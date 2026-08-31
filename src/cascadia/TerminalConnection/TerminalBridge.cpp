// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TerminalBridge.h"

#include <algorithm>
#include <filesystem>
#include <vector>

#include "ConptyConnection.h" // for the projected ITerminalConnection
#include "../../types/inc/utils.hpp"

using namespace ::Microsoft::Console;
namespace WDJ = ::winrt::Windows::Data::Json;

namespace
{
    constexpr size_t MaxOutboundBytes = 16 * 1024 * 1024;
    constexpr size_t MaxSessionReplayChars = 128 * 1024;
    constexpr size_t MaxAgentScanChars = 4 * 1024;
    constexpr std::wstring_view TerminalAgentOscPrefix = L"\x1b]1337;TerminalWeb.Agent=";
    constexpr DWORD InitialBackoffMs = 500;
    constexpr DWORD MaxBackoffMs = 5000;
    constexpr ULONGLONG ServerSpawnThrottleMs = 15000;

    std::wstring getEnv(const wchar_t* name)
    {
        wchar_t buffer[2048];
        const auto length = GetEnvironmentVariableW(name, &buffer[0], ARRAYSIZE(buffer));
        if (length == 0 || length >= ARRAYSIZE(buffer))
        {
            return {};
        }
        return std::wstring{ &buffer[0], length };
    }

    // ISO-8601 timestamp in UTC, e.g. 2026-06-29T12:34:56.789Z, matching what
    // the Node bridge produces with new Date().toISOString().
    std::wstring isoNow()
    {
        SYSTEMTIME st{};
        GetSystemTime(&st);
        wchar_t buffer[32];
        swprintf_s(&buffer[0],
                   ARRAYSIZE(buffer),
                   L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                   st.wYear,
                   st.wMonth,
                   st.wDay,
                   st.wHour,
                   st.wMinute,
                   st.wSecond,
                   st.wMilliseconds);
        return std::wstring{ &buffer[0] };
    }
}

namespace winrt::Microsoft::Terminal::TerminalConnection::implementation
{
    TerminalBridge& TerminalBridge::Instance()
    {
        // Intentionally leaked: this lives for the lifetime of the process and
        // owns detached worker threads, so we avoid static destruction order
        // problems by never destroying it.
        static TerminalBridge* const instance = new TerminalBridge();
        return *instance;
    }

    TerminalBridge::TerminalBridge()
    {
        const auto configured = getEnv(L"WT_BRIDGE_SERVER");
        if (configured == L"off" || configured == L"0" || configured == L"false")
        {
            _enabled = false;
            return;
        }

        // Default: enabled, talking to the local terminal-web server.
        _enabled = true;
        _status.store(static_cast<uint32_t>(Status::Connecting), std::memory_order_relaxed);

        if (!configured.empty())
        {
            try
            {
                const Windows::Foundation::Uri uri{ winrt::hstring{ configured } };
                if (!uri.Host().empty())
                {
                    _host = uri.Host();
                }
                if (uri.Port() != 0)
                {
                    _port = gsl::narrow_cast<INTERNET_PORT>(uri.Port());
                }
            }
            catch (...)
            {
                // Malformed override: fall back to the defaults but stay enabled.
            }
        }
    }

    TerminalBridge::Status TerminalBridge::ConnectionStatus() const noexcept
    {
        return static_cast<Status>(_status.load(std::memory_order_relaxed));
    }

    std::wstring TerminalBridge::Endpoint() const
    {
        const auto active = _activePort.load(std::memory_order_relaxed);
        return _host + L":" + std::to_wstring(active != 0 ? active : _port);
    }

    std::wstring TerminalBridge::AccessToken() const
    {
        auto token = getEnv(L"TERMINAL_WEB_ACCESS_TOKEN");
        if (!token.empty())
        {
            return token;
        }

        const auto root = _serverRoot();
        if (root.empty())
        {
            return {};
        }

        // The server persists its generated network token next to its package
        // so clients keep working across restarts (see tools/terminal-web).
        const auto tokenPath = root + L"\\.terminal-web-token";
        const wil::unique_hfile file{ CreateFileW(tokenPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr) };
        if (!file)
        {
            return {};
        }

        char buffer[512];
        DWORD read{};
        if (!ReadFile(file.get(), &buffer[0], sizeof(buffer), &read, nullptr) || read == 0)
        {
            return {};
        }

        std::string utf8{ &buffer[0], read };
        while (!utf8.empty() && (utf8.back() == '\r' || utf8.back() == '\n' || utf8.back() == ' ' || utf8.back() == '\t'))
        {
            utf8.pop_back();
        }
        return std::wstring{ winrt::to_hstring(utf8) };
    }

    std::wstring TerminalBridge::_serverRoot() const noexcept
    try
    {
        const auto packageJsonExists = [](const std::wstring& dir) {
            const auto probe = dir + L"\\package.json";
            const auto attributes = GetFileAttributesW(probe.c_str());
            return attributes != INVALID_FILE_ATTRIBUTES && WI_IsFlagClear(attributes, FILE_ATTRIBUTE_DIRECTORY);
        };

        auto configured = getEnv(L"TERMINAL_WEB_ROOT");
        if (!configured.empty())
        {
            while (!configured.empty() && (configured.back() == L'\\' || configured.back() == L'/'))
            {
                configured.pop_back();
            }
            if (packageJsonExists(configured))
            {
                return configured;
            }
        }

        // Walk up from WindowsTerminal.exe (e.g. src\cascadia\CascadiaPackage\bin\x64\Debug)
        // until we find the repo's tools\terminal-web package.
        wchar_t modulePath[MAX_PATH];
        const auto length = GetModuleFileNameW(nullptr, &modulePath[0], ARRAYSIZE(modulePath));
        if (length == 0 || length >= ARRAYSIZE(modulePath))
        {
            return {};
        }

        std::filesystem::path dir{ std::wstring_view{ &modulePath[0], length } };
        dir = dir.parent_path();
        while (!dir.empty() && dir != dir.root_path())
        {
            const auto candidate = (dir / L"tools" / L"terminal-web").wstring();
            if (packageJsonExists(candidate))
            {
                return candidate;
            }
            dir = dir.parent_path();
        }
        return {};
    }
    catch (...)
    {
        return {};
    }

    void TerminalBridge::_ensureServerRunning() noexcept
    try
    {
        // Only manage a server that we'd reach over loopback; a remote
        // WT_BRIDGE_SERVER override is someone else's responsibility.
        if (_host != L"127.0.0.1" && _host != L"localhost")
        {
            return;
        }

        // Nothing to mirror? Don't keep a server alive on our own.
        {
            std::lock_guard guard{ _sessionsMutex };
            if (_sessions.empty())
            {
                return;
            }
        }

        std::lock_guard guard{ _serverMutex };

        // Only one Windows Terminal process should own spawning the shared
        // local server. Non-owners retry the acquisition every pass and must
        // not keep a handle: holding one would keep the named mutex alive
        // after the owner exits and no survivor could ever take over.
        if (!_spawnOwner)
        {
            wil::unique_handle handle{ CreateMutexW(nullptr, FALSE, L"Local\\WindowsTerminalWebBridgeSpawner") };
            if (!handle || GetLastError() == ERROR_ALREADY_EXISTS)
            {
                return;
            }
            _spawnOwnerMutex = std::move(handle);
            _spawnOwner = true;
        }

        if (_serverProcess && WaitForSingleObject(_serverProcess.get(), 0) == WAIT_TIMEOUT)
        {
            // Our child is alive; it may still be starting up or it may be
            // serving on a different port — either way, don't stack spawns.
            return;
        }

        const auto now = GetTickCount64();
        if (_serverProcess)
        {
            // The last child we spawned has exited even though we still want a
            // server. Dying within the throttle window means it never really
            // came up (missing deps, syntax error, port bound by a non-server):
            // count it so the UI can point at the log instead of "offline".
            _quickExitCount = (now - _lastSpawnTick < ServerSpawnThrottleMs * 2) ? _quickExitCount + 1 : 0;
            _serverFailing.store(_quickExitCount >= 3, std::memory_order_relaxed);
            _serverProcess.reset();
        }

        if (now - _lastSpawnTick < ServerSpawnThrottleMs)
        {
            return;
        }
        _lastSpawnTick = now;

        const auto root = _serverRoot();
        if (root.empty())
        {
            return;
        }

        // The child's output lands in a log next to the package so a dead
        // server is diagnosable after the fact. Cap its growth by truncating
        // once it gets large; history beyond a few MB has no value here.
        const auto logPath = root + L"\\.terminal-web-server.log";
        SECURITY_ATTRIBUTES inheritable{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
        wil::unique_hfile logFile{ CreateFileW(logPath.c_str(),
                                               FILE_APPEND_DATA,
                                               FILE_SHARE_READ | FILE_SHARE_WRITE,
                                               &inheritable,
                                               OPEN_ALWAYS,
                                               FILE_ATTRIBUTE_NORMAL,
                                               nullptr) };
        if (logFile)
        {
            LARGE_INTEGER size{};
            if (GetFileSizeEx(logFile.get(), &size) && size.QuadPart > 4 * 1024 * 1024)
            {
                logFile.reset(CreateFileW(logPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
            }
        }
        if (logFile)
        {
            const auto banner = "\r\n[" + winrt::to_string(isoNow()) + "] terminal-web spawn (quick exits: " + std::to_string(_quickExitCount) + ")\r\n";
            DWORD written{};
            WriteFile(logFile.get(), banner.data(), gsl::narrow_cast<DWORD>(banner.size()), &written, nullptr);
        }

        // `bun install` first so a missing or stale node_modules (the classic
        // silent-offline cause: `tsx` not installed, dev script exits 1) heals
        // itself; it's a no-op costing ~100ms when everything is present.
        // Go through cmd.exe so PATH shims (bun.exe, bun.cmd) both resolve.
        std::wstring commandLine{ L"cmd.exe /d /s /c \"bun install && bun run dev\"" };
        STARTUPINFOW startupInfo{};
        startupInfo.cb = sizeof(startupInfo);
        wil::unique_hfile nulInput;
        if (logFile)
        {
            nulInput.reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
            startupInfo.dwFlags |= STARTF_USESTDHANDLES;
            startupInfo.hStdInput = nulInput ? nulInput.get() : INVALID_HANDLE_VALUE;
            startupInfo.hStdOutput = logFile.get();
            startupInfo.hStdError = logFile.get();
        }
        wil::unique_process_information processInfo;
        if (CreateProcessW(nullptr,
                           commandLine.data(),
                           nullptr,
                           nullptr,
                           logFile ? TRUE : FALSE,
                           CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
                           nullptr,
                           root.c_str(),
                           &startupInfo,
                           &processInfo))
        {
            _serverProcess.reset(processInfo.hProcess);
            processInfo.hProcess = nullptr;
        }
    }
    catch (...)
    {
    }

    void TerminalBridge::_ensureStarted()
    {
        std::call_once(_startFlag, [this]() {
            _sendThread = std::thread{ [this]() { _sendLoop(); } };
            _recvThread = std::thread{ [this]() { _receiveLoop(); } };
            _sendThread.detach();
            _recvThread.detach();
        });
    }

    void TerminalBridge::RegisterSession(const winrt::guid& id,
                                         const winrt::Windows::Foundation::IInspectable& connection,
                                         std::wstring_view title,
                                         std::wstring_view shell,
                                         std::wstring_view cwd,
                                         uint32_t pid,
                                         uint32_t cols,
                                         uint32_t rows)
    {
        if (!_enabled)
        {
            return;
        }

        _ensureStarted();

        const auto idStr = Utils::GuidToPlainString(id);

        std::wstring projectId;
        {
            std::lock_guard guard{ _sessionsMutex };
            if (const auto it = _sessionProjects.find(idStr); it != _sessionProjects.end())
            {
                projectId = it->second;
            }
        }

        auto message = _buildRegister(idStr, title, shell, cwd, pid, cols, rows, projectId);

        {
            std::lock_guard guard{ _sessionsMutex };
            _sessions[idStr] = SessionEntry{ winrt::make_weak(connection), message, std::wstring{ title } };
        }

        _enqueue(std::move(message));
    }

    void TerminalBridge::ForwardTitle(const winrt::guid& id, std::wstring_view title)
    {
        if (!_enabled || title.empty())
        {
            return;
        }

        const auto idStr = Utils::GuidToPlainString(id);
        {
            std::lock_guard guard{ _sessionsMutex };
            const auto it = _sessions.find(idStr);
            if (it == _sessions.end() || it->second.lastTitle == title)
            {
                return;
            }
            it->second.lastTitle = title;
        }

        WDJ::JsonObject message;
        message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"title"));
        message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(idStr));
        message.SetNamedValue(L"title", WDJ::JsonValue::CreateStringValue(winrt::hstring{ title }));
        _enqueue(winrt::to_string(message.Stringify()));
    }

    void TerminalBridge::SetProject(const winrt::guid& id, std::wstring_view projectId)
    {
        if (!_enabled)
        {
            return;
        }

        const auto idStr = Utils::GuidToPlainString(id);
        auto registered = false;
        {
            std::lock_guard guard{ _sessionsMutex };
            _sessionProjects[idStr] = std::wstring{ projectId };
            registered = _sessions.find(idStr) != _sessions.end();
        }

        if (registered)
        {
            WDJ::JsonObject message;
            message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"project"));
            message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(idStr));
            message.SetNamedValue(L"projectId", WDJ::JsonValue::CreateStringValue(winrt::hstring{ projectId }));
            _enqueue(winrt::to_string(message.Stringify()));
        }
    }

    void TerminalBridge::ForwardOutput(const winrt::guid& id, std::wstring_view data)
    {
        if (!_enabled || data.empty())
        {
            return;
        }

        const auto idStr = Utils::GuidToPlainString(id);
        {
            std::lock_guard guard{ _sessionsMutex };
            if (const auto it = _sessions.find(idStr); it != _sessions.end())
            {
                auto& entry = it->second;
                entry.replayChunks.emplace_back(data);
                entry.replayChars += data.size();
                while (entry.replayChars > MaxSessionReplayChars && !entry.replayChunks.empty())
                {
                    auto& first = entry.replayChunks.front();
                    const auto overflow = entry.replayChars - MaxSessionReplayChars;
                    if (first.size() <= overflow)
                    {
                        entry.replayChars -= first.size();
                        entry.replayChunks.pop_front();
                    }
                    else
                    {
                        first.erase(0, overflow);
                        entry.replayChars -= overflow;
                    }
                }

                // Presence OSCs are deliberately tiny, but may be split over
                // multiple ConPTY reads. Scan a bounded rolling window and pin
                // the most recent complete sequence separately from the tail.
                entry.agentScanBuffer.append(data);
                size_t searchFrom = 0;
                for (;;)
                {
                    const auto markerStart = entry.agentScanBuffer.find(TerminalAgentOscPrefix, searchFrom);
                    if (markerStart == std::wstring::npos)
                    {
                        break;
                    }

                    const auto payloadStart = markerStart + TerminalAgentOscPrefix.size();
                    const auto belEnd = entry.agentScanBuffer.find(L'\x07', payloadStart);
                    const auto stEnd = entry.agentScanBuffer.find(L"\x1b\\", payloadStart);
                    const auto markerEnd = belEnd == std::wstring::npos ? stEnd :
                                               stEnd == std::wstring::npos ? belEnd :
                                                                           std::min(belEnd, stEnd);
                    if (markerEnd == std::wstring::npos)
                    {
                        break;
                    }

                    const auto terminatorLength = markerEnd == stEnd ? 2u : 1u;
                    entry.agentPresenceSequence = entry.agentScanBuffer.substr(markerStart, markerEnd - markerStart + terminatorLength);
                    searchFrom = markerEnd + terminatorLength;
                }

                if (entry.agentScanBuffer.size() > MaxAgentScanChars)
                {
                    entry.agentScanBuffer.erase(0, entry.agentScanBuffer.size() - MaxAgentScanChars);
                }
            }
        }

        WDJ::JsonObject message;
        message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"output"));
        message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(idStr));
        message.SetNamedValue(L"data", WDJ::JsonValue::CreateStringValue(winrt::hstring{ data }));
        _enqueue(winrt::to_string(message.Stringify()));
    }

    void TerminalBridge::NotifyResize(const winrt::guid& id, uint32_t rows, uint32_t cols)
    {
        if (!_enabled)
        {
            return;
        }

        WDJ::JsonObject message;
        message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"resize"));
        message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(Utils::GuidToPlainString(id)));
        message.SetNamedValue(L"cols", WDJ::JsonValue::CreateNumberValue(cols));
        message.SetNamedValue(L"rows", WDJ::JsonValue::CreateNumberValue(rows));
        _enqueue(winrt::to_string(message.Stringify()));
    }

    void TerminalBridge::NotifyExit(const winrt::guid& id, uint32_t exitCode)
    {
        if (!_enabled)
        {
            return;
        }

        WDJ::JsonObject message;
        message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"exit"));
        message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(Utils::GuidToPlainString(id)));
        message.SetNamedValue(L"exitCode", WDJ::JsonValue::CreateNumberValue(exitCode));
        _enqueue(winrt::to_string(message.Stringify()));
    }

    void TerminalBridge::Unregister(const winrt::guid& id)
    {
        std::lock_guard guard{ _sessionsMutex };
        const auto idStr = Utils::GuidToPlainString(id);
        _sessions.erase(idStr);
        _sessionProjects.erase(idStr);
    }

    std::string TerminalBridge::_buildRegister(std::wstring_view id,
                                               std::wstring_view title,
                                               std::wstring_view shell,
                                               std::wstring_view cwd,
                                               uint32_t pid,
                                               uint32_t cols,
                                               uint32_t rows,
                                               std::wstring_view projectId) const
    {
        WDJ::JsonObject session;
        session.SetNamedValue(L"id", WDJ::JsonValue::CreateStringValue(winrt::hstring{ id }));
        session.SetNamedValue(L"title", WDJ::JsonValue::CreateStringValue(winrt::hstring{ title }));
        session.SetNamedValue(L"shell", WDJ::JsonValue::CreateStringValue(winrt::hstring{ shell }));
        session.SetNamedValue(L"args", WDJ::JsonArray{});
        session.SetNamedValue(L"cwd", WDJ::JsonValue::CreateStringValue(winrt::hstring{ cwd }));
        session.SetNamedValue(L"source", WDJ::JsonValue::CreateStringValue(L"bridged"));
        session.SetNamedValue(L"pid", WDJ::JsonValue::CreateNumberValue(pid));
        session.SetNamedValue(L"status", WDJ::JsonValue::CreateStringValue(L"running"));
        const auto now = isoNow();
        session.SetNamedValue(L"createdAt", WDJ::JsonValue::CreateStringValue(winrt::hstring{ now }));
        session.SetNamedValue(L"updatedAt", WDJ::JsonValue::CreateStringValue(winrt::hstring{ now }));
        session.SetNamedValue(L"cols", WDJ::JsonValue::CreateNumberValue(cols));
        session.SetNamedValue(L"rows", WDJ::JsonValue::CreateNumberValue(rows));
        session.SetNamedValue(L"bufferedBytes", WDJ::JsonValue::CreateNumberValue(0));
        if (!projectId.empty())
        {
            session.SetNamedValue(L"projectId", WDJ::JsonValue::CreateStringValue(winrt::hstring{ projectId }));
        }

        WDJ::JsonObject message;
        message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"register"));
        message.SetNamedValue(L"session", session);
        return winrt::to_string(message.Stringify());
    }

    std::string TerminalBridge::_buildReplayRegister(const SessionEntry& entry) const noexcept
    try
    {
        if (entry.replayChunks.empty() && entry.agentPresenceSequence.empty())
        {
            return entry.registerMessage;
        }

        WDJ::JsonObject message{ nullptr };
        if (!WDJ::JsonObject::TryParse(winrt::to_hstring(entry.registerMessage), message))
        {
            return entry.registerMessage;
        }

        std::wstring replay;
        replay.reserve(entry.agentPresenceSequence.size() + entry.replayChars);
        replay.append(entry.agentPresenceSequence);
        for (const auto& chunk : entry.replayChunks)
        {
            replay.append(chunk);
        }
        message.SetNamedValue(L"replay", WDJ::JsonValue::CreateStringValue(winrt::hstring{ replay }));
        return winrt::to_string(message.Stringify());
    }
    catch (...)
    {
        return entry.registerMessage;
    }

    void TerminalBridge::_enqueue(std::string message)
    {
        {
            std::lock_guard guard{ _outboundMutex };
            _outboundBytes += message.size();
            _outbound.push_back(std::move(message));

            // Bound memory: if the server is slow/absent, drop the oldest
            // messages rather than growing without limit. Local rendering is
            // unaffected because output is never sent inline.
            while (_outboundBytes > MaxOutboundBytes && _outbound.size() > 1)
            {
                _outboundBytes -= _outbound.front().size();
                _outbound.pop_front();
            }
        }
        _outboundCv.notify_one();
    }

    void TerminalBridge::_sendLoop() noexcept
    {
        for (;;)
        {
            std::string message;
            {
                std::unique_lock lock{ _outboundMutex };
                _outboundCv.wait(lock, [this]() noexcept { return !_outbound.empty() && _connected.load(); });
                message = std::move(_outbound.front());
                _outbound.pop_front();
                _outboundBytes -= message.size();
            }

            std::lock_guard guard{ _socketMutex };
            if (_connected.load() && _webSocket)
            {
                // A failed send simply drops this message; the receive thread
                // owns reconnect + re-register, so we don't react here.
                std::ignore = WinHttpWebSocketSend(_webSocket.get(),
                                                   WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                                   message.data(),
                                                   gsl::narrow_cast<DWORD>(message.size()));
            }
        }
    }

    void TerminalBridge::_receiveLoop() noexcept
    {
        auto backoff = InitialBackoffMs;
        for (;;)
        {
            _status.store(static_cast<uint32_t>(_serverFailing.load(std::memory_order_relaxed) ? Status::ServerFailing : Status::Connecting), std::memory_order_relaxed);
            if (!_connectAny())
            {
                // Nobody is listening locally: keep the shared terminal-web
                // server alive for as long as we have sessions to mirror.
                _ensureServerRunning();
                Sleep(backoff);
                backoff = std::min(backoff * 2, MaxBackoffMs);
                continue;
            }
            backoff = InitialBackoffMs;
            _serverFailing.store(false, std::memory_order_relaxed);
            {
                std::lock_guard guard{ _serverMutex };
                _quickExitCount = 0;
            }

            // Re-register every live session so the server reattaches them.
            {
                std::lock_guard sessions{ _sessionsMutex };
                std::lock_guard outbound{ _outboundMutex };
                for (const auto& [id, entry] : _sessions)
                {
                    auto registerMessage = _buildReplayRegister(entry);
                    _outboundBytes += registerMessage.size();
                    _outbound.push_front(std::move(registerMessage));
                }
            }

            _connected.store(true);
            _status.store(static_cast<uint32_t>(Status::Connected), std::memory_order_relaxed);
            _outboundCv.notify_all();

            _receiveUntilError();

            _connected.store(false);
            _status.store(static_cast<uint32_t>(Status::Connecting), std::memory_order_relaxed);
            _closeSocket();
        }
    }

    // The server prefers the default port but records where it actually
    // listens in .terminal-web-server.json (it walks up when something else
    // owns the default). Follow it there so a drifted port doesn't read as
    // "offline" forever.
    INTERNET_PORT TerminalBridge::_readRecordedServerPort() const noexcept
    try
    {
        const auto root = _serverRoot();
        if (root.empty())
        {
            return 0;
        }

        const auto infoPath = root + L"\\.terminal-web-server.json";
        const wil::unique_hfile file{ CreateFileW(infoPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr) };
        if (!file)
        {
            return 0;
        }

        char buffer[1024];
        DWORD read{};
        if (!ReadFile(file.get(), &buffer[0], sizeof(buffer), &read, nullptr) || read == 0)
        {
            return 0;
        }

        WDJ::JsonObject obj{ nullptr };
        if (!WDJ::JsonObject::TryParse(winrt::to_hstring(std::string_view{ &buffer[0], read }), obj))
        {
            return 0;
        }

        const auto port = obj.GetNamedNumber(L"port", 0);
        if (port <= 0 || port > 65535)
        {
            return 0;
        }
        return gsl::narrow_cast<INTERNET_PORT>(port);
    }
    catch (...)
    {
        return 0;
    }

    bool TerminalBridge::_connectAny() noexcept
    {
        // Try the port that last worked first, then the configured default,
        // then whatever the server recorded on disk.
        INTERNET_PORT candidates[3]{};
        size_t count = 0;
        const auto push = [&](INTERNET_PORT port) {
            if (port == 0)
            {
                return;
            }
            for (size_t i = 0; i < count; ++i)
            {
                if (candidates[i] == port)
                {
                    return;
                }
            }
            candidates[count++] = port;
        };

        push(gsl::narrow_cast<INTERNET_PORT>(_activePort.load(std::memory_order_relaxed)));
        push(_port);
        push(_readRecordedServerPort());

        for (size_t i = 0; i < count; ++i)
        {
            if (_connect(candidates[i]))
            {
                _activePort.store(candidates[i], std::memory_order_relaxed);
                return true;
            }
        }
        return false;
    }

    bool TerminalBridge::_connect(INTERNET_PORT port) noexcept
    {
        try
        {
            wil::unique_winhttp_hinternet session{ WinHttpOpen(L"WindowsTerminal-Bridge/1.0",
                                                               WINHTTP_ACCESS_TYPE_NO_PROXY,
                                                               WINHTTP_NO_PROXY_NAME,
                                                               WINHTTP_NO_PROXY_BYPASS,
                                                               0) };
            if (!session)
            {
                return false;
            }

            wil::unique_winhttp_hinternet connection{ WinHttpConnect(session.get(), _host.c_str(), port, 0) };
            if (!connection)
            {
                return false;
            }

            wil::unique_winhttp_hinternet request{ WinHttpOpenRequest(connection.get(), L"GET", _path.c_str(), nullptr, nullptr, nullptr, 0) };
            if (!request)
            {
                return false;
            }

            if (!WinHttpSetOption(request.get(), WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0))
            {
                return false;
            }
#pragma warning(suppress : 26477) // WINHTTP_NO_ADDITIONAL_HEADERS expands to NULL rather than nullptr.
            if (!WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0))
            {
                return false;
            }
            if (!WinHttpReceiveResponse(request.get(), nullptr))
            {
                return false;
            }

            wil::unique_winhttp_hinternet socket{ WinHttpWebSocketCompleteUpgrade(request.get(), 0) };
            if (!socket)
            {
                return false;
            }

            request.reset(); // no longer needed once upgraded

            std::lock_guard guard{ _socketMutex };
            _session = std::move(session);
            _connection = std::move(connection);
            _webSocket = std::move(socket);
            return true;
        }
        catch (...)
        {
            return false;
        }
    }

    void TerminalBridge::_receiveUntilError() noexcept
    {
        std::string accumulated;
        std::vector<char> buffer(64 * 1024);
        for (;;)
        {
            DWORD read{};
            WINHTTP_WEB_SOCKET_BUFFER_TYPE bufferType{};
            // The receive thread is the only owner of the handle while reading,
            // so we can read it without the socket lock (the send thread only
            // *uses* it under the lock, never resets it).
            const auto status = WinHttpWebSocketReceive(_webSocket.get(), buffer.data(), gsl::narrow_cast<DWORD>(buffer.size()), &read, &bufferType);
            if (status != NO_ERROR || bufferType == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE)
            {
                return;
            }

            accumulated.append(buffer.data(), read);

            // FRAGMENT buffer types mean more is coming; the MESSAGE types mark
            // the final piece of a complete message.
            if (bufferType == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE ||
                bufferType == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE)
            {
                _dispatchServerMessage(accumulated);
                accumulated.clear();
            }
        }
    }

    void TerminalBridge::_closeSocket() noexcept
    {
        std::lock_guard guard{ _socketMutex };
        _webSocket.reset();
        _connection.reset();
        _session.reset();
    }

    void TerminalBridge::_dispatchServerMessage(const std::string& utf8) noexcept
    try
    {
        WDJ::JsonObject obj{ nullptr };
        if (!WDJ::JsonObject::TryParse(winrt::to_hstring(utf8), obj))
        {
            return;
        }

        const auto type = obj.GetNamedString(L"type", L"");
        if (type == L"error" || type == L"registered")
        {
            return;
        }

        const auto sessionId = obj.GetNamedString(L"sessionId", L"");
        if (sessionId.empty())
        {
            return;
        }

        winrt::Windows::Foundation::IInspectable inspectable{ nullptr };
        {
            std::lock_guard guard{ _sessionsMutex };
            const auto it = _sessions.find(std::wstring{ sessionId });
            if (it == _sessions.end())
            {
                return;
            }
            inspectable = it->second.connection.get();
        }

        if (!inspectable)
        {
            return;
        }

        const auto connection = inspectable.try_as<winrt::Microsoft::Terminal::TerminalConnection::ITerminalConnection>();
        if (!connection)
        {
            return;
        }

        if (type == L"input")
        {
            const auto data = obj.GetNamedString(L"data", L"");
            const auto* const begin = reinterpret_cast<const char16_t*>(data.c_str());
            connection.WriteInput(winrt::array_view<const char16_t>{ begin, begin + data.size() });
        }
        else if (type == L"resize")
        {
            const auto cols = static_cast<uint32_t>(obj.GetNamedNumber(L"cols", 0));
            const auto rows = static_cast<uint32_t>(obj.GetNamedNumber(L"rows", 0));
            if (cols > 0 && rows > 0)
            {
                connection.Resize(rows, cols);
            }
        }
        else if (type == L"kill")
        {
            connection.Close();
        }
    }
    CATCH_LOG()
}

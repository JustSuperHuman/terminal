// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TerminalBridge.h"
#include "TerminalBridgeRust.h"

#include <filesystem>

#include "ConptyConnection.h"
#include "../../types/inc/utils.hpp"

using namespace ::Microsoft::Console;

namespace
{
    constexpr uint32_t RustCommandInput = 1;
    constexpr uint32_t RustCommandResize = 2;
    constexpr uint32_t RustCommandKill = 3;

    struct BridgeConfiguration
    {
        bool enabled{ true };
        bool automaticPort{ true };
        uint16_t port{ 10001 };
        std::wstring bindAddress{ L"0.0.0.0" };
        bool webInterfaceEnabled{ true };
    };

    std::mutex bridgeConfigurationMutex;
    BridgeConfiguration bridgeConfiguration;

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

    std::u16string_view asUtf16(std::wstring_view value) noexcept
    {
        static_assert(sizeof(wchar_t) == sizeof(char16_t));
        return { reinterpret_cast<const char16_t*>(value.data()), value.size() };
    }
}

namespace winrt::Microsoft::Terminal::TerminalConnection::implementation
{
    TerminalBridge& TerminalBridge::Instance()
    {
        static TerminalBridge* const instance = new TerminalBridge();
        return *instance;
    }

    void TerminalBridge::Configure(const bool enabled,
                                   const bool automaticPort,
                                   const uint16_t port,
                                   const std::wstring_view bindAddress,
                                   const bool webInterfaceEnabled)
    {
        {
            std::lock_guard guard{ bridgeConfigurationMutex };
            bridgeConfiguration.enabled = enabled;
            bridgeConfiguration.automaticPort = automaticPort;
            bridgeConfiguration.port = port == 0 ? 10001 : port;
            bridgeConfiguration.bindAddress = bindAddress.empty() ? L"0.0.0.0" : std::wstring{ bindAddress };
            bridgeConfiguration.webInterfaceEnabled = webInterfaceEnabled;
        }
        // Construct the singleton only after the application has supplied its
        // persisted settings, before the first ConPTY session is created.
        Instance();
    }

    TerminalBridge::TerminalBridge()
    {
        BridgeConfiguration settings;
        {
            std::lock_guard guard{ bridgeConfigurationMutex };
            settings = bridgeConfiguration;
        }
        const auto configured = getEnv(L"WT_BRIDGE_SERVER");
        if (!settings.enabled || configured == L"off" || configured == L"0" || configured == L"false")
        {
            return;
        }

        const auto assetRoot = _serverRoot();
        const auto dataRoot = _serverDataRoot();
        if (assetRoot.empty() || dataRoot.empty())
        {
            return;
        }

        const auto assetUtf16 = asUtf16(assetRoot);
        const auto dataUtf16 = asUtf16(dataRoot);
        const auto bindAddressUtf16 = asUtf16(settings.bindAddress);
        _enabled = tbr_initialize(assetUtf16.data(),
                                  assetUtf16.size(),
                                  dataUtf16.data(),
                                  dataUtf16.size(),
                                  settings.automaticPort,
                                  settings.port,
                                  bindAddressUtf16.data(),
                                  bindAddressUtf16.size(),
                                  settings.webInterfaceEnabled,
                                  this,
                                  &TerminalBridge::_dispatchRustCommand);
    }

    TerminalBridge::Status TerminalBridge::ConnectionStatus() const noexcept
    {
        if (!_enabled)
        {
            return Status::Disabled;
        }
        return static_cast<Status>(tbr_status());
    }

    std::wstring TerminalBridge::_copyRustString(size_t (*copy)(char16_t*, size_t) noexcept)
    {
        const auto length = copy(nullptr, 0);
        if (length == 0)
        {
            return {};
        }
        std::u16string value(length + 1, u'\0');
        copy(value.data(), value.size());
        value.resize(length);
        return { reinterpret_cast<const wchar_t*>(value.data()), value.size() };
    }

    std::wstring TerminalBridge::Endpoint() const
    {
        return _copyRustString(tbr_copy_endpoint);
    }

    std::wstring TerminalBridge::AccessToken() const
    {
        return _copyRustString(tbr_copy_access_token);
    }

    std::wstring TerminalBridge::_serverRoot() const noexcept
    try
    {
        auto configured = getEnv(L"TERMINAL_WEB_ROOT");
        while (!configured.empty() && (configured.back() == L'\\' || configured.back() == L'/'))
        {
            configured.pop_back();
        }
        if (!configured.empty())
        {
            return configured;
        }

        wchar_t modulePath[MAX_PATH];
        const auto length = GetModuleFileNameW(nullptr, &modulePath[0], ARRAYSIZE(modulePath));
        if (length == 0 || length >= ARRAYSIZE(modulePath))
        {
            return {};
        }

        return std::filesystem::path{ std::wstring_view{ &modulePath[0], length } }.parent_path().wstring();
    }
    catch (...)
    {
        return {};
    }

    std::wstring TerminalBridge::_serverDataRoot() const noexcept
    try
    {
        auto configured = getEnv(L"TERMINAL_WEB_DATA_ROOT");
        if (!configured.empty())
        {
            CreateDirectoryW(configured.c_str(), nullptr);
            return configured;
        }

        const auto localAppData = getEnv(L"LOCALAPPDATA");
        if (localAppData.empty())
        {
            return _serverRoot();
        }
        const auto root = localAppData + L"\\TerminalWeb";
        CreateDirectoryW(root.c_str(), nullptr);
        return root;
    }
    catch (...)
    {
        return {};
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
        const auto idString = Utils::GuidToPlainString(id);
        std::wstring project;
        {
            std::lock_guard guard{ _sessionsMutex };
            _sessions[idString] = winrt::make_weak(connection);
            if (const auto found = _sessionProjects.find(idString); found != _sessionProjects.end())
            {
                project = found->second;
            }
        }

        const auto idUtf16 = asUtf16(idString);
        const auto titleUtf16 = asUtf16(title);
        const auto shellUtf16 = asUtf16(shell);
        const auto cwdUtf16 = asUtf16(cwd);
        tbr_register_session(idUtf16.data(), idUtf16.size(),
                             titleUtf16.data(), titleUtf16.size(),
                             shellUtf16.data(), shellUtf16.size(),
                             cwdUtf16.data(), cwdUtf16.size(),
                             pid, cols, rows);
        if (!project.empty())
        {
            SetProject(id, project);
        }
    }

    void TerminalBridge::ForwardOutput(const winrt::guid& id, std::wstring_view data)
    {
        if (!_enabled || data.empty())
        {
            return;
        }
        const auto idString = Utils::GuidToPlainString(id);
        const auto idUtf16 = asUtf16(idString);
        const auto dataUtf16 = asUtf16(data);
        tbr_forward_output(idUtf16.data(), idUtf16.size(), dataUtf16.data(), dataUtf16.size());
    }

    void TerminalBridge::ForwardTitle(const winrt::guid& id, std::wstring_view title)
    {
        if (!_enabled || title.empty())
        {
            return;
        }
        const auto idString = Utils::GuidToPlainString(id);
        const auto idUtf16 = asUtf16(idString);
        const auto titleUtf16 = asUtf16(title);
        tbr_forward_title(idUtf16.data(), idUtf16.size(), titleUtf16.data(), titleUtf16.size());
    }

    void TerminalBridge::SetProject(const winrt::guid& id, std::wstring_view projectId)
    {
        if (!_enabled)
        {
            return;
        }
        const auto idString = Utils::GuidToPlainString(id);
        {
            std::lock_guard guard{ _sessionsMutex };
            _sessionProjects[idString] = std::wstring{ projectId };
        }
        const auto idUtf16 = asUtf16(idString);
        const auto projectUtf16 = asUtf16(projectId);
        tbr_set_project(idUtf16.data(), idUtf16.size(), projectUtf16.data(), projectUtf16.size());
    }

    void TerminalBridge::ForwardCwd(const winrt::guid& id, std::wstring_view cwd)
    {
        if (!_enabled || cwd.empty())
        {
            return;
        }
        const auto idString = Utils::GuidToPlainString(id);
        const auto idUtf16 = asUtf16(idString);
        const auto cwdUtf16 = asUtf16(cwd);
        tbr_update_cwd(idUtf16.data(), idUtf16.size(), cwdUtf16.data(), cwdUtf16.size());
    }

    void TerminalBridge::NotifyResize(const winrt::guid& id, uint32_t rows, uint32_t cols)
    {
        if (!_enabled)
        {
            return;
        }
        const auto idString = Utils::GuidToPlainString(id);
        const auto idUtf16 = asUtf16(idString);
        tbr_notify_resize(idUtf16.data(), idUtf16.size(), rows, cols);
    }

    void TerminalBridge::NotifyExit(const winrt::guid& id, uint32_t exitCode)
    {
        if (!_enabled)
        {
            return;
        }
        const auto idString = Utils::GuidToPlainString(id);
        const auto idUtf16 = asUtf16(idString);
        tbr_notify_exit(idUtf16.data(), idUtf16.size(), exitCode);
    }

    void TerminalBridge::Unregister(const winrt::guid& id)
    {
        const auto idString = Utils::GuidToPlainString(id);
        {
            std::lock_guard guard{ _sessionsMutex };
            _sessions.erase(idString);
            _sessionProjects.erase(idString);
        }
        if (_enabled)
        {
            const auto idUtf16 = asUtf16(idString);
            tbr_unregister(idUtf16.data(), idUtf16.size());
        }
    }

    void TerminalBridge::_dispatchRustCommand(void* context,
                                              const char16_t* sessionId,
                                              size_t sessionIdLength,
                                              uint32_t kind,
                                              const char16_t* data,
                                              size_t dataLength,
                                              uint32_t rows,
                                              uint32_t cols) noexcept
    {
        if (const auto bridge = static_cast<TerminalBridge*>(context))
        {
            bridge->_dispatchRustCommand({ sessionId, sessionIdLength }, kind, { data, dataLength }, rows, cols);
        }
    }

    void TerminalBridge::_dispatchRustCommand(std::u16string_view sessionId,
                                              uint32_t kind,
                                              std::u16string_view data,
                                              uint32_t rows,
                                              uint32_t cols) noexcept
    try
    {
        winrt::Windows::Foundation::IInspectable inspectable{ nullptr };
        {
            const std::wstring id{ reinterpret_cast<const wchar_t*>(sessionId.data()), sessionId.size() };
            std::lock_guard guard{ _sessionsMutex };
            if (const auto found = _sessions.find(id); found != _sessions.end())
            {
                inspectable = found->second.get();
            }
        }
        const auto connection = inspectable.try_as<winrt::Microsoft::Terminal::TerminalConnection::ITerminalConnection>();
        if (!connection)
        {
            return;
        }

        if (kind == RustCommandInput)
        {
            connection.WriteInput(winrt::array_view<const char16_t>{ data.data(), data.data() + data.size() });
        }
        else if (kind == RustCommandResize && rows > 0 && cols > 0)
        {
            connection.Resize(rows, cols);
        }
        else if (kind == RustCommandKill)
        {
            connection.Close();
        }
    }
    CATCH_LOG()
}

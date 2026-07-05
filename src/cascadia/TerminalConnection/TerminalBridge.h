// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// TerminalBridge
// --------------
// A process-wide client that mirrors every ConPTY session into the
// "terminal-web" bridge server (tools/terminal-web) so the web and mobile
// clients can view and control native Windows Terminal sessions.
//
// It speaks the exact JSON-over-WebSocket protocol that the standalone
// `bridge` Node client uses (see tools/terminal-web/server/types.ts):
//   client -> server : register / output / resize / exit
//   server -> client : registered / input / resize / kill / error
//
// Transport is an in-process WinHTTP WebSocket (the same primitive
// AzureConnection already uses), so no sidecar process is required.
//
// Threading:
//   * A receive thread owns the connect/reconnect lifecycle and dispatches
//     inbound input/resize/kill to the originating connection.
//   * A send thread drains a bounded outbound queue. Output is enqueued (never
//     sent inline) so a slow or absent server can never stall local rendering.

#pragma once

#include <winhttp.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <thread>

namespace winrt::Microsoft::Terminal::TerminalConnection::implementation
{
    class TerminalBridge
    {
    public:
        enum class Status : uint32_t
        {
            Disabled = 0,
            Connecting = 1,
            Connected = 2,
        };

        static TerminalBridge& Instance();

        bool Enabled() const noexcept { return _enabled; }
        Status ConnectionStatus() const noexcept;
        std::wstring Endpoint() const;
        std::wstring AccessToken() const;

        // Called by ConptyConnection as sessions come and go.
        void RegisterSession(const winrt::guid& id,
                             const winrt::Windows::Foundation::IInspectable& connection,
                             std::wstring_view title,
                             std::wstring_view shell,
                             std::wstring_view cwd,
                             uint32_t pid,
                             uint32_t cols,
                             uint32_t rows);
        void ForwardOutput(const winrt::guid& id, std::wstring_view data);
        void ForwardTitle(const winrt::guid& id, std::wstring_view title);
        void SetProject(const winrt::guid& id, std::wstring_view projectId);
        void NotifyResize(const winrt::guid& id, uint32_t rows, uint32_t cols);
        void NotifyExit(const winrt::guid& id, uint32_t exitCode);
        void Unregister(const winrt::guid& id);

        TerminalBridge(const TerminalBridge&) = delete;
        TerminalBridge& operator=(const TerminalBridge&) = delete;

    private:
        TerminalBridge();

        struct SessionEntry
        {
            winrt::weak_ref<winrt::Windows::Foundation::IInspectable> connection;
            std::string registerMessage; // cached JSON used to re-register after a reconnect
            std::wstring lastTitle; // dedupes title updates
        };

        void _ensureStarted();
        void _enqueue(std::string message);

        void _ensureServerRunning() noexcept;
        std::wstring _serverRoot() const noexcept;

        void _sendLoop() noexcept;
        void _receiveLoop() noexcept;
        bool _connect() noexcept;
        void _receiveUntilError() noexcept;
        void _closeSocket() noexcept;
        void _dispatchServerMessage(const std::string& utf8) noexcept;

        std::string _buildRegister(std::wstring_view id,
                                   std::wstring_view title,
                                   std::wstring_view shell,
                                   std::wstring_view cwd,
                                   uint32_t pid,
                                   uint32_t cols,
                                   uint32_t rows,
                                   std::wstring_view projectId) const;

        bool _enabled{ false };
        std::wstring _host{ L"127.0.0.1" };
        INTERNET_PORT _port{ 10001 };
        std::wstring _path{ L"/bridge" };

        std::once_flag _startFlag;
        std::thread _sendThread;
        std::thread _recvThread;

        std::mutex _sessionsMutex;
        std::map<std::wstring, SessionEntry> _sessions;
        // Project assignments may arrive before the session registers; they're
        // merged into the register payload when known ahead of time.
        std::map<std::wstring, std::wstring> _sessionProjects;

        std::mutex _outboundMutex;
        std::condition_variable _outboundCv;
        std::deque<std::string> _outbound;
        size_t _outboundBytes{ 0 };

        std::mutex _socketMutex;
        wil::unique_winhttp_hinternet _session;
        wil::unique_winhttp_hinternet _connection;
        wil::unique_winhttp_hinternet _webSocket;
        std::atomic<bool> _connected{ false };
        std::atomic<uint32_t> _status{ 0 };

        // Keep-alive for the local terminal-web server process. While any
        // session is registered and the server is unreachable, we (re)spawn it
        // from the repo's tools/terminal-web package.
        std::mutex _serverMutex;
        wil::unique_handle _serverProcess;
        wil::unique_handle _spawnOwnerMutex;
        bool _spawnOwnershipChecked{ false };
        bool _spawnOwner{ false };
        ULONGLONG _lastSpawnTick{ 0 };
    };
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Thin C++/WinRT adapter for the built-in Rust terminal bridge. Rust owns the
// HTTP/WebSocket host, session registry, VT rendering, replay, authentication,
// reconnect behavior, and web/mobile protocol. This class only retains weak
// WinRT connections so Rust can deliver input, resize, and close commands.

#pragma once

#include <map>
#include <mutex>
#include <string>

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
            ServerFailing = 3,
        };

        static TerminalBridge& Instance();
        static void Configure(bool enabled,
                              bool automaticPort,
                              uint16_t port,
                              std::wstring_view bindAddress,
                              bool webInterfaceEnabled);

        bool Enabled() const noexcept { return _enabled; }
        Status ConnectionStatus() const noexcept;
        std::wstring Endpoint() const;
        std::wstring AccessToken() const;

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
        void ForwardCwd(const winrt::guid& id, std::wstring_view cwd);
        void NotifyResize(const winrt::guid& id, uint32_t rows, uint32_t cols);
        void NotifyExit(const winrt::guid& id, uint32_t exitCode);
        void Unregister(const winrt::guid& id);

        TerminalBridge(const TerminalBridge&) = delete;
        TerminalBridge& operator=(const TerminalBridge&) = delete;

    private:
        TerminalBridge();

        static void _dispatchRustCommand(void* context,
                                         const char16_t* sessionId,
                                         size_t sessionIdLength,
                                         uint32_t kind,
                                         const char16_t* data,
                                         size_t dataLength,
                                         uint32_t rows,
                                         uint32_t cols) noexcept;
        void _dispatchRustCommand(std::u16string_view sessionId,
                                  uint32_t kind,
                                  std::u16string_view data,
                                  uint32_t rows,
                                  uint32_t cols) noexcept;

        std::wstring _serverRoot() const noexcept;
        std::wstring _serverDataRoot() const noexcept;
        static std::wstring _copyRustString(size_t (*copy)(char16_t*, size_t) noexcept);

        bool _enabled{ false };
        std::mutex _sessionsMutex;
        std::map<std::wstring, winrt::weak_ref<winrt::Windows::Foundation::IInspectable>> _sessions;
        std::map<std::wstring, std::wstring> _sessionProjects;
    };
}

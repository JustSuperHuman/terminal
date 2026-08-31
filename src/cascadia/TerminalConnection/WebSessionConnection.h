// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// WebSessionConnection
// --------------------
// An ITerminalConnection that attaches to a session hosted by the local
// terminal-web server (tools/terminal-web) over its client WebSocket (/ws).
// The native orchestrator panel uses this to render the server-managed
// orchestrator session in a real TermControl, sharing one live session with
// the web and mobile clients.
//
// Protocol (see tools/terminal-web/server/types.ts):
//   client -> server : subscribe (slot-scoped) / input / resize
//   server -> client : snapshot / output / exit (others are ignored)

#pragma once

#include "WebSessionConnection.g.h"

#include <winhttp.h>

#include <atomic>
#include <mutex>
#include <string>

namespace winrt::Microsoft::Terminal::TerminalConnection::implementation
{
    struct WebSessionConnection : WebSessionConnectionT<WebSessionConnection>
    {
        explicit WebSessionConnection(winrt::hstring sessionId);

        void Initialize(const Windows::Foundation::Collections::ValueSet& /*settings*/) const noexcept {}

        void Start();
        void WriteInput(const winrt::array_view<const char16_t> buffer);
        void Resize(uint32_t rows, uint32_t columns);
        void Close() noexcept;

        winrt::guid SessionId() const noexcept { return {}; }
        ConnectionState State() const noexcept { return _state.load(std::memory_order_relaxed); }

        til::event<TerminalOutputHandler> TerminalOutput;
        til::typed_event<ITerminalConnection, IInspectable> StateChanged;

    private:
        void _transition(ConnectionState state);
        void _receiveLoop();
        bool _connect() noexcept;
        void _receiveUntilError();
        void _dispatch(const std::string& utf8);
        void _send(const std::string& utf8) noexcept;
        void _closeSocket() noexcept;

        winrt::hstring _sessionId;
        std::atomic<ConnectionState> _state{ ConnectionState::NotConnected };
        std::atomic<bool> _closing{ false };

        std::mutex _socketMutex;
        wil::unique_winhttp_hinternet _session;
        wil::unique_winhttp_hinternet _connection;
        wil::unique_winhttp_hinternet _webSocket;
        std::atomic<bool> _connected{ false };
    };
}

namespace winrt::Microsoft::Terminal::TerminalConnection::factory_implementation
{
    BASIC_FACTORY(WebSessionConnection);
}

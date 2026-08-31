// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "WebSessionConnection.h"

#include <algorithm>
#include <vector>

#include "TerminalBridge.h"

#include "WebSessionConnection.g.cpp"

namespace WDJ = ::winrt::Windows::Data::Json;

namespace
{
    constexpr DWORD InitialBackoffMs = 500;
    constexpr DWORD MaxBackoffMs = 5000;
}

namespace winrt::Microsoft::Terminal::TerminalConnection::implementation
{
    WebSessionConnection::WebSessionConnection(winrt::hstring sessionId) :
        _sessionId{ std::move(sessionId) }
    {
    }

    void WebSessionConnection::_transition(ConnectionState state)
    {
        const auto previous = _state.exchange(state, std::memory_order_relaxed);
        if (previous != state)
        {
            StateChanged.raise(*this, nullptr);
        }
    }

    void WebSessionConnection::Start()
    {
        _transition(ConnectionState::Connecting);

        // The thread holds a strong reference, so the connection outlives any
        // TermControl teardown until the loop notices Close() and exits.
        std::thread{ [strongThis = get_strong()]() {
            strongThis->_receiveLoop();
        } }.detach();
    }

    void WebSessionConnection::WriteInput(const winrt::array_view<const char16_t> buffer)
    {
        if (buffer.empty() || _closing.load(std::memory_order_relaxed))
        {
            return;
        }

        WDJ::JsonObject message;
        message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"input"));
        message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(_sessionId));
        message.SetNamedValue(L"data", WDJ::JsonValue::CreateStringValue(winrt::hstring{ reinterpret_cast<const wchar_t*>(buffer.data()), buffer.size() }));
        _send(winrt::to_string(message.Stringify()));
    }

    void WebSessionConnection::Resize(uint32_t rows, uint32_t columns)
    {
        if (rows == 0 || columns == 0 || _closing.load(std::memory_order_relaxed))
        {
            return;
        }

        WDJ::JsonObject message;
        message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"resize"));
        message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(_sessionId));
        message.SetNamedValue(L"cols", WDJ::JsonValue::CreateNumberValue(columns));
        message.SetNamedValue(L"rows", WDJ::JsonValue::CreateNumberValue(rows));
        _send(winrt::to_string(message.Stringify()));
    }

    void WebSessionConnection::Close() noexcept
    try
    {
        if (_closing.exchange(true, std::memory_order_relaxed))
        {
            return;
        }

        // Initiate the close handshake only; the receive loop owns the handle
        // lifetimes and tears them down when its pending receive completes.
        {
            std::lock_guard guard{ _socketMutex };
            if (_webSocket)
            {
                std::ignore = WinHttpWebSocketClose(_webSocket.get(), WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
            }
        }

        _transition(ConnectionState::Closed);
    }
    catch (...)
    {
    }

    void WebSessionConnection::_send(const std::string& utf8) noexcept
    {
        std::lock_guard guard{ _socketMutex };
        if (_connected.load(std::memory_order_relaxed) && _webSocket)
        {
            std::ignore = WinHttpWebSocketSend(_webSocket.get(),
                                               WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                               const_cast<char*>(utf8.data()),
                                               gsl::narrow_cast<DWORD>(utf8.size()));
        }
    }

    void WebSessionConnection::_receiveLoop()
    {
        auto backoff = InitialBackoffMs;
        while (!_closing.load(std::memory_order_relaxed))
        {
            if (!_connect())
            {
                Sleep(backoff);
                backoff = std::min(backoff * 2, MaxBackoffMs);
                continue;
            }
            backoff = InitialBackoffMs;

            // (Re)subscribe: the server replies with a full snapshot, then
            // streams incremental output for this session.
            {
                WDJ::JsonObject message;
                message.SetNamedValue(L"type", WDJ::JsonValue::CreateStringValue(L"subscribe"));
                message.SetNamedValue(L"sessionId", WDJ::JsonValue::CreateStringValue(_sessionId));
                message.SetNamedValue(L"slot", WDJ::JsonValue::CreateStringValue(L"native-orchestrator"));
                const auto utf8 = winrt::to_string(message.Stringify());
                std::lock_guard guard{ _socketMutex };
                if (_webSocket)
                {
                    std::ignore = WinHttpWebSocketSend(_webSocket.get(),
                                                       WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                                       const_cast<char*>(utf8.data()),
                                                       gsl::narrow_cast<DWORD>(utf8.size()));
                }
            }

            _connected.store(true, std::memory_order_relaxed);
            if (!_closing.load(std::memory_order_relaxed))
            {
                _transition(ConnectionState::Connected);
            }

            _receiveUntilError();

            _connected.store(false, std::memory_order_relaxed);
            _closeSocket();

            if (!_closing.load(std::memory_order_relaxed))
            {
                _transition(ConnectionState::Connecting);
            }
        }

        _closeSocket();
        _transition(ConnectionState::Closed);
    }

    bool WebSessionConnection::_connect() noexcept
    {
        try
        {
            // The in-proc bridge already tracks where the terminal-web server
            // actually listens (default port, or the recorded fallback when the
            // default is taken); follow it instead of re-deriving.
            std::wstring host{ L"127.0.0.1" };
            INTERNET_PORT port{ 10001 };
            {
                const auto endpoint = TerminalBridge::Instance().Endpoint();
                if (const auto colon = endpoint.rfind(L':'); colon != std::wstring::npos)
                {
                    host = endpoint.substr(0, colon);
                    const auto parsed = wcstoul(endpoint.c_str() + colon + 1, nullptr, 10);
                    if (parsed > 0 && parsed <= 65535)
                    {
                        port = gsl::narrow_cast<INTERNET_PORT>(parsed);
                    }
                }
            }

            wil::unique_winhttp_hinternet session{ WinHttpOpen(L"WindowsTerminal-Orchestrator/1.0",
                                                               WINHTTP_ACCESS_TYPE_NO_PROXY,
                                                               WINHTTP_NO_PROXY_NAME,
                                                               WINHTTP_NO_PROXY_BYPASS,
                                                               0) };
            if (!session)
            {
                return false;
            }

            wil::unique_winhttp_hinternet connection{ WinHttpConnect(session.get(), host.c_str(), port, 0) };
            if (!connection)
            {
                return false;
            }

            wil::unique_winhttp_hinternet request{ WinHttpOpenRequest(connection.get(), L"GET", L"/ws", nullptr, nullptr, nullptr, 0) };
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

            request.reset();

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

    void WebSessionConnection::_receiveUntilError()
    {
        std::string accumulated;
        std::vector<char> buffer(64 * 1024);
        for (;;)
        {
            DWORD read{};
            WINHTTP_WEB_SOCKET_BUFFER_TYPE bufferType{};
            const auto status = WinHttpWebSocketReceive(_webSocket.get(), buffer.data(), gsl::narrow_cast<DWORD>(buffer.size()), &read, &bufferType);
            if (status != NO_ERROR || bufferType == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE)
            {
                return;
            }

            accumulated.append(buffer.data(), read);
            if (bufferType == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE ||
                bufferType == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE)
            {
                _dispatch(accumulated);
                accumulated.clear();
            }
        }
    }

    void WebSessionConnection::_closeSocket() noexcept
    {
        std::lock_guard guard{ _socketMutex };
        _webSocket.reset();
        _connection.reset();
        _session.reset();
    }

    void WebSessionConnection::_dispatch(const std::string& utf8)
    try
    {
        WDJ::JsonObject obj{ nullptr };
        if (!WDJ::JsonObject::TryParse(winrt::to_hstring(utf8), obj))
        {
            return;
        }

        const auto type = obj.GetNamedString(L"type", L"");

        if (type == L"snapshot" && obj.GetNamedString(L"sessionId", L"") == _sessionId)
        {
            // Full reset, then replay the serialized screen (or the raw
            // transcript chunks when the server has no serialized screen).
            std::wstring replay{ L"\x1b" L"c" };
            if (const auto screen = obj.GetNamedString(L"screen", L""); !screen.empty())
            {
                replay.append(screen);
            }
            else if (obj.HasKey(L"chunks") && obj.Lookup(L"chunks").ValueType() == WDJ::JsonValueType::Array)
            {
                for (const auto& chunk : obj.GetNamedArray(L"chunks"))
                {
                    if (chunk.ValueType() == WDJ::JsonValueType::Object)
                    {
                        replay.append(chunk.GetObject().GetNamedString(L"data", L""));
                    }
                }
            }
            TerminalOutput.raise(winrt_wstring_to_array_view(replay));
            return;
        }

        if (type == L"output" && obj.GetNamedString(L"sessionId", L"") == _sessionId)
        {
            const auto data = obj.GetNamedString(L"data", L"");
            TerminalOutput.raise(winrt_wstring_to_array_view(std::wstring_view{ data }));
            return;
        }

        if (type == L"exit" && obj.GetNamedString(L"sessionId", L"") == _sessionId)
        {
            // The remote session ended; stop reconnecting.
            _closing.store(true, std::memory_order_relaxed);
            std::lock_guard guard{ _socketMutex };
            if (_webSocket)
            {
                std::ignore = WinHttpWebSocketClose(_webSocket.get(), WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
            }
        }
    }
    CATCH_LOG()
}

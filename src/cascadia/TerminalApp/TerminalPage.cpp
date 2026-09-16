
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TerminalPage.h"

#include <algorithm>
#include <fstream>
#include <mutex>
#include <shlobj_core.h>

#include <TerminalCore/ControlKeyStates.hpp>
#include <TerminalThemeHelpers.h>
#include <til/hash.h>
#include <til/unicode.h>
#include <Utils.h>

#include "../../types/inc/ColorFix.hpp"
#include "../../types/inc/utils.hpp"
#include "../TerminalSettingsAppAdapterLib/TerminalSettings.h"
#include "App.h"
#include "DebugTapConnection.h"
#include "MarkdownPaneContent.h"
#include "Remoting.h"
#include "ScratchpadContent.h"
#include "SettingsPaneContent.h"
#include "SnippetsPaneContent.h"
#include "TabRowControl.h"
#include "TerminalSettingsCache.h"

#include <winhttp.h>
#include <winrt/Windows.Data.Json.h>
#pragma comment(lib, "winhttp.lib")

#include "LaunchPositionRequest.g.cpp"
#include "WindowListEntry.g.cpp"
#include "WindowListRequest.g.cpp"
#include "RenameWindowRequestedArgs.g.cpp"
#include "OpenWindowRequestedArgs.g.cpp"
#include "RequestMoveContentArgs.g.cpp"
#include "TerminalPage.g.cpp"

using namespace winrt;
using namespace winrt::Microsoft::Management::Deployment;
using namespace winrt::Microsoft::Terminal::Control;
using namespace winrt::Microsoft::Terminal::Settings::Model;
using namespace winrt::Microsoft::Terminal::TerminalConnection;
using namespace winrt::Microsoft::Terminal;
using namespace winrt::Windows::ApplicationModel::DataTransfer;
using namespace winrt::Windows::Foundation::Collections;
using namespace winrt::Windows::System;
using namespace winrt::Windows::UI;
using namespace winrt::Windows::UI::Core;
using namespace winrt::Windows::UI::Text;
using namespace winrt::Windows::UI::Xaml::Controls;
using namespace winrt::Windows::UI::Xaml;
using namespace winrt::Windows::UI::Xaml::Media;
using namespace ::TerminalApp;
using namespace ::Microsoft::Console;
using namespace ::Microsoft::Terminal::Core;
using namespace std::chrono_literals;

#define HOOKUP_ACTION(action) _actionDispatch->action({ this, &TerminalPage::_Handle##action });

namespace winrt
{
    namespace MUX = Microsoft::UI::Xaml;
    namespace WUX = Windows::UI::Xaml;
    namespace WDJ = Windows::Data::Json;
    using IInspectable = Windows::Foundation::IInspectable;
    using VirtualKeyModifiers = Windows::System::VirtualKeyModifiers;
}

namespace
{
    using unique_winhttp_handle = wil::unique_any<HINTERNET, decltype(&::WinHttpCloseHandle), ::WinHttpCloseHandle>;

    // Minimal synchronous HTTP client for the local terminal-web server that
    // backs the project tabs. Only ever call this from a background thread.
    // The bridge host may not sit on the default port (automatic port
    // selection, or another process owning it), so resolve "host:port" from
    // the live bridge endpoint every time.
    std::pair<std::wstring, INTERNET_PORT> _projectServerEndpoint()
    {
        std::wstring host{ L"127.0.0.1" };
        INTERNET_PORT port{ 10001 };
        try
        {
            const std::wstring endpoint{ winrt::Microsoft::Terminal::TerminalConnection::ConptyConnection::BridgeEndpoint() };
            const auto colon{ endpoint.rfind(L':') };
            if (colon != std::wstring::npos && colon + 1 < endpoint.size())
            {
                const auto parsed{ std::stoul(endpoint.substr(colon + 1)) };
                if (parsed > 0 && parsed <= 65535)
                {
                    port = static_cast<INTERNET_PORT>(parsed);
                    const auto candidate{ endpoint.substr(0, colon) };
                    // Bind addresses aren't connectable; always use loopback for those.
                    if (!candidate.empty() && candidate != L"0.0.0.0" && candidate != L"::" && candidate != L"[::]")
                    {
                        host = candidate;
                    }
                }
            }
        }
        CATCH_LOG();
        return { host, port };
    }

    struct ProjectServerResponse
    {
        DWORD Status{ 0 };
        std::string Body;
    };

    // Synchronous request to the bridge host; call from a background thread.
    // Returns the HTTP status and body for any completed exchange, or nullopt
    // when the host could not be reached at all.
    std::optional<ProjectServerResponse> _projectServerRequestDetailed(const wchar_t* verb, const std::wstring& path, const std::string& body = {})
    {
        const unique_winhttp_handle session{ WinHttpOpen(L"WindowsTerminal-Projects/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0) };
        if (!session)
        {
            return std::nullopt;
        }

        const auto [host, port] = _projectServerEndpoint();
        const unique_winhttp_handle connection{ WinHttpConnect(session.get(), host.c_str(), port, 0) };
        if (!connection)
        {
            return std::nullopt;
        }

        const unique_winhttp_handle request{ WinHttpOpenRequest(connection.get(), verb, path.c_str(), nullptr, nullptr, nullptr, 0) };
        if (!request)
        {
            return std::nullopt;
        }

        const auto* const headers = body.empty() ? nullptr : L"Content-Type: application/json\r\n";
        const auto headersLength = body.empty() ? 0UL : static_cast<DWORD>(-1);
        auto* const optionalData = body.empty() ? nullptr : const_cast<char*>(body.data());
        const auto bodySize = gsl::narrow_cast<DWORD>(body.size());
        if (!WinHttpSendRequest(request.get(), headers, headersLength, optionalData, bodySize, bodySize, 0))
        {
            return std::nullopt;
        }
        if (!WinHttpReceiveResponse(request.get(), nullptr))
        {
            return std::nullopt;
        }

        DWORD statusCode{};
        DWORD statusCodeSize{ sizeof(statusCode) };
#pragma warning(suppress : 26477) // WINHTTP_HEADER_NAME_BY_INDEX expands to NULL rather than nullptr.
        if (!WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusCodeSize, WINHTTP_NO_HEADER_INDEX))
        {
            return std::nullopt;
        }
        std::string response;
        for (;;)
        {
            DWORD available{};
            if (!WinHttpQueryDataAvailable(request.get(), &available))
            {
                return std::nullopt;
            }
            if (available == 0)
            {
                break;
            }

            const auto offset = response.size();
            response.resize(offset + available);
            DWORD read{};
            if (!WinHttpReadData(request.get(), response.data() + offset, available, &read))
            {
                return std::nullopt;
            }
            response.resize(offset + read);
        }
        return ProjectServerResponse{ statusCode, std::move(response) };
    }

    // The common case: the body of a 2xx response, nothing otherwise.
    std::optional<std::string> _projectServerRequest(const wchar_t* verb, const std::wstring& path, const std::string& body = {})
    {
        auto response{ _projectServerRequestDetailed(verb, path, body) };
        if (!response || response->Status < 200 || response->Status >= 300)
        {
            return std::nullopt;
        }
        return std::move(response->Body);
    }

    // Pulls the `message`/`detail` out of a bridge error body, or falls back
    // to the status code.
    std::wstring _projectServerErrorMessage(const std::optional<ProjectServerResponse>& response)
    {
        if (!response)
        {
            return L"Bridge server offline";
        }
        try
        {
            winrt::Windows::Data::Json::JsonObject obj{ nullptr };
            if (winrt::Windows::Data::Json::JsonObject::TryParse(winrt::to_hstring(response->Body), obj))
            {
                std::wstring message{ obj.GetNamedString(L"message", L"") };
                const std::wstring detail{ obj.GetNamedString(L"detail", L"") };
                if (!detail.empty())
                {
                    message += message.empty() ? detail : L" " + detail;
                }
                if (!message.empty())
                {
                    return message;
                }
            }
        }
        CATCH_LOG();
        return L"The bridge host answered HTTP " + std::to_wstring(response->Status);
    }
}

namespace clipboard
{
    static SRWLOCK lock = SRWLOCK_INIT;

    struct ClipboardHandle
    {
        explicit ClipboardHandle(bool open) :
            _open{ open }
        {
        }

        ~ClipboardHandle()
        {
            if (_open)
            {
                ReleaseSRWLockExclusive(&lock);
                CloseClipboard();
            }
        }

        explicit operator bool() const noexcept
        {
            return _open;
        }

    private:
        bool _open = false;
    };

    ClipboardHandle open(HWND hwnd)
    {
        // Turns out, OpenClipboard/CloseClipboard are not thread-safe whatsoever,
        // and on CloseClipboard, the GetClipboardData handle may get freed.
        // The problem is that WinUI also uses OpenClipboard (through WinRT which uses OLE),
        // and so even with this mutex we can still crash randomly if you copy something via WinUI.
        // Makes you wonder how many Windows apps are subtly broken, huh.
        AcquireSRWLockExclusive(&lock);

        bool success = false;

        // OpenClipboard may fail to acquire the internal lock --> retry.
        for (DWORD sleep = 10;; sleep *= 2)
        {
            if (OpenClipboard(hwnd))
            {
                success = true;
                break;
            }
            // 10 iterations
            if (sleep > 10000)
            {
                break;
            }
            Sleep(sleep);
        }

        if (!success)
        {
            ReleaseSRWLockExclusive(&lock);
        }

        return ClipboardHandle{ success };
    }

    void write(wil::zwstring_view text, std::string_view html, std::string_view rtf)
    {
        static const auto regular = [](const UINT format, const void* src, const size_t bytes) {
            wil::unique_hglobal handle{ THROW_LAST_ERROR_IF_NULL(GlobalAlloc(GMEM_MOVEABLE, bytes)) };

            const auto locked = GlobalLock(handle.get());
            memcpy(locked, src, bytes);
            GlobalUnlock(handle.get());

            THROW_LAST_ERROR_IF_NULL(SetClipboardData(format, handle.get()));
            handle.release();
        };
        static const auto registered = [](const wchar_t* format, const void* src, size_t bytes) {
            const auto id = RegisterClipboardFormatW(format);
            if (!id)
            {
                LOG_LAST_ERROR();
                return;
            }
            regular(id, src, bytes);
        };

        EmptyClipboard();

        if (!text.empty())
        {
            // As per: https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats
            //   CF_UNICODETEXT: [...] A null character signals the end of the data.
            // --> We add +1 to the length. This works because .c_str() is null-terminated.
            regular(CF_UNICODETEXT, text.c_str(), (text.size() + 1) * sizeof(wchar_t));
        }

        if (!html.empty())
        {
            registered(L"HTML Format", html.data(), html.size());
        }

        if (!rtf.empty())
        {
            registered(L"Rich Text Format", rtf.data(), rtf.size());
        }
    }

    winrt::hstring read()
    {
        // This handles most cases of pasting text as the OS converts most formats to CF_UNICODETEXT automatically.
        if (const auto handle = GetClipboardData(CF_UNICODETEXT))
        {
            const wil::unique_hglobal_locked lock{ handle };
            const auto str = static_cast<const wchar_t*>(lock.get());
            if (!str)
            {
                return {};
            }

            const auto maxLen = GlobalSize(handle) / sizeof(wchar_t);
            const auto len = wcsnlen(str, maxLen);
            return winrt::hstring{ str, gsl::narrow_cast<uint32_t>(len) };
        }

        // We get CF_HDROP when a user copied a file with Ctrl+C in Explorer and pastes that into the terminal (among others).
        if (const auto handle = GetClipboardData(CF_HDROP))
        {
            const wil::unique_hglobal_locked lock{ handle };
            const auto drop = static_cast<HDROP>(lock.get());
            if (!drop)
            {
                return {};
            }

            const auto cap = DragQueryFileW(drop, 0, nullptr, 0);
            if (cap == 0)
            {
                return {};
            }

            auto buffer = winrt::impl::hstring_builder{ cap };
            const auto len = DragQueryFileW(drop, 0, buffer.data(), cap + 1);
            if (len == 0)
            {
                return {};
            }

            return buffer.to_hstring();
        }

        return {};
    }
} // namespace clipboard

namespace winrt::TerminalApp::implementation
{
    // Reads a whole file as bytes. Returns "" when it cannot be read.
    static std::string _readFileUtf8(const std::filesystem::path& path)
    {
        std::ifstream stream{ path, std::ios::binary };
        if (!stream)
        {
            return {};
        }
        std::string text{ std::istreambuf_iterator<char>{ stream }, std::istreambuf_iterator<char>{} };
        // PowerShell writes a UTF-8 BOM into profiles it creates; keep the
        // text BOM-free internally and put one back on write.
        static constexpr std::string_view bom{ "\xEF\xBB\xBF" };
        if (text.starts_with(bom))
        {
            text.erase(0, bom.size());
        }
        return text;
    }

    // Writes a file as UTF-8 with a BOM, atomically via a sibling temp file so
    // a profile is never left truncated.
    static void _writeFileUtf8(const std::filesystem::path& path, std::string_view text)
    {
        auto temporary = path;
        temporary += L".wt-new";
        {
            std::ofstream stream{ temporary, std::ios::binary | std::ios::trunc };
            if (!stream)
            {
                return;
            }
            // Windows PowerShell 5.1 reads a BOM-less file as ANSI, which
            // would mangle a non-ASCII path in the block.
            stream << "\xEF\xBB\xBF" << text;
        }
        std::error_code ec;
        std::filesystem::rename(temporary, path, ec);
        if (ec)
        {
            std::filesystem::remove(temporary, ec);
        }
    }

    // The managed block that shell-integration installs into a PowerShell
    // profile, and the markers that let it be found and replaced in place.
    //
    // Everything about grouping tabs by directory depends on the shell saying
    // where it is. PowerShell is the one shell that can never be inferred from
    // the outside: Set-Location moves its provider location, not the process
    // cwd that the PEB holds, so a pwsh tab that has not reported looks like it
    // never left the directory it launched in. OSC 9;9 from the prompt is the
    // only source of truth, and the prompt runs after every command, so `cd`
    // reports immediately.
    //
    // The block wraps whatever prompt the earlier profiles installed instead of
    // replacing it, and lives in the current-host profile, which loads last, so
    // it wins without clobbering oh-my-posh/starship style prompts.
    static constexpr std::wstring_view shellIntegrationBeginMarker{ L"# >>> Windows Terminal working directory reporting (managed) >>>" };
    static constexpr std::wstring_view shellIntegrationEndMarker{ L"# <<< Windows Terminal working directory reporting (managed) <<<" };

    // Markers from earlier iterations of this feature. They dot-sourced a
    // script out of the package LocalState folder, which re-registering the
    // dev package deletes - leaving a Test-Path guarded no-op behind that
    // silently reported nothing. Strip them wherever they are still present.
    static constexpr std::array legacyShellIntegrationMarkers{
        std::pair{ std::wstring_view{ L"# >>> Windows Terminal path tab color shell integration >>>" },
                   std::wstring_view{ L"# <<< Windows Terminal path tab color shell integration <<<" } },
    };

    static std::wstring _shellIntegrationBlock()
    {
        std::wstring block;
        block.append(shellIntegrationBeginMarker);
        block.append(L"\n");
        block.append(LR"(# Reports the current directory to Windows Terminal (OSC 9;9) on every prompt
# so tabs can be grouped by the directory they are working in. Managed by
# Windows Terminal: this block is rewritten on launch, so edit it there.
if ($env:WT_SESSION) {
    # Capture whatever prompt is installed so it keeps rendering. Never
    # capture this wrapper itself: doing so makes prompt call itself, which
    # recurses until the prompt is nothing but escape sequences. Matching on
    # the body rather than trusting the variable also survives the variable
    # being removed while the function is still in place.
    $existingPrompt = $function:prompt
    if ($existingPrompt -and "$existingPrompt" -notmatch '__WTPromptInner') {
        $global:__WTPromptInner = $existingPrompt
    }

    function global:prompt {
        $inner = if ($global:__WTPromptInner) {
            & $global:__WTPromptInner
        }
        else {
            "PS $($ExecutionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
        }

        $location = $ExecutionContext.SessionState.Path.CurrentLocation
        if ($location.Provider.Name -ne 'FileSystem') {
            return $inner
        }

        $report = "$([char]27)]9;9;`"$($location.ProviderPath)`"$([char]27)\"
        # A prompt function may return several strings; prefixing the array
        # would stringify it, so only the first line carries the report.
        if ($inner -is [array] -and $inner.Count -gt 0) {
            $inner[0] = $report + [string]$inner[0]
            return $inner
        }
        return $report + [string]$inner
    }
}
)");
        block.append(shellIntegrationEndMarker);
        block.append(L"\n");
        return block;
    }

    // Removes a marker-delimited block (and the blank lines around it) from
    // `text`. Returns true when something was removed.
    static bool _removeManagedBlock(std::wstring& text, std::wstring_view begin, std::wstring_view end)
    {
        auto removed = false;
        for (;;)
        {
            const auto from = text.find(begin);
            if (from == std::wstring::npos)
            {
                break;
            }
            auto to = text.find(end, from);
            if (to == std::wstring::npos)
            {
                // Truncated block (hand-edited, or a failed earlier write):
                // drop everything from the marker on rather than leave half.
                to = text.size();
            }
            else
            {
                to += end.size();
                // Take the line break that ended the marker line with it.
                if (to < text.size() && text[to] == L'\r')
                {
                    ++to;
                }
                if (to < text.size() && text[to] == L'\n')
                {
                    ++to;
                }
            }

            // Cut whole lines. Trimming by character instead would split a
            // CRLF and leave a stray carriage return welded to the line above
            // when the block sits in the middle of a profile.
            const auto previousBreak = text.rfind(L'\n', from);
            const auto start = previousBreak == std::wstring::npos ? 0 : previousBreak + 1;

            text.erase(start, to - start);
            removed = true;
        }
        return removed;
    }

    // Method Description:
    // - Makes sure every PowerShell that starts in a Terminal tab reports its
    //   working directory, by keeping a managed block at the end of the user's
    //   PowerShell profiles. Idempotent, and only writes when the content
    //   actually differs, so a launch does not touch the file needlessly.
    // - Off the UI thread: this is file I/O in the user's profile folder,
    //   which may be redirected to OneDrive.
    static void _installShellIntegration()
    {
        wil::unique_cotaskmem_string documents;
        if (FAILED(SHGetKnownFolderPath(FOLDERID_Documents, KF_FLAG_DEFAULT, nullptr, &documents)) || !documents)
        {
            return;
        }

        const std::filesystem::path documentsPath{ documents.get() };
        // pwsh 7 and Windows PowerShell 5.1 keep separate profiles, and both
        // land in a Terminal tab. CurrentUserCurrentHost is the last profile
        // PowerShell loads, so a prompt installed here wraps every other one.
        const std::array profiles{
            documentsPath / L"PowerShell" / L"Microsoft.PowerShell_profile.ps1",
            documentsPath / L"WindowsPowerShell" / L"Microsoft.PowerShell_profile.ps1",
        };

        const auto block = _shellIntegrationBlock();

        for (const auto& profile : profiles)
        {
            try
            {
                std::wstring existing;
                std::error_code ec;
                if (std::filesystem::exists(profile, ec) && !ec)
                {
                    existing = til::u8u16(_readFileUtf8(profile));
                }

                auto updated = existing;
                for (const auto& [begin, end] : legacyShellIntegrationMarkers)
                {
                    _removeManagedBlock(updated, begin, end);
                }
                _removeManagedBlock(updated, shellIntegrationBeginMarker, shellIntegrationEndMarker);

                // Append the current block at the very end.
                while (!updated.empty() && (updated.back() == L'\n' || updated.back() == L'\r'))
                {
                    updated.pop_back();
                }
                if (!updated.empty())
                {
                    updated.append(L"\n\n");
                }
                updated.append(block);

                if (updated == existing)
                {
                    continue;
                }

                std::filesystem::create_directories(profile.parent_path(), ec);
                _writeFileUtf8(profile, til::u16u8(updated));
            }
            CATCH_LOG();
        }
    }

    static safe_void_coroutine _installShellIntegrationAsync()
    {
        // Profile files may sit on a redirected (OneDrive) Documents folder,
        // so keep this off the UI thread.
        co_await winrt::resume_background();
        _installShellIntegration();
    }

    static constexpr double MinimumTerminalContentWidth = 320.0;

    TerminalPage::TerminalPage(TerminalApp::WindowProperties properties, const TerminalApp::ContentManager& manager) :
        _tabs{ winrt::single_threaded_observable_vector<TerminalApp::Tab>() },
        _mruTabs{ winrt::single_threaded_observable_vector<TerminalApp::Tab>() },
        _manager{ manager },
        _hostingHwnd{},
        _WindowProperties{ std::move(properties) }
    {
        InitializeComponent();
        _WindowProperties.PropertyChanged({ get_weak(), &TerminalPage::_windowPropertyChanged });
    }

    // Method Description:
    // - implements the IInitializeWithWindow interface from shobjidl_core.
    // - We're going to use this HWND as the owner for the ConPTY windows, via
    //   ConptyConnection::ReparentWindow. We need this for applications that
    //   call GetConsoleWindow, and attempt to open a MessageBox for the
    //   console. By marking the conpty windows as owned by the Terminal HWND,
    //   the message box will be owned by the Terminal window as well.
    //   - see GH#2988
    HRESULT TerminalPage::Initialize(HWND hwnd)
    {
        if (!_hostingHwnd.has_value())
        {
            // GH#13211 - if we haven't yet set the owning hwnd, reparent all the controls now.
            for (const auto& tab : _tabs)
            {
                if (auto tabImpl{ _GetTabImpl(tab) })
                {
                    tabImpl->GetRootPane()->WalkTree([&](auto&& pane) {
                        if (const auto& term{ pane->GetTerminalControl() })
                        {
                            term.OwningHwnd(reinterpret_cast<uint64_t>(hwnd));
                        }
                    });
                }
                // We don't need to worry about resetting the owning hwnd for the
                // SUI here. GH#13211 only repros for a defterm connection, where
                // the tab is spawned before the window is created. It's not
                // possible to make a SUI tab like that, before the window is
                // created. The SUI could be spawned as a part of a window restore,
                // but that would still work fine. The window would be created
                // before restoring previous tabs in that scenario.
            }
        }

        _hostingHwnd = hwnd;
        return S_OK;
    }

    // INVARIANT: This needs to be called on OUR UI thread!
    void TerminalPage::SetSettings(CascadiaSettings settings, bool needRefreshUI)
    {
        assert(Dispatcher().HasThreadAccess());
        if (_settings == nullptr)
        {
            // Create this only on the first time we load the settings.
            _terminalSettingsCache = std::make_shared<TerminalSettingsCache>(settings, settings.WindowSettings(_WindowProperties.WindowName()));
        }
        _settings = settings;

        const auto globals = _settings.GlobalSettings();
        TerminalConnection::ConptyConnection::ConfigureBridge(
            globals.BridgeEnabled(),
            globals.BridgeAutomaticPort(),
            static_cast<uint16_t>(std::clamp(globals.BridgePort(), 1, 65535)),
            globals.BridgeBindAddress(),
            globals.BridgeWebInterface());

        // Make sure to call SetCommands before _RefreshUIForSettingsReload.
        // SetCommands will make sure the KeyChordText of Commands is updated, which needs
        // to happen before the Settings UI is reloaded and tries to re-read those values.
        if (const auto p = CommandPaletteElement())
        {
            p.SetActionMap(_settings.ActionMap());
        }

        if (needRefreshUI)
        {
            _RefreshUIForSettingsReload();
        }

        // Upon settings update we reload the system settings for scrolling as well.
        // TODO: consider reloading this value periodically.
        _systemRowsToScroll = _ReadSystemRowsToScroll();
    }

    winrt::Microsoft::Terminal::Settings::Model::WindowSettings TerminalPage::_currentWindowSettings() const
    {
        return _settings.WindowSettings(_WindowProperties.WindowName());
    }

    bool TerminalPage::IsRunningElevated() const noexcept
    {
        // GH#2455 - Make sure to try/catch calls to Application::Current,
        // because that _won't_ be an instance of TerminalApp::App in the
        // LocalTests
        try
        {
            return Application::Current().as<TerminalApp::App>().Logic().IsRunningElevated();
        }
        CATCH_LOG();
        return false;
    }
    bool TerminalPage::CanDragDrop() const noexcept
    {
        try
        {
            return Application::Current().as<TerminalApp::App>().Logic().CanDragDrop();
        }
        CATCH_LOG();
        return true;
    }

    void TerminalPage::Create()
    {
        // Hookup the key bindings
        _HookupKeyBindings(_settings.ActionMap());

        _tabContent = this->TabContent();
        _tabRow = this->TabRow();
        _tabView = _tabRow.TabView();
        _rearranging = false;

        // The terminal-web bridge lives on background threads inside
        // TerminalConnection, so poll its status and reflect changes in the
        // window title instead of marshalling events across the boundary.
        _bridgeStatusTimer.Interval(std::chrono::milliseconds(2000));
        _bridgeStatusTimer.Tick({ get_weak(), &TerminalPage::_BridgeStatusTimerTick });
        _bridgeStatusTimer.Start();

        // Keep the shell reporting its working directory. A shell that never
        // emits OSC 7 / OSC 9;9 cannot be tracked from the outside - pwsh in
        // particular leaves its process cwd at the launch directory across
        // every `cd` - so grouping tabs by directory depends on this being in
        // place. Idempotent, and only writes when the content differs.
        if (_settings.GlobalSettings().AutoInstallShellIntegration())
        {
            static std::once_flag once;
            std::call_once(once, []() { _installShellIntegrationAsync(); });
        }

        // Directory and branch sweep. A reporting shell delivers its directory
        // on an event the moment it changes; this catches what events cannot -
        // shells with no integration, TUI agents that never report, and
        // branch changes made outside the terminal, which move no directory.
        _directoryRefreshTimer.Interval(std::chrono::milliseconds(3000));
        _directoryRefreshTimer.Tick({ get_weak(), &TerminalPage::_DirectoryRefreshTimerTick });
        _directoryRefreshTimer.Start();

        // Populate the project strip ("All" + "+") immediately; the timer
        // tick keeps it in sync with the terminal-web store afterwards.
        _RebuildProjectTabs();

        // Orchestrator panel: header actions, composer, quick prompts and the
        // settings flyout. Status polling rides the 2s bridge tick while the
        // pane is open, plus a faster timer while a turn is streaming.
        {
            const auto weakThis{ get_weak() };
            OrchestratorToggleButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_ToggleOrchestratorPane();
                }
            });
            OrchestratorCollapseButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_ToggleOrchestratorPane();
                }
            });
            OrchestratorClearButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_ResetOrchestratorTranscript();
                    page->_UpdateOrchestratorChrome();
                    page->_PostOrchestratorCommand(L"DELETE", L"/api/orchestrator/messages", "");
                }
            });
            OrchestratorSendButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_SendOrchestratorMessage(page->OrchestratorComposer().Text());
                }
            });
            OrchestratorStopButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_PostOrchestratorCommand(L"POST", L"/api/orchestrator/cancel", "{}");
                }
            });
            for (const auto& child : OrchestratorQuickPrompts().Children())
            {
                if (const auto button{ child.try_as<Button>() })
                {
                    button.Click([weakThis](auto&& sender, auto&&) {
                        if (const auto page{ weakThis.get() })
                        {
                            const auto prompt{ winrt::unbox_value_or<winrt::hstring>(sender.template as<FrameworkElement>().Tag(), L"") };
                            page->_SendOrchestratorMessage(prompt);
                        }
                    });
                }
            }
            OrchestratorTranscriptScroller().ViewChanged([weakThis](auto&& sender, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    const auto scroller{ sender.template as<ScrollViewer>() };
                    page->_orchestratorStickToBottom = scroller.VerticalOffset() + scroller.ViewportHeight() >= scroller.ScrollableHeight() - 40.0;
                }
            });

            // Settings flyout.
            OrchestratorSettingsFlyout().Opening([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_PopulateOrchestratorSettings();
                }
            });
            OrchestratorProviderBox().SelectionChanged([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    const auto selected{ page->OrchestratorProviderBox().SelectedItem().try_as<ComboBoxItem>() };
                    const auto provider{ selected ? winrt::unbox_value_or<winrt::hstring>(selected.Tag(), L"openrouter") : winrt::hstring{ L"openrouter" } };
                    const auto custom = provider == L"custom";
                    page->OrchestratorBaseUrlBox().Visibility(custom ? Visibility::Visible : Visibility::Collapsed);
                    if (custom && page->OrchestratorKeyEnvBox().Text() == L"OPENROUTER_API_KEY")
                    {
                        page->OrchestratorKeyEnvBox().Text(L"OPENAI_API_KEY");
                    }
                    else if (!custom && page->OrchestratorKeyEnvBox().Text() == L"OPENAI_API_KEY")
                    {
                        page->OrchestratorKeyEnvBox().Text(L"OPENROUTER_API_KEY");
                    }
                }
            });
            OrchestratorRefreshModelsButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_LoadOrchestratorModels(true);
                }
            });
            OrchestratorModelList().SelectionChanged([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    if (const auto selected{ page->OrchestratorModelList().SelectedItem().try_as<ListViewItem>() })
                    {
                        const auto id{ winrt::unbox_value_or<winrt::hstring>(selected.Tag(), L"") };
                        if (!id.empty())
                        {
                            page->OrchestratorModelBox().Text(id);
                        }
                    }
                }
            });
            OrchestratorModelSearchBox().TextChanged([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_FilterOrchestratorModels();
                }
            });
            OrchestratorSaveButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_SaveOrchestratorConfig(page->_OrchestratorConfigBody(true));
                }
            });
            OrchestratorUseKeyButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_SaveOrchestratorConfig(page->_OrchestratorConfigBody(true));
                }
            });
            OrchestratorForgetKeyButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_SaveOrchestratorConfig(R"({"apiKey":""})");
                }
            });
            OrchestratorTestButton().Click([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_TestOrchestratorConnection();
                }
            });

            _orchestratorPollTimer = DispatcherTimer{};
            _orchestratorPollTimer.Interval(std::chrono::milliseconds(350));
            _orchestratorPollTimer.Tick([weakThis](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    page->_RefreshOrchestratorStatus();
                }
            });
        }

        // Accept project-tab drags for reordering.
        {
            const auto panel{ ProjectTabPanel() };
            panel.AllowDrop(true);
            panel.DragOver([](const IInspectable&, const WUX::DragEventArgs& e) {
                e.AcceptedOperation(DataPackageOperation::Move);
            });
            panel.Drop([weakThis = get_weak()](const IInspectable&, const WUX::DragEventArgs& e) {
                const auto page{ weakThis.get() };
                if (!page || !e.DataView().Contains(StandardDataFormats::Text()))
                {
                    return;
                }

                const auto dropX = e.GetPosition(page->ProjectTabPanel()).X;
                const auto deferral{ e.GetDeferral() };
                e.DataView().GetTextAsync().Completed([weakThis, dropX, deferral](const auto& operation, const auto status) {
                    if (status == Windows::Foundation::AsyncStatus::Completed)
                    {
                        if (const auto page{ weakThis.get() })
                        {
                            // The coroutine marshals itself back to the UI thread.
                            page->_SectionDropReorder(operation.GetResults(), dropX);
                        }
                    }
                    deferral.Complete();
                });
            });
        }

        const auto canDragDrop = CanDragDrop();

        _tabView.CanReorderTabs(canDragDrop);
        _tabView.CanDragTabs(canDragDrop);
        _tabView.TabDragStarting({ get_weak(), &TerminalPage::_TabDragStarted });
        _tabView.TabDragCompleted({ get_weak(), &TerminalPage::_TabDragCompleted });

        auto tabRowImpl = winrt::get_self<implementation::TabRowControl>(_tabRow);
        _newTabButton = tabRowImpl->NewTabButton();
        _workspaceFlyout = tabRowImpl->WorkspaceFlyout();
        _workspaceDropdown = tabRowImpl->WorkspaceDropdown();
        // The rail's headings are the project strip's contents, so subscribe
        // before handing it the tabs: SetTabs computes the first set of
        // sections and this is what turns them into chips.
        tabRowImpl->RailSectionsChanged = [weakThis{ get_weak() }]() {
            if (auto page{ weakThis.get() })
            {
                page->_OnRailSectionsChanged();
            }
        };
        tabRowImpl->SetTabs(_tabs);
        tabRowImpl->VerticalTabSelected([weakThis{ get_weak() }](auto&&, const auto& tab) {
            if (auto page{ weakThis.get() })
            {
                page->_SetFocusedTab(tab);
            }
        });
        tabRowImpl->VerticalTabMoveRequested = [weakThis{ get_weak() }](const auto& tab, const uint32_t targetIndex) {
            if (auto page{ weakThis.get() })
            {
                if (const auto currentIndex{ page->_GetTabIndex(tab) })
                {
                    page->_TryMoveTab(*currentIndex, static_cast<int32_t>(targetIndex));
                }
            }
        };
        // The [+] on a project header in the rail opens a terminal in that
        // project's directory.
        tabRowImpl->NewTabInDirectoryRequested = [weakThis{ get_weak() }](const winrt::hstring& directory) {
            if (auto page{ weakThis.get() })
            {
                NewTerminalArgs args;
                args.StartingDirectory(directory);
                page->_OpenNewTerminalViaDropdown(args);
            }
        };

        // Set the initial workspace name from the window name.
        // Use raw WindowName() so unnamed windows show no text.
        _tabRow.WorkspaceName(_WindowProperties.WindowName());

        // Rebuild the workspace flyout each time it opens so it always
        // reflects the latest set of persisted workspaces.
        _workspaceFlyout.Opening([weakThis{ get_weak() }](auto&&, auto&&) {
            if (auto page{ weakThis.get() })
            {
                page->_PopulateWorkspaceFlyout();
            }
        });

        static constexpr bool useVerticalTabs = true;
        if (!useVerticalTabs && _currentWindowSettings().ShowTabsInTitlebar())
        {
            // Remove the TabView from the page. We'll hang on to it, we need to
            // put it in the titlebar.
            uint32_t index = 0;
            if (this->Root().Children().IndexOf(_tabRow, index))
            {
                this->Root().Children().RemoveAt(index);
            }

            // Inform the host that our titlebar content has changed.
            SetTitleBarContent.raise(*this, _tabRow);

            // GH#13143 Manually set the tab row's background to transparent here.
            //
            // We're doing it this way because ThemeResources are tricky. We
            // default in XAML to using the appropriate ThemeResource background
            // color for our TabRow. When tabs in the titlebar are _disabled_,
            // this will ensure that the tab row has the correct theme-dependent
            // value. When tabs in the titlebar are _enabled_ (the default),
            // we'll switch the BG to Transparent, to let the Titlebar Control's
            // background be used as the BG for the tab row.
            //
            // We can't do it the other way around (default to Transparent, only
            // switch to a color when disabling tabs in the titlebar), because
            // looking up the correct ThemeResource from and App dictionary is a
            // capital-H Hard problem.
            const auto transparent = Media::SolidColorBrush();
            transparent.Color(Windows::UI::Colors::Transparent());
            _tabRow.Background(transparent);
        }
        _updateThemeColors();

        // Initialize the state of the CloseButtonOverlayMode property of
        // our TabView, to match the tab.showCloseButton property in the theme.
        if (const auto theme = _settings.GlobalSettings().CurrentTheme(_currentWindowSettings()))
        {
            const auto visibility = theme.Tab() ? theme.Tab().ShowCloseButton() : Settings::Model::TabCloseButtonVisibility::Always;

            _tabItemMiddleClickHookEnabled = visibility == Settings::Model::TabCloseButtonVisibility::Never;

            switch (visibility)
            {
            case Settings::Model::TabCloseButtonVisibility::Never:
                _tabView.CloseButtonOverlayMode(MUX::Controls::TabViewCloseButtonOverlayMode::Auto);
                break;
            case Settings::Model::TabCloseButtonVisibility::Hover:
                _tabView.CloseButtonOverlayMode(MUX::Controls::TabViewCloseButtonOverlayMode::OnPointerOver);
                break;
            default:
                _tabView.CloseButtonOverlayMode(MUX::Controls::TabViewCloseButtonOverlayMode::Always);
                break;
            }
        }

        // Hookup our event handlers to the ShortcutActionDispatch
        _RegisterActionCallbacks();

        //Event Bindings (Early)
        _newTabButton.Click([weakThis{ get_weak() }](auto&&, auto&&) {
            if (auto page{ weakThis.get() })
            {
                TraceLoggingWrite(
                    g_hTerminalAppProvider,
                    "NewTabMenuDefaultButtonClicked",
                    TraceLoggingDescription("Event emitted when the default button from the new tab split button is invoked"),
                    TraceLoggingValue(page->NumberOfTabs(), "TabCount", "The count of tabs currently opened in this window"),
                    TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
                    TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));

                page->_OpenNewTerminalViaDropdown(NewTerminalArgs());
            }
        });
        _newTabButton.Drop({ get_weak(), &TerminalPage::_NewTerminalByDrop });
        _tabView.SelectionChanged({ this, &TerminalPage::_OnTabSelectionChanged });
        _tabView.TabCloseRequested({ this, &TerminalPage::_OnTabCloseRequested });
        _tabView.TabItemsChanged({ this, &TerminalPage::_OnTabItemsChanged });

        _tabView.TabDragStarting({ this, &TerminalPage::_onTabDragStarting });
        _tabView.TabStripDragOver({ this, &TerminalPage::_onTabStripDragOver });
        _tabView.TabStripDrop({ this, &TerminalPage::_onTabStripDrop });
        _tabView.TabDroppedOutside({ this, &TerminalPage::_onTabDroppedOutside });

        _CreateNewTabFlyout();

        _UpdateTabWidthMode();

        // Settings AllowDependentAnimations will affect whether animations are
        // enabled application-wide, so we don't need to check it each time we
        // want to create an animation.
        WUX::Media::Animation::Timeline::AllowDependentAnimations(!_currentWindowSettings().DisableAnimations());

        // Once the page is actually laid out on the screen, trigger all our
        // startup actions. Things like Panes need to know at least how big the
        // window will be, so they can subdivide that space.
        //
        // _OnFirstLayout will remove this handler so it doesn't get called more than once.
        _layoutUpdatedRevoker = _tabContent.LayoutUpdated(winrt::auto_revoke, { this, &TerminalPage::_OnFirstLayout });

        _isAlwaysOnTop = _currentWindowSettings().AlwaysOnTop();
        _showTabsFullscreen = _currentWindowSettings().ShowTabsFullscreen();

        // DON'T set up Toasts/TeachingTips here. They should be loaded and
        // initialized the first time they're opened, in whatever method opens
        // them.

        _tabRow.ShowElevationShield(IsRunningElevated() && _currentWindowSettings().ShowAdminShield());

        // Apply the ShowWorkspacesButton theme setting.
        if (const auto theme = _settings.GlobalSettings().CurrentTheme(_currentWindowSettings()))
        {
            _tabRow.ShowWorkspacesButton(theme.Window() ? theme.Window().ShowWorkspacesButton() : true);
        }

        _adjustProcessPriorityThrottled = std::make_shared<ThrottledFunc<>>(
            DispatcherQueue::GetForCurrentThread(),
            til::throttled_func_options{
                .delay = std::chrono::milliseconds{ 100 },
                .debounce = true,
                .trailing = true,
            },
            [=]() {
                _adjustProcessPriority();
            });
    }

    Windows::UI::Xaml::Automation::Peers::AutomationPeer TerminalPage::OnCreateAutomationPeer()
    {
        return Automation::Peers::FrameworkElementAutomationPeer(*this);
    }

    void TerminalPage::_SetVerticalTabResizeCursor(const bool resizing) const
    {
        try
        {
            CoreWindow::GetForCurrentThread().PointerCursor(CoreCursor{ resizing ? CoreCursorType::SizeWestEast : CoreCursorType::Arrow, 0 });
        }
        CATCH_LOG();
    }

    void TerminalPage::_SetVerticalTabPaneWidth(const double width)
    {
        const auto column{ VerticalTabColumn() };
        const auto minWidth{ column.MinWidth() };
        auto maxWidth{ column.MaxWidth() };

        const auto rootWidth{ Root().ActualWidth() };
        if (rootWidth > 0)
        {
            const auto handleWidth{ VerticalTabResizeHandle().ActualWidth() };
            const auto maxWidthWithContent{ std::max(minWidth, rootWidth - handleWidth - MinimumTerminalContentWidth) };
            maxWidth = std::min(maxWidth, maxWidthWithContent);
        }

        const auto clampedWidth{ std::clamp(width, minWidth, maxWidth) };
        column.Width(GridLengthHelper::FromValueAndType(clampedWidth, GridUnitType::Pixel));
    }

    // Both pane edges carry a grip line that is invisible at rest, half up
    // under the pointer and full while the pane is being dragged, so a 6px
    // strip of window chrome looks like something you can grab. It escalates
    // in weight rather than hue - the accent belongs to the rail's selected
    // tab - and only Opacity moves, so the brushes stay theme resources
    // declared in the XAML.
    static constexpr auto ResizeHandleRestOpacity = 0.0;
    static constexpr auto ResizeHandleHoverOpacity = 0.5;
    static constexpr auto ResizeHandleDragOpacity = 1.0;

    void TerminalPage::_VerticalTabResizePointerEntered(const Windows::Foundation::IInspectable&,
                                                        const Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        _SetVerticalTabResizeCursor(true);
        VerticalTabResizeGrip().Opacity(_resizingVerticalTabPane ? ResizeHandleDragOpacity : ResizeHandleHoverOpacity);
    }

    void TerminalPage::_VerticalTabResizePointerExited(const Windows::Foundation::IInspectable&,
                                                       const Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        if (!_resizingVerticalTabPane)
        {
            _SetVerticalTabResizeCursor(false);
            VerticalTabResizeGrip().Opacity(ResizeHandleRestOpacity);
        }
    }

    void TerminalPage::_VerticalTabResizePointerPressed(const Windows::Foundation::IInspectable& sender,
                                                        const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        const auto resizeHandle{ sender.try_as<WUX::UIElement>() };
        if (!resizeHandle)
        {
            return;
        }

        resizeHandle.CapturePointer(e.Pointer());
        const auto point{ e.GetCurrentPoint(Root()) };
        _verticalTabResizeStartX = point.Position().X;
        _verticalTabResizeStartWidth = VerticalTabColumn().ActualWidth();
        _resizingVerticalTabPane = true;
        _SetVerticalTabResizeCursor(true);
        VerticalTabResizeGrip().Opacity(ResizeHandleDragOpacity);
        e.Handled(true);
    }

    void TerminalPage::_VerticalTabResizePointerMoved(const Windows::Foundation::IInspectable&,
                                                      const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        if (!_resizingVerticalTabPane)
        {
            // Releasing the drag with the pointer still over the handle
            // leaves no exit event behind, so re-assert the hover state on
            // the next move rather than waiting for one.
            VerticalTabResizeGrip().Opacity(ResizeHandleHoverOpacity);
            return;
        }

        const auto point{ e.GetCurrentPoint(Root()) };
        _SetVerticalTabPaneWidth(_verticalTabResizeStartWidth + point.Position().X - _verticalTabResizeStartX);
        e.Handled(true);
    }

    void TerminalPage::_StopVerticalTabPaneResize(const Windows::Foundation::IInspectable& sender,
                                                  const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        if (const auto resizeHandle{ sender.try_as<WUX::UIElement>() })
        {
            resizeHandle.ReleasePointerCapture(e.Pointer());
        }

        if (_resizingVerticalTabPane)
        {
            _resizingVerticalTabPane = false;
            _SetVerticalTabResizeCursor(false);
            VerticalTabResizeGrip().Opacity(ResizeHandleRestOpacity);
            e.Handled(true);
        }
    }

    void TerminalPage::_VerticalTabResizePointerReleased(const Windows::Foundation::IInspectable& sender,
                                                         const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        _StopVerticalTabPaneResize(sender, e);
    }

    void TerminalPage::_VerticalTabResizePointerCanceled(const Windows::Foundation::IInspectable& sender,
                                                         const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        _StopVerticalTabPaneResize(sender, e);
    }

    void TerminalPage::_VerticalTabResizePointerCaptureLost(const Windows::Foundation::IInspectable& sender,
                                                            const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        _StopVerticalTabPaneResize(sender, e);
    }

    // Method Description:
    // - This is a bit of trickiness: If we're running unelevated, and the user
    //   passed in only --elevate actions, the we don't _actually_ want to
    //   restore the layouts here. We're not _actually_ about to create the
    //   window. We're simply going to toss the commandlines
    // Arguments:
    // - <none>
    // Return Value:
    // - true if we're not elevated but all relevant pane-spawning actions are elevated
    bool TerminalPage::ShouldImmediatelyHandoffToElevated(const CascadiaSettings& settings) const
    {
        if (_startupActions.empty() || _startupConnection || IsRunningElevated())
        {
            // No point in handing off if we got no startup actions, or we're already elevated.
            // Also, we shouldn't need to elevate handoff ConPTY connections.
            assert(!_startupConnection);
            return false;
        }

        // Check that there's at least one action that's not just an elevated newTab action.
        for (const auto& action : _startupActions)
        {
            // Only new terminal panes will be requesting elevation.
            NewTerminalArgs newTerminalArgs{ nullptr };

            if (action.Action() == ShortcutAction::NewTab)
            {
                const auto& args{ action.Args().try_as<NewTabArgs>() };
                if (args)
                {
                    newTerminalArgs = args.ContentArgs().try_as<NewTerminalArgs>();
                }
                else
                {
                    // This was a nt action that didn't have any args. The default
                    // profile may want to be elevated, so don't just early return.
                }
            }
            else if (action.Action() == ShortcutAction::SplitPane)
            {
                const auto& args{ action.Args().try_as<SplitPaneArgs>() };
                if (args)
                {
                    newTerminalArgs = args.ContentArgs().try_as<NewTerminalArgs>();
                }
                else
                {
                    // This was a nt action that didn't have any args. The default
                    // profile may want to be elevated, so don't just early return.
                }
            }
            else
            {
                // This was not a new tab or split pane action.
                // This doesn't affect the outcome
                continue;
            }

            // It's possible that newTerminalArgs is null here.
            // GetProfileForArgs should be resilient to that.
            const auto profile{ settings.GetProfileForArgs(newTerminalArgs) };
            if (profile.Elevate())
            {
                continue;
            }

            // The profile didn't want to be elevated, and we aren't elevated.
            // We're going to open at least one tab, so return false.
            return false;
        }
        return true;
    }

    // Method Description:
    // - Escape hatch for immediately dispatching requests to elevated windows
    //   when first launched. At this point in startup, the window doesn't exist
    //   yet, XAML hasn't been started, but we need to dispatch these actions.
    //   We can't just go through ProcessStartupActions, because that processes
    //   the actions async using the XAML dispatcher (which doesn't exist yet)
    // - DON'T CALL THIS if you haven't already checked
    //   ShouldImmediatelyHandoffToElevated. If you're thinking about calling
    //   this outside of the one place it's used, that's probably the wrong
    //   solution.
    // Arguments:
    // - settings: the settings we should use for dispatching these actions. At
    //   this point in startup, we hadn't otherwise been initialized with these,
    //   so use them now.
    // Return Value:
    // - <none>
    void TerminalPage::HandoffToElevated(const CascadiaSettings& settings)
    {
        if (_startupActions.empty())
        {
            return;
        }

        // Hookup our event handlers to the ShortcutActionDispatch
        _settings = settings;
        _HookupKeyBindings(_settings.ActionMap());
        _RegisterActionCallbacks();

        for (const auto& action : _startupActions)
        {
            // only process new tabs and split panes. They're all going to the elevated window anyways.
            if (action.Action() == ShortcutAction::NewTab || action.Action() == ShortcutAction::SplitPane)
            {
                _actionDispatch->DoAction(action);
            }
        }
    }

    safe_void_coroutine TerminalPage::_NewTerminalByDrop(const Windows::Foundation::IInspectable&, winrt::Windows::UI::Xaml::DragEventArgs e)
    try
    {
        const auto data = e.DataView();
        if (!data.Contains(StandardDataFormats::StorageItems()))
        {
            co_return;
        }

        const auto weakThis = get_weak();
        const auto items = co_await data.GetStorageItemsAsync();
        const auto strongThis = weakThis.get();
        if (!strongThis)
        {
            co_return;
        }

        TraceLoggingWrite(
            g_hTerminalAppProvider,
            "NewTabByDragDrop",
            TraceLoggingDescription("Event emitted when the user drag&drops onto the new tab button"),
            TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
            TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));

        for (const auto& item : items)
        {
            auto directory = item.Path();

            std::filesystem::path path(std::wstring_view{ directory });
            if (!std::filesystem::is_directory(path))
            {
                directory = winrt::hstring{ path.parent_path().native() };
            }

            NewTerminalArgs args;
            args.StartingDirectory(directory);
            _OpenNewTerminalViaDropdown(args);
        }
    }
    CATCH_LOG()

    // Method Description:
    // - This method is called once command palette action was chosen for dispatching
    //   We'll use this event to dispatch this command.
    // Arguments:
    // - command - command to dispatch
    // Return Value:
    // - <none>
    void TerminalPage::_OnDispatchCommandRequested(const IInspectable& sender, const Microsoft::Terminal::Settings::Model::Command& command)
    {
        const auto& actionAndArgs = command.ActionAndArgs();
        _actionDispatch->DoAction(sender, actionAndArgs);
    }

    // Method Description:
    // - This method is called once command palette command line was chosen for execution
    //   We'll use this event to create a command line execution command and dispatch it.
    // Arguments:
    // - command - command to dispatch
    // Return Value:
    // - <none>
    void TerminalPage::_OnCommandLineExecutionRequested(const IInspectable& /*sender*/, const winrt::hstring& commandLine)
    {
        ExecuteCommandlineArgs args{ commandLine };
        ActionAndArgs actionAndArgs{ ShortcutAction::ExecuteCommandline, args };
        _actionDispatch->DoAction(actionAndArgs);
    }

    // Method Description:
    // - This method is called once on startup, on the first LayoutUpdated event.
    //   We'll use this event to know that we have an ActualWidth and
    //   ActualHeight, so we can now attempt to process our list of startup
    //   actions.
    // - We'll remove this event handler when the event is first handled.
    // - If there are no startup actions, we'll open a single tab with the
    //   default profile.
    // Arguments:
    // - <unused>
    // Return Value:
    // - <none>
    void TerminalPage::_OnFirstLayout(const IInspectable& /*sender*/, const IInspectable& /*eventArgs*/)
    {
        // Only let this succeed once.
        _layoutUpdatedRevoker.revoke();

        // This event fires every time the layout changes, but it is always the
        // last one to fire in any layout change chain. That gives us great
        // flexibility in finding the right point at which to initialize our
        // renderer (and our terminal). Any earlier than the last layout update
        // and we may not know the terminal's starting size.
        if (_startupState == StartupState::NotInitialized)
        {
            _startupState = StartupState::InStartup;

            if (_startupConnection)
            {
                CreateTabFromConnection(std::move(_startupConnection));
            }
            else if (!_startupActions.empty())
            {
                ProcessStartupActions(std::move(_startupActions));
            }

            _CompleteInitialization();
        }
    }

    // Method Description:
    // - Process all the startup actions in the provided list of startup
    //   actions. We'll do this all at once here.
    // Arguments:
    // - actions: a winrt vector of actions to process. Note that this must NOT
    //   be an IVector&, because we need the collection to be accessible on the
    //   other side of the co_await.
    // - initial: if true, we're parsing these args during startup, and we
    //   should fire an Initialized event.
    // - cwd: If not empty, we should try switching to this provided directory
    //   while processing these actions. This will allow something like `wt -w 0
    //   nt -d .` from inside another directory to work as expected.
    // Return Value:
    // - <none>
    safe_void_coroutine TerminalPage::ProcessStartupActions(std::vector<ActionAndArgs> actions, const winrt::hstring cwd, const winrt::hstring env)
    {
        const auto strong = get_strong();

        // If the caller provided a CWD, "switch" to that directory, then switch
        // back once we're done.
        auto originalVirtualCwd{ _WindowProperties.VirtualWorkingDirectory() };
        auto originalVirtualEnv{ _WindowProperties.VirtualEnvVars() };
        auto restoreCwd = wil::scope_exit([&]() {
            if (!cwd.empty())
            {
                // ignore errors, we'll just power on through. We'd rather do
                // something rather than fail silently if the directory doesn't
                // actually exist.
                _WindowProperties.VirtualWorkingDirectory(originalVirtualCwd);
                _WindowProperties.VirtualEnvVars(originalVirtualEnv);
            }
        });
        if (!cwd.empty())
        {
            _WindowProperties.VirtualWorkingDirectory(cwd);
            _WindowProperties.VirtualEnvVars(env);
        }

        // The current TerminalWindow & TerminalPage architecture is rather instable
        // and fails to start up if the first tab isn't created synchronously.
        //
        // While that's a fair assumption in on itself, simultaneously WinUI will
        // not assign tab contents a size if they're not shown at least once,
        // which we need however in order to initialize ControlCore with a size.
        //
        // So, we do two things here:
        // * DO NOT suspend if this is the first tab.
        // * DO suspend between the creation of panes (or tabs) in order to allow
        //   WinUI to layout the new controls and for ControlCore to get a size.
        //
        // This same logic is also applied to CreateTabFromConnection.
        //
        // See GH#13136.
        auto suspend = _tabs.Size() > 0;

        for (size_t i = 0; i < actions.size(); ++i)
        {
            if (suspend)
            {
                co_await wil::resume_foreground(Dispatcher(), CoreDispatcherPriority::Low);
            }

            _actionDispatch->DoAction(actions[i]);
            suspend = true;
        }

        // GH#6586: now that we're done processing all startup commands,
        // focus the active control. This will work as expected for both
        // commandline invocations and for `wt` action invocations.
        if (const auto& tabImpl{ _GetFocusedTabImpl() })
        {
            if (const auto& content{ tabImpl->GetActiveContent() })
            {
                content.Focus(FocusState::Programmatic);
            }
        }
    }

    safe_void_coroutine TerminalPage::CreateTabFromConnection(ITerminalConnection connection)
    {
        const auto strong = get_strong();

        // This is the exact same logic as in ProcessStartupActions.
        if (_tabs.Size() > 0)
        {
            co_await wil::resume_foreground(Dispatcher(), CoreDispatcherPriority::Low);
        }

        NewTerminalArgs newTerminalArgs;

        if (const auto conpty = connection.try_as<ConptyConnection>())
        {
            newTerminalArgs.Commandline(conpty.Commandline());
            newTerminalArgs.TabTitle(conpty.StartingTitle());
        }

        // GH #12370: We absolutely cannot allow a defterm connection to
        // auto-elevate. Defterm doesn't work for elevated scenarios in the
        // first place. If we try accepting the connection, the spawning an
        // elevated version of the Terminal with that profile... that's a
        // recipe for disaster. We won't ever open up a tab in this window.
        newTerminalArgs.Elevate(false);

        const auto newPane = _MakePane(newTerminalArgs, nullptr, std::move(connection));
        newPane->WalkTree([](const auto& pane) {
            pane->FinalizeConfigurationGivenDefault();
        });
        _CreateNewTabFromPane(newPane);
    }

    // Method Description:
    // - Perform and steps that need to be done once our initial state is all
    //   set up. This includes entering fullscreen mode and firing our
    //   Initialized event.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    safe_void_coroutine TerminalPage::_CompleteInitialization()
    {
        _startupState = StartupState::Initialized;

        // GH#632 - It's possible that the user tried to create the terminal
        // with only one tab, with only an elevated profile. If that happens,
        // we'll create _another_ process to host the elevated version of that
        // profile. This can happen from the jumplist, or if the default profile
        // is `elevate:true`, or from the commandline.
        //
        // However, we need to make sure to close this window in that scenario.
        // Since there aren't any _tabs_ in this window, we won't ever get a
        // closed event. So do it manually.
        //
        // GH#12267: Make sure that we don't instantly close ourselves when
        // we're readying to accept a defterm connection. In that case, we don't
        // have a tab yet, but will once we're initialized.
        if (_tabs.Size() == 0)
        {
            CloseWindowRequested.raise(*this, nullptr);
            co_return;
        }
        else
        {
            // GH#11561: When we start up, our window is initially just a frame
            // with a transparent content area. We're gonna do all this startup
            // init on the UI thread, so the UI won't actually paint till it's
            // all done. This results in a few frames where the frame is
            // visible, before the page paints for the first time, before any
            // tabs appears, etc.
            //
            // To mitigate this, we're gonna wait for the UI thread to finish
            // everything it's gotta do for the initial init, and _then_ fire
            // our Initialized event. By waiting for everything else to finish
            // (CoreDispatcherPriority::Low), we let all the tabs and panes
            // actually get created. In the window layer, we're gonna cloak the
            // window till this event is fired, so we don't actually see this
            // frame until we're actually all ready to go.
            //
            // This will result in the window seemingly not loading as fast, but
            // it will actually take exactly the same amount of time before it's
            // usable.
            //
            // We also experimented with drawing a solid BG color before the
            // initialization is finished. However, there are still a few frames
            // after the frame is displayed before the XAML content first draws,
            // so that didn't actually resolve any issues.
            Dispatcher().RunAsync(CoreDispatcherPriority::Low, [weak = get_weak()]() {
                if (auto self{ weak.get() })
                {
                    self->Initialized.raise(*self, nullptr);
                }
            });
        }
    }

    // Method Description:
    // - Show a dialog with "About" information. Displays the app's Display
    //   Name, version, getting started link, source code link, documentation link, release
    //   Notes link, send feedback link and privacy policy link.
    void TerminalPage::_ShowAboutDialog()
    {
        _ShowDialogHelper(L"AboutDialog");
    }

    winrt::hstring TerminalPage::ApplicationDisplayName()
    {
        return CascadiaSettings::ApplicationDisplayName();
    }

    winrt::hstring TerminalPage::ApplicationVersion()
    {
        return CascadiaSettings::ApplicationVersion();
    }

    // Method Description:
    // - Helper to show a content dialog
    // - We only open a content dialog if there isn't one open already
    winrt::Windows::Foundation::IAsyncOperation<ContentDialogResult> TerminalPage::_ShowDialogHelper(const std::wstring_view& name)
    {
        if (auto presenter{ _dialogPresenter.get() })
        {
            co_return co_await presenter.ShowDialog(FindName(name).try_as<WUX::Controls::ContentDialog>());
        }
        co_return ContentDialogResult::None;
    }

    // Method Description:
    // - Displays the unified close confirmation dialog configured for the
    //   given scenario. Resets the "don't ask me again" checkbox before showing.
    //   If the user confirms and checked "don't ask me again", sets
    //   confirmOnClose to Never and writes settings to disk.
    // - Only one dialog can be visible at a time. If another dialog is visible
    //   when this is called, nothing happens. See _ShowDialog for details
    winrt::Windows::Foundation::IAsyncOperation<ContentDialogResult> TerminalPage::_ShowConfirmCloseDialog(ConfirmCloseDialogKind kind)
    {
        // Load the dialog (triggers x:Load) and configure its strings.
        const auto dialog = FindName(L"ConfirmCloseDialog").as<ContentDialog>();

        winrt::hstring title;
        winrt::hstring primary;
        switch (kind)
        {
        case ConfirmCloseDialogKind::CloseAll:
            title = RS_(L"ConfirmCloseDialog_CloseAllTitle");
            primary = RS_(L"ConfirmCloseDialog_CloseAllPrimary");
            break;
        case ConfirmCloseDialogKind::Window:
            title = RS_(L"ConfirmCloseDialog_WindowTitle");
            primary = RS_(L"ConfirmCloseDialog_WindowPrimary");
            break;
        case ConfirmCloseDialogKind::Tab:
            title = RS_(L"ConfirmCloseDialog_TabTitle");
            primary = RS_(L"ConfirmCloseDialog_TabPrimary");
            break;
        case ConfirmCloseDialogKind::MultiplePanes:
            title = RS_(L"ConfirmCloseDialog_MultiplePanesTitle");
            primary = RS_(L"ConfirmCloseDialog_MultiplePanesPrimary");
            break;
        case ConfirmCloseDialogKind::MultipleTabs:
            title = RS_(L"ConfirmCloseDialog_MultipleTabsTitle");
            primary = RS_(L"ConfirmCloseDialog_MultipleTabsPrimary");
            break;
        case ConfirmCloseDialogKind::Pane:
            title = RS_(L"ConfirmCloseDialog_PaneTitle");
            primary = RS_(L"ConfirmCloseDialog_PanePrimary");
            break;
        }
        dialog.Title(winrt::box_value(title));
        dialog.PrimaryButtonText(primary);
        dialog.CloseButtonText(RS_(L"ConfirmCloseDialog_Cancel"));

        // BODGY: After a ContentDialog is dismissed, FindName() can no longer
        // resolve children inside it. Use Content() to get the checkbox directly.
        const auto checkbox = dialog.Content().as<CheckBox>();
        checkbox.IsChecked(false);

        auto result = ContentDialogResult::None;
        if (auto presenter{ _dialogPresenter.get() })
        {
            const auto weak = get_weak();
            result = co_await presenter.ShowDialog(dialog);

            // ShowDialog blocks until the dialog is dismissed, so it is
            // possible for `this` to be torn down while we wait. Re-acquire
            // a strong reference before touching any of our state.
            const auto strong = weak.get();
            if (!strong)
            {
                co_return ContentDialogResult::None;
            }

            if (result == ContentDialogResult::Primary && checkbox.IsChecked().Value())
            {
                _settings.GlobalSettings().ConfirmOnClose(ConfirmOnClose::Never);
                _settings.WriteSettingsToDisk();
            }
        }

        co_return result;
    }

    // Method Description:
    // - Displays a dialog for warnings found while closing the terminal tab marked as read-only
    winrt::Windows::Foundation::IAsyncOperation<ContentDialogResult> TerminalPage::_ShowCloseReadOnlyDialog()
    {
        return _ShowDialogHelper(L"CloseReadOnlyDialog");
    }

    // Method Description:
    // - Displays a dialog to warn the user about the fact that the text that
    //   they are trying to paste contains the "new line" character which can
    //   have the effect of starting commands without the user's knowledge if
    //   it is pasted on a shell where the "new line" character marks the end
    //   of a command.
    // - Only one dialog can be visible at a time. If another dialog is visible
    //   when this is called, nothing happens. See _ShowDialog for details
    winrt::Windows::Foundation::IAsyncOperation<ContentDialogResult> TerminalPage::_ShowMultiLinePasteWarningDialog()
    {
        return _ShowDialogHelper(L"MultiLinePasteDialog");
    }

    // Method Description:
    // - Displays a dialog to warn the user about the fact that the text that
    //   they are trying to paste is very long, in case they did not mean to
    //   paste it but pressed the paste shortcut by accident.
    // - Only one dialog can be visible at a time. If another dialog is visible
    //   when this is called, nothing happens. See _ShowDialog for details
    winrt::Windows::Foundation::IAsyncOperation<ContentDialogResult> TerminalPage::_ShowLargePasteWarningDialog()
    {
        return _ShowDialogHelper(L"LargePasteDialog");
    }

    // Method Description:
    // - Builds the flyout (dropdown) attached to the new tab button, and
    //   attaches it to the button. Populates the flyout with one entry per
    //   Profile, displaying the profile's name. Clicking each flyout item will
    //   open a new tab with that profile.
    //   Below the profiles are the static menu items: settings, command palette
    void TerminalPage::_CreateNewTabFlyout()
    {
        auto newTabFlyout = WUX::Controls::MenuFlyout{};
        newTabFlyout.Placement(WUX::Controls::Primitives::FlyoutPlacementMode::BottomEdgeAlignedLeft);

        // Create profile entries from the NewTabMenu configuration using a
        // recursive helper function. This returns a std::vector of FlyoutItemBases,
        // that we then add to our Flyout.
        auto entries = _currentWindowSettings().NewTabMenu();
        auto items = _CreateNewTabFlyoutItems(entries);
        for (const auto& item : items)
        {
            newTabFlyout.Items().Append(item);
        }

        // add menu separator
        auto separatorItem = WUX::Controls::MenuFlyoutSeparator{};
        newTabFlyout.Items().Append(separatorItem);

        // add static items
        {
            // Create the settings button.
            auto settingsItem = WUX::Controls::MenuFlyoutItem{};
            settingsItem.Text(RS_(L"SettingsMenuItem"));
            const auto settingsToolTip = RS_(L"SettingsToolTip");

            WUX::Controls::ToolTipService::SetToolTip(settingsItem, box_value(settingsToolTip));
            Automation::AutomationProperties::SetHelpText(settingsItem, settingsToolTip);

            WUX::Controls::SymbolIcon ico{};
            ico.Symbol(WUX::Controls::Symbol::Setting);
            settingsItem.Icon(ico);

            settingsItem.Click({ this, &TerminalPage::_SettingsButtonOnClick });
            newTabFlyout.Items().Append(settingsItem);

            auto actionMap = _settings.ActionMap();
            const auto settingsKeyChord{ actionMap.GetKeyBindingForAction(L"Terminal.OpenSettingsUI") };
            if (settingsKeyChord)
            {
                _SetAcceleratorForMenuItem(settingsItem, settingsKeyChord);
            }

            // Create the command palette button.
            auto commandPaletteFlyout = WUX::Controls::MenuFlyoutItem{};
            commandPaletteFlyout.Text(RS_(L"CommandPaletteMenuItem"));
            const auto commandPaletteToolTip = RS_(L"CommandPaletteToolTip");

            WUX::Controls::ToolTipService::SetToolTip(commandPaletteFlyout, box_value(commandPaletteToolTip));
            Automation::AutomationProperties::SetHelpText(commandPaletteFlyout, commandPaletteToolTip);

            WUX::Controls::FontIcon commandPaletteIcon{};
            commandPaletteIcon.Glyph(L"\xE945");
            commandPaletteIcon.FontFamily(Media::FontFamily{ L"Segoe Fluent Icons, Segoe MDL2 Assets" });
            commandPaletteFlyout.Icon(commandPaletteIcon);

            commandPaletteFlyout.Click({ this, &TerminalPage::_CommandPaletteButtonOnClick });
            newTabFlyout.Items().Append(commandPaletteFlyout);

            const auto commandPaletteKeyChord{ actionMap.GetKeyBindingForAction(L"Terminal.ToggleCommandPalette") };
            if (commandPaletteKeyChord)
            {
                _SetAcceleratorForMenuItem(commandPaletteFlyout, commandPaletteKeyChord);
            }

            // Create the about button.
            auto aboutFlyout = WUX::Controls::MenuFlyoutItem{};
            aboutFlyout.Text(RS_(L"AboutMenuItem"));
            const auto aboutToolTip = RS_(L"AboutToolTip");

            WUX::Controls::ToolTipService::SetToolTip(aboutFlyout, box_value(aboutToolTip));
            Automation::AutomationProperties::SetHelpText(aboutFlyout, aboutToolTip);

            WUX::Controls::SymbolIcon aboutIcon{};
            aboutIcon.Symbol(WUX::Controls::Symbol::Help);
            aboutFlyout.Icon(aboutIcon);

            aboutFlyout.Click({ this, &TerminalPage::_AboutButtonOnClick });
            newTabFlyout.Items().Append(aboutFlyout);

            // Create the "copy connection token" button, so remote web/mobile
            // clients can be handed the terminal-web bridge access token.
            auto copyTokenFlyout = WUX::Controls::MenuFlyoutItem{};
            copyTokenFlyout.Text(RS_(L"CopyConnectionTokenMenuItem"));
            const auto copyTokenToolTip = RS_(L"CopyConnectionTokenToolTip");

            WUX::Controls::ToolTipService::SetToolTip(copyTokenFlyout, box_value(copyTokenToolTip));
            Automation::AutomationProperties::SetHelpText(copyTokenFlyout, copyTokenToolTip);

            WUX::Controls::FontIcon copyTokenIcon{};
            copyTokenIcon.Glyph(L"\xE8D7"); // Permissions (key)
            copyTokenIcon.FontFamily(Media::FontFamily{ L"Segoe Fluent Icons, Segoe MDL2 Assets" });
            copyTokenFlyout.Icon(copyTokenIcon);

            copyTokenFlyout.Click({ this, &TerminalPage::_CopyConnectionTokenOnClick });
            newTabFlyout.Items().Append(copyTokenFlyout);
        }

        // Before opening the fly-out set focus on the current tab
        // so no matter how fly-out is closed later on the focus will return to some tab.
        // We cannot do it on closing because if the window loses focus (alt+tab)
        // the closing event is not fired.
        // It is important to set the focus on the tab
        // Since the previous focus location might be discarded in the background,
        // e.g., the command palette will be dismissed by the menu,
        // and then closing the fly-out will move the focus to wrong location.
        newTabFlyout.Opening([weakThis{ get_weak() }](auto&&, auto&&) {
            if (auto page{ weakThis.get() })
            {
                page->_FocusCurrentTab(true);

                TraceLoggingWrite(
                    g_hTerminalAppProvider,
                    "NewTabMenuOpened",
                    TraceLoggingDescription("Event emitted when the new tab menu is opened"),
                    TraceLoggingValue(page->NumberOfTabs(), "TabCount", "The Count of tabs currently opened in this window"),
                    TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
                    TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));
            }
        });
        // Necessary for fly-out sub items to get focus on a tab before collapsing. Related to #15049
        newTabFlyout.Closing([weakThis{ get_weak() }](auto&&, auto&&) {
            if (auto page{ weakThis.get() })
            {
                if (!page->_commandPaletteIs(Visibility::Visible))
                {
                    page->_FocusCurrentTab(true);
                }

                TraceLoggingWrite(
                    g_hTerminalAppProvider,
                    "NewTabMenuClosed",
                    TraceLoggingDescription("Event emitted when the new tab menu is closed"),
                    TraceLoggingValue(page->NumberOfTabs(), "TabCount", "The Count of tabs currently opened in this window"),
                    TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
                    TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));
            }
        });
        _newTabButton.Flyout(newTabFlyout);

        _UpdateNewTabProfileButtons();
    }

    // Method Description:
    // - Rebuilds the row of icon-only profile launcher buttons that sits next
    //   to the new tab split button at the bottom of the vertical tab rail.
    //   Every active profile gets a button; TabRowControl collapses the ones
    //   that don't fit, so the split button's dropdown chevron never gets
    //   clipped and no button renders partially.
    void TerminalPage::_UpdateNewTabProfileButtons()
    {
        if (!_tabRow)
        {
            return;
        }

        const auto tabRowImpl = winrt::get_self<implementation::TabRowControl>(_tabRow);
        const auto panel = tabRowImpl->NewTabProfilesPanel();
        panel.Children().Clear();

        // These buttons are the only part of the rail's footer that markup
        // can't reach, so they pick up the footer's style here instead. It
        // carries the size, margin, radius, glyph metrics and the chrome
        // ramp - transparent until touched - that the rest of the rail uses;
        // FitNewTabProfileButtons reads Width and Margin back off them, and
        // a Style setter sets those properties for real, so the fit maths
        // keeps working.
        WUX::Style profileButtonStyle{ nullptr };
        try
        {
            profileButtonStyle = Application::Current().Resources().Lookup(winrt::box_value(L"TabRailFooterProfileButtonStyle")).try_as<WUX::Style>();
        }
        CATCH_LOG();

        const auto activeProfiles = _settings.ActiveProfiles();
        const auto profileCount = activeProfiles.Size();
        for (uint32_t profileIndex = 0; profileIndex < profileCount; profileIndex++)
        {
            const auto profile = activeProfiles.GetAt(profileIndex);

            auto button = WUX::Controls::Button{};
            if (profileButtonStyle)
            {
                button.Style(profileButtonStyle);
            }
            else
            {
                button.Width(32);
                button.Height(32);
                button.Padding({ 0, 0, 0, 0 });
                button.Margin({ 4, 0, 0, 0 });
                button.BorderThickness({ 0, 0, 0, 0 });
                button.Background(WUX::Media::SolidColorBrush{ Windows::UI::Colors::Transparent() });
                button.FontFamily(Media::FontFamily{ L"Segoe Fluent Icons, Segoe MDL2 Assets" });
                button.FontSize(12);
            }

            if (const auto icon = _CreateNewTabFlyoutIcon(profile.Icon().Resolved()))
            {
                icon.Width(16);
                icon.Height(16);
                button.Content(icon);
            }
            else
            {
                // A bare glyph, so the style's SymbolThemeFontFamily and glyph
                // size apply the way they do on every other rail icon button.
                button.Content(winrt::box_value(L"\xE756")); // CommandPrompt
            }

            const auto profileName = profile.Name();
            WUX::Controls::ToolTipService::SetToolTip(button, box_value(profileName));
            Automation::AutomationProperties::SetName(button, profileName);

            button.Click([profileIndex, weakThis{ get_weak() }](auto&&, auto&&) {
                if (const auto page{ weakThis.get() })
                {
                    NewTerminalArgs newTerminalArgs{ gsl::narrow_cast<int32_t>(profileIndex) };
                    page->_OpenNewTerminalViaDropdown(newTerminalArgs);
                }
            });

            panel.Children().Append(button);
        }

        tabRowImpl->FitNewTabProfileButtons();
    }

    // Method Description:
    // - For a given list of tab menu entries, this method will create the corresponding
    //   list of flyout items. This is a recursive method that calls itself when it comes
    //   across a folder entry.
    std::vector<WUX::Controls::MenuFlyoutItemBase> TerminalPage::_CreateNewTabFlyoutItems(IVector<NewTabMenuEntry> entries)
    {
        std::vector<WUX::Controls::MenuFlyoutItemBase> items;

        if (entries == nullptr || entries.Size() == 0)
        {
            return items;
        }

        for (const auto& entry : entries)
        {
            if (entry == nullptr)
            {
                continue;
            }

            switch (entry.Type())
            {
            case NewTabMenuEntryType::Separator:
            {
                items.push_back(WUX::Controls::MenuFlyoutSeparator{});
                break;
            }
            // A folder has a custom name and icon, and has a number of entries that require
            // us to call this method recursively.
            case NewTabMenuEntryType::Folder:
            {
                const auto folderEntry = entry.as<FolderEntry>();
                const auto folderEntries = folderEntry.Entries();

                // If the folder is empty, we should skip the entry if AllowEmpty is false, or
                // when the folder should inline.
                // The IsEmpty check includes semantics for nested (empty) folders
                if (folderEntries.Size() == 0 && (!folderEntry.AllowEmpty() || folderEntry.Inlining() == FolderEntryInlining::Auto))
                {
                    break;
                }

                // Recursively generate flyout items
                auto folderEntryItems = _CreateNewTabFlyoutItems(folderEntries);

                // If the folder should auto-inline and there is only one item, do so.
                if (folderEntry.Inlining() == FolderEntryInlining::Auto && folderEntryItems.size() == 1)
                {
                    for (auto const& folderEntryItem : folderEntryItems)
                    {
                        items.push_back(folderEntryItem);
                    }

                    break;
                }

                // Otherwise, create a flyout
                auto folderItem = WUX::Controls::MenuFlyoutSubItem{};
                folderItem.Text(folderEntry.Name());

                auto icon = _CreateNewTabFlyoutIcon(folderEntry.Icon().Resolved());
                folderItem.Icon(icon);

                for (const auto& folderEntryItem : folderEntryItems)
                {
                    folderItem.Items().Append(folderEntryItem);
                }

                // If the folder is empty, and by now we know we set AllowEmpty to true,
                // create a placeholder item here
                if (folderEntries.Size() == 0)
                {
                    auto placeholder = WUX::Controls::MenuFlyoutItem{};
                    placeholder.Text(RS_(L"NewTabMenuFolderEmpty"));
                    placeholder.IsEnabled(false);

                    folderItem.Items().Append(placeholder);
                }

                items.push_back(folderItem);
                break;
            }
            // Any "collection entry" will simply make us add each profile in the collection
            // separately. This collection is stored as a map <int, Profile>, so the correct
            // profile index is already known.
            case NewTabMenuEntryType::RemainingProfiles:
            case NewTabMenuEntryType::MatchProfiles:
            {
                const auto remainingProfilesEntry = entry.as<ProfileCollectionEntry>();
                if (remainingProfilesEntry.Profiles() == nullptr)
                {
                    break;
                }

                for (auto&& [profileIndex, remainingProfile] : remainingProfilesEntry.Profiles())
                {
                    items.push_back(_CreateNewTabFlyoutProfile(remainingProfile, profileIndex, {}));
                }

                break;
            }
            // A single profile, the profile index is also given in the entry
            case NewTabMenuEntryType::Profile:
            {
                const auto profileEntry = entry.as<ProfileEntry>();
                if (profileEntry.Profile() == nullptr)
                {
                    break;
                }

                auto profileItem = _CreateNewTabFlyoutProfile(profileEntry.Profile(), profileEntry.ProfileIndex(), profileEntry.Icon().Resolved());
                items.push_back(profileItem);
                break;
            }
            case NewTabMenuEntryType::Action:
            {
                const auto actionEntry = entry.as<ActionEntry>();
                const auto actionId = actionEntry.ActionId();
                if (_settings.ActionMap().GetActionByID(actionId))
                {
                    auto actionItem = _CreateNewTabFlyoutAction(actionId, actionEntry.Icon().Resolved());
                    items.push_back(actionItem);
                }

                break;
            }
            }
        }

        return items;
    }

    // Method Description:
    // - This method creates a flyout menu item for a given profile with the given index.
    //   It makes sure to set the correct icon, keybinding, and click-action.
    WUX::Controls::MenuFlyoutItem TerminalPage::_CreateNewTabFlyoutProfile(const Profile profile, int profileIndex, const winrt::hstring& iconPathOverride)
    {
        auto profileMenuItem = WUX::Controls::MenuFlyoutItem{};

        // Add the keyboard shortcuts based on the number of profiles defined
        // Look for a keychord that is bound to the equivalent
        // NewTab(ProfileIndex=N) action
        NewTerminalArgs newTerminalArgs{ profileIndex };
        NewTabArgs newTabArgs{ newTerminalArgs };
        const auto id = fmt::format(FMT_COMPILE(L"Terminal.OpenNewTabProfile{}"), profileIndex);
        const auto profileKeyChord{ _settings.ActionMap().GetKeyBindingForAction(id) };

        // make sure we find one to display
        if (profileKeyChord)
        {
            _SetAcceleratorForMenuItem(profileMenuItem, profileKeyChord);
        }

        auto profileName = profile.Name();
        profileMenuItem.Text(profileName);

        // If a custom icon path has been specified, set it as the icon for
        // this flyout item. Otherwise, if an icon is set for this profile, set that icon
        // for this flyout item.
        const auto& iconPath = iconPathOverride.empty() ? profile.Icon().Resolved() : iconPathOverride;
        if (!iconPath.empty())
        {
            const auto icon = _CreateNewTabFlyoutIcon(iconPath);
            profileMenuItem.Icon(icon);
        }

        if (profile.Guid() == _currentWindowSettings().DefaultProfile())
        {
            // Contrast the default profile with others in font weight.
            profileMenuItem.FontWeight(FontWeights::Bold());
        }

        auto newTabRun = WUX::Documents::Run();
        newTabRun.Text(RS_(L"NewTabRun/Text"));
        auto newPaneRun = WUX::Documents::Run();
        newPaneRun.Text(RS_(L"NewPaneRun/Text"));
        newPaneRun.FontStyle(FontStyle::Italic);
        auto newWindowRun = WUX::Documents::Run();
        newWindowRun.Text(RS_(L"NewWindowRun/Text"));
        newWindowRun.FontStyle(FontStyle::Italic);
        auto elevatedRun = WUX::Documents::Run();
        elevatedRun.Text(RS_(L"ElevatedRun/Text"));
        elevatedRun.FontStyle(FontStyle::Italic);

        auto textBlock = WUX::Controls::TextBlock{};
        textBlock.Inlines().Append(newTabRun);
        textBlock.Inlines().Append(WUX::Documents::LineBreak{});
        textBlock.Inlines().Append(newPaneRun);
        textBlock.Inlines().Append(WUX::Documents::LineBreak{});
        textBlock.Inlines().Append(newWindowRun);
        textBlock.Inlines().Append(WUX::Documents::LineBreak{});
        textBlock.Inlines().Append(elevatedRun);

        auto toolTip = WUX::Controls::ToolTip{};
        toolTip.Content(textBlock);
        WUX::Controls::ToolTipService::SetToolTip(profileMenuItem, toolTip);

        profileMenuItem.Click([profileIndex, weakThis{ get_weak() }](auto&&, auto&&) {
            if (auto page{ weakThis.get() })
            {
                TraceLoggingWrite(
                    g_hTerminalAppProvider,
                    "NewTabMenuItemClicked",
                    TraceLoggingDescription("Event emitted when an item from the new tab menu is invoked"),
                    TraceLoggingValue(page->NumberOfTabs(), "TabCount", "The count of tabs currently opened in this window"),
                    TraceLoggingValue("Profile", "ItemType", "The type of item that was clicked in the new tab menu"),
                    TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
                    TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));

                NewTerminalArgs newTerminalArgs{ profileIndex };
                page->_OpenNewTerminalViaDropdown(newTerminalArgs);
            }
        });

        // Using the static method on the base class seems to do what we want in terms of placement.
        WUX::Controls::Primitives::FlyoutBase::SetAttachedFlyout(profileMenuItem, _CreateRunAsAdminFlyout(profileIndex));

        // Since we are not setting the ContextFlyout property of the item we have to handle the ContextRequested event
        // and rely on the base class to show our menu.
        profileMenuItem.ContextRequested([profileMenuItem](auto&&, auto&&) {
            WUX::Controls::Primitives::FlyoutBase::ShowAttachedFlyout(profileMenuItem);
        });

        return profileMenuItem;
    }

    // Method Description:
    // - This method creates a flyout menu item for a given action
    //   It makes sure to set the correct icon, keybinding, and click-action.
    WUX::Controls::MenuFlyoutItem TerminalPage::_CreateNewTabFlyoutAction(const winrt::hstring& actionId, const winrt::hstring& iconPathOverride)
    {
        auto actionMenuItem = WUX::Controls::MenuFlyoutItem{};
        const auto action{ _settings.ActionMap().GetActionByID(actionId) };
        const auto actionKeyChord{ _settings.ActionMap().GetKeyBindingForAction(actionId) };

        if (actionKeyChord)
        {
            _SetAcceleratorForMenuItem(actionMenuItem, actionKeyChord);
        }

        actionMenuItem.Text(action.Name());

        // If a custom icon path has been specified, set it as the icon for
        // this flyout item. Otherwise, if an icon is set for this action, set that icon
        // for this flyout item.
        const auto& iconPath = iconPathOverride.empty() ? action.Icon().Resolved() : iconPathOverride;
        if (!iconPath.empty())
        {
            const auto icon = _CreateNewTabFlyoutIcon(iconPath);
            actionMenuItem.Icon(icon);
        }

        actionMenuItem.Click([action, weakThis{ get_weak() }](auto&&, auto&&) {
            if (auto page{ weakThis.get() })
            {
                TraceLoggingWrite(
                    g_hTerminalAppProvider,
                    "NewTabMenuItemClicked",
                    TraceLoggingDescription("Event emitted when an item from the new tab menu is invoked"),
                    TraceLoggingValue(page->NumberOfTabs(), "TabCount", "The count of tabs currently opened in this window"),
                    TraceLoggingValue("Action", "ItemType", "The type of item that was clicked in the new tab menu"),
                    TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
                    TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));

                page->_actionDispatch->DoAction(action.ActionAndArgs());
            }
        });

        return actionMenuItem;
    }

    // Method Description:
    // - Helper method to create an IconElement that can be passed to MenuFlyoutItems and
    //   MenuFlyoutSubItems
    IconElement TerminalPage::_CreateNewTabFlyoutIcon(const winrt::hstring& iconSource)
    {
        if (iconSource.empty())
        {
            return nullptr;
        }

        auto icon = UI::IconPathConverter::IconWUX(iconSource);
        Automation::AutomationProperties::SetAccessibilityView(icon, Automation::Peers::AccessibilityView::Raw);

        return icon;
    }

    // Function Description:
    // Called when the openNewTabDropdown keybinding is used.
    // Shows the dropdown flyout.
    void TerminalPage::_OpenNewTabDropdown()
    {
        _newTabButton.Flyout().ShowAt(_newTabButton);
    }

    void TerminalPage::_OpenNewTerminalViaDropdown(const NewTerminalArgs newTerminalArgs)
    {
        // if alt is pressed, open a pane
        const auto window = CoreWindow::GetForCurrentThread();
        const auto rAltState = window.GetKeyState(VirtualKey::RightMenu);
        const auto lAltState = window.GetKeyState(VirtualKey::LeftMenu);
        const auto altPressed = WI_IsFlagSet(lAltState, CoreVirtualKeyStates::Down) ||
                                WI_IsFlagSet(rAltState, CoreVirtualKeyStates::Down);

        const auto shiftState{ window.GetKeyState(VirtualKey::Shift) };
        const auto rShiftState = window.GetKeyState(VirtualKey::RightShift);
        const auto lShiftState = window.GetKeyState(VirtualKey::LeftShift);
        const auto shiftPressed{ WI_IsFlagSet(shiftState, CoreVirtualKeyStates::Down) ||
                                 WI_IsFlagSet(lShiftState, CoreVirtualKeyStates::Down) ||
                                 WI_IsFlagSet(rShiftState, CoreVirtualKeyStates::Down) };

        const auto ctrlState{ window.GetKeyState(VirtualKey::Control) };
        const auto rCtrlState = window.GetKeyState(VirtualKey::RightControl);
        const auto lCtrlState = window.GetKeyState(VirtualKey::LeftControl);
        const auto ctrlPressed{ WI_IsFlagSet(ctrlState, CoreVirtualKeyStates::Down) ||
                                WI_IsFlagSet(rCtrlState, CoreVirtualKeyStates::Down) ||
                                WI_IsFlagSet(lCtrlState, CoreVirtualKeyStates::Down) };

        // Check for DebugTap
        auto debugTap = this->_settings.GlobalSettings().DebugFeaturesEnabled() &&
                        WI_IsFlagSet(lAltState, CoreVirtualKeyStates::Down) &&
                        WI_IsFlagSet(rAltState, CoreVirtualKeyStates::Down);

        const auto dispatchToElevatedWindow = ctrlPressed && !IsRunningElevated();

        auto sessionType = "";
        if ((shiftPressed || dispatchToElevatedWindow) && !debugTap)
        {
            // Manually fill in the evaluated profile.
            if (newTerminalArgs.ProfileIndex() != nullptr)
            {
                // We want to promote the index to a GUID because there is no "launch to profile index" command.
                const auto profile = _settings.GetProfileForArgs(newTerminalArgs);
                if (profile)
                {
                    newTerminalArgs.Profile(::Microsoft::Console::Utils::GuidToString(profile.Guid()));
                    newTerminalArgs.StartingDirectory(_evaluatePathForCwd(profile.EvaluatedStartingDirectory()));
                }
            }

            if (dispatchToElevatedWindow)
            {
                _OpenElevatedWT(newTerminalArgs);
                sessionType = "ElevatedWindow";
            }
            else
            {
                _OpenNewWindow(newTerminalArgs);
                sessionType = "Window";
            }
        }
        else
        {
            const auto newPane = _MakePane(newTerminalArgs);
            // If the newTerminalArgs caused us to open an elevated window
            // instead of creating a pane, it may have returned nullptr. Just do
            // nothing then.
            if (!newPane)
            {
                return;
            }
            if (altPressed && !debugTap)
            {
                this->_SplitPane(_GetFocusedTabImpl(),
                                 SplitDirection::Automatic,
                                 0.5f,
                                 newPane);
                sessionType = "Pane";
            }
            else
            {
                _CreateNewTabFromPane(newPane);
                sessionType = "Tab";
            }
        }

        TraceLoggingWrite(
            g_hTerminalAppProvider,
            "NewTabMenuCreatedNewTerminalSession",
            TraceLoggingDescription("Event emitted when a new terminal was created via the new tab menu"),
            TraceLoggingValue(NumberOfTabs(), "NewTabCount", "The count of tabs currently opened in this window"),
            TraceLoggingValue(sessionType, "SessionType", "The type of session that was created"),
            TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
            TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));
    }

    std::wstring TerminalPage::_evaluatePathForCwd(const std::wstring_view path)
    {
        return Utils::EvaluateStartingDirectory(_WindowProperties.VirtualWorkingDirectory(), path);
    }

    // Method Description:
    // - Creates a new connection based on the profile settings
    // Arguments:
    // - the profile we want the settings from
    // - the terminal settings
    // Return value:
    // - the desired connection
    TerminalConnection::ITerminalConnection TerminalPage::_CreateConnectionFromSettings(Profile profile,
                                                                                        IControlSettings settings,
                                                                                        const bool inheritCursor)
    {
        static const auto textMeasurement = [&]() -> std::wstring_view {
            switch (_currentWindowSettings().TextMeasurement())
            {
            case TextMeasurement::Graphemes:
                return L"graphemes";
            case TextMeasurement::Wcswidth:
                return L"wcswidth";
            case TextMeasurement::Console:
                return L"console";
            default:
                return {};
            }
        }();
        static const auto ambiguousIsWide = [&]() -> bool {
            return _currentWindowSettings().AmbiguousWidth() == AmbiguousWidth::Wide;
        }();

        TerminalConnection::ITerminalConnection connection{ nullptr };

        auto connectionType = profile.ConnectionType();
        Windows::Foundation::Collections::ValueSet valueSet;

        if (connectionType == TerminalConnection::AzureConnection::ConnectionType() &&
            TerminalConnection::AzureConnection::IsAzureConnectionAvailable())
        {
            connection = TerminalConnection::AzureConnection{};
            valueSet = TerminalConnection::ConptyConnection::CreateSettings(winrt::hstring{},
                                                                            L".",
                                                                            L"Azure",
                                                                            false,
                                                                            L"",
                                                                            nullptr,
                                                                            settings.InitialRows(),
                                                                            settings.InitialCols(),
                                                                            winrt::guid(),
                                                                            profile.Guid());
        }

        else
        {
            auto settingsInternal{ winrt::get_self<Settings::TerminalSettings>(settings) };
            const auto environment = settingsInternal->EnvironmentVariables();

            // Update the path to be relative to whatever our CWD is.
            //
            // Refer to the examples in
            // https://en.cppreference.com/w/cpp/filesystem/path/append
            //
            // We need to do this here, to ensure we tell the ConptyConnection
            // the correct starting path. If we're being invoked from another
            // terminal instance (e.g. `wt -w 0 -d .`), then we have switched our
            // CWD to the provided path. We should treat the StartingDirectory
            // as relative to the current CWD.
            //
            // The connection must be informed of the current CWD on
            // construction, because the connection might not spawn the child
            // process until later, on another thread, after we've already
            // restored the CWD to its original value.
            auto newWorkingDirectory{ _evaluatePathForCwd(settings.StartingDirectory()) };
            auto commandline{ settings.Commandline() };

            connection = TerminalConnection::ConptyConnection{};
            valueSet = TerminalConnection::ConptyConnection::CreateSettings(commandline,
                                                                            newWorkingDirectory,
                                                                            settings.StartingTitle(),
                                                                            settingsInternal->ReloadEnvironmentVariables(),
                                                                            _WindowProperties.VirtualEnvVars(),
                                                                            environment,
                                                                            settings.InitialRows(),
                                                                            settings.InitialCols(),
                                                                            winrt::guid(),
                                                                            profile.Guid());

            if (inheritCursor)
            {
                valueSet.Insert(L"inheritCursor", Windows::Foundation::PropertyValue::CreateBoolean(true));
            }
        }

        if (!textMeasurement.empty())
        {
            valueSet.Insert(L"textMeasurement", Windows::Foundation::PropertyValue::CreateString(textMeasurement));
        }
        if (ambiguousIsWide)
        {
            valueSet.Insert(L"ambiguousIsWide", Windows::Foundation::PropertyValue::CreateBoolean(true));
        }

        if (const auto id = settings.SessionId(); id != winrt::guid{})
        {
            valueSet.Insert(L"sessionId", Windows::Foundation::PropertyValue::CreateGuid(id));
        }

        connection.Initialize(valueSet);

        TraceLoggingWrite(
            g_hTerminalAppProvider,
            "ConnectionCreated",
            TraceLoggingDescription("Event emitted upon the creation of a connection"),
            TraceLoggingGuid(connectionType, "ConnectionTypeGuid", "The type of the connection"),
            TraceLoggingGuid(profile.Guid(), "ProfileGuid", "The profile's GUID"),
            TraceLoggingGuid(connection.SessionId(), "SessionGuid", "The WT_SESSION's GUID"),
            TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
            TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));

        return connection;
    }

    TerminalConnection::ITerminalConnection TerminalPage::_duplicateConnectionForRestart(const TerminalApp::TerminalPaneContent& paneContent)
    {
        if (paneContent == nullptr)
        {
            return nullptr;
        }

        const auto& control{ paneContent.GetTermControl() };
        if (control == nullptr)
        {
            return nullptr;
        }
        const auto& connection = control.Connection();
        auto profile{ paneContent.GetProfile() };

        Settings::TerminalSettingsCreateResult controlSettings{ nullptr };

        if (profile)
        {
            // TODO GH#5047 If we cache the NewTerminalArgs, we no longer need to do this.
            profile = GetClosestProfileForDuplicationOfProfile(profile);
            controlSettings = Settings::TerminalSettings::CreateWithProfile(_settings, _currentWindowSettings(), profile);

            // Replace the Starting directory with the CWD, if given
            const auto workingDirectory = control.WorkingDirectory();
            if (Utils::IsValidDirectory(workingDirectory.c_str()))
            {
                controlSettings.DefaultSettings()->StartingDirectory(workingDirectory);
            }

            // To facilitate restarting defterm connections: grab the original
            // commandline out of the connection and shove that back into the
            // settings.
            if (const auto& conpty{ connection.try_as<TerminalConnection::ConptyConnection>() })
            {
                controlSettings.DefaultSettings()->Commandline(conpty.Commandline());
            }
        }

        return _CreateConnectionFromSettings(profile, *controlSettings.DefaultSettings(), true);
    }

    // Method Description:
    // - Called when the settings button is clicked. Launches a background
    //   thread to open the settings file in the default JSON editor.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::_SettingsButtonOnClick(const IInspectable&,
                                              const RoutedEventArgs&)
    {
        const auto window = CoreWindow::GetForCurrentThread();

        // check alt state
        const auto rAltState{ window.GetKeyState(VirtualKey::RightMenu) };
        const auto lAltState{ window.GetKeyState(VirtualKey::LeftMenu) };
        const auto altPressed{ WI_IsFlagSet(lAltState, CoreVirtualKeyStates::Down) ||
                               WI_IsFlagSet(rAltState, CoreVirtualKeyStates::Down) };

        // check shift state
        const auto shiftState{ window.GetKeyState(VirtualKey::Shift) };
        const auto lShiftState{ window.GetKeyState(VirtualKey::LeftShift) };
        const auto rShiftState{ window.GetKeyState(VirtualKey::RightShift) };
        const auto shiftPressed{ WI_IsFlagSet(shiftState, CoreVirtualKeyStates::Down) ||
                                 WI_IsFlagSet(lShiftState, CoreVirtualKeyStates::Down) ||
                                 WI_IsFlagSet(rShiftState, CoreVirtualKeyStates::Down) };

        auto target{ SettingsTarget::SettingsUI };
        if (shiftPressed)
        {
            target = SettingsTarget::SettingsFile;
        }
        else if (altPressed)
        {
            target = SettingsTarget::DefaultsFile;
        }

        const auto targetAsString = [&target]() {
            switch (target)
            {
            case SettingsTarget::SettingsFile:
                return "SettingsFile";
            case SettingsTarget::DefaultsFile:
                return "DefaultsFile";
            case SettingsTarget::SettingsUI:
            default:
                return "UI";
            }
        }();

        TraceLoggingWrite(
            g_hTerminalAppProvider,
            "NewTabMenuItemClicked",
            TraceLoggingDescription("Event emitted when an item from the new tab menu is invoked"),
            TraceLoggingValue(NumberOfTabs(), "TabCount", "The count of tabs currently opened in this window"),
            TraceLoggingValue("Settings", "ItemType", "The type of item that was clicked in the new tab menu"),
            TraceLoggingValue(targetAsString, "SettingsTarget", "The target settings file or UI"),
            TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
            TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));

        _LaunchSettings(target);
    }

    // Method Description:
    // - Called when the command palette button is clicked. Opens the command palette.
    void TerminalPage::_CommandPaletteButtonOnClick(const IInspectable&,
                                                    const RoutedEventArgs&)
    {
        auto p = LoadCommandPalette();
        p.EnableCommandPaletteMode(CommandPaletteLaunchMode::Action);
        p.Visibility(Visibility::Visible);

        TraceLoggingWrite(
            g_hTerminalAppProvider,
            "NewTabMenuItemClicked",
            TraceLoggingDescription("Event emitted when an item from the new tab menu is invoked"),
            TraceLoggingValue(NumberOfTabs(), "TabCount", "The count of tabs currently opened in this window"),
            TraceLoggingValue("CommandPalette", "ItemType", "The type of item that was clicked in the new tab menu"),
            TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
            TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));
    }

    // Method Description:
    // - Called when the "copy connection token" item in the new tab flyout is
    //   clicked. Copies the terminal-web bridge access token to the clipboard
    //   so a web/mobile client on the network can authenticate.
    void TerminalPage::_CopyConnectionTokenOnClick(const IInspectable&,
                                                   const RoutedEventArgs&)
    {
        const auto token = TerminalConnection::ConptyConnection::BridgeAccessToken();
        if (token.empty())
        {
            return;
        }

        if (const auto clipboard = clipboard::open(_hostingHwnd.value_or(nullptr)))
        {
            clipboard::write(token.c_str(), {}, {});
        }
    }

    // Method Description:
    // - Samples the terminal-web bridge connectivity and refreshes the window
    //   title when it changes, so the title bar always reflects bridge status.
    void TerminalPage::_BridgeStatusTimerTick(const IInspectable&,
                                              const IInspectable&)
    {
        const auto status = TerminalConnection::ConptyConnection::BridgeConnectionStatus();
        if (status != _bridgeStatus)
        {
            _bridgeStatus = status;
            TitleChanged.raise(*this, nullptr);
        }

        // Directory-backed projects can change whenever a shell runs `cd`.
        // Refresh on every bridge tick so the native strip follows within a
        // couple of seconds without adding another UI timer.
        _RefreshBridgeProjects();

        // The orchestrator panel shares the same 2s cadence while it's open
        // (status transitions + attaching the session once it exists).
        if (_orchestratorPaneOpen)
        {
            _RefreshOrchestratorStatus();
        }
    }

    // Reads the first line of a small git bookkeeping file (HEAD, .git stubs).
    static std::string _readGitLine(const std::filesystem::path& path)
    {
        std::ifstream file{ path };
        std::string line;
        if (file)
        {
            std::getline(file, line);
        }
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' '))
        {
            line.pop_back();
        }
        return line;
    }

    // Resolves the git branch name (or a short detached-HEAD hash) for a
    // directory by walking up to the repository root and reading HEAD
    // directly; spawning git.exe per tab per tick would be far too heavy.
    // Returns an empty string when the directory isn't inside a repository.
    // `repositoryRoot`, when given, receives the directory holding `.git`.

    static std::wstring _gitBranchUncached(std::wstring cwd, std::wstring* repositoryRoot, std::filesystem::path* headFile)
    {
        if (repositoryRoot)
        {
            repositoryRoot->clear();
        }
        if (cwd.empty())
        {
            return {};
        }

        std::error_code ec;
        std::filesystem::path dir{ std::move(cwd) };
        if (!std::filesystem::is_directory(dir, ec) || ec)
        {
            return {};
        }

        while (true)
        {
            const auto gitPath = dir / L".git";
            std::filesystem::path headPath;
            if (std::filesystem::is_directory(gitPath, ec) && !ec)
            {
                headPath = gitPath / L"HEAD";
            }
            else if (std::filesystem::is_regular_file(gitPath, ec) && !ec)
            {
                // Worktrees and submodules leave a pointer file behind:
                // "gitdir: <path-to-the-real-git-dir>"
                auto line = _readGitLine(gitPath);
                static constexpr std::string_view gitdirPrefix{ "gitdir:" };
                if (line.starts_with(gitdirPrefix))
                {
                    line.erase(0, gitdirPrefix.size());
                    while (!line.empty() && line.front() == ' ')
                    {
                        line.erase(0, 1);
                    }
                    std::filesystem::path gitdir{ til::u8u16(line) };
                    if (gitdir.is_relative())
                    {
                        gitdir = dir / gitdir;
                    }
                    headPath = std::move(gitdir) / L"HEAD";
                }
            }

            if (!headPath.empty())
            {
                if (repositoryRoot)
                {
                    *repositoryRoot = dir.wstring();
                }
                if (headFile)
                {
                    *headFile = headPath;
                }
                const auto head = _readGitLine(headPath);
                static constexpr std::string_view refPrefix{ "ref: refs/heads/" };
                if (head.starts_with(refPrefix))
                {
                    return til::u8u16(head.substr(refPrefix.size()));
                }
                if (head.starts_with("ref: "))
                {
                    return til::u8u16(head.substr(5));
                }
                if (head.size() >= 8)
                {
                    // Detached HEAD: show the short commit hash.
                    return til::u8u16(head.substr(0, 8));
                }
                return {};
            }

            auto parent = dir.parent_path();
            if (parent == dir)
            {
                return {};
            }
            dir = std::move(parent);
        }
    }

    // The rail's top-level headings. These are the project strip's contents:
    // a chip exists exactly when a heading does, carries the heading's name
    // and count, and filters the rail back down to it. Before this the strip
    // was built from the terminal-web project store instead, so a saved
    // project with no terminal open showed a chip with nothing behind it and
    // an offline bridge showed a stale strip - or none - beside a rail full
    // of sections.
    static std::vector<implementation::TabRowControl::RailSection> _railSectionsOf(const TerminalApp::TabRowControl& tabRow)
    {
        if (tabRow)
        {
            return winrt::get_self<implementation::TabRowControl>(tabRow)->RailSections();
        }
        return {};
    }

    static std::wstring _projectDirectoryKey(std::wstring_view cwd)
    {
        if (cwd.empty())
        {
            return {};
        }

        try
        {
            auto normalized = std::filesystem::path{ cwd }.lexically_normal();
            normalized.make_preferred();
            auto key = normalized.wstring();
            std::transform(key.begin(), key.end(), key.begin(), ::towlower);
            return key;
        }
        catch (...)
        {
            auto key = std::wstring{ cwd };
            std::transform(key.begin(), key.end(), key.begin(), ::towlower);
            return key;
        }
    }


    // Cached git lookup for a directory.
    //
    // Resolving a branch means probing for .git up the parent chain and then
    // reading HEAD. That is a handful of filesystem calls, which was fine
    // until it ran once per tab per refresh - on a repo checked out on ReFS,
    // with a dozen tabs open, that is the bulk of what the tab poll costs.
    //
    // Which repository a directory belongs to is effectively immutable, and
    // the branch only moves when HEAD is rewritten, so a directory-keyed
    // cache revalidated against HEAD's write time collapses a refresh to one
    // stat in the steady state. A branch changed from outside (a checkout in
    // another window, an editor) still shows up on the next poll.
    struct GitDirectoryInfo
    {
        std::wstring Root;
        std::wstring Branch;
        std::filesystem::path HeadFile;
        std::filesystem::file_time_type HeadWriteTime{};
        std::chrono::steady_clock::time_point RevalidatedAt{};
    };

    static std::wstring _gitBranchForDirectory(std::wstring cwd, std::wstring* repositoryRoot = nullptr)
    {
        if (repositoryRoot)
        {
            repositoryRoot->clear();
        }
        if (cwd.empty())
        {
            return {};
        }

        // Revalidating more often than this buys nothing: the poll that drives
        // this runs on the same order, and HEAD is not rewritten in bursts.
        static constexpr auto revalidateAfter = std::chrono::milliseconds(2000);

        static std::mutex mutex;
        static std::unordered_map<std::wstring, GitDirectoryInfo> cache;

        const auto key{ _projectDirectoryKey(cwd) };
        const auto now = std::chrono::steady_clock::now();

        std::optional<GitDirectoryInfo> known;
        {
            const std::lock_guard guard{ mutex };
            if (const auto entry = cache.find(key); entry != cache.end())
            {
                if (now - entry->second.RevalidatedAt < revalidateAfter)
                {
                    if (repositoryRoot)
                    {
                        *repositoryRoot = entry->second.Root;
                    }
                    return entry->second.Branch;
                }
                known = entry->second;
            }
        }

        // Known repository: one stat tells us whether the branch can have moved.
        if (known && !known->HeadFile.empty())
        {
            std::error_code ec;
            const auto written = std::filesystem::last_write_time(known->HeadFile, ec);
            if (!ec && written == known->HeadWriteTime)
            {
                const std::lock_guard guard{ mutex };
                if (const auto entry = cache.find(key); entry != cache.end())
                {
                    entry->second.RevalidatedAt = now;
                }
                if (repositoryRoot)
                {
                    *repositoryRoot = known->Root;
                }
                return known->Branch;
            }
        }

        GitDirectoryInfo fresh;
        fresh.Branch = _gitBranchUncached(std::move(cwd), &fresh.Root, &fresh.HeadFile);
        if (!fresh.HeadFile.empty())
        {
            std::error_code ec;
            const auto written = std::filesystem::last_write_time(fresh.HeadFile, ec);
            if (!ec)
            {
                fresh.HeadWriteTime = written;
            }
        }
        fresh.RevalidatedAt = now;

        if (repositoryRoot)
        {
            *repositoryRoot = fresh.Root;
        }
        const auto branch = fresh.Branch;
        {
            const std::lock_guard guard{ mutex };
            cache[key] = std::move(fresh);
        }
        return branch;
    }

    // Method Description:
    // - The periodic sweep behind directory and branch tracking.
    // - A shell that reports OSC 7 / OSC 9;9 does not need this at all: the
    //   working directory arrives on an event the moment it changes. The sweep
    //   exists for what events cannot cover - a shell with no integration, a
    //   TUI agent that never reports, and branch changes made from outside the
    //   terminal, which move no directory at all.
    void TerminalPage::_DirectoryRefreshTimerTick(const IInspectable&, const IInspectable&)
    {
        for (const auto& tab : _tabs)
        {
            _RefreshTabDirectory(tab);
        }
    }

    // Method Description:
    // - A pane reported a new working directory (OSC 7 / OSC 9;9). Push it
    //   through immediately rather than waiting for the sweep.
    void TerminalPage::_ControlWorkingDirectoryChangedHandler(const IInspectable& sender, const IInspectable&)
    {
        const auto control{ sender.try_as<TermControl>() };
        if (!control)
        {
            return;
        }

        // Only the pane the user is looking at names the tab's directory.
        for (const auto& tab : _tabs)
        {
            if (const auto tabImpl{ _GetTabImpl(tab) })
            {
                if (tabImpl->GetActiveTerminalControl() == control)
                {
                    _RefreshTabDirectory(tab);
                    return;
                }
            }
        }
    }

    // Method Description:
    // - Resolves where a tab's active pane is working - and, from that, its git
    //   branch and project - and publishes all three onto the Tab, where the
    //   vertical rail's row template binds them. The resolution itself runs on
    //   a background thread; only the publish happens on the UI thread.
    // - Cheap to over-call: it coalesces, so the title-change path and the
    //   periodic sweep can both ask freely.
    safe_void_coroutine TerminalPage::_RefreshTabDirectory(winrt::TerminalApp::Tab tab)
    {
        std::wstring cwd;
        std::wstring seededCwd;
        TerminalConnection::ConptyConnection conpty{ nullptr };
        const auto observedTab{ _GetTabImpl(tab) };
        if (!observedTab)
        {
            co_return;
        }

        if (const auto control{ observedTab->GetActiveTerminalControl() })
        {
            // The control pre-seeds its cwd with the profile's starting
            // directory. Only trust it as "where the shell is now" once
            // the shell has actually reported a cwd; otherwise it stays
            // frozen at the opening directory across every `cd`.
            if (control.WorkingDirectoryFromShell())
            {
                cwd = std::wstring{ control.WorkingDirectory() };
            }
            else
            {
                seededCwd = std::wstring{ control.WorkingDirectory() };
            }
            if (const auto conn{ control.Connection() })
            {
                conpty = conn.try_as<TerminalConnection::ConptyConnection>();
            }
        }

        // Nothing to resolve and nothing to clear? Skip the thread hops.
        if (cwd.empty() && seededCwd.empty() && !conpty && tab.GitBranch().empty() && tab.WorkingDirectory().empty())
        {
            co_return;
        }

        // A refresh already on its way will observe everything we just did.
        if (observedTab->DirectoryRefreshInFlight)
        {
            co_return;
        }

        // _UpdateTitle asks for a refresh on every title change, and a TUI that
        // repaints re-emits its title constantly - so without coalescing, a
        // window that merely took focus kicks off a thread hop, a process walk
        // and a rail regroup per tab per repaint. Anything a suppressed pass
        // would have found (a branch moved outside the terminal, a fallback
        // directory that shifted) the periodic sweep picks up.
        //
        // The one thing that must never wait is a shell reporting a directory
        // this tab is not already filed under: that is the `cd` the user just
        // typed, and SetWorkingDirectory only raises its event when the
        // directory actually moved.
        const auto now = std::chrono::steady_clock::now();
        static constexpr auto coalesceWindow = std::chrono::milliseconds(2000);
        const auto refreshedRecently = observedTab->LastDirectoryRefresh.time_since_epoch().count() != 0 &&
                                       now - observedTab->LastDirectoryRefresh < coalesceWindow;
        const auto shellMovedUs = !cwd.empty() && cwd != std::wstring{ tab.WorkingDirectory() };
        if (refreshedRecently && !shellMovedUs)
        {
            co_return;
        }

        observedTab->DirectoryRefreshInFlight = true;
        observedTab->LastDirectoryRefresh = now;

        // Which coding agent is running in this tab, for the rail's agent mark.
        // ForegroundAgent walks the process tree; the snapshot behind it is
        // shared and short-lived, but a tab whose shell reports OSC 7 never
        // asks for one otherwise, so this must not ride along on every pass.
        // Once per tab per sweep interval is enough: a tab that just started
        // `claude` picks up its mark on the following sweep.
        static constexpr auto agentProbeWindow = std::chrono::seconds(3);
        const auto probeAgent = conpty &&
                                (observedTab->LastAgentProbe.time_since_epoch().count() == 0 ||
                                 now - observedTab->LastAgentProbe >= agentProbeWindow);
        if (probeAgent)
        {
            observedTab->LastAgentProbe = now;
        }

        const auto shellReported{ !cwd.empty() };
        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();

        // Shell integration (OSC 7 / OSC 9;9) is authoritative and is never
        // second-guessed here. It is also the only thing that can be right for
        // pwsh, which moves its provider location on `cd` and leaves the
        // process cwd where the tab started.
        //
        // Without it, fall back to the directory the process tree is running
        // in. That is genuinely correct for a program launched in a directory
        // (a TUI agent, cmd) and merely stale for a bare pwsh prompt.
        if (!shellReported && conpty)
        {
            cwd = std::wstring{ conpty.ForegroundWorkingDirectory() };
        }
        if (cwd.empty())
        {
            // No shell report and no readable process: the opening directory
            // is the best remaining guess.
            cwd = std::move(seededCwd);
        }

        std::wstring gitRoot;
        const auto branch = _gitBranchForDirectory(cwd, &gitRoot);

        // Nothing on a suppressed pass: leaving the value untouched is what
        // keeps a mark from blinking off between probes.
        std::optional<winrt::hstring> agent;
        if (probeAgent)
        {
            agent = conpty.ForegroundAgent();
        }

        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        const auto tabImpl{ page->_GetTabImpl(tab) };
        if (!tabImpl)
        {
            co_return;
        }
        tabImpl->DirectoryRefreshInFlight = false;

        auto railNeedsRefresh{ false };
        if (tabImpl->GitRoot() != gitRoot)
        {
            tabImpl->GitRoot(winrt::hstring{ gitRoot });
            railNeedsRefresh = true;
        }
        tabImpl->GitBranch(winrt::hstring{ branch });
        if (agent)
        {
            tabImpl->RailAgent(*agent);
        }

        // A project's identity follows the active pane's live working
        // directory. The server discovers/names directories centrally; once
        // its refreshed list contains this cwd, move the tab into that filter
        // and mirror the assignment back to web/mobile clients.
        if (!cwd.empty())
        {
            // The rail groups by path, so it needs the live directory even
            // before the bridge has a project for it.
            auto directoryMoved{ false };
            if (tabImpl->WorkingDirectory() != cwd)
            {
                tabImpl->WorkingDirectory(winrt::hstring{ cwd });
                railNeedsRefresh = true;
                directoryMoved = true;
            }

            // The bridge derives the project list from every session's live
            // directory, so tell it where this pane is now. Deduped inside.
            if (conpty)
            {
                conpty.UpdateBridgeCwd(winrt::hstring{ cwd });
            }

            const auto cwdKey{ _projectDirectoryKey(cwd) };
            const auto project = std::find_if(page->_bridgeProjects.begin(), page->_bridgeProjects.end(), [&](const auto& candidate) {
                return _projectDirectoryKey(candidate.Cwd) == cwdKey;
            });

            if (project != page->_bridgeProjects.end() && tab.ProjectId() != project->Id)
            {
                tabImpl->ProjectId(project->Id);
                tabImpl->ProjectName(project->Name);
                tabImpl->ProjectPath(project->Cwd);

                if (conpty)
                {
                    conpty.SetBridgeProject(project->Id);
                }

                // The rail's sections are keyed by directory, not by project
                // id, so a remapped tab still has to be regrouped.
                railNeedsRefresh = true;
            }

            // The strip filters the rail by section. A `cd` that walks the
            // focused tab out of the section the user is looking at takes the
            // strip with it, rather than leaving them staring at a rail the
            // tab has left. Only an actual move counts - a tab merely being
            // focused must not retarget the filter - and the test itself is
            // two string compares, no process or filesystem work.
            if (directoryMoved &&
                !page->_activeSectionKey.empty() &&
                !implementation::TabRowControl::SectionContainsTab(page->_activeSectionKey, tab))
            {
                if (const auto focused{ page->_GetFocusedTab() }; focused && focused == tab)
                {
                    page->_SelectSection(implementation::TabRowControl::SectionKeyForTab(tab));
                }
            }
        }

        // Hand the tab's repository and branch to the rail's shared registry
        // and let it re-decide what its row prints. The rail says a branch once
        // per repository, on the section header, so a `git checkout` in one tab
        // changes what every other tab in that checkout shows: fan the verdict
        // out, and rebuild so the headers pick it up too.
        if (tabImpl->RefreshRailSemantics())
        {
            for (const auto& sibling : page->_tabs)
            {
                if (const auto siblingImpl{ page->_GetTabImpl(sibling) }; siblingImpl && siblingImpl != tabImpl)
                {
                    siblingImpl->RefreshRailSemantics();
                }
            }
            railNeedsRefresh = true;
        }

        if (railNeedsRefresh && page->_tabRow)
        {
            winrt::get_self<implementation::TabRowControl>(page->_tabRow)->NotifyTabDirectoryUpdated();
        }
    }

    // Method Description:
    // - Fetches the project list from the local terminal-web server on a
    //   background thread and rebuilds the horizontal project tab strip when
    //   it changed.
    safe_void_coroutine TerminalPage::_RefreshBridgeProjects()
    {
        if (_projectFetchInFlight.exchange(true))
        {
            co_return;
        }

        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();

        std::vector<BridgeProject> projects;
        auto fetched = false;
        if (const auto response{ _projectServerRequest(L"GET", L"/api/projects") })
        {
            WDJ::JsonArray array{ nullptr };
            if (WDJ::JsonArray::TryParse(winrt::to_hstring(*response), array))
            {
                fetched = true;
                for (const auto& item : array)
                {
                    if (item.ValueType() != WDJ::JsonValueType::Object)
                    {
                        continue;
                    }
                    const auto obj{ item.GetObject() };
                    BridgeProject project{
                        obj.GetNamedString(L"id", L""),
                        obj.GetNamedString(L"name", L""),
                        obj.GetNamedString(L"cwd", L"")
                    };
                    if (!project.Id.empty())
                    {
                        projects.push_back(std::move(project));
                    }
                }
            }
        }

        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        page->_projectFetchInFlight.store(false);

        if (fetched && page->_bridgeProjects != projects)
        {
            page->_bridgeProjects = std::move(projects);

            // Project discovery is driven by live cwd changes. Remap tabs as
            // soon as the refreshed directory list arrives instead of waiting
            // for the next git-branch timer tick.
            for (const auto& tab : page->_tabs)
            {
                page->_RefreshTabDirectory(tab);
            }
            // Names and order for the rail's sections. Which sections exist is
            // not the bridge's call any more - a saved project with no live
            // terminal simply has no heading and therefore no chip - so a
            // project vanishing server-side cannot invalidate the selection.
            page->_ApplyProjectNames();
            page->_UpdateActiveSectionTargets();
            page->_RebuildProjectTabs();
        }
    }

    // Method Description:
    // - Rebuilds the horizontal strip: "All", then one chip per top-level
    //   heading in the rail below, then a hairline and the strip's own quiet
    //   actions.
    // - The chips come straight from TabRowControl::RailSections(), so the
    //   strip and the rail cannot disagree: a chip exists exactly when a
    //   heading does, wears the heading's name, and mirrors its tab count.
    //   The count is the point - reading "Projects 3" above and "Projects 3"
    //   below is what makes the two lists legible as one thing.
    // - Every metric, brush and template it uses is a resource declared in
    //   TerminalPage.xaml, which derives them from the rail's own token set,
    //   so nothing here hand-writes a size or a colour. The active chip wears
    //   the "on" mark the rail gives a checked toggle - a neutral fill plus
    //   primary foreground, SemiBold on top - and deliberately not an accent
    //   fill: the accent means "the tab you are looking at", which is the
    //   rail's selection bar, and a second accent here would compete.
    void TerminalPage::_RebuildProjectTabs()
    {
        const auto panel{ ProjectTabPanel() };
        if (!panel)
        {
            return;
        }

        panel.Children().Clear();

        // A missing key must never take the strip down with it, so each lookup
        // degrades to "unstyled" rather than throwing.
        const auto lookupStyle = [this](const wchar_t* key) -> WUX::Style {
            try
            {
                return Resources().Lookup(winrt::box_value(key)).try_as<WUX::Style>();
            }
            CATCH_LOG();
            return nullptr;
        };

        const auto chipStyle{ lookupStyle(L"ProjectStripChipStyle") };
        const auto activeChipStyle{ lookupStyle(L"ProjectStripChipActiveStyle") };
        const auto scopeChipStyle{ lookupStyle(L"ProjectStripScopeChipStyle") };
        const auto scopeChipActiveStyle{ lookupStyle(L"ProjectStripScopeChipActiveStyle") };
        const auto iconButtonStyle{ lookupStyle(L"ProjectStripIconButtonStyle") };
        const auto closeButtonStyle{ lookupStyle(L"ProjectStripCloseButtonStyle") };
        const auto labelStyle{ lookupStyle(L"ProjectStripLabelStyle") };
        const auto countStyle{ lookupStyle(L"ProjectStripCountStyle") };
        const auto dividerStyle{ lookupStyle(L"ProjectStripDividerStyle") };

        const auto weakThis{ get_weak() };
        const auto sections{ _railSectionsOf(_tabRow) };

        const auto addDivider = [&]() {
            Border divider;
            if (dividerStyle)
            {
                divider.Style(dividerStyle);
            }
            panel.Children().Append(divider);
        };

        // Every chip in strip order. The keyboard walks these as one tablist:
        // the active chip is the strip's only tab stop and the arrows move
        // between chips, so a dozen open projects don't cost a dozen Tab
        // presses to step past.
        std::vector<Button> chips;

        auto addChip = [&](const winrt::hstring& label,
                           const winrt::hstring& key,
                           const winrt::hstring& directory,
                           const uint32_t count,
                           const bool scope) {
            const auto active{ key == _activeSectionKey };
            Button tabButton;
            const auto style{ scope ? (active ? scopeChipActiveStyle : scopeChipStyle) : (active ? activeChipStyle : chipStyle) };
            if (style)
            {
                tabButton.Style(style);
            }
            // The section key travels with the chip so the drop handler can
            // read the strip's real order back off the panel instead of
            // assuming its child indices line up with some other list.
            tabButton.Tag(winrt::box_value(key));

            StackPanel content;
            content.Orientation(Orientation::Horizontal);

            TextBlock text;
            text.Text(label);
            if (labelStyle)
            {
                text.Style(labelStyle);
            }
            content.Children().Append(text);

            // The heading's own count, mirrored. Raw to automation: the number
            // is already part of the chip's name, and hearing it twice is
            // exactly the kind of repetition the rail spent a pass removing.
            TextBlock countText;
            countText.Text(winrt::to_hstring(count));
            if (countStyle)
            {
                countText.Style(countStyle);
            }
            Automation::AutomationProperties::SetAccessibilityView(countText, Automation::Peers::AccessibilityView::Raw);
            content.Children().Append(countText);

            if (!scope)
            {
                Button closeButton;
                if (closeButtonStyle)
                {
                    closeButton.Style(closeButtonStyle);
                }
                closeButton.Content(winrt::box_value(L"\xE711")); // Cancel

                // Row actions in the rail appear on hover or on keyboard focus
                // and are invisible otherwise; a chip's close button reads the
                // same way. Its slot stays reserved either way, so the strip
                // never reflows out from under the pointer.
                closeButton.Opacity(0.0);
                // Not a tab stop: the strip is one stop, and the same action
                // sits on the chip's context menu and on its Delete key.
                closeButton.IsTabStop(false);
                Automation::AutomationProperties::SetName(closeButton, L"Close " + label);
                ToolTipService::SetToolTip(closeButton, winrt::box_value(L"Close project"));
                closeButton.Click([weakThis, key, label, directory](auto&&, auto&&) {
                    if (const auto page{ weakThis.get() })
                    {
                        page->_CloseSectionRequested(key, label, directory);
                    }
                });
                content.Children().Append(closeButton);

                const auto weakChip{ winrt::make_weak(tabButton) };
                const auto weakClose{ winrt::make_weak(closeButton) };
                const auto hovered{ std::make_shared<bool>(false) };
                const auto focused{ std::make_shared<bool>(false) };
                const auto revealClose = [weakClose, hovered, focused]() {
                    if (const auto button{ weakClose.get() })
                    {
                        button.Opacity((*hovered || *focused) ? 1.0 : 0.0);
                    }
                };

                tabButton.PointerEntered([hovered, revealClose](auto&&, auto&&) {
                    *hovered = true;
                    revealClose();
                });
                tabButton.PointerExited([weakChip, hovered, revealClose](auto&&, const WUX::Input::PointerRoutedEventArgs& e) {
                    // The close button's own exit bubbles up here too, and
                    // acting on it would hide the button the instant the
                    // pointer reached it. Only a pointer that has actually
                    // left the chip counts.
                    if (const auto chip{ weakChip.get() })
                    {
                        const auto position{ e.GetCurrentPoint(chip).Position() };
                        if (position.X >= 0 && position.Y >= 0 &&
                            position.X <= chip.ActualWidth() && position.Y <= chip.ActualHeight())
                        {
                            return;
                        }
                    }
                    *hovered = false;
                    revealClose();
                });
                tabButton.GotFocus([focused, revealClose](auto&&, auto&&) {
                    *focused = true;
                    revealClose();
                });
                tabButton.LostFocus([focused, revealClose](auto&&, auto&&) {
                    *focused = false;
                    revealClose();
                });
            }

            tabButton.Content(content);

            // The full directory belongs in the tooltip, not on the chip: the
            // strip has to stay one quiet line however deep the paths go.
            const winrt::hstring tooltip{ scope ? winrt::hstring{ L"Every tab in this window" } :
                                                 (directory.empty() ? winrt::hstring{ L"Tabs with no working directory" } : directory) };
            ToolTipService::SetToolTip(tabButton, winrt::box_value(tooltip));
            Automation::AutomationProperties::SetName(tabButton, label + L", " + winrt::to_hstring(count) + L" tabs");
            Automation::AutomationProperties::SetLocalizedControlType(tabButton, L"filter");
            Automation::AutomationProperties::SetFullDescription(tabButton, tooltip);
            if (active)
            {
                Automation::AutomationProperties::SetItemStatus(tabButton, L"Selected");
            }

            tabButton.Click([weakThis, key](auto&&, auto&&) {
                const auto page{ weakThis.get() };
                if (!page)
                {
                    return;
                }
                // Selecting rebuilds the strip, which releases this very chip
                // and the captures that came with it; keep the key on the
                // stack for the rest of the handler.
                const auto sectionKey{ key };
                if (!sectionKey.empty() && sectionKey == page->_activeSectionKey)
                {
                    // Clicking the chip you are already inside is the way back
                    // out. Clearing to "All" and scrolling that heading into
                    // view means the round trip never loses your place in the
                    // full index.
                    page->_SelectSection({});
                    if (page->_tabRow)
                    {
                        winrt::get_self<implementation::TabRowControl>(page->_tabRow)->ScrollSectionIntoView(sectionKey);
                    }
                }
                else
                {
                    page->_SelectSection(sectionKey);
                }
            });

            if (!scope)
            {
                // Right-click: rename (remembered per directory) or close.
                MenuFlyout contextFlyout;
                MenuFlyoutItem renameItem;
                renameItem.Text(L"Rename project...");
                FontIcon renameIcon;
                renameIcon.Glyph(L"\xE8AC"); // Rename
                renameItem.Icon(renameIcon);
                renameItem.IsEnabled(!directory.empty());
                const auto weakButton{ winrt::make_weak(tabButton) };
                renameItem.Click([weakThis, weakButton, directory, label](auto&&, auto&&) {
                    const auto page{ weakThis.get() };
                    const auto button{ weakButton.get() };
                    if (page && button)
                    {
                        page->_ShowRenameSectionFlyout(button, directory, label);
                    }
                });
                contextFlyout.Items().Append(renameItem);

                MenuFlyoutItem closeItem;
                closeItem.Text(L"Close project");
                FontIcon closeItemIcon;
                closeItemIcon.Glyph(L"\xE711"); // Cancel
                closeItem.Icon(closeItemIcon);
                closeItem.Click([weakThis, key, label, directory](auto&&, auto&&) {
                    if (const auto page{ weakThis.get() })
                    {
                        page->_CloseSectionRequested(key, label, directory);
                    }
                });
                contextFlyout.Items().Append(closeItem);
                tabButton.ContextFlyout(contextFlyout);

                // Double-click renames too.
                tabButton.DoubleTapped([weakThis, weakButton, directory, label](auto&&, auto&&) {
                    const auto page{ weakThis.get() };
                    const auto button{ weakButton.get() };
                    if (page && button)
                    {
                        page->_ShowRenameSectionFlyout(button, directory, label);
                    }
                });

                // Chips can be dragged to reorder; the panel's Drop handler
                // (wired in Create()) computes the target position.
                tabButton.CanDrag(true);
                tabButton.DragStarting([key](const WUX::UIElement&, const WUX::DragStartingEventArgs& args) {
                    args.Data().SetText(key);
                    args.Data().RequestedOperation(DataPackageOperation::Move);
                });
            }

            chips.push_back(tabButton);
            panel.Children().Append(tabButton);
        };

        // "All" is a scope over the sections, not a peer of them: it takes a
        // quieter chip and stands on its own side of a hairline, so the strip
        // reads as "scope | the things in it" rather than as one flat row in
        // which the first entry happens to mean something different.
        uint32_t total{ 0 };
        for (const auto& section : sections)
        {
            total += section.Count;
        }
        addChip(L"All", {}, {}, total, true);
        if (!sections.empty())
        {
            addDivider();
        }

        for (const auto& section : sections)
        {
            addChip(section.Name, section.Key, section.Directory, section.Count, false);
        }

        // One tab stop, arrows between chips - the standard tablist. The stop
        // is the active chip, so Tab always lands on where you already are.
        const auto weakChips{ std::make_shared<std::vector<winrt::weak_ref<Button>>>() };
        for (const auto& chip : chips)
        {
            weakChips->push_back(winrt::make_weak(chip));
        }

        auto anyTabStop{ false };
        for (uint32_t i = 0; i < chips.size(); ++i)
        {
            const auto& chip{ chips[i] };
            const auto isActiveStop{ winrt::unbox_value_or<winrt::hstring>(chip.Tag(), winrt::hstring{}) == _activeSectionKey };
            chip.IsTabStop(isActiveStop);
            anyTabStop = anyTabStop || isActiveStop;
            Automation::AutomationProperties::SetPositionInSet(chip, gsl::narrow_cast<int32_t>(i) + 1);
            Automation::AutomationProperties::SetSizeOfSet(chip, gsl::narrow_cast<int32_t>(chips.size()));

            const size_t index{ i };
            chip.KeyDown([weakThis, weakChips, index](const IInspectable& sender, const WUX::Input::KeyRoutedEventArgs& e) {
                const auto count{ weakChips->size() };
                if (count == 0)
                {
                    return;
                }

                auto target{ count };
                switch (e.Key())
                {
                case VirtualKey::Left:
                    target = index == 0 ? count - 1 : index - 1;
                    break;
                case VirtualKey::Right:
                    target = index + 1 >= count ? 0 : index + 1;
                    break;
                case VirtualKey::Home:
                    target = 0;
                    break;
                case VirtualKey::End:
                    target = count - 1;
                    break;
                case VirtualKey::Delete:
                {
                    // Closing the focused section without reaching for a
                    // button that stays invisible until it is hovered.
                    const auto page{ weakThis.get() };
                    const auto source{ sender.try_as<Button>() };
                    if (page && source)
                    {
                        const auto sectionKey{ winrt::unbox_value_or<winrt::hstring>(source.Tag(), winrt::hstring{}) };
                        if (!sectionKey.empty())
                        {
                            e.Handled(true);
                            page->_CloseSectionForKey(sectionKey);
                        }
                    }
                    return;
                }
                case VirtualKey::F2:
                {
                    const auto page{ weakThis.get() };
                    const auto source{ sender.try_as<Button>() };
                    if (page && source)
                    {
                        const auto sectionKey{ winrt::unbox_value_or<winrt::hstring>(source.Tag(), winrt::hstring{}) };
                        if (!sectionKey.empty())
                        {
                            e.Handled(true);
                            page->_RenameSectionForKey(source, sectionKey);
                        }
                    }
                    return;
                }
                default:
                    return;
                }

                if (target < count)
                {
                    if (const auto next{ (*weakChips)[target].get() })
                    {
                        e.Handled(true);
                        // A roving tab stop, and not only for tab order:
                        // IsTabStop is also UWP's focusability gate, so the
                        // chip being arrowed to has to become the stop before
                        // it can take focus. Moving the stop with the focus is
                        // what the tablist pattern wants anyway - Tab comes
                        // back to wherever the arrows left off.
                        for (const auto& weak : *weakChips)
                        {
                            if (const auto other{ weak.get() })
                            {
                                other.IsTabStop(other == next);
                            }
                        }
                        next.Focus(FocusState::Keyboard);
                    }
                }
            });
        }
        if (!anyTabStop && !chips.empty())
        {
            // The filter points at a section that is momentarily gone; the
            // strip must still be reachable from the keyboard.
            chips.front().IsTabStop(true);
        }

        // A hairline separates the sections from the strip's own actions, so
        // "+" and the globe read as chrome rather than as two more projects.
        addDivider();

        const auto addStripAction = [&](const wchar_t* glyph, const winrt::hstring& name, const WUX::RoutedEventHandler& onClick) {
            Button button;
            if (iconButtonStyle)
            {
                button.Style(iconButtonStyle);
            }
            button.Content(winrt::box_value(glyph));
            ToolTipService::SetToolTip(button, winrt::box_value(name));
            Automation::AutomationProperties::SetName(button, name);
            button.Click(onClick);
            panel.Children().Append(button);
        };

        // Add.
        addStripAction(L"\xE710", L"New Project", [weakThis](auto&&, auto&&) {
            if (const auto page{ weakThis.get() })
            {
                page->_ShowNewProjectTip();
            }
        });

        // Globe: open the terminal-web view in the default browser.
        addStripAction(L"\xE774", L"Open web view", [](auto&&, auto&&) {
            const auto [host, port] = _projectServerEndpoint();
            std::ignore = Launcher::LaunchUriAsync(Windows::Foundation::Uri{ L"http://" + host + L":" + std::to_wstring(port) + L"/" });
        });
    }

    // Method Description:
    // - The keyboard shortcuts on a focused chip need the section's name and
    //   directory, which only the rail knows. Look them up at the moment the
    //   key is pressed rather than capturing a copy a rebuild would have
    //   staled.
    void TerminalPage::_CloseSectionForKey(const winrt::hstring& sectionKey)
    {
        for (const auto& section : _railSectionsOf(_tabRow))
        {
            if (section.Key == sectionKey)
            {
                _CloseSectionRequested(sectionKey, section.Name, section.Directory);
                return;
            }
        }
    }

    void TerminalPage::_RenameSectionForKey(const FrameworkElement& anchor, const winrt::hstring& sectionKey)
    {
        for (const auto& section : _railSectionsOf(_tabRow))
        {
            if (section.Key == sectionKey && !section.Directory.empty())
            {
                _ShowRenameSectionFlyout(anchor, section.Directory, section.Name);
                return;
            }
        }
    }

    // Method Description:
    // - The rail's sections are the strip's contents, so a change to them -
    //   a tab moved directory, the last tab under a heading closed - is what
    //   rebuilds the strip. Nothing else may add or remove a chip.
    void TerminalPage::_OnRailSectionsChanged()
    {
        if (!_activeSectionKey.empty())
        {
            auto stillExists{ false };
            for (const auto& section : _railSectionsOf(_tabRow))
            {
                if (section.Key == _activeSectionKey)
                {
                    stillExists = true;
                    break;
                }
            }
            if (!stillExists)
            {
                // The last terminal under that heading closed, so the heading
                // is gone and its chip goes with it: fall back to the whole
                // index rather than to a filter that can match nothing.
                _SelectSection({});
                return;
            }
        }

        _UpdateActiveSectionTargets();
        _RebuildProjectTabs();
    }

    // Method Description:
    // - Re-derives what the active section means downstream: the directory
    //   new terminals start in, and the terminal-web project id (when one
    //   sits behind that directory) that new tabs are stamped with so remote
    //   clients group them. A section with no project behind it leaves the id
    //   empty, which is exactly what an untagged tab wants.
    void TerminalPage::_UpdateActiveSectionTargets()
    {
        winrt::hstring directory;
        if (!_activeSectionKey.empty())
        {
            for (const auto& section : _railSectionsOf(_tabRow))
            {
                if (section.Key == _activeSectionKey)
                {
                    directory = section.Directory;
                    break;
                }
            }
        }

        _activeProjectCwd = directory;
        _activeProjectId = {};
        if (directory.empty())
        {
            return;
        }

        const auto key{ _projectDirectoryKey(directory) };
        for (const auto& project : _bridgeProjects)
        {
            if (_projectDirectoryKey(project.Cwd) == key)
            {
                _activeProjectId = project.Id;
                return;
            }
        }
    }

    // Method Description:
    // - Makes one rail section the active filter: the rail narrows to it (its
    //   own heading and any subheading nested under it included) and new
    //   terminals start in its directory. An empty key is "All".
    // - `sectionDirectory` is only for a section the rail has not seen yet -
    //   a project just created in a directory with no terminal in it - which
    //   is also the one case that opens a terminal of its own.
    void TerminalPage::_SelectSection(const winrt::hstring& sectionKey, const winrt::hstring& sectionDirectory)
    {
        _activeSectionKey = sectionKey;
        _UpdateActiveSectionTargets();
        if (_activeProjectCwd.empty() && !sectionDirectory.empty())
        {
            _activeProjectCwd = sectionDirectory;
        }

        if (_tabRow)
        {
            winrt::get_self<implementation::TabRowControl>(_tabRow)->SetSectionFilter(sectionKey);
        }

        _RebuildProjectTabs();

        // Filtering the rail can retire the very section being selected (its
        // last tab closed in the same beat), which clears the selection from
        // under us; don't then act on a section that is gone.
        if (sectionKey.empty() || _activeSectionKey != sectionKey)
        {
            return;
        }

        // Keep the focused tab inside the section the user is now looking at.
        if (const auto focused{ _GetFocusedTab() }; focused && implementation::TabRowControl::SectionContainsTab(sectionKey, focused))
        {
            return;
        }
        for (const auto& tab : _tabs)
        {
            if (implementation::TabRowControl::SectionContainsTab(sectionKey, tab))
            {
                _SetFocusedTab(tab);
                return;
            }
        }

        // A brand-new project has no terminal in it yet, so selecting it
        // launches one. Every section the rail publishes already has a tab,
        // so this can only fire for that case.
        if (!sectionDirectory.empty())
        {
            NewTerminalArgs args;
            args.StartingDirectory(sectionDirectory);
            _OpenNewTerminalViaDropdown(args);
        }
    }

    // Method Description:
    // - Refreshes every tab's project display name from the current project
    //   list, then hands the rail the two things the bridge still owns about
    //   a section: what a directory is *called* and what order the strip
    //   shows directories in.
    // - Membership is deliberately not among them. Which sections exist comes
    //   from the live tabs, so a saved project with no terminal open in it
    //   simply has no heading and therefore no chip, and an offline bridge
    //   costs names and ordering rather than the whole strip.
    void TerminalPage::_ApplyProjectNames()
    {
        for (const auto& tab : _tabs)
        {
            const auto tabImpl{ _GetTabImpl(tab) };
            if (!tabImpl || tab.ProjectId().empty())
            {
                continue;
            }
            for (const auto& project : _bridgeProjects)
            {
                if (project.Id == tab.ProjectId())
                {
                    if (tabImpl->ProjectName() != project.Name)
                    {
                        tabImpl->ProjectName(project.Name);
                    }
                    if (tabImpl->ProjectPath() != project.Cwd)
                    {
                        tabImpl->ProjectPath(project.Cwd);
                    }
                    break;
                }
            }
        }

        if (!_tabRow)
        {
            return;
        }

        // Names, keyed by directory the way the rail keys its sections.
        std::map<std::wstring, winrt::hstring> names;
        for (const auto& project : _bridgeProjects)
        {
            auto key{ implementation::TabRowControl::NormalizeDirectory(project.Cwd) };
            if (!key.empty() && !project.Name.empty())
            {
                names.emplace(std::move(key), project.Name);
            }
        }

        // A rename made here while the bridge was unreachable outranks the
        // bridge's own name - and retires itself the moment the bridge comes
        // back agreeing with it, so it can never shadow a later rename made
        // from the web.
        std::erase_if(_sectionNameOverrides, [&](const auto& entry) {
            const auto found{ names.find(entry.first) };
            return found != names.end() && found->second == entry.second;
        });
        for (const auto& [key, name] : _sectionNameOverrides)
        {
            names[key] = name;
        }

        // Order: whatever the user last dragged the strip into, with the
        // bridge's project order filling in every directory that drag never
        // named. Sections outside both sort by name after the ranked ones.
        auto order{ _sectionOrder };
        for (const auto& project : _bridgeProjects)
        {
            auto key{ implementation::TabRowControl::NormalizeDirectory(project.Cwd) };
            if (!key.empty() && std::find(order.begin(), order.end(), key) == order.end())
            {
                order.push_back(std::move(key));
            }
        }

        const auto rail{ winrt::get_self<implementation::TabRowControl>(_tabRow) };
        rail->SetSectionNames(std::move(names));
        rail->SetSectionOrder(std::move(order));
    }

    // Method Description:
    // - Opens a small flyout with a text box anchored to a chip. Enter (or
    //   losing focus with a changed name) renames the *directory* - which is
    //   what a section is - rather than a project id, so a heading with no
    //   saved project behind it can be renamed too.
    void TerminalPage::_ShowRenameSectionFlyout(const FrameworkElement& anchor, const winrt::hstring& directory, const winrt::hstring& currentName)
    {
        Flyout flyout;
        TextBox nameBox;
        nameBox.Text(currentName);
        nameBox.MinWidth(220);
        nameBox.PlaceholderText(L"Project name");
        Automation::AutomationProperties::SetName(nameBox, L"Project name");

        const auto weakThis{ get_weak() };
        // Weak: the flyout owns the box, which owns these handlers.
        const auto weakFlyout{ winrt::make_weak(flyout) };
        auto commit = [weakThis, directory, currentName, weakFlyout](const TextBox& box) {
            const auto newName{ box.Text() };
            if (const auto flyout{ weakFlyout.get() })
            {
                flyout.Hide();
            }
            if (const auto page{ weakThis.get() })
            {
                if (!newName.empty() && newName != currentName)
                {
                    page->_RenameSection(directory, newName);
                }
            }
        };

        nameBox.KeyDown([commit, weakFlyout](const IInspectable& sender, const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e) {
            if (e.Key() == VirtualKey::Enter)
            {
                e.Handled(true);
                commit(sender.as<TextBox>());
            }
            else if (e.Key() == VirtualKey::Escape)
            {
                e.Handled(true);
                if (const auto flyout{ weakFlyout.get() })
                {
                    flyout.Hide();
                }
            }
        });

        flyout.Content(nameBox);
        flyout.Opened([weakBox = winrt::make_weak(nameBox)](auto&&, auto&&) {
            const auto nameBox{ weakBox.get() };
            if (!nameBox)
            {
                return;
            }
            nameBox.Focus(FocusState::Programmatic);
            nameBox.SelectAll();
        });
        flyout.ShowAt(anchor);
    }

    // Method Description:
    // - Renames a rail section, i.e. a directory.
    // - Applied here first, then pushed to the bridge, because the bridge is
    //   often the thing that is down: a rename that visibly does nothing is
    //   worse than one that is only remembered for this session. The local
    //   override retires itself in _ApplyProjectNames once the bridge reports
    //   the same name.
    // - A directory the bridge has no saved project for is renamed by
    //   *creating* one (POST /api/projects) - that is how the bridge
    //   remembers a name per directory, and the Rust host reuses the
    //   directory's automatic id, so nothing is duplicated. It does not make
    //   the section any more or less real: membership still comes from the
    //   live tabs, so a saved project whose last terminal closes loses its
    //   chip exactly like any other section.
    safe_void_coroutine TerminalPage::_RenameSection(winrt::hstring directory, winrt::hstring newName)
    {
        if (directory.empty() || newName.empty())
        {
            co_return;
        }

        _sectionNameOverrides[implementation::TabRowControl::NormalizeDirectory(directory)] = newName;
        _ApplyProjectNames();

        winrt::hstring projectId;
        const auto directoryKey{ _projectDirectoryKey(directory) };
        for (const auto& project : _bridgeProjects)
        {
            if (_projectDirectoryKey(project.Cwd) == directoryKey)
            {
                projectId = project.Id;
                break;
            }
        }

        WDJ::JsonObject body;
        body.SetNamedValue(L"name", WDJ::JsonValue::CreateStringValue(newName));
        std::wstring path{ L"/api/projects" };
        if (projectId.empty())
        {
            body.SetNamedValue(L"cwd", WDJ::JsonValue::CreateStringValue(directory));
        }
        else
        {
            path += L"/" + std::wstring{ projectId };
        }
        const auto* const verb{ projectId.empty() ? L"POST" : L"PATCH" };
        const auto payload{ winrt::to_string(body.Stringify()) };

        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();
        const auto response{ _projectServerRequest(verb, path, payload) };
        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page || !response)
        {
            // Offline: the local override above is the whole of the rename,
            // and it holds until the bridge is reachable again.
            co_return;
        }

        for (auto& project : page->_bridgeProjects)
        {
            if (project.Id == projectId)
            {
                project.Name = newName;
                break;
            }
        }
        page->_ApplyProjectNames();
        page->_RefreshBridgeProjects();
    }

    // Method Description:
    // - Shows or hides the orchestrator panel. While open, the bridge status
    //   timer keeps its status fresh and attaches the session's TermControl.
    void TerminalPage::_ToggleOrchestratorPane()
    {
        _orchestratorPaneOpen = !_orchestratorPaneOpen;
        OrchestratorPane().Visibility(_orchestratorPaneOpen ? Visibility::Visible : Visibility::Collapsed);

        // Mark the right-edge toggle while the panel is open. The strip has
        // one rule - a filled, hairlined chip means "on" - and this is the
        // same marking the active project wears. Accent stays reserved for
        // the rail's selected tab.
        try
        {
            const auto key = _orchestratorPaneOpen ? L"ProjectStripIconButtonActiveStyle" : L"ProjectStripIconButtonStyle";
            if (const auto style = Resources().Lookup(winrt::box_value(key)).try_as<WUX::Style>())
            {
                OrchestratorToggleButton().Style(style);
            }
        }
        CATCH_LOG();

        if (_orchestratorPaneOpen)
        {
            // Reload the whole transcript on open: other clients may have
            // talked to the orchestrator while the pane was closed.
            _orchestratorNeedsFullRefresh = true;
            _RefreshOrchestratorStatus();
            OrchestratorComposer().Focus(FocusState::Programmatic);
        }
        else if (_orchestratorPollTimer)
        {
            _orchestratorPollTimer.Stop();
        }
    }

    // Orchestrator pane resize: same handle mechanics as the vertical tab
    // rail, mirrored for a right-docked pane (dragging left widens it). The
    // pane's column is Auto-sized in the root grid, so the terminal content
    // column reflows automatically as the pane width changes.
    void TerminalPage::_SetOrchestratorPaneWidth(const double width)
    {
        const auto column{ OrchestratorColumn() };
        const auto minWidth{ column.MinWidth() };
        auto maxWidth{ column.MaxWidth() };

        const auto rootWidth{ Root().ActualWidth() };
        if (rootWidth > 0)
        {
            const auto occupied{ VerticalTabPane().ActualWidth() + OrchestratorResizeHandle().ActualWidth() };
            const auto maxWidthWithContent{ std::max(minWidth, rootWidth - occupied - MinimumTerminalContentWidth) };
            maxWidth = std::min(maxWidth, maxWidthWithContent);
        }

        const auto clampedWidth{ std::clamp(width, minWidth, maxWidth) };
        column.Width(GridLengthHelper::FromValueAndType(clampedWidth, GridUnitType::Pixel));
    }

    void TerminalPage::_OrchestratorResizePointerEntered(const IInspectable&,
                                                         const Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        _SetVerticalTabResizeCursor(true);
        OrchestratorResizeGrip().Opacity(_resizingOrchestratorPane ? ResizeHandleDragOpacity : ResizeHandleHoverOpacity);
    }

    void TerminalPage::_OrchestratorResizePointerExited(const IInspectable&,
                                                        const Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        if (!_resizingOrchestratorPane)
        {
            _SetVerticalTabResizeCursor(false);
            OrchestratorResizeGrip().Opacity(ResizeHandleRestOpacity);
        }
    }

    void TerminalPage::_OrchestratorResizePointerPressed(const IInspectable& sender,
                                                         const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        const auto resizeHandle{ sender.try_as<WUX::UIElement>() };
        if (!resizeHandle)
        {
            return;
        }

        resizeHandle.CapturePointer(e.Pointer());
        const auto point{ e.GetCurrentPoint(Root()) };
        _orchestratorResizeStartX = point.Position().X;
        _orchestratorResizeStartWidth = OrchestratorColumn().ActualWidth();
        _resizingOrchestratorPane = true;
        _SetVerticalTabResizeCursor(true);
        OrchestratorResizeGrip().Opacity(ResizeHandleDragOpacity);
        e.Handled(true);
    }

    void TerminalPage::_OrchestratorResizePointerMoved(const IInspectable&,
                                                       const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        if (!_resizingOrchestratorPane)
        {
            OrchestratorResizeGrip().Opacity(ResizeHandleHoverOpacity);
            return;
        }

        const auto point{ e.GetCurrentPoint(Root()) };
        _SetOrchestratorPaneWidth(_orchestratorResizeStartWidth + (_orchestratorResizeStartX - point.Position().X));
        e.Handled(true);
    }

    void TerminalPage::_StopOrchestratorResize(const IInspectable& sender,
                                               const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        if (const auto resizeHandle{ sender.try_as<WUX::UIElement>() })
        {
            resizeHandle.ReleasePointerCapture(e.Pointer());
        }

        if (_resizingOrchestratorPane)
        {
            _resizingOrchestratorPane = false;
            _SetVerticalTabResizeCursor(false);
            OrchestratorResizeGrip().Opacity(ResizeHandleRestOpacity);
            e.Handled(true);
        }
    }

    void TerminalPage::_OrchestratorResizePointerReleased(const IInspectable& sender,
                                                          const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        _StopOrchestratorResize(sender, e);
    }

    void TerminalPage::_OrchestratorResizePointerCanceled(const IInspectable& sender,
                                                          const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        _StopOrchestratorResize(sender, e);
    }

    void TerminalPage::_OrchestratorResizePointerCaptureLost(const IInspectable& sender,
                                                             const Windows::UI::Xaml::Input::PointerRoutedEventArgs& e)
    {
        _StopOrchestratorResize(sender, e);
    }

    // Method Description:
    // - Polls GET /api/orchestrator on a background thread and applies the
    //   result to the panel. Passes `since=<seq>` so a poll only carries the
    //   transcript items that changed; a full snapshot is requested after
    //   open, clear, and reconnect.
    safe_void_coroutine TerminalPage::_RefreshOrchestratorStatus()
    {
        if (_orchestratorFetchInFlight.exchange(true))
        {
            co_return;
        }

        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };
        const auto partial = !_orchestratorNeedsFullRefresh;
        const auto since = _orchestratorSeq;

        co_await winrt::resume_background();

        std::wstring path{ L"/api/orchestrator" };
        if (partial)
        {
            path += L"?since=" + std::to_wstring(since);
        }
        WDJ::JsonObject status{ nullptr };
        auto reachable = false;
        if (const auto response{ _projectServerRequest(L"GET", path) })
        {
            reachable = true;
            WDJ::JsonObject parsed{ nullptr };
            if (WDJ::JsonObject::TryParse(winrt::to_hstring(*response), parsed) && parsed.HasKey(L"state"))
            {
                status = parsed;
            }
        }

        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        page->_orchestratorFetchInFlight.store(false);

        if (status)
        {
            page->_ApplyOrchestratorStatus(status, partial);
        }
        else
        {
            // A pre-orchestrator host serves the SPA's index.html for unknown
            // /api paths: reachable but unparseable means an older build.
            page->_orchestratorNeedsFullRefresh = true;
            page->_orchestratorState = reachable ? L"unavailable" : L"offline";
            page->_UpdateOrchestratorChrome();
        }
    }

    // Method Description:
    // - Applies a status snapshot: state, model, active step, and the
    //   transcript items it carries (all of them, or only those changed since
    //   the last poll).
    void TerminalPage::_ApplyOrchestratorStatus(const WDJ::JsonObject& status, const bool partial)
    {
        const auto itemCount = static_cast<size_t>(status.GetNamedNumber(L"itemCount", 0));
        if (partial && itemCount < _orchestratorItems.size())
        {
            // The transcript shrank (cleared or trimmed elsewhere): reload it.
            _orchestratorNeedsFullRefresh = true;
            _RefreshOrchestratorStatus();
            return;
        }

        _orchestratorState = status.GetNamedString(L"state", L"idle");
        if (status.HasKey(L"config") && status.GetNamedValue(L"config").ValueType() == WDJ::JsonValueType::Object)
        {
            const auto config{ status.GetNamedObject(L"config") };
            _orchestratorModel = config.GetNamedString(L"model", L"");
            _orchestratorKeyEnv = config.GetNamedString(L"keyEnv", L"OPENROUTER_API_KEY");
        }
        _orchestratorStep = L"";
        if (status.HasKey(L"activeTurn") && status.GetNamedValue(L"activeTurn").ValueType() == WDJ::JsonValueType::Object)
        {
            _orchestratorStep = status.GetNamedObject(L"activeTurn").GetNamedString(L"step", L"");
        }

        if (!partial)
        {
            _ResetOrchestratorTranscript();
        }
        if (status.HasKey(L"transcript") && status.GetNamedValue(L"transcript").ValueType() == WDJ::JsonValueType::Array)
        {
            for (const auto& entry : status.GetNamedArray(L"transcript"))
            {
                if (entry.ValueType() == WDJ::JsonValueType::Object)
                {
                    _ApplyOrchestratorItem(entry.GetObject());
                }
            }
        }
        _orchestratorSeq = static_cast<uint64_t>(status.GetNamedNumber(L"seq", static_cast<double>(_orchestratorSeq)));
        _orchestratorNeedsFullRefresh = false;
        _UpdateOrchestratorChrome();
        if (_orchestratorStickToBottom)
        {
            _ScrollOrchestratorToBottom();
        }
    }

    // Method Description:
    // - Adds or refreshes one transcript row. Rows are keyed by item id and
    //   only rebuilt when the item's revision moved, so streaming text
    //   updates in place instead of re-rendering the whole conversation.
    void TerminalPage::_ApplyOrchestratorItem(const WDJ::JsonObject& item)
    {
        const std::wstring id{ item.GetNamedString(L"id", L"") };
        if (id.empty())
        {
            return;
        }
        const auto rev = static_cast<uint64_t>(item.GetNamedNumber(L"rev", 0));
        if (const auto found{ _orchestratorItems.find(id) }; found != _orchestratorItems.end())
        {
            if (found->second.Rev != rev)
            {
                found->second.Rev = rev;
                found->second.Container.Child(_BuildOrchestratorItemContent(item));
            }
            return;
        }
        Border container;
        container.Child(_BuildOrchestratorItemContent(item));
        OrchestratorTranscript().Children().Append(container);
        _orchestratorItems.emplace(id, OrchestratorItemView{ rev, container });
    }

    // Method Description:
    // - Renders one transcript item: the user's bubble, the assistant's
    //   markdown, a tool call card (expandable to its result), or an error.
    UIElement TerminalPage::_BuildOrchestratorItemContent(const WDJ::JsonObject& item)
    {
        const auto style = [this](const wchar_t* key) {
            return Resources().Lookup(winrt::box_value(key)).try_as<WUX::Style>();
        };
        const auto role{ item.GetNamedString(L"role", L"assistant") };
        const auto text{ item.GetNamedString(L"text", L"") };
        const auto status{ item.GetNamedString(L"status", L"done") };

        if (role == L"user")
        {
            Border bubble;
            bubble.Style(style(L"OrchestratorUserBubbleStyle"));
            TextBlock block;
            block.Style(style(L"OrchestratorBodyTextStyle"));
            block.Text(text);
            bubble.Child(block);
            return bubble;
        }

        if (role == L"error")
        {
            Border row;
            row.Style(style(L"OrchestratorErrorRowStyle"));
            TextBlock block;
            block.Style(style(L"OrchestratorBodyTextStyle"));
            block.Text(text);
            row.Child(block);
            return row;
        }

        if (role == L"tool")
        {
            WDJ::JsonObject tool{ nullptr };
            if (item.HasKey(L"tool") && item.GetNamedValue(L"tool").ValueType() == WDJ::JsonValueType::Object)
            {
                tool = item.GetNamedObject(L"tool");
            }
            const auto name{ tool ? tool.GetNamedString(L"name", L"") : winrt::hstring{} };
            const auto summary{ tool ? tool.GetNamedString(L"summary", name) : winrt::hstring{} };
            const auto result{ tool ? tool.GetNamedString(L"result", L"") : winrt::hstring{} };
            const auto ok = tool ? tool.GetNamedBoolean(L"ok", true) : true;

            Grid header;
            header.ColumnSpacing(8);
            ColumnDefinition iconColumn;
            iconColumn.Width(GridLength{ 0, GridUnitType::Auto });
            ColumnDefinition textColumn;
            textColumn.Width(GridLength{ 1, GridUnitType::Star });
            ColumnDefinition stateColumn;
            stateColumn.Width(GridLength{ 0, GridUnitType::Auto });
            header.ColumnDefinitions().Append(iconColumn);
            header.ColumnDefinitions().Append(textColumn);
            header.ColumnDefinitions().Append(stateColumn);

            FontIcon icon;
            icon.FontFamily(Media::FontFamily{ L"Segoe Fluent Icons, Segoe MDL2 Assets" });
            icon.FontSize(12);
            icon.Glyph(name == L"read_session"     ? L"\xE7B3" :
                       name == L"send_input"       ? L"\xE765" :
                       name == L"send_keys"        ? L"\xE765" :
                       name == L"answer_prompt"    ? L"\xE97A" :
                       name == L"wait_for_output"  ? L"\xE823" :
                       name == L"create_session"   ? L"\xE710" :
                       name == L"close_session"    ? L"\xE711" :
                       name == L"rename_session"   ? L"\xE70F" :
                       name == L"list_projects"    ? L"\xE8B7" :
                       name == L"notify_user"      ? L"\xEA8F" :
                                                     L"\xE8FD");
            icon.VerticalAlignment(VerticalAlignment::Center);
            Grid::SetColumn(icon, 0);
            header.Children().Append(icon);

            TextBlock summaryBlock;
            summaryBlock.Style(style(L"OrchestratorBodyTextStyle"));
            summaryBlock.FontSize(12);
            summaryBlock.TextWrapping(TextWrapping::NoWrap);
            summaryBlock.TextTrimming(TextTrimming::CharacterEllipsis);
            summaryBlock.VerticalAlignment(VerticalAlignment::Center);
            summaryBlock.Text(summary);
            Grid::SetColumn(summaryBlock, 1);
            header.Children().Append(summaryBlock);

            if (status == L"streaming")
            {
                winrt::Microsoft::UI::Xaml::Controls::ProgressRing ring;
                ring.IsActive(true);
                ring.Width(14);
                ring.Height(14);
                ring.VerticalAlignment(VerticalAlignment::Center);
                Grid::SetColumn(ring, 2);
                header.Children().Append(ring);
            }
            else
            {
                FontIcon state;
                state.FontFamily(Media::FontFamily{ L"Segoe Fluent Icons, Segoe MDL2 Assets" });
                state.FontSize(11);
                state.VerticalAlignment(VerticalAlignment::Center);
                const auto failed = status == L"error" || !ok;
                state.Glyph(failed ? L"\xE783" : status == L"cancelled" ? L"\xE711" : L"\xE73E");
                state.Foreground(SolidColorBrush{ failed ? ColorHelper::FromArgb(255, 232, 72, 85) : ColorHelper::FromArgb(255, 16, 185, 129) });
                Grid::SetColumn(state, 2);
                header.Children().Append(state);
            }

            Border row;
            row.Style(style(L"OrchestratorToolRowStyle"));
            if (result.empty())
            {
                row.Child(header);
                return row;
            }

            // The result is one click away rather than always on screen: a
            // read_session result is a whole screenful.
            winrt::Microsoft::UI::Xaml::Controls::Expander expander;
            expander.Header(header);
            expander.HorizontalAlignment(HorizontalAlignment::Stretch);
            expander.HorizontalContentAlignment(HorizontalAlignment::Stretch);
            TextBlock resultBlock;
            resultBlock.Style(style(L"OrchestratorCodeTextStyle"));
            std::wstring clipped{ result };
            if (clipped.size() > 6000)
            {
                clipped.resize(6000);
                clipped += L"\n…";
            }
            resultBlock.Text(clipped);
            ScrollViewer resultScroller;
            resultScroller.MaxHeight(260);
            resultScroller.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
            resultScroller.Content(resultBlock);
            expander.Content(resultScroller);
            row.Padding(ThicknessHelper::FromUniformLength(0));
            row.Child(expander);
            return row;
        }

        // Assistant.
        StackPanel panel;
        panel.Spacing(4);
        if (item.HasKey(L"reasoning") && item.GetNamedValue(L"reasoning").ValueType() == WDJ::JsonValueType::String)
        {
            const auto reasoning{ item.GetNamedString(L"reasoning") };
            if (!reasoning.empty())
            {
                winrt::Microsoft::UI::Xaml::Controls::Expander thinking;
                TextBlock headerBlock;
                headerBlock.Style(style(L"OrchestratorMetaTextStyle"));
                headerBlock.Text(L"Thinking");
                thinking.Header(headerBlock);
                thinking.HorizontalAlignment(HorizontalAlignment::Stretch);
                thinking.HorizontalContentAlignment(HorizontalAlignment::Stretch);
                TextBlock body;
                body.Style(style(L"OrchestratorMetaTextStyle"));
                body.FontStyle(winrt::Windows::UI::Text::FontStyle::Italic);
                body.IsTextSelectionEnabled(true);
                body.Text(reasoning);
                thinking.Content(body);
                panel.Children().Append(thinking);
            }
        }
        if (text.empty())
        {
            if (status == L"streaming")
            {
                TextBlock thinking;
                thinking.Style(style(L"OrchestratorMetaTextStyle"));
                thinking.Text(L"Thinking…");
                panel.Children().Append(thinking);
            }
        }
        else
        {
            auto rendered = false;
            try
            {
                const auto rich{ Microsoft::Terminal::UI::Markdown::Builder::Convert(text, L"about:blank") };
                rich.FontSize(13);
                rich.IsTextSelectionEnabled(true);
                rich.TextWrapping(TextWrapping::Wrap);
                panel.Children().Append(rich);
                rendered = true;
            }
            CATCH_LOG();
            if (!rendered)
            {
                TextBlock block;
                block.Style(style(L"OrchestratorBodyTextStyle"));
                block.Text(text);
                panel.Children().Append(block);
            }
        }
        if (status == L"cancelled")
        {
            TextBlock stopped;
            stopped.Style(style(L"OrchestratorMetaTextStyle"));
            stopped.Text(L"Stopped.");
            panel.Children().Append(stopped);
        }
        return panel;
    }

    void TerminalPage::_ResetOrchestratorTranscript()
    {
        _orchestratorItems.clear();
        OrchestratorTranscript().Children().Clear();
        _orchestratorSeq = 0;
        _orchestratorStickToBottom = true;
    }

    void TerminalPage::_ScrollOrchestratorToBottom()
    {
        try
        {
            const auto scroller{ OrchestratorTranscriptScroller() };
            scroller.UpdateLayout();
            scroller.ChangeView(nullptr, scroller.ScrollableHeight(), nullptr, true);
        }
        CATCH_LOG();
    }

    void TerminalPage::_ShowOrchestratorError(const winrt::hstring& message)
    {
        OrchestratorErrorText().Text(message);
        OrchestratorErrorBar().Visibility(message.empty() ? Visibility::Collapsed : Visibility::Visible);
    }

    // Method Description:
    // - Status line, dot, send/stop buttons, empty state and the fast poll
    //   timer, all derived from the last status snapshot.
    void TerminalPage::_UpdateOrchestratorChrome()
    {
        const auto running = _orchestratorState == L"running";
        const auto idle = _orchestratorState == L"idle";
        const auto unconfigured = _orchestratorState == L"unconfigured";
        const auto offline = _orchestratorState == L"offline";
        const auto unavailable = _orchestratorState == L"unavailable";

        std::wstring model{ _orchestratorModel };
        if (const auto slash = model.rfind(L'/'); slash != std::wstring::npos)
        {
            model = model.substr(slash + 1);
        }
        if (model.empty())
        {
            model = L"No model";
        }
        std::wstring step{ _orchestratorStep };
        std::replace(step.begin(), step.end(), L'_', L' ');
        if (step.empty() || step == L"thinking")
        {
            step = L"thinking";
        }

        OrchestratorStatusText().Text(offline      ? winrt::hstring{ L"Bridge server offline" } :
                                      unavailable  ? winrt::hstring{ L"Server outdated — rebuild the terminal" } :
                                      unconfigured ? winrt::hstring{ L"Needs an API key" } :
                                      running      ? winrt::hstring{ model + L" · " + step + L"…" } :
                                                     winrt::hstring{ model + L" · ready" });
        OrchestratorStatusDot().Fill(SolidColorBrush{ running ? ColorHelper::FromArgb(255, 251, 191, 36) :
                                                      idle    ? ColorHelper::FromArgb(255, 16, 185, 129) :
                                                                Colors::Gray() });

        OrchestratorSendButton().Visibility(running ? Visibility::Collapsed : Visibility::Visible);
        OrchestratorStopButton().Visibility(running ? Visibility::Visible : Visibility::Collapsed);
        OrchestratorSendButton().IsEnabled(idle || unconfigured);
        OrchestratorClearButton().IsEnabled(!_orchestratorItems.empty() && !offline && !unavailable);

        const auto showEmpty = _orchestratorItems.empty();
        OrchestratorEmptyState().Visibility(showEmpty ? Visibility::Visible : Visibility::Collapsed);
        OrchestratorTranscriptScroller().Visibility(showEmpty ? Visibility::Collapsed : Visibility::Visible);
        OrchestratorQuickPrompts().Visibility(idle ? Visibility::Visible : Visibility::Collapsed);
        OrchestratorHintText().Text(unconfigured ? winrt::hstring{ L"Set " + std::wstring{ _orchestratorKeyEnv } + L" in your environment, or paste a key under the gear icon, to start." } :
                                    offline      ? winrt::hstring{ L"Waiting for the bridge host…" } :
                                    unavailable  ? winrt::hstring{ L"This terminal build predates the built-in orchestrator." } :
                                                   winrt::hstring{});
        OrchestratorComposer().PlaceholderText(running ? L"Working… (you can stop it)" : L"Ask about your tabs, or tell it what to do");

        if (_orchestratorPollTimer)
        {
            if (running && _orchestratorPaneOpen)
            {
                _orchestratorPollTimer.Start();
            }
            else
            {
                _orchestratorPollTimer.Stop();
            }
        }
    }

    // Method Description:
    // - Appends the user's message and starts a turn. The host rejects a
    //   message while one is running or when no key is configured; that
    //   message is shown in the error bar and the draft is kept.
    safe_void_coroutine TerminalPage::_SendOrchestratorMessage(winrt::hstring text)
    {
        std::wstring trimmed{ text };
        trimmed.erase(0, trimmed.find_first_not_of(L" \t\r\n"));
        if (const auto end = trimmed.find_last_not_of(L" \t\r\n"); end != std::wstring::npos)
        {
            trimmed.resize(end + 1);
        }
        else
        {
            trimmed.clear();
        }
        if (trimmed.empty())
        {
            co_return;
        }

        const auto body = "{\"text\":" + winrt::to_string(WDJ::JsonValue::CreateStringValue(winrt::hstring{ trimmed }).Stringify()) + "}";
        OrchestratorComposer().Text(L"");
        _ShowOrchestratorError(L"");
        _orchestratorStickToBottom = true;
        _orchestratorState = L"running";
        _UpdateOrchestratorChrome();

        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();
        const auto response{ _projectServerRequestDetailed(L"POST", L"/api/orchestrator/messages", body) };
        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        if (!response || response->Status < 200 || response->Status >= 300)
        {
            page->_ShowOrchestratorError(winrt::hstring{ _projectServerErrorMessage(response) });
            page->OrchestratorComposer().Text(winrt::hstring{ trimmed });
            page->_orchestratorNeedsFullRefresh = true;
        }
        page->_RefreshOrchestratorStatus();
    }

    // Method Description:
    // - Sends a command (cancel, clear) to the host and reloads the panel.
    safe_void_coroutine TerminalPage::_PostOrchestratorCommand(std::wstring verb, std::wstring path, std::string body)
    {
        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();
        const auto response{ _projectServerRequestDetailed(verb.c_str(), path, body) };
        co_await wil::resume_foreground(dispatcher);

        if (const auto page{ weakThis.get() })
        {
            if (!response || response->Status < 200 || response->Status >= 300)
            {
                page->_ShowOrchestratorError(winrt::hstring{ _projectServerErrorMessage(response) });
            }
            page->_orchestratorNeedsFullRefresh = true;
            page->_RefreshOrchestratorStatus();
        }
    }

    // Method Description:
    // - Serializes the settings flyout into a config patch.
    std::string TerminalPage::_OrchestratorConfigBody(const bool includeKey)
    {
        WDJ::JsonObject body;
        winrt::hstring provider{ L"openrouter" };
        if (const auto selected{ OrchestratorProviderBox().SelectedItem().try_as<ComboBoxItem>() })
        {
            provider = winrt::unbox_value_or<winrt::hstring>(selected.Tag(), L"openrouter");
        }
        body.SetNamedValue(L"provider", WDJ::JsonValue::CreateStringValue(provider));
        if (provider == L"custom")
        {
            body.SetNamedValue(L"baseUrl", WDJ::JsonValue::CreateStringValue(OrchestratorBaseUrlBox().Text()));
        }
        if (!OrchestratorModelBox().Text().empty())
        {
            body.SetNamedValue(L"model", WDJ::JsonValue::CreateStringValue(OrchestratorModelBox().Text()));
        }
        body.SetNamedValue(L"keyEnv", WDJ::JsonValue::CreateStringValue(OrchestratorKeyEnvBox().Text()));
        if (const auto selected{ OrchestratorReasoningBox().SelectedItem().try_as<ComboBoxItem>() })
        {
            body.SetNamedValue(L"reasoning", WDJ::JsonValue::CreateStringValue(winrt::unbox_value_or<winrt::hstring>(selected.Tag(), L"low")));
        }
        if (includeKey && !OrchestratorKeyBox().Password().empty())
        {
            body.SetNamedValue(L"apiKey", WDJ::JsonValue::CreateStringValue(OrchestratorKeyBox().Password()));
        }
        return winrt::to_string(body.Stringify());
    }

    safe_void_coroutine TerminalPage::_SaveOrchestratorConfig(std::string body)
    {
        OrchestratorSettingsMessage().Text(L"Saving…");
        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();
        const auto response{ _projectServerRequestDetailed(L"PUT", L"/api/orchestrator/config", body) };
        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        if (!response || response->Status < 200 || response->Status >= 300)
        {
            page->OrchestratorSettingsMessage().Text(winrt::hstring{ _projectServerErrorMessage(response) });
            co_return;
        }
        page->OrchestratorKeyBox().Password(L"");
        page->OrchestratorSettingsMessage().Text(L"Saved.");
        page->_PopulateOrchestratorSettings();
        page->_orchestratorNeedsFullRefresh = true;
        page->_RefreshOrchestratorStatus();
    }

    safe_void_coroutine TerminalPage::_TestOrchestratorConnection()
    {
        OrchestratorSettingsMessage().Text(L"Testing…");
        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();
        const auto response{ _projectServerRequestDetailed(L"POST", L"/api/orchestrator/test", "{}") };
        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        winrt::hstring message{ _projectServerErrorMessage(response) };
        if (response && response->Status >= 200 && response->Status < 300)
        {
            WDJ::JsonObject obj{ nullptr };
            if (WDJ::JsonObject::TryParse(winrt::to_hstring(response->Body), obj))
            {
                message = obj.GetNamedString(L"message", L"");
            }
        }
        page->OrchestratorSettingsMessage().Text(message);
    }

    // Method Description:
    // - Fills the settings flyout from GET /api/orchestrator/config, then
    //   loads the model catalog for the picker.
    safe_void_coroutine TerminalPage::_PopulateOrchestratorSettings()
    {
        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();
        WDJ::JsonObject config{ nullptr };
        if (const auto response{ _projectServerRequest(L"GET", L"/api/orchestrator/config") })
        {
            WDJ::JsonObject parsed{ nullptr };
            if (WDJ::JsonObject::TryParse(winrt::to_hstring(*response), parsed))
            {
                config = parsed;
            }
        }
        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        if (!config)
        {
            page->OrchestratorSettingsMessage().Text(L"The bridge host is not reachable.");
            co_return;
        }

        const auto provider{ config.GetNamedString(L"provider", L"openrouter") };
        for (const auto& candidate : page->OrchestratorProviderBox().Items())
        {
            if (const auto item{ candidate.try_as<ComboBoxItem>() }; item && winrt::unbox_value_or<winrt::hstring>(item.Tag(), L"") == provider)
            {
                page->OrchestratorProviderBox().SelectedItem(item);
            }
        }
        page->OrchestratorBaseUrlBox().Text(config.GetNamedString(L"baseUrl", L""));
        page->OrchestratorBaseUrlBox().Visibility(provider == L"custom" ? Visibility::Visible : Visibility::Collapsed);
        page->OrchestratorModelBox().Text(config.GetNamedString(L"model", L""));
        page->OrchestratorKeyEnvBox().Text(config.GetNamedString(L"keyEnv", L"OPENROUTER_API_KEY"));
        const auto reasoning{ config.GetNamedString(L"reasoning", L"low") };
        for (const auto& candidate : page->OrchestratorReasoningBox().Items())
        {
            if (const auto item{ candidate.try_as<ComboBoxItem>() }; item && winrt::unbox_value_or<winrt::hstring>(item.Tag(), L"") == reasoning)
            {
                page->OrchestratorReasoningBox().SelectedItem(item);
            }
        }

        const auto keySource{ config.GetNamedString(L"keySource", L"none") };
        winrt::hstring keyPreview;
        if (config.HasKey(L"keyPreview") && config.GetNamedValue(L"keyPreview").ValueType() == WDJ::JsonValueType::String)
        {
            keyPreview = config.GetNamedString(L"keyPreview");
        }
        const auto keyEnv{ config.GetNamedString(L"keyEnv", L"OPENROUTER_API_KEY") };
        page->OrchestratorKeyStatusText().Text(keySource == L"manual" ? winrt::hstring{ L"Using a key pasted here (" + std::wstring{ keyPreview } + L")." } :
                                               keySource == L"env"    ? winrt::hstring{ L"Using " + std::wstring{ keyEnv } + L" from the environment (" + std::wstring{ keyPreview } + L")." } :
                                                                        winrt::hstring{ L"No key found. Set " + std::wstring{ keyEnv } + L" in your environment or paste one below." });
        page->OrchestratorForgetKeyButton().Visibility(keySource == L"manual" ? Visibility::Visible : Visibility::Collapsed);
        page->_LoadOrchestratorModels(false);
    }

    // Method Description:
    // - Loads the model catalog (OpenRouter's, or whatever a custom endpoint
    //   lists) and shows the coding shortlist in the picker.
    safe_void_coroutine TerminalPage::_LoadOrchestratorModels(const bool refresh)
    {
        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();
        std::vector<OrchestratorModelEntry> recommended;
        std::vector<OrchestratorModelEntry> all;
        winrt::hstring error;
        const auto parseEntries = [](const WDJ::JsonObject& catalog, const wchar_t* key, std::vector<OrchestratorModelEntry>& into) {
            if (!catalog.HasKey(key) || catalog.GetNamedValue(key).ValueType() != WDJ::JsonValueType::Array)
            {
                return;
            }
            for (const auto& entry : catalog.GetNamedArray(key))
            {
                if (entry.ValueType() != WDJ::JsonValueType::Object)
                {
                    continue;
                }
                const auto model{ entry.GetObject() };
                const auto id{ model.GetNamedString(L"id", L"") };
                if (id.empty())
                {
                    continue;
                }
                std::wstring name{ model.GetNamedString(L"name", id) };
                if (const auto colon = name.find(L": "); colon != std::wstring::npos)
                {
                    name.erase(0, colon + 2);
                }
                std::wstring meta;
                const auto context = model.GetNamedNumber(L"contextLength", 0);
                if (context >= 1'000'000)
                {
                    meta += std::to_wstring(static_cast<int>(context / 1'000'000)) + L"M ctx";
                }
                else if (context > 0)
                {
                    meta += std::to_wstring(static_cast<int>(context / 1000)) + L"k ctx";
                }
                const auto promptPrice = model.GetNamedNumber(L"promptPrice", 0);
                const auto completionPrice = model.GetNamedNumber(L"completionPrice", 0);
                if (promptPrice > 0 || completionPrice > 0)
                {
                    wchar_t price[64]{};
                    swprintf_s(price, L"$%.2f / $%.2f per 1M", promptPrice, completionPrice);
                    meta += (meta.empty() ? L"" : L" · ") + std::wstring{ price };
                }
                into.push_back(OrchestratorModelEntry{ id, winrt::hstring{ name }, winrt::hstring{ meta } });
            }
        };
        if (const auto response{ _projectServerRequest(L"GET", refresh ? L"/api/orchestrator/models?refresh=1" : L"/api/orchestrator/models") })
        {
            WDJ::JsonObject catalog{ nullptr };
            if (WDJ::JsonObject::TryParse(winrt::to_hstring(*response), catalog))
            {
                parseEntries(catalog, L"recommended", recommended);
                parseEntries(catalog, L"models", all);
                if (catalog.HasKey(L"error") && catalog.GetNamedValue(L"error").ValueType() == WDJ::JsonValueType::String)
                {
                    error = catalog.GetNamedString(L"error");
                }
            }
        }
        else
        {
            error = L"The model list could not be loaded.";
        }
        co_await wil::resume_foreground(dispatcher);

        const auto page{ weakThis.get() };
        if (!page)
        {
            co_return;
        }
        page->_orchestratorRecommendedModels = std::move(recommended);
        page->_orchestratorAllModels = std::move(all);
        if (!error.empty())
        {
            page->OrchestratorSettingsMessage().Text(error);
        }
        page->_FilterOrchestratorModels();
    }

    void TerminalPage::_FillOrchestratorModelList(const std::vector<OrchestratorModelEntry>& entries)
    {
        const auto list{ OrchestratorModelList() };
        list.Items().Clear();
        const auto current{ OrchestratorModelBox().Text() };
        for (const auto& entry : entries)
        {
            StackPanel content;
            TextBlock name;
            name.Text(entry.Name);
            name.FontSize(13);
            name.TextTrimming(TextTrimming::CharacterEllipsis);
            content.Children().Append(name);
            TextBlock meta;
            meta.Style(Resources().Lookup(winrt::box_value(L"OrchestratorMetaTextStyle")).try_as<WUX::Style>());
            meta.Text(entry.Meta.empty() ? entry.Id : entry.Id + L" · " + entry.Meta);
            meta.TextTrimming(TextTrimming::CharacterEllipsis);
            meta.TextWrapping(TextWrapping::NoWrap);
            content.Children().Append(meta);
            ListViewItem item;
            item.Content(content);
            item.Tag(winrt::box_value(entry.Id));
            list.Items().Append(item);
            if (entry.Id == current)
            {
                list.SelectedItem(item);
            }
        }
    }

    // Method Description:
    // - The picker shows the coding shortlist until the search box has text,
    //   then the matching entries of the full catalog.
    void TerminalPage::_FilterOrchestratorModels()
    {
        std::wstring query{ OrchestratorModelSearchBox().Text() };
        std::transform(query.begin(), query.end(), query.begin(), ::towlower);
        query.erase(0, query.find_first_not_of(L" \t"));
        if (query.empty())
        {
            _FillOrchestratorModelList(_orchestratorRecommendedModels);
            return;
        }
        std::vector<OrchestratorModelEntry> matches;
        for (const auto& entry : _orchestratorAllModels)
        {
            std::wstring haystack{ entry.Id + L" " + entry.Name };
            std::transform(haystack.begin(), haystack.end(), haystack.begin(), ::towlower);
            if (haystack.find(query) != std::wstring::npos)
            {
                matches.push_back(entry);
                if (matches.size() >= 40)
                {
                    break;
                }
            }
        }
        _FillOrchestratorModelList(matches);
    }

    // Method Description:
    // - Enter sends; Shift+Enter inserts a newline (the box accepts returns).
    void TerminalPage::_OrchestratorComposerKeyDown(const IInspectable&, const Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        if (e.Key() != VirtualKey::Enter)
        {
            return;
        }
        if (::GetKeyState(VK_SHIFT) & 0x8000)
        {
            return;
        }
        e.Handled(true);
        _SendOrchestratorMessage(OrchestratorComposer().Text());
    }

    // Method Description:
    // - Opens the "New Project" TeachingTip. This is deliberately NOT a
    //   ContentDialog: in Xaml Islands a text box inside a ContentDialog
    //   won't receive any keypresses (see the WindowRenamer for the same
    //   workaround, including the two-LayoutUpdated focus dance).
    void TerminalPage::_ShowNewProjectTip()
    {
        const auto tip{ FindName(L"NewProjectTip").try_as<MUX::Controls::TeachingTip>() };
        if (!tip)
        {
            return;
        }

        NewProjectNameBox().Text(L"");
        NewProjectDirBox().Text(L"");
        NewProjectDirBox().ItemsSource(nullptr);

        // Refresh the recent-directory suggestions shown while the box is empty.
        _FetchRecentProjectDirs();

        _newProjectLayoutUpdatedRevoker.revoke();
        _newProjectLayoutCount = 0;
        _newProjectLayoutUpdatedRevoker = NewProjectNameBox().LayoutUpdated(winrt::auto_revoke, [weakThis = get_weak()](auto&&, auto&&) {
            if (auto self{ weakThis.get() })
            {
                auto& count{ self->_newProjectLayoutCount };
                if (count < 2)
                {
                    count++;
                }
                if (count >= 2)
                {
                    self->_newProjectLayoutUpdatedRevoker.revoke();
                    self->NewProjectNameBox().Focus(FocusState::Programmatic);
                }
            }
        });

        _newProjectPressedEnter = false;
        tip.IsOpen(true);
    }

    void TerminalPage::_NewProjectActionClick(const IInspectable& /*sender*/,
                                              const IInspectable& /*eventArgs*/)
    {
        _CreateProjectFromTip();
    }

    void TerminalPage::_NewProjectKeyDown(const IInspectable& /*sender*/,
                                          const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        if (e.OriginalKey() == Windows::System::VirtualKey::Enter)
        {
            _newProjectPressedEnter = true;
        }
    }

    void TerminalPage::_NewProjectKeyUp(const IInspectable& /*sender*/,
                                        const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        const auto key = e.OriginalKey();
        if (key == Windows::System::VirtualKey::Enter && _newProjectPressedEnter)
        {
            _CreateProjectFromTip();
        }
        else if (key == Windows::System::VirtualKey::Escape)
        {
            if (const auto tip{ FindName(L"NewProjectTip").try_as<MUX::Controls::TeachingTip>() })
            {
                tip.IsOpen(false);
            }
            _newProjectPressedEnter = false;
        }
    }

    // Method Description:
    // - Supplies suggestions for the starting-directory box: recently used
    //   project directories while the box is (nearly) empty, and filesystem
    //   directory completion once a path is being typed.
    void TerminalPage::_NewProjectDirTextChanged(const AutoSuggestBox& sender,
                                                 const AutoSuggestBoxTextChangedEventArgs& args)
    {
        if (args.Reason() != AutoSuggestionBoxTextChangeReason::UserInput)
        {
            return;
        }

        const std::wstring text{ sender.Text() };
        std::vector<winrt::hstring> suggestions;

        if (text.size() < 2)
        {
            suggestions = _recentProjectDirs;
        }
        else
        {
            try
            {
                const std::filesystem::path typed{ text };
                std::filesystem::path parent;
                std::wstring prefix;
                if (text.back() == L'\\' || text.back() == L'/')
                {
                    parent = typed;
                }
                else
                {
                    parent = typed.parent_path();
                    prefix = typed.filename().wstring();
                }

                std::transform(prefix.begin(), prefix.end(), prefix.begin(), ::towlower);

                std::error_code ec;
                for (const auto& entry : std::filesystem::directory_iterator{ parent, ec })
                {
                    if (!entry.is_directory(ec))
                    {
                        continue;
                    }

                    auto name = entry.path().filename().wstring();
                    std::transform(name.begin(), name.end(), name.begin(), ::towlower);
                    if (name.compare(0, prefix.size(), prefix) != 0)
                    {
                        continue;
                    }

                    suggestions.emplace_back(entry.path().wstring());
                    if (suggestions.size() >= 12)
                    {
                        break;
                    }
                }
            }
            catch (...)
            {
                // Bad path fragments just produce no suggestions.
            }
        }

        const auto items{ winrt::single_threaded_vector<IInspectable>() };
        for (const auto& suggestion : suggestions)
        {
            items.Append(winrt::box_value(suggestion));
        }
        sender.ItemsSource(items);
    }

    void TerminalPage::_NewProjectDirSuggestionChosen(const AutoSuggestBox& sender,
                                                      const AutoSuggestBoxSuggestionChosenEventArgs& args)
    {
        sender.Text(winrt::unbox_value_or<winrt::hstring>(args.SelectedItem(), L""));
    }

    // Method Description:
    // - Pulls the recently closed project directories from the terminal-web
    //   store, for the starting-directory suggestions.
    safe_void_coroutine TerminalPage::_FetchRecentProjectDirs()
    {
        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();

        std::vector<winrt::hstring> recents;
        if (const auto response{ _projectServerRequest(L"GET", L"/api/projects/recent") })
        {
            WDJ::JsonArray array{ nullptr };
            if (WDJ::JsonArray::TryParse(winrt::to_hstring(*response), array))
            {
                for (const auto& item : array)
                {
                    if (item.ValueType() != WDJ::JsonValueType::Object)
                    {
                        continue;
                    }
                    const auto cwd{ item.GetObject().GetNamedString(L"cwd", L"") };
                    if (!cwd.empty())
                    {
                        recents.push_back(cwd);
                    }
                }
            }
        }

        co_await wil::resume_foreground(dispatcher);

        if (const auto page{ weakThis.get() })
        {
            page->_recentProjectDirs = std::move(recents);
        }
    }

    // Method Description:
    // - Finishes a chip drag: reads the strip's real order back off the panel
    //   (each chip carries its section key in Tag, so nothing has to assume
    //   child indices line up with another list), works out where the drop
    //   landed, and records the result as the section order.
    // - That order is the rail's too - the rail ranks its headings by it and
    //   the strip is rebuilt from the rail - so one drag moves both. The
    //   bridge is told about it as far as it can be: the projects it has
    //   saved, in the new relative order. Sections with no saved project keep
    //   their position for this window only, which is the honest limit of a
    //   store that keys order by project id.
    safe_void_coroutine TerminalPage::_SectionDropReorder(winrt::hstring draggedKey, float dropX)
    {
        co_await wil::resume_foreground(Dispatcher());

        if (draggedKey.empty())
        {
            co_return;
        }

        const auto panel{ ProjectTabPanel() };
        if (!panel)
        {
            co_return;
        }

        // Where the dragged chip goes: after every chip whose midpoint the
        // drop passed. Counting rather than index arithmetic means removing
        // the dragged chip first needs no correction afterwards.
        std::vector<winrt::hstring> keys;
        size_t target{ 0 };
        auto found{ false };
        for (const auto& child : panel.Children())
        {
            const auto element{ child.try_as<WUX::FrameworkElement>() };
            if (!element)
            {
                continue;
            }
            const auto key{ winrt::unbox_value_or<winrt::hstring>(element.Tag(), winrt::hstring{}) };
            if (key.empty())
            {
                continue; // "All", the hairlines and the strip's own actions.
            }
            if (key == draggedKey)
            {
                found = true;
                continue;
            }
            const auto origin{ element.TransformToVisual(panel).TransformPoint({ 0, 0 }) };
            if (dropX >= origin.X + element.ActualWidth() / 2.0)
            {
                ++target;
            }
            keys.push_back(key);
        }
        if (!found)
        {
            co_return;
        }
        keys.insert(keys.begin() + std::min(target, keys.size()), draggedKey);

        // Section keys back to the directories the rail ranks by.
        const auto sections{ _railSectionsOf(_tabRow) };
        std::vector<std::wstring> order;
        order.reserve(keys.size());
        for (const auto& key : keys)
        {
            for (const auto& section : sections)
            {
                if (section.Key == key && !section.Directory.empty())
                {
                    order.push_back(implementation::TabRowControl::NormalizeDirectory(section.Directory));
                    break;
                }
            }
        }

        _sectionOrder = order;
        _ApplyProjectNames();
        _RebuildProjectTabs();

        // Persist as much of it as the store can hold: its saved projects, in
        // the new relative order.
        WDJ::JsonArray ids;
        std::stable_sort(_bridgeProjects.begin(), _bridgeProjects.end(), [&](const auto& left, const auto& right) {
            const auto rank = [&](const BridgeProject& project) {
                const auto key{ implementation::TabRowControl::NormalizeDirectory(project.Cwd) };
                const auto position{ std::find(order.begin(), order.end(), key) };
                return position == order.end() ? order.size() : static_cast<size_t>(position - order.begin());
            };
            return rank(left) < rank(right);
        });
        for (const auto& project : _bridgeProjects)
        {
            ids.Append(WDJ::JsonValue::CreateStringValue(project.Id));
        }
        WDJ::JsonObject body;
        body.SetNamedValue(L"ids", ids);
        const auto bodyStr{ winrt::to_string(body.Stringify()) };

        co_await winrt::resume_background();
        std::ignore = _projectServerRequest(L"PATCH", L"/api/projects/order", bodyStr);
    }

    // Method Description:
    // - Reads the New Project TeachingTip's fields and creates the project in
    //   the terminal-web store.
    safe_void_coroutine TerminalPage::_CreateProjectFromTip()
    {
        _newProjectPressedEnter = false;

        const winrt::hstring name{ NewProjectNameBox().Text() };
        const winrt::hstring cwd{ NewProjectDirBox().Text() };
        if (name.empty() || cwd.empty())
        {
            co_return;
        }

        if (const auto tip{ FindName(L"NewProjectTip").try_as<MUX::Controls::TeachingTip>() })
        {
            tip.IsOpen(false);
        }

        WDJ::JsonObject bodyJson;
        bodyJson.SetNamedValue(L"name", WDJ::JsonValue::CreateStringValue(name));
        bodyJson.SetNamedValue(L"cwd", WDJ::JsonValue::CreateStringValue(cwd));
        const auto body{ winrt::to_string(bodyJson.Stringify()) };

        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();

        winrt::hstring createdId;
        winrt::hstring createdCwd;
        if (const auto response{ _projectServerRequest(L"POST", L"/api/projects", body) })
        {
            WDJ::JsonObject created{ nullptr };
            if (WDJ::JsonObject::TryParse(winrt::to_hstring(*response), created))
            {
                createdId = created.GetNamedString(L"id", L"");
                createdCwd = created.GetNamedString(L"cwd", L"");
            }
        }

        co_await wil::resume_foreground(dispatcher);

        if (const auto page{ weakThis.get() })
        {
            if (!createdId.empty())
            {
                const auto directory{ createdCwd.empty() ? cwd : createdCwd };
                page->_bridgeProjects.push_back(BridgeProject{ createdId, name, directory });
                // No terminal is open there yet, so the rail has no heading
                // for it: hand _SelectSection the directory so it can open
                // one, and the section (and its chip) appears with the tab.
                page->_SelectSection(implementation::TabRowControl::SectionKeyForDirectory(directory), directory);
            }
            page->_RefreshBridgeProjects();
        }
    }

    // Method Description:
    // - Confirms and closes a rail section: closes this window's tabs under
    //   it - subsections included, because that is what the heading holds -
    //   and, when a saved terminal-web project sits behind the same
    //   directory, deletes that too so its remote sessions stop.
    // - A section with no saved project behind it (the common case with the
    //   bridge offline) closes its tabs and touches nothing on the server.
    //   Nothing is lost by that: a section *is* its open terminals, so once
    //   they are closed the heading and its chip are gone by definition.
    safe_void_coroutine TerminalPage::_CloseSectionRequested(winrt::hstring sectionKey, winrt::hstring sectionName, winrt::hstring directory)
    {
        const auto presenter{ _dialogPresenter.get() };
        if (!presenter || sectionKey.empty())
        {
            co_return;
        }

        std::vector<winrt::TerminalApp::Tab> sectionTabs;
        for (const auto& tab : _tabs)
        {
            if (implementation::TabRowControl::SectionContainsTab(sectionKey, tab))
            {
                sectionTabs.push_back(tab);
            }
        }

        winrt::hstring projectId;
        if (!directory.empty())
        {
            const auto directoryKey{ _projectDirectoryKey(directory) };
            for (const auto& project : _bridgeProjects)
            {
                if (_projectDirectoryKey(project.Cwd) == directoryKey)
                {
                    projectId = project.Id;
                    break;
                }
            }
        }

        ContentDialog dialog;
        dialog.Title(winrt::box_value(L"Close Project"));
        const auto tail = projectId.empty() ?
                              winrt::hstring{ L" terminal tab(s) here." } :
                              winrt::hstring{ L" terminal tab(s) here and stops any remote sessions started in it." };
        const auto message = L"Close project \"" + sectionName + L"\"? This closes " + winrt::to_hstring(sectionTabs.size()) + tail;
        dialog.Content(winrt::box_value(message));
        dialog.PrimaryButtonText(L"Close Project");
        dialog.CloseButtonText(L"Cancel");
        dialog.DefaultButton(ContentDialogButton::Close);

        const auto result{ co_await presenter.ShowDialog(dialog) };
        if (result != ContentDialogResult::Primary)
        {
            co_return;
        }

        if (_activeSectionKey == sectionKey)
        {
            _SelectSection({});
        }

        // The section-level dialog already confirmed; don't re-prompt per tab.
        // Closing them is what retires the heading, and _OnRailSectionsChanged
        // is what takes the chip away with it.
        for (const auto& tab : sectionTabs)
        {
            std::ignore = _HandleCloseTabRequested(tab, true);
        }

        if (projectId.empty())
        {
            co_return;
        }

        // Drop the saved project locally right away so the strip feels
        // responsive, then delete it on the server and re-sync.
        std::erase_if(_bridgeProjects, [&](const auto& project) { return project.Id == projectId; });
        _sectionNameOverrides.erase(implementation::TabRowControl::NormalizeDirectory(directory));
        _ApplyProjectNames();
        _RebuildProjectTabs();

        const auto weakThis{ get_weak() };
        const auto dispatcher{ Dispatcher() };

        co_await winrt::resume_background();

        std::ignore = _projectServerRequest(L"DELETE", L"/api/projects/" + std::wstring{ projectId });

        co_await wil::resume_foreground(dispatcher);

        if (const auto page{ weakThis.get() })
        {
            page->_RefreshBridgeProjects();
        }
    }

    // Method Description:
    // - Called when the about button is clicked. See _ShowAboutDialog for more info.
    // Arguments:
    // - <unused>
    // Return Value:
    // - <none>
    void TerminalPage::_AboutButtonOnClick(const IInspectable&,
                                           const RoutedEventArgs&)
    {
        _ShowAboutDialog();

        TraceLoggingWrite(
            g_hTerminalAppProvider,
            "NewTabMenuItemClicked",
            TraceLoggingDescription("Event emitted when an item from the new tab menu is invoked"),
            TraceLoggingValue(NumberOfTabs(), "TabCount", "The count of tabs currently opened in this window"),
            TraceLoggingValue("About", "ItemType", "The type of item that was clicked in the new tab menu"),
            TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
            TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));
    }

    // Method Description:
    // - Called when the users pressed keyBindings while CommandPaletteElement is open.
    // - As of GH#8480, this is also bound to the TabRowControl's KeyUp event.
    //   That should only fire when focus is in the tab row, which is hard to
    //   do. Notably, that's possible:
    //   - When you have enough tabs to make the little scroll arrows appear,
    //     click one, then hit tab
    //   - When Narrator is in Scan mode (which is the a11y bug we're fixing here)
    // - This method is effectively an extract of TermControl::_KeyHandler and TermControl::_TryHandleKeyBinding.
    // Arguments:
    // - e: the KeyRoutedEventArgs containing info about the keystroke.
    // Return Value:
    // - <none>
    void TerminalPage::_KeyDownHandler(const Windows::Foundation::IInspectable& /*sender*/, const Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        const auto keyStatus = e.KeyStatus();
        const auto vkey = gsl::narrow_cast<WORD>(e.OriginalKey());
        const auto scanCode = gsl::narrow_cast<WORD>(keyStatus.ScanCode);
        const auto modifiers = _GetPressedModifierKeys();

        // GH#11076:
        // For some weird reason we sometimes receive a WM_KEYDOWN
        // message without vkey or scanCode if a user drags a tab.
        // The KeyChord constructor has a debug assertion ensuring that all KeyChord
        // either have a valid vkey/scanCode. This is important, because this prevents
        // accidental insertion of invalid KeyChords into classes like ActionMap.
        if (!vkey && !scanCode)
        {
            return;
        }

        // Alt-Numpad# input will send us a character once the user releases
        // Alt, so we should be ignoring the individual keydowns. The character
        // will be sent through the TSFInputControl. See GH#1401 for more
        // details
        if (modifiers.IsAltPressed() && (vkey >= VK_NUMPAD0 && vkey <= VK_NUMPAD9))
        {
            return;
        }

        // GH#2235: Terminal::Settings hasn't been modified to differentiate
        // between AltGr and Ctrl+Alt yet.
        // -> Don't check for key bindings if this is an AltGr key combination.
        if (modifiers.IsAltGrPressed())
        {
            return;
        }

        const auto actionMap = _settings.ActionMap();
        if (!actionMap)
        {
            return;
        }

        const auto cmd = actionMap.GetActionByKeyChord({
            modifiers.IsCtrlPressed(),
            modifiers.IsAltPressed(),
            modifiers.IsShiftPressed(),
            modifiers.IsWinPressed(),
            vkey,
            scanCode,
        });
        if (!cmd)
        {
            return;
        }

        if (!_actionDispatch->DoAction(cmd.ActionAndArgs()))
        {
            return;
        }

        if (_commandPaletteIs(Visibility::Visible) &&
            cmd.ActionAndArgs().Action() != ShortcutAction::ToggleCommandPalette)
        {
            CommandPaletteElement().Visibility(Visibility::Collapsed);
        }
        if (_suggestionsControlIs(Visibility::Visible) &&
            cmd.ActionAndArgs().Action() != ShortcutAction::ToggleCommandPalette)
        {
            SuggestionsElement().Visibility(Visibility::Collapsed);
        }

        // Let's assume the user has bound the dead key "^" to a sendInput command that sends "b".
        // If the user presses the two keys "^a" it'll produce "bâ", despite us marking the key event as handled.
        // The following is used to manually "consume" such dead keys and clear them from the keyboard state.
        _ClearKeyboardState(vkey, scanCode);
        e.Handled(true);
    }

    bool TerminalPage::OnDirectKeyEvent(const uint32_t vkey, const uint8_t scanCode, const bool down)
    {
        const auto modifiers = _GetPressedModifierKeys();
        if (vkey == VK_SPACE && modifiers.IsAltPressed() && down)
        {
            if (const auto actionMap = _settings.ActionMap())
            {
                if (const auto cmd = actionMap.GetActionByKeyChord({
                        modifiers.IsCtrlPressed(),
                        modifiers.IsAltPressed(),
                        modifiers.IsShiftPressed(),
                        modifiers.IsWinPressed(),
                        gsl::narrow_cast<int32_t>(vkey),
                        scanCode,
                    }))
                {
                    return _actionDispatch->DoAction(cmd.ActionAndArgs());
                }
            }
        }
        return false;
    }

    // Method Description:
    // - Get the modifier keys that are currently pressed. This can be used to
    //   find out which modifiers (ctrl, alt, shift) are pressed in events that
    //   don't necessarily include that state.
    // - This is a copy of TermControl::_GetPressedModifierKeys.
    // Return Value:
    // - The Microsoft::Terminal::Core::ControlKeyStates representing the modifier key states.
    ControlKeyStates TerminalPage::_GetPressedModifierKeys() noexcept
    {
        const auto window = CoreWindow::GetForCurrentThread();
        // DONT USE
        //      != CoreVirtualKeyStates::None
        // OR
        //      == CoreVirtualKeyStates::Down
        // Sometimes with the key down, the state is Down | Locked.
        // Sometimes with the key up, the state is Locked.
        // IsFlagSet(Down) is the only correct solution.

        struct KeyModifier
        {
            VirtualKey vkey;
            ControlKeyStates flags;
        };

        constexpr std::array<KeyModifier, 7> modifiers{ {
            { VirtualKey::RightMenu, ControlKeyStates::RightAltPressed },
            { VirtualKey::LeftMenu, ControlKeyStates::LeftAltPressed },
            { VirtualKey::RightControl, ControlKeyStates::RightCtrlPressed },
            { VirtualKey::LeftControl, ControlKeyStates::LeftCtrlPressed },
            { VirtualKey::Shift, ControlKeyStates::ShiftPressed },
            { VirtualKey::RightWindows, ControlKeyStates::RightWinPressed },
            { VirtualKey::LeftWindows, ControlKeyStates::LeftWinPressed },
        } };

        ControlKeyStates flags;

        for (const auto& mod : modifiers)
        {
            const auto state = window.GetKeyState(mod.vkey);
            const auto isDown = WI_IsFlagSet(state, CoreVirtualKeyStates::Down);

            if (isDown)
            {
                flags |= mod.flags;
            }
        }

        return flags;
    }

    // Method Description:
    // - Discards currently pressed dead keys.
    // - This is a copy of TermControl::_ClearKeyboardState.
    // Arguments:
    // - vkey: The vkey of the key pressed.
    // - scanCode: The scan code of the key pressed.
    void TerminalPage::_ClearKeyboardState(const WORD vkey, const WORD scanCode) noexcept
    {
        std::array<BYTE, 256> keyState;
        if (!GetKeyboardState(keyState.data()))
        {
            return;
        }

        // As described in "Sometimes you *want* to interfere with the keyboard's state buffer":
        //   http://archives.miloush.net/michkap/archive/2006/09/10/748775.html
        // > "The key here is to keep trying to pass stuff to ToUnicode until -1 is not returned."
        std::array<wchar_t, 16> buffer;
        while (ToUnicodeEx(vkey, scanCode, keyState.data(), buffer.data(), gsl::narrow_cast<int>(buffer.size()), 0b1, nullptr) < 0)
        {
        }
    }

    // Method Description:
    // - Configure the AppKeyBindings to use our ShortcutActionDispatch and the updated ActionMap
    //    as the object to handle dispatching ShortcutAction events.
    // Arguments:
    // - bindings: An IActionMapView object to wire up with our event handlers
    void TerminalPage::_HookupKeyBindings(const IActionMapView& actionMap) noexcept
    {
        _bindings->SetDispatch(*_actionDispatch);
        _bindings->SetActionMap(actionMap);
    }

    // Method Description:
    // - Register our event handlers with our ShortcutActionDispatch. The
    //   ShortcutActionDispatch is responsible for raising the appropriate
    //   events for an ActionAndArgs. WE'll handle each possible event in our
    //   own way.
    // Arguments:
    // - <none>
    void TerminalPage::_RegisterActionCallbacks()
    {
        // Hook up the ShortcutActionDispatch object's events to our handlers.
        // They should all be hooked up here, regardless of whether or not
        // there's an actual keychord for them.
#define ON_ALL_ACTIONS(action) HOOKUP_ACTION(action);
        ALL_SHORTCUT_ACTIONS
        INTERNAL_SHORTCUT_ACTIONS
#undef ON_ALL_ACTIONS
    }

    // Method Description:
    // - Get the title of the currently focused terminal control. If this tab is
    //   the focused tab, then also bubble this title to any listeners of our
    //   TitleChanged event.
    // Arguments:
    // - tab: the Tab to update the title for.
    void TerminalPage::_UpdateTitle(const winrt::TerminalApp::Tab& tab)
    {
        // Mirror the tab's title onto its bridged terminal-web session, so
        // remote clients show the same names as the local tabs.
        if (const auto tabImpl{ _GetTabImpl(tab) })
        {
            if (const auto control{ tabImpl->GetActiveTerminalControl() })
            {
                if (const auto conn{ control.Connection() })
                {
                    if (const auto conpty{ conn.try_as<TerminalConnection::ConptyConnection>() })
                    {
                        conpty.UpdateBridgeTitle(tab.Title());
                    }
                }
            }
        }

        if (_tabRow)
        {
            winrt::get_self<implementation::TabRowControl>(_tabRow)->NotifyTabTitleUpdated(tab);
        }

        // Shells that emit title changes do so right after changing directory,
        // so this keeps the tab's git branch in step with `cd`.
        _RefreshTabDirectory(tab);

        if (tab == _GetFocusedTab())
        {
            TitleChanged.raise(*this, nullptr);
        }
    }

    // Method Description:
    // - Connects event handlers to the TermControl for events that we want to
    //   handle. This includes:
    //    * the Copy and Paste events, for setting and retrieving clipboard data
    //      on the right thread
    // Arguments:
    // - term: The newly created TermControl to connect the events for
    void TerminalPage::_RegisterTerminalEvents(TermControl term)
    {
        term.RaiseNotice({ this, &TerminalPage::_ControlNoticeRaisedHandler });

        term.WriteToClipboard({ get_weak(), &TerminalPage::_copyToClipboard });
        term.PasteFromClipboard({ this, &TerminalPage::_PasteFromClipboardHandler });

        term.OpenHyperlink({ this, &TerminalPage::_OpenHyperlinkHandler });

        // Add an event handler for when the terminal or tab wants to set a
        // progress indicator on the taskbar
        term.SetTaskbarProgress({ get_weak(), &TerminalPage::_SetTaskbarProgressHandler });

        term.ConnectionStateChanged({ get_weak(), &TerminalPage::_ConnectionStateChangedHandler });

        // The shell told us it changed directory. This is the authoritative
        // signal behind grouping tabs by directory; everything else is a
        // fallback for shells and TUIs that never report.
        term.WorkingDirectoryChanged({ get_weak(), &TerminalPage::_ControlWorkingDirectoryChangedHandler });

        term.PropertyChanged([weakThis = get_weak()](auto& /*sender*/, auto& e) {
            if (auto page{ weakThis.get() })
            {
                if (e.PropertyName() == L"BackgroundBrush")
                {
                    page->_updateThemeColors();
                }
            }
        });

        term.ShowWindowChanged({ get_weak(), &TerminalPage::_ShowWindowChangedHandler });
        term.SearchMissingCommand({ get_weak(), &TerminalPage::_SearchMissingCommandHandler });
        term.WindowSizeChanged({ get_weak(), &TerminalPage::_WindowSizeChanged });

        // Don't even register for the event if the feature is compiled off.
        if constexpr (Feature_ShellCompletions::IsEnabled())
        {
            term.CompletionsChanged({ get_weak(), &TerminalPage::_ControlCompletionsChangedHandler });
        }
        winrt::weak_ref<TermControl> weakTerm{ term };
        term.ContextMenu().Opening([weak = get_weak(), weakTerm](auto&& sender, auto&& /*args*/) {
            if (const auto& page{ weak.get() })
            {
                page->_PopulateContextMenu(weakTerm.get(), sender.try_as<MUX::Controls::CommandBarFlyout>(), false);
            }
        });
        term.SelectionContextMenu().Opening([weak = get_weak(), weakTerm](auto&& sender, auto&& /*args*/) {
            if (const auto& page{ weak.get() })
            {
                page->_PopulateContextMenu(weakTerm.get(), sender.try_as<MUX::Controls::CommandBarFlyout>(), true);
            }
        });
        if constexpr (Feature_QuickFix::IsEnabled())
        {
            term.QuickFixMenu().Opening([weak = get_weak(), weakTerm](auto&& sender, auto&& /*args*/) {
                if (const auto& page{ weak.get() })
                {
                    page->_PopulateQuickFixMenu(weakTerm.get(), sender.try_as<Controls::MenuFlyout>());
                }
            });
        }
    }

    // Method Description:
    // - Connects event handlers to the Tab for events that we want to
    //   handle. This includes:
    //    * the TitleChanged event, for changing the text of the tab
    //    * the Color{Selected,Cleared} events to change the color of a tab.
    // Arguments:
    // - hostingTab: The Tab that's hosting this TermControl instance
    void TerminalPage::_RegisterTabEvents(Tab& hostingTab)
    {
        auto weakTab{ hostingTab.get_weak() };
        auto weakThis{ get_weak() };
        // PropertyChanged is the generic mechanism by which the Tab
        // communicates changes to any of its observable properties, including
        // the Title
        hostingTab.PropertyChanged([weakTab, weakThis](auto&&, const WUX::Data::PropertyChangedEventArgs& args) {
            auto page{ weakThis.get() };
            auto tab{ weakTab.get() };
            if (page && tab)
            {
                const auto propertyName = args.PropertyName();
                if (propertyName == L"Title")
                {
                    page->_UpdateTitle(*tab);
                }
                else if (propertyName == L"Content")
                {
                    if (*tab == page->_GetFocusedTab())
                    {
                        const auto children = page->_tabContent.Children();

                        children.Clear();
                        if (auto content = tab->Content())
                        {
                            page->_tabContent.Children().Append(std::move(content));
                        }

                        tab->Focus(FocusState::Programmatic);
                    }
                }
            }
        });

        // Add an event handler for when the terminal or tab wants to set a
        // progress indicator on the taskbar
        hostingTab.TaskbarProgressChanged({ get_weak(), &TerminalPage::_SetTaskbarProgressHandler });

        hostingTab.RestartTerminalRequested({ get_weak(), &TerminalPage::_restartPaneConnection });
    }

    // Method Description:
    // - Helper to manually exit "zoom" when certain actions take place.
    //   Anything that modifies the state of the pane tree should probably
    //   un-zoom the focused pane first, so that the user can see the full pane
    //   tree again. These actions include:
    //   * Splitting a new pane
    //   * Closing a pane
    //   * Moving focus between panes
    //   * Resizing a pane
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::_UnZoomIfNeeded()
    {
        if (const auto activeTab{ _GetFocusedTabImpl() })
        {
            if (activeTab->IsZoomed())
            {
                // Remove the content from the tab first, so Pane::UnZoom can
                // re-attach the content to the tree w/in the pane
                _tabContent.Children().Clear();
                // In ExitZoom, we'll change the Tab's Content(), triggering the
                // content changed event, which will re-attach the tab's new content
                // root to the tree.
                activeTab->ExitZoom();
            }
        }
    }

    // Method Description:
    // - Attempt to move focus between panes, as to focus the child on
    //   the other side of the separator. See Pane::NavigateFocus for details.
    // - Moves the focus of the currently focused tab.
    // Arguments:
    // - direction: The direction to move the focus in.
    // Return Value:
    // - Whether changing the focus succeeded. This allows a keychord to propagate
    //   to the terminal when no other panes are present (GH#6219)
    bool TerminalPage::_MoveFocus(const FocusDirection& direction)
    {
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            return tabImpl->NavigateFocus(direction);
        }
        return false;
    }

    // Method Description:
    // - Attempt to swap the positions of the focused pane with another pane.
    //   See Pane::SwapPane for details.
    // Arguments:
    // - direction: The direction to move the focused pane in.
    // Return Value:
    // - true if panes were swapped.
    bool TerminalPage::_SwapPane(const FocusDirection& direction)
    {
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            _UnZoomIfNeeded();
            return tabImpl->SwapPane(direction);
        }
        return false;
    }

    TermControl TerminalPage::_GetActiveControl() const
    {
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            return tabImpl->GetActiveTerminalControl();
        }
        return nullptr;
    }

    CommandPalette TerminalPage::LoadCommandPalette()
    {
        if (const auto p = CommandPaletteElement())
        {
            return p;
        }

        return _loadCommandPaletteSlowPath();
    }
    bool TerminalPage::_commandPaletteIs(WUX::Visibility visibility)
    {
        const auto p = CommandPaletteElement();
        return p && p.Visibility() == visibility;
    }

    CommandPalette TerminalPage::_loadCommandPaletteSlowPath()
    {
        const auto p = FindName(L"CommandPaletteElement").as<CommandPalette>();

        p.SetActionMap(_settings.ActionMap());

        // When the visibility of the command palette changes to "collapsed",
        // the palette has been closed. Toss focus back to the currently active control.
        p.RegisterPropertyChangedCallback(UIElement::VisibilityProperty(), [this](auto&&, auto&&) {
            if (_commandPaletteIs(Visibility::Collapsed))
            {
                _FocusActiveControl(nullptr, nullptr);
            }
        });
        p.DispatchCommandRequested({ this, &TerminalPage::_OnDispatchCommandRequested });
        p.CommandLineExecutionRequested({ this, &TerminalPage::_OnCommandLineExecutionRequested });
        p.SwitchToTabRequested({ this, &TerminalPage::_OnSwitchToTabRequested });
        p.PreviewAction({ this, &TerminalPage::_PreviewActionHandler });

        return p;
    }

    SuggestionsControl TerminalPage::LoadSuggestionsUI()
    {
        if (const auto p = SuggestionsElement())
        {
            return p;
        }

        return _loadSuggestionsElementSlowPath();
    }
    bool TerminalPage::_suggestionsControlIs(WUX::Visibility visibility)
    {
        const auto p = SuggestionsElement();
        return p && p.Visibility() == visibility;
    }

    SuggestionsControl TerminalPage::_loadSuggestionsElementSlowPath()
    {
        const auto p = FindName(L"SuggestionsElement").as<SuggestionsControl>();

        p.RegisterPropertyChangedCallback(UIElement::VisibilityProperty(), [this](auto&&, auto&&) {
            if (SuggestionsElement().Visibility() == Visibility::Collapsed)
            {
                _FocusActiveControl(nullptr, nullptr);
            }
        });
        p.DispatchCommandRequested({ this, &TerminalPage::_OnDispatchCommandRequested });
        p.PreviewAction({ this, &TerminalPage::_PreviewActionHandler });

        return p;
    }

    // Method Description:
    // - Warn the user that they are about to close all open windows, then
    //   signal that we want to close everything.
    safe_void_coroutine TerminalPage::RequestQuit()
    {
        const auto setting = _settings.GlobalSettings().ConfirmOnClose();
        if (setting != ConfirmOnClose::Never && !_displayingCloseDialog)
        {
            _displayingCloseDialog = true;

            const auto weak = get_weak();
            auto warningResult = co_await _ShowConfirmCloseDialog(ConfirmCloseDialogKind::CloseAll);
            const auto strong = weak.get();
            if (!strong)
            {
                co_return;
            }

            _displayingCloseDialog = false;

            if (warningResult != ContentDialogResult::Primary)
            {
                co_return;
            }
        }

        QuitRequested.raise(nullptr, nullptr);
    }

    WindowLayout TerminalPage::GetWindowLayout()
    {
        // This method may be called for a window even if it hasn't had a tab yet or lost all of them.
        // We shouldn't persist such windows.
        const auto tabCount = _tabs.Size();
        if (_startupState != StartupState::Initialized || tabCount == 0)
        {
            return nullptr;
        }

        std::vector<ActionAndArgs> actions;

        for (auto tab : _tabs)
        {
            auto t = winrt::get_self<implementation::Tab>(tab);
            auto tabActions = t->BuildStartupActions(BuildStartupKind::Persist);
            actions.insert(actions.end(), std::make_move_iterator(tabActions.begin()), std::make_move_iterator(tabActions.end()));
        }

        // Avoid persisting a window with zero tabs, because `BuildStartupActions` happened to return an empty vector.
        if (actions.empty())
        {
            return nullptr;
        }

        // if the focused tab was not the last tab, restore that
        auto idx = _GetFocusedTabIndex();
        if (idx && idx != tabCount - 1)
        {
            ActionAndArgs action;
            action.Action(ShortcutAction::SwitchToTab);
            SwitchToTabArgs switchToTabArgs{ idx.value() };
            action.Args(switchToTabArgs);

            actions.emplace_back(std::move(action));
        }

        // If the user set a custom name, save it
        if (const auto& windowName{ _WindowProperties.WindowName() }; !windowName.empty())
        {
            ActionAndArgs action;
            action.Action(ShortcutAction::RenameWindow);
            RenameWindowArgs args{ windowName };
            action.Args(args);

            actions.emplace_back(std::move(action));
        }

        WindowLayout layout;
        layout.TabLayout(winrt::single_threaded_vector<ActionAndArgs>(std::move(actions)));

        auto mode = LaunchMode::DefaultMode;
        WI_SetFlagIf(mode, LaunchMode::FullscreenMode, _isFullscreen);
        WI_SetFlagIf(mode, LaunchMode::FocusMode, _isInFocusMode);
        WI_SetFlagIf(mode, LaunchMode::MaximizedMode, _isMaximized);

        layout.LaunchMode({ mode });

        // Only save the content size because the tab size will be added on load.
        const auto contentWidth = static_cast<float>(_tabContent.ActualWidth());
        const auto contentHeight = static_cast<float>(_tabContent.ActualHeight());
        const winrt::Windows::Foundation::Size windowSize{ contentWidth, contentHeight };

        layout.InitialSize(windowSize);

        // We don't actually know our own position. So we have to ask the window
        // layer for that.
        const auto launchPosRequest{ winrt::make<LaunchPositionRequest>() };
        RequestLaunchPosition.raise(*this, launchPosRequest);
        layout.InitialPosition(launchPosRequest.Position());

        return layout;
    }

    void TerminalPage::PersistState()
    {
        // There are two persistence mechanisms in play here:
        //   * PersistedWindowLayouts (vector): consumed on next startup to
        //     re-open a matching set of windows. Cleared after restore.
        //   * PersistedWorkspaces (name-keyed map): the full tab/buffer
        //     state of a named window, claimed by name on demand via
        //     ApplicationState::TakeWorkspace.
        //
        // For named windows we save the full layout into the workspace map
        // and drop a lightweight `openWorkspace` stub into the generic vector,
        // so the generic restore path re-opens the named window which in
        // turn claims its own workspace. Unnamed windows don't have a stable
        // key, so their full layout is stored directly in the vector.
        if (const auto layout = GetWindowLayout())
        {
            const auto& windowName = _WindowProperties.WindowName();
            if (!windowName.empty())
            {
                // Persist the full layout into the workspace collection.
                ApplicationState::SharedInstance().SaveWorkspace(windowName, layout);

                // Build a minimal layout with just an openWorkspace action
                // so the generic restore path re-opens this workspace by name.
                std::vector<ActionAndArgs> actions;
                ActionAndArgs action;
                action.Action(ShortcutAction::OpenWorkspace);
                OpenWorkspaceArgs args{ windowName };
                action.Args(args);
                actions.emplace_back(std::move(action));

                WindowLayout stub;
                stub.TabLayout(winrt::single_threaded_vector<ActionAndArgs>(std::move(actions)));
                ApplicationState::SharedInstance().AppendPersistedWindowLayout(stub);
            }
            else
            {
                ApplicationState::SharedInstance().AppendPersistedWindowLayout(layout);
            }
        }
    }

    // Method Description:
    // - Determines whether a close-window action should show a confirmation
    //   dialog, based on the confirmOnClose setting and the current window state.
    // Arguments:
    // - <none>
    // Return Value:
    // - true, if a warning dialog should be shown before closing the window
    bool TerminalPage::_ShouldWarnOnClose() const
    {
        const auto setting = _settings.GlobalSettings().ConfirmOnClose();
        switch (setting)
        {
        case ConfirmOnClose::Always:
            return true;
        case ConfirmOnClose::Automatic:
        {
            // Warn if there's more than one tab, or the one tab has more than one pane.
            return _HasMultipleTabs() || _GetTabImpl(_tabs.GetAt(0))->GetLeafPaneCount() > 1;
        }
        case ConfirmOnClose::Never:
        default:
            return false;
        }
    }

    // Method Description:
    // - Determines whether closing a specific tab should show a confirmation
    //   dialog, based on the confirmOnClose setting and the tab's state.
    // Arguments:
    // - tab: The tab being closed
    // Return Value:
    // - true, if a warning dialog should be shown before closing the tab
    bool TerminalPage::_ShouldWarnOnCloseTab(const winrt::com_ptr<Tab>& tab) const
    {
        const auto setting = _settings.GlobalSettings().ConfirmOnClose();
        switch (setting)
        {
        case ConfirmOnClose::Always:
            return true;
        case ConfirmOnClose::Automatic:
            // Warn if this tab has more than one pane.
            return tab->GetLeafPaneCount() > 1;
        case ConfirmOnClose::Never:
        default:
            return false;
        }
    }

    // Method Description:
    // - Close the terminal app. If the confirmOnClose setting indicates we should
    //   warn for the current window state, show a warning dialog.
    safe_void_coroutine TerminalPage::CloseWindow()
    {
        if (_ShouldWarnOnClose() &&
            !_displayingCloseDialog)
        {
            if (_newTabButton && _newTabButton.Flyout())
            {
                _newTabButton.Flyout().Hide();
            }
            _DismissTabContextMenus();
            _displayingCloseDialog = true;

            const auto weak = get_weak();
            auto warningResult = co_await _ShowConfirmCloseDialog(ConfirmCloseDialogKind::Window);
            // Hold a strong reference to `this` after the co_await; we may
            // be the last holder if the window was already being torn down.
            auto strong = weak.get();
            if (!strong)
            {
                co_return;
            }

            _displayingCloseDialog = false;

            if (warningResult != ContentDialogResult::Primary)
            {
                co_return;
            }
        }

        CloseWindowRequested.raise(*this, nullptr);
    }

    std::vector<IPaneContent> TerminalPage::Panes() const
    {
        std::vector<IPaneContent> panes;

        for (const auto tab : _tabs)
        {
            const auto impl = _GetTabImpl(tab);
            if (!impl)
            {
                continue;
            }

            impl->GetRootPane()->WalkTree([&](auto&& pane) {
                if (auto content = pane->GetContent())
                {
                    panes.push_back(std::move(content));
                }
            });
        }

        return panes;
    }

    // Method Description:
    // - Move the viewport of the terminal of the currently focused tab up or
    //      down a number of lines.
    // Arguments:
    // - scrollDirection: ScrollUp will move the viewport up, ScrollDown will move the viewport down
    // - rowsToScroll: a number of lines to move the viewport. If not provided we will use a system default.
    void TerminalPage::_Scroll(ScrollDirection scrollDirection, const Windows::Foundation::IReference<uint32_t>& rowsToScroll)
    {
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            uint32_t realRowsToScroll;
            if (rowsToScroll == nullptr)
            {
                // The magic value of WHEEL_PAGESCROLL indicates that we need to scroll the entire page
                realRowsToScroll = _systemRowsToScroll == WHEEL_PAGESCROLL ?
                                       tabImpl->GetActiveTerminalControl().ViewHeight() :
                                       _systemRowsToScroll;
            }
            else
            {
                // use the custom value specified in the command
                realRowsToScroll = rowsToScroll.Value();
            }
            auto scrollDelta = _ComputeScrollDelta(scrollDirection, realRowsToScroll);
            tabImpl->Scroll(scrollDelta);
        }
    }

    // Method Description:
    // - Moves the currently active pane on the currently active tab to the
    //   specified tab. If the tab index is greater than the number of
    //   tabs, then a new tab will be created for the pane. Similarly, if a pane
    //   is the last remaining pane on a tab, that tab will be closed upon moving.
    // - No move will occur if the tabIdx is the same as the current tab, or if
    //   the specified tab is not a host of terminals (such as the settings tab).
    // - If the Window is specified, the pane will instead be detached and moved
    //   to the window with the given name/id.
    // Return Value:
    // - true if the pane was successfully moved to the new tab.
    bool TerminalPage::_MovePane(MovePaneArgs args)
    {
        const auto tabIdx{ args.TabIndex() };
        const auto windowId{ args.Window() };

        auto focusedTab{ _GetFocusedTabImpl() };

        if (!focusedTab)
        {
            return false;
        }

        // If there was a windowId in the action, try to move it to the
        // specified window instead of moving it in our tab row.
        if (!windowId.empty())
        {
            if (const auto tabImpl{ _GetFocusedTabImpl() })
            {
                if (const auto pane{ tabImpl->GetActivePane() })
                {
                    auto startupActions = pane->BuildStartupActions(0, 1, BuildStartupKind::MovePane);
                    _DetachPaneFromWindow(pane);
                    _MoveContent(std::move(startupActions.args), windowId, tabIdx);
                    focusedTab->DetachPane();

                    if (auto autoPeer = Automation::Peers::FrameworkElementAutomationPeer::FromElement(*this))
                    {
                        if (windowId == L"new")
                        {
                            autoPeer.RaiseNotificationEvent(Automation::Peers::AutomationNotificationKind::ActionCompleted,
                                                            Automation::Peers::AutomationNotificationProcessing::ImportantMostRecent,
                                                            RS_(L"TerminalPage_PaneMovedAnnouncement_NewWindow"),
                                                            L"TerminalPageMovePaneToNewWindow" /* unique name for this notification category */);
                        }
                        else
                        {
                            autoPeer.RaiseNotificationEvent(Automation::Peers::AutomationNotificationKind::ActionCompleted,
                                                            Automation::Peers::AutomationNotificationProcessing::ImportantMostRecent,
                                                            RS_fmt(L"TerminalPage_PaneMovedAnnouncement_ExistingWindow2", windowId),
                                                            L"TerminalPageMovePaneToExistingWindow" /* unique name for this notification category */);
                        }
                    }
                    return true;
                }
            }
        }

        // If we are trying to move from the current tab to the current tab do nothing.
        if (_GetFocusedTabIndex() == tabIdx)
        {
            return false;
        }

        // Moving the pane from the current tab might close it, so get the next
        // tab before its index changes.
        if (tabIdx < _tabs.Size())
        {
            auto targetTab = _GetTabImpl(_tabs.GetAt(tabIdx));
            // if the selected tab is not a host of terminals (e.g. settings)
            // don't attempt to add a pane to it.
            if (!targetTab)
            {
                return false;
            }
            auto pane = focusedTab->DetachPane();
            targetTab->AttachPane(pane);
            _SetFocusedTab(*targetTab);

            if (auto autoPeer = Automation::Peers::FrameworkElementAutomationPeer::FromElement(*this))
            {
                const auto tabTitle = targetTab->Title();
                autoPeer.RaiseNotificationEvent(Automation::Peers::AutomationNotificationKind::ActionCompleted,
                                                Automation::Peers::AutomationNotificationProcessing::ImportantMostRecent,
                                                RS_fmt(L"TerminalPage_PaneMovedAnnouncement_ExistingTab", tabTitle),
                                                L"TerminalPageMovePaneToExistingTab" /* unique name for this notification category */);
            }
        }
        else
        {
            auto pane = focusedTab->DetachPane();
            _CreateNewTabFromPane(pane);
            if (auto autoPeer = Automation::Peers::FrameworkElementAutomationPeer::FromElement(*this))
            {
                autoPeer.RaiseNotificationEvent(Automation::Peers::AutomationNotificationKind::ActionCompleted,
                                                Automation::Peers::AutomationNotificationProcessing::ImportantMostRecent,
                                                RS_(L"TerminalPage_PaneMovedAnnouncement_NewTab"),
                                                L"TerminalPageMovePaneToNewTab" /* unique name for this notification category */);
            }
        }

        return true;
    }

    // Detach a tree of panes from this terminal. Helper used for moving panes
    // and tabs to other windows.
    void TerminalPage::_DetachPaneFromWindow(std::shared_ptr<Pane> pane)
    {
        pane->WalkTree([&](auto p) {
            if (const auto& control{ p->GetTerminalControl() })
            {
                _manager.Detach(control);
            }
        });
    }

    void TerminalPage::_DetachTabFromWindow(const winrt::com_ptr<Tab>& tab)
    {
        // Detach the root pane, which will act like the whole tab got detached.
        if (const auto rootPane = tab->GetRootPane())
        {
            _DetachPaneFromWindow(rootPane);
        }
    }

    // Method Description:
    // - Serialize these actions to json, and raise them as a RequestMoveContent
    //   event. Our Window will raise that to the window manager / monarch, who
    //   will dispatch this blob of json back to the window that should handle
    //   this.
    // - `actions` will be emptied into a winrt IVector as a part of this method
    //   and should be expected to be empty after this call.
    void TerminalPage::_MoveContent(std::vector<Settings::Model::ActionAndArgs>&& actions,
                                    const winrt::hstring& windowName,
                                    const uint32_t tabIndex,
                                    const std::optional<winrt::Windows::Foundation::Point>& dragPoint)
    {
        const auto winRtActions{ winrt::single_threaded_vector<ActionAndArgs>(std::move(actions)) };
        const auto str{ ActionAndArgs::Serialize(winRtActions) };
        const auto request = winrt::make_self<RequestMoveContentArgs>(windowName,
                                                                      str,
                                                                      tabIndex);
        if (dragPoint.has_value())
        {
            request->WindowPosition(*dragPoint);
        }
        RequestMoveContent.raise(*this, *request);
    }

    bool TerminalPage::_MoveTab(winrt::com_ptr<Tab> tab, MoveTabArgs args)
    {
        if (!tab)
        {
            return false;
        }

        // If there was a windowId in the action, try to move it to the
        // specified window instead of moving it in our tab row.
        const auto windowId{ args.Window() };
        if (!windowId.empty())
        {
            // if the windowId is the same as our name, do nothing
            if (windowId == WindowProperties().WindowName() ||
                windowId == winrt::to_hstring(WindowProperties().WindowId()))
            {
                return true;
            }

            if (tab)
            {
                auto startupActions = tab->BuildStartupActions(BuildStartupKind::Content);
                _DetachTabFromWindow(tab);
                _MoveContent(std::move(startupActions), windowId, 0);
                _RemoveTab(*tab);
                if (auto autoPeer = Automation::Peers::FrameworkElementAutomationPeer::FromElement(*this))
                {
                    const auto tabTitle = tab->Title();
                    if (windowId == L"new")
                    {
                        autoPeer.RaiseNotificationEvent(Automation::Peers::AutomationNotificationKind::ActionCompleted,
                                                        Automation::Peers::AutomationNotificationProcessing::ImportantMostRecent,
                                                        RS_fmt(L"TerminalPage_TabMovedAnnouncement_NewWindow", tabTitle),
                                                        L"TerminalPageMoveTabToNewWindow" /* unique name for this notification category */);
                    }
                    else
                    {
                        autoPeer.RaiseNotificationEvent(Automation::Peers::AutomationNotificationKind::ActionCompleted,
                                                        Automation::Peers::AutomationNotificationProcessing::ImportantMostRecent,
                                                        RS_fmt(L"TerminalPage_TabMovedAnnouncement_Default", tabTitle, windowId),
                                                        L"TerminalPageMoveTabToExistingWindow" /* unique name for this notification category */);
                    }
                }
                return true;
            }
        }

        const auto direction = args.Direction();
        if (direction != MoveTabDirection::None)
        {
            // Use the requested tab, if provided. Otherwise, use the currently
            // focused tab.
            const auto tabIndex = til::coalesce(_GetTabIndex(*tab),
                                                _GetFocusedTabIndex());
            if (tabIndex)
            {
                const auto currentTabIndex = tabIndex.value();
                const auto delta = direction == MoveTabDirection::Forward ? 1 : -1;
                _TryMoveTab(currentTabIndex, currentTabIndex + delta);
            }
        }

        return true;
    }

    // When the tab's active pane changes, we'll want to lookup a new icon
    // for it. The Title change will be propagated upwards through the tab's
    // PropertyChanged event handler.
    void TerminalPage::_activePaneChanged(winrt::TerminalApp::Tab sender,
                                          Windows::Foundation::IInspectable /*args*/)
    {
        if (const auto tab{ _GetTabImpl(sender) })
        {
            // Possibly update the icon of the tab.
            _UpdateTabIcon(*tab);

            _updateThemeColors();

            // Update the taskbar progress as well. We'll raise our own
            // SetTaskbarProgress event here, to get tell the hosting
            // application to re-query this value from us.
            SetTaskbarProgress.raise(*this, nullptr);

            auto profile = tab->GetFocusedProfile();
            _UpdateBackground(profile);
        }

        _adjustProcessPriorityThrottled->Run();
    }

    uint32_t TerminalPage::NumberOfTabs() const
    {
        return _tabs.Size();
    }

    // Method Description:
    // - Called when it is determined that an existing tab or pane should be
    //   attached to our window. content represents a blob of JSON describing
    //   some startup actions for rebuilding the specified panes. They will
    //   include `__content` properties with the GUID of the existing
    //   ControlInteractivity's we should use, rather than starting new ones.
    // - _MakePane is already enlightened to use the ContentId property to
    //   reattach instead of create new content, so this method simply needs to
    //   parse the JSON and pump it into our action handler. Almost the same as
    //   doing something like `wt -w 0 nt`.
    void TerminalPage::AttachContent(IVector<Settings::Model::ActionAndArgs> args, uint32_t tabIndex)
    {
        if (args == nullptr ||
            args.Size() == 0)
        {
            return;
        }

        const auto& firstAction = args.GetAt(0);
        const bool firstIsSplitPane{ firstAction.Action() == ShortcutAction::SplitPane };

        // `splitPane` allows the user to specify which tab to split. In that
        // case, split specifically the requested pane.
        //
        // If there's not enough tabs, then just turn this pane into a new tab.
        //
        // If the first action is `newTab`, the index is always going to be 0,
        // so don't do anything in that case.
        if (firstIsSplitPane && tabIndex < _tabs.Size())
        {
            _SelectTab(tabIndex);
        }

        for (const auto& action : args)
        {
            _actionDispatch->DoAction(action);
        }

        // After handling all the actions, then re-check the tabIndex. We might
        // have been called as a part of a tab drag/drop. In that case, the
        // tabIndex is actually relevant, and we need to move the tab we just
        // made into position.
        if (!firstIsSplitPane && tabIndex != -1)
        {
            // Move the currently active tab to the requested index Use the
            // currently focused tab index, because we don't know if the new tab
            // opened at the end of the list, or adjacent to the previously
            // active tab. This is affected by the user's "newTabPosition"
            // setting.
            if (const auto focusedTabIndex = _GetFocusedTabIndex())
            {
                const auto source = *focusedTabIndex;
                _TryMoveTab(source, tabIndex);
            }
            // else: This shouldn't really be possible, because the tab we _just_ opened should be active.
        }
    }

    // Method Description:
    // - Split the focused pane of the given tab, either horizontally or vertically, and place the
    //   given pane accordingly
    // Arguments:
    // - tab: The tab that is going to be split.
    // - newPane: the pane to add to our tree of panes
    // - splitDirection: one value from the TerminalApp::SplitDirection enum, indicating how the
    //   new pane should be split from its parent.
    // - splitSize: the size of the split
    void TerminalPage::_SplitPane(const winrt::com_ptr<Tab>& tab,
                                  const SplitDirection splitDirection,
                                  const float splitSize,
                                  std::shared_ptr<Pane> newPane)
    {
        auto activeTab = tab;
        // Clever hack for a crash in startup, with multiple sub-commands. Say
        // you have the following commandline:
        //
        //   wtd nt -p "elevated cmd" ; sp -p "elevated cmd" ; sp -p "Command Prompt"
        //
        // Where "elevated cmd" is an elevated profile.
        //
        // In that scenario, we won't dump off the commandline immediately to an
        // elevated window, because it's got the final unelevated split in it.
        // However, when we get to that command, there won't be a tab yet. So
        // we'd crash right about here.
        //
        // Instead, let's just promote this first split to be a tab instead.
        // Crash avoided, and we don't need to worry about inserting a new-tab
        // command in at the start.
        if (!tab)
        {
            if (_tabs.Size() == 0)
            {
                _CreateNewTabFromPane(newPane);
                return;
            }
            else
            {
                activeTab = _GetFocusedTabImpl();
            }
        }

        // For now, prevent splitting the _settingsTab. We can always revisit this later.
        if (*activeTab == _settingsTab)
        {
            return;
        }

        // If the caller is calling us with the return value of _MakePane
        // directly, it's possible that nullptr was returned, if the connections
        // was supposed to be launched in an elevated window. In that case, do
        // nothing here. We don't have a pane with which to create the split.
        if (!newPane)
        {
            return;
        }
        const auto contentWidth = static_cast<float>(_tabContent.ActualWidth());
        const auto contentHeight = static_cast<float>(_tabContent.ActualHeight());
        const winrt::Windows::Foundation::Size availableSpace{ contentWidth, contentHeight };

        const auto realSplitType = activeTab->PreCalculateCanSplit(splitDirection, splitSize, availableSpace);
        if (!realSplitType)
        {
            return;
        }

        _UnZoomIfNeeded();
        auto [original, newGuy] = activeTab->SplitPane(*realSplitType, splitSize, newPane);

        // After GH#6586, the control will no longer focus itself
        // automatically when it's finished being laid out. Manually focus
        // the control here instead.
        if (_startupState == StartupState::Initialized)
        {
            if (const auto& content{ newGuy->GetContent() })
            {
                content.Focus(FocusState::Programmatic);
            }
        }
    }

    // Method Description:
    // - Switches the split orientation of the currently focused pane.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::_ToggleSplitOrientation()
    {
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            _UnZoomIfNeeded();
            tabImpl->ToggleSplitOrientation();
        }
    }

    // Method Description:
    // - Attempt to move a separator between panes, as to resize each child on
    //   either size of the separator. See Pane::ResizePane for details.
    // - Moves a separator on the currently focused tab.
    // Arguments:
    // - direction: The direction to move the separator in.
    // Return Value:
    // - whether a pane was resized
    bool TerminalPage::_ResizePane(const ResizeDirection& direction)
    {
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            _UnZoomIfNeeded();
            return tabImpl->ResizePane(direction);
        }
        return false;
    }

    // Method Description:
    // - Move the viewport of the terminal of the currently focused tab up or
    //      down a page. The page length will be dependent on the terminal view height.
    // Arguments:
    // - scrollDirection: ScrollUp will move the viewport up, ScrollDown will move the viewport down
    void TerminalPage::_ScrollPage(ScrollDirection scrollDirection)
    {
        // Do nothing if for some reason, there's no terminal tab in focus. We don't want to crash.
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            if (const auto& control{ _GetActiveControl() })
            {
                const auto termHeight = control.ViewHeight();
                auto scrollDelta = _ComputeScrollDelta(scrollDirection, termHeight);
                tabImpl->Scroll(scrollDelta);
            }
        }
    }

    void TerminalPage::_ScrollToBufferEdge(ScrollDirection scrollDirection)
    {
        if (const auto tabImpl{ _GetFocusedTabImpl() })
        {
            auto scrollDelta = _ComputeScrollDelta(scrollDirection, INT_MAX);
            tabImpl->Scroll(scrollDelta);
        }
    }

    // Method Description:
    // - Gets the title of the currently focused terminal control. If there
    //   isn't a control selected for any reason, returns "Terminal"
    // Arguments:
    // - <none>
    // Return Value:
    // - the title of the focused control if there is one, else "Terminal"
    hstring TerminalPage::Title()
    {
        hstring title{ L"Terminal" };
        if (_currentWindowSettings().ShowTitleInTitlebar())
        {
            if (const auto tab{ _GetFocusedTab() })
            {
                title = tab.Title();
            }
        }

        // Surface the terminal-web bridge state in the caption so it's always
        // visible whether remote web/mobile control is available.
        const auto bridge = TerminalConnection::ConptyConnection::BridgeConnectionStatus();
        if (bridge == L"connected")
        {
            return hstring{ title + L" \x2022 Bridge: connected" };
        }
        if (bridge == L"failing")
        {
            // The spawn owner keeps watching its server child die on startup;
            // the child's output is in tools\terminal-web\.terminal-web-server.log.
            return hstring{ title + L" \x2022 Bridge: server error (see .terminal-web-server.log)" };
        }
        if (bridge == L"connecting")
        {
            return hstring{ title + L" \x2022 Bridge: offline" };
        }
        return title;
    }

    // Method Description:
    // - Handles the special case of providing a text override for the UI shortcut due to VK_OEM issue.
    //      Looks at the flags from the KeyChord modifiers and provides a concatenated string value of all
    //      in the same order that XAML would put them as well.
    // Return Value:
    // - a string representation of the key modifiers for the shortcut
    //NOTE: This needs to be localized with https://github.com/microsoft/terminal/issues/794 if XAML framework issue not resolved before then
    static std::wstring _FormatOverrideShortcutText(VirtualKeyModifiers modifiers)
    {
        std::wstring buffer{ L"" };

        if (WI_IsFlagSet(modifiers, VirtualKeyModifiers::Control))
        {
            buffer += L"Ctrl+";
        }

        if (WI_IsFlagSet(modifiers, VirtualKeyModifiers::Shift))
        {
            buffer += L"Shift+";
        }

        if (WI_IsFlagSet(modifiers, VirtualKeyModifiers::Menu))
        {
            buffer += L"Alt+";
        }

        if (WI_IsFlagSet(modifiers, VirtualKeyModifiers::Windows))
        {
            buffer += L"Win+";
        }

        return buffer;
    }

    // Method Description:
    // - Takes a MenuFlyoutItem and a corresponding KeyChord value and creates the accelerator for UI display.
    //   Takes into account a special case for an error condition for a comma
    // Arguments:
    // - MenuFlyoutItem that will be displayed, and a KeyChord to map an accelerator
    void TerminalPage::_SetAcceleratorForMenuItem(WUX::Controls::MenuFlyoutItem& menuItem,
                                                  const KeyChord& keyChord)
    {
#ifdef DEP_MICROSOFT_UI_XAML_708_FIXED
        // work around https://github.com/microsoft/microsoft-ui-xaml/issues/708 in case of VK_OEM_COMMA
        if (keyChord.Vkey() != VK_OEM_COMMA)
        {
            // use the XAML shortcut to give us the automatic capabilities
            auto menuShortcut = Windows::UI::Xaml::Input::KeyboardAccelerator{};

            // TODO: Modify this when https://github.com/microsoft/terminal/issues/877 is resolved
            menuShortcut.Key(static_cast<Windows::System::VirtualKey>(keyChord.Vkey()));

            // add the modifiers to the shortcut
            menuShortcut.Modifiers(keyChord.Modifiers());

            // add to the menu
            menuItem.KeyboardAccelerators().Append(menuShortcut);
        }
        else // we've got a comma, so need to just use the alternate method
#endif
        {
            // extract the modifier and key to a nice format
            auto overrideString = _FormatOverrideShortcutText(keyChord.Modifiers());
            auto mappedCh = MapVirtualKeyW(keyChord.Vkey(), MAPVK_VK_TO_CHAR);
            if (mappedCh != 0)
            {
                menuItem.KeyboardAcceleratorTextOverride(overrideString + gsl::narrow_cast<wchar_t>(mappedCh));
            }
        }
    }

    // Method Description:
    // - Calculates the appropriate size to snap to in the given direction, for
    //   the given dimension. If the global setting `snapToGridOnResize` is set
    //   to `false`, this will just immediately return the provided dimension,
    //   effectively disabling snapping.
    // - See Pane::CalcSnappedDimension
    float TerminalPage::CalcSnappedDimension(const bool widthOrHeight, const float dimension) const
    {
        if (_settings && _currentWindowSettings().SnapToGridOnResize())
        {
            if (const auto tabImpl{ _GetFocusedTabImpl() })
            {
                return tabImpl->CalcSnappedDimension(widthOrHeight, dimension);
            }
        }
        return dimension;
    }

    // Function Description:
    // - This function is called when the `TermControl` requests that we send
    //   it the clipboard's content.
    // - Retrieves the data from the Windows Clipboard and converts it to text.
    // - Shows warnings if the clipboard is too big or contains multiple lines
    //   of text.
    // - Sends the text back to the TermControl through the event's
    //   `HandleClipboardData` member function.
    // - Does some of this in a background thread, as to not hang/crash the UI thread.
    // Arguments:
    // - eventArgs: the PasteFromClipboard event sent from the TermControl
    safe_void_coroutine TerminalPage::_PasteFromClipboardHandler(const IInspectable sender, const PasteFromClipboardEventArgs eventArgs)
    try
    {
        // The old Win32 clipboard API as used below is somewhere in the order of 300-1000x faster than
        // the WinRT one on average, depending on CPU load. Don't use the WinRT clipboard API if you can.
        const auto weakThis = get_weak();
        const auto dispatcher = Dispatcher();
        const auto windowSettings = _currentWindowSettings();
        const auto bracketedPaste = eventArgs.BracketedPasteEnabled();
        const auto sourceId = sender.try_as<ControlInteractivity>().Id();

        // GetClipboardData might block for up to 30s for delay-rendered contents.
        co_await winrt::resume_background();

        winrt::hstring text;
        if (const auto clipboard = clipboard::open(nullptr))
        {
            text = clipboard::read();
        }

        if (!bracketedPaste && windowSettings.TrimPaste())
        {
            text = winrt::hstring{ Utils::TrimPaste(text) };
        }

        // LOAD BEARING: Send an empty bracketed paste even if the clipboard was empty.
        // Bracketed Paste provides an application a way to know whether the
        // user pasted, even if there was no applicable content on it. This
        // behavior is observed in GNOME Terminal, among others.
        if (!bracketedPaste && text.empty())
        {
            co_return;
        }

        bool warnMultiLine = false;
        switch (windowSettings.WarnAboutMultiLinePaste())
        {
        case WarnAboutMultiLinePaste::Automatic:
            // NOTE that this is unsafe, because a shell that doesn't support bracketed paste
            // will allow an attacker to enable the mode, not realize that, and then accept
            // the paste as if it was a series of legitimate commands. See GH#13014.
            warnMultiLine = !bracketedPaste;
            break;
        case WarnAboutMultiLinePaste::Always:
            warnMultiLine = true;
            break;
        default:
            warnMultiLine = false;
            break;
        }

        if (warnMultiLine)
        {
            const std::wstring_view view{ text };
            warnMultiLine = view.find_first_of(L"\r\n") != std::wstring_view::npos;
        }

        constexpr std::size_t minimumSizeForWarning = 1024 * 5; // 5 KiB
        const auto warnLargeText = text.size() > minimumSizeForWarning && windowSettings.WarnAboutLargePaste();

        if (warnMultiLine || warnLargeText)
        {
            co_await wil::resume_foreground(dispatcher);

            if (const auto strongThis = weakThis.get())
            {
                // We have to initialize the dialog here to be able to change the text of the text block within it
                std::ignore = FindName(L"MultiLinePasteDialog");

                // WinUI absolutely cannot deal with large amounts of text (at least O(n), possibly O(n^2),
                // so we limit the string length here and add an ellipsis if necessary.
                auto clipboardText = text;
                if (clipboardText.size() > 1024)
                {
                    const std::wstring_view view{ text };
                    // Make sure we don't cut in the middle of a surrogate pair
                    const auto len = til::utf16_iterate_prev(view, 512);
                    clipboardText = til::hstring_format(FMT_COMPILE(L"{}\n…"), view.substr(0, len));
                }

                ClipboardText().Text(std::move(clipboardText));

                // The vertical offset on the scrollbar does not reset automatically, so reset it manually
                ClipboardContentScrollViewer().ScrollToVerticalOffset(0);

                auto warningResult = ContentDialogResult::Primary;
                if (warnMultiLine)
                {
                    warningResult = co_await _ShowMultiLinePasteWarningDialog();
                }
                else if (warnLargeText)
                {
                    warningResult = co_await _ShowLargePasteWarningDialog();
                }

                // Clear the clipboard text so it doesn't lie around in memory
                ClipboardText().Text({});

                if (warningResult != ContentDialogResult::Primary)
                {
                    // user rejected the paste
                    co_return;
                }
            }

            co_await winrt::resume_background();
        }

        // This will end up calling ConptyConnection::WriteInput which calls WriteFile which may block for
        // an indefinite amount of time. Avoid freezes and deadlocks by running this on a background thread.
        assert(!dispatcher.HasThreadAccess());
        eventArgs.HandleClipboardData(text);

        // GH#18821: If broadcast input is active, paste the same text into all other
        // panes on the tab. We do this here (rather than re-reading the
        // clipboard per-pane) so that only one paste warning is shown.
        co_await wil::resume_foreground(dispatcher);
        if (const auto strongThis = weakThis.get())
        {
            if (const auto& tab{ strongThis->_GetFocusedTabImpl() })
            {
                if (tab->TabStatus().IsInputBroadcastActive())
                {
                    tab->GetRootPane()->WalkTree([&](auto&& pane) {
                        if (const auto control = pane->GetTerminalControl())
                        {
                            if (control.ContentId() != sourceId && !control.ReadOnly())
                            {
                                control.RawWriteString(text);
                            }
                        }
                    });
                }
            }
        }
    }
    CATCH_LOG();

    safe_void_coroutine TerminalPage::_OpenHyperlinkHandler(const IInspectable /*sender*/, const Microsoft::Terminal::Control::OpenHyperlinkEventArgs eventArgs)
    {
        try
        {
            auto uriString{ eventArgs.Uri() };
            auto parsed = winrt::Windows::Foundation::Uri(uriString);
            if (_IsUriSupported(parsed))
            {
                bool shouldLaunch{ _IsUriConsideredSomewhatSafe(parsed) };

                if (!shouldLaunch)
                {
                    if (auto presenter{ _dialogPresenter.get() })
                    {
                        // FindName needs to be called first to actually load the xaml object
                        auto unopenedUriDialog = FindName(L"UriErrorDialog").try_as<WUX::Controls::ContentDialog>();

                        // Insert the reason and the URI
                        unopenedUriDialog.SecondaryButtonText(RS_(L"UnsafeUrlConfirmAllowAction"));
                        CouldNotOpenUriReason().Text(RS_(L"UnsafeUrlConfirmText"));
                        UnopenedUri().Text(uriString);

                        // Show the dialog
                        auto result = co_await presenter.ShowDialog(unopenedUriDialog);
                        shouldLaunch = result == ContentDialogResult::Secondary;
                    }
                }

                if (shouldLaunch)
                {
                    ShellExecuteW(nullptr, L"open", uriString.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                }
            }
            else
            {
                _ShowCouldNotOpenDialog(RS_(L"UnsupportedSchemeText"), uriString);
            }
        }
        catch (...)
        {
            LOG_CAUGHT_EXCEPTION();
            _ShowCouldNotOpenDialog(RS_(L"InvalidUriText"), eventArgs.Uri());
        }
    }

    // Method Description:
    // - Opens up a dialog box explaining why we could not open a URI
    // Arguments:
    // - The reason (unsupported scheme, invalid uri, potentially more in the future)
    // - The uri
    void TerminalPage::_ShowCouldNotOpenDialog(winrt::hstring reason, winrt::hstring uri)
    {
        if (auto presenter{ _dialogPresenter.get() })
        {
            // FindName needs to be called first to actually load the xaml object
            auto unopenedUriDialog = FindName(L"UriErrorDialog").try_as<WUX::Controls::ContentDialog>();

            // Insert the reason and the URI
            unopenedUriDialog.SecondaryButtonText({});
            CouldNotOpenUriReason().Text(reason);
            UnopenedUri().Text(uri);

            // Show the dialog
            presenter.ShowDialog(unopenedUriDialog);
        }
    }

    // Method Description:
    // - Determines if the given URI is currently supported
    // Arguments:
    // - The parsed URI
    // Return value:
    // - True if we support it, false otherwise
    bool TerminalPage::_IsUriSupported(const winrt::Windows::Foundation::Uri& parsedUri)
    {
        if (parsedUri.SchemeName() == L"http" || parsedUri.SchemeName() == L"https")
        {
            return true;
        }
        if (parsedUri.SchemeName() == L"file")
        {
            const auto host = parsedUri.Host();
            // If no hostname was provided or if the hostname was "localhost", Host() will return an empty string
            // and we allow it
            if (host == L"")
            {
                return true;
            }

            // GH#10188: WSL paths are okay. We'll let those through.
            if (host == L"wsl$" || host == L"wsl.localhost")
            {
                return true;
            }

            // TODO: by the OSC 8 spec, if a hostname (other than localhost) is provided, we _should_ be
            // comparing that value against what is returned by GetComputerNameExW and making sure they match.
            // However, ShellExecute does not seem to be happy with file URIs of the form
            //          file://{hostname}/path/to/file.ext
            // and so while we could do the hostname matching, we do not know how to actually open the URI
            // if its given in that form. So for now we ignore all hostnames other than localhost
            return false;
        }

        // In this case, the app manually output a URI other than file:// or
        // http(s)://. We'll trust the user knows what they're doing when
        // clicking on those sorts of links.
        // See discussion in GH#7562 for more details.
        return true;
    }

    bool TerminalPage::_IsUriConsideredSomewhatSafe(const winrt::Windows::Foundation::Uri& parsedUri) const
    {
        const auto& schemeName = parsedUri.SchemeName();

        if (schemeName == L"http" || schemeName == L"https")
        {
            return true;
        }
        if (schemeName == L"file")
        {
            static const auto pathext{ wil::TryGetEnvironmentVariableW<std::wstring>(L"PATHEXT") };
            const auto filename = parsedUri.Path();
            for (const auto& e : til::split_iterator{ std::wstring_view{ pathext }, L';' })
            {
                if (til::ends_with_insensitive_ascii(filename, e))
                {
                    return false;
                }
            }

            return true;
        }
        if (const auto& safeSchemes = _currentWindowSettings().SafeUriSchemes())
        {
            for (const auto& scheme : safeSchemes)
            {
                if (til::equals_insensitive_ascii(schemeName, scheme))
                {
                    return true;
                }
            }
        }

        return false;
    }

    // Important! Don't take this eventArgs by reference, we need to extend the
    // lifetime of it to the other side of the co_await!
    safe_void_coroutine TerminalPage::_ControlNoticeRaisedHandler(const IInspectable /*sender*/,
                                                                  const Microsoft::Terminal::Control::NoticeEventArgs eventArgs)
    {
        auto weakThis = get_weak();
        co_await wil::resume_foreground(Dispatcher());
        if (auto page = weakThis.get())
        {
            auto message = eventArgs.Message();

            winrt::hstring title;

            switch (eventArgs.Level())
            {
            case NoticeLevel::Debug:
                title = RS_(L"NoticeDebug"); //\xebe8
                break;
            case NoticeLevel::Info:
                title = RS_(L"NoticeInfo"); // \xe946
                break;
            case NoticeLevel::Warning:
                title = RS_(L"NoticeWarning"); //\xe7ba
                break;
            case NoticeLevel::Error:
                title = RS_(L"NoticeError"); //\xe783
                break;
            }

            page->_ShowControlNoticeDialog(title, message);
        }
    }

    void TerminalPage::_ShowControlNoticeDialog(const winrt::hstring& title, const winrt::hstring& message)
    {
        if (auto presenter{ _dialogPresenter.get() })
        {
            // FindName needs to be called first to actually load the xaml object
            auto controlNoticeDialog = FindName(L"ControlNoticeDialog").try_as<WUX::Controls::ContentDialog>();

            ControlNoticeDialog().Title(winrt::box_value(title));

            // Insert the message
            NoticeMessage().Text(message);

            // Show the dialog
            presenter.ShowDialog(controlNoticeDialog);
        }
    }

    // Method Description:
    // - Copy text from the focused terminal to the Windows Clipboard
    // Arguments:
    // - dismissSelection: if not enabled, copying text doesn't dismiss the selection
    // - singleLine: if enabled, copy contents as a single line of text
    // - withControlSequences: if enabled, the copied plain text contains color/style ANSI escape codes from the selection
    // - formats: dictate which formats need to be copied
    // Return Value:
    // - true iff we we able to copy text (if a selection was active)
    bool TerminalPage::_CopyText(const bool dismissSelection, const bool singleLine, const bool withControlSequences, const CopyFormat formats)
    {
        if (const auto& control{ _GetActiveControl() })
        {
            return control.CopySelectionToClipboard(dismissSelection, singleLine, withControlSequences, formats);
        }
        return false;
    }

    // Method Description:
    // - Send an event (which will be caught by AppHost) to set the progress indicator on the taskbar
    // Arguments:
    // - sender (not used)
    // - eventArgs: the arguments specifying how to set the progress indicator
    safe_void_coroutine TerminalPage::_SetTaskbarProgressHandler(const IInspectable /*sender*/, const IInspectable /*eventArgs*/)
    {
        const auto weak = get_weak();
        co_await wil::resume_foreground(Dispatcher());
        if (const auto strong = weak.get())
        {
            SetTaskbarProgress.raise(*this, nullptr);
        }
    }

    // Method Description:
    // - Send an event (which will be caught by AppHost) to change the show window state of the entire hosting window
    // Arguments:
    // - sender (not used)
    // - args: the arguments specifying how to set the display status to ShowWindow for our window handle
    void TerminalPage::_ShowWindowChangedHandler(const IInspectable /*sender*/, const Microsoft::Terminal::Control::ShowWindowArgs args)
    {
        ShowWindowChanged.raise(*this, args);
    }

    Windows::Foundation::IAsyncOperation<IVectorView<MatchResult>> TerminalPage::_FindPackageAsync(hstring query)
    {
        const PackageManager packageManager = WindowsPackageManagerFactory::CreatePackageManager();
        PackageCatalogReference catalogRef{
            packageManager.GetPredefinedPackageCatalog(PredefinedPackageCatalog::OpenWindowsCatalog)
        };
        catalogRef.PackageCatalogBackgroundUpdateInterval(std::chrono::hours(24));

        ConnectResult connectResult{ nullptr };
        for (int retries = 0;;)
        {
            connectResult = catalogRef.Connect();
            if (connectResult.Status() == ConnectResultStatus::Ok)
            {
                break;
            }

            if (++retries == 3)
            {
                co_return nullptr;
            }
        }

        PackageCatalog catalog = connectResult.PackageCatalog();
        PackageMatchFilter filter = WindowsPackageManagerFactory::CreatePackageMatchFilter();
        filter.Value(query);
        filter.Field(PackageMatchField::Command);
        filter.Option(PackageFieldMatchOption::Equals);

        FindPackagesOptions options = WindowsPackageManagerFactory::CreateFindPackagesOptions();
        options.Filters().Append(filter);
        options.ResultLimit(20);

        const auto result = co_await catalog.FindPackagesAsync(options);
        const IVectorView<MatchResult> pkgList = result.Matches();
        co_return pkgList;
    }

    Windows::Foundation::IAsyncAction TerminalPage::_SearchMissingCommandHandler(const IInspectable /*sender*/, const Microsoft::Terminal::Control::SearchMissingCommandEventArgs args)
    {
        if (!Feature_QuickFix::IsEnabled())
        {
            co_return;
        }

        const auto weak = get_weak();
        const auto dispatcher = Dispatcher();

        // All of the code until resume_foreground is static and
        // doesn't touch `this`, so we don't need weak/strong_ref.
        co_await winrt::resume_background();

        // no packages were found, nothing to suggest
        const auto pkgList = co_await _FindPackageAsync(args.MissingCommand());
        if (!pkgList || pkgList.Size() == 0)
        {
            co_return;
        }

        std::vector<hstring> suggestions;
        suggestions.reserve(pkgList.Size());
        for (const auto& pkg : pkgList)
        {
            // --id and --source ensure we don't collide with another package catalog
            suggestions.emplace_back(fmt::format(FMT_COMPILE(L"winget install --id {} -s winget"), pkg.CatalogPackage().Id()));
        }

        co_await wil::resume_foreground(dispatcher);
        const auto strong = weak.get();
        if (!strong)
        {
            co_return;
        }

        auto term = _GetActiveControl();
        if (!term)
        {
            co_return;
        }
        term.UpdateWinGetSuggestions(single_threaded_vector<hstring>(std::move(suggestions)));
        term.RefreshQuickFixMenu();
    }

    void TerminalPage::_WindowSizeChanged(const IInspectable sender, const Microsoft::Terminal::Control::WindowSizeChangedEventArgs args)
    {
        // Raise if:
        // - Not in quake mode
        // - Not in fullscreen
        // - Only one tab exists
        // - Only one pane exists
        // else:
        // - Reset conpty to its original size back
        if (!WindowProperties().IsQuakeWindow() && !Fullscreen() &&
            NumberOfTabs() == 1 && _GetFocusedTabImpl()->GetLeafPaneCount() == 1)
        {
            WindowSizeChanged.raise(*this, args);
        }
        else if (const auto& control{ sender.try_as<TermControl>() })
        {
            const auto& connection = control.Connection();

            if (const auto& conpty{ connection.try_as<TerminalConnection::ConptyConnection>() })
            {
                conpty.ResetSize();
            }
        }
    }

    void TerminalPage::_copyToClipboard(const IInspectable, const WriteToClipboardEventArgs args) const
    {
        if (const auto clipboard = clipboard::open(_hostingHwnd.value_or(nullptr)))
        {
            const auto plain = args.Plain();
            const auto html = args.Html();
            const auto rtf = args.Rtf();

            clipboard::write(
                { plain.data(), plain.size() },
                { reinterpret_cast<const char*>(html.data()), html.size() },
                { reinterpret_cast<const char*>(rtf.data()), rtf.size() });
        }
    }

    // Method Description:
    // - Paste text from the Windows Clipboard to the focused terminal
    void TerminalPage::_PasteText()
    {
        if (const auto& control{ _GetActiveControl() })
        {
            control.PasteTextFromClipboard();
        }
    }

    // Function Description:
    // - Called when the settings button is clicked. ShellExecutes the settings
    //   file, as to open it in the default editor for .json files. Does this in
    //   a background thread, as to not hang/crash the UI thread.
    safe_void_coroutine TerminalPage::_LaunchSettings(const SettingsTarget target)
    {
        if (target == SettingsTarget::SettingsUI)
        {
            OpenSettingsUI();
        }
        else
        {
            // This will switch the execution of the function to a background (not
            // UI) thread. This is IMPORTANT, because the Windows.Storage API's
            // (used for retrieving the path to the file) will crash on the UI
            // thread, because the main thread is a STA.
            //
            // NOTE: All remaining code of this function doesn't touch `this`, so we don't need weak/strong_ref.
            // NOTE NOTE: Don't touch `this` when you make changes here.
            co_await winrt::resume_background();

            auto openFile = [](const auto& filePath) {
                HINSTANCE res = ShellExecute(nullptr, nullptr, filePath.c_str(), nullptr, nullptr, SW_SHOW);
                if (static_cast<int>(reinterpret_cast<uintptr_t>(res)) <= 32)
                {
                    ShellExecute(nullptr, nullptr, L"notepad", filePath.c_str(), nullptr, SW_SHOW);
                }
            };

            auto openFolder = [](const auto& filePath) {
                HINSTANCE res = ShellExecute(nullptr, nullptr, filePath.c_str(), nullptr, nullptr, SW_SHOW);
                if (static_cast<int>(reinterpret_cast<uintptr_t>(res)) <= 32)
                {
                    ShellExecute(nullptr, nullptr, L"open", filePath.c_str(), nullptr, SW_SHOW);
                }
            };

            switch (target)
            {
            case SettingsTarget::DefaultsFile:
                openFile(CascadiaSettings::DefaultSettingsPath());
                break;
            case SettingsTarget::SettingsFile:
                openFile(CascadiaSettings::SettingsPath());
                break;
            case SettingsTarget::Directory:
                openFolder(CascadiaSettings::SettingsDirectory());
                break;
            case SettingsTarget::AllFiles:
                openFile(CascadiaSettings::DefaultSettingsPath());
                openFile(CascadiaSettings::SettingsPath());
                break;
            }
        }
    }

    // Method Description:
    // - Responds to the TabView control's Tab Closing event by removing
    //      the indicated tab from the set and focusing another one.
    //      The event is cancelled so App maintains control over the
    //      items in the tabview.
    // Arguments:
    // - sender: the control that originated this event
    // - eventArgs: the event's constituent arguments
    void TerminalPage::_OnTabCloseRequested(const IInspectable& /*sender*/, const MUX::Controls::TabViewTabCloseRequestedEventArgs& eventArgs)
    {
        const auto tabViewItem = eventArgs.Tab();
        if (auto tab{ _GetTabByTabViewItem(tabViewItem) })
        {
            _HandleCloseTabRequested(tab);
        }
    }

    TermControl TerminalPage::_CreateNewControlAndContent(const Settings::TerminalSettingsCreateResult& settings, const ITerminalConnection& connection)
    {
        // Do any initialization that needs to apply to _every_ TermControl we
        // create here.
        const auto content = _manager.CreateCore(*settings.DefaultSettings(), settings.UnfocusedSettings().try_as<IControlAppearance>(), connection);
        const TermControl control{ content };
        return _SetupControl(control);
    }

    TermControl TerminalPage::_AttachControlToContent(const uint64_t& contentId)
    {
        if (const auto& content{ _manager.TryLookupCore(contentId) })
        {
            // We have to pass in our current keybindings, because that's an
            // object that belongs to this TerminalPage, on this thread. If we
            // don't, then when we move the content to another thread, and it
            // tries to handle a key, it'll callback on the original page's
            // stack, inevitably resulting in a wrong_thread
            return _SetupControl(TermControl::NewControlByAttachingContent(content));
        }
        return nullptr;
    }

    TermControl TerminalPage::_SetupControl(const TermControl& term)
    {
        // GH#12515: ConPTY assumes it's hidden at the start. If we're not, let it know now.
        if (_visible)
        {
            term.WindowVisibilityChanged(_visible);
        }

        // Even in the case of re-attaching content from another window, this
        // will correctly update the control's owning HWND
        if (_hostingHwnd.has_value())
        {
            term.OwningHwnd(reinterpret_cast<uint64_t>(*_hostingHwnd));
        }

        term.KeyBindings(*_bindings);

        _RegisterTerminalEvents(term);
        return term;
    }

    // Method Description:
    // - Creates a pane and returns a shared_ptr to it
    // - The caller should handle where the pane goes after creation,
    //   either to split an already existing pane or to create a new tab with it
    // Arguments:
    // - newTerminalArgs: an object that may contain a blob of parameters to
    //   control which profile is created and with possible other
    //   configurations. See CascadiaSettings::BuildSettings for more details.
    // - sourceTab: an optional tab reference that indicates that the created
    //   pane should be a duplicate of the tab's focused pane
    // - existingConnection: optionally receives a connection from the outside
    //   world instead of attempting to create one
    // Return Value:
    // - If the newTerminalArgs required us to open the pane as a new elevated
    //   connection, then we'll return nullptr. Otherwise, we'll return a new
    //   Pane for this connection.
    std::shared_ptr<Pane> TerminalPage::_MakeTerminalPane(const NewTerminalArgs& newTerminalArgs,
                                                          const winrt::TerminalApp::Tab& sourceTab,
                                                          TerminalConnection::ITerminalConnection existingConnection)
    {
        // First things first - Check for making a pane from content ID.
        if (newTerminalArgs &&
            newTerminalArgs.ContentId() != 0)
        {
            // Don't need to worry about duplicating or anything - we'll
            // serialize the actual profile's GUID along with the content guid.
            const auto& profile = _settings.GetProfileForArgs(newTerminalArgs);
            const auto control = _AttachControlToContent(newTerminalArgs.ContentId());
            auto paneContent{ winrt::make<TerminalPaneContent>(profile, _terminalSettingsCache, control) };
            return std::make_shared<Pane>(paneContent);
        }

        Settings::TerminalSettingsCreateResult controlSettings{ nullptr };
        Profile profile{ nullptr };

        if (const auto& tabImpl{ _GetTabImpl(sourceTab) })
        {
            profile = tabImpl->GetFocusedProfile();
            if (profile)
            {
                // TODO GH#5047 If we cache the NewTerminalArgs, we no longer need to do this.
                profile = GetClosestProfileForDuplicationOfProfile(profile);
                controlSettings = Settings::TerminalSettings::CreateWithProfile(_settings, _currentWindowSettings(), profile);
                const auto workingDirectory = tabImpl->GetActiveTerminalControl().WorkingDirectory();
                if (Utils::IsValidDirectory(workingDirectory.c_str()))
                {
                    controlSettings.DefaultSettings()->StartingDirectory(workingDirectory);
                }
            }
        }
        if (!profile)
        {
            profile = _settings.GetProfileForArgs(newTerminalArgs);
            controlSettings = Settings::TerminalSettings::CreateWithNewTerminalArgs(_settings, _currentWindowSettings(), newTerminalArgs);
        }

        // Try to handle auto-elevation
        if (_maybeElevate(newTerminalArgs, controlSettings, profile))
        {
            return nullptr;
        }

        const auto sessionId = controlSettings.DefaultSettings()->SessionId();
        const auto hasSessionId = sessionId != winrt::guid{};

        auto connection = existingConnection ? existingConnection : _CreateConnectionFromSettings(profile, *controlSettings.DefaultSettings(), hasSessionId);
        if (existingConnection)
        {
            connection.Resize(controlSettings.DefaultSettings()->InitialRows(), controlSettings.DefaultSettings()->InitialCols());
        }

        TerminalConnection::ITerminalConnection debugConnection{ nullptr };
        if (_settings.GlobalSettings().DebugFeaturesEnabled())
        {
            const auto window = CoreWindow::GetForCurrentThread();
            const auto rAltState = window.GetKeyState(VirtualKey::RightMenu);
            const auto lAltState = window.GetKeyState(VirtualKey::LeftMenu);
            const auto bothAltsPressed = WI_IsFlagSet(lAltState, CoreVirtualKeyStates::Down) &&
                                         WI_IsFlagSet(rAltState, CoreVirtualKeyStates::Down);
            if (bothAltsPressed)
            {
                std::tie(connection, debugConnection) = OpenDebugTapConnection(connection);
            }
        }

        const auto control = _CreateNewControlAndContent(controlSettings, connection);

        if (hasSessionId)
        {
            using namespace std::string_view_literals;

            const auto settingsDir = CascadiaSettings::SettingsDirectory();
            const auto admin = IsRunningElevated();
            const auto filenamePrefix = admin ? L"elevated_"sv : L"buffer_"sv;
            const auto path = fmt::format(FMT_COMPILE(L"{}\\{}{}.txt"), settingsDir, filenamePrefix, sessionId);
            control.RestoreFromPath(path);
        }

        auto paneContent{ winrt::make<TerminalPaneContent>(profile, _terminalSettingsCache, control) };

        auto resultPane = std::make_shared<Pane>(paneContent);

        if (debugConnection) // this will only be set if global debugging is on and tap is active
        {
            auto newControl = _CreateNewControlAndContent(controlSettings, debugConnection);
            // Split (auto) with the debug tap.
            auto debugContent{ winrt::make<TerminalPaneContent>(profile, _terminalSettingsCache, newControl) };
            auto debugPane = std::make_shared<Pane>(debugContent);

            // Since we're doing this split directly on the pane (instead of going through Tab,
            // we need to handle the panes 'active' states

            // Set the pane we're splitting to active (otherwise Split will not do anything)
            resultPane->SetActive();
            auto [original, _] = resultPane->Split(SplitDirection::Automatic, 0.5f, debugPane);

            // Set the non-debug pane as active
            resultPane->ClearActive();
            original->SetActive();
        }

        return resultPane;
    }

    // NOTE: callers of _MakePane should be able to accept nullptr as a return
    // value gracefully.
    // Method Description:
    // - The directory a new terminal should start in when nothing asked for
    //   one explicitly: the focused tab's live working directory (shell
    //   integration first, then the directory its process tree runs in),
    //   else the selected project's directory. Empty means "use the profile".
    winrt::hstring TerminalPage::_InheritedStartingDirectory()
    {
        if (const auto focused{ _GetFocusedTabImpl() })
        {
            winrt::hstring cwd;
            if (const auto control{ focused->GetActiveTerminalControl() })
            {
                cwd = control.WorkingDirectory();
            }
            if (cwd.empty())
            {
                cwd = focused->WorkingDirectory();
            }
            if (!cwd.empty() && Utils::IsValidDirectory(cwd.c_str()))
            {
                return cwd;
            }
        }
        return _activeProjectCwd;
    }

    std::shared_ptr<Pane> TerminalPage::_MakePane(const INewContentArgs& contentArgs,
                                                  const winrt::TerminalApp::Tab& sourceTab,
                                                  TerminalConnection::ITerminalConnection existingConnection)

    {
        auto newTerminalArgs{ contentArgs.try_as<NewTerminalArgs>() };
        if (contentArgs == nullptr || newTerminalArgs != nullptr || contentArgs.Type().empty())
        {
            // A brand-new terminal (not a duplicate, not attached content, no
            // directory asked for) opens where the user currently is.
            if (!sourceTab && !existingConnection && (!newTerminalArgs || (newTerminalArgs.ContentId() == 0 && newTerminalArgs.StartingDirectory().empty())))
            {
                if (const auto inherited{ _InheritedStartingDirectory() }; !inherited.empty())
                {
                    if (!newTerminalArgs)
                    {
                        newTerminalArgs = NewTerminalArgs{};
                    }
                    newTerminalArgs.StartingDirectory(inherited);
                }
            }
            // Terminals are of course special, and have to deal with debug taps, duplicating the tab, etc.
            return _MakeTerminalPane(newTerminalArgs, sourceTab, existingConnection);
        }

        IPaneContent content{ nullptr };

        const auto& paneType{ contentArgs.Type() };
        if (paneType == L"scratchpad")
        {
            const auto& scratchPane{ winrt::make_self<ScratchpadContent>() };

            // This is maybe a little wacky - add our key event handler to the pane
            // we made. So that we can get actions for keys that the content didn't
            // handle.
            scratchPane->GetRoot().KeyDown({ get_weak(), &TerminalPage::_KeyDownHandler });

            content = *scratchPane;
        }
        else if (paneType == L"settings")
        {
            content = _makeSettingsContent();
        }
        else if (paneType == L"snippets")
        {
            // Prevent the user from opening a bunch of snippets panes.
            //
            // Look at the focused tab, and if it already has one, then just focus it.
            if (const auto& focusedTab{ _GetFocusedTabImpl() })
            {
                const auto rootPane{ focusedTab->GetRootPane() };
                const bool found = rootPane == nullptr ? false : rootPane->WalkTree([](const auto& p) -> bool {
                    if (const auto& snippets{ p->GetContent().try_as<SnippetsPaneContent>() })
                    {
                        snippets->Focus(FocusState::Programmatic);
                        return true;
                    }
                    return false;
                });
                // Bail out if we already found one.
                if (found)
                {
                    return nullptr;
                }
            }

            const auto& tasksContent{ winrt::make_self<SnippetsPaneContent>() };
            tasksContent->UpdateSettings(_settings, _currentWindowSettings());
            tasksContent->GetRoot().KeyDown({ this, &TerminalPage::_KeyDownHandler });
            tasksContent->DispatchCommandRequested({ this, &TerminalPage::_OnDispatchCommandRequested });
            if (const auto& termControl{ _GetActiveControl() })
            {
                tasksContent->SetLastActiveControl(termControl);
            }

            content = *tasksContent;
        }
        else if (paneType == L"x-markdown")
        {
            if (Feature_MarkdownPane::IsEnabled())
            {
                const auto& markdownContent{ winrt::make_self<MarkdownPaneContent>(L"") };
                markdownContent->UpdateSettings(_settings, _currentWindowSettings());
                markdownContent->GetRoot().KeyDown({ this, &TerminalPage::_KeyDownHandler });

                // This one doesn't use DispatchCommand, because we don't create
                // Command's freely at runtime like we do with just plain old actions.
                markdownContent->DispatchActionRequested([weak = get_weak()](const auto& sender, const auto& actionAndArgs) {
                    if (const auto& page{ weak.get() })
                    {
                        page->_actionDispatch->DoAction(sender, actionAndArgs);
                    }
                });
                if (const auto& termControl{ _GetActiveControl() })
                {
                    markdownContent->SetLastActiveControl(termControl);
                }

                content = *markdownContent;
            }
        }

        assert(content);

        return std::make_shared<Pane>(content);
    }

    void TerminalPage::_restartPaneConnection(
        const TerminalApp::TerminalPaneContent& paneContent,
        const winrt::Windows::Foundation::IInspectable&)
    {
        // Note: callers are likely passing in `nullptr` as the args here, as
        // the TermControl.RestartTerminalRequested event doesn't actually pass
        // any args upwards itself. If we ever change this, make sure you check
        // for nulls
        if (const auto& connection{ _duplicateConnectionForRestart(paneContent) })
        {
            // Reset the terminal's VT state before attaching the new connection.
            // The previous client may have left dirty modes (e.g., bracketed
            // paste, mouse tracking, alternate buffer, kitty keyboard) that
            // would corrupt input/output for the new shell process.
            const auto& termControl = paneContent.GetTermControl();
            termControl.HardResetWithoutErase();
            termControl.Connection(connection);
            connection.Start();
        }
    }

    // Method Description:
    // - Sets background image and applies its settings (stretch, opacity and alignment)
    // - Checks path validity
    // Arguments:
    // - newAppearance
    // Return Value:
    // - <none>
    void TerminalPage::_SetBackgroundImage(const winrt::Microsoft::Terminal::Settings::Model::IAppearanceConfig& newAppearance)
    {
        if (!_currentWindowSettings().UseBackgroundImageForWindow())
        {
            _tabContent.Background(nullptr);
            return;
        }

        const auto path = newAppearance.BackgroundImagePath().Resolved();
        if (path.empty())
        {
            _tabContent.Background(nullptr);
            return;
        }

        Windows::Foundation::Uri imageUri{ nullptr };
        try
        {
            imageUri = Windows::Foundation::Uri{ path };
        }
        catch (...)
        {
            LOG_CAUGHT_EXCEPTION();
            _tabContent.Background(nullptr);
            return;
        }
        // Check if the image brush is already pointing to the image
        // in the modified settings; if it isn't (or isn't there),
        // set a new image source for the brush

        auto brush = _tabContent.Background().try_as<Media::ImageBrush>();
        Media::Imaging::BitmapImage imageSource = brush == nullptr ? nullptr : brush.ImageSource().try_as<Media::Imaging::BitmapImage>();

        if (imageSource == nullptr ||
            imageSource.UriSource() == nullptr ||
            !imageSource.UriSource().Equals(imageUri))
        {
            Media::ImageBrush b{};
            // Note that BitmapImage handles the image load asynchronously,
            // which is especially important since the image
            // may well be both large and somewhere out on the
            // internet.
            Media::Imaging::BitmapImage image(imageUri);
            b.ImageSource(image);
            _tabContent.Background(b);
        }

        // Pull this into a separate block. If the image didn't change, but the
        // properties of the image did, we should still update them.
        if (const auto newBrush{ _tabContent.Background().try_as<Media::ImageBrush>() })
        {
            newBrush.Stretch(newAppearance.BackgroundImageStretchMode());
            newBrush.Opacity(newAppearance.BackgroundImageOpacity());
        }
    }

    // Method Description:
    // - Hook up keybindings, and refresh the UI of the terminal.
    //   This includes update the settings of all the tabs according
    //   to their profiles, update the title and icon of each tab, and
    //   finally create the tab flyout
    void TerminalPage::_RefreshUIForSettingsReload()
    {
        // Re-wire the keybindings to their handlers, as we'll have created a
        // new AppKeyBindings object.
        _HookupKeyBindings(_settings.ActionMap());

        // Refresh UI elements

        // Recreate the TerminalSettings cache here. We'll use that as we're
        // updating terminal panes, so that we don't have to build a _new_
        // TerminalSettings for every profile we update - we can just look them
        // up the previous ones we built.
        _terminalSettingsCache->Reset(_settings, _currentWindowSettings());

        const auto windowSettings = _currentWindowSettings();
        for (const auto& tab : _tabs)
        {
            if (auto tabImpl{ _GetTabImpl(tab) })
            {
                // Let the tab know that there are new settings. It's up to each content to decide what to do with them.
                tabImpl->UpdateSettings(_settings, windowSettings);

                // Update the icon of the tab for the currently focused profile in that tab.
                // Only do this for TerminalTabs. Other types of tabs won't have multiple panes
                // and profiles so the Title and Icon will be set once and only once on init.
                _UpdateTabIcon(*tabImpl);

                // Force the TerminalTab to re-grab its currently active control's title.
                tabImpl->UpdateTitle();
            }

            auto tabImpl{ winrt::get_self<Tab>(tab) };
            tabImpl->SetActionMap(_settings.ActionMap());
        }

        if (const auto focusedTab{ _GetFocusedTabImpl() })
        {
            if (const auto profile{ focusedTab->GetFocusedProfile() })
            {
                _SetBackgroundImage(profile.DefaultAppearance());
            }
        }

        // repopulate the new tab button's flyout with entries for each
        // profile, which might have changed
        _UpdateTabWidthMode();
        _CreateNewTabFlyout();

        // Reload the current value of alwaysOnTop from the settings file. This
        // will let the user hot-reload this setting, but any runtime changes to
        // the alwaysOnTop setting will be lost.
        _isAlwaysOnTop = _currentWindowSettings().AlwaysOnTop();
        AlwaysOnTopChanged.raise(*this, nullptr);

        _showTabsFullscreen = _currentWindowSettings().ShowTabsFullscreen();

        // Settings AllowDependentAnimations will affect whether animations are
        // enabled application-wide, so we don't need to check it each time we
        // want to create an animation.
        WUX::Media::Animation::Timeline::AllowDependentAnimations(!_currentWindowSettings().DisableAnimations());

        _tabRow.ShowElevationShield(IsRunningElevated() && _currentWindowSettings().ShowAdminShield());

        // Apply the ShowWorkspacesButton theme setting.
        if (const auto theme = _settings.GlobalSettings().CurrentTheme(_currentWindowSettings()))
        {
            _tabRow.ShowWorkspacesButton(theme.Window() ? theme.Window().ShowWorkspacesButton() : true);
        }

        Media::SolidColorBrush transparent{ Windows::UI::Colors::Transparent() };
        _tabView.Background(transparent);

        ////////////////////////////////////////////////////////////////////////
        // Begin Theme handling
        _updateThemeColors();

        _updateAllTabCloseButtons();

        // The user may have changed the "show title in titlebar" setting.
        TitleChanged.raise(*this, nullptr);
    }

    void TerminalPage::_updateAllTabCloseButtons()
    {
        // Update the state of the CloseButtonOverlayMode property of
        // our TabView, to match the tab.showCloseButton property in the theme.
        //
        // Also update every tab's individual IsClosable to match the same property.
        const auto theme = _settings.GlobalSettings().CurrentTheme(_currentWindowSettings());
        const auto visibility = (theme && theme.Tab()) ?
                                    theme.Tab().ShowCloseButton() :
                                    Settings::Model::TabCloseButtonVisibility::Always;

        _tabItemMiddleClickHookEnabled = visibility == Settings::Model::TabCloseButtonVisibility::Never;

        for (const auto& tab : _tabs)
        {
            tab.CloseButtonVisibility(visibility);
        }

        switch (visibility)
        {
        case Settings::Model::TabCloseButtonVisibility::Never:
            _tabView.CloseButtonOverlayMode(MUX::Controls::TabViewCloseButtonOverlayMode::Auto);
            break;
        case Settings::Model::TabCloseButtonVisibility::Hover:
            _tabView.CloseButtonOverlayMode(MUX::Controls::TabViewCloseButtonOverlayMode::OnPointerOver);
            break;
        case Settings::Model::TabCloseButtonVisibility::ActiveOnly:
        default:
            _tabView.CloseButtonOverlayMode(MUX::Controls::TabViewCloseButtonOverlayMode::Always);
            break;
        }
    }

    // Method Description:
    // - Sets the initial actions to process on startup. We'll make a copy of
    //   this list, and process these actions when we're loaded.
    // - This function will have no effective result after Create() is called.
    // Arguments:
    // - actions: a list of Actions to process on startup.
    // Return Value:
    // - <none>
    void TerminalPage::SetStartupActions(std::vector<ActionAndArgs> actions)
    {
        _startupActions = std::move(actions);
    }

    void TerminalPage::SetStartupConnection(ITerminalConnection connection)
    {
        _startupConnection = std::move(connection);
    }

    winrt::TerminalApp::IDialogPresenter TerminalPage::DialogPresenter() const
    {
        return _dialogPresenter.get();
    }

    void TerminalPage::DialogPresenter(winrt::TerminalApp::IDialogPresenter dialogPresenter)
    {
        _dialogPresenter = dialogPresenter;
    }

    // Method Description:
    // - Get the combined taskbar state for the page. This is the combination of
    //   all the states of all the tabs, which are themselves a combination of
    //   all their panes. Taskbar states are given a priority based on the rules
    //   in:
    //   https://docs.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-itaskbarlist3-setprogressstate
    //   under "How the Taskbar Button Chooses the Progress Indicator for a Group"
    // Arguments:
    // - <none>
    // Return Value:
    // - A TaskbarState object representing the combined taskbar state and
    //   progress percentage of all our tabs.
    winrt::TerminalApp::TaskbarState TerminalPage::TaskbarState() const
    {
        auto state{ winrt::make<winrt::TerminalApp::implementation::TaskbarState>() };

        for (const auto& tab : _tabs)
        {
            if (auto tabImpl{ _GetTabImpl(tab) })
            {
                auto tabState{ tabImpl->GetCombinedTaskbarState() };
                // lowest priority wins
                if (tabState.Priority() < state.Priority())
                {
                    state = tabState;
                }
            }
        }

        return state;
    }

    // Method Description:
    // - This is the method that App will call when the titlebar
    //   has been clicked. It dismisses any open flyouts.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::TitlebarClicked()
    {
        if (_newTabButton && _newTabButton.Flyout())
        {
            _newTabButton.Flyout().Hide();
        }
        _DismissTabContextMenus();
    }

    // Method Description:
    // - Notifies all attached console controls that the visibility of the
    //   hosting window has changed. The underlying PTYs may need to know this
    //   for the proper response to `::GetConsoleWindow()` from a Win32 console app.
    // Arguments:
    // - showOrHide: Show is true; hide is false.
    // Return Value:
    // - <none>
    void TerminalPage::WindowVisibilityChanged(const bool showOrHide)
    {
        _visible = showOrHide;
        for (const auto& tab : _tabs)
        {
            if (auto tabImpl{ _GetTabImpl(tab) })
            {
                // Manually enumerate the panes in each tab; this will let us recycle TerminalSettings
                // objects but only have to iterate one time.
                tabImpl->GetRootPane()->WalkTree([&](auto&& pane) {
                    if (auto control = pane->GetTerminalControl())
                    {
                        control.WindowVisibilityChanged(showOrHide);
                    }
                });
            }
        }
    }

    // Method Description:
    // - Called when the user tries to do a search using keybindings.
    //   This will tell the active terminal control of the passed tab
    //   to create a search box and enable find process.
    // Arguments:
    // - tab: the tab where the search box should be created
    // Return Value:
    // - <none>
    void TerminalPage::_Find(const Tab& tab)
    {
        if (const auto& control{ tab.GetActiveTerminalControl() })
        {
            control.CreateSearchBoxControl();
        }
    }

    // Method Description:
    // - Toggles borderless mode. Hides the tab row, and raises our
    //   FocusModeChanged event.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::ToggleFocusMode()
    {
        SetFocusMode(!_isInFocusMode);
    }

    void TerminalPage::SetFocusMode(const bool inFocusMode)
    {
        const auto newInFocusMode = inFocusMode;
        if (newInFocusMode != FocusMode())
        {
            _isInFocusMode = newInFocusMode;
            _UpdateTabView();
            FocusModeChanged.raise(*this, nullptr);
        }
    }

    // Method Description:
    // - Toggles fullscreen mode. Hides the tab row, and raises our
    //   FullscreenChanged event.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::ToggleFullscreen()
    {
        SetFullscreen(!_isFullscreen);
    }

    // Method Description:
    // - Toggles always on top mode. Raises our AlwaysOnTopChanged event.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::ToggleAlwaysOnTop()
    {
        _isAlwaysOnTop = !_isAlwaysOnTop;
        AlwaysOnTopChanged.raise(*this, nullptr);
    }

    // Method Description:
    // - Sets the tab split button color when a new tab color is selected
    // Arguments:
    // - color: The color of the newly selected tab, used to properly calculate
    //          the foreground color of the split button (to match the font
    //          color of the tab)
    // - accentColor: the actual color we are going to use to paint the tab row and
    //                split button, so that there is some contrast between the tab
    //                and the non-client are behind it
    // Return Value:
    // - <none>
    void TerminalPage::_SetNewTabButtonColor(const til::color color, const til::color accentColor)
    {
        constexpr auto lightnessThreshold = 0.6f;
        // TODO GH#3327: Look at what to do with the tab button when we have XAML theming
        const auto isBrightColor = ColorFix::GetLightness(color) >= lightnessThreshold;
        const auto isLightAccentColor = ColorFix::GetLightness(accentColor) >= lightnessThreshold;
        const auto hoverColorAdjustment = isLightAccentColor ? -0.05f : 0.05f;
        const auto pressedColorAdjustment = isLightAccentColor ? -0.1f : 0.1f;

        const auto foregroundColor = isBrightColor ? Colors::Black() : Colors::White();
        const auto hoverColor = til::color{ ColorFix::AdjustLightness(accentColor, hoverColorAdjustment) };
        const auto pressedColor = til::color{ ColorFix::AdjustLightness(accentColor, pressedColorAdjustment) };

        Media::SolidColorBrush backgroundBrush{ accentColor };
        Media::SolidColorBrush backgroundHoverBrush{ hoverColor };
        Media::SolidColorBrush backgroundPressedBrush{ pressedColor };
        Media::SolidColorBrush foregroundBrush{ foregroundColor };

        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonBackground"), backgroundBrush);
        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonBackgroundPointerOver"), backgroundHoverBrush);
        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonBackgroundPressed"), backgroundPressedBrush);

        // Load bearing: The SplitButton uses SplitButtonForegroundSecondary for
        // the secondary button, but {TemplateBinding Foreground} for the
        // primary button.
        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonForeground"), foregroundBrush);
        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonForegroundPointerOver"), foregroundBrush);
        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonForegroundPressed"), foregroundBrush);
        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonForegroundSecondary"), foregroundBrush);
        _newTabButton.Resources().Insert(winrt::box_value(L"SplitButtonForegroundSecondaryPressed"), foregroundBrush);

        _newTabButton.Background(backgroundBrush);
        _newTabButton.Foreground(foregroundBrush);

        // This is just like what we do in Tab::_RefreshVisualState. We need
        // to manually toggle the visual state, so the setters in the visual
        // state group will re-apply, and set our currently selected colors in
        // the resources.
        VisualStateManager::GoToState(_newTabButton, L"FlyoutOpen", true);
        VisualStateManager::GoToState(_newTabButton, L"Normal", true);
    }

    // Method Description:
    // - Clears the tab split button color to a system color
    //   (or white if none is found) when the tab's color is cleared
    // - Clears the tab row color to a system color
    //   (or white if none is found) when the tab's color is cleared
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::_ClearNewTabButtonColor()
    {
        // TODO GH#3327: Look at what to do with the tab button when we have XAML theming
        winrt::hstring keys[] = {
            L"SplitButtonBackground",
            L"SplitButtonBackgroundPointerOver",
            L"SplitButtonBackgroundPressed",
            L"SplitButtonForeground",
            L"SplitButtonForegroundSecondary",
            L"SplitButtonForegroundPointerOver",
            L"SplitButtonForegroundPressed",
            L"SplitButtonForegroundSecondaryPressed"
        };

        // simply clear any of the colors in the split button's dict
        for (auto keyString : keys)
        {
            auto key = winrt::box_value(keyString);
            if (_newTabButton.Resources().HasKey(key))
            {
                _newTabButton.Resources().Remove(key);
            }
        }

        const auto res = Application::Current().Resources();

        const auto defaultBackgroundKey = winrt::box_value(L"TabViewItemHeaderBackground");
        const auto defaultForegroundKey = winrt::box_value(L"SystemControlForegroundBaseHighBrush");
        winrt::Windows::UI::Xaml::Media::SolidColorBrush backgroundBrush;
        winrt::Windows::UI::Xaml::Media::SolidColorBrush foregroundBrush;

        // TODO: Related to GH#3917 - I think if the system is set to "Dark"
        // theme, but the app is set to light theme, then this lookup still
        // returns to us the dark theme brushes. There's gotta be a way to get
        // the right brushes...
        // See also GH#5741
        if (res.HasKey(defaultBackgroundKey))
        {
            auto obj = res.Lookup(defaultBackgroundKey);
            backgroundBrush = obj.try_as<winrt::Windows::UI::Xaml::Media::SolidColorBrush>();
        }
        else
        {
            backgroundBrush = winrt::Windows::UI::Xaml::Media::SolidColorBrush{ winrt::Windows::UI::Colors::Black() };
        }

        if (res.HasKey(defaultForegroundKey))
        {
            auto obj = res.Lookup(defaultForegroundKey);
            foregroundBrush = obj.try_as<winrt::Windows::UI::Xaml::Media::SolidColorBrush>();
        }
        else
        {
            foregroundBrush = winrt::Windows::UI::Xaml::Media::SolidColorBrush{ winrt::Windows::UI::Colors::White() };
        }

        _newTabButton.Background(backgroundBrush);
        _newTabButton.Foreground(foregroundBrush);
    }

    // Function Description:
    // - This is a helper method to get the commandline out of a
    //   ExecuteCommandline action, break it into subcommands, and attempt to
    //   parse it into actions. This is used by _HandleExecuteCommandline for
    //   processing commandlines in the current WT window.
    // Arguments:
    // - args: the ExecuteCommandlineArgs to synthesize a list of startup actions for.
    // Return Value:
    // - an empty list if we failed to parse; otherwise, a list of actions to execute.
    std::vector<ActionAndArgs> TerminalPage::ConvertExecuteCommandlineToActions(const ExecuteCommandlineArgs& args)
    {
        ::TerminalApp::AppCommandlineArgs appArgs;
        if (appArgs.ParseArgs(args) == 0)
        {
            return appArgs.GetStartupActions();
        }

        return {};
    }

    void TerminalPage::_FocusActiveControl(IInspectable /*sender*/,
                                           IInspectable /*eventArgs*/)
    {
        _FocusCurrentTab(false);
    }

    bool TerminalPage::FocusMode() const
    {
        return _isInFocusMode;
    }

    bool TerminalPage::Fullscreen() const
    {
        return _isFullscreen;
    }

    // Method Description:
    // - Returns true if we're currently in "Always on top" mode. When we're in
    //   always on top mode, the window should be on top of all other windows.
    //   If multiple windows are all "always on top", they'll maintain their own
    //   z-order, with all the windows on top of all other non-topmost windows.
    // Arguments:
    // - <none>
    // Return Value:
    // - true if we should be in "always on top" mode
    bool TerminalPage::AlwaysOnTop() const
    {
        return _isAlwaysOnTop;
    }

    // Method Description:
    // - Returns true if the tab row should be visible when we're in full screen
    //   state.
    // Arguments:
    // - <none>
    // Return Value:
    // - true if the tab row should be visible in full screen state
    bool TerminalPage::ShowTabsFullscreen() const
    {
        return _showTabsFullscreen;
    }

    // Method Description:
    // - Updates the visibility of the tab row when in fullscreen state.
    void TerminalPage::SetShowTabsFullscreen(bool newShowTabsFullscreen)
    {
        if (_showTabsFullscreen == newShowTabsFullscreen)
        {
            return;
        }

        _showTabsFullscreen = newShowTabsFullscreen;

        // if we're currently in fullscreen, update tab view to make
        // sure tabs are given the correct visibility
        if (_isFullscreen)
        {
            _UpdateTabView();
        }
    }

    void TerminalPage::SetFullscreen(bool newFullscreen)
    {
        if (_isFullscreen == newFullscreen)
        {
            return;
        }
        _isFullscreen = newFullscreen;
        _UpdateTabView();
        FullscreenChanged.raise(*this, nullptr);
    }

    // Method Description:
    // - Updates the page's state for isMaximized when the window changes externally.
    void TerminalPage::Maximized(bool newMaximized)
    {
        _isMaximized = newMaximized;
    }

    // Method Description:
    // - Asks the window to change its maximized state.
    void TerminalPage::RequestSetMaximized(bool newMaximized)
    {
        if (_isMaximized == newMaximized)
        {
            return;
        }
        _isMaximized = newMaximized;
        ChangeMaximizeRequested.raise(*this, nullptr);
    }

    TerminalApp::IPaneContent TerminalPage::_makeSettingsContent()
    {
        if (auto app{ winrt::Windows::UI::Xaml::Application::Current().try_as<winrt::TerminalApp::App>() })
        {
            if (auto appPrivate{ winrt::get_self<implementation::App>(app) })
            {
                // Lazily load the Settings UI components so that we don't do it on startup.
                appPrivate->PrepareForSettingsUI();
            }
        }

        // Create the SUI pane content
        auto settingsContent{ winrt::make_self<SettingsPaneContent>(_settings, _currentWindowSettings()) };
        auto sui = settingsContent->SettingsUI();

        if (_hostingHwnd)
        {
            sui.SetHostingWindow(reinterpret_cast<uint64_t>(*_hostingHwnd));
        }

        // GH#8767 - let unhandled keys in the SUI try to run commands too.
        sui.KeyDown({ get_weak(), &TerminalPage::_KeyDownHandler });

        sui.OpenJson([weakThis{ get_weak() }](auto&& /*s*/, winrt::Microsoft::Terminal::Settings::Model::SettingsTarget e) {
            if (auto page{ weakThis.get() })
            {
                page->_LaunchSettings(e);
            }
        });

        sui.ShowLoadWarningsDialog([weakThis{ get_weak() }](auto&& /*s*/, const Windows::Foundation::Collections::IVectorView<winrt::Microsoft::Terminal::Settings::Model::SettingsLoadWarnings>& warnings) {
            if (auto page{ weakThis.get() })
            {
                page->ShowLoadWarningsDialog.raise(*page, warnings);
            }
        });

        return *settingsContent;
    }

    // Method Description:
    // - Creates a settings UI tab and focuses it. If there's already a settings UI tab open,
    //   just focus the existing one.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::OpenSettingsUI()
    {
        // If we're holding the settings tab's switch command, don't create a new one, switch to the existing one.
        if (!_settingsTab)
        {
            // Create the tab
            auto resultPane = std::make_shared<Pane>(_makeSettingsContent());
            _settingsTab = _CreateNewTabFromPane(resultPane);
        }
        else
        {
            _SetFocusedTab(_settingsTab);
        }
    }

    // Method Description:
    // - Returns a com_ptr to the implementation type of the given tab if it's a Tab.
    //   If the tab is not a TerminalTab, returns nullptr.
    // Arguments:
    // - tab: the projected type of a Tab
    // Return Value:
    // - If the tab is a TerminalTab, a com_ptr to the implementation type.
    //   If the tab is not a TerminalTab, nullptr
    winrt::com_ptr<Tab> TerminalPage::_GetTabImpl(const TerminalApp::Tab& tab)
    {
        winrt::com_ptr<Tab> tabImpl;
        tabImpl.copy_from(winrt::get_self<Tab>(tab));
        return tabImpl;
    }

    // Method Description:
    // - Computes the delta for scrolling the tab's viewport.
    // Arguments:
    // - scrollDirection - direction (up / down) to scroll
    // - rowsToScroll - the number of rows to scroll
    // Return Value:
    // - delta - Signed delta, where a negative value means scrolling up.
    int TerminalPage::_ComputeScrollDelta(ScrollDirection scrollDirection, const uint32_t rowsToScroll)
    {
        return scrollDirection == ScrollUp ? -1 * rowsToScroll : rowsToScroll;
    }

    // Method Description:
    // - Reads system settings for scrolling (based on the step of the mouse scroll).
    // Upon failure fallbacks to default.
    // Return Value:
    // - The number of rows to scroll or a magic value of WHEEL_PAGESCROLL
    // indicating that we need to scroll an entire view height
    uint32_t TerminalPage::_ReadSystemRowsToScroll()
    {
        uint32_t systemRowsToScroll;
        if (!SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &systemRowsToScroll, 0))
        {
            LOG_LAST_ERROR();

            // If SystemParametersInfoW fails, which it shouldn't, fall back to
            // Windows' default value.
            return DefaultRowsToScroll;
        }

        return systemRowsToScroll;
    }

    // Method Description:
    // - Displays a dialog stating the "Touch Keyboard and Handwriting Panel
    //   Service" is disabled.
    void TerminalPage::ShowKeyboardServiceWarning() const
    {
        if (!_IsMessageDismissed(InfoBarMessage::KeyboardServiceWarning))
        {
            if (const auto keyboardServiceWarningInfoBar = FindName(L"KeyboardServiceWarningInfoBar").try_as<MUX::Controls::InfoBar>())
            {
                keyboardServiceWarningInfoBar.IsOpen(true);
            }
        }
    }

    // Function Description:
    // - Helper function to get the OS-localized name for the "Touch Keyboard
    //   and Handwriting Panel Service". If we can't open up the service for any
    //   reason, then we'll just return the service's key, "TabletInputService".
    // Return Value:
    // - The OS-localized name for the TabletInputService
    winrt::hstring _getTabletServiceName()
    {
        wil::unique_schandle hManager{ OpenSCManagerW(nullptr, nullptr, 0) };

        if (LOG_LAST_ERROR_IF(!hManager.is_valid()))
        {
            return winrt::hstring{ TabletInputServiceKey };
        }

        DWORD cchBuffer = 0;
        const auto ok = GetServiceDisplayNameW(hManager.get(), TabletInputServiceKey.data(), nullptr, &cchBuffer);

        // Windows 11 doesn't have a TabletInputService.
        // (It was renamed to TextInputManagementService, because people kept thinking that a
        // service called "tablet-something" is system-irrelevant on PCs and can be disabled.)
        if (ok || GetLastError() != ERROR_INSUFFICIENT_BUFFER)
        {
            return winrt::hstring{ TabletInputServiceKey };
        }

        std::wstring buffer;
        cchBuffer += 1; // Add space for a null
        buffer.resize(cchBuffer);

        if (LOG_LAST_ERROR_IF(!GetServiceDisplayNameW(hManager.get(),
                                                      TabletInputServiceKey.data(),
                                                      buffer.data(),
                                                      &cchBuffer)))
        {
            return winrt::hstring{ TabletInputServiceKey };
        }
        return winrt::hstring{ buffer };
    }

    // Method Description:
    // - Return the fully-formed warning message for the
    //   "KeyboardServiceDisabled" InfoBar. This InfoBar is used to warn the user
    //   if the keyboard service is disabled, and uses the OS localization for
    //   the service's actual name. It's bound to the bar in XAML.
    // Return Value:
    // - The warning message, including the OS-localized service name.
    winrt::hstring TerminalPage::KeyboardServiceDisabledText()
    {
        const auto serviceName{ _getTabletServiceName() };
        const auto text{ RS_fmt(L"KeyboardServiceWarningText", serviceName) };
        return winrt::hstring{ text };
    }

    // Method Description:
    // - Update the RequestedTheme of the specified FrameworkElement and all its
    //   Parent elements. We need to do this so that we can actually theme all
    //   of the elements of the TeachingTip. See GH#9717
    // Arguments:
    // - element: The TeachingTip to set the theme on.
    // Return Value:
    // - <none>
    void TerminalPage::_UpdateTeachingTipTheme(winrt::Windows::UI::Xaml::FrameworkElement element)
    {
        auto theme{ _settings.GlobalSettings().CurrentTheme(_currentWindowSettings()) };
        auto requestedTheme{ theme.RequestedTheme() };
        while (element)
        {
            element.RequestedTheme(requestedTheme);
            element = element.Parent().try_as<winrt::Windows::UI::Xaml::FrameworkElement>();
        }
    }

    // Method Description:
    // - Display the name and ID of this window in a TeachingTip. If the window
    //   has no name, the name will be presented as "<unnamed-window>".
    // - This can be invoked by either:
    //   * An identifyWindow action, that displays the info only for the current
    //     window
    //   * An identifyWindows action, that displays the info for all windows.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::IdentifyWindow()
    {
        // If we haven't ever loaded the TeachingTip, then do so now and
        // create the toast for it.
        if (_windowIdToast == nullptr)
        {
            if (auto tip{ FindName(L"WindowIdToast").try_as<MUX::Controls::TeachingTip>() })
            {
                _windowIdToast = std::make_shared<Toast>(tip);
                // IsLightDismissEnabled == true is bugged and poorly interacts with multi-windowing.
                // It causes the tip to be immediately dismissed when another tip is opened in another window.
                tip.IsLightDismissEnabled(false);
                // Make sure to use the weak ref when setting up this callback.
                tip.Closed({ get_weak(), &TerminalPage::_FocusActiveControl });
            }
        }
        _UpdateTeachingTipTheme(WindowIdToast().try_as<winrt::Windows::UI::Xaml::FrameworkElement>());

        if (_windowIdToast != nullptr)
        {
            _windowIdToast->Open();
        }
    }

    void TerminalPage::ShowTerminalWorkingDirectory()
    {
        // If we haven't ever loaded the TeachingTip, then do so now and
        // create the toast for it.
        if (_windowCwdToast == nullptr)
        {
            if (auto tip{ FindName(L"WindowCwdToast").try_as<MUX::Controls::TeachingTip>() })
            {
                _windowCwdToast = std::make_shared<Toast>(tip);
                // Make sure to use the weak ref when setting up this
                // callback.
                tip.Closed({ get_weak(), &TerminalPage::_FocusActiveControl });
            }
        }
        _UpdateTeachingTipTheme(WindowCwdToast().try_as<winrt::Windows::UI::Xaml::FrameworkElement>());

        if (_windowCwdToast != nullptr)
        {
            _windowCwdToast->Open();
        }
    }

    // Method Description:
    // - Called when the user hits the "Ok" button on the WindowRenamer TeachingTip.
    // - Will raise an event that will bubble up to the monarch, asking if this
    //   name is acceptable.
    //   - we'll eventually get called back in TerminalPage::WindowName(hstring).
    // Arguments:
    // - <unused>
    // Return Value:
    // - <none>
    void TerminalPage::_WindowRenamerActionClick(const IInspectable& /*sender*/,
                                                 const IInspectable& /*eventArgs*/)
    {
        auto newName = WindowRenamerTextBox().Text();
        _RequestWindowRename(newName);
    }

    void TerminalPage::_RequestWindowRename(const winrt::hstring& newName)
    {
        auto request = winrt::make<implementation::RenameWindowRequestedArgs>(newName);
        // The WindowRenamer is _not_ a Toast - we want it to stay open until
        // the user dismisses it.
        if (WindowRenamer())
        {
            WindowRenamer().IsOpen(false);
        }
        RenameWindowRequested.raise(*this, request);
        // We can't just use request.Successful here, because the handler might
        // (will) be handling this asynchronously, so when control returns to
        // us, this hasn't actually been handled yet. We'll get called back in
        // RenameFailed if this fails.
        //
        // Theoretically we could do a IAsyncOperation<RenameWindowResult> kind
        // of thing with co_return winrt::make<RenameWindowResult>(false).
    }

    // Method Description:
    // - Used to track if the user pressed enter with the renamer open. If we
    //   immediately focus it after hitting Enter on the command palette, then
    //   the Enter keydown will dismiss the command palette and open the
    //   renamer, and then the enter keyup will go to the renamer. So we need to
    //   make sure both a down and up go to the renamer.
    // Arguments:
    // - e: the KeyRoutedEventArgs describing the key that was released
    // Return Value:
    // - <none>
    void TerminalPage::_WindowRenamerKeyDown(const IInspectable& /*sender*/,
                                             const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        const auto key = e.OriginalKey();
        if (key == Windows::System::VirtualKey::Enter)
        {
            _renamerPressedEnter = true;
        }
    }

    // Method Description:
    // - Manually handle Enter and Escape for committing and dismissing a window
    //   rename. This is highly similar to the TabHeaderControl's KeyUp handler.
    // Arguments:
    // - e: the KeyRoutedEventArgs describing the key that was released
    // Return Value:
    // - <none>
    void TerminalPage::_WindowRenamerKeyUp(const IInspectable& sender,
                                           const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        const auto key = e.OriginalKey();
        if (key == Windows::System::VirtualKey::Enter && _renamerPressedEnter)
        {
            // User is done making changes, close the rename box
            _WindowRenamerActionClick(sender, nullptr);
        }
        else if (key == Windows::System::VirtualKey::Escape)
        {
            // User wants to discard the changes they made
            WindowRenamerTextBox().Text(_WindowProperties.WindowName());
            WindowRenamer().IsOpen(false);
            _renamerPressedEnter = false;
        }
    }

    // Method Description:
    // - This function stops people from duplicating the base profile, because
    //   it gets ~ ~ weird ~ ~ when they do. Remove when TODO GH#5047 is done.
    Profile TerminalPage::GetClosestProfileForDuplicationOfProfile(const Profile& profile) const noexcept
    {
        if (profile == _settings.ProfileDefaults())
        {
            return _settings.FindProfile(_currentWindowSettings().DefaultProfile());
        }
        return profile;
    }

    // Function Description:
    // - Helper to launch a new WT instance elevated. It'll do this by spawning
    //   a helper process, that will ask the shell to elevate the process for
    //   us. This might cause a UAC prompt. The elevation is performed on a
    //   background thread, as to not block the UI thread.
    // Arguments:
    // - newTerminalArgs: A NewTerminalArgs describing the terminal instance
    //   that should be spawned. The Profile should be filled in with the GUID
    //   of the profile we want to launch.
    // Return Value:
    // - <none>
    // Important: Don't take the param by reference, since we'll be doing work
    // on another thread.
    void TerminalPage::_OpenElevatedWT(NewTerminalArgs newTerminalArgs)
    {
        // BODGY
        //
        // We're going to construct the commandline we want, then toss it to a
        // helper process called `elevate-shim.exe` that happens to live next to
        // us. elevate-shim.exe will be the one to call ShellExecute with the
        // args that we want (to elevate the given profile).
        //
        // We can't be the one to call ShellExecute ourselves. ShellExecute
        // requires that the calling process stays alive until the child is
        // spawned. However, in the case of something like `wt -p
        // AlwaysElevateMe`, then the original WT will try to ShellExecute a new
        // wt.exe (elevated) and immediately exit, preventing ShellExecute from
        // successfully spawning the elevated WT.

        std::filesystem::path exePath = wil::GetModuleFileNameW<std::wstring>(nullptr);
        exePath.replace_filename(L"elevate-shim.exe");

        // Build the commandline to pass to wt for this set of NewTerminalArgs
        auto cmdline{
            fmt::format(FMT_COMPILE(L"new-tab {}"), newTerminalArgs.ToCommandline())
        };

        wil::unique_process_information pi;
        STARTUPINFOW si{};
        si.cb = sizeof(si);

        LOG_IF_WIN32_BOOL_FALSE(CreateProcessW(exePath.c_str(),
                                               cmdline.data(),
                                               nullptr,
                                               nullptr,
                                               FALSE,
                                               0,
                                               nullptr,
                                               nullptr,
                                               &si,
                                               &pi));

        // TODO: GH#8592 - It may be useful to pop a Toast here in the original
        // Terminal window informing the user that the tab was opened in a new
        // window.
    }

    // Method Description:
    // - If the requested settings want us to elevate this new terminal
    //   instance, and we're not currently elevated, then open the new terminal
    //   as an elevated instance (using _OpenElevatedWT). Does nothing if we're
    //   already elevated, or if the control settings don't want to be elevated.
    // Arguments:
    // - newTerminalArgs: The NewTerminalArgs for this terminal instance
    // - controlSettings: The constructed TerminalSettingsCreateResult for this Terminal instance
    // - profile: The Profile we're using to launch this Terminal instance
    // Return Value:
    // - true iff we tossed this request to an elevated window. Callers can use
    //   this result to early-return if needed.
    bool TerminalPage::_maybeElevate(const NewTerminalArgs& newTerminalArgs,
                                     const Settings::TerminalSettingsCreateResult& controlSettings,
                                     const Profile& profile)
    {
        // When duplicating a tab there aren't any newTerminalArgs.
        if (!newTerminalArgs)
        {
            return false;
        }

        const auto defaultSettings = controlSettings.DefaultSettings();

        // If we don't even want to elevate we can return early.
        // If we're already elevated we can also return, because it doesn't get any more elevated than that.
        if (!defaultSettings->Elevate() || IsRunningElevated())
        {
            return false;
        }

        // Manually set the Profile of the NewTerminalArgs to the guid we've
        // resolved to. If there was a profile in the NewTerminalArgs, this
        // will be that profile's GUID. If there wasn't, then we'll use
        // whatever the default profile's GUID is.
        newTerminalArgs.Profile(::Microsoft::Console::Utils::GuidToString(profile.Guid()));
        newTerminalArgs.StartingDirectory(_evaluatePathForCwd(defaultSettings->StartingDirectory()));
        _OpenElevatedWT(newTerminalArgs);
        return true;
    }

    // Method Description:
    // - Handles the change of connection state.
    // If the connection state is failure show information bar suggesting to configure termination behavior
    // (unless user asked not to show this message again)
    // Arguments:
    // - sender: the ICoreState instance containing the connection state
    // Return Value:
    // - <none>
    safe_void_coroutine TerminalPage::_ConnectionStateChangedHandler(const IInspectable& sender, const IInspectable& /*args*/)
    {
        if (const auto coreState{ sender.try_as<winrt::Microsoft::Terminal::Control::ICoreState>() })
        {
            const auto newConnectionState = coreState.ConnectionState();
            const auto weak = get_weak();
            co_await wil::resume_foreground(Dispatcher());
            const auto strong = weak.get();
            if (!strong)
            {
                co_return;
            }

            _adjustProcessPriorityThrottled->Run();

            if (newConnectionState == ConnectionState::Failed && !_IsMessageDismissed(InfoBarMessage::CloseOnExitInfo))
            {
                if (const auto infoBar = FindName(L"CloseOnExitInfoBar").try_as<MUX::Controls::InfoBar>())
                {
                    infoBar.IsOpen(true);
                }
            }
        }
    }

    // Method Description:
    // - Persists the user's choice not to show information bar guiding to configure termination behavior.
    // Then hides this information buffer.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::_CloseOnExitInfoDismissHandler(const IInspectable& /*sender*/, const IInspectable& /*args*/) const
    {
        _DismissMessage(InfoBarMessage::CloseOnExitInfo);
        if (const auto infoBar = FindName(L"CloseOnExitInfoBar").try_as<MUX::Controls::InfoBar>())
        {
            infoBar.IsOpen(false);
        }
    }

    // Method Description:
    // - Persists the user's choice not to show information bar warning about "Touch keyboard and Handwriting Panel Service" disabled
    // Then hides this information buffer.
    // Arguments:
    // - <none>
    // Return Value:
    // - <none>
    void TerminalPage::_KeyboardServiceWarningInfoDismissHandler(const IInspectable& /*sender*/, const IInspectable& /*args*/) const
    {
        _DismissMessage(InfoBarMessage::KeyboardServiceWarning);
        if (const auto infoBar = FindName(L"KeyboardServiceWarningInfoBar").try_as<MUX::Controls::InfoBar>())
        {
            infoBar.IsOpen(false);
        }
    }

    // Method Description:
    // - Checks whether information bar message was dismissed earlier (in the application state)
    // Arguments:
    // - message: message to look for in the state
    // Return Value:
    // - true, if the message was dismissed
    bool TerminalPage::_IsMessageDismissed(const InfoBarMessage& message)
    {
        if (const auto dismissedMessages{ ApplicationState::SharedInstance().DismissedMessages() })
        {
            for (const auto& dismissedMessage : dismissedMessages)
            {
                if (dismissedMessage == message)
                {
                    return true;
                }
            }
        }
        return false;
    }

    // Method Description:
    // - Persists the user's choice to dismiss information bar message (in application state)
    // Arguments:
    // - message: message to dismiss
    // Return Value:
    // - <none>
    void TerminalPage::_DismissMessage(const InfoBarMessage& message)
    {
        const auto applicationState = ApplicationState::SharedInstance();
        std::vector<InfoBarMessage> messages;

        if (const auto values = applicationState.DismissedMessages())
        {
            messages.resize(values.Size());
            values.GetMany(0, messages);
        }

        if (std::none_of(messages.begin(), messages.end(), [&](const auto& m) { return m == message; }))
        {
            messages.emplace_back(message);
        }

        applicationState.DismissedMessages(std::move(messages));
    }

    void TerminalPage::_updateThemeColors()
    {
        if (_settings == nullptr)
        {
            return;
        }

        const auto theme = _settings.GlobalSettings().CurrentTheme(_currentWindowSettings());
        auto requestedTheme{ theme.RequestedTheme() };

        {
            _updatePaneResources(requestedTheme);

            for (const auto& tab : _tabs)
            {
                if (auto tabImpl{ _GetTabImpl(tab) })
                {
                    // The root pane will propagate the theme change to all its children.
                    if (const auto& rootPane{ tabImpl->GetRootPane() })
                    {
                        rootPane->UpdateResources(_paneResources);
                    }
                }
            }
        }

        const auto res = Application::Current().Resources();

        // Use our helper to lookup the theme-aware version of the resource.
        const auto tabViewBackgroundKey = winrt::box_value(L"TabViewBackground");
        const auto backgroundSolidBrush = ThemeLookup(res, requestedTheme, tabViewBackgroundKey).as<Media::SolidColorBrush>();

        til::color bgColor = backgroundSolidBrush.Color();

        Media::Brush terminalBrush{ nullptr };
        if (const auto tab{ _GetFocusedTabImpl() })
        {
            if (const auto& pane{ tab->GetActivePane() })
            {
                if (const auto& lastContent{ pane->GetLastFocusedContent() })
                {
                    terminalBrush = lastContent.BackgroundBrush();
                }
            }
        }

        // GH#19604: Get the theme's tabRow color to use as the acrylic tint.
        const auto tabRowBg{ theme.TabRow() ? (_activated ? theme.TabRow().Background() :
                                                            theme.TabRow().UnfocusedBackground()) :
                                              ThemeColor{ nullptr } };

        if (_currentWindowSettings().UseAcrylicInTabRow() && (_activated || _currentWindowSettings().EnableUnfocusedAcrylic()))
        {
            if (tabRowBg)
            {
                bgColor = ThemeColor::ColorFromBrush(tabRowBg.Evaluate(res, terminalBrush, true));
            }

            const auto acrylicBrush = Media::AcrylicBrush();
            acrylicBrush.BackgroundSource(Media::AcrylicBackgroundSource::HostBackdrop);
            acrylicBrush.FallbackColor(bgColor);
            acrylicBrush.TintColor(bgColor);
            acrylicBrush.TintOpacity(0.5);

            TitlebarBrush(acrylicBrush);
        }
        else if (tabRowBg)
        {
            const auto themeBrush{ tabRowBg.Evaluate(res, terminalBrush, true) };
            bgColor = ThemeColor::ColorFromBrush(themeBrush);
            // If the tab content returned nullptr for the terminalBrush, we
            // _don't_ want to use it as the tab row background. We want to just
            // use the default tab row background.
            TitlebarBrush(themeBrush ? themeBrush : backgroundSolidBrush);
        }
        else
        {
            // Nothing was set in the theme - fall back to our original `TabViewBackground` color.
            TitlebarBrush(backgroundSolidBrush);
        }

        constexpr bool useVerticalTabs{ true };
        if (useVerticalTabs || !_currentWindowSettings().ShowTabsInTitlebar())
        {
            _tabRow.Background(TitlebarBrush());
        }

        // Second: Update the colors of our individual TabViewItems. This
        // applies tab.background to the tabs via Tab::ThemeColor.
        //
        // Do this second, so that we already know the bgColor of the titlebar.
        {
            const auto tabBackground = theme.Tab() ? theme.Tab().Background() : nullptr;
            const auto tabUnfocusedBackground = theme.Tab() ? theme.Tab().UnfocusedBackground() : nullptr;
            for (const auto& tab : _tabs)
            {
                winrt::com_ptr<Tab> tabImpl;
                tabImpl.copy_from(winrt::get_self<Tab>(tab));
                tabImpl->ThemeColor(tabBackground, tabUnfocusedBackground, bgColor);
            }
        }
        // Update the new tab button to have better contrast with the new color.
        // In theory, it would be convenient to also change these for the
        // inactive tabs as well, but we're leaving that as a follow up.
        _SetNewTabButtonColor(bgColor, bgColor);

        // Third: the window frame. This is basically the same logic as the tab row background.
        // We'll set our `FrameBrush` property, for the window to later use.
        const auto windowTheme{ theme.Window() };
        if (auto windowFrame{ windowTheme ? (_activated ? windowTheme.Frame() :
                                                          windowTheme.UnfocusedFrame()) :
                                            ThemeColor{ nullptr } })
        {
            const auto themeBrush{ windowFrame.Evaluate(res, terminalBrush, true) };
            FrameBrush(themeBrush);
        }
        else
        {
            // Nothing was set in the theme - fall back to null. The window will
            // use that as an indication to use the default window frame.
            FrameBrush(nullptr);
        }
    }

    // Function Description:
    // - Attempts to load some XAML resources that Panes will need. This includes:
    //   * The Color they'll use for active Panes's borders - SystemAccentColor
    //   * The Brush they'll use for inactive Panes - TabViewBackground (to match the
    //     color of the titlebar)
    // Arguments:
    // - requestedTheme: this should be the currently active Theme for the app
    // Return Value:
    // - <none>
    void TerminalPage::_updatePaneResources(const winrt::Windows::UI::Xaml::ElementTheme& requestedTheme)
    {
        const auto res = Application::Current().Resources();
        const auto accentColorKey = winrt::box_value(L"SystemAccentColor");
        if (res.HasKey(accentColorKey))
        {
            const auto colorFromResources = ThemeLookup(res, requestedTheme, accentColorKey);
            // If SystemAccentColor is _not_ a Color for some reason, use
            // Transparent as the color, so we don't do this process again on
            // the next pane (by leaving s_focusedBorderBrush nullptr)
            auto actualColor = winrt::unbox_value_or<Color>(colorFromResources, Colors::Black());
            _paneResources.focusedBorderBrush = SolidColorBrush(actualColor);
        }
        else
        {
            // DON'T use Transparent here - if it's "Transparent", then it won't
            // be able to hittest for clicks, and then clicking on the border
            // will eat focus.
            _paneResources.focusedBorderBrush = SolidColorBrush{ Colors::Black() };
        }

        const auto unfocusedBorderBrushKey = winrt::box_value(L"UnfocusedBorderBrush");
        if (res.HasKey(unfocusedBorderBrushKey))
        {
            // MAKE SURE TO USE ThemeLookup, so that we get the correct resource for
            // the requestedTheme, not just the value from the resources (which
            // might not respect the settings' requested theme)
            auto obj = ThemeLookup(res, requestedTheme, unfocusedBorderBrushKey);
            _paneResources.unfocusedBorderBrush = obj.try_as<winrt::Windows::UI::Xaml::Media::SolidColorBrush>();
        }
        else
        {
            // DON'T use Transparent here - if it's "Transparent", then it won't
            // be able to hittest for clicks, and then clicking on the border
            // will eat focus.
            _paneResources.unfocusedBorderBrush = SolidColorBrush{ Colors::Black() };
        }

        const auto broadcastColorKey = winrt::box_value(L"BroadcastPaneBorderColor");
        if (res.HasKey(broadcastColorKey))
        {
            // MAKE SURE TO USE ThemeLookup
            auto obj = ThemeLookup(res, requestedTheme, broadcastColorKey);
            _paneResources.broadcastBorderBrush = obj.try_as<winrt::Windows::UI::Xaml::Media::SolidColorBrush>();
        }
        else
        {
            // DON'T use Transparent here - if it's "Transparent", then it won't
            // be able to hittest for clicks, and then clicking on the border
            // will eat focus.
            _paneResources.broadcastBorderBrush = SolidColorBrush{ Colors::Black() };
        }
    }

    void TerminalPage::_adjustProcessPriority() const
    {
        // Windowing is single-threaded, so this will not cause a race condition.
        static uint64_t s_lastUpdateHash{ 0 };
        static bool s_supported{ true };

        if (!s_supported || !_hostingHwnd.has_value())
        {
            return;
        }

        std::array<HANDLE, 32> processes;
        auto it = processes.begin();
        const auto end = processes.end();

        auto&& appendFromControl = [&](auto&& control) {
            if (it == end)
            {
                return;
            }
            if (control)
            {
                if (const auto conn{ control.Connection() })
                {
                    if (const auto pty{ conn.try_as<winrt::Microsoft::Terminal::TerminalConnection::ConptyConnection>() })
                    {
                        if (const uint64_t process{ pty.RootProcessHandle() }; process != 0)
                        {
                            *it++ = reinterpret_cast<HANDLE>(process);
                        }
                    }
                }
            }
        };

        auto&& appendFromTab = [&](auto&& tabImpl) {
            if (const auto pane{ tabImpl->GetRootPane() })
            {
                pane->WalkTree([&](auto&& child) {
                    if (const auto& control{ child->GetTerminalControl() })
                    {
                        appendFromControl(control);
                    }
                });
            }
        };

        if (!_activated)
        {
            // When a window is out of focus, we want to attach all of the processes
            // under it to the window so they all go into the background at the same time.
            for (auto&& tab : _tabs)
            {
                if (auto tabImpl{ _GetTabImpl(tab) })
                {
                    appendFromTab(tabImpl);
                }
            }
        }
        else
        {
            // When a window is in focus, propagate our foreground boost (if we have one)
            // to current all panes in the current tab.
            if (auto tabImpl{ _GetFocusedTabImpl() })
            {
                appendFromTab(tabImpl);
            }
        }

        const auto count{ gsl::narrow_cast<DWORD>(it - processes.begin()) };
        const auto hash = til::hash((void*)processes.data(), count * sizeof(HANDLE));

        if (hash == s_lastUpdateHash)
        {
            return;
        }

        s_lastUpdateHash = hash;
        const auto hr = TerminalTrySetWindowAssociatedProcesses(_hostingHwnd.value(), count, count ? processes.data() : nullptr);

        if (S_FALSE == hr)
        {
            // Don't bother trying again or logging. The wrapper tells us it's unsupported.
            s_supported = false;
            return;
        }

        TraceLoggingWrite(
            g_hTerminalAppProvider,
            "CalledNewQoSAPI",
            TraceLoggingValue(reinterpret_cast<uintptr_t>(_hostingHwnd.value()), "hwnd"),
            TraceLoggingValue(count),
            TraceLoggingHResult(hr));
#ifdef _DEBUG
        OutputDebugStringW(fmt::format(FMT_COMPILE(L"Submitted {} processes to TerminalTrySetWindowAssociatedProcesses; return=0x{:08x}\n"), count, hr).c_str());
#endif
    }

    void TerminalPage::WindowActivated(const bool activated)
    {
        // Stash if we're activated. Use that when we reload
        // the settings, change active panes, etc.
        _activated = activated;
        _updateThemeColors();

        _adjustProcessPriorityThrottled->Run();

        if (const auto& tab{ _GetFocusedTabImpl() })
        {
            if (tab->TabStatus().IsInputBroadcastActive())
            {
                tab->GetRootPane()->WalkTree([activated](const auto& p) {
                    if (const auto& control{ p->GetTerminalControl() })
                    {
                        control.CursorVisibility(activated ?
                                                     Microsoft::Terminal::Control::CursorDisplayState::Shown :
                                                     Microsoft::Terminal::Control::CursorDisplayState::Default);
                    }
                });
            }
        }
    }

    safe_void_coroutine TerminalPage::_ControlCompletionsChangedHandler(const IInspectable sender,
                                                                        const CompletionsChangedEventArgs args)
    {
        // This won't even get hit if the velocity flag is disabled - we gate
        // registering for the event based off of
        // Feature_ShellCompletions::IsEnabled back in _RegisterTerminalEvents

        // User must explicitly opt-in on Preview builds
        if (!_currentWindowSettings().EnableShellCompletionMenu())
        {
            co_return;
        }

        // Parse the json string into a collection of actions
        try
        {
            auto commandsCollection = Command::ParsePowerShellMenuComplete(args.MenuJson(),
                                                                           args.ReplacementLength());

            auto weakThis{ get_weak() };
            Dispatcher().RunAsync(CoreDispatcherPriority::Normal, [weakThis, commandsCollection, sender]() {
                // On the UI thread...
                if (const auto& page{ weakThis.get() })
                {
                    // Open the Suggestions UI with the commands from the control
                    page->_OpenSuggestions(sender.try_as<TermControl>(), commandsCollection, SuggestionsMode::Menu, L"");
                }
            });
        }
        CATCH_LOG();
    }

    void TerminalPage::_OpenSuggestions(
        const TermControl& sender,
        IVector<Command> commandsCollection,
        winrt::TerminalApp::SuggestionsMode mode,
        winrt::hstring filterText)

    {
        // ON THE UI THREAD
        assert(Dispatcher().HasThreadAccess());

        if (commandsCollection == nullptr)
        {
            return;
        }
        if (commandsCollection.Size() == 0)
        {
            if (const auto p = SuggestionsElement())
            {
                p.Visibility(Visibility::Collapsed);
            }
            return;
        }

        const auto& control{ sender ? sender : _GetActiveControl() };
        if (!control)
        {
            return;
        }

        const auto& sxnUi{ LoadSuggestionsUI() };

        const auto characterSize{ control.CharacterDimensions() };
        // This is in control-relative space. We'll need to convert it to page-relative space.
        const auto cursorPos{ control.CursorPositionInDips() };
        const auto controlTransform = control.TransformToVisual(this->Root());
        const auto realCursorPos{ controlTransform.TransformPoint({ cursorPos.X, cursorPos.Y }) }; // == controlTransform + cursorPos
        const Windows::Foundation::Size windowDimensions{ gsl::narrow_cast<float>(ActualWidth()), gsl::narrow_cast<float>(ActualHeight()) };

        sxnUi.Open(mode,
                   commandsCollection,
                   filterText,
                   realCursorPos,
                   windowDimensions,
                   characterSize.Height);
    }

    void TerminalPage::_PopulateContextMenu(const TermControl& control,
                                            const MUX::Controls::CommandBarFlyout& menu,
                                            const bool withSelection)
    {
        // withSelection can be used to add actions that only appear if there's
        // selected text, like "search the web"

        if (!control || !menu)
        {
            return;
        }

        // Helper lambda for dispatching an ActionAndArgs onto the
        // ShortcutActionDispatch. Used below to wire up each menu entry to the
        // respective action.

        auto weak = get_weak();
        auto makeCallback = [weak](const ActionAndArgs& actionAndArgs) {
            return [weak, actionAndArgs](auto&&, auto&&) {
                if (auto page{ weak.get() })
                {
                    page->_actionDispatch->DoAction(actionAndArgs);
                }
            };
        };

        auto makeItem = [&makeCallback](const winrt::hstring& label,
                                        const winrt::hstring& icon,
                                        const auto& action,
                                        auto& targetMenu) {
            AppBarButton button{};

            if (!icon.empty())
            {
                auto iconElement = UI::IconPathConverter::IconWUX(icon);
                Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
                button.Icon(iconElement);
            }

            button.Label(label);
            button.Click(makeCallback(action));
            targetMenu.SecondaryCommands().Append(button);
        };

        auto makeMenuItem = [](const winrt::hstring& label,
                               const winrt::hstring& icon,
                               const auto& subMenu,
                               auto& targetMenu) {
            AppBarButton button{};

            if (!icon.empty())
            {
                auto iconElement = UI::IconPathConverter::IconWUX(icon);
                Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
                button.Icon(iconElement);
            }

            button.Label(label);
            button.Flyout(subMenu);
            targetMenu.SecondaryCommands().Append(button);
        };

        auto makeContextItem = [&makeCallback](const winrt::hstring& label,
                                               const winrt::hstring& icon,
                                               const winrt::hstring& tooltip,
                                               const auto& action,
                                               const auto& subMenu,
                                               auto& targetMenu) {
            AppBarButton button{};

            if (!icon.empty())
            {
                auto iconElement = UI::IconPathConverter::IconWUX(icon);
                Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
                button.Icon(iconElement);
            }

            button.Label(label);
            button.Click(makeCallback(action));
            WUX::Controls::ToolTipService::SetToolTip(button, box_value(tooltip));
            button.ContextFlyout(subMenu);
            targetMenu.SecondaryCommands().Append(button);
        };

        const auto focusedProfile = _GetFocusedTabImpl()->GetFocusedProfile();
        auto separatorItem = AppBarSeparator{};
        auto activeProfiles = _settings.ActiveProfiles();
        auto activeProfileCount = gsl::narrow_cast<int>(activeProfiles.Size());
        MUX::Controls::CommandBarFlyout splitPaneMenu{};

        // Wire up each item to the action that should be performed. By actually
        // connecting these to actions, we ensure the implementation is
        // consistent. This also leaves room for customizing this menu with
        // actions in the future.

        makeItem(RS_(L"DuplicateTabText"), L"\xF5ED", ActionAndArgs{ ShortcutAction::DuplicateTab, nullptr }, menu);

        const auto focusedProfileName = focusedProfile.Name();
        const auto focusedProfileIcon = focusedProfile.Icon().Resolved();
        const auto splitPaneDuplicateText = RS_(L"SplitPaneDuplicateText") + L" " + focusedProfileName; // SplitPaneDuplicateText

        const auto splitPaneRightText = RS_(L"SplitPaneRightText");
        const auto splitPaneDownText = RS_(L"SplitPaneDownText");
        const auto splitPaneUpText = RS_(L"SplitPaneUpText");
        const auto splitPaneLeftText = RS_(L"SplitPaneLeftText");
        const auto splitPaneToolTipText = RS_(L"SplitPaneToolTipText");

        MUX::Controls::CommandBarFlyout splitPaneContextMenu{};
        makeItem(splitPaneRightText, focusedProfileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Duplicate, SplitDirection::Right, .5, nullptr } }, splitPaneContextMenu);
        makeItem(splitPaneDownText, focusedProfileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Duplicate, SplitDirection::Down, .5, nullptr } }, splitPaneContextMenu);
        makeItem(splitPaneUpText, focusedProfileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Duplicate, SplitDirection::Up, .5, nullptr } }, splitPaneContextMenu);
        makeItem(splitPaneLeftText, focusedProfileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Duplicate, SplitDirection::Left, .5, nullptr } }, splitPaneContextMenu);

        makeContextItem(splitPaneDuplicateText, focusedProfileIcon, splitPaneToolTipText, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Duplicate, SplitDirection::Automatic, .5, nullptr } }, splitPaneContextMenu, splitPaneMenu);

        // add menu separator
        const auto separatorAutoItem = AppBarSeparator{};

        splitPaneMenu.SecondaryCommands().Append(separatorAutoItem);

        for (auto profileIndex = 0; profileIndex < activeProfileCount; profileIndex++)
        {
            const auto profile = activeProfiles.GetAt(profileIndex);
            const auto profileName = profile.Name();
            const auto profileIcon = profile.Icon().Resolved();

            NewTerminalArgs args{};
            args.Profile(profileName);

            MUX::Controls::CommandBarFlyout splitPaneContextMenu{};
            makeItem(splitPaneRightText, profileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Manual, SplitDirection::Right, .5, args } }, splitPaneContextMenu);
            makeItem(splitPaneDownText, profileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Manual, SplitDirection::Down, .5, args } }, splitPaneContextMenu);
            makeItem(splitPaneUpText, profileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Manual, SplitDirection::Up, .5, args } }, splitPaneContextMenu);
            makeItem(splitPaneLeftText, profileIcon, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Manual, SplitDirection::Left, .5, args } }, splitPaneContextMenu);

            makeContextItem(profileName, profileIcon, splitPaneToolTipText, ActionAndArgs{ ShortcutAction::SplitPane, SplitPaneArgs{ SplitType::Manual, SplitDirection::Automatic, .5, args } }, splitPaneContextMenu, splitPaneMenu);
        }

        makeMenuItem(RS_(L"SplitPaneText"), L"\xF246", splitPaneMenu, menu);

        // Only wire up "Close Pane" if there's multiple panes.
        if (_GetFocusedTabImpl()->GetLeafPaneCount() > 1)
        {
            MUX::Controls::CommandBarFlyout swapPaneMenu{};
            const auto rootPane = _GetFocusedTabImpl()->GetRootPane();
            const auto mruPanes = _GetFocusedTabImpl()->GetMruPanes();
            auto activePane = _GetFocusedTabImpl()->GetActivePane();
            rootPane->WalkTree([&](auto p) {
                if (const auto& c{ p->GetTerminalControl() })
                {
                    if (c == control)
                    {
                        activePane = p;
                    }
                }
            });

            if (auto neighbor = rootPane->NavigateDirection(activePane, FocusDirection::Down, mruPanes))
            {
                makeItem(RS_(L"SwapPaneDownText"), neighbor->GetProfile().Icon().Resolved(), ActionAndArgs{ ShortcutAction::SwapPane, SwapPaneArgs{ FocusDirection::Down } }, swapPaneMenu);
            }

            if (auto neighbor = rootPane->NavigateDirection(activePane, FocusDirection::Right, mruPanes))
            {
                makeItem(RS_(L"SwapPaneRightText"), neighbor->GetProfile().Icon().Resolved(), ActionAndArgs{ ShortcutAction::SwapPane, SwapPaneArgs{ FocusDirection::Right } }, swapPaneMenu);
            }

            if (auto neighbor = rootPane->NavigateDirection(activePane, FocusDirection::Up, mruPanes))
            {
                makeItem(RS_(L"SwapPaneUpText"), neighbor->GetProfile().Icon().Resolved(), ActionAndArgs{ ShortcutAction::SwapPane, SwapPaneArgs{ FocusDirection::Up } }, swapPaneMenu);
            }

            if (auto neighbor = rootPane->NavigateDirection(activePane, FocusDirection::Left, mruPanes))
            {
                makeItem(RS_(L"SwapPaneLeftText"), neighbor->GetProfile().Icon().Resolved(), ActionAndArgs{ ShortcutAction::SwapPane, SwapPaneArgs{ FocusDirection::Left } }, swapPaneMenu);
            }

            makeMenuItem(RS_(L"SwapPaneText"), L"\xF1CB", swapPaneMenu, menu);

            makeItem(RS_(L"TogglePaneZoomText"), L"\xE8A3", ActionAndArgs{ ShortcutAction::TogglePaneZoom, nullptr }, menu);
            makeItem(RS_(L"CloseOtherPanesText"), L"\xE89F", ActionAndArgs{ ShortcutAction::CloseOtherPanes, nullptr }, menu);
            makeItem(RS_(L"PaneClose"), L"\xE89F", ActionAndArgs{ ShortcutAction::ClosePane, nullptr }, menu);
        }

        if (control.ConnectionState() >= ConnectionState::Closed)
        {
            makeItem(RS_(L"RestartConnectionText"), L"\xE72C", ActionAndArgs{ ShortcutAction::RestartConnection, nullptr }, menu);
        }

        if (withSelection)
        {
            makeItem(RS_(L"SearchWebText"), L"\xF6FA", ActionAndArgs{ ShortcutAction::SearchForText, nullptr }, menu);
        }

        makeItem(RS_(L"TabClose"), L"\xE711", ActionAndArgs{ ShortcutAction::CloseTab, CloseTabArgs{ _GetFocusedTabIndex().value() } }, menu);
    }

    void TerminalPage::_PopulateQuickFixMenu(const TermControl& control,
                                             const Controls::MenuFlyout& menu)
    {
        if (!control || !menu)
        {
            return;
        }

        // Helper lambda for dispatching a SendInput ActionAndArgs onto the
        // ShortcutActionDispatch. Used below to wire up each menu entry to the
        // respective action. Then clear the quick fix menu.
        auto weak = get_weak();
        auto makeCallback = [weak](const hstring& suggestion) {
            return [weak, suggestion](auto&&, auto&&) {
                if (auto page{ weak.get() })
                {
                    const auto actionAndArgs = ActionAndArgs{ ShortcutAction::SendInput, SendInputArgs{ hstring{ L"\u0003" } + suggestion } };
                    page->_actionDispatch->DoAction(actionAndArgs);
                    if (auto ctrl = page->_GetActiveControl())
                    {
                        ctrl.ClearQuickFix();
                    }

                    TraceLoggingWrite(
                        g_hTerminalAppProvider,
                        "QuickFixSuggestionUsed",
                        TraceLoggingDescription("Event emitted when a winget suggestion from is used"),
                        TraceLoggingValue("QuickFixMenu", "Source"),
                        TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
                        TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));
                }
            };
        };

        // Wire up each item to the action that should be performed. By actually
        // connecting these to actions, we ensure the implementation is
        // consistent. This also leaves room for customizing this menu with
        // actions in the future.

        menu.Items().Clear();
        const auto quickFixes = control.CommandHistory().QuickFixes();
        for (const auto& qf : quickFixes)
        {
            MenuFlyoutItem item{};

            auto iconElement = UI::IconPathConverter::IconWUX(L"\ue74c");
            Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
            item.Icon(iconElement);

            item.Text(qf);
            item.Click(makeCallback(qf));
            ToolTipService::SetToolTip(item, box_value(qf));
            menu.Items().Append(item);
        }
    }

    // Rebuild the workspace flyout contents. Called every time the flyout opens
    // so it reflects the current set of persisted workspaces.
    void TerminalPage::_PopulateWorkspaceFlyout()
    {
        if (!_workspaceFlyout)
        {
            return;
        }

        _workspaceFlyout.Items().Clear();

        // --- "Name / Rename this window" ---
        {
            MenuFlyoutItem item{};
            item.Text(_WindowProperties.WindowName().empty() ? RS_(L"NameThisWindowMenuItem") : RS_(L"RenameThisWindowMenuItem"));

            auto iconElement = UI::IconPathConverter::IconWUX(L"\uE8AC"); // Rename glyph
            Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
            item.Icon(iconElement);

            item.Click([weakThis{ get_weak() }](auto&&, auto&&) {
                if (auto page{ weakThis.get() })
                {
                    page->_actionDispatch->DoAction(ActionAndArgs{ ShortcutAction::OpenWindowRenamer, nullptr });
                }
            });
            _workspaceFlyout.Items().Append(item);
        }

        // --- Gather open window info first so we can filter workspaces ---
        const auto windowListReq{ winrt::make<WindowListRequest>() };
        RequestWindowList.raise(*this, windowListReq);
        const auto windowEntries = windowListReq.Entries();

        std::set<winrt::hstring> openWindowNames;
        if (windowEntries)
        {
            for (const auto& entry : windowEntries)
            {
                const auto& name = entry.Name();
                if (!name.empty())
                {
                    openWindowNames.emplace(name);
                }
            }
        }

        // --- Saved workspaces section (only those not currently open) ---
        // Collect workspace names that aren't currently open so we can show
        // them both as top-level "open" items and inside the delete sub-menu.
        const auto workspaces = ApplicationState::SharedInstance().AllPersistedWorkspaces();
        if (workspaces && workspaces.Size() > 0)
        {
            bool addedSeparator = false;

            for (const auto& pair : workspaces)
            {
                const auto name = pair.Key();

                // Skip workspaces that correspond to a currently-open window.
                if (openWindowNames.contains(name))
                {
                    continue;
                }

                if (!addedSeparator)
                {
                    _workspaceFlyout.Items().Append(MenuFlyoutSeparator{});
                    addedSeparator = true;
                }

                MenuFlyoutItem item{};
                item.Text(name);

                auto iconElement = UI::IconPathConverter::IconWUX(L"\uE8F1"); // SwitchApps glyph
                Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
                item.Icon(iconElement);

                item.Click([weakThis{ get_weak() }, name](auto&&, auto&&) {
                    if (auto page{ weakThis.get() })
                    {
                        page->_OpenWorkspaceWindow(name);
                    }
                });

                // Right-click to delete: attach a context flyout with a
                // "Delete workspace?" item that opens a confirmation dialog.
                {
                    WUX::Controls::MenuFlyout deleteFlyout{};
                    deleteFlyout.Placement(WUX::Controls::Primitives::FlyoutPlacementMode::BottomEdgeAlignedRight);

                    WUX::Controls::MenuFlyoutItem deleteItem{};
                    deleteItem.Text(RS_(L"DeleteWorkspaceMenuItem"));

                    auto trashIcon = UI::IconPathConverter::IconWUX(L"\xE74D"); // Delete  glyph

                    deleteItem.Click([weakThis{ get_weak() }, name](auto&&, auto&&) -> safe_void_coroutine {
                        auto page{ weakThis.get() };
                        if (!page)
                        {
                            co_return;
                        }

                        // Build and show a confirmation ContentDialog.
                        ContentDialog dialog{};
                        dialog.Title(winrt::box_value(winrt::hstring{ RS_fmt(L"ConfirmDeleteWorkspaceTitle", name) }));
                        dialog.Content(winrt::box_value(winrt::hstring{ RS_fmt(L"ConfirmDeleteWorkspaceBody", name) }));
                        dialog.PrimaryButtonText(RS_(L"ConfirmDeleteWorkspaceDelete"));
                        dialog.CloseButtonText(RS_(L"ConfirmDeleteWorkspaceCancel"));
                        dialog.DefaultButton(ContentDialogButton::Close);

                        if (auto presenter{ page->_dialogPresenter.get() })
                        {
                            const auto result = co_await presenter.ShowDialog(dialog);
                            // Re-check after co_await
                            page = weakThis.get();
                            if (!page)
                            {
                                co_return;
                            }
                            if (result == ContentDialogResult::Primary)
                            {
                                ApplicationState::SharedInstance().RemoveWorkspace(name);
                                page->_PopulateWorkspaceFlyout();
                            }
                        }
                    });

                    deleteFlyout.Items().Append(deleteItem);
                    WUX::Controls::Primitives::FlyoutBase::SetAttachedFlyout(item, deleteFlyout);
                    item.ContextRequested([item](auto&&, auto&&) {
                        WUX::Controls::Primitives::FlyoutBase::ShowAttachedFlyout(item);
                    });
                }

                _workspaceFlyout.Items().Append(item);
            }
        }

        // --- Open windows section ---
        if (windowEntries && windowEntries.Size() > 0)
        {
            _workspaceFlyout.Items().Append(MenuFlyoutSeparator{});

            const auto thisWindowId = _WindowProperties.WindowId();

            for (const auto& entry : windowEntries)
            {
                const auto id = entry.Id();
                const auto& name = entry.Name();

                winrt::hstring displayText;
                if (name.empty())
                {
                    displayText = winrt::hstring{ RS_fmt(L"WindowListUnnamedEntry", id) };
                }
                else
                {
                    displayText = winrt::hstring{ fmt::format(FMT_COMPILE(L"#{}: {}"), id, name) };
                }

                MenuFlyoutItem item{};
                item.Text(displayText);

                if (id == thisWindowId)
                {
                    auto iconElement = UI::IconPathConverter::IconWUX(L"\uE73E"); // CheckMark glyph
                    Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
                    item.Icon(iconElement);
                    item.IsEnabled(false);
                }
                else
                {
                    auto iconElement = UI::IconPathConverter::IconWUX(L"\uE737"); // ChromeRestore glyph
                    Automation::AutomationProperties::SetAccessibilityView(iconElement, Automation::Peers::AccessibilityView::Raw);
                    item.Icon(iconElement);

                    item.Click([weakThis{ get_weak() }, id](auto&&, auto&&) {
                        if (auto page{ weakThis.get() })
                        {
                            page->SummonWindowByIdRequested.raise(*page, winrt::make<SummonWindowByIdRequestedArgs>(id));
                        }
                    });
                }

                _workspaceFlyout.Items().Append(item);
            }
        }
    }

    // Handler for our WindowProperties's PropertyChanged event. We'll use this
    // to pop the "Identify Window" toast when the user renames our window.
    void TerminalPage::_windowPropertyChanged(const IInspectable& /*sender*/, const WUX::Data::PropertyChangedEventArgs& args)
    {
        if (args.PropertyName() != L"WindowName")
        {
            return;
        }

        // Keep the workspace dropdown label in sync with the window name.
        // Use raw WindowName() so clearing the name hides the text.
        _tabRow.WorkspaceName(_WindowProperties.WindowName());

        // DON'T display the confirmation if this is the name we were
        // given on startup!
        if (_startupState == StartupState::Initialized)
        {
            IdentifyWindow();
        }
    }

    void TerminalPage::_onTabDragStarting(const winrt::Microsoft::UI::Xaml::Controls::TabView&,
                                          const winrt::Microsoft::UI::Xaml::Controls::TabViewTabDragStartingEventArgs& e)
    {
        // Get the tab impl from this event.
        const auto eventTab = e.Tab();
        const auto tabBase = _GetTabByTabViewItem(eventTab);
        winrt::com_ptr<Tab> tabImpl;
        tabImpl.copy_from(winrt::get_self<Tab>(tabBase));
        if (tabImpl)
        {
            // First: stash the tab we started dragging.
            // We're going to be asked for this.
            _stashed.draggedTab = tabImpl;

            // Stash the offset from where we started the drag to the
            // tab's origin. We'll use that offset in the future to help
            // position the dropped window.
            const auto inverseScale = 1.0f / static_cast<float>(eventTab.XamlRoot().RasterizationScale());
            POINT cursorPos;
            GetCursorPos(&cursorPos);
            ScreenToClient(*_hostingHwnd, &cursorPos);
            _stashed.dragOffset.X = cursorPos.x * inverseScale;
            _stashed.dragOffset.Y = cursorPos.y * inverseScale;

            // Into the DataPackage, let's stash our own window ID.
            const auto id{ _WindowProperties.WindowId() };

            // Get our PID
            const auto pid{ GetCurrentProcessId() };

            e.Data().Properties().Insert(L"windowId", winrt::box_value(id));
            e.Data().Properties().Insert(L"pid", winrt::box_value<uint32_t>(pid));
            e.Data().RequestedOperation(DataPackageOperation::Move);

            // The next thing that will happen:
            //  * Another TerminalPage will get a TabStripDragOver, then get a
            //    TabStripDrop
            //    * This will be handled by the _other_ page asking the monarch
            //      to ask us to send our content to them.
            //  * We'll get a TabDroppedOutside to indicate that this tab was
            //    dropped _not_ on a TabView.
            //    * This will be handled by _onTabDroppedOutside, which will
            //      raise a MoveContent (to a new window) event.
        }
    }

    void TerminalPage::_onTabStripDragOver(const winrt::Windows::Foundation::IInspectable& /*sender*/,
                                           const winrt::Windows::UI::Xaml::DragEventArgs& e)
    {
        // We must mark that we can accept the drag/drop. The system will never
        // call TabStripDrop on us if we don't indicate that we're willing.
        const auto& props{ e.DataView().Properties() };
        if (props.HasKey(L"windowId") &&
            props.HasKey(L"pid") &&
            (winrt::unbox_value_or<uint32_t>(props.TryLookup(L"pid"), 0u) == GetCurrentProcessId()))
        {
            e.AcceptedOperation(DataPackageOperation::Move);
        }

        // You may think to yourself, this is a great place to increase the
        // width of the TabView artificially, to make room for the new tab item.
        // However, we'll never get a message that the tab left the tab view
        // (without being dropped). So there's no good way to resize back down.
    }

    // Method Description:
    // - Called on the TARGET of a tab drag/drop. We'll unpack the DataPackage
    //   to find who the tab came from. We'll then ask the Monarch to ask the
    //   sender to move that tab to us.
    void TerminalPage::_onTabStripDrop(winrt::Windows::Foundation::IInspectable /*sender*/,
                                       winrt::Windows::UI::Xaml::DragEventArgs e)
    {
        // Get the PID and make sure it is the same as ours.
        if (const auto& pidObj{ e.DataView().Properties().TryLookup(L"pid") })
        {
            const auto pid{ winrt::unbox_value_or<uint32_t>(pidObj, 0u) };
            if (pid != GetCurrentProcessId())
            {
                // The PID doesn't match ours. We can't handle this drop.
                return;
            }
        }
        else
        {
            // No PID? We can't handle this drop. Bail.
            return;
        }

        const auto& windowIdObj{ e.DataView().Properties().TryLookup(L"windowId") };
        if (windowIdObj == nullptr)
        {
            // No windowId? Bail.
            return;
        }
        const uint64_t src{ winrt::unbox_value<uint64_t>(windowIdObj) };

        // Figure out where in the tab strip we're dropping this tab. Add that
        // index to the request. This is largely taken from the WinUI sample
        // app.

        // First we need to get the position in the List to drop to
        auto index = -1;

        // Determine which items in the list our pointer is between.
        for (auto i = 0u; i < _tabView.TabItems().Size(); i++)
        {
            if (const auto& item{ _tabView.ContainerFromIndex(i).try_as<winrt::MUX::Controls::TabViewItem>() })
            {
                const auto posX{ e.GetPosition(item).X }; // The point of the drop, relative to the tab
                const auto itemWidth{ item.ActualWidth() }; // The right of the tab
                // If the drag point is on the left half of the tab, then insert here.
                if (posX < itemWidth / 2)
                {
                    index = i;
                    break;
                }
            }
        }

        // `this` is safe to use
        const auto request = winrt::make_self<RequestReceiveContentArgs>(src, _WindowProperties.WindowId(), index);

        // This will go up to the monarch, who will then dispatch the request
        // back down to the source TerminalPage, who will then perform a
        // RequestMoveContent to move their tab to us.
        RequestReceiveContent.raise(*this, *request);
    }

    // Method Description:
    // - This is called on the drag/drop SOURCE TerminalPage, when the monarch has
    //   requested that we send our tab to another window. We'll need to
    //   serialize the tab, and send it to the monarch, who will then send it to
    //   the destination window.
    // - Fortunately, sending the tab is basically just a MoveTab action, so we
    //   can largely reuse that.
    void TerminalPage::SendContentToOther(winrt::TerminalApp::RequestReceiveContentArgs args)
    {
        // validate that we're the source window of the tab in this request
        if (args.SourceWindow() != _WindowProperties.WindowId())
        {
            return;
        }
        if (!_stashed.draggedTab)
        {
            return;
        }

        _sendDraggedTabToWindow(winrt::to_hstring(args.TargetWindow()), args.TabIndex(), std::nullopt);
    }

    void TerminalPage::_onTabDroppedOutside(winrt::IInspectable /*sender*/,
                                            winrt::MUX::Controls::TabViewTabDroppedOutsideEventArgs /*e*/)
    {
        // Get the current pointer point from the CoreWindow
        const auto& pointerPoint{ CoreWindow::GetForCurrentThread().PointerPosition() };

        // This is called when a tab FROM OUR WINDOW was dropped outside the
        // tabview. We already know which tab was being dragged. We'll just
        // invoke a moveTab action with the target window being -1. That will
        // force the creation of a new window.

        if (!_stashed.draggedTab)
        {
            return;
        }

        // We need to convert the pointer point to a point that we can use
        // to position the new window. We'll use the drag offset from before
        // so that the tab in the new window is positioned so that it's
        // basically still directly under the cursor.

        // -1 is the magic number for "new window"
        // 0 as the tab index, because we don't care. It's making a new window. It'll be the only tab.
        const winrt::Windows::Foundation::Point adjusted = {
            pointerPoint.X - _stashed.dragOffset.X,
            pointerPoint.Y - _stashed.dragOffset.Y,
        };
        _sendDraggedTabToWindow(winrt::hstring{ L"-1" }, 0, adjusted);
    }

    void TerminalPage::_sendDraggedTabToWindow(const winrt::hstring& windowId,
                                               const uint32_t tabIndex,
                                               std::optional<winrt::Windows::Foundation::Point> dragPoint)
    {
        auto startupActions = _stashed.draggedTab->BuildStartupActions(BuildStartupKind::Content);
        _DetachTabFromWindow(_stashed.draggedTab);

        _MoveContent(std::move(startupActions), windowId, tabIndex, dragPoint);
        // _RemoveTab will make sure to null out the _stashed.draggedTab
        _RemoveTab(*_stashed.draggedTab);
    }

    /// <summary>
    /// Creates a sub flyout menu for profile items in the split button menu that when clicked will show a menu item for
    /// Run as Administrator
    /// </summary>
    /// <param name="profileIndex">The index for the profileMenuItem</param>
    /// <returns>MenuFlyout that will show when the context is request on a profileMenuItem</returns>
    WUX::Controls::MenuFlyout TerminalPage::_CreateRunAsAdminFlyout(int profileIndex)
    {
        // Create the MenuFlyout and set its placement
        WUX::Controls::MenuFlyout profileMenuItemFlyout{};
        profileMenuItemFlyout.Placement(WUX::Controls::Primitives::FlyoutPlacementMode::BottomEdgeAlignedRight);

        // Create the menu item and an icon to use in the menu
        WUX::Controls::MenuFlyoutItem runAsAdminItem{};
        WUX::Controls::FontIcon adminShieldIcon{};

        adminShieldIcon.Glyph(L"\xEA18");
        adminShieldIcon.FontFamily(Media::FontFamily{ L"Segoe Fluent Icons, Segoe MDL2 Assets" });

        runAsAdminItem.Icon(adminShieldIcon);
        runAsAdminItem.Text(RS_(L"RunAsAdminFlyout/Text"));

        // Click handler for the flyout item
        runAsAdminItem.Click([profileIndex, weakThis{ get_weak() }](auto&&, auto&&) {
            if (auto page{ weakThis.get() })
            {
                TraceLoggingWrite(
                    g_hTerminalAppProvider,
                    "NewTabMenuItemElevateSubmenuItemClicked",
                    TraceLoggingDescription("Event emitted when the elevate submenu item from the new tab menu is invoked"),
                    TraceLoggingValue(page->NumberOfTabs(), "TabCount", "The count of tabs currently opened in this window"),
                    TraceLoggingKeyword(MICROSOFT_KEYWORD_MEASURES),
                    TelemetryPrivacyDataTag(PDT_ProductAndServiceUsage));

                NewTerminalArgs args{ profileIndex };
                args.Elevate(true);
                page->_OpenNewTerminalViaDropdown(args);
            }
        });

        profileMenuItemFlyout.Items().Append(runAsAdminItem);

        return profileMenuItemFlyout;
    }
}

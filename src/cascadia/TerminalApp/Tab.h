// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once
#include "Pane.h"
#include "ColorPickupFlyout.h"
#include "Tab.h"
#include "Tab.g.h"

// fwdecl unittest classes
namespace TerminalAppLocalTests
{
    class TabTests;
};

namespace winrt::TerminalApp::implementation
{
    struct Tab : TabT<Tab>
    {
    public:
        Tab(std::shared_ptr<Pane> rootPane);
        ~Tab();

        // Called after construction to perform the necessary setup, which relies on weak_ptr
        void Initialize();

        winrt::Microsoft::Terminal::Control::TermControl GetActiveTerminalControl() const;
        winrt::Microsoft::Terminal::Settings::Model::Profile GetFocusedProfile() const noexcept;
        winrt::TerminalApp::IPaneContent GetActiveContent() const;

        void Focus(winrt::Windows::UI::Xaml::FocusState focusState);

        void Scroll(const int delta);

        std::shared_ptr<Pane> DetachRoot();
        std::shared_ptr<Pane> DetachPane();
        void AttachPane(std::shared_ptr<Pane> pane);

        void AttachColorPicker(winrt::TerminalApp::ColorPickupFlyout& colorPicker);

        std::pair<std::shared_ptr<Pane>, std::shared_ptr<Pane>> SplitPane(winrt::Microsoft::Terminal::Settings::Model::SplitDirection splitType,
                                                                          const float splitSize,
                                                                          std::shared_ptr<Pane> newPane);

        void ToggleSplitOrientation();
        void UpdateIcon(const winrt::hstring& iconPath, const winrt::Microsoft::Terminal::Settings::Model::IconStyle iconStyle);
        void HideIcon(const bool hide);

        void ShowBellIndicator(const bool show);
        void ActivateBellIndicatorTimer();

        float CalcSnappedDimension(const bool widthOrHeight, const float dimension) const;
        std::optional<winrt::Microsoft::Terminal::Settings::Model::SplitDirection> PreCalculateCanSplit(winrt::Microsoft::Terminal::Settings::Model::SplitDirection splitType,
                                                                                                        const float splitSize,
                                                                                                        winrt::Windows::Foundation::Size availableSpace) const;

        bool ResizePane(const winrt::Microsoft::Terminal::Settings::Model::ResizeDirection& direction);
        bool NavigateFocus(const winrt::Microsoft::Terminal::Settings::Model::FocusDirection& direction);
        bool SwapPane(const winrt::Microsoft::Terminal::Settings::Model::FocusDirection& direction);
        bool FocusPane(const uint32_t id);

        void UpdateSettings(const winrt::Microsoft::Terminal::Settings::Model::CascadiaSettings& settings,
                            const winrt::Microsoft::Terminal::Settings::Model::WindowSettings& windowSettings);
        void UpdateTitle();

        void Close();
        void Shutdown();
        void ClosePane();

        void SetTabText(winrt::hstring title);
        winrt::hstring GetTabText() const;
        void ResetTabText();
        void ActivateTabRenamer();

        std::optional<winrt::Windows::UI::Color> GetTabColor();
        void SetRuntimeTabColor(const winrt::Windows::UI::Color& color);
        void ResetRuntimeTabColor();

        void UpdateZoom(std::shared_ptr<Pane> newFocus);
        void ToggleZoom();
        bool IsZoomed();
        void EnterZoom();
        void ExitZoom();

        std::vector<Microsoft::Terminal::Settings::Model::ActionAndArgs> BuildStartupActions(BuildStartupKind kind) const;

        int GetLeafPaneCount() const noexcept;

        void TogglePaneReadOnly();
        void SetPaneReadOnly(const bool readOnlyState);
        void ToggleBroadcastInput();

        std::shared_ptr<Pane> GetActivePane() const;
        winrt::TerminalApp::TaskbarState GetCombinedTaskbarState() const;

        std::shared_ptr<Pane> GetRootPane() const { return _rootPane; }
        std::vector<uint32_t> GetMruPanes() const { return _mruPanes; }

        winrt::TerminalApp::TerminalTabStatus TabStatus()
        {
            return _tabStatus;
        }

        void SetDispatch(const winrt::TerminalApp::ShortcutActionDispatch& dispatch);

        void UpdateTabViewIndex(const uint32_t idx, const uint32_t numTabs);
        void SetActionMap(const Microsoft::Terminal::Settings::Model::IActionMapView& actionMap);

        void ThemeColor(const winrt::Microsoft::Terminal::Settings::Model::ThemeColor& focused,
                        const winrt::Microsoft::Terminal::Settings::Model::ThemeColor& unfocused,
                        const til::color& tabRowColor);

        Microsoft::Terminal::Settings::Model::TabCloseButtonVisibility CloseButtonVisibility();
        void CloseButtonVisibility(Microsoft::Terminal::Settings::Model::TabCloseButtonVisibility visible);

        til::event<winrt::delegate<void()>> RequestFocusActiveControl;

        til::event<winrt::Windows::Foundation::EventHandler<winrt::Windows::Foundation::IInspectable>> Closed;
        til::event<winrt::Windows::Foundation::EventHandler<winrt::Windows::Foundation::IInspectable>> CloseRequested;
        til::property_changed_event PropertyChanged;

        til::typed_event<TerminalApp::TerminalPaneContent> RestartTerminalRequested;

        til::typed_event<TerminalApp::Tab, IInspectable> ActivePaneChanged;
        til::event<winrt::delegate<>> TabRaiseVisualBell;
        til::event<winrt::delegate<winrt::hstring /*title*/, winrt::hstring /*body*/, winrt::TerminalApp::IPaneContent /*content*/>> TabToastNotificationRequested;
        til::typed_event<IInspectable, IInspectable> TaskbarProgressChanged;

        // The TabViewIndex is the index this Tab object resides in TerminalPage's _tabs vector.
        WINRT_PROPERTY(uint32_t, TabViewIndex, 0);
        // The TabViewNumTabs is the number of Tab objects in TerminalPage's _tabs vector.
        WINRT_PROPERTY(uint32_t, TabViewNumTabs, 0);
        // Which terminal-web project this tab was created under ("" = none).
        WINRT_PROPERTY(winrt::hstring, ProjectId);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, ProjectName, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, ProjectPath, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, WorkingDirectory, PropertyChanged.raise);
        // Root of the git repository containing WorkingDirectory ("" if none).
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, GitRoot, PropertyChanged.raise);

    public:
        // Nesting level of the rail section this tab sits in; drives the
        // row's left padding so tabs line up under a nested subheading.
        uint32_t RailDepth() const noexcept { return _RailDepth; }
        void RailDepth(const uint32_t value)
        {
            if (_RailDepth != value)
            {
                _RailDepth = value;
                PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"RailDepth" });
                PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"RailPadding" });
            }
        }
        // Mirrors the rail's tokens: TabRailContentPadding (10,6,4,6) plus
        // one TabRailIndentStep (12) per level of nesting. The right edge
        // stays small because RailRowActions supplies its own gap.
        winrt::Windows::UI::Xaml::Thickness RailPadding() const noexcept
        {
            return winrt::Windows::UI::Xaml::Thickness{ 10.0 + 12.0 * _RailDepth, 6.0, 4.0, 6.0 };
        }

        // Raw location line handed down by the rail: the directory relative to
        // the tab's section, or the project name in the flat views. The rail
        // assigns this on every rebuild - unchanged value included - which is
        // what makes it the point where every derived row string is re-decided.
        winrt::hstring RailSubtitle() const noexcept { return _RailSubtitle; }
        void RailSubtitle(const winrt::hstring& value)
        {
            if (_RailSubtitle != value)
            {
                _RailSubtitle = value;
                PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"RailSubtitle" });
            }
            // Not guarded by the change above: what the row prints also
            // depends on the other tabs in its repository, and a rebuild is
            // exactly when those move.
            _updateRailDerived();
        }
        winrt::hstring GitBranch() const noexcept { return _GitBranch; }
        void GitBranch(const winrt::hstring& value)
        {
            if (_GitBranch != value)
            {
                _GitBranch = value;
                PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"GitBranch" });
                _updateRailDerived();
            }
        }

        // The row's location line, branch excluded and dropped entirely when
        // it only repeats the title.
        winrt::hstring RailPathText() const noexcept { return _railPathText; }
        // The branch on its own: "" outside a repository, and "" whenever it
        // is simply the branch the whole repository is on, which the section
        // header says once for all of its rows.
        winrt::hstring RailBranch() const noexcept { return _railBranch; }
        // Both of the above joined with a middle dot, for the single-TextBlock
        // meta line; either alone when the other is empty.
        winrt::hstring RailMeta() const
        {
            if (_railPathText.empty())
            {
                return _railBranch;
            }
            if (_railBranch.empty())
            {
                return _railPathText;
            }
            return _railPathText + L"  \u00B7  " + _railBranch;
        }
        // Everything the row had to leave out, one fact per line, for the
        // hover tooltip.
        winrt::hstring RailTooltip() const noexcept { return _railTooltip; }
        // "claude", "codex", ... when a coding agent is running in the tab's
        // foreground; "" otherwise. Filled in by TerminalPage's directory
        // refresh, which is the only thing holding the tab's connection.
        winrt::hstring RailAgent() const noexcept { return _railAgent; }
        void RailAgent(const winrt::hstring& value)
        {
            if (_railAgent != value)
            {
                _railAgent = value;
                PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"RailAgent" });
                PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"RailAgentGlyph" });
                _updateRailDerived();
            }
        }
        winrt::hstring RailAgentGlyph() const;
        // Everything the row shows, spelled out for a screen reader.
        winrt::hstring RailAccessibleName() const noexcept { return _railAccessibleName; }

        // Publishes this tab's repository and branch into the shared rail
        // registry and re-decides every derived row string.
        // Returns true when the branch that repository agrees on moved, which
        // means the other rows filed under it have to re-decide as well.
        bool RefreshRailSemantics();

        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Title, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Icon, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(bool, ReadOnly, PropertyChanged.raise, false);
        WINRT_PROPERTY(winrt::Microsoft::UI::Xaml::Controls::TabViewItem, TabViewItem, nullptr);

        WINRT_OBSERVABLE_PROPERTY(winrt::Windows::UI::Xaml::FrameworkElement, Content, PropertyChanged.raise, nullptr);

    public:
        // Bookkeeping for directory/branch refreshes. Not projected: only
        // TerminalPage touches these, and they are pure throttling state.
        //
        // A TUI that repaints re-emits its title many times a second, and each
        // of those asks for a refresh; without coalescing, every one of them
        // started a process walk, filesystem probes and a rail regroup.
        std::chrono::steady_clock::time_point LastDirectoryRefresh{};
        bool DirectoryRefreshInFlight{ false };
        // The agent probe walks a process tree, so it rides the sweep's
        // cadence rather than the (much noisier) title-change path.
        std::chrono::steady_clock::time_point LastAgentProbe{};

    private:
        static constexpr double HeaderRenameBoxWidthDefault{ 165 };
        winrt::hstring _RailSubtitle;
        winrt::hstring _GitBranch;
        uint32_t _RailDepth{ 0 };
        // Cached results of the rules in _updateRailDerived, so the getters
        // are pure reads and only genuine changes raise PropertyChanged.
        winrt::hstring _railPathText;
        winrt::hstring _railBranch;
        winrt::hstring _railTooltip;
        winrt::hstring _railAgent;
        winrt::hstring _railAccessibleName;

        void _updateRailDerived();
        winrt::hstring _computeRailPathText() const;
        winrt::hstring _computeRailBranch() const;
        winrt::hstring _computeRailTooltip() const;
        winrt::hstring _computeRailAccessibleName() const;

        static constexpr double HeaderRenameBoxWidthTitleLength{ std::numeric_limits<double>::infinity() };

        winrt::Windows::UI::Xaml::FocusState _focusState{ winrt::Windows::UI::Xaml::FocusState::Unfocused };
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _duplicateTabMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _splitTabMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _moveToNewWindowMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _moveRightMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _moveLeftMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _exportTabMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _findMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _restartConnectionMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _closeOtherTabsMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _closeTabsAfterMenuItem{};
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutItem _closePaneMenuItem{};
        winrt::TerminalApp::ShortcutActionDispatch _dispatch;
        Microsoft::Terminal::Settings::Model::IActionMapView _actionMap{ nullptr };
        winrt::hstring _keyChord{};

        winrt::Microsoft::Terminal::Settings::Model::ThemeColor _themeColor{ nullptr };
        winrt::Microsoft::Terminal::Settings::Model::ThemeColor _unfocusedThemeColor{ nullptr };
        til::color _tabRowColor;

        Microsoft::Terminal::Settings::Model::TabCloseButtonVisibility _closeButtonVisibility{ Microsoft::Terminal::Settings::Model::TabCloseButtonVisibility::Always };

        std::shared_ptr<Pane> _rootPane{ nullptr };
        std::shared_ptr<Pane> _activePane{ nullptr };
        std::shared_ptr<Pane> _zoomedPane{ nullptr };

        winrt::Microsoft::Terminal::Settings::Model::IconStyle _lastIconStyle;
        winrt::hstring _lastIconPath{};
        std::optional<winrt::Windows::UI::Color> _runtimeTabColor{};
        winrt::TerminalApp::TabHeaderControl _headerControl{};
        winrt::TerminalApp::TerminalTabStatus _tabStatus{};

        winrt::TerminalApp::ColorPickupFlyout _tabColorPickup{ nullptr };
        winrt::event_token _colorSelectedToken;
        winrt::event_token _colorClearedToken;
        winrt::event_token _pickerClosedToken;

        struct ContentEventTokens
        {
            winrt::TerminalApp::IPaneContent::BellRequested_revoker BellRequested;
            winrt::TerminalApp::IPaneContent::TitleChanged_revoker TitleChanged;
            winrt::TerminalApp::IPaneContent::TabColorChanged_revoker TabColorChanged;
            winrt::TerminalApp::IPaneContent::TaskbarProgressChanged_revoker TaskbarProgressChanged;
            winrt::TerminalApp::IPaneContent::ConnectionStateChanged_revoker ConnectionStateChanged;
            winrt::TerminalApp::IPaneContent::ReadOnlyChanged_revoker ReadOnlyChanged;
            winrt::TerminalApp::IPaneContent::FocusRequested_revoker FocusRequested;
            winrt::TerminalApp::IPaneContent::NotificationRequested_revoker NotificationRequested;

            // These events literally only apply if the content is a TermControl.
            winrt::Microsoft::Terminal::Control::TermControl::KeySent_revoker KeySent;
            winrt::Microsoft::Terminal::Control::TermControl::CharSent_revoker CharSent;
            winrt::Microsoft::Terminal::Control::TermControl::StringSent_revoker StringSent;

            winrt::TerminalApp::TerminalPaneContent::RestartTerminalRequested_revoker RestartTerminalRequested;
        };
        std::unordered_map<uint32_t, ContentEventTokens> _contentEvents;

        winrt::event_token _rootClosedToken{};

        std::vector<uint32_t> _mruPanes;
        uint32_t _nextPaneId{ 0 };

        bool _receivedKeyDown{ false };
        bool _iconHidden{ false };
        bool _changingActivePane{ false };

        winrt::hstring _runtimeTabText{};
        bool _inRename{ false };
        winrt::Windows::UI::Xaml::Controls::TextBox::LayoutUpdated_revoker _tabRenameBoxLayoutUpdatedRevoker;

        void _Setup();

        SafeDispatcherTimer _bellIndicatorTimer;
        void _BellIndicatorTimerTick(const Windows::Foundation::IInspectable& sender, const Windows::Foundation::IInspectable& e);

        void _UpdateHeaderControlMaxWidth(const winrt::Microsoft::Terminal::Settings::Model::WindowSettings& windowSettings);

        void _CreateContextMenu();
        winrt::hstring _CreateToolTipTitle();

        void _DetachEventHandlersFromContent(const uint32_t paneId);
        void _AttachEventHandlersToContent(const uint32_t paneId, const winrt::TerminalApp::IPaneContent& content);
        void _AttachEventHandlersToPane(std::shared_ptr<Pane> pane);

        void _UpdateActivePane(std::shared_ptr<Pane> pane);
        void _UpdateMenuItemStates();

        winrt::hstring _GetActiveTitle() const;

        void _RecalculateAndApplyReadOnly();

        void _UpdateProgressState();

        void _UpdateConnectionClosedState();
        void _RestartActivePaneConnection();

        winrt::Windows::UI::Xaml::Media::Brush _BackgroundBrush();

        void _MakeTabViewItem();

        void _AppendMoveMenuItems(winrt::Windows::UI::Xaml::Controls::MenuFlyout flyout);
        winrt::Windows::UI::Xaml::Controls::MenuFlyoutSubItem _AppendCloseMenuItems(winrt::Windows::UI::Xaml::Controls::MenuFlyout flyout);
        void _EnableMenuItems();
        void _UpdateSwitchToTabKeyChord();
        void _UpdateToolTip();

        void _RecalculateAndApplyTabColor();
        void _ApplyTabColorOnUIThread(const winrt::Windows::UI::Color& color);
        void _ClearTabBackgroundColor();
        void _RefreshVisualState();

        bool _focused() const noexcept;
        void _updateIsClosable();

        void _addBroadcastHandlers(const winrt::Microsoft::Terminal::Control::TermControl& control, ContentEventTokens& events);

        void _chooseColorClicked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void _renameTabClicked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void _duplicateTabClicked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void _splitTabClicked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void _closePaneClicked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void _exportTextClicked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void _findClicked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);

        void _bubbleRestartTerminalRequested(TerminalApp::TerminalPaneContent sender, const winrt::Windows::Foundation::IInspectable& args);

        friend class ::TerminalAppLocalTests::TabTests;
    };
}

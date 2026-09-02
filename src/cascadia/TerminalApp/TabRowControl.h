// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include <functional>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "winrt/Microsoft.UI.Xaml.Controls.h"
#include "winrt/Windows.UI.Xaml.Controls.h"
#include "winrt/Windows.UI.Xaml.Input.h"

#include "Tab.h"
#include "TabGroup.h"
#include "TabRowControl.g.h"

template<typename... Args>
class ThrottledFunc;

namespace winrt::TerminalApp::implementation
{
    struct TabRowControl : TabRowControlT<TabRowControl>
    {
        TabRowControl();

        void OnNewTabButtonClick(const Windows::Foundation::IInspectable& sender, const Microsoft::UI::Xaml::Controls::SplitButtonClickEventArgs& args);
        void OnNewTabButtonDrop(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::DragEventArgs& e);
        void OnNewTabButtonDragOver(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::DragEventArgs& e);
        void OnVerticalTabSearchTextChanged(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::TextChangedEventArgs& e);
        void OnVerticalTabSelectionChanged(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::SelectionChangedEventArgs& e);
        void OnVerticalTabCloseClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnVerticalTabTitlePointerEntered(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnVerticalTabTitlePointerExited(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnVerticalTabTitlePointerCanceled(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnVerticalTabTitlePointerCaptureLost(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnVerticalTabDragItemsStarting(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::DragItemsStartingEventArgs& e);
        void OnVerticalTabDragItemsCompleted(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::DragItemsCompletedEventArgs& e);
        void OnCollectWindowsClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnTabGroupHeaderClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnTabGroupNewTabClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnNewTabProfilesPanelSizeChanged(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::SizeChangedEventArgs& e);
        void OnRecentSortToggleChecked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnRecentSortToggleUnchecked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);

        void SetTabs(const winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab>& tabs);
        void NotifyTabTitleUpdated(const winrt::TerminalApp::Tab& tab);
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> FilteredTabs() const noexcept;
        void SelectTab(const winrt::TerminalApp::Tab& tab);
        void NotifyTabDirectoryUpdated();
        void SetProjectFilter(const winrt::hstring& projectId);
        void SetProjectOrder(std::vector<winrt::hstring> projectIds);
        void FitNewTabProfileButtons();

        til::typed_event<winrt::Windows::Foundation::IInspectable, winrt::TerminalApp::Tab> VerticalTabSelected;
        std::function<void(const winrt::TerminalApp::Tab&, uint32_t)> VerticalTabMoveRequested;
        std::function<void()> CollectWindowsRequested;
        std::function<void(const winrt::hstring&)> NewTabInDirectoryRequested;

        til::property_changed_event PropertyChanged;
        WINRT_OBSERVABLE_PROPERTY(bool, ShowElevationShield, PropertyChanged.raise, false);
        WINRT_OBSERVABLE_PROPERTY(bool, ShowWorkspacesButton, PropertyChanged.raise, true);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, WorkspaceName, PropertyChanged.raise, L"");
        WINRT_OBSERVABLE_PROPERTY(bool, SortByRecentActivity, PropertyChanged.raise, false);
        WINRT_OBSERVABLE_PROPERTY(bool, CanReorderVerticalTabs, PropertyChanged.raise, true);

    private:
        struct ActivityDebounce
        {
            winrt::TerminalApp::Tab Tab{ nullptr };
            std::shared_ptr<ThrottledFunc<>> Update;
        };

        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> _tabs{ nullptr };
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> _filteredTabs{ nullptr };
        winrt::event_token _tabsChangedToken{};
        winrt::TerminalApp::Tab _selectedTab{ nullptr };
        winrt::TerminalApp::Tab _draggedTab{ nullptr };
        winrt::Windows::UI::Xaml::Controls::ToolTip _verticalTabTitleToolTip{ nullptr };
        winrt::Windows::UI::Xaml::FrameworkElement _verticalTabTitleToolTipOwner{ nullptr };
        std::vector<winrt::TerminalApp::Tab> _recentActivityTabs;
        std::vector<ActivityDebounce> _activityDebounces;
        // Depth counter: >0 while we're programmatically mutating the vertical
        // list selection or rebuilding _filteredTabs, so SelectionChanged
        // callbacks raised by our own mutations don't re-enter tab focusing.
        uint32_t _updatingVerticalSelection{ 0 };
        // Debounces the expensive buffer-text search pass while typing.
        SafeDispatcherTimer _bufferSearchTimer;
        // Non-empty: only show tabs created under this terminal-web project.
        winrt::hstring _projectFilter;
        // Project strip order; the "All" view groups tabs by it.
        std::vector<winrt::hstring> _projectOrder;
        // Project sections of the "All" view (bound through GroupedTabsSource).
        // What the rail's ListView actually shows: TabGroup headers
        // interleaved with Tab rows (or just tabs in flat views).
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::Windows::Foundation::IInspectable> _railItems{ nullptr };
        // Group keys the user collapsed; their tabs stay out of the list.
        std::set<std::wstring> _collapsedGroups;
        // Tab -> collapsed group key, so selecting a hidden tab reopens its group.
        std::vector<std::pair<winrt::TerminalApp::Tab, std::wstring>> _collapsedTabs;

        struct TabGroupBucket
        {
            std::wstring Key;
            std::wstring Name;
            std::wstring Path;
            std::wstring PathKey;
            size_t Rank{ 0 };
            bool CanOpenNewTab{ false };
            std::vector<winrt::TerminalApp::Tab> Tabs;
        };
        std::vector<TabGroupBucket> _bucketTabsByPath(const std::vector<winrt::TerminalApp::Tab>& tabs) const;
        void _publishGroups(std::vector<TabGroupBucket> buckets);
        static std::wstring _pathKey(std::wstring_view path);
        static std::wstring _pathLeaf(std::wstring_view path);
        static std::wstring _displayPath(std::wstring_view path);
        static bool _pathIsUnder(std::wstring_view childKey, std::wstring_view parentKey);

        void _updateFilteredTabs(const bool includeBufferSearch = true);
        void _bufferSearchTimerTick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::Foundation::IInspectable& e);
        void _setRecentActivitySortEnabled(const bool enabled);
        void _markTabRecentlyUpdated(const winrt::TerminalApp::Tab& tab);
        void _closeVerticalTabTitleToolTip();
        void _pruneActivityState();
        void _updateCanReorderVerticalTabs(const std::vector<std::wstring>& terms, const bool grouped);
        bool _tabIsTracked(const winrt::TerminalApp::Tab& tab) const;
        bool _matchesFilter(const winrt::TerminalApp::Tab& tab, const std::vector<std::wstring>& terms, const bool allowBufferSearch) const;
        std::wstring _tabSearchText(const winrt::TerminalApp::Tab& tab, const bool includeBuffer) const;
        static bool _containsTab(const std::vector<winrt::TerminalApp::Tab>& tabs, const winrt::TerminalApp::Tab& tab);
        static bool _containsAllTerms(const std::wstring& text, const std::vector<std::wstring>& terms);
        static bool _shouldSearchBuffer(const std::vector<std::wstring>& terms);
        static void _appendSearchText(std::wstring& text, const winrt::hstring& value);
        static std::vector<std::wstring> _splitSearchTerms(const std::wstring_view filter);
        static std::wstring _foldForSearch(const winrt::hstring& value);
    };
}

namespace winrt::TerminalApp::factory_implementation
{
    BASIC_FACTORY(TabRowControl);
}

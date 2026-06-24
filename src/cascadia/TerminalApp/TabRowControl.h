// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "winrt/Microsoft.UI.Xaml.Controls.h"

#include "Tab.h"
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
        void OnVerticalTabDragItemsStarting(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::DragItemsStartingEventArgs& e);
        void OnVerticalTabDragItemsCompleted(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::DragItemsCompletedEventArgs& e);
        void OnRecentSortToggleChecked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnRecentSortToggleUnchecked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);

        void SetTabs(const winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab>& tabs);
        void NotifyTabTitleUpdated(const winrt::TerminalApp::Tab& tab);
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> FilteredTabs() const noexcept;
        void SelectTab(const winrt::TerminalApp::Tab& tab);

        til::typed_event<winrt::Windows::Foundation::IInspectable, winrt::TerminalApp::Tab> VerticalTabSelected;
        std::function<void(const winrt::TerminalApp::Tab&, uint32_t)> VerticalTabMoveRequested;

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
        std::vector<winrt::TerminalApp::Tab> _recentActivityTabs;
        std::vector<ActivityDebounce> _activityDebounces;
        bool _updatingVerticalSelection{ false };

        void _updateFilteredTabs();
        void _setRecentActivitySortEnabled(const bool enabled);
        void _markTabRecentlyUpdated(const winrt::TerminalApp::Tab& tab);
        void _pruneActivityState();
        void _updateCanReorderVerticalTabs(const std::vector<std::wstring>& terms);
        bool _tabIsTracked(const winrt::TerminalApp::Tab& tab) const;
        bool _matchesFilter(const winrt::TerminalApp::Tab& tab, const std::vector<std::wstring>& terms) const;
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

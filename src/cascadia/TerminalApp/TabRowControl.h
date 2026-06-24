// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "winrt/Microsoft.UI.Xaml.Controls.h"

#include "Tab.h"
#include "TabRowControl.g.h"

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
        void OnVerticalTabItemClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::ItemClickEventArgs& e);
        void OnVerticalTabCloseClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);

        void SetTabs(const winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab>& tabs);
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> FilteredTabs() const noexcept;
        void SelectTab(const winrt::TerminalApp::Tab& tab);

        til::typed_event<winrt::Windows::Foundation::IInspectable, winrt::TerminalApp::Tab> VerticalTabSelected;

        til::property_changed_event PropertyChanged;
        WINRT_OBSERVABLE_PROPERTY(bool, ShowElevationShield, PropertyChanged.raise, false);
        WINRT_OBSERVABLE_PROPERTY(bool, ShowWorkspacesButton, PropertyChanged.raise, true);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, WorkspaceName, PropertyChanged.raise, L"");

    private:
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> _tabs{ nullptr };
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> _filteredTabs{ nullptr };
        winrt::event_token _tabsChangedToken{};
        winrt::TerminalApp::Tab _selectedTab{ nullptr };
        bool _updatingVerticalSelection{ false };

        void _updateFilteredTabs();
        bool _matchesFilter(const winrt::TerminalApp::Tab& tab, const std::vector<std::wstring>& terms) const;
        std::wstring _tabSearchText(const winrt::TerminalApp::Tab& tab, const bool includeBuffer) const;
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

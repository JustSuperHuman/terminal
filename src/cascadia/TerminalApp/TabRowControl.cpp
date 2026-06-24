// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TabRowControl.h"

#include "TabRowControl.g.cpp"

#include <algorithm>
#include <cwctype>

using namespace winrt::Windows::ApplicationModel::DataTransfer;

using namespace winrt;
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Windows::UI::Text;

namespace winrt
{
    namespace MUX = Microsoft::UI::Xaml;
    namespace WUX = Windows::UI::Xaml;
}

namespace winrt::TerminalApp::implementation
{
    TabRowControl::TabRowControl()
    {
        _filteredTabs = winrt::single_threaded_observable_vector<TerminalApp::Tab>();
        InitializeComponent();
    }

    winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> TabRowControl::FilteredTabs() const noexcept
    {
        return _filteredTabs;
    }

    void TabRowControl::SetTabs(const winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab>& tabs)
    {
        if (_tabs && _tabsChangedToken.value != 0)
        {
            _tabs.VectorChanged(_tabsChangedToken);
            _tabsChangedToken = {};
        }

        _tabs = tabs;

        if (_tabs)
        {
            _tabsChangedToken = _tabs.VectorChanged([weakThis{ get_weak() }](auto&&, auto&&) {
                if (auto self{ weakThis.get() })
                {
                    self->_updateFilteredTabs();
                }
            });
        }

        _updateFilteredTabs();
    }

    void TabRowControl::SelectTab(const winrt::TerminalApp::Tab& tab)
    {
        _selectedTab = tab;

        _updatingVerticalSelection = true;
        auto restoreSelection = wil::scope_exit([&]() {
            _updatingVerticalSelection = false;
        });

        if (!_selectedTab)
        {
            VerticalTabList().SelectedIndex(-1);
            return;
        }

        uint32_t filteredIndex{};
        if (_filteredTabs.IndexOf(_selectedTab, filteredIndex))
        {
            VerticalTabList().SelectedItem(_selectedTab);
        }
        else
        {
            VerticalTabList().SelectedIndex(-1);
        }
    }

    std::wstring TabRowControl::_foldForSearch(const winrt::hstring& value)
    {
        std::wstring result{ value.c_str() };
        std::transform(result.begin(), result.end(), result.begin(), [](const wchar_t ch) {
            return static_cast<wchar_t>(std::towlower(ch));
        });
        return result;
    }

    bool TabRowControl::_matchesFilter(const winrt::TerminalApp::Tab& tab, const std::wstring_view filter) const
    {
        if (filter.empty())
        {
            return true;
        }

        const auto title{ _foldForSearch(tab.Title()) };
        return title.find(filter) != std::wstring::npos;
    }

    void TabRowControl::_updateFilteredTabs()
    {
        const auto filter{ _foldForSearch(VerticalTabSearchBox().Text()) };

        _filteredTabs.Clear();
        if (_tabs)
        {
            for (const auto& tab : _tabs)
            {
                if (_matchesFilter(tab, filter))
                {
                    _filteredTabs.Append(tab);
                }
            }
        }

        SelectTab(_selectedTab);
    }

    // Method Description:
    // - Bound in the Xaml editor to the [+] button.
    // Arguments:
    // <unused>
    void TabRowControl::OnNewTabButtonClick(const IInspectable&, const Controls::SplitButtonClickEventArgs&)
    {
    }

    // Method Description:
    // - Bound in Drag&Drop of the Xaml editor to the [+] button.
    // Arguments:
    // <unused>
    void TabRowControl::OnNewTabButtonDrop(const IInspectable&, const winrt::Windows::UI::Xaml::DragEventArgs&)
    {
    }

    void TabRowControl::OnVerticalTabSearchTextChanged(const winrt::Windows::Foundation::IInspectable&,
                                                       const winrt::Windows::UI::Xaml::Controls::TextChangedEventArgs&)
    {
        _updateFilteredTabs();
    }

    void TabRowControl::OnVerticalTabSelectionChanged(const winrt::Windows::Foundation::IInspectable&,
                                                      const winrt::Windows::UI::Xaml::Controls::SelectionChangedEventArgs&)
    {
        if (_updatingVerticalSelection)
        {
            return;
        }

        if (const auto tab{ VerticalTabList().SelectedItem().try_as<TerminalApp::Tab>() })
        {
            _selectedTab = tab;
            VerticalTabSelected.raise(*this, tab);
        }
    }

    void TabRowControl::OnVerticalTabItemClick(const winrt::Windows::Foundation::IInspectable&,
                                               const winrt::Windows::UI::Xaml::Controls::ItemClickEventArgs& e)
    {
        if (const auto tab{ e.ClickedItem().try_as<TerminalApp::Tab>() })
        {
            _selectedTab = tab;
            VerticalTabSelected.raise(*this, tab);
        }
    }

    void TabRowControl::OnVerticalTabCloseClick(const winrt::Windows::Foundation::IInspectable& sender,
                                                const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        if (const auto button{ sender.try_as<winrt::Windows::UI::Xaml::Controls::Button>() })
        {
            if (const auto tab{ button.DataContext().try_as<TerminalApp::Tab>() })
            {
                if (const auto tabImpl{ winrt::get_self<Tab>(tab) })
                {
                    tabImpl->CloseRequested.raise(nullptr, nullptr);
                }
            }
        }
    }

    // Method Description:
    // - Bound in Drag-over of the Xaml editor to the [+] button.
    // Allows drop of 'StorageItems' which will be used as StartingDirectory
    // Arguments:
    //  - <unused>
    //  - e: DragEventArgs which hold the items
    void TabRowControl::OnNewTabButtonDragOver(const IInspectable&, const winrt::Windows::UI::Xaml::DragEventArgs& e)
    {
        // We can only handle drag/dropping StorageItems (files).
        // If the format on the clipboard is anything else, returning
        // early here will prevent the drag/drop from doing anything.
        if (!e.DataView().Contains(StandardDataFormats::StorageItems()))
        {
            return;
        }

        // Make sure to set the AcceptedOperation, so that we can later receive the path in the Drop event
        e.AcceptedOperation(DataPackageOperation::Copy);

        const auto modifiers = static_cast<uint32_t>(e.Modifiers());
        if (WI_IsFlagSet(modifiers, static_cast<uint32_t>(DragDrop::DragDropModifiers::Alt)))
        {
            e.DragUIOverride().Caption(RS_(L"DropPathTabSplit/Text"));
        }
        else if (WI_IsFlagSet(modifiers, static_cast<uint32_t>(DragDrop::DragDropModifiers::Shift)))
        {
            e.DragUIOverride().Caption(RS_(L"DropPathTabNewWindow/Text"));
        }
        else
        {
            e.DragUIOverride().Caption(RS_(L"DropPathTabRun/Text"));
        }

        // Sets if the caption is visible
        e.DragUIOverride().IsCaptionVisible(true);
        // Sets if the dragged content is visible
        e.DragUIOverride().IsContentVisible(false);
        // Sets if the glyph is visible
        e.DragUIOverride().IsGlyphVisible(false);
    }
}

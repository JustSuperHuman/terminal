// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TabRowControl.h"

#include <ThrottledFunc.h>

#include "TabRowControl.g.cpp"

#include <algorithm>
#include <chrono>
#include <cwctype>
#include <utility>
#include <vector>

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
    static constexpr size_t MaxSearchBufferChars = 32768;
    static constexpr std::chrono::seconds RecentActivityDebounce{ 2 };

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
                    self->_pruneActivityState();
                    self->_updateFilteredTabs();
                }
            });
        }

        _pruneActivityState();
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
            if (VerticalTabList().SelectedItem() != _selectedTab)
            {
                VerticalTabList().SelectedItem(_selectedTab);
            }
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

    std::vector<std::wstring> TabRowControl::_splitSearchTerms(const std::wstring_view filter)
    {
        std::vector<std::wstring> terms;

        size_t termStart{};
        while (termStart < filter.size())
        {
            while (termStart < filter.size() && std::iswspace(filter[termStart]))
            {
                ++termStart;
            }

            auto termEnd{ termStart };
            while (termEnd < filter.size() && !std::iswspace(filter[termEnd]))
            {
                ++termEnd;
            }

            if (termEnd > termStart)
            {
                terms.emplace_back(filter.substr(termStart, termEnd - termStart));
            }

            termStart = termEnd;
        }

        return terms;
    }

    void TabRowControl::_appendSearchText(std::wstring& text, const winrt::hstring& value)
    {
        if (value.empty())
        {
            return;
        }

        const auto folded{ _foldForSearch(value) };
        text.append(folded);
        text.push_back(L' ');

        for (const auto ch : folded)
        {
            switch (ch)
            {
            case L'\\':
            case L'/':
            case L'_':
            case L'-':
            case L'.':
            case L':':
                text.push_back(L' ');
                break;
            default:
                text.push_back(ch);
                break;
            }
        }
        text.push_back(L' ');
    }

    bool TabRowControl::_containsAllTerms(const std::wstring& text, const std::vector<std::wstring>& terms)
    {
        return std::all_of(terms.begin(), terms.end(), [&](const auto& term) {
            return text.find(term) != std::wstring::npos;
        });
    }

    bool TabRowControl::_shouldSearchBuffer(const std::vector<std::wstring>& terms)
    {
        return std::any_of(terms.begin(), terms.end(), [](const auto& term) {
            return term.size() > 1;
        });
    }

    bool TabRowControl::_containsTab(const std::vector<winrt::TerminalApp::Tab>& tabs, const winrt::TerminalApp::Tab& tab)
    {
        return std::find(tabs.begin(), tabs.end(), tab) != tabs.end();
    }

    bool TabRowControl::_tabIsTracked(const winrt::TerminalApp::Tab& tab) const
    {
        uint32_t index{};
        return _tabs && _tabs.IndexOf(tab, index);
    }

    void TabRowControl::_pruneActivityState()
    {
        _recentActivityTabs.erase(std::remove_if(_recentActivityTabs.begin(), _recentActivityTabs.end(), [this](const auto& tab) {
                                      return !_tabIsTracked(tab);
                                  }),
                                  _recentActivityTabs.end());

        _activityDebounces.erase(std::remove_if(_activityDebounces.begin(), _activityDebounces.end(), [this](const auto& item) {
                                     return !_tabIsTracked(item.Tab);
                                 }),
                                 _activityDebounces.end());
    }

    void TabRowControl::_updateCanReorderVerticalTabs(const std::vector<std::wstring>& terms)
    {
        const auto canReorder{ !SortByRecentActivity() && terms.empty() };
        if (CanReorderVerticalTabs() != canReorder)
        {
            CanReorderVerticalTabs(canReorder);
        }
    }

    void TabRowControl::_setRecentActivitySortEnabled(const bool enabled)
    {
        if (SortByRecentActivity() != enabled)
        {
            SortByRecentActivity(enabled);
            _updateFilteredTabs();
        }
    }

    void TabRowControl::NotifyTabTitleUpdated(const winrt::TerminalApp::Tab& tab)
    {
        if (!tab || !_tabIsTracked(tab))
        {
            return;
        }

        const auto existing = std::find_if(_activityDebounces.begin(), _activityDebounces.end(), [&](const auto& item) {
            return item.Tab == tab;
        });

        if (existing != _activityDebounces.end())
        {
            existing->Update->Run();
            return;
        }

        auto weakThis{ get_weak() };
        auto update = std::make_shared<ThrottledFunc<>>(
            winrt::Windows::System::DispatcherQueue::GetForCurrentThread(),
            til::throttled_func_options{
                .delay = RecentActivityDebounce,
                .debounce = true,
                .trailing = true,
            },
            [weakThis, tab]() {
                if (const auto self{ weakThis.get() })
                {
                    self->_markTabRecentlyUpdated(tab);
                }
            });

        _activityDebounces.push_back({ tab, update });
        update->Run();
    }

    void TabRowControl::_markTabRecentlyUpdated(const winrt::TerminalApp::Tab& tab)
    {
        if (!_tabIsTracked(tab))
        {
            _pruneActivityState();
            return;
        }

        _recentActivityTabs.erase(std::remove(_recentActivityTabs.begin(), _recentActivityTabs.end(), tab), _recentActivityTabs.end());
        _recentActivityTabs.insert(_recentActivityTabs.begin(), tab);

        if (SortByRecentActivity())
        {
            _updateFilteredTabs();
        }
    }

    std::wstring TabRowControl::_tabSearchText(const winrt::TerminalApp::Tab& tab, const bool includeBuffer) const
    {
        std::wstring text;
        _appendSearchText(text, tab.Title());

        const auto tabImpl{ winrt::get_self<Tab>(tab) };
        if (!tabImpl)
        {
            return text;
        }

        if (const auto content{ tabImpl->GetActiveContent() })
        {
            _appendSearchText(text, content.Title());
        }

        if (const auto profile{ tabImpl->GetFocusedProfile() })
        {
            _appendSearchText(text, profile.Name());
            _appendSearchText(text, profile.TabTitle());
            _appendSearchText(text, profile.Source());
            _appendSearchText(text, profile.Commandline());
            _appendSearchText(text, profile.StartingDirectory());
            _appendSearchText(text, profile.EvaluatedStartingDirectory());
        }

        if (const auto control{ tabImpl->GetActiveTerminalControl() })
        {
            _appendSearchText(text, control.WorkingDirectory());

            const auto history{ control.CommandHistory() };
            _appendSearchText(text, history.CurrentCommandline());
            if (const auto commands{ history.History() })
            {
                for (const auto& command : commands)
                {
                    _appendSearchText(text, command);
                }
            }
            if (const auto quickFixes{ history.QuickFixes() })
            {
                for (const auto& quickFix : quickFixes)
                {
                    _appendSearchText(text, quickFix);
                }
            }

            if (includeBuffer)
            {
                auto buffer{ control.ReadEntireBuffer() };
                if (buffer.size() > MaxSearchBufferChars)
                {
                    buffer = winrt::hstring{ std::wstring_view{ buffer }.substr(buffer.size() - MaxSearchBufferChars) };
                }

                _appendSearchText(text, buffer);
            }
        }

        return text;
    }

    bool TabRowControl::_matchesFilter(const winrt::TerminalApp::Tab& tab, const std::vector<std::wstring>& terms) const
    {
        if (terms.empty())
        {
            return true;
        }

        const auto fastText{ _tabSearchText(tab, false) };
        if (_containsAllTerms(fastText, terms))
        {
            return true;
        }

        return _shouldSearchBuffer(terms) && _containsAllTerms(_tabSearchText(tab, true), terms);
    }

    void TabRowControl::_updateFilteredTabs()
    {
        const auto filter{ _foldForSearch(VerticalTabSearchBox().Text()) };
        const auto terms{ _splitSearchTerms(filter) };

        _updateCanReorderVerticalTabs(terms);

        std::vector<TerminalApp::Tab> visibleTabs;
        auto appendIfVisible = [&](const auto& tab) {
            if (!_containsTab(visibleTabs, tab) && _tabIsTracked(tab) && _matchesFilter(tab, terms))
            {
                visibleTabs.push_back(tab);
            }
        };

        if (SortByRecentActivity())
        {
            for (const auto& tab : _recentActivityTabs)
            {
                appendIfVisible(tab);
            }
        }

        if (_tabs)
        {
            for (const auto& tab : _tabs)
            {
                appendIfVisible(tab);
            }
        }

        _filteredTabs.Clear();
        for (const auto& tab : visibleTabs)
        {
            _filteredTabs.Append(tab);
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

    void TabRowControl::OnVerticalTabDragItemsStarting(const winrt::Windows::Foundation::IInspectable&,
                                                       const winrt::Windows::UI::Xaml::Controls::DragItemsStartingEventArgs& e)
    {
        _draggedTab = nullptr;

        const auto items{ e.Items() };
        if (items && items.Size() == 1)
        {
            _draggedTab = items.GetAt(0).try_as<TerminalApp::Tab>();
        }
    }

    void TabRowControl::OnVerticalTabDragItemsCompleted(const winrt::Windows::Foundation::IInspectable&,
                                                        const winrt::Windows::UI::Xaml::Controls::DragItemsCompletedEventArgs&)
    {
        auto draggedTab{ std::exchange(_draggedTab, nullptr) };
        if (!draggedTab || !VerticalTabMoveRequested)
        {
            _updateFilteredTabs();
            return;
        }

        uint32_t targetIndex{};
        if (_filteredTabs.IndexOf(draggedTab, targetIndex))
        {
            VerticalTabMoveRequested(draggedTab, targetIndex);
        }

        _updateFilteredTabs();
    }

    void TabRowControl::OnRecentSortToggleChecked(const winrt::Windows::Foundation::IInspectable&,
                                                  const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        _setRecentActivitySortEnabled(true);
    }

    void TabRowControl::OnRecentSortToggleUnchecked(const winrt::Windows::Foundation::IInspectable&,
                                                    const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        _setRecentActivitySortEnabled(false);
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

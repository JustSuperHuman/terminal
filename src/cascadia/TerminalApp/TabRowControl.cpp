// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TabRowControl.h"

#include <ThrottledFunc.h>

#include "TabRowControl.g.cpp"
#include "TabGroup.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cwctype>
#include <filesystem>
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
    static constexpr double VerticalTabTitleToolTipMaxWidth = 560.0;

    TabRowControl::TabRowControl()
    {
        _filteredTabs = winrt::single_threaded_observable_vector<TerminalApp::Tab>();
        _railItems = winrt::single_threaded_observable_vector<winrt::Windows::Foundation::IInspectable>();
        InitializeComponent();

        const auto list{ VerticalTabList() };
        list.ItemsSource(_railItems);
        // Arrowing through the rail moves the keyboard, not the window.
        // Selection is what switches tab - and switching a tab hands focus to
        // its terminal control - so with the ListView's default of selection
        // following focus, one Down key ended keyboard navigation before it
        // started. Enter, Space and a click still activate a row.
        list.SingleSelectionFollowsFocus(false);
        list.KeyDown({ get_weak(), &TabRowControl::_onVerticalTabListKeyDown });
        list.GettingFocus({ get_weak(), &TabRowControl::_onVerticalTabListGettingFocus });
        list.GotFocus({ get_weak(), &TabRowControl::_onVerticalTabListFocusChanged });
        list.LostFocus({ get_weak(), &TabRowControl::_onVerticalTabListFocusChanged });
        list.ContainerContentChanging({ get_weak(), &TabRowControl::_onVerticalTabContainerContentChanging });
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

    // Method Description:
    // - The window's focused tab changed. Only a *change* of tab reveals a
    //   folded section (like an IDE revealing the active file in a tree);
    //   re-selecting the same tab during a rebuild must not, or collapsing
    //   the section that holds the focused tab would instantly reopen it.
    void TabRowControl::SelectTab(const winrt::TerminalApp::Tab& tab)
    {
        const auto changed{ tab != _selectedTab };
        _selectedTab = tab;

        if (changed && _selectedTab)
        {
            const auto hidden = std::find_if(_collapsedTabs.begin(), _collapsedTabs.end(), [&](const auto& item) {
                return item.first == _selectedTab;
            });
            if (hidden != _collapsedTabs.end())
            {
                _collapsedGroups.erase(hidden->second);
            }
        }

        // Grouped headers show which folded section holds the focused tab,
        // so a focus change needs the sections recomputed (cheap, diffed).
        if (changed && _isGroupedView())
        {
            _updateFilteredTabs(false);
            return;
        }

        _syncListSelection();
    }

    void TabRowControl::_syncListSelection()
    {
        ++_updatingVerticalSelection;
        auto restoreSelection = wil::scope_exit([&]() {
            --_updatingVerticalSelection;
        });

        if (!_selectedTab)
        {
            VerticalTabList().SelectedIndex(-1);
            _updateRowActionAffordances();
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

        _updateRowActionAffordances();
    }

    // Method Description:
    // - The rail row keyboard focus currently sits in, or null when focus is
    //   somewhere else entirely. Walks up from the focused element the way
    //   CommandPalette does, because a row's focus can be on the container or
    //   on anything inside its template.
    winrt::Windows::Foundation::IInspectable TabRowControl::_railItemHoldingFocus()
    {
        const auto root{ XamlRoot() };
        const auto list{ VerticalTabList() };
        if (!root || !list)
        {
            return nullptr;
        }

        auto element{ WUX::Input::FocusManager::GetFocusedElement(root).try_as<WUX::DependencyObject>() };
        while (element)
        {
            if (element == list)
            {
                // The list itself, not one of its rows.
                return nullptr;
            }
            if (const auto container{ element.try_as<WUX::Controls::ListViewItem>() })
            {
                return list.ItemFromContainer(container);
            }
            element = WUX::Media::VisualTreeHelper::GetParent(element);
        }
        return nullptr;
    }

    // Method Description:
    // - The container of the first tab row at or after `startIndex`, walking
    //   forwards or backwards. Section headers are skipped: they're rows in
    //   the same list but they aren't places the keyboard should land.
    // Arguments:
    // - realize: scroll a virtualized row into view so it has a container.
    //   Only safe from an explicit user gesture, never from a focus event.
    winrt::Windows::UI::Xaml::Controls::ListViewItem TabRowControl::_railTabContainer(const int32_t startIndex, const bool forward, const bool realize)
    {
        const auto list{ VerticalTabList() };
        const auto count{ gsl::narrow_cast<int32_t>(_railItems.Size()) };
        for (auto i = startIndex; i >= 0 && i < count; i += (forward ? 1 : -1))
        {
            const auto item{ _railItems.GetAt(gsl::narrow_cast<uint32_t>(i)) };
            if (!item.try_as<TerminalApp::Tab>())
            {
                continue;
            }

            auto container{ list.ContainerFromItem(item).try_as<WUX::Controls::ListViewItem>() };
            if (!container && realize)
            {
                list.ScrollIntoView(item);
                list.UpdateLayout();
                container = list.ContainerFromItem(item).try_as<WUX::Controls::ListViewItem>();
            }
            return container;
        }
        return nullptr;
    }

    // Method Description:
    // - Puts the keyboard back where it was after a rebuild. The rail
    //   regroups itself whenever a tab changes directory, and that can pull
    //   the focused row's container out from under the user; without this,
    //   focus lands back at the top of the list or leaves the rail entirely.
    void TabRowControl::_restoreRailFocus(const winrt::Windows::Foundation::IInspectable& item)
    try
    {
        if (!item || _railItemHoldingFocus())
        {
            // Focus wasn't in the rail, or the rebuild didn't disturb it.
            return;
        }

        const auto list{ VerticalTabList() };
        // The row was re-inserted a moment ago and its container is generated
        // on the next layout pass; without this there's nothing to focus yet.
        list.UpdateLayout();

        WUX::Controls::ListViewItem container{ nullptr };
        uint32_t index{};
        if (_railItems.IndexOf(item, index))
        {
            container = list.ContainerFromItem(item).try_as<WUX::Controls::ListViewItem>();
        }
        if (!container && _selectedTab)
        {
            // That row is gone (filtered out, or folded into a section): the
            // focused tab is the next best place to be.
            container = list.ContainerFromItem(_selectedTab).try_as<WUX::Controls::ListViewItem>();
        }
        if (!container)
        {
            return;
        }

        if (container.IsTabStop())
        {
            container.Focus(WUX::FocusState::Programmatic);
        }
        else if (const auto inner{ WUX::Input::FocusManager::FindFirstFocusableElement(container).try_as<WUX::Controls::Control>() })
        {
            // A section header's container isn't a tab stop; the button that
            // folds it is what the keyboard was actually on.
            inner.Focus(WUX::FocusState::Programmatic);
        }
    }
    catch (...)
    {
        // Best effort only: forcing layout to find a just-inserted container
        // can throw if XAML is already mid-pass, and losing the keyboard is
        // never worth taking the rail down for.
        LOG_CAUGHT_EXCEPTION();
    }

    // Hands the keyboard back to the terminal the rail is pointing at.
    void TabRowControl::_focusSelectedTerminal()
    {
        if (_selectedTab)
        {
            _selectedTab.Focus(WUX::FocusState::Programmatic);
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

    void TabRowControl::_updateCanReorderVerticalTabs(const std::vector<std::wstring>& terms, const bool grouped)
    {
        // Drag-reorder maps a filtered index straight onto the window's tab
        // order, so it's only safe while the rail shows tabs in window order
        // (grouped sources don't support ListView reordering either).
        const auto canReorder{ !SortByRecentActivity() && terms.empty() && !grouped };
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

    void TabRowControl::_closeVerticalTabTitleToolTip()
    {
        if (_verticalTabTitleToolTip)
        {
            _verticalTabTitleToolTip.IsOpen(false);
        }

        if (_verticalTabTitleToolTipOwner)
        {
            WUX::Controls::ToolTipService::SetToolTip(_verticalTabTitleToolTipOwner, winrt::Windows::Foundation::IInspectable{ nullptr });
        }

        _verticalTabTitleToolTip = nullptr;
        _verticalTabTitleToolTipOwner = nullptr;
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
    try
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
    catch (...)
    {
        // A tab that's mid-teardown can throw from any of the accessors
        // above; treat it as having no searchable text rather than crashing.
        LOG_CAUGHT_EXCEPTION();
        return {};
    }

    bool TabRowControl::_matchesFilter(const winrt::TerminalApp::Tab& tab, const std::vector<std::wstring>& terms, const bool allowBufferSearch) const
    {
        if (!_sectionFilter.empty() && !SectionContainsTab(_sectionFilter, tab))
        {
            return false;
        }

        if (terms.empty())
        {
            return true;
        }

        const auto fastText{ _tabSearchText(tab, false) };
        if (_containsAllTerms(fastText, terms))
        {
            return true;
        }

        return allowBufferSearch && _shouldSearchBuffer(terms) && _containsAllTerms(_tabSearchText(tab, true), terms);
    }

    // Method Description:
    // - A pane changed directory (or project); regroup the "All" view so the
    //   tab moves to the section it now belongs to, or re-filter a project
    //   view so it enters/leaves the shown project. Search results are flat
    //   and refresh on their own debounce, so they're left alone.
    void TabRowControl::NotifyTabDirectoryUpdated()
    {
        if (VerticalTabSearchBox().Text().empty())
        {
            _updateFilteredTabs(false);
        }
    }

    // The rail keeps its headings whenever it is showing tabs in directory
    // order - with or without a section filter. Filtering to a section is a
    // narrowing of the same index, not a different view, so the heading (and
    // any subheading nested under it) stays put and the strip's chip and the
    // rail's heading keep reading as one object. Only search results and the
    // recent-activity sort are flat, because neither is ordered by directory.
    bool TabRowControl::_isGroupedView()
    {
        return !SortByRecentActivity() && VerticalTabSearchBox().Text().empty();
    }

    const std::vector<TabRowControl::RailSection>& TabRowControl::RailSections() const noexcept
    {
        return _railSections;
    }

    winrt::hstring TabRowControl::SectionFilter() const noexcept
    {
        return _sectionFilter;
    }

    void TabRowControl::SetSectionFilter(const winrt::hstring& sectionKey)
    {
        if (_sectionFilter != sectionKey)
        {
            _sectionFilter = sectionKey;
            _updateFilteredTabs();

            // A narrowed rail is short; start it at the top so the section
            // the user just picked is the first thing under the search box.
            if (_railItems && _railItems.Size() > 0)
            {
                if (const auto list{ VerticalTabList() })
                {
                    list.ScrollIntoView(_railItems.GetAt(0));
                }
            }
        }
    }

    // Method Description:
    // - Display names for section directories, so the bridge's project names
    //   (project.json, a rename) reach the rail's headings and the strip's
    //   chips through one path instead of two that can disagree.
    void TabRowControl::SetSectionNames(std::map<std::wstring, winrt::hstring> names)
    {
        if (_sectionNames != names)
        {
            _sectionNames = std::move(names);
            _updateFilteredTabs();
        }
    }

    // Method Description:
    // - Records the strip's order as normalized directories. Sections sort by
    //   that rank first, then by name, and the strip is rebuilt from the
    //   result - so this is the only place the two can be ordered from.
    void TabRowControl::SetSectionOrder(std::vector<std::wstring> directoryKeys)
    {
        if (_sectionOrder != directoryKeys)
        {
            _sectionOrder = std::move(directoryKeys);
            _updateFilteredTabs();
        }
    }

    // Method Description:
    // - The section key of the tab's own heading. Never empty: a tab with no
    //   directory belongs to the "no directory" section.
    winrt::hstring TabRowControl::SectionKeyForTab(const winrt::TerminalApp::Tab& tab)
    {
        if (!tab)
        {
            return winrt::hstring{ NoDirectorySectionKey };
        }
        return SectionKeyForDirectory(winrt::hstring{ _sectionRootForTab(tab) });
    }

    winrt::hstring TabRowControl::SectionKeyForDirectory(const winrt::hstring& directory)
    {
        const auto key{ _pathKey(directory) };
        return key.empty() ? winrt::hstring{ NoDirectorySectionKey } : winrt::hstring{ L"dir:" + key };
    }

    // Method Description:
    // - Does `sectionKey` name a heading that holds `tab`? An empty key is
    //   "All" and holds everything.
    // - Containment matters: the rail draws J:\Projects\instagram as a
    //   subheading *inside* the J:\Projects section, so filtering to
    //   J:\Projects has to keep instagram's tabs. Equality alone would empty
    //   half of a section the moment you selected it.
    bool TabRowControl::SectionContainsTab(const winrt::hstring& sectionKey, const winrt::TerminalApp::Tab& tab)
    {
        if (sectionKey.empty())
        {
            return true;
        }
        if (!tab)
        {
            return false;
        }

        const auto tabKey{ _pathKey(_sectionRootForTab(tab)) };
        std::wstring_view section{ sectionKey };
        if (section == NoDirectorySectionKey)
        {
            return tabKey.empty();
        }
        if (!section.starts_with(L"dir:"))
        {
            return false;
        }
        section.remove_prefix(4);
        return !tabKey.empty() && (std::wstring_view{ tabKey } == section || _pathIsUnder(tabKey, section));
    }

    // Method Description:
    // - Scrolls a section's heading into view without touching the filter, so
    //   that clearing a chip back to "All" lands the user where they were
    //   rather than at the top of a list they have to re-find their place in.
    void TabRowControl::ScrollSectionIntoView(const winrt::hstring& sectionKey)
    {
        if (sectionKey.empty() || !_railItems)
        {
            return;
        }

        // The "no directory" heading's own key is empty; the sentinel exists
        // only so the strip can tell it apart from "no filter".
        const std::wstring_view groupKey{ std::wstring_view{ sectionKey } == NoDirectorySectionKey ? std::wstring_view{} : std::wstring_view{ sectionKey } };
        for (const auto& item : _railItems)
        {
            const auto group{ item.try_as<winrt::TerminalApp::TabGroup>() };
            if (!group)
            {
                continue;
            }
            const auto key{ group.Key() };
            if (std::wstring_view{ key } == groupKey)
            {
                if (const auto list{ VerticalTabList() })
                {
                    list.ScrollIntoView(item);
                }
                return;
            }
        }
    }

    void TabRowControl::_updateFilteredTabs(const bool includeBufferSearch)
    {
        const auto query{ VerticalTabSearchBox().Text() };
        const auto filter{ _foldForSearch(query) };
        const auto terms{ _splitSearchTerms(filter) };
        // Which row the keyboard is on, so a rebuild can put it back there.
        const auto focusedItem{ _railItemHoldingFocus() };

        std::vector<TerminalApp::Tab> visibleTabs;
        auto appendIfVisible = [&](const auto& tab) {
            if (!_containsTab(visibleTabs, tab) && _tabIsTracked(tab) && _matchesFilter(tab, terms, includeBufferSearch))
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

        // "All" view: sections per project directory (T3 Code style), in the
        // project strip's order, window order within a section. Recent-activity
        // sort and search results stay flat and keep their own ordering.
        const auto grouped{ _isGroupedView() && terms.empty() };
        _updateCanReorderVerticalTabs(terms, grouped);

        // Clearing/appending the bound observable vectors makes the ListView
        // raise SelectionChanged for our own mutations; suppress those so
        // they can't re-enter tab focusing (and, transitively, this method).
        ++_updatingVerticalSelection;
        auto restoreSelection = wil::scope_exit([&]() {
            --_updatingVerticalSelection;
        });

        _collapsedTabs.clear();
        std::vector<winrt::Windows::Foundation::IInspectable> items;
        if (grouped)
        {
            auto buckets{ _bucketTabsByPath(visibleTabs) };
            visibleTabs.clear();
            for (auto& bucket : buckets)
            {
                // A collapsed section hides everything nested inside it too;
                // parents precede children, so the parent's verdict is ready.
                if (bucket.Parent >= 0 && !buckets[bucket.Parent].HiddenBy.empty())
                {
                    bucket.HiddenBy = buckets[bucket.Parent].HiddenBy;
                }
                else if (_collapsedGroups.contains(bucket.Key))
                {
                    bucket.HiddenBy = bucket.Key;
                }
                for (const auto& tab : bucket.Tabs)
                {
                    if (!bucket.HiddenBy.empty())
                    {
                        _collapsedTabs.emplace_back(tab, bucket.HiddenBy);
                    }
                    else
                    {
                        visibleTabs.push_back(tab);
                    }
                }
            }
            _publishGroups(std::move(buckets), items);
        }
        else
        {
            _groupCache.clear();
            for (const auto& tab : visibleTabs)
            {
                if (const auto tabImpl{ winrt::get_self<implementation::Tab>(tab) })
                {
                    tabImpl->RailSubtitle(tab.ProjectName());
                    tabImpl->RailDepth(0);
                }
                items.push_back(tab);
            }
        }
        _applyRailItems(items);
        _updateSearchChrome(query, !items.empty());

        _filteredTabs.Clear();
        for (const auto& tab : visibleTabs)
        {
            _filteredTabs.Append(tab);
        }

        _syncListSelection();
        _restoreRailFocus(focusedItem);
        _updateRailSections();
    }

    // Method Description:
    // - Recomputes the rail's top-level headings and, when the set actually
    //   changed, tells the project strip to rebuild from them.
    // - Deliberately bucketed from *every* tracked tab rather than from the
    //   rows the rail is currently showing: those are already narrowed by the
    //   search box and the active section, so deriving the strip from them
    //   would collapse it to a single chip the moment one was picked.
    // - Only Depth == 0 buckets become chips; a nested subheading stays a
    //   rail-only idea, and its tabs are already counted in its parent's
    //   TotalCount.
    void TabRowControl::_updateRailSections()
    {
        std::vector<TerminalApp::Tab> allTabs;
        if (_tabs)
        {
            allTabs.reserve(_tabs.Size());
            for (const auto& tab : _tabs)
            {
                allTabs.push_back(tab);
            }
        }

        std::vector<RailSection> sections;
        for (const auto& bucket : _bucketTabsByPath(allTabs))
        {
            if (bucket.Depth != 0)
            {
                continue;
            }
            sections.push_back(RailSection{
                bucket.Key.empty() ? winrt::hstring{ NoDirectorySectionKey } : winrt::hstring{ bucket.Key },
                winrt::hstring{ bucket.Name },
                winrt::hstring{ bucket.Directory },
                bucket.TotalCount });
        }

        if (sections == _railSections)
        {
            return;
        }
        _railSections = std::move(sections);

        // The strip's rebuild pushes names and order back in here, which lands
        // in _updateFilteredTabs again; publish at most one level deep and let
        // the equality check above settle the rest.
        if (RailSectionsChanged && _publishingRailSections == 0)
        {
            ++_publishingRailSections;
            auto restore = wil::scope_exit([&]() {
                --_publishingRailSections;
            });
            RailSectionsChanged();
        }
    }

    // Method Description:
    // - Looks up a rail string by name instead of through RS_(), which
    //   registers the key for the debug residency check and fails fast on
    //   launch when it's missing. The rail's strings are added in a file this
    //   one doesn't own, so a missing one has to degrade instead.
    winrt::hstring TabRowControl::_optionalResourceString(const std::wstring_view key)
    {
        return HasLibraryResourceWithName(key) ? GetLibraryResourceString(key) : winrt::hstring{};
    }

    // The clear button and the empty state are optional parts of the rail's
    // markup; find them once by name so this file works with or without them.
    void TabRowControl::_resolveRailChrome()
    {
        if (_railChromeResolved)
        {
            return;
        }

        const auto scope{ VerticalTabRoot() };
        if (!scope)
        {
            return;
        }

        _railChromeResolved = true;
        _searchClearButton = scope.FindName(L"VerticalTabSearchClearButton").try_as<WUX::FrameworkElement>();
        _emptyState = scope.FindName(L"VerticalTabEmptyState").try_as<WUX::FrameworkElement>();
        _emptyStateText = scope.FindName(L"VerticalTabEmptyStateText").try_as<WUX::Controls::TextBlock>();
    }

    // Method Description:
    // - Keeps the search affordances honest: there's a clear button only while
    //   there's something to clear, and a query that matches nothing says so
    //   rather than leaving the rail blank.
    // Arguments:
    // - query: the raw (unfolded) search text, as typed.
    // - anyRows: whether the rail has anything at all to show.
    void TabRowControl::_updateSearchChrome(const winrt::hstring& query, const bool anyRows)
    {
        _resolveRailChrome();

        if (_searchClearButton)
        {
            _searchClearButton.Visibility(query.empty() ? WUX::Visibility::Collapsed : WUX::Visibility::Visible);
        }

        const auto nothingMatched{ !anyRows && !query.empty() };
        if (_emptyState)
        {
            _emptyState.Visibility(nothingMatched ? WUX::Visibility::Visible : WUX::Visibility::Collapsed);
        }

        if (nothingMatched && _emptyStateText)
        {
            // Without the string, leave whatever the markup says rather than
            // showing half a sentence.
            if (const auto format{ _optionalResourceString(L"TabRailNoSearchResults") }; !format.empty())
            {
                std::wstring message;
                try
                {
                    message = fmt::format(fmt::runtime(std::wstring_view{ format }), std::wstring_view{ query });
                }
                catch (...)
                {
                    // A malformed translation shouldn't take the rail with it.
                    LOG_CAUGHT_EXCEPTION();
                    message = std::wstring{ format };
                }
                _emptyStateText.Text(winrt::hstring{ message });
            }
        }
    }

    // The user's profile directory, normalized like _pathKey.
    std::wstring TabRowControl::_homeKey()
    {
        static const std::wstring key = [] {
            return _pathKey(wil::TryGetEnvironmentVariableW<std::wstring>(L"USERPROFILE"));
        }();
        return key;
    }

    // Directories that are never a project of their own: a drive or UNC
    // root, or the home folder. A tab parked there is just a shell, and
    // letting it become a section would swallow every real project beneath.
    bool TabRowControl::_isGenericRoot(std::wstring_view pathKey)
    {
        if (pathKey.empty())
        {
            return true;
        }
        if (pathKey.size() <= 3)
        {
            return true; // "c:\"
        }
        if (pathKey.starts_with(L"\\\\"))
        {
            // "\\server\share" has exactly three separators.
            return std::count(pathKey.begin(), pathKey.end(), L'\\') <= 3;
        }
        const auto home{ _homeKey() };
        return !home.empty() && pathKey == home;
    }

    // Method Description:
    // - Picks the directory a tab's section is named after: the highest of
    //   its bridge project directory, its git repository root and its live
    //   working directory that still contains the working directory. So a
    //   tab in F:\repo\src sits in the F:\repo section even when no tab is
    //   open at the repo root, while a shell parked at C:\ or ~ never
    //   becomes a section that absorbs every project underneath it.
    std::wstring TabRowControl::_sectionRootForTab(const winrt::TerminalApp::Tab& tab)
    {
        const std::wstring cwd{ tab.WorkingDirectory().c_str() };
        if (cwd.empty())
        {
            return std::wstring{ tab.ProjectPath().c_str() };
        }

        const auto cwdKey{ _pathKey(cwd) };
        std::wstring best{ cwd };
        auto bestKey{ cwdKey };
        for (const auto& candidate : { std::wstring{ tab.ProjectPath().c_str() }, std::wstring{ tab.GitRoot().c_str() } })
        {
            if (candidate.empty())
            {
                continue;
            }
            const auto key{ _pathKey(candidate) };
            const auto contains{ key == cwdKey || _pathIsUnder(cwdKey, key) };
            if (contains && key.size() < bestKey.size() && !_isGenericRoot(key))
            {
                best = candidate;
                bestKey = key;
            }
        }
        return best;
    }

    // Method Description:
    // - Sorts tabs into sections by directory and arranges those sections as
    //   a tree. Each tab joins the section of its project root (see
    //   _sectionRootForTab). A section whose directory sits inside another
    //   section's directory is NOT merged into it: it becomes a nested
    //   subheading (J:\projects\instagram stays its own project under a
    //   J:\projects section rather than dissolving into it). Sections keep
    //   the project strip's order, then sort by name; tabs keep window
    //   order. Two top-level sections sharing a leaf name are told apart by
    //   their parent folder ("a\web", "b\web").
    std::vector<TabRowControl::TabGroupBucket> TabRowControl::_bucketTabsByPath(const std::vector<winrt::TerminalApp::Tab>& tabs) const
    {
        std::vector<TabGroupBucket> buckets;
        // Sections rank by their own directory, not by the project id of the
        // tabs inside them: a section exists as soon as a terminal is open in
        // a directory, long before (or entirely without) the bridge having a
        // project for it.
        const auto unranked{ _sectionOrder.size() };
        const auto rankOf = [&](const std::wstring& directoryKey) {
            if (directoryKey.empty())
            {
                return unranked;
            }
            const auto found{ std::find(_sectionOrder.begin(), _sectionOrder.end(), directoryKey) };
            return found == _sectionOrder.end() ? unranked : static_cast<size_t>(found - _sectionOrder.begin());
        };

        for (const auto& tab : tabs)
        {
            const auto root{ _sectionRootForTab(tab) };
            const auto rootKey{ _pathKey(root) };
            const auto key{ rootKey.empty() ? std::wstring{} : L"dir:" + rootKey };

            auto bucket = std::find_if(buckets.begin(), buckets.end(), [&](const auto& existing) {
                return existing.Key == key;
            });
            if (bucket == buckets.end())
            {
                TabGroupBucket candidate;
                candidate.Key = key;
                candidate.PathKey = rootKey;
                candidate.Directory = root;
                candidate.Rank = rankOf(rootKey);
                if (rootKey.empty())
                {
                    candidate.Name = RS_(L"TabRailUngroupedSectionName").c_str();
                    candidate.Rank = unranked + 1;
                }
                else
                {
                    candidate.Name = rootKey.size() <= 3 ? _displayPath(root) : _pathLeaf(root);
                    candidate.CanOpenNewTab = true;
                    // A name the strip supplied for this directory - the
                    // bridge's project name, or a rename made here - beats the
                    // folder name, and it reaches the heading and the chip
                    // through this one path so they cannot disagree.
                    if (const auto named{ _sectionNames.find(rootKey) }; named != _sectionNames.end() && !named->second.empty())
                    {
                        candidate.Name = named->second.c_str();
                    }
                }
                buckets.push_back(std::move(candidate));
                bucket = buckets.end() - 1;
            }
            bucket->Tabs.push_back(tab);
            // Failing that, a tab whose bridge project *is* this section still
            // carries the project's name.
            if (!tab.ProjectName().empty() && !rootKey.empty() && !_sectionNames.contains(rootKey) && _pathKey(tab.ProjectPath()) == rootKey)
            {
                bucket->Name = tab.ProjectName().c_str();
            }
        }

        // Parents before children: shorter keys first.
        std::stable_sort(buckets.begin(), buckets.end(), [](const auto& left, const auto& right) {
            return left.PathKey.size() < right.PathKey.size();
        });
        for (size_t i = 0; i < buckets.size(); ++i)
        {
            auto& bucket{ buckets[i] };
            if (bucket.PathKey.empty())
            {
                continue;
            }
            for (size_t j = 0; j < i; ++j)
            {
                // A shell parked at a drive root or in ~ is its own flat
                // section; it never becomes the parent of real projects.
                const auto& other{ buckets[j] };
                if (!other.PathKey.empty() && !_isGenericRoot(other.PathKey) && _pathIsUnder(bucket.PathKey, other.PathKey) &&
                    (bucket.Parent < 0 || other.PathKey.size() > buckets[bucket.Parent].PathKey.size()))
                {
                    bucket.Parent = gsl::narrow_cast<int32_t>(j);
                }
            }
            if (bucket.Parent >= 0)
            {
                const auto& parent{ buckets[bucket.Parent] };
                bucket.Depth = parent.Depth + 1;
                // "projects\instagram" under J:\ rather than the full path again.
                auto offset{ std::min(bucket.Directory.size(), parent.PathKey.size()) };
                while (offset < bucket.Directory.size() && (bucket.Directory[offset] == L'\\' || bucket.Directory[offset] == L'/'))
                {
                    ++offset;
                }
                bucket.Path = bucket.Directory.substr(offset);
            }
            else
            {
                bucket.Path = _displayPath(bucket.Directory);
            }
        }

        // Counts and strip rank flow up to the enclosing sections (children
        // come after their parents, so walk backwards).
        for (auto& bucket : buckets)
        {
            bucket.TotalCount = gsl::narrow_cast<uint32_t>(bucket.Tabs.size());
        }
        for (auto i = buckets.size(); i-- > 0;)
        {
            if (buckets[i].Parent >= 0)
            {
                auto& parent{ buckets[buckets[i].Parent] };
                parent.TotalCount += buckets[i].TotalCount;
                parent.Rank = std::min(parent.Rank, buckets[i].Rank);
            }
        }

        // Same leaf name twice at the top level? Prefix the parent folder.
        for (size_t i = 0; i < buckets.size(); ++i)
        {
            if (buckets[i].Parent >= 0 || buckets[i].PathKey.empty())
            {
                continue;
            }
            for (size_t j = i + 1; j < buckets.size(); ++j)
            {
                if (buckets[j].Parent < 0 && !buckets[j].PathKey.empty() && _wcsicmp(buckets[i].Name.c_str(), buckets[j].Name.c_str()) == 0)
                {
                    for (auto* bucket : { &buckets[i], &buckets[j] })
                    {
                        const auto parentLeaf{ _pathLeaf(std::filesystem::path{ bucket->Directory }.parent_path().wstring()) };
                        const auto leaf{ _pathLeaf(bucket->Directory) };
                        if (!parentLeaf.empty() && parentLeaf != leaf)
                        {
                            bucket->Name = parentLeaf + L"\\" + leaf;
                        }
                    }
                }
            }
        }

        // Emit in tree order: siblings by strip rank then name, each followed
        // by its own subtree. Tabs keep window order within a section.
        std::vector<std::vector<size_t>> children(buckets.size());
        std::vector<size_t> roots;
        for (size_t i = 0; i < buckets.size(); ++i)
        {
            (buckets[i].Parent < 0 ? roots : children[buckets[i].Parent]).push_back(i);
        }
        const auto siblingOrder = [&](const size_t left, const size_t right) {
            if (buckets[left].Rank != buckets[right].Rank)
            {
                return buckets[left].Rank < buckets[right].Rank;
            }
            return _wcsicmp(buckets[left].Name.c_str(), buckets[right].Name.c_str()) < 0;
        };
        std::vector<TabGroupBucket> ordered;
        std::vector<int32_t> newIndex(buckets.size(), -1);
        const auto emit = [&](auto& self, const size_t index) -> void {
            auto& bucket{ buckets[index] };
            std::stable_sort(bucket.Tabs.begin(), bucket.Tabs.end(), [](const auto& left, const auto& right) {
                return left.TabViewIndex() < right.TabViewIndex();
            });
            if (bucket.Parent >= 0)
            {
                bucket.Parent = newIndex[bucket.Parent];
            }
            newIndex[index] = gsl::narrow_cast<int32_t>(ordered.size());
            ordered.push_back(std::move(bucket));
            auto& kids{ children[index] };
            std::sort(kids.begin(), kids.end(), siblingOrder);
            for (const auto child : kids)
            {
                self(self, child);
            }
        };
        std::sort(roots.begin(), roots.end(), siblingOrder);
        for (const auto root : roots)
        {
            emit(emit, root);
        }
        return ordered;
    }

    // Method Description:
    // - Appends each section to `items` as a TabGroup header followed by its
    //   tabs, and stamps each tab's rail subtitle with its path relative to
    //   the section directory and its depth. Headers are reused from
    //   _groupCache by key. Sections hidden inside a collapsed ancestor emit
    //   nothing at all.
    void TabRowControl::_publishGroups(std::vector<TabGroupBucket> buckets, std::vector<winrt::Windows::Foundation::IInspectable>& items)
    {
        // Does the focused tab sit in this section or any nested one?
        std::vector<bool> containsActive(buckets.size(), false);
        for (auto i = buckets.size(); i-- > 0;)
        {
            if (_selectedTab && _containsTab(buckets[i].Tabs, _selectedTab))
            {
                containsActive[i] = true;
            }
            if (containsActive[i] && buckets[i].Parent >= 0)
            {
                containsActive[buckets[i].Parent] = true;
            }
        }

        std::set<std::wstring> liveKeys;
        // The hairline separates one top-level section from the next, so the
        // first header to actually reach the list never draws one.
        auto publishedHeader{ false };
        for (size_t i = 0; i < buckets.size(); ++i)
        {
            auto& bucket{ buckets[i] };
            liveKeys.insert(bucket.Key);
            const auto collapsed{ _collapsedGroups.contains(bucket.Key) };
            const auto hiddenByAncestor{ !bucket.HiddenBy.empty() && bucket.HiddenBy != bucket.Key };
            auto& group{ _groupCache[bucket.Key] };
            if (!group)
            {
                group = winrt::make_self<implementation::TabGroup>();
                group->Key(winrt::hstring{ bucket.Key });
            }
            group->Depth(bucket.Depth);
            group->Directory(winrt::hstring{ bucket.Directory });
            group->Update(winrt::hstring{ bucket.Name },
                          winrt::hstring{ bucket.Path },
                          bucket.TotalCount,
                          collapsed,
                          bucket.CanOpenNewTab,
                          containsActive[i]);
            if (!hiddenByAncestor)
            {
                group->ShowDivider(bucket.Depth == 0 && publishedHeader);
                publishedHeader = true;
                items.push_back(*group);
            }

            for (const auto& tab : bucket.Tabs)
            {
                if (const auto tabImpl{ winrt::get_self<implementation::Tab>(tab) })
                {
                    std::wstring subtitle;
                    const auto cwdKey{ _pathKey(tab.WorkingDirectory()) };
                    if (!bucket.PathKey.empty() && cwdKey.size() > bucket.PathKey.size() && _pathIsUnder(cwdKey, bucket.PathKey))
                    {
                        // Relative to the section, in the pane's own casing.
                        const std::wstring cwd{ tab.WorkingDirectory().c_str() };
                        auto offset{ std::min(cwd.size(), bucket.PathKey.size()) };
                        while (offset < cwd.size() && (cwd[offset] == L'\\' || cwd[offset] == L'/'))
                        {
                            ++offset;
                        }
                        subtitle = cwd.substr(offset);
                    }
                    tabImpl->RailSubtitle(winrt::hstring{ subtitle });
                    tabImpl->RailDepth(bucket.Depth);
                }
                if (bucket.HiddenBy.empty())
                {
                    items.push_back(tab);
                }
            }
        }
        std::erase_if(_groupCache, [&](const auto& entry) { return !liveKeys.contains(entry.first); });
    }

    // Method Description:
    // - Brings _railItems in line with `items` using removes, inserts and
    //   moves instead of Clear()+Append(), so the ListView's add/delete and
    //   reorder transitions play only for rows that actually changed.
    void TabRowControl::_applyRailItems(const std::vector<winrt::Windows::Foundation::IInspectable>& items)
    {
        const auto wanted = [&](const winrt::Windows::Foundation::IInspectable& item) {
            return std::find(items.begin(), items.end(), item) != items.end();
        };

        // Remove rows that are gone, back to front so indices stay valid.
        for (auto i = static_cast<int32_t>(_railItems.Size()) - 1; i >= 0; --i)
        {
            if (!wanted(_railItems.GetAt(static_cast<uint32_t>(i))))
            {
                _railItems.RemoveAt(static_cast<uint32_t>(i));
            }
        }

        // Then walk the target order, inserting or pulling each row into place.
        for (uint32_t target = 0; target < items.size(); ++target)
        {
            const auto& item{ items[target] };
            if (target < _railItems.Size() && _railItems.GetAt(target) == item)
            {
                continue;
            }
            uint32_t current{};
            if (_railItems.IndexOf(item, current))
            {
                _railItems.RemoveAt(current);
            }
            _railItems.InsertAt(target, item);
        }
    }

    // Method Description:
    // - Collapses/expands a section and animates that header's chevron. The
    //   bound ChevronAngle already holds the final value; the storyboard just
    //   eases between the two and then releases the property again.
    void TabRowControl::_toggleGroup(const winrt::TerminalApp::TabGroup& group, const std::optional<bool> collapse, const winrt::Windows::UI::Xaml::Controls::Button& headerButton)
    {
        const std::wstring key{ group.Key().c_str() };
        const auto wasCollapsed{ _collapsedGroups.contains(key) };
        const auto nowCollapsed{ collapse.value_or(!wasCollapsed) };
        if (wasCollapsed == nowCollapsed)
        {
            return;
        }
        if (nowCollapsed)
        {
            _collapsedGroups.insert(key);
        }
        else
        {
            _collapsedGroups.erase(key);
        }

        if (headerButton)
        {
            // Button -> Grid -> FontIcon (column 0) carries the RotateTransform.
            if (const auto content{ headerButton.Content().try_as<WUX::Controls::Grid>() })
            {
                for (const auto& child : content.Children())
                {
                    const auto icon{ child.try_as<WUX::Controls::FontIcon>() };
                    if (!icon)
                    {
                        continue;
                    }
                    if (const auto rotate{ icon.RenderTransform().try_as<WUX::Media::RotateTransform>() })
                    {
                        WUX::Media::Animation::Storyboard storyboard;
                        WUX::Media::Animation::DoubleAnimation animation;
                        animation.From(wasCollapsed ? -90.0 : 0.0);
                        animation.To(nowCollapsed ? -90.0 : 0.0);
                        animation.Duration(WUX::DurationHelper::FromTimeSpan(std::chrono::milliseconds(150)));
                        animation.EnableDependentAnimation(true);
                        WUX::Media::Animation::CubicEase ease;
                        ease.EasingMode(WUX::Media::Animation::EasingMode::EaseOut);
                        animation.EasingFunction(ease);
                        WUX::Media::Animation::Storyboard::SetTarget(animation, rotate);
                        WUX::Media::Animation::Storyboard::SetTargetProperty(animation, L"Angle");
                        storyboard.Children().Append(animation);
                        // Hand the property back to the x:Bind once done, so a
                        // recycled container never shows a stale held angle.
                        storyboard.Completed([storyboard](auto&&, auto&&) { storyboard.Stop(); });
                        storyboard.Begin();
                    }
                    break;
                }
            }
        }

        _updateFilteredTabs(false);
    }

    // Method Description:
    // - One switch for the whole tree: fold every top-level section, or open
    //   them all again once they're folded. Nested sections are hidden by
    //   their ancestor, so only the roots need a key of their own.
    void TabRowControl::OnCollapseAllClick(const winrt::Windows::Foundation::IInspectable&,
                                           const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        _closeVerticalTabTitleToolTip();

        std::vector<std::wstring> topLevel;
        for (const auto& [key, group] : _groupCache)
        {
            if (group && group->Depth() == 0)
            {
                topLevel.push_back(key);
            }
        }
        if (topLevel.empty())
        {
            // A flat view (search results, recent-activity sort) has no sections.
            return;
        }

        const auto allCollapsed{ std::all_of(topLevel.begin(), topLevel.end(), [this](const auto& key) {
            return _collapsedGroups.contains(key);
        }) };

        // _toggleGroup republishes the rail per section; this edits the same
        // state it owns and publishes once instead of once per section.
        if (allCollapsed)
        {
            _collapsedGroups.clear();
        }
        else
        {
            _collapsedGroups.insert(topLevel.begin(), topLevel.end());
        }

        _updateFilteredTabs(false);
    }

    void TabRowControl::_setHeaderNewTabButtonOpacity(const winrt::Windows::UI::Xaml::FrameworkElement& headerRoot, const double opacity)
    {
        if (const auto grid{ headerRoot.try_as<WUX::Controls::Grid>() })
        {
            for (const auto& child : grid.Children())
            {
                if (const auto button{ child.try_as<WUX::Controls::Button>() })
                {
                    // The [+] is the header's only direct Button with a fixed width.
                    if (!std::isnan(button.Width()))
                    {
                        button.Opacity(opacity);
                    }
                }
            }
        }
    }

    // Method Description:
    // - Finds a named element inside a row. Names declared in a DataTemplate
    //   belong to the template instance's own namescope, so the page can't
    //   FindName them; walking down from the row is how the section header's
    //   [+] is reached too (see _setHeaderNewTabButtonOpacity).
    winrt::Windows::UI::Xaml::FrameworkElement TabRowControl::_findNamedDescendant(const winrt::Windows::UI::Xaml::DependencyObject& root, const std::wstring_view name, const uint32_t depth)
    {
        if (!root || depth == 0)
        {
            return nullptr;
        }

        const auto count{ WUX::Media::VisualTreeHelper::GetChildrenCount(root) };
        for (auto i = 0; i < count; ++i)
        {
            const auto child{ WUX::Media::VisualTreeHelper::GetChild(root, i) };
            if (const auto element{ child.try_as<WUX::FrameworkElement>() }; element && std::wstring_view{ element.Name() } == name)
            {
                return element;
            }
            if (const auto found{ _findNamedDescendant(child, name, depth - 1) })
            {
                return found;
            }
        }
        return nullptr;
    }

    // Method Description:
    // - Row actions are chrome, not content: they belong to the row the
    //   pointer is over, the selected row and the row holding keyboard focus,
    //   and nowhere else - every other row gives the width back to its title.
    // Arguments:
    // - scope: the row's container or its root, to search downwards from.
    // Return Value:
    // - false when the row's actions element isn't in the tree (yet).
    bool TabRowControl::_applyRowActionOpacity(const winrt::Windows::UI::Xaml::FrameworkElement& scope,
                                               const winrt::Windows::Foundation::IInspectable& item,
                                               const winrt::Windows::Foundation::IInspectable& focusedItem)
    {
        const auto actions{ _findNamedDescendant(scope, L"RailRowActions") };
        if (!actions)
        {
            return false;
        }

        const auto show{ item && (item == _selectedTab || item == _hoveredTab || item == focusedItem) };
        actions.Opacity(show ? 1.0 : 0.0);
        return true;
    }

    void TabRowControl::_updateRowActionAffordances()
    {
        const auto list{ VerticalTabList() };
        if (!list)
        {
            return;
        }

        if (_hoveredTab && !_tabIsTracked(_hoveredTab))
        {
            // The hovered tab closed under the pointer; no PointerExited comes.
            _hoveredTab = nullptr;
        }

        const auto focusedItem{ _railItemHoldingFocus() };
        for (uint32_t i = 0; i < _railItems.Size(); ++i)
        {
            const auto item{ _railItems.GetAt(i) };
            if (!item.try_as<TerminalApp::Tab>())
            {
                continue;
            }
            if (const auto container{ list.ContainerFromItem(item).try_as<WUX::FrameworkElement>() })
            {
                _applyRowActionOpacity(container, item, focusedItem);
            }
        }
    }

    // Normalized, lower-cased path without a trailing separator, for grouping.
    std::wstring TabRowControl::_pathKey(std::wstring_view path)
    {
        if (path.empty())
        {
            return {};
        }
        std::wstring key;
        try
        {
            auto normalized = std::filesystem::path{ path }.lexically_normal();
            normalized.make_preferred();
            key = normalized.wstring();
        }
        catch (...)
        {
            key.assign(path);
        }
        while (key.size() > 3 && (key.back() == L'\\' || key.back() == L'/'))
        {
            key.pop_back();
        }
        std::transform(key.begin(), key.end(), key.begin(), [](const wchar_t ch) {
            return static_cast<wchar_t>(std::towlower(ch));
        });
        return key;
    }

    bool TabRowControl::_pathIsUnder(std::wstring_view childKey, std::wstring_view parentKey)
    {
        if (parentKey.empty() || childKey.size() <= parentKey.size() || childKey.substr(0, parentKey.size()) != parentKey)
        {
            return false;
        }
        const auto separator{ childKey[parentKey.size()] };
        // A drive root key ("c:\") already ends in its separator.
        return separator == L'\\' || separator == L'/' || parentKey.back() == L'\\' || parentKey.back() == L'/';
    }

    std::wstring TabRowControl::_pathLeaf(std::wstring_view path)
    {
        try
        {
            auto normalized = std::filesystem::path{ path }.lexically_normal();
            auto leaf = normalized.filename().wstring();
            if (leaf.empty())
            {
                leaf = normalized.parent_path().filename().wstring();
            }
            if (leaf.empty())
            {
                leaf = normalized.root_name().wstring();
            }
            return leaf.empty() ? std::wstring{ path } : leaf;
        }
        catch (...)
        {
            return std::wstring{ path };
        }
    }

    // The user's profile folder shown as "~", like the web sidebar.
    std::wstring TabRowControl::_displayPath(std::wstring_view path)
    {
        if (path.empty())
        {
            return {};
        }
        std::wstring display{ path };
        while (display.size() > 3 && (display.back() == L'\\' || display.back() == L'/'))
        {
            display.pop_back();
        }
        static const std::wstring homeKey = [] {
            wchar_t buffer[MAX_PATH]{};
            const auto length{ GetEnvironmentVariableW(L"USERPROFILE", buffer, MAX_PATH) };
            return (length > 0 && length < MAX_PATH) ? _pathKey(std::wstring_view{ buffer, length }) : std::wstring{};
        }();
        if (!homeKey.empty())
        {
            const auto key{ _pathKey(display) };
            if (key == homeKey)
            {
                return L"~";
            }
            if (_pathIsUnder(key, homeKey))
            {
                return L"~" + display.substr(homeKey.size());
            }
        }
        return display;
    }

    void TabRowControl::OnTabGroupHeaderClick(const winrt::Windows::Foundation::IInspectable& sender,
                                              const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        const auto element{ sender.try_as<WUX::FrameworkElement>() };
        const auto group{ element ? element.DataContext().try_as<TerminalApp::TabGroup>() : nullptr };
        if (!group)
        {
            return;
        }
        _toggleGroup(group, std::nullopt, sender.try_as<WUX::Controls::Button>());
    }

    // Method Description:
    // - Left collapses, Right expands, like a tree view. Enter and Space come
    //   through the header button's own Click, so they aren't handled here -
    //   handling them again would toggle the section twice. Right on a
    //   section that's already open steps into it rather than doing nothing.
    void TabRowControl::OnTabGroupHeaderKeyDown(const winrt::Windows::Foundation::IInspectable& sender,
                                                const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        const auto key{ e.Key() };
        if (key != winrt::Windows::System::VirtualKey::Left && key != winrt::Windows::System::VirtualKey::Right)
        {
            return;
        }
        const auto element{ sender.try_as<WUX::FrameworkElement>() };
        const auto group{ element ? element.DataContext().try_as<TerminalApp::TabGroup>() : nullptr };
        if (!group)
        {
            return;
        }

        const auto collapse{ key == winrt::Windows::System::VirtualKey::Left };
        const auto wasCollapsed{ _collapsedGroups.contains(std::wstring{ group.Key().c_str() }) };
        _toggleGroup(group, collapse, sender.try_as<WUX::Controls::Button>());
        e.Handled(true);

        if (wasCollapsed != collapse || collapse)
        {
            // The section moved (so the list was rebuilt and these indices are
            // stale), or it was already folded and Left has nowhere to go.
            return;
        }

        uint32_t index{};
        if (_railItems.IndexOf(group, index))
        {
            if (const auto container{ _railTabContainer(gsl::narrow_cast<int32_t>(index) + 1, true, false) })
            {
                container.Focus(WUX::FocusState::Keyboard);
            }
        }
    }

    // The [+] only shows while the pointer is over the header (or it has focus).
    void TabRowControl::OnTabGroupHeaderPointerEntered(const winrt::Windows::Foundation::IInspectable& sender,
                                                       const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        if (const auto root{ sender.try_as<WUX::FrameworkElement>() })
        {
            _setHeaderNewTabButtonOpacity(root, 1.0);
        }
    }

    void TabRowControl::OnTabGroupHeaderPointerExited(const winrt::Windows::Foundation::IInspectable& sender,
                                                      const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        if (const auto root{ sender.try_as<WUX::FrameworkElement>() })
        {
            _setHeaderNewTabButtonOpacity(root, 0.0);
        }
    }

    void TabRowControl::OnTabGroupNewTabGotFocus(const winrt::Windows::Foundation::IInspectable& sender,
                                                 const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        if (const auto button{ sender.try_as<WUX::UIElement>() })
        {
            button.Opacity(1.0);
        }
    }

    void TabRowControl::OnTabGroupNewTabLostFocus(const winrt::Windows::Foundation::IInspectable& sender,
                                                  const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        if (const auto button{ sender.try_as<WUX::UIElement>() })
        {
            button.Opacity(0.0);
        }
    }

    void TabRowControl::OnTabGroupNewTabClick(const winrt::Windows::Foundation::IInspectable& sender,
                                              const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        const auto element{ sender.try_as<WUX::FrameworkElement>() };
        const auto group{ element ? element.DataContext().try_as<TerminalApp::TabGroup>() : nullptr };
        if (!group || !group.CanOpenNewTab() || !NewTabInDirectoryRequested || !_tabs)
        {
            return;
        }

        // Hand over the real directory, not the "~"-shortened display.
        if (const auto directory{ group.Directory() }; !directory.empty())
        {
            NewTabInDirectoryRequested(directory);
        }
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
        _closeVerticalTabTitleToolTip();

        // Filter on the cheap metadata immediately; defer the expensive
        // buffer-text pass (which takes each terminal's lock) until typing
        // settles, so every keystroke doesn't contend with the output threads.
        _updateFilteredTabs(false);

        if (!_bufferSearchTimer)
        {
            _bufferSearchTimer.Interval(std::chrono::milliseconds(250));
            _bufferSearchTimer.Tick({ get_weak(), &TabRowControl::_bufferSearchTimerTick });
        }
        _bufferSearchTimer.Stop();
        _bufferSearchTimer.Start();
    }

    void TabRowControl::_bufferSearchTimerTick(const winrt::Windows::Foundation::IInspectable&,
                                               const winrt::Windows::Foundation::IInspectable&)
    {
        _bufferSearchTimer.Stop();
        _updateFilteredTabs(true);
    }

    // Clearing the query puts the whole list back through TextChanged; the
    // box keeps the caret so the next thing typed still goes to the search.
    void TabRowControl::OnVerticalTabSearchClearClick(const winrt::Windows::Foundation::IInspectable&,
                                                      const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        _closeVerticalTabTitleToolTip();

        const auto box{ VerticalTabSearchBox() };
        if (!box)
        {
            return;
        }

        if (!box.Text().empty())
        {
            box.Text(L"");
        }
        box.Focus(WUX::FocusState::Programmatic);
    }

    // Method Description:
    // - Escape empties the query, and empties the rail's claim on the
    //   keyboard once there's nothing left to clear. Down (or Enter) drops
    //   into the results, so a search can be finished without the mouse.
    void TabRowControl::OnVerticalTabSearchKeyDown(const winrt::Windows::Foundation::IInspectable&,
                                                   const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        const auto box{ VerticalTabSearchBox() };
        switch (e.Key())
        {
        case winrt::Windows::System::VirtualKey::Escape:
            if (box && !box.Text().empty())
            {
                box.Text(L"");
            }
            else
            {
                _focusSelectedTerminal();
            }
            e.Handled(true);
            return;

        case winrt::Windows::System::VirtualKey::Down:
        case winrt::Windows::System::VirtualKey::Enter:
            // Only claim the key if there's somewhere to go; otherwise the
            // box keeps its own handling of it.
            if (const auto container{ _railTabContainer(0, true, true) })
            {
                container.Focus(WUX::FocusState::Keyboard);
                e.Handled(true);
            }
            return;

        default:
            return;
        }
    }

    void TabRowControl::OnVerticalTabSelectionChanged(const winrt::Windows::Foundation::IInspectable&,
                                                      const winrt::Windows::UI::Xaml::Controls::SelectionChangedEventArgs&)
    {
        _closeVerticalTabTitleToolTip();

        if (_updatingVerticalSelection)
        {
            return;
        }

        // A click on a section header's padding lands here as a header
        // selection; put the selection back on the focused tab.
        if (VerticalTabList().SelectedItem().try_as<TerminalApp::TabGroup>())
        {
            _syncListSelection();
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
        _closeVerticalTabTitleToolTip();

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
    // - The pointer is over a row: bring its actions up. The selected row and
    //   the row holding keyboard focus keep theirs up on their own (see
    //   _updateRowActionAffordances), so leaving a row doesn't always hide
    //   them again.
    void TabRowControl::OnVerticalTabRowPointerEntered(const winrt::Windows::Foundation::IInspectable& sender,
                                                       const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        const auto root{ sender.try_as<WUX::FrameworkElement>() };
        if (!root)
        {
            return;
        }

        _hoveredTab = root.DataContext().try_as<TerminalApp::Tab>();
        if (const auto actions{ _findNamedDescendant(root, L"RailRowActions") })
        {
            actions.Opacity(1.0);
        }
    }

    void TabRowControl::OnVerticalTabRowPointerExited(const winrt::Windows::Foundation::IInspectable& sender,
                                                      const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        const auto root{ sender.try_as<WUX::FrameworkElement>() };
        if (!root)
        {
            return;
        }

        const auto item{ root.DataContext() };
        if (item && item == _hoveredTab)
        {
            _hoveredTab = nullptr;
        }
        _applyRowActionOpacity(root, item, _railItemHoldingFocus());
    }

    // Method Description:
    // - Enter activates the focused row (selection is what actually switches
    //   tab, and switching hands the keyboard to the terminal); Escape leaves
    //   the rail the same way.
    void TabRowControl::_onVerticalTabListKeyDown(const winrt::Windows::Foundation::IInspectable&,
                                                  const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e)
    {
        if (e.Key() == winrt::Windows::System::VirtualKey::Escape)
        {
            _focusSelectedTerminal();
            e.Handled(true);
            return;
        }

        if (e.Key() != winrt::Windows::System::VirtualKey::Enter)
        {
            return;
        }

        const auto item{ _railItemHoldingFocus() };
        const auto tab{ item.try_as<TerminalApp::Tab>() };
        if (!tab)
        {
            return;
        }

        if (VerticalTabList().SelectedItem() != item)
        {
            // SelectionChanged carries it on to the window.
            VerticalTabList().SelectedItem(item);
        }
        else
        {
            // Already the selected row: nothing changes, so ask for the
            // terminal explicitly rather than waiting for an event.
            _selectedTab = tab;
            VerticalTabSelected.raise(*this, tab);
        }
        e.Handled(true);
    }

    // Method Description:
    // - Section headers are rows in the same list as the tabs, so directional
    //   navigation can land on one even though its container isn't a tab
    //   stop. Bounce that focus on to the next tab in the direction of
    //   travel. A header's own buttons stay reachable with Tab, and a click
    //   (direction None) is left alone.
    void TabRowControl::_onVerticalTabListGettingFocus(const winrt::Windows::Foundation::IInspectable&,
                                                       const winrt::Windows::UI::Xaml::Input::GettingFocusEventArgs& e)
    {
        const auto container{ e.NewFocusedElement().try_as<WUX::Controls::ListViewItem>() };
        if (!container)
        {
            return;
        }

        const auto item{ VerticalTabList().ItemFromContainer(container) };
        if (!item || !item.try_as<TerminalApp::TabGroup>())
        {
            return;
        }

        bool forward{};
        switch (e.Direction())
        {
        case WUX::Input::FocusNavigationDirection::Next:
        case WUX::Input::FocusNavigationDirection::Down:
        case WUX::Input::FocusNavigationDirection::Right:
            forward = true;
            break;
        case WUX::Input::FocusNavigationDirection::Previous:
        case WUX::Input::FocusNavigationDirection::Up:
        case WUX::Input::FocusNavigationDirection::Left:
            forward = false;
            break;
        default:
            return;
        }

        uint32_t index{};
        if (!_railItems.IndexOf(item, index))
        {
            return;
        }

        if (const auto target{ _railTabContainer(gsl::narrow_cast<int32_t>(index) + (forward ? 1 : -1), forward, false) })
        {
            e.TrySetNewFocusedElement(target);
        }
    }

    void TabRowControl::_onVerticalTabListFocusChanged(const winrt::Windows::Foundation::IInspectable&,
                                                       const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        _updateRowActionAffordances();
    }

    // A recycled container keeps the opacity it was left with, so a row
    // realized by scrolling has to be told what it is before it's seen.
    void TabRowControl::_onVerticalTabContainerContentChanging(const winrt::Windows::Foundation::IInspectable&,
                                                               const winrt::Windows::UI::Xaml::Controls::ContainerContentChangingEventArgs& e)
    {
        if (e.InRecycleQueue())
        {
            return;
        }

        const auto container{ e.ItemContainer().try_as<WUX::FrameworkElement>() };
        if (!container)
        {
            return;
        }

        if (!_applyRowActionOpacity(container, e.Item(), _railItemHoldingFocus()) && e.Phase() == 0)
        {
            // The row's template isn't built yet; ask to be called back once
            // it is, and only once, so a row without actions can't loop.
            e.RegisterUpdateCallback({ get_weak(), &TabRowControl::_onVerticalTabContainerContentChanging });
        }
    }

    void TabRowControl::OnVerticalTabTitlePointerEntered(const winrt::Windows::Foundation::IInspectable& sender,
                                                         const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        const auto titleElement{ sender.try_as<WUX::FrameworkElement>() };
        if (!titleElement)
        {
            return;
        }

        const auto dataContext{ titleElement.DataContext() };
        if (!dataContext)
        {
            return;
        }

        const auto tab{ dataContext.try_as<TerminalApp::Tab>() };
        if (!tab)
        {
            return;
        }

        const auto title{ tab.Title() };
        if (title.empty())
        {
            return;
        }

        _closeVerticalTabTitleToolTip();

        WUX::Controls::TextBlock tooltipText;
        tooltipText.Text(title);
        tooltipText.MaxWidth(VerticalTabTitleToolTipMaxWidth);
        tooltipText.TextWrapping(WUX::TextWrapping::Wrap);

        WUX::Controls::ToolTip tooltip;
        tooltip.Content(tooltipText);
        tooltip.IsHitTestVisible(false);
        tooltip.Placement(WUX::Controls::Primitives::PlacementMode::Right);

        WUX::Controls::ToolTipService::SetToolTip(titleElement, tooltip);
        tooltip.IsOpen(true);

        _verticalTabTitleToolTip = tooltip;
        _verticalTabTitleToolTipOwner = titleElement;
    }

    void TabRowControl::OnVerticalTabTitlePointerExited(const winrt::Windows::Foundation::IInspectable&,
                                                        const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        _closeVerticalTabTitleToolTip();
    }

    void TabRowControl::OnVerticalTabTitlePointerCanceled(const winrt::Windows::Foundation::IInspectable&,
                                                          const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        _closeVerticalTabTitleToolTip();
    }

    void TabRowControl::OnVerticalTabTitlePointerCaptureLost(const winrt::Windows::Foundation::IInspectable&,
                                                             const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs&)
    {
        _closeVerticalTabTitleToolTip();
    }

    void TabRowControl::OnVerticalTabDragItemsStarting(const winrt::Windows::Foundation::IInspectable&,
                                                       const winrt::Windows::UI::Xaml::Controls::DragItemsStartingEventArgs& e)
    {
        _closeVerticalTabTitleToolTip();
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

        // The ListView reordered _railItems, which in the flat (reorderable)
        // view holds only tabs in window order.
        uint32_t targetIndex{};
        if (_railItems.IndexOf(draggedTab, targetIndex))
        {
            VerticalTabMoveRequested(draggedTab, targetIndex);
        }

        _updateFilteredTabs();
    }

    void TabRowControl::OnNewTabProfilesPanelSizeChanged(const winrt::Windows::Foundation::IInspectable&,
                                                         const winrt::Windows::UI::Xaml::SizeChangedEventArgs&)
    {
        FitNewTabProfileButtons();
    }

    // Shows only as many whole profile launcher buttons as fit in the space
    // left over next to the new tab split button. The panel doesn't clip, so
    // overflowing buttons have to be collapsed outright or they'd render on
    // top of the rail edge.
    void TabRowControl::FitNewTabProfileButtons()
    {
        const auto panel = NewTabProfilesPanel();
        if (!panel)
        {
            return;
        }

        const auto available = panel.ActualWidth();
        auto used = 0.0;
        for (const auto& child : panel.Children())
        {
            const auto element = child.try_as<WUX::FrameworkElement>();
            if (!element)
            {
                continue;
            }

            const auto width = element.Width();
            const auto margin = element.Margin();
            const auto slot = (std::isnan(width) ? 32.0 : width) + margin.Left + margin.Right;
            // Half-pixel slack so rounding doesn't hide a button that fits.
            const auto fits = used + slot <= available + 0.5;
            element.Visibility(fits ? WUX::Visibility::Visible : WUX::Visibility::Collapsed);
            if (fits)
            {
                used += slot;
            }
        }
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

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
        VerticalTabList().ItemsSource(_railItems);
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

        // Focusing a tab that lives in a collapsed section reopens it, the
        // way an IDE reveals the active file in a folded tree.
        if (_selectedTab)
        {
            const auto hidden = std::find_if(_collapsedTabs.begin(), _collapsedTabs.end(), [&](const auto& item) {
                return item.first == _selectedTab;
            });
            if (hidden != _collapsedTabs.end())
            {
                _collapsedGroups.erase(hidden->second);
                _updateFilteredTabs(false);
                return;
            }
        }

        ++_updatingVerticalSelection;
        auto restoreSelection = wil::scope_exit([&]() {
            --_updatingVerticalSelection;
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
        if (!_projectFilter.empty() && tab.ProjectId() != _projectFilter)
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
    // - A pane changed directory; regroup the "All" view so the tab moves to
    //   the section it now belongs to.
    void TabRowControl::NotifyTabDirectoryUpdated()
    {
        if (_projectFilter.empty() && !SortByRecentActivity() && VerticalTabSearchBox().Text().empty())
        {
            _updateFilteredTabs(false);
        }
    }

    void TabRowControl::SetProjectFilter(const winrt::hstring& projectId)
    {
        if (_projectFilter != projectId)
        {
            _projectFilter = projectId;
            _updateFilteredTabs();
        }
    }

    // Method Description:
    // - Records the project strip's order. The "All" view groups tabs by
    //   project in this order (tabs without a project come last).
    void TabRowControl::SetProjectOrder(std::vector<winrt::hstring> projectIds)
    {
        if (_projectOrder != projectIds)
        {
            _projectOrder = std::move(projectIds);
            _updateFilteredTabs();
        }
    }

    void TabRowControl::_updateFilteredTabs(const bool includeBufferSearch)
    {
        const auto filter{ _foldForSearch(VerticalTabSearchBox().Text()) };
        const auto terms{ _splitSearchTerms(filter) };

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
        const auto grouped{ _projectFilter.empty() && !SortByRecentActivity() && terms.empty() };
        _updateCanReorderVerticalTabs(terms, grouped);

        // Clearing/appending the bound observable vectors makes the ListView
        // raise SelectionChanged for our own mutations; suppress those so
        // they can't re-enter tab focusing (and, transitively, this method).
        ++_updatingVerticalSelection;
        auto restoreSelection = wil::scope_exit([&]() {
            --_updatingVerticalSelection;
        });

        _collapsedTabs.clear();
        _railItems.Clear();
        if (grouped)
        {
            auto buckets{ _bucketTabsByPath(visibleTabs) };
            visibleTabs.clear();
            for (auto& bucket : buckets)
            {
                const auto collapsed{ _collapsedGroups.contains(bucket.Key) };
                for (const auto& tab : bucket.Tabs)
                {
                    if (collapsed)
                    {
                        _collapsedTabs.emplace_back(tab, bucket.Key);
                    }
                    else
                    {
                        visibleTabs.push_back(tab);
                    }
                }
            }
            _publishGroups(std::move(buckets));
        }
        else
        {
            for (const auto& tab : visibleTabs)
            {
                if (const auto tabImpl{ winrt::get_self<implementation::Tab>(tab) })
                {
                    if (tabImpl->RailSubtitle() != tab.ProjectName())
                    {
                        tabImpl->RailSubtitle(tab.ProjectName());
                    }
                }
                _railItems.Append(tab);
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
    // - Sorts tabs into project sections by path. A tab's section is its
    //   bridge project when it has one, otherwise its live working directory;
    //   a section whose directory sits inside another visible section's
    //   directory folds into that ancestor (a tab in F:\repo\src belongs to
    //   the F:\repo project, not to a second "src" project).
    std::vector<TabRowControl::TabGroupBucket> TabRowControl::_bucketTabsByPath(const std::vector<winrt::TerminalApp::Tab>& tabs) const
    {
        std::vector<TabGroupBucket> buckets;
        const auto unranked{ _projectOrder.size() };

        for (const auto& tab : tabs)
        {
            TabGroupBucket candidate;
            const auto projectId{ tab.ProjectId() };
            const auto projectPath{ tab.ProjectPath() };
            const auto cwd{ tab.WorkingDirectory() };

            if (!projectId.empty())
            {
                candidate.Key = projectId.c_str();
                candidate.PathKey = _pathKey(projectPath);
                candidate.Path = _displayPath(projectPath);
                candidate.Name = tab.ProjectName().c_str();
                if (candidate.Name.empty())
                {
                    candidate.Name = _pathLeaf(projectPath);
                }
                const auto found{ std::find(_projectOrder.begin(), _projectOrder.end(), projectId) };
                candidate.Rank = found == _projectOrder.end() ? unranked : static_cast<size_t>(found - _projectOrder.begin());
                candidate.CanOpenNewTab = !projectPath.empty();
            }
            else if (!cwd.empty())
            {
                candidate.PathKey = _pathKey(cwd);
                candidate.Key = L"dir:" + candidate.PathKey;
                candidate.Path = _displayPath(cwd);
                candidate.Name = _pathLeaf(cwd);
                candidate.Rank = unranked;
                candidate.CanOpenNewTab = true;
            }
            else
            {
                candidate.Key = L"";
                candidate.Name = RS_(L"TabRailUngroupedSectionName").c_str();
                candidate.Rank = unranked + 1;
            }

            auto bucket = std::find_if(buckets.begin(), buckets.end(), [&](const auto& existing) {
                return existing.Key == candidate.Key;
            });
            if (bucket == buckets.end())
            {
                buckets.push_back(std::move(candidate));
                bucket = buckets.end() - 1;
            }
            bucket->Tabs.push_back(tab);
        }

        // Fold nested directories into their ancestor section. Shortest paths
        // first so an ancestor is always kept before its descendants arrive.
        std::stable_sort(buckets.begin(), buckets.end(), [](const auto& left, const auto& right) {
            return left.PathKey.size() < right.PathKey.size();
        });
        std::vector<TabGroupBucket> folded;
        for (auto& bucket : buckets)
        {
            TabGroupBucket* ancestor{ nullptr };
            if (!bucket.PathKey.empty())
            {
                for (auto& kept : folded)
                {
                    if (!kept.PathKey.empty() && _pathIsUnder(bucket.PathKey, kept.PathKey) &&
                        (!ancestor || kept.PathKey.size() > ancestor->PathKey.size()))
                    {
                        ancestor = &kept;
                    }
                }
            }
            if (ancestor)
            {
                ancestor->Tabs.insert(ancestor->Tabs.end(), bucket.Tabs.begin(), bucket.Tabs.end());
                ancestor->Rank = std::min(ancestor->Rank, bucket.Rank);
            }
            else
            {
                folded.push_back(std::move(bucket));
            }
        }

        // Strip order first, then alphabetical; window order within a section.
        std::stable_sort(folded.begin(), folded.end(), [](const auto& left, const auto& right) {
            if (left.Rank != right.Rank)
            {
                return left.Rank < right.Rank;
            }
            return _wcsicmp(left.Name.c_str(), right.Name.c_str()) < 0;
        });
        for (auto& bucket : folded)
        {
            std::stable_sort(bucket.Tabs.begin(), bucket.Tabs.end(), [](const auto& left, const auto& right) {
                return left.TabViewIndex() < right.TabViewIndex();
            });
        }
        return folded;
    }

    // Method Description:
    // - Appends each section to the rail list as a TabGroup header followed
    //   by its tabs, and stamps each tab's rail subtitle with its path
    //   relative to the section directory.
    void TabRowControl::_publishGroups(std::vector<TabGroupBucket> buckets)
    {
        for (auto& bucket : buckets)
        {
            const auto collapsed{ _collapsedGroups.contains(bucket.Key) };
            auto group{ winrt::make_self<implementation::TabGroup>() };
            group->Key(winrt::hstring{ bucket.Key });
            group->Name(winrt::hstring{ bucket.Name });
            group->Path(winrt::hstring{ bucket.Path });
            group->Count(gsl::narrow_cast<uint32_t>(bucket.Tabs.size()));
            group->IsCollapsed(collapsed);
            group->CanOpenNewTab(bucket.CanOpenNewTab);
            _railItems.Append(*group);

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
                    if (tabImpl->RailSubtitle() != subtitle)
                    {
                        tabImpl->RailSubtitle(winrt::hstring{ subtitle });
                    }
                }
                if (!collapsed)
                {
                    _railItems.Append(tab);
                }
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
        const std::wstring key{ group.Key().c_str() };
        if (!_collapsedGroups.erase(key))
        {
            _collapsedGroups.insert(key);
        }
        _updateFilteredTabs(false);
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
        winrt::hstring directory;
        const std::wstring key{ group.Key().c_str() };
        for (const auto& tab : _tabs)
        {
            if (!tab.ProjectId().empty() && tab.ProjectId() == group.Key() && !tab.ProjectPath().empty())
            {
                directory = tab.ProjectPath();
                break;
            }
            if (!tab.WorkingDirectory().empty() && key == L"dir:" + _pathKey(tab.WorkingDirectory()))
            {
                directory = tab.WorkingDirectory();
                break;
            }
        }
        if (!directory.empty())
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
            SelectTab(_selectedTab);
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

    void TabRowControl::OnCollectWindowsClick(const winrt::Windows::Foundation::IInspectable&,
                                              const winrt::Windows::UI::Xaml::RoutedEventArgs&)
    {
        if (CollectWindowsRequested)
        {
            CollectWindowsRequested();
        }
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

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include <functional>
#include <map>
#include <memory>
#include <optional>
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
        // One top-level heading of the rail, published so the project strip
        // above it can be built from exactly the same list. The two surfaces
        // used to be computed from different sources - the rail from the live
        // tabs, the strip from the terminal-web project store - which is why
        // they disagreed whenever the bridge was offline or held a saved
        // project with no terminal open in it.
        struct RailSection
        {
            // "dir:<normalized directory>", or NoDirectorySectionKey for the
            // "no directory" heading. This is the filter id the strip hands
            // back to SetSectionFilter.
            winrt::hstring Key;
            // Exactly the text the rail's heading shows.
            winrt::hstring Name;
            // The section's real directory in its own casing; empty for the
            // "no directory" section.
            winrt::hstring Directory;
            // Tabs under the heading, nested subsections included.
            uint32_t Count{ 0 };

            bool operator==(const RailSection&) const = default;
        };

        // The "no directory" section's group key is empty, which would be
        // indistinguishable from "no filter" (= All), so it takes a sentinel
        // of its own in the strip.
        static constexpr std::wstring_view NoDirectorySectionKey{ L"section:none" };

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
        void OnTabGroupHeaderClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnTabGroupNewTabClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnTabGroupHeaderKeyDown(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e);
        void OnTabGroupHeaderPointerEntered(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnTabGroupHeaderPointerExited(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnTabGroupNewTabGotFocus(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnTabGroupNewTabLostFocus(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnNewTabProfilesPanelSizeChanged(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::SizeChangedEventArgs& e);
        void OnRecentSortToggleChecked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnRecentSortToggleUnchecked(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnVerticalTabSearchClearClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void OnVerticalTabSearchKeyDown(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e);
        void OnVerticalTabRowPointerEntered(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnVerticalTabRowPointerExited(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs& e);
        void OnCollapseAllClick(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);

        void SetTabs(const winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab>& tabs);
        void NotifyTabTitleUpdated(const winrt::TerminalApp::Tab& tab);
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::TerminalApp::Tab> FilteredTabs() const noexcept;
        void SelectTab(const winrt::TerminalApp::Tab& tab);
        void NotifyTabDirectoryUpdated();
        void FitNewTabProfileButtons();

        // --- Sections: the rail's headings, and the strip built from them ---

        // The current top-level headings, in the order the rail draws them.
        const std::vector<RailSection>& RailSections() const noexcept;
        // Show only the tabs of one section (empty = every tab). Nested
        // sections stay inside their parent, so filtering to "J:\Projects"
        // keeps the tab that lives in "J:\Projects\instagram".
        void SetSectionFilter(const winrt::hstring& sectionKey);
        winrt::hstring SectionFilter() const noexcept;
        // Display names for section directories - the bridge's project names
        // plus any local rename - keyed by NormalizeDirectory().
        void SetSectionNames(std::map<std::wstring, winrt::hstring> names);
        // Section order, as normalized directories. Sections not named here
        // follow the named ones, by name.
        void SetSectionOrder(std::vector<std::wstring> directoryKeys);
        // Brings a section's heading into view without changing the filter.
        void ScrollSectionIntoView(const winrt::hstring& sectionKey);

        // Which section a tab belongs to, and whether a section holds it.
        // Containment-aware: a tab in a nested section belongs to its
        // ancestors too, because that is what the rail draws.
        static winrt::hstring SectionKeyForTab(const winrt::TerminalApp::Tab& tab);
        static winrt::hstring SectionKeyForDirectory(const winrt::hstring& directory);
        static bool SectionContainsTab(const winrt::hstring& sectionKey, const winrt::TerminalApp::Tab& tab);
        // The rail's own directory normalization, public so that anything
        // keying by directory (the strip's names and order) agrees with it.
        static std::wstring NormalizeDirectory(std::wstring_view path)
        {
            return _pathKey(path);
        }

        til::typed_event<winrt::Windows::Foundation::IInspectable, winrt::TerminalApp::Tab> VerticalTabSelected;
        std::function<void(const winrt::TerminalApp::Tab&, uint32_t)> VerticalTabMoveRequested;
        std::function<void(const winrt::hstring&)> NewTabInDirectoryRequested;
        // Raised only when the set of top-level sections actually changes.
        std::function<void()> RailSectionsChanged;

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
        // The row the pointer is over. Row actions are chrome: they show for
        // this row, the selected row and the row holding keyboard focus, and
        // are transparent everywhere else so the title keeps the width.
        winrt::TerminalApp::Tab _hoveredTab{ nullptr };
        // Optional parts of the rail's markup, resolved by name once. They
        // live in a file this one doesn't own, so a build without them has to
        // degrade rather than crash.
        bool _railChromeResolved{ false };
        winrt::Windows::UI::Xaml::FrameworkElement _searchClearButton{ nullptr };
        winrt::Windows::UI::Xaml::FrameworkElement _emptyState{ nullptr };
        winrt::Windows::UI::Xaml::Controls::TextBlock _emptyStateText{ nullptr };
        std::vector<winrt::TerminalApp::Tab> _recentActivityTabs;
        std::vector<ActivityDebounce> _activityDebounces;
        // Depth counter: >0 while we're programmatically mutating the vertical
        // list selection or rebuilding _filteredTabs, so SelectionChanged
        // callbacks raised by our own mutations don't re-enter tab focusing.
        uint32_t _updatingVerticalSelection{ 0 };
        // Debounces the expensive buffer-text search pass while typing.
        SafeDispatcherTimer _bufferSearchTimer;
        // Non-empty: only show the tabs of this rail section (see
        // SectionContainsTab).
        winrt::hstring _sectionFilter;
        // Section order and display names, both keyed by normalized
        // directory, supplied by the project strip.
        std::vector<std::wstring> _sectionOrder;
        std::map<std::wstring, winrt::hstring> _sectionNames;
        // Last published set of top-level sections, and a re-entrancy guard:
        // RailSectionsChanged lands in the strip's rebuild, which can push
        // names/order straight back in here.
        std::vector<RailSection> _railSections;
        uint32_t _publishingRailSections{ 0 };
        // Project sections of the "All" view (bound through GroupedTabsSource).
        // What the rail's ListView actually shows: TabGroup headers
        // interleaved with Tab rows (or just tabs in flat views).
        winrt::Windows::Foundation::Collections::IObservableVector<winrt::Windows::Foundation::IInspectable> _railItems{ nullptr };
        // Group keys the user collapsed; their tabs stay out of the list.
        std::set<std::wstring> _collapsedGroups;
        // Tab -> collapsed group key, so selecting a hidden tab reopens its group.
        std::vector<std::pair<winrt::TerminalApp::Tab, std::wstring>> _collapsedTabs;
        // Header objects reused across rebuilds (keyed by group key) so the
        // ListView keeps their containers and property changes animate.
        std::map<std::wstring, winrt::com_ptr<TabGroup>> _groupCache;

        struct TabGroupBucket
        {
            std::wstring Key;
            std::wstring Name;
            // Text under the name: full display path at depth 0, otherwise
            // the directory relative to the parent section.
            std::wstring Path;
            // Real section directory (own casing) and its normalized key.
            std::wstring Directory;
            std::wstring PathKey;
            size_t Rank{ 0 };
            // Index of the enclosing section in the returned vector, -1 for
            // a top-level project. Parents always precede their children.
            int32_t Parent{ -1 };
            uint32_t Depth{ 0 };
            // Tabs directly in this section plus those of nested sections.
            uint32_t TotalCount{ 0 };
            // Key of the collapsed section (self or an ancestor) hiding this
            // one, filled in during a rebuild; empty when fully visible.
            std::wstring HiddenBy;
            bool CanOpenNewTab{ false };
            std::vector<winrt::TerminalApp::Tab> Tabs;
        };
        std::vector<TabGroupBucket> _bucketTabsByPath(const std::vector<winrt::TerminalApp::Tab>& tabs) const;
        static std::wstring _sectionRootForTab(const winrt::TerminalApp::Tab& tab);
        static bool _isGenericRoot(std::wstring_view pathKey);
        static std::wstring _homeKey();
        void _publishGroups(std::vector<TabGroupBucket> buckets, std::vector<winrt::Windows::Foundation::IInspectable>& items);
        void _applyRailItems(const std::vector<winrt::Windows::Foundation::IInspectable>& items);
        void _toggleGroup(const winrt::TerminalApp::TabGroup& group, const std::optional<bool> collapse, const winrt::Windows::UI::Xaml::Controls::Button& headerButton);
        static void _setHeaderNewTabButtonOpacity(const winrt::Windows::UI::Xaml::FrameworkElement& headerRoot, const double opacity);
        static winrt::Windows::UI::Xaml::FrameworkElement _findNamedDescendant(const winrt::Windows::UI::Xaml::DependencyObject& root, const std::wstring_view name, const uint32_t depth = 8);
        bool _applyRowActionOpacity(const winrt::Windows::UI::Xaml::FrameworkElement& scope, const winrt::Windows::Foundation::IInspectable& item, const winrt::Windows::Foundation::IInspectable& focusedItem);
        void _updateRowActionAffordances();
        static std::wstring _pathKey(std::wstring_view path);
        static std::wstring _pathLeaf(std::wstring_view path);
        static std::wstring _displayPath(std::wstring_view path);
        static bool _pathIsUnder(std::wstring_view childKey, std::wstring_view parentKey);

        void _updateFilteredTabs(const bool includeBufferSearch = true);
        void _updateRailSections();
        void _syncListSelection();
        void _resolveRailChrome();
        void _updateSearchChrome(const winrt::hstring& query, const bool anyRows);
        void _focusSelectedTerminal();
        winrt::Windows::Foundation::IInspectable _railItemHoldingFocus();
        winrt::Windows::UI::Xaml::Controls::ListViewItem _railTabContainer(const int32_t startIndex, const bool forward, const bool realize);
        void _restoreRailFocus(const winrt::Windows::Foundation::IInspectable& item);
        void _onVerticalTabListKeyDown(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs& e);
        void _onVerticalTabListGettingFocus(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Input::GettingFocusEventArgs& e);
        void _onVerticalTabListFocusChanged(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::RoutedEventArgs& e);
        void _onVerticalTabContainerContentChanging(const winrt::Windows::Foundation::IInspectable& sender, const winrt::Windows::UI::Xaml::Controls::ContainerContentChangingEventArgs& e);
        bool _isGroupedView();
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
        static winrt::hstring _optionalResourceString(const std::wstring_view key);
    };
}

namespace winrt::TerminalApp::factory_implementation
{
    BASIC_FACTORY(TabRowControl);
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include "TabGroup.g.h"

namespace winrt::TerminalApp::implementation
{
    // Where every live tab is checked out, so that the rail can say each fact
    // exactly once.
    //
    // Inside one git checkout every tab is on the same branch, so repeating it
    // on every row - the column of nine identical "main"s - carries no
    // information at all. The section header for that repository says it once
    // instead (TabGroup::Branch), and a row only speaks up when it genuinely
    // disagrees with its siblings: a worktree, or a submodule.
    //
    // Tabs publish into this table as their directory is resolved, and sections
    // read it as the rail is rebuilt. Both happen on the UI thread, but a tab
    // can be torn down from anywhere, so the table is locked.
    struct RailSemantics
    {
        // "F:\Repo\" and "f:/repo" have to compare equal. Mirrors
        // TabRowControl::_pathKey, which is what buckets tabs into sections.
        static std::wstring Key(std::wstring_view path);

        // Where a tab is working and on what branch. Returns true when this
        // moved the branch a repository agrees on - every row filed under it,
        // and its header, then has to re-decide what to print.
        static bool PublishTab(uintptr_t tab, std::wstring_view gitRoot, const winrt::hstring& branch);
        static bool RetireTab(uintptr_t tab);

        // The branch every live tab in this repository agrees on; "" when the
        // directory is no repository we have seen, or the tabs disagree - and
        // then the branch is genuinely per-row and every row prints its own.
        static winrt::hstring Branch(std::wstring_view directory);
        static bool IsRepositoryRoot(std::wstring_view directory);
    };

    struct TabGroup : TabGroupT<TabGroup>
    {
        TabGroup() = default;

        winrt::hstring CountText() const;
        double ChevronAngle() const noexcept;
        winrt::hstring AccessibleName() const;
        // Setters that also raise the derived properties above.
        winrt::Windows::UI::Xaml::Visibility ActiveMarkerVisibility() const noexcept;
        void Update(const winrt::hstring& name, const winrt::hstring& path, uint32_t count, bool collapsed, bool canOpenNewTab, bool containsActiveTab);
        winrt::Windows::UI::Xaml::Thickness HeaderMargin() const noexcept;
        double NameFontSize() const noexcept;
        void Depth(uint32_t value);
        uint32_t Depth() const noexcept { return _Depth; }

        // The directory the section is drawn for. Assigning it - which the rail
        // does on every rebuild, even when the value is unchanged - is also
        // when the section re-reads whether that directory is a repository
        // root and which branch it is on.
        winrt::hstring Directory() const noexcept { return _Directory; }
        void Directory(const winrt::hstring& value);
        // Folder or repository, for the glyph in front of the section name.
        bool IsRepositoryRoot() const noexcept { return _IsRepositoryRoot; }
        void IsRepositoryRoot(bool value);
        winrt::hstring SectionGlyph() const;
        // The repository's current branch, so the rail prints it once here
        // instead of once per row. "" when the section is a plain folder.
        winrt::hstring Branch() const noexcept { return _Branch; }

        til::property_changed_event PropertyChanged;
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Key, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Name, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Path, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(uint32_t, Count, PropertyChanged.raise, 0);
        WINRT_OBSERVABLE_PROPERTY(bool, ShowDivider, PropertyChanged.raise, false);
        WINRT_OBSERVABLE_PROPERTY(bool, IsCollapsed, PropertyChanged.raise, false);
        WINRT_OBSERVABLE_PROPERTY(bool, CanOpenNewTab, PropertyChanged.raise, false);
        WINRT_OBSERVABLE_PROPERTY(bool, ContainsActiveTab, PropertyChanged.raise, false);

    private:
        uint32_t _Depth{ 0 };
        winrt::hstring _Directory;
        winrt::hstring _Branch;
        bool _IsRepositoryRoot{ false };
    };
}

namespace winrt::TerminalApp::factory_implementation
{
    BASIC_FACTORY(TabGroup);
}

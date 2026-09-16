// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TabGroup.h"
#include "TabGroup.g.cpp"

#include <LibraryResources.h>

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <mutex>
#include <unordered_map>

namespace
{
    // Segoe Fluent Icons / Segoe MDL2 Assets, both verified present on the
    // machines we ship to: E8B7 is the folder, E943 the code braces.
    constexpr std::wstring_view FolderGlyph{ L"\uE8B7" };
    constexpr std::wstring_view RepositoryGlyph{ L"\uE943" };

    struct RailSemanticsTable
    {
        struct TabEntry
        {
            std::wstring RootKey;
            winrt::hstring Branch;
        };

        std::mutex Mutex;
        // Live tabs, keyed by the tab's address; retired on teardown, so an
        // address can never be mistaken for a tab that has gone away.
        std::unordered_map<uintptr_t, TabEntry> Tabs;

        // Caller holds the lock.
        winrt::hstring ConsensusLocked(const std::wstring& rootKey) const
        {
            if (rootKey.empty())
            {
                return {};
            }
            winrt::hstring agreed;
            auto seen{ false };
            for (const auto& tab : Tabs)
            {
                const auto& entry{ tab.second };
                if (entry.RootKey != rootKey)
                {
                    continue;
                }
                if (!seen)
                {
                    agreed = entry.Branch;
                    seen = true;
                }
                else if (agreed != entry.Branch)
                {
                    // Worktrees or submodules of the same root disagree; then
                    // the branch is genuinely per-row and no header can own it.
                    return {};
                }
            }
            return agreed;
        }
    };

    RailSemanticsTable& railSemantics()
    {
        static RailSemanticsTable table;
        return table;
    }
}

namespace winrt::TerminalApp::implementation
{
    std::wstring RailSemantics::Key(const std::wstring_view path)
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
        // "C:\repo\" -> "C:\repo"; a drive root keeps its separator.
        while (key.size() > 3 && (key.back() == L'\\' || key.back() == L'/'))
        {
            key.pop_back();
        }
        std::transform(key.begin(), key.end(), key.begin(), [](const wchar_t ch) {
            return static_cast<wchar_t>(std::towlower(ch));
        });
        return key;
    }

    // Method Description:
    // - Records where a tab is working and what branch it is on.
    // Return Value:
    // - True when the branch a repository agrees on moved, either for the
    //   repository the tab left or the one it joined. The caller then has to
    //   re-raise the derived strings on the other rows in those repositories.
    bool RailSemantics::PublishTab(const uintptr_t tab, const std::wstring_view gitRoot, const winrt::hstring& branch)
    {
        auto& table{ railSemantics() };
        const std::lock_guard guard{ table.Mutex };

        auto rootKey{ Key(gitRoot) };
        const auto existing{ table.Tabs.find(tab) };
        if (existing != table.Tabs.end() && existing->second.RootKey == rootKey && existing->second.Branch == branch)
        {
            return false;
        }

        const auto previousKey{ existing == table.Tabs.end() ? std::wstring{} : existing->second.RootKey };
        const auto previousBefore{ table.ConsensusLocked(previousKey) };
        const auto currentBefore{ table.ConsensusLocked(rootKey) };

        if (rootKey.empty())
        {
            table.Tabs.erase(tab);
        }
        else
        {
            table.Tabs[tab] = RailSemanticsTable::TabEntry{ std::move(rootKey), branch };
        }

        return table.ConsensusLocked(previousKey) != previousBefore ||
               table.ConsensusLocked(Key(gitRoot)) != currentBefore;
    }

    bool RailSemantics::RetireTab(const uintptr_t tab)
    {
        auto& table{ railSemantics() };
        const std::lock_guard guard{ table.Mutex };

        const auto existing{ table.Tabs.find(tab) };
        if (existing == table.Tabs.end())
        {
            return false;
        }
        const auto rootKey{ existing->second.RootKey };
        const auto before{ table.ConsensusLocked(rootKey) };
        table.Tabs.erase(existing);
        return table.ConsensusLocked(rootKey) != before;
    }

    winrt::hstring RailSemantics::Branch(const std::wstring_view directory)
    {
        auto& table{ railSemantics() };
        const auto key{ Key(directory) };
        const std::lock_guard guard{ table.Mutex };
        return table.ConsensusLocked(key);
    }

    bool RailSemantics::IsRepositoryRoot(const std::wstring_view directory)
    {
        const auto key{ Key(directory) };
        if (key.empty())
        {
            return false;
        }
        auto& table{ railSemantics() };
        const std::lock_guard guard{ table.Mutex };
        return std::any_of(table.Tabs.begin(), table.Tabs.end(), [&](const auto& entry) {
            return entry.second.RootKey == key;
        });
    }

    winrt::hstring TabGroup::CountText() const
    {
        return winrt::to_hstring(_Count);
    }

    double TabGroup::ChevronAngle() const noexcept
    {
        return _IsCollapsed ? -90.0 : 0.0;
    }

    winrt::hstring TabGroup::AccessibleName() const
    {
        std::wstring name;
        if (_IsCollapsed)
        {
            name = RS_fmt(L"TabGroupHeaderAccessibleNameCollapsed", _Name, _Count);
        }
        else
        {
            name = RS_fmt(L"TabGroupHeaderAccessibleNameExpanded", _Name, _Count);
        }

        // The rows underneath drop the branch precisely because this header
        // owns it, so it has to be announced here or it is announced nowhere.
        if (!_Branch.empty())
        {
            name.append(L", ");
            name.append(std::wstring_view{ _Branch });
        }
        return winrt::hstring{ name };
    }

    // The marker only earns its place while the section is folded; expanded,
    // the selected row itself shows where focus is.
    winrt::Windows::UI::Xaml::Visibility TabGroup::ActiveMarkerVisibility() const noexcept
    {
        return (_IsCollapsed && _ContainsActiveTab) ? winrt::Windows::UI::Xaml::Visibility::Visible : winrt::Windows::UI::Xaml::Visibility::Collapsed;
    }

    // Nested subheadings indent under their parent and sit closer to the
    // rows above them; top-level sections keep the roomier gap.
    winrt::Windows::UI::Xaml::Thickness TabGroup::HeaderMargin() const noexcept
    {
        return winrt::Windows::UI::Xaml::Thickness{ 14.0 * _Depth, _Depth == 0 ? 10.0 : 4.0, 0.0, 2.0 };
    }

    double TabGroup::NameFontSize() const noexcept
    {
        return _Depth == 0 ? 12.0 : 11.5;
    }

    // Method Description:
    // - Points the section at a directory, and - because the rail assigns this
    //   on every rebuild, unchanged value included - takes the opportunity to
    //   re-read whether that directory is a repository and which branch it is
    //   on. Only values that actually moved raise.
    void TabGroup::Directory(const winrt::hstring& value)
    {
        if (_Directory != value)
        {
            _Directory = value;
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"Directory" });
        }

        IsRepositoryRoot(RailSemantics::IsRepositoryRoot(_Directory));
        if (const auto branch{ RailSemantics::Branch(_Directory) }; _Branch != branch)
        {
            _Branch = branch;
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"Branch" });
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"AccessibleName" });
        }
    }

    void TabGroup::IsRepositoryRoot(const bool value)
    {
        if (_IsRepositoryRoot != value)
        {
            _IsRepositoryRoot = value;
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"IsRepositoryRoot" });
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"SectionGlyph" });
        }
    }

    winrt::hstring TabGroup::SectionGlyph() const
    {
        return winrt::hstring{ _IsRepositoryRoot ? RepositoryGlyph : FolderGlyph };
    }

    void TabGroup::Depth(const uint32_t value)
    {
        if (_Depth != value)
        {
            _Depth = value;
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"Depth" });
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"HeaderMargin" });
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ L"NameFontSize" });
        }
    }

    // Method Description:
    // - Applies a rebuilt bucket to a cached group. Only changed values raise,
    //   and the derived CountText/ChevronAngle/AccessibleName follow, so the
    //   ListView keeps the same container and the chevron can animate.
    void TabGroup::Update(const winrt::hstring& name, const winrt::hstring& path, uint32_t count, bool collapsed, bool canOpenNewTab, bool containsActiveTab)
    {
        const auto raise = [this](const wchar_t* property) {
            PropertyChanged.raise(*this, winrt::Windows::UI::Xaml::Data::PropertyChangedEventArgs{ property });
        };
        const auto collapsedChanged{ _IsCollapsed != collapsed };
        if (_Name != name || _Count != count || collapsedChanged)
        {
            Name(name);
            Count(count);
            IsCollapsed(collapsed);
            raise(L"CountText");
            raise(L"ChevronAngle");
            raise(L"AccessibleName");
        }
        if (_ContainsActiveTab != containsActiveTab || collapsedChanged)
        {
            ContainsActiveTab(containsActiveTab);
            raise(L"ActiveMarkerVisibility");
        }
        Path(path);
        CanOpenNewTab(canOpenNewTab);
    }
}

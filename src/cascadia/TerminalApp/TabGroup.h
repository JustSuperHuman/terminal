// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include "TabGroup.g.h"

namespace winrt::TerminalApp::implementation
{
    struct TabGroup : TabGroupT<TabGroup>
    {
        TabGroup() = default;

        winrt::hstring CountText() const;
        winrt::hstring ChevronGlyph() const;

        til::property_changed_event PropertyChanged;
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Key, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Name, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(winrt::hstring, Path, PropertyChanged.raise);
        WINRT_OBSERVABLE_PROPERTY(uint32_t, Count, PropertyChanged.raise, 0);
        WINRT_OBSERVABLE_PROPERTY(bool, IsCollapsed, PropertyChanged.raise, false);
        WINRT_OBSERVABLE_PROPERTY(bool, CanOpenNewTab, PropertyChanged.raise, false);
    };
}

namespace winrt::TerminalApp::factory_implementation
{
    BASIC_FACTORY(TabGroup);
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TabGroup.h"
#include "TabGroup.g.cpp"

namespace winrt::TerminalApp::implementation
{
    winrt::hstring TabGroup::CountText() const
    {
        return winrt::to_hstring(_Count);
    }

    // E70D = ChevronDown (expanded), E76C = ChevronRight (collapsed).
    winrt::hstring TabGroup::ChevronGlyph() const
    {
        return _IsCollapsed ? winrt::hstring{ L"\uE76C" } : winrt::hstring{ L"\uE70D" };
    }
}

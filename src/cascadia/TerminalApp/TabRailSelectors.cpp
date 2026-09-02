// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "TabRailSelectors.h"
#include "TabRailItemTemplateSelector.g.cpp"
#include "TabRailItemStyleSelector.g.cpp"

namespace winrt::TerminalApp::implementation
{
    Windows::UI::Xaml::DataTemplate TabRailItemTemplateSelector::SelectTemplateCore(const winrt::Windows::Foundation::IInspectable& item, const winrt::Windows::UI::Xaml::DependencyObject& /*container*/)
    {
        return SelectTemplateCore(item);
    }

    Windows::UI::Xaml::DataTemplate TabRailItemTemplateSelector::SelectTemplateCore(const winrt::Windows::Foundation::IInspectable& item)
    {
        return item.try_as<winrt::TerminalApp::TabGroup>() ? GroupHeaderTemplate() : TabTemplate();
    }

    Windows::UI::Xaml::Style TabRailItemStyleSelector::SelectStyleCore(const winrt::Windows::Foundation::IInspectable& item, const winrt::Windows::UI::Xaml::DependencyObject& /*container*/)
    {
        return item.try_as<winrt::TerminalApp::TabGroup>() ? GroupHeaderStyle() : TabStyle();
    }
}

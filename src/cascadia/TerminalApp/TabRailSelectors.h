// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include "TabRailItemTemplateSelector.g.h"
#include "TabRailItemStyleSelector.g.h"

namespace winrt::TerminalApp::implementation
{
    struct TabRailItemTemplateSelector : TabRailItemTemplateSelectorT<TabRailItemTemplateSelector>
    {
        TabRailItemTemplateSelector() = default;

        Windows::UI::Xaml::DataTemplate SelectTemplateCore(const winrt::Windows::Foundation::IInspectable& item, const winrt::Windows::UI::Xaml::DependencyObject& container);
        Windows::UI::Xaml::DataTemplate SelectTemplateCore(const winrt::Windows::Foundation::IInspectable& item);

        WINRT_PROPERTY(winrt::Windows::UI::Xaml::DataTemplate, GroupHeaderTemplate);
        WINRT_PROPERTY(winrt::Windows::UI::Xaml::DataTemplate, TabTemplate);
    };

    struct TabRailItemStyleSelector : TabRailItemStyleSelectorT<TabRailItemStyleSelector>
    {
        TabRailItemStyleSelector() = default;

        Windows::UI::Xaml::Style SelectStyleCore(const winrt::Windows::Foundation::IInspectable& item, const winrt::Windows::UI::Xaml::DependencyObject& container);

        WINRT_PROPERTY(winrt::Windows::UI::Xaml::Style, GroupHeaderStyle);
        WINRT_PROPERTY(winrt::Windows::UI::Xaml::Style, TabStyle);
    };
}

namespace winrt::TerminalApp::factory_implementation
{
    BASIC_FACTORY(TabRailItemTemplateSelector);
    BASIC_FACTORY(TabRailItemStyleSelector);
}

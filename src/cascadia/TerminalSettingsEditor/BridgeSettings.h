// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

#include "BridgeSettings.g.h"
#include "BridgeSettingsViewModel.g.h"
#include "ViewModelHelpers.h"
#include "Utils.h"

namespace winrt::Microsoft::Terminal::Settings::Editor::implementation
{
    struct BridgeSettingsViewModel : BridgeSettingsViewModelT<BridgeSettingsViewModel>, ViewModelHelper<BridgeSettingsViewModel>
    {
        BridgeSettingsViewModel(Model::CascadiaSettings settings);

        using ViewModelHelper<BridgeSettingsViewModel>::PropertyChanged;

        PERMANENT_OBSERVABLE_PROJECTED_SETTING(_settings.GlobalSettings(), BridgeEnabled);
        PERMANENT_OBSERVABLE_PROJECTED_SETTING(_settings.GlobalSettings(), BridgeWebInterface);

        bool BridgeAutomaticPort() const;
        void BridgeAutomaticPort(bool value);
        bool ManualPortEnabled() const;

        winrt::hstring BridgePortText() const;
        void BridgePortText(const winrt::hstring& value);
        winrt::hstring BridgePortError() const;

        winrt::hstring BridgeBindAddress() const;
        void BridgeBindAddress(const winrt::hstring& value);
        winrt::hstring BridgeBindAddressError() const;

    private:
        Model::CascadiaSettings _settings;
        winrt::hstring _bridgePortError;
        winrt::hstring _bridgeBindAddressError;
    };

    struct BridgeSettings : public HasScrollViewer<BridgeSettings>, BridgeSettingsT<BridgeSettings>
    {
        BridgeSettings();
        void OnNavigatedTo(const winrt::Windows::UI::Xaml::Navigation::NavigationEventArgs& e);

        til::property_changed_event PropertyChanged;
        WINRT_OBSERVABLE_PROPERTY(Editor::BridgeSettingsViewModel, ViewModel, PropertyChanged.raise, nullptr);
    };
}

namespace winrt::Microsoft::Terminal::Settings::Editor::factory_implementation
{
    BASIC_FACTORY(BridgeSettings);
    BASIC_FACTORY(BridgeSettingsViewModel);
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "BridgeSettings.h"
#include "BridgeSettings.g.cpp"
#include "BridgeSettingsViewModel.g.cpp"

#include <ws2tcpip.h>

#pragma comment(lib, "Ws2_32.lib")

using namespace winrt::Windows::UI::Xaml::Navigation;

namespace winrt::Microsoft::Terminal::Settings::Editor::implementation
{
    BridgeSettingsViewModel::BridgeSettingsViewModel(Model::CascadiaSettings settings) :
        _settings{ std::move(settings) }
    {
    }

    bool BridgeSettingsViewModel::BridgeAutomaticPort() const
    {
        return _settings.GlobalSettings().BridgeAutomaticPort();
    }

    void BridgeSettingsViewModel::BridgeAutomaticPort(const bool value)
    {
        if (BridgeAutomaticPort() != value)
        {
            _settings.GlobalSettings().BridgeAutomaticPort(value);
            _NotifyChanges(L"BridgeAutomaticPort", L"ManualPortEnabled");
        }
    }

    bool BridgeSettingsViewModel::ManualPortEnabled() const
    {
        return !BridgeAutomaticPort();
    }

    winrt::hstring BridgeSettingsViewModel::BridgePortText() const
    {
        return winrt::to_hstring(_settings.GlobalSettings().BridgePort());
    }

    void BridgeSettingsViewModel::BridgePortText(const winrt::hstring& value)
    {
        wchar_t* end = nullptr;
        const auto port = std::wcstol(value.c_str(), &end, 10);
        if (!value.empty() && end == value.c_str() + value.size() && port >= 1 && port <= 65535)
        {
            _settings.GlobalSettings().BridgePort(static_cast<int32_t>(port));
            _bridgePortError.clear();
        }
        else
        {
            _bridgePortError = L"Enter a port from 1 through 65535.";
        }
        _NotifyChanges(L"BridgePortError");
    }

    winrt::hstring BridgeSettingsViewModel::BridgePortError() const
    {
        return _bridgePortError;
    }

    winrt::hstring BridgeSettingsViewModel::BridgeBindAddress() const
    {
        return _settings.GlobalSettings().BridgeBindAddress();
    }

    void BridgeSettingsViewModel::BridgeBindAddress(const winrt::hstring& value)
    {
        IN_ADDR ipv4{};
        IN6_ADDR ipv6{};
        if (InetPtonW(AF_INET, value.c_str(), &ipv4) == 1 || InetPtonW(AF_INET6, value.c_str(), &ipv6) == 1)
        {
            _settings.GlobalSettings().BridgeBindAddress(value);
            _bridgeBindAddressError.clear();
        }
        else
        {
            _bridgeBindAddressError = L"Enter a valid IPv4 or IPv6 address.";
        }
        _NotifyChanges(L"BridgeBindAddressError");
    }

    winrt::hstring BridgeSettingsViewModel::BridgeBindAddressError() const
    {
        return _bridgeBindAddressError;
    }

    BridgeSettings::BridgeSettings()
    {
        InitializeComponent();
    }

    void BridgeSettings::OnNavigatedTo(const NavigationEventArgs& e)
    {
        const auto args = e.Parameter().as<Editor::NavigateToPageArgs>();
        _ViewModel = args.ViewModel().as<Editor::BridgeSettingsViewModel>();
        BringIntoViewWhenLoaded(args.ElementToFocus());
    }
}

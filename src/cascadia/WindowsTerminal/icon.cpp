// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "pch.h"
#include "icon.h"
#include "resource.h"

static int _GetActiveAppIconResource()
{
    auto iconResource{ IDI_APPICON };

    HIGHCONTRASTW hcInfo{};
    hcInfo.cbSize = sizeof(hcInfo);

    if (SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(hcInfo), &hcInfo, 0))
    {
        if (WI_IsFlagSet(hcInfo.dwFlags, HCF_HIGHCONTRASTON))
        {
            iconResource = IDI_APPICON_HC_BLACK;

            if (0x00FFFFFF == GetSysColor(COLOR_WINDOW)) // white window color == white high contrast
            {
                iconResource = IDI_APPICON_HC_WHITE;
            }
        }
    }

    return iconResource;
}

// There's only two possible sizes - ICON_SMALL and ICON_BIG.
// So, use true for smallIcon if you want small and false for big.
HANDLE GetActiveAppIconHandle(bool smallIcon)
{
    auto iconResource{ MAKEINTRESOURCEW(_GetActiveAppIconResource()) };

    const auto smXIcon = smallIcon ? SM_CXSMICON : SM_CXICON;
    const auto smYIcon = smallIcon ? SM_CYSMICON : SM_CYICON;

    // These handles are loaded with LR_SHARED, so they are safe to "leak".
    auto hIcon{ LoadImageW(wil::GetModuleInstanceHandle(), iconResource, IMAGE_ICON, GetSystemMetrics(smXIcon), GetSystemMetrics(smYIcon), LR_SHARED) };
    LOG_LAST_ERROR_IF_NULL(hIcon);

    return hIcon;
}

wil::unique_hicon CreateNotificationIconHandle()
{
    constexpr COLORREF trayIconTint = RGB(0xff, 0xd7, 0x00);

    const auto width = GetSystemMetrics(SM_CXSMICON);
    const auto height = GetSystemMetrics(SM_CYSMICON);
    const auto sourceIcon = reinterpret_cast<HICON>(GetActiveAppIconHandle(true));
    if (!sourceIcon || width <= 0 || height <= 0)
    {
        return {};
    }

    BITMAPINFO bitmapInfo{};
    bitmapInfo.bmiHeader.biSize = sizeof(bitmapInfo.bmiHeader);
    bitmapInfo.bmiHeader.biWidth = width;
    bitmapInfo.bmiHeader.biHeight = -height;
    bitmapInfo.bmiHeader.biPlanes = 1;
    bitmapInfo.bmiHeader.biBitCount = 32;
    bitmapInfo.bmiHeader.biCompression = BI_RGB;

    void* bitmapBits = nullptr;
    wil::unique_hbitmap colorBitmap{ CreateDIBSection(nullptr, &bitmapInfo, DIB_RGB_COLORS, &bitmapBits, nullptr, 0) };
    LOG_LAST_ERROR_IF_NULL(colorBitmap.get());
    if (!colorBitmap || !bitmapBits)
    {
        return {};
    }

    wil::unique_hdc drawDc{ CreateCompatibleDC(nullptr) };
    LOG_LAST_ERROR_IF_NULL(drawDc.get());
    if (!drawDc)
    {
        return {};
    }

    const auto previousBitmap = SelectObject(drawDc.get(), colorBitmap.get());
    if (!previousBitmap)
    {
        LOG_LAST_ERROR();
        return {};
    }
    const auto restoreBitmap = wil::scope_exit([&]() noexcept {
        SelectObject(drawDc.get(), previousBitmap);
    });

    std::memset(bitmapBits, 0, gsl::narrow_cast<size_t>(width) * gsl::narrow_cast<size_t>(height) * sizeof(uint32_t));
    if (LOG_LAST_ERROR_IF(!DrawIconEx(drawDc.get(), 0, 0, sourceIcon, width, height, 0, nullptr, DI_NORMAL)))
    {
        return {};
    }

    auto pixels = static_cast<uint32_t*>(bitmapBits);
    const auto pixelCount = gsl::narrow_cast<size_t>(width) * gsl::narrow_cast<size_t>(height);

    bool hasAlpha = false;
    for (size_t i = 0; i < pixelCount; ++i)
    {
        if ((pixels[i] & 0xff000000) != 0)
        {
            hasAlpha = true;
            break;
        }
    }

    for (size_t i = 0; i < pixelCount; ++i)
    {
        const auto pixel = pixels[i];
        const auto alpha = static_cast<uint8_t>(pixel >> 24);
        const auto blue = static_cast<uint8_t>(pixel);
        const auto green = static_cast<uint8_t>(pixel >> 8);
        const auto red = static_cast<uint8_t>(pixel >> 16);
        const auto visible = hasAlpha ? alpha != 0 : (red != 0 || green != 0 || blue != 0);
        if (visible)
        {
            const auto outputAlpha = hasAlpha ? alpha : 0xff;
            pixels[i] = (static_cast<uint32_t>(outputAlpha) << 24) |
                        (static_cast<uint32_t>(GetRValue(trayIconTint)) << 16) |
                        (static_cast<uint32_t>(GetGValue(trayIconTint)) << 8) |
                        static_cast<uint32_t>(GetBValue(trayIconTint));
        }
    }

    const auto maskStride = gsl::narrow_cast<size_t>(((width + 15) / 16) * 2);
    std::vector<uint8_t> maskBits(maskStride * gsl::narrow_cast<size_t>(height));
    wil::unique_hbitmap maskBitmap{ CreateBitmap(width, height, 1, 1, maskBits.data()) };
    LOG_LAST_ERROR_IF_NULL(maskBitmap.get());
    if (!maskBitmap)
    {
        return {};
    }

    ICONINFO iconInfo{};
    iconInfo.fIcon = TRUE;
    iconInfo.hbmColor = colorBitmap.get();
    iconInfo.hbmMask = maskBitmap.get();

    wil::unique_hicon result{ CreateIconIndirect(&iconInfo) };
    LOG_LAST_ERROR_IF_NULL(result.get());
    return result;
}

void UpdateWindowIconForActiveMetrics(HWND window)
{
    if (auto smallIcon = GetActiveAppIconHandle(true))
    {
        SendMessageW(window, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(smallIcon));
    }
    if (auto largeIcon = GetActiveAppIconHandle(false))
    {
        SendMessageW(window, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(largeIcon));
    }
}

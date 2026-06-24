// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

HANDLE GetActiveAppIconHandle(bool smallIcon);
wil::unique_hicon CreateNotificationIconHandle();
void UpdateWindowIconForActiveMetrics(HWND window);

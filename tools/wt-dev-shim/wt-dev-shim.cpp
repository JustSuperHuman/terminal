#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <string>

int __stdcall wWinMain(HINSTANCE, HINSTANCE, LPWSTR commandLineTail, int)
{
    constexpr auto targetTemplate = L"%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wtd.exe";

    const auto required = ExpandEnvironmentStringsW(targetTemplate, nullptr, 0);
    if (required == 0)
    {
        return 1;
    }

    std::wstring target(required, L'\0');
    if (ExpandEnvironmentStringsW(targetTemplate, &target[0], required) == 0)
    {
        return 1;
    }
    target.resize(wcslen(target.c_str()));

    std::wstring forwardedCommandLine{ L"wtd.exe" };
    if (commandLineTail && *commandLineTail)
    {
        forwardedCommandLine.push_back(L' ');
        forwardedCommandLine.append(commandLineTail);
    }

    STARTUPINFOW startupInfo{};
    startupInfo.cb = sizeof(startupInfo);
    GetStartupInfoW(&startupInfo);

    PROCESS_INFORMATION processInfo{};
    if (!CreateProcessW(target.c_str(),
                        &forwardedCommandLine[0],
                        nullptr,
                        nullptr,
                        FALSE,
                        0,
                        nullptr,
                        nullptr,
                        &startupInfo,
                        &processInfo))
    {
        return 1;
    }

    CloseHandle(processInfo.hThread);
    CloseHandle(processInfo.hProcess);
    return 0;
}

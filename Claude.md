# Claude Notes

## Repo

- Checkout: `F:\terminal`
- Upstream: `https://github.com/microsoft/terminal.git`
- Main solution: `OpenConsole.slnx`
- Terminal app package project: `src\cascadia\CascadiaPackage`
- Main Terminal UI library: `src\cascadia\TerminalApp`
- Tab surface files: `TabRowControl.*`, `TabHeaderControl.*`, `TerminalPage.*`, `Tab.*`, `TabManagement.cpp`

## Build And Run

- Restore submodules before building: `git submodule update --init --recursive`
- PowerShell build path:
  - `.\dep\nuget\nuget.exe restore .\dep\nuget\packages.config -PackagesDirectory .\packages`
  - `Import-Module .\tools\OpenConsole.psm1`
  - `Set-MsBuildDevEnvironment`
  - `msbuild OpenConsole.slnx /p:Platform=x64 /p:Configuration=Debug /m /v:minimal /nologo`
- Cmd build path:
  - `.\tools\razzle.cmd`
  - `bcz`
- Windows Terminal itself is packaged. Do not try to run `WindowsTerminal.exe` directly from the build output.
- Local loose-package deploy/run:
  - `Add-AppxPackage -Register .\src\cascadia\CascadiaPackage\bin\x64\Debug\AppxManifest.xml -ForceUpdateFromAnyVersion -ForceApplicationShutdown`
  - `Start-Process "shell:AppsFolder\WindowsTerminalDev_8wekyb3d8bbwe!App"`
- For local app testing, build/deploy `CascadiaPackage` from Visual Studio, use the loose manifest above, or build/deploy the generated appx recipe/MSIX per `doc\building.md`.
- Useful docs: `README.md`, `doc\building.md`, `tools\README.md`, `doc\STYLE.md`, `doc\ORGANIZATION.md`.

## Current Host State

- PowerShell 7.5.5 is installed.
- OS reports `10.0.26200.0`.
- Developer Mode is enabled (`AllowDevelopmentWithoutDevLicense = 1`).
- `.NET SDK 10.0.202` is installed.
- Visual Studio Community 2026 is installed at `C:\Program Files\Microsoft Visual Studio\18\Community`.
- `Set-MsBuildDevEnvironment` succeeds.
- Windows SDK `10.0.26100.0` is installed.
- `winget configure test --file .config\configuration.winget` hung in this session; stale `winget`/`ConfigurationRemotingServer` processes from that probe were stopped.
- Full Debug x64 solution build succeeded after restoring `dep\nuget\packages.config`.
- The dev loose package registered successfully as `WindowsTerminalDev_8wekyb3d8bbwe`.

## Prerequisites From The Repo

- Windows 10 2004 build 19041+ to run Terminal.
- Developer Mode enabled.
- PowerShell 7+.
- Windows 11 SDK `10.0.26100.8249` or greater.
- Visual Studio 2026 18.6+ with workloads/components from `.vsconfig`.
- .NET Framework 4.7.2 Targeting Pack for test projects.
- Repo-provided install config: `.config\configuration.winget`.

## UI Notes

- This is native product UI. Preserve existing WinUI controls, resource usage, keyboard/accessibility behavior, and theme-aware brushes.
- Keep tab behavior attached to the existing tab model and action dispatch. Avoid creating a parallel tab state.
- Prefer changing `TabRowControl`/`TabHeaderControl` layout before touching pane/session logic.
- Search UX should use standard XAML input affordances, live filtering, and keyboard navigation; avoid custom drawing unless necessary.
- Current vertical-tab prototype keeps the original `mux:TabView` collapsed as the behavioral backing control and renders tabs through `TabRowControl.FilteredTabs`.
- Vertical-tab selection is bridged through `TabRowControl::VerticalTabSelected` into `TerminalPage::_SetFocusedTab`; `_SetFocusedTab` and tab initialization now call `_UpdatedSelectedTab` directly because the collapsed backing `TabView` cannot be relied on to populate the center `TabContent`.
- Launch/window sizing for the rail is currently hard-coded at 240px in `TerminalWindow.cpp`; matching visual width is on `TabRowControl.xaml`.

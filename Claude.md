# Claude Notes

## Repo

- Checkout: `F:\terminal`
- Upstream: `https://github.com/microsoft/terminal.git`
- Main solution: `OpenConsole.slnx`
- Terminal app package project: `src\cascadia\CascadiaPackage`
- Main Terminal UI library: `src\cascadia\TerminalApp`
- Tab surface files: `TabRowControl.*`, `TabHeaderControl.*`, `TerminalPage.*`, `Tab.*`, `TabManagement.cpp`

## Build And Run

- One-command local update:
  - `bun run update`
  - This restores NuGet packages, builds `Terminal\CascadiaPackage` as Debug x64, registers the loose `WindowsTerminalDev` package, installs a per-user `wt.exe` shim, and launches it.
  - Re-registration removes the existing `WindowsTerminalDev` package registration first, clears the generated loose-package output directory, and preserves app data when the host supports it; this avoids the same-version dev package registration block and stale package output locks.
  - Use `bun run update -- -NoLaunch` to build/register without launching.
  - Use `bun run update -- -MakeDefault` to also set `WindowsTerminalDev` as the per-user default terminal application.
  - Use `bun run update -- -NoWtShim` to skip replacing `wt.exe` command resolution.
  - Use `bun run update -- -Pull` only when the working tree is clean and you want a `git pull --ff-only` before building.
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
- Dev package identity is `WindowsTerminalDev_8wekyb3d8bbwe`; its command alias is `wtd.exe`, not the Store package `wt.exe`.
- `bun run update` installs a user `wt.exe` shim at `%LOCALAPPDATA%\Programs\WindowsTerminalDevShim\wt.exe`, prepends that directory to the user PATH, and registers `HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\wt.exe` so normal `wt`/`wt.exe` launches prefer the dev package.
- To make this the everyday terminal, pin Windows Terminal Dev and set Windows' default terminal app to the dev package if it appears in Settings. Do not overwrite the Store package identity.
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
- The vertical rail background is driven by `TerminalPage::_updateThemeColors()` assigning `TitlebarBrush()` to `_tabRow.Background()`, so acrylic/custom tab-row themes stay on the rail even when the collapsed backing `TabView` is not in the titlebar.
- Vertical tab search tokenizes whitespace terms and searches title/profile/path metadata first, then command history/quick fixes and the last 32K chars of terminal buffer text for queries with at least two typed chars when metadata does not match.
- The collect-windows rail button routes `TabRowControl -> TerminalPage -> TerminalWindow -> AppHost`, counts live-collectable tabs through `WindowEmperor::GetWindows()`, confirms with a `ContentDialog`, then moves live tab content using the existing `_MoveContent`/`AttachContent` handoff.
- External terminal windows are discovered with `EnumWindows()` in `AppHost.cpp` and shown in the collect dialog, but they cannot be live-moved because `ControlInteractivity`/ConPTY content IDs are process-local and Windows exposes no safe handoff for already-running terminal apps, other WT packages, or elevated sessions.

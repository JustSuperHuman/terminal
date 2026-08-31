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
  - Before registering, the script stamps a unique timestamp-based version into the generated `AppxManifest.xml`; re-registering the same version can fail with 0x80073CF6/0x80070020 when Windows cannot delete the previous registration's stale AppRepository metadata directory.
  - Re-registration removes the existing `WindowsTerminalDev` package registration first, clears the generated loose-package output directory, and preserves app data when the host supports it; this avoids the same-version dev package registration block and stale package output locks.
  - Use `bun run update -- -NoLaunch` to build/register without launching.
  - Use `bun run update -- -MakeDefault` to also set `WindowsTerminalDev` as the per-user default terminal application.
  - Use `bun run update -- -NoWtShim` to skip replacing `wt.exe` command resolution.
  - Use `bun run update -- -Pull` only when the working tree is clean and you want a `git pull --ff-only` before building.
- Launch without building:
  - `bun run launch` (`tools\launch-dev-terminal.ps1`) starts the existing `WindowsTerminalDev` build; use it instead of `bun run update` when nothing needs rebuilding.
  - It runs the built exe through the `wtd.exe` execution alias in `%LOCALAPPDATA%\Microsoft\WindowsApps` — that alias is what supplies package identity — and falls back to `shell:AppsFolder\WindowsTerminalDev_8wekyb3d8bbwe!App` when the alias is missing. The dev loose layout has no `wt.exe`; `wtd.exe` is the commandline entry point.
  - Trailing args go to `wtd.exe` untouched: `bun run launch -- new-tab -d F:\terminal`.
  - `-Restart` kills running dev instances (matched by exe path, so the Store package is untouched) before launching; `-NoRegister` refuses to register instead of doing it; `-Direct` runs the loose-layout `WindowsTerminal.exe` with no package identity (debugging the launch itself only — Terminal normally fails that way).
  - The script parses those switches by hand out of `$args` instead of using `param()`. PowerShell prefix matching binds wt's own `-d <dir>` to a `-Direct` switch and silently drops the flag, and a literal `--` separator fails parameter binding outright.
  - Missing `src\cascadia\CascadiaPackage\bin\x64\Debug\WindowsTerminal.exe` is a hard error pointing at `bun run build`; a missing package registration is repaired in place (see below).
- `bun run register` (`tools\register-dev-terminal.ps1`) is the register step factored out of `update-dev-terminal.ps1`: copy `res\terminal\images-Dev` into the layout's `Images`, stamp a unique version into `AppxManifest.xml`, `Add-AppxPackage -Register`. Both `bun run update` and `bun run launch` call it, so the version-stamp and image-copy rationale lives in one place.
  - Building `Terminal\CascadiaPackage` rewrites the generated `AppxManifest.xml` back to source version `0.0.1.0`, which drops the existing loose-package registration — after a plain `bun run build` the app cannot launch until it is registered again. `bun run launch` detects the missing registration and re-registers the layout on disk rather than forcing a full rebuild.
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
- `_UpdateTabView()` ignores fullscreen (and the `showTabsFullscreen` setting): the vertical rail is the only tab surface, so it stays visible in fullscreen and focus mode is the chrome-free view. When hidden, the whole `VerticalTabPane` (rail + resize handle) collapses — collapsing only `TabRow` leaves an empty fixed-width strip — and the project strip collapses in focus mode only.

## Terminal-Web Bridge

- Every native ConPTY session mirrors into the `tools/terminal-web` server via the in-proc WinHTTP WebSocket client `src/cascadia/TerminalConnection/TerminalBridge.{h,cpp}` (default `127.0.0.1:10001`; `WT_BRIDGE_SERVER=off` disables, or set it to another `http://host:port`).
- While sessions exist and the server is unreachable, `TerminalBridge::_ensureServerRunning()` spawns `cmd /c "bun install && bun run dev"` in the terminal-web package (root from `TERMINAL_WEB_ROOT` or walk-up from the exe); the `bun install` self-heals missing/stale node_modules — a missing `tsx` used to make `bun run dev` exit 1 silently forever ("Bridge: offline" with no trace). Child stdout/stderr land in `tools/terminal-web/.terminal-web-server.log` (truncated past 4MB, spawn banners timestamped). A named mutex makes one WT process the spawner with a 15s respawn throttle; non-owners retry acquisition every pass and never hold a handle, so the spawner role fails over when the owning WT exits.
- The server records where it actually listens in `tools/terminal-web/.terminal-web-server.json` (pid/host/port, removed on clean exit); `TerminalBridge::_connectAny()` tries last-good port, then the default, then the recorded port, so a drifted port (default taken by a foreign process) doesn't read as offline. `GET /api/health` returns `{ok, pid, port, startedAt, sessions}`.
- `ConptyConnection` exposes statics `BridgeConnectionStatus()/BridgeEndpoint()/BridgeAccessToken()`; `TerminalPage` polls the status every 2s (`_bridgeStatusTimer`) and appends `• Bridge: connected/offline` to the window title — or `Bridge: server error (see .terminal-web-server.log)` when the spawn owner has watched its server child die quickly ≥3 times (status string `"failing"`, `TerminalBridge::Status::ServerFailing`). The new-tab dropdown has a "Copy Connection Token" item (reads `tools/terminal-web/.terminal-web-token` or `TERMINAL_WEB_ACCESS_TOKEN`).
- terminal-web deps are installed with bun (`bun.lock`); `bun run dev` = `tsx server/index.ts`.
- Task-finish notifications: `server/notifications.ts` scans every session's output with a per-session VT state machine — bare BEL (not OSC terminators), OSC 9, and OSC 777;notify become `{type:"notify", sessionId, sessionTitle, title, body, sound, origin, id, at}` broadcasts, throttled to one per session per 4s. `POST /api/notify` still works for hooks and now takes `sessionId` (pass `%WT_SESSION%` to attribute the tab). Everything is recorded in a 200-deep ring served by `GET /api/notifications?since=<epoch-ms>` so reconnecting clients (mobile resume) catch up on missed signals.
- Image paste for remote agents: `POST /api/sessions/:id/attachments` (raw body ≤32MB, `?filename=` hint, `?paste=1`) saves to `%TEMP%\terminal-web-attachments` (pruned after 24h) and with `paste=1` bracket-pastes the saved path (+trailing space) into the session — Claude Code and Codex both turn a pasted image path into an attached image; raw bytes can't cross a PTY.
- just-terminal mobile (Expo SDK 56 — check versioned docs per its AGENTS.md): CommandBar has an attach-image control (tap = photo library via expo-image-picker, long-press = clipboard image via expo-clipboard → staged through react-native-fs) uploading with `paste=1`; `notify` handling plays the tone, bumps that session's unread badge, and shows a tap-to-jump `NotificationToast`; on socket reopen/app resume it replays missed notifications from `/api/notifications`. expo-image-picker + expo-clipboard are new native modules — the dev client needs an EAS rebuild before they work.
- just-terminal composer (`src/components/Composer.tsx`, `src/useInputContext.ts`, `src/lib/composerApi.ts`): the default way to type on mobile. A local multi-line field sends whole messages through `/compose` (socket fallback if REST fails), with `/` slash-command and `@` file pickers floating above the bar, prompt history and per-session drafts (AsyncStorage), one-tap replies for a detected menu, and dictation landing in the field to be edited instead of straight in the terminal. Tapping a no-argument command runs it; one with an `argument-hint` keeps the keyboard. The `⌨` key toggles back to direct typing — the two modes must never both hold focus, so `keepKeyboardOpen` (TerminalView's `setKeepFocus`) is off whenever the composer is up, and the composer's own field is what keeps the soft keyboard raised. The completion panel is `position:absolute; bottom:"100%"` so opening it never reflows the terminal — that requires no `overflow:hidden` on any ancestor.
- Agent recognition is pushed with the session summary itself (`agent`, `agentSource`, `agentActivity`), so every client shows what is running in a terminal and what it is doing without a second call. `TerminalPromptMonitor` computes it from the same 180ms-settle render pass that finds questions (`onObservation`), plus a 4s `sweep()` over quiet running sessions from `startAgentSweepLoop()` — a terminal already sitting at a prompt when the host starts must not wait for its next byte. Precedence in `terminalAgentSummaryMetadata`: OSC handshake > `screen` fingerprint > launch `command`/`profile`; screen outranks the launch command because a `pwsh` tab that later ran `claude` is an agent terminal and a `claude` tab that exited back to its shell is not.
- The rich ACP view is one explicit tap from any detected agent terminal, never automatic: `GET /api/sessions/:id/agent[?prepare=1]` reports the agent plus ranked attach candidates (`server/agent-links.ts` matches that agent's own `session/list` history against the terminal's cwd — exact directory first, then recency, then parent/child directories), `POST /api/sessions/:id/agent/attach` loads a candidate's typed history (or starts a fresh conversation), `DELETE` unlinks (`?close=1` also ends it). `prepare=1` starts the adapter — a stopped adapter lists no conversations and reads as "you have never worked here" — so only the opening tap sends it, never background polling. Links live in `AgentLinkRegistry` and surface as `acpSessionId` on the terminal summary; ACP still cannot attach to the TUI process that owns the live conversation, so the terminal keeps running alongside.
- Agent-aware composed input (for driving Claude Code / Codex from a phone). The host answers three questions about any session from its already-rendered headless screen — no probing: `GET /api/sessions/:id/input-context` (`server/session-input.ts`: which agent is listening, whether it is mid-turn, the VT modes, and any menu it is blocking on), `GET /api/sessions/:id/commands` (`server/slash-commands.ts`: the agent's built-ins plus `.claude/commands` / `~/.claude/commands` / `~/.codex/prompts`, frontmatter descriptions included) and `GET /api/sessions/:id/files?q=` (`server/file-search.ts`: fuzzy lookup under the cwd, `git ls-files` fast path, bounded walk otherwise). `POST /api/sessions/:id/compose {text,submit,mode}` delivers a whole message: bracketed paste when the program takes one, paced chunks, then Enter after a settle delay. Heuristics are pinned by `bun run smoke:session-input` (fixture screens + a live-host sweep).
  - Agent detection scores screen fingerprints (Claude's `shift+tab to cycle` footer, Codex's `› ` prompt and model line) above the launch command, because an agent that exited back to its shell must stop being treated as an agent. `shell` is the whole command line for bridged sessions, so the executable is parsed out with the quotes/args stripped.
  - `pasteSafe` ≠ `bracketedPaste`: a bridged session's mirror starts empty when the host restarts, so an agent that enabled DECSET 2004 minutes ago reads as off. A confident claude/codex detection implies paste support — getting this wrong submits a multi-line prompt one line at a time.
  - A menu only becomes one-tap replies when an entry carries a selection caret (`❯ 1. Yes`). Without that rule any agent answer ending in a numbered list would offer bogus replies.
- The old anonymous-namespace `npm run bridge` commandline wrapper in `TerminalPage.cpp` was removed — do not reintroduce it; it double-registered every tab.
- terminal-web projects combine saved launch shortcuts (`server/projects.ts`, `.terminal-web-projects.json`, `GET/POST /api/projects`, `GET /api/projects/recent`, `PATCH /api/projects/order`, `DELETE /api/projects/:id`) with ephemeral projects discovered from every running session's live cwd. Only directories used by a running terminal appear in the project strip, so the tab disappears when the last terminal there closes; saved paths remain available through recents and creating/reopening one immediately launches a terminal there. OSC 7 and OSC 9;9 updates move sessions between projects automatically; names prefer `project.json`, then remembered/git metadata, then a cleaned directory name. Horizontal tabs in the web UI set the starting directory for new sessions, filter the session list, and kill their sessions on confirmed close. Web sidebar and mobile drawer group sessions under project headers.
- Mirror semantics: the session list mirrors live terminal tabs. No default managed session is seeded at startup; exited sessions (bridged and managed) are pruned 30s after exit (grace period lets a restarting terminal re-register under the same session id). The bridge protocol has `title` and `project` client messages: native pushes tab-title changes (`ConptyConnection::UpdateBridgeTitle` from `TerminalPage::_UpdateTitle`) and project assignment (`SetBridgeProject`, merged into the register payload when set pre-registration).
- Web-created desktop sessions run the requested shell directly via `wt -w 0 new-tab` (new tab in the existing window; new window only if none is running; falls back to `wt.exe` on PATH when no host process is found). The old powershell+`npm run bridge` wrapper is gone — do not reintroduce it.
- The native desktop terminal has the same horizontal project tabs (strip above `TabContent`, built in code by `TerminalPage::_RebuildProjectTabs`): polled from `GET /api/projects` every ~2s via WinHTTP on a background thread, selecting a project with no local tab opens one at the project cwd, active project overrides the starting directory in `_CreateConnectionFromSettings`, tabs remap `Tab.ProjectId` from their active pane's live cwd and the rail filters through `TabRowControl::SetProjectFilter`, and closing a project shows a ContentDialog then closes its tabs (skipConfirmClose) and DELETEs the server project.
- Tab search stability: `Tab::GetFocusedProfile` is null-guarded (teardown race), `_updateFilteredTabs` suppresses ListView SelectionChanged reentrancy with a depth counter, and the buffer-text search pass is debounced 250ms behind cheap metadata filtering (`_bufferSearchTimer`). These fixed intermittent crashes when searching while tabs closed/changed focus.
- Orchestrator: a server-managed agent session (Claude Code or Codex TUI, `server/orchestrator.ts`) with cross-session tools via a dependency-free stdio MCP sidecar (`server/orchestrator-mcp.ts`: list/read sessions, send_input/send_keys, create/close/rename, list_projects, notify_user — read_session returns TUI-resolved plain text from the headless buffer via `server/terminal-text.ts` + `GET /api/sessions/:id/text?tail=`). Claude launches with `--mcp-config` (generated `.terminal-web-orchestrator.mcp.json`, gitignored) + `--append-system-prompt`; codex gets `-c mcp_servers.*` TOML overrides. Session summaries carry `kind:"orchestrator"` — hidden from the web session list/targets and excluded from project reconciliation. REST: `GET /api/orchestrator`, `POST /api/orchestrator/start {agent,restart?}`, `POST /api/orchestrator/stop`, plus `GET /api/sessions`; `POST /api/sessions` accepts `mode:"managed"` to force web-only sessions. `/ws` subscriptions are slot-scoped (`subscribe {slot}`, `unsubscribe`) so one client can stream the main terminal and the orchestrator panel at once.
- Web orchestrator panel (`src/components/OrchestratorPanel.tsx`): collapsible/resizable right sidebar — collapsed rail with status dot + activity pulse on desktop, overlay on mobile; agent picker + start hero when stopped, TerminalSurface (slot `orchestrator`) + quick-prompt chips when running; width/open/agent persisted in localStorage.
- Native orchestrator panel: `TerminalConnection::WebSessionConnection` (WinHTTP WS client modeled on TerminalBridge, subscribes to the session over `/ws`, replays snapshot after `ESC c`) feeds a TermControl in a collapsible right pane on `TerminalPage` (XAML `OrchestratorPane`, robot-glyph toggle in the project strip); status polls piggyback the 2s `_bridgeStatusTimer`, start/stop/restart POST through `_projectServerRequest`. Desktop, web, and mobile all attach to the SAME server-side orchestrator session.

# JustTerminal mobile companion

An Expo app for controlling your desktop terminals from Android or iOS.

- Sessions grouped by project, with stable ordering while output streams.
- Automatic reconnect after network interruptions or returning to the app.
- Separate **Send** (submit a draft) and **Enter** (press the terminal key), plus **Alt+↑**, arrows, and control keys.
- **Hide / Show keyboard** controls and per-session drafts.
- New sessions use the last selected session's working directory.
- A pinned **Orchestrator** opens the same conversation used on desktop and web.
- Terminal Assist question cards for supported Claude Code and Codex prompts.

## Connect

Run the [JustTerminal desktop app](https://github.com/JustSuperHuman/terminal/releases/latest). Enter the PC's reachable host address and access token in the companion. Keep the PC running and reachable over your LAN or private network.

The host normally uses port `10001`. Open `http://localhost:10001` on the PC to find its network addresses; it chooses another port if needed. For the Android emulator, use `10.0.2.2:10001`.

Configure your model provider in the desktop/web orchestrator settings. The phone shares its transcript, send, and stop controls. The optional ACP Agent Workspace requires a host that advertises ACP support; the native desktop host uses Terminal Assist for existing terminal sessions.

## Develop

This app uses Expo SDK 56 and custom native modules, so use a development build rather than Expo Go.

```powershell
cd tools/just-terminal
bun install
bunx expo run:android
```

For an already installed development build:

```powershell
bunx expo start --dev-client
```

An iOS native build requires macOS or EAS. The repository's `bun run build:internal` script starts the configured internal iOS EAS build; it requires access to that Expo project and signing credentials. Mobile binaries are released separately from the Windows ZIP.

## Check changes

```powershell
bun run typecheck
bun run smoke:mobile-reliability
bun run smoke:mobile-orchestrator
bun run smoke:terminal-html
```

The terminal WebView uses Ghostty's WASM renderer. The final smoke check needs Chrome or Edge installed.

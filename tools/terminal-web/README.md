# Terminal Web Host

A local, browser-hosted terminal switchboard for Windows Terminal and TUI workflows.

The server owns terminal sessions through ConPTY via `node-pty`. This is intentional:
focus and keyboard emulation against existing windows is fragile, loses terminal state,
and breaks when a TUI redraws, focus changes, or Windows blocks injected input. Owned
pseudo-terminal sessions give the web UI stable input, resize, ANSI output, replay, and
session lifecycle control.

## Run

```powershell
bun install
bun run bridge
```

From the repo root, `bun run bridge` starts the terminal-web host. The app binds
to `0.0.0.0` on the first available port starting at `10001` by default.
Each additional app instance binds to the next free port. Running instances scan
`127.0.0.1:10001` and upward, then show reachable terminal-web peers in the
sidebar. Peer sessions can be selected from the sidebar and are proxied through
the active web host, so switching between hosted instances stays in one browser
surface.

```powershell
bun run bridge -- --port 10005
bun run bridge -- --host 127.0.0.1
```

Run it only on trusted networks or override the host back to `127.0.0.1`. The
web UI can send input to local shells. When bound to all interfaces, remote API
and WebSocket clients require an access token by default, while loopback clients
stay open for local tools, peer discovery, and bridge commands. The sidebar
shows copyable tokenized network URLs for the active host. If no token is
configured, the generated network token is saved in `.terminal-web-token` so
mobile clients keep working after host restarts.

Set a stable token with:

```powershell
$env:TERMINAL_WEB_ACCESS_TOKEN="change-me"
```

For a fully trusted isolated network, token auth can be disabled with:

```powershell
$env:TERMINAL_WEB_AUTH="off"
```

## Bridge An External Terminal

Run the bridge from any terminal to expose a command from that terminal's
environment to the web host:

```powershell
npm run bridge -- --server http://127.0.0.1:10001 --title Worktree -- pwsh -NoLogo
npm run bridge -- --server http://127.0.0.1:10001 --title Codex -- codex
npm run bridge -- --server http://127.0.0.1:10001 --title Claude -- claude
```

The bridge owns a child PTY, mirrors output locally, and registers the session
with the web UI. Browser input and local terminal input both flow to that child
PTY. Use `--no-mirror` for automation or tests where local echo is noisy.
If the web host restarts or the bridge WebSocket drops, the bridge keeps the
child PTY running, reconnects with the same session id, and replays a bounded
ANSI buffer so the UI can recover recent terminal state.

## Windows Terminal Dev Auto-Bridge

The local WindowsTerminalDev build mirrors every ConPTY session into this
server with an in-process WebSocket client (no sidecar process; see
`src/cascadia/TerminalConnection/TerminalBridge.*`). New tabs opened in that
dev host appear as bridged sessions in the web UI and can be viewed and
controlled remotely. Tabs opened in a different Windows Terminal install
cannot be attached retroactively.

While the dev host has sessions open it also keeps this server alive: if
`127.0.0.1:10001` stops answering, the terminal spawns `bun run dev` from this
package (found via `TERMINAL_WEB_ROOT` or by walking up from
`WindowsTerminal.exe`) and keeps retrying with backoff. The window title bar
shows the live bridge state (`Bridge: connected` / `Bridge: offline`), and the
new-tab dropdown has a "Copy Connection Token" item that copies
`.terminal-web-token` (or `TERMINAL_WEB_ACCESS_TOKEN`) for remote clients.

Set `WT_BRIDGE_SERVER` to point the dev host at another server (or to `off` to
disable mirroring entirely).

## Input Model

Click the terminal surface for full interactive keyboard input. The bottom
composer sends line input, bracketed paste blocks, and common TUI control keys
such as Escape, Tab, arrows, Ctrl+C, Ctrl+D, and Ctrl+L. This keeps Codex,
Claude, editors, and other TUIs on the PTY path instead of relying on OS window
focus or synthetic keystrokes.

## Export Saved Output

Use the header download action to save the active terminal's retained ANSI
transcript. The API also exposes:

```text
/api/sessions/:id/export?format=ansi
/api/sessions/:id/export?format=screen
/api/sessions/:id/export?format=json
```

Peer session exports route through the active host at
`/api/peers/:port/sessions/:id/export`, so browsers connected from another
machine do not need direct access to the peer host's loopback address.

Limit peer scanning with:

```powershell
$env:TERMINAL_WEB_DISCOVERY_PORTS=50
```

Tune the refresh interval with:

```powershell
$env:TERMINAL_WEB_DISCOVERY_INTERVAL_MS=15000
```

Terminal output is coalesced before browser broadcast to keep noisy PTY streams
stable without losing transcript fidelity. Tune the browser flush cadence with:

```powershell
$env:TERMINAL_WEB_OUTPUT_FLUSH_MS=33
```

Browser and bridge WebSocket clients use a heartbeat so broken connections are
closed promptly and can reconnect. Tune the heartbeat interval with:

```powershell
$env:TERMINAL_WEB_WS_HEARTBEAT_MS=5000
```

## Build

```powershell
npm run build
npm run start
```

## Scope

- Managed sessions are fully interactive.
- External terminals can opt in through `npm run bridge -- -- <command>`, which
  exposes a command as a bridged, switchable terminal session.
- Other terminal-web instances on the host are discovered as peer hosts and
  proxied as switchable terminal targets.
- Managed, bridged, and peer sessions can be renamed from the sidebar.
- `codex` and `claude` are detected from `PATH` and shown as agent launch
  profiles when available.
- External host terminal and shell processes are discovered and shown with
  managed-session and bridge-copy actions when the process can be matched.
- Existing external Windows Terminal tabs cannot be safely attached to after the fact
  because Windows does not expose their ConPTY streams.

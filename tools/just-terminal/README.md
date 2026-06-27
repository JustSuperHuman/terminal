# JustTerminal

A React Native (Expo SDK 56) mobile client for the **Terminal Web Host**
(`tools/terminal-web`). It connects to a running host over its WebSocket
protocol and gives you a clean, phone-first terminal: live ANSI output, a
control-key composer, and a streamlined session switcher.

It deliberately drops the web sidebar's host-process list, peer hosts, bridge
command helpers, and access-URL panel — the mobile drawer is just **sessions**
and **launch profiles**.

## What it does

- Connect to any reachable host by address (`192.168.1.50:10001`), with an
  optional access token. Recent servers are remembered.
- Render terminals with the real xterm.js engine inside a WebView, themed to
  match the web client exactly.
- Type via the composer (Line / Paste modes, history) and a control-key row
  (Esc, Tab, arrows, Ctrl+C/D/L). Tap the terminal or the ⌨ button to type
  directly with the soft keyboard.
- Switch, create, rename, and stop sessions from the drawer.
- Quick-launch agents with bypass flags when the host has them on `PATH`:
  `codex --yolo` and `claude --dangerously-skip-permissions`.

## Run

```powershell
# 1. Start a Terminal Web Host (separate terminal)
cd ..\terminal-web
npm install
npm run dev            # binds 127.0.0.1:10001

# 2. Start JustTerminal
cd ..\just-terminal
npm install
npx expo start
```

Open the app in **Expo Go** (Android/iOS) or a dev build, then enter the host
address.

### Connecting from an Android emulator

The emulator reaches the host's loopback at `10.0.2.2`. Use
`10.0.2.2:10001` (the connect screen has a one-tap chip for this). Because that
traffic arrives at the host as loopback, no token is required.

### Connecting from a physical phone (same LAN)

Start the host bound to the network and copy its token from the web sidebar:

```powershell
npm run dev -- --host 0.0.0.0
```

Then enter the host's LAN address and the token in the connect screen.

## How it talks to the host

The native side owns one reconnecting WebSocket to `/ws` and speaks the same
JSON protocol as the web client (`subscribe`, `input`, `resize`, `create`,
`rename`, `kill`; receives `hello`, `sessions`, `session`, `snapshot`,
`output`, `exit`). Session creation uses `POST /api/sessions` so custom
`shell`/`args` (the quick-launch flags) are honored and the new session id is
returned for auto-selection.

Terminal rendering happens in a WebView that hosts xterm.js. The native side
forwards `snapshot`/`output` into the page via `injectJavaScript`, and the page
posts keystrokes/resize back via `window.ReactNativeWebView.postMessage`.

## Layout

```
App.tsx                     connection state, connect vs terminal screen
src/TerminalScreen.tsx      session state, header + terminal + composer + drawer
src/terminalHtml.ts         xterm.js WebView page + RN bridge
src/lib/socket.ts           reconnecting WebSocket client (configurable endpoint)
src/lib/endpoint.ts         address -> http/ws URLs + token
src/lib/api.ts              REST: create session, reachability probe
src/lib/storage.ts          remembered servers (AsyncStorage)
src/components/             ConnectScreen, Header, TerminalView, CommandBar, SessionsDrawer
src/theme.ts                palette ported from the web client's oklch tokens
```

# Terminal Companion

A React Native (Expo SDK 56) mobile client for the **Terminal Web Host**
(`tools/terminal-web`). It connects to a running host over its WebSocket
protocol and gives you a phone-first companion to Windows Terminal: live ANSI
output, a control-key composer, and a streamlined session switcher — styled
after WinUI 3 / Windows Terminal itself (Mica-grey Fluent dark chrome, the
Windows accent, Selawik for UI text, Cascadia Mono in the terminal, and the
Campbell color scheme).

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
- Answer Claude Code and Codex questions as native option cards. This works for
  structured ACP Agent Workspace requests and for ordinary direct/bro-launched
  terminal sessions through Terminal Assist; a live question hides the normal
  text keyboard, validates that it is still current, and sends the exact TUI
  interaction when an option is tapped.
- Paste an image from the phone clipboard, or choose one from Photos, into the
  active terminal prompt.
- Switch, create, rename, and stop sessions from the drawer.
- Launch the desktop's visible Windows Terminal profiles. The host monitors its
  `settings.json`, so profile additions, removals, renames, and hidden-state
  changes appear on connected phones without restarting the app.

## Run

```powershell
# 1. Start a Terminal Web Host (separate terminal)
cd ..\terminal-web
npm install
npm run dev            # binds 127.0.0.1:10001

# 2. Start Terminal Companion
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
`profiles`, `output`, `exit`). Session creation uses `POST /api/sessions`; a
profile launch carries its live profile id so Windows Terminal opens that exact
configured profile and the new session id is returned for auto-selection.

Terminal rendering happens in a WebView that hosts xterm.js. The native side
forwards `snapshot`/`output` into the page via `injectJavaScript`, and the page
posts keystrokes/resize back via `window.ReactNativeWebView.postMessage`.

The separate Agent Workspace is the full ACP surface. Existing terminal TUIs
cannot be converted into ACP sessions after launch; they appear in the same
session list with a Claude/Codex identity and use Terminal Assist instead, so
the question-and-answer UX stays consistent without pretending the underlying
protocol is attached.

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
src/theme.ts                WinUI 3 dark design tokens (Mica ramp, Fluent hues)
```

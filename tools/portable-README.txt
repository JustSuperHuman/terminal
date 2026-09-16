JustTerminal for Windows
========================

1. Extract the entire ZIP into a writable folder.
2. Open WindowsTerminal.exe.

Windows 10 version 2004 (build 19041) or newer is required. This is an
independent Windows Terminal fork, not an official Microsoft release.

The .portable marker keeps Terminal settings beside the app. The native
bridge and web interface are built into TerminalConnection.dll; no Bun,
Node, source checkout, or separate server is needed to run this download.

Use the terminal's connection menu to open the web interface or connect
the mobile companion. Remote clients need the host's access token. The
bridge uses port 10001 by default and can choose another available port.

Orchestrator shares one conversation across desktop, web, and mobile.
Configure its model and provider key in the desktop/web Orchestrator
settings. Provider usage may incur charges from your chosen provider.

Bridge settings and history are in %LOCALAPPDATA%\TerminalWeb. The mobile
companion source is included in the repository; it is not part of this ZIP.

Source and updates: https://github.com/JustSuperHuman/terminal
License: MIT. See LICENSE and NOTICE.md for attribution.

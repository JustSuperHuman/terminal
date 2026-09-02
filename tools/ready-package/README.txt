WindowsTerminalReady
====================

Run Install.ps1 in PowerShell and approve the one administrator prompt. It
trusts the included package-specific certificate for this machine, installs
WindowsTerminalDev, allows its authenticated web/mobile ports through Windows
Firewall, and launches it.

If this checkout's loose Debug package is registered, the installer preserves
its application data, unregisters that loose package, and installs the MSIX.

The terminal-web bridge and production web UI are embedded in
TerminalConnection.dll. They start automatically when the first terminal
session opens; Bun, Node, loose web files, this source repository, and a
separate bridge command are not required. The local UI is available at:

    http://127.0.0.1:10001

The host listens on all interfaces by default. Loopback stays open; network
clients use the generated access token available from the terminal's connection
menu. Runtime state and logs are stored in:

    %LOCALAPPDATA%\TerminalWeb

The HTTP/WebSocket host and terminal transport run inside TerminalConnection.dll
and do not launch a relay process. Claude Code or Codex must still be installed
to use those agents.

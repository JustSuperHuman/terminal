# Built-in terminal bridge

This crate is linked into `TerminalConnection.dll` as a Rust static library. It
owns the terminal session registry, bounded VT-safe replay, HTTP/WebSocket API,
static web client, authentication, and the compatibility `/bridge` endpoint.
There is no runtime Node, Bun, `node-pty`, or terminal-web relay process.

The first Terminal process claims a per-user Windows mutex and becomes the
host. Other Terminal processes connect directly to its Rust `/bridge` endpoint,
so every window remains visible through one web/mobile endpoint. If the owner
exits, a remaining process claims ownership and restores its sessions from its
bounded local replay.

The native boundary is the stable C ABI in `TerminalBridgeRust.h`. C++ retains
only weak WinRT session references and translates Rust input/resize/kill
callbacks to `ITerminalConnection` calls.

Replay is kept as complete UTF-8 chunks and is trimmed only at known VT ground
boundaries. The private `OSC 1337;TerminalWeb.Agent=...` integration envelope is
parsed with state preserved across arbitrary reads and removed from client
output. Malformed oversized OSC frames are discarded instead of leaking their
payload as console text; ordinary terminal control sequences are preserved.

Run the focused checks from this directory:

```powershell
cargo test -- --test-threads=1
cargo clippy --all-targets -- -D warnings
```

The native project invokes the matching Rust target automatically before link.
For an x64 debug build from the repository root:

```powershell
Import-Module .\tools\OpenConsole.psm1 -Force
Set-MsBuildDevEnvironment
msbuild .\OpenConsole.slnx /t:Terminal\TerminalConnection /p:Platform=x64 /p:Configuration=Debug /m
```

ACP is a separate optional adapter, not terminal transport; the Rust bridge
advertises it as unavailable instead of starting the former JavaScript host
implicitly.

The orchestrator (`src/orchestrator/`) is built in: a chat agent over every
session that talks to an OpenAI-compatible endpoint (OpenRouter by default,
`OPENROUTER_API_KEY` from the environment or a key entered in the panel) and
drives tabs through in-process tools. `cargo test live_orchestrator --
--ignored --nocapture` runs one real turn against the configured endpoint.

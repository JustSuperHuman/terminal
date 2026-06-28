#!/usr/bin/env bash
#
# Regenerate the vendored coder/ghostty-web@main artifacts used by the mobile
# terminal WebView (src/vendor/ghosttyWebBundle.ts + src/vendor/ghosttyWasm.ts).
#
# We pin to the upstream `main` branch (not the npm release): the JS library is
# bundled into a single classic-script IIFE with Bun, and ghostty-vt.wasm is
# compiled from the Ghostty submodule with Zig. Both are inlined as base64 so the
# React Native WebView can load them with no file origin (the WASM is fetched
# from a data: URL via Ghostty.load(url)).
#
# Requirements: bun, git, and Zig 0.15.2+. NOTE: building the WASM on Windows
# fails (a transitive Unicode-table generator exe cannot be spawned — Defender);
# build under Linux/WSL. The repo's own CI builds on Linux for the same reason.
#
# Usage:  bash scripts/build-ghostty-web.sh
set -euo pipefail

REPO="https://github.com/coder/ghostty-web.git"
REF="main"
ZIG_VER="${ZIG_VER:-0.15.2}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/src/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Cloning $REPO@$REF (with Ghostty submodule)"
git clone --depth 1 --branch "$REF" "$REPO" "$WORK/ghostty-web"
cd "$WORK/ghostty-web"
git submodule update --init --depth 1 --recursive

echo "==> Ensuring Zig $ZIG_VER"
if command -v zig >/dev/null 2>&1; then
  ZIG="$(command -v zig)"
else
  UNAME="$(uname -s)"
  case "$UNAME" in
    Linux*)  TARBALL="zig-x86_64-linux-${ZIG_VER}.tar.xz" ;;
    Darwin*) TARBALL="zig-$(uname -m)-macos-${ZIG_VER}.tar.xz" ;;
    *) echo "Unsupported OS for auto Zig install: $UNAME (build WASM on Linux/WSL)"; exit 1 ;;
  esac
  curl -fsSL -o "$WORK/zig.tar.xz" "https://ziglang.org/download/${ZIG_VER}/${TARBALL}"
  mkdir -p "$WORK/zig" && tar -xf "$WORK/zig.tar.xz" -C "$WORK/zig" --strip-components=1
  ZIG="$WORK/zig/zig"
fi
"$ZIG" version

echo "==> Building ghostty-vt.wasm"
( cd ghostty && git apply ../patches/ghostty-wasm-api.patch )
( cd ghostty && "$ZIG" build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall )
cp ghostty/zig-out/bin/ghostty-vt.wasm ./ghostty-vt.wasm

echo "==> Bundling JS library (IIFE, classic-script safe)"
bun install
cat > gw-entry.ts <<'EOF'
import { init, Terminal, Ghostty } from "./lib/index";
import { FitAddon } from "./lib/addons/fit";
(globalThis as any).GhosttyWeb = { init, Terminal, Ghostty, FitAddon };
EOF
bun build ./gw-entry.ts --target browser --format iife --minify \
  --external fs/promises --external fs --external path --external url \
  --outfile ghostty-web.iife.js
# import.meta.url is dead code here (we always pass an explicit wasm URL) but it
# is a parse error in a classic <script>, so neutralize it.
sed -i 's/import\.meta\.url/"file:\/\/\/ghostty"/g' ghostty-web.iife.js

echo "==> Emitting vendored base64 TS modules"
mkdir -p "$VENDOR"
VENDOR="$VENDOR" node -e '
const fs = require("fs");
const dir = process.env.VENDOR;
const wasm = fs.readFileSync("ghostty-vt.wasm");
const js = fs.readFileSync("ghostty-web.iife.js", "utf8");
fs.writeFileSync(dir + "/ghosttyWasm.ts",
  "// AUTO-GENERATED ghostty-vt.wasm from coder/ghostty-web@main (build-ghostty-web.sh). Do not edit.\n" +
  "export const GHOSTTY_VT_WASM_B64 = \"" + wasm.toString("base64") + "\";\n");
fs.writeFileSync(dir + "/ghosttyWebBundle.ts",
  "// AUTO-GENERATED IIFE bundle of coder/ghostty-web@main lib (import.meta neutralized). Do not edit.\n" +
  "export const GHOSTTY_WEB_JS_B64 = \"" + Buffer.from(js, "utf8").toString("base64") + "\";\n");
console.log("wrote " + dir + "/ghosttyWasm.ts and ghosttyWebBundle.ts");
'
echo "==> Done. Run: bun run typecheck && bun run smoke:terminal-html"

// Headless smoke test for the WebView terminal page (terminalHtml.ts), which now
// runs coder/ghostty-web (Ghostty's VT parser compiled to WASM) instead of
// xterm.js. We drive it in real Chromium via CDP — the same engine the React
// Native WebView uses — to prove the page boots the WASM engine, reports a
// readable fit size, scrolls scrollback, and mirrors bridged sessions without
// forwarding a resize.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_HTML } from "../src/terminalHtml.ts";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  throw new Error("Chrome or Edge was not found. Set CHROME_PATH to run this smoke test.");
}

const debugPort = Number(process.env.TERMINAL_HTML_SMOKE_CDP_PORT ?? 9232);
const userDataDir = mkdtempSync(join(tmpdir(), "terminal-html-smoke-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }
  return response.json();
}

async function waitFor(fn, timeout = 15000, interval = 150) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
      last = value;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`waitFor timed out: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message}: ${JSON.stringify(message.error.data ?? "")}`));
        } else {
          pending.resolve(message.result);
        }
      }
    });
  }

  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // best effort
    }
  }
}

async function evalValue(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

async function host(cdp, message) {
  await evalValue(cdp, `window.onHostMessage(${JSON.stringify(JSON.stringify(message))}); true`);
  await sleep(140);
}

async function state(cdp) {
  return evalValue(cdp, `(() => {
    const root = document.getElementById("root");
    const canvas = root ? root.querySelector("canvas") : null;
    const term = window.__term;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left), top: Math.round(r.top),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
        width: Math.round(r.width), height: Math.round(r.height),
      };
    };
    let viewportY = null, scrollback = null, alt = null, mouse = null;
    try { viewportY = term && term.getViewportY ? term.getViewportY() : null; } catch (e) {}
    try { scrollback = term && term.getScrollbackLength ? term.getScrollbackLength() : null; } catch (e) {}
    try { alt = term && term.wasmTerm ? term.wasmTerm.isAlternateScreen() : null; } catch (e) {}
    try { mouse = term && term.wasmTerm ? term.wasmTerm.hasMouseTracking() : null; } catch (e) {}
    return {
      root: rect(root),
      canvas: rect(canvas),
      hasCanvas: Boolean(canvas),
      cols: term ? term.cols : null,
      rows: term ? term.rows : null,
      viewportY, scrollback, alt, mouse,
      canvasTransform: canvas ? canvas.style.transform : null,
      messages: (window.__rnMessages || []).slice(),
    };
  })()`);
}

function latestMessage(messages, type) {
  return [...messages].reverse().find((message) => message.type === type);
}

function parseScale(transform) {
  if (!transform) return 1;
  const m = /scale\(([\-0-9.]+)\)/.exec(transform);
  return m ? Number(m[1]) : 1;
}

function parseTranslateX(transform) {
  if (!transform) return 0;
  const m = /translate\(([\-0-9.]+)px/.exec(transform);
  return m ? Number(m[1]) : 0;
}

function parseTranslateY(transform) {
  if (!transform) return 0;
  const m = /translate\([^,]+,\s*([\-0-9.]+)px/.exec(transform);
  return m ? Number(m[1]) : 0;
}

async function twoFingerGesture(cdp, p0a, p1a, p0b, p1b) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...p0a, id: 1 }, { ...p1a, id: 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p0b, id: 1 }, { ...p1b, id: 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Count non-background ("ink") pixels in a vertical band of the canvas. Robust to
// glyph whitespace, unlike sampling a single pixel. Background is #05070a.
async function bandInk(cdp, y0Frac, y1Frac) {
  return evalValue(
    cdp,
    `(() => {
      const c = document.querySelector("#root canvas");
      if (!c) return -1;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const a = Math.floor(c.height * ${y0Frac});
      const b = Math.floor(c.height * ${y1Frac});
      let ink = 0;
      for (let y = a; y < b; y += 2) {
        const row = ctx.getImageData(0, y, c.width, 1).data;
        for (let i = 0; i < row.length; i += 4) {
          if (row[i] > 40 || row[i + 1] > 40 || row[i + 2] > 40) ink++;
        }
      }
      return ink;
    })()`
  );
}

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--ignore-certificate-errors",
    "about:blank",
  ],
  { stdio: "ignore" }
);

let cdp;
try {
  await waitFor(() => getJson(`http://127.0.0.1:${debugPort}/json/version`), 10000, 150);
  const version = await getJson(`http://127.0.0.1:${debugPort}/json/version`);
  cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.ready();
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
  const pageTarget = targets.find((item) => item.id === target.targetId) ?? targets.find((item) => item.type === "page");
  cdp.close();

  cdp = new Cdp(pageTarget.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source:
      'window.__rnMessages = []; window.ReactNativeWebView = { postMessage: (message) => { try { window.__rnMessages.push(JSON.parse(message)); } catch { window.__rnMessages.push({ raw: message }); } } };',
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 760,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 390,
    screenHeight: 760,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await cdp.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(TERMINAL_HTML)}` });

  // Boot: WASM engine loaded, canvas mounted, ready posted.
  await waitFor(() => evalValue(cdp, 'Boolean(window.__term && document.querySelector("#root canvas"))'), 30000, 250);
  await waitFor(async () => (await state(cdp)).messages.some((message) => message.type === "ready"), 10000, 200);

  // Managed session in fit mode reflows to a readable mobile size.
  await host(cdp, { type: "hostLayout", width: 390, height: 760 });
  await host(cdp, { type: "session", source: "managed" });
  await host(cdp, { type: "fit" });
  await sleep(150);
  const managedFull = await state(cdp);

  // Fit reflows to the actual container size (e.g. rotation): a shorter host
  // keeps columns but reduces rows.
  await host(cdp, { type: "hostLayout", width: 390, height: 289 });
  await host(cdp, { type: "fit" });
  await sleep(150);
  const managedKeyboard = await state(cdp);

  // Keyboard: shifting the view up via keyboardInset must NOT resize the terminal
  // (no row change, no resize forwarded) — it just translates the canvas up.
  await host(cdp, { type: "hostLayout", width: 390, height: 760 });
  await host(cdp, { type: "fit" });
  await sleep(120);
  const beforeKb = await state(cdp);
  const msgsBeforeKb = beforeKb.messages.length;
  await host(cdp, { type: "keyboardInset", height: 280 });
  await sleep(120);
  const afterKb = await state(cdp);
  const kbResizeMsgs = afterKb.messages.slice(msgsBeforeKb).filter((m) => m.type === "resize");
  await host(cdp, { type: "keyboardInset", height: 0 });
  await sleep(60);

  // Restore full height and write enough output to create scrollback.
  await host(cdp, { type: "hostLayout", width: 390, height: 760 });
  await host(cdp, { type: "fit" });
  let output = "";
  for (let i = 0; i < 300; i += 1) {
    output += `MOBILE-SMOKE ${i}\\r\\n`;
  }
  await host(cdp, { type: "write", data: output });
  await sleep(300);
  const afterOutput = await state(cdp);

  // scrollBy up moves into history; scrollBy down returns toward the bottom.
  await host(cdp, { type: "scrollToBottom" });
  await sleep(80);
  const atBottom = await state(cdp);
  await host(cdp, { type: "scrollBy", deltaY: -240 });
  await sleep(80);
  const afterScrollUp = await state(cdp);
  await host(cdp, { type: "scrollBy", deltaY: 240 });
  await sleep(80);
  const afterScrollDown = await state(cdp);

  // Alternate screen (Claude, Codex, vim, less): there is no scrollback to move,
  // so a scroll gesture must become input the app understands — arrow keys when
  // the app does not track the mouse, SGR wheel sequences when it does.
  await host(cdp, { type: "write", data: "\x1b[?1049h" }); // enter alt screen
  await sleep(120);
  const altState = await state(cdp);
  const beforeAltMsgs = altState.messages.length;
  await host(cdp, { type: "scrollBy", deltaY: 240 }); // drag toward newer => Down
  await sleep(80);
  const afterAltScroll = await state(cdp);
  const altInputs = afterAltScroll.messages.slice(beforeAltMsgs).filter((m) => m.type === "input");
  const altSentArrows = altInputs.some((m) => typeof m.data === "string" && m.data.indexOf("[B") >= 0);

  await host(cdp, { type: "write", data: "\x1b[?1000h\x1b[?1006h" }); // enable mouse tracking (SGR)
  await sleep(120);
  const mouseState = await state(cdp);
  const beforeMouseMsgs = mouseState.messages.length;
  await host(cdp, { type: "scrollBy", deltaY: 240 });
  await sleep(80);
  const afterMouseScroll = await state(cdp);
  const mouseInputs = afterMouseScroll.messages.slice(beforeMouseMsgs).filter((m) => m.type === "input");
  const mouseSentSgrWheel = mouseInputs.some((m) => typeof m.data === "string" && /\x1b\[<6[45];/.test(m.data));
  await host(cdp, { type: "write", data: "\x1b[?1000l\x1b[?1049l" }); // leave alt screen
  await sleep(120);

  // Ghost-on-switch: reset must wipe the canvas, not leave stale pixels from the
  // previous session showing through until the next session repaints.
  await host(cdp, { type: "session", source: "managed" });
  await host(cdp, { type: "hostLayout", width: 390, height: 760 });
  await host(cdp, { type: "fit" });
  let fillRows = "";
  for (let i = 0; i < 80; i += 1) {
    fillRows += "X".repeat(60) + "\r\n";
  }
  await host(cdp, { type: "write", data: fillRows });
  await sleep(220);
  const filledInk = await bandInk(cdp, 0.35, 0.6);
  await host(cdp, { type: "reset" });
  await sleep(180);
  const clearedInk = await bandInk(cdp, 0.35, 0.6);

  // Pinch-zoom + two-finger pan: spreading two fingers magnifies the canvas;
  // dragging two fingers pans it; switching sessions resets the zoom.
  await host(cdp, { type: "write", data: "zoom me\r\n".repeat(40) });
  await sleep(150);
  const beforePinch = await state(cdp);
  const cx = Math.round((beforePinch.root.left + beforePinch.root.right) / 2);
  const cy = Math.round((beforePinch.root.top + beforePinch.root.bottom) / 2);
  await twoFingerGesture(cdp, { x: cx - 40, y: cy }, { x: cx + 40, y: cy }, { x: cx - 130, y: cy }, { x: cx + 130, y: cy });
  await sleep(100);
  const afterPinch = await state(cdp);
  // Two-finger drag left while zoomed-in pans the view.
  await twoFingerGesture(cdp, { x: cx, y: cy }, { x: cx + 60, y: cy }, { x: cx - 100, y: cy }, { x: cx - 40, y: cy });
  await sleep(100);
  const afterPan = await state(cdp);
  await host(cdp, { type: "reset" });
  await sleep(120);
  const afterZoomReset = await state(cdp);

  // Mirror mode is gone: a bridged session reflows to fit just like a managed
  // one (reads as a readable mobile width, no scale transform), and the device
  // pans/zooms to see more rather than scaling the whole host layout down.
  await host(cdp, { type: "session", source: "bridged", cols: 160, rows: 48 });
  await host(cdp, { type: "hostLayout", width: 390, height: 760 });
  await host(cdp, { type: "fit" });
  await sleep(200);
  const bridged = await state(cdp);

  const managedFullResize = latestMessage(managedFull.messages, "resize");
  const managedKeyboardResize = latestMessage(managedKeyboard.messages, "resize");

  const checks = {
    enginePostsReady: managedFull.messages.some((m) => m.type === "ready"),
    canvasMounted: managedFull.hasCanvas === true,
    managedFitResizesToReadableMobile:
      managedFullResize?.cols >= 28 && managedFullResize?.cols <= 80 && managedFullResize?.rows >= 20,
    fitRespondsToContainerHeight:
      managedKeyboardResize?.cols === managedFullResize?.cols && managedKeyboardResize?.rows < managedFullResize?.rows,
    keyboardInsetTranslatesView: parseTranslateY(afterKb.canvasTransform) <= -200,
    keyboardInsetDoesNotResize:
      afterKb.cols === beforeKb.cols && afterKb.rows === beforeKb.rows && kbResizeMsgs.length === 0,
    outputCreatesScrollback: afterOutput.scrollback > 0,
    scrollByMovesIntoHistory: afterScrollUp.viewportY > atBottom.viewportY,
    scrollByCanReturn: afterScrollDown.viewportY < afterScrollUp.viewportY,
    altScreenDetected: altState.alt === true,
    altScreenScrollSendsArrows: altSentArrows,
    mouseTrackingScrollSendsSgrWheel: mouseSentSgrWheel,
    bridgedReflowsToFit: bridged.cols >= 28 && bridged.cols <= 80 && bridged.cols !== 160,
    bridgedNoScaleTransform: parseScale(bridged.canvasTransform) <= 1.01,
    bridgedDoesNotOverflowHost: bridged.canvas && bridged.root && bridged.canvas.width <= bridged.root.width + 1,
    switchFillsCanvas: filledInk > 200,
    resetClearsCanvasNoGhost: clearedInk < 50,
    pinchZoomsIn: parseScale(beforePinch.canvasTransform) <= 1.01 && parseScale(afterPinch.canvasTransform) > 1.5,
    twoFingerPansWhenZoomed: parseTranslateX(afterPan.canvasTransform) < parseTranslateX(afterPinch.canvasTransform) - 1,
    switchResetsZoom: parseScale(afterZoomReset.canvasTransform) <= 1.01,
  };
  console.log("ghost-check ink:", JSON.stringify({ filledInk, clearedInk }));
  console.log("zoom-check:", JSON.stringify({
    before: beforePinch.canvasTransform,
    afterPinch: afterPinch.canvasTransform,
    afterPan: afterPan.canvasTransform,
    afterReset: afterZoomReset.canvasTransform,
  }));

  console.log(
    JSON.stringify(
      { checks, dims: { managedFullResize, managedKeyboardResize, bridged: { cols: bridged.cols, rows: bridged.rows, transform: bridged.canvasTransform } } },
      null,
      2
    )
  );
  const failed = Object.entries(checks).filter(([, value]) => !value);
  if (failed.length > 0) {
    throw new Error(`Smoke failed: ${failed.map(([name]) => name).join(", ")}`);
  }
  console.log("terminal-html smoke OK");
} finally {
  cdp?.close();
  try {
    chrome.kill();
  } catch {
    // best effort
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

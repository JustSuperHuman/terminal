// Headless smoke test for the WebView terminal page (terminalHtml.ts), which now
// runs coder/ghostty-web (Ghostty's VT parser compiled to WASM) instead of
// xterm.js. We drive it in real Chromium via CDP — the same engine the React
// Native WebView uses — to prove the page boots the WASM engine, mirrors the
// host session's grid (scaling to fit, never resizing the real PTY), and
// converts scroll gestures into the right input per screen mode.
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

async function twoFingerGesture(cdp, p0a, p1a, p0b, p1b) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...p0a, id: 1 }, { ...p1a, id: 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p0b, id: 1 }, { ...p1b, id: 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// One-finger drag through a sequence of points (touchStart at the first, a
// touchMove per remaining point, then touchEnd).
async function oneFingerDrag(cdp, points) {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first.x, y: first.y, id: 1 }] });
  for (const point of rest) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
    await sleep(25);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function tapTouch(cdp, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await sleep(40);
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

  // A session mirrors the host's grid exactly (the host owns the width) and is
  // scaled down to fit the phone — it does NOT reflow the PTY to a narrow mobile
  // width, and it forwards no resize back to the host.
  await host(cdp, { type: "hostLayout", width: 390, height: 760 });
  await host(cdp, { type: "session", source: "managed", cols: 100, rows: 30 });
  await host(cdp, { type: "fit" });
  await sleep(150);
  const managedFull = await state(cdp);

  // Keyboard-open simulation: the native side shrinks the terminal container
  // (marginBottom above the keyboard), which arrives here as a shorter
  // hostLayout. The grid must stay identical (mirror — never reflow rows away),
  // the whole canvas just rescales smaller, and no resize is forwarded to the
  // host PTY.
  const msgsBeforeShrink = managedFull.messages.length;
  await host(cdp, { type: "hostLayout", width: 390, height: 200 });
  await host(cdp, { type: "fit" });
  await sleep(150);
  const managedKeyboard = await state(cdp);
  const shrinkResizeMsgs = managedKeyboard.messages.slice(msgsBeforeShrink).filter((m) => m.type === "resize");

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

  // One-finger gesture semantics (page-owned). The 100-col grid is held at the
  // readability floor, so it overflows the 390px viewport horizontally and can
  // be panned. A tap must fall through (keyboard focus), a drag starting in
  // the right-edge strip scrolls, and a drag anywhere else pans without
  // emitting input/scroll. (The native SwipeBar above the command bar switches
  // sessions only — it never scrolls the terminal.)
  await host(cdp, { type: "scrollToBottom" });
  await sleep(100);
  const beforeGestures = await state(cdp);
  const gcx = Math.round((beforeGestures.root.left + beforeGestures.root.right) / 2);
  const gcy = Math.round((beforeGestures.root.top + beforeGestures.root.bottom) / 2);

  await tapTouch(cdp, gcx, gcy);
  await sleep(150);
  const afterTap = await state(cdp);
  const tapInputs = afterTap.messages.slice(beforeGestures.messages.length).filter((m) => m.type === "input");

  const beforeMiddlePanMsgs = afterTap.messages.length;
  await oneFingerDrag(cdp, [
    { x: gcx, y: gcy },
    { x: gcx - 12, y: gcy }, // passes the 8px tap slop -> pan mode
    { x: gcx - 70, y: gcy },
    { x: gcx - 130, y: gcy },
    { x: gcx - 180, y: gcy },
  ]);
  await sleep(150);
  const afterMiddlePan = await state(cdp);
  const middlePanInputs = afterMiddlePan.messages.slice(beforeMiddlePanMsgs).filter((m) => m.type === "input");

  // A drag starting in the right-edge strip (48px) keeps the classic scroll
  // behavior: dragging down pulls older content into view.
  const beforeEdgeDragMsgs = afterMiddlePan.messages.length;
  await oneFingerDrag(cdp, [
    { x: 380, y: 260 },
    { x: 380, y: 274 },
    { x: 380, y: 350 },
    { x: 380, y: 440 },
    { x: 380, y: 530 },
  ]);
  await sleep(150);
  const afterEdgeDrag = await state(cdp);
  const edgeDragInputs = afterEdgeDrag.messages.slice(beforeEdgeDragMsgs).filter((m) => m.type === "input");
  await host(cdp, { type: "scrollToBottom" });
  await sleep(100);

  // Alternate screen (Claude, Codex, vim, less): there is no scrollback to move,
  // so a scroll gesture must become input the app understands — arrow keys when
  // the app does not track the mouse, SGR wheel sequences when it does. Bare
  // arrows move a TUI's selection/history, so they are heavily damped: one step
  // per 24px of pan, at most 3 per message.
  await host(cdp, { type: "write", data: "\x1b[?1049h" }); // enter alt screen
  await sleep(120);
  const altState = await state(cdp);
  const beforeAltMsgs = altState.messages.length;
  await host(cdp, { type: "scrollBy", deltaY: 240 }); // drag toward newer => Down
  await sleep(80);
  const afterAltScroll = await state(cdp);
  const altInputs = afterAltScroll.messages.slice(beforeAltMsgs).filter((m) => m.type === "input");
  const altSentArrows = altInputs.some((m) => typeof m.data === "string" && m.data.indexOf("[B") >= 0);
  const altArrowCount = altInputs.reduce(
    (count, m) => count + (typeof m.data === "string" ? (m.data.match(/\x1b\[B/g) ?? []).length : 0),
    0
  );

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
  await host(cdp, { type: "session", source: "managed", cols: 100, rows: 30 });
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

  // A wide bridged session (160 cols) mirrors that grid exactly and is held at
  // the readability floor instead of shrinking to fit — the canvas overflows
  // the phone horizontally and one-finger panning reaches both edges. No
  // resize is ever forwarded back to the host.
  await host(cdp, { type: "session", source: "bridged", cols: 160, rows: 48 });
  await host(cdp, { type: "hostLayout", width: 390, height: 760 });
  await host(cdp, { type: "fit" });
  await sleep(200);
  const bridged = await state(cdp);
  const bridgedResize = latestMessage(bridged.messages, "resize");

  // Pan hard left (two drags) to reveal the content's right edge, then hard
  // right to return to the left edge. panX must clamp exactly to the bounds.
  const bAvailW = bridged.root.width - 16; // 8px page padding per side
  const bContentW = bridged.canvas ? bridged.canvas.width : 0; // rect width includes the scale
  const bMinPanX = bAvailW - bContentW;
  const bcy = Math.round((bridged.root.top + bridged.root.bottom) / 2);
  // Both drags start OUTSIDE the right 48px scroll strip so they pan.
  const dragLeft = [{ x: 330, y: bcy }, { x: 318, y: bcy }, { x: 250, y: bcy }, { x: 130, y: bcy }, { x: 20, y: bcy }];
  const dragRight = [{ x: 20, y: bcy }, { x: 32, y: bcy }, { x: 140, y: bcy }, { x: 260, y: bcy }, { x: 330, y: bcy }];
  for (let i = 0; i < 3; i += 1) {
    await oneFingerDrag(cdp, dragLeft);
  }
  await sleep(120);
  const bridgedPannedLeft = await state(cdp);
  for (let i = 0; i < 3; i += 1) {
    await oneFingerDrag(cdp, dragRight);
  }
  await sleep(120);
  const bridgedPannedRight = await state(cdp);

  // Fits fallback: when the grid fits the viewport entirely there is nothing
  // to pan, so a one-finger drag falls back to classic scroll-into-history.
  await host(cdp, { type: "session", source: "managed", cols: 44, rows: 24 });
  await host(cdp, { type: "fit" });
  let fitsOutput = "";
  for (let i = 0; i < 200; i += 1) {
    fitsOutput += `FITS-SMOKE ${i}\r\n`;
  }
  await host(cdp, { type: "write", data: fitsOutput });
  await sleep(220);
  await host(cdp, { type: "scrollToBottom" });
  await sleep(100);
  const fitsBefore = await state(cdp);
  const fcx = Math.round((fitsBefore.root.left + fitsBefore.root.right) / 2);
  const fcy = Math.round((fitsBefore.root.top + fitsBefore.root.bottom) / 2);
  await oneFingerDrag(cdp, [
    { x: fcx, y: fcy - 150 },
    { x: fcx, y: fcy - 136 }, // passes the 8px tap slop -> (fits) scroll mode
    { x: fcx, y: fcy - 60 },
    { x: fcx, y: fcy + 40 },
    { x: fcx, y: fcy + 150 },
  ]);
  await sleep(150);
  const fitsAfter = await state(cdp);

  // Hold-to-repeat backspace: the hidden textarea keeps a run of sentinel
  // spaces parked before the caret — Android IMEs only auto-repeat a held
  // backspace when there is content to delete. Handled deletes must be
  // preventDefault()'d (sentinel intact) while still emitting DEL 0x7f, and an
  // IME edit that lands anyway (commits are not cancelable) must be refilled.
  const sentinelState = await evalValue(cdp, `(() => {
    const ta = window.__term.textarea;
    return { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
  })()`);
  const beforeBackspaceMsgs = (await state(cdp)).messages.length;
  const backspaceProbe = await evalValue(cdp, `(() => {
    const ta = window.__term.textarea;
    ta.focus();
    const fire = () => {
      const event = new InputEvent("beforeinput", { inputType: "deleteContentBackward", cancelable: true, bubbles: true });
      ta.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { prevented: [fire(), fire(), fire()], value: ta.value };
  })()`);
  await sleep(150);
  const afterBackspace = await state(cdp);
  const backspaceInputs = afterBackspace.messages
    .slice(beforeBackspaceMsgs)
    .filter((m) => m.type === "input" && m.data === "\x7f");
  const refillProbe = await evalValue(cdp, `(() => {
    const ta = window.__term.textarea;
    ta.value = ta.value + "hello";
    ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => resolve({ value: ta.value, selStart: ta.selectionStart }), 60));
  })()`);

  const managedFullResize = latestMessage(managedFull.messages, "resize");

  // With the 13px base font on a 390px-wide viewport, the readability floor is
  // 10 / 13 — effective glyph size never drops below ~10px.
  const FLOOR = 10 / 13;

  const checks = {
    enginePostsReady: managedFull.messages.some((m) => m.type === "ready"),
    canvasMounted: managedFull.hasCanvas === true,
    // Mirror: the grid matches the host session's cols/rows exactly...
    mirrorsHostGridExactly: managedFull.cols === 100 && managedFull.rows === 30,
    // ...and the page never reflows the PTY to a phone width (no resize echoed).
    mirrorForwardsNoResize: managedFullResize === undefined,
    // Scale-to-fit with a readability floor: a 100-col grid scales below 1:1,
    // but never below the floor (10px effective glyphs) — it overflows and
    // pans instead of becoming unreadably small.
    scalesGridBelowOneToOne: parseScale(managedFull.canvasTransform) < 0.95,
    respectsReadableFloor: parseScale(managedFull.canvasTransform) >= FLOOR - 0.01,
    // Keyboard-open shrink keeps the grid identical (rescale, never reflow
    // rows), holds the readability floor, and forwards no resize.
    shorterHostKeepsGrid: managedKeyboard.cols === 100 && managedKeyboard.rows === 30,
    shorterHostKeepsReadableFloor: parseScale(managedKeyboard.canvasTransform) >= FLOOR - 0.01,
    shorterHostForwardsNoResize: shrinkResizeMsgs.length === 0,
    // When the floored canvas is taller than the keyboard-shrunk viewport it
    // must anchor to the BOTTOM (prompt/composer rows), not the top — the
    // hidden rows should be the old ones at the top, never the input line.
    shorterHostOverflowsVertically: managedKeyboard.canvas.height > managedKeyboard.root.height - 15,
    shorterHostAnchorsBottomRows: Math.abs(managedKeyboard.canvas.bottom - (managedKeyboard.root.bottom - 8)) <= 4,
    // Restoring the full height goes back to a fitting, top-aligned canvas.
    restoredHeightTopAligns: afterOutput.canvas.top >= afterOutput.root.top - 1,
    outputCreatesScrollback: afterOutput.scrollback > 0,
    scrollByMovesIntoHistory: afterScrollUp.viewportY > atBottom.viewportY,
    scrollByCanReturn: afterScrollDown.viewportY < afterScrollUp.viewportY,
    altScreenDetected: altState.alt === true,
    altScreenScrollSendsArrows: altSentArrows,
    // 240px of pan = 10 raw steps at 24px each, but the per-message cap is 3.
    altScreenArrowsCapped: altArrowCount > 0 && altArrowCount <= 3,
    mouseTrackingScrollSendsSgrWheel: mouseSentSgrWheel,
    // One-finger gesture semantics: a drag in the body pans overflowing
    // content without emitting input; a drag starting in the right-edge strip
    // scrolls into history instead.
    tapDoesNotPan: afterTap.canvasTransform === beforeGestures.canvasTransform,
    tapEmitsNoInput: tapInputs.length === 0,
    middleDragPans: parseTranslateX(afterMiddlePan.canvasTransform) < parseTranslateX(afterTap.canvasTransform) - 100,
    middleDragEmitsNoInput: middlePanInputs.length === 0,
    middleDragDoesNotScroll: afterMiddlePan.viewportY === afterTap.viewportY,
    rightStripDragScrolls: afterEdgeDrag.viewportY > afterMiddlePan.viewportY,
    rightStripDragEmitsNoInput: edgeDragInputs.length === 0,
    bridgedMirrorsWideGrid: bridged.cols === 160 && bridged.rows === 48,
    bridgedForwardsNoResize: bridgedResize === undefined,
    // The floor wins over fit for a 160-col grid: scale sits AT the floor and
    // the canvas overflows the phone horizontally...
    bridgedHeldAtReadableFloor: Math.abs(parseScale(bridged.canvasTransform) - FLOOR) < 0.02,
    bridgedOverflowsForPanning: bContentW > bAvailW + 1,
    // ...and one-finger panning clamps exactly at both content edges.
    bridgedPanReachesRightEdge: Math.abs(parseTranslateX(bridgedPannedLeft.canvasTransform) - bMinPanX) <= 3,
    bridgedPanReachesLeftEdge: parseTranslateX(bridgedPannedRight.canvasTransform) >= -1,
    // Fits fallback: a grid that fits the viewport has nothing to pan, so a
    // one-finger drag scrolls into history instead.
    fitsGridHasNoOverflow:
      fitsBefore.canvas &&
      fitsBefore.canvas.width <= fitsBefore.root.width - 15 &&
      fitsBefore.canvas.height <= fitsBefore.root.height - 15,
    fitsFallbackDragScrolls: fitsAfter.viewportY > fitsBefore.viewportY,
    switchFillsCanvas: filledInk > 200,
    resetClearsCanvasNoGhost: clearedInk < 50,
    pinchZoomsIn:
      parseScale(afterPinch.canvasTransform) > parseScale(beforePinch.canvasTransform) * 1.5,
    twoFingerPansWhenZoomed: parseTranslateX(afterPan.canvasTransform) < parseTranslateX(afterPinch.canvasTransform) - 1,
    switchResetsZoom: parseScale(afterZoomReset.canvasTransform) <= parseScale(beforePinch.canvasTransform) * 1.05,
    // Hold-to-repeat backspace reservoir in the hidden textarea.
    backspaceSentinelPrimed:
      /^ {32}$/.test(sentinelState.value) && sentinelState.selStart === 32 && sentinelState.selEnd === 32,
    backspaceDeletesEmitDel: backspaceInputs.length === 3,
    backspaceDeletesPrevented: backspaceProbe.prevented.every(Boolean) && /^ {32}$/.test(backspaceProbe.value),
    backspaceSentinelRefills: /^ {32}$/.test(refillProbe.value) && refillProbe.selStart === 32,
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
      { checks, dims: { managedFull: { cols: managedFull.cols, rows: managedFull.rows, transform: managedFull.canvasTransform }, bridged: { cols: bridged.cols, rows: bridged.rows, transform: bridged.canvasTransform } } },
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

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
if (!existsSync("dist/server/index.js")) {
  throw new Error("dist/server/index.js is missing. Run npm run build before npm run smoke:layout.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

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

async function setViewport(cdp, width, height, mobile = false) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await sleep(420);
}

async function layout(cdp) {
  return evalValue(cdp, `(() => {
    const textarea = document.querySelector('textarea[aria-label="Terminal composer"]');
    const form = document.querySelector("form[data-active-target]");
    const viewport = document.querySelector(".xterm-viewport");
    const host = document.querySelector(".xterm")?.parentElement;
    const rows = document.querySelector(".xterm-rows");
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
    };
    return {
      host: rect(host),
      form: rect(form),
      textarea: rect(textarea),
      activeIsComposer: document.activeElement === textarea,
      textareaValue: textarea?.value ?? null,
      terminalFormOverlap: host && form ? Math.max(0, Math.round(host.getBoundingClientRect().bottom - form.getBoundingClientRect().top)) : null,
      text: rows?.innerText ?? "",
      scrollTop: viewport ? Math.round(viewport.scrollTop) : null,
      scrollHeight: viewport ? Math.round(viewport.scrollHeight) : null,
      clientHeight: viewport ? Math.round(viewport.clientHeight) : null,
    };
  })()`);
}

async function sessionSize(baseUrl) {
  const bootstrap = await getJson(`${baseUrl}/api/bootstrap`);
  const session = bootstrap.sessions?.find((item) => item.status === "running") ?? bootstrap.sessions?.[0];
  if (!session) {
    return undefined;
  }
  return { id: session.id, cols: session.cols, rows: session.rows, source: session.source, status: session.status };
}

async function focusComposer(cdp) {
  await evalValue(cdp, `(() => {
    const textarea = document.querySelector('textarea[aria-label="Terminal composer"]');
    textarea?.focus();
    return document.activeElement === textarea;
  })()`);
  await sleep(220);
}

async function submitComposer(cdp, command) {
  await focusComposer(cdp);
  await cdp.send("Input.insertText", { text: command });
  await sleep(250);
  const afterType = await layout(cdp);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(500);
  return afterType;
}

async function wheel(cdp, deltaY) {
  return evalValue(cdp, `(() => {
    const host = document.querySelector(".xterm")?.parentElement;
    if (!host) return false;
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: ${deltaY}, bubbles: true, cancelable: true }));
    return true;
  })()`);
}

const appPort = await freePort();
const debugPort = Number(process.env.TERMINAL_WEB_SMOKE_CDP_PORT ?? (await freePort()));
const baseUrl = `http://127.0.0.1:${appPort}`;
const userDataDir = mkdtempSync(join(tmpdir(), "terminal-web-smoke-"));
const server = spawn("node", ["dist/server/index.js", "--static", "--port", String(appPort)], {
  env: { ...process.env, TERMINAL_WEB_CREATE_MODE: "managed", TERMINAL_WEB_AUTH: "off" },
  stdio: "ignore",
});
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" }
);

let cdp;
try {
  await waitFor(() => getJson(`${baseUrl}/api/bootstrap`), 10000, 150);
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
  await setViewport(cdp, 1280, 820, false);
  await cdp.send("Page.navigate", { url: baseUrl });
  await waitFor(() => evalValue(cdp, 'Boolean(document.querySelector(".xterm") && document.querySelector(\'textarea[aria-label="Terminal composer"]\'))'), 15000, 150);
  await sleep(800);

  const desktopLayout = await layout(cdp);
  const desktopSession = await sessionSize(baseUrl);

  await setViewport(cdp, 390, 760, true);
  await focusComposer(cdp);
  const mobileLayout = await layout(cdp);
  const mobileSession = await sessionSize(baseUrl);

  await setViewport(cdp, 390, 460, true);
  await focusComposer(cdp);
  const keyboardLayout = await layout(cdp);
  const keyboardSession = await sessionSize(baseUrl);

  const smokeCommand = `node -e "for(let i=0;i<120;i++) console.log('WEB-SMOKE '+i)"`;
  const afterType = await submitComposer(cdp, smokeCommand);
  await waitFor(async () => (await layout(cdp)).text.includes("WEB-SMOKE 119"), 20000, 250);
  const afterOutput = await layout(cdp);
  await wheel(cdp, -1500);
  await sleep(300);
  const afterWheelUp = await layout(cdp);
  await wheel(cdp, 1500);
  await sleep(300);
  const afterWheelDown = await layout(cdp);

  await setViewport(cdp, 1280, 820, false);
  await focusComposer(cdp);
  const desktopReturnLayout = await layout(cdp);
  const desktopReturnSession = await sessionSize(baseUrl);

  const checks = {
    typedIntoComposer: afterType.textareaValue === smokeCommand,
    focusHeldOnMobile: keyboardLayout.activeIsComposer === true,
    inputClearedAfterEnter: afterOutput.textareaValue === "",
    noDesktopOverlap: desktopLayout.terminalFormOverlap === 0,
    noMobileOverlap: mobileLayout.terminalFormOverlap === 0,
    noKeyboardOverlap: keyboardLayout.terminalFormOverlap === 0,
    keyboardRowsLessThanMobile: Boolean(keyboardSession && mobileSession && keyboardSession.rows < mobileSession.rows),
    desktopReturnRowsRestored: Boolean(desktopReturnSession && desktopSession && Math.abs(desktopReturnSession.rows - desktopSession.rows) <= 1),
    visibleTextMovesOnScrollUp: afterWheelUp.text !== afterOutput.text,
    visibleTextReturnsOnScrollDown: afterWheelDown.text !== afterWheelUp.text,
    desktopReturnHasNoOverlap: desktopReturnLayout.terminalFormOverlap === 0,
  };

  console.log(JSON.stringify({
    checks,
    sessions: { desktopSession, mobileSession, keyboardSession, desktopReturnSession },
  }, null, 2));
  const failed = Object.entries(checks).filter(([, value]) => !value);
  if (failed.length > 0) {
    throw new Error(`Smoke failed: ${failed.map(([name]) => name).join(", ")}`);
  }
} finally {
  cdp?.close();
  chrome.kill();
  server.kill();
  await sleep(300);
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright-core";

const browserCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const browserPath = browserCandidates.find((candidate) => existsSync(candidate));
if (!browserPath) {
  throw new Error("Chrome or Edge was not found. Set CHROME_PATH to run this smoke test.");
}
if (!existsSync("dist/server/index.js")) {
  throw new Error("dist/server/index.js is missing. Run npm run build first.");
}

const freePort = () => new Promise((resolve, reject) => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    listener.close(() => resolve(address.port));
  });
  listener.on("error", reject);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("node", ["dist/server/index.js", "--static", "--port", String(port)], {
  env: { ...process.env, TERMINAL_WEB_CREATE_MODE: "managed", TERMINAL_WEB_AUTH: "off" },
  stdio: "ignore",
});

let browser;
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) break;
    } catch {
      // The host is still starting.
    }
    if (attempt === 59) throw new Error("Terminal web host did not start.");
    await sleep(100);
  }

  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const rail = page.locator('[data-orchestrator-panel="collapsed"]');
  await rail.waitFor({ state: "visible" });
  const result = await rail.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
    };
  });
  const passed = result.width === 44
    && result.height === 820
    && result.backgroundColor === "rgb(20, 22, 27)"
    && result.opacity === "1";
  console.log(JSON.stringify({ passed, rail: result }, null, 2));
  if (!passed) throw new Error("Collapsed orchestrator rail is not fully opaque or correctly sized.");
} finally {
  await browser?.close();
  server.kill();
}

// Render the real web UI with deterministic demo data, without a live host or credentials.
// Run after `bun run build:client`: node scripts/capture-readme.mjs
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
if (!chrome) throw new Error('Set CHROME_PATH to Chrome or Edge.');
const output = resolve('../../doc/screenshots');
mkdirSync(output, { recursive: true });
const at = '2026-09-16T12:00:00Z';
const projects = ['Website', 'API'].map((name, i) => ({ id: `project-${i}`, name, cwd: `C:\\Projects\\${name.toLowerCase()}`, createdAt: at }));
const sessions = ['Build the dashboard', 'Review changes', 'Run API tests'].map((title, i) => ({
  id: `demo-${i}`, title, shell: 'pwsh.exe', args: [], cwd: projects[i === 2 ? 1 : 0].cwd,
  projectId: projects[i === 2 ? 1 : 0].id, source: 'bridged', status: 'running',
  createdAt: at, updatedAt: at, cols: 80, rows: 30, bufferedBytes: 0,
}));
const orchestrator = { state: 'idle', seq: 2, itemCount: 2, config: {
  provider: 'custom', baseUrl: 'http://localhost:1234/v1', model: 'local-model', keyEnv: '', keySource: 'none', reasoning: 'off',
}, transcript: [
  { id: 'q', role: 'user', text: 'What is every tab doing?', seq: 1 },
  { id: 'a', role: 'assistant', text: '**Website**\n\n- **Build the dashboard** — build finished successfully.\n- **Review changes** — ready for your review.\n\n**API**\n\n- **Run API tests** — all tests passed.\n\nNothing is waiting for input.', seq: 2 },
].map(item => ({ ...item, rev: 1, turnId: 'demo', status: 'done', at })) };
const bootstrap = { sessions, projects, profiles: [], hostProcesses: [], peerHosts: [], orchestrator,
  server: { pid: 1, host: '127.0.0.1', port: 10001, startedAt: at, urls: [] } };
const screen = '\x1b[36mPS C:\\Projects\\website>\x1b[0m bun run build\r\n\r\n'
  + '  Building dashboard...\r\n\r\n'
  + '\x1b[32m  [ok]\x1b[0m Compiled application\r\n'
  + '\x1b[32m  [ok]\x1b[0m Checked types\r\n'
  + '\x1b[32m  [ok]\x1b[0m Generated static assets\r\n\r\n'
  + '  dist/index.html              1.42 kB\r\n  dist/assets/app.js          84.16 kB\r\n  dist/assets/app.css         12.08 kB\r\n\r\n'
  + '\x1b[32m  Build completed successfully.\x1b[0m\r\n\r\n\x1b[36mPS C:\\Projects\\website>\x1b[0m ';
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://demo.local/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) {
      const body = path === '/api/bootstrap' ? bootstrap : path === '/api/orchestrator' ? orchestrator : { models: [], recommended: [], source: 'custom' };
      return route.fulfill({ json: body });
    }
    const file = resolve('dist/client', path === '/' ? 'index.html' : `.${path}`);
    if (!file.startsWith(resolve('dist/client'))) return route.abort();
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    return route.fulfill({ body: readFileSync(file), contentType: types[extname(file)] ?? 'application/octet-stream' });
  });
  await page.routeWebSocket('ws://demo.local/ws', ws => {
    ws.send(JSON.stringify({ type: 'hello', ...bootstrap }));
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'subscribe') ws.send(JSON.stringify({ type: 'snapshot', sessionId: msg.sessionId, screen, chunks: [] }));
    });
  });
  await page.goto('http://demo.local');
  await page.getByText('Build the dashboard', { exact: true }).first().waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(output, 'web-terminal.png') });
  await page.evaluate(() => localStorage.setItem('terminal-web.orchestrator.open', '1'));
  await page.reload();
  await page.getByText('Nothing is waiting for input.', { exact: false }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(output, 'orchestrator.png') });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Captured real web UI with demo data: ${output}`);
} finally { await browser.close(); }

// One-off CDP probe of the terminal WebView on the emulator (debug helper).
// Usage: adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
//        node scripts/probe-webview.mjs [pageId]
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = process.argv[2] ? list.find((t) => t.id === process.argv[2]) : list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pend = new Map();
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = id++;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
};

const probe = `(() => {
  const term = window.__term;
  const canvas = document.querySelector("#root canvas");
  let ink = 0;
  try {
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, canvas.width, Math.min(300, canvas.height)).data;
    for (let i = 0; i < img.length; i += 16) {
      if (img[i] > 40 || img[i + 1] > 40 || img[i + 2] > 40) ink++;
    }
  } catch (e) { ink = -1; }
  let vy = null, sb = null;
  try { vy = term.getViewportY(); } catch (e) {}
  try { sb = term.getScrollbackLength(); } catch (e) {}
  return JSON.stringify({
    cols: term.cols, rows: term.rows,
    canvasW: canvas.width, canvasH: canvas.height,
    cssW: canvas.offsetWidth, cssH: canvas.offsetHeight,
    transform: canvas.style.transform,
    rootW: document.getElementById("root").style.width,
    rootH: document.getElementById("root").style.height,
    ink, viewportY: vy, scrollback: sb,
    taLen: term.textarea ? term.textarea.value.length : -1,
  });
})()`;

ws.onopen = async () => {
  await send("Runtime.enable");
  const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
  console.log(r.result?.result?.value ?? JSON.stringify(r));
  process.exit(0);
};
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 10000);

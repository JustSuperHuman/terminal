// Self-contained HTML page that runs xterm.js inside the WebView and bridges
// it to React Native. The native side owns the WebSocket; this page only
// renders output and reports keystrokes/resize back up.
//
// Bridge protocol
//   Native -> Web : window.onHostMessage(jsonString)
//                   { type: "reset" } | { type: "write", data }
//                   | { type: "fit" } | { type: "focus" } | { type: "blur" }
//                   | { type: "scrollToBottom" }
//                   | { type: "fontSize", value }
//   Web -> Native : window.ReactNativeWebView.postMessage(JSON.stringify(...))
//                   { type: "ready", cols, rows }
//                   | { type: "input", data }
//                   | { type: "resize", cols, rows }
//                   | { type: "scroll", atBottom, canScroll }
//                   | { type: "log", message }

const XTERM_VERSION = "5.5.0";
const FIT_VERSION = "0.10.0";

const THEME = {
  background: "#06080d",
  foreground: "#d1d9df",
  cursor: "#37bca5",
  cursorAccent: "#06080d",
  selectionBackground: "#263444",
  black: "#0e1218",
  red: "#e36c61",
  green: "#77b870",
  yellow: "#d9a850",
  blue: "#5b9ddf",
  magenta: "#b481cb",
  cyan: "#36b8c5",
  white: "#d1d9df",
  brightBlack: "#606a74",
  brightRed: "#f2897e",
  brightGreen: "#91cd8b",
  brightYellow: "#e8bd6d",
  brightBlue: "#76b3f1",
  brightMagenta: "#c898de",
  brightCyan: "#61cdd9",
  brightWhite: "#e6ecf1",
};

export const TERMINAL_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/css/xterm.min.css" />
    <style>
      html, body { margin: 0; height: 100%; background: ${THEME.background}; overflow: hidden; }
      #root { position: absolute; inset: 0; padding: 10px; box-sizing: border-box; }
      .xterm { height: 100%; }
      .xterm-viewport { overflow-y: auto !important; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; background-color: transparent !important; }
      #fallback { color: #89949d; font-family: -apple-system, system-ui, sans-serif; font-size: 13px; padding: 16px; }
    </style>
  </head>
  <body>
    <div id="root"><div id="fallback">Loading terminal…</div></div>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${FIT_VERSION}/lib/addon-fit.min.js"></script>
    <script>
      (function () {
        var theme = ${JSON.stringify(THEME)};
        var pending = [];
        var ready = false;
        var term = null;
        var fit = null;

        function post(obj) {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify(obj));
          }
        }

        function fontSizeForWidth() {
          return window.innerWidth <= 480 ? 12 : 13;
        }

        function reportScroll() {
          var vp = document.querySelector(".xterm-viewport");
          if (!vp) { return; }
          var canScroll = vp.scrollHeight > vp.clientHeight + 1;
          var atBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 2;
          post({ type: "scroll", atBottom: atBottom, canScroll: canScroll });
        }

        function doFit() {
          if (!fit) { return; }
          try { fit.fit(); } catch (e) {}
        }

        function handle(msg) {
          if (!term) { pending.push(msg); return; }
          switch (msg.type) {
            case "reset": term.reset(); break;
            case "write": term.write(msg.data); setTimeout(reportScroll, 0); break;
            case "fit": doFit(); break;
            case "focus": term.focus(); break;
            case "blur": term.blur(); break;
            case "scrollToBottom": term.scrollToBottom(); setTimeout(reportScroll, 0); break;
            case "fontSize":
              term.options.fontSize = msg.value;
              doFit();
              break;
          }
        }

        // Native -> Web entry point.
        window.onHostMessage = function (raw) {
          try { handle(typeof raw === "string" ? JSON.parse(raw) : raw); } catch (e) {}
        };

        function boot() {
          if (typeof window.Terminal === "undefined") {
            document.getElementById("fallback").textContent =
              "Could not load terminal renderer. Check the device's internet connection.";
            post({ type: "log", message: "xterm failed to load" });
            return;
          }

          var FitAddonCtor = (window.FitAddon && window.FitAddon.FitAddon) || null;
          var root = document.getElementById("root");
          root.innerHTML = "";

          term = new window.Terminal({
            allowProposedApi: true,
            convertEol: true,
            cursorBlink: true,
            cursorStyle: "bar",
            fontFamily: '"Cascadia Mono", "Cascadia Code", "SFMono-Regular", Menlo, Consolas, ui-monospace, monospace',
            fontSize: fontSizeForWidth(),
            lineHeight: 1.22,
            scrollback: 5000,
            theme: theme,
          });

          if (FitAddonCtor) {
            fit = new FitAddonCtor();
            term.loadAddon(fit);
          }
          term.open(root);
          doFit();

          term.onData(function (data) { post({ type: "input", data: data }); });
          term.onResize(function (size) { post({ type: "resize", cols: size.cols, rows: size.rows }); });

          var vp = document.querySelector(".xterm-viewport");
          if (vp) { vp.addEventListener("scroll", reportScroll, { passive: true }); }

          window.addEventListener("resize", function () { doFit(); setTimeout(reportScroll, 0); });
          if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", function () { doFit(); });
          }

          ready = true;
          for (var i = 0; i < pending.length; i++) { handle(pending[i]); }
          pending = [];

          setTimeout(doFit, 60);
          setTimeout(function () {
            doFit();
            post({ type: "ready", cols: term.cols, rows: term.rows });
            reportScroll();
          }, 120);
        }

        if (document.readyState === "complete") {
          boot();
        } else {
          window.addEventListener("load", boot);
        }
      })();
    </script>
  </body>
</html>`;

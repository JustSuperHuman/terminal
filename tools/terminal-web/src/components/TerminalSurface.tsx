import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { ArrowDownToLine, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalSocket, type SocketStatus } from "@/lib/terminal-socket";
import type { ServerMessage, TerminalSessionSummary } from "@/lib/types";

function getTerminalFontSize() {
  return window.matchMedia("(max-width: 640px)").matches ? 12 : 13;
}

function isMobileTerminalViewport() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function clampTerminalDimension(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.floor(value), max));
}

function setTerminalFontSize(term: Terminal, size: number) {
  const nextSize = Math.round(size * 100) / 100;
  const currentSize = Number(term.options.fontSize ?? getTerminalFontSize());
  if (Math.abs(currentSize - nextSize) > 0.05) {
    term.options.fontSize = nextSize;
  }
}

function measureCellWidth(host: HTMLElement, term: Terminal) {
  const fontSize = Number(term.options.fontSize ?? getTerminalFontSize());
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(120);
  probe.style.fontFamily = String(term.options.fontFamily ?? "monospace");
  probe.style.fontSize = `${fontSize}px`;
  probe.style.lineHeight = String(term.options.lineHeight ?? 1.22);
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.pointerEvents = "none";

  host.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 120;
  probe.remove();

  return Number.isFinite(width) && width > 0 ? width : fontSize * 0.62;
}

interface TerminalDimensions {
  cols: number;
  rows: number;
}

function sameDimensions(left?: TerminalDimensions, right?: TerminalDimensions) {
  return Boolean(left && right && left.cols === right.cols && left.rows === right.rows);
}

function measureReadableViewport(host: HTMLElement, term: Terminal): TerminalDimensions | undefined {
  const shell = host.parentElement;
  const availableWidth = Math.max(80, shell?.clientWidth ?? host.clientWidth);
  const availableHeight = Math.max(80, host.clientHeight || shell?.clientHeight || 0);
  const fontSize = getTerminalFontSize();
  const lineHeight = Math.max(fontSize * Number(term.options.lineHeight ?? 1.22), 12);

  setTerminalFontSize(term, fontSize);
  return {
    cols: clampTerminalDimension(Math.floor(availableWidth / measureCellWidth(host, term)), 20, 400),
    rows: clampTerminalDimension(Math.floor(availableHeight / lineHeight), 8, 200)
  };
}

interface TerminalSurfaceProps {
  session?: TerminalSessionSummary;
  targetId?: string;
  copySignal: number;
  focusSignal: number;
  socketStatus: SocketStatus;
  onCopied?: () => void;
}

export interface TerminalSurfaceHandle {
  settleBeforeInput: () => void;
}

export const TerminalSurface = forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(function TerminalSurface(
  { session, targetId, copySignal, focusSignal, socketStatus, onCopied },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const activeTargetRef = useRef<string | undefined>(targetId);
  const activeSessionRef = useRef<TerminalSessionSummary | undefined>(session);
  const socketStatusRef = useRef<SocketStatus>(socketStatus);
  const subscribedTargetRef = useRef<string | undefined>();
  const layoutFrameRef = useRef<number | undefined>();
  const pendingBridgeSizeRef = useRef<(TerminalDimensions & { targetId: string }) | undefined>();
  const lastResizeClaimRef = useRef<(TerminalDimensions & { targetId: string }) | undefined>();
  const [scrollState, setScrollState] = useState({ canScroll: false, atBottom: true });

  function isBridgedSession() {
    return activeSessionRef.current?.source === "bridged";
  }

  function applyTerminalLayout() {
    const term = terminalRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) {
      return;
    }

    const bridgedSession = activeSessionRef.current?.source === "bridged" ? activeSessionRef.current : undefined;
    if (bridgedSession) {
      const pendingSize =
        pendingBridgeSizeRef.current?.targetId === activeTargetRef.current ? pendingBridgeSizeRef.current : undefined;
      const cols = clampTerminalDimension(pendingSize?.cols ?? bridgedSession.cols, 20, 400);
      const rows = clampTerminalDimension(pendingSize?.rows ?? bridgedSession.rows, 8, 200);
      const shell = host.parentElement;
      const parentWidth = host.parentElement?.clientWidth ?? host.clientWidth;
      const baseFontSize = getTerminalFontSize();
      const mobile = isMobileTerminalViewport();

      if (mobile) {
        setTerminalFontSize(term, baseFontSize);
        const baseWidth = Math.ceil(cols * measureCellWidth(host, term)) + 4;
        const fittedFontSize = baseWidth > parentWidth ? baseFontSize * (parentWidth / baseWidth) : baseFontSize;
        setTerminalFontSize(term, Math.max(9, Math.min(baseFontSize, fittedFontSize)));
      } else {
        setTerminalFontSize(term, baseFontSize);
      }

      const contentWidth = Math.ceil(cols * measureCellWidth(host, term)) + 4;
      const width = Math.max(parentWidth, contentWidth);
      const scaleX = mobile && width > parentWidth ? parentWidth / width : 1;

      host.style.width = `${width}px`;
      host.style.minWidth = scaleX < 1 ? "0" : "100%";
      host.style.transform = scaleX < 1 ? `scaleX(${scaleX})` : "";
      host.style.transformOrigin = "left top";
      if (shell) {
        shell.style.overflowX = scaleX < 1 ? "hidden" : "";
        if (scaleX < 1) {
          shell.scrollLeft = 0;
        }
      }
      term.resize(cols, rows);
      return;
    }

    host.style.width = "";
    host.style.minWidth = "";
    host.style.transform = "";
    host.style.transformOrigin = "";
    if (host.parentElement) {
      host.parentElement.style.overflowX = "";
    }
    setTerminalFontSize(term, getTerminalFontSize());
    fit.fit();
  }

  function sendResizeClaim(dimensions: TerminalDimensions, allowBridged: boolean) {
    const targetId = activeTargetRef.current;
    const activeSession = activeSessionRef.current;
    if (!targetId || !activeSession || socketStatusRef.current !== "open" || activeSession.status !== "running") {
      return;
    }
    if (!allowBridged && activeSession.source === "bridged") {
      return;
    }
    if (activeSession.cols === dimensions.cols && activeSession.rows === dimensions.rows) {
      return;
    }
    const nextClaim = { targetId, cols: dimensions.cols, rows: dimensions.rows };
    if (sameDimensions(lastResizeClaimRef.current, nextClaim) && lastResizeClaimRef.current?.targetId === targetId) {
      return;
    }
    lastResizeClaimRef.current = nextClaim;
    terminalSocket.send({ type: "resize", sessionId: targetId, cols: dimensions.cols, rows: dimensions.rows });
  }

  function claimActiveViewportSize() {
    const term = terminalRef.current;
    const host = hostRef.current;
    if (!term || !host) {
      return;
    }

    const activeSession = activeSessionRef.current;
    const targetId = activeTargetRef.current;
    if (!activeSession || !targetId) {
      return;
    }

    if (activeSession.source === "bridged") {
      const dimensions = measureReadableViewport(host, term);
      if (!dimensions) {
        return;
      }
      pendingBridgeSizeRef.current = { targetId, ...dimensions };
      sendResizeClaim(dimensions, true);
      return;
    }

    sendResizeClaim({ cols: term.cols, rows: term.rows }, false);
  }

  function scheduleTerminalLayout() {
    if (layoutFrameRef.current !== undefined) {
      window.cancelAnimationFrame(layoutFrameRef.current);
    }

    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = undefined;
      if (isBridgedSession()) {
        claimActiveViewportSize();
      }
      applyTerminalLayout();
      if (!isBridgedSession()) {
        claimActiveViewportSize();
      }
      updateScrollState();
    });
  }

  function settleBeforeInput() {
    if (isBridgedSession()) {
      claimActiveViewportSize();
    }
    applyTerminalLayout();
    claimActiveViewportSize();
    updateScrollState();
  }

  function updateScrollState() {
    const buffer = terminalRef.current?.buffer.active;
    if (!buffer) {
      setScrollState({ canScroll: false, atBottom: true });
      return;
    }

    const canScroll = buffer.baseY > 0;
    const atBottom = buffer.viewportY >= buffer.baseY;
    setScrollState({ canScroll, atBottom });
  }

  useEffect(() => {
    activeTargetRef.current = targetId;
    pendingBridgeSizeRef.current = undefined;
    lastResizeClaimRef.current = undefined;
  }, [targetId]);

  useEffect(() => {
    const previous = activeSessionRef.current;
    activeSessionRef.current = session;
    if (previous?.id !== session?.id || previous?.cols !== session?.cols || previous?.rows !== session?.rows) {
      lastResizeClaimRef.current = undefined;
    }
    scheduleTerminalLayout();
  }, [session?.id, session?.source, session?.cols, session?.rows]);

  useEffect(() => {
    socketStatusRef.current = socketStatus;
  }, [socketStatus]);

  useImperativeHandle(
    ref,
    () => ({
      settleBeforeInput,
    })
  );

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "SFMono-Regular", Menlo, Consolas, ui-monospace, monospace',
      fontSize: getTerminalFontSize(),
      lineHeight: 1.22,
      scrollback: 5000,
      theme: {
        background: "oklch(0.135 0.011 258)",
        foreground: "oklch(0.88 0.012 244)",
        cursor: "oklch(0.72 0.118 178)",
        selectionBackground: "oklch(0.32 0.034 252)",
        black: "oklch(0.18 0.014 260)",
        red: "oklch(0.67 0.15 27)",
        green: "oklch(0.72 0.12 142)",
        yellow: "oklch(0.76 0.12 80)",
        blue: "oklch(0.68 0.12 250)",
        magenta: "oklch(0.68 0.12 315)",
        cyan: "oklch(0.72 0.11 205)",
        white: "oklch(0.88 0.012 244)",
        brightBlack: "oklch(0.52 0.02 250)",
        brightRed: "oklch(0.74 0.13 27)",
        brightGreen: "oklch(0.79 0.11 142)",
        brightYellow: "oklch(0.82 0.11 82)",
        brightBlue: "oklch(0.75 0.11 250)",
        brightMagenta: "oklch(0.75 0.11 315)",
        brightCyan: "oklch(0.79 0.1 205)",
        brightWhite: "oklch(0.94 0.01 244)"
      }
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();

    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    terminalRef.current = term;
    fitRef.current = fit;
    serializeRef.current = serialize;

    const settleFocusedLayout = () => {
      scheduleTerminalLayout();
      window.setTimeout(scheduleTerminalLayout, 80);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        settleFocusedLayout();
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      settleFocusedLayout();
      window.setTimeout(updateScrollState, 0);
    });
    resizeObserver.observe(hostRef.current);
    window.addEventListener("resize", settleFocusedLayout);
    window.visualViewport?.addEventListener("resize", settleFocusedLayout);
    window.addEventListener("focus", settleFocusedLayout);
    document.addEventListener("visibilitychange", onVisibilityChange);

    const mobileQuery = window.matchMedia("(max-width: 640px)");
    const onMobileQueryChange = () => {
      term.options.fontSize = getTerminalFontSize();
      settleFocusedLayout();
    };
    mobileQuery.addEventListener("change", onMobileQueryChange);

    document.fonts?.ready.then(() => scheduleTerminalLayout()).catch(() => undefined);

    const viewport = hostRef.current.querySelector<HTMLElement>(".xterm-viewport");
    viewport?.addEventListener("scroll", updateScrollState, { passive: true });

    function scrollLines(lines: number) {
      if (lines === 0) {
        return;
      }
      term.scrollLines(lines);
      updateScrollState();
    }

    const onWheel = (event: WheelEvent) => {
      if (term.buffer.active.baseY === 0) {
        return;
      }
      const lines = Math.sign(event.deltaY) * Math.max(1, Math.ceil(Math.abs(event.deltaY) / 48));
      scrollLines(lines);
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    let touchY: number | undefined;
    let touchRemainder = 0;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchY = undefined;
        touchRemainder = 0;
        return;
      }
      touchY = event.touches[0].clientY;
      touchRemainder = 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchY === undefined || event.touches.length !== 1) {
        return;
      }
      const nextY = event.touches[0].clientY;
      const dy = touchY - nextY;
      touchY = nextY;

      // Full-screen apps (Claude, Codex, vim, less) live on the alternate screen
      // where there is no scrollback to move. Translate the gesture into input the
      // app understands: SGR mouse-wheel sequences when it tracks the mouse, else
      // arrow keys (respecting application-cursor mode).
      if (term.buffer.active.type === "alternate") {
        touchRemainder += dy;
        const altLineHeight = Math.max(Number(term.options.fontSize) * Number(term.options.lineHeight ?? 1), 12);
        const steps = Math.trunc(touchRemainder / altLineHeight);
        if (steps !== 0) {
          touchRemainder -= steps * altLineHeight;
          const altTargetId = activeTargetRef.current;
          if (altTargetId && socketStatusRef.current === "open") {
            const count = Math.min(Math.abs(steps), 8);
            const modes = term.modes;
            let data = "";
            if (modes.mouseTrackingMode !== "none") {
              const button = steps > 0 ? 65 : 64; // SGR wheel down / up
              const col = Math.max(1, Math.min(term.cols, Math.floor(term.cols / 2) + 1));
              const row = Math.max(1, Math.min(term.rows, Math.floor(term.rows / 2) + 1));
              for (let i = 0; i < count; i += 1) {
                data += `\x1b[<${button};${col};${row}M`;
              }
            } else {
              const down = modes.applicationCursorKeysMode ? "\x1bOB" : "\x1b[B";
              const up = modes.applicationCursorKeysMode ? "\x1bOA" : "\x1b[A";
              data = (steps > 0 ? down : up).repeat(count);
            }
            if (data) {
              terminalSocket.send({ type: "input", sessionId: altTargetId, data });
            }
          }
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        return;
      }

      if (term.buffer.active.baseY === 0) {
        return;
      }
      touchRemainder += dy;

      const lineHeight = Math.max(Number(term.options.fontSize) * Number(term.options.lineHeight ?? 1), 12);
      const lines = Math.trunc(touchRemainder / lineHeight);
      if (lines !== 0) {
        touchRemainder -= lines * lineHeight;
        scrollLines(lines);
      }
      if (event.cancelable) {
        event.preventDefault();
      }
    };
    const onTouchEnd = () => {
      touchY = undefined;
      touchRemainder = 0;
    };

    const hostElement = hostRef.current;
    hostElement.addEventListener("wheel", onWheel, { passive: false });
    hostElement.addEventListener("touchstart", onTouchStart, { passive: true });
    hostElement.addEventListener("touchmove", onTouchMove, { passive: false });
    hostElement.addEventListener("touchend", onTouchEnd, { passive: true });
    hostElement.addEventListener("touchcancel", onTouchEnd, { passive: true });
    hostElement.addEventListener("focusin", settleFocusedLayout);

    const dataDisposable = term.onData((data) => {
      const activeTargetId = activeTargetRef.current;
      if (activeTargetId) {
        terminalSocket.send({ type: "input", sessionId: activeTargetId, data });
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const activeTargetId = activeTargetRef.current;
      if (activeTargetId && !isBridgedSession()) {
        terminalSocket.send({ type: "resize", sessionId: activeTargetId, cols, rows });
      }
    });

    scheduleTerminalLayout();
    window.setTimeout(scheduleTerminalLayout, 60);
    window.setTimeout(scheduleTerminalLayout, 240);
    window.setTimeout(updateScrollState, 0);

    return () => {
      if (layoutFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutFrameRef.current);
        layoutFrameRef.current = undefined;
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", settleFocusedLayout);
      window.visualViewport?.removeEventListener("resize", settleFocusedLayout);
      window.removeEventListener("focus", settleFocusedLayout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      mobileQuery.removeEventListener("change", onMobileQueryChange);
      viewport?.removeEventListener("scroll", updateScrollState);
      hostElement.removeEventListener("wheel", onWheel);
      hostElement.removeEventListener("touchstart", onTouchStart);
      hostElement.removeEventListener("touchmove", onTouchMove);
      hostElement.removeEventListener("touchend", onTouchEnd);
      hostElement.removeEventListener("touchcancel", onTouchEnd);
      hostElement.removeEventListener("focusin", settleFocusedLayout);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      serializeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const off = terminalSocket.onMessage((message: ServerMessage) => {
      const term = terminalRef.current;
      if (!term) {
        return;
      }

      if (message.type === "snapshot" && message.sessionId === activeTargetRef.current) {
        term.reset();
        if (message.screen) {
          term.write(message.screen);
        } else {
          for (const chunk of message.chunks) {
            term.write(chunk.data);
          }
        }
        window.setTimeout(scheduleTerminalLayout, 0);
        window.setTimeout(updateScrollState, 0);
      }

      if (message.type === "output" && message.sessionId === activeTargetRef.current) {
        term.write(message.data);
        window.setTimeout(updateScrollState, 0);
      }
    });
    return off;
  }, []);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !session || !targetId) {
      return;
    }
    const acceptsInput = socketStatus === "open" && session.status === "running";
    term.options.disableStdin = !acceptsInput;

    if (socketStatus !== "open") {
      return;
    }

    if (subscribedTargetRef.current !== targetId) {
      term.clear();
      subscribedTargetRef.current = targetId;
    }

    terminalSocket.send({ type: "subscribe", sessionId: targetId });
    window.setTimeout(() => {
      applyTerminalLayout();
      claimActiveViewportSize();
      if (acceptsInput) {
        term.focus();
      }
    }, 0);
  }, [session?.id, session?.status, socketStatus, targetId]);

  useEffect(() => {
    if (focusSignal === 0) {
      return;
    }
    scheduleTerminalLayout();
    window.setTimeout(claimActiveViewportSize, 0);
    window.setTimeout(claimActiveViewportSize, 120);
    terminalRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    if (copySignal === 0) {
      return;
    }
    const serialized = serializeRef.current?.serialize();
    if (serialized) {
      navigator.clipboard.writeText(serialized).then(() => onCopied?.());
    }
  }, [copySignal]);

  function scrollPage(direction: -1 | 1) {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    term.scrollLines(direction * Math.max(term.rows - 2, 1));
    window.setTimeout(updateScrollState, 0);
  }

  function scrollToBottom() {
    terminalRef.current?.scrollToBottom();
    window.setTimeout(updateScrollState, 0);
  }

  return (
    <div className="relative min-h-0 flex-1 bg-terminal">
      <div className={`terminal-shell h-full w-full ${session?.source === "bridged" ? "terminal-shell-fixed" : ""}`}>
        <div ref={hostRef} className={`terminal-frame h-full ${session?.source === "bridged" ? "terminal-frame-fixed" : "w-full"}`} />
      </div>
      {scrollState.canScroll ? (
        <div className="absolute bottom-3 right-3 z-10 flex rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7" onClick={() => scrollPage(-1)}>
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">Scroll terminal up</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Scroll up</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7" onClick={() => scrollPage(1)}>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">Scroll terminal down</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Scroll down</TooltipContent>
          </Tooltip>
          {!scrollState.atBottom ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7" onClick={scrollToBottom}>
                  <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Jump to latest terminal output</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Jump to latest</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {socketStatus !== "open" ? (
        <div className="pointer-events-none absolute right-4 top-4 rounded-md border bg-background/90 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm">
          Reconnecting terminal
        </div>
      ) : null}
    </div>
  );
});

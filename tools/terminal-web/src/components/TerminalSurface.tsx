import { useEffect, useRef, useState } from "react";
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

interface TerminalSurfaceProps {
  session?: TerminalSessionSummary;
  targetId?: string;
  copySignal: number;
  focusSignal: number;
  socketStatus: SocketStatus;
  onCopied?: () => void;
}

export function TerminalSurface({ session, targetId, copySignal, focusSignal, socketStatus, onCopied }: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const activeTargetRef = useRef<string | undefined>(targetId);
  const subscribedTargetRef = useRef<string | undefined>();
  const [scrollState, setScrollState] = useState({ canScroll: false, atBottom: true });

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
  }, [targetId]);

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

    let fitFrame: number | undefined;
    function scheduleFit() {
      if (fitFrame) {
        window.cancelAnimationFrame(fitFrame);
      }
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        fit.fit();
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
      window.setTimeout(updateScrollState, 0);
    });
    resizeObserver.observe(hostRef.current);
    window.addEventListener("resize", scheduleFit);
    window.visualViewport?.addEventListener("resize", scheduleFit);

    const mobileQuery = window.matchMedia("(max-width: 640px)");
    const onMobileQueryChange = () => {
      term.options.fontSize = getTerminalFontSize();
      scheduleFit();
    };
    mobileQuery.addEventListener("change", onMobileQueryChange);

    document.fonts?.ready.then(() => scheduleFit()).catch(() => undefined);

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
      if (touchY === undefined || event.touches.length !== 1 || term.buffer.active.baseY === 0) {
        return;
      }
      const nextY = event.touches[0].clientY;
      touchRemainder += touchY - nextY;
      touchY = nextY;

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

    hostRef.current.addEventListener("wheel", onWheel, { passive: false });
    hostRef.current.addEventListener("touchstart", onTouchStart, { passive: true });
    hostRef.current.addEventListener("touchmove", onTouchMove, { passive: false });
    hostRef.current.addEventListener("touchend", onTouchEnd, { passive: true });
    hostRef.current.addEventListener("touchcancel", onTouchEnd, { passive: true });

    const dataDisposable = term.onData((data) => {
      const activeTargetId = activeTargetRef.current;
      if (activeTargetId) {
        terminalSocket.send({ type: "input", sessionId: activeTargetId, data });
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const activeTargetId = activeTargetRef.current;
      if (activeTargetId) {
        terminalSocket.send({ type: "resize", sessionId: activeTargetId, cols, rows });
      }
    });

    scheduleFit();
    window.setTimeout(scheduleFit, 60);
    window.setTimeout(scheduleFit, 240);
    window.setTimeout(updateScrollState, 0);

    return () => {
      if (fitFrame) {
        window.cancelAnimationFrame(fitFrame);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleFit);
      window.visualViewport?.removeEventListener("resize", scheduleFit);
      mobileQuery.removeEventListener("change", onMobileQueryChange);
      viewport?.removeEventListener("scroll", updateScrollState);
      hostRef.current?.removeEventListener("wheel", onWheel);
      hostRef.current?.removeEventListener("touchstart", onTouchStart);
      hostRef.current?.removeEventListener("touchmove", onTouchMove);
      hostRef.current?.removeEventListener("touchend", onTouchEnd);
      hostRef.current?.removeEventListener("touchcancel", onTouchEnd);
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
        window.setTimeout(() => fitRef.current?.fit(), 0);
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
      fitRef.current?.fit();
      terminalSocket.send({ type: "resize", sessionId: targetId, cols: term.cols, rows: term.rows });
      if (acceptsInput) {
        term.focus();
      }
    }, 0);
  }, [session?.id, session?.status, socketStatus, targetId]);

  useEffect(() => {
    if (focusSignal === 0) {
      return;
    }
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
      <div className="terminal-shell h-full w-full">
        <div ref={hostRef} className="terminal-frame h-full w-full" />
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
}

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { PanResponder, Pressable, StyleSheet, Text, type LayoutChangeEvent, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { terminalSocket, type SocketStatus } from "../lib/socket";
import type { ServerMessage, TerminalSessionSummary } from "../types";
import { TERMINAL_HTML } from "../terminalHtml";
import { colors, font, radius } from "../theme";
import { TerminalLoading } from "./TerminalLoading";

// Hard cap on how long the launch skeleton lingers if a session never prints.
const LOADING_FALLBACK_MS = 4000;

const SESSION_SWITCH_EDGE_WIDTH = 34;
const SCROLL_GESTURE_THRESHOLD = 7;

export interface TerminalViewHandle {
  fitToViewport: () => void;
  focusTerminal: () => void;
  blurTerminal: () => void;
  resizeForMobileInput: () => void;
}

interface TerminalViewProps {
  targetId?: string;
  session?: TerminalSessionSummary;
  socketStatus: SocketStatus;
  // While the session switcher is scrubbing we live-preview each session; hide
  // the launch skeleton so the real terminal content is visible as it flips.
  suppressLoading?: boolean;
  // Pixels the keyboard occludes at the bottom. We shift the terminal view up by
  // this much (instead of resizing it) so the input stays visible above the
  // keyboard.
  keyboardInset?: number;
}

interface WebDims {
  cols: number;
  rows: number;
}

interface HostLayout {
  width: number;
  height: number;
}

function parseWebDims(cols: unknown, rows: unknown): WebDims | undefined {
  const nextCols = Math.floor(Number(cols));
  const nextRows = Math.floor(Number(rows));
  if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) {
    return undefined;
  }
  return { cols: nextCols, rows: nextRows };
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { targetId, session, socketStatus, suppressLoading = false, keyboardInset = 0 },
  ref
) {
  const webRef = useRef<WebView | null>(null);
  const containerRef = useRef<View | null>(null);
  const webReadyRef = useRef(false);
  const [webReady, setWebReady] = useState(false);
  const activeTargetRef = useRef<string | undefined>(targetId);
  const activeSessionRef = useRef<TerminalSessionSummary | undefined>(session);
  const keyboardInsetRef = useRef<number>(keyboardInset);
  const subscribedTargetRef = useRef<string | undefined>(undefined);
  const hostLayoutRef = useRef<HostLayout | undefined>(undefined);
  const lastResizeRef = useRef<{ sessionId: string; cols: number; rows: number } | undefined>(undefined);
  const fitTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const scrollGestureLastDyRef = useRef(0);
  const [scroll, setScroll] = useState({ canScroll: false, atBottom: true });
  // Whether the active session has painted anything yet — drives the launch skeleton.
  const [rendered, setRendered] = useState(false);
  const loadingFallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const postToWeb = useCallback((message: Record<string, unknown>) => {
    if (!webRef.current) {
      return;
    }
    const json = JSON.stringify(message);
    // Double-encode so arbitrary terminal bytes survive as a JS string literal.
    webRef.current.injectJavaScript(`window.onHostMessage(${JSON.stringify(json)});true;`);
  }, []);

  const clearFitTimers = useCallback(() => {
    for (const timer of fitTimersRef.current) {
      clearTimeout(timer);
    }
    fitTimersRef.current = [];
  }, []);

  const recordHostSize = useCallback((rawWidth: number, rawHeight: number) => {
    const width = Math.round(rawWidth);
    const height = Math.round(rawHeight);
    if (width <= 0 || height <= 0) {
      return false;
    }
    const current = hostLayoutRef.current;
    if (current?.width === width && current.height === height) {
      return true;
    }
    hostLayoutRef.current = { width, height };
    return true;
  }, []);

  const recordHostLayout = useCallback((layout: LayoutChangeEvent["nativeEvent"]["layout"] | undefined) => {
    if (!layout) {
      return false;
    }
    return recordHostSize(layout.width, layout.height);
  }, [recordHostSize]);

  const measureHostLayout = useCallback(
    (onMeasured: () => void) => {
      const container = containerRef.current;
      if (!container) {
        onMeasured();
        return;
      }
      container.measure((_x, _y, width, height) => {
        recordHostSize(width, height);
        onMeasured();
      });
    },
    [recordHostSize]
  );

  const postHostLayout = useCallback(() => {
    const layout = hostLayoutRef.current;
    if (!layout) {
      return;
    }
    postToWeb({ type: "hostLayout", width: layout.width, height: layout.height });
  }, [postToWeb]);

  // Forward a measured size to the PTY (the WebView reflows to fit and reports
  // its size here). Deduped so we don't spam identical resizes.
  const forwardResize = useCallback((dims?: WebDims) => {
    if (!dims) {
      return;
    }
    const target = activeTargetRef.current;
    const session = activeSessionRef.current;
    if (!target || !session || terminalSocket.currentStatus !== "open") {
      return;
    }
    if (session.cols === dims.cols && session.rows === dims.rows) {
      return;
    }
    const last = lastResizeRef.current;
    if (last?.sessionId === target && last.cols === dims.cols && last.rows === dims.rows) {
      return;
    }
    lastResizeRef.current = { sessionId: target, cols: dims.cols, rows: dims.rows };
    terminalSocket.send({ type: "resize", sessionId: target, cols: dims.cols, rows: dims.rows });
  }, []);

  const postSession = useCallback(() => {
    postToWeb({ type: "session" });
  }, [postToWeb]);

  const requestTerminalFit = useCallback(
    (event?: LayoutChangeEvent) => {
      recordHostLayout(event?.nativeEvent.layout);
      if (!webReadyRef.current) {
        return;
      }
      const fitToMeasuredLayout = () => {
        postHostLayout();
        postToWeb({ type: "fit" });
      };
      measureHostLayout(fitToMeasuredLayout);
      clearFitTimers();
      fitTimersRef.current = [
        setTimeout(() => measureHostLayout(fitToMeasuredLayout), 80),
        setTimeout(() => measureHostLayout(fitToMeasuredLayout), 220),
      ];
    },
    [clearFitTimers, measureHostLayout, postHostLayout, postToWeb, recordHostLayout]
  );

  const scrollResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (event, gesture) => {
        // Leave multi-touch (pinch-zoom / two-finger pan) to the WebView.
        if (gesture.numberActiveTouches > 1) {
          return false;
        }
        if (event.nativeEvent.locationX <= SESSION_SWITCH_EDGE_WIDTH) {
          return false;
        }
        const absDx = Math.abs(gesture.dx);
        const absDy = Math.abs(gesture.dy);
        return absDy >= SCROLL_GESTURE_THRESHOLD && absDy > absDx * 1.15;
      },
      onMoveShouldSetPanResponderCapture: (event, gesture) => {
        if (gesture.numberActiveTouches > 1) {
          return false;
        }
        if (event.nativeEvent.locationX <= SESSION_SWITCH_EDGE_WIDTH) {
          return false;
        }
        const absDx = Math.abs(gesture.dx);
        const absDy = Math.abs(gesture.dy);
        return absDy >= SCROLL_GESTURE_THRESHOLD && absDy > absDx * 1.15;
      },
      onPanResponderGrant: () => {
        scrollGestureLastDyRef.current = 0;
      },
      onPanResponderMove: (_event, gesture) => {
        const deltaY = scrollGestureLastDyRef.current - gesture.dy;
        scrollGestureLastDyRef.current = gesture.dy;
        if (Math.abs(deltaY) >= 0.5) {
          postToWeb({ type: "scrollBy", deltaY });
        }
      },
      onPanResponderRelease: () => {
        scrollGestureLastDyRef.current = 0;
      },
      onPanResponderTerminate: () => {
        scrollGestureLastDyRef.current = 0;
      },
      onPanResponderTerminationRequest: () => true,
    })
  ).current;

  useEffect(() => {
    activeTargetRef.current = targetId;
    lastResizeRef.current = undefined;
    // Re-arm the launch skeleton for the newly selected session until it paints.
    if (loadingFallbackRef.current) {
      clearTimeout(loadingFallbackRef.current);
      loadingFallbackRef.current = undefined;
    }
    if (targetId) {
      setRendered(false);
      loadingFallbackRef.current = setTimeout(() => setRendered(true), LOADING_FALLBACK_MS);
    } else {
      setRendered(true);
    }
    return () => {
      if (loadingFallbackRef.current) {
        clearTimeout(loadingFallbackRef.current);
        loadingFallbackRef.current = undefined;
      }
    };
  }, [targetId]);

  useEffect(() => {
    activeSessionRef.current = session;
    if (webReadyRef.current) {
      postSession();
    }
  }, [postSession, session?.id, session?.source, session?.cols, session?.rows]);

  useEffect(() => {
    keyboardInsetRef.current = keyboardInset;
    if (webReadyRef.current) {
      postToWeb({ type: "keyboardInset", height: keyboardInset });
    }
  }, [keyboardInset, postToWeb]);

  useEffect(() => {
    return () => {
      clearFitTimers();
    };
  }, [clearFitTimers]);

  useImperativeHandle(
    ref,
    () => ({
      fitToViewport: requestTerminalFit,
      focusTerminal: () => postToWeb({ type: "focus" }),
      blurTerminal: () => postToWeb({ type: "blur" }),
      resizeForMobileInput: () => requestTerminalFit(),
    }),
    [postToWeb, requestTerminalFit]
  );

  // Render snapshots/output for the active session into the WebView.
  useEffect(() => {
    const off = terminalSocket.onMessage((message: ServerMessage) => {
      if (!webReadyRef.current) {
        return;
      }
      if (message.type === "snapshot" && message.sessionId === activeTargetRef.current) {
        postToWeb({ type: "reset" });
        if (message.screen) {
          postToWeb({ type: "write", data: message.screen });
          setRendered(true);
        } else {
          for (const chunk of message.chunks) {
            postToWeb({ type: "write", data: chunk.data });
          }
          if (message.chunks.length > 0) {
            setRendered(true);
          }
        }
      }
      if (message.type === "output" && message.sessionId === activeTargetRef.current) {
        postToWeb({ type: "write", data: message.data });
        setRendered(true);
      }
    });
    return off;
  }, [postToWeb]);

  // Subscribe to the active session once both the WebView and socket are ready.
  useEffect(() => {
    if (!webReady || socketStatus !== "open" || !targetId) {
      return;
    }
    if (subscribedTargetRef.current !== targetId) {
      postToWeb({ type: "reset" });
      subscribedTargetRef.current = targetId;
    }
    postSession();
    terminalSocket.send({ type: "subscribe", sessionId: targetId });
  }, [webReady, socketStatus, targetId, postToWeb, postSession]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    const target = activeTargetRef.current;
    switch (message.type) {
      case "ready": {
        webReadyRef.current = true;
        setWebReady(true);
        postToWeb({ type: "keyboardInset", height: keyboardInsetRef.current });
        postSession();
        requestTerminalFit();
        break;
      }
      case "input": {
        if (target) {
          terminalSocket.send({ type: "input", sessionId: target, data: String(message.data ?? "") });
        }
        break;
      }
      case "resize":
      case "viewport": {
        const dims = parseWebDims(message.cols, message.rows);
        if (dims) {
          forwardResize(dims);
        }
        break;
      }
      case "scroll": {
        setScroll({ canScroll: Boolean(message.canScroll), atBottom: Boolean(message.atBottom) });
        break;
      }
      case "log": {
        // Surface engine diagnostics in the Metro/dev console.
        // eslint-disable-next-line no-console
        console.log("[terminal]", message.message);
        break;
      }
      default:
        break;
    }
  }, [forwardResize, postSession, postToWeb, requestTerminalFit]);

  return (
    <View
      ref={containerRef}
      collapsable={false}
      style={styles.container}
      onLayout={requestTerminalFit}
      {...scrollResponder.panHandlers}
    >
      <WebView
        ref={webRef}
        source={{ html: TERMINAL_HTML }}
        originWhitelist={["*"]}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        overScrollMode="never"
        scrollEnabled={false}
        bounces={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        automaticallyAdjustContentInsets={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        style={styles.web}
        containerStyle={styles.web}
        androidLayerType="hardware"
        onContentProcessDidTerminate={() => {
          webReadyRef.current = false;
          subscribedTargetRef.current = undefined;
          setWebReady(false);
          webRef.current?.reload();
        }}
      />

      {scroll.canScroll && !scroll.atBottom ? (
        <Pressable style={({ pressed }) => [styles.jump, pressed && styles.jumpPressed]} onPress={() => postToWeb({ type: "scrollToBottom" })} hitSlop={8}>
          <Text style={styles.jumpText}>↓ Latest</Text>
        </Pressable>
      ) : null}

      {socketStatus === "open" && targetId && !rendered && !suppressLoading ? <TerminalLoading session={session} /> : null}

      {socketStatus !== "open" ? (
        <View style={styles.reconnect} pointerEvents="none">
          <Text style={styles.reconnectText}>Reconnecting…</Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.terminal,
  },
  web: {
    flex: 1,
    backgroundColor: colors.terminal,
  },
  jump: {
    position: "absolute",
    bottom: 12,
    right: 12,
    zIndex: 1,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  jumpPressed: {
    backgroundColor: colors.primaryDim,
  },
  jumpText: {
    color: colors.primaryForeground,
    fontSize: 12,
    fontFamily: font.bold,
  },
  reconnect: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 2,
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  reconnectText: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.semibold,
  },
});

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, type LayoutChangeEvent, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { terminalSocket, type SocketStatus } from "../lib/socket";
import type { ServerMessage, TerminalSessionSummary } from "../types";
import { TERMINAL_HTML } from "../terminalHtml";
import { colors, font, glass, radius } from "../theme";
import { Acrylic } from "./Acrylic";
import { TerminalLoading } from "./TerminalLoading";

// Hard cap on how long the cold-start skeleton lingers if a session never prints.
const LOADING_FALLBACK_MS = 4000;

export interface TerminalViewHandle {
  fitToViewport: () => void;
  /**
   * While enabled, the page holds ghostty's hidden textarea focused so the soft
   * keyboard stays open (refocusing on any blur attempt). Disabling blurs and
   * lets the keyboard dismiss (e.g. while the sessions drawer is open).
   */
  setKeepFocus: (enabled: boolean) => void;
  resizeForMobileInput: () => void;
  /** Force a full all-rows repaint (e.g. after the app returns to foreground). */
  repaint: () => void;
}

interface TerminalViewProps {
  targetId?: string;
  session?: TerminalSessionSummary;
  socketStatus: SocketStatus;
  // While the session switcher is scrubbing we live-preview each session; hide
  // the launch skeleton so the real terminal content is visible as it flips.
  suppressLoading?: boolean;
}

interface HostLayout {
  width: number;
  height: number;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { targetId, session, socketStatus, suppressLoading = false },
  ref
) {
  const webRef = useRef<WebView | null>(null);
  const containerRef = useRef<View | null>(null);
  const webReadyRef = useRef(false);
  const [webReady, setWebReady] = useState(false);
  const activeTargetRef = useRef<string | undefined>(targetId);
  const activeSessionRef = useRef<TerminalSessionSummary | undefined>(session);
  const subscribedTargetRef = useRef<string | undefined>(undefined);
  // The session id whose grid dims the WebView is currently mirroring. Set when
  // a snapshot posts its own dims; used to defer dim changes for a NEW session
  // until its snapshot arrives (posting them early reflows the old content).
  const postedSessionIdRef = useRef<string | undefined>(undefined);
  const hostLayoutRef = useRef<HostLayout | undefined>(undefined);
  // Last keep-focus request from the host; re-posted after a WebView (re)load so
  // a crashed/reloaded page comes back with the keyboard held open again.
  const keepFocusRef = useRef(false);
  const fitTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [scroll, setScroll] = useState({ canScroll: false, atBottom: true });
  // Whether the WebView currently has ANY terminal content on screen. This is a
  // cold-start flag, not a per-session one: it starts false on first mount and
  // flips back to false only when the page is genuinely blank again (WebView
  // process crash/reload). It deliberately does NOT reset on session switch,
  // socket reconnect, foreground repaints, or fit/resize churn — in all of those
  // the previous frame stays visible until the next snapshot swaps atomically,
  // so a loading skeleton would just flash over real content.
  const [rendered, setRendered] = useState(false);
  // Jump-to-latest fades in/out instead of popping; kept mounted while the
  // exit fade plays.
  const [jumpMounted, setJumpMounted] = useState(false);
  const jumpFade = useRef(new Animated.Value(0)).current;

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

  // Note: the phone deliberately never sends { type: "resize" } to the server.
  // It MIRRORS the host session's grid (the desktop owns the real PTY size) and
  // scales the canvas to fit — driving the real PTY from here would resize the
  // user's desktop terminal.

  const postSession = useCallback(() => {
    const current = activeSessionRef.current;
    postToWeb({ type: "session", cols: current?.cols, rows: current?.rows });
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

  // Touch gestures (one-finger scroll/pan, tap-to-focus, two-finger pinch)
  // are owned by the page inside the WebView — it knows the canvas
  // bounds/scale. The native layer owns the SwipeBar above the command bar
  // (session scrubbing only, see SwipeBar/SessionSwitcher) and posting
  // hostLayout/fit on layout changes.

  useEffect(() => {
    activeTargetRef.current = targetId;
  }, [targetId]);

  // Cold-start skeleton fallback: while nothing has ever painted (or the page
  // came back blank after a crash) and a session is selected, cap how long the
  // skeleton can linger if that session never prints. Session switches do NOT
  // reset `rendered` — the old frame stays up until the new snapshot paints, so
  // switching feels instant with no loading flash.
  useEffect(() => {
    if (rendered || !targetId) {
      return;
    }
    const timer = setTimeout(() => setRendered(true), LOADING_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [rendered, targetId]);

  useEffect(() => {
    activeSessionRef.current = session;
    // Only live-sync grid dims for the session the WebView is already showing
    // (e.g. the host window was resized). A newly selected session's dims are
    // posted by the snapshot handler, atomically with the reset+write — posting
    // them here first would reflow the still-displayed OLD content into the new
    // grid and flash a corrupted frame during session scrubbing.
    if (webReadyRef.current && session && postedSessionIdRef.current === session.id) {
      postSession();
    }
  }, [postSession, session?.id, session?.source, session?.cols, session?.rows]);

  useEffect(() => {
    return () => {
      clearFitTimers();
    };
  }, [clearFitTimers]);

  const showJump = scroll.canScroll && !scroll.atBottom;
  useEffect(() => {
    if (showJump) {
      setJumpMounted(true);
      Animated.timing(jumpFade, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(jumpFade, {
      toValue: 0,
      duration: 150,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setJumpMounted(false);
      }
    });
  }, [showJump, jumpFade]);

  useImperativeHandle(
    ref,
    () => ({
      fitToViewport: requestTerminalFit,
      setKeepFocus: (enabled: boolean) => {
        keepFocusRef.current = enabled;
        if (enabled) {
          // Android only raises the soft keyboard for a focused WebView, so make
          // sure the native view itself has focus before the page focuses ghostty.
          webRef.current?.requestFocus();
        }
        postToWeb({ type: "keepFocus", enabled });
      },
      resizeForMobileInput: () => requestTerminalFit(),
      repaint: () => postToWeb({ type: "repaint" }),
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
        // Size the grid to the exact dimensions this snapshot was rendered for
        // (the host owns the width) before clearing + writing, so the bytes land
        // without re-wrapping. This is the ONLY place a new session's dims are
        // posted — doing it here keeps the resize atomic with the reset+write.
        if (message.session) {
          postToWeb({ type: "session", cols: message.session.cols, rows: message.session.rows });
          postedSessionIdRef.current = message.sessionId;
        }
        postToWeb({ type: "reset" });
        if (message.screen) {
          // Prefer the server's rendered screen dump: it reproduces the full
          // grid exactly as the host shows it.
          postToWeb({ type: "write", data: message.screen });
          setRendered(true);
        } else {
          // Fallback only: chunks are a bounded tail of the raw transcript, so
          // replaying them can miss content that scrolled out of the buffer.
          for (const chunk of message.chunks) {
            postToWeb({ type: "write", data: chunk.data });
          }
          if (message.chunks.length > 0) {
            setRendered(true);
          }
        }
        // Cold start / session switch: the snapshot write can land while the
        // WebView surface is still settling (first composite, keyboard raise
        // resizing the view), which wipes the canvas after the dirty rows were
        // already painted — leaving a blank terminal until fresh output
        // arrives. Chase the write with the staggered full-repaint heal.
        postToWeb({ type: "repaint" });
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
    // Don't reset or post the new session's dims here — keep the current frame
    // (and grid) until the new session's snapshot arrives and sizes+clears+
    // writes atomically (the snapshot handler posts session dims right before
    // reset+write). Resizing early would reflow the still-visible old content;
    // resetting early would flash blank. The launch skeleton covers the gap
    // until the new session paints.
    subscribedTargetRef.current = targetId;
    terminalSocket.send({ type: "subscribe", sessionId: targetId });
  }, [webReady, socketStatus, targetId]);

  // The WebView's renderer process died (OS reclaimed it) — the page is
  // genuinely blank now, so this is the ONE post-mount path that re-arms the
  // cold-start skeleton. Reload and let the ready → subscribe → snapshot chain
  // repaint and clear it.
  const onWebViewProcessGone = useCallback(() => {
    webReadyRef.current = false;
    subscribedTargetRef.current = undefined;
    postedSessionIdRef.current = undefined;
    setWebReady(false);
    setRendered(false);
    webRef.current?.reload();
  }, []);

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
        // The page is blank at this point, so posting the active session's dims
        // is safe (nothing to reflow) and gives the grid a sane initial size
        // until the snapshot arrives.
        postedSessionIdRef.current = activeSessionRef.current?.id;
        postSession();
        requestTerminalFit();
        // A fresh page booted with keepFocus off — restore the host's wish so
        // the keyboard comes straight back up after a WebView reload.
        if (keepFocusRef.current) {
          postToWeb({ type: "keepFocus", enabled: true });
        }
        break;
      }
      case "input": {
        if (target) {
          terminalSocket.send({ type: "input", sessionId: target, data: String(message.data ?? "") });
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
  }, [postSession, postToWeb, requestTerminalFit]);

  return (
    <View
      ref={containerRef}
      collapsable={false}
      style={styles.container}
      onLayout={requestTerminalFit}
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
        onContentProcessDidTerminate={onWebViewProcessGone}
        onRenderProcessGone={onWebViewProcessGone}
      />

      {jumpMounted ? (
        <Animated.View style={[styles.jumpWrap, { opacity: jumpFade }]} pointerEvents={showJump ? "auto" : "none"}>
          <Pressable
            style={({ pressed }) => [styles.jump, pressed && styles.jumpPressed]}
            onPress={() => postToWeb({ type: "scrollToBottom" })}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Jump to latest output"
          >
            <Text style={styles.jumpText}>↓ Latest</Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* Cold-start skeleton only: first-ever paint or a post-crash blank page.
          Never shown for session switches, reconnects, or repaints (see the
          `rendered` flag above). */}
      {socketStatus === "open" && targetId && !rendered && !suppressLoading ? <TerminalLoading session={session} /> : null}

      {/* Informative (non-blocking) pill while the socket is actually down and
          retrying. "idle" is an intentional disconnect — no pill. */}
      {socketStatus === "connecting" || socketStatus === "closed" ? (
        <View style={styles.statusPill} pointerEvents="none" accessibilityLiveRegion="polite">
          <Acrylic />
          <View style={[styles.statusDot, styles.reconnectDot]} />
          <Text style={styles.statusText}>Reconnecting…</Text>
        </View>
      ) : null}

      {socketStatus === "open" && session?.status === "exited" ? (
        <View style={[styles.statusPill, styles.exited]} pointerEvents="none" accessibilityLiveRegion="polite">
          <Acrylic />
          <View style={[styles.statusDot, styles.exitedDot]} />
          <Text style={styles.statusText}>
            Session ended{typeof session.exitCode === "number" ? ` · exit ${session.exitCode}` : ""}
          </Text>
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
  jumpWrap: {
    position: "absolute",
    bottom: 12,
    right: 12,
    zIndex: 1,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  jump: {
    // Filled accent button (WinUI dark: light accent fill, near-black text).
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    elevation: 3,
  },
  jumpPressed: {
    backgroundColor: colors.primaryDim,
  },
  jumpText: {
    color: colors.primaryForeground,
    fontSize: 12,
    fontFamily: font.semibold,
  },
  // Shared state pill: acrylic like the rest of the floating chrome (a solid
  // card over live output read heavier than the toast/command bar), with a
  // semantic-hue dot so the state reads before the text does.
  statusPill: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    // Clips the Acrylic backing to the rounded corners.
    overflow: "hidden",
    borderColor: glass.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  exited: {
    right: undefined,
    // Clears the floating menu button that overlays the terminal's top-left.
    left: 60,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  reconnectDot: {
    // Caution amber: transient trouble, not a dead session.
    backgroundColor: colors.accentAmber,
  },
  exitedDot: {
    backgroundColor: colors.destructive,
  },
  statusText: {
    color: colors.secondaryForeground,
    fontSize: 12,
    fontFamily: font.regular,
  },
});

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { terminalSocket, type SocketStatus } from "../lib/socket";
import type { ServerMessage, TerminalSessionSummary } from "../types";
import { TERMINAL_HTML } from "../terminalHtml";
import { colors, font, radius } from "../theme";

export interface TerminalViewHandle {
  focusTerminal: () => void;
}

interface TerminalViewProps {
  targetId?: string;
  session?: TerminalSessionSummary;
  socketStatus: SocketStatus;
}

interface WebDims {
  cols: number;
  rows: number;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { targetId, session, socketStatus },
  ref
) {
  const webRef = useRef<WebView | null>(null);
  const webReadyRef = useRef(false);
  const [webReady, setWebReady] = useState(false);
  const activeTargetRef = useRef<string | undefined>(targetId);
  const activeSessionRef = useRef<TerminalSessionSummary | undefined>(session);
  const subscribedTargetRef = useRef<string | undefined>(undefined);
  const dimsRef = useRef<WebDims | undefined>(undefined);
  const [scroll, setScroll] = useState({ canScroll: false, atBottom: true });

  const postToWeb = useCallback((message: Record<string, unknown>) => {
    if (!webRef.current) {
      return;
    }
    const json = JSON.stringify(message);
    // Double-encode so arbitrary terminal bytes survive as a JS string literal.
    webRef.current.injectJavaScript(`window.onHostMessage(${JSON.stringify(json)});true;`);
  }, []);

  useEffect(() => {
    activeTargetRef.current = targetId;
  }, [targetId]);

  useEffect(() => {
    activeSessionRef.current = session;
    if (webReadyRef.current) {
      postToWeb({
        type: "session",
        source: session?.source,
        cols: session?.cols,
        rows: session?.rows,
      });
    }
  }, [postToWeb, session?.id, session?.source, session?.cols, session?.rows]);

  useImperativeHandle(
    ref,
    () => ({
      focusTerminal: () => postToWeb({ type: "focus" }),
    }),
    [postToWeb]
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
        } else {
          for (const chunk of message.chunks) {
            postToWeb({ type: "write", data: chunk.data });
          }
        }
      }
      if (message.type === "output" && message.sessionId === activeTargetRef.current) {
        postToWeb({ type: "write", data: message.data });
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
    postToWeb({
      type: "session",
      source: session?.source,
      cols: session?.cols,
      rows: session?.rows,
    });
    terminalSocket.send({ type: "subscribe", sessionId: targetId });
    if (dimsRef.current && session?.source !== "bridged") {
      terminalSocket.send({ type: "resize", sessionId: targetId, cols: dimsRef.current.cols, rows: dimsRef.current.rows });
    }
  }, [webReady, socketStatus, targetId, postToWeb, session?.source, session?.cols, session?.rows]);

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
        dimsRef.current = { cols: Number(message.cols), rows: Number(message.rows) };
        webReadyRef.current = true;
        setWebReady(true);
        postToWeb({
          type: "session",
          source: activeSessionRef.current?.source,
          cols: activeSessionRef.current?.cols,
          rows: activeSessionRef.current?.rows,
        });
        break;
      }
      case "input": {
        if (target) {
          terminalSocket.send({ type: "input", sessionId: target, data: String(message.data ?? "") });
        }
        break;
      }
      case "resize": {
        const cols = Number(message.cols);
        const rows = Number(message.rows);
        dimsRef.current = { cols, rows };
        if (target && activeSessionRef.current?.source !== "bridged") {
          terminalSocket.send({ type: "resize", sessionId: target, cols, rows });
        }
        break;
      }
      case "scroll": {
        setScroll({ canScroll: Boolean(message.canScroll), atBottom: Boolean(message.atBottom) });
        break;
      }
      default:
        break;
    }
  }, [postToWeb]);

  return (
    <View style={styles.container}>
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
        automaticallyAdjustContentInsets={false}
        keyboardDisplayRequiresUserAction={false}
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

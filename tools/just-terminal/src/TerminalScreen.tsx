import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  type KeyboardEvent,
  type KeyboardMetrics,
  type LayoutChangeEvent,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurTargetView } from "expo-blur";
import { CommandBar } from "./components/CommandBar";
import { Header } from "./components/Header";
import { SessionsDrawer, type CreateSpec } from "./components/SessionsDrawer";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { TerminalView, type TerminalViewHandle } from "./components/TerminalView";
import { TerminalEmptyState } from "./components/TerminalEmptyState";
import { useDictation } from "./useDictation";
import { createSession as createSessionApi } from "./lib/api";
import type { ServerEndpoint } from "./lib/endpoint";
import { terminalSocket, type SocketStatus } from "./lib/socket";
import { forgetCwd, loadRecentCwds, rememberCwd } from "./lib/storage";
import type { ServerInfo, ServerMessage, TerminalProfile, TerminalSessionSummary } from "./types";
import { colors, font } from "./theme";

interface TerminalScreenProps {
  endpoint: ServerEndpoint;
  onDisconnect: () => void;
}

function dockedKeyboardHeight(metrics: KeyboardMetrics | undefined | null, windowHeight: number): number {
  if (!metrics || metrics.height <= 0) {
    return 0;
  }

  // SDK 56 (RN 0.85) renders edge-to-edge, so the soft keyboard OVERLAYS the
  // window instead of resizing it — on Android too (the old softwareKeyboardLayoutMode
  // "resize" is now a no-op). So we always shift content up by the keyboard's
  // occluded height ourselves. On Android the keyboard is docked at the bottom,
  // so its reported height is the full inset.
  if (Platform.OS === "android") {
    // Use the occluded span (window bottom minus the keyboard's top edge) so the
    // command bar clears the whole keyboard including its suggestion strip, which
    // `height` alone can omit. Fall back to height if screenY looks unset.
    const occluded = Math.round(windowHeight - metrics.screenY);
    return occluded > metrics.height ? occluded : Math.round(metrics.height);
  }

  const keyboardBottom = metrics.screenY + metrics.height;
  const overlapsBottomEdge = keyboardBottom >= windowHeight - 24;
  if (!overlapsBottomEdge) {
    return 0;
  }

  const overlapHeight = Math.max(0, windowHeight - metrics.screenY);
  return Math.round(Math.min(metrics.height, overlapHeight));
}

function keyboardVisibleFromMetrics(metrics: KeyboardMetrics | undefined | null, windowHeight: number): boolean {
  if (!metrics || metrics.height <= 0) {
    return false;
  }
  if (Platform.OS === "android") {
    return true;
  }

  return dockedKeyboardHeight(metrics, windowHeight) > 0;
}

function shellName(session?: TerminalSessionSummary) {
  if (!session) return "";
  return session.shell.split(/[\\/]/).pop() ?? session.shell;
}

function selectPreferredSessionId(sessions: TerminalSessionSummary[], currentId?: string): string | undefined {
  const current = sessions.find((session) => session.id === currentId);
  if (current?.status === "running") {
    return current.id;
  }

  return sessions.find((session) => session.status === "running")?.id ?? current?.id ?? sessions[0]?.id;
}

export function TerminalScreen({ endpoint, onDisconnect }: TerminalScreenProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>();
  const [activeId, setActiveId] = useState<string | undefined>();
  const [socketStatus, setSocketStatus] = useState<SocketStatus>(terminalSocket.currentStatus);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [activeCwd, setActiveCwd] = useState<string | undefined>(undefined);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [commandBarHeight, setCommandBarHeight] = useState(0);
  // True while the session switcher is being scrubbed (live terminal preview).
  const [scrubbing, setScrubbing] = useState(false);
  // True while a new session is being created — the host can take a few seconds
  // to spawn/bridge a terminal, so we show a clear "starting" overlay.
  const [creating, setCreating] = useState(false);
  const activeIdRef = useRef<string | undefined>(activeId);
  const terminalRef = useRef<TerminalViewHandle | null>(null);
  const blurTargetRef = useRef<View | null>(null);
  const settleFrameRef = useRef<number | undefined>(undefined);
  const settleTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const syncTerminalToInput = useCallback(() => {
    terminalRef.current?.fitToViewport();
    terminalRef.current?.resizeForMobileInput();
  }, []);

  const clearTerminalSettle = useCallback(() => {
    if (settleFrameRef.current !== undefined) {
      cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = undefined;
    }
    for (const timer of settleTimersRef.current) {
      clearTimeout(timer);
    }
    settleTimersRef.current = [];
  }, []);

  const settleTerminalToInput = useCallback(() => {
    clearTerminalSettle();
    syncTerminalToInput();
    settleFrameRef.current = requestAnimationFrame(() => {
      settleFrameRef.current = undefined;
      syncTerminalToInput();
    });
    settleTimersRef.current = [80, 180, Platform.OS === "ios" ? 320 : 220].map((delay) =>
      setTimeout(syncTerminalToInput, delay)
    );
  }, [clearTerminalSettle, syncTerminalToInput]);

  const syncKeyboardMetrics = useCallback(() => {
    const metrics = Keyboard.metrics();
    const nextHeight = dockedKeyboardHeight(metrics, windowHeight);
    setKeyboardHeight(nextHeight);
    setKeyboardVisible(keyboardVisibleFromMetrics(metrics, windowHeight));
    settleTerminalToInput();
  }, [settleTerminalToInput, windowHeight]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    setActiveId((current) => {
      const preferred = selectPreferredSessionId(sessions, current);
      return preferred === current ? current : preferred;
    });
  }, [sessions]);

  useEffect(() => {
    settleTerminalToInput();
  }, [keyboardHeight, keyboardVisible, commandBarHeight, settleTerminalToInput]);

  useEffect(() => clearTerminalSettle, [clearTerminalSettle]);

  useEffect(() => {
    const applyKeyboardFrame = (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      const nextHeight = dockedKeyboardHeight(event.endCoordinates, windowHeight);
      setKeyboardHeight(nextHeight);
      setKeyboardVisible(keyboardVisibleFromMetrics(event.endCoordinates, windowHeight));
      settleTerminalToInput();
    };

    const hideKeyboard = (event?: KeyboardEvent) => {
      if (event) {
        Keyboard.scheduleLayoutAnimation(event);
      }
      setKeyboardHeight(0);
      setKeyboardVisible(false);
      settleTerminalToInput();
    };

    syncKeyboardMetrics();

    const showSub = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow", applyKeyboardFrame);
    const frameSettledSub =
      Platform.OS === "ios" ? Keyboard.addListener("keyboardDidChangeFrame", applyKeyboardFrame) : undefined;
    const hideSub = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", hideKeyboard);
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        requestAnimationFrame(syncKeyboardMetrics);
        settleTerminalToInput();
        // ghostty-web's render loop only repaints dirty rows and pauses while the
        // app is backgrounded, so the terminal can return fragmented (mostly
        // blank). Force a full repaint once the surface is back.
        requestAnimationFrame(() => terminalRef.current?.repaint());
      }
    });

    return () => {
      showSub.remove();
      frameSettledSub?.remove();
      hideSub.remove();
      appStateSub.remove();
    };
  }, [settleTerminalToInput, syncKeyboardMetrics, windowHeight]);

  useEffect(() => {
    let mounted = true;
    loadRecentCwds(endpoint.id).then((cwds) => {
      if (!mounted) {
        return;
      }
      setRecentCwds(cwds);
      setActiveCwd(cwds[0]); // saved default for this host (undefined if none)
    });
    return () => {
      mounted = false;
    };
  }, [endpoint.id]);

  const upsertSession = useCallback((session: TerminalSessionSummary) => {
    setSessions((current) => {
      const exists = current.some((item) => item.id === session.id);
      return exists ? current.map((item) => (item.id === session.id ? session : item)) : [...current, session];
    });
  }, []);

  useEffect(() => {
    const offStatus = terminalSocket.onStatus(setSocketStatus);
    const offMessage = terminalSocket.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case "hello":
          setSessions(message.sessions);
          setProfiles(message.profiles);
          setServerInfo(message.server);
          setActiveId((current) => current ?? message.sessions[0]?.id);
          break;
        case "sessions":
          setSessions(message.sessions);
          setActiveId((current) => current ?? message.sessions[0]?.id);
          break;
        case "session":
          upsertSession(message.session);
          break;
        case "exit":
          upsertSession(message.session);
          break;
        case "output":
          if (message.sessionId !== activeIdRef.current) {
            setUnread((current) => ({ ...current, [message.sessionId]: (current[message.sessionId] ?? 0) + 1 }));
          }
          break;
        default:
          break;
      }
    });
    return () => {
      offStatus();
      offMessage();
    };
  }, [upsertSession]);

  const activeSession = useMemo(() => sessions.find((item) => item.id === activeId), [sessions, activeId]);

  // On-device voice dictation: recognized phrases are injected into the active
  // session as input (no auto-Enter — the user reviews, then runs).
  const injectDictatedText = useCallback((text: string) => {
    const id = activeIdRef.current;
    if (id) {
      terminalSocket.send({ type: "input", sessionId: id, data: `${text} ` });
    }
  }, []);

  const dictation = useDictation({
    onText: injectDictatedText,
    enabled: socketStatus === "open" && activeSession?.status === "running",
  });

  const selectSession = useCallback((id: string) => {
    setActiveId(id);
    setUnread((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDrawerOpen(false);
  }, []);

  const createSession = useCallback(
    async (spec?: CreateSpec) => {
      setDrawerOpen(false);
      const options = { ...(spec ?? {}), ...(activeCwd ? { cwd: activeCwd } : {}) };
      setCreating(true);
      try {
        const session = await createSessionApi(endpoint, options);
        upsertSession(session);
        selectSession(session.id);
        if (activeCwd) {
          rememberCwd(endpoint.id, activeCwd).then(setRecentCwds);
        }
      } catch {
        terminalSocket.send({ type: "create", ...options });
      } finally {
        setCreating(false);
      }
    },
    [endpoint, selectSession, activeCwd, upsertSession]
  );

  const killSession = useCallback((id: string) => {
    terminalSocket.send({ type: "kill", sessionId: id });
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    terminalSocket.send({ type: "rename", sessionId: id, title });
  }, []);

  const setCwd = useCallback(
    (cwd?: string) => {
      setActiveCwd(cwd);
      if (cwd) {
        rememberCwd(endpoint.id, cwd).then(setRecentCwds);
      }
    },
    [endpoint.id]
  );

  const forgetCwdEntry = useCallback(
    (cwd: string) => {
      forgetCwd(endpoint.id, cwd).then((next) => {
        setRecentCwds(next);
        setActiveCwd((current) => (current === cwd ? undefined : current));
      });
    },
    [endpoint.id]
  );

  const headerTitle = activeSession?.title ?? "Terminal";
  const headerMeta = activeSession
    ? `${activeSession.cwd} · pid ${activeSession.pid ?? "—"}`
    : socketStatus === "open"
      ? "No active session"
      : "Connecting…";
  const commandBarBottom = keyboardHeight;
  // The terminal stays full-size when the keyboard appears (no resize). Reserve
  // only the constant tools-bar height; the keyboard is handled by shifting the
  // terminal view up (keyboardInset) so the input stays visible.
  const terminalBottomInset = commandBarHeight;
  const keyboardInset = keyboardVisible ? keyboardHeight + 28 : 0;

  const handleCommandBarLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setCommandBarHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);

  return (
    <View style={styles.root}>
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surface }}>
        <Header
          title={headerTitle}
          meta={headerMeta}
          socketStatus={socketStatus}
          canKill={Boolean(activeSession && activeSession.status === "running")}
          keyboardVisible={keyboardVisible}
          onMenu={() => setDrawerOpen(true)}
          onFocus={() => {
            terminalRef.current?.focusTerminal();
            settleTerminalToInput();
          }}
          onHideKeyboard={() => {
            Keyboard.dismiss();
            terminalRef.current?.blurTerminal();
          }}
          onNew={() => createSession()}
          onKill={() => activeId && killSession(activeId)}
        />
      </View>

      <View style={styles.body}>
        <BlurTargetView ref={blurTargetRef} style={styles.blurTarget}>
          <View style={[styles.terminalWrap, { marginBottom: terminalBottomInset }]}>
            <TerminalView
              ref={terminalRef}
              targetId={activeId}
              session={activeSession}
              socketStatus={socketStatus}
              suppressLoading={scrubbing}
              keyboardInset={keyboardInset}
            />
            <SessionSwitcher
              sessions={sessions}
              activeId={activeId}
              unread={unread}
              onSelect={selectSession}
              onRequestList={() => setDrawerOpen(true)}
              onPreview={(id) => setActiveId(id)}
              onScrubbingChange={setScrubbing}
            />
            {socketStatus === "open" && sessions.length === 0 ? (
              <TerminalEmptyState
                profiles={profiles}
                onCreate={createSession}
                onOpenMenu={() => setDrawerOpen(true)}
              />
            ) : null}
          </View>
        </BlurTargetView>
        <View style={[styles.commandBarDock, { bottom: commandBarBottom }]} onLayout={handleCommandBarLayout}>
          <CommandBar
            targetId={activeId}
            sessionStatus={activeSession?.status}
            socketStatus={socketStatus}
            bottomInset={keyboardVisible ? 0 : insets.bottom}
            keyboardVisible={keyboardVisible}
            blurTarget={blurTargetRef}
            dictation={{
              status: dictation.status,
              active: dictation.active,
              level: dictation.level,
              speaking: dictation.speaking,
              lastText: dictation.lastText,
              downloadPercent: dictation.downloadPercent,
              error: dictation.error,
              modelLabel: dictation.modelLabel,
              onStart: dictation.start,
              onStop: dictation.stop,
            }}
          />
        </View>

        {creating ? (
          <View style={styles.creatingOverlay}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={styles.creatingText}>Starting session…</Text>
          </View>
        ) : null}
      </View>

      <SessionsDrawer
        visible={drawerOpen}
        sessions={sessions}
        profiles={profiles}
        activeId={activeId}
        unread={unread}
        serverHost={endpoint.label ? `${endpoint.label} · ${endpoint.host}` : endpoint.host}
        activeCwd={activeCwd}
        recentCwds={recentCwds}
        onClose={() => setDrawerOpen(false)}
        onSelect={selectSession}
        onCreate={createSession}
        onKill={killSession}
        onRename={renameSession}
        onDisconnect={onDisconnect}
        onSetCwd={setCwd}
        onForgetCwd={forgetCwdEntry}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  body: {
    flex: 1,
    position: "relative",
    backgroundColor: colors.background,
  },
  blurTarget: {
    flex: 1,
  },
  terminalWrap: {
    flex: 1,
    overflow: "hidden",
  },
  commandBarDock: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  creatingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    backgroundColor: colors.overlay,
  },
  creatingText: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
});

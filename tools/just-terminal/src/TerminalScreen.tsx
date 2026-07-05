import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  Platform,
  Pressable,
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
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { CommandBar } from "./components/CommandBar";
import { SessionsScreen, type CreateSpec } from "./components/SessionsScreen";
import { SessionSwitcher, type SessionSwitcherHandle } from "./components/SessionSwitcher";
import { SwipeBar } from "./components/SwipeBar";
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

// Tones played when desktop automation POSTs /api/notify (Claude Code hooks):
// "done" = upbeat ascending chime, "attention"/"input" = gentle descending
// pair for "Claude needs you". Unknown/absent sound names fall back to done.
const doneChime = require("../assets/sounds/notify.wav");
const attentionChime = require("../assets/sounds/attention.wav");

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
  // Notification tones for server "notify" broadcasts; ref-wrapped so the
  // socket effect doesn't need the players in its dependency list.
  const donePlayer = useAudioPlayer(doneChime);
  const attentionPlayer = useAudioPlayer(attentionChime);
  const playNotifyRef = useRef<(sound?: string) => void>(() => undefined);
  useEffect(() => {
    playNotifyRef.current = (sound?: string) => {
      const wantsAttention = sound === "attention" || sound === "input" || sound === "warning";
      const player = wantsAttention ? attentionPlayer : donePlayer;
      try {
        player.seekTo(0);
        player.play();
      } catch {
        // Audio-session hiccups shouldn't take the app down.
      }
      Haptics.notificationAsync(
        wantsAttention ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success
      ).catch(() => undefined);
    };
  }, [donePlayer, attentionPlayer]);
  useEffect(() => {
    // Hook chimes should be audible even with the iOS silent switch on.
    // `allowsRecording: true` is load-bearing: this call configures the SHARED
    // audio session, and without it iOS drops the session to playback-only
    // (.playback instead of .playAndRecord), which intermittently kills the mic
    // capture the dictation engine needs. With allowsRecording set, playback
    // still routes through the speaker (shouldRouteThroughEarpiece defaults to
    // false), so the chime is unaffected.
    setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true }).catch(() => undefined);
  }, []);
  // Mirrors whether the soft keyboard should currently be held open, for
  // listeners (AppState) that live outside the deciding effect.
  const keepKeyboardOpenRef = useRef(false);
  const terminalRef = useRef<TerminalViewHandle | null>(null);
  // Session scrubber overlay (picker wheel); driven by the SwipeBar's gesture.
  const sessionSwitcherRef = useRef<SessionSwitcherHandle | null>(null);
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
        // Bring the persistent keyboard straight back after backgrounding.
        terminalRef.current?.setKeepFocus(keepKeyboardOpenRef.current);
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
        case "notify":
          // Desktop-side automation (e.g. Claude Code hooks POSTing to
          // /api/notify) plays a tone + haptic on the phone.
          playNotifyRef.current(message.sound);
          break;
        case "session":
          upsertSession(message.session);
          break;
        case "exit":
          upsertSession(message.session);
          break;
        case "output":
        case "activity":
          // "activity" is the server's data-free ping for sessions this client
          // is NOT subscribed to — full output only streams for the active one.
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

  // Persistent keyboard: while a live session is connected, the terminal input
  // stays focused so the soft keyboard never collapses (the page refocuses on
  // any blur attempt). Opening the drawer releases it; closing re-engages it.
  const keepKeyboardOpen =
    !drawerOpen && !creating && socketStatus === "open" && activeSession?.status === "running";
  useEffect(() => {
    keepKeyboardOpenRef.current = keepKeyboardOpen;
    terminalRef.current?.setKeepFocus(keepKeyboardOpen);
    if (keepKeyboardOpen) {
      settleTerminalToInput();
    }
  }, [keepKeyboardOpen, settleTerminalToInput]);

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

  const commandBarBottom = keyboardHeight;
  // When the keyboard opens, shrink the terminal so it sits fully ABOVE the
  // command bar + keyboard and reflows to fewer rows. The old approach shifted
  // the whole canvas up by the keyboard height instead, which slid the top rows
  // up off screen with no way to scroll them back (alt-screen TUIs like
  // Claude/Codex have no scrollback). Reserving the keyboard height as bottom
  // inset keeps every row on screen between the status bar and the keyboard.
  const terminalBottomInset = commandBarHeight + (keyboardVisible ? keyboardHeight : 0);

  const handleCommandBarLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setCommandBarHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        <BlurTargetView ref={blurTargetRef} style={styles.blurTarget}>
          {/* No header: the terminal owns the whole screen. The safe-area top is
              padded INSIDE the terminal wrap so text clears the notch while the
              surface itself runs edge to edge. */}
          <View style={[styles.terminalWrap, { paddingTop: insets.top, marginBottom: terminalBottomInset }]}>
            <TerminalView
              ref={terminalRef}
              targetId={activeId}
              session={activeSession}
              socketStatus={socketStatus}
              suppressLoading={scrubbing}
            />
            {/* Scrub picker overlay (visual only; the SwipeBar below owns the
                gesture and drives it through the imperative handle). */}
            <SessionSwitcher
              ref={sessionSwitcherRef}
              sessions={sessions}
              activeId={activeId}
              unread={unread}
              onSelect={selectSession}
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
          {/* Terminal switcher bar between the terminal and the command bar:
              swipe left/right to scrub sessions (release switches), tap for the
              sessions drawer. Scrolling the terminal is a vertical drag on the
              terminal surface itself, not here. Inside the dock so its height
              is part of commandBarHeight (the terminal reserves space above it). */}
          {activeSession ? (
            <SwipeBar
              sessionCount={sessions.length}
              activeIndex={sessions.findIndex((item) => item.id === activeId)}
              onTap={() => setDrawerOpen(true)}
              onScrubBegin={() => sessionSwitcherRef.current?.begin() ?? false}
              onScrubMove={(steps) => sessionSwitcherRef.current?.moveBy(steps)}
              onScrubEnd={(commit) => sessionSwitcherRef.current?.finish(commit)}
            />
          ) : null}
          <CommandBar
            targetId={activeId}
            sessionStatus={activeSession?.status}
            socketStatus={socketStatus}
            bottomInset={keyboardVisible ? 0 : insets.bottom}
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

        {/* The only chrome over the terminal: a mostly transparent menu button
            floating in the top-left, safe-area aware. */}
        <Pressable
          onPress={() => setDrawerOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open sessions menu"
          style={({ pressed }) => [styles.menuFab, { top: insets.top + 8 }, pressed && styles.menuFabPressed]}
        >
          <View style={styles.menuLine} />
          <View style={[styles.menuLine, styles.menuLineMid]} />
          <View style={styles.menuLine} />
        </Pressable>

        {creating ? (
          <View style={styles.creatingOverlay}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={styles.creatingText}>Starting session…</Text>
          </View>
        ) : null}
      </View>

      <SessionsScreen
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
    // Matches the terminal page background so the safe-area padding reads as
    // part of the console surface, not a bar.
    backgroundColor: colors.terminal,
  },
  menuFab: {
    position: "absolute",
    left: 10,
    zIndex: 6,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    gap: 3.5,
    backgroundColor: "rgba(10, 12, 16, 0.35)",
    borderColor: "rgba(255, 255, 255, 0.10)",
    borderWidth: 1,
  },
  menuFabPressed: {
    backgroundColor: "rgba(255, 255, 255, 0.13)",
  },
  menuLine: {
    width: 15,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.foreground,
  },
  menuLineMid: {
    width: 11,
    backgroundColor: colors.primary,
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
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
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import type { AcpBridgeState } from "./acpTypes";
import { AgentAttachSheet } from "./components/AgentAttachSheet";
import { AgentStatusBar } from "./components/AgentStatusBar";
import { AgentWorkspaceScreen } from "./components/AgentWorkspaceScreen";
import { AttachmentSheet } from "./components/AttachmentSheet";
import { CommandBar } from "./components/CommandBar";
import { Composer, type ComposerHandle } from "./components/Composer";
import { NotificationToast, type ToastNotification } from "./components/NotificationToast";
import { SessionsScreen, type CreateSpec } from "./components/SessionsScreen";
import { SessionSwitcher, type SessionSwitcherHandle } from "./components/SessionSwitcher";
import { SwipeBar } from "./components/SwipeBar";
import { TerminalView, type TerminalViewHandle } from "./components/TerminalView";
import { TerminalEmptyState } from "./components/TerminalEmptyState";
import { useDictation } from "./useDictation";
import { useInputContext } from "./useInputContext";
import { createSession as createSessionApi, fetchNotifications } from "./lib/api";
import {
  attachSessionAgent,
  fetchSessionAgent,
  type AgentLinkCandidate,
  type SessionAgentState,
} from "./lib/agentApi";
import { uploadImageFromDataUri, uploadImageFromUri } from "./lib/attachments";
import type { ServerEndpoint } from "./lib/endpoint";
import { terminalSocket, type SocketStatus } from "./lib/socket";
import { forgetCwd, loadComposerMode, loadRecentCwds, rememberCwd, saveComposerMode } from "./lib/storage";
import type { ServerInfo, ServerMessage, TerminalProfile, TerminalSessionSummary } from "./types";
import { colors, font, glass, radius, withAlpha } from "./theme";
import { Acrylic } from "./components/Acrylic";

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
  const [agentWorkspaceOpen, setAgentWorkspaceOpen] = useState(false);
  const [agentWorkspaceSessionId, setAgentWorkspaceSessionId] = useState<string | undefined>();
  const [agentSheetOpen, setAgentSheetOpen] = useState(false);
  const [agentState, setAgentState] = useState<SessionAgentState>();
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentAttaching, setAgentAttaching] = useState(false);
  const [agentError, setAgentError] = useState<string>();
  const [acpState, setAcpState] = useState<AcpBridgeState>();
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
  // True while an image is uploading to the host (attach button feedback).
  const [attaching, setAttaching] = useState(false);
  const [attachmentSheetOpen, setAttachmentSheetOpen] = useState(false);
  // Newest notification banner; tap jumps to the session that rang.
  const [toast, setToast] = useState<ToastNotification | null>(null);
  // Composer mode edits the message locally and sends it whole; direct mode
  // hands every keystroke to the terminal. Persisted between launches.
  const [composerMode, setComposerMode] = useState(true);
  const activeIdRef = useRef<string | undefined>(activeId);
  // Watermark of the newest notification we've seen (live or via catch-up);
  // GET /api/notifications?since= replays anything after it on resume.
  const lastNotifySeenRef = useRef<number>(Date.now());
  const catchUpInFlightRef = useRef(false);
  const acpOrderRef = useRef<{ epoch: string; sequence: number } | undefined>(undefined);
  const lastAcpAttentionIdRef = useRef<string | undefined>(undefined);
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
  const composerRef = useRef<ComposerHandle | null>(null);
  const inputContextRefreshRef = useRef<() => void>(() => undefined);
  // Session scrubber overlay (picker wheel); driven by the SwipeBar's gesture.
  const sessionSwitcherRef = useRef<SessionSwitcherHandle | null>(null);
  const blurTargetRef = useRef<View | null>(null);
  const settleFrameRef = useRef<number | undefined>(undefined);
  const settleTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const applyAcpState = useCallback((next: AcpBridgeState) => {
    const previous = acpOrderRef.current;
    if (previous?.epoch === next.epoch && next.sequence <= previous.sequence) return;
    acpOrderRef.current = { epoch: next.epoch, sequence: next.sequence };
    setAcpState(next);

    const request = next.requests[0];
    if (!request || lastAcpAttentionIdRef.current === request.id) return;
    lastAcpAttentionIdRef.current = request.id;
    Keyboard.dismiss();
    setDrawerOpen(false);
    setAttachmentSheetOpen(false);
    setAgentWorkspaceOpen(true);
    playNotifyRef.current("attention");
  }, []);

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
    // The final late pass catches slow keyboard animations and the iOS
    // QuickType bar appearing a beat after the main keyboard frame — without
    // it the terminal can keep a stale (taller) layout under the keyboard.
    settleTimersRef.current = [80, 180, Platform.OS === "ios" ? 320 : 220, 600].map((delay) =>
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
    acpOrderRef.current = undefined;
    lastAcpAttentionIdRef.current = undefined;
    setAcpState(undefined);
    setAgentWorkspaceOpen(false);
  }, [endpoint.id]);

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
        // Replay task-finish notifications that landed while we were away.
        catchUpNotificationsRef.current();
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

  // Replays notifications recorded while this client was disconnected or
  // backgrounded (iOS drops the socket within seconds of leaving the
  // foreground): one tone, one summary banner, badges for every session that
  // rang. Ref-wrapped so socket/AppState listeners can call the latest version.
  const catchUpNotificationsRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    catchUpNotificationsRef.current = () => {
      if (catchUpInFlightRef.current) {
        return;
      }
      catchUpInFlightRef.current = true;
      fetchNotifications(endpoint, lastNotifySeenRef.current)
        .then((missed) => {
          if (missed.length === 0) {
            return;
          }
          const stamps = missed.map((item) => Date.parse(item.at)).filter(Number.isFinite);
          lastNotifySeenRef.current = Math.max(lastNotifySeenRef.current, ...stamps);
          setUnread((current) => {
            const next = { ...current };
            for (const item of missed) {
              if (item.sessionId && item.sessionId !== activeIdRef.current) {
                next[item.sessionId] = (next[item.sessionId] ?? 0) + 1;
              }
            }
            return next;
          });
          const latest = missed[missed.length - 1];
          playNotifyRef.current(latest.sound);
          setToast(
            missed.length > 1
              ? {
                  key: latest.id,
                  title: `${missed.length} tasks finished while you were away`,
                  sessionId: latest.sessionId,
                }
              : {
                  key: latest.id,
                  title: latest.sessionTitle ?? latest.title ?? "Terminal",
                  body: latest.body,
                  sessionId: latest.sessionId,
                }
          );
        })
        .catch(() => undefined)
        .finally(() => {
          catchUpInFlightRef.current = false;
        });
    };
  }, [endpoint]);

  useEffect(() => {
    const offStatus = terminalSocket.onStatus((status) => {
      setSocketStatus(status);
      if (status === "open") {
        catchUpNotificationsRef.current();
      }
    });
    const offMessage = terminalSocket.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case "hello":
          setSessions(message.sessions);
          setProfiles(message.profiles);
          setServerInfo(message.server);
          setActiveId((current) => current ?? message.sessions[0]?.id);
          if (message.acp) applyAcpState(message.acp);
          break;
        case "sessions":
          setSessions(message.sessions);
          setActiveId((current) => current ?? message.sessions[0]?.id);
          break;
        case "profiles":
          setProfiles(message.profiles);
          break;
        case "acp_state":
          applyAcpState(message.acp);
          break;
        case "acp_session": {
          const order = acpOrderRef.current;
          if (!order || order.epoch !== message.epoch || message.sequence <= order.sequence) break;
          acpOrderRef.current = { epoch: message.epoch, sequence: message.sequence };
          setAcpState((current) => {
            if (!current || current.epoch !== message.epoch) return current;
            const index = current.sessions.findIndex((session) => session.id === message.session.id);
            const sessions = index < 0
              ? [message.session, ...current.sessions]
              : current.sessions.map((session, candidateIndex) => candidateIndex === index ? message.session : session);
            return { ...current, sequence: message.sequence, sessions };
          });
          break;
        }
        case "acp_session_removed": {
          const order = acpOrderRef.current;
          if (!order || order.epoch !== message.epoch || message.sequence <= order.sequence) break;
          acpOrderRef.current = { epoch: message.epoch, sequence: message.sequence };
          setAcpState((current) => current?.epoch === message.epoch
            ? {
                ...current,
                sequence: message.sequence,
                sessions: current.sessions.filter((session) => session.id !== message.sessionId),
                requests: current.requests.filter((request) => request.sessionId !== message.sessionId),
              }
            : current);
          break;
        }
        case "notify": {
          // Task-finish signals: server-detected bells/OSCs in any session's
          // output plus desktop automation POSTing /api/notify. Tone + haptic,
          // badge the session that rang, and surface a tappable banner.
          playNotifyRef.current(message.sound);
          const at = message.at ? Date.parse(message.at) : Number.NaN;
          lastNotifySeenRef.current = Math.max(lastNotifySeenRef.current, Number.isFinite(at) ? at : Date.now());
          const sessionId = message.sessionId;
          if (sessionId && sessionId !== activeIdRef.current) {
            setUnread((current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
          }
          if (sessionId !== activeIdRef.current || message.body) {
            setToast({
              key: message.id ?? `notify-${Date.now()}`,
              title: message.sessionTitle ?? message.title ?? "Terminal",
              body: message.body,
              sessionId,
            });
          }
          break;
        }
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
          } else {
            // Output redraws are the earliest signal that an agent opened or
            // advanced a question. Refresh after the burst instead of waiting
            // for the normal polling interval.
            inputContextRefreshRef.current();
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
  }, [applyAcpState, upsertSession]);

  const activeSession = useMemo(() => sessions.find((item) => item.id === activeId), [sessions, activeId]);
  const activeSessionRef = useRef<TerminalSessionSummary | undefined>(undefined);
  const agentSessionKind =
    activeSession?.status === "running" && (activeSession.agent === "claude" || activeSession.agent === "codex")
      ? activeSession.agent
      : undefined;

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    loadComposerMode().then(setComposerMode);
  }, []);

  const sessionLive = socketStatus === "open" && activeSession?.status === "running";
  const composerActive =
    composerMode && !drawerOpen && !agentWorkspaceOpen && !attachmentSheetOpen && !attaching && !creating && Boolean(sessionLive);

  // What the active terminal needs to know about the far end: which agent is
  // listening, whether it is mid-turn, and any dialog it is blocking on. This
  // stays live in direct-key mode too. A question must never depend on the user
  // having enabled the composer first (bro-cli and shells that launch an agent
  // after startup are common examples).
  const { context: inputContext, refresh: refreshInputContext } = useInputContext(endpoint, activeId, {
    enabled: !drawerOpen && !agentWorkspaceOpen && Boolean(sessionLive),
  });
  inputContextRefreshRef.current = refreshInputContext;

  const sendKeys = useCallback((data: string) => {
    const id = activeIdRef.current;
    if (id) {
      terminalSocket.send({ type: "input", sessionId: id, data });
    }
  }, []);

  // On-device voice dictation. While composing, phrases land in the message so
  // they can be edited before they run; in direct mode they go straight to the
  // session's command line as before (CommandBar then arms the auto-Enter).
  const injectDictatedText = useCallback(
    (text: string) => {
      if (composerMode) {
        composerRef.current?.insertText(text);
        return;
      }
      const id = activeIdRef.current;
      if (id) {
        terminalSocket.send({ type: "input", sessionId: id, data: `${text} ` });
      }
    },
    [composerMode]
  );

  // Unmounting the composer blurs it, and the keep-focus effect below hands
  // the keyboard back to the terminal, so the toggle only has to flip state.
  const toggleComposerMode = useCallback(() => {
    setComposerMode((current) => {
      const next = !current;
      void saveComposerMode(next);
      return next;
    });
  }, []);

  const dictation = useDictation({
    onText: injectDictatedText,
    enabled: !agentWorkspaceOpen && !inputContext?.prompt && socketStatus === "open" && activeSession?.status === "running",
  });

  // Persistent keyboard: while a live session is connected, the terminal input
  // stays focused so the soft keyboard never collapses (the page refocuses on
  // any blur attempt). Opening the drawer releases it; closing re-engages it.
  // The composer must not fight for focus, so this is off while it is up — the
  // composer's own field is then what holds the keyboard.
  const keepKeyboardOpen =
    !composerMode && !inputContext?.prompt && !drawerOpen && !agentWorkspaceOpen && !attachmentSheetOpen && !attaching && !creating && Boolean(sessionLive);
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

  // Once a terminal has an agent view, that view is where the person expects
  // to land — but closing it has to mean something. A dismissal is remembered
  // per terminal until they ask for the agent view again, so "back to the
  // terminal" stays sticky without ever hiding the way back.
  const agentViewDismissedRef = useRef(new Set<string>());

  const openAgentWorkspace = useCallback((acpSessionId?: string) => {
    Keyboard.dismiss();
    terminalRef.current?.setKeepFocus(false);
    setDrawerOpen(false);
    setAttachmentSheetOpen(false);
    setAgentSheetOpen(false);
    setAgentWorkspaceSessionId(acpSessionId);
    setAgentWorkspaceOpen(true);
    const terminalId = activeSessionRef.current?.id;
    if (terminalId) agentViewDismissedRef.current.delete(terminalId);
  }, []);

  const closeAgentWorkspace = useCallback(() => {
    const terminalId = activeSessionRef.current?.id;
    if (terminalId) agentViewDismissedRef.current.add(terminalId);
    setAgentWorkspaceOpen(false);
  }, []);

  // The agent pill's one job: get from "Claude is running here" to a rich view
  // of it in a single tap when the terminal is already attached, and in one
  // deliberate choice when it is not.
  const openAgentView = useCallback(async () => {
    const session = activeSessionRef.current;
    if (!session) return;
    if (session.acpSessionId) {
      openAgentWorkspace(session.acpSessionId);
      return;
    }

    Keyboard.dismiss();
    terminalRef.current?.setKeepFocus(false);
    setAgentError(undefined);
    setAgentState(undefined);
    setAgentSheetOpen(true);
    setAgentLoading(true);
    try {
      const state = await fetchSessionAgent(endpoint, session.id, true);
      if (activeSessionRef.current?.id !== session.id) return;
      setAgentState(state);
      // An attachment that survived a client restart needs no second question.
      if (state.acpSessionId) openAgentWorkspace(state.acpSessionId);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentLoading(false);
    }
  }, [endpoint, openAgentWorkspace]);

  const attachAgentView = useCallback(
    async (candidate?: AgentLinkCandidate) => {
      const session = activeSessionRef.current;
      if (!session) return;
      setAgentAttaching(true);
      setAgentError(undefined);
      try {
        const result = await attachSessionAgent(endpoint, session.id, {
          ...(candidate ? { remoteSessionId: candidate.sessionId, cwd: candidate.cwd } : {}),
        });
        upsertSession(result.session);
        openAgentWorkspace(result.acpSession.id);
      } catch (error) {
        setAgentError(error instanceof Error ? error.message : String(error));
      } finally {
        setAgentAttaching(false);
      }
    },
    [endpoint, openAgentWorkspace, upsertSession]
  );

  // Attached agent sessions open in their agent view by default: if you gave a
  // terminal a rich view, that is the surface you meant to come back to. The
  // raw terminal is one dismissal away and stays dismissed until asked for.
  useEffect(() => {
    if (!activeSession?.acpSessionId) return;
    if (drawerOpen || agentSheetOpen || agentWorkspaceOpen) return;
    if (agentViewDismissedRef.current.has(activeSession.id)) return;
    openAgentWorkspace(activeSession.acpSessionId);
  }, [activeSession?.id, activeSession?.acpSessionId, drawerOpen, agentSheetOpen, agentWorkspaceOpen, openAgentWorkspace]);

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

  // "Paste a picture into Claude/Codex": upload the image to the host, which
  // saves it to a local temp file and bracket-pastes the path into the session
  // — the form both CLIs turn into an attached image.
  const attachImage = useCallback(
    async (source: "library" | "clipboard") => {
      const sessionId = activeIdRef.current;
      if (!sessionId) {
        setAttaching(false);
        return;
      }
      try {
        let attached = false;
        if (source === "clipboard") {
          const image = await Clipboard.getImageAsync({ format: "jpeg", jpegQuality: 0.9 });
          if (!image?.data) {
            setToast({
              key: `attach-${Date.now()}`,
              title: "No clipboard image",
              body: "Copy an image first, then try again. On iOS, paste access may also have been denied.",
            });
            return;
          }
          await uploadImageFromDataUri(endpoint, sessionId, image.data);
          attached = true;
        } else {
          const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!permission.granted) {
            setToast({ key: `attach-${Date.now()}`, title: "Attach image", body: "Photo library access was denied." });
            return;
          }
          const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
          const asset = picked.canceled ? undefined : picked.assets?.[0];
          if (!asset) {
            return;
          }
          await uploadImageFromUri(endpoint, sessionId, asset.uri, asset.mimeType ?? "image/jpeg", asset.fileName ?? undefined);
          attached = true;
        }
        if (attached) {
          setToast({
            key: `attach-${Date.now()}`,
            title: "Image pasted",
            body: "The image is ready in the current terminal prompt.",
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        }
      } catch (error) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        setToast({
          key: `attach-${Date.now()}`,
          title: "Attach image failed",
          body: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setAttaching(false);
      }
    },
    [endpoint]
  );

  const openAttachmentSheet = useCallback(() => {
    setAttachmentSheetOpen(true);
    requestAnimationFrame(() => Keyboard.dismiss());
  }, []);

  const selectAttachmentSource = useCallback(
    (source: "library" | "clipboard") => {
      setAttachmentSheetOpen(false);
      setAttaching(true);
      // Let the sheet hand off focus before iOS/Android presents a paste
      // permission prompt or the native photo picker.
      setTimeout(() => void attachImage(source), 200);
    },
    [attachImage]
  );

  // Fade the "starting session" scrim in instead of popping it — the spinner
  // often only shows for a beat, and a hard cut reads as a glitch.
  const creatingFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (creating) {
      creatingFade.setValue(0);
      Animated.timing(creatingFade, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }
  }, [creating, creatingFade]);

  const dismissToast = useCallback(() => setToast(null), []);
  const openToastSession = useCallback(
    (sessionId?: string) => {
      setToast(null);
      if (sessionId && sessions.some((session) => session.id === sessionId)) {
        selectSession(sessionId);
      }
    },
    [selectSession, sessions]
  );

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
              onStep={(delta) => {
                const next = sessions[sessions.findIndex((item) => item.id === activeId) + delta];
                if (next) {
                  selectSession(next.id);
                }
              }}
            />
          ) : null}
          {/* Local message composition: slash commands, @file mentions, prompt
              history and one-tap answers to whatever dialog the agent is
              showing. Sits between the session switcher and the key row so the
              keys stay reachable while typing. */}
          {/* A terminal question always gets the native option surface, even
              when ordinary input is in direct-key mode. Composer owns the
              stale-response guard and keyboard handoff for both paths. */}
          {composerMode || inputContext?.prompt ? (
            <Composer
              ref={composerRef}
              endpoint={endpoint}
              sessionId={activeId}
              context={inputContext}
              disabled={!sessionLive}
              active={composerActive}
              blurTarget={blurTargetRef}
              onSendKeys={sendKeys}
              onRefreshContext={refreshInputContext}
              onNotice={(title, body) => setToast({ key: `composer-${Date.now()}`, title, body })}
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
          ) : null}
          <CommandBar
            targetId={activeId}
            sessionStatus={activeSession?.status}
            socketStatus={socketStatus}
            bottomInset={keyboardVisible ? 0 : insets.bottom}
            blurTarget={blurTargetRef}
            onAttachImage={openAttachmentSheet}
            attachingImage={attaching}
            composerMode={composerMode}
            onInsertToken={(token) => composerRef.current?.insertToken(token)}
            onToggleComposer={toggleComposerMode}
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
          style={[styles.menuFab, { top: insets.top + 8 }]}
        >
          {({ pressed }) => (
            <>
              <Acrylic />
              {pressed ? <View style={[StyleSheet.absoluteFill, styles.menuFabPressed]} /> : null}
              <View style={styles.menuLines}>
                <View style={styles.menuLine} />
                <View style={[styles.menuLine, styles.menuLineMid]} />
                <View style={styles.menuLine} />
              </View>
            </>
          )}
        </Pressable>

        {/* The live answer to "what is the agent doing?" — and the way into the
            rich agent view. Only shown once an agent is actually detected in
            this terminal, so a plain shell keeps its clean surface. */}
        {agentSessionKind ? (
          <AgentStatusBar
            agent={agentSessionKind}
            topInset={insets.top}
            activity={activeSession?.agentActivity}
            attached={Boolean(activeSession?.acpSessionId)}
            connecting={agentAttaching}
            onPress={openAgentView}
          />
        ) : null}

        {/* Task-finish banner: newest notification, tap to jump to its session. */}
        <NotificationToast
          notification={toast}
          topInset={insets.top}
          onPress={openToastSession}
          onDismiss={dismissToast}
        />

        {creating ? (
          <Animated.View style={[styles.creatingOverlay, { opacity: creatingFade }]}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={styles.creatingText}>Starting session…</Text>
          </Animated.View>
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
        acpState={acpState}
        onClose={() => setDrawerOpen(false)}
        onOpenAgentWorkspace={() => openAgentWorkspace()}
        onSelect={selectSession}
        onCreate={createSession}
        onKill={killSession}
        onRename={renameSession}
        onDisconnect={onDisconnect}
        onSetCwd={setCwd}
        onForgetCwd={forgetCwdEntry}
      />
      <AttachmentSheet
        visible={attachmentSheetOpen}
        onClose={() => setAttachmentSheetOpen(false)}
        onSelect={selectAttachmentSource}
      />
      <AgentAttachSheet
        visible={agentSheetOpen}
        state={agentState}
        loading={agentLoading}
        busy={agentAttaching}
        error={agentError}
        onClose={() => setAgentSheetOpen(false)}
        onPick={attachAgentView}
      />
      <AgentWorkspaceScreen
        visible={agentWorkspaceOpen}
        endpoint={endpoint}
        initialSessionId={agentWorkspaceSessionId}
        defaultCwd={activeCwd ?? activeSession?.cwd}
        onClose={closeAgentWorkspace}
        onStateChange={applyAcpState}
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
    left: 12,
    zIndex: 6,
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    // Clips the Acrylic backing to the rounded corners.
    overflow: "hidden",
    borderColor: glass.border,
    borderWidth: 1,
  },
  menuFabPressed: {
    // Wash layered above the acrylic so the press darkens the glass instead
    // of replacing it.
    backgroundColor: withAlpha(colors.foreground, 0.08),
  },
  menuLines: {
    alignItems: "center",
    gap: 3.5,
  },
  menuLine: {
    width: 14,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: colors.secondaryForeground,
  },
  menuLineMid: {
    width: 14,
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
    gap: 16,
    backgroundColor: colors.overlay,
  },
  creatingText: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
});

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CommandBar } from "./components/CommandBar";
import { Header } from "./components/Header";
import { SessionsDrawer, type CreateSpec } from "./components/SessionsDrawer";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { TerminalView, type TerminalViewHandle } from "./components/TerminalView";
import { createSession as createSessionApi } from "./lib/api";
import type { ServerEndpoint } from "./lib/endpoint";
import { terminalSocket, type SocketStatus } from "./lib/socket";
import { forgetCwd, loadRecentCwds, rememberCwd } from "./lib/storage";
import type { ServerInfo, ServerMessage, TerminalProfile, TerminalSessionSummary } from "./types";
import { colors } from "./theme";

interface TerminalScreenProps {
  endpoint: ServerEndpoint;
  onDisconnect: () => void;
}

function shellName(session?: TerminalSessionSummary) {
  if (!session) return "";
  return session.shell.split(/[\\/]/).pop() ?? session.shell;
}

export function TerminalScreen({ endpoint, onDisconnect }: TerminalScreenProps) {
  const insets = useSafeAreaInsets();
  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>();
  const [activeId, setActiveId] = useState<string | undefined>();
  const [socketStatus, setSocketStatus] = useState<SocketStatus>(terminalSocket.currentStatus);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [activeCwd, setActiveCwd] = useState<string | undefined>(undefined);
  const activeIdRef = useRef<string | undefined>(activeId);
  const terminalRef = useRef<TerminalViewHandle | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

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
      try {
        const session = await createSessionApi(endpoint, options);
        upsertSession(session);
        selectSession(session.id);
        if (activeCwd) {
          rememberCwd(endpoint.id, activeCwd).then(setRecentCwds);
        }
      } catch {
        terminalSocket.send({ type: "create", ...options });
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

  return (
    <View style={styles.root}>
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surface }}>
        <Header
          title={headerTitle}
          meta={headerMeta}
          socketStatus={socketStatus}
          canKill={Boolean(activeSession && activeSession.status === "running")}
          onMenu={() => setDrawerOpen(true)}
          onFocus={() => terminalRef.current?.focusTerminal()}
          onNew={() => createSession()}
          onKill={() => activeId && killSession(activeId)}
        />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top}
      >
        <View style={styles.terminalWrap}>
          <TerminalView
            ref={terminalRef}
            targetId={activeId}
            session={activeSession}
            socketStatus={socketStatus}
          />
          <SessionSwitcher sessions={sessions} activeId={activeId} unread={unread} onSelect={selectSession} />
        </View>
        <CommandBar
          targetId={activeId}
          sessionStatus={activeSession?.status}
          socketStatus={socketStatus}
          bottomInset={insets.bottom}
        />
      </KeyboardAvoidingView>

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
  flex: {
    flex: 1,
  },
  terminalWrap: {
    flex: 1,
    overflow: "hidden",
  },
});

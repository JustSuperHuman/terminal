import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, Copy, CopyCheck, Download, Focus, KeyRound, Menu, Plus, Power, X } from "lucide-react";
import { CommandBar } from "@/components/CommandBar";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { NewTerminalDialog } from "@/components/NewTerminalDialog";
import { ProjectTabs } from "@/components/ProjectTabs";
import { SessionSidebar } from "@/components/SessionSidebar";
import { TerminalSurface, type TerminalSurfaceHandle } from "@/components/TerminalSurface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, createProject, createSession, deleteProject, getBootstrap } from "@/lib/api";
import { setAccessToken, withAccessToken } from "@/lib/access-token";
import { buildTerminalTargets, type TerminalTarget } from "@/lib/session-targets";
import { terminalSocket, type SocketStatus } from "@/lib/terminal-socket";
import type {
  BootstrapPayload,
  BridgeCommandInfo,
  CreateSessionOptions,
  HostTerminalProcess,
  ServerInfo,
  ServerMessage,
  TerminalHostPeer,
  TerminalProfile,
  TerminalProject,
  TerminalSessionSummary
} from "@/lib/types";

function selectPreferredTargetId(targets: TerminalTarget[], currentId?: string): string | undefined {
  const current = targets.find((target) => target.id === currentId);
  if (current?.session.status === "running") {
    return current.id;
  }

  return targets.find((target) => target.session.status === "running")?.id ?? current?.id ?? targets[0]?.id;
}

export function App() {
  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [hostProcesses, setHostProcesses] = useState<HostTerminalProcess[]>([]);
  const [peerHosts, setPeerHosts] = useState<TerminalHostPeer[]>([]);
  const [projects, setProjects] = useState<TerminalProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>();
  const [bridgeCommands, setBridgeCommands] = useState<BridgeCommandInfo | undefined>();
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>();
  const [activeTargetId, setActiveTargetId] = useState<string | undefined>();
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("closed");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [actionError, setActionError] = useState("");
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState(false);
  const [copySignal, setCopySignal] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);
  const activeTargetIdRef = useRef<string | undefined>(activeTargetId);
  const terminalSurfaceRef = useRef<TerminalSurfaceHandle | null>(null);

  const targets = useMemo(() => buildTerminalTargets(sessions, peerHosts), [sessions, peerHosts]);
  const activeTarget = useMemo(() => {
    const preferredId = selectPreferredTargetId(targets, activeTargetId);
    return targets.find((target) => target.id === preferredId);
  }, [activeTargetId, targets]);
  const activeSession = activeTarget?.session;
  const activeProject = useMemo(() => projects.find((project) => project.id === activeProjectId), [activeProjectId, projects]);
  const visibleSessions = useMemo(
    () => (activeProject ? sessions.filter((session) => session.projectId === activeProject.id) : sessions),
    [activeProject, sessions]
  );
  const projectSessionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      if (session.projectId) {
        counts[session.projectId] = (counts[session.projectId] ?? 0) + 1;
      }
    }
    return counts;
  }, [sessions]);

  useEffect(() => {
    activeTargetIdRef.current = activeTargetId;
  }, [activeTargetId]);

  useEffect(() => {
    setActiveTargetId((current) => {
      const preferredId = selectPreferredTargetId(targets, current);
      return preferredId === current ? current : preferredId;
    });
  }, [targets]);

  useEffect(() => {
    if (activeProjectId && !projects.some((project) => project.id === activeProjectId)) {
      setActiveProjectId(undefined);
    }
  }, [activeProjectId, projects]);

  function applyBootstrap(payload: BootstrapPayload) {
    setSessions(payload.sessions);
    setProfiles(payload.profiles);
    setHostProcesses(payload.hostProcesses);
    setPeerHosts(payload.peerHosts ?? []);
    setProjects(payload.projects ?? []);
    setBridgeCommands(payload.bridgeCommands);
    setServerInfo(payload.server);
    setActiveTargetId((current) => current ?? payload.sessions[0]?.id);
    setAuthRequired(false);
    setActionError("");
  }

  function handleBootstrapError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ApiError && error.status === 401) {
      setAuthRequired(true);
      setActionError(message);
      return;
    }

    setActionError(message);
  }

  useEffect(() => {
    let mounted = true;

    getBootstrap()
      .then((payload) => {
        if (!mounted) {
          return;
        }
        applyBootstrap(payload);
      })
      .catch((error) => {
        if (mounted) {
          handleBootstrapError(error);
        }
      });

    const offStatus = terminalSocket.onStatus(setSocketStatus);
    const offMessage = terminalSocket.onMessage((message: ServerMessage) => {
      if (message.type === "hello") {
        applyBootstrap(message);
      }

      if (message.type === "sessions") {
        setSessions(message.sessions);
        setActiveTargetId((current) => current ?? message.sessions[0]?.id);
      }

      if (message.type === "session" || message.type === "exit") {
        const session = message.session;
        if (session.id.startsWith("peer:")) {
          setPeerHosts((current) =>
            current.map((peer) => ({
              ...peer,
              sessions: peer.sessions.map((item) => (`peer:${peer.server.port}:${item.id}` === session.id ? { ...session, id: item.id } : item))
            }))
          );
        } else {
          setSessions((current) => {
            const exists = current.some((item) => item.id === session.id);
            if (!exists) {
              return [...current, session];
            }
            return current.map((item) => (item.id === session.id ? session : item));
          });
        }
      }

      if (message.type === "projects") {
        setProjects(message.projects);
      }

      if (message.type === "host") {
        setHostProcesses(message.hostProcesses);
        setPeerHosts(message.peerHosts ?? []);
      }

      if (message.type === "error") {
        setActionError(message.detail ? `${message.message} ${message.detail}` : message.message);
      }

      if (message.type === "output" || message.type === "activity") {
        setUnread((current) => {
          if (message.sessionId === activeTargetIdRef.current) {
            return current;
          }
          return {
            ...current,
            [message.sessionId]: (current[message.sessionId] ?? 0) + 1
          };
        });
      }
    });
    terminalSocket.connect();

    return () => {
      mounted = false;
      offStatus();
      offMessage();
    };
  }, []);

  useEffect(() => {
    if (activeTarget?.id && activeTarget.id !== activeTargetId) {
      setActiveTargetId(activeTarget.id);
    }
  }, [activeTarget?.id, activeTargetId]);

  function selectSession(targetId: string) {
    setActiveTargetId(targetId);
    setUnread((current) => {
      const next = { ...current };
      delete next[targetId];
      return next;
    });
    setSidebarOpen(false);
  }

  function selectProject(projectId?: string) {
    setActiveProjectId(projectId);
    if (!projectId) {
      return;
    }

    const projectSessions = sessions.filter((session) => session.projectId === projectId);
    if (!projectSessions.some((session) => session.id === activeTarget?.session.id)) {
      setActiveTargetId(projectSessions[0]?.id);
    }
  }

  async function handleCreateProject(name: string, cwd: string) {
    setActionError("");
    try {
      const project = await createProject(name, cwd);
      setActiveProjectId(project.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function handleDeleteProject(projectId: string) {
    setActionError("");
    try {
      await deleteProject(projectId);
      if (activeProjectId === projectId) {
        setActiveProjectId(undefined);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function newSession(options: CreateSessionOptions = {}) {
    setActionError("");
    const nextOptions: CreateSessionOptions =
      activeProject && !options.projectId
        ? { ...options, projectId: activeProject.id, cwd: options.cwd ?? activeProject.cwd }
        : options;
    try {
      const session = await createSession(nextOptions);
      setActiveTargetId(session.id);
      setSidebarOpen(false);
      return session;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  function createFromSidebar(options?: CreateSessionOptions) {
    if (options) {
      void newSession(options).catch(() => undefined);
      return;
    }
    setNewTerminalOpen(true);
    setSidebarOpen(false);
  }

  function killActive() {
    if (activeTarget) {
      killSession(activeTarget.id);
    }
  }

  function killSession(targetId: string) {
    terminalSocket.send({ type: "kill", sessionId: targetId });
    if (targetId.startsWith("peer:")) {
      window.setTimeout(() => terminalSocket.send({ type: "refresh-host" }), 500);
    }
  }

  function refreshHost() {
    terminalSocket.send({ type: "refresh-host" });
  }

  function renameSession(targetId: string, title: string) {
    terminalSocket.send({ type: "rename", sessionId: targetId, title });
  }

  async function submitAccessToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = authToken.trim();
    if (!token) {
      return;
    }

    setAccessToken(token);
    setActionError("");
    terminalSocket.connect();

    try {
      applyBootstrap(await getBootstrap());
    } catch (error) {
      handleBootstrapError(error);
    }
  }

  function getActiveExportUrl() {
    if (!activeTarget) {
      return undefined;
    }

    const sessionId = encodeURIComponent(activeTarget.session.id);
    if (activeTarget.kind === "peer" && activeTarget.peer) {
      return withAccessToken(`/api/peers/${activeTarget.peer.server.port}/sessions/${sessionId}/export?format=ansi`);
    }

    return withAccessToken(`/api/sessions/${sessionId}/export?format=ansi`);
  }

  function downloadActiveTranscript() {
    const href = getActiveExportUrl();
    if (!href) {
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.rel = "noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  function onCopied() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function copyBridgeCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.inset = "-1000px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    onCopied();
  }

  const headerTitle = activeTarget?.kind === "peer" ? `:${activeTarget.peer?.server.port} · ${activeSession?.title}` : activeSession?.title;
  const headerSource = activeTarget?.kind === "peer" ? `peer :${activeTarget.peer?.server.port}` : activeTarget?.session.source === "bridged" ? "bridge" : "";
  const headerMeta = activeTarget
    ? `${headerSource ? `${headerSource} | ` : ""}${activeTarget.session.cwd} | pid ${activeTarget.session.pid ?? "pending"}`
    : "No active session";

  return (
    <TooltipProvider delayDuration={250}>
      <div className="h-dvh bg-background text-foreground">
        <div className="flex h-full min-h-0">
          <aside className="hidden w-[320px] shrink-0 border-r lg:block">
            <SessionSidebar
              sessions={visibleSessions}
              projects={projects}
              activeTargetId={activeTarget?.id}
              hostProcesses={hostProcesses}
              peerHosts={peerHosts}
              serverInfo={serverInfo}
              bridgeCommands={bridgeCommands}
              profiles={profiles}
              unread={unread}
              onSelectSession={selectSession}
              onCreateSession={createFromSidebar}
              onRefreshHost={refreshHost}
              onCopyBridgeCommand={copyBridgeCommand}
              onRenameSession={renameSession}
              onKillSession={killSession}
            />
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background/95 px-3">
              <div className="flex min-w-0 items-center gap-2">
                <Button variant="ghost" size="iconSm" className="lg:hidden" onClick={() => setSidebarOpen(true)}>
                  <Menu className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Open sidebar</span>
                </Button>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{headerTitle ?? "Terminal"}</div>
                  <div className="truncate text-xs text-muted-foreground">{headerMeta}</div>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {serverInfo ? (
                  <div className="hidden rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground sm:block">
                    :{serverInfo.port}
                  </div>
                ) : null}
                <ConnectionBadge status={socketStatus} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="iconSm" onClick={() => setNewTerminalOpen(true)}>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">New terminal</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>New terminal</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="iconSm" className="hidden sm:inline-flex" onClick={() => setFocusSignal((value) => value + 1)}>
                      <Focus className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Focus terminal</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Focus terminal</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="iconSm" className="hidden sm:inline-flex" onClick={() => setCopySignal((value) => value + 1)}>
                      <Copy className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Copy ANSI snapshot</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy ANSI snapshot</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="iconSm" className="hidden sm:inline-flex" onClick={downloadActiveTranscript} disabled={!activeSession}>
                      <Download className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Download ANSI transcript</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Download ANSI transcript</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="iconSm" onClick={killActive} disabled={!activeSession || activeSession.status !== "running"}>
                      <Power className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Stop terminal</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Stop terminal</TooltipContent>
                </Tooltip>
                {copied ? (
                  <div className="hidden items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground md:flex">
                    <CopyCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                    Copied
                  </div>
                ) : null}
              </div>
            </header>

            <ProjectTabs
              projects={projects}
              activeProjectId={activeProjectId}
              sessionCounts={projectSessionCounts}
              onSelectProject={selectProject}
              onCreateProject={handleCreateProject}
              onDeleteProject={handleDeleteProject}
            />

            {actionError && !authRequired ? (
              <div className="flex shrink-0 items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1 break-words">{actionError}</div>
                <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={() => setActionError("")}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Dismiss error</span>
                </Button>
              </div>
            ) : null}

            {authRequired ? (
              <div className="flex min-h-0 flex-1 items-center justify-center bg-terminal p-4">
                <form
                  onSubmit={submitAccessToken}
                  className="w-full max-w-sm rounded-md border bg-background p-4 shadow-sm"
                >
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-secondary text-primary">
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">Access token</div>
                      <div className="text-xs text-muted-foreground">Network access requires a token</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      value={authToken}
                      onChange={(event) => setAuthToken(event.target.value)}
                      placeholder="Token"
                      autoCapitalize="none"
                      autoCorrect="off"
                      className="font-mono"
                      autoFocus
                    />
                    <Button type="submit" disabled={!authToken.trim()}>
                      Connect
                    </Button>
                  </div>
                  {actionError ? (
                    <div className="mt-3 flex items-start gap-2 text-xs text-destructive-foreground">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="break-words">{actionError}</span>
                    </div>
                  ) : null}
                </form>
              </div>
            ) : (
              <>
                <TerminalSurface
                  ref={terminalSurfaceRef}
                  session={activeSession}
                  targetId={activeTarget?.id}
                  copySignal={copySignal}
                  focusSignal={focusSignal}
                  socketStatus={socketStatus}
                  onCopied={onCopied}
                />
                <CommandBar
                  session={activeSession}
                  targetId={activeTarget?.id}
                  socketStatus={socketStatus}
                  onBeforeInput={() => terminalSurfaceRef.current?.settleBeforeInput()}
                />
              </>
            )}
          </main>
        </div>

        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent>
            <SheetHeader className="sr-only">
              <SheetTitle>Terminal Host</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              <SessionSidebar
                sessions={visibleSessions}
                projects={projects}
                activeTargetId={activeTarget?.id}
                hostProcesses={hostProcesses}
                peerHosts={peerHosts}
                serverInfo={serverInfo}
                bridgeCommands={bridgeCommands}
                profiles={profiles}
                unread={unread}
                onSelectSession={selectSession}
                onCreateSession={createFromSidebar}
                onRefreshHost={refreshHost}
                onCopyBridgeCommand={copyBridgeCommand}
                onRenameSession={renameSession}
                onKillSession={killSession}
              />
            </div>
          </SheetContent>
        </Sheet>
        <NewTerminalDialog open={newTerminalOpen} profiles={profiles} defaultCwd={activeProject?.cwd} onOpenChange={setNewTerminalOpen} onCreate={newSession} />
      </div>
    </TooltipProvider>
  );
}

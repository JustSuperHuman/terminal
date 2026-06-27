import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, CopyCheck, Download, Focus, Menu, Plus, Power } from "lucide-react";
import { CommandBar } from "@/components/CommandBar";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { SessionSidebar } from "@/components/SessionSidebar";
import { TerminalSurface } from "@/components/TerminalSurface";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createSession, getBootstrap } from "@/lib/api";
import { withAccessToken } from "@/lib/access-token";
import { buildTerminalTargets } from "@/lib/session-targets";
import { terminalSocket, type SocketStatus } from "@/lib/terminal-socket";
import type { BridgeCommandInfo, HostTerminalProcess, ServerInfo, ServerMessage, TerminalHostPeer, TerminalProfile, TerminalSessionSummary } from "@/lib/types";

export function App() {
  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [hostProcesses, setHostProcesses] = useState<HostTerminalProcess[]>([]);
  const [peerHosts, setPeerHosts] = useState<TerminalHostPeer[]>([]);
  const [bridgeCommands, setBridgeCommands] = useState<BridgeCommandInfo | undefined>();
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>();
  const [activeTargetId, setActiveTargetId] = useState<string | undefined>();
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("closed");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState(false);
  const [copySignal, setCopySignal] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);
  const activeTargetIdRef = useRef<string | undefined>(activeTargetId);

  const targets = useMemo(() => buildTerminalTargets(sessions, peerHosts), [sessions, peerHosts]);
  const activeTarget = useMemo(() => targets.find((target) => target.id === activeTargetId) ?? targets[0], [activeTargetId, targets]);
  const activeSession = activeTarget?.session;

  useEffect(() => {
    activeTargetIdRef.current = activeTargetId;
  }, [activeTargetId]);

  useEffect(() => {
    let mounted = true;

    getBootstrap().then((payload) => {
      if (!mounted) {
        return;
      }
      setSessions(payload.sessions);
      setProfiles(payload.profiles);
      setHostProcesses(payload.hostProcesses);
      setPeerHosts(payload.peerHosts ?? []);
      setBridgeCommands(payload.bridgeCommands);
      setServerInfo(payload.server);
      setActiveTargetId((current) => current ?? payload.sessions[0]?.id);
    });

    terminalSocket.connect();
    const offStatus = terminalSocket.onStatus(setSocketStatus);
    const offMessage = terminalSocket.onMessage((message: ServerMessage) => {
      if (message.type === "hello") {
        setSessions(message.sessions);
        setProfiles(message.profiles);
        setHostProcesses(message.hostProcesses);
        setPeerHosts(message.peerHosts ?? []);
        setBridgeCommands(message.bridgeCommands);
        setServerInfo(message.server);
        setActiveTargetId((current) => current ?? message.sessions[0]?.id);
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

      if (message.type === "host") {
        setHostProcesses(message.hostProcesses);
        setPeerHosts(message.peerHosts ?? []);
      }

      if (message.type === "output") {
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

  async function newSession(profileId?: string) {
    const session = await createSession(profileId);
    setActiveTargetId(session.id);
    setSidebarOpen(false);
  }

  function killActive() {
    if (activeTarget) {
      terminalSocket.send({ type: "kill", sessionId: activeTarget.id });
    }
  }

  function refreshHost() {
    terminalSocket.send({ type: "refresh-host" });
  }

  function renameSession(targetId: string, title: string) {
    terminalSocket.send({ type: "rename", sessionId: targetId, title });
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
              sessions={sessions}
              activeTargetId={activeTarget?.id}
              hostProcesses={hostProcesses}
              peerHosts={peerHosts}
              serverInfo={serverInfo}
              bridgeCommands={bridgeCommands}
              profiles={profiles}
              unread={unread}
              onSelectSession={selectSession}
              onCreateSession={newSession}
              onRefreshHost={refreshHost}
              onCopyBridgeCommand={copyBridgeCommand}
              onRenameSession={renameSession}
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
                    <Button variant="ghost" size="iconSm" onClick={() => newSession()}>
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

            <TerminalSurface
              session={activeSession}
              targetId={activeTarget?.id}
              copySignal={copySignal}
              focusSignal={focusSignal}
              socketStatus={socketStatus}
              onCopied={onCopied}
            />
            <CommandBar session={activeSession} targetId={activeTarget?.id} socketStatus={socketStatus} />
          </main>
        </div>

        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent>
            <SheetHeader className="sr-only">
              <SheetTitle>Terminal Host</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              <SessionSidebar
                sessions={sessions}
                activeTargetId={activeTarget?.id}
                hostProcesses={hostProcesses}
                peerHosts={peerHosts}
                serverInfo={serverInfo}
                bridgeCommands={bridgeCommands}
                profiles={profiles}
                unread={unread}
                onSelectSession={selectSession}
                onCreateSession={newSession}
                onRefreshHost={refreshHost}
                onCopyBridgeCommand={copyBridgeCommand}
                onRenameSession={renameSession}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}

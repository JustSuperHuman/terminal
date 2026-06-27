import { useState } from "react";
import { Bot, Check, Copy, Network, Pencil, Plus, Radio, RefreshCw, Search, Shell, SquareTerminal, Terminal, Unplug, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getPeerSessionTargetId } from "@/lib/session-targets";
import { cn } from "@/lib/utils";
import type { BridgeCommandInfo, CreateSessionOptions, HostTerminalProcess, ServerInfo, TerminalHostPeer, TerminalProfile, TerminalSessionSummary } from "@/lib/types";

interface SessionSidebarProps {
  sessions: TerminalSessionSummary[];
  activeTargetId?: string;
  hostProcesses: HostTerminalProcess[];
  peerHosts: TerminalHostPeer[];
  serverInfo?: ServerInfo;
  bridgeCommands?: BridgeCommandInfo;
  profiles: TerminalProfile[];
  unread: Record<string, number>;
  onSelectSession: (targetId: string) => void;
  onCreateSession: (options?: CreateSessionOptions) => void;
  onRefreshHost: () => void;
  onCopyBridgeCommand: (command: string) => void;
  onRenameSession: (targetId: string, title: string) => void;
  onKillSession: (targetId: string) => void;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function shellName(session: TerminalSessionSummary) {
  return session.shell.split(/[\\/]/).pop() ?? session.shell;
}

function executableName(value?: string) {
  return value?.split(/[\\/]/).pop() ?? value;
}

function profileSections(profiles: TerminalProfile[], query = "") {
  return [
    {
      id: "agent",
      label: "Agents",
      icon: Bot,
      profiles: profiles.filter((profile) => profile.group === "agent")
    },
    {
      id: "shell",
      label: "Shells",
      icon: Shell,
      profiles: profiles.filter((profile) => (profile.group ?? "shell") === "shell")
    },
    {
      id: "custom",
      label: "Custom",
      icon: Terminal,
      profiles: profiles.filter((profile) => profile.group === "custom")
    }
  ]
    .map((section) => ({
      ...section,
      profiles: query ? section.profiles.filter((profile) => profileMatches(profile, query)) : section.profiles
    }))
    .filter((section) => section.profiles.length > 0);
}

function searchable(value?: string | number | string[]) {
  if (Array.isArray(value)) {
    return value.join(" ").toLowerCase();
  }
  return String(value ?? "").toLowerCase();
}

function sessionMatches(session: TerminalSessionSummary, query: string) {
  return [
    session.title,
    session.shell,
    session.args,
    session.cwd,
    session.source,
    session.status,
    session.pid
  ].some((value) => searchable(value).includes(query));
}

function profileMatches(profile: TerminalProfile, query: string) {
  return [profile.label, profile.shell, profile.args, profile.group, profile.description].some((value) => searchable(value).includes(query));
}

function hostProcessMatches(process: HostTerminalProcess, query: string) {
  return [process.name, process.pid, process.ppid, process.commandLine, process.executablePath, process.reason].some((value) =>
    searchable(value).includes(query)
  );
}

function processText(process: HostTerminalProcess) {
  return `${process.name} ${process.commandLine ?? ""}`.toLowerCase();
}

function profileForHostProcess(process: HostTerminalProcess, profiles: TerminalProfile[]): TerminalProfile | undefined {
  const text = processText(process);
  const name = process.name.toLowerCase();
  const candidates = [
    text.includes("codex") ? "codex" : undefined,
    text.includes("claude") ? "claude" : undefined,
    name === "pwsh.exe" ? "pwsh" : undefined,
    name === "powershell.exe" ? "windows-powershell" : undefined,
    name === "cmd.exe" ? "cmd" : undefined,
    name === "wsl.exe" || name === "bash.exe" ? "wsl" : undefined
  ].filter(Boolean) as string[];

  return profiles.find((profile) => candidates.includes(profile.id));
}

function bridgeCommandForHostProcess(process: HostTerminalProcess, bridgeCommands?: BridgeCommandInfo): string | undefined {
  if (!bridgeCommands) {
    return undefined;
  }

  const text = processText(process);
  if (text.includes("codex") && bridgeCommands.codex) {
    return bridgeCommands.codex;
  }
  if (text.includes("claude") && bridgeCommands.claude) {
    return bridgeCommands.claude;
  }
  return bridgeCommands.shell;
}

function defaultArgsForProcessName(name: string): string[] | undefined {
  if (name === "pwsh.exe" || name === "powershell.exe") {
    return ["-NoLogo"];
  }
  return undefined;
}

function launchSpecForHostProcess(
  process: HostTerminalProcess,
  profiles: TerminalProfile[]
): { label: string; options: CreateSessionOptions } | undefined {
  const matchedProfile = profileForHostProcess(process, profiles);
  if (matchedProfile) {
    return {
      label: matchedProfile.label,
      options: { profileId: matchedProfile.id }
    };
  }

  const name = process.name.toLowerCase();
  if (!process.executablePath || ["windowsterminal.exe", "openconsole.exe", "conhost.exe"].includes(name)) {
    return undefined;
  }

  if (!/(pwsh|powershell|cmd|wsl|bash|zsh|fish|codex|claude)/i.test(`${process.name} ${process.commandLine ?? ""}`)) {
    return undefined;
  }

  const label = executableName(process.executablePath) ?? process.name;
  return {
    label,
    options: {
      title: label,
      shell: process.executablePath,
      args: defaultArgsForProcessName(name)
    }
  };
}

function displayAccessUrl(value: string) {
  const parsed = new URL(value);
  return parsed.host;
}

export function SessionSidebar({
  sessions,
  activeTargetId,
  hostProcesses,
  peerHosts,
  serverInfo,
  bridgeCommands,
  profiles,
  unread,
  onSelectSession,
  onCreateSession,
  onRefreshHost,
  onCopyBridgeCommand,
  onRenameSession,
  onKillSession
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [editingTargetId, setEditingTargetId] = useState<string | undefined>();
  const [editingTitle, setEditingTitle] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const bridgeActions = bridgeCommands
    ? [
        { id: "shell", label: "Shell", command: bridgeCommands.shell },
        bridgeCommands.codex ? { id: "codex", label: "Codex", command: bridgeCommands.codex } : undefined,
        bridgeCommands.claude ? { id: "claude", label: "Claude", command: bridgeCommands.claude } : undefined
      ].filter(Boolean) as Array<{ id: string; label: string; command: string }>
    : [];
  const filteredSessions = normalizedQuery ? sessions.filter((session) => sessionMatches(session, normalizedQuery)) : sessions;
  const filteredProfileSections = profileSections(profiles, normalizedQuery);
  const filteredPeerHosts = peerHosts
    .map((peer) => {
      const peerMatches = [peer.server.port, peer.server.pid, peer.url].some((value) => searchable(value).includes(normalizedQuery));
      return {
        ...peer,
        sessions: normalizedQuery && !peerMatches ? peer.sessions.filter((session) => sessionMatches(session, normalizedQuery)) : peer.sessions
      };
    })
    .filter((peer) => peer.sessions.length > 0);
  const filteredHostProcesses = normalizedQuery ? hostProcesses.filter((item) => hostProcessMatches(item, normalizedQuery)) : hostProcesses;
  const visibleHostProcesses = filteredHostProcesses.slice(0, normalizedQuery ? 80 : 30);
  const serverUrls = serverInfo?.urls ?? [];

  function beginRename(targetId: string, title: string) {
    setEditingTargetId(targetId);
    setEditingTitle(title);
  }

  function commitRename() {
    if (editingTargetId && editingTitle.trim()) {
      onRenameSession(editingTargetId, editingTitle);
    }
    setEditingTargetId(undefined);
    setEditingTitle("");
  }

  function cancelRename() {
    setEditingTargetId(undefined);
    setEditingTitle("");
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal className="h-4 w-4 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Terminal Host</div>
            <div className="truncate text-xs text-muted-foreground">{sessions.length} sessions</div>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="iconSm" onClick={() => onCreateSession()}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">New terminal</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>New terminal</TooltipContent>
        </Tooltip>
      </div>

      <div className="border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find terminals"
            aria-label="Find terminals"
            className="h-8 pl-8 pr-8 text-xs"
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="iconSm"
              className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2"
              onClick={() => setQuery("")}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Clear search</span>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-2 py-3">
        <div className="mb-2 flex items-center justify-between px-2">
          <div className="text-xs font-medium text-muted-foreground">Sessions</div>
          {normalizedQuery ? <Badge variant="muted">{filteredSessions.length}</Badge> : null}
        </div>
        <div className="space-y-1">
          {filteredSessions.map((session) => {
            const selected = session.id === activeTargetId;
            const unreadCount = unread[session.id] ?? 0;
            const editing = editingTargetId === session.id;
            return (
              <div
                key={session.id}
                data-terminal-target={session.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 transition-colors",
                  selected ? "bg-sidebar-active text-foreground" : "hover:bg-sidebar-active/70"
                )}
              >
                {editing ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                        selected ? "border-primary/60 bg-primary/12 text-primary" : "border-border bg-background/50"
                      )}
                    >
                      <Terminal className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <Input
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitRename();
                        }
                        if (event.key === "Escape") {
                          cancelRename();
                        }
                      }}
                      aria-label="Session title"
                      className="h-8 min-w-0 flex-1 text-xs"
                      autoFocus
                    />
                    <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={commitRename}>
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only">Save title</span>
                    </Button>
                    <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={cancelRename}>
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only">Cancel rename</span>
                    </Button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelectSession(session.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                          selected ? "border-primary/60 bg-primary/12 text-primary" : "border-border bg-background/50"
                        )}
                      >
                        <Terminal className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{session.title}</span>
                          {unreadCount > 0 ? <Badge variant="warning">{unreadCount}</Badge> : null}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                          <span className={cn("h-1.5 w-1.5 rounded-full", session.status === "running" ? "bg-primary" : "bg-muted-foreground")} />
                          {session.source === "bridged" ? <span>bridge</span> : null}
                          {session.source === "bridged" ? <span aria-hidden="true">·</span> : null}
                          <span className="truncate">{shellName(session)}</span>
                          <span>{timeLabel(session.updatedAt)}</span>
                        </span>
                      </span>
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={() => beginRename(session.id, session.title)}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="sr-only">Rename {session.title}</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Rename</TooltipContent>
                    </Tooltip>
                    {session.status === "exited" ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={() => onKillSession(session.id)}>
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="sr-only">Close {session.title}</span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Close exited session</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
          {filteredSessions.length === 0 ? <div className="px-2.5 py-2 text-sm text-muted-foreground">No matching sessions</div> : null}
        </div>

        <Separator className="my-4" />

        <div className="space-y-4">
          {filteredProfileSections.map((section) => {
            const Icon = section.icon;
            return (
              <div key={section.id}>
                <div className="mb-2 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{section.label}</span>
                </div>
                <div className="space-y-1">
                  {section.profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-sidebar-active/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onCreateSession({ profileId: profile.id })}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{profile.label}</span>
                        {profile.description ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{profile.description}</span> : null}
                      </span>
                      <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {filteredProfileSections.length === 0 && normalizedQuery ? (
            <div className="px-2.5 py-2 text-sm text-muted-foreground">No matching profiles</div>
          ) : null}
        </div>

        <Separator className="my-4" />

        {bridgeActions.length > 0 ? (
          <>
            <div className="mb-2 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Bridge commands</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(4.75rem,1fr))] gap-1 px-2">
              {bridgeActions.map((action) => (
                <Tooltip key={action.id}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => onCopyBridgeCommand(action.command)}
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      <span className="truncate">{action.label}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-80">
                    <span className="break-all font-mono text-xs">{action.command}</span>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>

            <Separator className="my-4" />
          </>
        ) : null}

        {serverUrls.length > 0 ? (
          <>
            <div className="mb-2 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
              <Network className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Access URLs</span>
            </div>
            <div className="space-y-1 px-2">
              {serverUrls.map((entry) => (
                <Tooltip key={entry.url}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
                      onClick={() => onCopyBridgeCommand(entry.url)}
                    >
                      <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs font-medium">{entry.label}</span>
                          <Badge variant="muted" className="shrink-0 px-1.5 py-0 text-[10px]">
                            {entry.scope === "local" ? "local" : "net"}
                          </Badge>
                          {entry.tokenRequired ? (
                            <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-[10px]">
                              token
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                          {displayAccessUrl(entry.url)}
                        </span>
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-80">
                    <span className="break-all font-mono text-xs">{entry.url}</span>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>

            <Separator className="my-4" />
          </>
        ) : null}

        <div className="mb-2 flex items-center justify-between px-2">
          <div className="text-xs font-medium text-muted-foreground">Hosted peers</div>
          <Badge variant="muted">{normalizedQuery ? filteredPeerHosts.length : peerHosts.length}</Badge>
        </div>
        <div className="space-y-1">
          {filteredPeerHosts.map((peer) => {
            const running = peer.sessions.filter((session) => session.status === "running").length;
            return (
              <div
                key={peer.id}
                className="rounded-md border border-transparent bg-background/20 px-2 py-2"
              >
                <div className="mb-1.5 flex items-center gap-2 px-0.5">
                  <Network className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate text-sm font-medium">:{peer.server.port}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {running}/{peer.sessions.length} running, pid {peer.server.pid}
                  </span>
                </div>
                <div className="space-y-1">
                  {peer.sessions.map((session) => {
                    const targetId = getPeerSessionTargetId(peer, session);
                    const selected = targetId === activeTargetId;
                    const unreadCount = unread[targetId] ?? 0;
                    const editing = editingTargetId === targetId;
                    return (
                      <div
                        key={targetId}
                        data-terminal-target={targetId}
                        className={cn(
                          "flex w-full items-center gap-1 rounded-md px-2 py-1.5 transition-colors",
                          selected ? "bg-sidebar-active text-foreground" : "hover:bg-sidebar-active/70"
                        )}
                      >
                        {editing ? (
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <Terminal className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                            <Input
                              value={editingTitle}
                              onChange={(event) => setEditingTitle(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  commitRename();
                                }
                                if (event.key === "Escape") {
                                  cancelRename();
                                }
                              }}
                              aria-label="Session title"
                              className="h-8 min-w-0 flex-1 text-xs"
                              autoFocus
                            />
                            <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={commitRename}>
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              <span className="sr-only">Save title</span>
                            </Button>
                            <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={cancelRename}>
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                              <span className="sr-only">Cancel rename</span>
                            </Button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              aria-pressed={selected}
                              onClick={() => onSelectSession(targetId)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <Terminal className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="truncate text-sm">{session.title}</span>
                                  {unreadCount > 0 ? <Badge variant="warning">{unreadCount}</Badge> : null}
                                </span>
                                <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                  <span className={cn("h-1.5 w-1.5 rounded-full", session.status === "running" ? "bg-primary" : "bg-muted-foreground")} />
                                  <span className="truncate">{shellName(session)}</span>
                                </span>
                              </span>
                            </button>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={() => beginRename(targetId, session.title)}>
                                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                  <span className="sr-only">Rename {session.title}</span>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Rename</TooltipContent>
                            </Tooltip>
                            {session.status === "exited" ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button type="button" variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={() => onKillSession(targetId)}>
                                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    <span className="sr-only">Close {session.title}</span>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Close exited session</TooltipContent>
                              </Tooltip>
                            ) : null}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {filteredPeerHosts.length === 0 ? (
            <div className="px-2.5 py-2 text-sm text-muted-foreground">{normalizedQuery ? "No matching peers" : "No peer hosts on 10001+"}</div>
          ) : null}
        </div>

        <Separator className="my-4" />

        <div className="mb-2 flex items-center justify-between px-2">
          <div className="text-xs font-medium text-muted-foreground">Host processes</div>
          <div className="flex items-center gap-1">
            <Badge variant="muted">{filteredHostProcesses.length}</Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" onClick={onRefreshHost}>
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Refresh host processes</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh host processes</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="space-y-1 pb-3">
          {visibleHostProcesses.map((item) => {
            const launchSpec = launchSpecForHostProcess(item, profiles);
            const bridgeCommand = bridgeCommandForHostProcess(item, bridgeCommands);
            return (
              <div key={`${item.pid}-${item.name}`} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground">
                <Unplug className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{item.name}</span>
                    <span className="font-mono text-xs">{item.pid}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs" title={item.commandLine ?? item.reason}>
                    {item.commandLine ?? item.reason}
                  </span>
                </span>
                {launchSpec ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="iconSm"
                        className="h-7 w-7 shrink-0"
                        onClick={() => onCreateSession(launchSpec.options)}
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="sr-only">Start managed {launchSpec.label}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Start managed {launchSpec.label}</TooltipContent>
                  </Tooltip>
                ) : null}
                {bridgeCommand ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="iconSm"
                        className="h-7 w-7 shrink-0"
                        onClick={() => onCopyBridgeCommand(bridgeCommand)}
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="sr-only">Copy bridge command</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-80">
                      <span className="break-all font-mono text-xs">{bridgeCommand}</span>
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            );
          })}
          {filteredHostProcesses.length > visibleHostProcesses.length ? (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              Showing {visibleHostProcesses.length} of {filteredHostProcesses.length}
            </div>
          ) : null}
          {filteredHostProcesses.length === 0 ? (
            <div className="px-2.5 py-2 text-sm text-muted-foreground">{normalizedQuery ? "No matching host processes" : "No host terminals detected"}</div>
          ) : null}
        </div>
      </div>

      <div className="border-t px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Radio className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span>ConPTY transport, peer proxy ready</span>
        </div>
      </div>
    </div>
  );
}

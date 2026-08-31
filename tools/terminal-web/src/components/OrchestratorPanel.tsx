import { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Loader2,
  PanelRightClose,
  Play,
  Power,
  RotateCcw,
  ScanEye,
  Sparkles,
  SquareTerminal
} from "lucide-react";
import { CommandBar } from "@/components/CommandBar";
import { TerminalSurface } from "@/components/TerminalSurface";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalSocket, type SocketStatus } from "@/lib/terminal-socket";
import { cn } from "@/lib/utils";
import type { OrchestratorAgent, OrchestratorStatus, TerminalSessionSummary } from "@/lib/types";

const WIDTH_KEY = "terminal-web.orchestrator.width";
const AGENT_KEY = "terminal-web.orchestrator.agent";
const MIN_WIDTH = 340;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 430;

const AGENT_LABELS: Record<OrchestratorAgent, string> = {
  claude: "Claude Code",
  codex: "Codex"
};

const QUICK_PROMPTS: Array<{ label: string; prompt: string }> = [
  {
    label: "Summarize sessions",
    prompt: "Summarize what every terminal session is doing right now. Keep it tight: one line per session."
  },
  {
    label: "What needs me?",
    prompt: "Which sessions are stuck, erroring, or waiting for my input right now? Check the ones that look suspicious."
  },
  {
    label: "Tidy up",
    prompt:
      "Find sessions that look finished or idle and suggest which ones to close. Don't close anything without asking me first."
  }
];

interface CapabilityRowProps {
  icon: typeof ScanEye;
  text: string;
}

function CapabilityRow({ icon: Icon, text }: CapabilityRowProps) {
  return (
    <div className="flex items-center gap-2.5 text-left">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-secondary/60 text-primary">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className="text-xs text-muted-foreground">{text}</span>
    </div>
  );
}

function loadStoredWidth(): number {
  const raw = Number(window.localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH ? Math.floor(raw) : DEFAULT_WIDTH;
}

function loadStoredAgent(available: OrchestratorAgent[]): OrchestratorAgent | undefined {
  const raw = window.localStorage.getItem(AGENT_KEY);
  if (raw === "claude" || raw === "codex") {
    if (available.length === 0 || available.includes(raw)) {
      return raw;
    }
  }
  return available.includes("claude") ? "claude" : available[0];
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsDesktop(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isDesktop;
}

interface OrchestratorPanelProps {
  orchestrator?: OrchestratorStatus;
  session?: TerminalSessionSummary;
  socketStatus: SocketStatus;
  open: boolean;
  pulse: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (agent: OrchestratorAgent, restart?: boolean) => Promise<void>;
  onStop: () => Promise<void>;
}

export function OrchestratorPanel({
  orchestrator,
  session,
  socketStatus,
  open,
  pulse,
  onOpenChange,
  onStart,
  onStop
}: OrchestratorPanelProps) {
  const isDesktop = useIsDesktop();
  const available = orchestrator?.availableAgents ?? [];
  const [agent, setAgent] = useState<OrchestratorAgent | undefined>(() => loadStoredAgent(available));
  const [width, setWidth] = useState(loadStoredWidth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focusSignal, setFocusSignal] = useState(0);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | undefined>();

  const state = orchestrator?.state ?? "stopped";
  const activeAgent = orchestrator?.agent;
  const hasLiveSession = Boolean(session && (state === "running" || state === "starting"));

  useEffect(() => {
    if (agent && available.includes(agent)) {
      return;
    }
    setAgent(loadStoredAgent(available));
  }, [available.join(","), agent]);

  useEffect(() => {
    if (open && hasLiveSession) {
      setFocusSignal((value) => value + 1);
    }
  }, [open, hasLiveSession]);

  function selectAgent(next: OrchestratorAgent) {
    setAgent(next);
    window.localStorage.setItem(AGENT_KEY, next);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function sendPrompt(prompt: string) {
    if (!session || session.status !== "running" || socketStatus !== "open") {
      return;
    }
    // Bracketed paste keeps the agent TUI from treating the prompt as
    // keystrokes; Enter follows after a beat so the paste is registered first.
    terminalSocket.send({ type: "input", sessionId: session.id, data: `\x1b[200~${prompt}\x1b[201~` });
    window.setTimeout(() => {
      terminalSocket.send({ type: "input", sessionId: session.id, data: "\r" });
    }, 160);
    setFocusSignal((value) => value + 1);
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>) {
    dragStateRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (!drag) {
      return;
    }
    const next = Math.max(MIN_WIDTH, Math.min(drag.startWidth + (drag.startX - event.clientX), MAX_WIDTH));
    setWidth(next);
  }

  function endResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStateRef.current) {
      return;
    }
    dragStateRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    window.localStorage.setItem(WIDTH_KEY, String(width));
  }

  const statusDot =
    state === "running" ? "bg-emerald-500" : state === "starting" ? "animate-pulse bg-amber-400" : "bg-muted-foreground/40";
  const subtitle =
    state === "stopped"
      ? "Not running"
      : `${activeAgent ? AGENT_LABELS[activeAgent] : "Agent"} · ${state === "starting" ? "starting" : "running"}`;

  // Collapsed: a slim rail on desktop keeps the orchestrator one click away
  // (with an activity pulse); on mobile the header button is the way in.
  if (!open) {
    return (
      <aside className="hidden w-11 shrink-0 flex-col items-center gap-3 border-l bg-sidebar py-3 lg:flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="iconSm" className="relative" onClick={() => onOpenChange(true)}>
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
              {pulse ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              ) : null}
              <span className="sr-only">Open orchestrator</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Orchestrator</TooltipContent>
        </Tooltip>
        <span className={cn("h-1.5 w-1.5 rounded-full", statusDot)} aria-hidden="true" />
        <span className="select-none text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground [writing-mode:vertical-rl]">
          Orchestrator
        </span>
      </aside>
    );
  }

  const content = (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-gradient-to-br from-primary/25 via-primary/10 to-transparent text-primary">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Orchestrator</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDot)} aria-hidden="true" />
            <span className="truncate">{subtitle}</span>
          </div>
        </div>
        {state !== "stopped" && activeAgent ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="iconSm"
                  disabled={busy}
                  onClick={() => void run(() => onStart(activeAgent, true))}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Restart orchestrator</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Restart</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" disabled={busy} onClick={() => void run(onStop)}>
                  <Power className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Stop orchestrator</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop</TooltipContent>
            </Tooltip>
          </>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="iconSm" onClick={() => onOpenChange(false)}>
              <PanelRightClose className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Collapse orchestrator</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Collapse</TooltipContent>
        </Tooltip>
      </header>

      {hasLiveSession && session ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <TerminalSurface
            session={session}
            targetId={session.id}
            slot="orchestrator"
            copySignal={0}
            focusSignal={focusSignal}
            socketStatus={socketStatus}
          />
          {state === "starting" ? (
            <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Starting {activeAgent ? AGENT_LABELS[activeAgent] : "agent"}
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t bg-background px-2 py-1.5">
            {QUICK_PROMPTS.map((quick) => (
              <button
                key={quick.label}
                type="button"
                className="shrink-0 rounded-full border bg-secondary/40 px-2.5 py-1 text-[11px] font-medium text-secondary-foreground transition-colors hover:bg-secondary disabled:opacity-45"
                disabled={state !== "running" || socketStatus !== "open"}
                onClick={() => sendPrompt(quick.prompt)}
              >
                {quick.label}
              </button>
            ))}
          </div>
          {!isDesktop ? <CommandBar session={session} targetId={session.id} socketStatus={socketStatus} /> : null}
          {error ? <div className="border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground">{error}</div> : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-gradient-to-br from-primary/30 via-primary/10 to-transparent text-primary shadow-sm">
            {state === "starting" || busy ? (
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-6 w-6" aria-hidden="true" />
            )}
          </span>
          <h3 className="mt-4 text-sm font-semibold">Command every terminal</h3>
          <p className="mt-1 max-w-[280px] text-xs leading-relaxed text-muted-foreground">
            One agent that watches every session on this host — it summarizes, opens, closes, and drives them for you.
          </p>

          <div className="mt-5 flex w-full max-w-[280px] flex-col gap-2.5">
            <CapabilityRow icon={ScanEye} text="Reads and summarizes any session" />
            <CapabilityRow icon={SquareTerminal} text="Opens and closes terminals on demand" />
            <CapabilityRow icon={Keyboard} text="Types into shells and drives other agents" />
          </div>

          {available.length > 0 ? (
            <>
              <div className="mt-6 grid w-full max-w-[280px] grid-cols-2 gap-0.5 rounded-md border bg-background p-0.5">
                {(["claude", "codex"] as const).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    disabled={!available.includes(candidate)}
                    className={cn(
                      "rounded-[5px] px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-40",
                      agent === candidate ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => selectAgent(candidate)}
                  >
                    {AGENT_LABELS[candidate]}
                  </button>
                ))}
              </div>
              <Button
                className="mt-3 w-full max-w-[280px]"
                disabled={!agent || busy || state !== "stopped"}
                onClick={() => agent && void run(() => onStart(agent))}
              >
                <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Start orchestrator
              </Button>
            </>
          ) : (
            <p className="mt-6 max-w-[280px] text-xs text-muted-foreground">
              Install the <span className="font-mono">claude</span> or <span className="font-mono">codex</span> CLI on this host to
              enable the orchestrator.
            </p>
          )}

          {error ? <p className="mt-3 max-w-[280px] break-words text-xs text-destructive-foreground">{error}</p> : null}
          {orchestrator?.lastExit && state === "stopped" && !error ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Last run exited
              {typeof orchestrator.lastExit.exitCode === "number" ? ` (code ${orchestrator.lastExit.exitCode})` : ""} at{" "}
              {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(orchestrator.lastExit.at))}
            </p>
          ) : null}
        </div>
      )}
    </>
  );

  if (!isDesktop) {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-background/70 backdrop-blur-[2px]" onClick={() => onOpenChange(false)} aria-hidden="true" />
        <aside className="fixed inset-y-0 right-0 z-50 flex w-[min(440px,100vw)] flex-col border-l bg-sidebar shadow-lg">
          {content}
        </aside>
      </>
    );
  }

  return (
    <aside className="relative hidden shrink-0 flex-col border-l bg-sidebar lg:flex" style={{ width }}>
      <div
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/40"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize orchestrator panel"
      />
      {content}
    </aside>
  );
}

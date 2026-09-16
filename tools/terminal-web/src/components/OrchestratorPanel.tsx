import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  Bell,
  Bot,
  Check,
  ChevronDown,
  Clock,
  Eye,
  FolderOpen,
  Keyboard,
  ListChecks,
  Loader2,
  PanelRightClose,
  Pencil,
  Plus,
  RefreshCw,
  Reply,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  cancelOrchestrator,
  clearOrchestrator,
  getOrchestrator,
  getOrchestratorModels,
  sendOrchestratorMessage,
  testOrchestratorConnection,
  updateOrchestratorConfig,
  type OrchestratorConfigPatch
} from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type {
  OrchestratorCatalog,
  OrchestratorConfig,
  OrchestratorModel,
  OrchestratorStatus,
  OrchestratorTranscriptItem
} from "@/lib/types";

const WIDTH_KEY = "terminal-web.orchestrator.width";
const MIN_WIDTH = 340;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 440;

const QUICK_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: "What's every tab doing?", prompt: "What is every tab doing right now? One line per tab." },
  { label: "What needs me?", prompt: "Which tabs are waiting on me, stuck, or showing errors? Check anything suspicious." },
  { label: "Summarize the agents", prompt: "For each tab running Claude Code or Codex, tell me what it is working on and how far along it is." }
];

const TOOL_ICONS: Record<string, typeof Eye> = {
  list_sessions: ListChecks,
  read_session: Eye,
  send_input: Keyboard,
  send_keys: Keyboard,
  answer_prompt: Reply,
  wait_for_output: Clock,
  create_session: Plus,
  close_session: X,
  rename_session: Pencil,
  list_projects: FolderOpen,
  notify_user: Bell
};

function loadStoredWidth(): number {
  const raw = Number(window.localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH ? Math.floor(raw) : DEFAULT_WIDTH;
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

function modelLabel(id: string | undefined, catalog?: OrchestratorCatalog): string {
  if (!id) {
    return "No model";
  }
  const match = catalog?.models.find((model) => model.id === id) ?? catalog?.recommended.find((model) => model.id === id);
  if (match) {
    return match.name.replace(/^[^:]+:\s*/, "");
  }
  return id.split("/").pop() ?? id;
}

function formatContext(length: number): string {
  if (!length) return "";
  if (length >= 1_000_000) return `${(length / 1_000_000).toFixed(length % 1_000_000 ? 1 : 0)}M ctx`;
  return `${Math.round(length / 1000)}k ctx`;
}

function formatPrice(model: OrchestratorModel): string {
  if (!model.promptPrice && !model.completionPrice) return "";
  return `$${model.promptPrice.toFixed(2)} / $${model.completionPrice.toFixed(2)} per 1M`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- transcript ---

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70"
          style={{ animationDelay: `${dot * 120}ms` }}
        />
      ))}
    </span>
  );
}

function ToolItem({ item }: { item: OrchestratorTranscriptItem }) {
  const [open, setOpen] = useState(false);
  const tool = item.tool;
  if (!tool) {
    return null;
  }
  const Icon = TOOL_ICONS[tool.name] ?? Sparkles;
  const running = item.status === "streaming";
  const failed = item.status === "error" || !tool.ok;
  return (
    <div className="my-1 rounded-md border border-border/70 bg-secondary/25 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-secondary/40"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border bg-background text-primary">
          <Icon className="h-3 w-3" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground/90">{tool.summary || tool.name}</span>
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : failed ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive-foreground" aria-hidden="true" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="space-y-1.5 border-t border-border/60 px-2.5 py-2">
          <div className="font-mono text-[11px] text-muted-foreground">
            {tool.name}({JSON.stringify(tool.arguments)})
          </div>
          {tool.result ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-terminal px-2 py-1.5 font-mono text-[11px] leading-snug text-terminal-foreground">
              {tool.result}
            </pre>
          ) : running ? (
            <div className="text-muted-foreground">Running…</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TranscriptItemView({ item }: { item: OrchestratorTranscriptItem }) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/30 bg-primary/15 px-3 py-2 text-sm">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.role === "tool") {
    return <ToolItem item={item} />;
  }
  if (item.role === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="break-words">{item.text}</span>
      </div>
    );
  }
  const streaming = item.status === "streaming";
  const showBody = item.text.length > 0 || (streaming && !item.toolCalls?.length);
  if (!showBody && !item.reasoning) {
    return null;
  }
  return (
    <div className="text-sm leading-relaxed">
      {item.reasoning ? (
        <details className="mb-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Thinking</summary>
          <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2 italic">{item.reasoning}</div>
        </details>
      ) : null}
      {item.text ? <Markdown text={item.text} /> : streaming ? <TypingDots /> : null}
      {item.status === "cancelled" ? <div className="mt-1 text-[11px] text-muted-foreground">Stopped.</div> : null}
    </div>
  );
}

// --- settings ---

interface SettingsViewProps {
  config?: OrchestratorConfig;
  status?: OrchestratorStatus;
  onSaved: () => void;
  onClose: () => void;
}

function SettingsView({ config, status, onSaved, onClose }: SettingsViewProps) {
  const [provider, setProvider] = useState<OrchestratorConfig["provider"]>(config?.provider ?? "openrouter");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [model, setModel] = useState(config?.model ?? "");
  const [keyEnv, setKeyEnv] = useState(config?.keyEnv ?? "OPENROUTER_API_KEY");
  const [reasoning, setReasoning] = useState<OrchestratorConfig["reasoning"]>(config?.reasoning ?? "low");
  const [apiKey, setApiKey] = useState("");
  const [catalog, setCatalog] = useState<OrchestratorCatalog | undefined>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();

  useEffect(() => {
    setProvider(config?.provider ?? "openrouter");
    setBaseUrl(config?.baseUrl ?? "");
    setModel(config?.model ?? "");
    setKeyEnv(config?.keyEnv ?? "OPENROUTER_API_KEY");
    setReasoning(config?.reasoning ?? "low");
  }, [config?.provider, config?.baseUrl, config?.model, config?.keyEnv, config?.reasoning]);

  async function loadCatalog(refresh = false) {
    setCatalogLoading(true);
    try {
      setCatalog(await getOrchestratorModels(refresh));
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) });
    } finally {
      setCatalogLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.provider, config?.baseUrl]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !catalog) return [];
    return catalog.models
      .filter((candidate) => candidate.id.toLowerCase().includes(needle) || candidate.name.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [catalog, query]);

  async function save(extra: OrchestratorConfigPatch = {}) {
    setBusy(true);
    setMessage(undefined);
    try {
      await updateOrchestratorConfig({
        provider,
        baseUrl: provider === "custom" ? baseUrl : undefined,
        model,
        keyEnv,
        reasoning,
        ...extra
      });
      setApiKey("");
      setMessage({ ok: true, text: "Saved." });
      onSaved();
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await testOrchestratorConnection();
      setMessage({ ok: result.ok, text: result.message });
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const keyStatus =
    config?.keySource === "manual"
      ? `Using a key entered here (${config.keyPreview ?? "…"}).`
      : config?.keySource === "env"
        ? `Using ${config.keyEnv} from the environment (${config.keyPreview ?? "…"}).`
        : `No key found. Set ${config?.keyEnv ?? "OPENROUTER_API_KEY"} in your environment or paste one below.`;

  const recommended = catalog?.recommended ?? [];
  const usage = status?.usage;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 text-sm">
      <section className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Endpoint</div>
        <div className="grid grid-cols-2 gap-0.5 rounded-md border bg-background p-0.5">
          {(["openrouter", "custom"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={cn(
                "rounded-[5px] px-2 py-1.5 text-xs font-medium transition-colors",
                provider === candidate ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => {
                setProvider(candidate);
                if (candidate === "openrouter") {
                  setBaseUrl(config?.defaults?.openrouterBaseUrl ?? "https://openrouter.ai/api/v1");
                  setKeyEnv(config?.defaults?.openrouterKeyEnv ?? "OPENROUTER_API_KEY");
                } else if (keyEnv === (config?.defaults?.openrouterKeyEnv ?? "OPENROUTER_API_KEY")) {
                  setKeyEnv(config?.defaults?.customKeyEnv ?? "OPENAI_API_KEY");
                }
              }}
            >
              {candidate === "openrouter" ? "OpenRouter" : "Custom OpenAI-compatible"}
            </button>
          ))}
        </div>
        {provider === "custom" ? (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Base URL (the part before /chat/completions)</span>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:11434/v1" className="h-8 font-mono text-xs" />
          </label>
        ) : null}
      </section>

      <section className="mt-4 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">API key</div>
        <p className="text-xs text-muted-foreground">{keyStatus}</p>
        <div className="flex gap-1.5">
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider === "openrouter" ? "sk-or-v1-…" : "Paste a key"}
            className="h-8 font-mono text-xs"
          />
          <Button size="sm" variant="secondary" disabled={busy || !apiKey.trim()} onClick={() => void save({ apiKey: apiKey.trim() })}>
            Use key
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Env var</span>
            <Input value={keyEnv} onChange={(event) => setKeyEnv(event.target.value)} className="h-7 font-mono text-[11px]" />
          </label>
          {config?.keySource === "manual" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save({ apiKey: "" })}>
              Forget key
            </Button>
          ) : null}
        </div>
      </section>

      <section className="mt-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Model</div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={catalogLoading}
            onClick={() => void loadCatalog(true)}
          >
            <RefreshCw className={cn("h-3 w-3", catalogLoading && "animate-spin")} aria-hidden="true" />
            Refresh list
          </button>
        </div>
        <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="anthropic/claude-sonnet-5" className="h-8 font-mono text-xs" />
        {catalog?.error ? <p className="text-xs text-destructive-foreground">{catalog.error}</p> : null}
        {recommended.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">Recommended for coding</div>
            <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border bg-background p-1">
              {recommended.map((candidate) => (
                <ModelRow key={candidate.id} model={candidate} selected={candidate.id === model} onSelect={() => setModel(candidate.id)} />
              ))}
            </div>
          </div>
        ) : catalogLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Loading models…
          </div>
        ) : null}
        {catalog && catalog.models.length > 0 ? (
          <div className="space-y-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search all ${catalog.models.length} models…`}
              className="h-8 text-xs"
            />
            {filtered.length > 0 ? (
              <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border bg-background p-1">
                {filtered.map((candidate) => (
                  <ModelRow key={candidate.id} model={candidate} selected={candidate.id === model} onSelect={() => setModel(candidate.id)} />
                ))}
              </div>
            ) : query.trim() ? (
              <div className="px-1 text-xs text-muted-foreground">No models match.</div>
            ) : null}
          </div>
        ) : null}
        {provider === "openrouter" ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Reasoning effort</span>
            <select
              value={reasoning}
              onChange={(event) => setReasoning(event.target.value as OrchestratorConfig["reasoning"])}
              className="h-7 rounded-md border bg-background px-2 text-xs text-foreground"
            >
              <option value="off">Off</option>
              <option value="low">Low (fast)</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        ) : null}
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Save
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void test()}>
          Test connection
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Back to chat
        </Button>
      </div>
      {message ? (
        <p className={cn("mt-2 text-xs", message.ok ? "text-emerald-500" : "text-destructive-foreground")}>{message.text}</p>
      ) : null}
      {usage && usage.turns > 0 ? (
        <p className="mt-4 text-[11px] text-muted-foreground">
          {usage.turns} turn{usage.turns === 1 ? "" : "s"} · {formatTokens(usage.promptTokens)} in / {formatTokens(usage.completionTokens)} out
          {usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : ""}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Settings and any pasted key are stored by the terminal host in its local data folder; keys never reach other clients.
      </p>
    </div>
  );
}

function ModelRow({ model, selected, onSelect }: { model: OrchestratorModel; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/60",
        selected && "bg-secondary text-secondary-foreground"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{model.name.replace(/^[^:]+:\s*/, "")}</span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground">{model.id}</span>
      </span>
      <span className="shrink-0 text-right text-[10px] text-muted-foreground">
        {formatContext(model.contextLength)}
        {formatPrice(model) ? <span className="block">{formatPrice(model)}</span> : null}
      </span>
      {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
    </button>
  );
}

// --- panel ---

interface OrchestratorPanelProps {
  orchestrator?: OrchestratorStatus;
  open: boolean;
  pulse: boolean;
  onOpenChange: (open: boolean) => void;
  onStatus: (status: OrchestratorStatus) => void;
}

export function OrchestratorPanel({ orchestrator, open, pulse, onOpenChange, onStatus }: OrchestratorPanelProps) {
  const isDesktop = useIsDesktop();
  const [width, setWidth] = useState(loadStoredWidth);
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<OrchestratorCatalog | undefined>();
  const dragStateRef = useRef<{ startX: number; startWidth: number } | undefined>();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const state = orchestrator?.state ?? "idle";
  const running = state === "running";
  const transcript = orchestrator?.transcript ?? [];
  const config = orchestrator?.config;

  // The model label wants the catalog; fetch it lazily once the panel opens.
  useEffect(() => {
    if (!open || catalog || state === "unavailable") return;
    getOrchestratorModels()
      .then(setCatalog)
      .catch(() => undefined);
  }, [open, catalog, state]);

  useEffect(() => {
    if (state === "unconfigured" && open) {
      setView("settings");
    }
  }, [state, open]);

  useEffect(() => {
    if (!open || view !== "chat") return;
    const scroller = scrollerRef.current;
    if (scroller && stickRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [open, view, transcript]);

  useEffect(() => {
    if (open && view === "chat") {
      composerRef.current?.focus();
    }
  }, [open, view]);

  function onScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    stickRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  async function refreshStatus() {
    try {
      onStatus(await getOrchestrator());
    } catch {
      // The socket keeps the status current; a failed refresh is not fatal.
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || running || busy) return;
    setBusy(true);
    setError("");
    try {
      stickRef.current = true;
      onStatus(await sendOrchestratorMessage(trimmed));
      setDraft("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
      composerRef.current?.focus();
    }
  }

  async function stop() {
    setBusy(true);
    try {
      onStatus(await cancelOrchestrator());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (transcript.length === 0) return;
    setBusy(true);
    try {
      onStatus(await clearOrchestrator());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>) {
    dragStateRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (!drag) return;
    setWidth(Math.max(MIN_WIDTH, Math.min(drag.startWidth + (drag.startX - event.clientX), MAX_WIDTH)));
  }

  function endResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStateRef.current) return;
    dragStateRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    window.localStorage.setItem(WIDTH_KEY, String(width));
  }

  const label = modelLabel(config?.model, catalog);
  const step = orchestrator?.activeTurn?.step;
  const subtitle =
    state === "unavailable"
      ? "Not available on this host"
      : state === "unconfigured"
        ? "Needs an API key"
        : running
          ? `${label} · ${step && step !== "thinking" ? step.replace(/_/g, " ") : "thinking"}…`
          : `${label} · ready`;
  const statusDot =
    running ? "animate-pulse bg-amber-400" : state === "idle" ? "bg-emerald-500" : "bg-muted-foreground/40";
  const rows = Math.min(6, Math.max(1, draft.split("\n").length));

  if (!open) {
    return (
      <aside
        data-orchestrator-panel="collapsed"
        className="hidden w-11 shrink-0 flex-col items-center gap-3 border-l border-border/90 bg-[#14161b] py-3 shadow-[-10px_0_24px_rgba(0,0,0,0.32)] lg:flex"
      >
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
        {state !== "unavailable" ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="iconSm" disabled={busy || transcript.length === 0} onClick={() => void clear()}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Clear conversation</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear conversation</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="iconSm"
                  className={cn(view === "settings" && "bg-secondary")}
                  onClick={() => setView((current) => (current === "settings" ? "chat" : "settings"))}
                >
                  <Settings2 className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Model and endpoint settings</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Model &amp; endpoint</TooltipContent>
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

      {state === "unavailable" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-8 text-center">
          <Bot className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-semibold">Orchestrator lives in the terminal host</h3>
          <p className="mt-1 max-w-[300px] text-xs leading-relaxed text-muted-foreground">
            {orchestrator?.error ?? "Connect to the Windows Terminal bridge host to chat with the orchestrator."}
          </p>
        </div>
      ) : view === "settings" ? (
        <>
          {state === "unconfigured" ? (
            <div className="border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Add an OpenRouter key to start: set <span className="font-mono">{config?.keyEnv ?? "OPENROUTER_API_KEY"}</span> or paste a key below.
            </div>
          ) : null}
          <SettingsView config={config} status={orchestrator} onSaved={() => void refreshStatus()} onClose={() => setView("chat")} />
        </>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {transcript.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl border bg-gradient-to-br from-primary/30 via-primary/10 to-transparent text-primary">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-3 text-sm font-semibold">Ask about your tabs</h3>
                <p className="mt-1 max-w-[280px] text-xs leading-relaxed text-muted-foreground">
                  The orchestrator sees every terminal on this machine: what is running, where, and whether it needs you. It can
                  read, type into, open and close tabs for you.
                </p>
                <div className="mt-4 flex flex-col gap-1.5">
                  {QUICK_PROMPTS.map((quick) => (
                    <button
                      key={quick.label}
                      type="button"
                      className="rounded-full border bg-secondary/40 px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary disabled:opacity-45"
                      disabled={running || busy}
                      onClick={() => void send(quick.prompt)}
                    >
                      {quick.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                {transcript.map((item) => (
                  <TranscriptItemView key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>

          {orchestrator?.error && !running ? (
            <div className="border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground">{orchestrator.error}</div>
          ) : null}
          {error ? <div className="border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground">{error}</div> : null}

          <div className="shrink-0 border-t bg-background px-2.5 py-2">
            {transcript.length > 0 && !running ? (
              <div className="mb-1.5 flex items-center gap-1.5 overflow-x-auto">
                {QUICK_PROMPTS.map((quick) => (
                  <button
                    key={quick.label}
                    type="button"
                    className="shrink-0 rounded-full border bg-secondary/40 px-2.5 py-1 text-[11px] font-medium text-secondary-foreground transition-colors hover:bg-secondary disabled:opacity-45"
                    disabled={busy}
                    onClick={() => void send(quick.prompt)}
                  >
                    {quick.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex items-end gap-1.5">
              <Textarea
                ref={composerRef}
                value={draft}
                rows={rows}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={running ? "Working… (you can stop it)" : "Ask about your tabs, or tell it what to do"}
                className="min-h-0 resize-none py-2 text-sm"
              />
              {running ? (
                <Button size="icon" variant="secondary" disabled={busy} onClick={() => void stop()} aria-label="Stop">
                  <Square className="h-4 w-4" aria-hidden="true" />
                </Button>
              ) : (
                <Button size="icon" disabled={busy || !draft.trim()} onClick={() => void send(draft)} aria-label="Send">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (!isDesktop) {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-background/70 backdrop-blur-[2px]" onClick={() => onOpenChange(false)} aria-hidden="true" />
        <aside className="fixed inset-y-0 right-0 z-50 flex w-[min(460px,100vw)] flex-col border-l bg-sidebar shadow-lg">{content}</aside>
      </>
    );
  }

  return (
    <aside
      data-orchestrator-panel="expanded"
      className="relative hidden shrink-0 flex-col border-l bg-sidebar lg:flex"
      style={{ width }}
    >
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

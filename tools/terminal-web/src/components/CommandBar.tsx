import { FormEvent, KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ClipboardPaste, CornerDownLeft, SendHorizonal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalSocket, type SocketStatus } from "@/lib/terminal-socket";
import { cn } from "@/lib/utils";
import type { TerminalSessionSummary } from "@/lib/types";

interface CommandBarProps {
  session?: TerminalSessionSummary;
  targetId?: string;
  socketStatus: SocketStatus;
}

type ComposerMode = "line" | "paste";
type HistoryIndex = number | undefined;

const HISTORY_LIMIT = 80;

const controlKeys = [
  { label: "Enter", value: "\r", display: "↵" },
  { label: "Esc", value: "\x1b" },
  { label: "Tab", value: "\t" },
  { label: "Up", value: "\x1b[A", display: "↑" },
  { label: "Down", value: "\x1b[B", display: "↓" },
  { label: "Ctrl+C", value: "\x03" },
  { label: "Ctrl+D", value: "\x04" },
  { label: "Ctrl+L", value: "\x0c" }
];

function normalizeLineInput(value: string): string {
  return `${value.replace(/\r?\n/g, "\r")}\r`;
}

function bracketedPaste(value: string): string {
  return `\x1b[200~${value.replace(/\r\n/g, "\n")}\x1b[201~`;
}

export function CommandBar({ session, targetId, socketStatus }: CommandBarProps) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<ComposerMode>("line");
  const draftsByTargetRef = useRef<Record<string, string>>({});
  const activeTargetRef = useRef<string | undefined>(targetId);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [historyByTarget, setHistoryByTarget] = useState<Record<string, string[]>>({});
  const [historyIndex, setHistoryIndex] = useState<HistoryIndex>();
  const [draftBeforeHistory, setDraftBeforeHistory] = useState("");
  const disabled = !session || session.status !== "running" || socketStatus !== "open";
  const currentHistory = targetId ? historyByTarget[targetId] ?? [] : [];
  const canRecallPrevious = currentHistory.length > 0 && (historyIndex === undefined || historyIndex > 0);
  const canRecallNext = historyIndex !== undefined;
  activeTargetRef.current = targetId;

  useLayoutEffect(() => {
    setValue(targetId ? draftsByTargetRef.current[targetId] ?? "" : "");
    setHistoryIndex(undefined);
    setDraftBeforeHistory("");
  }, [targetId]);

  function updateValue(nextValue: string) {
    setValue(nextValue);
    const activeTargetId = activeTargetRef.current;
    if (activeTargetId) {
      draftsByTargetRef.current[activeTargetId] = nextValue;
    }
  }

  function send(data: string) {
    if (!session || !targetId || disabled) {
      return;
    }

    terminalSocket.send({ type: "input", sessionId: targetId, data });
  }

  function rememberHistory(entry: string) {
    if (!targetId || mode !== "line" || !entry.trim() || entry.length > 4000) {
      return;
    }

    setHistoryByTarget((current) => {
      const existing = current[targetId] ?? [];
      const next = [...existing.filter((item) => item !== entry), entry].slice(-HISTORY_LIMIT);
      return {
        ...current,
        [targetId]: next
      };
    });
  }

  function sendBufferedInput() {
    if (!value) {
      return;
    }

    const sentValue = value;
    send(mode === "line" ? normalizeLineInput(value) : bracketedPaste(value));
    rememberHistory(sentValue);
    updateValue("");
    setHistoryIndex(undefined);
    setDraftBeforeHistory("");
  }

  function focusComposer() {
    textareaRef.current?.focus();
    window.setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }, 0);
  }

  function recallHistory(direction: -1 | 1) {
    if (currentHistory.length === 0) {
      return;
    }
    focusComposer();

    if (historyIndex === undefined) {
      if (direction > 0) {
        return;
      }
      setDraftBeforeHistory(value);
      const nextIndex = currentHistory.length - 1;
      setHistoryIndex(nextIndex);
      updateValue(currentHistory[nextIndex]);
      return;
    }

    const nextIndex = historyIndex + direction;
    if (nextIndex < 0) {
      setHistoryIndex(0);
      updateValue(currentHistory[0]);
      return;
    }

    if (nextIndex >= currentHistory.length) {
      setHistoryIndex(undefined);
      updateValue(draftBeforeHistory);
      setDraftBeforeHistory("");
      return;
    }

    setHistoryIndex(nextIndex);
    updateValue(currentHistory[nextIndex]);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    sendBufferedInput();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    const atStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
    const atEnd = textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length;
    const singleLine = !textarea.value.includes("\n");

    if (event.key === "Enter" && !event.shiftKey && (mode === "line" || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendBufferedInput();
    }

    if (event.key === "ArrowUp" && !event.shiftKey && !event.ctrlKey && (event.altKey || (singleLine && atStart))) {
      event.preventDefault();
      recallHistory(-1);
    }

    if (event.key === "ArrowDown" && !event.shiftKey && !event.ctrlKey && (event.altKey || (historyIndex !== undefined && (singleLine || atEnd)))) {
      event.preventDefault();
      recallHistory(1);
    }
  }

  return (
    <form data-active-target={targetId} onSubmit={onSubmit} className="border-t bg-background/95 px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {controlKeys.map((key) => (
            <Tooltip key={key.label}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 min-w-8 px-2 font-mono text-[11px]"
                  disabled={disabled}
                  onClick={() => send(key.value)}
                  aria-label={key.label}
                >
                  {key.display ?? key.label}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{key.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="flex rounded-md border bg-background p-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="iconSm"
                  className="h-7 w-7"
                  disabled={!canRecallPrevious}
                  onClick={() => recallHistory(-1)}
                >
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Previous composer entry</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous entry</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="iconSm"
                  className="h-7 w-7"
                  disabled={!canRecallNext}
                  onClick={() => recallHistory(1)}
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Next composer entry</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next entry</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex rounded-md border bg-background p-0.5">
            {(["line", "paste"] as ComposerMode[]).map((item) => (
              <button
                key={item}
                type="button"
                className={cn(
                  "inline-flex h-7 min-w-16 items-center justify-center gap-1 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  mode === item ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setMode(item)}
                aria-pressed={mode === item}
              >
                {item === "paste" ? <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                {item === "line" ? "Line" : "Paste"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          aria-label="Terminal composer"
          value={value}
          onChange={(event) => {
            updateValue(event.target.value);
            setHistoryIndex(undefined);
            setDraftBeforeHistory("");
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={
            !session ? "No terminal selected" : socketStatus !== "open" ? "Reconnecting terminal host" : mode === "line" ? "Send to active terminal" : "Paste to active terminal"
          }
          className="max-h-32 min-h-10 resize-none font-mono"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="submit" size="icon" disabled={disabled || !value}>
              <SendHorizonal className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Send</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="inline-flex items-center gap-1">
              Send <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
    </form>
  );
}

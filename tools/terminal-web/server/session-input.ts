import path from "node:path";
import type { TerminalModes } from "./terminal-text.js";
import type { TerminalSessionSummary } from "./types.js";

// What a remote client needs to know before it puts text into a session. The
// host derives this from the already-rendered headless screen: terminal agents
// do not expose their in-TUI questions to external clients, so the rendered
// dialog is the one source that works for managed and bridged sessions alike.

export type AgentKind = "claude" | "codex" | "shell" | "unknown";
export type SessionPromptKind = "single-select" | "multi-select" | "confirm" | "freeform";
export type SessionPromptInteraction = "direct-key" | "cursor" | "numeric-input";
export type SessionPromptTextKind = "answer" | "other" | "notes";

export interface SessionPromptOption {
  /** Stable within this prompt; response calls use this instead of labels. */
  id: string;
  /** Visible shortcut, when the TUI assigned one. */
  key?: string;
  label: string;
  description?: string;
  focused: boolean;
  selected: boolean;
  disabled: boolean;
  /** Claude/Codex's synthetic Other/None-of-the-above entry. */
  custom: boolean;
}

export interface SessionPromptProgress {
  current: number;
  total: number;
  unanswered?: number;
}

export interface SessionPromptTextInput {
  kind: SessionPromptTextKind;
  placeholder: string;
  optional: boolean;
}

export interface SessionPrompt {
  /** Fingerprint of the actionable prompt, excluding focus/selection state. */
  id: string;
  kind: SessionPromptKind;
  interaction: SessionPromptInteraction;
  title?: string;
  question?: string;
  /** Supporting command/path/explanation lines shown above the choices. */
  details: string[];
  options: SessionPromptOption[];
  progress?: SessionPromptProgress;
  textInput?: SessionPromptTextInput;
  acceptsNotes: boolean;
  canSubmit: boolean;
  submitLabel?: string;
  /** Cursor row used by TUIs that render Submit/Next beneath the options. */
  submitTarget?: { index: number; focused: boolean };
  cancelLabel: "Cancel" | "Interrupt";
}

export interface SessionInputContext {
  sessionId: string;
  agent: AgentKind;
  agentLabel: string;
  cwd: string;
  status: "running" | "exited";
  altScreen: boolean;
  bracketedPaste: boolean;
  /**
   * Whether a composed message should be delivered as a bracketed paste.
   * Distinct from `bracketedPaste`, which is only what this mirror observed:
   * a bridged session's buffer starts empty when the host restarts.
   */
  pasteSafe: boolean;
  applicationCursor: boolean;
  mouse: boolean;
  /** The agent is mid-turn, rather than blocked on a question. */
  busy: boolean;
  prompt?: SessionPrompt;
  at: string;
}

export type SessionPromptResponse =
  | { action: "select" | "toggle"; optionId: string }
  | { action: "submit"; optionIds?: string[] }
  | { action: "text"; text: string }
  | { action: "open-notes" }
  | { action: "cancel" };

export type SessionPromptResponsePlan =
  | { method: "keys"; data: string; consumesPrompt: boolean }
  | { method: "compose"; text: string; submit: true; consumesPrompt: boolean };

const AGENT_WINDOW_LINES = 60;
// AskUserQuestion may contain four questions, descriptions, previews and a
// review footer. Forty-eight lines keeps that whole dialog without turning
// old transcript lists into candidates.
const PROMPT_WINDOW_LINES = 48;
const PROMPT_TAIL_SLACK = 18;

const VERTICAL_GUTTER = "│┃┆┇┊┋║▌▐▎|";
const LEADING_FRAME = new RegExp(`^\\s*[${VERTICAL_GUTTER}]\\s?`);
const TRAILING_FRAME = new RegExp(`\\s*[${VERTICAL_GUTTER}]\\s*$`);
const RULE_LINE = /^[─-╿\-_=~\s]+$/;
const FOCUS = "❯>\u203a»▸▶";
const NUMBERED_OPTION = new RegExp(`^(?:([${FOCUS}])\\s*)?(\\d{1,2})[.)]\\s+(?:([${FOCUS}])\\s*)?(.*)$`);
const UNNUMBERED_FOCUSED = new RegExp(`^[${FOCUS}]\\s+(.+)$`);
const CONFIRM_LINE = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i;
const EMPTY_PROMPT_LINE = new RegExp(`^[${FOCUS}▌]\\s*$`);
const PROGRESS_LINE = /^Question\s+(\d+)\s*\/\s*(\d+)(?:\s*\((\d+)\s+unanswered\))?/i;
const TEXT_ENTRY = /^(?:Add notes|Type your answer(?:\s*\((?:optional|required)\))?|Type something\.?|Enter (?:an? )?(?:answer|response|note|text).*)$/i;
const INTERACTION_HINT = /(?:enter|return) to (?:confirm|select|submit|continue|set)|press (?:enter|return)|enter selections|comma-\s*or space-separated/i;
const NUMERIC_INPUT_HINT = /enter (?:a )?selections?\b|comma-\s*or space-separated/i;
const NOTES_HINT = /(?:tab|n) to add notes?|add notes?/i;
const MULTI_HINT = /select all|multi[- ]select|toggle selection|enter selections|selections \(comma|selected options/i;
const SUBMIT_ROW = new RegExp(`^(?:([${FOCUS}])\\s*)?(Submit(?: answers?)?|Next(?: question)?|Review answers)$`, "i");
const DIALOG_META_LINE = /^(?:[◉○◌].*(?:to adjust|effort)|Use \/\S+\b|Preview(?: available)?:)/i;
const FOOTER_LINE = /shift\+tab to cycle|for shortcuts|esc to (?:interrupt|cancel)|ctrl\s*\+\s*[a-z]|⏴|⏵|⏸|·\s+\S|(?:enter|return) to (?:confirm|select|submit|continue|set)|press (?:enter|return)|to navigate questions|add notes?/i;

const CLAUDE_MARKS: Array<[RegExp, number]> = [
  [/shift\+tab to cycle/i, 4],
  [/(?:bypass permissions|accept edits|plan mode) on\b/i, 4],
  [/⏵⏵/, 3],
  [/welcome to claude code/i, 3],
  [/\?\s*for shortcuts/i, 3],
  [/ctrl\+t to (?:hide|show) tasks/i, 2],
  [/\bclaude code\b/i, 1],
  [/^❯\s/m, 1]
];

const CODEX_MARKS: Array<[RegExp, number]> = [
  [/ctrl\+j\s*(?:for\s*)?newline/i, 4],
  [/^\s*›\s/m, 3],
  [/\/approvals\b/, 3],
  [/^\s*•\s*Working\b/im, 2],
  [/\bopenai codex\b/i, 3],
  [/\bcodex\b/i, 1],
  [/^\s*(?:gpt|o\d)[\w.\-]*\s+\w+\s*·\s+\S/im, 3]
];

const BUSY_MARKS = [/\besc to interrupt\b/i, /^\s*•\s*Working\s*\(/im];

interface ScreenLine {
  text: string;
  indent: number;
}

interface ParsedOptionLine {
  index: number;
  key: string;
  label: string;
  description?: string;
  focused: boolean;
  selected: boolean;
  disabled: boolean;
  custom: boolean;
  hasSelectionMarker: boolean;
  selectionMarker?: "checkbox" | "radio" | "word";
}

interface OptionRun {
  start: number;
  end: number;
  options: ParsedOptionLine[];
}

function tail(text: string, lines: number): string[] {
  const all = text.replace(/\r/g, "").split("\n");
  return all.slice(Math.max(0, all.length - lines));
}

function normalizeLine(line: string): ScreenLine {
  const unframed = line.replace(TRAILING_FRAME, "").replace(LEADING_FRAME, "").replace(/\s+$/, "");
  const indent = /^\s*/.exec(unframed)?.[0].length ?? 0;
  return { text: unframed.trim(), indent };
}

function score(text: string, marks: Array<[RegExp, number]>): number {
  let total = 0;
  for (const [pattern, weight] of marks) {
    if (pattern.test(text)) total += weight;
  }
  return total;
}

function executableName(shell: string): string {
  const trimmed = shell.trim();
  const quoted = /^"([^"]+)"/.exec(trimmed);
  const extension = quoted ? undefined : /^.*?\.(?:exe|cmd|bat|com|ps1|sh)\b/i.exec(trimmed);
  const first = quoted?.[1] ?? extension?.[0] ?? trimmed.split(/\s+/)[0] ?? "";
  return path.basename(first).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "");
}

function shellLabel(shell: string): string {
  const name = executableName(shell);
  if (name === "pwsh" || name === "powershell") return "PowerShell";
  if (name === "cmd") return "Command Prompt";
  if (name === "wsl") return "WSL";
  return name || "Terminal";
}

function commandAgent(session: TerminalSessionSummary): AgentKind | undefined {
  // Runtime OSC metadata from bro-cli is the strongest launch signal when the
  // outer terminal itself is just PowerShell/cmd. Screen evidence above can
  // still override it if a different agent is visibly in the foreground.
  if (session.agent === "claude" || session.agent === "codex") return session.agent;
  const command = `${session.shell} ${session.args.join(" ")}`.toLowerCase();
  const executable = executableName(session.shell);
  if (executable.startsWith("claude") || /(?:^|[\s"'\\/])claude(?:\.exe)?(?:\s|$)/.test(command)) return "claude";
  if (executable.startsWith("codex") || /(?:^|[\s"'\\/])codex(?:\.exe)?(?:\s|$)/.test(command)) return "codex";
  return undefined;
}

export function detectAgent(session: TerminalSessionSummary, screenText: string): { agent: AgentKind; label: string } {
  const window = tail(screenText, AGENT_WINDOW_LINES).join("\n");
  const claude = score(window, CLAUDE_MARKS);
  const codex = score(window, CODEX_MARKS);

  if (claude >= 4 && claude > codex) return { agent: "claude", label: "Claude Code" };
  if (codex >= 4 && codex > claude) return { agent: "codex", label: "Codex" };

  const launched = commandAgent(session);
  if (launched === "claude" && codex < 4) return { agent: "claude", label: "Claude Code" };
  if (launched === "codex" && claude < 4) return { agent: "codex", label: "Codex" };
  return { agent: "shell", label: shellLabel(session.shell) };
}

function detectBusy(screenText: string): boolean {
  const window = tail(screenText, AGENT_WINDOW_LINES).join("\n");
  return BUSY_MARKS.some((pattern) => pattern.test(window));
}

function isFurniture(line: string): boolean {
  return !line || RULE_LINE.test(line) || EMPTY_PROMPT_LINE.test(line) || FOOTER_LINE.test(line);
}

function isDialogTrailer(line: string): boolean {
  return isFurniture(line) || SUBMIT_ROW.test(line) || DIALOG_META_LINE.test(line);
}

function splitLabel(value: string): { label: string; description?: string } {
  const clean = value.trim();
  const divider = /\s{2,}|\s+[—–]\s+/.exec(clean);
  if (!divider?.index) return { label: clean };
  const label = clean.slice(0, divider.index).trim();
  const description = clean.slice(divider.index + divider[0].length).trim();
  return description ? { label, description } : { label };
}

function parseOptionBody(value: string): Omit<ParsedOptionLine, "index" | "key" | "focused"> {
  let body = value.trim();
  let selected = false;
  let disabled = false;
  let hasSelectionMarker = false;
  let selectionMarker: ParsedOptionLine["selectionMarker"];

  const wordMarker = /^\((selected|not selected|disabled)\)\s*/i.exec(body);
  if (wordMarker) {
    hasSelectionMarker = true;
    selectionMarker = "word";
    selected = wordMarker[1]!.toLowerCase() === "selected";
    disabled = wordMarker[1]!.toLowerCase() === "disabled";
    body = body.slice(wordMarker[0].length);
  }

  const glyphMarker = /^(\[[ x✓✔]\]|☐|☑|○|◯|◉|◈|●|□|■)\s*/i.exec(body);
  if (glyphMarker) {
    hasSelectionMarker = true;
    selectionMarker = /^\[|^☐|^☑|^□|^■/.test(glyphMarker[1]!) ? "checkbox" : "radio";
    selected = /x|✓|✔|☑|◉|◈|●|■/i.test(glyphMarker[1]!);
    body = body.slice(glyphMarker[0].length);
  }

  const trailingDisabled = /\s+\((?:disabled|unavailable)\)$/i.test(body);
  if (trailingDisabled) {
    disabled = true;
    body = body.replace(/\s+\((?:disabled|unavailable)\)$/i, "");
  }

  const { label, description } = splitLabel(body);
  return {
    label,
    description,
    selected,
    disabled,
    custom: /^(?:other|none of the above)(?:\b|\s|$)/i.test(label),
    hasSelectionMarker,
    selectionMarker
  };
}

function optionId(key: string | undefined, label: string, index: number): string {
  const stem = (key || label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28);
  return `option-${stem || index + 1}-${index + 1}`;
}

function publicOptions(options: ParsedOptionLine[]): SessionPromptOption[] {
  return options.map((option, index) => ({
    id: optionId(option.key, option.label, index),
    key: option.key,
    label: option.label.slice(0, 240),
    description: option.description?.slice(0, 500),
    focused: option.focused,
    selected: option.selected,
    disabled: option.disabled,
    custom: option.custom
  }));
}

function promptProgress(lines: ScreenLine[]): SessionPromptProgress | undefined {
  for (const line of lines) {
    const match = PROGRESS_LINE.exec(line.text);
    if (!match) continue;
    const current = Number(match[1]);
    const total = Number(match[2]);
    const unanswered = match[3] === undefined ? undefined : Number(match[3]);
    if (current >= 1 && total >= current) return { current, total, unanswered };
  }
  return undefined;
}

function stableHash(value: string): string {
  // FNV-1a is compact, deterministic in browsers/Node, and sufficient for a
  // stale-response guard (this is an identity token, not a security hash).
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function withId(prompt: Omit<SessionPrompt, "id">): SessionPrompt {
  const identity = JSON.stringify({
    kind: prompt.kind,
    interaction: prompt.interaction,
    title: prompt.title,
    question: prompt.question,
    details: prompt.details,
    progress: prompt.progress,
    textInput: prompt.textInput,
    options: prompt.options.map(({ key, label, description, disabled, custom }) => ({
      key,
      label,
      description,
      disabled,
      custom
    })),
    acceptsNotes: prompt.acceptsNotes,
    canSubmit: prompt.canSubmit,
    submitLabel: prompt.submitLabel,
    submitTarget: prompt.submitTarget?.index,
    cancelLabel: prompt.cancelLabel
  });
  return { id: `prompt-${stableHash(identity)}`, ...prompt };
}

function copyBefore(lines: ScreenLine[], start: number): {
  title?: string;
  question?: string;
  details: string[];
  progress?: SessionPromptProgress;
} {
  const floor = Math.max(0, start - 18);
  const content = lines
    .slice(floor, start)
    .map((line) => line.text)
    .filter(
      (line) =>
        line &&
        !RULE_LINE.test(line) &&
        !FOOTER_LINE.test(line) &&
        !EMPTY_PROMPT_LINE.test(line) &&
        !NUMBERED_OPTION.test(line) &&
        !UNNUMBERED_FOCUSED.test(line) &&
        !SUBMIT_ROW.test(line)
    );
  const progress = promptProgress(lines.slice(floor, start + 1));
  const withoutProgress = content.filter((line) => !PROGRESS_LINE.test(line));
  if (withoutProgress.length === 0) return { details: [], progress };

  let questionIndex = -1;
  for (let index = withoutProgress.length - 1; index >= 0; index -= 1) {
    if (/\?$/.test(withoutProgress[index]!)) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) questionIndex = withoutProgress.length - 1;

  let questionStart = questionIndex;
  while (questionStart > 0) {
    const previous = withoutProgress[questionStart - 1]!;
    const current = withoutProgress[questionStart]!;
    const looksWrapped = previous.length >= 60 || /^\p{Ll}/u.test(current);
    if (!looksWrapped || /[:.!?]$/.test(previous)) break;
    questionStart -= 1;
  }
  const question = withoutProgress.slice(questionStart, questionIndex + 1).join(" ").slice(0, 500);
  const titleCandidate = withoutProgress.find(
    (line, index) => (index < questionStart || index > questionIndex) && line.length <= 100
  );
  const title = titleCandidate?.replace(/:$/, "");
  const details = withoutProgress
    .filter((line, index) => (index < questionStart || index > questionIndex) && line !== titleCandidate)
    .slice(-8)
    .map((line) => line.slice(0, 500));
  return { title, question, details, progress };
}

function numberedOptionRuns(lines: ScreenLine[]): OptionRun[] {
  const parsed: ParsedOptionLine[] = [];
  lines.forEach((line, index) => {
    const match = NUMBERED_OPTION.exec(line.text);
    if (!match) return;
    const key = match[2]!;
    const body = parseOptionBody(match[4]!);
    if (!body.label || body.label.length > 240) return;
    parsed.push({ index, key, focused: Boolean(match[1] || match[3]), ...body });
  });

  const runs: OptionRun[] = [];
  let current: OptionRun | undefined;
  for (const option of parsed) {
    const expected = current ? current.options.length + 1 : 1;
    const gap = current ? option.index - current.end : 0;
    if (current && Number(option.key) === expected && gap <= 3) {
      // One wrapped line between numbered entries belongs to the preceding
      // option's description rather than breaking the menu.
      const wrapped = lines
        .slice(current.end + 1, option.index)
        .map((line) => line.text)
        .filter((line) => !isFurniture(line));
      if (wrapped.length) {
        const prior = current.options[current.options.length - 1]!;
        prior.description = [prior.description, ...wrapped].filter(Boolean).join(" ").slice(0, 500);
      }
      current.options.push(option);
      current.end = option.index;
    } else if (option.key === "1") {
      current = { start: option.index, end: option.index, options: [option] };
      runs.push(current);
    } else {
      current = undefined;
    }
  }
  return runs;
}

function findNumberedPrompt(lines: ScreenLine[]): SessionPrompt | undefined {
  const windowText = lines.map((line) => line.text).join("\n");
  const hasInteractionHint = INTERACTION_HINT.test(windowText);
  const numericInput = NUMERIC_INPUT_HINT.test(windowText);
  const runs = numberedOptionRuns(lines).filter((run) => {
    const options = run.options;
    const evidence = options.some((option) => option.focused || option.hasSelectionMarker) || hasInteractionHint;
    return (
      evidence &&
      options.length >= 2 &&
      options.length <= 99 &&
      run.end >= lines.length - PROMPT_TAIL_SLACK &&
      lines.slice(run.end + 1).every((line) => isDialogTrailer(line.text))
    );
  });
  const run = runs[runs.length - 1];
  if (!run) return undefined;

  const copy = copyBefore(lines, run.start);
  const checkboxCount = run.options.filter((option) => option.selectionMarker === "checkbox").length;
  const selectedCount = run.options.filter((option) => option.selected).length;
  const multiple = MULTI_HINT.test(windowText) || checkboxCount >= 2 || selectedCount >= 2;
  const options = publicOptions(run.options);
  const cancelLabel = /esc to interrupt/i.test(windowText) ? "Interrupt" : "Cancel";
  const progress = copy.progress ?? promptProgress(lines);
  const submitLine = lines
    .slice(run.end + 1, Math.min(lines.length, run.end + 8))
    .map((line) => SUBMIT_ROW.exec(line.text))
    .find(Boolean);
  const submitTarget = submitLine ? { index: options.length, focused: Boolean(submitLine[1]) } : undefined;

  return withId({
    kind: multiple ? "multi-select" : "single-select",
    interaction: numericInput ? "numeric-input" : "direct-key",
    title: copy.title,
    question: copy.question,
    details: copy.details,
    options,
    progress,
    acceptsNotes: NOTES_HINT.test(windowText),
    canSubmit: multiple,
    submitLabel: multiple ? submitLine?.[2] ?? (progress && progress.current < progress.total ? "Next question" : "Submit answers") : undefined,
    submitTarget,
    cancelLabel
  });
}

function findUnnumberedPrompt(lines: ScreenLine[]): SessionPrompt | undefined {
  let hintIndex = -1;
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 14); index -= 1) {
    if (INTERACTION_HINT.test(lines[index]!.text)) {
      hintIndex = index;
      break;
    }
  }
  if (hintIndex < 0) return undefined;
  if (!lines.slice(hintIndex + 1).every((line) => isFurniture(line.text))) return undefined;

  let end = hintIndex - 1;
  while (end >= 0 && isFurniture(lines[end]!.text)) end -= 1;
  if (end < 0) return undefined;
  let start = end;
  while (start > 0 && lines[start - 1]!.text && !RULE_LINE.test(lines[start - 1]!.text)) start -= 1;

  let block = lines.slice(start, end + 1);
  const focusedAt = block.findIndex((line) => UNNUMBERED_FOCUSED.test(line.text));
  if (focusedAt < 0) return undefined;

  // If the TUI omitted a blank before its list, indentation still identifies
  // the menu rows. Keep the focused row and similarly indented neighbours.
  if (block.length > 12) {
    block = block.slice(Math.max(0, focusedAt - 5), Math.min(block.length, focusedAt + 7));
  }
  const firstFocused = block.findIndex((line) => UNNUMBERED_FOCUSED.test(line.text));
  const optionStart = Math.max(0, firstFocused - block.slice(0, firstFocused).filter((line) => line.indent > 0).length);
  const optionLines = block.slice(optionStart).filter((line) => line.text.length > 0);
  if (optionLines.length < 2 || optionLines.length > 12) return undefined;

  const parsed = optionLines.map((line, index): ParsedOptionLine => {
    const focusMatch = UNNUMBERED_FOCUSED.exec(line.text);
    const body = parseOptionBody(focusMatch?.[1] ?? line.text);
    return { index: start + optionStart + index, key: "", focused: Boolean(focusMatch), ...body };
  });
  if (parsed.some((option) => !option.label || /\?$/.test(option.label))) return undefined;

  const copy = copyBefore(lines, start + optionStart);
  const windowText = lines.map((line) => line.text).join("\n");
  const multiple =
    MULTI_HINT.test(windowText) ||
    parsed.filter((option) => option.selectionMarker === "checkbox").length >= 2 ||
    parsed.filter((option) => option.selected).length >= 2;
  return withId({
    kind: multiple ? "multi-select" : "single-select",
    interaction: "cursor",
    title: copy.title,
    question: copy.question,
    details: copy.details,
    options: publicOptions(parsed),
    progress: copy.progress ?? promptProgress(lines),
    acceptsNotes: NOTES_HINT.test(windowText),
    canSubmit: multiple,
    submitLabel: multiple ? "Submit answers" : undefined,
    cancelLabel: /esc to interrupt/i.test(windowText) ? "Interrupt" : "Cancel"
  });
}

function findTextPrompt(lines: ScreenLine[]): SessionPrompt | undefined {
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 12); index -= 1) {
    const line = lines[index]!.text.replace(new RegExp(`^[${FOCUS}]\\s*`), "").trim();
    if (!TEXT_ENTRY.test(line)) continue;
    if (!lines.slice(index + 1).every((candidate) => isFurniture(candidate.text))) continue;
    const lower = line.toLowerCase();
    const kind: SessionPromptTextKind = lower.startsWith("add notes") || lower.includes("note") ? "notes" : lower.startsWith("type something") ? "other" : "answer";
    const copy = copyBefore(lines, index);
    return withId({
      kind: "freeform",
      interaction: "cursor",
      title: copy.title,
      question: kind === "notes" ? copy.question ?? "Add notes" : copy.question,
      details: copy.details,
      options: [],
      progress: copy.progress ?? promptProgress(lines),
      textInput: {
        kind,
        placeholder: kind === "notes" ? "Add optional notes" : kind === "other" ? "Type another answer" : "Type your answer",
        optional: /optional/i.test(line) || kind === "notes"
      },
      acceptsNotes: false,
      canSubmit: true,
      submitLabel: copy.progress && copy.progress.current < copy.progress.total ? "Next question" : "Submit answer",
      cancelLabel: lines.some((candidate) => /esc to interrupt/i.test(candidate.text)) ? "Interrupt" : "Cancel"
    });
  }
  return undefined;
}

function findConfirmPrompt(lines: ScreenLine[]): SessionPrompt | undefined {
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 8); index -= 1) {
    const line = lines[index]!.text;
    if (!CONFIRM_LINE.test(line)) continue;
    if (!lines.slice(index + 1).every((candidate) => isFurniture(candidate.text))) continue;
    const question = line.replace(CONFIRM_LINE, "").trim().replace(/[:\-]\s*$/, "");
    return withId({
      kind: "confirm",
      interaction: "direct-key",
      question: question.slice(0, 500),
      details: [],
      options: [
        { id: "option-y-1", key: "y", label: "Yes", focused: true, selected: false, disabled: false, custom: false },
        { id: "option-n-2", key: "n", label: "No", focused: false, selected: false, disabled: false, custom: false }
      ],
      acceptsNotes: false,
      canSubmit: false,
      cancelLabel: "Cancel"
    });
  }
  return undefined;
}

export function detectPrompt(screenText: string): SessionPrompt | undefined {
  const lines = tail(screenText, PROMPT_WINDOW_LINES).map(normalizeLine);
  return findTextPrompt(lines) ?? findNumberedPrompt(lines) ?? findUnnumberedPrompt(lines) ?? findConfirmPrompt(lines);
}

function cursorSequence(from: number, to: number, applicationCursor: boolean): string {
  const distance = to - from;
  if (distance === 0) return "";
  const direction = distance > 0 ? "B" : "A";
  const arrow = applicationCursor ? `\x1bO${direction}` : `\x1b[${direction}`;
  return arrow.repeat(Math.abs(distance));
}

/**
 * Convert a semantic mobile action into the smallest terminal interaction.
 * The route calls this only after re-reading and fingerprint-matching the live
 * prompt, so a stale tap cannot spill a digit/Enter into the next question.
 */
export function planPromptResponse(
  prompt: SessionPrompt,
  response: SessionPromptResponse,
  modes: Pick<TerminalModes, "applicationCursor">,
  agent: AgentKind
): SessionPromptResponsePlan {
  if (response.action === "cancel") {
    return { method: "keys", data: "\x1b", consumesPrompt: true };
  }
  if (response.action === "open-notes") {
    if (!prompt.acceptsNotes) throw new Error("This prompt does not accept notes.");
    return { method: "keys", data: agent === "codex" ? "\t" : "n", consumesPrompt: false };
  }
  if (response.action === "text") {
    if (!prompt.textInput) throw new Error("This prompt is not accepting text.");
    if (!response.text.trim() && !prompt.textInput.optional) throw new Error("An answer is required.");
    return { method: "compose", text: response.text, submit: true, consumesPrompt: true };
  }
  if (response.action === "submit") {
    if (!prompt.canSubmit) throw new Error("This prompt does not have a separate submit action.");
    if (prompt.interaction === "numeric-input") {
      const chosen = new Set(response.optionIds ?? []);
      const keys = prompt.options
        .filter((option) => chosen.has(option.id) && !option.disabled)
        .map((option) => option.key)
        .filter((key): key is string => Boolean(key));
      return { method: "keys", data: `${keys.join(",")}\r`, consumesPrompt: true };
    }
    if (prompt.submitTarget) {
      const focusedOption = prompt.options.findIndex((candidate) => candidate.focused);
      const from = prompt.submitTarget.focused ? prompt.submitTarget.index : Math.max(0, focusedOption);
      const move = cursorSequence(from, prompt.submitTarget.index, modes.applicationCursor);
      return { method: "keys", data: `${move}\r`, consumesPrompt: true };
    }
    return { method: "keys", data: "\r", consumesPrompt: true };
  }

  const option = prompt.options.find((candidate) => candidate.id === response.optionId);
  if (!option) throw new Error("That option is no longer available.");
  if (option.disabled) throw new Error("That option is disabled.");
  if (response.action === "toggle" && prompt.kind !== "multi-select") throw new Error("This prompt accepts one answer.");
  if (response.action === "select" && prompt.kind === "multi-select") throw new Error("This prompt accepts multiple answers.");
  if (prompt.interaction === "numeric-input") {
    if (prompt.kind === "multi-select") throw new Error("Numeric-input selections are submitted together.");
    if (!option.key) throw new Error("That option has no numeric shortcut.");
    return { method: "keys", data: `${option.key}\r`, consumesPrompt: true };
  }

  // Numbered single-choice menus advertise direct keys, which avoids relying
  // on the mirror having caught every cursor repaint. Other/None entries are
  // deliberately entered with the cursor so the TUI opens its text field.
  if (response.action === "select" && option.key?.length === 1 && !option.custom) {
    const suffix = prompt.kind === "confirm" ? "\r" : "";
    return { method: "keys", data: `${option.key}${suffix}`, consumesPrompt: true };
  }

  const focusedOption = prompt.options.findIndex((candidate) => candidate.focused);
  const focused = prompt.submitTarget?.focused ? prompt.submitTarget.index : Math.max(0, focusedOption);
  const target = prompt.options.indexOf(option);
  const move = cursorSequence(focused, target, modes.applicationCursor);
  return {
    method: "keys",
    data: `${move}\r`,
    consumesPrompt: response.action === "select"
  };
}

export function describeInputContext(
  session: TerminalSessionSummary,
  screenText: string,
  modes: TerminalModes
): SessionInputContext {
  const { agent, label } = detectAgent(session, screenText);
  const prompt = session.status === "running" ? detectPrompt(screenText) : undefined;
  return {
    sessionId: session.id,
    agent,
    agentLabel: label,
    cwd: session.cwd,
    status: session.status,
    altScreen: modes.altScreen,
    bracketedPaste: modes.bracketedPaste,
    pasteSafe: modes.bracketedPaste || agent === "claude" || agent === "codex",
    applicationCursor: modes.applicationCursor,
    mouse: modes.mouse,
    busy: session.status === "running" && !prompt && detectBusy(screenText),
    prompt,
    at: new Date().toISOString()
  };
}

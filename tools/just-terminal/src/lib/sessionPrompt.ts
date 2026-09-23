import type { SessionPrompt, SessionPromptOption } from "./composerApi";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Native hosts before the full prompt contract omitted details and flags. */
export function normalizeSessionPrompt(value: unknown): SessionPrompt | undefined {
  if (!record(value) || typeof value.id !== "string" || !value.id) return undefined;
  if (!["single-select", "multi-select", "confirm", "freeform"].includes(String(value.kind))) return undefined;
  const options: SessionPromptOption[] = (Array.isArray(value.options) ? value.options : [])
    .filter((option): option is Record<string, unknown> => record(option) && typeof option.id === "string" && typeof option.label === "string")
    .map((option) => ({
      id: option.id as string, label: option.label as string,
      key: typeof option.key === "string" ? option.key : undefined,
      description: typeof option.description === "string" ? option.description : undefined,
      focused: option.focused === true, selected: option.selected === true,
      disabled: option.disabled === true, custom: option.custom === true,
    }));
  const input = record(value.textInput) ? value.textInput : undefined;
  const textInput: SessionPrompt["textInput"] = input && ["answer", "other", "notes"].includes(String(input.kind)) ? {
    kind: input.kind as "answer" | "other" | "notes",
    placeholder: typeof input.placeholder === "string" ? input.placeholder : "Your answer",
    optional: input.optional === true,
  } : undefined;
  if (!options.length && !textInput) return undefined;
  const progress = record(value.progress) ? value.progress : undefined;
  return {
    id: value.id, kind: value.kind as SessionPrompt["kind"],
    interaction: ["cursor", "numeric-input", "direct-key"].includes(String(value.interaction))
      ? value.interaction as SessionPrompt["interaction"] : "direct-key",
    title: typeof value.title === "string" ? value.title : undefined,
    question: typeof value.question === "string" ? value.question : undefined,
    details: Array.isArray(value.details) ? value.details.filter((line): line is string => typeof line === "string") : [],
    options, textInput,
    progress: progress && typeof progress.current === "number" && Number.isFinite(progress.current)
      && typeof progress.total === "number" && Number.isFinite(progress.total) && progress.total > 0
      ? { current: progress.current, total: progress.total } : undefined,
    acceptsNotes: value.acceptsNotes === true, canSubmit: value.canSubmit === true,
    submitLabel: typeof value.submitLabel === "string" ? value.submitLabel : undefined,
    cancelLabel: value.cancelLabel === "Interrupt" ? "Interrupt" : "Cancel",
  };
}

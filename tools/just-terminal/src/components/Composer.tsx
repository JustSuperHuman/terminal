import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import {
  composeInput,
  fetchSlashCommands,
  PromptResponseError,
  respondToPrompt,
  searchSessionFiles,
  type AgentKind,
  type FileHit,
  type SessionInputContext,
  type SessionPromptResponse,
  type SlashCommand,
} from "../lib/composerApi";
import type { ServerEndpoint } from "../lib/endpoint";
import {
  forgetPrompt,
  loadDraft,
  loadPromptHistory,
  rememberPrompt,
  saveDraft,
  type PromptHistoryEntry,
} from "../lib/storage";
import type { DictationControl } from "./CommandBar";
import { AgentPromptCard } from "./AgentPromptCard";
import { ClaudeIcon, CodexIcon, FileIcon, FolderIcon, MicIcon, SendIcon, TerminalGlyph } from "./icons";
import { colors, font, glass, radius, withAlpha } from "../theme";

// A local editing surface for terminal AI agents. Typing straight into a TUI
// over a phone keyboard is miserable — every keystroke round-trips, there is no
// way to fix a typo halfway through a paragraph, and the agent's own `/` and
// `@` popups are unreadable at phone size. So the message is composed here and
// delivered whole (bracketed paste + Enter, decided host-side), with the
// agent's slash commands and the session's files offered as real pickers.

const MAX_INPUT_HEIGHT = 132;
const FILE_SEARCH_DEBOUNCE_MS = 170;
// How long a programmatic caret move stays pinned. Long enough for the native
// field to apply it, short enough that the IME owns the caret while typing —
// holding `selection` controlled the whole time makes Android autocorrect
// fight the cursor.
const FORCED_SELECTION_MS = 60;
const DRAFT_SAVE_DEBOUNCE_MS = 500;

/** Key-row shortcuts that type into the message rather than the terminal. */
export type ComposerToken = "/" | "@" | "newline";

export interface ComposerHandle {
  focus: () => void;
  /** Append text (dictation lands here rather than in the terminal). */
  insertText: (value: string) => void;
  /** Summon a picker (`/`, `@`) or break the line, from the key row. */
  insertToken: (token: ComposerToken) => void;
}

interface ComposerProps {
  endpoint: ServerEndpoint;
  sessionId?: string;
  context?: SessionInputContext;
  /** No live session to send to (exited, socket down, drawer open). */
  disabled: boolean;
  /** This surface should hold the keyboard. */
  active: boolean;
  /** The BlurTargetView behind the bar; required for real blur on Android. */
  blurTarget?: RefObject<View | null>;
  /** Raw byte passthrough, for one-tap replies and the fallback send path. */
  onSendKeys: (data: string) => void;
  onRefreshContext: () => void;
  onNotice: (title: string, body?: string) => void;
  dictation?: DictationControl;
}

type PanelMode = "none" | "slash" | "file" | "history";

interface Token {
  value: string;
  start: number;
  end: number;
}

/** The whitespace-delimited word the caret sits in. */
function currentToken(text: string, caret: number): Token {
  const cursor = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, cursor);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end]!)) {
    end += 1;
  }
  return { value: text.slice(start, end), start, end };
}

function tokenKind(token: Token): PanelMode {
  // Slash commands are only commands at the very start of a message; anywhere
  // else a slash is a path.
  if (token.start === 0 && token.value.startsWith("/")) {
    return "slash";
  }
  if (token.value.startsWith("@")) {
    return "file";
  }
  return "none";
}

const SOURCE_RANK: Record<SlashCommand["source"], number> = { project: 0, user: 1, builtin: 2 };

function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) {
    // With nothing typed, the project's own commands are the interesting ones.
    return [...commands].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name));
  }

  const scored: Array<{ command: SlashCommand; score: number }> = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const description = command.description?.toLowerCase() ?? "";
    let score: number | undefined;
    if (name.startsWith(query)) {
      score = 300 - name.length;
    } else if (name.includes(query)) {
      score = 200 - name.indexOf(query);
    } else if (description.includes(query)) {
      score = 100 - description.indexOf(query);
    }
    if (score !== undefined) {
      scored.push({ command, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
  return scored.map((item) => item.command);
}

function agentBadge(agent: AgentKind | undefined, size: number) {
  if (agent === "claude") {
    return <ClaudeIcon size={size} />;
  }
  if (agent === "codex") {
    return <CodexIcon size={size} color={colors.secondaryForeground} />;
  }
  return <TerminalGlyph size={size} color={colors.mutedForeground} />;
}

function leafName(directory: string | undefined): string {
  if (!directory) {
    return "";
  }
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? directory;
}

function placeholderFor(context: SessionInputContext | undefined): string {
  if (!context) {
    return "Type a message…";
  }
  if (context.agent === "claude" || context.agent === "codex") {
    return context.busy ? `Queue for ${context.agentLabel}…` : `Message ${context.agentLabel}…`;
  }
  return "Run a command…";
}

function relativeTime(at: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { endpoint, sessionId, context, disabled, active, blurTarget, onSendKeys, onRefreshContext, onNotice, dictation },
  ref
) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [history, setHistory] = useState<PromptHistoryEntry[]>([]);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  // Read inside callbacks that must not re-bind on every keystroke.
  const textRef = useRef(text);
  textRef.current = text;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const agent = context?.agent;
  const prompt = context?.prompt;

  const token = useMemo(() => currentToken(text, selection.start), [text, selection.start]);
  const panelMode: PanelMode = historyOpen ? "history" : tokenKind(token);

  // Fade the completion panel in on open (never on slash↔file mode switches —
  // re-fading mid-filter would flicker). It floats absolutely, so the animation
  // never reflows the bar or the terminal; closing unmounts immediately.
  const panelAnim = useRef(new Animated.Value(0)).current;
  const panelVisible = panelMode !== "none";
  useEffect(() => {
    if (!panelVisible) {
      panelAnim.setValue(0);
      return;
    }
    Animated.timing(panelAnim, {
      toValue: 1,
      duration: 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [panelAnim, panelVisible]);

  const applyEdit = useCallback((next: string, caret: number) => {
    setText(next);
    setSelection({ start: caret, end: caret });
    setForcedSelection({ start: caret, end: caret });
  }, []);

  // Release the caret back to the IME shortly after a programmatic move.
  useEffect(() => {
    if (!forcedSelection) {
      return;
    }
    const timer = setTimeout(() => setForcedSelection(undefined), FORCED_SELECTION_MS);
    return () => clearTimeout(timer);
  }, [forcedSelection]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      insertText: (value: string) => {
        const current = textRef.current;
        const spacer = current.length > 0 && !/\s$/.test(current) ? " " : "";
        const next = `${current}${spacer}${value}`;
        applyEdit(next, next.length);
      },
      insertToken: (token: ComposerToken) => {
        const current = textRef.current;
        if (token === "/") {
          // A slash is only a command at the very start, so put it there and
          // leave the caret behind it — whatever was typed becomes the filter.
          const next = current.startsWith("/") ? current : `/${current}`;
          applyEdit(next, 1);
          inputRef.current?.focus();
          return;
        }

        const caret = Math.max(0, Math.min(selectionRef.current.start, current.length));
        const before = current.slice(0, caret);
        // A mention needs a word boundary in front of it or it reads as part of
        // whatever precedes it; a line break never does.
        const insert = token === "newline" ? "\n" : `${before && !/\s$/.test(before) ? " " : ""}@`;
        applyEdit(`${before}${insert}${current.slice(caret)}`, caret + insert.length);
        inputRef.current?.focus();
      },
    }),
    [applyEdit]
  );

  // Take the keyboard whenever this surface becomes the active input — and give
  // it back the moment it stops being (the sessions screen covering us, the
  // session exiting), so the keyboard does not hang over whatever is now on top.
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) {
      const timer = setTimeout(() => inputRef.current?.focus(), 60);
      wasActive.current = true;
      return () => clearTimeout(timer);
    }
    if (!active && wasActive.current) {
      wasActive.current = false;
      inputRef.current?.blur();
    }
  }, [active]);

  // A real agent question replaces the ordinary composer. Hide the keyboard
  // once when that prompt arrives (but never on subsequent polling updates, so
  // tapping an Other/free-text field can still summon it), close completion
  // surfaces, and stop dictation from writing into a now-hidden draft.
  const lastPromptIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!prompt || prompt.id === lastPromptIdRef.current) return;
    lastPromptIdRef.current = prompt.id;
    inputRef.current?.blur();
    Keyboard.dismiss();
    setHistoryOpen(false);
    setFiles([]);
    if (dictation?.active) dictation.onStop();
  }, [prompt?.id]);

  useEffect(() => {
    if (!prompt) lastPromptIdRef.current = undefined;
  }, [prompt]);

  // Restore the unsent draft for this session. Guarded so a slow read cannot
  // clobber something typed in the meantime.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    let alive = true;
    loadDraft(endpoint.id, sessionId).then((draft) => {
      if (alive && draft && !textRef.current) {
        applyEdit(draft, draft.length);
      }
    });
    return () => {
      alive = false;
    };
  }, [applyEdit, endpoint.id, sessionId]);

  // Persist the draft as it changes so switching sessions never loses it.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const timer = setTimeout(() => void saveDraft(endpoint.id, sessionId, text), DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [endpoint.id, sessionId, text]);

  // Swap the composed text when the session changes: each session keeps its own
  // draft, and the previous one has already been persisted.
  const lastSessionRef = useRef(sessionId);
  useEffect(() => {
    if (lastSessionRef.current === sessionId) {
      return;
    }
    lastSessionRef.current = sessionId;
    applyEdit("", 0);
    setHistoryOpen(false);
    setFiles([]);
  }, [applyEdit, sessionId]);

  useEffect(() => {
    loadPromptHistory(endpoint.id).then(setHistory);
  }, [endpoint.id]);

  // The command catalog depends on which agent is running and where, so it is
  // refetched when either changes.
  useEffect(() => {
    if (!sessionId) {
      setCommands([]);
      return;
    }
    const controller = new AbortController();
    fetchSlashCommands(endpoint, sessionId, controller.signal)
      .then((result) => setCommands(result.commands))
      .catch(() => undefined);
    return () => controller.abort();
  }, [endpoint, sessionId, agent, context?.cwd]);

  // `@` lookups run on the host (it has the filesystem); debounced so a fast
  // typist issues one query, not one per letter.
  useEffect(() => {
    if (panelMode !== "file" || !sessionId) {
      setFilesLoading(false);
      return;
    }

    const controller = new AbortController();
    setFilesLoading(true);
    const timer = setTimeout(() => {
      searchSessionFiles(endpoint, sessionId, token.value.slice(1), controller.signal)
        .then(setFiles)
        .catch(() => undefined)
        .finally(() => setFilesLoading(false));
    }, FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, panelMode, sessionId, token.value]);

  const slashMatches = useMemo(
    () => (panelMode === "slash" ? rankCommands(commands, token.value.slice(1).toLowerCase()) : []),
    [commands, panelMode, token.value]
  );

  const onSelectionChange = useCallback((event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    setSelection(event.nativeEvent.selection);
  }, []);

  // Last resort when the REST call fails (host restarting, flaky wifi): push
  // the same bytes down the terminal socket so the message is not lost.
  const sendOverSocket = useCallback(
    (body: string) => {
      const payload = context?.pasteSafe ? `\x1b[200~${body}\x1b[201~` : body.replace(/\n/g, "\r");
      onSendKeys(payload);
      setTimeout(() => onSendKeys("\r"), 80);
    },
    [context?.pasteSafe, onSendKeys]
  );

  const submit = useCallback(
    async (options: { submit: boolean; overrideText?: string }) => {
      const body = options.overrideText ?? textRef.current;
      if (!sessionId || disabled || sending) {
        return;
      }
      if (!body.trim() && !options.submit) {
        return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      setSending(true);
      try {
        await composeInput(endpoint, sessionId, { text: body, submit: options.submit });
        if (body.trim()) {
          rememberPrompt(endpoint.id, body, context?.cwd).then(setHistory);
        }
        applyEdit("", 0);
        setHistoryOpen(false);
        void saveDraft(endpoint.id, sessionId, "");
        onRefreshContext();
      } catch (error) {
        sendOverSocket(body);
        applyEdit("", 0);
        void saveDraft(endpoint.id, sessionId, "");
        onNotice("Sent over the terminal socket", error instanceof Error ? error.message : undefined);
      } finally {
        setSending(false);
      }
    },
    [applyEdit, context?.cwd, disabled, endpoint, onNotice, onRefreshContext, sendOverSocket, sending, sessionId]
  );

  const chooseCommand = useCallback(
    (command: SlashCommand, run: boolean) => {
      Haptics.selectionAsync().catch(() => undefined);
      const insert = `/${command.name}`;
      const takesArguments = Boolean(command.argumentHint);
      const next = `${text.slice(0, token.start)}${insert}${takesArguments ? " " : ""}${text.slice(token.end)}`;
      const caret = token.start + insert.length + (takesArguments ? 1 : 0);
      applyEdit(next, caret);

      // A command that takes no arguments is already the whole message, so a
      // tap runs it; one that does keeps the keyboard for its argument.
      if (run && !takesArguments && next.trim() === insert) {
        void submit({ submit: true, overrideText: next });
      } else {
        inputRef.current?.focus();
      }
    },
    [applyEdit, submit, text, token.end, token.start]
  );

  const chooseFile = useCallback(
    (hit: FileHit) => {
      Haptics.selectionAsync().catch(() => undefined);
      // Directories keep their trailing slash so the next query drills in.
      const insert = `@${hit.path}${hit.kind === "dir" ? "/" : " "}`;
      const next = `${text.slice(0, token.start)}${insert}${text.slice(token.end)}`;
      applyEdit(next, token.start + insert.length);
      inputRef.current?.focus();
    },
    [applyEdit, text, token.end, token.start]
  );

  const chooseHistory = useCallback(
    (entry: PromptHistoryEntry) => {
      Haptics.selectionAsync().catch(() => undefined);
      applyEdit(entry.text, entry.text.length);
      setHistoryOpen(false);
      inputRef.current?.focus();
    },
    [applyEdit]
  );

  const answerPrompt = useCallback(
    async (response: SessionPromptResponse) => {
      if (!sessionId || !prompt || disabled) throw new Error("This terminal question is no longer available.");
      await respondToPrompt(endpoint, sessionId, prompt.id, response);
      onRefreshContext();
    },
    [disabled, endpoint, onRefreshContext, prompt, sessionId]
  );

  const reportPromptError = useCallback(
    (error: unknown) => {
      onRefreshContext();
      if (error instanceof PromptResponseError && error.stale) {
        onNotice("Question changed", "The agent moved on before that answer arrived. The current question is being refreshed.");
        return;
      }
      if (error instanceof PromptResponseError && error.status === 409) {
        onNotice("Answer already sent", "The agent is handling that response now.");
        return;
      }
      onNotice("Couldn’t answer the question", error instanceof Error ? error.message : "Try again from the terminal.");
    },
    [onNotice, onRefreshContext]
  );

  const canSend = !disabled && !sending;
  const hasText = text.trim().length > 0;

  function renderPanel() {
    if (panelMode === "none") {
      return null;
    }

    const title =
      panelMode === "slash"
        ? `${context?.agentLabel ?? "Terminal"} commands`
        : panelMode === "file"
          ? `Files in ${leafName(context?.cwd) || "session"}`
          : "Recent prompts";

    return (
      <Animated.View
        style={[
          styles.panel,
          {
            opacity: panelAnim,
            transform: [{ translateY: panelAnim.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
          },
        ]}
      >
        <View style={styles.panelHeader}>
          <Text style={styles.panelTitle} numberOfLines={1}>
            {title}
          </Text>
          {panelMode === "file" && filesLoading ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
          {panelMode === "history" ? (
            <Pressable onPress={() => setHistoryOpen(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close recent prompts">
              <Text style={styles.panelAction}>Close</Text>
            </Pressable>
          ) : null}
        </View>
        <ScrollView
          style={styles.panelScroll}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          {panelMode === "slash" ? renderCommandRows() : null}
          {panelMode === "file" ? renderFileRows() : null}
          {panelMode === "history" ? renderHistoryRows() : null}
        </ScrollView>
      </Animated.View>
    );
  }

  function renderCommandRows() {
    if (slashMatches.length === 0) {
      return (
        <Text style={styles.panelEmpty}>
          {commands.length === 0 ? "No slash commands for this session." : "No command matches."}
        </Text>
      );
    }

    return slashMatches.map((command) => (
      <Pressable
        key={`${command.source}:${command.name}`}
        onPress={() => chooseCommand(command, true)}
        onLongPress={() => chooseCommand(command, false)}
        accessibilityRole="button"
        accessibilityLabel={`Slash command ${command.name}${command.description ? `. ${command.description}` : ""}`}
        accessibilityHint={command.argumentHint ? "Inserts the command so you can add its argument" : "Runs the command. Long-press to insert without running"}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        {({ pressed }) => (
          <>
            {pressed ? <View style={styles.rowIndicator} /> : null}
            <View style={styles.rowMain}>
              <Text style={[styles.rowTitle, styles.rowCommand]} numberOfLines={1}>
                /{command.name}
                {command.argumentHint ? <Text style={styles.rowHint}> {command.argumentHint}</Text> : null}
              </Text>
              {command.description ? (
                <Text style={styles.rowSubtitle} numberOfLines={1}>
                  {command.description}
                </Text>
              ) : null}
            </View>
            {command.source !== "builtin" ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{command.source}</Text>
              </View>
            ) : null}
          </>
        )}
      </Pressable>
    ));
  }

  function renderFileRows() {
    if (files.length === 0) {
      return <Text style={styles.panelEmpty}>{filesLoading ? "Searching…" : "No file matches."}</Text>;
    }

    return files.map((hit) => (
      <Pressable
        key={`${hit.kind}:${hit.path}`}
        onPress={() => chooseFile(hit)}
        accessibilityRole="button"
        accessibilityLabel={`${hit.kind === "dir" ? "Folder" : "File"} ${hit.path}`}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        {({ pressed }) => (
          <>
            {pressed ? <View style={styles.rowIndicator} /> : null}
            <View style={styles.rowIcon}>{hit.kind === "dir" ? <FolderIcon /> : <FileIcon />}</View>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {hit.name}
              </Text>
              {hit.dir ? (
                <Text style={styles.rowSubtitle} numberOfLines={1} ellipsizeMode="head">
                  {hit.dir}
                </Text>
              ) : null}
            </View>
          </>
        )}
      </Pressable>
    ));
  }

  function renderHistoryRows() {
    if (history.length === 0) {
      return <Text style={styles.panelEmpty}>Prompts you send are kept here.</Text>;
    }

    return history.map((entry) => (
      <Pressable
        key={`${entry.at}:${entry.text.slice(0, 24)}`}
        onPress={() => chooseHistory(entry)}
        onLongPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
          forgetPrompt(endpoint.id, entry.text).then(setHistory);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Reuse prompt: ${entry.text.slice(0, 80)}`}
        accessibilityHint="Long-press to remove from history"
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        {({ pressed }) => (
          <>
            {pressed ? <View style={styles.rowIndicator} /> : null}
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {entry.text}
              </Text>
            </View>
            <Text style={styles.rowMeta}>{relativeTime(entry.at)}</Text>
          </>
        )}
      </Pressable>
    ));
  }

  function renderStatus() {
    if (prompt) {
      return null;
    }

    const dictating = dictation?.active || dictation?.status === "downloading" || dictation?.status === "loading";
    if (dictating) {
      return (
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: colors.accentMint }]} />
          <Text style={styles.statusText} numberOfLines={1}>
            {dictation?.status === "downloading"
              ? `Downloading ${dictation.modelLabel} · ${dictation.downloadPercent ?? 0}%`
              : dictation?.status === "loading"
                ? "Loading speech model…"
                : dictation?.lastText
                  ? `“${dictation.lastText}”`
                  : "Listening — release to add"}
          </Text>
        </View>
      );
    }

    if (dictation?.status === "error") {
      return (
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: colors.accentCoral }]} />
          <Text style={[styles.statusText, styles.statusTextError]} numberOfLines={1}>
            {dictation.error ?? "Dictation unavailable"}
          </Text>
        </View>
      );
    }

    return null;
  }

  function renderMic() {
    if (!dictation || dictation.status === "unsupported") {
      return null;
    }

    const danger = dictation.status === "error";
    const glow = dictation.active && (dictation.status === "listening" || dictation.status === "recognizing");
    return (
      <Pressable
        onPressIn={() => {
          if (disabled) {
            return;
          }
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
          dictation.onStart();
        }}
        onPressOut={() => dictation.onStop()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Hold to dictate into the message"
        accessibilityState={{ disabled, selected: dictation.active }}
        style={({ pressed }) => [
          styles.iconButton,
          dictation.active && styles.micActive,
          glow && { backgroundColor: withAlpha(colors.accentMint, 0.16 + Math.min(0.5, dictation.level * 0.6)) },
          danger && styles.micError,
          disabled && !dictation.active && styles.faded,
          pressed && styles.pressed,
        ]}
      >
        <MicIcon
          size={18}
          color={danger ? colors.accentCoral : dictation.active ? colors.accentMint : colors.secondaryForeground}
        />
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      <BlurView
        intensity={Platform.OS === "ios" ? 74 : 40}
        tint="systemChromeMaterialDark"
        blurMethod="dimezisBlurView"
        blurTarget={blurTarget}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, styles.tint]} pointerEvents="none" />

      {prompt ? (
        <AgentPromptCard
          agent={agent}
          agentLabel={context?.agentLabel ?? "Terminal"}
          prompt={prompt}
          disabled={disabled}
          onRespond={answerPrompt}
          onError={reportPromptError}
        />
      ) : (
        <>
          {renderPanel()}
          {renderStatus()}
          <View style={styles.inputRow}>
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            setHistoryOpen((open) => !open);
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Sending to ${context?.agentLabel ?? "terminal"}. Tap for recent prompts`}
          style={({ pressed }) => [styles.agentButton, historyOpen && styles.agentButtonActive, pressed && styles.pressed]}
        >
          {agentBadge(agent, 17)}
        </Pressable>

        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          selection={forcedSelection}
          onSelectionChange={onSelectionChange}
          placeholder={placeholderFor(context)}
          placeholderTextColor={colors.faint}
          multiline
          // Enter sends. `submitBehavior="submit"` fires onSubmitEditing without
          // blurring, so the keyboard stays up for the next message; the ⏎ key in
          // the row below is how a deliberate line break gets in.
          submitBehavior="submit"
          returnKeyType="send"
          onSubmitEditing={() => void submit({ submit: true })}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="none"
          autoCorrect
          editable={!disabled}
          scrollEnabled
          style={[styles.input, text.length === 0 && styles.inputEmpty, focused && styles.inputFocused]}
          accessibilityLabel="Message to send to the terminal session"
        />

        {renderMic()}

        <Pressable
          onPress={() => void submit({ submit: true })}
          onLongPress={() => {
            if (hasText) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
              void submit({ submit: false });
            }
          }}
          disabled={!canSend}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            hasText ? "Send message and press Enter. Long-press to insert without Enter" : "Press Enter in the session"
          }
          accessibilityState={{ disabled: !canSend }}
          style={({ pressed }) => [
            styles.send,
            hasText ? styles.sendReady : styles.sendBare,
            !canSend && styles.faded,
            pressed && styles.sendPressed,
          ]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : hasText ? (
            <SendIcon size={18} color={colors.primaryForeground} />
          ) : (
            <Text style={styles.sendEnter}>⏎</Text>
          )}
        </Pressable>
          </View>
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: "relative",
    backgroundColor: "transparent",
    borderTopWidth: 1,
    borderColor: glass.border,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  tint: {
    backgroundColor: glass.tint,
  },
  // Completions float above the bar instead of growing it, so opening the
  // picker never reflows the terminal underneath.
  panel: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: "100%",
    marginBottom: 8,
    maxHeight: 262,
    zIndex: 24,
    elevation: 24,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  panelTitle: {
    flex: 1,
    color: colors.mutedForeground,
    fontFamily: font.semibold,
    fontSize: 12,
  },
  panelAction: {
    color: colors.accentCyan,
    fontFamily: font.semibold,
    fontSize: 12,
  },
  panelScroll: {
    maxHeight: 218,
  },
  panelEmpty: {
    color: colors.faint,
    fontFamily: font.medium,
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(colors.border, 0.5),
  },
  rowPressed: {
    backgroundColor: colors.selection,
  },
  // The WinUI selection indicator: a short rounded accent pill hugging the
  // left edge of the highlighted row.
  rowIndicator: {
    position: "absolute",
    left: 2,
    top: "25%",
    bottom: "25%",
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  rowIcon: {
    width: 18,
    alignItems: "center",
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: colors.foreground,
    fontFamily: font.mono,
    fontSize: 13,
  },
  // Command names carry the scan weight; the hint and description stay quiet.
  rowCommand: {
    fontFamily: font.monoSemibold,
  },
  rowHint: {
    color: colors.faint,
    fontFamily: font.mono,
    fontSize: 12,
  },
  rowSubtitle: {
    color: colors.mutedForeground,
    fontFamily: font.regular,
    fontSize: 12,
  },
  rowMeta: {
    color: colors.faint,
    fontFamily: font.medium,
    fontSize: 11,
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: withAlpha(colors.primary, 0.12),
    borderWidth: 1,
    borderColor: withAlpha(colors.primary, 0.4),
  },
  badgeText: {
    color: colors.primary,
    fontFamily: font.semibold,
    fontSize: 10,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 2,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusText: {
    flex: 1,
    color: colors.mutedForeground,
    fontFamily: font.medium,
    fontSize: 12,
  },
  statusTextError: {
    color: colors.accentCoral,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  agentButton: {
    width: 38,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  agentButtonActive: {
    backgroundColor: withAlpha(colors.primary, 0.18),
  },
  // WinUI TextBox: quiet fill, 4px corners, and the signature 2px bottom
  // underline that lights up accent on focus. The underline is 2px in both
  // states so focusing never shifts layout. Text is Cascadia Mono — this
  // field composes terminal input.
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: MAX_INPUT_HEIGHT,
    paddingHorizontal: 12,
    // Android centres single-line text oddly without symmetric padding here.
    paddingTop: Platform.OS === "ios" ? 12 : 11,
    paddingBottom: Platform.OS === "ios" ? 12 : 11,
    borderRadius: radius.sm,
    backgroundColor: colors.input,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 2,
    borderBottomColor: colors.borderStrong,
    color: colors.foreground,
    fontFamily: font.mono,
    fontSize: 13.5,
    lineHeight: 19,
    textAlignVertical: "top",
  },
  // A multiline TextInput otherwise measures its placeholder as content and
  // can grow to two rows before anything has been typed.
  inputEmpty: {
    height: 44,
  },
  inputFocused: {
    borderBottomColor: colors.primary,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: glass.raised,
    borderColor: glass.raisedBorder,
    borderWidth: 1,
  },
  micActive: {
    backgroundColor: withAlpha(colors.accentMint, 0.18),
    borderColor: withAlpha(colors.accentMint, 0.5),
  },
  micError: {
    backgroundColor: withAlpha(colors.accentCoral, 0.14),
    borderColor: withAlpha(colors.accentCoral, 0.4),
  },
  send: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
  },
  sendReady: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  // With nothing typed the button still does something useful — press Enter in
  // the session — so it stays available, just quiet.
  sendBare: {
    backgroundColor: glass.raised,
    borderColor: glass.raisedBorder,
  },
  sendPressed: {
    backgroundColor: colors.primaryDim,
    borderColor: colors.primaryDim,
  },
  sendEnter: {
    color: colors.secondaryForeground,
    fontFamily: font.mono,
    fontSize: 16,
  },
  pressed: {
    backgroundColor: glass.pressed,
  },
  faded: {
    opacity: 0.45,
  },
});

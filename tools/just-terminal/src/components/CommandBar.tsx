import { useEffect, useRef, useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { terminalSocket, type SocketStatus } from "../lib/socket";
import { loadKeysExpanded, saveKeysExpanded } from "../lib/storage";
import type { SessionStatus } from "../types";
import { colors, font, radius } from "../theme";

type ComposerMode = "line" | "paste";

interface CommandBarProps {
  targetId?: string;
  sessionStatus?: SessionStatus;
  socketStatus: SocketStatus;
}

const HISTORY_LIMIT = 60;

const controlKeys: Array<{ label: string; value: string; accent?: boolean }> = [
  { label: "Esc", value: "\x1b" },
  { label: "Tab", value: "\t" },
  { label: "←", value: "\x1b[D" },
  { label: "↑", value: "\x1b[A" },
  { label: "↓", value: "\x1b[B" },
  { label: "→", value: "\x1b[C" },
  { label: "^C", value: "\x03", accent: true },
  { label: "^D", value: "\x04" },
  { label: "^L", value: "\x0c" },
  { label: "^Z", value: "\x1a" },
];

function normalizeLineInput(value: string): string {
  return `${value.replace(/\r?\n/g, "\r")}\r`;
}

function bracketedPaste(value: string): string {
  return `\x1b[200~${value.replace(/\r\n/g, "\n")}\x1b[201~`;
}

export function CommandBar({ targetId, sessionStatus, socketStatus }: CommandBarProps) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<ComposerMode>("line");
  const [expanded, setExpanded] = useState(true);
  const inputRef = useRef<TextInput | null>(null);
  const draftsRef = useRef<Record<string, string>>({});
  const [historyByTarget, setHistoryByTarget] = useState<Record<string, string[]>>({});
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();

  const disabled = !targetId || sessionStatus !== "running" || socketStatus !== "open";
  const history = targetId ? historyByTarget[targetId] ?? [] : [];

  useEffect(() => {
    loadKeysExpanded().then(setExpanded);
  }, []);

  function toggleExpanded() {
    LayoutAnimation.configureNext(LayoutAnimation.create(160, "easeInEaseOut", "opacity"));
    setExpanded((current) => {
      const next = !current;
      saveKeysExpanded(next);
      return next;
    });
  }

  function send(data: string) {
    if (disabled || !targetId) {
      return;
    }
    terminalSocket.send({ type: "input", sessionId: targetId, data });
  }

  function updateValue(next: string) {
    setValue(next);
    if (targetId) {
      draftsRef.current[targetId] = next;
    }
  }

  function rememberHistory(entry: string) {
    if (!targetId || mode !== "line" || !entry.trim()) {
      return;
    }
    setHistoryByTarget((current) => {
      const existing = current[targetId] ?? [];
      const next = [...existing.filter((item) => item !== entry), entry].slice(-HISTORY_LIMIT);
      return { ...current, [targetId]: next };
    });
  }

  function submit() {
    if (!value || disabled) {
      return;
    }
    const sent = value;
    send(mode === "line" ? normalizeLineInput(value) : bracketedPaste(value));
    rememberHistory(sent);
    updateValue("");
    setHistoryIndex(undefined);
  }

  function recall(direction: -1 | 1) {
    if (history.length === 0) {
      return;
    }
    if (historyIndex === undefined) {
      if (direction > 0) {
        return;
      }
      const index = history.length - 1;
      setHistoryIndex(index);
      updateValue(history[index]);
      return;
    }
    const next = historyIndex + direction;
    if (next < 0) {
      setHistoryIndex(0);
      updateValue(history[0]);
    } else if (next >= history.length) {
      setHistoryIndex(undefined);
      updateValue("");
    } else {
      setHistoryIndex(next);
      updateValue(history[next]);
    }
  }

  const canPrev = !disabled && history.length > 0;
  const canNext = !disabled && historyIndex !== undefined;

  return (
    <View style={styles.container}>
      <View style={styles.handleRow}>
        <Pressable onPress={toggleExpanded} hitSlop={6} style={({ pressed }) => [styles.handle, pressed && styles.pressed]}>
          <Text style={styles.handleGlyph}>{expanded ? "⌄" : "⌃"}</Text>
          <Text style={styles.handleText}>Keys</Text>
        </Pressable>

        <View style={styles.handleSpacer} />

        <View style={styles.modeToggle}>
          {(["line", "paste"] as ComposerMode[]).map((item) => (
            <Pressable key={item} onPress={() => setMode(item)} style={[styles.modeItem, mode === item && styles.modeItemActive]}>
              <Text style={[styles.modeText, mode === item && styles.modeTextActive]}>{item === "line" ? "Line" : "Paste"}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.histGroup}>
          <Pressable disabled={!canPrev} onPress={() => recall(-1)} style={({ pressed }) => [styles.histBtn, pressed && styles.pressed, !canPrev && styles.faded]}>
            <Text style={styles.histText}>⌃↑</Text>
          </Pressable>
          <Pressable disabled={!canNext} onPress={() => recall(1)} style={({ pressed }) => [styles.histBtn, pressed && styles.pressed, !canNext && styles.faded]}>
            <Text style={styles.histText}>⌃↓</Text>
          </Pressable>
        </View>
      </View>

      {expanded ? (
        <View style={styles.keyRow}>
          {controlKeys.map((key) => (
            <Pressable
              key={key.label}
              disabled={disabled}
              onPress={() => send(key.value)}
              style={({ pressed }) => [
                styles.key,
                key.accent && styles.keyAccent,
                disabled && styles.faded,
                pressed && styles.keyPressed,
              ]}
            >
              <Text style={[styles.keyText, key.accent && styles.keyTextAccent, disabled && styles.keyTextDisabled]}>{key.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={(text) => {
            updateValue(text);
            setHistoryIndex(undefined);
          }}
          editable={!disabled}
          placeholder={
            !targetId
              ? "No terminal selected"
              : socketStatus !== "open"
                ? "Reconnecting…"
                : mode === "line"
                  ? "Send to terminal"
                  : "Paste to terminal"
          }
          placeholderTextColor={colors.faint}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          blurOnSubmit={mode === "line"}
          returnKeyType="send"
          onSubmitEditing={() => {
            if (mode === "line") {
              submit();
            }
          }}
          style={styles.input}
        />
        <Pressable
          disabled={disabled || !value}
          onPress={submit}
          style={({ pressed }) => [styles.send, (disabled || !value) && styles.sendDisabled, pressed && styles.sendPressed]}
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 8,
    gap: 8,
  },
  handleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  handle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
  },
  handleGlyph: {
    color: colors.primary,
    fontSize: 12,
    fontFamily: font.bold,
  },
  handleText: {
    color: colors.secondaryForeground,
    fontSize: 11.5,
    fontFamily: font.semibold,
  },
  handleSpacer: {
    flex: 1,
  },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    borderColor: colors.border,
    borderWidth: 1,
    padding: 2,
  },
  modeItem: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  modeItemActive: {
    backgroundColor: colors.primary,
  },
  modeText: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.bold,
  },
  modeTextActive: {
    color: colors.primaryForeground,
  },
  histGroup: {
    flexDirection: "row",
    gap: 4,
  },
  histBtn: {
    minWidth: 38,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
  },
  histText: {
    color: colors.secondaryForeground,
    fontFamily: font.mono,
    fontSize: 12,
  },
  keyRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  key: {
    minWidth: 42,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  keyAccent: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderStrong,
  },
  keyPressed: {
    backgroundColor: colors.surfaceHi,
  },
  keyText: {
    color: colors.secondaryForeground,
    fontFamily: font.mono,
    fontSize: 13,
  },
  keyTextAccent: {
    color: colors.destructive,
  },
  keyTextDisabled: {
    color: colors.faint,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 124,
    backgroundColor: colors.input,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.foreground,
    fontFamily: font.mono,
    fontSize: 14,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  send: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: 18,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendPressed: {
    backgroundColor: colors.primaryDim,
  },
  sendText: {
    color: colors.primaryForeground,
    fontFamily: font.extrabold,
    fontSize: 14,
  },
  pressed: {
    backgroundColor: colors.surfaceHi,
  },
  faded: {
    opacity: 0.4,
  },
});

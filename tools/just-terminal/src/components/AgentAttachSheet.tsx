import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, font, radius, withAlpha } from "../theme";
import { BottomSheet } from "./BottomSheet";
import { ClaudeIcon, CodexIcon } from "./icons";
import type { AgentLinkCandidate, SessionAgentState } from "../lib/agentApi";

export interface AgentAttachSheetProps {
  visible: boolean;
  state?: SessionAgentState;
  loading: boolean;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onPick: (candidate?: AgentLinkCandidate) => void;
}

function relativeTime(value?: string): string {
  if (!value) return "";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || value;
}

/**
 * The one tap between "Claude is running in this terminal" and a full agent
 * view of the work.
 *
 * The terminal's harness owns its own conversation and cannot hand it over, so
 * this is explicit about what each choice does: continue the transcript of a
 * past conversation in this directory, or start a fresh one. Nothing is
 * attached until the person picks.
 */
export function AgentAttachSheet({ visible, state, loading, busy, error, onClose, onPick }: AgentAttachSheetProps) {
  const agent = state?.agent;
  const candidates = state?.attach.candidates ?? [];
  const blocked = state ? !state.attach.supported : false;

  return (
    <BottomSheet visible={visible} title="Agent view" onClose={onClose}>
      <View style={styles.head}>
        <View style={styles.headIcon}>{agent === "codex" ? <CodexIcon size={18} /> : <ClaudeIcon size={18} />}</View>
        <Text style={styles.headText}>
          {agent === "codex" ? "Codex" : "Claude"} is running in this terminal. Open a rich view of the conversation —
          messages, tool calls, diffs and permission prompts — while the terminal keeps running.
        </Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {blocked ? <Text style={styles.error}>{state?.attach.reason}</Text> : null}

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Looking for this terminal's conversation…</Text>
        </View>
      ) : null}

      {!loading && !blocked ? (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          {candidates.length ? <Text style={styles.section}>Continue where you left off</Text> : null}
          {candidates.map((candidate) => (
            <Pressable
              key={candidate.sessionId}
              disabled={busy}
              onPress={() => onPick(candidate)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {candidate.title?.trim() || "Untitled conversation"}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {[relativeTime(candidate.updatedAt), candidate.exact ? undefined : shortPath(candidate.cwd)]
                    .filter(Boolean)
                    .join("  ·  ")}
                </Text>
              </View>
              {candidate.exact ? <View style={styles.exactDot} /> : null}
            </Pressable>
          ))}

          <Text style={styles.section}>{candidates.length ? "Or" : "Start here"}</Text>
          <Pressable
            disabled={busy}
            onPress={() => onPick(undefined)}
            style={({ pressed }) => [styles.row, styles.freshRow, pressed && styles.rowPressed]}
          >
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>Start a new conversation</Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                In {state ? shortPath(state.acpSession?.cwd ?? "") || "this directory" : "this directory"}
              </Text>
            </View>
          </Pressable>

          {candidates.length === 0 ? (
            <Text style={styles.note}>
              No earlier conversation was found for this directory. A new one starts fresh — the terminal's own history
              stays in the terminal.
            </Text>
          ) : null}
        </ScrollView>
      ) : null}

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator color={colors.primary} size="small" />
          <Text style={styles.loadingText}>Opening agent view…</Text>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    gap: 10,
    paddingBottom: 14,
  },
  headIcon: {
    marginTop: 1,
  },
  headText: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.secondaryForeground,
  },
  error: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.destructive,
    paddingBottom: 12,
  },
  loading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 18,
  },
  loadingText: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.mutedForeground,
  },
  list: {
    maxHeight: 340,
  },
  listContent: {
    paddingBottom: 8,
    gap: 6,
  },
  section: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: colors.faint,
    paddingTop: 8,
    paddingBottom: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  freshRow: {
    borderColor: withAlpha(colors.primary, 0.3),
    backgroundColor: withAlpha(colors.primary, 0.08),
  },
  rowPressed: {
    backgroundColor: colors.surfaceHi,
  },
  rowCopy: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    fontFamily: font.medium,
    fontSize: 14,
    color: colors.foreground,
  },
  rowMeta: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.mutedForeground,
  },
  exactDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  note: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.faint,
    paddingTop: 10,
  },
  busy: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 12,
  },
});

import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CreateSpec } from "./SessionsScreen";
import { resolveQuickLaunches } from "../lib/launchers";
import type { TerminalProfile } from "../types";
import { colors, font, radius } from "../theme";
import { JustGainsMark, agentGlyph } from "./icons";

interface TerminalEmptyStateProps {
  profiles: TerminalProfile[];
  onCreate: (spec?: CreateSpec) => void;
  onOpenMenu: () => void;
}

// Shown over the terminal surface when the host is connected but has no
// sessions yet. Turns a blank black screen into a clear first action: spin up a
// shell, or jump straight into an agent.
export function TerminalEmptyState({ profiles, onCreate, onOpenMenu }: TerminalEmptyStateProps) {
  const quickLaunches = resolveQuickLaunches(profiles);

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <View style={styles.mark}>
          <JustGainsMark size={52} color={colors.primary} />
        </View>
        <Text style={styles.title}>No sessions yet</Text>
        <Text style={styles.subtitle}>Start a shell, or launch an agent to get going.</Text>

        <Pressable
          onPress={() => onCreate()}
          accessibilityRole="button"
          accessibilityLabel="New session"
          style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
        >
          <Text style={styles.primaryText}>New session</Text>
        </Pressable>

        {quickLaunches.length > 0 ? (
          <View style={styles.quickRow}>
            {quickLaunches.map((entry) => (
              <Pressable
                key={entry.profileId}
                onPress={() => onCreate({ shell: entry.shell, args: entry.args, title: entry.label })}
                accessibilityRole="button"
                accessibilityLabel={`Launch ${entry.label}`}
                style={({ pressed }) => [styles.quickChip, pressed && styles.quickChipPressed]}
              >
                <View style={styles.quickIcon}>{agentGlyph(entry.profileId, 20)}</View>
                <Text style={styles.quickLabel}>{entry.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Pressable onPress={onOpenMenu} hitSlop={8} style={styles.menuLink} accessibilityRole="button">
          <Text style={styles.menuLinkText}>More options</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    backgroundColor: colors.terminal,
  },
  card: {
    width: "100%",
    maxWidth: 320,
    alignItems: "center",
  },
  mark: {
    width: 92,
    height: 92,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    marginBottom: 22,
  },
  title: {
    color: colors.foreground,
    fontSize: 19,
    fontFamily: font.extrabold,
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 13.5,
    fontFamily: font.medium,
    textAlign: "center",
    lineHeight: 19,
    marginTop: 7,
    marginBottom: 24,
  },
  primary: {
    alignSelf: "stretch",
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
  },
  primaryPressed: {
    backgroundColor: colors.primaryDim,
  },
  primaryText: {
    color: colors.primaryForeground,
    fontSize: 15,
    fontFamily: font.extrabold,
  },
  quickRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 14,
  },
  quickChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingLeft: 11,
    paddingRight: 14,
    paddingVertical: 8,
  },
  quickChipPressed: {
    backgroundColor: colors.surfaceHi,
  },
  quickIcon: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  quickLabel: {
    color: colors.sidebarForeground,
    fontSize: 13,
    fontFamily: font.semibold,
  },
  menuLink: {
    marginTop: 22,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  menuLinkText: {
    color: colors.mutedForeground,
    fontSize: 13,
    fontFamily: font.semibold,
  },
});

import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import type { CreateSpec } from "./SessionsScreen";
import { resolveQuickLaunches } from "../lib/launchers";
import type { TerminalProfile } from "../types";
import { colors, font, glass, radius } from "../theme";
import { TerminalCompanionMark, launchGlyph } from "./icons";

interface TerminalEmptyStateProps {
  profiles: TerminalProfile[];
  onCreate: (spec?: CreateSpec) => void;
  onOpenMenu: () => void;
}

// Shown over the terminal surface when the host is connected but has no
// sessions yet. The launch chips mirror the desktop Terminal's live, visible
// profile list; they are not a separate mobile configuration.
export function TerminalEmptyState({ profiles, onCreate, onOpenMenu }: TerminalEmptyStateProps) {
  const quickLaunches = resolveQuickLaunches(profiles);

  // Fluent entrance: the card fades in with a small rise instead of hard-cutting
  // over the terminal surface.
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  return (
    <View style={styles.overlay}>
      <Animated.View
        style={[
          styles.card,
          {
            opacity: entrance,
            transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
          },
        ]}
      >
        <View style={styles.mark}>
          <TerminalCompanionMark size={40} color={colors.primary} />
        </View>
        <Text style={styles.title}>No sessions yet</Text>
        <Text style={styles.subtitle}>Launch one of your configured Terminal profiles.</Text>

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
                onPress={() => onCreate({ profileId: entry.profileId })}
                accessibilityRole="button"
                accessibilityLabel={`Launch ${entry.label}`}
                style={({ pressed }) => [styles.quickChip, pressed && styles.quickChipPressed]}
              >
                <View style={styles.quickIcon}>{launchGlyph(entry.agent ?? entry.profileId, 20)}</View>
                <Text style={styles.quickLabel}>{entry.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Pressable
          onPress={onOpenMenu}
          hitSlop={8}
          style={styles.menuLink}
          accessibilityRole="button"
          accessibilityLabel="More options"
        >
          <Text style={styles.menuLinkText}>More options</Text>
        </Pressable>
      </Animated.View>
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
    width: 72,
    height: 72,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    marginBottom: 24,
  },
  title: {
    color: colors.foreground,
    fontSize: 20,
    fontFamily: font.semibold,
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 14,
    fontFamily: font.regular,
    textAlign: "center",
    lineHeight: 19,
    marginTop: 8,
    marginBottom: 24,
  },
  primary: {
    alignSelf: "stretch",
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    minHeight: 44,
  },
  primaryPressed: {
    backgroundColor: colors.primaryDim,
  },
  primaryText: {
    color: colors.primaryForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  quickRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
  },
  quickChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: glass.raised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingLeft: 12,
    paddingRight: 14,
    paddingVertical: 10,
    minHeight: 44,
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
    color: colors.secondaryForeground,
    fontSize: 13,
    fontFamily: font.semibold,
  },
  menuLink: {
    marginTop: 24,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  menuLinkText: {
    color: colors.mutedForeground,
    fontSize: 13,
    fontFamily: font.semibold,
  },
});

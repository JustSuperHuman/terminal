import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { TerminalSessionSummary } from "../types";
import { colors, font, radius } from "../theme";
import { launchGlyph, launchLabel } from "./icons";

// Derive a launch key (e.g. "pwsh", "wsl", "claude") from a session's shell path.
function launchKeyFor(session?: TerminalSessionSummary): string {
  if (!session) {
    return "";
  }
  const base = session.shell.split(/[\\/]/).pop() ?? session.shell;
  return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

const BAR_WIDTHS = ["100%", "82%", "60%"] as const;

// Themed placeholder shown over the terminal while a freshly-created session
// connects and prints its first bytes. The glyph/label track the action being
// launched (Claude / Codex / Hermes / PowerShell / WSL …) so the wait reads as
// "starting <thing>" rather than a blank screen.
export function TerminalLoading({ session }: { session?: TerminalSessionSummary }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 720, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 720, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const key = launchKeyFor(session);
  const shimmer = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.85] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

  return (
    <View style={styles.overlay} pointerEvents="none">
      <View style={styles.center}>
        <Animated.View style={[styles.iconWrap, { opacity: glow }]}>
          {launchGlyph(key, 34, colors.primary)}
        </Animated.View>
        <Text style={styles.label}>Starting {launchLabel(key)}…</Text>
        <View style={styles.bars}>
          {BAR_WIDTHS.map((width, index) => (
            <Animated.View key={index} style={[styles.bar, { width, opacity: shimmer }]} />
          ))}
        </View>
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
    backgroundColor: colors.terminal,
    alignItems: "center",
    justifyContent: "center",
  },
  center: {
    width: "100%",
    maxWidth: 260,
    alignItems: "center",
    paddingHorizontal: 24,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    marginBottom: 18,
  },
  label: {
    color: colors.foreground,
    fontSize: 15,
    fontFamily: font.semibold,
    marginBottom: 20,
  },
  bars: {
    width: "100%",
    gap: 10,
  },
  bar: {
    height: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceHi,
  },
});

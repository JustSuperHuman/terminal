import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { TerminalSessionSummary } from "../types";
import { colors, font } from "../theme";
import { launchLabel } from "./icons";

// Derive a launch key (e.g. "pwsh", "wsl", "claude") from a session's shell path.
function launchKeyFor(session?: TerminalSessionSummary): string {
  if (!session) {
    return "";
  }
  const base = session.shell.split(/[\\/]/).pop() ?? session.shell;
  return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

// Themed placeholder shown over the terminal while a freshly-created session
// connects and prints its first bytes: a Cascadia Mono ">_" prompt with a
// blinking cursor on the Campbell background — exactly what Windows Terminal
// looks like the instant before a shell paints. The label tracks the action
// being launched (Claude / Codex / Hermes / PowerShell / WSL …) so the wait
// reads as "starting <thing>" rather than a blank screen.
export function TerminalLoading({ session }: { session?: TerminalSessionSummary }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        // ~600ms per phase matches Windows Terminal's default caret blink rate.
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 600, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const key = launchKeyFor(session);
  // Hard on/off blink (no fade) so the cursor reads as a terminal caret.
  const blink = pulse.interpolate({ inputRange: [0, 0.5, 0.5001, 1], outputRange: [1, 1, 0, 0] });

  return (
    <View style={styles.overlay} pointerEvents="none">
      <View style={styles.center}>
        <View style={styles.prompt}>
          <Text style={styles.promptGlyph}>&gt;</Text>
          <Animated.Text style={[styles.promptGlyph, styles.cursor, { opacity: blink }]}>_</Animated.Text>
        </View>
        <Text style={styles.label}>Starting {launchLabel(key)}…</Text>
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
    alignItems: "center",
    paddingHorizontal: 24,
  },
  prompt: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  promptGlyph: {
    // Campbell's default foreground is what the shell prompt renders in.
    color: colors.secondaryForeground,
    fontSize: 40,
    fontFamily: font.mono,
  },
  cursor: {
    color: colors.primary,
    marginLeft: 2,
  },
  label: {
    color: colors.secondaryForeground,
    fontSize: 13,
    fontFamily: font.regular,
  },
});

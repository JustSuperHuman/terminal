import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, font, glass, radius, withAlpha } from "../theme";
import { ClaudeIcon, CodexIcon } from "./icons";
import type { TerminalAgentActivity, TerminalAgentId } from "../types";

export interface AgentStatusBarProps {
  agent: TerminalAgentId;
  /** Safe-area top inset, so the pill lines up with the menu button. */
  topInset: number;
  activity?: TerminalAgentActivity;
  /** True once this terminal has a rich agent view to return to. */
  attached: boolean;
  /** Set while the attach round-trip is in flight. */
  connecting?: boolean;
  onPress: () => void;
}

function agentLabel(agent: TerminalAgentId): string {
  return agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : "Hermes";
}

function agentIcon(agent: TerminalAgentId, size: number) {
  if (agent === "codex") return <CodexIcon size={size} />;
  return <ClaudeIcon size={size} />;
}

/**
 * What the agent is doing, in the words a person would use. Deliberately three
 * states: anything finer is noise on a phone, and anything coarser stops
 * answering the only question that matters while you are away from the desk.
 */
function describe(activity: TerminalAgentActivity | undefined, attached: boolean): { text: string; tone: string } {
  switch (activity) {
    case "awaiting":
      return { text: "Needs you", tone: colors.accentAmber };
    case "working":
      return { text: "Working", tone: colors.accentMint };
    case "idle":
      return { text: attached ? "Ready" : "Idle", tone: colors.mutedForeground };
    default:
      return { text: "Connecting", tone: colors.mutedForeground };
  }
}

/**
 * The always-on answer to "what is happening right now?".
 *
 * Floats over the terminal rather than sitting in the layout: the terminal's
 * row/column geometry is negotiated with the host, and a bar that changed
 * height on every state flip would reflow the grid under the person's eyes.
 */
export function AgentStatusBar({ agent, topInset, activity, attached, connecting, onPress }: AgentStatusBarProps) {
  const { text, tone } = describe(activity, attached);
  const live = activity === "working" || connecting;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!live) {
      pulse.stopAnimation(() => pulse.setValue(0));
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 620, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 620, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  const dotStyle = {
    backgroundColor: tone,
    opacity: live ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) : 1,
    transform: [{ scale: live ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.15] }) : 1 }],
  };

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${agentLabel(agent)} — ${text}. ${attached ? "Open agent view" : "Open the rich agent view"}`}
      style={({ pressed }) => [styles.bar, pressed && styles.barPressed, { top: topInset + 8, borderColor: withAlpha(tone, 0.28) }]}
      hitSlop={6}
    >
      <View style={styles.icon}>{agentIcon(agent, 15)}</View>
      <Animated.View style={[styles.dot, dotStyle]} />
      <Text style={[styles.state, { color: tone }]} numberOfLines={1}>
        {connecting ? "Opening" : text}
      </Text>
      {attached ? null : <Text style={styles.hint}>·  Agent view</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    right: 12,
    zIndex: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: glass.tint,
  },
  barPressed: {
    backgroundColor: glass.pressed,
  },
  icon: {
    opacity: 0.9,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
  },
  state: {
    fontFamily: font.medium,
    fontSize: 12,
    letterSpacing: 0.1,
  },
  hint: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.mutedForeground,
    marginLeft: -3,
  },
});

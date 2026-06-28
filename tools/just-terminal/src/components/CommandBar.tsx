import { useEffect, useState, type RefObject } from "react";
import { LayoutAnimation, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { terminalSocket, type SocketStatus } from "../lib/socket";
import { loadKeysExpanded, saveKeysExpanded } from "../lib/storage";
import type { SessionStatus } from "../types";
import type { DictationUiStatus } from "../useDictation";
import { MicIcon } from "./icons";
import { colors, font, radius } from "../theme";

// Frosted-glass palette for the tools bar, in the spirit of JustGains-Mobile's
// GlassSurface (BlurView + sheen + translucent raised controls).
const GLASS_TINT = "rgba(10, 12, 16, 0.40)";
const GLASS_RAISED = "rgba(255, 255, 255, 0.055)";
const GLASS_RAISED_BORDER = "rgba(255, 255, 255, 0.09)";
const GLASS_PRESSED = "rgba(255, 255, 255, 0.13)";
const GLASS_BORDER = "rgba(255, 255, 255, 0.10)";
const SHEEN_TOP = "rgba(255, 255, 255, 0.08)";
const SHEEN_MID = "rgba(255, 255, 255, 0.015)";
const SHEEN_BOTTOM = "rgba(255, 255, 255, 0)";
const ACCENT_GLASS = "rgba(245, 45, 45, 0.12)";
const ACCENT_GLASS_BORDER = "rgba(245, 45, 45, 0.34)";
const MIC_ACTIVE_BG = "rgba(255, 191, 0, 0.16)";
const MIC_ACTIVE_BORDER = "rgba(255, 191, 0, 0.40)";
const MIC_ERROR_BG = "rgba(245, 45, 45, 0.14)";
const METER_TRACK = "rgba(255, 255, 255, 0.08)";
const GLASS_RADIUS = 24;

type ControlKey = { label: string; value: string; accent?: boolean; a11y?: string };

// Live voice-dictation state + control, supplied by `useDictation`. Omitted (or
// status "unsupported") hides the mic — e.g. in Expo Go where the native speech
// module isn't linked.
export interface DictationControl {
  status: DictationUiStatus;
  active: boolean;
  level: number;
  speaking: boolean;
  lastText?: string;
  downloadPercent?: number;
  error?: string;
  modelLabel: string;
  onToggle: () => void;
}

interface CommandBarProps {
  targetId?: string;
  sessionStatus?: SessionStatus;
  socketStatus: SocketStatus;
  bottomInset?: number;
  keyboardVisible?: boolean;
  // Ref to the BlurTargetView behind the bar; required for real blur on Android.
  blurTarget?: RefObject<View | null>;
  dictation?: DictationControl;
}

// Typing and pasting now happen directly in the terminal (the soft keyboard
// follows a tap), so this bar is purely a control-key accessory. The arrows the
// user reaches for most — Up/Down for shell history and TUI navigation — live in
// the always-visible row; the rest stay in the collapsible row.
const visibleKeys: ControlKey[] = [
  { label: "Esc", value: "\x1b", a11y: "Escape" },
  { label: "Tab", value: "\t", a11y: "Tab" },
  { label: "↑", value: "\x1b[A", a11y: "Up arrow" },
  { label: "↓", value: "\x1b[B", a11y: "Down arrow" },
  { label: "^C", value: "\x03", accent: true, a11y: "Control C, interrupt" },
];

const expandedKeys: ControlKey[] = [
  { label: "←", value: "\x1b[D", a11y: "Left arrow" },
  { label: "→", value: "\x1b[C", a11y: "Right arrow" },
  { label: "Home", value: "\x1b[H", a11y: "Home" },
  { label: "End", value: "\x1b[F", a11y: "End" },
  { label: "^D", value: "\x04", a11y: "Control D" },
  { label: "^L", value: "\x0c", a11y: "Control L, clear" },
  { label: "^Z", value: "\x1a", a11y: "Control Z, suspend" },
];

// One-line status shown above the keys while dictation is engaged.
function describeDictation(d: DictationControl): string {
  switch (d.status) {
    case "checking":
      return "Preparing…";
    case "downloading":
      return `Downloading ${d.modelLabel} · ${d.downloadPercent ?? 0}%`;
    case "loading":
      return "Loading speech model…";
    case "recognizing":
      return d.lastText ? `“${d.lastText}”` : "Transcribing…";
    case "listening":
      return d.speaking ? "Listening…" : d.lastText ? `“${d.lastText}”` : "Listening — speak now";
    case "error":
      return d.error ?? "Dictation unavailable";
    default:
      return "";
  }
}

export function CommandBar({
  targetId,
  sessionStatus,
  socketStatus,
  bottomInset = 0,
  keyboardVisible = false,
  blurTarget,
  dictation,
}: CommandBarProps) {
  const [expanded, setExpanded] = useState(true);

  const disabled = !targetId || sessionStatus !== "running" || socketStatus !== "open";
  const showExpandedKeys = expanded && !keyboardVisible;

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

  function send(key: ControlKey) {
    if (disabled || !targetId) {
      return;
    }
    // A control key is a deliberate, discrete action — give it a tactile tap.
    // The interrupt (^C) gets a heavier hit so it feels consequential.
    if (key.accent) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } else {
      Haptics.selectionAsync().catch(() => {});
    }
    terminalSocket.send({ type: "input", sessionId: targetId, data: key.value });
  }

  function renderKey(key: ControlKey, compact: boolean) {
    return (
      <Pressable
        key={key.label}
        disabled={disabled}
        onPress={() => send(key)}
        accessibilityRole="button"
        accessibilityLabel={key.a11y ?? key.label}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.key,
          compact && styles.keyCompact,
          key.accent && styles.keyAccent,
          disabled && styles.faded,
          pressed && styles.keyPressed,
        ]}
      >
        <Text style={[styles.keyText, key.accent && styles.keyTextAccent, disabled && styles.keyTextDisabled]}>
          {key.label}
        </Text>
      </Pressable>
    );
  }

  function renderMic(d: DictationControl) {
    // The mic can always be turned OFF; it's only blocked from turning ON when
    // there's no running session to inject the transcription into.
    const canToggle = !disabled || d.active;
    const danger = d.status === "error";
    const glow = d.active && (d.status === "listening" || d.status === "recognizing");
    const iconColor = danger ? colors.destructive : d.active ? colors.primary : colors.secondaryForeground;
    return (
      <Pressable
        onPress={() => {
          if (!canToggle) {
            return;
          }
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          d.onToggle();
        }}
        disabled={!canToggle}
        accessibilityRole="button"
        accessibilityLabel={d.active ? "Stop voice dictation" : "Start voice dictation"}
        accessibilityState={{ disabled: !canToggle, selected: d.active }}
        style={({ pressed }) => [
          styles.mic,
          d.active && styles.micActive,
          // Mic glows with the live input level while listening/transcribing.
          glow && { backgroundColor: `rgba(255, 191, 0, ${0.16 + Math.min(0.5, d.level * 0.6)})` },
          danger && styles.micError,
          !canToggle && styles.faded,
          pressed && styles.keyPressed,
        ]}
      >
        <MicIcon size={16} color={iconColor} />
      </Pressable>
    );
  }

  const showMic = Boolean(dictation && dictation.status !== "unsupported");
  const showDictationStrip = Boolean(
    dictation && dictation.status !== "idle" && dictation.status !== "unsupported"
  );
  const meterPercent = dictation
    ? dictation.status === "downloading"
      ? Math.max(0, Math.min(100, dictation.downloadPercent ?? 0))
      : Math.round(Math.max(0, Math.min(1, dictation.level)) * 100)
    : 0;

  return (
    <View style={[styles.container, keyboardVisible && styles.containerKeyboard, { paddingBottom: 8 + bottomInset }]}>
      <BlurView
        intensity={Platform.OS === "ios" ? 74 : 40}
        tint="systemChromeMaterialDark"
        blurMethod="dimezisBlurView"
        blurTarget={blurTarget}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, styles.glassTint]} pointerEvents="none" />
      <LinearGradient
        colors={[SHEEN_TOP, SHEEN_MID, SHEEN_BOTTOM]}
        locations={[0, 0.4, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {showDictationStrip && dictation ? (
        <View style={styles.dictationStrip}>
          <View style={styles.dictationMeterTrack}>
            <View style={[styles.dictationMeterFill, { width: `${meterPercent}%` }]} />
          </View>
          <Text
            style={[styles.dictationText, dictation.status === "error" && styles.dictationTextError]}
            numberOfLines={1}
          >
            {describeDictation(dictation)}
          </Text>
        </View>
      ) : null}

      <View style={styles.handleRow}>
        {showMic && dictation ? renderMic(dictation) : null}
        <Pressable
          onPress={toggleExpanded}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Hide extra keys" : "Show extra keys"}
          accessibilityState={{ expanded }}
          style={({ pressed }) => [styles.handle, pressed && styles.pressed]}
        >
          <Text style={styles.handleGlyph}>{expanded ? "⌄" : "⌃"}</Text>
          <Text style={styles.handleText}>Keys</Text>
        </Pressable>

        <View style={styles.visibleKeys}>
          {visibleKeys.map((key) => renderKey(key, keyboardVisible))}
        </View>
      </View>

      {showExpandedKeys ? (
        <View style={styles.keyRow}>{expandedKeys.map((key) => renderKey(key, false))}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: "transparent",
    borderTopLeftRadius: GLASS_RADIUS,
    borderTopRightRadius: GLASS_RADIUS,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: GLASS_BORDER,
    paddingHorizontal: 12,
    paddingTop: 11,
    gap: 8,
  },
  containerKeyboard: {
    paddingTop: 8,
    gap: 6,
  },
  glassTint: {
    backgroundColor: GLASS_TINT,
  },
  dictationStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 2,
  },
  dictationMeterTrack: {
    width: 56,
    height: 6,
    borderRadius: 3,
    backgroundColor: METER_TRACK,
    overflow: "hidden",
  },
  dictationMeterFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  dictationText: {
    flex: 1,
    color: colors.secondaryForeground,
    fontFamily: font.medium,
    fontSize: 12,
  },
  dictationTextError: {
    color: colors.destructive,
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
    backgroundColor: GLASS_RAISED,
    borderColor: GLASS_RAISED_BORDER,
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
  mic: {
    width: 42,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: GLASS_RAISED,
    borderColor: GLASS_RAISED_BORDER,
    borderWidth: 1,
  },
  micActive: {
    backgroundColor: MIC_ACTIVE_BG,
    borderColor: MIC_ACTIVE_BORDER,
  },
  micError: {
    backgroundColor: MIC_ERROR_BG,
    borderColor: ACCENT_GLASS_BORDER,
  },
  visibleKeys: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "nowrap",
    gap: 6,
  },
  keyRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  key: {
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: GLASS_RAISED,
    borderColor: GLASS_RAISED_BORDER,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  keyCompact: {
    minWidth: 40,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  keyAccent: {
    backgroundColor: ACCENT_GLASS,
    borderColor: ACCENT_GLASS_BORDER,
  },
  keyPressed: {
    backgroundColor: GLASS_PRESSED,
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
  pressed: {
    backgroundColor: GLASS_PRESSED,
  },
  faded: {
    opacity: 0.4,
  },
});

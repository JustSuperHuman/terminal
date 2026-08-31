import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { terminalSocket, type SocketStatus } from "../lib/socket";
import type { ComposerToken } from "./Composer";
import type { SessionStatus } from "../types";
import type { DictationUiStatus } from "../useDictation";
import { ImageIcon, KeyboardIcon, MicIcon } from "./icons";
import { colors, font, glass, radius, withAlpha } from "../theme";

// After a hold-to-dictate ends, the transcript is armed to "submit" (Enter) once
// this countdown elapses — tapping Cancel first stops it so you can redo/edit.
const ARM_SECONDS = 3;

// Width of the fade hinting that the key row scrolls past the edges.
const EDGE_FADE_WIDTH = 20;

type ControlKey = { label: string; value: string; strong?: boolean; a11y?: string };

// Every control key lives in one horizontally scrolling row, organized into
// clusters that each own a Fluent hue: the Windows accent for system keys,
// cyan for navigation, coral for the control chords (interrupts and friends).
// Clusters are frequency-ranked left to right — Esc/Tab and the arrows stay
// visible without scrolling, the interrupt cluster sits one flick away, and
// the rarely-needed Home/End pair takes the overflow.
type KeyGroup = { id: string; tint: string; keys: ControlKey[] };

const keyGroups: KeyGroup[] = [
  {
    id: "system",
    tint: colors.primary,
    keys: [
      { label: "Esc", value: "\x1b", a11y: "Escape" },
      { label: "Tab", value: "\t", a11y: "Tab" },
    ],
  },
  {
    id: "arrows",
    tint: colors.accentCyan,
    keys: [
      { label: "↑", value: "\x1b[A", a11y: "Up arrow" },
      { label: "↓", value: "\x1b[B", a11y: "Down arrow" },
      { label: "←", value: "\x1b[D", a11y: "Left arrow" },
      { label: "→", value: "\x1b[C", a11y: "Right arrow" },
    ],
  },
  {
    id: "control",
    tint: colors.accentCoral,
    keys: [
      { label: "^C", value: "\x03", strong: true, a11y: "Control C, interrupt" },
      { label: "^D", value: "\x04", a11y: "Control D" },
      { label: "^Z", value: "\x1a", a11y: "Control Z, suspend" },
      { label: "^L", value: "\x0c", a11y: "Control L, clear" },
    ],
  },
  {
    id: "jump",
    tint: colors.accentCyan,
    keys: [
      { label: "Home", value: "\x1b[H", a11y: "Home" },
      { label: "End", value: "\x1b[F", a11y: "End" },
    ],
  },
];

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
  /** Begin capturing (press-and-hold start). */
  onStart: () => void;
  /** Stop capturing and flush the final phrase (release). */
  onStop: () => void;
}

interface CommandBarProps {
  targetId?: string;
  sessionStatus?: SessionStatus;
  socketStatus: SocketStatus;
  bottomInset?: number;
  // Ref to the BlurTargetView behind the bar; required for real blur on Android.
  blurTarget?: RefObject<View | null>;
  dictation?: DictationControl;
  /** Open the explicit clipboard/photo image chooser. */
  onAttachImage?: () => void;
  /** True while an image upload is in flight (dims the attach control). */
  attachingImage?: boolean;
  /**
   * True while the Composer owns text entry. The key row then drops the mic
   * (the composer has its own) and gains `/` and `@` shortcuts that open the
   * composer's pickers rather than sending bytes.
   */
  composerMode?: boolean;
  onInsertToken?: (token: ComposerToken) => void;
  /** Switch between composing messages and typing straight into the terminal. */
  onToggleComposer?: () => void;
}

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
      return d.speaking ? "Listening…" : d.lastText ? `“${d.lastText}”` : "Listening — release to send";
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
  blurTarget,
  dictation,
  onAttachImage,
  attachingImage = false,
  composerMode = false,
  onInsertToken,
  onToggleComposer,
}: CommandBarProps) {
  // Seconds left on the post-dictation auto-submit countdown; null when disarmed.
  const [armSeconds, setArmSeconds] = useState<number | null>(null);
  const armSubmitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // True for the duration of a press-and-hold; gates whether speech was heard.
  const holdingRef = useRef(false);
  const spokeRef = useRef(false);
  // Dictation strip entrance (fade + 4px rise) and smoothed meter fill.
  const stripAnim = useRef(new Animated.Value(0)).current;
  const meterAnim = useRef(new Animated.Value(0)).current;

  const disabled = !targetId || sessionStatus !== "running" || socketStatus !== "open";
  const speaking = dictation?.speaking ?? false;
  const lastText = dictation?.lastText;

  const clearArm = useCallback(() => {
    if (armSubmitRef.current) {
      clearTimeout(armSubmitRef.current);
      armSubmitRef.current = null;
    }
    if (armTickRef.current) {
      clearInterval(armTickRef.current);
      armTickRef.current = null;
    }
    setArmSeconds(null);
  }, []);

  // Run the dictated command: send Enter to the active session.
  const submitEnter = useCallback(() => {
    if (!targetId) {
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    terminalSocket.send({ type: "input", sessionId: targetId, data: "\r" });
  }, [targetId]);

  // Arm the auto-submit: tick the visible countdown, then press Enter at zero
  // unless Retry (or a fresh hold) cancels it first.
  const beginArm = useCallback(() => {
    clearArm();
    setArmSeconds(ARM_SECONDS);
    armTickRef.current = setInterval(() => {
      setArmSeconds((s) => (s !== null && s > 1 ? s - 1 : s));
    }, 1000);
    armSubmitRef.current = setTimeout(() => {
      clearArm();
      submitEnter();
    }, ARM_SECONDS * 1000);
  }, [clearArm, submitEnter]);

  const cancelArm = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    clearArm();
  }, [clearArm]);

  // Disarm on unmount and whenever the target session can no longer take input.
  useEffect(() => clearArm, [clearArm]);
  useEffect(() => {
    if (disabled) {
      clearArm();
    }
  }, [disabled, clearArm]);

  // While holding, remember that speech actually occurred (VAD flip or a landed
  // phrase) so an empty hold doesn't arm a stray Enter.
  useEffect(() => {
    if (holdingRef.current && (speaking || lastText)) {
      spokeRef.current = true;
    }
  }, [speaking, lastText]);

  function micPressIn(d: DictationControl) {
    // Need a live session to dictate into and to submit to.
    if (disabled) {
      return;
    }
    // A new hold supersedes any pending auto-submit.
    clearArm();
    spokeRef.current = false;
    holdingRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    d.onStart();
  }

  function micPressOut(d: DictationControl) {
    if (!holdingRef.current) {
      return;
    }
    holdingRef.current = false;
    d.onStop();
    // Only arm the submit if we captured speech — a silent tap shouldn't run.
    if (spokeRef.current && !disabled && targetId) {
      beginArm();
    }
  }

  function send(key: ControlKey) {
    if (disabled || !targetId) {
      return;
    }
    // A control key is a deliberate, discrete action — give it a tactile tap.
    // The interrupt (^C) gets a heavier hit so it feels consequential.
    if (key.strong) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } else {
      Haptics.selectionAsync().catch(() => {});
    }
    terminalSocket.send({ type: "input", sessionId: targetId, data: key.value });
  }

  // A key wears its cluster's hue: tinted fill + border with the accent as the
  // label color, so the groups read at a glance without shouting.
  function renderKey(key: ControlKey, tint: string) {
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
          {
            backgroundColor: withAlpha(tint, key.strong ? 0.18 : 0.14),
            borderColor: withAlpha(tint, key.strong ? 0.42 : 0.26),
          },
          disabled && styles.faded,
          pressed && { backgroundColor: withAlpha(tint, 0.32) },
        ]}
      >
        <Text style={[styles.keyText, { color: tint }, disabled && styles.keyTextDisabled]}>{key.label}</Text>
      </Pressable>
    );
  }

  function renderMic(d: DictationControl) {
    // Press-and-hold to dictate: capture starts on press-in, stops on release.
    // The control still works while a session is missing only to release a hold.
    const danger = d.status === "error";
    const glow = d.active && (d.status === "listening" || d.status === "recognizing");
    const iconColor = danger ? colors.accentCoral : d.active ? colors.accentMint : colors.secondaryForeground;
    return (
      <Pressable
        onPressIn={() => micPressIn(d)}
        onPressOut={() => micPressOut(d)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Hold to dictate, release to send"
        accessibilityState={{ disabled, selected: d.active }}
        style={({ pressed }) => [
          styles.mic,
          d.active && styles.micActive,
          // Mic glows mint with the live input level while listening/transcribing.
          glow && { backgroundColor: withAlpha(colors.accentMint, 0.16 + Math.min(0.5, d.level * 0.6)) },
          danger && styles.micError,
          disabled && !d.active && styles.faded,
          pressed && styles.pressed,
        ]}
      >
        <MicIcon size={18} color={iconColor} />
      </Pressable>
    );
  }

  function attach() {
    if (disabled || attachingImage || !onAttachImage) {
      return;
    }
    Haptics.selectionAsync().catch(() => {});
    onAttachImage();
  }

  // Head of the key row while composing: shortcuts that type into the message,
  // not into the terminal. `⏎` is here because Enter itself now sends, so this
  // is the only way to put a deliberate line break in a longer prompt.
  function renderTokenKeys() {
    const tokens: Array<{ token: ComposerToken; label: string; a11y: string }> = [
      { token: "/", label: "/", a11y: "Slash commands" },
      { token: "@", label: "@", a11y: "Mention a file" },
      { token: "newline", label: "⏎", a11y: "Insert a line break" },
    ];

    return (
      <View style={[styles.group, styles.groupSpacedRight]}>
        {tokens.map(({ token, label, a11y }) => (
          <Pressable
            key={token}
            disabled={disabled}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              onInsertToken?.(token);
            }}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            accessibilityState={{ disabled }}
            style={({ pressed }) => [
              styles.key,
              {
                backgroundColor: withAlpha(colors.primary, 0.16),
                borderColor: withAlpha(colors.primary, 0.42),
              },
              disabled && styles.faded,
              pressed && { backgroundColor: withAlpha(colors.primary, 0.32) },
            ]}
          >
            <Text style={[styles.keyText, { color: colors.primary }, disabled && styles.keyTextDisabled]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  function renderComposerToggle() {
    return (
      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => {});
          onToggleComposer?.();
        }}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={composerMode ? "Type directly into the terminal" : "Compose a message instead"}
        accessibilityState={{ selected: !composerMode }}
        style={({ pressed }) => [styles.pinnedButton, !composerMode && styles.pinnedButtonActive, pressed && styles.pressed]}
      >
        <KeyboardIcon size={18} color={composerMode ? colors.secondaryForeground : colors.primary} />
      </Pressable>
    );
  }

  function renderAttach() {
    // Pictures go to remote Claude/Codex as pasted file paths: the host saves
    // the upload locally and bracket-pastes the path into the session.
    return (
      <Pressable
        onPress={attach}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Attach or paste an image"
        accessibilityState={{ disabled: disabled || attachingImage }}
        style={({ pressed }) => [
          styles.pinnedButton,
          (disabled || attachingImage) && styles.faded,
          pressed && styles.pressed,
        ]}
      >
        <ImageIcon size={18} color={attachingImage ? colors.accentAmber : colors.secondaryForeground} />
      </Pressable>
    );
  }

  // While composing, dictation dictates into the message: the composer owns the
  // mic and reports its own status, so this bar shows neither.
  const showMic = Boolean(dictation && dictation.status !== "unsupported") && !composerMode;
  const arming = armSeconds !== null;
  const showDictationStrip =
    !composerMode && Boolean(dictation && (arming || (dictation.status !== "idle" && dictation.status !== "unsupported")));
  const meterPercent = dictation
    ? dictation.status === "downloading"
      ? Math.max(0, Math.min(100, dictation.downloadPercent ?? 0))
      : Math.round(Math.max(0, Math.min(1, dictation.level)) * 100)
    : 0;

  // Ease the strip in when dictation engages; it unmounts on the way out, so
  // only the entrance animates (the bar snapping back is the "done" cue).
  useEffect(() => {
    if (showDictationStrip) {
      stripAnim.setValue(0);
      Animated.timing(stripAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    }
  }, [showDictationStrip, stripAnim]);

  // Smooth the meter between level samples so it breathes instead of stepping.
  useEffect(() => {
    Animated.timing(meterAnim, { toValue: meterPercent, duration: 150, useNativeDriver: false }).start();
  }, [meterPercent, meterAnim]);

  return (
    <View style={[styles.container, { paddingBottom: 8 + bottomInset }]}>
      <BlurView
        intensity={Platform.OS === "ios" ? 74 : 40}
        tint="systemChromeMaterialDark"
        blurMethod="dimezisBlurView"
        blurTarget={blurTarget}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, styles.glassTint]} pointerEvents="none" />

      {showDictationStrip && dictation ? (
        <Animated.View
          style={[
            styles.dictationStrip,
            {
              opacity: stripAnim,
              transform: [{ translateY: stripAnim.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
            },
          ]}
        >
          {arming ? (
            <>
              <View style={styles.armBadge}>
                <Text style={styles.armCount}>{armSeconds}</Text>
              </View>
              <Text style={styles.dictationText} numberOfLines={1}>
                Sending in {armSeconds}s…
              </Text>
              <Pressable
                onPress={cancelArm}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Cancel auto-send"
                style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
              >
                <Text style={styles.retryText}>Cancel</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.dictationMeterTrack}>
                <Animated.View
                  style={[
                    styles.dictationMeterFill,
                    { width: meterAnim.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) },
                  ]}
                />
              </View>
              <Text
                style={[styles.dictationText, dictation.status === "error" && styles.dictationTextError]}
                numberOfLines={1}
              >
                {describeDictation(dictation)}
              </Text>
            </>
          )}
        </Animated.View>
      ) : null}

      <View style={styles.toolbarRow}>
        {/* All control keys in one horizontally scrolling strip, in clusters.
            Edge fades hint that there is more to the sides. */}
        <View style={styles.scrollWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            overScrollMode="never"
            contentContainerStyle={styles.scrollContent}
          >
            {composerMode && onInsertToken ? renderTokenKeys() : null}
            {keyGroups.map((group, index) => (
              <View key={group.id} style={[styles.group, index > 0 && styles.groupSpaced]}>
                {group.keys.map((key) => renderKey(key, group.tint))}
              </View>
            ))}
          </ScrollView>
          <LinearGradient
            colors={[glass.tint, withAlpha(colors.background, 0)]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={[styles.edgeFade, styles.edgeFadeLeft]}
            pointerEvents="none"
          />
          <LinearGradient
            colors={[withAlpha(colors.background, 0), glass.tint]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={[styles.edgeFade, styles.edgeFadeRight]}
            pointerEvents="none"
          />
        </View>

        {/* The most-used controls stay pinned outside the scroll area. */}
        {onAttachImage ? renderAttach() : null}
        {showMic && dictation ? renderMic(dictation) : null}
        {onToggleComposer ? renderComposerToggle() : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: "transparent",
    borderTopWidth: 1,
    borderColor: glass.border,
    // Sized for the keyboard-up steady state (the keyboard is always open now).
    paddingTop: 8,
    paddingHorizontal: 10,
    gap: 6,
  },
  glassTint: {
    backgroundColor: glass.tint,
  },
  dictationStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
  },
  dictationMeterTrack: {
    width: 56,
    height: 6,
    borderRadius: 3,
    backgroundColor: glass.track,
    overflow: "hidden",
  },
  dictationMeterFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: colors.accentMint,
  },
  dictationText: {
    flex: 1,
    color: colors.secondaryForeground,
    fontFamily: font.medium,
    fontSize: 12,
  },
  dictationTextError: {
    color: colors.accentCoral,
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  scrollWrap: {
    flex: 1,
    position: "relative",
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: EDGE_FADE_WIDTH / 2,
  },
  // 8px between keys keeps neighbors — ^C beside ^D especially — out of each
  // other's fat-finger radius while staying on the 4px grid.
  group: {
    flexDirection: "row",
    gap: 8,
  },
  // Cluster spacing doubles as the group separator — a clear visual breath
  // between hue families without extra chrome.
  groupSpaced: {
    marginLeft: 16,
  },
  groupSpacedRight: {
    marginRight: 16,
  },
  edgeFade: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: EDGE_FADE_WIDTH,
  },
  edgeFadeLeft: {
    left: 0,
  },
  edgeFadeRight: {
    right: 0,
  },
  // 44px both ways — the minimum comfortable touch target for the most-used
  // surface in the app.
  key: {
    minWidth: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
  },
  // Key legends in Cascadia Mono SemiBold — exactly Windows Terminal's face.
  // (The weight lives in the family name: a synthetic fontWeight would knock
  // Android off the loaded custom font.)
  keyText: {
    fontFamily: font.monoSemibold,
    fontSize: 14,
  },
  keyTextDisabled: {
    color: colors.faint,
  },
  // Pinned controls (attach + mic) share one quiet raised-glass look; state
  // colors the icon, not the chrome, so the row stays calm.
  pinnedButton: {
    width: 46,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: glass.raised,
    borderColor: glass.raisedBorder,
    borderWidth: 1,
  },
  pinnedButtonActive: {
    backgroundColor: withAlpha(colors.primary, 0.18),
    borderColor: withAlpha(colors.primary, 0.45),
  },
  mic: {
    width: 56,
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
  armBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: withAlpha(colors.accentMint, 0.18),
    borderColor: withAlpha(colors.accentMint, 0.5),
    borderWidth: 1,
  },
  armCount: {
    color: colors.accentMint,
    fontFamily: font.bold,
    fontSize: 12,
  },
  // WinUI buttons are 4px-cornered, never pill-shaped.
  retry: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: glass.raised,
    borderColor: glass.raisedBorder,
    borderWidth: 1,
  },
  retryText: {
    color: colors.accentCyan,
    fontFamily: font.semibold,
    fontSize: 12.5,
  },
  pressed: {
    backgroundColor: glass.pressed,
  },
  faded: {
    opacity: 0.4,
  },
});

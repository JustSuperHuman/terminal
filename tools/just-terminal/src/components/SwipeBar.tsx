import { useEffect, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { ChevronIcon } from "./icons";
import { Acrylic } from "./Acrylic";
import { colors, font, glass, radius, withAlpha } from "../theme";

// A slim glass bar that sits directly above the CommandBar and owns TERMINAL
// SWITCHING (it never scrolls the terminal — scrolling lives on the page's
// right-edge strip over the terminal itself):
//   - horizontal swipe = scrub between sessions (the SessionSwitcher picker
//     wheel summons as soon as the drag passes the slop; one session per
//     SCRUB_STEP_PX of travel; release commits, gesture-cancel reverts)
//   - press-and-hold (HOLD_MS without moving) also summons the picker, for a
//     look-first scrub
//   - plain tap = open the sessions drawer
//   - the chevrons at either end step one session, and only appear when there
//     is somewhere to step to
// The chevrons are siblings of the gesture area rather than children of it:
// the PanResponder captures every touch that starts inside it, so a Pressable
// nested within would never fire.
// The gesture is entirely RN-side, so it never touches the WebView's focus —
// ghostty's textarea keeps the soft keyboard open throughout.
//
// Visual: the old left-edge grip's dots UI, laid horizontally — one cyan dot
// per session with the active one lit, plus the session count. Cyan is the
// navigation hue (it matches the arrow cluster in the CommandBar), and the
// frosted styling comes from the shared theme glass tokens.

const BAR_HEIGHT = 24; // touch height of the whole bar (slim, but not a sliver)
const HOLD_MS = 250; // press-and-hold threshold to summon the picker in place
const HOLD_SLOP_PX = 8; // movement past this before the hold fires = scrub drag
const SCRUB_STEP_PX = 60; // horizontal travel per one session while scrubbing
const MAX_DOTS = 10; // cap the dot row; the count label always shows the truth

type BarMode = "idle" | "pending" | "scrub" | "inert";

interface SwipeBarProps {
  sessionCount: number;
  /** Index of the active session in the list (-1 when unknown). */
  activeIndex: number;
  /** Plain tap (no hold, no drag): open the sessions drawer. */
  onTap: () => void;
  /** Drag/hold began: summon the session scrubber. Return false to stay inert. */
  onScrubBegin: () => boolean;
  /** Scrub drag: select anchor+steps in the scrubber (>0 = later in the list). */
  onScrubMove: (steps: number) => void;
  /** Scrub ended: commit on release, revert on gesture cancellation. */
  onScrubEnd: (commit: boolean) => void;
  /** Chevron tap: move one session earlier (-1) or later (+1) in the list. */
  onStep?: (delta: -1 | 1) => void;
}

export function SwipeBar({
  sessionCount,
  activeIndex,
  onTap,
  onScrubBegin,
  onScrubMove,
  onScrubEnd,
  onStep,
}: SwipeBarProps) {
  // Visual-only mirror of the gesture mode (drives the pill styling).
  const [mode, setMode] = useState<BarMode>("idle");

  // The PanResponder is created once and reads the latest callbacks via a ref.
  const handlers = useRef({ onTap, onScrubBegin, onScrubMove, onScrubEnd });
  useEffect(() => {
    handlers.current = { onTap, onScrubBegin, onScrubMove, onScrubEnd };
  }, [onTap, onScrubBegin, onScrubMove, onScrubEnd]);

  const modeRef = useRef<BarMode>("idle");
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setBarMode = (next: BarMode) => {
    modeRef.current = next;
    setMode(next);
  };

  const clearHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  useEffect(() => clearHold, []);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        setBarMode("pending");
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          // Still a stationary press: summon the picker so the user can see
          // the list before sliding. If there is nothing to scrub
          // (<2 sessions) stay pending so release = tap.
          if (modeRef.current === "pending" && handlers.current.onScrubBegin()) {
            setBarMode("scrub");
          }
        }, HOLD_MS);
      },
      onPanResponderMove: (_evt, gesture) => {
        if (modeRef.current === "pending") {
          if (Math.abs(gesture.dx) <= HOLD_SLOP_PX && Math.abs(gesture.dy) <= HOLD_SLOP_PX) {
            return;
          }
          // Moved past the slop: this is a session-scrub drag. With nothing to
          // scrub, go inert so releasing a drag doesn't count as a tap.
          clearHold();
          setBarMode(handlers.current.onScrubBegin() ? "scrub" : "inert");
        }
        if (modeRef.current === "scrub") {
          // Drag right = later in the session list, left = earlier. The slop
          // (8px) is well under half a step, so no baseline correction needed.
          handlers.current.onScrubMove(Math.round(gesture.dx / SCRUB_STEP_PX));
        }
      },
      onPanResponderRelease: () => {
        clearHold();
        const finished = modeRef.current;
        setBarMode("idle");
        if (finished === "scrub") {
          handlers.current.onScrubEnd(true);
        } else if (finished === "pending") {
          // Quick tap: never held, never dragged — open the sessions drawer.
          handlers.current.onTap();
        }
      },
      onPanResponderTerminate: () => {
        clearHold();
        const finished = modeRef.current;
        setBarMode("idle");
        if (finished === "scrub") {
          handlers.current.onScrubEnd(false);
        }
      },
    })
  ).current;

  const dotCount = Math.min(sessionCount, MAX_DOTS);
  const activeDot = activeIndex >= 0 ? Math.min(activeIndex, MAX_DOTS - 1) : -1;
  const scrubbing = mode === "scrub";
  const canStepBack = Boolean(onStep) && activeIndex > 0;
  const canStepForward = Boolean(onStep) && activeIndex >= 0 && activeIndex < sessionCount - 1;

  // The slot keeps its width whether or not a chevron is in it, so reaching
  // either end of the list doesn't shuffle the bar sideways.
  function renderStep(delta: -1 | 1, enabled: boolean) {
    if (!enabled) {
      return <View style={styles.step} />;
    }
    return (
      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => {});
          onStep?.(delta);
        }}
        hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel={delta < 0 ? "Previous terminal" : "Next terminal"}
        style={({ pressed }) => [styles.step, pressed && styles.stepPressed]}
      >
        <ChevronIcon direction={delta < 0 ? "left" : "right"} />
      </Pressable>
    );
  }

  return (
    <View style={styles.row}>
      {renderStep(-1, canStepBack)}
      <View
        style={[styles.bar, scrubbing && styles.barEngagedBorder]}
        accessibilityRole="adjustable"
        accessibilityLabel={`Terminal switcher · ${sessionCount} sessions. Swipe left or right to switch terminals. Tap to open the session list.`}
        accessibilityValue={activeIndex >= 0 ? { text: `Terminal ${activeIndex + 1} of ${sessionCount}` } : undefined}
        {...responder.panHandlers}
      >
        <Acrylic />
        {/* Touch feedback washes layer above the acrylic, not in place of it. */}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            mode === "pending" && styles.barPending,
            scrubbing && styles.barEngaged,
          ]}
        />
        <View style={styles.grip}>
          {Array.from({ length: dotCount }, (_, index) => (
            <View
              key={index}
              style={[styles.dot, index === activeDot && styles.dotActive]}
            />
          ))}
          {sessionCount > 1 ? <Text style={styles.count}>{sessionCount}</Text> : null}
        </View>
      </View>
      {renderStep(1, canStepForward)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    marginBottom: 4,
    gap: 4,
  },
  // 4px corners on the steppers and the strip itself — WinUI subtle buttons,
  // not pills.
  step: {
    width: 26,
    height: BAR_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  stepPressed: {
    backgroundColor: glass.pressed,
  },
  bar: {
    flex: 1,
    height: BAR_HEIGHT,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: glass.border,
    // Clips the Acrylic backing to the rounded corners.
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  // A faint wash the instant the finger lands, so the bar acknowledges the
  // touch before the hold or drag resolves; the full cyan wash means "scrubbing".
  barPending: {
    backgroundColor: withAlpha(colors.accentCyan, 0.06),
  },
  barEngaged: {
    backgroundColor: withAlpha(colors.accentCyan, 0.14),
  },
  barEngagedBorder: {
    borderColor: withAlpha(colors.accentCyan, 0.4),
  },
  grip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: withAlpha(colors.accentCyan, 0.45),
  },
  dotActive: {
    width: 10,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accentCyan,
  },
  count: {
    marginLeft: 4,
    color: colors.accentCyan,
    fontSize: 11,
    fontFamily: font.bold,
  },
});

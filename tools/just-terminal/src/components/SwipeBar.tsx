import { useEffect, useRef, useState } from "react";
import { PanResponder, StyleSheet, Text, View } from "react-native";
import { font, radius } from "../theme";

// A slim glass bar that sits directly above the CommandBar and owns TERMINAL
// SWITCHING (it never scrolls the terminal — scrolling lives on the page's
// right-edge strip over the terminal itself):
//   - horizontal swipe = scrub between sessions (the SessionSwitcher picker
//     wheel summons as soon as the drag passes the slop; one session per
//     SCRUB_STEP_PX of travel; release commits, gesture-cancel reverts)
//   - press-and-hold (HOLD_MS without moving) also summons the picker, for a
//     look-first scrub
//   - plain tap = open the sessions drawer
// The gesture is entirely RN-side, so it never touches the WebView's focus —
// ghostty's textarea keeps the soft keyboard open throughout.
//
// Visual: the old left-edge grip's dots UI, laid horizontally — one gold dot
// per session with the active one lit, plus the session count.

// Glass palette mirrors CommandBar's frosted styling.
const GLASS_BG = "rgba(10, 12, 16, 0.40)";
const GLASS_BORDER = "rgba(255, 255, 255, 0.10)";
const GLASS_ACTIVE_BG = "rgba(255, 191, 0, 0.08)";
const DOT_IDLE = "rgba(255, 191, 0, 0.35)";
const DOT_ACTIVE = "rgba(255, 191, 0, 0.95)";
const COUNT_GOLD = "rgba(255, 191, 0, 0.85)";

const BAR_HEIGHT = 20; // touch height of the whole bar
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
}

export function SwipeBar({ sessionCount, activeIndex, onTap, onScrubBegin, onScrubMove, onScrubEnd }: SwipeBarProps) {
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
  return (
    <View
      style={[styles.bar, scrubbing && styles.barEngaged]}
      accessibilityRole="adjustable"
      accessibilityLabel={`Terminal switcher · ${sessionCount} sessions. Swipe left or right to switch terminals. Tap to open the session list.`}
      {...responder.panHandlers}
    >
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
  );
}

const styles = StyleSheet.create({
  bar: {
    height: BAR_HEIGHT,
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    backgroundColor: GLASS_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  barEngaged: {
    backgroundColor: GLASS_ACTIVE_BG,
  },
  grip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: DOT_IDLE,
  },
  dotActive: {
    width: 8,
    height: 4,
    borderRadius: 2,
    backgroundColor: DOT_ACTIVE,
  },
  count: {
    marginLeft: 5,
    color: COUNT_GOLD,
    fontSize: 10,
    fontFamily: font.bold,
  },
});

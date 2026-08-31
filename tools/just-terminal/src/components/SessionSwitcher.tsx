import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import * as Haptics from "expo-haptics";
import type { TerminalSessionSummary } from "../types";
import { colors, font, radius } from "../theme";

// Session scrubber picker: a full-screen overlay (live terminal preview behind
// a translucent card wheel) summoned by the SwipeBar's horizontal drag (or a
// stationary press-and-hold, for a look-first scrub). The bar owns the touch;
// this component only renders the picker and applies the scrub via an
// imperative handle:
//   begin()          -> summon the picker anchored on the active session
//                       (returns false when there is nothing to scrub)
//   moveBy(steps)    -> select anchor+steps (clamped), live-previewing it
//   finish(commit)   -> commit switches to the selection; cancel reverts the
//                       preview to the anchor session

const ROW_HEIGHT = 62; // height of each picker card

export interface SessionSwitcherHandle {
  /** Summon the picker. Returns false (no-op) when fewer than 2 sessions. */
  begin: () => boolean;
  /** Move the selection to anchor+steps (clamped to the session list). */
  moveBy: (steps: number) => void;
  /** Dismiss: commit switches to the selection, cancel reverts the preview. */
  finish: (commit: boolean) => void;
}

interface SessionSwitcherProps {
  sessions: TerminalSessionSummary[];
  activeId?: string;
  unread: Record<string, number>;
  onSelect: (id: string) => void;
  // Live-switch the terminal to the scrubbed session while still dragging, so the
  // user sees the destination before releasing (committed via onSelect, reverted
  // to the start on cancel).
  onPreview?: (id: string) => void;
  // Fired true while scrubbing so the host can suppress the launch skeleton (we
  // want to see real terminal content flip during the scrub, not a placeholder).
  onScrubbingChange?: (scrubbing: boolean) => void;
}

function shellName(session: TerminalSessionSummary) {
  return session.shell.split(/[\\/]/).pop() ?? session.shell;
}

function sessionKind(session: TerminalSessionSummary): string {
  if (session.agent === "claude") return "Claude · Terminal Assist";
  if (session.agent === "codex") return "Codex · Terminal Assist";
  if (session.agent === "hermes") return "Hermes";
  return shellName(session);
}

function shortPath(path: string, max = 24): string {
  return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

const tick = () => Haptics.selectionAsync().catch(() => {});
const thud = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
const confirm = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

export const SessionSwitcher = forwardRef<SessionSwitcherHandle, SessionSwitcherProps>(function SessionSwitcher(
  { sessions, activeId, unread, onSelect, onPreview, onScrubbingChange },
  ref
) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // The imperative handle reads live values through refs.
  const sessionsRef = useRef(sessions);
  const activeIdRef = useRef(activeId);
  const anchorSessionIdRef = useRef<string | undefined>(undefined);
  const onPreviewRef = useRef(onPreview);
  const onScrubbingChangeRef = useRef(onScrubbingChange);
  useEffect(() => {
    onPreviewRef.current = onPreview;
    onScrubbingChangeRef.current = onScrubbingChange;
  }, [onPreview, onScrubbingChange]);
  const selectedRef = useRef(0);
  const anchorIndexRef = useRef(0);
  const activeRef = useRef(false);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const pos = useRef(new Animated.Value(0)).current; // continuous selected index
  const fade = useRef(new Animated.Value(0)).current; // overlay opacity

  const moveSelection = useCallback(
    (next: number) => {
      if (next === selectedRef.current) {
        return;
      }
      selectedRef.current = next;
      setSelected(next);
      tick();
      Animated.spring(pos, { toValue: next, useNativeDriver: true, speed: 22, bounciness: 5 }).start();
      // Live-switch the terminal behind the picker to the scrubbed session.
      const previewId = sessionsRef.current[next]?.id;
      if (previewId) {
        onPreviewRef.current?.(previewId);
      }
    },
    [pos]
  );

  const begin = useCallback(() => {
    const list = sessionsRef.current;
    if (list.length < 2 || activeRef.current) {
      return false;
    }
    const start = Math.max(0, list.findIndex((item) => item.id === activeIdRef.current));
    anchorIndexRef.current = start;
    anchorSessionIdRef.current = list[start]?.id;
    selectedRef.current = start;
    setSelected(start);
    pos.setValue(start);
    activeRef.current = true;
    setActive(true);
    onScrubbingChangeRef.current?.(true);
    thud();
    Animated.timing(fade, { toValue: 1, duration: 130, useNativeDriver: true }).start();
    return true;
  }, [fade, pos]);

  const moveBy = useCallback(
    (steps: number) => {
      if (!activeRef.current) {
        return;
      }
      const count = sessionsRef.current.length;
      const next = Math.min(count - 1, Math.max(0, anchorIndexRef.current + steps));
      moveSelection(next);
    },
    [moveSelection]
  );

  const finish = useCallback(
    (commit: boolean) => {
      if (!activeRef.current) {
        return;
      }
      activeRef.current = false;
      onScrubbingChangeRef.current?.(false);
      const target = sessionsRef.current[selectedRef.current];
      if (commit && target) {
        // The terminal was already previewed to `target`; finalize (clears unread,
        // closes the drawer). Only celebrate when it's an actual change.
        if (target.id !== anchorSessionIdRef.current) {
          confirm();
        }
        onSelect(target.id);
      } else if (!commit && anchorSessionIdRef.current) {
        // Cancelled mid-scrub: snap the terminal back to where we started.
        onPreviewRef.current?.(anchorSessionIdRef.current);
      }
      Animated.timing(fade, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
        if (!activeRef.current) {
          setActive(false);
        }
      });
    },
    [fade, onSelect]
  );

  useImperativeHandle(ref, () => ({ begin, moveBy, finish }), [begin, moveBy, finish]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerH(event.nativeEvent.layout.height);
  }, []);

  const centerY = containerH / 2;
  // Slide the whole column so the selected card lands on the centre frame.
  const listTranslate = Animated.subtract(centerY - ROW_HEIGHT / 2, Animated.multiply(pos, ROW_HEIGHT));

  // The wrapper is a permanent, untouchable full-bleed layer: it measures the
  // terminal area (so the wheel centres correctly on the first frame) and hosts
  // the picker overlay only while a scrub is in flight. All touches pass
  // through to the terminal beneath.
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={onLayout}>
      {active ? (
        <Animated.View style={[StyleSheet.absoluteFill, styles.overlay, { opacity: fade }]} pointerEvents="none">
          <View style={styles.topHint}>
            <Text style={styles.topHintText}>Switch terminal</Text>
            <Text style={styles.topHintSub}>
              {selected + 1} / {sessions.length}
            </Text>
          </View>

          {/* Fixed selection frame at centre; the column scrubs through it. */}
          <View pointerEvents="none" style={[styles.selectionFrame, { top: centerY - ROW_HEIGHT / 2 }]} />

          <Animated.View
            style={[styles.list, { transform: [{ translateY: listTranslate }] }]}
            pointerEvents="none"
          >
            {sessions.map((session, index) => {
              const isSelected = index === selected;
              const cardOpacity = pos.interpolate({
                inputRange: [index - 2.4, index, index + 2.4],
                outputRange: [0.16, 1, 0.16],
                extrapolate: "clamp",
              });
              const cardScale = pos.interpolate({
                inputRange: [index - 1.5, index, index + 1.5],
                outputRange: [0.84, 1, 0.84],
                extrapolate: "clamp",
              });
              const count = unread[session.id] ?? 0;
              return (
                <Animated.View
                  key={session.id}
                  style={[styles.cardWrap, { opacity: cardOpacity, transform: [{ scale: cardScale }] }]}
                >
                  <View style={[styles.card, isSelected && styles.cardSelected]}>
                    {isSelected ? <View style={styles.cardBar} /> : null}
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: session.status === "running" ? colors.success : colors.faint },
                      ]}
                    />
                    <View style={styles.cardText}>
                      <View style={styles.cardTitleRow}>
                        <Text
                          style={[styles.cardTitle, isSelected && styles.cardTitleSelected]}
                          numberOfLines={1}
                        >
                          {session.title}
                        </Text>
                        {count > 0 ? (
                          <View style={styles.badge}>
                            <Text style={styles.badgeText}>{count > 99 ? "99+" : count}</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.cardSub} numberOfLines={1}>
                        {/* Name exited status — at scrub speed the 9px dot alone
                            doesn't read. */}
                        {session.status !== "running" ? "exited · " : ""}
                        {sessionKind(session)} · {shortPath(session.cwd)}
                      </Text>
                    </View>
                  </View>
                </Animated.View>
              );
            })}
          </Animated.View>

          <View style={styles.bottomHint}>
            <Text style={styles.bottomHintText}>Slide to choose · release to switch</Text>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  overlay: {
    // Translucent so the live terminal preview is visible behind the picker as
    // the user scrubs between sessions.
    backgroundColor: colors.overlaySoft,
  },
  topHint: {
    position: "absolute",
    top: 18,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 3,
  },
  // Fluent Caption, sentence case — never all-caps or tracked-out.
  topHintText: {
    color: colors.accentCyan,
    fontSize: 12,
    fontFamily: font.semibold,
  },
  topHintSub: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.mono,
  },
  // Quiet WinUI focus frame — the selected card's accent pill does the
  // pointing; the frame is just a hairline stop for the scrub.
  selectionFrame: {
    position: "absolute",
    left: 14,
    right: 14,
    height: ROW_HEIGHT,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  list: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
  },
  cardWrap: {
    height: ROW_HEIGHT,
    paddingHorizontal: 14,
    paddingVertical: 5,
    justifyContent: "center",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: "100%",
    paddingHorizontal: 16,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  cardSelected: {
    backgroundColor: colors.selection,
  },
  // WinUI selection indicator: 3px accent pill, ~16px tall, centred on the
  // card's left edge.
  cardBar: {
    position: "absolute",
    left: 0,
    top: "50%",
    marginTop: -8,
    width: 3,
    height: 16,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  cardText: {
    flex: 1,
    minWidth: 0,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  // Fluent BodyStrong; unselected cards use secondary text so the centre
  // frame's white title is the clear focal point.
  cardTitle: {
    flexShrink: 1,
    color: colors.secondaryForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  cardTitleSelected: {
    color: colors.foreground,
    fontFamily: font.semibold,
  },
  cardSub: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.mono,
    marginTop: 2,
  },
  badge: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 18,
    alignItems: "center",
  },
  badgeText: {
    color: colors.primaryForeground,
    fontSize: 10.5,
    fontFamily: font.semibold,
  },
  bottomHint: {
    position: "absolute",
    bottom: 22,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  bottomHintText: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.medium,
  },
});

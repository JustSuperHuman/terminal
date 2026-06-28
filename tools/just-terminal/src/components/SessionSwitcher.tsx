import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import * as Haptics from "expo-haptics";
import type { TerminalSessionSummary } from "../types";
import { colors, font, radius } from "../theme";

const GOLD_BORDER = "rgba(255, 191, 0, 0.42)";

// Press-and-hold (or drag) on the left edge of the terminal to summon a
// vertical picker, then slide up/down to scrub between every live session and
// release to switch. The capture strip sits above the terminal WebView so the
// gesture wins over the terminal's own touch scrolling; the picker overlay is
// purely visual — once the strip owns the responder it keeps every move/release
// for the whole gesture, wherever the finger travels.

const STRIP_WIDTH = 26; // left-edge capture zone
const ROW_HEIGHT = 62; // height of each picker card
const ACTIVATE_HOLD_MS = 190; // press-and-hold threshold to summon the picker
const ACTIVATE_DRAG_PX = 12; // …or a deliberate drag past this also summons it
const STEP_PX = 46; // finger travel per one-session step

interface SessionSwitcherProps {
  sessions: TerminalSessionSummary[];
  activeId?: string;
  unread: Record<string, number>;
  onSelect: (id: string) => void;
  // Quick tap on the grip opens the full (tappable) session list — slide is for
  // power users, tap is the discoverable path.
  onRequestList?: () => void;
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

function shortPath(path: string, max = 24): string {
  return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

const tick = () => Haptics.selectionAsync().catch(() => {});
const thud = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
const confirm = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

export function SessionSwitcher({
  sessions,
  activeId,
  unread,
  onSelect,
  onRequestList,
  onPreview,
  onScrubbingChange,
}: SessionSwitcherProps) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // The PanResponder is created once; it reads live values through refs.
  const sessionsRef = useRef(sessions);
  const activeIdRef = useRef(activeId);
  const anchorSessionIdRef = useRef<string | undefined>(undefined);
  const onRequestListRef = useRef(onRequestList);
  const onPreviewRef = useRef(onPreview);
  const onScrubbingChangeRef = useRef(onScrubbingChange);
  useEffect(() => {
    onRequestListRef.current = onRequestList;
    onPreviewRef.current = onPreview;
    onScrubbingChangeRef.current = onScrubbingChange;
  }, [onRequestList, onPreview, onScrubbingChange]);
  const selectedRef = useRef(0);
  const anchorIndexRef = useRef(0);
  const activeRef = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      return;
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
  }, [fade, pos]);

  const finish = useCallback(
    (commit: boolean) => {
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
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

  // Keep the responder's closures pointing at the freshest callbacks.
  const handlers = useRef({ begin, finish, moveSelection });
  useEffect(() => {
    handlers.current = { begin, finish, moveSelection };
  }, [begin, finish, moveSelection]);

  useEffect(() => {
    return () => {
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
      }
    };
  }, []);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => sessionsRef.current.length >= 2,
      onStartShouldSetPanResponderCapture: () => sessionsRef.current.length >= 2,
      onMoveShouldSetPanResponder: () => activeRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        if (sessionsRef.current.length < 2) {
          return;
        }
        holdTimer.current = setTimeout(() => handlers.current.begin(), ACTIVATE_HOLD_MS);
      },
      onPanResponderMove: (_evt, gesture) => {
        if (!activeRef.current) {
          if (Math.abs(gesture.dy) <= ACTIVATE_DRAG_PX && Math.abs(gesture.dx) <= ACTIVATE_DRAG_PX) {
            return;
          }
          if (holdTimer.current) {
            clearTimeout(holdTimer.current);
            holdTimer.current = null;
          }
          handlers.current.begin();
        }
        const count = sessionsRef.current.length;
        const steps = Math.round(gesture.dy / STEP_PX);
        const next = Math.min(count - 1, Math.max(0, anchorIndexRef.current + steps));
        handlers.current.moveSelection(next);
      },
      onPanResponderRelease: () => {
        // A quick tap (no hold-to-activate, no slide) never entered scrub mode —
        // treat it as "open the session list" so switching is discoverable.
        const wasActive = activeRef.current;
        handlers.current.finish(true);
        if (!wasActive) {
          onRequestListRef.current?.();
        }
      },
      onPanResponderTerminate: () => handlers.current.finish(false),
    })
  ).current;

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerH(event.nativeEvent.layout.height);
  }, []);

  const hasMany = sessions.length >= 2;
  const centerY = containerH / 2;
  // Slide the whole column so the selected card lands on the centre frame.
  const listTranslate = Animated.subtract(centerY - ROW_HEIGHT / 2, Animated.multiply(pos, ROW_HEIGHT));

  // Idle, only the 26px edge strip overlays the terminal — the rest of the
  // surface is left clear so taps reach the WebView (Android does not reliably
  // pass taps through a full-screen pointerEvents="box-none" view). The picker
  // overlay is mounted only while actively scrubbing.
  return (
    <>
      <View
        style={styles.strip}
        pointerEvents={hasMany ? "auto" : "none"}
        onLayout={onLayout}
        accessibilityRole="button"
        accessibilityLabel={`Switch terminal · ${sessions.length} sessions. Tap to list, hold and slide to scrub.`}
        {...responder.panHandlers}
      >
        {hasMany && !active ? (
          <View style={styles.grip}>
            <View style={styles.gripDot} />
            <View style={styles.gripDot} />
            <View style={styles.gripDot} />
            <Text style={styles.gripCount}>{sessions.length}</Text>
          </View>
        ) : null}
      </View>

      {active ? (
        <Animated.View style={[StyleSheet.absoluteFill, styles.overlay, { opacity: fade }]} pointerEvents="none">
          <View style={styles.topHint}>
            <Text style={styles.topHintText}>SWITCH TERMINAL</Text>
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
                        {shellName(session)} · {shortPath(session.cwd)}
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
    </>
  );
}

const styles = StyleSheet.create({
  strip: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: STRIP_WIDTH,
    alignItems: "center",
    justifyContent: "center",
  },
  grip: {
    gap: 5,
    paddingVertical: 14,
    paddingHorizontal: 7,
    borderTopRightRadius: radius.pill,
    borderBottomRightRadius: radius.pill,
    backgroundColor: "rgba(255, 191, 0, 0.08)",
  },
  gripDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255, 191, 0, 0.5)",
  },
  gripCount: {
    marginTop: 4,
    color: "rgba(255, 191, 0, 0.85)",
    fontSize: 10,
    fontFamily: font.bold,
  },
  overlay: {
    // Translucent so the live terminal preview is visible behind the picker as
    // the user scrubs between sessions.
    backgroundColor: "rgba(8, 10, 13, 0.5)",
  },
  topHint: {
    position: "absolute",
    top: 18,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 3,
  },
  topHintText: {
    color: colors.primary,
    fontSize: 11,
    fontFamily: font.bold,
    letterSpacing: 1.6,
  },
  topHintSub: {
    color: colors.mutedForeground,
    fontSize: 11.5,
    fontFamily: font.mono,
  },
  selectionFrame: {
    position: "absolute",
    left: 14,
    right: 14,
    height: ROW_HEIGHT,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: GOLD_BORDER,
    backgroundColor: "rgba(255, 191, 0, 0.06)",
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
    backgroundColor: colors.surfaceAlt,
  },
  cardBar: {
    position: "absolute",
    left: 0,
    top: 12,
    bottom: 12,
    width: 3,
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
  cardTitle: {
    flexShrink: 1,
    color: colors.sidebarForeground,
    fontSize: 15,
    fontFamily: font.semibold,
  },
  cardTitleSelected: {
    color: colors.foreground,
    fontFamily: font.bold,
  },
  cardSub: {
    color: colors.mutedForeground,
    fontSize: 11.5,
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
    fontFamily: font.bold,
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
    fontSize: 11.5,
    fontFamily: font.medium,
  },
});

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, font, radius, withAlpha } from "../theme";
import { Acrylic } from "./Acrylic";

// One notification surfaced at a time: newest wins, auto-hides, and tapping
// jumps to the session that rang (when the server attributed one).
export interface ToastNotification {
  /** Change of key restarts the show/auto-hide cycle for a new notification. */
  key: string;
  title?: string;
  body?: string;
  sessionId?: string;
}

interface NotificationToastProps {
  notification: ToastNotification | null;
  topInset: number;
  onPress: (sessionId?: string) => void;
  onDismiss: () => void;
}

const SHOW_MS = 4500;

export function NotificationToast({ notification, topInset, onPress, onDismiss }: NotificationToastProps) {
  const slide = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept mounted with the last notification while the exit fade plays, so
  // dismissal (timeout or tap) slides out instead of vanishing mid-frame.
  const [current, setCurrent] = useState<ToastNotification | null>(notification);

  useEffect(() => {
    if (notification) {
      setCurrent(notification);
      slide.stopAnimation();
      slide.setValue(0);
      Animated.timing(slide, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      hideTimer.current = setTimeout(onDismiss, SHOW_MS);
      return () => {
        if (hideTimer.current) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
      };
    }
    // Prop cleared: play the exit slide, then drop the retained copy.
    Animated.timing(slide, {
      toValue: 0,
      duration: 150,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setCurrent(null);
      }
    });
    return undefined;
  }, [notification?.key, notification === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) {
    return null;
  }

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [-72, 0] });

  return (
    <Animated.View style={[styles.wrap, { top: topInset + 8, transform: [{ translateY }], opacity: slide }]}>
      <Pressable
        onPress={() => onPress(current.sessionId)}
        accessibilityRole="button"
        accessibilityLabel={`Notification: ${current.title ?? "Terminal"}. ${current.body ?? ""}`}
        accessibilityHint={current.sessionId ? "Opens the session that sent this notification" : "Dismisses the notification"}
        style={styles.card}
      >
        {({ pressed }) => (
          <>
            <Acrylic />
            {pressed ? <View style={[StyleSheet.absoluteFill, styles.cardPressed]} /> : null}
            {/* WinUI toast accent: a slim bar in the accent color along the left edge. */}
            <View style={styles.accentBar} />
            <View style={styles.textCol}>
              <Text style={styles.title} numberOfLines={1}>
                {current.title ?? "Terminal"}
              </Text>
              {current.body ? (
                <Text style={styles.body} numberOfLines={2}>
                  {current.body}
                </Text>
              ) : null}
            </View>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 8,
    // Flyout elevation lives out here: the card clips its children (accent
    // bar corners), and overflow:hidden would clip an iOS shadow with it.
    shadowColor: "#000",
    shadowOpacity: 0.32,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingLeft: 12,
    paddingRight: 12,
    paddingVertical: 10,
    gap: 12,
    overflow: "hidden",
    elevation: 6,
  },
  cardPressed: {
    // Wash layered above the acrylic so the press darkens the glass instead
    // of replacing it.
    backgroundColor: withAlpha(colors.foreground, 0.06),
  },
  accentBar: {
    width: 3,
    borderRadius: 1.5,
    backgroundColor: colors.primary,
    alignSelf: "stretch",
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.foreground,
    fontFamily: font.semibold,
    fontSize: 14,
  },
  body: {
    color: colors.secondaryForeground,
    fontFamily: font.regular,
    fontSize: 13,
  },
});

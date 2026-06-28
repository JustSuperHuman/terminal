import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Dimensions, PanResponder, StyleSheet, Text, View } from "react-native";
import { colors, font, radius } from "../theme";

interface SwipeableRowProps {
  children: ReactNode;
  onDelete: () => void;
  enabled?: boolean;
  // Fired true the moment a horizontal swipe is claimed and false when it ends,
  // so the parent can lock its vertical scroll — the swipe and the scroll cancel
  // each other instead of fighting.
  onSwipeStateChange?: (active: boolean) => void;
}

const SCREEN_W = Dimensions.get("window").width;
const THRESHOLD = 96;

// Swipe a row left to delete it. Built on PanResponder + Animated so it needs no
// gesture-handler / reanimated native modules — works in Expo Go as-is.
export function SwipeableRow({ children, onDelete, enabled = true, onSwipeStateChange }: SwipeableRowProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const onDeleteRef = useRef(onDelete);
  const onSwipeStateChangeRef = useRef(onSwipeStateChange);
  useEffect(() => {
    onDeleteRef.current = onDelete;
    onSwipeStateChangeRef.current = onSwipeStateChange;
  }, [onDelete, onSwipeStateChange]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Claim clearly-horizontal drags only, so vertical scrolling and taps still
      // work; a diagonal/vertical drag stays with the ScrollView.
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
      onPanResponderGrant: () => {
        onSwipeStateChangeRef.current?.(true);
      },
      onPanResponderMove: (_event, gesture) => {
        translateX.setValue(Math.min(0, gesture.dx));
      },
      // Once we own a horizontal swipe, don't surrender it back to the
      // ScrollView — that hand-off is what made the row spring back as the
      // container scrolled.
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_event, gesture) => {
        onSwipeStateChangeRef.current?.(false);
        if (gesture.dx < -THRESHOLD || gesture.vx < -0.6) {
          Animated.timing(translateX, {
            toValue: -SCREEN_W,
            duration: 180,
            useNativeDriver: true,
          }).start(() => onDeleteRef.current?.());
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        }
      },
      onPanResponderTerminate: () => {
        onSwipeStateChangeRef.current?.(false);
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
    })
  ).current;

  if (!enabled) {
    return <View>{children}</View>;
  }

  const deleteOpacity = translateX.interpolate({
    inputRange: [-THRESHOLD, -24, 0],
    outputRange: [1, 0.35, 0],
    extrapolate: "clamp",
  });

  return (
    <View style={styles.wrap}>
      <Animated.View style={[styles.deleteLayer, { opacity: deleteOpacity }]} pointerEvents="none">
        <Text style={styles.deleteText}>Delete</Text>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.md,
    overflow: "hidden",
  },
  deleteLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.destructive,
    alignItems: "flex-end",
    justifyContent: "center",
    paddingRight: 22,
  },
  deleteText: {
    color: colors.destructiveForeground,
    fontFamily: font.bold,
    fontSize: 13.5,
    letterSpacing: 0.3,
  },
});

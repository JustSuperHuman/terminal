import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, font, radius } from "../theme";

interface BottomSheetProps {
  visible: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
}

// Lightweight slide-up sheet. Renders nothing when closed and an absolute-fill
// layer when open, so it can be dropped inside an existing Modal (e.g. the
// sessions drawer) without nesting native modals.
export function BottomSheet({ visible, title, onClose, children }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const [sheetH, setSheetH] = useState(360);
  const progress = useRef(new Animated.Value(0)).current; // 0 hidden, 1 shown

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        damping: 24,
        stiffness: 240,
        mass: 0.8,
      }).start();
    } else if (mounted) {
      Animated.timing(progress, {
        toValue: 0,
        duration: 170,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setMounted(false);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) {
    return null;
  }

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [sheetH + insets.bottom, 0] });

  return (
    <View style={[StyleSheet.absoluteFill, styles.overlay]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        onLayout={(event) => setSheetH(event.nativeEvent.layout.height)}
        style={[styles.sheet, { paddingBottom: insets.bottom + 18, transform: [{ translateY }] }]}
      >
        <View style={styles.grabber} />
        {title ? (
          <View style={styles.head}>
            <Text style={styles.title}>{title}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            >
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>
        ) : null}
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    // Bottom sheets may be mounted beside the terminal WebView rather than
    // inside a native Modal. Keep the whole interaction layer above that
    // surface on both iOS and Android/Fabric.
    zIndex: 100,
    elevation: 100,
  },
  scrim: {
    backgroundColor: colors.overlay,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderColor: colors.border,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 14,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: {
    color: colors.foreground,
    fontSize: 15,
    fontFamily: font.semibold,
  },
  close: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  closePressed: {
    backgroundColor: colors.surfaceHi,
  },
  closeGlyph: {
    color: colors.mutedForeground,
    fontSize: 15,
  },
});

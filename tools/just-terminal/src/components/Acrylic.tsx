import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { glass } from "../theme";

// Acrylic backing for small floating chrome (menu button, toast, status
// pills, swipe bar): a real BlurView under the shared glass tint on iOS —
// WinUI's tint-over-blur acrylic — and the near-solid tint alone on Android,
// where blurring arbitrary views needs a blurTarget ref that only the
// command bar and composer have. Render it as the first child of a rounded,
// overflow-hidden container in place of a glass.tint backgroundColor.
export function Acrylic({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      {Platform.OS === "ios" ? (
        <BlurView intensity={60} tint="systemChromeMaterialDark" style={StyleSheet.absoluteFill} />
      ) : null}
      <View style={[StyleSheet.absoluteFill, styles.tint]} />
    </View>
  );
}

const styles = StyleSheet.create({
  tint: { backgroundColor: glass.tint },
});

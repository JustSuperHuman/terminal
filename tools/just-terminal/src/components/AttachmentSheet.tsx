import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, font, radius, withAlpha } from "../theme";
import { BottomSheet } from "./BottomSheet";
import { ClipboardIcon, ImageIcon } from "./icons";

interface AttachmentSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (source: "clipboard" | "library") => void;
}

export function AttachmentSheet({ visible, onClose, onSelect }: AttachmentSheetProps) {
  return (
    <BottomSheet visible={visible} title="Attach image" onClose={onClose}>
      <Text style={styles.hint}>Paste a copied image or choose one from your photo library.</Text>
      <Pressable
        onPress={() => onSelect("clipboard")}
        accessibilityRole="button"
        accessibilityLabel="Paste image from clipboard"
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.icon}>
          <ClipboardIcon size={20} color={colors.primary} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.label}>Paste from clipboard</Text>
          <Text style={styles.description}>Use the image you most recently copied</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      <Pressable
        onPress={() => onSelect("library")}
        accessibilityRole="button"
        accessibilityLabel="Choose image from photo library"
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.icon}>
          <ImageIcon size={20} color={colors.primary} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.label}>Choose from photos</Text>
          <Text style={styles.description}>Select a screenshot or photo on this device</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  hint: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.regular,
    lineHeight: 18,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  row: {
    minHeight: 66,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: radius.lg,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  rowPressed: {
    backgroundColor: colors.selection,
  },
  // Both sources are the same "attach an image" action, so their icon tiles
  // share one accent wash rather than inventing a hue per row.
  icon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: withAlpha(colors.primary, 0.12),
    borderColor: withAlpha(colors.primary, 0.32),
  },
  copy: {
    flex: 1,
  },
  label: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  description: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.regular,
    marginTop: 3,
  },
  chevron: {
    color: colors.mutedForeground,
    fontSize: 24,
    fontFamily: font.regular,
    marginRight: 3,
  },
});

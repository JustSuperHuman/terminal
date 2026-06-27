import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SocketStatus } from "../lib/socket";
import { colors, font, radius } from "../theme";
import { PlugIcon } from "./icons";

interface HeaderProps {
  title: string;
  meta: string;
  socketStatus: SocketStatus;
  canKill: boolean;
  onMenu: () => void;
  onFocus: () => void;
  onNew: () => void;
  onKill: () => void;
}

function statusInfo(status: SocketStatus): { label: string; color: string; detail: string } {
  if (status === "open")
    return { label: "Connected", color: colors.success, detail: "Live link to the host. Keystrokes and output stream in real time." };
  if (status === "connecting")
    return { label: "Connecting", color: colors.primary, detail: "Opening the link to the host…" };
  if (status === "closed")
    return { label: "Offline", color: colors.destructive, detail: "The link dropped. Reconnecting automatically — your sessions stay alive on the host." };
  return { label: "Idle", color: colors.mutedForeground, detail: "Not connected to a host yet." };
}

export function Header({ title, meta, socketStatus, canKill, onMenu, onFocus, onNew, onKill }: HeaderProps) {
  const status = statusInfo(socketStatus);
  const insets = useSafeAreaInsets();
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <View style={styles.container}>
      <Pressable onPress={onMenu} hitSlop={8} style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}>
        <View style={styles.menuLine} />
        <View style={[styles.menuLine, styles.menuLineMid]} />
        <View style={styles.menuLine} />
      </Pressable>

      <View style={styles.titleWrap}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>

      <Pressable
        onPress={() => setInfoOpen(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Connection: ${status.label}. Tap for details.`}
        style={({ pressed }) => [styles.statusPlug, pressed && styles.chipPressed]}
      >
        <PlugIcon size={18} color={status.color} />
      </Pressable>

      <Modal visible={infoOpen} transparent animationType="fade" onRequestClose={() => setInfoOpen(false)} statusBarTranslucent>
        <Pressable style={styles.infoBackdrop} onPress={() => setInfoOpen(false)} />
        <View style={[styles.infoCard, { top: insets.top + 50 }]}>
          <View style={styles.infoHead}>
            <PlugIcon size={20} color={status.color} />
            <Text style={[styles.infoTitle, { color: status.color }]}>{status.label}</Text>
          </View>
          <Text style={styles.infoDetail}>{status.detail}</Text>
        </View>
      </Modal>

      <View style={styles.actions}>
        <Pressable onPress={onFocus} hitSlop={6} style={({ pressed }) => [styles.iconChip, pressed && styles.chipPressed]}>
          <Text style={styles.iconGlyph}>⌨</Text>
        </Pressable>
        <Pressable onPress={onNew} hitSlop={6} style={({ pressed }) => [styles.iconChip, pressed && styles.chipPressed]}>
          <Text style={styles.iconPlus}>+</Text>
        </Pressable>
        <Pressable
          onPress={onKill}
          hitSlop={6}
          disabled={!canKill}
          style={({ pressed }) => [styles.iconChip, pressed && styles.chipPressed, !canKill && styles.disabled]}
        >
          <View style={styles.killSquare} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  chip: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3.5,
  },
  chipPressed: {
    backgroundColor: colors.surfaceHi,
  },
  menuLine: {
    width: 15,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.foreground,
  },
  menuLineMid: {
    width: 11,
    backgroundColor: colors.primary,
  },
  titleWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.foreground,
    fontSize: 14.5,
    fontFamily: font.bold,
  },
  meta: {
    color: colors.mutedForeground,
    fontSize: 10.5,
    fontFamily: font.mono,
    marginTop: 1,
  },
  statusPlug: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  infoBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  infoCard: {
    position: "absolute",
    right: 10,
    maxWidth: 290,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 7,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  infoHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  infoTitle: {
    fontSize: 14,
    fontFamily: font.bold,
  },
  infoDetail: {
    color: colors.sidebarForeground,
    fontSize: 12.5,
    fontFamily: font.regular,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  iconChip: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: {
    color: colors.secondaryForeground,
    fontSize: 17,
  },
  iconPlus: {
    color: colors.secondaryForeground,
    fontSize: 23,
    fontFamily: font.regular,
    marginTop: -2,
  },
  killSquare: {
    width: 13,
    height: 13,
    borderRadius: 3,
    backgroundColor: colors.destructive,
  },
  disabled: {
    opacity: 0.32,
  },
});

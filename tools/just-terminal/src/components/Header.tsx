import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SocketStatus } from "../lib/socket";
import { colors, font, radius } from "../theme";

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

function statusInfo(status: SocketStatus): { label: string; color: string } {
  if (status === "open") return { label: "Connected", color: colors.success };
  if (status === "connecting") return { label: "Connecting", color: colors.primary };
  if (status === "closed") return { label: "Offline", color: colors.destructive };
  return { label: "Idle", color: colors.mutedForeground };
}

export function Header({ title, meta, socketStatus, canKill, onMenu, onFocus, onNew, onKill }: HeaderProps) {
  const status = statusInfo(socketStatus);
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

      <View style={styles.statusPill}>
        <View style={[styles.statusDot, { backgroundColor: status.color }]} />
        <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
      </View>

      <View style={styles.actions}>
        <Pressable onPress={onFocus} hitSlop={6} style={({ pressed }) => [styles.iconChip, pressed && styles.chipPressed]}>
          <Text style={styles.iconGlyph}>⌨</Text>
        </Pressable>
        <Pressable onPress={onNew} hitSlop={6} style={({ pressed }) => [styles.iconChip, pressed && styles.chipPressed]}>
          <Text style={styles.iconGlyphGold}>+</Text>
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
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 10.5,
    fontFamily: font.bold,
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
  iconGlyphGold: {
    color: colors.primary,
    fontSize: 22,
    fontFamily: font.semibold,
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

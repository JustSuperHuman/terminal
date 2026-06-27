import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { TerminalProfile, TerminalSessionSummary } from "../types";
import { colors, font, radius } from "../theme";
import { BottomSheet } from "./BottomSheet";
import { JustGainsMark, agentGlyph } from "./icons";

export interface CreateSpec {
  profileId?: string;
  shell?: string;
  args?: string[];
  title?: string;
}

interface SessionsDrawerProps {
  visible: boolean;
  sessions: TerminalSessionSummary[];
  profiles: TerminalProfile[];
  activeId?: string;
  unread: Record<string, number>;
  serverHost?: string;
  activeCwd?: string;
  recentCwds: string[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: (spec?: CreateSpec) => void;
  onKill: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDisconnect: () => void;
  onSetCwd: (cwd?: string) => void;
  onForgetCwd: (cwd: string) => void;
}

const quickLaunches: Array<{ profileId: string; label: string; flag: string; args: string[] }> = [
  { profileId: "codex", label: "Codex", flag: "--yolo", args: ["--yolo"] },
  { profileId: "claude", label: "Claude", flag: "--dangerously-skip-permissions", args: ["--dangerously-skip-permissions"] },
];

function shellName(session: TerminalSessionSummary) {
  return session.shell.split(/[\\/]/).pop() ?? session.shell;
}

function timeLabel(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
  } catch {
    return "";
  }
}

function shortPath(path: string, max = 26): string {
  if (path.length <= max) {
    return path;
  }
  return `…${path.slice(path.length - (max - 1))}`;
}

const profileGroups: Array<{ id: TerminalProfile["group"]; label: string }> = [
  { id: "agent", label: "Agents" },
  { id: "shell", label: "Shells" },
  { id: "custom", label: "Custom" },
];

export function SessionsDrawer({
  visible,
  sessions,
  profiles,
  activeId,
  unread,
  serverHost,
  activeCwd,
  recentCwds,
  onClose,
  onSelect,
  onCreate,
  onKill,
  onRename,
  onDisconnect,
  onSetCwd,
  onForgetCwd,
}: SessionsDrawerProps) {
  const [editingId, setEditingId] = useState<string | undefined>();
  const [editingTitle, setEditingTitle] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwdSheetOpen, setCwdSheetOpen] = useState(false);

  useEffect(() => {
    if (!visible) {
      setEditingId(undefined);
      setEditingTitle("");
      setCwdDraft("");
      setCwdSheetOpen(false);
    }
  }, [visible]);

  const sections = useMemo(
    () =>
      profileGroups
        .map((group) => ({
          ...group,
          profiles: profiles.filter((profile) => (profile.group ?? "shell") === group.id),
        }))
        .filter((group) => group.profiles.length > 0),
    [profiles]
  );

  const availableQuickLaunches = useMemo(
    () =>
      quickLaunches
        .map((entry) => {
          const profile = profiles.find((candidate) => candidate.id === entry.profileId);
          return profile ? { ...entry, shell: profile.shell } : undefined;
        })
        .filter((entry): entry is (typeof quickLaunches)[number] & { shell: string } => Boolean(entry)),
    [profiles]
  );

  function commitRename(id: string) {
    if (editingTitle.trim()) {
      onRename(id, editingTitle.trim());
    }
    setEditingId(undefined);
    setEditingTitle("");
  }

  function chooseCwd(cwd?: string) {
    onSetCwd(cwd);
    setCwdSheetOpen(false);
  }

  function applyCwdDraft() {
    const value = cwdDraft.trim();
    if (value) {
      onSetCwd(value);
      setCwdDraft("");
      setCwdSheetOpen(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={styles.panel}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <JustGainsMark size={22} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.brandTitle}>JustTerminal</Text>
              <Text style={styles.brandSub} numberOfLines={1}>
                {serverHost ?? "Not connected"}
              </Text>
            </View>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}>
            <Text style={styles.iconGlyph}>✕</Text>
          </Pressable>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Sessions</Text>
            <Pressable onPress={() => onCreate()} hitSlop={8} style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}>
              <Text style={styles.newBtnText}>+ New</Text>
            </Pressable>
          </View>

          {sessions.length === 0 ? (
            <Text style={styles.empty}>No sessions yet</Text>
          ) : (
            sessions.map((session) => {
              const selected = session.id === activeId;
              const unreadCount = unread[session.id] ?? 0;
              const editing = editingId === session.id;
              return (
                <View key={session.id} style={[styles.sessionRow, selected && styles.sessionRowActive]}>
                  {selected ? <View style={styles.activeBar} /> : null}
                  {editing ? (
                    <View style={styles.editRow}>
                      <TextInput
                        value={editingTitle}
                        onChangeText={setEditingTitle}
                        autoFocus
                        style={styles.editInput}
                        placeholderTextColor={colors.faint}
                        onSubmitEditing={() => commitRename(session.id)}
                      />
                      <Pressable onPress={() => commitRename(session.id)} hitSlop={8} style={styles.iconBtn}>
                        <Text style={styles.iconGlyphPrimary}>✓</Text>
                      </Pressable>
                      <Pressable onPress={() => setEditingId(undefined)} hitSlop={8} style={styles.iconBtn}>
                        <Text style={styles.iconGlyph}>✕</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <>
                      <Pressable style={styles.sessionMain} onPress={() => onSelect(session.id)}>
                        <View
                          style={[
                            styles.statusDot,
                            { backgroundColor: session.status === "running" ? colors.success : colors.faint },
                          ]}
                        />
                        <View style={{ flex: 1 }}>
                          <View style={styles.titleLine}>
                            <Text style={[styles.sessionTitle, selected && styles.sessionTitleActive]} numberOfLines={1}>
                              {session.title}
                            </Text>
                            {unreadCount > 0 ? (
                              <View style={styles.badge}>
                                <Text style={styles.badgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
                              </View>
                            ) : null}
                          </View>
                          <Text style={styles.sessionSub} numberOfLines={1}>
                            {session.source === "bridged" ? "bridge · " : ""}
                            {shellName(session)} · {timeLabel(session.updatedAt)}
                          </Text>
                        </View>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setEditingId(session.id);
                          setEditingTitle(session.title);
                        }}
                        hitSlop={8}
                        style={styles.iconBtn}
                      >
                        <Text style={styles.iconGlyph}>✎</Text>
                      </Pressable>
                      {session.status === "running" ? (
                        <Pressable onPress={() => onKill(session.id)} hitSlop={8} style={styles.iconBtn}>
                          <View style={styles.killSquare} />
                        </Pressable>
                      ) : null}
                    </>
                  )}
                </View>
              );
            })
          )}

          {/* Working-directory chooser opens in a bottom sheet */}
          <View style={styles.cwdLauncherWrap}>
            <Text style={styles.sectionTitle}>Working directory</Text>
            <Pressable
              onPress={() => setCwdSheetOpen(true)}
              style={({ pressed }) => [styles.cwdLauncher, pressed && styles.cwdLauncherPressed]}
            >
              <Text style={styles.cwdFolder}>▸</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.cwdLauncherLabel}>New session in</Text>
                <Text style={styles.cwdLauncherValue} numberOfLines={1} ellipsizeMode="head">
                  {activeCwd ?? "Host default"}
                </Text>
              </View>
              <Text style={styles.cwdLauncherChevron}>⌄</Text>
            </Pressable>
          </View>

          {availableQuickLaunches.length > 0 ? (
            <View style={styles.launchSection}>
              <Text style={styles.sectionTitle}>Quick launch</Text>
              {availableQuickLaunches.map((entry) => (
                <Pressable
                  key={entry.profileId}
                  style={({ pressed }) => [styles.launchRow, pressed && styles.launchRowPressed]}
                  onPress={() => onCreate({ shell: entry.shell, args: entry.args, title: entry.label })}
                >
                  <View style={styles.launchIcon}>{agentGlyph(entry.profileId, 18)}</View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.launchLabel} numberOfLines={1}>
                      {entry.label}
                    </Text>
                    <Text style={styles.launchDesc} numberOfLines={1}>
                      {entry.flag}
                    </Text>
                  </View>
                  <Text style={styles.launchPlus}>+</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {sections.map((section) => (
            <View key={section.id} style={styles.launchSection}>
              <Text style={styles.sectionTitle}>{section.label}</Text>
              {section.profiles.map((profile) => {
                const glyph = section.id === "agent" ? agentGlyph(profile.id, 18) : null;
                return (
                  <Pressable
                    key={profile.id}
                    style={({ pressed }) => [styles.launchRow, pressed && styles.launchRowPressed]}
                    onPress={() => onCreate({ profileId: profile.id })}
                  >
                    {glyph ? <View style={styles.launchIcon}>{glyph}</View> : null}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.launchLabel} numberOfLines={1}>
                        {profile.label}
                      </Text>
                      {profile.description ? (
                        <Text style={styles.launchDesc} numberOfLines={1}>
                          {profile.description}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.launchPlus}>+</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable onPress={onDisconnect} style={({ pressed }) => [styles.disconnect, pressed && styles.disconnectPressed]}>
            <Text style={styles.disconnectText}>Disconnect</Text>
          </Pressable>
        </View>
      </View>

      <BottomSheet visible={cwdSheetOpen} title="New session in" onClose={() => setCwdSheetOpen(false)}>
        <Text style={styles.sheetHint}>Choose where new terminals start on {serverHost ?? "this host"}.</Text>

        <View style={styles.cwdInputRow}>
          <Text style={styles.cwdFolder}>▸</Text>
          <TextInput
            value={cwdDraft}
            onChangeText={setCwdDraft}
            placeholder="Set a directory path…"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.cwdInput}
            onSubmitEditing={applyCwdDraft}
            returnKeyType="done"
          />
          <Pressable
            onPress={applyCwdDraft}
            disabled={!cwdDraft.trim()}
            style={({ pressed }) => [styles.cwdUse, !cwdDraft.trim() && styles.faded, pressed && styles.cwdUsePressed]}
          >
            <Text style={styles.cwdUseText}>Use</Text>
          </Pressable>
        </View>

        <View style={styles.chipWrap}>
          <Pressable onPress={() => chooseCwd(undefined)} style={[styles.chip, !activeCwd && styles.chipActive]}>
            <Text style={[styles.chipText, !activeCwd && styles.chipTextActive]}>Host default</Text>
          </Pressable>
          {recentCwds.map((cwd) => {
            const active = cwd === activeCwd;
            return (
              <View key={cwd} style={[styles.chip, active && styles.chipActive]}>
                <Pressable onPress={() => chooseCwd(cwd)} hitSlop={6}>
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{shortPath(cwd)}</Text>
                </Pressable>
                <Pressable onPress={() => onForgetCwd(cwd)} hitSlop={8} style={styles.chipForget}>
                  <Text style={styles.chipForgetText}>✕</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      </BottomSheet>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay,
  },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "86%",
    maxWidth: 380,
    backgroundColor: colors.sidebar,
    borderRightColor: colors.border,
    borderRightWidth: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 14,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  brandRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  brandMark: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  brandTitle: {
    color: colors.foreground,
    fontSize: 16,
    fontFamily: font.extrabold,
  },
  brandSub: {
    color: colors.mutedForeground,
    fontSize: 11.5,
    fontFamily: font.mono,
    marginTop: 1,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    gap: 4,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
    paddingBottom: 6,
  },
  sectionTitle: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.bold,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  newBtn: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  newBtnPressed: {
    backgroundColor: colors.surfaceHi,
  },
  newBtnText: {
    color: colors.primary,
    fontSize: 12,
    fontFamily: font.bold,
  },
  empty: {
    color: colors.mutedForeground,
    fontSize: 13,
    fontFamily: font.regular,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minHeight: 54,
    overflow: "hidden",
  },
  sessionRowActive: {
    backgroundColor: colors.sidebarActive,
  },
  activeBar: {
    position: "absolute",
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  sessionMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 7,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sessionTitle: {
    flexShrink: 1,
    color: colors.sidebarForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  sessionTitleActive: {
    color: colors.foreground,
  },
  sessionSub: {
    color: colors.mutedForeground,
    fontSize: 11.5,
    marginTop: 2,
    fontFamily: font.mono,
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
  editRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  editInput: {
    flex: 1,
    backgroundColor: colors.input,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.foreground,
    fontFamily: font.medium,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnPressed: {
    backgroundColor: colors.surfaceHi,
  },
  iconGlyph: {
    color: colors.mutedForeground,
    fontSize: 15,
  },
  iconGlyphPrimary: {
    color: colors.success,
    fontSize: 17,
    fontFamily: font.bold,
  },
  killSquare: {
    width: 13,
    height: 13,
    borderRadius: 3,
    backgroundColor: colors.destructive,
  },
  // working-directory launcher
  cwdLauncherWrap: {
    marginTop: 16,
    gap: 6,
    paddingHorizontal: 6,
  },
  cwdLauncher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  cwdLauncherPressed: {
    backgroundColor: colors.surfaceHi,
  },
  cwdLauncherLabel: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.bold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  cwdLauncherValue: {
    color: colors.foreground,
    fontSize: 13.5,
    fontFamily: font.mono,
    marginTop: 2,
  },
  cwdLauncherChevron: {
    color: colors.mutedForeground,
    fontSize: 16,
    fontFamily: font.bold,
  },
  // bottom-sheet content
  sheetHint: {
    color: colors.mutedForeground,
    fontSize: 12.5,
    fontFamily: font.regular,
    lineHeight: 18,
    marginBottom: 14,
  },
  cwdFolder: {
    color: colors.primary,
    fontSize: 14,
    fontFamily: font.bold,
  },
  cwdInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  cwdInput: {
    flex: 1,
    backgroundColor: colors.input,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.foreground,
    fontFamily: font.mono,
    fontSize: 13,
    paddingHorizontal: 11,
    paddingVertical: 11,
  },
  cwdUse: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  cwdUsePressed: {
    backgroundColor: colors.primaryDim,
  },
  cwdUseText: {
    color: colors.primaryForeground,
    fontFamily: font.bold,
    fontSize: 13,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingLeft: 12,
    paddingRight: 9,
    paddingVertical: 7,
  },
  chipActive: {
    backgroundColor: colors.surfaceHi,
    borderColor: colors.primary,
  },
  chipText: {
    color: colors.sidebarForeground,
    fontSize: 12,
    fontFamily: font.mono,
  },
  chipTextActive: {
    color: colors.primary,
  },
  chipForget: {
    paddingHorizontal: 2,
  },
  chipForgetText: {
    color: colors.mutedForeground,
    fontSize: 11,
  },
  // launch sections
  launchSection: {
    marginTop: 16,
    gap: 4,
  },
  launchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  launchRowPressed: {
    backgroundColor: colors.sidebarActive,
  },
  launchIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  launchLabel: {
    color: colors.sidebarForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  launchDesc: {
    color: colors.mutedForeground,
    fontSize: 11.5,
    fontFamily: font.mono,
    marginTop: 1,
  },
  launchPlus: {
    color: colors.mutedForeground,
    fontSize: 18,
    fontFamily: font.semibold,
  },
  footer: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    paddingBottom: 28,
  },
  disconnect: {
    alignItems: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingVertical: 12,
  },
  disconnectPressed: {
    backgroundColor: colors.surfaceHi,
  },
  disconnectText: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.bold,
  },
  faded: {
    opacity: 0.4,
  },
});

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TerminalProfile, TerminalSessionSummary } from "../types";
import { resolveQuickLaunches } from "../lib/launchers";
import { loadSortRecent, saveSortRecent } from "../lib/storage";
import { colors, font, radius } from "../theme";
import { BottomSheet } from "./BottomSheet";
import { SwipeableRow } from "./SwipeableRow";
import { agentGlyph } from "./icons";

export interface CreateSpec {
  profileId?: string;
  shell?: string;
  args?: string[];
  title?: string;
}

interface SessionsScreenProps {
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

/** Last path segment of a cwd — the "project" name a directory reads as. */
function folderName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed || cwd;
}

// Search matching mirrors the desktop sidebar: a session matches when the
// query appears in any of its identifying fields, not just the title.
function searchable(value?: string | number | string[]): string {
  if (Array.isArray(value)) {
    return value.join(" ").toLowerCase();
  }
  return String(value ?? "").toLowerCase();
}

function sessionMatches(session: TerminalSessionSummary, query: string): boolean {
  return [session.title, session.shell, session.args, session.cwd, session.source, session.status, session.pid].some(
    (value) => searchable(value).includes(query)
  );
}

function profileMatches(profile: TerminalProfile, query: string): boolean {
  return [profile.label, profile.shell, profile.args, profile.group, profile.description].some((value) =>
    searchable(value).includes(query)
  );
}

// Agents are surfaced through Quick launch; the launcher lists shells/custom only.
const profileGroups: Array<{ id: TerminalProfile["group"]; label: string }> = [
  { id: "shell", label: "Shells" },
  { id: "custom", label: "Custom" },
];

interface SessionGroup {
  key: string;
  label: string;
  sublabel?: string;
  sessions: TerminalSessionSummary[];
}

export function SessionsScreen({
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
}: SessionsScreenProps) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | undefined>();
  const [editingTitle, setEditingTitle] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwdSheetOpen, setCwdSheetOpen] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  // While a session row is being swiped to delete, lock the list's vertical
  // scroll so the two gestures don't fight.
  const [rowSwiping, setRowSwiping] = useState(false);
  // Recency sort: flat list ordered by last update, most recent at the BOTTOM
  // (closest to the thumb). Off = grouping by working directory. Persisted.
  const [sortRecent, setSortRecent] = useState(false);

  // Fast X-style push: slide + fade, ~160ms, native driver. The screen mounts
  // on first open and then STAYS mounted (hidden via opacity/pointerEvents) so
  // the list's scroll position survives close/open — reopening after picking a
  // session lands exactly where you left off.
  const slide = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(visible);

  useEffect(() => {
    if (visible) {
      setShown(true);
    }
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: visible ? 160 : 130,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  useEffect(() => {
    loadSortRecent().then(setSortRecent);
  }, []);

  // Android hardware back closes the screen, like the header back button.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  useEffect(() => {
    if (!visible) {
      setEditingId(undefined);
      setEditingTitle("");
      setCwdDraft("");
      setCwdSheetOpen(false);
      setQuery("");
    }
  }, [visible]);

  function toggleSortRecent() {
    setSortRecent((current) => {
      const next = !current;
      saveSortRecent(next);
      return next;
    });
  }

  const normalizedQuery = query.trim().toLowerCase();

  const visibleSessions = useMemo(() => {
    const alive = sessions.filter((session) => !hiddenIds.includes(session.id));
    return normalizedQuery ? alive.filter((session) => sessionMatches(session, normalizedQuery)) : alive;
  }, [sessions, hiddenIds, normalizedQuery]);

  // Sessions are grouped by their current working directory: each distinct cwd
  // is a "project" heading (folder name + full path). Groups are ordered by
  // their most recent activity. With recency sort on, grouping collapses into
  // one flat list ordered oldest → newest (recent at the bottom).
  const sessionGroups = useMemo<SessionGroup[]>(() => {
    if (sortRecent) {
      const ordered = [...visibleSessions].sort(
        (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
      );
      return ordered.length > 0 ? [{ key: "__recent__", label: "", sessions: ordered }] : [];
    }
    const byCwd = new Map<string, TerminalSessionSummary[]>();
    for (const session of visibleSessions) {
      const key = session.cwd || "";
      const bucket = byCwd.get(key);
      if (bucket) {
        bucket.push(session);
      } else {
        byCwd.set(key, [session]);
      }
    }
    return [...byCwd.entries()]
      .map(([cwd, grouped]) => ({
        key: cwd || "__none__",
        label: cwd ? folderName(cwd) : "No directory",
        sublabel: cwd || undefined,
        sessions: grouped,
        latest: Math.max(...grouped.map((session) => new Date(session.updatedAt).getTime() || 0)),
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [visibleSessions, sortRecent]);

  function deleteSession(id: string) {
    setHiddenIds((current) => (current.includes(id) ? current : [...current, id]));
    onKill(id);
  }

  const launchSections = useMemo(
    () =>
      profileGroups
        .map((group) => ({
          ...group,
          profiles: profiles.filter(
            (profile) =>
              (profile.group ?? "shell") === group.id && (!normalizedQuery || profileMatches(profile, normalizedQuery))
          ),
        }))
        .filter((group) => group.profiles.length > 0),
    [profiles, normalizedQuery]
  );

  const availableQuickLaunches = useMemo(() => {
    const entries = resolveQuickLaunches(profiles);
    if (!normalizedQuery) {
      return entries;
    }
    return entries.filter((entry) =>
      [entry.label, entry.shell, entry.args].some((value) => searchable(value).includes(normalizedQuery))
    );
  }, [profiles, normalizedQuery]);

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

  if (!shown) {
    return null;
  }

  const runningCount = sessions.filter((session) => session.status === "running").length;

  return (
    <Animated.View
      style={[
        styles.screen,
        {
          opacity: slide,
          transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-28, 0] }) }],
        },
      ]}
      pointerEvents={visible ? "auto" : "none"}
    >
      {/* X-style screen header: back chevron, bold title + live meta, actions. */}
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back to terminal"
          style={({ pressed }) => [styles.iconCircle, pressed && styles.iconCirclePressed]}
        >
          <Text style={styles.backGlyph}>←</Text>
        </Pressable>
        <View style={styles.headerTitles}>
          <Text style={styles.headerTitle}>Sessions</Text>
          <Text style={styles.headerMeta} numberOfLines={1}>
            {runningCount} running{serverHost ? ` · ${serverHost}` : ""}
          </Text>
        </View>
        <Pressable
          onPress={toggleSortRecent}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={
            sortRecent ? "Group sessions by directory" : "Sort sessions by last update, recent at the bottom"
          }
          style={({ pressed }) => [
            styles.iconCircle,
            sortRecent && styles.iconCircleActive,
            pressed && styles.iconCirclePressed,
          ]}
        >
          <Text style={[styles.sortGlyph, sortRecent && styles.sortGlyphActive]}>⇅</Text>
        </Pressable>
      </View>

      {/* Pill search, like the desktop sidebar filter: matches title, shell,
          args, cwd, source, status and pid. */}
      <View style={styles.searchWrap}>
        <View style={styles.searchPill}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search sessions"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.searchInput}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={10} accessibilityLabel="Clear search">
              <Text style={styles.searchClear}>✕</Text>
            </Pressable>
          ) : null}
        </View>
        {normalizedQuery ? (
          <Text style={styles.searchCount}>
            {visibleSessions.length} match{visibleSessions.length === 1 ? "" : "es"}
          </Text>
        ) : null}
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 120 }]}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!rowSwiping}
      >
        {visibleSessions.length === 0 ? (
          <Text style={styles.empty}>{normalizedQuery ? "No matching sessions" : "No sessions yet"}</Text>
        ) : (
          sessionGroups.map((group) => (
            <View key={group.key} style={styles.projectGroup}>
              {group.label ? (
                <View style={styles.projectHeader}>
                  <Text style={styles.projectName} numberOfLines={1}>
                    {group.label}
                  </Text>
                  {group.sublabel ? (
                    <Text style={styles.projectPath} numberOfLines={1}>
                      {shortPath(group.sublabel, 34)}
                    </Text>
                  ) : null}
                  <Text style={styles.projectCount}>{group.sessions.length}</Text>
                </View>
              ) : null}
              {group.sessions.map((session) => {
                const selected = session.id === activeId;
                const unreadCount = unread[session.id] ?? 0;
                const editing = editingId === session.id;
                const running = session.status === "running";
                return (
                  <SwipeableRow
                    key={session.id}
                    enabled={!editing}
                    onDelete={() => deleteSession(session.id)}
                    onSwipeStateChange={setRowSwiping}
                  >
                    <View style={[styles.sessionRow, selected && styles.sessionRowActive]}>
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
                            {/* Avatar: shell initial in a circle, status dot on
                                the corner — the X row anatomy. */}
                            <View style={[styles.avatar, selected && styles.avatarActive]}>
                              <Text style={[styles.avatarText, selected && styles.avatarTextActive]}>
                                {(session.title || shellName(session)).slice(0, 1).toUpperCase()}
                              </Text>
                              <View
                                style={[
                                  styles.statusDot,
                                  { backgroundColor: running ? colors.success : colors.faint },
                                ]}
                              />
                            </View>
                            <View style={{ flex: 1 }}>
                              <View style={styles.titleLine}>
                                <Text
                                  style={[styles.sessionTitle, selected && styles.sessionTitleActive]}
                                  numberOfLines={1}
                                >
                                  {session.title}
                                </Text>
                                <Text style={styles.sessionTime}>{timeLabel(session.updatedAt)}</Text>
                              </View>
                              <View style={styles.subLine}>
                                <Text style={styles.sessionSub} numberOfLines={1}>
                                  {session.source === "bridged" ? "bridge · " : ""}
                                  {shellName(session)}
                                </Text>
                                {unreadCount > 0 ? (
                                  <View style={styles.badge}>
                                    <Text style={styles.badgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
                                  </View>
                                ) : null}
                              </View>
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
                        </>
                      )}
                    </View>
                  </SwipeableRow>
                );
              })}
            </View>
          ))
        )}

        {/* Working-directory chooser opens in a bottom sheet */}
        <Pressable
          onPress={() => setCwdSheetOpen(true)}
          style={({ pressed }) => [styles.cwdLauncher, pressed && styles.cwdLauncherPressed]}
        >
          <Text style={styles.cwdLauncherLabel}>New session in</Text>
          <Text style={styles.cwdLauncherValue} numberOfLines={1} ellipsizeMode="head">
            {activeCwd ?? "Host default"}
          </Text>
          <Text style={styles.cwdLauncherChevron}>⌄</Text>
        </Pressable>

        {availableQuickLaunches.length > 0 ? (
          <View style={styles.launchSection}>
            <Text style={styles.sectionTitle}>Quick launch</Text>
            {availableQuickLaunches.map((entry) => (
              <Pressable
                key={entry.profileId}
                style={({ pressed }) => [styles.launchRow, pressed && styles.launchRowPressed]}
                onPress={() => onCreate({ shell: entry.shell, args: entry.args, title: entry.label })}
              >
                <View style={styles.launchIcon}>{agentGlyph(entry.profileId, 24)}</View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.launchLabel} numberOfLines={1}>
                    {entry.label}
                  </Text>
                </View>
                <Text style={styles.launchPlus}>+</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {launchSections.map((section) => (
          <View key={section.id} style={styles.launchSection}>
            <Text style={styles.sectionTitle}>{section.label}</Text>
            {section.profiles.map((profile) => (
              <Pressable
                key={profile.id}
                style={({ pressed }) => [styles.launchRow, pressed && styles.launchRowPressed]}
                onPress={() => onCreate({ profileId: profile.id })}
              >
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
            ))}
          </View>
        ))}

        <Pressable
          onPress={onDisconnect}
          style={({ pressed }) => [styles.disconnect, pressed && styles.disconnectPressed]}
        >
          <Text style={styles.disconnectText}>Disconnect</Text>
        </Pressable>
      </ScrollView>

      {/* Compose-style FAB: new session in the chosen directory. */}
      <Pressable
        onPress={() => onCreate()}
        accessibilityRole="button"
        accessibilityLabel="New session"
        style={({ pressed }) => [
          styles.fab,
          { bottom: insets.bottom + 22 },
          pressed && styles.fabPressed,
        ]}
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      <BottomSheet visible={cwdSheetOpen} title="New session in" onClose={() => setCwdSheetOpen(false)}>
        <Text style={styles.sheetHint}>Choose where new terminals start on {serverHost ?? "this host"}.</Text>

        <View style={styles.cwdInputRow}>
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
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  headerTitles: {
    flex: 1,
  },
  headerTitle: {
    color: colors.foreground,
    fontSize: 20,
    fontFamily: font.extrabold,
    letterSpacing: 0.2,
  },
  headerMeta: {
    color: colors.mutedForeground,
    fontSize: 11.5,
    fontFamily: font.mono,
    marginTop: 1,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCirclePressed: {
    backgroundColor: colors.surfaceHi,
  },
  iconCircleActive: {
    backgroundColor: colors.surfaceAlt,
  },
  backGlyph: {
    color: colors.foreground,
    fontSize: 21,
    marginTop: -2,
  },
  sortGlyph: {
    color: colors.mutedForeground,
    fontSize: 16,
  },
  sortGlyphActive: {
    color: colors.primary,
  },
  searchWrap: {
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  searchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: 15,
  },
  searchIcon: {
    color: colors.faint,
    fontSize: 17,
    marginTop: -1,
  },
  searchInput: {
    flex: 1,
    color: colors.foreground,
    fontFamily: font.medium,
    fontSize: 14,
    paddingVertical: 10,
  },
  searchClear: {
    color: colors.mutedForeground,
    fontSize: 13,
    padding: 2,
  },
  searchCount: {
    color: colors.mutedForeground,
    fontSize: 11.5,
    fontFamily: font.semibold,
    marginTop: 7,
    marginLeft: 4,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: 10,
    paddingTop: 2,
    gap: 2,
  },
  projectGroup: {
    marginBottom: 6,
  },
  // cwd heading: folder name + shortened path + count, hairline above.
  projectHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 14,
    paddingBottom: 6,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  projectName: {
    color: colors.foreground,
    fontSize: 14.5,
    fontFamily: font.bold,
    flexShrink: 1,
  },
  projectPath: {
    flex: 1,
    color: colors.faint,
    fontSize: 10.5,
    fontFamily: font.mono,
  },
  projectCount: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.bold,
  },
  empty: {
    color: colors.mutedForeground,
    fontSize: 13.5,
    fontFamily: font.regular,
    paddingHorizontal: 10,
    paddingVertical: 18,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.lg,
    paddingHorizontal: 8,
    minHeight: 60,
    overflow: "hidden",
  },
  sessionRowActive: {
    backgroundColor: colors.sidebarActive,
  },
  sessionMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 9,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
  },
  avatarActive: {
    borderColor: colors.primary,
  },
  avatarText: {
    color: colors.sidebarForeground,
    fontSize: 16,
    fontFamily: font.bold,
  },
  avatarTextActive: {
    color: colors.primary,
  },
  statusDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.background,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sessionTitle: {
    flex: 1,
    color: colors.foreground,
    fontSize: 14.5,
    fontFamily: font.semibold,
  },
  sessionTitleActive: {
    fontFamily: font.bold,
  },
  sessionTime: {
    color: colors.faint,
    fontSize: 11,
    fontFamily: font.mono,
  },
  subLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  sessionSub: {
    flexShrink: 1,
    color: colors.mutedForeground,
    fontSize: 11.5,
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
  iconGlyph: {
    color: colors.mutedForeground,
    fontSize: 15,
  },
  iconGlyphPrimary: {
    color: colors.success,
    fontSize: 17,
    fontFamily: font.bold,
  },
  // working-directory launcher (compact single row)
  cwdLauncher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 18,
    marginHorizontal: 4,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  cwdLauncherPressed: {
    backgroundColor: colors.surfaceHi,
  },
  cwdLauncherLabel: {
    color: colors.mutedForeground,
    fontSize: 12.5,
    fontFamily: font.semibold,
  },
  cwdLauncherValue: {
    flex: 1,
    textAlign: "right",
    color: colors.foreground,
    fontSize: 12.5,
    fontFamily: font.mono,
  },
  cwdLauncherChevron: {
    color: colors.mutedForeground,
    fontSize: 14,
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
    marginTop: 18,
    gap: 2,
  },
  sectionTitle: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.bold,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  launchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  launchRowPressed: {
    backgroundColor: colors.sidebarActive,
  },
  launchIcon: {
    width: 32,
    height: 32,
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
  disconnect: {
    alignItems: "center",
    marginTop: 26,
    marginHorizontal: 4,
    borderRadius: radius.pill,
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
  fab: {
    position: "absolute",
    right: 18,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabPressed: {
    backgroundColor: colors.primaryDim,
  },
  fabText: {
    color: colors.primaryForeground,
    fontSize: 30,
    fontFamily: font.regular,
    marginTop: -2,
  },
  faded: {
    opacity: 0.4,
  },
});

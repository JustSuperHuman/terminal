import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AcpBridgeState } from "../acpTypes";
import type { TerminalProfile, TerminalSessionSummary } from "../types";
import { loadSortRecent, saveSortRecent } from "../lib/storage";
import { colors, font, radius, withAlpha } from "../theme";
import { BottomSheet } from "./BottomSheet";
import { SwipeableRow } from "./SwipeableRow";
import { ClaudeIcon, CodexIcon, launchGlyph } from "./icons";

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
  acpState?: AcpBridgeState;
  onClose: () => void;
  onOpenAgentWorkspace: () => void;
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

function agentName(session: TerminalSessionSummary): string | undefined {
  if (session.agent === "claude") return "Claude";
  if (session.agent === "codex") return "Codex";
  if (session.agent === "hermes") return "Hermes";
  return undefined;
}

/**
 * The row subtitle for an agent session: who is running and what they are
 * doing. The transport ("Terminal Assist" vs. ACP) is deliberately not named —
 * it is not a thing the person scanning this list has to think about.
 */
function sessionKind(session: TerminalSessionSummary): string | undefined {
  const name = agentName(session);
  if (!name) return undefined;
  if (session.status !== "running") return name;
  if (session.agentActivity === "awaiting") return `${name} · Needs you`;
  if (session.agentActivity === "working") return `${name} · Working`;
  return name;
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
  return [session.title, session.shell, session.args, session.cwd, session.agent, session.source, session.status, session.pid].some(
    (value) => searchable(value).includes(query)
  );
}

function profileMatches(profile: TerminalProfile, query: string): boolean {
  return [profile.label, profile.shell, profile.args, profile.group, profile.description].some((value) =>
    searchable(value).includes(query)
  );
}

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
  acpState,
  onClose,
  onOpenAgentWorkspace,
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
  // WinUI TextBox focus cue: the search box grows a 2px accent underline.
  const [searchFocused, setSearchFocused] = useState(false);
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
    if (visible) {
      // This screen covers the composer, which was holding the keyboard open.
      // Leaving it up would hide half the session list; tapping Search brings
      // it back when the user actually wants to type.
      Keyboard.dismiss();
      return;
    }
    setEditingId(undefined);
    setEditingTitle("");
    setCwdDraft("");
    setCwdSheetOpen(false);
    setQuery("");
  }, [visible]);

  function toggleSortRecent() {
    setSortRecent((current) => {
      const next = !current;
      saveSortRecent(next);
      return next;
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const showAgentLauncher = !normalizedQuery || "agent workspace claude codex acp".includes(normalizedQuery);
  const activeAgentSessions = acpState?.sessions.filter((session) => session.state !== "closed").length ?? 0;
  const pendingAgentRequests = acpState?.requests.length ?? 0;
  const readyAgents = acpState?.agents.filter((agent) => agent.state === "ready").length ?? 0;
  const agentWorkspaceSubtitle = pendingAgentRequests > 0
    ? `${pendingAgentRequests} request${pendingAgentRequests === 1 ? "" : "s"} need input`
    : activeAgentSessions > 0
      ? `${activeAgentSessions} agent session${activeAgentSessions === 1 ? "" : "s"}`
      : readyAgents > 0
        ? `${readyAgents} agent${readyAgents === 1 ? "" : "s"} ready`
        : "Claude and Codex · structured ACP sessions";

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

  const availableProfiles = useMemo(
    () => profiles.filter((profile) => !normalizedQuery || profileMatches(profile, normalizedQuery)),
    [profiles, normalizedQuery]
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

      {/* WinUI search box, like the desktop sidebar filter: matches title,
          shell, args, cwd, source, status and pid. */}
      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, searchFocused && styles.searchBoxFocused]}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search sessions"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={10} accessibilityLabel="Clear search">
              <Text style={styles.searchClear}>✕</Text>
            </Pressable>
          ) : null}
        </View>
        {normalizedQuery && visibleSessions.length > 0 ? (
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
        {showAgentLauncher ? (
          <Pressable
            onPress={onOpenAgentWorkspace}
            accessibilityRole="button"
            accessibilityLabel={`Open Agent workspace. ${agentWorkspaceSubtitle}`}
            style={({ pressed }) => [
              styles.agentWorkspaceRow,
              pendingAgentRequests > 0 && styles.agentWorkspaceAttention,
              pressed && styles.agentWorkspacePressed,
            ]}
          >
            <View style={styles.agentWorkspaceIcons} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={[styles.agentWorkspaceIcon, styles.agentWorkspaceIconBack]}><ClaudeIcon size={19} /></View>
              <View style={[styles.agentWorkspaceIcon, styles.agentWorkspaceIconFront]}><CodexIcon size={19} /></View>
            </View>
            <View style={styles.agentWorkspaceCopy}>
              <Text style={styles.agentWorkspaceTitle}>Agent workspace</Text>
              <Text
                style={[styles.agentWorkspaceSubtitle, pendingAgentRequests > 0 && styles.agentWorkspaceSubtitleAttention]}
                numberOfLines={1}
              >
                {agentWorkspaceSubtitle}
              </Text>
            </View>
            {pendingAgentRequests > 0 ? (
              <View style={styles.agentRequestBadge}>
                <Text style={styles.agentRequestBadgeText}>{pendingAgentRequests > 99 ? "99+" : pendingAgentRequests}</Text>
              </View>
            ) : null}
            <Text style={styles.agentWorkspaceChevron}>›</Text>
          </Pressable>
        ) : null}

        {visibleSessions.length === 0 ? (
          // Empty / search-miss state: glyph + title + a recovery hint, centred
          // like a WinUI InfoBar-less empty view.
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>{normalizedQuery ? "⌕" : ">_"}</Text>
            <Text style={styles.emptyTitle}>
              {normalizedQuery ? `No matches for “${query.trim()}”` : "No sessions yet"}
            </Text>
            <Text style={styles.emptyHint}>
              {normalizedQuery
                ? "Search covers titles, shells, paths and PIDs."
                : "Start one from a profile below, or tap +."}
            </Text>
          </View>
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
                const kind = sessionKind(session);
                return (
                  <SwipeableRow
                    key={session.id}
                    enabled={!editing}
                    onDelete={() => deleteSession(session.id)}
                    onSwipeStateChange={setRowSwiping}
                  >
                    <View style={[styles.sessionRow, selected && styles.sessionRowActive]}>
                      {/* WinUI selection indicator: the vertically-centered
                          accent pill on the row's left edge. */}
                      {selected && !editing ? <View style={styles.selectionPill} /> : null}
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
                          <Pressable
                            onPress={() => commitRename(session.id)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel="Save name"
                            style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                          >
                            <Text style={styles.iconGlyphPrimary}>✓</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => setEditingId(undefined)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel rename"
                            style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                          >
                            <Text style={styles.iconGlyph}>✕</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <>
                          <Pressable
                            style={styles.sessionMain}
                            onPress={() => onSelect(session.id)}
                            accessibilityRole="button"
                            accessibilityLabel={`${session.title}, ${running ? "running" : "exited"}${
                              unreadCount > 0 ? `, ${unreadCount} unread` : ""
                            }`}
                          >
                            {/* Avatar: shell initial in a circle, status dot on
                                the corner — the X row anatomy. */}
                            <View style={[styles.avatar, selected && styles.avatarActive]}>
                              {session.agent ? (
                                launchGlyph(session.agent, 22, selected ? colors.primary : colors.foreground)
                              ) : (
                                <Text style={[styles.avatarText, selected && styles.avatarTextActive]}>
                                  {(session.title || shellName(session)).slice(0, 1).toUpperCase()}
                                </Text>
                              )}
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
                                  style={[
                                    styles.sessionTitle,
                                    !running && styles.sessionTitleExited,
                                    selected && styles.sessionTitleActive,
                                  ]}
                                  numberOfLines={1}
                                >
                                  {session.title}
                                </Text>
                                <Text style={styles.sessionTime}>{timeLabel(session.updatedAt)}</Text>
                              </View>
                              <View style={styles.subLine}>
                                <Text
                                  style={[
                                    styles.sessionSub,
                                    session.agentActivity === "awaiting" && styles.sessionSubAttention,
                                  ]}
                                  numberOfLines={1}
                                >
                                  {kind ?? `${session.source === "bridged" ? "bridge · " : ""}${shellName(session)}`}
                                </Text>
                                {/* Exited is named, not just dot-coded — grey
                                    on grey isn't legible at row-scan speed. */}
                                {!running ? <Text style={styles.exitedTag}>exited</Text> : null}
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
                            accessibilityRole="button"
                            accessibilityLabel={`Rename ${session.title}`}
                            style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                          >
                            <Text style={styles.iconGlyphQuiet}>✎</Text>
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
          accessibilityRole="button"
          accessibilityLabel={`New sessions start in ${activeCwd ?? "host default"}. Change directory`}
          style={({ pressed }) => [styles.cwdLauncher, pressed && styles.cwdLauncherPressed]}
        >
          <Text style={styles.cwdLauncherLabel}>New session in</Text>
          <Text style={styles.cwdLauncherValue} numberOfLines={1} ellipsizeMode="head">
            {activeCwd ?? "Host default"}
          </Text>
          <Text style={styles.cwdLauncherChevron}>⌄</Text>
        </Pressable>

        {availableProfiles.length > 0 ? (
          <View style={styles.launchSection}>
            <Text style={styles.sectionTitle}>Terminal profiles</Text>
            {availableProfiles.map((profile) => (
              <Pressable
                key={profile.id}
                style={({ pressed }) => [styles.launchRow, pressed && styles.launchRowPressed]}
                onPress={() => onCreate({ profileId: profile.id })}
                accessibilityRole="button"
                accessibilityLabel={`New ${profile.label} session`}
              >
                <View style={styles.launchIcon}>{launchGlyph(profile.agent ?? profile.id, 24)}</View>
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
        ) : null}

        <Pressable
          onPress={onDisconnect}
          accessibilityRole="button"
          accessibilityLabel="Disconnect from host"
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
            accessibilityRole="button"
            accessibilityLabel="Use this directory"
            style={({ pressed }) => [styles.cwdUse, !cwdDraft.trim() && styles.faded, pressed && styles.cwdUsePressed]}
          >
            <Text style={styles.cwdUseText}>Use</Text>
          </Pressable>
        </View>

        <View style={styles.chipWrap}>
          <Pressable
            onPress={() => chooseCwd(undefined)}
            accessibilityRole="button"
            accessibilityLabel="Use host default directory"
            style={[styles.chip, !activeCwd && styles.chipActive]}
          >
            <Text style={[styles.chipText, !activeCwd && styles.chipTextActive]}>Host default</Text>
          </Pressable>
          {recentCwds.map((cwd) => {
            const active = cwd === activeCwd;
            return (
              <View key={cwd} style={[styles.chip, active && styles.chipActive]}>
                <Pressable
                  onPress={() => chooseCwd(cwd)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Start new sessions in ${cwd}`}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{shortPath(cwd)}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onForgetCwd(cwd)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Forget ${cwd}`}
                  style={styles.chipForget}
                >
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
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitles: {
    flex: 1,
  },
  // Fluent Subtitle: 20 semibold.
  headerTitle: {
    color: colors.foreground,
    fontSize: 20,
    fontFamily: font.semibold,
  },
  headerMeta: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.mono,
    marginTop: 1,
  },
  // WinUI subtle icon button: square 4px-radius hit target, faint fill on press.
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCirclePressed: {
    backgroundColor: withAlpha(colors.foreground, 0.06),
  },
  iconCircleActive: {
    backgroundColor: colors.selection,
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
    color: colors.accentCyan,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  // WinUI TextBox: ControlFill, 4px radius, hairline stroke; the focused
  // state thickens the bottom edge into the accent underline.
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.input,
    borderColor: colors.border,
    borderWidth: 1,
    borderBottomWidth: 2,
    borderBottomColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
  },
  searchBoxFocused: {
    borderBottomColor: colors.primary,
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
    fontSize: 12,
    fontFamily: font.semibold,
    marginTop: 8,
    marginLeft: 4,
  },
  body: {
    flex: 1,
  },
  // 8 + the row's own 8 = 16, so row content aligns with the search box edge.
  bodyContent: {
    paddingHorizontal: 8,
    paddingTop: 4,
    gap: 2,
  },
  agentWorkspaceRow: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 4,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  agentWorkspaceAttention: {
    borderColor: withAlpha(colors.accentAmber, 0.56),
    backgroundColor: withAlpha(colors.accentAmber, 0.07),
  },
  agentWorkspacePressed: {
    backgroundColor: colors.selection,
    borderColor: colors.borderStrong,
  },
  agentWorkspaceIcons: {
    width: 50,
    height: 42,
  },
  agentWorkspaceIcon: {
    position: "absolute",
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceAlt,
  },
  agentWorkspaceIconBack: {
    left: 0,
    top: 0,
  },
  agentWorkspaceIconFront: {
    right: 0,
    bottom: 0,
  },
  agentWorkspaceCopy: {
    flex: 1,
    gap: 3,
  },
  agentWorkspaceTitle: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  agentWorkspaceSubtitle: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.mono,
  },
  agentWorkspaceSubtitleAttention: {
    color: colors.accentAmber,
  },
  agentRequestBadge: {
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentAmber,
  },
  agentRequestBadgeText: {
    color: colors.background,
    fontSize: 10.5,
    fontFamily: font.semibold,
  },
  agentWorkspaceChevron: {
    color: colors.mutedForeground,
    fontSize: 22,
    marginTop: -2,
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
    paddingTop: 16,
    paddingBottom: 4,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Fluent Caption group header, sentence case — never all-caps.
  projectName: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.semibold,
    flexShrink: 1,
  },
  projectPath: {
    flex: 1,
    color: colors.faint,
    fontSize: 11,
    fontFamily: font.mono,
  },
  projectCount: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.semibold,
  },
  empty: {
    alignItems: "center",
    paddingHorizontal: 24,
    paddingVertical: 40,
    gap: 4,
  },
  emptyGlyph: {
    color: colors.faint,
    fontSize: 26,
    fontFamily: font.mono,
    marginBottom: 8,
  },
  emptyTitle: {
    color: colors.secondaryForeground,
    fontSize: 14,
    fontFamily: font.semibold,
    textAlign: "center",
  },
  emptyHint: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.regular,
    textAlign: "center",
  },
  // WinUI list item: 4px radius, no separators; selection is the quiet accent
  // wash plus the left-edge indicator pill.
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    minHeight: 60,
    overflow: "hidden",
  },
  sessionRowActive: {
    backgroundColor: colors.selection,
  },
  selectionPill: {
    position: "absolute",
    left: 0,
    top: "50%",
    marginTop: -8,
    width: 3,
    height: 16,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  sessionMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  // Rounded-square avatar, like a Windows Terminal tab icon plate.
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
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
    color: colors.secondaryForeground,
    fontSize: 16,
    fontFamily: font.semibold,
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
  // Fluent BodyStrong — the row's one scannable anchor.
  sessionTitle: {
    flex: 1,
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  // Exited rows recede so live work pops out of the scan.
  sessionTitleExited: {
    color: colors.mutedForeground,
  },
  sessionTitleActive: {
    color: colors.foreground,
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
    fontSize: 11,
    fontFamily: font.mono,
  },
  // A blocked agent is the one thing in this list worth interrupting for.
  sessionSubAttention: {
    color: colors.accentAmber,
  },
  // Named status for dead sessions — the corner dot alone is too quiet.
  exitedTag: {
    color: colors.faint,
    fontSize: 11,
    fontFamily: font.semibold,
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
    fontFamily: font.semibold,
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
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnPressed: {
    backgroundColor: withAlpha(colors.foreground, 0.06),
  },
  iconGlyph: {
    color: colors.mutedForeground,
    fontSize: 15,
  },
  // Row-level rename affordance stays whisper-quiet until pressed — the title
  // and timestamp are what the eye should hit first.
  iconGlyphQuiet: {
    color: colors.faint,
    fontSize: 15,
  },
  iconGlyphPrimary: {
    color: colors.success,
    fontSize: 17,
    fontFamily: font.semibold,
  },
  // working-directory launcher (compact single row)
  cwdLauncher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 20,
    marginHorizontal: 4,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  cwdLauncherPressed: {
    backgroundColor: colors.surfaceHi,
  },
  cwdLauncherLabel: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.semibold,
  },
  cwdLauncherValue: {
    flex: 1,
    textAlign: "right",
    color: colors.foreground,
    fontSize: 12,
    fontFamily: font.mono,
  },
  cwdLauncherChevron: {
    color: colors.mutedForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  // bottom-sheet content
  sheetHint: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.regular,
    lineHeight: 18,
    marginBottom: 16,
  },
  cwdInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
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
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  cwdUse: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cwdUsePressed: {
    backgroundColor: colors.primaryDim,
  },
  cwdUseText: {
    color: colors.primaryForeground,
    fontFamily: font.semibold,
    fontSize: 13,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  // Standard WinUI buttons: faint raised fill, hairline stroke, 4px radius.
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: withAlpha(colors.foreground, 0.06),
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingLeft: 12,
    paddingRight: 9,
    paddingVertical: 7,
  },
  chipActive: {
    backgroundColor: colors.selection,
    borderColor: colors.primary,
  },
  chipText: {
    color: colors.secondaryForeground,
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
    marginTop: 20,
    gap: 2,
  },
  // Fluent Caption section header — sentence case, no tracking.
  sectionTitle: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.semibold,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  launchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  launchRowPressed: {
    backgroundColor: colors.selection,
  },
  launchIcon: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  launchLabel: {
    color: colors.secondaryForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  launchDesc: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.mono,
    marginTop: 2,
  },
  launchPlus: {
    color: colors.accentMint,
    fontSize: 18,
    fontFamily: font.semibold,
  },
  disconnect: {
    alignItems: "center",
    marginTop: 28,
    marginHorizontal: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: withAlpha(colors.accentCoral, 0.45),
    paddingVertical: 12,
  },
  disconnectPressed: {
    backgroundColor: withAlpha(colors.accentCoral, 0.12),
  },
  disconnectText: {
    color: colors.accentCoral,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  // Accent-filled action button — Fluent surface radius, not a round FAB.
  fab: {
    position: "absolute",
    right: 18,
    width: 56,
    height: 56,
    borderRadius: radius.lg,
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

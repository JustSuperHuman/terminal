import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import type {
  AcpAgentId,
  AcpAgentStatusView,
  AcpBridgeState,
  AcpConfigOptionView,
  AcpContentView,
  AcpFileChangeReportView,
  AcpInteractiveRequestView,
  AcpPlanEntryView,
  AcpPromptBlockInput,
  AcpSessionFailureView,
  AcpSessionView,
  AcpSubagentView,
  AcpTimelineItemView,
  AcpToolCallView,
  AcpUsageView,
} from "../acpTypes";
import {
  actOnAcpGoal,
  authenticateAcpAgent,
  cancelAcpSession,
  closeAcpSession,
  createAcpSession,
  deleteAcpSession,
  fetchAcpState,
  forkAcpSession,
  loadAcpSession,
  logoutAcpAgent,
  promptAcpSession,
  respondToAcpRequest,
  setAcpSessionConfig,
  setAcpSessionMode,
  startAcpAgent,
  type RespondToAcpRequestInput,
} from "../lib/acpApi";
import type { ServerEndpoint } from "../lib/endpoint";
import { terminalSocket } from "../lib/socket";
import { colors, font, radius, withAlpha } from "../theme";
import { AcpRequestCard } from "./AcpRequestCard";
import { BottomSheet } from "./BottomSheet";
import { ClaudeIcon, CloseIcon, CodexIcon, ImageIcon, SendIcon, TerminalGlyph } from "./icons";

export interface AgentWorkspaceScreenProps {
  visible: boolean;
  endpoint: ServerEndpoint;
  initialSessionId?: string;
  defaultCwd?: string;
  onClose: () => void;
  onStateChange?: (state: AcpBridgeState) => void;
}

type WorkspaceSheet = "sessions" | "create" | "settings" | "commands" | "goal" | undefined;

interface PendingImage {
  mimeType: string;
  data: string;
  previewUri: string;
  name: string;
}

type AcpSocketMessage =
  | { type: "acp_state"; acp?: AcpBridgeState; state?: AcpBridgeState; snapshot?: AcpBridgeState }
  | {
      type: "acp_session";
      epoch: string;
      sequence: number;
      session?: AcpSessionView;
      requests?: AcpInteractiveRequestView[];
      removedSessionId?: string;
      sessionId?: string;
      removed?: boolean;
    }
  | { type: "acp_session_removed"; epoch: string; sequence: number; sessionId: string; requests?: AcpInteractiveRequestView[] };

const POLL_MS = 6_000;
const MAX_IMAGE_BASE64_LENGTH = 22_000_000;
const TIMELINE_PAGE_SIZE = 120;

function isBridgeState(value: unknown): value is AcpBridgeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AcpBridgeState>;
  return typeof candidate.epoch === "string" && typeof candidate.sequence === "number" && Array.isArray(candidate.agents) && Array.isArray(candidate.sessions) && Array.isArray(candidate.requests);
}

function agentIcon(agent: AcpAgentId, size = 18) {
  return agent === "claude" ? <ClaudeIcon size={size} /> : <CodexIcon size={size} />;
}

function agentTone(agent: AcpAgentId): string {
  return agent === "claude" ? colors.accentAmber : colors.primary;
}

function stateTone(state: string): string {
  if (["ready", "completed", "complete", "reported", "exited"].includes(state)) return colors.success;
  if (["error", "failed", "blocked", "unavailable"].includes(state)) return colors.destructive;
  if (["prompting", "connecting", "starting", "cancelling", "running", "active", "limited"].includes(state)) return colors.accentAmber;
  return colors.mutedForeground;
}

function isDangerousAccessChoice(...values: Array<string | undefined>): boolean {
  return values.some((value) => /full[\s_-]*access|bypass[\s_-]*permissions?|unrestricted access/i.test(value ?? ""));
}

function formatWhen(value?: string): string {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  const elapsed = Date.now() - time.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "now";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return time.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatNumber(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDirectories(value: string): string[] {
  return [...new Set(value.split(/[\r\n;]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function imageMimeType(base64: string, fallback?: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  return fallback?.startsWith("image/") ? fallback : "image/jpeg";
}

function mergeSession(current: AcpSessionView[], incoming: AcpSessionView): AcpSessionView[] {
  const index = current.findIndex((session) => session.id === incoming.id);
  if (index < 0) return [incoming, ...current];
  const next = [...current];
  next[index] = incoming;
  return next;
}

function StateBadge({ state }: { state: string }) {
  const tone = stateTone(state);
  return (
    <View style={[styles.stateBadge, { borderColor: withAlpha(tone, 0.35), backgroundColor: withAlpha(tone, 0.10) }]}>
      <View style={[styles.stateDot, { backgroundColor: tone }]} />
      <Text style={[styles.stateBadgeText, { color: tone }]}>{state.replaceAll("_", " ")}</Text>
    </View>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function UsageStrip({ usage }: { usage: AcpUsageView }) {
  const parts = [
    usage.totalTokens !== undefined ? `${formatNumber(usage.totalTokens)} tokens` : undefined,
    usage.inputTokens !== undefined ? `${formatNumber(usage.inputTokens)} in` : undefined,
    usage.outputTokens !== undefined ? `${formatNumber(usage.outputTokens)} out` : undefined,
    usage.cost ? `${usage.cost.amount.toFixed(usage.cost.amount < 1 ? 4 : 2)} ${usage.cost.currency}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const fraction = usage.used !== undefined && usage.size ? Math.max(0, Math.min(1, usage.used / usage.size)) : undefined;
  return (
    <View style={styles.usageStrip}>
      <View style={styles.usageHead}>
        <Text style={styles.usageLabel}>CONTEXT</Text>
        <Text style={styles.usageValue}>{parts.join(" · ") || "Usage available"}</Text>
      </View>
      {fraction !== undefined ? (
        <View style={styles.usageTrack}>
          <View style={[styles.usageFill, { width: `${fraction * 100}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

function PlanCard({ plan, compact = false }: { plan: AcpPlanEntryView[]; compact?: boolean }) {
  if (!plan.length) return null;
  return (
    <View style={[styles.metaCard, compact && styles.metaCardCompact]}>
      <View style={styles.metaHead}>
        <Text style={styles.metaGlyph}>☷</Text>
        <Text style={styles.metaTitle}>Plan</Text>
        <Text style={styles.metaCount}>{plan.filter((item) => item.status === "completed").length}/{plan.length}</Text>
      </View>
      {plan.map((entry, index) => (
        <View key={`${index}:${entry.content}`} style={styles.planRow}>
          <View style={[styles.planMark, entry.status === "completed" && styles.planMarkDone, entry.status === "in_progress" && styles.planMarkActive]}>
            {entry.status === "completed" ? <Text style={styles.planCheck}>✓</Text> : null}
          </View>
          <Text style={[styles.planText, entry.status === "completed" && styles.planTextDone]}>{entry.content}</Text>
          {entry.priority === "high" ? <View style={styles.priorityMark} /> : null}
        </View>
      ))}
    </View>
  );
}

function GoalCard({ session, onOpen }: { session: AcpSessionView; onOpen: () => void }) {
  if (!session.goal) return null;
  const goal = session.goal;
  const budget = goal.tokenBudget && goal.tokensUsed !== undefined ? Math.max(0, Math.min(1, goal.tokensUsed / goal.tokenBudget)) : undefined;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Goal ${goal.status}. ${goal.objective}`}
      style={({ pressed }) => [styles.goalCard, pressed && styles.rowPressed]}
    >
      <View style={styles.goalHead}>
        <Text style={styles.goalEyebrow}>AUTONOMOUS GOAL</Text>
        <StateBadge state={goal.status} />
      </View>
      <Text style={styles.goalObjective} numberOfLines={3}>{goal.objective}</Text>
      {goal.lastReason ? <Text style={styles.goalReason} numberOfLines={2}>{goal.lastReason}</Text> : null}
      {budget !== undefined ? (
        <View style={styles.goalBudgetRow}>
          <View style={styles.goalBudgetTrack}><View style={[styles.goalBudgetFill, { width: `${budget * 100}%` }]} /></View>
          <Text style={styles.goalBudgetText}>{formatNumber(goal.tokensUsed)} / {formatNumber(goal.tokenBudget)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function FailureCards({
  failures,
  disabled,
  onAction,
}: {
  failures: AcpSessionFailureView[];
  disabled?: boolean;
  onAction: (action: string) => void;
}) {
  if (!failures.length) return null;
  return (
    <View style={styles.metaStack}>
      {failures.map((failure) => {
        const tone = failure.severity === "error" ? colors.destructive : colors.accentAmber;
        return (
          <View key={`${failure.id}:${failure.revision}`} style={[styles.failureCard, { borderColor: withAlpha(tone, 0.35) }]}>
            <View style={styles.failureHead}>
              <Text style={[styles.failureKind, { color: tone }]}>{failure.category.toUpperCase()}</Text>
              <Text style={styles.failureRevision}>REV {failure.revision}</Text>
            </View>
            <Text style={styles.failureTitle}>{failure.title}</Text>
            {failure.details ? <Text style={styles.failureDetails} selectable>{failure.details}</Text> : null}
            {failure.actions.length ? (
              <View style={styles.failureActions}>
                {failure.actions.map((action) => (
                  <Pressable
                    key={action}
                    onPress={() => onAction(action)}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={`${action.replaceAll("_", " ")} for ${failure.title}`}
                    style={({ pressed }) => [styles.failureAction, pressed && styles.rowPressed, disabled && styles.disabled]}
                  >
                    <Text style={styles.failureActionText}>{action.replaceAll("_", " ")}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function FileChangeCards({ reports }: { reports: AcpFileChangeReportView[] }) {
  if (!reports.length) return null;
  return (
    <View style={styles.metaStack}>
      {reports.slice(-3).map((report) => (
        <View key={report.requestId} style={styles.changeCard}>
          <View style={styles.metaHead}>
            <Text style={styles.metaGlyph}>±</Text>
            <Text style={styles.metaTitle}>File changes</Text>
            <StateBadge state={report.status} />
          </View>
          {report.status === "reported" ? (
            <>
              {report.paths.slice(0, 12).map((path) => <Text key={path} style={styles.changePath} numberOfLines={1}>{path}</Text>)}
              {report.paths.length > 12 || report.truncated ? <Text style={styles.metaHint}>Additional paths were omitted from this report.</Text> : null}
              {report.uncertainty ? <Text style={styles.failureDetails}>{report.uncertainty}</Text> : null}
              <Text style={styles.metaHint}>{report.declaredComplete ? "Agent declared this report complete." : "Agent did not declare this report complete."}</Text>
            </>
          ) : <Text style={styles.failureDetails}>{report.reason}</Text>}
        </View>
      ))}
    </View>
  );
}

function openExternal(uri: string, onError: (error: unknown) => void) {
  Linking.openURL(uri).catch(onError);
}

function ContentBlock({ content, onError }: { content: AcpContentView; onError: (error: unknown) => void }) {
  if (content.type === "text") return <Text style={styles.timelineText} selectable>{content.text}</Text>;
  if (content.type === "image") {
    const uri = content.data ? `data:${content.mimeType};base64,${content.data}` : content.uri;
    return uri ? <Image source={{ uri }} resizeMode="contain" style={styles.contentImage} accessibilityLabel="Agent image" /> : <Text style={styles.metaHint}>Image content unavailable</Text>;
  }
  if (content.type === "audio") {
    return <View style={styles.resourceCard}><Text style={styles.resourceType}>AUDIO</Text><Text style={styles.resourceTitle}>{content.mimeType}</Text></View>;
  }
  return (
    <Pressable onPress={() => openExternal(content.uri, onError)} accessibilityRole="link" style={({ pressed }) => [styles.resourceCard, pressed && styles.rowPressed]}>
      <Text style={styles.resourceType}>RESOURCE</Text>
      <Text style={styles.resourceTitle}>{content.title ?? content.name ?? content.uri}</Text>
      <Text style={styles.resourceUri} numberOfLines={2}>{content.uri}</Text>
      {content.text ? <Text style={styles.resourcePreview} numberOfLines={6} selectable>{content.text}</Text> : null}
    </Pressable>
  );
}

function TerminalCard({ terminal }: { terminal: AcpSessionView["terminals"][number] }) {
  return (
    <View style={styles.terminalCard}>
      <View style={styles.terminalHead}>
        <TerminalGlyph size={15} color={colors.secondaryForeground} />
        <Text style={styles.terminalCommand} numberOfLines={1}>{[terminal.command, ...terminal.args].join(" ")}</Text>
        <StateBadge state={terminal.state} />
      </View>
      <Text style={styles.terminalCwd} numberOfLines={1}>{terminal.cwd}</Text>
      <ScrollView style={styles.terminalOutputScroll} nestedScrollEnabled>
        <Text style={styles.terminalOutput} selectable>{terminal.output || "No output"}</Text>
      </ScrollView>
      {terminal.truncated ? <Text style={styles.metaHint}>Earlier output was truncated.</Text> : null}
      {terminal.exitCode !== undefined ? <Text style={styles.metaHint}>Exit code {terminal.exitCode}{terminal.signal ? ` · ${terminal.signal}` : ""}</Text> : null}
    </View>
  );
}

function DiffCard({ path, oldText, newText, truncated }: { path: string; oldText?: string; newText: string; truncated?: boolean }) {
  const removed = oldText?.split("\n").slice(0, 80) ?? [];
  const added = newText.split("\n").slice(0, 120);
  return (
    <View style={styles.diffCard}>
      <View style={styles.diffHead}><Text style={styles.diffGlyph}>±</Text><Text style={styles.diffPath} numberOfLines={2}>{path}</Text></View>
      {removed.length ? <View style={styles.diffRemoved}>{removed.map((line, index) => <Text key={`r${index}`} style={styles.diffRemovedText} selectable>- {line}</Text>)}</View> : null}
      <View style={styles.diffAdded}>{added.map((line, index) => <Text key={`a${index}`} style={styles.diffAddedText} selectable>+ {line}</Text>)}</View>
      {truncated || removed.length >= 80 || added.length >= 120 ? <Text style={styles.metaHint}>Diff preview truncated.</Text> : null}
    </View>
  );
}

function ToolCard({ tool, session, onError }: { tool: AcpToolCallView; session: AcpSessionView; onError: (error: unknown) => void }) {
  const [expanded, setExpanded] = useState(tool.status === "failed" || tool.status === "in_progress");
  const tone = tool.status === "failed" ? colors.destructive : tool.status === "completed" ? colors.success : colors.accentAmber;
  return (
    <View style={[styles.toolCard, { borderColor: withAlpha(tone, 0.28) }]}>
      <Pressable onPress={() => setExpanded((current) => !current)} accessibilityRole="button" accessibilityState={{ expanded }} style={({ pressed }) => [styles.toolHead, pressed && styles.rowPressed]}>
        <View style={[styles.toolKind, { backgroundColor: withAlpha(tone, 0.12), borderColor: withAlpha(tone, 0.3) }]}><Text style={[styles.toolKindText, { color: tone }]}>{tool.kind.slice(0, 1).toUpperCase()}</Text></View>
        <View style={styles.toolCopy}>
          <Text style={styles.toolName} numberOfLines={2}>{tool.title}</Text>
          <Text style={styles.toolMeta}>{tool.name ?? tool.kind} · {tool.status.replaceAll("_", " ")}</Text>
        </View>
        {tool.status === "in_progress" ? <ActivityIndicator size="small" color={tone} /> : <Text style={styles.expandGlyph}>{expanded ? "⌃" : "⌄"}</Text>}
      </Pressable>
      {expanded ? (
        <View style={styles.toolBody}>
          {tool.locations.map((location) => <Text key={`${location.path}:${location.line ?? 0}`} style={styles.changePath}>{location.path}{location.line ? `:${location.line}` : ""}</Text>)}
          {tool.content.map((entry, index) => {
            if (entry.type === "content") return <ContentBlock key={index} content={entry.content} onError={onError} />;
            if (entry.type === "diff") return <DiffCard key={index} {...entry} />;
            const terminal = session.terminals.find((candidate) => candidate.id === entry.terminalId);
            return terminal ? <TerminalCard key={index} terminal={terminal} /> : <Text key={index} style={styles.metaHint}>Terminal {entry.terminalId} is no longer available.</Text>;
          })}
          {!tool.content.length && tool.rawOutput !== undefined ? <Text style={styles.rawJson} selectable>{JSON.stringify(tool.rawOutput, null, 2)}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function TimelineRow({ item, session, onError }: { item: AcpTimelineItemView; session: AcpSessionView; onError: (error: unknown) => void }) {
  const [expanded, setExpanded] = useState(item.kind !== "thought");
  if (item.kind === "tool" && item.toolCall) return <ToolCard tool={item.toolCall} session={session} onError={onError} />;
  if (item.kind === "plan" && item.plan) return <PlanCard plan={item.plan} />;
  if (item.kind === "usage" && item.usage) return <UsageStrip usage={item.usage} />;
  if (item.kind === "thought") {
    return (
      <Pressable onPress={() => setExpanded((current) => !current)} accessibilityRole="button" accessibilityState={{ expanded }} style={({ pressed }) => [styles.thoughtCard, pressed && styles.rowPressed]}>
        <View style={styles.thoughtHead}><Text style={styles.thoughtGlyph}>◇</Text><Text style={styles.thoughtTitle}>{item.title ?? "Reasoning"}</Text><Text style={styles.expandGlyph}>{expanded ? "⌃" : "⌄"}</Text></View>
        {expanded ? <Text style={styles.thoughtText} selectable>{item.text ?? (item.content?.type === "text" ? item.content.text : "")}</Text> : null}
      </Pressable>
    );
  }
  if (item.kind === "extension") {
    return <View style={styles.extensionCard}><Text style={styles.extensionMethod}>{item.extension?.method ?? item.title ?? "EXTENSION"}</Text><Text style={styles.extensionSummary}>{item.extension?.summary ?? item.text ?? "Extension update"}</Text></View>;
  }
  if (item.kind === "status" || item.kind === "error") {
    return <View style={[styles.statusCard, item.kind === "error" && styles.errorCard]}><Text style={[styles.statusTitle, item.kind === "error" && styles.errorText]}>{item.title ?? (item.kind === "error" ? "Error" : "Status")}</Text>{item.text ? <Text style={styles.statusText} selectable>{item.text}</Text> : null}</View>;
  }

  const isUser = item.kind === "user";
  return (
    <View style={[styles.messageRow, isUser && styles.messageRowUser]}>
      {!isUser ? <View style={styles.agentMini}>{agentIcon(session.agent, 15)}</View> : null}
      <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.agentBubble]}>
        {item.title ? <Text style={styles.messageTitle}>{item.title}</Text> : null}
        {item.content ? <ContentBlock content={item.content} onError={onError} /> : item.text ? <Text style={styles.timelineText} selectable>{item.text}</Text> : null}
        <Text style={styles.messageTime}>{formatWhen(item.at)}</Text>
      </View>
    </View>
  );
}

function SubagentCard({ subagent, all, depth = 0, session, onError }: { subagent: AcpSubagentView; all: AcpSubagentView[]; depth?: number; session: AcpSessionView; onError: (error: unknown) => void }) {
  const [expanded, setExpanded] = useState(subagent.state === "running");
  const children = all.filter((candidate) => candidate.parentId === subagent.id);
  return (
    <View style={[styles.subagentCard, depth > 0 && styles.subagentNested]}>
      <Pressable onPress={() => setExpanded((current) => !current)} accessibilityRole="button" accessibilityState={{ expanded }} style={({ pressed }) => [styles.subagentHead, pressed && styles.rowPressed]}>
        <View style={styles.subagentBranch}><Text style={styles.subagentBranchText}>{depth ? "└" : "↳"}</Text></View>
        <View style={styles.toolCopy}><Text style={styles.subagentName}>{subagent.name}</Text><Text style={styles.subagentTask} numberOfLines={2}>{subagent.task}</Text></View>
        <StateBadge state={subagent.state} />
      </Pressable>
      {expanded ? (
        <View style={styles.subagentBody}>
          {subagent.timeline.slice(-8).map((item) => <TimelineRow key={item.id} item={item} session={session} onError={onError} />)}
          {!subagent.timeline.length ? <Text style={styles.metaHint}>Waiting for the subagent’s first update.</Text> : null}
          {children.map((child) => <SubagentCard key={child.id} subagent={child} all={all} depth={depth + 1} session={session} onError={onError} />)}
        </View>
      ) : null}
    </View>
  );
}

function AgentHome({
  agents,
  sessions,
  requests,
  refreshing,
  onRefresh,
  onOpenSession,
  onCreate,
  onStart,
  onAuthenticate,
  onLogout,
  onLoad,
  busy,
}: {
  agents: AcpAgentStatusView[];
  sessions: AcpSessionView[];
  requests: AcpInteractiveRequestView[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSession: (sessionId: string) => void;
  onCreate: (agent: AcpAgentId) => void;
  onStart: (agent: AcpAgentId) => void;
  onAuthenticate: (agent: AcpAgentId, methodId: string) => void;
  onLogout: (agent: AcpAgentId) => void;
  onLoad: (agent: AcpAgentId, sessionId: string, cwd: string, mode: "load" | "resume") => void;
  busy?: string;
}) {
  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions]
  );
  return (
    <ScrollView
      style={styles.homeList}
      contentContainerStyle={styles.homeContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
    >
      <View style={styles.homeHeader}>
        <Text style={styles.homeKicker}>AGENT CLIENT PROTOCOL</Text>
        <Text style={styles.homeTitle}>Claude and Codex, without leaving Terminal.</Text>
        <Text style={styles.homeIntro}>Structured sessions keep permissions, tools, plans, changes, and resumable work legible on a phone.</Text>
        {sortedSessions.length ? (
          <View style={styles.homeSection}>
            <SectionLabel>ACTIVE WORKSPACES</SectionLabel>
            {sortedSessions.slice(0, 6).map((session) => {
              const count = requests.filter((request) => request.sessionId === session.id).length;
              return (
                <Pressable key={session.id} onPress={() => onOpenSession(session.id)} accessibilityRole="button" style={({ pressed }) => [styles.sessionRow, pressed && styles.rowPressed]}>
                  <View style={styles.sessionAgent}>{agentIcon(session.agent, 20)}</View>
                  <View style={styles.sessionCopy}>
                    <Text style={styles.sessionTitle} numberOfLines={1}>{session.title}</Text>
                    <Text style={styles.sessionMeta} numberOfLines={1}>{session.cwd} · {formatWhen(session.updatedAt)}</Text>
                  </View>
                  {count ? <View style={styles.requestCount}><Text style={styles.requestCountText}>{count}</Text></View> : <StateBadge state={session.state} />}
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <SectionLabel>PROVIDERS</SectionLabel>
      </View>
      {agents.map((agent) => {
        const tone = agentTone(agent.id);
        const agentBusy = busy?.startsWith(`agent:${agent.id}`) ?? false;
        return (
          <View key={agent.id} style={[styles.providerCard, { borderColor: withAlpha(tone, 0.25) }]}>
            <View style={styles.providerHead}>
              <View style={[styles.providerIcon, { backgroundColor: withAlpha(tone, 0.1), borderColor: withAlpha(tone, 0.28) }]}>{agentIcon(agent.id, 23)}</View>
              <View style={styles.providerCopy}>
                <Text style={styles.providerName}>{agent.label}</Text>
                <Text style={styles.providerImpl} numberOfLines={1}>{agent.implementation?.title ?? agent.implementation?.name ?? "ACP adapter"}{agent.implementation?.version ? ` · ${agent.implementation.version}` : ""}</Text>
              </View>
              <StateBadge state={agent.state} />
            </View>
            {agent.lastError ? <Text style={styles.providerError}>{agent.lastError}</Text> : null}
            <View style={styles.capabilityRow}>
              {agent.capabilities.loadSession ? <View style={styles.tag}><Text style={styles.tagText}>RESUME</Text></View> : null}
              {agent.capabilities.prompt.image ? <View style={styles.tag}><Text style={styles.tagText}>IMAGES</Text></View> : null}
              {agent.capabilities.steering ? <View style={styles.tag}><Text style={styles.tagText}>STEERING</Text></View> : null}
              {agent.capabilities.nativeSubagents ? <View style={styles.tag}><Text style={styles.tagText}>SUBAGENTS</Text></View> : null}
              {agent.protocolVersion ? <View style={styles.tag}><Text style={styles.tagText}>ACP {agent.protocolVersion}</Text></View> : null}
            </View>
            <View style={styles.providerActions}>
              <Pressable
                onPress={() => agent.state === "ready" ? onCreate(agent.id) : onStart(agent.id)}
                disabled={!agent.available || agentBusy || agent.state === "starting"}
                accessibilityRole="button"
                style={({ pressed }) => [styles.primaryCompact, pressed && styles.primaryPressed, (!agent.available || agentBusy) && styles.disabled]}
              >
                {agentBusy ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <Text style={styles.primaryCompactText}>{agent.state === "ready" ? "New session" : agent.state === "error" ? "Retry" : "Start"}</Text>}
              </Pressable>
              {agent.state === "ready" && agent.capabilities.auth.logout ? (
                <Pressable onPress={() => onLogout(agent.id)} disabled={agentBusy} accessibilityRole="button" style={({ pressed }) => [styles.secondaryCompact, pressed && styles.rowPressed, agentBusy && styles.disabled]}><Text style={styles.secondaryCompactText}>Sign out</Text></Pressable>
              ) : null}
            </View>
            {agent.state === "ready" && agent.authMethods.length ? (
              <View style={styles.authList}>
                {agent.authMethods.map((method) => (
                  <Pressable key={method.id} onPress={() => onAuthenticate(agent.id, method.id)} disabled={agentBusy} accessibilityRole="button" style={({ pressed }) => [styles.authRow, pressed && styles.rowPressed, agentBusy && styles.disabled]}>
                    <View style={styles.authCopy}><Text style={styles.authName}>{method.name}</Text>{method.description ? <Text style={styles.authDescription}>{method.description}</Text> : null}</View>
                    <Text style={styles.authType}>{method.type.toUpperCase()}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {agent.availableSessions.length ? (
              <View style={styles.remoteList}>
                <Text style={styles.remoteLabel}>AVAILABLE TO RESUME</Text>
                {agent.availableSessions.slice(0, 5).map((session) => {
                  const mode = agent.capabilities.session.resume ? "resume" : "load";
                  return (
                    <Pressable key={session.sessionId} onPress={() => onLoad(agent.id, session.sessionId, session.cwd, mode)} disabled={agentBusy} accessibilityRole="button" style={({ pressed }) => [styles.remoteRow, pressed && styles.rowPressed, agentBusy && styles.disabled]}>
                      <View style={styles.remoteCopy}><Text style={styles.remoteTitle} numberOfLines={1}>{session.title ?? session.sessionId}</Text><Text style={styles.remotePath} numberOfLines={1}>{session.cwd}</Text></View>
                      <Text style={styles.remoteAction}>{mode === "resume" ? "Resume" : "Load"}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
      {!agents.length ? (
        <View style={styles.emptyCard}>
          <TerminalGlyph size={26} color={colors.mutedForeground} />
          <Text style={styles.emptyTitle}>No ACP adapters advertised</Text>
          <Text style={styles.emptyText}>Update or restart the desktop bridge, then pull to refresh. Existing terminal sessions are unaffected.</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function SessionPickerSheet({
  visible,
  sessions,
  requests,
  activeId,
  onClose,
  onSelect,
  onHome,
  onNew,
}: {
  visible: boolean;
  sessions: AcpSessionView[];
  requests: AcpInteractiveRequestView[];
  activeId?: string;
  onClose: () => void;
  onSelect: (sessionId: string) => void;
  onHome: () => void;
  onNew: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="Agent workspaces" onClose={onClose}>
      <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <Pressable onPress={onHome} accessibilityRole="button" style={({ pressed }) => [styles.sessionRow, pressed && styles.rowPressed]}>
          <View style={styles.sessionAgent}><TerminalGlyph size={19} color={colors.primary} /></View>
          <View style={styles.sessionCopy}><Text style={styles.sessionTitle}>ACP home</Text><Text style={styles.sessionMeta}>Providers, sign-in, and resumable sessions</Text></View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
        <Pressable onPress={onNew} accessibilityRole="button" style={({ pressed }) => [styles.newWorkspaceRow, pressed && styles.rowPressed]}>
          <View style={styles.newWorkspaceMark}><Text style={styles.newWorkspacePlus}>+</Text></View>
          <View style={styles.sessionCopy}><Text style={styles.sessionTitle}>New ACP session</Text><Text style={styles.sessionMeta}>Choose Claude or Codex and a directory</Text></View>
        </Pressable>
        {[...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((session) => {
          const selected = session.id === activeId;
          const count = requests.filter((request) => request.sessionId === session.id).length;
          return (
            <Pressable key={session.id} onPress={() => onSelect(session.id)} accessibilityRole="button" accessibilityState={{ selected }} style={({ pressed }) => [styles.sessionRow, selected && styles.sessionRowSelected, pressed && styles.rowPressed]}>
              <View style={styles.sessionAgent}>{agentIcon(session.agent, 19)}</View>
              <View style={styles.sessionCopy}><Text style={styles.sessionTitle} numberOfLines={1}>{session.title}</Text><Text style={styles.sessionMeta} numberOfLines={1}>{session.cwd}</Text></View>
              {count ? <View style={styles.requestCount}><Text style={styles.requestCountText}>{count}</Text></View> : <StateBadge state={session.state} />}
            </Pressable>
          );
        })}
      </ScrollView>
    </BottomSheet>
  );
}

function CreateSessionSheet({
  visible,
  agents,
  initialAgent,
  initialCwd,
  busy,
  onClose,
  onCreate,
}: {
  visible: boolean;
  agents: AcpAgentStatusView[];
  initialAgent?: AcpAgentId;
  initialCwd?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (agent: AcpAgentId, cwd: string, additionalDirectories: string[]) => void;
}) {
  const readyAgents = agents.filter((agent) => agent.available);
  const [agent, setAgent] = useState<AcpAgentId>(initialAgent ?? readyAgents[0]?.id ?? "claude");
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [directories, setDirectories] = useState("");
  useEffect(() => {
    if (!visible) return;
    setAgent(initialAgent ?? readyAgents[0]?.id ?? "claude");
    setCwd(initialCwd ?? "");
    setDirectories("");
  }, [initialAgent, initialCwd, visible]);
  const selectedStatus = agents.find((candidate) => candidate.id === agent);
  const canSubmit = Boolean(cwd.trim()) && selectedStatus?.state === "ready" && !busy;
  return (
    <BottomSheet visible={visible} title="New agent session" onClose={onClose}>
      <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.formSheetContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.inputLabel}>AGENT</Text>
        <View style={styles.segmented}>
          {readyAgents.map((candidate) => (
            <Pressable key={candidate.id} onPress={() => setAgent(candidate.id)} accessibilityRole="radio" accessibilityState={{ checked: candidate.id === agent }} style={({ pressed }) => [styles.segment, candidate.id === agent && styles.segmentSelected, pressed && styles.rowPressed]}>
              {agentIcon(candidate.id, 17)}<Text style={[styles.segmentText, candidate.id === agent && styles.segmentTextSelected]}>{candidate.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.inputLabel}>WORKING DIRECTORY</Text>
        <TextInput value={cwd} onChangeText={setCwd} placeholder="F:\\projects\\app" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={[styles.workspaceInput, styles.monoWorkspaceInput]} accessibilityLabel="Working directory" />
        {selectedStatus?.capabilities.session.additionalDirectories ? (
          <>
            <Text style={styles.inputLabel}>ADDITIONAL DIRECTORIES</Text>
            <TextInput value={directories} onChangeText={setDirectories} placeholder="One path per line (optional)" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} multiline style={[styles.workspaceInput, styles.directoryInput, styles.monoWorkspaceInput]} accessibilityLabel="Additional directories" />
          </>
        ) : null}
        {selectedStatus?.state !== "ready" ? <Text style={styles.formWarning}>Start and authenticate {selectedStatus?.label ?? agent} before creating a session.</Text> : null}
        <Pressable onPress={() => onCreate(agent, cwd.trim(), normalizeDirectories(directories))} disabled={!canSubmit} accessibilityRole="button" accessibilityState={{ disabled: !canSubmit }} style={({ pressed }) => [styles.sheetPrimary, pressed && styles.primaryPressed, !canSubmit && styles.disabled]}>
          {busy ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <Text style={styles.primaryButtonText}>Create session</Text>}
        </Pressable>
      </ScrollView>
    </BottomSheet>
  );
}

function SessionSettingsSheet({
  visible,
  session,
  agent,
  busy,
  reportFileChanges,
  deleteArmed,
  onClose,
  onSetMode,
  onSetConfig,
  onToggleFileReports,
  onOpenGoal,
  onFork,
  onCloseSession,
  onDelete,
}: {
  visible: boolean;
  session?: AcpSessionView;
  agent?: AcpAgentStatusView;
  busy: boolean;
  reportFileChanges: boolean;
  deleteArmed: boolean;
  onClose: () => void;
  onSetMode: (modeId: string, confirmDangerous?: boolean) => void;
  onSetConfig: (option: AcpConfigOptionView, value: string | boolean, confirmDangerous?: boolean) => void;
  onToggleFileReports: () => void;
  onOpenGoal: () => void;
  onFork: () => void;
  onCloseSession: () => void;
  onDelete: () => void;
}) {
  const [armedSetting, setArmedSetting] = useState<string>();
  useEffect(() => {
    if (!visible) setArmedSetting(undefined);
  }, [session?.id, visible]);
  const hasPreferredModeConfig = session?.configOptions.some((option) => option.id.toLowerCase() === "mode" || option.category === "mode") ?? false;

  return (
    <BottomSheet visible={visible} title="Session settings" onClose={onClose}>
      <ScrollView style={styles.settingsScroll} contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
        {session?.modes?.availableModes.length && !hasPreferredModeConfig ? (
          <View style={styles.settingsSection}>
            <Text style={styles.inputLabel}>MODE</Text>
            {session.modes.availableModes.map((mode) => {
              const selected = mode.id === session.modes?.currentModeId;
              const dangerous = isDangerousAccessChoice(mode.id, mode.name, mode.description);
              const token = `mode:${mode.id}`;
              const armed = armedSetting === token;
              return (
                <Pressable
                  key={mode.id}
                  onPress={() => {
                    if (dangerous && !armed) { setArmedSetting(token); return; }
                    setArmedSetting(undefined);
                    onSetMode(mode.id, dangerous);
                  }}
                  disabled={busy || selected}
                  accessibilityRole="radio"
                  accessibilityHint={dangerous && !armed ? "Tap once to review, then again to enable unrestricted access" : undefined}
                  accessibilityState={{ checked: selected, disabled: busy }}
                  style={({ pressed }) => [styles.settingsRow, selected && styles.settingsRowSelected, armed && styles.dangerSettingArmed, pressed && styles.rowPressed, busy && styles.disabled]}
                >
                  <View style={[styles.radioMark, selected && styles.radioMarkSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
                  <View style={styles.settingsCopy}><Text style={styles.settingsName}>{mode.name}</Text>{mode.description ? <Text style={styles.settingsDescription}>{mode.description}</Text> : null}{armed ? <Text style={styles.dangerSettingText}>Tap again to allow unrestricted filesystem and network access.</Text> : null}</View>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {session?.configOptions.length ? (
          <View style={styles.settingsSection}>
            <Text style={styles.inputLabel}>CONFIGURATION</Text>
            {session.configOptions.map((option) => (
              <View key={option.id} style={styles.configBlock}>
                <View style={styles.configHead}>
                  <View style={styles.settingsCopy}><Text style={styles.settingsName}>{option.name}</Text>{option.description ? <Text style={styles.settingsDescription}>{option.description}</Text> : null}</View>
                  {option.type === "boolean" ? (
                    <Pressable onPress={() => onSetConfig(option, !option.currentValue)} disabled={busy} accessibilityRole="switch" accessibilityState={{ checked: option.currentValue, disabled: busy }} style={[styles.switchTrack, option.currentValue && styles.switchTrackOn]}>
                      <View style={[styles.switchThumb, option.currentValue && styles.switchThumbOn]} />
                    </Pressable>
                  ) : null}
                </View>
                {option.type === "select" ? (
                  <View style={styles.configOptions}>
                    {option.options.map((value) => {
                      const selected = option.currentValue === value.value;
                      const dangerous = (option.id.toLowerCase() === "mode" || option.category === "mode")
                        && isDangerousAccessChoice(value.value, value.name, value.description);
                      const token = `config:${option.id}:${value.value}`;
                      const armed = armedSetting === token;
                      return (
                        <Pressable
                          key={value.value}
                          onPress={() => {
                            if (dangerous && !armed) { setArmedSetting(token); return; }
                            setArmedSetting(undefined);
                            onSetConfig(option, value.value, dangerous);
                          }}
                          disabled={busy || selected}
                          accessibilityRole="radio"
                          accessibilityHint={dangerous && !armed ? "Tap once to review, then again to enable unrestricted access" : undefined}
                          accessibilityState={{ checked: selected, disabled: busy }}
                          style={({ pressed }) => [styles.configChip, selected && styles.configChipSelected, armed && styles.dangerSettingArmed, pressed && styles.rowPressed, busy && styles.disabled]}
                        >
                          <Text style={[styles.configChipText, selected && styles.configChipTextSelected, armed && styles.dangerSettingText]}>{armed ? `Confirm ${value.name}` : value.name}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
        {agent?.capabilities.fileChangeReports ? (
          <Pressable onPress={onToggleFileReports} accessibilityRole="switch" accessibilityState={{ checked: reportFileChanges }} style={({ pressed }) => [styles.preferenceRow, pressed && styles.rowPressed]}>
            <View style={styles.settingsCopy}><Text style={styles.settingsName}>Report file changes</Text><Text style={styles.settingsDescription}>Ask the agent to return a normalized list after each prompt.</Text></View>
            <View style={[styles.switchTrack, reportFileChanges && styles.switchTrackOn]}><View style={[styles.switchThumb, reportFileChanges && styles.switchThumbOn]} /></View>
          </Pressable>
        ) : null}
        {agent?.capabilities.goal.supported ? (
          <Pressable onPress={onOpenGoal} accessibilityRole="button" style={({ pressed }) => [styles.preferenceRow, pressed && styles.rowPressed]}>
            <View style={styles.settingsCopy}><Text style={styles.settingsName}>Autonomous goal</Text><Text style={styles.settingsDescription}>{session?.goal?.objective ?? "Create or manage a persistent agent goal."}</Text></View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ) : null}
        <View style={styles.sessionDetails}>
          <Text style={styles.inputLabel}>SESSION</Text>
          <Text style={styles.detailKey}>Agent session ID</Text><Text style={styles.detailValue} selectable>{session?.agentSessionId}</Text>
          <Text style={styles.detailKey}>Working directory</Text><Text style={styles.detailValue} selectable>{session?.cwd}</Text>
          {session?.additionalDirectories.map((directory) => <Text key={directory} style={styles.detailValue} selectable>+ {directory}</Text>)}
        </View>
        {agent?.capabilities.session.fork ? (
          <Pressable onPress={onFork} disabled={busy} accessibilityRole="button" style={({ pressed }) => [styles.preferenceRow, pressed && styles.rowPressed, busy && styles.disabled]}>
            <View style={styles.settingsCopy}><Text style={styles.settingsName}>Fork session</Text><Text style={styles.settingsDescription}>Branch the current conversation into a new workspace at the same working directory.</Text></View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ) : null}
        {agent?.capabilities.session.close || agent?.capabilities.loadSession ? (
          <Pressable onPress={onCloseSession} disabled={busy} accessibilityRole="button" style={({ pressed }) => [styles.preferenceRow, pressed && styles.rowPressed, busy && styles.disabled]}>
            <View style={styles.settingsCopy}><Text style={styles.settingsName}>Close workspace</Text><Text style={styles.settingsDescription}>Release this live workspace while keeping provider history available to resume.</Text></View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ) : null}
        {agent?.capabilities.session.delete ? (
          <Pressable onPress={onDelete} disabled={busy} accessibilityRole="button" accessibilityLabel={deleteArmed ? "Confirm delete agent session" : "Delete agent session"} style={({ pressed }) => [styles.deleteButton, deleteArmed && styles.deleteButtonArmed, pressed && styles.deletePressed, busy && styles.disabled]}>
            <Text style={styles.deleteButtonText}>{deleteArmed ? "Tap again to delete permanently" : "Delete agent session"}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

function CommandsSheet({ visible, session, onClose, onChoose }: { visible: boolean; session?: AcpSessionView; onClose: () => void; onChoose: (command: string) => void }) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (visible) setQuery(""); }, [visible]);
  const commands = (session?.availableCommands ?? []).filter((command) => `${command.name} ${command.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <BottomSheet visible={visible} title="Agent commands" onClose={onClose}>
      <TextInput value={query} onChangeText={setQuery} placeholder="Filter commands" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={styles.workspaceInput} accessibilityLabel="Filter commands" />
      <ScrollView style={styles.commandSheetList} contentContainerStyle={styles.commandSheetContent} keyboardShouldPersistTaps="handled">
        {commands.map((command) => (
          <Pressable key={command.name} onPress={() => onChoose(command.name)} accessibilityRole="button" style={({ pressed }) => [styles.commandRow, pressed && styles.rowPressed]}>
            <Text style={styles.commandName}>/{command.name}</Text>
            <View style={styles.commandCopy}><Text style={styles.commandDescription}>{command.description}</Text>{command.inputHint ? <Text style={styles.commandHint}>{command.inputHint}</Text> : null}</View>
          </Pressable>
        ))}
        {!commands.length ? <Text style={styles.emptyText}>No commands match this filter.</Text> : null}
      </ScrollView>
    </BottomSheet>
  );
}

function GoalSheet({
  visible,
  session,
  actions,
  busy,
  onClose,
  onAction,
}: {
  visible: boolean;
  session?: AcpSessionView;
  actions: string[];
  busy: boolean;
  onClose: () => void;
  onAction: (action: string, objective?: string) => void;
}) {
  const [objective, setObjective] = useState("");
  useEffect(() => { if (visible) setObjective(session?.goal?.objective ?? ""); }, [session?.goal?.objective, visible]);
  return (
    <BottomSheet visible={visible} title="Autonomous goal" onClose={onClose}>
      <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.formSheetContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.sheetHint}>Goal controls are advertised by the active adapter. The desktop remains the source of truth for budgets and status.</Text>
        <Text style={styles.inputLabel}>OBJECTIVE</Text>
        <TextInput value={objective} onChangeText={setObjective} placeholder="Describe the outcome to pursue" placeholderTextColor={colors.faint} multiline style={[styles.workspaceInput, styles.goalInput]} accessibilityLabel="Goal objective" />
        {session?.goal ? <GoalCard session={session} onOpen={() => undefined} /> : null}
        <View style={styles.goalActions}>
          {actions.map((action) => {
            const destructive = ["cancel", "delete", "stop"].includes(action.toLowerCase());
            return (
              <Pressable key={action} onPress={() => onAction(action, objective.trim() || undefined)} disabled={busy || (["create", "start", "update", "set"].includes(action.toLowerCase()) && !objective.trim())} accessibilityRole="button" style={({ pressed }) => [styles.goalAction, destructive && styles.goalActionDanger, pressed && styles.rowPressed, busy && styles.disabled]}>
                {busy ? <ActivityIndicator size="small" color={destructive ? colors.destructive : colors.primary} /> : <Text style={[styles.goalActionText, destructive && styles.goalActionTextDanger]}>{action.replaceAll("_", " ")}</Text>}
              </Pressable>
            );
          })}
        </View>
        {!actions.length ? <Text style={styles.emptyText}>This adapter did not advertise any goal actions.</Text> : null}
      </ScrollView>
    </BottomSheet>
  );
}

export function AgentWorkspaceScreen({
  visible,
  endpoint,
  initialSessionId,
  defaultCwd,
  onClose,
  onStateChange,
}: AgentWorkspaceScreenProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  const [bridge, setBridge] = useState<AcpBridgeState>();
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId);
  const [homePinned, setHomePinned] = useState(false);
  const [sheet, setSheet] = useState<WorkspaceSheet>();
  const [createAgent, setCreateAgent] = useState<AcpAgentId>();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [pendingImage, setPendingImage] = useState<PendingImage>();
  const [reportFileChanges, setReportFileChanges] = useState(true);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_PAGE_SIZE);
  const listRef = useRef<ScrollView | null>(null);
  const followOutputRef = useRef(true);
  const streamScrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<TextInput | null>(null);
  const refreshGeneration = useRef(0);
  const refreshFailedRef = useRef(false);
  const lastRequestId = useRef<string | undefined>(undefined);
  const initialSelectionApplied = useRef<string | undefined>(undefined);
  const orderRef = useRef<{ epoch: string; sequence: number } | undefined>(undefined);
  const retiredEpochsRef = useRef(new Set<string>());

  const publish = useCallback((next: AcpBridgeState): boolean => {
    const previous = orderRef.current;
    if (previous?.epoch === next.epoch && next.sequence <= previous.sequence) return false;
    if (previous?.epoch !== next.epoch && retiredEpochsRef.current.has(next.epoch)) return false;
    if (previous?.epoch && previous.epoch !== next.epoch) retiredEpochsRef.current.add(previous.epoch);
    orderRef.current = { epoch: next.epoch, sequence: next.sequence };
    setBridge(next);
    onStateChange?.(next);
    return true;
  }, [onStateChange]);

  useEffect(() => {
    refreshGeneration.current += 1;
    orderRef.current = undefined;
    retiredEpochsRef.current.clear();
    lastRequestId.current = undefined;
    initialSelectionApplied.current = undefined;
    setBridge(undefined);
    setActiveSessionId(initialSessionId);
    setHomePinned(false);
  }, [endpoint.id]);

  const refresh = useCallback(async (showSpinner = false): Promise<AcpBridgeState | undefined> => {
    const generation = ++refreshGeneration.current;
    if (showSpinner) setRefreshing(true);
    try {
      const next = await fetchAcpState(endpoint);
      if (generation === refreshGeneration.current) {
        publish(next);
        if (refreshFailedRef.current) {
          refreshFailedRef.current = false;
          setError(undefined);
        }
      }
      return next;
    } catch (caught) {
      if (generation === refreshGeneration.current) {
        refreshFailedRef.current = true;
        setError(errorMessage(caught));
      }
      return undefined;
    } finally {
      if (showSpinner && generation === refreshGeneration.current) setRefreshing(false);
    }
  }, [endpoint, publish]);

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 180 : 140,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    if (!visible) {
      Keyboard.dismiss();
      setSheet(undefined);
    }
  }, [progress, visible]);

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (sheet) setSheet(undefined);
      else onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, sheet, visible]);

  useEffect(() => {
    if (!visible) return;
    void refresh(!orderRef.current);
    const timer = setInterval(() => void refresh(false), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, visible]);

  useEffect(() => {
    if (!visible) return;
    return terminalSocket.onMessage((rawMessage) => {
      const message = rawMessage as unknown as AcpSocketMessage & Partial<AcpBridgeState>;
      if (message.type === "acp_state") {
        const candidate = message.acp ?? message.state ?? message.snapshot ?? message;
        if (isBridgeState(candidate)) publish(candidate);
      } else if (message.type === "acp_session" && message.session) {
        const order = orderRef.current;
        if (!order || message.epoch !== order.epoch || message.sequence <= order.sequence) return;
        orderRef.current = { epoch: message.epoch, sequence: message.sequence };
        setBridge((current) => current ? {
          ...current,
          sequence: message.sequence,
          sessions: mergeSession(current.sessions, message.session as AcpSessionView),
          ...(message.requests ? { requests: message.requests } : {}),
        } : current);
      } else if (message.type === "acp_session" || message.type === "acp_session_removed") {
        const order = orderRef.current;
        if (!order || message.epoch !== order.epoch || message.sequence <= order.sequence) return;
        const removedId = message.type === "acp_session_removed"
          ? message.sessionId
          : message.removedSessionId ?? (message.removed ? message.sessionId : undefined);
        if (!removedId) return;
        orderRef.current = { epoch: message.epoch, sequence: message.sequence };
        setBridge((current) => current ? {
          ...current,
          sequence: message.sequence,
          sessions: current.sessions.filter((candidate) => candidate.id !== removedId),
          requests: (message.requests ?? current.requests).filter((request) => request.sessionId !== removedId),
        } : current);
      }
    });
  }, [publish, visible]);

  useEffect(() => {
    if (!bridge) return;
    if (initialSessionId && initialSelectionApplied.current !== initialSessionId && bridge.sessions.some((session) => session.id === initialSessionId)) {
      initialSelectionApplied.current = initialSessionId;
      setHomePinned(false);
      setActiveSessionId(initialSessionId);
      return;
    }
    if (homePinned) return;
    if (activeSessionId && bridge.sessions.some((session) => session.id === activeSessionId)) return;
    const newest = [...bridge.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    setActiveSessionId(newest?.id);
  }, [activeSessionId, bridge, homePinned, initialSessionId]);

  useEffect(() => {
    if (!visible || !bridge?.requests.length) return;
    const incoming = bridge.requests[0];
    if (lastRequestId.current === incoming.id) return;
    lastRequestId.current = incoming.id;
    inputRef.current?.blur();
    Keyboard.dismiss();
    if (incoming.sessionId && bridge.sessions.some((session) => session.id === incoming.sessionId)) {
      setHomePinned(false);
      setActiveSessionId(incoming.sessionId);
    }
  }, [bridge?.requests, bridge?.sessions, visible]);

  const session = bridge?.sessions.find((candidate) => candidate.id === activeSessionId);
  const agent = bridge?.agents.find((candidate) => candidate.id === session?.agent);
  const activeRequest = bridge?.requests.find((request) => !request.sessionId || request.sessionId === session?.id);
  const canSteer = session?.state === "prompting" && Boolean(agent?.capabilities.steering);
  const canPrompt = session?.state === "ready" || canSteer;
  const isGenerating = session?.state === "prompting" || session?.state === "cancelling";
  const commandMatches = useMemo(() => {
    if (!session || !draft.startsWith("/")) return [];
    const query = draft.slice(1).split(/\s/, 1)[0].toLowerCase();
    return session.availableCommands.filter((command) => command.name.toLowerCase().includes(query)).slice(0, 6);
  }, [draft, session]);
  const timelineItems = session?.timeline.slice(-timelineLimit) ?? [];
  const hiddenTimelineCount = Math.max(0, (session?.timeline.length ?? 0) - timelineItems.length);

  useEffect(() => {
    setTimelineLimit(TIMELINE_PAGE_SIZE);
    followOutputRef.current = true;
    if (streamScrollTimerRef.current) clearTimeout(streamScrollTimerRef.current);
    streamScrollTimerRef.current = undefined;
  }, [session?.id]);

  useEffect(() => {
    if (session?.state !== "prompting" || !followOutputRef.current || streamScrollTimerRef.current) return;
    streamScrollTimerRef.current = setTimeout(() => {
      streamScrollTimerRef.current = undefined;
      listRef.current?.scrollToEnd({ animated: false });
    }, 80);
  }, [session?.state, session?.updatedAt]);

  useEffect(() => () => {
    if (streamScrollTimerRef.current) clearTimeout(streamScrollTimerRef.current);
  }, []);

  const run = useCallback(async (token: string, operation: () => Promise<void>, closeSheet = false) => {
    if (busy) return;
    setBusy(token);
    setError(undefined);
    try {
      await operation();
      await refresh(false);
      if (closeSheet) setSheet(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }, [busy, refresh]);

  const openCreate = useCallback((agentId?: AcpAgentId) => {
    setHomePinned(false);
    setCreateAgent(agentId);
    setSheet("create");
    Keyboard.dismiss();
  }, []);

  const create = useCallback((agentId: AcpAgentId, cwd: string, additionalDirectories: string[]) => {
    const beforeIds = new Set(bridge?.sessions.map((candidate) => candidate.id) ?? []);
    void run("create", async () => {
      const created = await createAcpSession(endpoint, { agent: agentId, cwd, ...(additionalDirectories.length ? { additionalDirectories } : {}) });
      const next = await fetchAcpState(endpoint);
      publish(next);
      const selected = created ?? next.sessions.find((candidate) => !beforeIds.has(candidate.id) && candidate.agent === agentId) ?? [...next.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      setActiveSessionId(selected?.id);
      setHomePinned(false);
    }, true);
  }, [bridge?.sessions, endpoint, publish, run]);

  const load = useCallback((agentId: AcpAgentId, remoteId: string, cwd: string, mode: "load" | "resume") => {
    void run(`agent:${agentId}:load`, async () => {
      const loaded = await loadAcpSession(endpoint, { agent: agentId, sessionId: remoteId, cwd, mode });
      const next = await fetchAcpState(endpoint);
      publish(next);
      const selected = loaded ?? next.sessions.find((candidate) => candidate.agentSessionId === remoteId);
      if (selected) setActiveSessionId(selected.id);
      setHomePinned(false);
    });
  }, [endpoint, publish, run]);

  const chooseImage = useCallback(async () => {
    if (!agent?.capabilities.prompt.image || busy) return;
    Keyboard.dismiss();
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error("Photo library access was denied.");
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.85 });
      const asset = result.canceled ? undefined : result.assets[0];
      if (!asset) return;
      if (!asset.base64) throw new Error("The selected image could not be read.");
      if (asset.base64.length > MAX_IMAGE_BASE64_LENGTH) throw new Error("That image is too large to send. Choose an image under about 16 MB.");
      setPendingImage({ mimeType: imageMimeType(asset.base64, asset.mimeType), data: asset.base64, previewUri: asset.uri, name: asset.fileName ?? "Image" });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [agent?.capabilities.prompt.image, busy]);

  const sendPrompt = useCallback(() => {
    if (!session || !canPrompt || busy || (!draft.trim() && !pendingImage)) return;
    const content: AcpPromptBlockInput[] = [];
    if (pendingImage) content.push({ type: "image", mimeType: pendingImage.mimeType, data: pendingImage.data });
    if (draft.trim()) content.push({ type: "text", text: draft.trim() });
    const sentDraft = draft;
    const sentImage = pendingImage;
    setBusy("prompt");
    setError(undefined);
    promptAcpSession(endpoint, session.id, content, { reportFileChanges: agent?.capabilities.fileChangeReports ? reportFileChanges : undefined })
      .then(async () => {
        setDraft("");
        setPendingImage(undefined);
        Keyboard.dismiss();
        await refresh(false);
      })
      .catch((caught) => {
        setDraft((current) => current || sentDraft);
        setPendingImage((current) => current ?? sentImage);
        setError(errorMessage(caught));
      })
      .finally(() => setBusy(undefined));
  }, [agent?.capabilities.fileChangeReports, busy, canPrompt, draft, endpoint, pendingImage, refresh, reportFileChanges, session]);

  const respond = useCallback(async (requestId: string, response: RespondToAcpRequestInput) => {
    await respondToAcpRequest(endpoint, requestId, response);
    await refresh(false);
  }, [endpoint, refresh]);

  const selectCommand = useCallback((name: string) => {
    setDraft(`/${name} `);
    setSheet(undefined);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const handleFailureAction = useCallback((action: string) => {
    if (!session) return;
    if (action === "login") {
      Keyboard.dismiss();
      setHomePinned(true);
      setActiveSessionId(undefined);
      return;
    }
    if (action === "new_session") {
      openCreate(session.agent);
      return;
    }
    if (action === "retry") {
      const previous = [...session.timeline].reverse().find((item) =>
        item.kind === "user" && (Boolean(item.text?.trim()) || (item.content?.type === "text" && Boolean(item.content.text.trim())))
      );
      const text = previous?.text ?? (previous?.content?.type === "text" ? previous.content.text : undefined);
      if (!text) {
        setError("This turn has no text prompt that can be retried safely. Send it again from the composer.");
        return;
      }
      void run("failure:retry", () => promptAcpSession(
        endpoint,
        session.id,
        [{ type: "text", text }],
        { reportFileChanges: agent?.capabilities.fileChangeReports ? reportFileChanges : undefined }
      ));
      return;
    }
    setError(`The agent advertised an unsupported recovery action: ${action}.`);
  }, [agent?.capabilities.fileChangeReports, endpoint, openCreate, reportFileChanges, run, session]);

  if (!mounted) return null;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [Math.max(24, width * 0.18), 0] });
  const rootSubagents = session?.subagents.filter((subagent) => !subagent.parentId || !session.subagents.some((candidate) => candidate.id === subagent.parentId)) ?? [];

  return (
    <Animated.View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityViewIsModal={visible}
      style={[styles.root, { paddingTop: insets.top, opacity: progress, transform: [{ translateX }] }]}
    >
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Back to terminal" hitSlop={6} style={({ pressed }) => [styles.topButton, pressed && styles.rowPressed]}>
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <Pressable onPress={() => setSheet("sessions")} accessibilityRole="button" accessibilityLabel="Choose agent workspace" style={({ pressed }) => [styles.topIdentity, pressed && styles.rowPressed]}>
            {session ? <View style={styles.headerAgent}>{agentIcon(session.agent, 18)}</View> : <View style={styles.headerAgent}><TerminalGlyph size={18} color={colors.primary} /></View>}
            <View style={styles.headerCopy}>
              <Text style={styles.headerTitle} numberOfLines={1}>{session?.title ?? "Agent workspace"}</Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>{session ? `${agent?.label ?? session.agent} · ${session.cwd}` : `${endpoint.label ?? endpoint.host} · ACP ${bridge?.protocol.version ?? "—"}`}</Text>
            </View>
            <Text style={styles.headerChevron}>⌄</Text>
            {bridge?.requests.length ? <View style={styles.requestCount}><Text style={styles.requestCountText}>{bridge.requests.length}</Text></View> : null}
          </Pressable>
          {session ? (
            <Pressable onPress={() => setSheet("settings")} accessibilityRole="button" accessibilityLabel="Session settings" hitSlop={6} style={({ pressed }) => [styles.topButton, pressed && styles.rowPressed]}><Text style={styles.moreGlyph}>•••</Text></Pressable>
          ) : <View style={styles.topButton} />}
        </View>

        {error ? (
          <Pressable onPress={() => setError(undefined)} accessibilityRole="button" accessibilityLabel="Dismiss error" style={styles.errorBanner}>
            <View style={styles.errorBannerCopy}><Text style={styles.errorBannerTitle}>ACP request failed</Text><Text style={styles.errorBannerText} numberOfLines={3}>{error}</Text></View>
            <CloseIcon size={15} color={colors.destructive} />
          </Pressable>
        ) : null}

        {!bridge && refreshing ? (
          <View style={styles.loading}><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.loadingTitle}>Connecting to agent bridge</Text><Text style={styles.loadingText}>Terminal sessions remain active underneath this workspace.</Text></View>
        ) : session ? (
          <>
            <ScrollView
              ref={listRef}
              style={styles.timeline}
              contentContainerStyle={[styles.timelineContent, { paddingBottom: activeRequest ? 14 : 24 }]}
              keyboardShouldPersistTaps="handled"
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh(true)} tintColor={colors.primary} colors={[colors.primary]} />}
              onScroll={(event) => {
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                followOutputRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 96;
              }}
              scrollEventThrottle={80}
            >
              <View style={styles.sessionOverview}>
                {session.error ? <View style={styles.sessionError}><Text style={styles.sessionErrorText}>{session.error}</Text></View> : null}
                {session.goal ? <GoalCard session={session} onOpen={() => setSheet("goal")} /> : null}
                {session.plan.length ? <PlanCard plan={session.plan} compact /> : null}
                <FailureCards failures={session.failures} disabled={Boolean(busy)} onAction={handleFailureAction} />
                <FileChangeCards reports={session.fileChangeReports} />
                {rootSubagents.length ? (
                  <View style={styles.subagentSection}>
                    <SectionLabel>NATIVE SUBAGENTS</SectionLabel>
                    {rootSubagents.map((subagent) => <SubagentCard key={subagent.id} subagent={subagent} all={session.subagents} session={session} onError={(caught) => setError(errorMessage(caught))} />)}
                  </View>
                ) : null}
              </View>
              {hiddenTimelineCount ? (
                <Pressable
                  onPress={() => setTimelineLimit((current) => current + TIMELINE_PAGE_SIZE)}
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${Math.min(TIMELINE_PAGE_SIZE, hiddenTimelineCount)} earlier updates`}
                  style={({ pressed }) => [styles.earlierButton, pressed && styles.rowPressed]}
                >
                  <Text style={styles.earlierButtonText}>Show {Math.min(TIMELINE_PAGE_SIZE, hiddenTimelineCount)} earlier updates</Text>
                </Pressable>
              ) : null}
              {timelineItems.map((item) => <TimelineRow key={item.id} item={item} session={session} onError={(caught) => setError(errorMessage(caught))} />)}
              {!session.timeline.length && !session.plan.length && !session.goal && !session.failures.length && !session.subagents.length ? (
                <View style={styles.emptyTimeline}><View style={styles.emptyAgent}>{agentIcon(session.agent, 27)}</View><Text style={styles.emptyTitle}>Ready for a task</Text><Text style={styles.emptyText}>Messages, tool calls, plans, permissions, and diffs will appear here as structured ACP updates.</Text></View>
              ) : null}
              {session.usage ? <UsageStrip usage={session.usage} /> : null}
            </ScrollView>

            {activeRequest ? (
              <View style={styles.requestLayer}>
                <AcpRequestCard request={activeRequest} disabled={Boolean(busy)} onRespond={respond} onError={(caught) => setError(errorMessage(caught))} />
              </View>
            ) : (
              <View style={[styles.composerWrap, { paddingBottom: Math.max(8, insets.bottom) }]}>
                {commandMatches.length ? (
                  <View style={styles.commandSuggestions}>
                    {commandMatches.map((command) => (
                      <Pressable key={command.name} onPress={() => selectCommand(command.name)} accessibilityRole="button" style={({ pressed }) => [styles.commandSuggestion, pressed && styles.rowPressed]}>
                        <Text style={styles.commandName}>/{command.name}</Text><Text style={styles.commandSuggestionDescription} numberOfLines={1}>{command.description}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {pendingImage ? (
                  <View style={styles.attachmentPreview}>
                    <Image source={{ uri: pendingImage.previewUri }} style={styles.attachmentImage} />
                    <View style={styles.attachmentCopy}><Text style={styles.attachmentName} numberOfLines={1}>{pendingImage.name}</Text><Text style={styles.attachmentMeta}>IMAGE · READY TO SEND</Text></View>
                    <Pressable onPress={() => setPendingImage(undefined)} accessibilityRole="button" accessibilityLabel="Remove attached image" style={({ pressed }) => [styles.attachmentRemove, pressed && styles.rowPressed]}><CloseIcon size={15} /></Pressable>
                  </View>
                ) : null}
                <View style={[styles.composer, !canPrompt && styles.composerDisabled]}>
                  <View style={styles.composerActions}>
                    {agent?.capabilities.prompt.image ? (
                      <Pressable onPress={() => void chooseImage()} disabled={Boolean(busy)} accessibilityRole="button" accessibilityLabel="Attach image" hitSlop={4} style={({ pressed }) => [styles.composerButton, pressed && styles.composerButtonPressed, busy && styles.disabled]}><ImageIcon size={19} color={colors.accentAmber} /></Pressable>
                    ) : null}
                    {session.availableCommands.length ? (
                      <Pressable onPress={() => setSheet("commands")} accessibilityRole="button" accessibilityLabel="Agent commands" hitSlop={4} style={({ pressed }) => [styles.composerButton, pressed && styles.composerButtonPressed]}><Text style={styles.slashGlyph}>/</Text></Pressable>
                    ) : null}
                  </View>
                  <TextInput
                    ref={inputRef}
                    value={draft}
                    onChangeText={setDraft}
                    editable={canPrompt && !busy}
                    placeholder={session.state === "connecting" ? "Connecting…" : canSteer ? `Steer ${agent?.label ?? "agent"}…` : isGenerating ? "Agent is working…" : "Message the agent…"}
                    placeholderTextColor={colors.faint}
                    multiline
                    autoCapitalize="sentences"
                    autoCorrect
                    accessibilityLabel="Agent message"
                    style={styles.composerInput}
                  />
                  {isGenerating ? (
                    <Pressable onPress={() => void run("cancel", () => cancelAcpSession(endpoint, session.id))} disabled={busy === "cancel" || session.state === "cancelling"} accessibilityRole="button" accessibilityLabel="Stop agent" style={({ pressed }) => [styles.stopButton, pressed && styles.stopPressed, (busy === "cancel" || session.state === "cancelling") && styles.disabled]}>
                      {busy === "cancel" || session.state === "cancelling" ? <ActivityIndicator size="small" color={colors.destructive} /> : <View style={styles.stopMark} />}
                    </Pressable>
                  ) : (
                    <Pressable onPress={sendPrompt} disabled={!canPrompt || Boolean(busy) || (!draft.trim() && !pendingImage)} accessibilityRole="button" accessibilityLabel="Send to agent" style={({ pressed }) => [styles.sendButton, pressed && styles.primaryPressed, (!canPrompt || Boolean(busy) || (!draft.trim() && !pendingImage)) && styles.sendDisabled]}>
                      {busy === "prompt" ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <SendIcon size={17} color={colors.primaryForeground} />}
                    </Pressable>
                  )}
                </View>
                <View style={styles.composerFoot}>
                  <Text style={styles.composerHint}>{canSteer ? "STEERING CURRENT TURN" : `${agent?.label?.toUpperCase() ?? session.agent.toUpperCase()} · ACP`}</Text>
                  {agent?.capabilities.fileChangeReports && reportFileChanges ? <Text style={styles.composerHint}>FILE REPORT ON</Text> : null}
                </View>
              </View>
            )}
          </>
        ) : bridge ? (
          <>
            <AgentHome
              agents={bridge.agents}
              sessions={bridge.sessions}
              requests={bridge.requests}
              refreshing={refreshing}
              onRefresh={() => void refresh(true)}
              onOpenSession={(id) => { setHomePinned(false); setActiveSessionId(id); }}
              onCreate={openCreate}
              onStart={(agentId) => void run(`agent:${agentId}:start`, () => startAcpAgent(endpoint, agentId))}
              onAuthenticate={(agentId, methodId) => void run(`agent:${agentId}:auth`, () => authenticateAcpAgent(endpoint, agentId, methodId))}
              onLogout={(agentId) => void run(`agent:${agentId}:logout`, () => logoutAcpAgent(endpoint, agentId))}
              onLoad={load}
              busy={busy}
            />
            {activeRequest ? (
              <View style={[styles.requestLayer, { paddingBottom: Math.max(10, insets.bottom) }]}>
                <AcpRequestCard request={activeRequest} disabled={Boolean(busy)} onRespond={respond} onError={(caught) => setError(errorMessage(caught))} />
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.loading}><Text style={styles.emptyTitle}>Agent bridge unavailable</Text><Text style={styles.emptyText}>{error ?? "Pull to retry when the desktop bridge is ready."}</Text><Pressable onPress={() => void refresh(true)} style={styles.primaryCompact}><Text style={styles.primaryCompactText}>Retry</Text></Pressable></View>
        )}
      </KeyboardAvoidingView>

      <SessionPickerSheet
        visible={sheet === "sessions"}
        sessions={bridge?.sessions ?? []}
        requests={bridge?.requests ?? []}
        activeId={activeSessionId}
        onClose={() => setSheet(undefined)}
        onSelect={(id) => { setHomePinned(false); setActiveSessionId(id); setSheet(undefined); }}
        onHome={() => { setHomePinned(true); setActiveSessionId(undefined); setSheet(undefined); }}
        onNew={() => openCreate()}
      />
      <CreateSessionSheet
        visible={sheet === "create"}
        agents={bridge?.agents ?? []}
        initialAgent={createAgent}
        initialCwd={defaultCwd ?? session?.cwd}
        busy={busy === "create"}
        onClose={() => setSheet(undefined)}
        onCreate={create}
      />
      <SessionSettingsSheet
        visible={sheet === "settings"}
        session={session}
        agent={agent}
        busy={Boolean(busy)}
        reportFileChanges={reportFileChanges}
        deleteArmed={deleteArmed}
        onClose={() => { setSheet(undefined); setDeleteArmed(false); }}
        onSetMode={(modeId, confirmDangerous) => session && void run("mode", () => setAcpSessionMode(endpoint, session.id, modeId, confirmDangerous))}
        onSetConfig={(option, value, confirmDangerous) => session && void run(`config:${option.id}`, () => setAcpSessionConfig(endpoint, session.id, option.id, value, confirmDangerous))}
        onToggleFileReports={() => setReportFileChanges((current) => !current)}
        onOpenGoal={() => setSheet("goal")}
        onFork={() => {
          if (!session) return;
          void run("fork", async () => {
            const forked = await forkAcpSession(endpoint, session.id, session.cwd);
            const next = await fetchAcpState(endpoint);
            publish(next);
            const selected = forked ?? [...next.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            setActiveSessionId(selected?.id);
            setHomePinned(false);
          }, true);
        }}
        onCloseSession={() => {
          if (!session) return;
          void run("close", async () => {
            await closeAcpSession(endpoint, session.id);
            setActiveSessionId(undefined);
            setHomePinned(true);
          }, true);
        }}
        onDelete={() => {
          if (!session) return;
          if (!deleteArmed) { setDeleteArmed(true); return; }
          void run("delete", async () => { await deleteAcpSession(endpoint, session.id); setActiveSessionId(undefined); }, true);
        }}
      />
      <CommandsSheet visible={sheet === "commands"} session={session} onClose={() => setSheet(undefined)} onChoose={selectCommand} />
      <GoalSheet
        visible={sheet === "goal"}
        session={session}
        actions={agent?.capabilities.goal.actions ?? []}
        busy={busy === "goal"}
        onClose={() => setSheet(undefined)}
        onAction={(action, objective) => session && void run("goal", () => actOnAcpGoal(endpoint, session.id, { action, ...(objective ? { objective } : {}) }))}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 120,
    elevation: 120,
    backgroundColor: colors.background,
  },
  flex: { flex: 1 },
  disabled: { opacity: 0.45 },
  rowPressed: { backgroundColor: colors.selection },
  topBar: {
    height: 58,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 6,
  },
  topButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  backGlyph: { color: colors.foreground, fontSize: 36, lineHeight: 38, fontFamily: font.regular, marginTop: -3 },
  moreGlyph: { color: colors.secondaryForeground, fontSize: 15, letterSpacing: 1.5, fontFamily: font.bold },
  topIdentity: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: radius.md, paddingHorizontal: 7 },
  headerAgent: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { color: colors.foreground, fontSize: 14, lineHeight: 18, fontFamily: font.semibold },
  headerSubtitle: { color: colors.mutedForeground, fontSize: 10, lineHeight: 14, fontFamily: font.regular },
  headerChevron: { color: colors.mutedForeground, fontSize: 15, fontFamily: font.regular },
  chevron: { color: colors.mutedForeground, fontSize: 22, fontFamily: font.regular },
  requestCount: { minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.primary },
  requestCountText: { color: colors.primaryForeground, fontSize: 11, fontFamily: font.bold },
  errorBanner: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: withAlpha(colors.destructive, 0.12), borderBottomWidth: 1, borderBottomColor: withAlpha(colors.destructive, 0.35) },
  errorBannerCopy: { flex: 1, gap: 1 },
  errorBannerTitle: { color: colors.destructive, fontSize: 11, fontFamily: font.semibold },
  errorBannerText: { color: colors.secondaryForeground, fontSize: 11, lineHeight: 15, fontFamily: font.regular },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 36 },
  loadingTitle: { color: colors.foreground, fontSize: 16, fontFamily: font.semibold, textAlign: "center" },
  loadingText: { color: colors.mutedForeground, fontSize: 12, lineHeight: 18, fontFamily: font.regular, textAlign: "center" },

  homeList: { flex: 1 },
  homeContent: { padding: 14, paddingBottom: 60, gap: 12 },
  homeHeader: { gap: 10 },
  homeKicker: { color: colors.primary, fontSize: 10, letterSpacing: 1, fontFamily: font.semibold, marginTop: 4 },
  homeTitle: { color: colors.foreground, fontSize: 22, lineHeight: 28, fontFamily: font.semibold, maxWidth: 360 },
  homeIntro: { color: colors.secondaryForeground, fontSize: 13, lineHeight: 19, fontFamily: font.regular, maxWidth: 520, marginBottom: 8 },
  homeSection: { gap: 7, marginBottom: 10 },
  sectionLabel: { color: colors.mutedForeground, fontSize: 10, letterSpacing: 0.9, fontFamily: font.semibold, marginTop: 3, marginBottom: 1 },
  providerCard: { marginBottom: 12, borderWidth: 1, borderRadius: radius.lg, backgroundColor: colors.surface, padding: 12, gap: 11 },
  providerHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  providerIcon: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1 },
  providerCopy: { flex: 1, minWidth: 0, gap: 2 },
  providerName: { color: colors.foreground, fontSize: 15, fontFamily: font.semibold },
  providerImpl: { color: colors.mutedForeground, fontSize: 10, fontFamily: font.regular },
  providerError: { color: colors.destructive, fontSize: 11, lineHeight: 16, fontFamily: font.regular, padding: 8, borderRadius: radius.md, backgroundColor: withAlpha(colors.destructive, 0.08) },
  capabilityRow: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 3 },
  tag: { minHeight: 21, justifyContent: "center", paddingHorizontal: 7, borderRadius: radius.sm, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border },
  tagText: { color: colors.mutedForeground, fontSize: 8, letterSpacing: 0.55, fontFamily: font.semibold },
  providerActions: { flexDirection: "row", gap: 8 },
  primaryCompact: { minHeight: 40, minWidth: 102, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.primary },
  primaryCompactText: { color: colors.primaryForeground, fontSize: 12, fontFamily: font.semibold },
  primaryPressed: { backgroundColor: colors.primaryDim },
  secondaryCompact: { minHeight: 40, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceAlt },
  secondaryCompactText: { color: colors.secondaryForeground, fontSize: 12, fontFamily: font.semibold },
  authList: { gap: 5, paddingTop: 2 },
  authRow: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 9, paddingVertical: 7, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  authCopy: { flex: 1, gap: 2 },
  authName: { color: colors.foreground, fontSize: 12, fontFamily: font.semibold },
  authDescription: { color: colors.mutedForeground, fontSize: 10, lineHeight: 14, fontFamily: font.regular },
  authType: { color: colors.primary, fontSize: 8, letterSpacing: 0.6, fontFamily: font.semibold },
  remoteList: { gap: 4, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 9 },
  remoteLabel: { color: colors.mutedForeground, fontSize: 9, letterSpacing: 0.7, fontFamily: font.semibold, marginBottom: 2 },
  remoteRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, borderRadius: radius.md },
  remoteCopy: { flex: 1, minWidth: 0 },
  remoteTitle: { color: colors.foreground, fontSize: 12, fontFamily: font.semibold },
  remotePath: { color: colors.mutedForeground, fontSize: 10, fontFamily: font.mono },
  remoteAction: { color: colors.primary, fontSize: 11, fontFamily: font.semibold },
  emptyCard: { minHeight: 180, alignItems: "center", justifyContent: "center", gap: 8, padding: 22, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  emptyTitle: { color: colors.foreground, fontSize: 15, fontFamily: font.semibold, textAlign: "center" },
  emptyText: { color: colors.mutedForeground, fontSize: 12, lineHeight: 18, fontFamily: font.regular, textAlign: "center" },

  stateBadge: { minHeight: 23, maxWidth: 104, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 7, borderRadius: radius.pill, borderWidth: 1 },
  stateDot: { width: 6, height: 6, borderRadius: radius.pill },
  stateBadgeText: { fontSize: 9, lineHeight: 12, textTransform: "capitalize", fontFamily: font.semibold },
  sessionRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 9, paddingVertical: 7, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  sessionRowSelected: { borderColor: withAlpha(colors.primary, 0.5), backgroundColor: colors.selection },
  sessionAgent: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  sessionCopy: { flex: 1, minWidth: 0, gap: 2 },
  sessionTitle: { color: colors.foreground, fontSize: 13, fontFamily: font.semibold },
  sessionMeta: { color: colors.mutedForeground, fontSize: 10, fontFamily: font.regular },
  newWorkspaceRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 10, padding: 8, borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.3), backgroundColor: withAlpha(colors.primary, 0.07), marginBottom: 7 },
  newWorkspaceMark: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: withAlpha(colors.primary, 0.14), borderWidth: 1, borderColor: withAlpha(colors.primary, 0.32) },
  newWorkspacePlus: { color: colors.primary, fontSize: 24, lineHeight: 25, fontFamily: font.regular },

  timeline: { flex: 1, backgroundColor: colors.background },
  timelineContent: { paddingHorizontal: 12, paddingTop: 12, gap: 10 },
  earlierButton: { minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  earlierButtonText: { color: colors.primary, fontSize: 11, fontFamily: font.semibold },
  sessionOverview: { gap: 10, marginBottom: 2 },
  sessionError: { padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(colors.destructive, 0.35), backgroundColor: withAlpha(colors.destructive, 0.09) },
  sessionErrorText: { color: colors.destructive, fontSize: 12, lineHeight: 17, fontFamily: font.regular },
  emptyTimeline: { minHeight: 250, alignItems: "center", justifyContent: "center", gap: 9, padding: 30 },
  emptyAgent: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong },
  messageRow: { alignSelf: "stretch", flexDirection: "row", alignItems: "flex-start", gap: 7, marginVertical: 2 },
  messageRowUser: { justifyContent: "flex-end", paddingLeft: 46 },
  agentMini: { width: 26, height: 26, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.surfaceAlt, marginTop: 2 },
  messageBubble: { maxWidth: "88%", paddingHorizontal: 11, paddingVertical: 9, borderRadius: radius.lg, borderWidth: 1 },
  userBubble: { backgroundColor: withAlpha(colors.primary, 0.11), borderColor: withAlpha(colors.primary, 0.25) },
  agentBubble: { backgroundColor: colors.surface, borderColor: colors.border },
  messageTitle: { color: colors.foreground, fontSize: 12, fontFamily: font.semibold, marginBottom: 4 },
  timelineText: { color: colors.secondaryForeground, fontSize: 13, lineHeight: 19, fontFamily: font.regular },
  messageTime: { color: colors.faint, fontSize: 8, fontFamily: font.regular, alignSelf: "flex-end", marginTop: 4 },
  thoughtCard: { padding: 9, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  thoughtHead: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: 7 },
  thoughtGlyph: { color: colors.primary, fontSize: 15, fontFamily: font.regular },
  thoughtTitle: { flex: 1, color: colors.mutedForeground, fontSize: 11, letterSpacing: 0.25, fontFamily: font.semibold },
  thoughtText: { color: colors.mutedForeground, fontSize: 12, lineHeight: 18, fontFamily: font.regular, paddingTop: 5, paddingLeft: 22 },
  expandGlyph: { color: colors.mutedForeground, fontSize: 14, fontFamily: font.regular },
  statusCard: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderLeftWidth: 2, borderLeftColor: colors.primary },
  errorCard: { borderLeftColor: colors.destructive, backgroundColor: withAlpha(colors.destructive, 0.08) },
  statusTitle: { color: colors.primary, fontSize: 10, letterSpacing: 0.4, fontFamily: font.semibold },
  errorText: { color: colors.destructive },
  statusText: { color: colors.secondaryForeground, fontSize: 12, lineHeight: 17, fontFamily: font.regular, marginTop: 3 },
  extensionCard: { padding: 9, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  extensionMethod: { color: colors.primary, fontSize: 9, fontFamily: font.monoSemibold },
  extensionSummary: { color: colors.secondaryForeground, fontSize: 12, lineHeight: 17, fontFamily: font.regular, marginTop: 4 },
  contentImage: { width: "100%", minHeight: 180, maxHeight: 360, borderRadius: radius.md, backgroundColor: colors.terminal },
  resourceCard: { padding: 9, gap: 3, borderRadius: radius.md, backgroundColor: colors.terminal, borderWidth: 1, borderColor: colors.border },
  resourceType: { color: colors.primary, fontSize: 9, letterSpacing: 0.7, fontFamily: font.semibold },
  resourceTitle: { color: colors.foreground, fontSize: 12, fontFamily: font.semibold },
  resourceUri: { color: colors.primary, fontSize: 10, lineHeight: 14, fontFamily: font.mono },
  resourcePreview: { color: colors.mutedForeground, fontSize: 11, lineHeight: 16, fontFamily: font.regular, marginTop: 4 },

  metaStack: { gap: 7 },
  metaCard: { padding: 10, gap: 7, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  metaCardCompact: { backgroundColor: colors.surfaceAlt },
  metaHead: { minHeight: 24, flexDirection: "row", alignItems: "center", gap: 7 },
  metaGlyph: { color: colors.primary, fontSize: 15, fontFamily: font.monoSemibold },
  metaTitle: { flex: 1, color: colors.foreground, fontSize: 12, fontFamily: font.semibold },
  metaCount: { color: colors.mutedForeground, fontSize: 10, fontFamily: font.mono },
  metaHint: { color: colors.mutedForeground, fontSize: 10, lineHeight: 15, fontFamily: font.regular },
  planRow: { minHeight: 30, flexDirection: "row", alignItems: "flex-start", gap: 8 },
  planMark: { width: 17, height: 17, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderStrong, marginTop: 1 },
  planMarkDone: { backgroundColor: colors.success, borderColor: colors.success },
  planMarkActive: { borderColor: colors.accentAmber, backgroundColor: withAlpha(colors.accentAmber, 0.12) },
  planCheck: { color: colors.primaryForeground, fontSize: 10, fontFamily: font.bold },
  planText: { flex: 1, color: colors.secondaryForeground, fontSize: 12, lineHeight: 17, fontFamily: font.regular },
  planTextDone: { color: colors.mutedForeground, textDecorationLine: "line-through" },
  priorityMark: { width: 5, height: 5, borderRadius: radius.pill, backgroundColor: colors.destructive, marginTop: 6 },
  usageStrip: { padding: 9, gap: 7, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  usageHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  usageLabel: { color: colors.primary, fontSize: 9, letterSpacing: 0.7, fontFamily: font.semibold },
  usageValue: { flex: 1, color: colors.mutedForeground, fontSize: 9, fontFamily: font.mono, textAlign: "right" },
  usageTrack: { height: 3, borderRadius: radius.pill, backgroundColor: colors.surfaceHi, overflow: "hidden" },
  usageFill: { height: "100%", backgroundColor: colors.primary, borderRadius: radius.pill },
  goalCard: { padding: 10, gap: 7, borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(colors.accentAmber, 0.3), backgroundColor: withAlpha(colors.accentAmber, 0.07) },
  goalHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  goalEyebrow: { color: colors.accentAmber, fontSize: 9, letterSpacing: 0.75, fontFamily: font.semibold },
  goalObjective: { color: colors.foreground, fontSize: 13, lineHeight: 18, fontFamily: font.semibold },
  goalReason: { color: colors.mutedForeground, fontSize: 11, lineHeight: 16, fontFamily: font.regular },
  goalBudgetRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  goalBudgetTrack: { flex: 1, height: 3, borderRadius: radius.pill, backgroundColor: colors.surfaceHi, overflow: "hidden" },
  goalBudgetFill: { height: "100%", backgroundColor: colors.accentAmber },
  goalBudgetText: { color: colors.mutedForeground, fontSize: 9, fontFamily: font.mono },
  failureCard: { padding: 10, gap: 5, borderRadius: radius.md, borderWidth: 1, backgroundColor: colors.surface },
  failureHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  failureKind: { fontSize: 9, letterSpacing: 0.7, fontFamily: font.semibold },
  failureRevision: { color: colors.faint, fontSize: 8, fontFamily: font.mono },
  failureTitle: { color: colors.foreground, fontSize: 12, fontFamily: font.semibold },
  failureDetails: { color: colors.secondaryForeground, fontSize: 11, lineHeight: 16, fontFamily: font.regular },
  failureActions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 3 },
  failureAction: { minHeight: 32, justifyContent: "center", paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceHi },
  failureActionText: { color: colors.secondaryForeground, fontSize: 10, textTransform: "capitalize", fontFamily: font.semibold },
  changeCard: { padding: 10, gap: 5, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  changePath: { color: colors.primary, fontSize: 10, lineHeight: 15, fontFamily: font.mono },

  toolCard: { borderWidth: 1, borderRadius: radius.md, backgroundColor: colors.surface, overflow: "hidden" },
  toolHead: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 9, paddingVertical: 7 },
  toolKind: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: radius.md },
  toolKindText: { fontSize: 13, fontFamily: font.monoSemibold },
  toolCopy: { flex: 1, minWidth: 0, gap: 2 },
  toolName: { color: colors.foreground, fontSize: 12, lineHeight: 16, fontFamily: font.semibold },
  toolMeta: { color: colors.mutedForeground, fontSize: 9, textTransform: "capitalize", fontFamily: font.regular },
  toolBody: { gap: 8, padding: 9, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceAlt },
  rawJson: { color: colors.secondaryForeground, fontSize: 10, lineHeight: 15, fontFamily: font.mono, padding: 8, borderRadius: radius.md, backgroundColor: colors.terminal },
  terminalCard: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.terminal, overflow: "hidden" },
  terminalHead: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 9, borderBottomWidth: 1, borderBottomColor: colors.border },
  terminalCommand: { flex: 1, color: colors.foreground, fontSize: 10, fontFamily: font.monoSemibold },
  terminalCwd: { color: colors.mutedForeground, fontSize: 9, fontFamily: font.mono, paddingHorizontal: 9, paddingTop: 7 },
  terminalOutputScroll: { maxHeight: 300 },
  terminalOutput: { color: colors.secondaryForeground, fontSize: 10, lineHeight: 15, fontFamily: font.mono, padding: 9 },
  diffCard: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.terminal, overflow: "hidden" },
  diffHead: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 9, borderBottomWidth: 1, borderBottomColor: colors.border },
  diffGlyph: { color: colors.primary, fontSize: 14, fontFamily: font.monoSemibold },
  diffPath: { flex: 1, color: colors.foreground, fontSize: 10, lineHeight: 14, fontFamily: font.monoSemibold },
  diffRemoved: { padding: 7, backgroundColor: withAlpha(colors.destructive, 0.08) },
  diffRemovedText: { color: colors.accentCoral, fontSize: 9, lineHeight: 14, fontFamily: font.mono },
  diffAdded: { padding: 7, backgroundColor: withAlpha(colors.success, 0.07) },
  diffAddedText: { color: colors.success, fontSize: 9, lineHeight: 14, fontFamily: font.mono },

  subagentSection: { gap: 7 },
  subagentCard: { borderWidth: 1, borderColor: withAlpha(colors.primary, 0.24), borderRadius: radius.md, backgroundColor: colors.surface, overflow: "hidden" },
  subagentNested: { marginLeft: 10, borderColor: colors.borderStrong },
  subagentHead: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 8, padding: 8 },
  subagentBranch: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: withAlpha(colors.primary, 0.1) },
  subagentBranchText: { color: colors.primary, fontSize: 15, fontFamily: font.monoSemibold },
  subagentName: { color: colors.foreground, fontSize: 12, fontFamily: font.semibold },
  subagentTask: { color: colors.mutedForeground, fontSize: 10, lineHeight: 14, fontFamily: font.regular },
  subagentBody: { gap: 7, padding: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceAlt },

  requestLayer: { paddingHorizontal: 10, paddingTop: 7, paddingBottom: 10, backgroundColor: colors.background, borderTopWidth: 1, borderTopColor: colors.border },
  composerWrap: { paddingHorizontal: 9, paddingTop: 7, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  composer: { minHeight: 52, maxHeight: 150, flexDirection: "row", alignItems: "flex-end", borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, padding: 5 },
  composerDisabled: { borderColor: colors.border },
  composerActions: { flexDirection: "row", alignItems: "center" },
  composerButton: { width: 39, height: 39, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  composerButtonPressed: { backgroundColor: colors.surfaceHi },
  slashGlyph: { color: colors.primary, fontSize: 22, lineHeight: 24, fontFamily: font.monoSemibold },
  composerInput: { flex: 1, minHeight: 40, maxHeight: 130, color: colors.foreground, fontSize: 14, lineHeight: 19, fontFamily: font.regular, paddingHorizontal: 7, paddingVertical: 9, textAlignVertical: "top" },
  sendButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.primary },
  sendDisabled: { opacity: 0.32 },
  stopButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(colors.destructive, 0.35), backgroundColor: withAlpha(colors.destructive, 0.1) },
  stopPressed: { backgroundColor: withAlpha(colors.destructive, 0.2) },
  stopMark: { width: 12, height: 12, borderRadius: 2, backgroundColor: colors.destructive },
  composerFoot: { minHeight: 19, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 3, paddingTop: 4 },
  composerHint: { color: colors.faint, fontSize: 8, letterSpacing: 0.55, fontFamily: font.semibold },
  commandSuggestions: { maxHeight: 246, gap: 2, marginBottom: 5, padding: 5, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceAlt },
  commandSuggestion: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 8, borderRadius: radius.md },
  commandSuggestionDescription: { flex: 1, color: colors.mutedForeground, fontSize: 10, fontFamily: font.regular },
  attachmentPreview: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 9, padding: 6, marginBottom: 6, borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(colors.accentAmber, 0.3), backgroundColor: withAlpha(colors.accentAmber, 0.07) },
  attachmentImage: { width: 42, height: 42, borderRadius: radius.md, backgroundColor: colors.terminal },
  attachmentCopy: { flex: 1, gap: 2 },
  attachmentName: { color: colors.foreground, fontSize: 11, fontFamily: font.semibold },
  attachmentMeta: { color: colors.accentAmber, fontSize: 8, letterSpacing: 0.55, fontFamily: font.semibold },
  attachmentRemove: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.md },

  sheetScroll: { maxHeight: 540 },
  sheetContent: { gap: 6, paddingBottom: 8 },
  formSheetContent: { gap: 10, paddingBottom: 8 },
  settingsScroll: { maxHeight: 620 },
  settingsContent: { gap: 14, paddingBottom: 8 },
  sheetHint: { color: colors.mutedForeground, fontSize: 11, lineHeight: 16, fontFamily: font.regular },
  inputLabel: { color: colors.mutedForeground, fontSize: 9, letterSpacing: 0.75, fontFamily: font.semibold, marginTop: 3 },
  workspaceInput: { minHeight: 43, color: colors.foreground, fontSize: 13, fontFamily: font.regular, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, paddingHorizontal: 11, paddingVertical: 9 },
  monoWorkspaceInput: { fontFamily: font.mono, fontSize: 12 },
  directoryInput: { minHeight: 82, textAlignVertical: "top" },
  goalInput: { minHeight: 90, textAlignVertical: "top" },
  formWarning: { color: colors.accentAmber, fontSize: 11, lineHeight: 16, fontFamily: font.regular },
  sheetPrimary: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.primary, marginTop: 3 },
  primaryButtonText: { color: colors.primaryForeground, fontSize: 13, fontFamily: font.semibold },
  segmented: { flexDirection: "row", gap: 6, padding: 3, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  segment: { flex: 1, minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: radius.sm },
  segmentSelected: { backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.45) },
  segmentText: { color: colors.mutedForeground, fontSize: 12, fontFamily: font.semibold },
  segmentTextSelected: { color: colors.foreground },
  settingsSection: { gap: 6 },
  settingsRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, padding: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  settingsRowSelected: { borderColor: withAlpha(colors.primary, 0.45), backgroundColor: colors.selection },
  radioMark: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong },
  radioMarkSelected: { borderColor: colors.primary },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.primary },
  settingsCopy: { flex: 1, minWidth: 0, gap: 2 },
  settingsName: { color: colors.foreground, fontSize: 12, fontFamily: font.semibold },
  settingsDescription: { color: colors.mutedForeground, fontSize: 10, lineHeight: 14, fontFamily: font.regular },
  configBlock: { gap: 8, padding: 9, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  configHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  configOptions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  configChip: { minHeight: 34, justifyContent: "center", paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  configChipSelected: { borderColor: colors.primary, backgroundColor: colors.selection },
  configChipText: { color: colors.secondaryForeground, fontSize: 10, fontFamily: font.semibold },
  configChipTextSelected: { color: colors.primary },
  dangerSettingArmed: { borderColor: colors.accentCoral, backgroundColor: withAlpha(colors.accentCoral, 0.1) },
  dangerSettingText: { color: colors.accentCoral, fontSize: 10, lineHeight: 14, fontFamily: font.semibold },
  switchTrack: { width: 42, height: 24, borderRadius: radius.pill, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.borderStrong, padding: 2 },
  switchTrackOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  switchThumb: { width: 18, height: 18, borderRadius: radius.pill, backgroundColor: colors.mutedForeground },
  switchThumbOn: { marginLeft: 18, backgroundColor: colors.primaryForeground },
  preferenceRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: 12, padding: 9, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  sessionDetails: { gap: 4, padding: 9, borderRadius: radius.md, backgroundColor: colors.terminal, borderWidth: 1, borderColor: colors.border },
  detailKey: { color: colors.mutedForeground, fontSize: 9, fontFamily: font.semibold, marginTop: 4 },
  detailValue: { color: colors.secondaryForeground, fontSize: 10, lineHeight: 15, fontFamily: font.mono },
  deleteButton: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(colors.destructive, 0.38), backgroundColor: withAlpha(colors.destructive, 0.07) },
  deleteButtonArmed: { backgroundColor: colors.destructive, borderColor: colors.destructive },
  deletePressed: { backgroundColor: withAlpha(colors.destructive, 0.18) },
  deleteButtonText: { color: colors.destructive, fontSize: 12, fontFamily: font.semibold },
  commandSheetList: { maxHeight: 460, marginTop: 8 },
  commandSheetContent: { gap: 3, paddingBottom: 8 },
  commandRow: { minHeight: 52, flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 9, borderRadius: radius.md },
  commandName: { color: colors.primary, fontSize: 11, fontFamily: font.monoSemibold },
  commandCopy: { flex: 1, gap: 2 },
  commandDescription: { color: colors.secondaryForeground, fontSize: 11, lineHeight: 15, fontFamily: font.regular },
  commandHint: { color: colors.mutedForeground, fontSize: 9, fontFamily: font.mono },
  goalActions: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  goalAction: { minHeight: 40, paddingHorizontal: 13, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.35), backgroundColor: withAlpha(colors.primary, 0.09) },
  goalActionDanger: { borderColor: withAlpha(colors.destructive, 0.35), backgroundColor: withAlpha(colors.destructive, 0.08) },
  goalActionText: { color: colors.primary, fontSize: 11, textTransform: "capitalize", fontFamily: font.semibold },
  goalActionTextDanger: { color: colors.destructive },
});

import { memo, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OrchestratorItem, OrchestratorStatus } from "../orchestratorTypes";
import type { SocketStatus } from "../lib/socket";
import { loadDraft, saveDraft } from "../lib/storage";
import { colors, font, radius } from "../theme";

interface Props {
  visible: boolean;
  endpointId: string;
  status?: OrchestratorStatus;
  socketStatus: SocketStatus;
  error?: string;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onClose: () => void;
}

const DRAFT_ID = "__orchestrator_chat__";

const TranscriptRow = memo(function TranscriptRow({ item }: { item: OrchestratorItem }) {
  const [expanded, setExpanded] = useState(false);
  const isTool = item.role === "tool";
  return (
    <View style={[styles.message, item.role === "user" && styles.userMessage]}>
      <Text style={styles.role}>{item.role === "user" ? "You" : isTool ? item.tool?.name ?? "Tool" : "Orchestrator"}</Text>
      {isTool ? (
        <Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button" accessibilityLabel={`${expanded ? "Hide" : "Show"} tool details`}>
          <Text style={[styles.messageText, item.tool?.ok === false && styles.errorText]}>{item.tool?.summary || item.text || "Tool finished"} {expanded ? "⌃" : "⌄"}</Text>
          {expanded ? <Text selectable style={styles.toolDetails}>{item.tool?.result || item.text}</Text> : null}
        </Pressable>
      ) : <Text selectable style={[styles.messageText, item.role === "error" && styles.errorText]}>{item.text || (item.toolCalls?.length ? `Using ${item.toolCalls.map((tool) => tool.name).join(", ")}…` : item.status === "streaming" ? "Thinking…" : "")}</Text>}
      {item.status === "cancelled" ? <Text style={styles.meta}>Stopped</Text> : null}
    </View>
  );
});

export function OrchestratorChat({ visible, endpointId, status, socketStatus, error, refreshing, onRefresh, onSend, onCancel, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [keyboardHidden, setKeyboardHidden] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const draftRef = useRef("");
  const draftLoaded = useRef(false);
  const pending = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<OrchestratorItem>>(null);
  const nearBottom = useRef(true);
  const running = status?.state === "running";
  const connected = socketStatus === "open";
  const canSend = connected && status?.state === "idle" && !busy && Boolean(draft.trim());
  const unavailable = status?.state === "unavailable";
  const unconfigured = status?.state === "unconfigured";

  function changeDraft(value: string) { draftRef.current = value; setDraft(value); }

  useEffect(() => {
    let alive = true;
    void loadDraft(endpointId, DRAFT_ID).then((value) => {
      if (!alive) return;
      draftLoaded.current = true;
      if (!draftRef.current) changeDraft(value);
    });
    return () => {
      alive = false;
      if (draftLoaded.current || draftRef.current) void saveDraft(endpointId, DRAFT_ID, draftRef.current);
    };
  }, [endpointId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (draftLoaded.current || draft) void saveDraft(endpointId, DRAFT_ID, draft);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, endpointId]);

  useEffect(() => {
    if (!visible) return;
    void onRefresh();
    nearBottom.current = true;
    setShowLatest(false);
  }, [visible, onRefresh]);

  useEffect(() => {
    if (!visible || !connected) return;
    const timer = setInterval(() => void onRefresh(), 15000);
    return () => clearInterval(timer);
  }, [visible, connected, onRefresh]);

  useEffect(() => {
    if (!visible || keyboardHidden) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 200);
    return () => clearTimeout(timer);
  }, [visible, keyboardHidden]);

  async function send() {
    if (!canSend || pending.current) return;
    const text = draftRef.current.trim();
    pending.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      await onSend(text);
      changeDraft("");
      void saveDraft(endpointId, DRAFT_ID, "");
      nearBottom.current = true;
      listRef.current?.scrollToEnd({ animated: true });
    } catch (cause) {
      setNotice(`${cause instanceof Error ? cause.message : "Send not confirmed."} Draft kept. Check the conversation before retrying.`);
      void onRefresh();
    } finally { pending.current = false; setBusy(false); }
  }

  async function stop() {
    if (!connected || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(undefined);
    try { await onCancel(); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "Could not stop the orchestrator."); }
    finally { pending.current = false; setBusy(false); }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <KeyboardAvoidingView behavior="padding" style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Back to sessions" style={styles.button}><Text style={styles.buttonText}>‹ Back</Text></Pressable>
          <View style={styles.heading}><Text style={styles.title}>Orchestrator</Text><Text style={styles.meta}>{!connected ? "Reconnecting…" : running ? status.activeTurn?.step || "Working…" : "Shared with desktop"}</Text></View>
          <Pressable onPress={() => void onRefresh()} disabled={refreshing} accessibilityRole="button" accessibilityLabel="Refresh orchestrator" style={styles.button}>{refreshing ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.buttonText}>↻</Text>}</Pressable>
        </View>
        <FlatList
          ref={listRef}
          data={status?.transcript ?? []}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <TranscriptRow item={item} />}
          contentContainerStyle={styles.messages}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
            setShowLatest(!nearBottom.current);
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => { if (nearBottom.current) listRef.current?.scrollToEnd({ animated: false }); }}
          ListEmptyComponent={<View style={styles.empty}><Text style={styles.title}>{unavailable ? "Connect to your desktop" : unconfigured ? "Set up Orchestrator on desktop" : "Your desktop, from here"}</Text><Text style={styles.meta}>{unavailable ? "This host does not provide the shared chat." : unconfigured ? "Choose a model and configure its provider in the desktop Orchestrator settings. This chat will use the same setup." : "Ask what is running, check progress, or ask Orchestrator to work with your terminal sessions."}</Text></View>}
        />
        {showLatest ? <Pressable style={styles.latest} onPress={() => { nearBottom.current = true; setShowLatest(false); listRef.current?.scrollToEnd({ animated: true }); }} accessibilityRole="button"><Text style={styles.buttonText}>Latest messages ↓</Text></Pressable> : null}
        {notice || error || status?.error ? <Text selectable style={[styles.notice, styles.errorText]}>{notice || error || status?.error}</Text> : null}
        <View style={styles.composer}>
          <TextInput ref={inputRef} value={draft} onChangeText={changeDraft} editable={!busy} multiline submitBehavior="newline" placeholder={running ? "Draft your next message…" : "Message Orchestrator…"} placeholderTextColor={colors.faint} style={styles.input} accessibilityLabel="Message the desktop orchestrator" onFocus={() => setKeyboardHidden(false)} />
          <View style={styles.actions}>
            <Pressable onPress={() => { if (!keyboardHidden) { inputRef.current?.blur(); Keyboard.dismiss(); } setKeyboardHidden((hidden) => !hidden); }} accessibilityRole="button" style={styles.button}><Text style={styles.buttonText}>{keyboardHidden ? "Show keyboard" : "Hide keyboard"}</Text></Pressable>
            <Pressable onPress={() => void (running ? stop() : send())} disabled={running ? !connected || busy : !canSend} accessibilityRole="button" accessibilityLabel={running ? "Stop desktop orchestrator" : "Send to desktop orchestrator"} style={[styles.send, (running ? !connected || busy : !canSend) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={styles.sendText}>{running ? "Stop" : "Send"}</Text>}</Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  heading: { flex: 1, paddingHorizontal: 8 },
  title: { color: colors.foreground, fontFamily: font.semibold, fontSize: 18 },
  meta: { color: colors.mutedForeground, fontFamily: font.regular, fontSize: 12, lineHeight: 18 },
  button: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  buttonText: { color: colors.primary, fontFamily: font.semibold, fontSize: 14 },
  messages: { padding: 16, gap: 14, flexGrow: 1 },
  message: { padding: 12, borderRadius: radius.lg, backgroundColor: colors.surface },
  userMessage: { backgroundColor: colors.selection, marginLeft: 24 },
  role: { color: colors.mutedForeground, fontFamily: font.semibold, fontSize: 12, marginBottom: 6 },
  messageText: { color: colors.foreground, fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  toolDetails: { color: colors.secondaryForeground, fontFamily: font.mono, fontSize: 12, lineHeight: 18, marginTop: 8 },
  errorText: { color: colors.accentCoral },
  empty: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  latest: { alignSelf: "center", padding: 12 },
  notice: { fontFamily: font.regular, fontSize: 12, padding: 12 },
  composer: { borderTopWidth: 1, borderColor: colors.border, padding: 10, gap: 6 },
  input: { backgroundColor: colors.input, color: colors.foreground, fontFamily: font.regular, fontSize: 16, padding: 12, minHeight: 44, maxHeight: 140, borderRadius: radius.md },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  send: { backgroundColor: colors.primary, borderRadius: radius.md, minHeight: 44, minWidth: 72, justifyContent: "center", alignItems: "center", paddingHorizontal: 16 },
  sendText: { color: colors.primaryForeground, fontFamily: font.semibold, fontSize: 15 },
  disabled: { opacity: 0.4 },
});

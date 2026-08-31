import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  type AgentKind,
  type SessionPrompt,
  type SessionPromptOption,
  type SessionPromptResponse,
} from "../lib/composerApi";
import { colors, font, glass, radius, withAlpha } from "../theme";
import { ClaudeIcon, CloseIcon, CodexIcon, SendIcon, TerminalGlyph } from "./icons";

interface AgentPromptCardProps {
  agent: AgentKind | undefined;
  agentLabel: string;
  prompt: SessionPrompt;
  disabled: boolean;
  onRespond: (response: SessionPromptResponse) => Promise<void>;
  onError: (error: unknown) => void;
}

function agentIcon(agent: AgentKind | undefined) {
  if (agent === "claude") return <ClaudeIcon size={18} />;
  if (agent === "codex") return <CodexIcon size={18} />;
  return <TerminalGlyph size={18} color={colors.secondaryForeground} />;
}

function promptType(prompt: SessionPrompt): string {
  if (prompt.textInput?.kind === "notes") return "Notes";
  if (prompt.textInput?.kind === "other") return "Other answer";
  if (prompt.kind === "freeform") return "Written answer";
  if (prompt.kind === "multi-select") return "Choose any";
  if (prompt.kind === "confirm") return "Confirmation";
  return "Choose one";
}

function selectionHint(prompt: SessionPrompt): string {
  if (prompt.kind === "multi-select") return "Select every option that applies, then submit.";
  if (prompt.kind === "freeform") return prompt.textInput?.optional ? "A response is optional." : "Enter a response to continue.";
  return "Selecting an option answers immediately.";
}

function OptionRow({
  option,
  multiple,
  selected,
  pending,
  disabled,
  onPress,
}: {
  option: SessionPromptOption;
  multiple: boolean;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const unavailable = disabled || option.disabled;
  const stateDescription = multiple ? (selected ? "Selected" : "Not selected") : option.focused ? "Currently highlighted" : undefined;
  return (
    <Pressable
      onPress={onPress}
      disabled={unavailable}
      accessibilityRole={multiple ? "checkbox" : "button"}
      accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
      accessibilityHint={multiple ? "Toggles this answer" : option.custom ? "Opens a text field for another answer" : "Answers this question"}
      accessibilityState={{
        disabled: unavailable,
        checked: multiple ? selected : undefined,
        selected: multiple ? undefined : selected,
      }}
      accessibilityValue={stateDescription ? { text: stateDescription } : undefined}
      style={({ pressed }) => [
        styles.option,
        option.focused && styles.optionFocused,
        selected && styles.optionSelected,
        unavailable && styles.disabled,
        pressed && !unavailable && styles.optionPressed,
      ]}
    >
      <View style={[styles.selectionMark, multiple ? styles.checkbox : styles.radio, selected && styles.selectionMarkSelected]}>
        {selected ? <Text style={styles.checkmark}>✓</Text> : null}
      </View>
      <View style={styles.optionCopy}>
        <View style={styles.optionTitleRow}>
          <Text style={styles.optionLabel}>{option.label}</Text>
          {option.custom ? (
            <View style={styles.otherBadge}>
              <Text style={styles.otherBadgeText}>WRITE IN</Text>
            </View>
          ) : null}
        </View>
        {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
      </View>
      {pending ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : option.key ? (
        <View style={styles.keycap}>
          <Text style={styles.keycapText}>{option.key}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function AgentPromptCard({ agent, agentLabel, prompt, disabled, onRespond, onError }: AgentPromptCardProps) {
  const { height } = useWindowDimensions();
  const entrance = useRef(new Animated.Value(0)).current;
  const inputRef = useRef<TextInput | null>(null);
  const [text, setText] = useState("");
  const [pendingAction, setPendingAction] = useState<string | undefined>(undefined);
  const selectedSignature = prompt.options
    .filter((option) => option.selected)
    .map((option) => option.id)
    .join("\u0000");
  const serverSelected = useMemo(() => new Set(selectedSignature ? selectedSignature.split("\u0000") : []), [selectedSignature]);
  const [localSelected, setLocalSelected] = useState<Set<string>>(serverSelected);

  useEffect(() => {
    setText("");
    setPendingAction(undefined);
    setLocalSelected(serverSelected);
    entrance.setValue(0);
    Animated.timing(entrance, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance, prompt.id]);

  // Visual multi-select TUIs redraw their checked rows after each action. For
  // accessibility/screen-reader prompts the choices are typed only on Submit,
  // so the phone owns the temporary selection set instead.
  useEffect(() => {
    if (prompt.interaction !== "numeric-input") setLocalSelected(serverSelected);
  }, [prompt.interaction, selectedSignature]);

  const run = async (response: SessionPromptResponse, token: string): Promise<boolean> => {
    if (disabled || pendingAction) return false;
    setPendingAction(token);
    try {
      await onRespond(response);
      if (response.action === "toggle" || response.action === "open-notes") {
        // Cursor-based TUIs need a redraw beat before another mobile action;
        // otherwise a fast Submit could navigate from the previous focus row.
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      return true;
    } catch (error) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      onError(error);
      return false;
    } finally {
      setPendingAction(undefined);
    }
  };

  const choose = (option: SessionPromptOption) => {
    if (prompt.kind === "multi-select" && prompt.interaction === "numeric-input") {
      Haptics.selectionAsync().catch(() => undefined);
      setLocalSelected((current) => {
        const next = new Set(current);
        if (next.has(option.id)) next.delete(option.id);
        else next.add(option.id);
        return next;
      });
      return;
    }

    if (prompt.kind === "multi-select") {
      setLocalSelected((current) => {
        const next = new Set(current);
        if (next.has(option.id)) next.delete(option.id);
        else next.add(option.id);
        return next;
      });
      void run({ action: "toggle", optionId: option.id }, `option:${option.id}`).then((accepted) => {
        if (!accepted) setLocalSelected(serverSelected);
      });
      return;
    }
    void run({ action: "select", optionId: option.id }, `option:${option.id}`);
  };

  const submitText = () => {
    if (!prompt.textInput || (!text.trim() && !prompt.textInput.optional)) return;
    void run({ action: "text", text }, "submit-text");
  };

  const progress = prompt.progress;
  const progressFraction = progress ? Math.max(0, Math.min(1, progress.current / progress.total)) : 0;
  // Preserve room for the session strip and hardware-key row in short
  // landscape/keyboard-resized windows; the question body becomes scrollable.
  const maxHeight = Math.max(180, Math.min(560, height * 0.58, height - 170));
  const busy = Boolean(pendingAction);

  return (
    <Animated.View
      accessibilityLabel={`${agentLabel} needs input`}
      accessibilityLiveRegion="polite"
      style={[
        styles.card,
        {
          maxHeight,
          opacity: entrance,
          transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.brandMark}>{agentIcon(agent)}</View>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow} numberOfLines={1}>{agentLabel} NEEDS INPUT</Text>
          <Text style={styles.kindLabel} numberOfLines={1}>{promptType(prompt)}</Text>
        </View>
        {progress ? (
          <View style={styles.progressBadge}>
            <Text style={styles.progressBadgeText}>
              {progress.current} / {progress.total}
            </Text>
          </View>
        ) : null}
        <Pressable
          onPress={() => void run({ action: "cancel" }, "cancel")}
          disabled={disabled || busy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${prompt.cancelLabel} this question`}
          accessibilityHint="Sends Escape to the agent"
          accessibilityState={{ disabled: disabled || busy }}
          style={({ pressed }) => [styles.closeButton, pressed && styles.closePressed, (disabled || busy) && styles.disabled]}
        >
          <CloseIcon size={16} color={prompt.cancelLabel === "Interrupt" ? colors.accentCoral : colors.secondaryForeground} />
          <Text style={[styles.closeLabel, prompt.cancelLabel === "Interrupt" && styles.closeLabelDanger]}>{prompt.cancelLabel}</Text>
        </Pressable>
      </View>

      {progress ? (
        <View style={styles.progressTrack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.progressFill, { width: `${progressFraction * 100}%` }]} />
        </View>
      ) : null}

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={prompt.options.length > 4 || prompt.details.length > 2}
        nestedScrollEnabled
      >
        {prompt.title ? <Text style={styles.title}>{prompt.title}</Text> : null}
        {prompt.question ? <Text style={styles.question}>{prompt.question}</Text> : null}
        {prompt.details.length ? (
          <View style={styles.details}>
            {prompt.details.map((line, index) => (
              <Text key={`${index}:${line}`} style={styles.detailLine} selectable>
                {line}
              </Text>
            ))}
          </View>
        ) : null}

        {prompt.options.length ? (
          <View style={styles.options}>
            {prompt.options.map((option) => (
              <OptionRow
                key={option.id}
                option={option}
                multiple={prompt.kind === "multi-select"}
                selected={localSelected.has(option.id)}
                pending={pendingAction === `option:${option.id}`}
                disabled={disabled || busy}
                onPress={() => choose(option)}
              />
            ))}
          </View>
        ) : null}

        {prompt.textInput ? (
          <View style={styles.textAnswer}>
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder={prompt.textInput.placeholder}
              placeholderTextColor={colors.faint}
              multiline
              autoFocus={false}
              autoCapitalize="sentences"
              autoCorrect
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={submitText}
              editable={!disabled && !busy}
              accessibilityLabel={prompt.textInput.placeholder}
              accessibilityHint="Type your answer, then use the submit button"
              style={styles.textInput}
            />
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.hint} numberOfLines={2}>
          {selectionHint(prompt)}
        </Text>
        {prompt.acceptsNotes ? (
          <Pressable
            onPress={() => void run({ action: "open-notes" }, "notes")}
            disabled={disabled || busy}
            accessibilityRole="button"
            accessibilityLabel="Add notes to this answer"
            accessibilityState={{ disabled: disabled || busy }}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed, (disabled || busy) && styles.disabled]}
          >
            {pendingAction === "notes" ? <ActivityIndicator size="small" color={colors.secondaryForeground} /> : <Text style={styles.secondaryButtonText}>Add note</Text>}
          </Pressable>
        ) : null}
        {prompt.canSubmit ? (
          <Pressable
            onPress={() =>
              prompt.textInput
                ? submitText()
                : void run({ action: "submit", optionIds: [...localSelected] }, "submit-options")
            }
            disabled={disabled || busy || Boolean(prompt.textInput && !prompt.textInput.optional && !text.trim())}
            accessibilityRole="button"
            accessibilityLabel={prompt.submitLabel ?? "Submit answer"}
            accessibilityState={{ disabled: disabled || busy || Boolean(prompt.textInput && !prompt.textInput.optional && !text.trim()) }}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryPressed,
              (disabled || busy || Boolean(prompt.textInput && !prompt.textInput.optional && !text.trim())) && styles.disabled,
            ]}
          >
            {pendingAction === "submit-options" || pendingAction === "submit-text" ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <>
                <Text style={styles.primaryButtonText}>{prompt.submitLabel ?? "Submit answer"}</Text>
                <SendIcon size={15} color={colors.primaryForeground} />
              </>
            )}
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 180,
    borderWidth: 1,
    borderColor: withAlpha(colors.primary, 0.34),
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.38,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 18,
  },
  header: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brandMark: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: glass.raised,
    borderWidth: 1,
    borderColor: glass.raisedBorder,
  },
  headerCopy: { flex: 1, gap: 1 },
  eyebrow: {
    color: colors.primary,
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 0.75,
  },
  kindLabel: {
    color: colors.foreground,
    fontFamily: font.semibold,
    fontSize: 14,
  },
  progressBadge: {
    minWidth: 42,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    backgroundColor: withAlpha(colors.primary, 0.12),
    borderWidth: 1,
    borderColor: withAlpha(colors.primary, 0.32),
  },
  progressBadgeText: { color: colors.primary, fontFamily: font.monoSemibold, fontSize: 11 },
  closeButton: { minWidth: 44, height: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 7, borderRadius: radius.md },
  closePressed: { backgroundColor: withAlpha(colors.accentCoral, 0.16) },
  closeLabel: { color: colors.secondaryForeground, fontFamily: font.semibold, fontSize: 11 },
  closeLabelDanger: { color: colors.accentCoral },
  progressTrack: { height: 2, backgroundColor: glass.track },
  progressFill: { height: 2, backgroundColor: colors.primary },
  body: { flexShrink: 1 },
  bodyContent: { padding: 12, gap: 10 },
  title: { color: colors.secondaryForeground, fontFamily: font.semibold, fontSize: 12 },
  question: { color: colors.foreground, fontFamily: font.semibold, fontSize: 16, lineHeight: 22 },
  details: {
    gap: 3,
    padding: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.input,
    borderWidth: 1,
    borderColor: colors.border,
  },
  detailLine: { color: colors.mutedForeground, fontFamily: font.mono, fontSize: 11.5, lineHeight: 17 },
  options: { gap: 8 },
  option: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: radius.md,
    backgroundColor: glass.raised,
    borderWidth: 1,
    borderColor: glass.raisedBorder,
  },
  optionFocused: { borderColor: colors.borderStrong },
  optionSelected: { backgroundColor: colors.selection, borderColor: withAlpha(colors.primary, 0.52) },
  optionPressed: { backgroundColor: glass.pressed, borderColor: withAlpha(colors.primary, 0.58) },
  selectionMark: { width: 22, height: 22, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: colors.faint },
  checkbox: { borderRadius: radius.sm },
  radio: { borderRadius: radius.pill },
  selectionMarkSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.primaryForeground, fontFamily: font.bold, fontSize: 13, lineHeight: 16 },
  optionCopy: { flex: 1, gap: 3 },
  optionTitleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7 },
  optionLabel: { flexShrink: 1, color: colors.foreground, fontFamily: font.semibold, fontSize: 13.5, lineHeight: 18 },
  optionDescription: { color: colors.mutedForeground, fontFamily: font.regular, fontSize: 12, lineHeight: 17 },
  otherBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: withAlpha(colors.accentAmber, 0.12) },
  otherBadgeText: { color: colors.accentAmber, fontFamily: font.semibold, fontSize: 8, letterSpacing: 0.45 },
  keycap: {
    minWidth: 25,
    height: 25,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.input,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  keycapText: { color: colors.secondaryForeground, fontFamily: font.monoSemibold, fontSize: 11 },
  textAnswer: { gap: 7 },
  textInput: {
    minHeight: 78,
    maxHeight: 132,
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.input,
    borderWidth: 1,
    borderBottomWidth: 2,
    borderColor: colors.border,
    borderBottomColor: colors.primary,
    color: colors.foreground,
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  footer: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  hint: { flex: 1, color: colors.faint, fontFamily: font.regular, fontSize: 11, lineHeight: 15 },
  secondaryButton: {
    minHeight: 44,
    minWidth: 74,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 11,
    borderRadius: radius.md,
    backgroundColor: glass.raised,
    borderWidth: 1,
    borderColor: glass.raisedBorder,
  },
  secondaryPressed: { backgroundColor: glass.pressed },
  secondaryButtonText: { color: colors.secondaryForeground, fontFamily: font.semibold, fontSize: 12 },
  primaryButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 13,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  primaryPressed: { backgroundColor: colors.primaryDim, borderColor: colors.primaryDim },
  primaryButtonText: { color: colors.primaryForeground, fontFamily: font.semibold, fontSize: 12 },
  disabled: { opacity: 0.45 },
});

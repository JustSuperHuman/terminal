import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import type { AcpInteractiveRequestView, AcpPermissionOptionView } from "../acpTypes";
import type { RespondToAcpRequestInput } from "../lib/acpApi";
import { colors, font, radius, withAlpha } from "../theme";
import { ClaudeIcon, CloseIcon, CodexIcon, SendIcon, TerminalGlyph } from "./icons";

interface AcpRequestCardProps {
  request: AcpInteractiveRequestView;
  disabled?: boolean;
  onRespond: (requestId: string, response: RespondToAcpRequestInput) => Promise<void>;
  onError: (error: unknown) => void;
}

type FieldKind = "string" | "number" | "integer" | "boolean" | "single" | "multi" | "json";

interface FormField {
  key: string;
  title: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  options: Array<{ value: unknown; label: string; description?: string }>;
  initialValue: unknown;
  secret: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

interface ParsedForm {
  fields: FormField[];
  wholeValue: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function labelForValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function schemaOptions(schema: Record<string, unknown>): Array<{ value: unknown; label: string; description?: string }> {
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (titled) {
    const options = titled
      .filter(isRecord)
      .filter((item) => "const" in item)
      .map((item) => ({
        value: item.const,
        label: typeof item.title === "string" ? item.title : labelForValue(item.const),
        description: typeof item.description === "string" ? item.description : undefined,
      }));
    if (options.length) return options;
  }
  const values = Array.isArray(schema.enum) ? schema.enum : [];
  const namesCandidate = schema.enumNames ?? schema["x-enumNames"];
  const names = Array.isArray(namesCandidate) ? namesCandidate : [];
  return values.map((value, index) => ({
    value,
    label: typeof names[index] === "string" ? names[index] : labelForValue(value),
  }));
}

function fieldFromSchema(key: string, schema: Record<string, unknown>, required: boolean): FormField {
  const options = schemaOptions(schema);
  const itemSchema = isRecord(schema.items) ? schema.items : {};
  const itemOptions = schemaOptions(itemSchema);
  const type = schema.type;
  const codexMeta = isRecord(schema._meta) && isRecord(schema._meta.codex) ? schema._meta.codex : undefined;
  let kind: FieldKind = "json";
  if (type === "array" && itemOptions.length) kind = "multi";
  else if (options.length) kind = "single";
  else if (type === "string") kind = "string";
  else if (type === "number") kind = "number";
  else if (type === "integer") kind = "integer";
  else if (type === "boolean") kind = "boolean";

  const title = typeof schema.title === "string" ? schema.title : key === "value" ? "Response" : key;
  const initial = schema.default;
  return {
    key,
    title,
    description: typeof schema.description === "string" ? schema.description : undefined,
    kind,
    required,
    options: kind === "multi" ? itemOptions : options,
    initialValue:
      initial !== undefined
        ? initial
        : kind === "multi"
          ? []
          : kind === "boolean"
            ? false
            : kind === "json"
              ? ""
              : "",
    secret: schema.writeOnly === true || schema.format === "password" || codexMeta?.isSecret === true,
    ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
    ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
    ...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {}),
    ...(typeof schema.format === "string" ? { format: schema.format } : {}),
    ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
    ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
    ...(typeof schema.minItems === "number" ? { minItems: schema.minItems } : {}),
    ...(typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
  };
}

function parseForm(schema: Record<string, unknown> | undefined): ParsedForm {
  if (!schema) {
    return {
      wholeValue: true,
      fields: [
        {
          key: "value",
          title: "Response",
          description: "This request did not include a supported form schema. Enter text or JSON.",
          kind: "json",
          required: false,
          options: [],
          initialValue: "",
          secret: false,
        },
      ],
    };
  }

  if (schema.type === "object" && isRecord(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
    const fields = Object.entries(schema.properties)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([key, fieldSchema]) => fieldFromSchema(key, fieldSchema, required.has(key)));
    if (fields.length) return { fields, wholeValue: false };
  }

  return { fields: [fieldFromSchema("value", schema, true)], wholeValue: true };
}

function initialValues(form: ParsedForm): Record<string, unknown> {
  return Object.fromEntries(form.fields.map((field) => [field.key, field.initialValue]));
}

function validateAndBuild(form: ParsedForm, values: Record<string, unknown>): { content?: unknown; error?: string } {
  const result: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = values[field.key];
    if (field.kind === "string" || field.kind === "single") {
      if (field.required && (value === undefined || value === null || String(value).trim() === "")) {
        return { error: `${field.title} is required.` };
      }
      if (value !== "" && value !== undefined) {
        const text = String(value);
        if (field.minLength !== undefined && text.length < field.minLength) return { error: `${field.title} must be at least ${field.minLength} characters.` };
        if (field.maxLength !== undefined && text.length > field.maxLength) return { error: `${field.title} must be at most ${field.maxLength} characters.` };
        if (field.pattern) {
          if (field.pattern.length > 512) return { error: `${field.title} has an unsupported validation pattern.` };
          try {
            if (!new RegExp(field.pattern).test(text)) return { error: `${field.title} does not match the required format.` };
          } catch {
            return { error: `${field.title} has an invalid validation pattern.` };
          }
        }
        if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { error: `${field.title} must be an email address.` };
        if (field.format === "uri") {
          try { new URL(text); } catch { return { error: `${field.title} must be a complete URL.` }; }
        }
        if (field.format === "date") {
          const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : undefined;
          if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return { error: `${field.title} must be a date in YYYY-MM-DD format.` };
        }
        if (field.format === "date-time" && !Number.isFinite(Date.parse(text))) return { error: `${field.title} must be a valid date and time.` };
        result[field.key] = value;
      }
    } else if (field.kind === "number" || field.kind === "integer") {
      if (String(value ?? "").trim() === "") {
        if (field.required) return { error: `${field.title} is required.` };
        continue;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || (field.kind === "integer" && !Number.isInteger(parsed))) {
        return { error: `${field.title} must be ${field.kind === "integer" ? "a whole number" : "a number"}.` };
      }
      if (field.minimum !== undefined && parsed < field.minimum) return { error: `${field.title} must be at least ${field.minimum}.` };
      if (field.maximum !== undefined && parsed > field.maximum) return { error: `${field.title} must be at most ${field.maximum}.` };
      result[field.key] = parsed;
    } else if (field.kind === "boolean") {
      result[field.key] = Boolean(value);
    } else if (field.kind === "multi") {
      const selected = Array.isArray(value) ? value : [];
      if (field.required && selected.length === 0) return { error: `Choose at least one value for ${field.title}.` };
      if (field.minItems !== undefined && selected.length < field.minItems) return { error: `Choose at least ${field.minItems} values for ${field.title}.` };
      if (field.maxItems !== undefined && selected.length > field.maxItems) return { error: `Choose no more than ${field.maxItems} values for ${field.title}.` };
      result[field.key] = selected;
    } else {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) {
        if (field.required) return { error: `${field.title} is required.` };
        continue;
      }
      // ACP elicitation values are scalar or string arrays. Preserve unknown
      // schema fields as text instead of inventing a nested object the agent
      // cannot accept.
      result[field.key] = text;
    }
  }
  return { content: result };
}

function agentIcon(agent: AcpInteractiveRequestView["agent"]) {
  if (agent === "claude") return <ClaudeIcon size={18} />;
  if (agent === "codex") return <CodexIcon size={18} />;
  return <TerminalGlyph size={18} color={colors.secondaryForeground} />;
}

function permissionTone(option: AcpPermissionOptionView) {
  return option.kind.startsWith("reject") ? colors.destructive : colors.primary;
}

function fieldConstraint(field: FormField): string | undefined {
  const parts: string[] = [];
  if (field.minLength !== undefined || field.maxLength !== undefined) {
    if (field.minLength !== undefined && field.maxLength !== undefined) parts.push(`${field.minLength}–${field.maxLength} characters`);
    else if (field.minLength !== undefined) parts.push(`At least ${field.minLength} characters`);
    else parts.push(`At most ${field.maxLength} characters`);
  }
  if (field.minimum !== undefined || field.maximum !== undefined) {
    if (field.minimum !== undefined && field.maximum !== undefined) parts.push(`${field.minimum}–${field.maximum}`);
    else if (field.minimum !== undefined) parts.push(`Minimum ${field.minimum}`);
    else parts.push(`Maximum ${field.maximum}`);
  }
  if (field.minItems !== undefined || field.maxItems !== undefined) {
    if (field.minItems !== undefined && field.maxItems !== undefined) parts.push(`Choose ${field.minItems}–${field.maxItems}`);
    else if (field.minItems !== undefined) parts.push(`Choose at least ${field.minItems}`);
    else parts.push(`Choose up to ${field.maxItems}`);
  }
  if (field.format === "date") parts.push("YYYY-MM-DD");
  else if (field.format === "date-time") parts.push("Date and time");
  else if (field.format === "email") parts.push("Email address");
  else if (field.format === "uri") parts.push("Complete URL");
  return parts.length ? parts.join(" · ") : undefined;
}

export function AcpRequestCard({ request, disabled = false, onRespond, onError }: AcpRequestCardProps) {
  const { height } = useWindowDimensions();
  const entrance = useRef(new Animated.Value(0)).current;
  const form = useMemo(() => parseForm(request.requestedSchema), [request.id]);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(form));
  const [pending, setPending] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [urlOpened, setUrlOpened] = useState(false);
  const [armedOptionId, setArmedOptionId] = useState<string>();
  const initializedRequestId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (initializedRequestId.current === request.id) return;
    initializedRequestId.current = request.id;
    setValues(initialValues(form));
    setPending(undefined);
    setFormError(undefined);
    setUrlOpened(false);
    setArmedOptionId(undefined);
    entrance.setValue(0);
    Animated.timing(entrance, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance, form, request.id]);

  const respond = async (response: RespondToAcpRequestInput, token: string) => {
    if (disabled || pending) return;
    setPending(token);
    try {
      await onRespond(request.id, response);
    } catch (error) {
      onError(error);
    } finally {
      setPending(undefined);
    }
  };

  const openUrl = async () => {
    if (!request.url || pending) return;
    setPending("url");
    try {
      const destination = new URL(request.url);
      if (["javascript:", "data:", "file:"].includes(destination.protocol)) {
        throw new Error(`The ${destination.protocol} link type is blocked for safety.`);
      }
      const supported = await Linking.canOpenURL(request.url);
      if (!supported) throw new Error("This sign-in link cannot be opened on this device.");
      await Linking.openURL(request.url);
      setUrlOpened(true);
    } catch (error) {
      onError(error);
    } finally {
      setPending(undefined);
    }
  };

  const submitForm = () => {
    const built = validateAndBuild(form, values);
    if (built.error) {
      setFormError(built.error);
      return;
    }
    setFormError(undefined);
    void respond({ action: "accept", content: built.content }, "submit");
  };

  return (
    <Animated.View
      accessibilityLabel={`${request.agent} needs input`}
      accessibilityLiveRegion="assertive"
      style={[
        styles.card,
        {
          maxHeight: Math.max(240, Math.min(620, height * 0.68, height - 150)),
          opacity: entrance,
          transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.brand}>{agentIcon(request.agent)}</View>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{request.agent.toUpperCase()} NEEDS INPUT</Text>
          <Text style={styles.headerTitle} numberOfLines={2}>{request.title}</Text>
        </View>
        <Pressable
          onPress={() => void respond({ action: "cancel" }, "cancel")}
          disabled={disabled || Boolean(pending)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss request"
          hitSlop={8}
          style={({ pressed }) => [styles.closeButton, pressed && styles.pressed, (disabled || Boolean(pending)) && styles.disabled]}
        >
          {pending === "cancel" ? <ActivityIndicator size="small" color={colors.secondaryForeground} /> : <CloseIcon size={17} />}
        </Pressable>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {request.message ? <Text style={styles.message} selectable>{request.message}</Text> : null}
        {request.toolCall ? (
          <View style={styles.toolContext}>
            <Text style={styles.toolEyebrow}>REQUESTED BY TOOL</Text>
            <Text style={styles.toolTitle} numberOfLines={2}>{request.toolCall.title}</Text>
            {request.toolCall.locations.slice(0, 3).map((location) => (
              <Text key={`${location.path}:${location.line ?? 0}`} style={styles.pathText} numberOfLines={1}>
                {location.path}{location.line ? `:${location.line}` : ""}
              </Text>
            ))}
          </View>
        ) : null}

        {request.kind === "permission" ? (
          <View style={styles.optionList}>
            {(request.options ?? []).map((option) => {
              const tone = permissionTone(option);
              const isPending = pending === option.optionId;
              const durable = option.kind.endsWith("_always");
              const armed = armedOptionId === option.optionId;
              return (
                <Pressable
                  key={option.optionId}
                  onPress={() => {
                    if (durable && !armed) {
                      setArmedOptionId(option.optionId);
                      return;
                    }
                    void respond({ action: "select", optionId: option.optionId }, option.optionId);
                  }}
                  disabled={disabled || Boolean(pending)}
                  accessibilityRole="button"
                  accessibilityLabel={option.name}
                  accessibilityHint={armed ? "Tap again to confirm this persistent choice" : durable ? `${option.kind.replaceAll("_", " ")}. Requires confirmation.` : option.kind.replaceAll("_", " ")}
                  style={({ pressed }) => [
                    styles.permissionOption,
                    { borderColor: withAlpha(tone, 0.28) },
                    armed && { backgroundColor: withAlpha(tone, 0.12), borderColor: withAlpha(tone, 0.55) },
                    pressed && { backgroundColor: withAlpha(tone, 0.12) },
                    (disabled || Boolean(pending)) && styles.disabled,
                  ]}
                >
                  <View style={[styles.permissionMark, { backgroundColor: withAlpha(tone, 0.14), borderColor: withAlpha(tone, 0.35) }]}>
                    {isPending ? <ActivityIndicator size="small" color={tone} /> : <Text style={[styles.permissionGlyph, { color: tone }]}>{option.kind.startsWith("reject") ? "×" : "✓"}</Text>}
                  </View>
                  <View style={styles.optionCopy}>
                    <Text style={styles.optionName}>{option.name}</Text>
                    {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                    <Text style={[styles.optionKind, armed && { color: tone }]}>{armed ? "Tap again to confirm" : option.kind.replaceAll("_", " ")}</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              );
            })}
            {(request.options ?? []).length === 0 ? (
              <Text style={styles.muted}>The agent did not provide any permission choices. Dismiss this request to continue safely.</Text>
            ) : null}
          </View>
        ) : null}

        {request.kind === "elicitation_form" ? (
          <View style={styles.form}>
            {form.fields.map((field) => (
              <View key={field.key} style={styles.field}>
                <Text style={styles.fieldLabel}>{field.title}{field.required ? " *" : ""}</Text>
                {field.description ? <Text style={styles.fieldDescription}>{field.description}</Text> : null}
                {fieldConstraint(field) ? <Text style={styles.fieldConstraint}>{fieldConstraint(field)}</Text> : null}

                {field.kind === "boolean" ? (
                  <Pressable
                    onPress={() => setValues((current) => ({ ...current, [field.key]: !Boolean(current[field.key]) }))}
                    disabled={disabled || Boolean(pending)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: Boolean(values[field.key]), disabled: disabled || Boolean(pending) }}
                    style={({ pressed }) => [styles.switchRow, pressed && styles.pressed]}
                  >
                    <View style={[styles.switchTrack, Boolean(values[field.key]) && styles.switchTrackOn]}>
                      <View style={[styles.switchThumb, Boolean(values[field.key]) && styles.switchThumbOn]} />
                    </View>
                    <Text style={styles.switchLabel}>{Boolean(values[field.key]) ? "Yes" : "No"}</Text>
                  </Pressable>
                ) : field.kind === "single" || field.kind === "multi" ? (
                  <View style={styles.choiceGrid}>
                    {field.options.map((option) => {
                      const current = values[field.key];
                      const selected = field.kind === "multi"
                        ? Array.isArray(current) && current.some((value) => Object.is(value, option.value))
                        : Object.is(current, option.value);
                      const selectionLimitReached = field.kind === "multi"
                        && !selected
                        && field.maxItems !== undefined
                        && Array.isArray(current)
                        && current.length >= field.maxItems;
                      return (
                        <Pressable
                          key={labelForValue(option.value)}
                          onPress={() => {
                            setValues((previous) => {
                              if (field.kind === "single") return { ...previous, [field.key]: option.value };
                              const list = Array.isArray(previous[field.key]) ? [...(previous[field.key] as unknown[])] : [];
                              const index = list.findIndex((value) => Object.is(value, option.value));
                              if (index >= 0) list.splice(index, 1);
                              else list.push(option.value);
                              return { ...previous, [field.key]: list };
                            });
                          }}
                          disabled={disabled || Boolean(pending) || selectionLimitReached}
                          accessibilityRole={field.kind === "multi" ? "checkbox" : "radio"}
                          accessibilityState={{ checked: selected, disabled: disabled || Boolean(pending) || selectionLimitReached }}
                          style={({ pressed }) => [styles.choice, selected && styles.choiceSelected, selectionLimitReached && styles.disabled, pressed && !selectionLimitReached && styles.choicePressed]}
                        >
                          <View style={[styles.choiceMark, field.kind === "single" && styles.radio, selected && styles.choiceMarkSelected]}>
                            {selected ? <Text style={styles.check}>✓</Text> : null}
                          </View>
                          <View style={styles.optionCopy}>
                            <Text style={styles.optionName}>{option.label}</Text>
                            {option.description ? <Text style={styles.fieldDescription}>{option.description}</Text> : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <TextInput
                    value={String(values[field.key] ?? "")}
                    onChangeText={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                    editable={!disabled && !pending}
                    keyboardType={
                      field.kind === "number" ? "decimal-pad"
                        : field.kind === "integer" ? "number-pad"
                          : field.format === "email" ? "email-address"
                            : field.format === "uri" ? "url"
                              : "default"
                    }
                    multiline={field.kind === "json" || field.kind === "string"}
                    maxLength={field.maxLength}
                    placeholder={field.format === "date" ? "YYYY-MM-DD" : field.kind === "json" ? "Enter a value" : `Enter ${field.title.toLowerCase()}`}
                    placeholderTextColor={colors.faint}
                    accessibilityLabel={field.title}
                    secureTextEntry={field.secret}
                    autoCorrect={!field.secret}
                    autoCapitalize={field.secret || field.format === "email" || field.format === "uri" ? "none" : "sentences"}
                    autoComplete={field.secret ? "off" : undefined}
                    importantForAutofill={field.secret ? "no" : "auto"}
                    style={[styles.input, (field.kind === "json" || field.kind === "string") && styles.inputMultiline, field.kind === "json" && styles.monoInput]}
                  />
                )}
              </View>
            ))}
            {formError ? <Text style={styles.formError} accessibilityLiveRegion="polite">{formError}</Text> : null}
            <View style={styles.actionRow}>
              <Pressable
                onPress={() => void respond({ action: "decline" }, "decline")}
                disabled={disabled || Boolean(pending)}
                accessibilityRole="button"
                accessibilityLabel="Decline request"
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (disabled || Boolean(pending)) && styles.disabled]}
              >
                {pending === "decline" ? <ActivityIndicator size="small" color={colors.secondaryForeground} /> : <Text style={styles.secondaryButtonText}>Decline</Text>}
              </Pressable>
              <Pressable
                onPress={submitForm}
                disabled={disabled || Boolean(pending)}
                accessibilityRole="button"
                accessibilityLabel="Submit response"
                style={({ pressed }) => [styles.primaryButton, styles.actionPrimary, pressed && styles.primaryPressed, (disabled || Boolean(pending)) && styles.disabled]}
              >
                {pending === "submit" ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : (
                  <>
                    <Text style={styles.primaryButtonText}>Submit response</Text>
                    <SendIcon size={15} color={colors.primaryForeground} />
                  </>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}

        {request.kind === "elicitation_url" ? (
          <View style={styles.urlPanel}>
            {request.url ? (
              <Text style={styles.urlOrigin} selectable>
                {(() => { try { return new URL(request.url).origin; } catch { return "Unrecognized destination"; } })()}
              </Text>
            ) : null}
            <Text style={styles.urlText} selectable>{request.url ?? "No URL was provided."}</Text>
            <View style={styles.actionRow}>
              <Pressable
                onPress={() => void respond({ action: "decline" }, "decline")}
                disabled={disabled || Boolean(pending)}
                accessibilityRole="button"
                accessibilityLabel="Decline browser request"
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (disabled || Boolean(pending)) && styles.disabled]}
              >
                {pending === "decline" ? <ActivityIndicator size="small" color={colors.secondaryForeground} /> : <Text style={styles.secondaryButtonText}>Decline</Text>}
              </Pressable>
              <Pressable
                onPress={() => void openUrl()}
                disabled={disabled || Boolean(pending) || !request.url}
                accessibilityRole="link"
                accessibilityLabel={urlOpened ? "Reopen external page" : "Open external page"}
                style={({ pressed }) => [styles.primaryButton, styles.actionPrimary, pressed && styles.primaryPressed, (disabled || Boolean(pending) || !request.url) && styles.disabled]}
              >
                {pending === "url" ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <Text style={styles.primaryButtonText}>{urlOpened ? "Reopen page ↗" : "Open page ↗"}</Text>}
              </Pressable>
            </View>
            <Text style={styles.urlHint}>{urlOpened ? "Page opened. This card will close when the agent confirms completion." : "This opens in your default browser. Return here when the external flow is complete."}</Text>
          </View>
        ) : null}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: withAlpha(colors.primary, 0.38),
    borderRadius: radius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brand: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.surfaceHi,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  headerCopy: { flex: 1, gap: 2 },
  eyebrow: { color: colors.primary, fontSize: 10, letterSpacing: 0.8, fontFamily: font.semibold },
  headerTitle: { color: colors.foreground, fontSize: 14, lineHeight: 18, fontFamily: font.semibold },
  closeButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  pressed: { backgroundColor: colors.surfaceHi },
  disabled: { opacity: 0.45 },
  body: { flexGrow: 0 },
  bodyContent: { padding: 14, gap: 14 },
  message: { color: colors.secondaryForeground, fontSize: 14, lineHeight: 20, fontFamily: font.regular },
  toolContext: { padding: 10, gap: 3, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.terminal },
  toolEyebrow: { color: colors.mutedForeground, fontSize: 9, letterSpacing: 0.7, fontFamily: font.semibold },
  toolTitle: { color: colors.foreground, fontSize: 13, fontFamily: font.semibold },
  pathText: { color: colors.primary, fontSize: 11, lineHeight: 16, fontFamily: font.mono },
  optionList: { gap: 8 },
  permissionOption: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 11, padding: 9, borderWidth: 1, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  permissionMark: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: radius.md },
  permissionGlyph: { fontSize: 20, lineHeight: 22, fontFamily: font.semibold },
  optionCopy: { flex: 1, gap: 2 },
  optionName: { color: colors.foreground, fontSize: 13, lineHeight: 17, fontFamily: font.semibold },
  optionDescription: { color: colors.secondaryForeground, fontSize: 11, lineHeight: 15, fontFamily: font.regular },
  optionKind: { color: colors.mutedForeground, fontSize: 10, textTransform: "capitalize", fontFamily: font.regular },
  chevron: { color: colors.mutedForeground, fontSize: 23, fontFamily: font.regular },
  muted: { color: colors.mutedForeground, fontSize: 12, lineHeight: 18, fontFamily: font.regular },
  form: { gap: 14 },
  field: { gap: 6 },
  fieldLabel: { color: colors.foreground, fontSize: 13, fontFamily: font.semibold },
  fieldDescription: { color: colors.mutedForeground, fontSize: 11, lineHeight: 16, fontFamily: font.regular },
  fieldConstraint: { color: colors.accentCyan, fontSize: 10.5, lineHeight: 15, fontFamily: font.mono },
  input: { minHeight: 42, color: colors.foreground, fontSize: 14, fontFamily: font.regular, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, paddingHorizontal: 11, paddingVertical: 9 },
  inputMultiline: { minHeight: 74, textAlignVertical: "top" },
  monoInput: { fontFamily: font.mono, fontSize: 12 },
  switchRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "flex-start", paddingRight: 12 },
  switchTrack: { width: 40, height: 22, borderRadius: radius.pill, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.borderStrong, padding: 2 },
  switchTrackOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  switchThumb: { width: 16, height: 16, borderRadius: radius.pill, backgroundColor: colors.mutedForeground },
  switchThumbOn: { marginLeft: 18, backgroundColor: colors.primaryForeground },
  switchLabel: { color: colors.secondaryForeground, fontSize: 13, fontFamily: font.regular },
  choiceGrid: { gap: 7 },
  choice: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 9, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, padding: 8 },
  choiceSelected: { borderColor: withAlpha(colors.primary, 0.55), backgroundColor: colors.selection },
  choicePressed: { backgroundColor: withAlpha(colors.primary, 0.16) },
  choiceMark: { width: 20, height: 20, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  radio: { borderRadius: radius.pill },
  choiceMarkSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  check: { color: colors.primaryForeground, fontSize: 12, fontFamily: font.bold },
  formError: { color: colors.destructive, fontSize: 12, lineHeight: 17, fontFamily: font.semibold },
  primaryButton: { minHeight: 44, paddingHorizontal: 15, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.primary, alignSelf: "stretch" },
  actionRow: { flexDirection: "row", gap: 8 },
  actionPrimary: { flex: 1 },
  secondaryButton: { minHeight: 44, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceAlt },
  secondaryButtonText: { color: colors.secondaryForeground, fontSize: 13, fontFamily: font.semibold },
  primaryPressed: { backgroundColor: colors.primaryDim },
  primaryButtonText: { color: colors.primaryForeground, fontSize: 13, fontFamily: font.semibold },
  urlPanel: { gap: 10 },
  urlOrigin: { color: colors.foreground, fontSize: 13, fontFamily: font.semibold },
  urlText: { color: colors.primary, fontSize: 12, lineHeight: 17, fontFamily: font.mono, padding: 10, backgroundColor: colors.terminal, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  urlHint: { color: colors.mutedForeground, fontSize: 11, lineHeight: 16, fontFamily: font.regular },
});

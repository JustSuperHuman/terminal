import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ServerEndpoint } from "../lib/endpoint";
import { colors, font, glass, radius, withAlpha } from "../theme";
import { CloseIcon, TerminalCompanionMark } from "./icons";

interface ConnectScreenProps {
  servers: ServerEndpoint[];
  connecting: boolean;
  error?: string;
  onConnect: (address: string, token: string, label?: string) => void;
  onSelectSaved: (endpoint: ServerEndpoint) => void;
  onForget: (id: string) => void;
}

const EMULATOR_HOST = "10.0.2.2:10001";

export function ConnectScreen({ servers, connecting, error, onConnect, onSelectSaved, onForget }: ConnectScreenProps) {
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [focused, setFocused] = useState<"address" | "token" | "label" | null>(null);

  // Fluent entrance: the whole page fades in with a small rise on mount.
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  // The error notice fades/slides in rather than popping.
  const errorAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (error) {
      errorAnim.setValue(0);
      Animated.timing(errorAnim, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [error, errorAnim]);

  const canConnect = address.trim().length > 0 && !connecting;

  function submit() {
    if (canConnect) {
      onConnect(address, token, label);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 36, paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Animated.View
          style={{
            opacity: entrance,
            transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
          }}
        >
        <View style={styles.brand}>
          <View style={styles.brandMark}>
            <TerminalCompanionMark size={44} color={colors.primary} />
          </View>
          <Text style={styles.title}>Terminal Companion</Text>
          <Text style={styles.subtitle}>Connect to a Terminal Web host</Text>
        </View>

        <View style={styles.card}>
          <Text style={[styles.label, styles.labelFirst]}>Server address</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder="192.168.1.50:10001"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={submit}
            onFocus={() => setFocused("address")}
            onBlur={() => setFocused((f) => (f === "address" ? null : f))}
            accessibilityLabel="Server address"
            style={[styles.input, focused === "address" && styles.inputFocused]}
            editable={!connecting}
          />

          <View style={styles.rowFields}>
            <View style={styles.flex}>
              <Text style={styles.label}>Token</Text>
              <TextInput
                value={token}
                onChangeText={setToken}
                placeholder="Optional"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                onFocus={() => setFocused("token")}
                onBlur={() => setFocused((f) => (f === "token" ? null : f))}
                accessibilityLabel="Access token (optional)"
                style={[styles.input, focused === "token" && styles.inputFocused]}
                editable={!connecting}
              />
            </View>
            <View style={styles.flex}>
              <Text style={styles.label}>Label</Text>
              <TextInput
                value={label}
                onChangeText={setLabel}
                placeholder="Optional"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={submit}
                onFocus={() => setFocused("label")}
                onBlur={() => setFocused((f) => (f === "label" ? null : f))}
                accessibilityLabel="Server label (optional)"
                style={[styles.input, focused === "label" && styles.inputFocused]}
                editable={!connecting}
              />
            </View>
          </View>

          {error ? (
            <Animated.View
              style={[
                styles.errorBox,
                {
                  opacity: errorAnim,
                  transform: [{ translateY: errorAnim.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
                },
              ]}
              accessibilityLiveRegion="polite"
            >
              <Text style={styles.errorText}>{error}</Text>
            </Animated.View>
          ) : null}

          <Pressable
            disabled={!canConnect}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel="Connect"
            accessibilityState={{ disabled: !canConnect, busy: connecting }}
            style={({ pressed }) => [styles.connect, !canConnect && styles.connectDisabled, pressed && styles.connectPressed]}
          >
            {connecting ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.connectText}>Connect</Text>
            )}
          </Pressable>

          {__DEV__ ? (
            <Pressable
              onPress={() => setAddress(EMULATOR_HOST)}
              style={styles.hintChip}
              disabled={connecting}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Use emulator host ${EMULATOR_HOST}`}
            >
              <Text style={styles.hintChipText}>Use emulator host · {EMULATOR_HOST}</Text>
            </Pressable>
          ) : null}
        </View>

        {servers.length > 0 ? (
          <View style={styles.recent}>
            <Text style={styles.recentTitle}>Recent servers</Text>
            {servers.map((server) => (
              <View key={server.id} style={styles.recentRow}>
                <Pressable style={styles.recentMain} onPress={() => onSelectSaved(server)} disabled={connecting}>
                  {({ pressed }) => (
                    <>
                      <View style={[styles.selectionPill, pressed && styles.selectionPillActive]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.recentLabel} numberOfLines={1}>
                          {server.label ?? server.host}
                        </Text>
                        <Text style={styles.recentHost} numberOfLines={1}>
                          {server.host}
                          {server.token ? " · token" : ""}
                        </Text>
                      </View>
                    </>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => onForget(server.id)}
                  hitSlop={10}
                  style={styles.forget}
                  accessibilityRole="button"
                  accessibilityLabel={`Forget ${server.label ?? server.host}`}
                >
                  <CloseIcon size={14} color={colors.mutedForeground} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={styles.footnote}>
          Start the host with <Text style={styles.code}>bun run dev</Text> in tools/terminal-web. For LAN access use{" "}
          <Text style={styles.code}>--host 0.0.0.0</Text> and supply the token.
        </Text>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: 20,
  },
  brand: {
    alignItems: "flex-start",
    marginBottom: 24,
  },
  brandMark: {
    alignItems: "center",
    justifyContent: "center",
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    marginBottom: 16,
  },
  title: {
    color: colors.foreground,
    fontSize: 28,
    fontFamily: font.semibold,
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 14,
    fontFamily: font.regular,
    marginTop: 4,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 16,
  },
  label: {
    color: colors.secondaryForeground,
    fontSize: 12,
    fontFamily: font.regular,
    marginBottom: 6,
    marginTop: 12,
  },
  // The card's own padding provides the top inset; the first label adds none.
  labelFirst: {
    marginTop: 0,
  },
  input: {
    backgroundColor: colors.input,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.mono,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputFocused: {
    borderColor: colors.primary,
  },
  rowFields: {
    flexDirection: "row",
    gap: 12,
  },
  errorBox: {
    marginTop: 16,
    backgroundColor: withAlpha(colors.destructive, 0.08),
    borderColor: withAlpha(colors.destructive, 0.5),
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 12.5,
    fontFamily: font.medium,
    lineHeight: 17,
  },
  connect: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    marginTop: 16,
    minHeight: 44,
  },
  connectDisabled: {
    opacity: 0.45,
  },
  connectPressed: {
    backgroundColor: colors.primaryDim,
  },
  connectText: {
    color: colors.primaryForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  hintChip: {
    alignSelf: "center",
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    backgroundColor: glass.raised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  hintChipText: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.mono,
  },
  recent: {
    marginTop: 24,
  },
  recentTitle: {
    color: colors.secondaryForeground,
    fontSize: 14,
    fontFamily: font.semibold,
    marginBottom: 8,
    marginLeft: 4,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    marginBottom: 8,
  },
  recentMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 8,
    paddingRight: 14,
    paddingVertical: 12,
  },
  // WinUI selection indicator: a 3px accent pill on the row's left edge,
  // shown while the row is pressed.
  selectionPill: {
    width: 3,
    height: 16,
    borderRadius: radius.pill,
    backgroundColor: "transparent",
  },
  selectionPillActive: {
    backgroundColor: colors.primary,
  },
  recentLabel: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  recentHost: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.mono,
    marginTop: 2,
  },
  forget: {
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  footnote: {
    color: colors.faint,
    fontSize: 12,
    fontFamily: font.regular,
    lineHeight: 18,
    marginTop: 24,
    textAlign: "center",
  },
  code: {
    fontFamily: font.mono,
    color: colors.mutedForeground,
  },
});

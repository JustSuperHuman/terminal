import { useState } from "react";
import {
  ActivityIndicator,
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
import { colors, font, radius } from "../theme";
import { JustGainsMark } from "./icons";

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
        <View style={styles.brand}>
          <View style={styles.brandMark}>
            <JustGainsMark size={96} color={colors.foreground} />
          </View>
          <Text style={styles.title}>
            Just<Text style={styles.titleAccent}>Terminal</Text>
          </Text>
          <Text style={styles.subtitle}>Connect to a Terminal Web host</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Server address</Text>
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
            accessibilityLabel="Server address"
            style={styles.input}
            editable={!connecting}
          />

          <View style={styles.rowFields}>
            <View style={styles.flex}>
              <Text style={styles.label}>Token</Text>
              <TextInput
                value={token}
                onChangeText={setToken}
                placeholder="optional"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                accessibilityLabel="Access token (optional)"
                style={styles.input}
                editable={!connecting}
              />
            </View>
            <View style={styles.flex}>
              <Text style={styles.label}>Label</Text>
              <TextInput
                value={label}
                onChangeText={setLabel}
                placeholder="optional"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={submit}
                accessibilityLabel="Server label (optional)"
                style={styles.input}
                editable={!connecting}
              />
            </View>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
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
            <Pressable onPress={() => setAddress(EMULATOR_HOST)} style={styles.hintChip} disabled={connecting}>
              <Text style={styles.hintChipText}>Use emulator host · {EMULATOR_HOST}</Text>
            </Pressable>
          ) : null}
        </View>

        {servers.length > 0 ? (
          <View style={styles.recent}>
            <Text style={styles.recentTitle}>Recent</Text>
            {servers.map((server) => (
              <View key={server.id} style={styles.recentRow}>
                <Pressable style={styles.recentMain} onPress={() => onSelectSaved(server)} disabled={connecting}>
                  <View style={styles.recentDot} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.recentLabel} numberOfLines={1}>
                      {server.label ?? server.host}
                    </Text>
                    <Text style={styles.recentHost} numberOfLines={1}>
                      {server.host}
                      {server.token ? " · token" : ""}
                    </Text>
                  </View>
                </Pressable>
                <Pressable onPress={() => onForget(server.id)} hitSlop={10} style={styles.forget}>
                  <Text style={styles.forgetText}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={styles.footnote}>
          Start the host with <Text style={styles.code}>npm run dev</Text> in tools/terminal-web. For LAN access use{" "}
          <Text style={styles.code}>--host 0.0.0.0</Text> and supply the token.
        </Text>
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
    alignItems: "center",
    marginBottom: 26,
  },
  brandMark: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: {
    color: colors.foreground,
    fontSize: 26,
    fontFamily: font.extrabold,
    letterSpacing: 0.2,
  },
  titleAccent: {
    color: colors.primary,
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 13.5,
    fontFamily: font.medium,
    marginTop: 5,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 18,
  },
  label: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.bold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.input,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.foreground,
    fontSize: 15,
    fontFamily: font.mono,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },
  rowFields: {
    flexDirection: "row",
    gap: 10,
  },
  errorBox: {
    marginTop: 14,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.destructive,
    borderWidth: 1,
    borderRadius: radius.md,
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
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    marginTop: 18,
    minHeight: 50,
  },
  connectDisabled: {
    opacity: 0.45,
  },
  connectPressed: {
    backgroundColor: colors.primaryDim,
  },
  connectText: {
    color: colors.primaryForeground,
    fontSize: 16,
    fontFamily: font.extrabold,
  },
  hintChip: {
    alignSelf: "center",
    marginTop: 14,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
  },
  hintChipText: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.mono,
  },
  recent: {
    marginTop: 26,
  },
  recentTitle: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: font.bold,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    marginBottom: 8,
  },
  recentMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  recentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  recentLabel: {
    color: colors.foreground,
    fontSize: 15,
    fontFamily: font.semibold,
  },
  recentHost: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: font.mono,
    marginTop: 2,
  },
  forget: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  forgetText: {
    color: colors.mutedForeground,
    fontSize: 15,
  },
  footnote: {
    color: colors.faint,
    fontSize: 12,
    fontFamily: font.regular,
    lineHeight: 18,
    marginTop: 26,
    textAlign: "center",
  },
  code: {
    fontFamily: font.mono,
    color: colors.mutedForeground,
  },
});

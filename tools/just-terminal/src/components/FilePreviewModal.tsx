import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ServerEndpoint } from "../lib/endpoint";
import { fetchFilePreview, type FilePreview, type FilePreviewTarget } from "../lib/filePreviewApi";
import { colors, font } from "../theme";

export function FilePreviewModal({ endpoint, target, onClose }: {
  endpoint: ServerEndpoint; target?: FilePreviewTarget; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [preview, setPreview] = useState<FilePreview>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setPreview(undefined); setError(undefined);
    if (!target) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let active = true;
    void fetchFilePreview(endpoint, target, controller.signal).then((value) => {
      if (active) setPreview(value);
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [endpoint, target]);
  return <Modal visible={Boolean(target)} onRequestClose={onClose} animationType="slide" presentationStyle="fullScreen">
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Text style={styles.path} numberOfLines={3}>{preview?.path ?? target?.path}</Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close file" style={styles.close}><Text style={styles.closeText}>Done</Text></Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : !preview ? <ActivityIndicator style={styles.loading} color={colors.primary} /> : preview.kind === "image"
        ? <Image source={{ uri: `data:${preview.mimeType};base64,${preview.data}` }} style={styles.image} resizeMode="contain" accessibilityLabel={preview.path} />
        : <>
          <Text style={styles.info}>{preview.totalLines} lines{preview.truncated ? ` · Preview from line ${preview.startLine}` : ""}{target?.line ? ` · Line ${target.line}${target.column ? `, column ${target.column}` : ""}` : ""}</Text>
          <ScrollView><ScrollView horizontal contentContainerStyle={styles.code}>
            <View>{preview.content.split("\n").map((line, index) => <Text key={index} selectable style={[styles.line, target?.line === preview.startLine + index && styles.selected]}>
              <Text style={styles.lineNumber}>{String(preview.startLine + index).padStart(5)}  </Text>{line || " "}
            </Text>)}</View>
          </ScrollView></ScrollView>
        </>}
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { padding: 16, flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  path: { flex: 1, color: colors.foreground, fontFamily: font.mono, fontSize: 12 },
  close: { padding: 12 }, closeText: { color: colors.primary, fontSize: 16 },
  error: { color: colors.destructive, padding: 24 }, loading: { margin: 40 }, image: { flex: 1 },
  info: { color: colors.mutedForeground, fontSize: 11, padding: 12 }, code: { padding: 12 },
  line: { color: colors.foreground, fontFamily: font.mono, fontSize: 12, lineHeight: 20 },
  lineNumber: { color: colors.mutedForeground }, selected: { backgroundColor: colors.selection },
});

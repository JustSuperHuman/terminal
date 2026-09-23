import { createContext, useContext, useMemo } from "react";
import { Text, type TextProps } from "react-native";
import { findFileLinks, type FileLink } from "../lib/fileLinks";
import { colors } from "../theme";

export const OpenFileContext = createContext<((link: FileLink) => void) | undefined>(undefined);
/** ACP already identified this as a file, so no text heuristics are needed. */
export function FilePathText({ path, line, ...props }: Omit<TextProps, "children"> & FileLink) {
  const open = useContext(OpenFileContext);
  return <Text {...props} accessibilityRole="link" accessibilityLabel={`Open ${path}`} onPress={() => open?.({ path, line })} style={[props.style, { color: colors.primary, textDecorationLine: "underline" }]}>{path}{line ? `:${line}` : ""}</Text>;
}
export function FileLinkText({ children, ...props }: Omit<TextProps, "children"> & { children: string }) {
  const open = useContext(OpenFileContext);
  const links = useMemo(() => open ? findFileLinks(children) : [], [children, open]);
  let end = 0;
  const parts = links.flatMap((link) => {
    const before = children.slice(end, link.start); end = link.end;
    return [before, <Text key={link.start} accessibilityRole="link" accessibilityLabel={`Open ${link.path}`} onPress={() => open?.(link)} style={{ color: colors.primary, textDecorationLine: "underline" }}>{link.label}</Text>];
  });
  return <Text {...props}>{parts}{children.slice(end)}</Text>;
}

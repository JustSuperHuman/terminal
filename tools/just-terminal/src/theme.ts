import { Platform } from "react-native";

// JustGains brand system (from JustGains-Admin styles/variables.css):
// gold primary, orange secondary, warm neutral surfaces, accent green/blue/red.
// Applied as a dark, compact terminal UI.
export const colors = {
  // Brand
  primary: "#ffbf00", // gold (primary-500 / web-background)
  primaryBright: "#ffcf0d",
  primaryDim: "#d19a00",
  primaryForeground: "#241a00", // text on gold
  accent: "#ff6b35", // orange (secondary)
  accentDeep: "#ff5500",

  // Accent semantics
  success: "#4ac229",
  info: "#0090ff",
  purple: "#9933e9",
  destructive: "#f52d2d",
  destructiveForeground: "#fff3f3",
  warning: "#ffbf00",

  // Surfaces (warm neutrals, darkened for an app shell)
  background: "#14171c",
  surface: "#1b2027",
  surfaceAlt: "#222831", // neutral-950-ish elevated
  surfaceHi: "#2c333d",
  sidebar: "#11141a",
  sidebarActive: "#222a34",
  terminal: "#0b0d11",
  input: "#1b2027",

  // Lines
  border: "#2e3640",
  borderStrong: "#475466", // neutral-700

  // Text (neutrals)
  foreground: "#f6f8fa", // neutral-50
  secondaryForeground: "#e4e9ef",
  sidebarForeground: "#cdd4dc",
  mutedForeground: "#8c9aaf", // neutral-400
  faint: "#6d8199", // neutral-500
  terminalForeground: "#e6ecf1",

  overlay: "rgba(8, 10, 13, 0.68)",
} as const;

export const radius = {
  sm: 8,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

const monospace = Platform.select({ ios: "Menlo", default: "monospace" }) as string;

export const font = {
  regular: "Montserrat_400Regular",
  medium: "Montserrat_500Medium",
  semibold: "Montserrat_600SemiBold",
  bold: "Montserrat_700Bold",
  extrabold: "Montserrat_800ExtraBold",
  mono: monospace,
} as const;

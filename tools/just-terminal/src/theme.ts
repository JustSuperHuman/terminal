import { Platform } from "react-native";

// Terminal Companion design tokens — WinUI 3 / Fluent dark, matched to
// Windows Terminal itself. Neutral Mica-grey surfaces (never blue-tinted),
// the Windows dark-theme accent (#60CDFF) as the single hero hue, and the
// Fluent semantic hues (success green, caution yellow, critical red) for
// everything stateful. Chrome text is Selawik (Microsoft's open
// metric-compatible twin of Segoe UI); terminal text is Cascadia Mono —
// the same faces Windows Terminal renders with.
export const colors = {
  // Accent — the Windows 11 dark-theme accent. Filled accent controls in
  // WinUI dark use a light accent fill with *dark* text (see Settings' Save
  // buttons), which is why primaryForeground is near-black.
  primary: "#60cdff",
  primaryDim: "#4fb1e3", // pressed (accent fill drops ~10% in WinUI)
  primaryForeground: "#0b1a26",

  // Accent hues, one per control family (Fluent dark semantic ramp).
  accentCyan: "#60cdff", // navigation: arrows, Home/End, session switching
  accentMint: "#6ccb5f", // voice/dictation, running/success (SystemFillColorSuccess dark)
  accentAmber: "#fde300", // attachments, busy states (SystemFillColorCaution dark)
  accentCoral: "#ff99a4", // interrupt keys, errors, destructive (SystemFillColorCritical dark)

  // Semantics (aliases of the hues above so intent reads at the call site).
  success: "#6ccb5f",
  destructive: "#ff99a4",
  destructiveForeground: "#2b0b0e",

  // Surfaces — the WinUI dark neutral ramp. #202020 is Mica's base (and the
  // Windows Terminal tab row); layers step up in flat greys, never tinted.
  background: "#202020",
  surface: "#2b2b2b", // CardBackgroundFillColorDefault over Mica
  surfaceAlt: "#323232",
  surfaceHi: "#3a3a3a",
  selection: "rgba(96, 205, 255, 0.10)", // selected rows — a quiet accent wash
  terminal: "#0c0c0c", // Campbell background, exactly Windows Terminal's default
  input: "#2d2d2d", // ControlFillColorDefault (TextBox resting fill)

  // Lines — Fluent strokes are translucent white so they sit on any layer.
  border: "rgba(255, 255, 255, 0.08)",
  borderStrong: "rgba(255, 255, 255, 0.17)",

  // Text — Fluent TextFillColor primary/secondary/tertiary/disabled.
  foreground: "#ffffff",
  secondaryForeground: "#cecece",
  mutedForeground: "#9d9d9d",
  faint: "#6f6f6f",

  // Scrims (SmokeFillColorDefault, weighted for small screens).
  overlay: "rgba(0, 0, 0, 0.62)",
  overlaySoft: "rgba(0, 0, 0, 0.45)", // see-through: live content stays visible
} as const;

// Acrylic recipe shared by all floating chrome (command bar, swipe bar, menu
// button, toasts): the WinUI in-app acrylic — a Mica-grey tint over blur,
// faint raised fills for keys/chips, and one hairline surface stroke.
// On iOS the tint is genuinely translucent so the BlurView underneath shows
// through (components/Acrylic.tsx); on Android only the command bar and
// composer have a blur backing (dimezis needs a blurTarget ref), so the tint
// stays near-solid to keep small chrome legible over terminal output.
export const glass = {
  tint: Platform.OS === "ios" ? "rgba(32, 32, 32, 0.55)" : "rgba(32, 32, 32, 0.88)",
  raised: "rgba(255, 255, 255, 0.06)", // ControlFillColorDefault on acrylic
  raisedBorder: "rgba(255, 255, 255, 0.09)", // ControlStrokeColorDefault
  border: "rgba(255, 255, 255, 0.08)", // SurfaceStrokeColorFlyout
  pressed: "rgba(96, 205, 255, 0.20)",
  track: "rgba(255, 255, 255, 0.10)",
} as const;

/** Tint helper: a theme hex color at the given opacity (for accent glass). */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

// Fluent corner radii: 4px on controls (buttons, inputs, chips), 8px on
// surfaces (cards, flyouts, sheets). Windows 11 has no larger radius —
// "xl" stays at the overlay radius so sheets read as WinUI flyouts.
export const radius = {
  sm: 4,
  md: 4,
  lg: 8,
  xl: 8,
  pill: 999,
} as const;

// Selawik ships Regular/Semibold/Bold (Segoe UI Variable's ramp has no 500,
// so "medium" maps to Semibold — exactly what Fluent's BodyStrong does).
export const font = {
  regular: "Selawik",
  medium: "Selawik-Semibold",
  semibold: "Selawik-Semibold",
  bold: "Selawik-Bold",
  extrabold: "Selawik-Bold",
  mono: "CascadiaMono_400Regular",
  monoSemibold: "CascadiaMono_600SemiBold",
} as const;

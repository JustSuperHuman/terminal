import type { TerminalProfile } from "../types";

// Product-defined "quick launch" agents surfaced in the sessions drawer and the
// empty state. Each maps to a server profile by id; the profile supplies the
// real shell path, while `args` are the flags we always pass for that agent.
export interface QuickLaunch {
  profileId: string;
  label: string;
  args: string[];
}

export const QUICK_LAUNCHES: QuickLaunch[] = [
  { profileId: "codex", label: "Codex", args: ["--yolo"] },
  { profileId: "claude", label: "Claude", args: ["--dangerously-skip-permissions"] },
  { profileId: "hermes", label: "Hermes", args: ["--yolo"] },
];

export interface ResolvedQuickLaunch extends QuickLaunch {
  shell: string;
}

// Keep only the quick launches whose profile actually exists on this host, and
// attach the resolved shell so callers can create the session directly.
export function resolveQuickLaunches(profiles: TerminalProfile[]): ResolvedQuickLaunch[] {
  return QUICK_LAUNCHES.map((entry) => {
    const profile = profiles.find((candidate) => candidate.id === entry.profileId);
    return profile ? { ...entry, shell: profile.shell } : undefined;
  }).filter((entry): entry is ResolvedQuickLaunch => Boolean(entry));
}

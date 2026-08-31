import type { TerminalProfile } from "../types";

// A launch row is derived entirely from the desktop host's current Windows
// Terminal settings. There is intentionally no product-defined agent list:
// adding, hiding, renaming, or removing a desktop profile changes this list.
export interface QuickLaunch {
  profileId: string;
  label: string;
  shell: string;
  args: string[];
  description?: string;
  agent?: TerminalProfile["agent"];
}

export function resolveQuickLaunches(profiles: TerminalProfile[]): QuickLaunch[] {
  return profiles.map((profile) => ({
    profileId: profile.id,
    label: profile.label,
    shell: profile.shell,
    args: profile.args,
    description: profile.description,
    agent: profile.agent,
  }));
}

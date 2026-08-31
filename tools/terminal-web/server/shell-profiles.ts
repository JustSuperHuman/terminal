import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { inferTerminalAgent } from "./terminal-agent-metadata.js";
import type { TerminalProfile } from "./types.js";

type AgentProfileKind = NonNullable<TerminalProfile["agent"]>;

interface WindowsTerminalProfileJson {
  guid?: unknown;
  name?: unknown;
  commandline?: unknown;
  source?: unknown;
  hidden?: unknown;
}

interface WindowsTerminalSettingsJson {
  defaultProfile?: unknown;
  profiles?:
    | WindowsTerminalProfileJson[]
    | {
        defaults?: WindowsTerminalProfileJson;
        list?: WindowsTerminalProfileJson[];
      };
}

export interface ShellProfileStoreOptions {
  settingsPath?: string;
  pollIntervalMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface ProfileSnapshot {
  profiles: TerminalProfile[];
  defaultProfileId: string;
  settingsPath?: string;
}

function existingPath(candidate: string): string | undefined {
  return fs.existsSync(candidate) ? candidate : undefined;
}

function getPathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.Path ?? env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function commandCandidates(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (path.extname(command)) {
    return [command];
  }

  if (platform === "win32") {
    const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((entry) => entry.toLowerCase());
    return extensions.map((extension) => `${command}${extension}`);
  }

  return [command];
}

function findOnPath(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  for (const entry of getPathEntries(env)) {
    for (const candidate of commandCandidates(command, platform, env)) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

function getAgentProfiles(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): TerminalProfile[] {
  const profiles: TerminalProfile[] = [];
  const definitions: Array<{ id: AgentProfileKind; label: string; description: string }> = [
    { id: "codex", label: "Codex", description: "OpenAI Codex TUI" },
    { id: "claude", label: "Claude", description: "Claude Code TUI" },
    { id: "hermes", label: "Hermes", description: "Hermes Agent TUI" },
  ];

  for (const definition of definitions) {
    const shell = findOnPath(definition.id, platform, env);
    if (shell) {
      profiles.push({
        id: definition.id,
        label: definition.label,
        shell,
        args: [],
        group: "agent",
        description: definition.description,
        agent: definition.id,
      });
    }
  }

  return profiles;
}

function fallbackProfiles(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): TerminalProfile[] {
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const pwshPath = existingPath(path.join(programFiles, "PowerShell", "7", "pwsh.exe")) ?? "pwsh.exe";
    const profiles: TerminalProfile[] = [
      {
        id: "pwsh",
        label: "PowerShell 7",
        shell: pwshPath,
        args: ["-NoLogo"],
        group: "shell",
        description: "PowerShell 7",
      },
      {
        id: "windows-powershell",
        label: "Windows PowerShell",
        shell: path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args: ["-NoLogo"],
        group: "shell",
        description: "Windows PowerShell",
      },
      {
        id: "cmd",
        label: "Command Prompt",
        shell: env.ComSpec ?? "cmd.exe",
        args: [],
        group: "shell",
        description: "cmd.exe",
      },
    ];

    const wsl = existingPath(path.join(env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe"));
    if (wsl) {
      profiles.push({
        id: "wsl",
        label: "WSL",
        shell: wsl,
        args: [],
        group: "shell",
        description: "Windows Subsystem for Linux",
      });
    }

    return [...profiles, ...getAgentProfiles(platform, env)];
  }

  const shell = env.SHELL ?? (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
  return [
    {
      id: "default",
      label: path.basename(shell),
      shell,
      args: ["-l"],
      group: "shell",
      description: "Default login shell",
    },
    ...getAgentProfiles(platform, env),
  ];
}

function normalizeGuid(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const bare = value.trim().replace(/^\{|\}$/g, "").toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bare)
    ? `{${bare}}`
    : undefined;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => environmentValue(env, name) ?? whole);
}

/** Parse the Windows argv quoting rules used by profile `commandline` values. */
export function splitWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let cursor = 0;

  while (cursor < commandLine.length) {
    while (/\s/.test(commandLine[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= commandLine.length) {
      break;
    }

    let value = "";
    let quoted = false;
    while (cursor < commandLine.length && (quoted || !/\s/.test(commandLine[cursor] ?? ""))) {
      if (commandLine[cursor] === "\\") {
        const slashStart = cursor;
        while (commandLine[cursor] === "\\") {
          cursor += 1;
        }
        const slashCount = cursor - slashStart;
        if (commandLine[cursor] === '"') {
          value += "\\".repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 1) {
            value += '"';
          } else {
            quoted = !quoted;
          }
          cursor += 1;
        } else {
          value += "\\".repeat(slashCount);
        }
        continue;
      }

      if (commandLine[cursor] === '"') {
        quoted = !quoted;
        cursor += 1;
        continue;
      }

      value += commandLine[cursor];
      cursor += 1;
    }
    args.push(value);
  }

  return args;
}

function profileId(label: string, guid: string | undefined, agent: AgentProfileKind | undefined, used: Set<string>): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const preferred = agent ?? (slug || "profile");
  let candidate = preferred;
  if (used.has(candidate)) {
    candidate = guid ? `wt:${guid.slice(1, -1)}` : `wt:${preferred}`;
  }
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${preferred}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function parseSettings(text: string, settingsPath: string): WindowsTerminalSettingsJson {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as WindowsTerminalSettingsJson;
  if (errors.length > 0 || !parsed || typeof parsed !== "object") {
    const detail = errors.map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`).join(", ");
    throw new Error(`Could not parse Windows Terminal settings at ${settingsPath}${detail ? `: ${detail}` : "."}`);
  }
  return parsed;
}

export function readWindowsTerminalProfiles(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env
): { profiles: TerminalProfile[]; defaultProfileId?: string } {
  const settings = parseSettings(fs.readFileSync(settingsPath, "utf8"), settingsPath);
  const profilesNode = settings.profiles;
  const defaults = !Array.isArray(profilesNode) && profilesNode?.defaults ? profilesNode.defaults : {};
  const entries = Array.isArray(profilesNode) ? profilesNode : profilesNode?.list;
  if (!Array.isArray(entries)) {
    return { profiles: [] };
  }

  const fallback = fallbackProfiles("win32", env)[0]!;
  const profiles: TerminalProfile[] = [];
  const idByGuid = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = { ...defaults, ...rawEntry };
    if (entry.hidden === true || typeof entry.name !== "string" || !entry.name.trim()) {
      continue;
    }

    const label = entry.name.trim();
    const guid = normalizeGuid(entry.guid);
    const commandLine = typeof entry.commandline === "string" ? expandEnvironmentVariables(entry.commandline.trim(), env) : "";
    const argv = commandLine ? splitWindowsCommandLine(commandLine) : [];
    const agent = inferTerminalAgent(label, commandLine);
    const id = profileId(label, guid, agent, usedIds);
    const source = typeof entry.source === "string" && entry.source.trim() ? entry.source.trim() : undefined;
    const profile: TerminalProfile = {
      id,
      label,
      shell: argv[0] || fallback.shell,
      args: argv.length > 0 ? argv.slice(1) : fallback.args,
      group: agent ? "agent" : "custom",
      description: source ? `Windows Terminal · ${source}` : "Windows Terminal profile",
      agent,
      terminalProfileGuid: guid,
    };
    profiles.push(profile);
    if (guid) {
      idByGuid.set(guid, id);
    }
  }

  const defaultGuid = normalizeGuid(settings.defaultProfile);
  return {
    profiles,
    defaultProfileId: defaultGuid ? idByGuid.get(defaultGuid) : undefined,
  };
}

export function resolveWindowsTerminalSettingsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.TERMINAL_WEB_SETTINGS_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return undefined;
  }

  const candidates = [
    path.join(localAppData, "Packages", "WindowsTerminalDev_8wekyb3d8bbwe", "LocalState", "settings.json"),
    path.join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    path.join(localAppData, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
    path.join(localAppData, "Packages", "Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe", "LocalState", "settings.json"),
    path.join(localAppData, "Microsoft", "Windows Terminal", "settings.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function loadSnapshot(options: ShellProfileStoreOptions): ProfileSnapshot {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const settingsPath = options.settingsPath ?? resolveWindowsTerminalSettingsPath(env);
    if (settingsPath && fs.existsSync(settingsPath)) {
      const configured = readWindowsTerminalProfiles(settingsPath, env);
      if (configured.profiles.length > 0) {
        return {
          profiles: configured.profiles,
          defaultProfileId: configured.defaultProfileId ?? configured.profiles[0]!.id,
          settingsPath,
        };
      }
    }
  }

  const profiles = fallbackProfiles(platform, env);
  return { profiles, defaultProfileId: profiles[0]!.id };
}

function snapshotFingerprint(snapshot: ProfileSnapshot): string {
  return JSON.stringify({
    settingsPath: snapshot.settingsPath,
    defaultProfileId: snapshot.defaultProfileId,
    profiles: snapshot.profiles,
  });
}

/**
 * Live view of the desktop Terminal's visible profiles. Polling is deliberate:
 * settings saves commonly replace the file, which can detach an fs.watch
 * listener. A short read of the JSONC file also survives those atomic saves.
 */
export class ShellProfileStore extends EventEmitter {
  private snapshot: ProfileSnapshot;
  private fingerprint: string;
  private timer?: ReturnType<typeof setInterval>;
  private lastError = "";

  constructor(private readonly options: ShellProfileStoreOptions = {}) {
    super();
    try {
      this.snapshot = loadSnapshot(options);
    } catch (error) {
      const platform = options.platform ?? process.platform;
      const env = options.env ?? process.env;
      const profiles = fallbackProfiles(platform, env);
      this.snapshot = { profiles, defaultProfileId: profiles[0]!.id };
      this.reportError(error);
    }
    this.fingerprint = snapshotFingerprint(this.snapshot);

    const configuredInterval = options.pollIntervalMs ?? Number(process.env.TERMINAL_WEB_PROFILE_POLL_MS ?? 1000);
    const pollIntervalMs = Number.isFinite(configuredInterval) ? Math.max(0, configuredInterval) : 1000;
    if (pollIntervalMs > 0) {
      this.timer = setInterval(() => this.refresh(), pollIntervalMs);
      this.timer.unref?.();
    }
  }

  get profiles(): TerminalProfile[] {
    return this.snapshot.profiles;
  }

  get defaultProfile(): TerminalProfile {
    return this.snapshot.profiles.find((profile) => profile.id === this.snapshot.defaultProfileId) ?? this.snapshot.profiles[0]!;
  }

  get settingsPath(): string | undefined {
    return this.snapshot.settingsPath;
  }

  refresh(): boolean {
    try {
      const next = loadSnapshot(this.options);
      const fingerprint = snapshotFingerprint(next);
      this.lastError = "";
      if (fingerprint === this.fingerprint) {
        return false;
      }
      this.snapshot = next;
      this.fingerprint = fingerprint;
      this.emit("change", this.profiles);
      return true;
    } catch (error) {
      // A settings save can be observable between truncate and rewrite. Keep
      // the last valid list and retry on the next poll instead of flashing the
      // mobile launcher back to fallback profiles.
      this.reportError(error);
      return false;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.lastError) {
      this.lastError = message;
      console.warn(`Windows Terminal profiles could not be refreshed: ${message}`);
    }
  }
}

export function getShellProfiles(): TerminalProfile[] {
  return loadSnapshot({}).profiles;
}

export function getDefaultProfile(): TerminalProfile {
  const snapshot = loadSnapshot({});
  return snapshot.profiles.find((profile) => profile.id === snapshot.defaultProfileId) ?? snapshot.profiles[0]!;
}

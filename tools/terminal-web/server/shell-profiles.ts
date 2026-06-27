import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TerminalProfile } from "./types.js";

function existingPath(candidate: string): string | undefined {
  return fs.existsSync(candidate) ? candidate : undefined;
}

function getPathEntries(): string[] {
  return (process.env.Path ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function commandCandidates(command: string): string[] {
  if (path.extname(command)) {
    return [command];
  }

  if (process.platform === "win32") {
    const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((entry) => entry.toLowerCase());
    return extensions.map((extension) => `${command}${extension}`);
  }

  return [command];
}

function findOnPath(command: string): string | undefined {
  for (const entry of getPathEntries()) {
    for (const candidate of commandCandidates(command)) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

function getAgentProfiles(): TerminalProfile[] {
  const profiles: TerminalProfile[] = [];
  const codex = findOnPath("codex");
  const claude = findOnPath("claude");

  if (codex) {
    profiles.push({
      id: "codex",
      label: "Codex",
      shell: codex,
      args: [],
      group: "agent",
      description: "OpenAI Codex TUI"
    });
  }

  if (claude) {
    profiles.push({
      id: "claude",
      label: "Claude",
      shell: claude,
      args: [],
      group: "agent",
      description: "Claude Code TUI"
    });
  }

  return profiles;
}

export function getShellProfiles(): TerminalProfile[] {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const pwshPath =
      existingPath(path.join(programFiles, "PowerShell", "7", "pwsh.exe")) ??
      "pwsh.exe";

    const profiles: TerminalProfile[] = [
      {
        id: "pwsh",
        label: "PowerShell 7",
        shell: pwshPath,
        args: ["-NoLogo"],
        group: "shell",
        description: "PowerShell 7"
      },
      {
        id: "windows-powershell",
        label: "Windows PowerShell",
        shell: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args: ["-NoLogo"],
        group: "shell",
        description: "Windows PowerShell"
      },
      {
        id: "cmd",
        label: "Command Prompt",
        shell: process.env.ComSpec ?? "cmd.exe",
        args: [],
        group: "shell",
        description: "cmd.exe"
      }
    ];

    const wsl = existingPath(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe"));
    if (wsl) {
      profiles.push({
        id: "wsl",
        label: "WSL",
        shell: wsl,
        args: [],
        group: "shell",
        description: "Windows Subsystem for Linux"
      });
    }

    return [...profiles, ...getAgentProfiles()];
  }

  const shell = process.env.SHELL ?? (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
  const profiles: TerminalProfile[] = [
    {
      id: "default",
      label: path.basename(shell),
      shell,
      args: ["-l"],
      group: "shell",
      description: "Default login shell"
    }
  ];

  return [...profiles, ...getAgentProfiles()];
}

export function getDefaultProfile(): TerminalProfile {
  return getShellProfiles()[0];
}

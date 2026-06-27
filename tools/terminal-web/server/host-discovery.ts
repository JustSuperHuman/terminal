import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostTerminalProcess } from "./types.js";

const execFileAsync = promisify(execFile);

const attachReason =
  "Existing terminal windows do not expose their ConPTY stream. Start a managed session here for stable control.";

function normalizeProcess(value: any): HostTerminalProcess | undefined {
  const pid = Number(value.ProcessId ?? value.pid);
  if (!Number.isFinite(pid)) {
    return undefined;
  }

  const name = String(value.Name ?? value.name ?? "process");
  const commandLine = value.CommandLine ? String(value.CommandLine) : undefined;
  if (isNoisyHelperProcess(name, commandLine)) {
    return undefined;
  }

  return {
    pid,
    ppid: Number(value.ParentProcessId ?? value.ppid) || undefined,
    name,
    commandLine,
    executablePath: value.ExecutablePath ? String(value.ExecutablePath) : undefined,
    attachable: false,
    reason: attachReason
  };
}

function isNoisyHelperProcess(name: string, commandLine?: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerCommand = commandLine?.toLowerCase() ?? "";

  if (lowerName === "chrome-native-host.exe") {
    return true;
  }
  if (lowerName === "claude.exe" && /--type=(renderer|gpu-process|utility|crashpad-handler)/.test(lowerCommand)) {
    return true;
  }
  return false;
}

function parseJsonList(stdout: string): HostTerminalProcess[] {
  if (!stdout.trim()) {
    return [];
  }

  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return sortHostProcesses(list.map(normalizeProcess).filter(Boolean) as HostTerminalProcess[]);
}

function processPriority(process: HostTerminalProcess): number {
  const name = process.name.toLowerCase();
  const commandLine = process.commandLine?.toLowerCase() ?? "";
  const text = `${name} ${commandLine}`;

  if (/\b(codex|claude)\b/.test(text)) {
    return 0;
  }
  if (name === "windowsterminal.exe") {
    return 1;
  }
  if (["pwsh.exe", "powershell.exe", "cmd.exe", "wsl.exe", "bash.exe"].includes(name)) {
    return 2;
  }
  if (name === "openconsole.exe") {
    return 3;
  }
  if (name === "conhost.exe") {
    return 9;
  }
  return 5;
}

function sortHostProcesses(processes: HostTerminalProcess[]): HostTerminalProcess[] {
  return processes.sort((a, b) => {
    const priority = processPriority(a) - processPriority(b);
    if (priority !== 0) {
      return priority;
    }
    const name = a.name.localeCompare(b.name);
    if (name !== 0) {
      return name;
    }
    return a.pid - b.pid;
  });
}

export async function discoverHostTerminals(): Promise<HostTerminalProcess[]> {
  try {
    if (process.platform === "win32") {
      const script = [
        "$names = @('WindowsTerminal.exe','OpenConsole.exe','conhost.exe','pwsh.exe','powershell.exe','cmd.exe','bash.exe','wsl.exe')",
        "$items = Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name -or ($_.CommandLine -match '(?i)\\b(codex|claude)\\b') }",
        "$items | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Depth 3"
      ].join("; ");

      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 }
      );
      return parseJsonList(stdout);
    }

    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
      timeout: 4000,
      maxBuffer: 1024 * 1024
    });

    return sortHostProcesses(stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
        if (!match) {
          return undefined;
        }
        const [, pid, ppid, name, args] = match;
        if (!/(terminal|bash|zsh|fish|pwsh|powershell|cmd|wsl|codex|claude)/i.test(`${name} ${args}`)) {
          return undefined;
        }
        return normalizeProcess({
          pid,
          ppid,
          name,
          CommandLine: args
        });
      })
      .filter(Boolean) as HostTerminalProcess[]);
  } catch {
    return [];
  }
}

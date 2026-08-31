import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { ShellProfileStore, readWindowsTerminalProfiles, splitWindowsCommandLine } from "./shell-profiles.js";
import type { TerminalProfile } from "./types.js";

const tempDirectories: string[] = [];

function temporarySettings(contents: string): { directory: string; settingsPath: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-profiles-test-"));
  const settingsPath = path.join(directory, "settings.json");
  writeFileSync(settingsPath, contents, "utf8");
  tempDirectories.push(directory);
  return { directory, settingsPath };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows Terminal profiles", () => {
  test("parses JSONC, hides hidden profiles, and preserves configured commands", () => {
    const { settingsPath } = temporarySettings(`{
      // Windows Terminal settings are JSONC and commonly have trailing commas.
      "defaultProfile": "{11111111-1111-1111-1111-111111111111}",
      "profiles": {
        "defaults": { "startingDirectory": "%USERPROFILE%" },
        "list": [
          {
            "guid": "{11111111-1111-1111-1111-111111111111}",
            "name": "Codex Work",
            "commandline": "powershell.exe codex --yolo",
          },
          {
            "guid": "{22222222-2222-2222-2222-222222222222}",
            "name": "Bro CLI",
            "commandline": "powershell.exe bro",
          },
          {
            "guid": "{33333333-3333-3333-3333-333333333333}",
            "name": "Hidden Hermes",
            "commandline": "hermes",
            "hidden": true,
          },
        ],
      },
    }`);

    const result = readWindowsTerminalProfiles(settingsPath, {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });

    assert.deepEqual(result.profiles.map((profile) => profile.label), ["Codex Work", "Bro CLI"]);
    assert.equal(result.defaultProfileId, "codex");
    assert.deepEqual({
      id: result.profiles[0]?.id,
      shell: result.profiles[0]?.shell,
      args: result.profiles[0]?.args,
      agent: result.profiles[0]?.agent,
      terminalProfileGuid: result.profiles[0]?.terminalProfileGuid,
    }, {
      id: "codex",
      shell: "powershell.exe",
      args: ["codex", "--yolo"],
      agent: "codex",
      terminalProfileGuid: "{11111111-1111-1111-1111-111111111111}",
    });
    assert.deepEqual({
      id: result.profiles[1]?.id,
      shell: result.profiles[1]?.shell,
      args: result.profiles[1]?.args,
      agent: result.profiles[1]?.agent,
      terminalProfileGuid: result.profiles[1]?.terminalProfileGuid,
    }, {
      id: "bro-cli",
      shell: "powershell.exe",
      args: ["bro"],
      agent: undefined,
      terminalProfileGuid: "{22222222-2222-2222-2222-222222222222}",
    });
  });

  test("refreshes programmatically and retains the last valid list during an atomic save", () => {
    const { settingsPath } = temporarySettings(JSON.stringify({
      defaultProfile: "{11111111-1111-1111-1111-111111111111}",
      profiles: {
        list: [{
          guid: "{11111111-1111-1111-1111-111111111111}",
          name: "Codex",
          commandline: "powershell.exe codex --yolo",
        }],
      },
    }));
    const store = new ShellProfileStore({
      settingsPath,
      pollIntervalMs: 0,
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    });
    const changes: string[][] = [];
    store.on("change", (profiles: TerminalProfile[]) => changes.push(profiles.map((profile) => profile.label)));

    writeFileSync(settingsPath, "{", "utf8");
    assert.equal(store.refresh(), false);
    assert.deepEqual(store.profiles.map((profile) => profile.label), ["Codex"]);

    writeFileSync(settingsPath, JSON.stringify({
      defaultProfile: "{22222222-2222-2222-2222-222222222222}",
      profiles: {
        list: [{
          guid: "{22222222-2222-2222-2222-222222222222}",
          name: "Claude Personal",
          commandline: "powershell.exe clawd",
        }],
      },
    }), "utf8");

    assert.equal(store.refresh(), true);
    assert.deepEqual(changes, [["Claude Personal"]]);
    assert.equal(store.profiles[0]?.id, "claude");
    assert.equal(store.profiles[0]?.agent, "claude");
    store.dispose();
    assert.match(readFileSync(settingsPath, "utf8"), /Claude Personal/);
  });

  test("uses Windows command-line quoting rules", () => {
    assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -Command "codex --yolo"'), [
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "-NoLogo",
      "-Command",
      "codex --yolo",
    ]);
  });
});

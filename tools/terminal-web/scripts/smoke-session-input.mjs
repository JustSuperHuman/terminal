// Checks the composer's screen heuristics — agent fingerprinting, busy
// detection and one-tap prompt extraction — against fixture screens and, when
// a host is reachable, against every session it is currently mirroring.
//
//   node scripts/smoke-session-input.mjs [http://127.0.0.1:10001]

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Left registered for the life of the process: unregistering the hooks before
// exit trips a libuv handle assertion on Windows.
require("tsx/esm/api").register();
const { detectAgent, detectPrompt, describeInputContext, planPromptResponse } = await import(
  new URL("../server/session-input.ts", import.meta.url).href
);

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function checkThrows(label, run, expectedMessage) {
  let actual;
  try {
    run();
    actual = "did not throw";
  } catch (error) {
    actual = error instanceof Error ? error.message : String(error);
  }
  check(label, actual, expectedMessage);
}

// A bridged session reports its whole command line as `shell`, quotes and all.
const shellSession = { id: "s", shell: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo', args: [], cwd: "F:\\terminal", status: "running" };
const claudeSession = { ...shellSession, shell: "C:\\Users\\me\\.local\\bin\\claude.exe", args: ["--dangerously-skip-permissions"] };
const codexInShell = { ...shellSession, shell: "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe codex --yolo" };
const broSession = { ...shellSession, shell: "powershell.exe", args: ["bro"] };

// bro is a launcher, not an agent: its picker mentions both harnesses and the
// provider can differ from the eventual harness. Until the selected TUI paints
// a conclusive screen, the terminal must remain unclassified.
const BRO_PICKER = [
  "Choose a provider and model:",
  " ❯ Claude subscription",
  "   Codex subscription",
  "   OpenRouter",
  "",
  "  [h] Harness  CLAUDE │ OMP │ PI │ CODEX │ DEEPSEEK",
  "  ↑/↓ move · enter select · h harness · esc cancel"
].join("\n");

// A Claude Code screen: transcript, the framed input box, the mode footer.
const CLAUDE_IDLE = [
  "  3 tasks (2 done, 1 in progress, 0 open)",
  "  ✔ Fix ExerciseService.MergeExercise data-loss gaps",
  "───────────────────────────────────────────────────────────",
  "❯ ",
  "───────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks · ← for agents"
].join("\n");

const CLAUDE_BUSY = [
  "✽ Building server input-context detection… (7m 6s · ↓ 26.2k tokens)",
  "───────────────────────────────────────────────────────────",
  "❯ ",
  "───────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ctrl+t to hide tasks"
].join("\n");

const CLAUDE_PERMISSION = [
  "╭──────────────────────────────────────────────────────────╮",
  "│ Bash command                                             │",
  "│                                                          │",
  "│   rm -rf build                                           │",
  "│   Remove the build directory                             │",
  "│                                                          │",
  "│ Do you want to proceed?                                  │",
  "│ ❯ 1. Yes                                                 │",
  "│   2. Yes, and don't ask again for rm commands            │",
  "│   3. No, and tell Claude what to do differently (esc)    │",
  "╰──────────────────────────────────────────────────────────╯"
].join("\n");

// The same dialog as the phone actually sees it: the framed input box and the
// mode footer sit below it, which must not push it out of "live prompt" range.
const CLAUDE_PERMISSION_FULL = [
  CLAUDE_PERMISSION,
  "───────────────────────────────────────────────────────────",
  "❯ ",
  "───────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks"
].join("\n");

// Codex asks the same way, with its own frame and status footer.
const CODEX_APPROVAL = [
  "▌ Allow Codex to run `rm -rf build`?",
  "▌ ❯ 1. Yes, proceed",
  "▌   2. No, provide feedback",
  "",
  "› ",
  "  gpt-5.6-sol max · J:\\justgains"
].join("\n");

// Claude's /model picker: a real menu whose own hint lines sit below it.
const CLAUDE_MODEL_MENU = [
  "  Select model",
  "  Switch between Claude models. Your pick becomes the default for new sessions.",
  "",
  "    1. Default (recommended)    Opus 5 with 1M context",
  "  ❯ 2. Opus (1M context) ✔      Opus 5 with 1M context",
  "    3. Fable                    Fable 5 · Most capable",
  "    4. Sonnet                   Sonnet 5 · Efficient",
  "    5. Haiku                    Haiku 4.5 · Fastest",
  "",
  "  ◉ xHigh effort ↵/→ to adjust",
  "",
  "  Use /fast to turn on Fast mode (Opus 5).",
  "",
  "  Enter to set as default · s to use this session only · Esc to cancel"
].join("\n");

// Current Codex request_user_input: progress, descriptions, a write-in option,
// notes, cross-question navigation, and an interrupt action.
const CODEX_REQUEST = [
  "Question 1/2 (2 unanswered)",
  "Which database should we use?",
  "",
  "  1. SQLite             Small and local.",
  "› 2. PostgreSQL         Shared and production-ready.",
  "  3. None of the above  Add another answer.",
  "",
  "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt"
].join("\n");

const CODEX_FREEFORM = [
  "Question 2/2 (1 unanswered)",
  "Share any rollout constraints.",
  "› Type your answer (optional)",
  "enter to submit answer | esc to interrupt"
].join("\n");

const CODEX_NOTES = [
  "Question 1/2 (2 unanswered)",
  "Which database should we use?",
  "  1. SQLite",
  "› 2. PostgreSQL",
  "  3. None of the above",
  "› Add notes",
  "enter to submit answer | esc to interrupt"
].join("\n");

// Claude's first-run safety picker is a real, unnumbered two-row menu.
const CLAUDE_TRUST = [
  "Accessing workspace:",
  "F:\\terminal",
  "Quick safety check: Is this a project you created or one you trust?",
  "Claude may read, edit, or execute files in this folder.",
  "",
  "❯ No, exit",
  "  Yes, I trust this folder",
  "",
  "Enter to confirm · Esc to cancel"
].join("\n");

// Claude's screen-reader fallback expects all selected option numbers in one
// text response instead of cursor toggles.
const CLAUDE_AX_MULTI = [
  "Which clients should receive the feature?",
  "1. (selected) iOS — Apple mobile app.",
  "2. (not selected) Android — Google mobile app.",
  "3. (selected) Web — Browser client.",
  "Enter selections (comma- or space-separated) [1-3] then Enter to Submit"
].join("\n");

const CLAUDE_AX_SINGLE = [
  "Which environment should receive the build?",
  "1. (selected) Testing — Internal users.",
  "2. (not selected) Production — Everyone.",
  "Enter a selection [1-2] then Enter to Submit"
].join("\n");

// Visual multi-select menus have independent checked rows and a Submit/Next
// cursor target after the numbered options.
const CLAUDE_VISUAL_MULTI = [
  "Question 1/2 (2 unanswered)",
  "Choose every integration that applies.",
  "❯ 1. [x] Slack       Team notifications.",
  "  2. [ ] Teams       Microsoft notifications.",
  "  3. [ ] Other       Write another integration.",
  "  Submit",
  "Enter to select · ↑/↓ to navigate · n to add notes · tab to switch questions · Esc to cancel"
].join("\n");

const WRAPPED_DESCRIPTIONS = [
  "Pick a deployment strategy.",
  "❯ 1. Blue/green  Keep both production pools alive",
  "     until health checks and traffic migration finish.",
  "  2. Rolling     Replace instances incrementally.",
  "Enter to confirm · Esc to cancel"
].join("\n");

const TWELVE_OPTIONS = [
  "Pick a numbered target.",
  ...Array.from({ length: 12 }, (_, index) => `${index === 0 ? "❯ " : "  "}${index + 1}. Target ${index + 1}`),
  "Enter to confirm · Esc to cancel"
].join("\n");

const WRAPPED_QUESTION = [
  "Should the mobile client preserve the current draft when the terminal is resized or",
  "backgrounded while a question is still waiting?",
  "❯ 1. Yes",
  "  2. No",
  "Enter to confirm · Esc to cancel"
].join("\n");

const DISABLED_OPTION = [
  "Choose an account scope.",
  "❯ 1. This workspace",
  "  2. (disabled) Every workspace — Requires an administrator.",
  "Enter to confirm · Esc to cancel"
].join("\n");

const CODEX_UNANSWERED_REVIEW = [
  "Submit with unanswered questions?",
  "2 unanswered questions",
  "› 1. Proceed  Submit the answers already provided.",
  "  2. Go back  Return to the unanswered questions.",
  "Press enter to confirm or esc to go back"
].join("\n");

// The same shape without a selection caret: prose, not a menu.
const CLAUDE_NUMBERED_ANSWER = [
  "Here is what I would do:",
  "",
  "  1. Rename the handler",
  "  2. Add a regression test",
  "  3. Ship it",
  "",
  "───────────────────────────────────────────────────────────",
  "❯ ",
  "───────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
].join("\n");

const CODEX_BUSY = [
  "◦ Running dotnet test JustGains-API.Tests/JustGains-API.Tests.csproj",
  "    … +56 lines (ctrl + t to view transcript)",
  "",
  "• Working (1m 02s • esc to interrupt)",
  "",
  "› Summarize recent commits",
  " ",
  "  gpt-5.6-sol max · J:\\justgains"
].join("\n");

const SHELL_SCREEN = [
  "PS F:\\terminal> git status",
  "On branch voice-dictation",
  "nothing to commit, working tree clean",
  "PS F:\\terminal> "
].join("\n");

// A numbered list in the transcript is not a live prompt.
const SHELL_WITH_LIST = [
  "Steps:",
  "1. Install the dependencies",
  "2. Run the build",
  "3. Ship it",
  "",
  "PS F:\\terminal> git log --oneline",
  "592168d46 JustTerminal: X-style full-screen sessions view",
  "6b5400555 Checkpoint before JustTerminal UI overhaul",
  "2a80a5e2b JustTerminal: keep terminal rows above the keyboard",
  "1d5106354 JustTerminal: heal terminal render after backgrounding",
  "b6301f9b5 JustTerminal: fix session-switch ghosting",
  "PS F:\\terminal> "
].join("\n");

check("claude idle screen -> claude", detectAgent(shellSession, CLAUDE_IDLE).agent, "claude");
check("claude busy screen -> claude", detectAgent(shellSession, CLAUDE_BUSY).agent, "claude");
check("codex screen -> codex", detectAgent(shellSession, CODEX_BUSY).agent, "codex");
check("bare shell -> shell", detectAgent(shellSession, SHELL_SCREEN).agent, "shell");
check("shell label", detectAgent(shellSession, SHELL_SCREEN).label, "PowerShell");
check("claude launch command with no TUI yet", detectAgent(claudeSession, "").agent, "claude");
// After a host restart a bridged session's buffer is empty until it prints
// again, so the launch command is all there is to go on.
check("codex launched inside a shell, empty buffer", detectAgent(codexInShell, "").agent, "codex");
check("quoted command line yields a clean shell label", detectAgent(shellSession, SHELL_SCREEN).label, "PowerShell");
// A managed session passes a bare path plus separate args; the path itself
// contains a space, so the executable cannot be found by splitting on one.
check(
  "unquoted path with a space",
  detectAgent({ ...shellSession, shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo"] }, SHELL_SCREEN).label,
  "PowerShell"
);
check("posix shell", detectAgent({ ...shellSession, shell: "/bin/bash", args: ["-l"] }, "$ ls\n$ ").label, "bash");
check("codex TUI beats a claude launch command", detectAgent(claudeSession, CODEX_BUSY).agent, "codex");
check("bro picker does not guess a harness", detectAgent(broSession, BRO_PICKER).agent, "shell");
check("bro-launched Claude is classified from its TUI", detectAgent(broSession, CLAUDE_IDLE).agent, "claude");
check("bro-launched Codex is classified from its TUI", detectAgent(broSession, CODEX_BUSY).agent, "codex");
check(
  "bro OSC metadata identifies Claude before its TUI draws",
  detectAgent({ ...broSession, agent: "claude", agentSource: "osc" }, "").agent,
  "claude"
);
check(
  "visible Codex TUI overrides stale Claude metadata",
  detectAgent({ ...broSession, agent: "claude", agentSource: "osc" }, CODEX_BUSY).agent,
  "codex"
);

const modes = { altScreen: true, bracketedPaste: true, applicationCursor: true, mouse: false };
check("idle claude is not busy", describeInputContext(shellSession, CLAUDE_IDLE, modes).busy, false);
check("working claude is busy", describeInputContext(shellSession, CLAUDE_BUSY, modes).busy, true);
check("working codex is busy", describeInputContext(shellSession, CODEX_BUSY, modes).busy, true);
check("modes are passed through", describeInputContext(shellSession, CLAUDE_IDLE, modes).bracketedPaste, true);
// A bridged mirror that missed the DECSET must still paste into an agent.
const plainModes = { altScreen: false, bracketedPaste: false, applicationCursor: false, mouse: false };
check("agents are paste-safe even with modes unseen", describeInputContext(shellSession, CLAUDE_IDLE, plainModes).pasteSafe, true);
check("a bare shell is not assumed paste-safe", describeInputContext(shellSession, SHELL_SCREEN, plainModes).pasteSafe, false);
check("an observed DECSET makes any session paste-safe", describeInputContext(shellSession, SHELL_SCREEN, modes).pasteSafe, true);
check(
  "exited sessions report no prompt",
  describeInputContext({ ...shellSession, status: "exited" }, CLAUDE_PERMISSION, modes).prompt,
  undefined
);

const permission = detectPrompt(CLAUDE_PERMISSION);
check("permission dialog is a single-select prompt", permission?.kind, "single-select");
check("permission question", permission?.question, "Do you want to proceed?");
check("permission option keys", permission?.options.map((option) => option.key), ["1", "2", "3"]);
check("permission first option", permission?.options[0]?.label, "Yes");
check("permission third option", permission?.options[2]?.label, "No, and tell Claude what to do differently (esc)");

check("prompt survives the input box and footer below it", detectPrompt(CLAUDE_PERMISSION_FULL)?.options.length, 3);
check("codex approval is a choice prompt", detectPrompt(CODEX_APPROVAL)?.options.map((option) => option.label), [
  "Yes, proceed",
  "No, provide feedback"
]);
check("codex approval question", detectPrompt(CODEX_APPROVAL)?.question, "Allow Codex to run `rm -rf build`?");
check("/model picker is a choice prompt", detectPrompt(CLAUDE_MODEL_MENU)?.options.length, 5);
// The question is the nearest line above the options that opens a sentence —
// for a dialog that is the actual question, for a picker its explanation.
check(
  "/model picker question skips the wrapped continuation",
  detectPrompt(CLAUDE_MODEL_MENU)?.question,
  "Switch between Claude models. Your pick becomes the default for new sessions."
);
check("column padding is trimmed off the label", detectPrompt(CLAUDE_MODEL_MENU)?.options[1]?.label, "Opus (1M context) ✔");
const codexRequest = detectPrompt(CODEX_REQUEST);
check("Codex question kind", codexRequest?.kind, "single-select");
check("Codex progress", codexRequest?.progress, { current: 1, total: 2, unanswered: 2 });
check("Codex descriptions", codexRequest?.options[1]?.description, "Shared and production-ready.");
check("Codex write-in is marked custom", codexRequest?.options[2]?.custom, true);
check("Codex notes are available", codexRequest?.acceptsNotes, true);
check("prompt id ignores cursor focus", detectPrompt(CODEX_REQUEST.replace("› 2.", "  2.").replace("  1.", "› 1."))?.id, codexRequest?.id);

const freeform = detectPrompt(CODEX_FREEFORM);
check("freeform question", freeform?.kind, "freeform");
check("freeform is optional", freeform?.textInput?.optional, true);
check("freeform prompt keeps question progress", freeform?.progress, { current: 2, total: 2, unanswered: 1 });
check("notes input is distinguished", detectPrompt(CODEX_NOTES)?.textInput?.kind, "notes");

const trust = detectPrompt(CLAUDE_TRUST);
check("unnumbered Claude trust menu", trust?.options.map((option) => option.label), ["No, exit", "Yes, I trust this folder"]);
check("unnumbered menu uses cursor interaction", trust?.interaction, "cursor");
check("trust menu retains dialog title", trust?.title, "Accessing workspace");

const axMulti = detectPrompt(CLAUDE_AX_MULTI);
check("Claude accessibility multi-select", axMulti?.kind, "multi-select");
check("Claude accessibility interaction", axMulti?.interaction, "numeric-input");
check("Claude accessibility selected state", axMulti?.options.map((option) => option.selected), [true, false, true]);
const axSingle = detectPrompt(CLAUDE_AX_SINGLE);
check("screen-reader radio state stays single-select", axSingle?.kind, "single-select");
check("screen-reader single choice expects typed input", axSingle?.interaction, "numeric-input");

const visualMulti = detectPrompt(CLAUDE_VISUAL_MULTI);
check("Claude visual multi-select", visualMulti?.kind, "multi-select");
check("Claude visual submit cursor", visualMulti?.submitTarget, { index: 3, focused: false });
check("Claude visual notes shortcut", visualMulti?.acceptsNotes, true);
check("wrapped description is retained", detectPrompt(WRAPPED_DESCRIPTIONS)?.options[0]?.description, "Keep both production pools alive until health checks and traffic migration finish.");
check("more than nine options are retained", detectPrompt(TWELVE_OPTIONS)?.options.length, 12);
check(
  "wrapped question lines are reassembled",
  detectPrompt(WRAPPED_QUESTION)?.question,
  "Should the mobile client preserve the current draft when the terminal is resized or backgrounded while a question is still waiting?"
);
check("disabled options are identified", detectPrompt(DISABLED_OPTION)?.options[1]?.disabled, true);
check("Codex unanswered review is actionable", detectPrompt(CODEX_UNANSWERED_REVIEW)?.options.map((option) => option.label), [
  "Proceed",
  "Go back"
]);
check("progress changes prompt identity", detectPrompt(CODEX_REQUEST.replace("Question 1/2", "Question 2/2"))?.id === codexRequest?.id, false);
check("permission details change prompt identity", detectPrompt(CLAUDE_PERMISSION.replace("rm -rf build", "bun run build"))?.id === permission?.id, false);
check("a numbered answer with no caret is not a menu", detectPrompt(CLAUDE_NUMBERED_ANSWER), undefined);
check("no prompt on an idle screen", detectPrompt(CLAUDE_IDLE), undefined);
check("no prompt while working", detectPrompt(CODEX_BUSY), undefined);
check("a numbered list in scrollback is not a prompt", detectPrompt(SHELL_WITH_LIST), undefined);
check("answered numbered prompt is no longer live", detectPrompt(`${CODEX_REQUEST}\nANSWER:2`), undefined);
check("answered unnumbered prompt is no longer live", detectPrompt(`${CLAUDE_TRUST}\nANSWER:Yes`), undefined);
check("submitted freeform prompt is no longer live", detectPrompt(`${CODEX_FREEFORM}\nSaved answer`), undefined);
check("answered y/n prompt is no longer live", detectPrompt("Overwrite existing file? (y/n)\nNo"), undefined);
check(
  "y/n question is a confirm prompt",
  detectPrompt("Overwrite existing file? (y/n) ")?.options.map((option) => option.key),
  ["y", "n"]
);

// Semantic response planning covers direct shortcuts, cursor-only menus,
// write-ins, accessibility input, explicit Submit rows, text and cancellation.
if (codexRequest) {
  check(
    "single choice uses its direct digit",
    planPromptResponse(codexRequest, { action: "select", optionId: codexRequest.options[1].id }, { applicationCursor: false }, "codex"),
    { method: "keys", data: "2", consumesPrompt: true }
  );
  check(
    "write-in navigates and opens text",
    planPromptResponse(codexRequest, { action: "select", optionId: codexRequest.options[2].id }, { applicationCursor: true }, "codex"),
    { method: "keys", data: "\x1bOB\r", consumesPrompt: true }
  );
  check(
    "Codex notes use Tab",
    planPromptResponse(codexRequest, { action: "open-notes" }, { applicationCursor: false }, "codex"),
    { method: "keys", data: "\t", consumesPrompt: false }
  );
}
if (trust) {
  check(
    "unnumbered choice uses cursor and Enter",
    planPromptResponse(trust, { action: "select", optionId: trust.options[1].id }, { applicationCursor: false }, "claude"),
    { method: "keys", data: "\x1b[B\r", consumesPrompt: true }
  );
}
if (axMulti) {
  check(
    "screen-reader selections submit together",
    planPromptResponse(axMulti, { action: "submit", optionIds: [axMulti.options[0].id, axMulti.options[2].id] }, { applicationCursor: false }, "claude"),
    { method: "keys", data: "1,3\r", consumesPrompt: true }
  );
}
if (axSingle) {
  check(
    "screen-reader single choice types its number and Enter",
    planPromptResponse(axSingle, { action: "select", optionId: axSingle.options[1].id }, { applicationCursor: false }, "claude"),
    { method: "keys", data: "2\r", consumesPrompt: true }
  );
}
if (visualMulti) {
  check(
    "visual multi-select navigates to Submit",
    planPromptResponse(visualMulti, { action: "submit" }, { applicationCursor: false }, "claude"),
    { method: "keys", data: "\x1b[B\x1b[B\x1b[B\r", consumesPrompt: true }
  );
}
const twelve = detectPrompt(TWELVE_OPTIONS);
if (twelve) {
  check(
    "two-digit option falls back to cursor navigation",
    planPromptResponse(twelve, { action: "select", optionId: twelve.options[9].id }, { applicationCursor: false }, "codex"),
    { method: "keys", data: `${"\x1b[B".repeat(9)}\r`, consumesPrompt: true }
  );
}
const disabledPrompt = detectPrompt(DISABLED_OPTION);
if (disabledPrompt) {
  checkThrows(
    "disabled option cannot be sent",
    () =>
      planPromptResponse(
        disabledPrompt,
        { action: "select", optionId: disabledPrompt.options[1].id },
        { applicationCursor: false },
        "claude"
      ),
    "That option is disabled."
  );
  check(
    "cancel always maps to Escape",
    planPromptResponse(disabledPrompt, { action: "cancel" }, { applicationCursor: false }, "claude"),
    { method: "keys", data: "\x1b", consumesPrompt: true }
  );
}
if (freeform) {
  check(
    "free text is composed and submitted",
    planPromptResponse(freeform, { action: "text", text: "After 9 PM" }, { applicationCursor: false }, "codex"),
    { method: "compose", text: "After 9 PM", submit: true, consumesPrompt: true }
  );
}

const host = process.argv[2] ?? "http://127.0.0.1:10001";
try {
  const response = await fetch(`${host}/api/sessions`, { signal: AbortSignal.timeout(3000) });
  if (response.ok) {
    const sessions = await response.json();
    console.log(`\nLive host ${host} — ${sessions.length} session(s):`);
    for (const session of sessions) {
      const text = await (await fetch(`${host}/api/sessions/${session.id}/text?tail=80`)).text();
      const detected = detectAgent(session, text);
      const prompt = detectPrompt(text);
      const busy = describeInputContext(session, text, modes).busy;
      console.log(
        `  ${detected.agent.padEnd(7)} ${busy ? "busy" : "idle"} ${prompt ? `prompt(${prompt.options.length})` : "        "} ${session.title.slice(0, 46)}`
      );
    }
  }
} catch {
  console.log(`\n(no live host at ${host} — fixture checks only)`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
// Set the code rather than calling process.exit(): forcing exit while tsx's
// ESM hook thread is live trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;

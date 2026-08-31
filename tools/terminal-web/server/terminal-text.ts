import type { Terminal as HeadlessTerminalType } from "@xterm/headless";

// The input-relevant VT state of a session, as the running program set it.
// Composed input (the mobile composer, /api/sessions/:id/compose) needs this to
// pick a delivery envelope: a TUI that turned bracketed paste on wants the
// whole message in one `ESC[200~ … ESC[201~` block, while a program that did
// not must receive plain bytes or it would see the wrapper as literal text.
export interface TerminalModes {
  /** The program is on the alternate screen (a full-screen TUI, no scrollback). */
  altScreen: boolean;
  /** DECSET 2004 — the program understands bracketed pastes. */
  bracketedPaste: boolean;
  /** DECCKM — arrow keys should be sent as SS3 (`ESC O A`) rather than CSI. */
  applicationCursor: boolean;
  /** The program is tracking the mouse. */
  mouse: boolean;
}

export function readTerminalModes(terminal: HeadlessTerminalType): TerminalModes {
  // `modes` is proposed API; treat every field as optional so an older or
  // stubbed terminal degrades to "plain teletype" instead of throwing.
  const modes = (terminal as { modes?: Partial<HeadlessTerminalType["modes"]> }).modes ?? {};
  return {
    altScreen: terminal.buffer?.active?.type === "alternate",
    bracketedPaste: modes.bracketedPasteMode === true,
    applicationCursor: modes.applicationCursorKeysMode === true,
    mouse: typeof modes.mouseTrackingMode === "string" && modes.mouseTrackingMode !== "none"
  };
}

// Plain-text view of a session for machine consumers (the orchestrator's
// read_session tool). Reading the live headless terminal buffer -- instead of
// ANSI-stripping the raw transcript -- means full-screen TUIs (Claude Code,
// Codex, vim) come out as the screen they are currently showing rather than a
// soup of redraw fragments.
export function extractPlainText(terminal: HeadlessTerminalType, tailLines: number): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];

  // Only the tail is ever returned, so start far enough back to cover it even
  // if every row is wrapped several times. Reading the whole 5000-row
  // scrollback on every poll (the composer asks ~once a second) is otherwise
  // the most expensive thing this server does.
  const start = tailLines > 0 ? Math.max(0, buffer.length - tailLines * 6) : 0;

  for (let i = start; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (!line) {
      continue;
    }
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  return (tailLines > 0 ? lines.slice(-tailLines) : lines).join("\n");
}

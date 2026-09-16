// Native host protocol: one conversation is shared with the desktop panel.
export interface OrchestratorItem {
  id: string;
  rev: number;
  seq: number;
  turnId: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  reasoning?: string;
  status: "streaming" | "done" | "cancelled" | "error";
  at: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  tool?: { callId: string; name: string; summary: string; result: string; ok: boolean; arguments: unknown };
}

export interface OrchestratorStatus {
  state: "idle" | "running" | "unconfigured" | "unavailable";
  seq: number;
  config?: { model: string; provider: string };
  error?: string | null;
  activeTurn?: { id: string; startedAt: string; step: string } | null;
  transcript?: OrchestratorItem[];
  itemCount?: number;
  partial?: boolean;
}

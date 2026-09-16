import type { OrchestratorItem, OrchestratorStatus } from "../orchestratorTypes";

function mergeItems(base: OrchestratorItem[], updates: OrchestratorItem[]): OrchestratorItem[] {
  const items = new Map(base.map((item) => [item.id, item]));
  for (const item of updates) {
    const existing = items.get(item.id);
    if (!existing || item.rev >= existing.rev) items.set(item.id, item);
  }
  return [...items.values()].slice(-400);
}

/** Merge a REST snapshot without rolling back events received while it loaded. */
export function mergeOrchestratorStatus(current: OrchestratorStatus | undefined, incoming: OrchestratorStatus, resetSeq = -1): OrchestratorStatus {
  if (incoming.seq < resetSeq && current) return current;
  if (!current) return incoming;
  const newer = incoming.seq >= current.seq;
  const transcript = incoming.transcript === undefined ? current.transcript
    : incoming.partial ? mergeItems(current.transcript ?? [], incoming.transcript)
    : newer ? incoming.transcript : mergeItems(incoming.transcript, current.transcript ?? []);
  return { ...(newer ? incoming : current), transcript };
}

export function mergeOrchestratorItem(current: OrchestratorStatus | undefined, item: OrchestratorItem, seq: number, resetSeq = -1): OrchestratorStatus | undefined {
  if (seq <= resetSeq) return current;
  return { ...(current ?? { state: "idle" }), seq: Math.max(seq, current?.seq ?? 0),
    transcript: mergeItems(current?.transcript ?? [], [item]) };
}

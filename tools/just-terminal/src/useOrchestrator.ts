import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerEndpoint } from "./lib/endpoint";
import { requestOrchestrator } from "./lib/orchestratorApi";
import { mergeOrchestratorItem, mergeOrchestratorStatus } from "./lib/orchestratorState";
import { terminalSocket } from "./lib/socket";
import type { OrchestratorStatus } from "./orchestratorTypes";

export function useOrchestrator(endpoint: ServerEndpoint) {
  const [status, setStatus] = useState<OrchestratorStatus>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const resetSeq = useRef(-1);
  const refreshPending = useRef(false);

  useEffect(() => {
    generation.current++;
    resetSeq.current = -1;
    setStatus(undefined);
    setError(undefined);
    const off = terminalSocket.onMessage((message) => {
      if (message.type === "hello") {
        generation.current++;
        resetSeq.current = -1;
        setStatus(message.orchestrator);
        setError(undefined);
      } else if (message.type === "orchestrator") {
        setStatus((current) => mergeOrchestratorStatus(current, message.orchestrator, resetSeq.current));
      } else if (message.type === "orchestrator_item") {
        setStatus((current) => mergeOrchestratorItem(current, message.item, message.seq, resetSeq.current));
      } else if (message.type === "orchestrator_reset") {
        resetSeq.current = Math.max(resetSeq.current, message.seq);
        setStatus((current) => current && message.seq < current.seq ? current
          : { ...(current ?? { state: "idle" }), seq: message.seq, transcript: [] });
      }
    });
    return () => { generation.current++; off(); };
  }, [endpoint.id, endpoint.wsUrl]);

  const request = useCallback(async (action: "status" | "send" | "cancel", text?: string) => {
    const epoch = generation.current;
    const next = await requestOrchestrator(endpoint, action, text);
    if (epoch === generation.current) {
      setStatus((current) => mergeOrchestratorStatus(current, next, resetSeq.current));
      setError(undefined);
    }
  }, [endpoint]);

  const refresh = useCallback(async () => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    const epoch = generation.current;
    try { await request("status"); }
    catch (cause) {
      if (epoch === generation.current) setError(cause instanceof Error ? cause.message : "Could not refresh Orchestrator.");
    } finally { refreshPending.current = false; setRefreshing(false); }
  }, [request]);

  return { status, error, refreshing, refresh,
    send: useCallback((text: string) => request("send", text), [request]),
    cancel: useCallback(() => request("cancel"), [request]) };
}

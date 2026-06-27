import type { TerminalHostPeer, TerminalSessionSummary } from "./types";

export interface TerminalTarget {
  id: string;
  kind: "local" | "peer";
  session: TerminalSessionSummary;
  peer?: TerminalHostPeer;
}

export function getPeerSessionTargetId(peer: TerminalHostPeer, session: TerminalSessionSummary): string {
  return `peer:${peer.server.port}:${session.id}`;
}

export function buildTerminalTargets(sessions: TerminalSessionSummary[], peerHosts: TerminalHostPeer[]): TerminalTarget[] {
  return [
    ...sessions.map((session): TerminalTarget => ({
      id: session.id,
      kind: "local",
      session
    })),
    ...peerHosts.flatMap((peer) =>
      peer.sessions.map(
        (session): TerminalTarget => ({
          id: getPeerSessionTargetId(peer, session),
          kind: "peer",
          session,
          peer
        })
      )
    )
  ];
}

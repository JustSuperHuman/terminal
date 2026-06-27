export interface PeerSessionTarget {
  port: number;
  sessionId: string;
}

const peerTargetPattern = /^peer:(\d+):(.+)$/;

export function makePeerSessionTargetId(port: number, sessionId: string): string {
  return `peer:${port}:${sessionId}`;
}

export function parsePeerSessionTargetId(value: string): PeerSessionTarget | undefined {
  const match = value.match(peerTargetPattern);
  if (!match) {
    return undefined;
  }

  const port = Number(match[1]);
  if (!Number.isFinite(port)) {
    return undefined;
  }

  return {
    port,
    sessionId: match[2]
  };
}

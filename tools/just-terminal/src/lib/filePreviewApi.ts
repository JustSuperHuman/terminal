import { apiUrl, type ServerEndpoint } from "./endpoint";
import type { FileLink } from "./fileLinks";

export interface FilePreviewTarget extends FileLink { sessionId: string; acp?: boolean }
export type FilePreview =
  | { path: string; kind: "text"; content: string; line: number; startLine: number; totalLines: number; truncated: boolean }
  | { path: string; kind: "image"; mimeType: string; data: string };

export async function fetchFilePreview(endpoint: ServerEndpoint, target: FilePreviewTarget, signal?: AbortSignal): Promise<FilePreview> {
  const route = `/api/${target.acp ? "acp/" : ""}sessions/${encodeURIComponent(target.sessionId)}/file?path=${encodeURIComponent(target.path)}&line=${target.line ?? 1}`;
  const response = await fetch(apiUrl({ ...endpoint, token: undefined }, route), { signal, headers: endpoint.token ? { "x-terminal-web-token": endpoint.token } : {} });
  if (!response.ok) {
    if (response.status === 404) throw new Error("This host does not have file previews yet, or the session is no longer available. Update the desktop host and try again.");
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `File could not be opened (${response.status}).`);
  }
  return await response.json() as FilePreview;
}

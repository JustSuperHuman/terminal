import { open, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export async function readFilePreview(roots: string[], target: string, requestedLine = 1) {
  if (!roots[0] || !target || /[\x00-\x1f]/.test(target) || target.startsWith("\\\\") || target.includes("://")) throw new Error("Invalid file path.");
  const resolved = await realpath(path.resolve(roots[0], target));
  const allowed = await Promise.all(roots.map((root) => realpath(root)));
  if (!allowed.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  })) throw new Error("This file is outside the session's workspace.");
  const file = await open(resolved, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("This path is not a file.");
    if (stat.size > MAX_BYTES) throw new Error("This file is too large to preview (2 MB limit).");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("This file is too large to preview (2 MB limit).");
    const data = buffer.subarray(0, size);
    const mimeType = IMAGE_TYPES[path.extname(resolved).toLowerCase()];
    if (mimeType) return { path: resolved, kind: "image" as const, mimeType, data: data.toString("base64") };
    if (data.includes(0)) throw new Error("This binary file cannot be previewed.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const lines = text.split(/\r?\n/);
    const line = Math.min(lines.length, Math.max(1, Math.floor(requestedLine) || 1));
    const start = Math.max(0, line - 21);
    const content = lines.slice(start, start + 300).join("\n").slice(0, 120_000);
    return { path: resolved, kind: "text" as const, content, line, startLine: start + 1, totalLines: lines.length,
      truncated: start > 0 || start + 300 < lines.length || content.length < lines.slice(start, start + 300).join("\n").length };
  } finally { await file.close(); }
}

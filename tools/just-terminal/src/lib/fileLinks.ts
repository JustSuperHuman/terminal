export interface FileLink {
  path: string;
  line?: number;
  column?: number;
}
export interface FileLinkMatch extends FileLink { start: number; end: number; label: string }

/** Shared by native text and the terminal WebView (keep this function self-contained). */
export function findFileLinks(text: string): FileLinkMatch[] {
  const result: FileLinkMatch[] = [];
  const occupied: Array<[number, number]> = [];
  const parse = (raw: string): FileLink | undefined => {
    let value = raw.trim().replace(/^<|>$/g, "");
    if (/^file:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.hostname && url.hostname !== "localhost") return undefined;
        value = decodeURIComponent(url.pathname) + url.hash;
        if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
      } catch { return undefined; }
    }
    if (/[\x00-\x1f]/.test(value) || value.includes("://") || value.startsWith("\\\\")) return undefined;
    const location = value.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?|\((\d+),(\d+)\))$/i);
    if (location) value = value.slice(0, location.index);
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined;
    if (!value || !(/[/\\]/.test(value) || /^(?:[\p{L}\p{N}_@+~-]+\.)+[\p{L}\p{N}_-]+$/u.test(value) || /^(?:Dockerfile|Makefile|LICENSE|\.gitignore|\.env)$/i.test(value))) return undefined;
    if (/^(?:\d+\.)+\d+$/.test(value)) return undefined;
    if (/^[^/\\\s]+@[^/\\\s]+\.[^/\\\s]+$/.test(value)) return undefined;
    return { path: value, ...(location ? {
      line: Math.max(1, Number(location[1] ?? location[3] ?? location[5])),
      column: location[2] || location[4] || location[6] ? Math.max(1, Number(location[2] ?? location[4] ?? location[6])) : undefined,
    } : {}) };
  };
  const add = (start: number, end: number, raw: string, label: string) => {
    if (occupied.some(([a, b]) => start < b && end > a)) return;
    const link = parse(raw);
    if (link) { result.push({ ...link, start, end, label }); occupied.push([start, end]); }
  };
  // Codex Markdown destinations and quoted paths preserve spaces.
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g)) {
    add(match.index!, match.index! + match[0].length, match[2]!, match[1]!);
    occupied.push([match.index!, match.index! + match[0].length]);
  }
  for (const match of text.matchAll(/([`"'])([^`"'\n]+)\1/g)) {
    add(match.index! + 1, match.index! + match[0].length - 1, match[2]!, match[2]!);
  }
  for (const match of text.matchAll(/(?:https?:\/\/[^\s<>`"']+)|(?:file:\/\/[^\s<>`"']+)|(?:(?:[a-zA-Z]:[\\/]|\.{1,2}[/\\]|\/)?[\p{L}\p{N}_@~+.\[\]-]+(?:[/\\][\p{L}\p{N}_@~+.\[\]-]+)+(?:\.[\w-]+)?|[\p{L}\p{N}_@+~-]+(?:\.[\w-]+)+)(?::\d+(?::\d+)?|#L\d+(?:C\d+)?|\(\d+,\d+\))?/gu)) {
    const start = match.index!;
    const raw = match[0].replace(/[.,;!?]+$/, "");
    // Do not turn pieces of URLs, email addresses or escape codes into files.
    if (/^https?:/i.test(raw) || (start > 0 && /[\w@/\\]/.test(text[start - 1]!))) continue;
    add(start, start + raw.length, raw, raw);
  }
  return result.sort((a, b) => a.start - b.start);
}

import { Fragment, type ReactNode } from "react";

// A deliberately small markdown renderer for assistant messages: fenced code,
// headings, bullet/numbered lists, paragraphs, and inline code/bold/italic/
// links. It never emits raw HTML, so model output cannot inject markup.

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!part) {
      return null;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={key} className="rounded bg-secondary/70 px-1 py-0.5 font-mono text-[0.85em] text-foreground">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{renderInline(part.slice(2, -2), key)}</strong>;
    }
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
      if (part.length > 2) {
        return <em key={key}>{renderInline(part.slice(1, -1), key)}</em>;
      }
    }
    const link = LINK.exec(part);
    if (link && link[0] === part) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

interface Block {
  kind: "code" | "heading" | "bullets" | "numbers" | "paragraph";
  lines: string[];
  language?: string;
  level?: number;
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] || undefined;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lines: body, language });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", lines: [heading[2] ?? ""], level: heading[1]?.length ?? 1 });
      index += 1;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*•]\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*[-*•]\s+/, ""));
        index += 1;
        // Continuation lines indented under the bullet.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index] ?? "") && !/^\s*[-*•]\s+/.test(lines[index] ?? "")) {
          items[items.length - 1] += ` ${(lines[index] ?? "").trim()}`;
          index += 1;
        }
      }
      blocks.push({ kind: "bullets", lines: items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index] ?? "") && !/^\s*\d+[.)]\s+/.test(lines[index] ?? "")) {
          items[items.length - 1] += ` ${(lines[index] ?? "").trim()}`;
          index += 1;
        }
      }
      blocks.push({ kind: "numbers", lines: items });
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^\s*```/.test(lines[index] ?? "") &&
      !/^(#{1,4})\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*•]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+[.)]\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "code":
            return (
              <pre
                key={key}
                className="my-1.5 overflow-x-auto rounded-md border bg-terminal px-2.5 py-2 font-mono text-[12px] leading-relaxed text-terminal-foreground"
                data-language={block.language}
              >
                {block.lines.join("\n")}
              </pre>
            );
          case "heading": {
            const size = block.level === 1 ? "text-sm" : "text-[13px]";
            return (
              <div key={key} className={`mt-2 font-semibold ${size}`}>
                {renderInline(block.lines[0] ?? "", key)}
              </div>
            );
          }
          case "bullets":
            return (
              <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
                {block.lines.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case "numbers":
            return (
              <ol key={key} className="my-1 list-decimal space-y-0.5 pl-5">
                {block.lines.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={key} className="my-1 whitespace-pre-wrap break-words">
                {block.lines.map((line, lineIndex) => (
                  <Fragment key={`${key}-${lineIndex}`}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderInline(line, `${key}-${lineIndex}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

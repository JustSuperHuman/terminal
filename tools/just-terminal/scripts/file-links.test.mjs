import { test, expect } from "bun:test";
import { findFileLinks } from "../src/lib/fileLinks.ts";
import { FILE_LINKS_SCRIPT } from "../src/fileLinksScript.ts";
import { fetchFilePreview } from "../src/lib/filePreviewApi.ts";

test("native text and WebView use identical link detection", () => {
  expect(FILE_LINKS_SCRIPT).toBe(findFileLinks.toString());
});
for (const [text, path, line, column] of [
  ["Updated src/app.ts:42:3.", "src/app.ts", 42, 3],
  ["F:\\terminal\\src\\app.ts:17", "F:\\terminal\\src\\app.ts", 17],
  ["See /Users/james/project/file.ts#L25C4", "/Users/james/project/file.ts", 25, 4],
  ["`F:\\My Project\\read me.md:7`", "F:\\My Project\\read me.md", 7],
  ["[app.ts](F:/terminal/src/app.ts:9)", "F:/terminal/src/app.ts", 9],
  ["[My Report](<F:/My Project/report.md:12>)", "F:/My Project/report.md", 12],
  ["file:///F:/My%20Project/main.ts#L18", "F:/My Project/main.ts", 18],
  ["README.md", "README.md", undefined],
  ["app.ts:42", "app.ts", 42],
  ["app/[id]/page.tsx:18", "app/[id]/page.tsx", 18],
  ["`Dockerfile`", "Dockerfile", undefined],
  ["./src/app.ts(12,5)", "./src/app.ts", 12, 5],
  ["😀 see src/日本.ts", "src/日本.ts", undefined],
]) test(`detect ${text}`, () => {
  const link = findFileLinks(text)[0];
  expect(link?.path).toBe(path); expect(link?.line).toBe(line); expect(link?.column).toBe(column);
});
test("web links, email addresses and version numbers do not become local files", () => {
  for (const text of ["https://example.com/src/app.ts:9", "[site](https://example.com/file.ts)", "hello@example.com", "1.2.3"]) expect(findFileLinks(text)).toEqual([]);
});
test("file API preserves the session, path and requested line without putting auth in the URL", async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (...args) => { calls.push(args); return new Response(JSON.stringify({ kind: "text", content: "hello" })); };
  try {
    const endpoint = { id: "host", httpBase: "http://host", token: "test-only" };
    for (const acp of [false, true]) await fetchFilePreview(endpoint, { sessionId: "id with spaces", path: "F:\\My Project\\file.ts", line: 29, acp });
    expect(new URL(calls[0][0]).pathname).toBe("/api/sessions/id%20with%20spaces/file");
    expect(new URL(calls[1][0]).pathname).toBe("/api/acp/sessions/id%20with%20spaces/file");
    expect(new URL(calls[0][0]).searchParams.get("path")).toBe("F:\\My Project\\file.ts");
    expect(new URL(calls[0][0]).searchParams.get("line")).toBe("29");
    expect(calls[0][0]).not.toContain("test-only");
    expect(calls[0][1].headers["x-terminal-web-token"]).toBe("test-only");
  } finally { globalThis.fetch = previous; }
});

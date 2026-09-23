import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFilePreview } from "./file-preview.js";

test("previews resolve relative and absolute paths, line references, and images", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "terminal-file-"));
  try {
    const file = path.join(dir, "file with spaces.ts");
    await writeFile(file, Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\r\n"));
    const preview = await readFilePreview([dir], "file with spaces.ts", 100);
    assert.equal(preview.kind, "text");
    if (preview.kind !== "text") return;
    assert.equal(preview.startLine, 80); assert.equal(preview.line, 100); assert.equal(preview.totalLines, 500);
    assert.equal(preview.truncated, true); assert.match(preview.content, /line 100/);
    assert.equal((await readFilePreview([dir], file)).kind, "text");
    await writeFile(path.join(dir, "image.png"), Buffer.from([137, 80, 78, 71]));
    assert.equal((await readFilePreview([dir], "image.png")).kind, "image");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("previews reject traversal, symlink escapes, binaries and oversized files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "terminal-file-"));
  try {
    const root = path.join(dir, "workspace"), outside = path.join(dir, "other");
    await mkdir(root); await mkdir(outside); await writeFile(path.join(outside, "file.ts"), "outside");
    await assert.rejects(readFilePreview([root], "../other/file.ts"), /outside/);
    await symlink(outside, path.join(root, "link"), "junction");
    await assert.rejects(readFilePreview([root], "link/file.ts"), /outside/);
    assert.equal((await readFilePreview([root, outside], "../other/file.ts")).kind, "text");
    await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
    await assert.rejects(readFilePreview([root], "binary"), /binary/);
    await writeFile(path.join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
    await assert.rejects(readFilePreview([root], "large"), /too large/);
    await assert.rejects(readFilePreview([root], "."), /not a file/);
    await assert.rejects(readFilePreview([root], "missing"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

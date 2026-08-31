import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port, "Could not allocate a profile-sync smoke-test port.");
  return port;
}

function settings(name, commandline, guid) {
  return JSON.stringify({
    defaultProfile: guid,
    profiles: { list: [{ guid, name, commandline }] },
  });
}

function waitForMessage(socket, predicate, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a profile WebSocket event."));
    }, timeoutMs);
    const onMessage = (raw) => {
      const value = JSON.parse(raw.toString());
      if (predicate(value)) {
        cleanup();
        resolve(value);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "terminal-profile-sync-"));
const settingsPath = path.join(temporaryRoot, "settings.json");
const port = await availablePort();
const firstGuid = "{11111111-1111-1111-1111-111111111111}";
const secondGuid = "{22222222-2222-2222-2222-222222222222}";
await writeFile(settingsPath, settings("Codex Test", "powershell.exe codex --yolo", firstGuid));

const child = spawn(
  process.execPath,
  ["--import", "tsx", "server/index.ts", "--host", "127.0.0.1", "--port", String(port)],
  {
    cwd: packageRoot,
    env: {
      ...process.env,
      TERMINAL_WEB_SETTINGS_PATH: settingsPath,
      TERMINAL_WEB_PROFILE_POLL_MS: "100",
      TERMINAL_WEB_SERVER_INFO_PATH: path.join(temporaryRoot, "server.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);
const childExited = new Promise((resolve) => child.once("exit", resolve));

let childOutput = "";
child.stdout.on("data", (chunk) => {
  childOutput += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  childOutput += chunk.toString();
});

let socket;
let attachmentPath;
let sessionId;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start.\n${childOutput}`)), 15_000);
    const poll = setInterval(() => {
      if (childOutput.includes("Terminal Web Host listening")) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    child.once("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timeout);
      reject(new Error(`Profile smoke server exited with ${code}.\n${childOutput}`));
    });
  });

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const helloPromise = waitForMessage(socket, (message) => message.type === "hello");
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const hello = await helloPromise;
  assert.deepEqual(hello.profiles.map((profile) => profile.label), ["Codex Test"]);

  const changedPromise = waitForMessage(socket, (message) => message.type === "profiles");
  await writeFile(settingsPath, settings("Bro CLI", "powershell.exe bro", secondGuid));
  const changed = await changedPromise;
  assert.deepEqual(changed.profiles.map((profile) => profile.label), ["Bro CLI"]);
  assert.equal(changed.profiles[0].terminalProfileGuid, secondGuid);

  console.log("Profile sync smoke passed: settings.json change -> WebSocket profiles event.");

  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "managed",
      shell: process.execPath,
      args: ["-e", "process.stdin.on('data', chunk => process.stdout.write(chunk))"],
      title: "Attachment smoke",
    }),
  });
  const createdBody = await createdResponse.text();
  assert.equal(createdResponse.status, 201, createdBody);
  const created = JSON.parse(createdBody);
  sessionId = created.id;

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const uploadResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/attachments?paste=1&filename=clipboard.png`,
    { method: "POST", headers: { "content-type": "image/png" }, body: png }
  );
  const uploadBody = await uploadResponse.text();
  assert.equal(uploadResponse.status, 201, uploadBody);
  const attachment = JSON.parse(uploadBody);
  attachmentPath = attachment.path;
  assert.equal(attachment.pasted, true);
  assert.deepEqual(await readFile(attachmentPath), png);

  console.log("Attachment smoke passed: binary PNG upload -> exact saved bytes -> PTY paste accepted.");
} finally {
  if (sessionId) {
    await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (attachmentPath) {
    await unlink(attachmentPath).catch(() => undefined);
  }
  socket?.close();
  child.kill();
  await Promise.race([childExited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 9) {
        console.warn(`Could not remove smoke-test directory: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

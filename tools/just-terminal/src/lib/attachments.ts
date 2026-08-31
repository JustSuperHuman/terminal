// Image paste for remote agent sessions. Raw image bytes can't cross a PTY,
// but Claude Code and Codex both treat a pasted image *path* as an attached
// image — so the phone uploads the picture to the terminal-web host, which
// saves it to a local temp file and bracket-pastes that path into the session
// (POST /api/sessions/:id/attachments?paste=1).

import { File, Paths } from "expo-file-system";
import * as FileSystemLegacy from "expo-file-system/legacy";
import { apiUrl, type ServerEndpoint } from "./endpoint";

export interface AttachmentResult {
  /** Absolute path of the saved file on the desktop host. */
  path: string;
  /** Whether the host also pasted the path into the session. */
  pasted: boolean;
}

export interface ClipboardImageData {
  mimeType: string;
  extension: string;
  base64: string;
}

/** Validate and split the data URI returned by Expo Clipboard. */
export function parseClipboardImageDataUri(dataUri: string): ClipboardImageData {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(dataUri);
  if (!match) {
    throw new Error("Clipboard did not contain a usable image.");
  }

  const mimeType = match[1].toLowerCase();
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return { mimeType, extension: extensions[mimeType] ?? "img", base64: match[2] };
}

async function postAttachment(
  endpoint: ServerEndpoint,
  sessionId: string,
  uri: string,
  mimeType: string,
  fileName?: string
): Promise<AttachmentResult> {
  const query = `paste=1${fileName ? `&filename=${encodeURIComponent(fileName)}` : ""}`;
  // SDK 56's new File.upload() currently stalls on Android for files returned
  // by the system photo picker. The maintained legacy transport streams the
  // same local file natively and is reliable on both Android and iOS.
  const upload = await FileSystemLegacy.uploadAsync(
    apiUrl(endpoint, `/api/sessions/${encodeURIComponent(sessionId)}/attachments?${query}`),
    uri,
    {
      httpMethod: "POST",
      uploadType: FileSystemLegacy.FileSystemUploadType.BINARY_CONTENT,
      sessionType: FileSystemLegacy.FileSystemSessionType.FOREGROUND,
      headers: {
        "Content-Type": mimeType,
        ...(endpoint.token ? { "x-terminal-web-token": endpoint.token } : {}),
      },
    }
  );
  if (upload.status < 200 || upload.status >= 300) {
    let detail = "";
    try {
      const error = JSON.parse(upload.body) as { message?: string; detail?: string };
      detail = error.detail ?? error.message ?? "";
    } catch {
      detail = "";
    }
    throw new Error(`Attachment upload failed (${upload.status})${detail ? `: ${detail}` : ""}`);
  }

  let result: AttachmentResult;
  try {
    result = JSON.parse(upload.body) as AttachmentResult;
  } catch {
    throw new Error("Attachment host returned an invalid response.");
  }
  if (!result.path || result.pasted !== true) {
    throw new Error("The image was uploaded, but its path was not pasted into the session.");
  }
  return result;
}

/** Upload a picked image by its local file uri (expo-image-picker asset). */
export async function uploadImageFromUri(
  endpoint: ServerEndpoint,
  sessionId: string,
  uri: string,
  mimeType = "image/jpeg",
  fileName?: string
): Promise<AttachmentResult> {
  // Expo's native uploader streams the URI as binary content on both iOS and
  // Android, avoiding the unreliable fetch(file://...).blob() bridge.
  return postAttachment(endpoint, sessionId, uri, mimeType, fileName);
}

/**
 * Upload a clipboard image. expo-clipboard hands back a data URI; stage those
 * bytes in Expo's cache directory so the native uploader can stream them.
 */
export async function uploadImageFromDataUri(
  endpoint: ServerEndpoint,
  sessionId: string,
  dataUri: string
): Promise<AttachmentResult> {
  const { mimeType, extension, base64 } = parseClipboardImageDataUri(dataUri);
  const staged = new File(Paths.cache, `clipboard-paste-${Date.now()}.${extension}`);
  staged.create({ overwrite: true });
  staged.write(base64, { encoding: "base64" });
  try {
    return await uploadImageFromUri(endpoint, sessionId, staged.uri, mimeType, `clipboard.${extension}`);
  } finally {
    try {
      if (staged.exists) {
        staged.delete();
      }
    } catch {
      // Cache cleanup is best-effort; the OS can reclaim this directory too.
    }
  }
}

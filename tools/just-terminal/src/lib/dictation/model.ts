// On-device speech model provisioning.
//
// The sherpa-onnx binding ships a download manager, but its catalog does not
// include NVIDIA Parakeet, so we fetch the model ourselves: a handful of files
// streamed into the app's document directory at first use (far too large to
// bundle in the app binary). The resulting directory is handed straight to
// `fileModelPath()` for `createSTT`.
//
// `@dr.pogodin/react-native-fs` calls `TurboModuleRegistry.getEnforcing` at
// module load, which throws when the native module is absent (Expo Go). So it's
// required lazily — every export here is only reached after dictation support
// has been confirmed, keeping the app loadable in Expo Go.
type RNFS = typeof import("@dr.pogodin/react-native-fs");

let rnfsCache: RNFS | undefined;
function rnfs(): RNFS {
  rnfsCache ??= require("@dr.pogodin/react-native-fs") as RNFS;
  return rnfsCache;
}

/** Thrown when a download is aborted by the user (toggling dictation off). */
export class DictationCancelled extends Error {
  constructor() {
    super("Model download cancelled.");
    this.name = "DictationCancelled";
  }
}

export interface ModelFile {
  name: string;
  /** Approximate size, used only to weight aggregate progress. */
  bytes: number;
}

export interface ParakeetModel {
  id: string;
  label: string;
  language: string;
  /** Hugging Face `resolve/main` base — files are appended to this. */
  baseUrl: string;
  files: ModelFile[];
  totalBytes: number;
}

// NVIDIA Parakeet TDT 0.6B v2 (English), int8-quantized, exported for
// sherpa-onnx as an offline NeMo transducer: three ONNX graphs + a token table.
// Sizes are the real Hugging Face blob sizes (used for the progress meter only).
export const PARAKEET_TDT_06B_V2_INT8: ParakeetModel = {
  id: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
  label: "Parakeet TDT 0.6B · English",
  language: "en",
  baseUrl:
    "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main",
  files: [
    { name: "encoder.int8.onnx", bytes: 652_000_000 },
    { name: "decoder.int8.onnx", bytes: 7_260_000 },
    { name: "joiner.int8.onnx", bytes: 1_740_000 },
    { name: "tokens.txt", bytes: 9_380 },
  ],
  totalBytes: 661_009_380,
};

export const ACTIVE_MODEL: ParakeetModel = PARAKEET_TDT_06B_V2_INT8;

function modelsRoot(): string {
  return `${rnfs().DocumentDirectoryPath}/sherpa-models`;
}

/** Absolute directory the model files live in (pass this to `fileModelPath`). */
export function modelDir(model: ParakeetModel = ACTIVE_MODEL): string {
  return `${modelsRoot()}/${model.id}`;
}

/** True only when every required file is present (final names, not `.part`). */
export async function isModelReady(model: ParakeetModel = ACTIVE_MODEL): Promise<boolean> {
  const { exists } = rnfs();
  const dir = modelDir(model);
  for (const file of model.files) {
    if (!(await exists(`${dir}/${file.name}`))) {
      return false;
    }
  }
  return true;
}

export interface DownloadProgress {
  /** Bytes received across the whole model. */
  received: number;
  /** `model.totalBytes`. */
  total: number;
  /** 0–100, capped at 99 until the final move completes. */
  percent: number;
  fileName: string;
  /** 1-based index of the file currently downloading. */
  fileIndex: number;
  fileCount: number;
}

export interface ModelDownloadHandle {
  /** Resolves to the model directory; rejects with `DictationCancelled` on abort. */
  promise: Promise<string>;
  cancel: () => void;
}

/**
 * Download every missing model file, reporting aggregate progress. Each file
 * streams to a `.part` sibling and is only renamed to its final name once
 * complete, so an interrupted run is never mistaken for a ready model. Already
 * present files are skipped, making this safely resumable across launches.
 */
export function downloadModel(
  onProgress: (progress: DownloadProgress) => void,
  model: ParakeetModel = ACTIVE_MODEL,
): ModelDownloadHandle {
  let cancelled = false;
  let activeJobId: number | undefined;

  const bytesBefore = (index: number) =>
    model.files.slice(0, index).reduce((sum, file) => sum + file.bytes, 0);

  const run = async (): Promise<string> => {
    const { downloadFile, exists, mkdir, moveFile, unlink } = rnfs();
    const dir = modelDir(model);
    await mkdir(dir);

    for (let i = 0; i < model.files.length; i++) {
      if (cancelled) throw new DictationCancelled();

      const file = model.files[i];
      const finalPath = `${dir}/${file.name}`;
      if (await exists(finalPath)) {
        continue;
      }

      const partPath = `${finalPath}.part`;
      if (await exists(partPath)) {
        await unlink(partPath).catch(() => undefined);
      }

      const base = bytesBefore(i);
      const job = downloadFile({
        fromUrl: `${model.baseUrl}/${encodeURIComponent(file.name)}`,
        toFile: partPath,
        progressInterval: 250,
        begin: ({ jobId }) => {
          activeJobId = jobId;
        },
        progress: ({ bytesWritten, contentLength }) => {
          const fileTotal = contentLength > 0 ? contentLength : file.bytes;
          const received = base + Math.min(bytesWritten, fileTotal);
          onProgress({
            received,
            total: model.totalBytes,
            percent: Math.min(99, Math.round((received / model.totalBytes) * 100)),
            fileName: file.name,
            fileIndex: i + 1,
            fileCount: model.files.length,
          });
        },
      });
      activeJobId = job.jobId;

      const result = await job.promise;
      if (cancelled) {
        await unlink(partPath).catch(() => undefined);
        throw new DictationCancelled();
      }
      if (result.statusCode >= 400) {
        await unlink(partPath).catch(() => undefined);
        throw new Error(`Download failed for ${file.name} (HTTP ${result.statusCode}).`);
      }
      await moveFile(partPath, finalPath);
    }

    onProgress({
      received: model.totalBytes,
      total: model.totalBytes,
      percent: 100,
      fileName: model.files[model.files.length - 1].name,
      fileIndex: model.files.length,
      fileCount: model.files.length,
    });
    return dir;
  };

  return {
    promise: run(),
    cancel: () => {
      cancelled = true;
      if (activeJobId !== undefined) {
        try {
          rnfs().stopDownload(activeJobId);
        } catch {
          // best-effort; the cancelled flag still rejects the run
        }
      }
    },
  };
}

/** Remove the downloaded model (frees ~0.66 GB). */
export async function deleteModel(model: ParakeetModel = ACTIVE_MODEL): Promise<void> {
  const { exists, unlink } = rnfs();
  const dir = modelDir(model);
  if (await exists(dir)) {
    await unlink(dir);
  }
}

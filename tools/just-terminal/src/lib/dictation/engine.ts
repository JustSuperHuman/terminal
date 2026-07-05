// Real-time dictation engine.
//
// Pipeline: device mic → sherpa-onnx `createPcmLiveStream` (16 kHz mono Float32)
// → a lightweight energy-based voice-activity detector that segments speech on
// pauses → offline Parakeet (`transcribeSamples`) per segment → `onSegment`.
//
// Parakeet is offline-only in sherpa-onnx, so "live" means a phrase lands each
// time you pause (true word-by-word streaming needs the binding's silero VAD,
// which ships in 0.7.0 — this is the robust interim approach).
import { PermissionsAndroid, Platform } from "react-native";
import type { SttEngine } from "react-native-sherpa-onnx/stt";
import type { PcmLiveStreamHandle } from "react-native-sherpa-onnx/audio";

// sherpa-onnx accesses native TurboModules at module load (getEnforcing), which
// throws when the native side is absent (Expo Go). The value modules are
// therefore required lazily — only after dictation support is confirmed — while
// the (erased) `import type` above keeps full typing. This keeps the whole app
// loadable in Expo Go, where dictation simply reports as unsupported.
type SttModule = typeof import("react-native-sherpa-onnx/stt");
type AudioModule = typeof import("react-native-sherpa-onnx/audio");
type RootModule = typeof import("react-native-sherpa-onnx");

// Metro doesn't honor this package's "exports" subpaths (./stt, ./audio) — only
// the root resolves via "main". So the runtime require() targets the real build
// files directly (the types above still resolve through "exports" via tsc, and
// are erased before Metro sees them). Pinned to the v0.4.x build layout.
const sttModule = (): SttModule => require("react-native-sherpa-onnx/lib/module/stt");
const audioModule = (): AudioModule => require("react-native-sherpa-onnx/lib/module/audio");
const rootModule = (): RootModule => require("react-native-sherpa-onnx");

const TARGET_RATE = 16000;

// VAD tuning, in milliseconds / normalized RMS. Calibrated for close-mic phone
// dictation; ambient noise is tracked so the on-threshold floats above it.
const SILENCE_HANGOVER_MS = 650; // trailing silence that ends a phrase
const MIN_SPEECH_MS = 280; // discard blips shorter than this (coughs, taps)
const MAX_UTTERANCE_MS = 14000; // hard cap so a long take still flushes
const PREROLL_MS = 320; // audio retained before speech so the first word survives
const RMS_ON = 0.02; // enter-speech threshold
const RMS_OFF = 0.012; // leave-speech threshold (hysteresis)
const LEVEL_FULL_SCALE = 0.22; // RMS mapped to a full UI meter

export type DictationStatus = "idle" | "starting" | "listening" | "recognizing" | "error";

export interface DictationEvents {
  onStatus?: (status: DictationStatus) => void;
  /** Smoothed mic level, 0..1, for a UI meter. */
  onLevel?: (level: number) => void;
  /** Whether a speech segment is currently in progress. */
  onSpeaking?: (speaking: boolean) => void;
  /** A finalized, transcribed phrase. */
  onSegment?: (text: string) => void;
  onError?: (message: string) => void;
}

let nativeAvailable: boolean | undefined;

/**
 * Whether the sherpa-onnx native module is linked. False in Expo Go (no native
 * code) — callers use this to hide the mic affordance there. Cached after the
 * first probe.
 */
export async function isDictationSupported(): Promise<boolean> {
  if (nativeAvailable !== undefined) {
    return nativeAvailable;
  }
  try {
    await rootModule().testSherpaInit();
    nativeAvailable = true;
  } catch {
    nativeAvailable = false;
  }
  return nativeAvailable;
}

async function ensureMicPermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    // iOS shows the system mic prompt automatically on first capture.
    return true;
  }
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: "Microphone access",
    message: "JustTerminal transcribes your voice on-device to type into the command line.",
    buttonPositive: "Allow",
    buttonNegative: "Not now",
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export class DictationEngine {
  private pcm?: PcmLiveStreamHandle;
  private recognizer?: SttEngine;
  private recognizerDir?: string;
  private unsubData?: () => void;
  private unsubError?: () => void;
  private running = false;
  // Serializes start/stop/dispose so a new capture can never race the previous
  // one's teardown (starting while the old stream is still releasing the mic
  // was an intermittent "mic is busy/dead" failure). The chain never rejects.
  private op: Promise<unknown> = Promise.resolve();
  // Set when the native recognizer looks dead (repeated transcribe failures);
  // the next start destroys and re-creates it instead of reusing the handle.
  private recognizerSuspect = false;
  private transcribeFailures = 0;

  // VAD state
  private phase: "listening" | "speaking" = "listening";
  private utterance: number[] = [];
  private prerollChunks: Float32Array[] = [];
  private prerollLength = 0;
  private speechSamples = 0;
  private silenceSamples = 0;
  private noiseFloor = RMS_OFF;
  private level = 0;

  // Transcription runs sequentially so capture is never blocked.
  private queue: number[][] = [];
  private draining = false;

  constructor(private readonly events: DictationEvents) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Acquire the mic and start listening. Loads the recognizer on first use.
   * Serialized against stop/dispose: a stop issued while this is in flight runs
   * AFTER it, so the mic acquired here is always released cleanly.
   */
  async start(modelPath: string): Promise<void> {
    return this.enqueue(() => this.doStart(modelPath));
  }

  /** Stop listening; any phrase mid-flight is flushed so its words aren't lost. */
  async stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  /** Stop and release the loaded model. Call on unmount. */
  async dispose(): Promise<void> {
    return this.enqueue(async () => {
      await this.doStop();
      await this.recognizer?.destroy().catch(() => undefined);
      this.recognizer = undefined;
      this.recognizerDir = undefined;
    });
  }

  /** Chain an operation behind every previously issued start/stop/dispose. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.op.then(fn, fn);
    this.op = run.catch(() => undefined);
    return run;
  }

  /**
   * (Re)create the recognizer when absent, pointed at a different model dir, or
   * marked suspect after repeated transcription failures. A single clean retry
   * covers a native engine that died and needs a fresh init.
   */
  private async ensureRecognizer(modelPath: string): Promise<void> {
    if (this.recognizer && this.recognizerDir === modelPath && !this.recognizerSuspect) {
      return;
    }
    await this.recognizer?.destroy().catch(() => undefined);
    this.recognizer = undefined;
    this.recognizerDir = undefined;
    const create = () =>
      sttModule().createSTT({
        modelPath: rootModule().fileModelPath(modelPath),
        modelType: "nemo_transducer",
        preferInt8: true,
        numThreads: 2,
        provider: "cpu",
      });
    try {
      this.recognizer = await create();
    } catch {
      // The native side may have died mid-session — retry once from scratch.
      this.recognizer = await create();
    }
    this.recognizerDir = modelPath;
    this.recognizerSuspect = false;
    this.transcribeFailures = 0;
  }

  private async doStart(modelPath: string): Promise<void> {
    if (this.running) {
      // Already capturing (e.g. a press landed on a capture that never stood
      // down) — re-emit the real state so the UI can't sit stuck on "loading".
      this.events.onStatus?.("listening");
      return;
    }
    if (!(await ensureMicPermission())) {
      this.fail("Microphone permission denied.");
      return;
    }

    this.events.onStatus?.("starting");
    try {
      await this.ensureRecognizer(modelPath);
    } catch (error) {
      this.fail(describe(error, "Could not load the speech model."));
      return;
    }

    this.resetVad();
    const pcm = audioModule().createPcmLiveStream({ sampleRate: TARGET_RATE, channelCount: 1 });
    this.pcm = pcm;
    this.unsubData = pcm.onData((samples) => this.onChunk(samples));
    this.unsubError = pcm.onError((message) => this.onCaptureError(message));

    try {
      await pcm.start();
    } catch (error) {
      await this.teardownCapture();
      this.fail(describe(error, "Could not start the microphone."));
      return;
    }

    if (this.pcm !== pcm) {
      // Defensive (start/stop are serialized now, but onCaptureError can still
      // tear down out-of-band): if the stream we acquired is no longer current,
      // release it so the mic doesn't leak and stand down.
      await pcm.stop().catch(() => undefined);
      return;
    }

    this.running = true;
    this.events.onStatus?.("listening");
  }

  private async doStop(): Promise<void> {
    if (!this.running) {
      await this.teardownCapture();
      return;
    }
    this.running = false;
    this.flushUtterance();
    await this.teardownCapture();
    if (!this.draining) {
      this.events.onStatus?.("idle");
    }
  }

  /**
   * The mic stream died mid-capture (OS revoked it, route change, backgrounding).
   * Without this, `running` stayed true against a dead stream and the next press
   * found the engine wedged. Fail loudly, then tear down so the next start is clean.
   */
  private onCaptureError(message: string): void {
    this.fail(message);
    this.running = false;
    void this.enqueue(() => this.teardownCapture());
  }

  private fail(message: string): void {
    this.events.onError?.(message);
    this.events.onStatus?.("error");
  }

  private async teardownCapture(): Promise<void> {
    this.unsubData?.();
    this.unsubError?.();
    this.unsubData = undefined;
    this.unsubError = undefined;
    const pcm = this.pcm;
    this.pcm = undefined;
    this.events.onSpeaking?.(false);
    this.events.onLevel?.(0);
    if (pcm) {
      await pcm.stop().catch(() => undefined);
    }
  }

  private resetVad(): void {
    this.phase = "listening";
    this.utterance = [];
    this.prerollChunks = [];
    this.prerollLength = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.noiseFloor = RMS_OFF;
    this.level = 0;
  }

  private onChunk(samples: Float32Array): void {
    if (!this.running || samples.length === 0) {
      return;
    }
    const rms = rmsOf(samples);

    // Fast attack, slow release so the meter feels responsive but not jittery.
    const norm = Math.min(1, rms / LEVEL_FULL_SCALE);
    this.level = norm > this.level ? norm : this.level * 0.82 + norm * 0.18;
    this.events.onLevel?.(this.level);

    const onThreshold = Math.max(RMS_ON, this.noiseFloor * 2.4);

    if (this.phase === "listening") {
      if (rms < RMS_ON) {
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      }
      this.pushPreroll(samples);
      if (rms > onThreshold) {
        this.beginSpeech();
        this.appendUtterance(samples);
        this.speechSamples += samples.length;
      }
      return;
    }

    // phase === "speaking"
    this.appendUtterance(samples);
    if (rms > RMS_OFF) {
      this.speechSamples += samples.length;
      this.silenceSamples = 0;
    } else {
      this.silenceSamples += samples.length;
    }

    const utteranceMs = (this.utterance.length / TARGET_RATE) * 1000;
    const silenceMs = (this.silenceSamples / TARGET_RATE) * 1000;
    if (silenceMs >= SILENCE_HANGOVER_MS || utteranceMs >= MAX_UTTERANCE_MS) {
      this.flushUtterance();
    }
  }

  private pushPreroll(samples: Float32Array): void {
    // Copy: the native layer may reuse the backing buffer across callbacks.
    this.prerollChunks.push(samples.slice());
    this.prerollLength += samples.length;
    const max = (PREROLL_MS / 1000) * TARGET_RATE;
    while (this.prerollChunks.length > 1 && this.prerollLength - this.prerollChunks[0].length >= max) {
      this.prerollLength -= this.prerollChunks.shift()!.length;
    }
  }

  private beginSpeech(): void {
    this.phase = "speaking";
    this.utterance = [];
    this.speechSamples = 0;
    this.silenceSamples = 0;
    for (const chunk of this.prerollChunks) {
      this.appendUtterance(chunk);
    }
    this.prerollChunks = [];
    this.prerollLength = 0;
    this.events.onSpeaking?.(true);
  }

  private appendUtterance(samples: Float32Array | number[]): void {
    const target = this.utterance;
    for (let i = 0; i < samples.length; i++) {
      target.push(samples[i]);
    }
  }

  private flushUtterance(): void {
    if (this.phase !== "speaking") {
      return;
    }
    const samples = this.utterance;
    const speechMs = (this.speechSamples / TARGET_RATE) * 1000;
    this.phase = "listening";
    this.utterance = [];
    this.silenceSamples = 0;
    this.speechSamples = 0;
    this.events.onSpeaking?.(false);
    if (speechMs >= MIN_SPEECH_MS && samples.length > 0) {
      this.queue.push(samples);
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    this.events.onStatus?.("recognizing");
    while (this.queue.length > 0) {
      const samples = this.queue.shift()!;
      const recognizer = this.recognizer;
      if (!recognizer) {
        break;
      }
      try {
        const result = await recognizer.transcribeSamples(samples, TARGET_RATE);
        const text = result.text.trim();
        if (text) {
          this.events.onSegment?.(text);
        }
        this.transcribeFailures = 0;
      } catch (error) {
        // One failure can be a transient bad segment; two in a row means the
        // native recognizer is likely dead — recreate it on the next start.
        this.transcribeFailures += 1;
        if (this.transcribeFailures >= 2) {
          this.recognizerSuspect = true;
        }
        this.events.onError?.(describe(error, "Transcription failed."));
      }
    }
    this.draining = false;
    this.events.onStatus?.(this.running ? "listening" : "idle");
  }
}

function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return fallback;
}

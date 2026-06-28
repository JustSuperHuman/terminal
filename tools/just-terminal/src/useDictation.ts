import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIVE_MODEL,
  DictationCancelled,
  DictationEngine,
  downloadModel,
  isDictationSupported,
  isModelReady,
  modelDir,
  type ModelDownloadHandle,
} from "./lib/dictation";

// UI-facing dictation status. `unsupported` means the native module isn't linked
// (Expo Go); the rest map the engine + model-provisioning phases.
export type DictationUiStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "downloading"
  | "loading"
  | "listening"
  | "recognizing"
  | "error";

// Statuses where the engine/provisioning is engaged (drives the `active` flag).
const BUSY: DictationUiStatus[] = ["downloading", "loading", "listening", "recognizing"];
// Capture (press-and-hold listening) phases — these stand down on release.
const CAPTURING: DictationUiStatus[] = ["loading", "listening", "recognizing"];

export interface UseDictationParams {
  /** Called with each finalized phrase (already trimmed, non-empty). */
  onText: (text: string) => void;
  /** When false, capture is forced off (e.g. no running session). */
  enabled?: boolean;
}

export interface UseDictationResult {
  status: DictationUiStatus;
  /** Engine/provisioning engaged (busy or actively listening/recognizing). */
  active: boolean;
  /** Mic level 0..1 for a meter. */
  level: number;
  speaking: boolean;
  lastText?: string;
  /** 0–100 while the model is downloading. */
  downloadPercent?: number;
  error?: string;
  modelLabel: string;
  toggle: () => void;
  start: () => void;
  stop: () => void;
}

/**
 * Drives on-device voice dictation: probes native availability, downloads the
 * Parakeet model on first use, then runs the capture/VAD/transcribe engine and
 * forwards each recognized phrase to `onText`. Safe in Expo Go — it simply
 * reports `unsupported` there.
 *
 * The one-time ~660MB model download is intentionally DECOUPLED from the mic
 * hold: a press kicks it off and it runs to completion regardless of release.
 * Only the live capture (listening) is tied to holding the mic.
 */
export function useDictation({ onText, enabled = true }: UseDictationParams): UseDictationResult {
  const [status, setStatus] = useState<DictationUiStatus>("idle");
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [lastText, setLastText] = useState<string | undefined>();
  const [downloadPercent, setDownloadPercent] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  const engineRef = useRef<DictationEngine | null>(null);
  const downloadRef = useRef<ModelDownloadHandle | null>(null);
  const onTextRef = useRef(onText);
  const levelTsRef = useRef(0);
  // Press-and-hold capture lifecycle: bumped on each start/stop so a capture
  // released mid-load tears itself back down. The model download is NOT guarded
  // by this — it runs to completion independent of press/release.
  const captureTokenRef = useRef(0);
  // null = not yet checked; true/false once known.
  const modelReadyRef = useRef<boolean | null>(null);

  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  // Probe native support (false in Expo Go) and prime model readiness.
  useEffect(() => {
    let mounted = true;
    isDictationSupported().then(async (ok) => {
      if (!mounted) return;
      if (!ok) {
        setStatus("unsupported");
        return;
      }
      try {
        modelReadyRef.current = await isModelReady();
      } catch {
        modelReadyRef.current = false;
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const getEngine = useCallback((): DictationEngine => {
    if (!engineRef.current) {
      engineRef.current = new DictationEngine({
        onStatus: (engineStatus) => {
          if (engineStatus === "starting") setStatus("loading");
          else if (engineStatus === "listening") setStatus("listening");
          else if (engineStatus === "recognizing") setStatus("recognizing");
          // Don't clobber a download that's running in the background.
          else if (engineStatus === "idle") setStatus((cur) => (cur === "downloading" ? cur : "idle"));
          else if (engineStatus === "error") setStatus("error");
        },
        onLevel: (value) => {
          // Throttle to ~14 fps so a tiny meter view doesn't thrash.
          const now = Date.now();
          if (now - levelTsRef.current >= 70) {
            levelTsRef.current = now;
            setLevel(value);
          }
        },
        onSpeaking: setSpeaking,
        onSegment: (text) => {
          setLastText(text);
          onTextRef.current(text);
        },
        onError: (message) => {
          setError(message);
          setStatus("error");
        },
      });
    }
    return engineRef.current;
  }, []);

  // Kick off the one-time model download (no-op if already downloading/ready).
  // Runs to completion regardless of the mic hold — a single tap is enough.
  const ensureModelDownload = useCallback(() => {
    if (downloadRef.current || modelReadyRef.current) {
      return;
    }
    setError(undefined);
    setStatus("downloading");
    setDownloadPercent(0);
    const handle = downloadModel((progress) => {
      if (downloadRef.current === handle) {
        setDownloadPercent(progress.percent);
      }
    });
    downloadRef.current = handle;
    handle.promise.then(
      () => {
        if (downloadRef.current !== handle) return;
        downloadRef.current = null;
        modelReadyRef.current = true;
        setDownloadPercent(undefined);
        setStatus((cur) => (cur === "downloading" ? "idle" : cur));
      },
      (err: unknown) => {
        if (downloadRef.current === handle) downloadRef.current = null;
        setDownloadPercent(undefined);
        if (err instanceof DictationCancelled) {
          setStatus((cur) => (cur === "downloading" ? "idle" : cur));
          return;
        }
        setError(err instanceof Error ? err.message : "Model download failed.");
        setStatus("error");
      }
    );
  }, []);

  // Begin live capture for a press-and-hold session (model must be ready).
  // Guarded by `token` so releasing during the load tears the engine down.
  const beginCapture = useCallback(
    (token: number) => {
      setError(undefined);
      setStatus("loading");
      void (async () => {
        await getEngine().start(modelDir());
        if (token !== captureTokenRef.current) {
          void getEngine().stop();
        }
      })();
    },
    [getEngine]
  );

  const start = useCallback(() => {
    if (status === "unsupported" || status === "downloading") {
      return;
    }
    const token = ++captureTokenRef.current;

    if (modelReadyRef.current === true) {
      beginCapture(token);
      return;
    }
    if (modelReadyRef.current === false) {
      ensureModelDownload();
      return;
    }
    // Readiness not resolved yet (first interaction) — check, then act.
    void (async () => {
      let ready = false;
      try {
        ready = await isModelReady();
      } catch {
        ready = false;
      }
      modelReadyRef.current = ready;
      if (ready) {
        if (token === captureTokenRef.current) beginCapture(token);
      } else {
        ensureModelDownload();
      }
    })();
  }, [status, beginCapture, ensureModelDownload]);

  const stop = useCallback(() => {
    // Stop press-and-hold capture only. NEVER cancel an in-flight model download
    // — it keeps running so a single tap downloads the whole model.
    captureTokenRef.current += 1;
    void engineRef.current?.stop();
    setSpeaking(false);
    setLevel(0);
    setStatus((cur) => (CAPTURING.includes(cur) ? "idle" : cur));
  }, []);

  const toggle = useCallback(() => {
    if (status === "unsupported") return;
    if (CAPTURING.includes(status)) {
      stop();
    } else {
      start();
    }
  }, [status, start, stop]);

  // Force capture off when the consumer disables dictation. A download in flight
  // is left running — it doesn't need a session.
  useEffect(() => {
    if (!enabled && CAPTURING.includes(status)) {
      stop();
    }
  }, [enabled, status, stop]);

  // Release the model + mic on unmount (and abort an in-flight download).
  useEffect(() => {
    return () => {
      downloadRef.current?.cancel();
      void engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  return {
    status,
    active: BUSY.includes(status),
    level,
    speaking,
    lastText,
    downloadPercent,
    error,
    modelLabel: ACTIVE_MODEL.label,
    toggle,
    start,
    stop,
  };
}

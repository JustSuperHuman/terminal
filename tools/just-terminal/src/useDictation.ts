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

// Statuses where the engine is engaged (so a toggle should stand it down).
const BUSY: DictationUiStatus[] = ["checking", "downloading", "loading", "listening", "recognizing"];

export interface UseDictationParams {
  /** Called with each finalized phrase (already trimmed, non-empty). */
  onText: (text: string) => void;
  /** When false, dictation is forced off (e.g. no running session). */
  enabled?: boolean;
}

export interface UseDictationResult {
  status: DictationUiStatus;
  /** Engine engaged (busy or actively listening/recognizing). */
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
 * Drives on-device voice dictation: probes native availability, lazily downloads
 * the Parakeet model on first use, then runs the capture/VAD/transcribe engine
 * and forwards each recognized phrase to `onText`. Safe in Expo Go — it simply
 * reports `unsupported` there.
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
  // Bumped on every start/stop so stale async flows abandon themselves.
  const tokenRef = useRef(0);

  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  // Probe once; flip to `unsupported` when there's no native module (Expo Go).
  useEffect(() => {
    let mounted = true;
    isDictationSupported().then((ok) => {
      if (mounted && !ok) {
        setStatus("unsupported");
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
          else if (engineStatus === "idle") setStatus("idle");
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

  const stop = useCallback(() => {
    tokenRef.current += 1;
    downloadRef.current?.cancel();
    downloadRef.current = null;
    setDownloadPercent(undefined);
    void engineRef.current?.stop();
    setSpeaking(false);
    setLevel(0);
    setStatus((current) => (current === "unsupported" ? current : "idle"));
  }, []);

  const start = useCallback(() => {
    if (status === "unsupported") {
      return;
    }
    const token = ++tokenRef.current;
    setError(undefined);

    void (async () => {
      setStatus("checking");
      let ready = false;
      try {
        ready = await isModelReady();
      } catch {
        ready = false;
      }
      if (token !== tokenRef.current) return;

      if (!ready) {
        setStatus("downloading");
        setDownloadPercent(0);
        const handle = downloadModel((progress) => {
          if (token === tokenRef.current) {
            setDownloadPercent(progress.percent);
          }
        });
        downloadRef.current = handle;
        try {
          await handle.promise;
        } catch (err) {
          if (downloadRef.current === handle) downloadRef.current = null;
          if (err instanceof DictationCancelled || token !== tokenRef.current) {
            return;
          }
          setError(err instanceof Error ? err.message : "Model download failed.");
          setStatus("error");
          return;
        }
        if (downloadRef.current === handle) downloadRef.current = null;
        setDownloadPercent(undefined);
      }
      if (token !== tokenRef.current) return;

      setStatus("loading");
      await getEngine().start(modelDir());
      // Stand down if dictation was toggled off while the model was loading.
      if (token !== tokenRef.current) {
        void getEngine().stop();
      }
    })();
  }, [status, getEngine]);

  const toggle = useCallback(() => {
    if (status === "unsupported") {
      return;
    }
    if (BUSY.includes(status)) {
      stop();
    } else {
      start();
    }
  }, [status, start, stop]);

  // Force off when the consumer disables dictation.
  useEffect(() => {
    if (!enabled && BUSY.includes(status)) {
      stop();
    }
  }, [enabled, status, stop]);

  // Release the model + mic on unmount.
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

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetchInputContext, type SessionInputContext } from "./lib/composerApi";
import type { ServerEndpoint } from "./lib/endpoint";

// Keeps a live read on what the active session's program is doing so the
// composer can label itself, show that the agent is mid-turn, and offer
// one-tap answers to whatever dialog is on screen. Polled rather than pushed:
// the read is cheap host-side and this keeps the socket free for terminal
// bytes, which is the connection that must never stall on mobile.
const POLL_ACTIVE_MS = 1200;
const POLL_IDLE_MS = 2600;

interface Options {
  /** Poll only while there is something to poll for (composer up, session live). */
  enabled: boolean;
}

export interface InputContextState {
  context?: SessionInputContext;
  /** Ask for a fresh read now — used right after sending input. */
  refresh: () => void;
}

export function useInputContext(
  endpoint: ServerEndpoint,
  sessionId: string | undefined,
  { enabled }: Options
): InputContextState {
  const [context, setContext] = useState<SessionInputContext | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef<(delay?: number) => void>(() => undefined);
  // Guards against a slow in-flight read landing after the session changed.
  const generationRef = useRef(0);

  // A stale context is worse than none: it would label the composer with the
  // previous session's agent and offer its dialog's replies.
  useEffect(() => {
    setContext(undefined);
  }, [sessionId]);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!enabled || !sessionId) {
      clearTimer();
      abortRef.current?.abort();
      runRef.current = () => undefined;
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;
    let cancelled = false;

    const poll = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let next: SessionInputContext | undefined;
      try {
        next = await fetchInputContext(endpoint, sessionId, controller.signal);
      } catch {
        // Offline, restarting host, or a session that just went away — keep
        // the last known context and try again on the next tick.
      }

      if (cancelled || generation !== generationRef.current) {
        return;
      }
      if (next) {
        setContext(next);
      }
      if (AppState.currentState === "active") {
        schedule(next?.busy || next?.prompt ? POLL_ACTIVE_MS : POLL_IDLE_MS);
      }
    };

    const schedule = (delay: number) => {
      clearTimer();
      timerRef.current = setTimeout(poll, delay);
    };

    runRef.current = (delay = 0) => schedule(delay);
    schedule(0);

    // iOS suspends timers in the background; re-read as soon as we are back so
    // the composer is never labelled with a stale turn state.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        schedule(0);
      } else {
        clearTimer();
      }
    });

    return () => {
      cancelled = true;
      clearTimer();
      abortRef.current?.abort();
      subscription.remove();
    };
  }, [enabled, endpoint, sessionId]);

  const refresh = useCallback(() => {
    // Agents redraw a beat after input lands; a short delay catches the new
    // state instead of the one we just replaced.
    runRef.current(250);
  }, []);

  return { context, refresh };
}

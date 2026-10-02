"use client";

import { getSessionToken } from "./client";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Fire-and-forget ranking signals (point 24).
 * ─────────────────────────────────────────────────────────────────────────
 * These calls never await, never throw and never render anything. They only
 * report behaviour to the same-origin recommendation API, which does the
 * actual recording and abuse filtering. A failure here can never affect
 * playback, likes, comments or any existing BharatTube feature.
 */

export interface WatchSignal {
  videoId: string | number;
  watchSeconds: number;
  videoSeconds: number;
  /** 0–1; preferred when the duration is unknown. */
  watchPct?: number;
  completed?: boolean;
}

function post(body: Record<string, unknown>): void {
  try {
    const token = getSessionToken();
    void fetch("/api/recommendations/events", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  } catch {
    /* signals are best-effort by design */
  }
}

/** Report normalized watch behaviour (watch %, completion, rewatch). */
export function recordWatchSignal(signal: WatchSignal): void {
  if (!signal?.videoId) return;
  post({
    kind: "watch",
    videoId: String(signal.videoId),
    watchSeconds: signal.watchSeconds,
    videoSeconds: signal.videoSeconds,
    watchPct: signal.watchPct,
    completed: signal.completed,
  });
}

/** Report a like, dislike, comment, share, subscribe, skip or rewatch. */
export function recordInteractionSignal(
  kind:
    | "like"
    | "dislike"
    | "comment"
    | "share"
    | "subscribe"
    | "unsubscribe"
    | "skip"
    | "rewatch",
  videoId: string | number
): void {
  if (!videoId) return;
  post({ kind, videoId: String(videoId) });
}

/** Report a search query as an interest signal. */
export function recordSearchSignal(query: string): void {
  const clean = String(query || "").trim();
  if (!clean) return;
  post({ kind: "search", query: clean });
}

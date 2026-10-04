"use client";

import { getSessionToken } from "./client";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Fire-and-forget ranking signals.
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
  /** Search query that led to this watch, when the app knows it. */
  searchContext?: string;
  /** Which recommendation source served this video, when known. */
  source?: string;
}

export type InteractionSignalKind =
  | "like"
  | "dislike"
  | "comment"
  | "share"
  | "subscribe"
  | "unsubscribe"
  | "skip"
  | "rewatch"
  | "not_interested";

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
    searchContext: signal.searchContext,
    source: signal.source,
  });
}

/** Report a like, dislike, comment, share, subscribe, skip, rewatch or "not interested". */
export function recordInteractionSignal(
  kind: InteractionSignalKind,
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

/**
 * Per-refresh feed session token (#15). Sent with Home/Shorts/related requests
 * so a refresh returns a freshly rotated (but still score-ordered) feed while
 * pagination inside one browsing session stays stable.
 */
const SESSION_KEY = "bharattube_feed_session_v1";

export function getFeedSession(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
  } catch {
    /* sessionStorage may be unavailable; fall back to a fresh token */
  }
  return rotateFeedSession();
}

/** Starts a new ranking session — call on pull-to-refresh / feed reload. */
export function rotateFeedSession(): string {
  const token = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(SESSION_KEY, token);
    } catch {
      /* non-fatal: the server falls back to a time-bucketed seed */
    }
  }
  return token;
}

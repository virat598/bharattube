"use client";

import { getSessionToken } from "./client";

/**
 * Client helper for the same-origin /api/remix route.
 *
 * The route proxies BharatTube's existing Render + MongoDB backend and stores
 * nothing locally, so there is no database on the frontend. Every value shown
 * in the UI comes from the real backend — no invented counters.
 */

export interface RemixSource {
  videoId: string;
  title: string;
  videoUrl: string;
  thumbnailUrl: string;
  duration: number;
  isShort: boolean;
  channelId: string;
  channelHandle: string;
  channelName: string;
}

export interface RemixState {
  available: boolean;
  source: RemixSource | null;
}

function authHeaders(): Record<string, string> {
  // Reuse the existing BharatTube session token (memory/storage/cookie).
  const token = getSessionToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Reads the real source Short that a remix would be built from. */
export async function fetchRemixState(
  sourceVideoId: string | number
): Promise<RemixState> {
  try {
    const res = await fetch(
      `/api/remix?sourceVideoId=${encodeURIComponent(String(sourceVideoId))}`,
      { cache: "no-store", credentials: "include", headers: authHeaders() }
    );
    if (!res.ok) return { available: false, source: null };
    const data = await res.json().catch(() => ({}));
    return {
      available: Boolean(data?.available),
      source: (data?.source as RemixSource) ?? null,
    };
  } catch {
    return { available: false, source: null };
  }
}

/**
 * Validates the remix against the existing backend. Throws with the API's own
 * message so the UI surfaces an honest error instead of pretending it worked.
 */
export async function createRemix(
  sourceVideoId: string | number
): Promise<{ source: RemixSource }> {
  const res = await fetch("/api/remix", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ sourceVideoId: String(sourceVideoId) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Could not start the remix");
  }
  return { source: (data?.source as RemixSource) ?? null };
}

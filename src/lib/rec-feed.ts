"use client";

import { getFeedSession } from "./rec-client";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Feed sources for Home, Shorts and the watch page's related column.
 * ─────────────────────────────────────────────────────────────────────────
 * Every surface requests the server-side recommendation endpoint. If that
 * endpoint is unavailable or returns nothing, the caller falls back to the
 * original chronological backend URL, so the feed can never break.
 *
 * The per-session token is attached automatically: it seeds the server-side
 * rotation, so two different viewers (or two refreshes) never receive an
 * identical ordering, while infinite scroll inside one session stays stable.
 */

export interface FeedPayload {
  videos?: unknown[];
  shorts?: unknown[];
  pagination?: {
    currentPage?: number;
    totalPages?: number;
    hasNextPage?: boolean;
  };
  [key: string]: unknown;
}

async function requestRanked(
  endpoint: string,
  params: Record<string, string | number | undefined>
): Promise<FeedPayload | null> {
  try {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      query.set(key, String(value));
    }
    query.set("session", getFeedSession());
    const res = await fetch(`${endpoint}?${query.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as FeedPayload | null;
    if (!payload) return null;
    const list = payload.videos ?? payload.shorts;
    return Array.isArray(list) && list.length > 0 ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Ranked Home page (long-form). Returns null when the recommendation service
 * is unavailable so the caller can use the existing backend URL.
 */
export function fetchRecommendedHome(
  page: number,
  limit: number
): Promise<FeedPayload | null> {
  return requestRanked("/api/recommendations/home", { page, limit });
}

/**
 * Ranked Shorts page — uses the separate Shorts ranking model.
 * Returns null when unavailable so the caller can fall back.
 */
export function fetchRecommendedShorts(
  page: number,
  limit: number
): Promise<FeedPayload | null> {
  return requestRanked("/api/recommendations/shorts", { page, limit });
}

/**
 * Video→video recommendations for the watch page: ranked by similarity to the
 * video being watched (topic, tags, creator, co-watch neighbours) blended with
 * this viewer's interests. Returns null so the caller can keep its existing
 * fallback untouched.
 */
export function fetchRecommendedRelated(
  videoId: string | number,
  limit: number,
  page = 1
): Promise<FeedPayload | null> {
  if (!videoId) return Promise.resolve(null);
  return requestRanked("/api/recommendations/related", { videoId, limit, page });
}

"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Feed sources for Home and Shorts.
 * ─────────────────────────────────────────────────────────────────────────
 * Both surfaces request the server-side recommendation endpoint. If that
 * endpoint is unavailable or returns nothing, the caller falls back to the
 * original chronological backend URL, so the feed can never break (#26).
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
  page: number,
  limit: number
): Promise<FeedPayload | null> {
  try {
    const res = await fetch(`${endpoint}?page=${page}&limit=${limit}`, {
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
  return requestRanked("/api/recommendations/home", page, limit);
}

/**
 * Ranked Shorts page — uses the separate Shorts ranking model (point 17).
 * Returns null when unavailable so the caller can fall back.
 */
export function fetchRecommendedShorts(
  page: number,
  limit: number
): Promise<FeedPayload | null> {
  return requestRanked("/api/recommendations/shorts", page, limit);
}

import { db, isDatabaseConfigured } from "@/db";
import { serveEvents, watchEvents } from "@/db/schema";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { CREATOR_OVEREXPOSURE, REPETITION } from "./config";
import type { CandidateRow, RecommendationSource } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Impression memory — the fix for "same video baar-baar top par" (#5) and
 * "same creator dominating Home" (#7).
 * ─────────────────────────────────────────────────────────────────────────
 * Every ranked page that is handed to a viewer is written to `serve_events`
 * with its rank, score and recommendation source. On the next request those
 * impressions become penalty multipliers:
 *
 *   recentlyRecommendedVideos → unwatched impressions decay the score
 *   recentlyWatchedVideos     → handled by the viewer profile (watch %)
 *   recentlySkippedVideos     → handled by the viewer profile (skip count)
 *
 * All reads are indexed on (user_key, surface, created_at) and bounded by a
 * rolling window, so this never turns into a full-table scan (#17/#18).
 */

export interface ImpressionMemory {
  /** videoId → impressions inside the window + most recent impression time. */
  videos: Map<string, { count: number; lastAt: number }>;
  /** creatorId → impressions inside the window. */
  creators: Map<string, number>;
}

export function emptyImpressions(): ImpressionMemory {
  return { videos: new Map(), creators: new Map() };
}

/** Recent impressions for one viewer on one surface. */
export async function loadImpressions(
  userKey: string,
  surface: string
): Promise<ImpressionMemory> {
  const memory = emptyImpressions();
  if (!isDatabaseConfigured || !userKey) return memory;

  const since = new Date(Date.now() - REPETITION.impressionWindowHours * 3600_000);
  try {
    const rows = await db
      .select({
        videoId: serveEvents.videoId,
        creatorId: serveEvents.creatorId,
        createdAt: serveEvents.createdAt,
      })
      .from(serveEvents)
      .where(
        and(
          eq(serveEvents.userKey, userKey),
          eq(serveEvents.surface, surface),
          gte(serveEvents.createdAt, since)
        )
      )
      .orderBy(desc(serveEvents.createdAt))
      .limit(REPETITION.maxStoredImpressions);

    for (const row of rows) {
      const at = new Date(row.createdAt).getTime();
      const existing = memory.videos.get(row.videoId);
      if (existing) {
        existing.count += 1;
        existing.lastAt = Math.max(existing.lastAt, at);
      } else {
        memory.videos.set(row.videoId, { count: 1, lastAt: at });
      }
      if (row.creatorId) {
        memory.creators.set(row.creatorId, (memory.creators.get(row.creatorId) ?? 0) + 1);
      }
    }
  } catch {
    /* no impression memory → ranking still works, just without repeat control */
  }
  return memory;
}

/**
 * Genuine watches per creator inside the over-exposure window. A viewer who
 * actively watches a creator gets a reduced diversity penalty (#7).
 */
export async function loadCreatorWatches(userKey: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!isDatabaseConfigured || !userKey) return map;
  const since = new Date(Date.now() - CREATOR_OVEREXPOSURE.windowHours * 3600_000);
  try {
    const rows = await db
      .select({
        channelId: watchEvents.channelId,
        n: sql<number>`count(*)::int`,
      })
      .from(watchEvents)
      .where(
        and(
          eq(watchEvents.userKey, userKey),
          gte(watchEvents.createdAt, since),
          sql`${watchEvents.watchPct} >= 0.25`
        )
      )
      .groupBy(watchEvents.channelId);
    for (const row of rows) {
      if (row.channelId) map.set(row.channelId, Number(row.n) || 0);
    }
  } catch {
    /* relief simply stays unavailable */
  }
  return map;
}

export interface ImpressionItem {
  videoId: string;
  creatorId: string;
  format: "long" | "short";
  score: number;
  rank: number;
  source: RecommendationSource;
}

/**
 * Persists what this viewer was just shown. Fire-and-forget: a failure here
 * must never break the feed, so the write is awaited only in a catch-all.
 */
export async function recordImpressions(
  userKey: string,
  surface: string,
  items: ImpressionItem[]
): Promise<void> {
  if (!isDatabaseConfigured || !userKey || !items.length) return;
  const now = new Date();
  const rows = items.slice(0, 60).map((item) => ({
    userKey,
    surface,
    videoId: String(item.videoId).slice(0, 64),
    score: Number(item.score) || 0,
    rank: Number(item.rank) || 0,
    creatorId: String(item.creatorId ?? "").slice(0, 64),
    format: item.format === "short" ? "short" : "long",
    source: String(item.source ?? "").slice(0, 32),
    createdAt: now,
  }));
  try {
    await db.insert(serveEvents).values(rows).onConflictDoNothing();
  } catch {
    /* impressions are best-effort */
  }
}

/** Rolling prune so the table stays small and every query stays indexed. */
let lastPrune = 0;
export async function pruneImpressions(userKey: string, surface: string): Promise<void> {
  if (!isDatabaseConfigured || !userKey) return;
  const now = Date.now();
  if (now - lastPrune < 5 * 60_000) return;
  lastPrune = now;
  const cutoff = new Date(now - REPETITION.impressionWindowHours * 2 * 3600_000);
  try {
    await db
      .delete(serveEvents)
      .where(
        and(
          eq(serveEvents.userKey, userKey),
          eq(serveEvents.surface, surface),
          sql`${serveEvents.createdAt} < ${cutoff}`
        )
      );
  } catch {
    /* pruning is optional housekeeping */
  }
}

/**
 * Videos that must never be re-recommended right now: explicit "not interested"
 * inside its window. Kept separate from scoring so the filter step (#15 stage
 * "Repeated Content Removal") can drop them before ranking.
 */
export async function loadSuppressedVideoIds(userKey: string): Promise<Set<string>> {
  const set = new Set<string>();
  if (!isDatabaseConfigured || !userKey) return set;
  const since = new Date(Date.now() - REPETITION.notInterestedWindowHours * 3600_000);
  try {
    const rows = await db
      .select({ targetId: sql<string>`target_id` })
      .from(sql`interaction_events`)
      .where(
        sql`user_key = ${userKey} and kind = 'not_interested' and created_at >= ${since}`
      )
      .limit(500);
    for (const row of rows) set.add(String(row.targetId));
  } catch {
    /* scoring still applies the penalty from the viewer profile */
  }
  return set;
}

/** Helper for candidate-stage filtering: drop ids the viewer already handled. */
export function filterSuppressed(pool: CandidateRow[], suppressed: Set<string>): CandidateRow[] {
  if (!suppressed.size) return pool;
  return pool.filter((c) => !suppressed.has(c.id));
}

/** Videos impressed in the top slots very recently — excluded from top slots. */
export function recentTopSlotIds(memory: ImpressionMemory): Set<string> {
  const ids = new Set<string>();
  const cutoff = Date.now() - REPETITION.topSlotCooldownHours * 3600_000;
  for (const [videoId, info] of memory.videos) {
    if (info.lastAt >= cutoff && info.count >= 1) ids.add(videoId);
  }
  return ids;
}

export { inArray };

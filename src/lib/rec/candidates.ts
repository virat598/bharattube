import { getDb, isDatabaseConfigured } from "@/db";
import { videosCache } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { CANDIDATE_POOL_SIZE, CANDIDATE_SLICE_SIZE } from "./config";
import { loadBackendCandidates } from "./backend-candidates";
import type { CandidateRow, ViewerProfile } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Candidate generation (#15 stage 1, #16, #18).
 * ─────────────────────────────────────────────────────────────────────────
 * The previous pool was a single `ORDER BY created_at DESC` slice, which is
 * exactly why the newest upload kept landing on top of everybody's Home. The
 * pool is now assembled from SEVERAL indexed slices and unioned:
 *
 *   • freshest        → new uploads still get a route into the pool
 *   • most viewed     → proven performers
 *   • best engagement → quality that never accumulated mass views
 *   • viewer's topics → personalised recall (indexed on category)
 *   • viewer's creators / subscriptions → affinity recall (indexed on channel)
 *
 * Each slice is bounded, so a Home request never scans the whole library, and
 * older relevant videos stay reachable instead of being pushed out by recency.
 */

export type Surface = "home" | "shorts" | "related";

function subscriberCount(raw: Record<string, unknown>): number {
  const channel = (raw ?? {}) as Record<string, unknown>;
  const subs = (channel as Record<string, unknown>).channel
    ? (((channel as Record<string, unknown>).channel ?? {}) as Record<string, unknown>).subscribers
    : (channel as Record<string, unknown>).subscribers;
  if (Array.isArray(subs)) return subs.length;
  const holder = ((raw?.channel ?? {}) as Record<string, unknown>);
  const n = Number(holder.subscribersCount ?? holder.subscriberCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const BASE_COLUMNS = {
  id: videosCache.id,
  title: videosCache.title,
  description: videosCache.description,
  category: videosCache.category,
  language: videosCache.language,
  tags: videosCache.tags,
  channelId: videosCache.channelId,
  durationSec: videosCache.durationSec,
  isShort: videosCache.isShort,
  views: videosCache.views,
  likesCount: videosCache.likesCount,
  dislikesCount: videosCache.dislikesCount,
  commentsCount: videosCache.commentsCount,
  shares: videosCache.shares,
  raw: videosCache.raw,
  sourceCreatedAt: videosCache.sourceCreatedAt,
};

type Row = typeof BASE_COLUMNS extends infer T ? { [K in keyof T]: unknown } : never;

function toCandidate(row: Row): CandidateRow {
  const tags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
  const raw = (row.raw ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    category: String(row.category ?? ""),
    language: String(row.language ?? ""),
    tags,
    channelId: String(row.channelId ?? ""),
    durationSec: Number(row.durationSec) || 0,
    isShort: Boolean(row.isShort),
    views: Number(row.views) || 0,
    likesCount: Number(row.likesCount) || 0,
    dislikesCount: Number(row.dislikesCount) || 0,
    commentsCount: Number(row.commentsCount) || 0,
    shares: Number(row.shares) || 0,
    raw,
    sourceCreatedAt: row.sourceCreatedAt ? new Date(row.sourceCreatedAt as string | Date) : null,
    subscribers: subscriberCount(raw),
  };
}

/** Engagement rate expressed in SQL so the slice stays an indexed top-N. */
const ENGAGEMENT_EXPR = sql`(
  (${videosCache.likesCount} + 2 * ${videosCache.commentsCount} + 3 * ${videosCache.shares})::float
  / (${videosCache.views} + 25)
)`;

function topTopics(profile: ViewerProfile | null, limit = 6): string[] {
  if (!profile) return [];
  return [...profile.topicAffinity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic]) => topic);
}

function topCreators(profile: ViewerProfile | null, limit = 12): string[] {
  if (!profile) return [];
  const fromAffinity = [...profile.creatorAffinity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
  return [...new Set([...fromAffinity, ...profile.subscriptions])].slice(0, limit * 2);
}

/**
 * Builds the union of every recall strategy. `profile` may be null (cold
 * start), in which case only the non-personalised slices are queried.
 */
export async function generateCandidates(
  surface: Surface,
  profile: ViewerProfile | null,
  authHeaders?: Record<string, string>
): Promise<CandidateRow[]> {
  const wantShort = surface === "shorts";

  if (!isDatabaseConfigured) {
    // Vercel path: no Postgres, so the pool comes straight from the existing
    // backend (already several pages wide, not just the newest items).
    const backend = await loadBackendCandidates(authHeaders).catch(() => ({
      longs: [] as CandidateRow[],
      shorts: [] as CandidateRow[],
    }));
    const list = wantShort ? backend.shorts : backend.longs;
    return surface === "related" ? [...backend.longs, ...backend.shorts] : list;
  }

  const db = getDb();
  if (!db) return [];

  const formatFilter = surface === "related" ? undefined : eq(videosCache.isShort, wantShort);
  const where = (extra?: ReturnType<typeof eq> | ReturnType<typeof inArray>) =>
    and(eq(videosCache.visible, true), formatFilter, extra) ?? eq(videosCache.visible, true);

  const slices = await Promise.all([
    // 1. freshest uploads
    db
      .select(BASE_COLUMNS)
      .from(videosCache)
      .where(where())
      .orderBy(desc(sql`coalesce(${videosCache.sourceCreatedAt}, now() - interval '30 days')`))
      .limit(CANDIDATE_SLICE_SIZE)
      .catch(() => [] as Row[]),
    // 2. most viewed (proven performers)
    db
      .select(BASE_COLUMNS)
      .from(videosCache)
      .where(where())
      .orderBy(desc(videosCache.views))
      .limit(CANDIDATE_SLICE_SIZE)
      .catch(() => [] as Row[]),
    // 3. best engagement rate (quality independent of scale)
    db
      .select(BASE_COLUMNS)
      .from(videosCache)
      .where(where())
      .orderBy(desc(ENGAGEMENT_EXPR))
      .limit(CANDIDATE_SLICE_SIZE)
      .catch(() => [] as Row[]),
    // 4. personalised recall by topic
    (async () => {
      const topics = topTopics(profile);
      if (!topics.length) return [] as Row[];
      return db
        .select(BASE_COLUMNS)
        .from(videosCache)
        .where(where(inArray(sql`lower(${videosCache.category})`, topics)))
        .orderBy(desc(ENGAGEMENT_EXPR))
        .limit(CANDIDATE_SLICE_SIZE)
        .catch(() => [] as Row[]);
    })(),
    // 5. personalised recall by creator / subscription
    (async () => {
      const creators = topCreators(profile);
      if (!creators.length) return [] as Row[];
      return db
        .select(BASE_COLUMNS)
        .from(videosCache)
        .where(where(inArray(videosCache.channelId, creators)))
        .orderBy(desc(sql`coalesce(${videosCache.sourceCreatedAt}, now())`))
        .limit(CANDIDATE_SLICE_SIZE)
        .catch(() => [] as Row[]);
    })(),
  ]);

  const merged = new Map<string, CandidateRow>();
  for (const slice of slices) {
    for (const row of slice as Row[]) {
      const candidate = toCandidate(row);
      if (candidate.id && !merged.has(candidate.id)) merged.set(candidate.id, candidate);
    }
  }

  // Hard cap keeps the ranking pass O(pool) and predictable under load.
  return [...merged.values()].slice(0, CANDIDATE_POOL_SIZE);
}

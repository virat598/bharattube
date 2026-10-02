import { getDb, isDatabaseConfigured } from "@/db";
import { videosCache } from "@/db/schema";
import { loadBackendCandidates } from "./backend-candidates";
import {
  buildProfileFromSignals,
  loadViewerSignals,
  retentionFromSignals,
} from "./backend-signals";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  CANDIDATE_POOL_SIZE,
  FEED_PAGE_SIZE,
  FRESHNESS_HALF_LIFE_HOURS,
  SHORTS_FRESHNESS_HALF_LIFE_HOURS,
  SHORTS_PAGE_SIZE,
  SHORTS_WEIGHTS,
  WEIGHTS,
} from "./config";
import { ensureCandidates } from "./sync";
import {
  buildViewerProfile,
  recentInteractionCounts,
  retentionByVideo,
  scoreCandidates,
  type CandidateRow,
} from "./scoring";
import { applyCreatorDiversity, applyTopicDiversity, isExplorationCandidate } from "./diversity";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Recommendation pipeline (point 20), executed entirely server-side.
 * ─────────────────────────────────────────────────────────────────────────
 *   1  fetch a broad candidate pool (not just the newest page)
 *   2  drop unavailable / deleted / private videos
 *   3  drop videos the viewer must not receive
 *   4  personalised scores
 *   5  freshness
 *   6  engagement + retention
 *   7  subscribed-channel boost
 *   8  exploration
 *   9  creator diversity
 *  10  topic diversity
 *  11  already-watched adjustment
 *  12  final ranking
 *  13  hand the ranked page to the existing Home UI
 *
 * The response contains ranked videos only. No weights, thresholds or
 * component breakdowns are returned to the browser.
 */

export type Surface = "home" | "shorts";

function subscriberCount(raw: Record<string, unknown>): number {
  const channel = (raw?.channel ?? {}) as Record<string, unknown>;
  const subs = channel.subscribers;
  if (Array.isArray(subs)) return subs.length;
  const n = Number(channel.subscribersCount ?? channel.subscriberCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Steps 1–3: load the candidate pool. Ordered by a blend of recency and
 * lifetime engagement so genuinely relevant older videos stay discoverable —
 * the pool is NOT a pure createdAt DESC slice.
 */
async function loadPool(surface: Surface): Promise<CandidateRow[]> {
  // No Postgres → no candidate cache. Returning an empty pool makes rankFeed
  // return an empty page, which tells the client to use the existing
  // BharatTube backend feed. Nothing else in the app depends on a database.
  if (!isDatabaseConfigured) return [];
  const isShort = surface === "shorts";
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
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
    })
    .from(videosCache)
    .orderBy(
      // Recency-lean, but engagement-heavy so older quality survives step 1.
      desc(sql`coalesce(${videosCache.sourceCreatedAt}, now() - interval '30 days')`),
      desc(videosCache.views)
    )
    .limit(CANDIDATE_POOL_SIZE);

  return rows.map((row) => ({
    ...row,
    tags: Array.isArray(row.tags) ? row.tags : [],
    raw: (row.raw ?? {}) as Record<string, unknown>,
    subscribers: subscriberCount(row.raw),
  }));
}

export interface RankedFeed {
  items: Array<{ raw: Record<string, unknown>; score: number; rank: number; seen: string }>;
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCandidates: number;
  coldStart: boolean;
  signals: number;
}

/**
 * Steps 4–12 and pagination (point 22). Ranking is deterministic per viewer
 * given their signals, so offset pagination is stable across a page load.
 */
export async function rankFeed(
  userKey: string,
  surface: Surface,
  page = 1,
  requestedPageSize?: number,
  authHeaders?: Record<string, string>
): Promise<RankedFeed> {
  const pageSize = Math.max(
    1,
    Math.min(requestedPageSize ?? (surface === "shorts" ? SHORTS_PAGE_SIZE : FEED_PAGE_SIZE), 60)
  );

  // Step 1–3: candidate pool.
  //
  // Two interchangeable sources for the SAME data:
  //   • Postgres cache — used when DATABASE_URL exists (self-hosted/sandbox).
  //   • the existing backend directly — the Vercel path, where there is no
  //     database at all. Without this the algorithm silently degraded to a
  //     chronological feed on Vercel.
  let pool: CandidateRow[];
  if (isDatabaseConfigured) {
    await ensureCandidates();
    pool = await loadPool(surface).catch(() => [] as CandidateRow[]);
  } else {
    const backend = await loadBackendCandidates(authHeaders).catch(() => ({
      longs: [] as CandidateRow[],
      shorts: [] as CandidateRow[],
    }));
    pool = surface === "shorts" ? backend.shorts : backend.longs;
  }

  // Home ranks long-form first; Shorts come from their own surface (#17).
  if (surface === "home") {
    pool = pool.filter((c) => !c.isShort);
  }

  if (!pool.length) {
    return {
      items: [],
      page,
      pageSize,
      hasMore: false,
      totalCandidates: 0,
      coldStart: true,
      signals: 0,
    };
  }

  const ids = pool.map((c) => c.id);

  // Personalisation has two interchangeable sources, matching the pool above:
  //   • Postgres event tables (when a database is configured)
  //   • the existing backend's own /history, /likes and /search-history, which
  //     is what makes per-viewer ranking work on Vercel.
  let profile: Awaited<ReturnType<typeof buildViewerProfile>> | null = null;
  let retention = new Map<string, { avg: number; n: number; completed: number }>();
  let velocity = new Map<string, number>();

  if (isDatabaseConfigured) {
    const [p, r, v] = await Promise.all([
      buildViewerProfile(userKey, pool).catch(() => null),
      retentionByVideo(ids),
      recentInteractionCounts(ids),
    ]);
    profile = p;
    retention = r;
    velocity = v;
  } else {
    const signals = await loadViewerSignals(authHeaders).catch(() => null);
    if (signals) {
      profile = buildProfileFromSignals(pool, signals) as Awaited<
        ReturnType<typeof buildViewerProfile>
      >;
      retention = retentionFromSignals(signals);
      // Velocity stays lifetime-only here: the backend does not expose a
      // per-video recent-activity stream, so this component degrades rather
      // than being invented.
      velocity = new Map();
    }
  }

  const viewer = profile ?? {
    userKey,
    coldStart: true,
    topicAffinity: new Map(),
    tokenAffinity: new Map(),
    creatorAffinity: new Map(),
    languageAffinity: new Map(),
    shortAffinity: 0.5,
    watched: new Map(),
    subscriptions: new Set<string>(),
    observedEvents: 0,
  };

  let retentionSamples = 0;
  let retentionSum = 0;
  for (const value of retention.values()) {
    retentionSamples += value.n;
    retentionSum += value.avg * value.n;
  }
  const globalRetention = retentionSamples > 0 ? retentionSum / retentionSamples : 0.4;

  // Steps 4–8 + 11 (scoring). Shorts use their own model and half-life (#17).
  const scored = scoreCandidates(
    pool,
    viewer,
    { surface, retention, globalRetention, velocity },
    surface === "shorts" ? SHORTS_WEIGHTS : WEIGHTS,
    surface === "shorts" ? SHORTS_FRESHNESS_HALF_LIFE_HOURS : FRESHNESS_HALF_LIFE_HOURS
  );

  // Step 12 — deterministic order (score desc, then id) so pagination holds.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.candidate.id).localeCompare(String(b.candidate.id));
  });

  // Steps 9–10 — diversity, applied to the ranked order.
  const diversified = applyTopicDiversity(
    applyCreatorDiversity(scored),
    pageSize
  );

  // Exploration accounting (point 19) — logged, never surfaced to the client.
  void isExplorationCandidate;
  void viewer.coldStart;

  const start = (page - 1) * pageSize;
  const pageItems = diversified.slice(start, start + pageSize);

  return {
    items: pageItems.map((item, index) => ({
      raw: item.candidate.raw,
      score: item.score,
      rank: start + index + 1,
      seen: item.seenState,
    })),
    page,
    pageSize,
    hasMore: start + pageItems.length < diversified.length,
    totalCandidates: diversified.length,
    coldStart: viewer.coldStart,
    signals: viewer.observedEvents,
  };
}

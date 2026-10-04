import { isDatabaseConfigured } from "@/db";
import {
  buildProfileFromSignals,
  loadViewerSignals,
  retentionFromSignals,
} from "./backend-signals";
import { generateCandidates } from "./candidates";
import {
  loadGlobalAggregates,
  loadVideoStats,
  refreshAggregatesInBackground,
  similarUserScores,
  similarVideoScores,
} from "./collaborative";
import {
  FEED_PAGE_SIZE,
  FRESHNESS_HALF_LIFE_HOURS,
  RELATED_PAGE_SIZE,
  RELATED_WEIGHTS,
  REPETITION,
  SHORTS_FRESHNESS_HALF_LIFE_HOURS,
  SHORTS_PAGE_SIZE,
  SHORTS_WEIGHTS,
  WEIGHTS,
} from "./config";
import { applyCreatorDiversity, applyTopicDiversity } from "./diversity";
import {
  applyRotation,
  applyStrategyMix,
  coldStartRank,
  defaultRotationSeed,
  demoteFromTopSlots,
} from "./mix";
import { peekCachedProfile, loadViewerProfile } from "./profile-cache";
import {
  loadCreatorWatches,
  loadImpressions,
  loadSuppressedVideoIds,
  pruneImpressions,
  recentTopSlotIds,
  recordImpressions,
} from "./repetition";
import {
  emptyProfile,
  emptyScoreContext,
  recentInteractionCounts,
  retentionByVideo,
  scoreCandidates,
  stableHash,
  type CandidateRow,
  type ScoreContext,
  type ViewerProfile,
} from "./scoring";
import { ensureCandidates } from "./sync";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Recommendation pipeline, executed entirely server-side.
 * ─────────────────────────────────────────────────────────────────────────
 *   Candidate Generation        → several indexed recall strategies, unioned
 *   ↓
 *   Eligibility Filtering       → public only, format, "not interested" removed
 *   ↓
 *   Personalized Scoring        → every component × configured weight
 *   ↓
 *   Repeated Content Removal    → watched / skipped / impressed penalties
 *   ↓
 *   Creator Diversity           → no creator may dominate consecutive slots
 *   ↓
 *   Topic Diversity             → no category may dominate the page
 *   ↓
 *   Format Balancing            → format-aware weights per surface
 *   ↓
 *   Exploration Injection       → ~75% personal / ~15% related / ~10% explore
 *   ↓
 *   Final Ranking + Rotation    → refresh never returns an identical order
 *   ↓
 *   Home Feed                   → ranked videos only, weights never leave
 *
 * Two interchangeable data sources keep this working everywhere:
 *   • Postgres (DATABASE_URL set) — full engine: cached profiles, collaborative
 *     filtering, precomputed stats and impression memory.
 *   • the existing BharatTube backend alone — personalisation from the viewer's
 *     own /history, /likes and /search-history, so ranking still differs per
 *     viewer when there is no database at all.
 */

export type Surface = "home" | "shorts" | "related";

export interface RankOptions {
  /** Client-generated per-refresh token; seeds the bounded rotation (#15). */
  session?: string;
  /** Anchor video for the related / up-next surface (#9). */
  anchorId?: string;
  /** Restrict the related surface to one format. */
  shortsOnly?: boolean;
}

export interface RankedFeed {
  items: Array<{
    raw: Record<string, unknown>;
    score: number;
    rank: number;
    seen: string;
    source: string;
  }>;
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCandidates: number;
  coldStart: boolean;
  signals: number;
}

const EMPTY_FEED = (page: number, pageSize: number): RankedFeed => ({
  items: [],
  page,
  pageSize,
  hasMore: false,
  totalCandidates: 0,
  coldStart: true,
  signals: 0,
});

function pageSizeFor(surface: Surface, requested?: number): number {
  const fallback =
    surface === "shorts"
      ? SHORTS_PAGE_SIZE
      : surface === "related"
      ? RELATED_PAGE_SIZE
      : FEED_PAGE_SIZE;
  return Math.max(1, Math.min(requested ?? fallback, 60));
}

function weightsFor(surface: Surface) {
  if (surface === "shorts") return SHORTS_WEIGHTS;
  // Related / up-next is similarity-led: the anchor's topic, creator and
  // co-watch neighbours dominate, generic popularity barely matters (#9).
  if (surface === "related") return RELATED_WEIGHTS;
  return WEIGHTS;
}

function halfLifeFor(surface: Surface) {
  return surface === "shorts" ? SHORTS_FRESHNESS_HALF_LIFE_HOURS : FRESHNESS_HALF_LIFE_HOURS;
}

/** Impressions are tracked per surface so Home repeats do not starve Shorts. */
function impressionScope(surface: Surface): string {
  return surface === "related" ? "home" : surface;
}

export async function rankFeed(
  userKey: string,
  surface: Surface,
  page = 1,
  requestedPageSize?: number,
  authHeaders?: Record<string, string>,
  options: RankOptions = {}
): Promise<RankedFeed> {
  const pageSize = pageSizeFor(surface, requestedPageSize);
  const anchorId = String(options.anchorId ?? "").slice(0, 64);

  // ── Candidate Generation ────────────────────────────────────────────────
  if (isDatabaseConfigured) {
    await ensureCandidates();
    // Precomputed aggregates refresh on their own TTL, off the request path.
    refreshAggregatesInBackground();
  }

  // A cached profile is enough to drive personalised recall slices; when there
  // is no cache the pool is supplemented right after the profile is built.
  const recallProfile = isDatabaseConfigured
    ? await peekCachedProfile(userKey).catch(() => null)
    : null;

  let pool: CandidateRow[] = await generateCandidates(surface, recallProfile, authHeaders).catch(
    () => [] as CandidateRow[]
  );

  if (!pool.length) return EMPTY_FEED(page, pageSize);

  // ── Personalisation source ──────────────────────────────────────────────
  let viewer: ViewerProfile;
  let ctx: ScoreContext = emptyScoreContext(surface);

  if (isDatabaseConfigured) {
    viewer = await loadViewerProfile(userKey, pool).catch(() => emptyProfile(userKey));

    // Cold cache: the first pass had no personalised recall slices, so merge a
    // personalised pull now. Costs two indexed queries, once per invalidation.
    if (!recallProfile && !viewer.coldStart) {
      const supplement = await generateCandidates(surface, viewer, authHeaders).catch(
        () => [] as CandidateRow[]
      );
      if (supplement.length) {
        const byId = new Map(pool.map((c) => [c.id, c]));
        for (const extra of supplement) if (!byId.has(extra.id)) byId.set(extra.id, extra);
        pool = [...byId.values()];
      }
    }

    const ids = pool.map((c) => c.id);
    const [stats, globals, velocity, similarUsers, similarVideo, impressions, creatorWatches] =
      await Promise.all([
        loadVideoStats(ids),
        loadGlobalAggregates(),
        recentInteractionCounts(ids).catch(() => new Map<string, number>()),
        similarUserScores(viewer, pool).catch(() => new Map<string, number>()),
        anchorId
          ? similarVideoScores(anchorId, pool).catch(() => new Map<string, number>())
          : Promise.resolve(new Map<string, number>()),
        loadImpressions(userKey, impressionScope(surface)),
        loadCreatorWatches(userKey),
      ]);

    // Retention comes from the precomputed table; a live query only fills gaps
    // for videos the background job has not aggregated yet.
    let retention = new Map<string, { avg: number; n: number; completed: number }>();
    if (stats.size < Math.min(20, ids.length)) {
      retention = await retentionByVideo(ids).catch(
        () => new Map<string, { avg: number; n: number; completed: number }>()
      );
    }
    for (const [id, stat] of stats) {
      if (stat.samples > 0) {
        retention.set(id, { avg: stat.avgWatchPct, n: stat.samples, completed: stat.completions });
      }
    }

    ctx = {
      ...ctx,
      stats,
      retention,
      globalRetention: globals.retention,
      globalConversion: globals.conversion,
      velocity,
      similarUsers,
      similarVideo,
      impressions: impressions.videos,
      creatorImpressions: impressions.creators,
      creatorWatches,
      audienceSeed: stableHash(userKey || "anonymous"),
    };
  } else {
    // No database: personalisation comes from the viewer's own backend data.
    const signals = await loadViewerSignals(authHeaders).catch(() => null);
    viewer = signals
      ? { ...emptyProfile(userKey), ...buildProfileFromSignals(pool, signals) }
      : emptyProfile(userKey);
    if (signals) {
      ctx = {
        ...ctx,
        retention: retentionFromSignals(signals),
        globalRetention: 0.4,
        audienceSeed: stableHash(userKey || "anonymous"),
      };
      let retentionSum = 0;
      let retentionSamples = 0;
      for (const value of ctx.retention.values()) {
        retentionSamples += value.n;
        retentionSum += value.avg * value.n;
      }
      if (retentionSamples > 0) ctx.globalRetention = retentionSum / retentionSamples;
    }
  }

  // ── Eligibility Filtering ───────────────────────────────────────────────
  // Format: Home ranks long-form, Shorts rank Shorts (the existing Home layout
  // interleaves the two surfaces itself, so neither list may contain both).
  if (surface === "home") pool = pool.filter((c) => !c.isShort);
  else if (surface === "shorts") pool = pool.filter((c) => c.isShort);
  else if (surface === "related" && !options.shortsOnly) pool = pool.filter((c) => !c.isShort);

  // The anchor itself is never "related" to itself.
  if (anchorId) pool = pool.filter((c) => c.id !== anchorId);

  // "Not interested" is a hard removal for its window, not just a demotion.
  const suppressedIds = isDatabaseConfigured
    ? await loadSuppressedVideoIds(userKey).catch(() => new Set<string>())
    : new Set<string>();
  for (const id of viewer.notInterested.keys()) suppressedIds.add(id);
  if (suppressedIds.size) pool = pool.filter((c) => !suppressedIds.has(c.id));

  if (!pool.length) return EMPTY_FEED(page, pageSize);

  // ── Personalized Scoring ────────────────────────────────────────────────
  const scored = scoreCandidates(
    pool,
    viewer,
    ctx,
    weightsFor(surface),
    halfLifeFor(surface)
  );

  // Suppressed candidates that survived (e.g. recorded mid-request) are dropped.
  const eligible = scored.filter((item) => !item.suppressed);

  // ── Final ranking, then diversity, then mix ─────────────────────────────
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.candidate.id).localeCompare(String(b.candidate.id));
  });

  // Repeated-content control: a video impressed within the cooldown window is
  // kept out of the top slots but stays available deeper in the feed.
  const recentlyImpressed = recentTopSlotIds({
    videos: ctx.impressions,
    creators: ctx.creatorImpressions,
  });
  const guarded = demoteFromTopSlots(eligible, recentlyImpressed, REPETITION.topSlotCount);

  const diversified = applyTopicDiversity(applyCreatorDiversity(guarded), pageSize);

  // Cold start (#13) gets a breadth-first page; everyone else gets the
  // exploitation / related / exploration mix (#11).
  const arranged = viewer.coldStart
    ? coldStartRank(diversified, pageSize)
    : applyStrategyMix(diversified, pageSize);

  // Home refresh (#15): bounded rotation seeded by the client's session token.
  const rotated = applyRotation(arranged, options.session, defaultRotationSeed());

  const start = (page - 1) * pageSize;
  const pageItems = rotated.slice(start, start + pageSize);

  // ── Impression memory (#5/#7/#19) ───────────────────────────────────────
  if (userKey && isDatabaseConfigured && pageItems.length) {
    await recordImpressions(
      userKey,
      impressionScope(surface),
      pageItems.map((item, index) => ({
        videoId: item.candidate.id,
        creatorId: item.candidate.channelId,
        format: item.candidate.isShort ? "short" : "long",
        score: item.score,
        rank: start + index + 1,
        source: item.source,
      }))
    ).catch(() => undefined);
    void pruneImpressions(userKey, impressionScope(surface));
  }

  return {
    items: pageItems.map((item, index) => ({
      raw: item.candidate.raw,
      score: item.score,
      rank: start + index + 1,
      seen: item.seenState,
      source: item.source,
    })),
    page,
    pageSize,
    hasMore: start + pageItems.length < rotated.length,
    totalCandidates: rotated.length,
    coldStart: viewer.coldStart,
    signals: viewer.observedEvents,
  };
}

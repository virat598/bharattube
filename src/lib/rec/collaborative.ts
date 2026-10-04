import { db, isDatabaseConfigured } from "@/db";
import { itemSimilarity, syncState, videoStats, videosCache, watchEvents, serveEvents } from "@/db/schema";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { CF, STATS_TTL_MS, VELOCITY_WINDOW_HOURS } from "./config";
import { tokenize, type CandidateRow, type ViewerProfile, type VideoStat } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Collaborative filtering (#8), video→video similarity (#9) and the
 * background aggregation of per-video statistics (#12/#18).
 * ─────────────────────────────────────────────────────────────────────────
 * Everything expensive here is PRECOMPUTED on a TTL and stored in Postgres.
 * A Home request only ever reads small, indexed slices — never a full scan of
 * the event tables, and never a similarity matrix built from scratch.
 *
 *   item_similarity → "users with similar interests also watched this"
 *   video_stats     → retention / completion / skip / impression conversion
 */

type SimilarityMap = Map<string, Map<string, number>>;

/* ───────────────────────── background aggregation ─────────────────────── */

async function scopeAge(scope: string): Promise<number> {
  try {
    const rows = await db
      .select({ at: syncState.lastSyncedAt })
      .from(syncState)
      .where(eq(syncState.scope, scope))
      .limit(1);
    if (!rows.length) return Infinity;
    return Date.now() - new Date(rows[0].at).getTime();
  } catch {
    return Infinity;
  }
}

async function markScope(scope: string, seen: number): Promise<void> {
  try {
    await db
      .insert(syncState)
      .values({ scope, itemsSeen: seen, lastSyncedAt: new Date() })
      .onConflictDoNothing();
    await db
      .update(syncState)
      .set({ lastSyncedAt: new Date(), itemsSeen: seen })
      .where(eq(syncState.scope, scope));
  } catch {
    /* bookkeeping only */
  }
}

/**
 * Per-video aggregates: average watch %, completions, skips, impressions and
 * the impression→watch conversion rate that judges a fresh upload's test pool.
 */
export async function refreshVideoStats(): Promise<void> {
  if (!isDatabaseConfigured) return;
  if ((await scopeAge("stats")) < STATS_TTL_MS) return;

  const recentCutoff = new Date(Date.now() - VELOCITY_WINDOW_HOURS * 3600_000);
  try {
    await db.execute(sql`
      INSERT INTO video_stats AS vs (
        video_id, samples, avg_watch_pct, completions, skips, impressions,
        conversion, recent_samples, computed_at
      )
      SELECT
        w.video_id,
        count(*)::int,
        coalesce(avg(w.watch_pct), 0)::real,
        sum(case when w.completed then 1 else 0 end)::int,
        sum(case when w.skipped or w.watch_pct < 0.12 then 1 else 0 end)::int,
        coalesce(impr.n, 0)::int,
        case
          when coalesce(impr.n, 0) > 0 then (count(*)::real / impr.n::real)
          else 0
        end::real,
        sum(case when w.created_at >= ${recentCutoff} then 1 else 0 end)::int,
        now()
      FROM watch_events w
      LEFT JOIN (
        SELECT video_id, count(*)::int AS n
        FROM serve_events
        GROUP BY video_id
      ) impr ON impr.video_id = w.video_id
      GROUP BY w.video_id, impr.n
      ON CONFLICT (video_id) DO UPDATE SET
        samples = excluded.samples,
        avg_watch_pct = excluded.avg_watch_pct,
        completions = excluded.completions,
        skips = excluded.skips,
        impressions = excluded.impressions,
        conversion = excluded.conversion,
        recent_samples = excluded.recent_samples,
        computed_at = excluded.computed_at
    `);
    await markScope("stats", 1);
  } catch {
    /* stats are an optimisation; ranking falls back to live queries */
  }
}

/** Reads the precomputed aggregates for a bounded set of candidates. */
export async function loadVideoStats(videoIds: string[]): Promise<Map<string, VideoStat>> {
  const map = new Map<string, VideoStat>();
  if (!isDatabaseConfigured || !videoIds.length) return map;
  try {
    const rows = await db
      .select()
      .from(videoStats)
      .where(inArray(videoStats.videoId, videoIds.slice(0, 600)));
    for (const row of rows) {
      map.set(row.videoId, {
        samples: row.samples,
        avgWatchPct: Number(row.avgWatchPct) || 0,
        completions: row.completions,
        skips: row.skips,
        impressions: row.impressions,
        conversion: Number(row.conversion) || 0,
        recentSamples: row.recentSamples,
      });
    }
  } catch {
    /* empty → retention prior is used instead */
  }
  return map;
}

/** Global average conversion — the baseline a fresh upload is judged against. */
export async function loadGlobalAggregates(): Promise<{
  retention: number;
  conversion: number;
}> {
  if (!isDatabaseConfigured) return { retention: 0.4, conversion: 0 };
  try {
    const rows = await db
      .select({
        retention: sql<number>`coalesce(avg(avg_watch_pct), 0)::float`,
        conversion: sql<number>`coalesce(avg(conversion), 0)::float`,
      })
      .from(videoStats);
    return {
      retention: Number(rows[0]?.retention) || 0.4,
      conversion: Number(rows[0]?.conversion) || 0,
    };
  } catch {
    return { retention: 0.4, conversion: 0 };
  }
}

/** Co-watch pairs from the viewer event stream, bounded to a recent window. */
async function loadCoWatchPairs(): Promise<Map<string, Map<string, number>>> {
  const pairs: Map<string, Map<string, number>> = new Map();
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  try {
    const rows = await db
      .select({
        a: sql<string>`a.video_id`,
        b: sql<string>`b.video_id`,
        n: sql<number>`count(distinct a.user_key)::int`,
      })
      .from(sql`watch_events a`)
      .innerJoin(
        sql`watch_events b`,
        sql`a.user_key = b.user_key and a.video_id <> b.video_id and b.watch_pct >= 0.3`
      )
      .where(sql`a.watch_pct >= 0.3 and a.created_at >= ${since} and b.created_at >= ${since}`)
      .groupBy(sql`a.video_id`, sql`b.video_id`)
      .having(sql`count(distinct a.user_key) >= ${CF.minCoWatchers}`)
      .orderBy(desc(sql`count(distinct a.user_key)`))
      .limit(6000);

    for (const row of rows) {
      let inner = pairs.get(String(row.a));
      if (!inner) {
        inner = new Map();
        pairs.set(String(row.a), inner);
      }
      inner.set(String(row.b), Number(row.n) || 0);
    }
  } catch {
    /* no co-watch data → content similarity still works */
  }
  return pairs;
}

/** Bounded content-similarity index over the mirrored candidate pool. */
function contentSimilarity(rows: CandidateRow[]): Map<string, Map<string, number>> {
  const out: Map<string, Map<string, number>> = new Map();
  const inverted = new Map<string, number[]>();

  const features = rows.map((row) => {
    const tagTokens = tokenize(row.tags.join(" "));
    const titleTokens = tokenize(row.title);
    const category = (row.category || "").toLowerCase();
    for (const token of new Set(tagTokens)) {
      const list = inverted.get(token) ?? [];
      list.push(rows.indexOf(row));
      inverted.set(token, list);
    }
    return { row, tagTokens: new Set(tagTokens), titleTokens: new Set(titleTokens), category };
  });

  // Only pairs that share at least one tag token are scored — O(shared), not
  // O(n²) over the whole library.
  const pairScore = new Map<string, number>();
  for (const tokenList of inverted.values()) {
    if (tokenList.length < 2 || tokenList.length > 60) continue;
    for (let i = 0; i < tokenList.length; i += 1) {
      for (let j = i + 1; j < tokenList.length; j += 1) {
        const a = features[tokenList[i]];
        const b = features[tokenList[j]];
        if (!a || !b || a.row.isShort !== b.row.isShort) continue;
        let tagOverlap = 0;
        for (const t of a.tagTokens) if (b.tagTokens.has(t)) tagOverlap += 1;
        let titleOverlap = 0;
        for (const t of a.titleTokens) if (b.titleTokens.has(t)) titleOverlap += 1;
        const tagSim =
          a.tagTokens.size + b.tagTokens.size > 0
            ? tagOverlap / ((a.tagTokens.size + b.tagTokens.size) / 2)
            : 0;
        const titleSim =
          a.titleTokens.size + b.titleTokens.size > 0
            ? titleOverlap / ((a.titleTokens.size + b.titleTokens.size) / 2)
            : 0;
        const catSim = a.category && a.category === b.category ? 1 : 0;
        const creatorSim = a.row.channelId && a.row.channelId === b.row.channelId ? 0.6 : 0;
        const score =
          CF.contentMix.tags * tagSim +
          CF.contentMix.title * titleSim +
          CF.contentMix.category * catSim +
          creatorSim * 0.15;
        if (score <= 0.02) continue;
        const key = `${a.row.id}\u0000${b.row.id}`;
        pairScore.set(key, Math.max(pairScore.get(key) ?? 0, score));
      }
    }
  }

  for (const [key, score] of pairScore) {
    const [a, b] = key.split("\u0000");
    let inner = out.get(a);
    if (!inner) {
      inner = new Map();
      out.set(a, inner);
    }
    inner.set(b, score);
    let reverse = out.get(b);
    if (!reverse) {
      reverse = new Map();
      out.set(b, reverse);
    }
    reverse.set(a, score);
  }
  return out;
}

let aggregating: Promise<void> | null = null;

/**
 * Rebuilds `item_similarity` by blending co-watch evidence with content
 * similarity. Runs at most once per TTL and never blocks a feed request.
 */
export async function refreshItemSimilarity(): Promise<void> {
  if (!isDatabaseConfigured) return;
  if ((await scopeAge("similarity")) < CF.similarityTtlMs) return;
  if (aggregating) return;

  aggregating = (async () => {
    try {
      const [coWatch, rows] = await Promise.all([
        loadCoWatchPairs(),
        db
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
          .where(eq(videosCache.visible, true))
          .orderBy(desc(videosCache.views))
          .limit(600),
      ]);

      const candidates: CandidateRow[] = rows.map((row) => ({
        ...row,
        tags: Array.isArray(row.tags) ? row.tags : [],
        raw: (row.raw ?? {}) as Record<string, unknown>,
        subscribers: 0,
      }));

      const content = contentSimilarity(candidates);
      const maxCoWatch = Math.max(
        1,
        ...Array.from(coWatch.values(), (inner) => Math.max(1, ...inner.values()))
      );

      const blended = new Map<string, Map<string, number>>();
      const addEdge = (a: string, b: string, score: number) => {
        let inner = blended.get(a);
        if (!inner) {
          inner = new Map();
          blended.set(a, inner);
        }
        inner.set(b, Math.max(inner.get(b) ?? 0, Math.min(1, score)));
      };

      for (const [a, inner] of coWatch) {
        for (const [b, n] of inner) addEdge(a, b, CF.blend.coWatch * (n / maxCoWatch) + 0.05);
      }
      for (const [a, inner] of content) {
        for (const [b, score] of inner) {
          const existing = blended.get(a)?.get(b) ?? 0;
          addEdge(a, b, existing + CF.blend.content * score);
        }
      }

      // Keep only the strongest CF.topPerVideo edges per video.
      const payload: Array<{
        videoA: string;
        videoB: string;
        score: number;
        coWatchers: number;
        kind: string;
      }> = [];
      for (const [a, inner] of blended) {
        const top = [...inner.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, CF.topPerVideo);
        for (const [b, score] of top) {
          payload.push({
            videoA: a.slice(0, 64),
            videoB: b.slice(0, 64),
            score: Number(score.toFixed(5)),
            coWatchers: coWatch.get(a)?.get(b) ?? 0,
            kind: "blended",
          });
        }
      }

      const chunk = 200;
      for (let i = 0; i < payload.length; i += chunk) {
        await db
          .insert(itemSimilarity)
          .values(payload.slice(i, i + chunk))
          .onConflictDoUpdate({
            target: [itemSimilarity.videoA, itemSimilarity.videoB],
            set: {
              score: sql`excluded.score`,
              coWatchers: sql`excluded.co_watchers`,
              kind: sql`excluded.kind`,
              computedAt: sql`now()`,
            },
          });
      }
      await markScope("similarity", payload.length);
    } catch {
      /* similarity is an enhancement; ranking degrades gracefully */
    } finally {
      aggregating = null;
    }
  })();

  await aggregating;
}

/** Fire-and-forget refresh, safe to call from a request handler. */
export function refreshAggregatesInBackground(): void {
  if (!isDatabaseConfigured) return;
  void refreshVideoStats().catch(() => undefined);
  void refreshItemSimilarity().catch(() => undefined);
}

/* ─────────────────────────── rank-time reads ──────────────────────────── */

/** Stored similarity edges for the given videos. */
export async function loadSimilarityFor(videoIds: string[]): Promise<SimilarityMap> {
  const map: SimilarityMap = new Map();
  if (!isDatabaseConfigured || !videoIds.length) return map;
  try {
    const rows = await db
      .select({
        a: itemSimilarity.videoA,
        b: itemSimilarity.videoB,
        score: itemSimilarity.score,
      })
      .from(itemSimilarity)
      .where(inArray(itemSimilarity.videoA, videoIds.slice(0, 400)));
    for (const row of rows) {
      let inner = map.get(row.a);
      if (!inner) {
        inner = new Map();
        map.set(row.a, inner);
      }
      inner.set(row.b, Number(row.score) || 0);
    }
  } catch {
    /* no similarity edges → the component simply contributes 0 */
  }
  return map;
}

/**
 * Similar-user score (#8). Two complementary evidence sources, blended:
 *
 *  1. item-based CF — videos similar to what this viewer already enjoyed
 *     (from the precomputed edges), and
 *  2. a bounded user neighbourhood — other viewers who watched the same videos
 *     as this viewer, and what ELSE they watched ("users with similar
 *     interests also watched this").
 *
 * Both reads are indexed and capped, so this stays cheap at request time.
 */
export async function similarUserScores(
  profile: ViewerProfile,
  pool: CandidateRow[]
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (profile.coldStart || !pool.length) return scores;

  const poolIds = new Set(pool.map((c) => c.id));

  // (1) item-based CF over the viewer's positively-watched videos.
  const enjoyed = [...profile.watched.entries()]
    .filter(([, w]) => w.watchPct >= 0.3 || w.completed)
    .sort((a, b) => b[1].watchPct * b[1].count - a[1].watchPct * a[1].count)
    .slice(0, 30)
    .map(([id]) => id);

  if (enjoyed.length && isDatabaseConfigured) {
    const edges = await loadSimilarityFor(enjoyed);
    for (const seed of enjoyed) {
      const inner = edges.get(seed);
      if (!inner) continue;
      const seedWeight = profile.watched.get(seed)?.watchPct ?? 0.5;
      for (const [other, sim] of inner) {
        if (!poolIds.has(other) || enjoyed.includes(other)) continue;
        scores.set(other, (scores.get(other) ?? 0) + sim * seedWeight * 0.6);
      }
    }
  }

  // (2) bounded user neighbourhood — genuine collaborative filtering.
  if (enjoyed.length && isDatabaseConfigured) {
    try {
      const neighbours = await db
        .select({
          userKey: watchEvents.userKey,
          n: sql<number>`count(*)::int`,
        })
        .from(watchEvents)
        .where(
          and(
            inArray(watchEvents.videoId, enjoyed.slice(0, 20)),
            ne(watchEvents.userKey, profile.userKey),
            sql`${watchEvents.watchPct} >= 0.3`
          )
        )
        .groupBy(watchEvents.userKey)
        .orderBy(desc(sql`count(*)`))
        .limit(CF.maxNeighbours);

      const neighbourKeys = neighbours.map((n) => n.userKey);
      const overlap = new Map(neighbours.map((n) => [n.userKey, Number(n.n) || 1]));

      if (neighbourKeys.length) {
        const since = new Date(Date.now() - 30 * 24 * 3600_000);
        const watchedByNeighbours = await db
          .select({
            userKey: watchEvents.userKey,
            videoId: watchEvents.videoId,
            watchPct: watchEvents.watchPct,
          })
          .from(watchEvents)
          .where(
            and(
              inArray(watchEvents.userKey, neighbourKeys),
              gte(watchEvents.createdAt, since),
              sql`${watchEvents.watchPct} >= 0.4`
            )
          )
          .orderBy(desc(watchEvents.createdAt))
          .limit(2000);

        for (const row of watchedByNeighbours) {
          if (!poolIds.has(row.videoId)) continue;
          if (profile.watched.has(row.videoId)) continue;
          const affinity = (overlap.get(row.userKey) ?? 1) / Math.max(1, enjoyed.length);
          scores.set(
            row.videoId,
            (scores.get(row.videoId) ?? 0) + 0.4 * affinity * (0.5 + row.watchPct / 2)
          );
        }
      }
    } catch {
      /* neighbourhood unavailable → item-based CF alone still applies */
    }
  }

  // Normalise to 0..1 so the weight in config.ts is directly meaningful.
  const max = Math.max(...scores.values(), 0.0001);
  for (const [id, value] of scores) scores.set(id, Math.min(1, value / max));
  return scores;
}

/**
 * Video→video score for a specific anchor video (#9) — related / up-next.
 * Uses the precomputed edges first and falls back to on-the-fly content
 * similarity for a small pool, so a brand-new video still gets related items.
 */
export async function similarVideoScores(
  anchorId: string,
  pool: CandidateRow[]
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!anchorId || !pool.length) return scores;

  const anchor = pool.find((c) => c.id === anchorId);
  const stored = isDatabaseConfigured ? await loadSimilarityFor([anchorId]) : new Map();
  const edges = stored.get(anchorId);
  if (edges) {
    for (const [id, score] of edges) scores.set(id, score);
  }

  if (anchor) {
    const content = contentSimilarity([anchor, ...pool.filter((c) => c.id !== anchorId).slice(0, 200)]);
    const inner = content.get(anchorId);
    if (inner) {
      for (const [id, score] of inner) {
        scores.set(id, Math.max(scores.get(id) ?? 0, score));
      }
    }
  }

  const max = Math.max(...scores.values(), 0.0001);
  for (const [id, value] of scores) scores.set(id, Math.min(1, value / max));
  return scores;
}

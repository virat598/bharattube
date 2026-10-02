import { db, isDatabaseConfigured } from "@/db";
import { watchEvents, interactionEvents, searchEvents } from "@/db/schema";
import { and, desc, eq, gte, sql, inArray } from "drizzle-orm";
import {
  ALREADY_WATCHED,
  ENGAGEMENT,
  EXPLORATION,
  FRESHNESS_FLOOR,
  FRESHNESS_HALF_LIFE_HOURS,
  SHORTS_COMPLETED_PENALTY,
  SHORTS_FRESHNESS_HALF_LIFE_HOURS,
  SHORTS_SWIPE_AWAY_PCT,
  SHORTS_SWIPE_AWAY_PENALTY,
  SUBSCRIPTION_BOOST,
  VELOCITY_WINDOW_HOURS,
} from "./config";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Signal extraction and scoring. SERVER ONLY.
 * ─────────────────────────────────────────────────────────────────────────
 * Every candidate gets independent 0..1 component scores. The pipeline in
 * service.ts blends them with the configurable weights from config.ts.
 */

export interface CandidateRow {
  id: string;
  title: string;
  description: string;
  category: string;
  language: string;
  tags: string[];
  channelId: string;
  durationSec: number;
  isShort: boolean;
  views: number;
  likesCount: number;
  dislikesCount: number;
  commentsCount: number;
  shares: number;
  raw: Record<string, unknown>;
  sourceCreatedAt: Date | null;
  subscribers: number;
}

export interface WatchedItem {
  watchPct: number;
  count: number;
  completed: boolean;
  lastAt: Date;
}

export interface ViewerProfile {
  userKey: string;
  coldStart: boolean;
  /** category / tag token → affinity */
  topicAffinity: Map<string, number>;
  /** free-text token from titles, tags and searches → affinity */
  tokenAffinity: Map<string, number>;
  /** channelId → affinity */
  creatorAffinity: Map<string, number>;
  languageAffinity: Map<string, number>;
  /** share of the viewer's watch time spent on Shorts */
  shortAffinity: number;
  watched: Map<string, WatchedItem>;
  subscriptions: Set<string>;
  observedEvents: number;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","of","in","on","to","for","with","is","are","was","were","be",
  "this","that","it","as","at","by","from","up","about","into","over","after","you","your",
  "के","का","की","में","से","और","है","को","पर","एक","यह","क्या","कैसे","क्यों","नहीं",
  "shorts","short","video","videos","full","episode","part","latest","new","best","top",
  "hd","official","song","songs","live","watch","how","why","what",
]);

export function tokenize(input: string): string[] {
  return String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function addAffinity(map: Map<string, number>, key: string, amount: number): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** How strongly each interaction kind expresses interest (point 2/24). */
const KIND_WEIGHT: Record<string, number> = {
  like: 1,
  dislike: -1,
  comment: 0.8,
  share: 1.2,
  subscribe: 1.5,
  unsubscribe: -1.5,
  rewatch: 0.9,
  skip: -0.6,
};

/**
 * Builds the viewer's interest model from THEIR OWN watch, engagement and
 * search events. A viewer with no history yields `coldStart: true`, and the
 * pipeline falls back to global quality + freshness + diversity (#12).
 */
export async function buildViewerProfile(
  userKey: string,
  pool: CandidateRow[]
): Promise<ViewerProfile> {
  const profile: ViewerProfile = {
    userKey,
    coldStart: true,
    topicAffinity: new Map(),
    tokenAffinity: new Map(),
    creatorAffinity: new Map(),
    languageAffinity: new Map(),
    shortAffinity: 0.5,
    watched: new Map(),
    subscriptions: new Set(),
    observedEvents: 0,
  };
  if (!userKey || !pool.length) return profile;

  const byId = new Map(pool.map((c) => [c.id, c]));
  let observed = 0;
  let shortSeconds = 0;
  let longSeconds = 0;

  try {
    const watches = await db
      .select({
        videoId: watchEvents.videoId,
        watchPct: watchEvents.watchPct,
        watchSeconds: watchEvents.watchSeconds,
        completed: watchEvents.completed,
        createdAt: watchEvents.createdAt,
      })
      .from(watchEvents)
      .where(eq(watchEvents.userKey, userKey))
      .orderBy(desc(watchEvents.createdAt))
      .limit(500);

    for (const w of watches) {
      const meta = byId.get(w.videoId);
      const seconds = Number(w.watchSeconds) || 0;
      if (meta?.isShort) shortSeconds += seconds;
      else longSeconds += seconds;

      const existing = profile.watched.get(w.videoId);
      if (existing) {
        existing.watchPct = Math.max(existing.watchPct, Number(w.watchPct) || 0);
        existing.count += 1;
        existing.completed = existing.completed || Boolean(w.completed);
        if (w.createdAt > existing.lastAt) existing.lastAt = w.createdAt;
      } else {
        profile.watched.set(w.videoId, {
          watchPct: Number(w.watchPct) || 0,
          count: 1,
          completed: Boolean(w.completed),
          lastAt: w.createdAt,
        });
      }
    }
    observed += watches.length;

    // Recent, completed watches carry the most intent; decayed recency.
    watches.slice(0, 150).forEach((w, i) => {
      const meta = byId.get(w.videoId);
      if (!meta) return;
      const weight = (1 / (1 + i / 40)) * (0.35 + 0.65 * (Number(w.watchPct) || 0));
      addAffinity(profile.creatorAffinity, meta.channelId, weight);
      if (meta.category) addAffinity(profile.topicAffinity, meta.category.toLowerCase(), weight);
      for (const tag of tokenize(meta.tags.join(" "))) {
        addAffinity(profile.tokenAffinity, tag, weight * 0.8);
      }
      for (const token of tokenize(meta.title)) {
        addAffinity(profile.tokenAffinity, token, weight * 0.5);
      }
      if (meta.language) addAffinity(profile.languageAffinity, meta.language.toLowerCase(), weight);
    });

    const interactions = await db
      .select({
        targetId: interactionEvents.targetId,
        kind: interactionEvents.kind,
        weight: interactionEvents.weight,
      })
      .from(interactionEvents)
      .where(eq(interactionEvents.userKey, userKey))
      .orderBy(desc(interactionEvents.createdAt))
      .limit(400);

    for (const ev of interactions) {
      if (ev.kind === "subscribe" || ev.kind === "unsubscribe") {
        if (ev.kind === "subscribe") profile.subscriptions.add(ev.targetId);
        continue;
      }
      const meta = byId.get(ev.targetId);
      if (!meta) continue;
      const base = (KIND_WEIGHT[ev.kind] ?? 0.3) * (Number(ev.weight) || 1);
      addAffinity(profile.creatorAffinity, meta.channelId, base);
      if (meta.category) addAffinity(profile.topicAffinity, meta.category.toLowerCase(), base);
      for (const token of tokenize(`${meta.title} ${meta.tags.join(" ")}`)) {
        addAffinity(profile.tokenAffinity, token, base * 0.7);
      }
      if (meta.language) addAffinity(profile.languageAffinity, meta.language.toLowerCase(), base);
      observed += 1;
    }

    const searches = await db
      .select({ query: searchEvents.query })
      .from(searchEvents)
      .where(eq(searchEvents.userKey, userKey))
      .orderBy(desc(searchEvents.createdAt))
      .limit(120);

    searches.forEach((s, i) => {
      const weight = 0.4 / (1 + i / 25);
      for (const token of tokenize(s.query)) {
        addAffinity(profile.tokenAffinity, token, weight);
      }
    });
    observed += searches.length;
  } catch {
    // Signal-read failure degrades to cold start; the feed still renders (#26).
  }

  profile.observedEvents = observed;
  profile.coldStart = observed < 3;

  const total = shortSeconds + longSeconds;
  if (total > 0) profile.shortAffinity = shortSeconds / total;

  return profile;
}

/** Gentle normalization: scale by the pool maximum instead of min-max. */
function normalize(values: number[]): number[] {
  const max = Math.max(...values, 0.000001);
  return values.map((v) => Math.max(0, Math.min(1, v / max)));
}

function maxAffinity(map: Map<string, number>, keys: string[]): number {
  let best = 0;
  for (const key of keys) {
    if (!key) continue;
    best = Math.max(best, map.get(key.toLowerCase()) ?? 0);
  }
  return best;
}

/** Title/description/tag relevance against the viewer's interest tokens (#2). */
function textRelevance(c: CandidateRow, tokens: Map<string, number>): number {
  const bag = tokenize(`${c.title} ${c.category} ${c.tags.join(" ")}`);
  if (!bag.length) return 0;
  let hit = 0;
  for (const token of bag) {
    const affinity = tokens.get(token) ?? 0;
    if (affinity > 0) hit += Math.min(affinity, 3);
  }
  return Math.min(1, hit / (bag.length * 0.9));
}

/** Point 6 — exponential decay with a configurable half-life. */
export function freshnessScore(ageHours: number, halfLife: number): number {
  const safeAge = ageHours < 0 ? 0 : ageHours;
  return Math.max(FRESHNESS_FLOOR, Math.exp(-safeAge / halfLife));
}

/**
 * Point 7 — engagement QUALITY, not raw counts. Rates are smoothed by a views
 * prior and dampened by lifetime scale, so 10/100 can outrank 1000/1000000.
 */
export function engagementQuality(c: CandidateRow): number {
  const views = Math.max(c.views, 0) + ENGAGEMENT.smoothingViews;
  const likeRate = c.likesCount / views;
  const commentRate = c.commentsCount / views;
  const shareRate = c.shares / views;
  const dislikeRate = c.dislikesCount / views;
  const scaleDampening = Math.log1p(Math.max(c.views, 0)) / Math.log1p(Math.max(c.views, 0) + ENGAGEMENT.logViewDampening * 100);
  const positive =
    likeRate * ENGAGEMENT.likeRateWeight +
    commentRate * ENGAGEMENT.commentRateWeight +
    shareRate * ENGAGEMENT.shareRateWeight;
  const score = positive * (1 - scaleDampening * 0.35) - dislikeRate * ENGAGEMENT.dislikeRateWeight * 12;
  return Math.max(0, Math.min(1, score * 8));
}

export interface ScoredCandidate {
  candidate: CandidateRow;
  components: {
    personalization: number;
    watchBehavior: number;
    retention: number;
    engagementQuality: number;
    freshness: number;
    subscription: number;
    recentVelocity: number;
    exploration: number;
  };
  score: number;
  seenState: "unseen" | "partial" | "completed";
}

export interface ScoreContext {
  surface: "home" | "shorts";
  /** Observed retention per video id (avg watch %, sample count). */
  retention: Map<string, { avg: number; n: number; completed: number }>;
  /** Global average retention, used as the shrinkage prior. */
  globalRetention: number;
  /** Recent interaction counts per video id (#8 velocity). */
  velocity: Map<string, number>;
}

/**
 * Point 20 steps 4–8 and point 21. Blends every component with the configured
 * weights. `surface` selects the separate Shorts model (#17).
 */
export function scoreCandidates(
  pool: CandidateRow[],
  profile: ViewerProfile,
  ctx: ScoreContext,
  weights: {
    personalization: number;
    watchBehavior: number;
    retention: number;
    rewatch: number;
    engagementQuality: number;
    freshness: number;
    subscription: number;
    recentVelocity: number;
    exploration: number;
  },
  halfLifeHours: number
): ScoredCandidate[] {
  const now = Date.now();

  const personalRaw: number[] = [];
  const watchRaw: number[] = [];
  const engagementRaw: number[] = [];
  const velocityRaw: number[] = [];
  const retRaw: number[] = [];

  const pre = pool.map((c) => {
    // ── personalization (#2/#3/#5) ────────────────────────────────────────
    const topicAff = maxAffinity(profile.topicAffinity, [
      c.category,
      ...c.tags.map((t) => t.toLowerCase()),
    ]);
    const topic = Math.min(1, topicAff / 3);
    const text = textRelevance(c, profile.tokenAffinity);
    const creator = Math.min(1, (profile.creatorAffinity.get(c.channelId) ?? 0) / 3);
    const lang = c.language
      ? Math.min(1, (profile.languageAffinity.get(c.language.toLowerCase()) ?? 0) / 2)
      : 0.35;
    const format = 1 - Math.abs(profile.shortAffinity - (c.isShort ? 1 : 0));
    const personal = 0.34 * topic + 0.3 * text + 0.18 * creator + 0.1 * lang + 0.08 * format;

    // ── watch behaviour (#4): this video → this creator → this topic ──────
    const seen = profile.watched.get(c.id);
    const watchBehavior = seen
      ? Math.min(1, seen.watchPct * 0.7 + Math.min(seen.count - 1, 3) * 0.1)
      : creator > 0
      ? Math.min(1, creator * 0.7)
      : Math.min(1, topic * 0.6);

    const engagement = engagementQuality(c);

    // ── retention (#4/#7): observed, shrunk toward the global prior ───────
    const observedRetention = ctx.retention.get(c.id);
    const prior = ctx.globalRetention > 0 ? ctx.globalRetention : 0.4;
    const shrink = ENGAGEMENT.smoothingViews / (ENGAGEMENT.smoothingViews + (observedRetention?.n ?? 0));
    const retention =
      observedRetention && observedRetention.n > 0
        ? observedRetention.avg * (1 - shrink) + prior * shrink
        : prior * 0.8;

    // ── velocity (#8): recent genuine activity over lifetime scale ────────
    const recent = ctx.velocity.get(c.id) ?? 0;
    const velocity = recent / (1 + Math.log1p(Math.max(c.views, 0)) / 4);

    personalRaw.push(personal);
    watchRaw.push(watchBehavior);
    engagementRaw.push(engagement);
    velocityRaw.push(velocity);
    retRaw.push(retention);

    return { candidate: c, seen, personal, watchBehavior, engagement, retention, velocity };
  });

  const nPersonal = normalize(personalRaw);
  const nWatch = normalize(watchRaw);
  const nEngagement = normalize(engagementRaw);
  const nVelocity = normalize(velocityRaw);
  const nRetention = normalize(retRaw);

  return pre.map((item, i) => {
    const c = item.candidate;
    const ageHours = c.sourceCreatedAt
      ? (now - new Date(c.sourceCreatedAt).getTime()) / 3600000
      : 24 * 365;
    const freshness = freshnessScore(ageHours, halfLifeHours);
    const subscription = profile.subscriptions.has(c.channelId) ? SUBSCRIPTION_BOOST : 0;

    // ── exploration (#11/#19): low-data + small-creator uncertainty bonus ──
    const lowData = c.views < EXPLORATION.lowDataViews;
    const smallCreator = c.subscribers > 0 && c.subscribers < EXPLORATION.smallCreatorViews;
    // Deterministic per (viewer, video) and refreshed every 6h, so the order
    // is stable across re-renders yet still refreshable (#23).
    const salt = Math.floor(now / (6 * 3600 * 1000));
    let hash = 0;
    const key = `${profile.userKey}:${c.id}:${salt}`;
    for (let k = 0; k < key.length; k += 1) hash = (hash * 31 + key.charCodeAt(k)) % 100000;
    const jitter = (hash / 100000) * EXPLORATION.jitterAmplitude;
    const exploration = Math.min(1, (lowData ? 0.55 : 0) + (smallCreator ? 0.25 : 0) + jitter);

    // ── already-watched adjustment (#14): demote, never ban ────────────────
    const seen = item.seen;
    let seenState: ScoredCandidate["seenState"] = "unseen";
    let watchedPenalty = 1;
    if (seen) {
      if (seen.completed || seen.watchPct >= 0.9) {
        seenState = "completed";
        watchedPenalty =
          ctx.surface === "shorts" ? SHORTS_COMPLETED_PENALTY : ALREADY_WATCHED.completedPenalty;
      } else if (seen.watchPct >= ALREADY_WATCHED.trivialThreshold) {
        seenState = "partial";
        watchedPenalty = ALREADY_WATCHED.partialPenalty;
      }
    }

    // ── Shorts: an immediate swipe-away is an explicit negative (#17) ──────
    let swipePenalty = 1;
    if (
      ctx.surface === "shorts" &&
      seen &&
      seen.watchPct > 0 &&
      seen.watchPct < SHORTS_SWIPE_AWAY_PCT &&
      !seen.completed
    ) {
      swipePenalty = SHORTS_SWIPE_AWAY_PENALTY;
    }

    const components = {
      personalization: nPersonal[i],
      watchBehavior: nWatch[i],
      retention: nRetention[i],
      engagementQuality: nEngagement[i],
      freshness,
      subscription,
      recentVelocity: nVelocity[i],
      exploration,
    };

    let score =
      weights.personalization * components.personalization +
      weights.watchBehavior * components.watchBehavior +
      weights.retention * components.retention +
      weights.rewatch * components.watchBehavior +
      weights.engagementQuality * components.engagementQuality +
      weights.freshness * components.freshness +
      weights.subscription * components.subscription +
      weights.recentVelocity * components.recentVelocity +
      weights.exploration * components.exploration;

    score *= watchedPenalty * swipePenalty;

    return { candidate: c, components, score, seenState };
  });
}

/** Recent genuine activity per video, used by the velocity component (#8). */
export async function recentInteractionCounts(videoIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!isDatabaseConfigured || !videoIds.length) return counts;
  const cutoff = new Date(Date.now() - VELOCITY_WINDOW_HOURS * 3600 * 1000);
  try {
    const rows = await db
      .select({ videoId: watchEvents.videoId, n: sql<number>`count(*)::int` })
      .from(watchEvents)
      .where(and(inArray(watchEvents.videoId, videoIds), gte(watchEvents.createdAt, cutoff)))
      .groupBy(watchEvents.videoId);
    for (const row of rows) counts.set(row.videoId, Number(row.n) || 0);
  } catch {
    /* velocity falls back to lifetime signals */
  }
  return counts;
}

/** Observed retention per video (#4): avg watch %, samples and completions. */
export async function retentionByVideo(
  videoIds: string[]
): Promise<Map<string, { avg: number; n: number; completed: number }>> {
  const map = new Map<string, { avg: number; n: number; completed: number }>();
  if (!videoIds.length) return map;
  try {
    const rows = await db
      .select({
        videoId: watchEvents.videoId,
        avgPct: sql<number>`avg(${watchEvents.watchPct})::float`,
        n: sql<number>`count(*)::int`,
        completed: sql<number>`sum(case when ${watchEvents.completed} then 1 else 0 end)::int`,
      })
      .from(watchEvents)
      .where(inArray(watchEvents.videoId, videoIds))
      .groupBy(watchEvents.videoId);
    for (const row of rows) {
      map.set(row.videoId, {
        avg: Number(row.avgPct) || 0,
        n: Number(row.n) || 0,
        completed: Number(row.completed) || 0,
      });
    }
  } catch {
    /* empty map → the global prior is used */
  }
  return map;
}

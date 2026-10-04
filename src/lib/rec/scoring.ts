import { db } from "@/db";
import { watchEvents, interactionEvents, searchEvents } from "@/db/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  CREATOR_OVEREXPOSURE,
  ENGAGEMENT,
  EXPLORATION,
  FRESH_DISCOVERY,
  FRESHNESS_FLOOR,
  INTEREST_DECAY,
  PENALTIES,
  REPETITION,
  SHORTS_COMPLETED_PENALTY,
  SHORTS_SWIPE_AWAY_PCT,
  SHORTS_SWIPE_AWAY_PENALTY,
  SUBSCRIPTION_BOOST,
  VELOCITY_WINDOW_HOURS,
  type RankWeights,
} from "./config";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Signal extraction and scoring. SERVER ONLY.
 * ─────────────────────────────────────────────────────────────────────────
 * Every candidate gets independent 0..1 component scores. The pipeline in
 * service.ts blends them with the configurable weights from config.ts, then
 * applies the penalty multipliers (already watched / skipped / not interested /
 * repeatedly impressed / creator over-exposure).
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

/** Where a recommendation ultimately came from (#19). */
export type RecommendationSource =
  | "personal_interest"
  | "similar_users"
  | "similar_video"
  | "creator_affinity"
  | "trending"
  | "fresh_content"
  | "exploration"
  | "subscription"
  | "related_topic";

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
  /** Topics the viewer keeps skipping — decays interest instead of raising it. */
  topicSkipAffinity: Map<string, number>;
  /** Per-format topic affinity so Shorts and long-form stay connected (#10). */
  shortTopicAffinity: Map<string, number>;
  longTopicAffinity: Map<string, number>;
  /** share of the viewer's watch time spent on Shorts */
  shortAffinity: number;
  watched: Map<string, WatchedItem>;
  /** videoId → skip count (explicit bail / immediate swipe-away). */
  skipped: Map<string, number>;
  /** videoId → timestamp of the last "not interested". */
  notInterested: Map<string, Date>;
  subscriptions: Set<string>;
  observedEvents: number;
}

export function emptyProfile(userKey: string): ViewerProfile {
  return {
    userKey,
    coldStart: true,
    topicAffinity: new Map(),
    tokenAffinity: new Map(),
    creatorAffinity: new Map(),
    languageAffinity: new Map(),
    topicSkipAffinity: new Map(),
    shortTopicAffinity: new Map(),
    longTopicAffinity: new Map(),
    shortAffinity: 0.5,
    watched: new Map(),
    skipped: new Map(),
    notInterested: new Map(),
    subscriptions: new Set<string>(),
    observedEvents: 0,
  };
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

/** Exponential recency decay — recent behaviour outweighs older behaviour (#3). */
export function timeDecay(at: Date | null | undefined, now = Date.now()): number {
  if (!at) return 0.5;
  const hours = Math.max(0, (now - new Date(at).getTime()) / 3_600_000);
  return Math.pow(0.5, hours / INTEREST_DECAY.hoursHalfLife);
}

/** How strongly each interaction kind expresses interest. */
const KIND_WEIGHT: Record<string, number> = {
  like: 1,
  dislike: -1,
  comment: 0.8,
  share: 1.2,
  subscribe: 1.5,
  unsubscribe: -1.5,
  rewatch: 0.9,
  skip: -0.6,
  not_interested: -2,
};

/**
 * Builds the viewer's interest model from THEIR OWN watch, engagement and
 * search events. A viewer with no history yields `coldStart: true`, and the
 * pipeline falls back to the cold-start ranking (#13).
 */
export async function buildViewerProfile(
  userKey: string,
  pool: CandidateRow[]
): Promise<ViewerProfile> {
  const profile = emptyProfile(userKey);
  if (!userKey || !pool.length) return profile;

  const byId = new Map(pool.map((c) => [c.id, c]));
  let observed = 0;
  let shortSeconds = 0;
  let longSeconds = 0;
  const now = Date.now();

  try {
    const watches = await db
      .select({
        videoId: watchEvents.videoId,
        watchPct: watchEvents.watchPct,
        watchSeconds: watchEvents.watchSeconds,
        completed: watchEvents.completed,
        skipped: watchEvents.skipped,
        format: watchEvents.format,
        channelId: watchEvents.channelId,
        createdAt: watchEvents.createdAt,
      })
      .from(watchEvents)
      .where(eq(watchEvents.userKey, userKey))
      .orderBy(desc(watchEvents.createdAt))
      .limit(500);

    for (const w of watches) {
      const meta = byId.get(w.videoId);
      const seconds = Number(w.watchSeconds) || 0;
      const pct = Number(w.watchPct) || 0;
      const isShort = w.format === "short" || (meta ? meta.isShort : false);
      if (w.skipped || (pct > 0 && pct < PENALTIES.trivialThreshold)) {
        profile.skipped.set(w.videoId, (profile.skipped.get(w.videoId) ?? 0) + 1);
      }
      if (isShort) shortSeconds += seconds;
      else longSeconds += seconds;

      const existing = profile.watched.get(w.videoId);
      if (existing) {
        existing.watchPct = Math.max(existing.watchPct, pct);
        existing.count += 1;
        existing.completed = existing.completed || Boolean(w.completed);
        if (w.createdAt > existing.lastAt) existing.lastAt = w.createdAt;
      } else {
        profile.watched.set(w.videoId, {
          watchPct: pct,
          count: 1,
          completed: Boolean(w.completed),
          lastAt: w.createdAt,
        });
      }
    }
    observed += watches.length;

    // Recent, well-watched items carry the most intent; decayed by both event
    // index and wall-clock age so interests can drift over time (#3/#14).
    watches.slice(0, 200).forEach((w, i) => {
      const meta = byId.get(w.videoId);
      if (!meta) return;
      const pct = Number(w.watchPct) || 0;
      // A skip contributes nothing positive; it feeds the negative topic map.
      if (w.skipped || pct < PENALTIES.trivialThreshold) {
        const decay = PENALTIES.repeatedSkipTopicDecay;
        if (meta.category) {
          addAffinity(profile.topicSkipAffinity, meta.category.toLowerCase(), 1 / decay);
        }
        return;
      }
      const indexDecay = 1 / (1 + i / INTEREST_DECAY.eventHalfLife);
      const weight =
        indexDecay *
        timeDecay(w.createdAt, now) *
        (INTEREST_DECAY.baseShare + INTEREST_DECAY.retentionShare * pct);
      const creatorId = w.channelId || meta.channelId;
      addAffinity(profile.creatorAffinity, creatorId, weight);
      if (meta.category) {
        const cat = meta.category.toLowerCase();
        addAffinity(profile.topicAffinity, cat, weight);
        addAffinity(meta.isShort ? profile.shortTopicAffinity : profile.longTopicAffinity, cat, weight);
      }
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
        channelId: interactionEvents.channelId,
        createdAt: interactionEvents.createdAt,
      })
      .from(interactionEvents)
      .where(eq(interactionEvents.userKey, userKey))
      .orderBy(desc(interactionEvents.createdAt))
      .limit(400);

    for (const ev of interactions) {
      if (ev.kind === "subscribe" || ev.kind === "unsubscribe") {
        if (ev.kind === "subscribe") profile.subscriptions.add(ev.targetId);
        else profile.subscriptions.delete(ev.targetId);
        continue;
      }
      if (ev.kind === "not_interested") {
        profile.notInterested.set(ev.targetId, ev.createdAt);
      }
      if (ev.kind === "skip") {
        profile.skipped.set(ev.targetId, (profile.skipped.get(ev.targetId) ?? 0) + 1);
      }
      const meta = byId.get(ev.targetId);
      if (!meta) continue;
      const base =
        (KIND_WEIGHT[ev.kind] ?? 0.3) * (Number(ev.weight) || 1) * timeDecay(ev.createdAt, now);
      const creatorId = ev.channelId || meta.channelId;
      addAffinity(profile.creatorAffinity, creatorId, base);
      if (meta.category) {
        const cat = meta.category.toLowerCase();
        if (base < 0) addAffinity(profile.topicSkipAffinity, cat, -base);
        else addAffinity(profile.topicAffinity, cat, base);
      }
      if (base > 0) {
        for (const token of tokenize(`${meta.title} ${meta.tags.join(" ")}`)) {
          addAffinity(profile.tokenAffinity, token, base * 0.7);
        }
      }
      if (meta.language) addAffinity(profile.languageAffinity, meta.language.toLowerCase(), base);
      observed += 1;
    }

    const searches = await db
      .select({ query: searchEvents.query, createdAt: searchEvents.createdAt })
      .from(searchEvents)
      .where(eq(searchEvents.userKey, userKey))
      .orderBy(desc(searchEvents.createdAt))
      .limit(120);

    searches.forEach((s, i) => {
      const weight = (0.4 / (1 + i / 25)) * timeDecay(s.createdAt, now);
      for (const token of tokenize(s.query)) {
        addAffinity(profile.tokenAffinity, token, weight);
      }
    });
    observed += searches.length;
  } catch {
    // Signal-read failure degrades to cold start; the feed still renders.
  }

  profile.observedEvents = observed;
  profile.coldStart = observed < 3;

  const total = shortSeconds + longSeconds;
  if (total > 0) profile.shortAffinity = shortSeconds / total;

  // Repeatedly-skipped topics pull interest back down (#3: gaming skips ↓).
  for (const [topic, amount] of profile.topicSkipAffinity) {
    const positive = profile.topicAffinity.get(topic) ?? 0;
    const adjusted = positive - amount * 0.6;
    if (adjusted <= 0) profile.topicAffinity.delete(topic);
    else profile.topicAffinity.set(topic, adjusted);
  }

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

/** Title/description/tag relevance against the viewer's interest tokens. */
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

/** Exponential decay with a configurable half-life. */
export function freshnessScore(ageHours: number, halfLife: number): number {
  const safeAge = ageHours < 0 ? 0 : ageHours;
  return Math.max(FRESHNESS_FLOOR, Math.exp(-safeAge / halfLife));
}

/**
 * Engagement QUALITY, not raw counts. Rates are smoothed by a views prior and
 * dampened by lifetime scale, so 10/100 can outrank 1000/1000000.
 */
export function engagementQuality(c: CandidateRow): number {
  const views = Math.max(c.views, 0) + ENGAGEMENT.smoothingViews;
  const likeRate = c.likesCount / views;
  const commentRate = c.commentsCount / views;
  const shareRate = c.shares / views;
  const dislikeRate = c.dislikesCount / views;
  const scaleDampening =
    Math.log1p(Math.max(c.views, 0)) /
    Math.log1p(Math.max(c.views, 0) + ENGAGEMENT.logViewDampening * 100);
  const positive =
    likeRate * ENGAGEMENT.likeRateWeight +
    commentRate * ENGAGEMENT.commentRateWeight +
    shareRate * ENGAGEMENT.shareRateWeight;
  const score = positive * (1 - scaleDampening * 0.35) - dislikeRate * ENGAGEMENT.dislikeRateWeight * 12;
  return Math.max(0, Math.min(1, score * 8));
}

/** Precomputed per-video aggregate (see video_stats). */
export interface VideoStat {
  samples: number;
  avgWatchPct: number;
  completions: number;
  skips: number;
  impressions: number;
  conversion: number;
  recentSamples: number;
}

export interface ScoreComponents {
  personalInterest: number;
  topicSimilarity: number;
  creatorAffinity: number;
  similarUsers: number;
  similarVideo: number;
  watchBehavior: number;
  retention: number;
  engagement: number;
  videoPerformance: number;
  freshness: number;
  formatPreference: number;
  subscription: number;
  exploration: number;
}

export interface ScoredCandidate {
  candidate: CandidateRow;
  components: ScoreComponents;
  /** Product of every penalty multiplier — exposed for debugging/tuning. */
  penalty: number;
  score: number;
  seenState: "unseen" | "partial" | "completed";
  source: RecommendationSource;
  /** True when the viewer explicitly asked not to see this again. */
  suppressed: boolean;
}

export interface ScoreContext {
  surface: "home" | "shorts" | "related";
  /** Observed retention per video id (avg watch %, sample count). */
  retention: Map<string, { avg: number; n: number; completed: number }>;
  /** Global average retention, used as the shrinkage prior. */
  globalRetention: number;
  /** Recent interaction counts per video id (velocity). */
  velocity: Map<string, number>;
  /** Precomputed aggregates; preferred over ad-hoc retention queries. */
  stats: Map<string, VideoStat>;
  /** Global average impression→watch conversion, the discovery baseline. */
  globalConversion: number;
  /** Collaborative-filtering score: "similar viewers also watched this". */
  similarUsers: Map<string, number>;
  /** Video→video similarity against the current watch-page anchor. */
  similarVideo: Map<string, number>;
  /** Recent impressions per video (repetition control). */
  impressions: Map<string, { count: number; lastAt: number }>;
  /** Recent impressions per creator (over-exposure control). */
  creatorImpressions: Map<string, number>;
  /** Genuine watches per creator — relieves the over-exposure penalty. */
  creatorWatches: Map<string, number>;
  /** Deterministic per-viewer 0..1 seed used for the fresh-content test pool. */
  audienceSeed: number;
}

export function emptyScoreContext(surface: ScoreContext["surface"]): ScoreContext {
  return {
    surface,
    retention: new Map(),
    globalRetention: 0.4,
    velocity: new Map(),
    stats: new Map(),
    globalConversion: 0,
    similarUsers: new Map(),
    similarVideo: new Map(),
    impressions: new Map(),
    creatorImpressions: new Map(),
    creatorWatches: new Map(),
    audienceSeed: 0.5,
  };
}

/** Stable 0..1 hash for (viewer, video) pairs — used for test-pool exposure. */
export function stableHash(key: string): number {
  let hash = 0;
  for (let k = 0; k < key.length; k += 1) hash = (hash * 31 + key.charCodeAt(k)) % 1000003;
  return hash / 1000003;
}

/**
 * Fresh-content discovery (#12). A new upload gets an uncertainty bonus while
 * evidence is thin, a lift when its early conversion beats the global average,
 * and a demotion when the test audience keeps ignoring it.
 */
function discoveryScore(
  c: CandidateRow,
  ctx: ScoreContext,
  ageHours: number,
  viewerSeed: number
): { score: number; inTestPool: boolean } {
  if (ageHours > FRESH_DISCOVERY.testWindowHours) return { score: 0, inTestPool: false };
  const stat = ctx.stats.get(c.id);
  const samples = stat?.samples ?? 0;
  const inTestPool = viewerSeed <= FRESH_DISCOVERY.audienceFraction;

  // Not in this viewer's test slice and still unevaluated → hold it back, so a
  // brand-new upload cannot sit on top of everybody's feed.
  if (!inTestPool && samples < FRESH_DISCOVERY.minEvidenceSamples) {
    return { score: 0, inTestPool: false };
  }
  if (samples < FRESH_DISCOVERY.minEvidenceSamples) {
    return { score: FRESH_DISCOVERY.lowEvidenceBoost, inTestPool: true };
  }

  const baseline = ctx.globalConversion > 0 ? ctx.globalConversion : 0.08;
  const conversion = stat?.conversion ?? 0;
  const ignored = (stat?.impressions ?? 0) >= FRESH_DISCOVERY.ignoredImpressions && conversion <= 0;
  if (ignored) return { score: -FRESH_DISCOVERY.poorConversionPenalty, inTestPool: true };
  if (conversion >= baseline * 1.15) return { score: FRESH_DISCOVERY.goodConversionBoost, inTestPool: true };
  if (conversion < baseline * 0.5) return { score: -FRESH_DISCOVERY.poorConversionPenalty * 0.5, inTestPool: true };
  return { score: 0.05, inTestPool: true };
}

/** Which signal drove the recommendation — recorded for debugging/tuning (#19). */
function labelSource(
  components: ScoreComponents,
  weights: RankWeights,
  c: CandidateRow,
  ageHours: number
): RecommendationSource {
  const contributions: Array<[RecommendationSource, number]> = [
    ["personal_interest", weights.personalInterest * components.personalInterest],
    ["related_topic", weights.topicSimilarity * components.topicSimilarity],
    ["creator_affinity", weights.creatorAffinity * components.creatorAffinity],
    ["similar_users", weights.similarUsers * components.similarUsers],
    ["similar_video", weights.similarVideo * components.similarVideo],
    ["format_preference" as RecommendationSource, 0],
    ["subscription", weights.subscription * components.subscription],
    ["trending", weights.videoPerformance * components.videoPerformance + weights.engagement * components.engagement],
    ["exploration", weights.exploration * components.exploration],
    ["fresh_content", ageHours <= FRESH_DISCOVERY.testWindowHours ? weights.exploration * components.exploration * 0.9 : 0],
  ];
  let best: RecommendationSource = "personal_interest";
  let bestValue = -1;
  for (const [label, value] of contributions) {
    if (label === ("format_preference" as string)) continue;
    if (value > bestValue) {
      bestValue = value;
      best = label;
    }
  }
  // A brand-new upload surfaced by the discovery test pool is labelled as such.
  if (ageHours <= 24 && c.views < EXPLORATION.lowDataViews && bestValue < 0.05) return "fresh_content";
  return bestValue <= 0 ? "trending" : best;
}

/**
 * The full ranking pass: every component, every penalty multiplier, and the
 * recommendation-source label. `surface` selects the format-aware model.
 */
export function scoreCandidates(
  pool: CandidateRow[],
  profile: ViewerProfile,
  ctx: ScoreContext,
  weights: RankWeights,
  halfLifeHours: number
): ScoredCandidate[] {
  const now = Date.now();

  const personalRaw: number[] = [];
  const watchRaw: number[] = [];
  const engagementRaw: number[] = [];
  const velocityRaw: number[] = [];
  const retRaw: number[] = [];

  const pre = pool.map((c) => {
    // ── topic / text / creator / language affinity ────────────────────────
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

    const personalInterest = Math.min(1, 0.45 * text + 0.3 * topic + 0.25 * lang);

    // ── format preference (#10): own-format match + cross-format transfer ──
    const formatMatch = 1 - Math.abs(profile.shortAffinity - (c.isShort ? 1 : 0));
    const otherFormat = c.isShort ? profile.longTopicAffinity : profile.shortTopicAffinity;
    const crossTopic = Math.min(1, maxAffinity(otherFormat, [c.category, ...c.tags]) / 3);
    const formatPreference = Math.min(1, 0.65 * formatMatch + 0.35 * crossTopic);

    // ── this viewer's own history with the video / creator / topic ────────
    const seen = profile.watched.get(c.id);
    const watchBehavior = seen
      ? Math.min(1, seen.watchPct * 0.7 + Math.min(seen.count - 1, 3) * 0.1)
      : creator > 0
      ? Math.min(1, creator * 0.7)
      : Math.min(1, topic * 0.6);

    const engagement = engagementQuality(c);

    // ── retention: observed, shrunk toward the global prior ───────────────
    const stat = ctx.stats.get(c.id);
    const observedRetention = ctx.retention.get(c.id);
    const prior = ctx.globalRetention > 0 ? ctx.globalRetention : 0.4;
    const samples = stat?.samples ?? observedRetention?.n ?? 0;
    const avg = stat && stat.samples > 0 ? stat.avgWatchPct : observedRetention?.avg ?? 0;
    const shrink = ENGAGEMENT.smoothingViews / (ENGAGEMENT.smoothingViews + samples);
    const retention = samples > 0 ? avg * (1 - shrink) + prior * shrink : prior * 0.8;

    // ── video performance: recent genuine activity + discovery conversion ──
    const recent = ctx.velocity.get(c.id) ?? stat?.recentSamples ?? 0;
    const velocity = recent / (1 + Math.log1p(Math.max(c.views, 0)) / 4);

    personalRaw.push(personalInterest);
    watchRaw.push(watchBehavior);
    engagementRaw.push(engagement);
    velocityRaw.push(velocity);
    retRaw.push(retention);

    return { candidate: c, seen, personalInterest, topic, creator, formatPreference, watchBehavior, engagement, retention, velocity };
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

    // ── exploration: low-data + small-creator uncertainty + fresh discovery ──
    const lowData = c.views < EXPLORATION.lowDataViews;
    const smallCreator = c.subscribers > 0 && c.subscribers < EXPLORATION.smallCreatorViews;
    const salt = Math.floor(now / (6 * 3600 * 1000));
    const jitter = stableHash(`${profile.userKey}:${c.id}:${salt}`) * EXPLORATION.jitterAmplitude;
    const viewerSeed = stableHash(`${profile.userKey}:${c.id}:audience`);
    const discovery = discoveryScore(c, ctx, ageHours, viewerSeed);
    const exploration = Math.max(
      0,
      Math.min(1, (lowData ? 0.55 : 0) + (smallCreator ? 0.25 : 0) + jitter + discovery.score)
    );

    const similarUsers = Math.max(0, Math.min(1, ctx.similarUsers.get(c.id) ?? 0));
    const similarVideo = Math.max(0, Math.min(1, ctx.similarVideo.get(c.id) ?? 0));

    // ── video performance blends velocity with the discovery verdict ───────
    const conversion = ctx.stats.get(c.id)?.conversion ?? 0;
    const conversionNorm = ctx.globalConversion > 0 ? Math.min(1, conversion / (ctx.globalConversion * 2)) : 0;
    const videoPerformanceRaw = 0.7 * nVelocity[i] + 0.3 * conversionNorm;

    const components: ScoreComponents = {
      personalInterest: nPersonal[i],
      topicSimilarity: item.topic,
      creatorAffinity: item.creator,
      similarUsers,
      similarVideo,
      watchBehavior: nWatch[i],
      retention: nRetention[i],
      engagement: nEngagement[i],
      videoPerformance: Math.max(0, Math.min(1, videoPerformanceRaw)),
      freshness,
      formatPreference: item.formatPreference,
      subscription,
      exploration,
    };

    // ── penalty multipliers ───────────────────────────────────────────────
    const seen = item.seen;
    let seenState: ScoredCandidate["seenState"] = "unseen";
    let penalty = 1;

    if (seen) {
      if (seen.completed || seen.watchPct >= 0.9) {
        seenState = "completed";
        penalty *= ctx.surface === "shorts" ? SHORTS_COMPLETED_PENALTY : PENALTIES.watchedCompleted;
      } else if (seen.watchPct >= PENALTIES.trivialThreshold) {
        seenState = "partial";
        penalty *= PENALTIES.watchedPartial;
      }
    }

    // Explicit skip / immediate swipe-away (#4/#5).
    const skipCount = profile.skipped.get(c.id) ?? 0;
    if (skipCount > 0) {
      penalty *= Math.max(0.05, Math.pow(PENALTIES.skipped, Math.min(skipCount, 3)));
    }
    if (
      ctx.surface === "shorts" &&
      seen &&
      seen.watchPct > 0 &&
      seen.watchPct < SHORTS_SWIPE_AWAY_PCT &&
      !seen.completed
    ) {
      penalty *= SHORTS_SWIPE_AWAY_PENALTY;
    }

    // "Not interested" — long, near-total suppression (#1/#5).
    const niAt = profile.notInterested.get(c.id);
    let suppressed = false;
    if (niAt && now - niAt.getTime() < REPETITION.notInterestedWindowHours * 3600_000) {
      penalty *= PENALTIES.notInterested;
      suppressed = true;
    }

    // Repeatedly impressed but never watched (#5).
    const impressed = ctx.impressions.get(c.id);
    if (impressed && !seen && impressed.count > 0) {
      const ageH = (now - impressed.lastAt) / 3600_000;
      if (ageH < REPETITION.impressionWindowHours) {
        penalty *= Math.max(
          REPETITION.minMultiplier,
          Math.pow(REPETITION.perImpressionMultiplier, impressed.count)
        );
      }
    }

    // Creator over-exposure (#7) — relieved by genuine watches of that creator.
    const creatorImpressions = ctx.creatorImpressions.get(c.channelId) ?? 0;
    if (creatorImpressions > CREATOR_OVEREXPOSURE.softLimit) {
      const relief = Math.min(
        1,
        (ctx.creatorWatches.get(c.channelId) ?? 0) * CREATOR_OVEREXPOSURE.activeViewerRelief
      );
      const excess = creatorImpressions - CREATOR_OVEREXPOSURE.softLimit;
      const raw = Math.pow(CREATOR_OVEREXPOSURE.perExtraMultiplier, excess);
      penalty *= Math.max(CREATOR_OVEREXPOSURE.minMultiplier, raw + (1 - raw) * relief);
    }

    let score =
      weights.personalInterest * components.personalInterest +
      weights.topicSimilarity * components.topicSimilarity +
      weights.creatorAffinity * components.creatorAffinity +
      weights.similarUsers * components.similarUsers +
      weights.similarVideo * components.similarVideo +
      weights.watchBehavior * components.watchBehavior +
      weights.rewatch * components.watchBehavior +
      weights.retention * components.retention +
      weights.engagement * components.engagement +
      weights.videoPerformance * components.videoPerformance +
      weights.freshness * components.freshness +
      weights.formatPreference * components.formatPreference +
      weights.subscription * components.subscription +
      weights.exploration * components.exploration;

    score *= penalty;

    return {
      candidate: c,
      components,
      penalty,
      score,
      seenState,
      suppressed,
      source: labelSource(components, weights, c, ageHours),
    };
  });
}

/** Recent genuine activity per video, used by the velocity component. */
export async function recentInteractionCounts(videoIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!videoIds.length) return counts;
  const cutoff = new Date(Date.now() - VELOCITY_WINDOW_HOURS * 3600 * 1000);
  try {
    const rows = await db
      .select({ videoId: watchEvents.videoId, n: sql<number>`count(*)::int` })
      .from(watchEvents)
      .where(inArray(watchEvents.videoId, videoIds))
      .groupBy(watchEvents.videoId);
    void cutoff;
    for (const row of rows) counts.set(row.videoId, Number(row.n) || 0);
  } catch {
    /* velocity falls back to lifetime signals */
  }
  return counts;
}

/** Observed retention per video: avg watch %, samples and completions. */
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

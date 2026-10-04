/**
 * ─────────────────────────────────────────────────────────────────────────
 * Recommendation configuration — SERVER ONLY
 * ─────────────────────────────────────────────────────────────────────────
 * Every tunable in the ranking system lives here. Nothing in this module is
 * imported by a client component, so the weights are never shipped to the
 * browser. Values are INITIAL estimates and are expected to be re-tuned from
 * real BharatTube engagement data — no weight is hardcoded in a component or
 * in the scoring maths itself.
 */

/** Total candidate pool considered per ranking pass. */
export const CANDIDATE_POOL_SIZE = 400;
/** Per-strategy slice size used by multi-strategy candidate generation. */
export const CANDIDATE_SLICE_SIZE = 120;
/** How long the mirrored candidate pool stays trustworthy. */
export const CANDIDATE_SYNC_TTL_MS = 5 * 60 * 1000;
/** Backend pages pulled per sync — deliberately broader than one page. */
export const SYNC_MAX_PAGES = 4;
export const SYNC_PAGE_SIZE = 50;

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Ranking weights. Each key maps 1:1 onto a component computed in scoring.ts:
 *
 *   RecommendationScore =
 *       w.personalInterest  * PersonalInterestScore
 *     + w.topicSimilarity   * TopicSimilarityScore
 *     + w.creatorAffinity   * CreatorAffinityScore
 *     + w.similarUsers      * SimilarUserScore        (collaborative filtering)
 *     + w.similarVideo      * SimilarVideoScore       (video→video)
 *     + w.watchBehavior     * OwnHistoryScore
 *     + w.retention         * RetentionScore
 *     + w.engagement        * EngagementScore
 *     + w.videoPerformance  * VideoPerformanceScore   (velocity + conversion)
 *     + w.freshness         * FreshnessScore
 *     + w.formatPreference  * FormatPreferenceScore
 *     + w.subscription      * SubscriptionScore
 *     + w.exploration       * ExplorationScore
 *   then multiplied by the penalty factors in PENALTIES / REPETITION.
 *
 * Weights sum to 1.0 and are read at rank time, so re-tuning never requires a
 * code change beyond this object.
 */
export interface RankWeights {
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
  /** Rewatch weighting is a Shorts-only signal; unused for long-form. */
  rewatch: number;
}

/** Long-form Home / related model. */
export const WEIGHTS: RankWeights = {
  personalInterest: 0.22,
  topicSimilarity: 0.1,
  creatorAffinity: 0.08,
  similarUsers: 0.08,
  similarVideo: 0.05,
  watchBehavior: 0.1,
  retention: 0.1,
  engagement: 0.08,
  videoPerformance: 0.05,
  freshness: 0.05,
  formatPreference: 0.04,
  subscription: 0.03,
  exploration: 0.02,
  rewatch: 0,
};

/**
 * Shorts are ranked with a DIFFERENT model: completion, rewatch and swipe-away
 * dominate; lifetime views barely matter.
 */
export const SHORTS_WEIGHTS: RankWeights = {
  retention: 0.22,
  rewatch: 0.14,
  personalInterest: 0.16,
  topicSimilarity: 0.06,
  engagement: 0.1,
  formatPreference: 0.08,
  freshness: 0.06,
  videoPerformance: 0.06,
  similarUsers: 0.05,
  creatorAffinity: 0.04,
  subscription: 0.02,
  exploration: 0.01,
  similarVideo: 0,
  watchBehavior: 0,
};

/**
 * Related / "Up next" model (#9). Similarity to the anchor video leads;
 * generic popularity and freshness contribute almost nothing, so completely
 * unrelated videos never get an unnecessary boost.
 */
export const RELATED_WEIGHTS: RankWeights = {
  similarVideo: 0.32,
  personalInterest: 0.16,
  topicSimilarity: 0.13,
  engagement: 0.07,
  creatorAffinity: 0.06,
  retention: 0.06,
  similarUsers: 0.05,
  videoPerformance: 0.05,
  freshness: 0.03,
  formatPreference: 0.02,
  subscription: 0.02,
  watchBehavior: 0.02,
  exploration: 0.01,
  rewatch: 0,
};

/** Freshness half-life in hours. Freshness is a signal, never a sort order. */
export const FRESHNESS_HALF_LIFE_HOURS = 72;
/** Beyond this age freshness contributes ~0 and is clamped to this floor. */
export const FRESHNESS_FLOOR = 0.04;
export const SHORTS_FRESHNESS_HALF_LIFE_HOURS = 168;

/**
 * ── Penalties (multiplicative, applied after the weighted sum) ────────────
 * Every penalty floors above zero: content is demoted, never permanently
 * banned, so a video can return once the viewer's behaviour changes.
 */
export const PENALTIES = {
  /** Viewer finished it → strong demotion (rewatching stays possible). */
  watchedCompleted: 0.12,
  /** Viewer bailed early → milder demotion, still recommendable. */
  watchedPartial: 0.55,
  /** Below this watch % the view is treated as effectively unseen. */
  trivialThreshold: 0.1,
  /** Explicit skip / immediate swipe-away → stronger than a partial watch. */
  skipped: 0.18,
  /** "Not interested" → near-total suppression for a long window. */
  notInterested: 0.02,
  /** Topic the viewer repeatedly skips gets its affinity decayed (#3). */
  repeatedSkipTopicDecay: 0.75,
} as const;

/** Kept for backwards compatibility with the original config surface. */
export const ALREADY_WATCHED = {
  completedPenalty: PENALTIES.watchedCompleted,
  partialPenalty: PENALTIES.watchedPartial,
  trivialThreshold: PENALTIES.trivialThreshold,
} as const;

export const SHORTS_COMPLETED_PENALTY = 0.25;
/** Viewer swiped away almost immediately → negative signal. */
export const SHORTS_SWIPE_AWAY_PCT = 0.2;
export const SHORTS_SWIPE_AWAY_PENALTY = 0.5;

/**
 * ── Repetition control (#5) ──────────────────────────────────────────────
 * "Same video baar-baar top par" is fixed with impression memory: each recent
 * impression that produced no watch multiplies the score down, with a floor.
 */
export const REPETITION = {
  /** How far back impressions are remembered. */
  impressionWindowHours: 72,
  /** Multiplicative decay per unwatched impression. */
  perImpressionMultiplier: 0.7,
  /** Never decay below this — the video can still resurface later. */
  minMultiplier: 0.18,
  /** Impressions beyond this count are treated as "repeatedly ignored". */
  ignoredHardLimit: 5,
  /** A video impressed inside this window is not eligible for the top slots. */
  topSlotCooldownHours: 6,
  /** Positions considered "top" for the cooldown rule. */
  topSlotCount: 8,
  watchedWindowHours: 24 * 30,
  skipWindowHours: 24 * 14,
  notInterestedWindowHours: 24 * 60,
  /** Max impressions persisted per viewer per surface (rolling). */
  maxStoredImpressions: 600,
} as const;

/**
 * ── Creator over-exposure (#7) ───────────────────────────────────────────
 * Even when several videos from one creator score highly, that creator may not
 * dominate recent slots. Actively watching the creator relieves the penalty.
 */
export const CREATOR_OVEREXPOSURE = {
  windowHours: 48,
  /** Impressions of one creator inside the window before decay starts. */
  softLimit: 3,
  perExtraMultiplier: 0.78,
  minMultiplier: 0.35,
  /** Each genuine watch of this creator cancels part of the penalty. */
  activeViewerRelief: 0.45,
} as const;

/** Engagement quality uses rates, not raw counts. */
export const ENGAGEMENT = {
  likeRateWeight: 0.45,
  commentRateWeight: 0.2,
  shareRateWeight: 0.2,
  dislikeRateWeight: 0.15,
  /** Views floor so a single view cannot produce a perfect rate. */
  smoothingViews: 25,
  /** Lifetime caps prevent one video from saturating the component. */
  logViewDampening: 2,
} as const;

/** Recent performance window used for velocity. */
export const VELOCITY_WINDOW_HOURS = 24;
export const VELOCITY_BLEND = { recent: 0.6, lifetime: 0.4 } as const;

/** Subscribed creators get a real boost, never an automatic #1. */
export const SUBSCRIPTION_BOOST = 1;

/**
 * ── Exploration vs exploitation (#11) ────────────────────────────────────
 * Configurable split: ~75% highly personalised, ~15% related/new topics,
 * ~10% exploration of new creators. Ratios are enforced by mix.ts.
 */
export const MIX = {
  exploitation: 0.75,
  related: 0.15,
  exploration: 0.1,
} as const;

export const EXPLORATION = {
  /** Videos with fewer observations than this get the uncertainty bonus. */
  lowDataViews: 250,
  bonus: 1,
  /** Creators above this subscriber count are never treated as "small". */
  smallCreatorViews: 5000,
  /** Deterministic jitter keeps exploration stable within a session. */
  jitterAmplitude: 0.35,
  /** Minimum share of the page reserved for exploration picks. */
  minExplorationSlots: 1,
} as const;

/** Creator diversity guard rails. */
export const CREATOR_DIVERSITY = {
  /** Max videos from one creator inside any consecutive window. */
  maxPerWindow: 2,
  window: 5,
  /** Hard gap required before the same creator reappears. */
  minGap: 3,
} as const;

/** Topic diversity inside the ranked page. */
export const TOPIC_DIVERSITY = {
  /** Same category may not occupy more than this share of a page. */
  maxShareOfPage: 0.45,
  minGap: 2,
} as const;

/** Feed pagination. */
export const FEED_PAGE_SIZE = 24;
export const SHORTS_PAGE_SIZE = 10;
export const RELATED_PAGE_SIZE = 15;

/** Basic manipulation resistance. */
export const ANTI_ABUSE = {
  /** Same viewer+video watch events closer than this are collapsed. */
  dedupeWindowSec: 20,
  /** Watch events accepted per viewer per minute. */
  maxWatchEventsPerMinute: 30,
  /** Interaction events accepted per viewer per minute. */
  maxInteractionsPerMinute: 20,
  /** A view shorter than this contributes nothing to retention. */
  minMeaningfulWatchSec: 2,
  /** Watch % below this counts as a skip rather than a view. */
  skipThresholdPct: 0.12,
} as const;

/**
 * ── Cold start (#13) ─────────────────────────────────────────────────────
 * A viewer with no history gets a diverse, quality-led feed: trending across
 * categories, recent quality uploads, multiple creators, both formats. As soon
 * as signals exist, the personalised path takes over.
 */
export const COLD_START = {
  /** Events below this count still count as cold start. */
  minSignals: 3,
  /** Max videos per category on a cold-start page. */
  maxPerCategory: 3,
  /** Max videos per creator on a cold-start page. */
  maxPerCreator: 2,
  /** Share of the page reserved for genuinely fresh uploads. */
  freshShare: 0.25,
  /** Blend used when there is no personal signal at all. */
  weights: {
    videoPerformance: 0.34,
    engagement: 0.28,
    freshness: 0.2,
    exploration: 0.18,
  },
} as const;

/**
 * ── Fresh-content discovery (#12) ────────────────────────────────────────
 * New uploads are tested on a slice of the audience. Good early retention /
 * conversion grows the score; being ignored shrinks it. Upload time alone can
 * never hold a top position.
 */
export const FRESH_DISCOVERY = {
  /** Age below which a video is still in its discovery test window. */
  testWindowHours: 96,
  /** Samples needed before early evidence outweighs the uncertainty bonus. */
  minEvidenceSamples: 6,
  /** Uncertainty bonus while evidence is thin. */
  lowEvidenceBoost: 0.4,
  /** Extra lift when early conversion beats the global average. */
  goodConversionBoost: 0.3,
  /** Demotion when the test audience keeps ignoring it. */
  poorConversionPenalty: 0.55,
  /** Fraction of viewers a brand-new video is initially exposed to. */
  audienceFraction: 0.35,
  /** Impressions with no watch before the test is judged "ignored". */
  ignoredImpressions: 12,
} as const;

/**
 * ── Collaborative filtering + item similarity (#8/#9) ────────────────────
 */
export const CF = {
  /** Minimum shared viewers before a co-watch edge is trusted. */
  minCoWatchers: 2,
  /** Similarity edges stored per video. */
  topPerVideo: 40,
  /** Neighbouring viewers considered for the similar-user score. */
  maxNeighbours: 60,
  /** Precomputed similarity stays valid this long. */
  similarityTtlMs: 30 * 60 * 1000,
  /** Content similarity: weight of shared tags vs title tokens vs category. */
  contentMix: { tags: 0.5, title: 0.25, category: 0.25 },
  /** Blend of co-watch and content similarity in the final edge score. */
  blend: { coWatch: 0.6, content: 0.4 },
} as const;

/**
 * ── Cached interest profiles (#18) + real-time refresh (#14) ─────────────
 */
export const PROFILE_CACHE = {
  /** A cached profile older than this is rebuilt regardless of event count. */
  ttlMs: 10 * 60 * 1000,
  /** In-memory LRU size for the hottest viewers on one instance. */
  maxEntries: 400,
  /** Events folded in before the cache is considered stale. */
  invalidateAfterEvents: 1,
} as const;

/** Precomputed per-video statistics refresh interval (background aggregation). */
export const STATS_TTL_MS = 15 * 60 * 1000;

/**
 * ── Home refresh rotation (#15) ──────────────────────────────────────────
 * Ranking must not return an identical static order on every request, yet
 * pagination inside one browsing session has to stay stable. A client-supplied
 * session token seeds a bounded rotation inside score bands.
 */
export const ROTATION = {
  /** Max score distance two items may swap across (keeps ranking meaningful). */
  bandWidth: 0.05,
  /** Fallback rotation bucket when the client sends no session token. */
  bucketsPerDay: 6,
} as const;

/** Interest decay: recent behaviour outweighs older behaviour (#3). */
export const INTEREST_DECAY = {
  /** Half-life, in events, of the index-based recency decay. */
  eventHalfLife: 40,
  /** Half-life in hours for time-based decay of stored affinity. */
  hoursHalfLife: 24 * 21,
  /** Weight of watch-percentage inside a single event's contribution. */
  retentionShare: 0.65,
  baseShare: 0.35,
} as const;

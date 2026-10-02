/**
 * ─────────────────────────────────────────────────────────────────────────
 * Recommendation configuration — SERVER ONLY
 * ─────────────────────────────────────────────────────────────────────────
 * Every tunable in the ranking system lives here. Nothing in this module is
 * imported by a client component, so the weights are never shipped to the
 * browser. Values are INITIAL estimates and are expected to be re-tuned from
 * real BharatTube engagement data.
 */

/** Total candidate pool considered per ranking pass (#20 step 1). */
export const CANDIDATE_POOL_SIZE = 400;
/** How long the mirrored candidate pool stays trustworthy (#23). */
export const CANDIDATE_SYNC_TTL_MS = 5 * 60 * 1000;
/** Backend pages pulled per sync — deliberately broader than one page (#20). */
export const SYNC_MAX_PAGES = 4;
export const SYNC_PAGE_SIZE = 50;

/**
 * Point 21 — initial scoring model. Weights sum to 1.0.
 */
export const WEIGHTS = {
  personalization: 0.3,
  watchBehavior: 0.2,
  retention: 0.15,
  engagementQuality: 0.1,
  freshness: 0.08,
  subscription: 0.07,
  recentVelocity: 0.05,
  exploration: 0.05,
  /** Rewatch weighting is a Shorts-only signal; unused for long-form. */
  rewatch: 0,
} as const;

/** Point 6 — freshness half-life in hours. Freshness is a signal, not a sort. */
export const FRESHNESS_HALF_LIFE_HOURS = 72;
/** Beyond this age freshness contributes ~0 and is clamped to this floor. */
export const FRESHNESS_FLOOR = 0.04;

/** Point 14 — previously-watched handling (never a permanent ban). */
export const ALREADY_WATCHED = {
  /** Viewer finished it: strong demotion, rewatching is still possible. */
  completedPenalty: 0.15,
  /** Viewer bailed early: mild demotion, still recommendable. */
  partialPenalty: 0.6,
  /** Watched a trivial amount (<10%): treated as effectively unseen. */
  trivialThreshold: 0.1,
} as const;

/**
 * Point 7 — engagement quality uses rates, not raw counts. Raw counts are
 * log-dampened so 10/100 can outrank 1000/1000000.
 */
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

/** Point 8 — recent performance window used for velocity. */
export const VELOCITY_WINDOW_HOURS = 24;
export const VELOCITY_BLEND = { recent: 0.6, lifetime: 0.4 } as const;

/** Point 15 — subscribed creators get a real boost, never an automatic #1. */
export const SUBSCRIPTION_BOOST = 1;

/**
 * Point 19 / 10 — exploration vs exploitation split. Configurable, not
 * hardcoded in components.
 */
export const MIX = {
  exploitation: 0.7,
  related: 0.2,
  exploration: 0.1,
} as const;

/** Point 11 — small-creator / low-data exploration uplift. */
export const EXPLORATION = {
  /** Videos with fewer observations than this get the uncertainty bonus. */
  lowDataViews: 250,
  bonus: 1,
  /** Creators above this subscriber count are never treated as "small". */
  smallCreatorViews: 5000,
  /** Deterministic jitter keeps exploration stable within a session (#23). */
  jitterAmplitude: 0.35,
} as const;

/** Point 9 — creator diversity guard rails. */
export const CREATOR_DIVERSITY = {
  /** Max videos from one creator inside any consecutive window. */
  maxPerWindow: 2,
  window: 5,
  /** Hard gap required before the same creator reappears. */
  minGap: 3,
} as const;

/** Point 10 — topic diversity inside the ranked page. */
export const TOPIC_DIVERSITY = {
  /** Same category may not occupy more than this share of a page. */
  maxShareOfPage: 0.45,
  minGap: 2,
} as const;

/** Point 22 — feed pagination. */
export const FEED_PAGE_SIZE = 24;
export const SHORTS_PAGE_SIZE = 10;

/** Point 18 — basic manipulation resistance. */
export const ANTI_ABUSE = {
  /** Same viewer+video watch events closer than this are collapsed. */
  dedupeWindowSec: 20,
  /** Watch events accepted per viewer per minute. */
  maxWatchEventsPerMinute: 30,
  /** Interaction events accepted per viewer per minute. */
  maxInteractionsPerMinute: 20,
  /** A view shorter than this contributes nothing to retention. */
  minMeaningfulWatchSec: 2,
} as const;

/**
 * Point 17 — Shorts are ranked with a different model: completion, rewatch and
 * swipe-away dominate; lifetime views barely matter.
 */
export const SHORTS_WEIGHTS = {
  retention: 0.3,
  rewatch: 0.2,
  personalization: 0.18,
  engagementQuality: 0.12,
  freshness: 0.08,
  recentVelocity: 0.06,
  subscription: 0.06,
  /** Long-form-only signals contribute nothing to the Shorts model. */
  watchBehavior: 0,
  exploration: 0,
} as const;
export const SHORTS_FRESHNESS_HALF_LIFE_HOURS = 168;
export const SHORTS_COMPLETED_PENALTY = 0.25;
/** Viewer swiped away almost immediately → negative signal. */
export const SHORTS_SWIPE_AWAY_PCT = 0.2;
export const SHORTS_SWIPE_AWAY_PENALTY = 0.5;

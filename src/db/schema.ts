import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Recommendation subsystem tables
 * ─────────────────────────────────────────────────────────────────────────
 * The existing BharatTube Render/Mongo backend stays the source of truth for
 * videos, users, uploads, likes and comments. These tables hold ONLY the
 * ranking inputs that backend does not expose:
 *
 *   videos_cache      → broad candidate pool + immutable engagement snapshot
 *   watch_events      → per-viewer retention (watch %, completion, rewatch)
 *   interaction_events→ likes / comments / shares / skips / subscriptions
 *   search_events     → viewer search interests
 *   sync_state        → candidate-pool freshness bookkeeping
 *   serve_events      → impressions: what was recommended, where, from which
 *                        recommendation source (repetition + overexposure)
 *   user_profiles     → cached interest profile per viewer (performance)
 *   item_similarity   → precomputed video↔video co-watch / content affinity
 *   video_stats       → precomputed per-video aggregates (background job)
 *
 * Nothing here is exposed to another user: every query is scoped by `user_key`,
 * which is derived server-side from the caller's own auth headers.
 */

/** Broad candidate pool mirrored from the existing backend (metadata only). */
export const videosCache = pgTable(
  "videos_cache",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    category: varchar("category", { length: 120 }).notNull().default(""),
    language: varchar("language", { length: 120 }).notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    channelId: varchar("channel_id", { length: 64 }).notNull().default(""),
    channelName: varchar("channel_name", { length: 240 }).notNull().default(""),
    channelHandle: varchar("channel_handle", { length: 240 }).notNull().default(""),
    durationSec: real("duration_sec").notNull().default(0),
    isShort: boolean("is_short").notNull().default(false),
    views: integer("views").notNull().default(0),
    likesCount: integer("likes_count").notNull().default(0),
    dislikesCount: integer("dislikes_count").notNull().default(0),
    commentsCount: integer("comments_count").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    watchTimeSec: real("watch_time_sec").notNull().default(0),
    /** Engagement sampled in the last 24h window, for velocity scoring. */
    viewsRecent: integer("views_recent").notNull().default(0),
    /** Untouched backend payload so the client adapter keeps working as-is. */
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    visible: boolean("visible").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("videos_cache_short_idx").on(t.isShort),
    index("videos_cache_channel_idx").on(t.channelId),
    index("videos_cache_created_idx").on(t.sourceCreatedAt),
    /** Candidate generation slices: format + recency, format + popularity. */
    index("videos_cache_short_created_idx").on(t.isShort, t.sourceCreatedAt),
    index("videos_cache_short_views_idx").on(t.isShort, t.views),
    index("videos_cache_category_idx").on(t.category),
  ]
);

/** Normalized watch behaviour per viewer — the retention/interest backbone. */
export const watchEvents = pgTable(
  "watch_events",
  {
    id: serial("id").primaryKey(),
    userKey: varchar("user_key", { length: 160 }).notNull(),
    videoId: varchar("video_id", { length: 64 }).notNull(),
    watchSeconds: real("watch_seconds").notNull().default(0),
    videoSeconds: real("video_seconds").notNull().default(0),
    watchPct: real("watch_pct").notNull().default(0),
    completed: boolean("completed").notNull().default(false),
    /** Creator of the watched video — enables creator affinity without a join. */
    channelId: varchar("channel_id", { length: 64 }).notNull().default(""),
    /** "long" | "short" — format-aware retention and format preference. */
    format: varchar("format", { length: 12 }).notNull().default("long"),
    /** Viewer bailed almost immediately (explicit negative signal). */
    skipped: boolean("skipped").notNull().default(false),
    /** Search query that led to this watch, when known. */
    searchContext: varchar("search_context", { length: 160 }).notNull().default(""),
    /** Which recommendation source served this video (#19). */
    source: varchar("source", { length: 32 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("watch_events_user_idx").on(t.userKey, t.createdAt),
    index("watch_events_video_idx").on(t.userKey, t.videoId),
    /** Per-video aggregate scan used by the background stats job. */
    index("watch_events_video_created_idx").on(t.videoId, t.createdAt),
    /** Co-watch neighbourhoods: which viewers watched this video. */
    index("watch_events_video_user_idx").on(t.videoId, t.userKey),
  ]
);

/** Likes, comments, shares, skips, subscriptions and format-level swipes. */
export const interactionEvents = pgTable(
  "interaction_events",
  {
    id: serial("id").primaryKey(),
    userKey: varchar("user_key", { length: 160 }).notNull(),
    /** videoId, or a channel id when kind === "subscribe". */
    targetId: varchar("target_id", { length: 64 }).notNull(),
    /** like | dislike | comment | share | subscribe | unsubscribe | skip | rewatch | not_interested */
    kind: varchar("kind", { length: 32 }).notNull(),
    weight: real("weight").notNull().default(1),
    channelId: varchar("channel_id", { length: 64 }).notNull().default(""),
    format: varchar("format", { length: 12 }).notNull().default("long"),
    source: varchar("source", { length: 32 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interaction_user_idx").on(t.userKey, t.kind, t.createdAt),
    index("interaction_target_idx").on(t.userKey, t.targetId),
    index("interaction_target_kind_idx").on(t.targetId, t.kind, t.createdAt),
  ]
);

/** Viewer search interests, used as a personalization signal only. */
export const searchEvents = pgTable(
  "search_events",
  {
    id: serial("id").primaryKey(),
    userKey: varchar("user_key", { length: 160 }).notNull(),
    query: varchar("query", { length: 160 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("search_events_user_idx").on(t.userKey, t.createdAt)]
);

/** Candidate-pool freshness bookkeeping, so syncing stays cheap. */
export const syncState = pgTable("sync_state", {
  id: serial("id").primaryKey(),
  scope: varchar("scope", { length: 32 }).notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  itemsSeen: integer("items_seen").notNull().default(0),
});

/** Per-user served impressions, for exploration accounting and repeat control. */
export const serveEvents = pgTable(
  "serve_events",
  {
    id: serial("id").primaryKey(),
    userKey: varchar("user_key", { length: 160 }).notNull(),
    surface: varchar("surface", { length: 16 }).notNull(),
    videoId: varchar("video_id", { length: 64 }).notNull(),
    score: real("score").notNull().default(0),
    rank: integer("rank").notNull().default(0),
    /** Creator + format denormalised so penalties need no join. */
    creatorId: varchar("creator_id", { length: 64 }).notNull().default(""),
    format: varchar("format", { length: 12 }).notNull().default("long"),
    /** personal_interest | similar_users | similar_video | creator_affinity |
     *  trending | fresh_content | exploration | subscription | related_topic */
    source: varchar("source", { length: 32 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("serve_unique_idx").on(t.userKey, t.surface, t.videoId, t.createdAt),
    /** "What did we recently show this viewer?" — the hot repetition query. */
    index("serve_user_surface_created_idx").on(t.userKey, t.surface, t.createdAt),
    index("serve_video_idx").on(t.videoId, t.createdAt),
    index("serve_creator_idx").on(t.userKey, t.creatorId, t.createdAt),
  ]
);

/**
 * Cached interest profile per viewer (#18). Rebuilding affinities from hundreds
 * of events on every Home request is the single most expensive part of ranking,
 * so the derived model is stored and only recomputed when new events arrive
 * (#14 real-time invalidation).
 */
export const userProfiles = pgTable(
  "user_profiles",
  {
    userKey: varchar("user_key", { length: 160 }).primaryKey(),
    profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
    /** Number of events folded into this snapshot — the invalidation cursor. */
    eventCount: integer("event_count").notNull().default(0),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_profiles_updated_idx").on(t.updatedAt)]
);

/**
 * Precomputed video↔video affinity (#8/#9). Written by the background
 * aggregation job, read at rank time — never computed per request.
 */
export const itemSimilarity = pgTable(
  "item_similarity",
  {
    videoA: varchar("video_a", { length: 64 }).notNull(),
    videoB: varchar("video_b", { length: 64 }).notNull(),
    /** Normalised 0..1 similarity. */
    score: real("score").notNull().default(0),
    /** Viewers who engaged with both — confidence for the co-watch signal. */
    coWatchers: integer("co_watchers").notNull().default(0),
    /** "co_watch" | "content" | "creator" | "blended" */
    kind: varchar("kind", { length: 16 }).notNull().default("blended"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.videoA, t.videoB] }),
    index("item_similarity_b_idx").on(t.videoB),
    index("item_similarity_a_score_idx").on(t.videoA, t.score),
  ]
);

/**
 * Precomputed per-video performance aggregates (#12/#18): retention, completion,
 * skip rate and impression→watch conversion. Fresh uploads are judged on this
 * early evidence instead of their upload timestamp.
 */
export const videoStats = pgTable(
  "video_stats",
  {
    videoId: varchar("video_id", { length: 64 }).primaryKey(),
    samples: integer("samples").notNull().default(0),
    avgWatchPct: real("avg_watch_pct").notNull().default(0),
    completions: integer("completions").notNull().default(0),
    skips: integer("skips").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    /** Watched / impressed — the discovery "test pool" verdict (#12). */
    conversion: real("conversion").notNull().default(0),
    recentSamples: integer("recent_samples").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("video_stats_conversion_idx").on(t.conversion)]
);

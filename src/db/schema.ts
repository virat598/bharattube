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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("watch_events_user_idx").on(t.userKey, t.createdAt),
    index("watch_events_video_idx").on(t.userKey, t.videoId),
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
    /** like | dislike | comment | share | subscribe | unsubscribe | skip | rewatch */
    kind: varchar("kind", { length: 32 }).notNull(),
    weight: real("weight").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interaction_user_idx").on(t.userKey, t.kind, t.createdAt),
    index("interaction_target_idx").on(t.userKey, t.targetId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("serve_unique_idx").on(t.userKey, t.surface, t.videoId, t.createdAt)]
);

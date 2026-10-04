import { db, isDatabaseConfigured } from "@/db";
import { watchEvents, interactionEvents, searchEvents, videosCache } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { ANTI_ABUSE } from "./config";
import { invalidateProfile } from "./profile-cache";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Event recording with basic manipulation resistance.
 * ─────────────────────────────────────────────────────────────────────────
 * Events are written through the same-origin API route, so the client never
 * learns how they are weighted. Only the caller's own events are ever read
 * back — a viewer's history is never shared with another viewer.
 *
 * Every write stores the denormalised ranking context (creator, format, the
 * recommendation source that served it, and any search context) so interest,
 * repetition and over-exposure queries stay single-table and indexed (#17).
 *
 * Recording also invalidates that viewer's cached profile, which is what makes
 * personalisation feel real-time: five cricket videos in a row change the next
 * Home refresh instead of waiting for a cache expiry (#14).
 */

export type InteractionKind =
  | "like"
  | "dislike"
  | "comment"
  | "share"
  | "subscribe"
  | "unsubscribe"
  | "skip"
  | "rewatch"
  | "not_interested";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Denormalised video context, read by primary key (never a scan). */
interface VideoContext {
  channelId: string;
  format: "long" | "short";
}

const contextCache = new Map<string, VideoContext>();

async function videoContext(videoId: string): Promise<VideoContext> {
  const fallback = { channelId: "", format: "long" as const };
  if (!videoId) return fallback;
  const hit = contextCache.get(videoId);
  if (hit) return hit;
  if (!isDatabaseConfigured) return fallback;
  try {
    const rows = await db
      .select({ channelId: videosCache.channelId, isShort: videosCache.isShort })
      .from(videosCache)
      .where(eq(videosCache.id, videoId))
      .limit(1);
    const row = rows[0];
    const ctx: VideoContext = {
      channelId: row?.channelId ?? "",
      format: row?.isShort ? "short" : "long",
    };
    if (contextCache.size > 2000) contextCache.clear();
    contextCache.set(videoId, ctx);
    return ctx;
  } catch {
    return fallback;
  }
}

async function countRecent(
  table: typeof watchEvents | typeof interactionEvents,
  userKey: string,
  since: Date
): Promise<number> {
  if (!isDatabaseConfigured) return 0;
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.userKey, userKey), gte(table.createdAt, since)));
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

export interface WatchEventInput {
  watchSeconds?: number;
  videoSeconds?: number;
  /** Explicit watch percentage; used when durations are unavailable. */
  watchPct?: number;
  completed?: boolean;
  /** Which recommendation source served this video (#19). */
  source?: string;
  /** Search query that led to the watch, when known. */
  searchContext?: string;
  /** Creator/format override when the client already knows them. */
  channelId?: string;
  format?: "long" | "short";
}

/**
 * Record a watch sample. Returns false when the sample was rejected by the
 * anti-abuse guard or was too short to be meaningful.
 */
export async function recordWatchEvent(
  userKey: string,
  videoId: string,
  input: WatchEventInput
): Promise<boolean> {
  // Without Postgres the signal is simply not persisted; the existing backend
  // keeps recording views/history as before.
  if (!isDatabaseConfigured || !userKey || !videoId) return false;

  const since = new Date(Date.now() - 60_000);
  const recent = await countRecent(watchEvents, userKey, since);
  if (recent >= ANTI_ABUSE.maxWatchEventsPerMinute) return false;

  // Collapse rapid repeated views of the same video.
  const cutoff = new Date(Date.now() - ANTI_ABUSE.dedupeWindowSec * 1000);
  try {
    const dupes = await db
      .select({ id: watchEvents.id })
      .from(watchEvents)
      .where(
        and(
          eq(watchEvents.userKey, userKey),
          eq(watchEvents.videoId, videoId),
          gte(watchEvents.createdAt, cutoff)
        )
      )
      .limit(1);
    if (dupes.length) return false;
  } catch {
    /* a failed dedupe read must not block a legitimate event */
  }

  const videoSeconds = clamp(Number(input.videoSeconds ?? 0), 0, 86_400);
  const watchSeconds = clamp(Number(input.watchSeconds ?? 0), 0, 86_400);
  const watchPct =
    input.watchPct != null
      ? clamp(Number(input.watchPct), 0, 1)
      : videoSeconds > 0
      ? clamp(watchSeconds / videoSeconds, 0, 1)
      : 0;

  const completed = Boolean(input.completed) || watchPct >= 0.9;
  // A near-zero watch is an explicit negative: it becomes a skip, so repeated
  // early bail-outs push the video (and its topic) down instead of counting as
  // a view (#4/#5).
  const skipped = !completed && watchPct < ANTI_ABUSE.skipThresholdPct;
  if (!skipped && watchSeconds < ANTI_ABUSE.minMeaningfulWatchSec && watchPct < 0.05) return false;

  const ctx = await videoContext(videoId);

  try {
    await db.insert(watchEvents).values({
      userKey,
      videoId,
      watchSeconds,
      videoSeconds,
      watchPct: skipped ? Math.max(watchPct, 0) : watchPct,
      completed,
      skipped,
      channelId: (input.channelId ?? ctx.channelId).slice(0, 64),
      format: (input.format ?? ctx.format) === "short" ? "short" : "long",
      searchContext: String(input.searchContext ?? "").slice(0, 160),
      source: String(input.source ?? "").slice(0, 32),
    });
    invalidateProfile(userKey);
    return true;
  } catch {
    return false;
  }
}

export interface InteractionEventInput {
  weight?: number;
  source?: string;
  channelId?: string;
  format?: "long" | "short";
}

export async function recordInteractionEvent(
  userKey: string,
  targetId: string,
  kind: InteractionKind,
  weight = 1,
  extra: InteractionEventInput = {}
): Promise<boolean> {
  if (!isDatabaseConfigured || !userKey || !targetId || !kind) return false;

  const since = new Date(Date.now() - 60_000);
  const recent = await countRecent(interactionEvents, userKey, since);
  if (recent >= ANTI_ABUSE.maxInteractionsPerMinute) return false;

  // Duplicate identical interactions inside a short window are spam, not signal.
  const cutoff = new Date(Date.now() - ANTI_ABUSE.dedupeWindowSec * 1000);
  try {
    const dupes = await db
      .select({ id: interactionEvents.id })
      .from(interactionEvents)
      .where(
        and(
          eq(interactionEvents.userKey, userKey),
          eq(interactionEvents.targetId, targetId),
          eq(interactionEvents.kind, kind),
          gte(interactionEvents.createdAt, cutoff)
        )
      )
      .limit(1);
    if (dupes.length && kind !== "subscribe") return false;
  } catch {
    /* ignore */
  }

  const isChannelKind = kind === "subscribe" || kind === "unsubscribe";
  const ctx = isChannelKind ? { channelId: targetId, format: "long" as const } : await videoContext(targetId);

  try {
    await db.insert(interactionEvents).values({
      userKey,
      targetId,
      kind,
      weight: clamp(Number(weight) || 1, 0, 10),
      channelId: (isChannelKind ? targetId : extra.channelId ?? ctx.channelId).slice(0, 64),
      format: (extra.format ?? ctx.format) === "short" ? "short" : "long",
      source: String(extra.source ?? "").slice(0, 32),
    });
    invalidateProfile(userKey);
    return true;
  } catch {
    return false;
  }
}

export async function recordSearchEvent(userKey: string, query: string): Promise<boolean> {
  const clean = String(query || "").trim().slice(0, 160);
  if (!userKey || !clean || !isDatabaseConfigured) return false;
  try {
    await db.insert(searchEvents).values({ userKey, query: clean });
    invalidateProfile(userKey);
    return true;
  } catch {
    return false;
  }
}

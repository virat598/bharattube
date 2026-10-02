import { db, isDatabaseConfigured } from "@/db";
import { watchEvents, interactionEvents, searchEvents } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { ANTI_ABUSE } from "./config";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Event recording (point 24) with basic manipulation resistance (point 18).
 * ─────────────────────────────────────────────────────────────────────────
 * Events are written through the same-origin API route, so the client never
 * learns how they are weighted. Only the caller's own events are ever read
 * back — a viewer's history is never shared with another viewer.
 */

export type InteractionKind =
  | "like"
  | "dislike"
  | "comment"
  | "share"
  | "subscribe"
  | "unsubscribe"
  | "skip"
  | "rewatch";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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

  // Collapse rapid repeated views of the same video (point 18).
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
  let watchPct =
    input.watchPct != null
      ? clamp(Number(input.watchPct), 0, 1)
      : videoSeconds > 0
      ? clamp(watchSeconds / videoSeconds, 0, 1)
      : 0;

  if (input.completed) watchPct = Math.max(watchPct, 0.95);
  if (watchSeconds < ANTI_ABUSE.minMeaningfulWatchSec && watchPct < 0.05) return false;

  try {
    await db.insert(watchEvents).values({
      userKey,
      videoId,
      watchSeconds,
      videoSeconds,
      watchPct,
      completed: Boolean(input.completed) || watchPct >= 0.9,
    });
    return true;
  } catch {
    return false;
  }
}

export async function recordInteractionEvent(
  userKey: string,
  targetId: string,
  kind: InteractionKind,
  weight = 1
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

  try {
    await db.insert(interactionEvents).values({
      userKey,
      targetId,
      kind,
      weight: clamp(Number(weight) || 1, 0, 10),
    });
    return true;
  } catch {
    return false;
  }
}

export async function recordSearchEvent(userKey: string, query: string): Promise<boolean> {
  const clean = String(query || "").trim().slice(0, 160);
  if (!userKey || !clean) return false;
  try {
    await db.insert(searchEvents).values({ userKey, query: clean });
    return true;
  } catch {
    return false;
  }
}

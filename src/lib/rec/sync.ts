import { db, isDatabaseConfigured } from "@/db";
import { videosCache, syncState } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  CANDIDATE_SYNC_TTL_MS,
  SYNC_MAX_PAGES,
  SYNC_PAGE_SIZE,
} from "./config";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Candidate generation input: mirror a BROAD pool of videos from the existing
 * BharatTube backend into Postgres (metadata + engagement snapshot only).
 * ─────────────────────────────────────────────────────────────────────────
 * Point 20 explicitly forbids ranking over "the newest 10 videos", so this
 * walks several pages of both /videos and /shorts/feed. The Render backend
 * remains the storage system of record — nothing is duplicated as a new
 * source of truth, this is only a ranking input cache.
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

type AnyRecord = Record<string, any>;

function asArray(payload: any, keys: string[]): AnyRecord[] {
  const data = payload?.data ?? payload;
  for (const key of keys) {
    const value = data?.[key];
    if (Array.isArray(value)) return value;
  }
  if (Array.isArray(data)) return data;
  return [];
}

function pickId(v: AnyRecord): string {
  return String(v?._id ?? v?.id ?? v?.videoId ?? "").slice(0, 64);
}

function channelOf(v: AnyRecord): AnyRecord {
  const ch = v?.channel;
  return ch && typeof ch === "object" ? ch : {};
}

function num(...values: unknown[]): number {
  for (const value of values) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

async function fetchPage(path: string, page: number, limit: number): Promise<AnyRecord[]> {
  try {
    const res = await fetch(`${BACKEND_BASE}${path}?page=${page}&limit=${limit}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const payload = await res.json().catch(() => null);
    if (!payload) return [];
    return asArray(payload, ["videos", "shorts", "results", "items"]);
  } catch {
    return [];
  }
}

async function markSynced(scope: string, itemsSeen: number): Promise<void> {
  if (!isDatabaseConfigured) return;
  await db
    .insert(syncState)
    .values({ scope, itemsSeen, lastSyncedAt: new Date() })
    .onConflictDoNothing();
  await db
    .update(syncState)
    .set({ lastSyncedAt: new Date(), itemsSeen })
    .where(eq(syncState.scope, scope));
}

export async function lastSyncAge(scope: string): Promise<number> {
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

/**
 * Upsert one backend video into the ranking cache. `raw` is preserved so the
 * client-side adapter keeps behaving exactly as it does today.
 */
function toCacheRow(v: AnyRecord, isShort: boolean) {
  const channel = channelOf(v);
  const createdAtRaw = str(v.createdAt, v.updatedAt);
  const parsed = createdAtRaw ? new Date(createdAtRaw) : null;
  const tags = Array.isArray(v.tags)
    ? v.tags.map((t: unknown) => String(t)).slice(0, 30)
    : typeof v.tags === "string" && v.tags.trim()
    ? v.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30)
    : [];

  return {
    id: pickId(v),
    title: str(v.title).slice(0, 500),
    description: str(v.description).slice(0, 4000),
    category: str(v.category, channel.category).slice(0, 120),
    language: str(v.language).slice(0, 120),
    tags,
    channelId: str(channel._id, channel.id, v.channelId, v.userId).slice(0, 64),
    channelName: str(channel.channelName, channel.name, v.channelName).slice(0, 240),
    channelHandle: str(channel.handle, channel.username, v.channelHandle).slice(0, 240),
    durationSec: num(v.duration),
    isShort,
    views: num(v.views, v.viewsCount, v.viewCount),
    likesCount: num(v.likesCount, Array.isArray(v.likes) ? v.likes.length : 0),
    dislikesCount: num(v.dislikesCount, Array.isArray(v.dislikes) ? v.dislikes.length : 0),
    commentsCount: num(v.commentsCount),
    shares: num(v.shares),
    watchTimeSec: num(v.watchTime),
    viewsRecent: 0,
    raw: v as AnyRecord,
    sourceCreatedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    // Only publicly watchable videos are ever candidates (#20 step 2).
    visible: String(v.visibility ?? "public").toLowerCase() === "public",
    syncedAt: new Date(),
  };
}

let syncing: Promise<void> | null = null;

async function runSync(): Promise<void> {
  if (!isDatabaseConfigured) return;
  const seen = new Map<string, ReturnType<typeof toCacheRow>>();

  for (let page = 1; page <= SYNC_MAX_PAGES; page += 1) {
    const batch = await fetchPage("/videos", page, SYNC_PAGE_SIZE);
    if (!batch.length) break;
    for (const v of batch) {
      const id = pickId(v);
      if (id && !seen.has(id)) seen.set(id, toCacheRow(v, Boolean(v.isShort)));
    }
    if (batch.length < SYNC_PAGE_SIZE) break;
  }

  for (let page = 1; page <= SYNC_MAX_PAGES; page += 1) {
    const batch = await fetchPage("/shorts/feed", page, SYNC_PAGE_SIZE);
    if (!batch.length) break;
    for (const v of batch) {
      const id = pickId(v);
      if (id && !seen.has(id)) seen.set(id, toCacheRow(v, true));
    }
    if (batch.length < SYNC_PAGE_SIZE) break;
  }

  const rows = Array.from(seen.values()).filter((row) => row.id);
  if (rows.length) {
    const chunk = 60;
    for (let i = 0; i < rows.length; i += chunk) {
      await db
        .insert(videosCache)
        .values(rows.slice(i, i + chunk))
        .onConflictDoUpdate({
          target: videosCache.id,
          set: {
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            category: sql`excluded.category`,
            language: sql`excluded.language`,
            tags: sql`excluded.tags`,
            channelId: sql`excluded.channel_id`,
            channelName: sql`excluded.channel_name`,
            channelHandle: sql`excluded.channel_handle`,
            durationSec: sql`excluded.duration_sec`,
            isShort: sql`excluded.is_short`,
            views: sql`excluded.views`,
            likesCount: sql`excluded.likes_count`,
            dislikesCount: sql`excluded.dislikes_count`,
            commentsCount: sql`excluded.comments_count`,
            shares: sql`excluded.shares`,
            watchTimeSec: sql`excluded.watch_time_sec`,
            raw: sql`excluded.raw`,
            sourceCreatedAt: sql`excluded.source_created_at`,
            visible: sql`excluded.visible`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
    }
  }

  await markSynced("candidates", rows.length);
}

/**
 * Refresh the candidate pool when stale. Safe to call on every request: the
 * in-flight promise is shared, and a failure never breaks the feed (#26).
 */
export async function ensureCandidates(): Promise<void> {
  // No Postgres (e.g. Vercel serverless): there is no ranking cache to fill.
  // The caller serves the existing backend feed instead.
  if (!isDatabaseConfigured) return;
  const age = await lastSyncAge("candidates");
  if (age < CANDIDATE_SYNC_TTL_MS) return;
  if (!syncing) {
    syncing = runSync()
      .catch(() => undefined)
      .finally(() => {
        syncing = null;
      });
  }
  await syncing;
}

import type { CandidateRow } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Candidate pool straight from the existing BharatTube backend.
 * ─────────────────────────────────────────────────────────────────────────
 * This is the path that runs on Vercel, where there is no DATABASE_URL and so
 * no Postgres ranking cache. The Render backend stays the only source of
 * truth — nothing is duplicated, we simply read it directly and cache briefly
 * in module scope so one warm lambda does not re-fetch on every request.
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

const TTL_MS = 4 * 60 * 1000;
const MAX_PAGES = 4;
const PAGE_SIZE = 50;

type AnyRecord = Record<string, any>;

interface CacheEntry {
  at: number;
  longs: CandidateRow[];
  shorts: CandidateRow[];
}

const globalForCandidates = globalThis as typeof globalThis & {
  __bharattubeCandidateCache?: CacheEntry;
};

function asArray(payload: any): AnyRecord[] {
  const data = payload?.data ?? payload;
  for (const key of ["videos", "shorts", "results", "items"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Mirrors the field mapping the client adapter already uses. */
function toRow(v: AnyRecord): CandidateRow | null {
  const id = firstString(v._id, v.id, v.videoId).slice(0, 64);
  if (!id) return null;
  const channel = v.channel && typeof v.channel === "object" ? v.channel : {};
  const subs = channel.subscribers;
  const createdAtRaw = firstString(v.createdAt, v.updatedAt);
  const parsed = createdAtRaw ? new Date(createdAtRaw) : null;

  return {
    id,
    title: firstString(v.title).slice(0, 500),
    description: firstString(v.description).slice(0, 4000),
    category: firstString(v.category, channel.category).slice(0, 120),
    language: firstString(v.language).slice(0, 120),
    tags: Array.isArray(v.tags)
      ? v.tags.map((t: unknown) => String(t)).slice(0, 30)
      : typeof v.tags === "string" && v.tags.trim()
      ? v.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30)
      : [],
    channelId: firstString(channel._id, channel.id, v.channelId, v.userId).slice(0, 64),
    durationSec: firstNumber(v.duration),
    isShort: Boolean(v.isShort ?? v.short ?? v.aspectRatio === "9:16"),
    views: firstNumber(v.views, v.viewsCount, v.viewCount),
    likesCount: firstNumber(v.likesCount, Array.isArray(v.likes) ? v.likes.length : 0),
    dislikesCount: firstNumber(
      v.dislikesCount,
      Array.isArray(v.dislikes) ? v.dislikes.length : 0
    ),
    commentsCount: firstNumber(v.commentsCount),
    shares: firstNumber(v.shares),
    raw: v,
    sourceCreatedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    subscribers: Array.isArray(subs)
      ? subs.length
      : firstNumber(channel.subscribersCount, channel.subscriberCount),
  };
}

async function fetchList(path: string, authHeaders?: Record<string, string>): Promise<AnyRecord[]> {
  try {
    const res = await fetch(`${BACKEND_BASE}${path}`, {
      cache: "no-store",
      headers: authHeaders ?? undefined,
    });
    if (!res.ok) return [];
    const payload = await res.json().catch(() => null);
    return payload ? asArray(payload) : [];
  } catch {
    return [];
  }
}

/**
 * Loads the broad candidate pool. Several pages are walked deliberately so the
 * pool is not just "the newest 10" — older relevant videos must stay reachable.
 */
export async function loadBackendCandidates(
  authHeaders?: Record<string, string>
): Promise<{ longs: CandidateRow[]; shorts: CandidateRow[] }> {
  const cached = globalForCandidates.__bharattubeCandidateCache;
  if (cached && Date.now() - cached.at < TTL_MS) return cached;

  const byId = new Map<string, CandidateRow>();
  const longs: CandidateRow[] = [];
  const shorts: CandidateRow[] = [];

  const add = (v: AnyRecord) => {
    const row = toRow(v);
    if (!row) return;
    if (byId.has(row.id)) return;
    byId.set(row.id, row);
    (row.isShort ? shorts : longs).push(row);
  };

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchList(`/videos?page=${page}&limit=${PAGE_SIZE}`, authHeaders);
    if (!batch.length) break;
    for (const v of batch) add(v);
    if (batch.length < PAGE_SIZE) break;
  }

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchList(`/shorts/feed?page=${page}&limit=${PAGE_SIZE}`, authHeaders);
    if (!batch.length) break;
    for (const v of batch) add(v);
    if (batch.length < PAGE_SIZE) break;
  }

  // Only publicly watchable videos are ever candidates.
  const visible = (row: CandidateRow) =>
    String((row.raw as AnyRecord)?.visibility ?? "public").toLowerCase() === "public";

  const entry: CacheEntry = {
    at: Date.now(),
    longs: longs.filter(visible),
    shorts: shorts.filter(visible),
  };
  globalForCandidates.__bharattubeCandidateCache = entry;
  return entry;
}

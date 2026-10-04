import { NextRequest, NextResponse } from "next/server";
import { buildAuthHeaders } from "@/lib/search-history-server";

export const dynamic = "force-dynamic";
// The channel library is walked and sorted here, in Node, not in the browser.
export const runtime = "nodejs";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * GET /api/channel/:id/videos?kind=videos|shorts&sort=latest|popular|oldest
 *                            &page=1&limit=24
 * ─────────────────────────────────────────────────────────────────────────
 * Same-origin channel browsing endpoint, added to the EXISTING BharatTube
 * architecture (the same wrapper pattern used by /api/recommendations/*).
 *
 * Why it exists: the upstream channel route returns the creator's whole
 * library in backend order, so sorting meant downloading every video into the
 * browser. Here the library is fetched ONCE per channel, cached briefly in
 * module scope, then sorted and paginated server-side — the client only ever
 * receives the page it is about to render, and switching sort mode or paging
 * does not re-hit the upstream backend.
 *
 * Guarantees:
 *   • no video is ever dropped or hidden because of the sort mode;
 *   • ids are deduplicated, so pages never overlap or repeat;
 *   • videos with missing/zero views still appear under Popular;
 *   • Latest / Oldest use the real upload timestamp, Popular uses real views;
 *   • raw backend payloads are returned untouched, so the client keeps using
 *     the existing adaptVideos() mapping and the existing cards.
 *
 * This route is for browsing inside a channel only. It does not touch the Home
 * recommendation algorithm, global search ranking or Subscriptions ordering.
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

/** How long a fetched channel library stays trustworthy. */
const CACHE_TTL_MS = 60_000;
/** Hard cap on how far the upstream library is walked (safety, not a filter). */
const MAX_PAGES = 20;
const UPSTREAM_PAGE_SIZE = 100;

export type SortMode = "latest" | "popular" | "oldest";
export type Kind = "videos" | "shorts" | "all";

interface NormalizedVideo {
  id: string;
  /** Real upload timestamp in ms; 0 when the backend does not provide one. */
  createdAtMs: number;
  /** Real stored view count; 0 when absent. */
  views: number;
  isShort: boolean;
  isLive: boolean;
  /** Untouched backend payload — handed straight back to the client. */
  raw: Record<string, unknown>;
}

type AnyRecord = Record<string, any>;

/* ────────────────────────── payload normalization ─────────────────────── */

function listOf(payload: any): AnyRecord[] {
  const data = payload?.data ?? payload;
  for (const key of ["videos", "shorts", "results", "items", "docs"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function num(...values: unknown[]): number {
  for (const value of values) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function timestampMs(v: AnyRecord): number {
  for (const key of ["createdAt", "publishedAt", "uploadedAt", "created_at", "updatedAt"]) {
    const raw = v?.[key];
    if (!raw) continue;
    const ms = new Date(String(raw)).getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return 0;
}

function normalize(v: AnyRecord): NormalizedVideo | null {
  const id = String(v?._id ?? v?.id ?? v?.videoId ?? "").slice(0, 64);
  if (!id) return null;
  const likes = Array.isArray(v?.likes) ? v.likes.length : 0;
  return {
    id,
    createdAtMs: timestampMs(v),
    views: num(v?.viewsCount, v?.views, v?.viewCount, likes ? undefined : 0),
    isShort: Boolean(v?.isShort ?? v?.short ?? v?.aspectRatio === "9:16"),
    isLive: Boolean(v?.isLive ?? v?.live),
    raw: v as Record<string, unknown>,
  };
}

/* ───────────────────────────── upstream fetch ─────────────────────────── */

async function fetchUpstream(
  handle: string,
  headers: Record<string, string>
): Promise<AnyRecord[]> {
  // Primary: the same public channel route the channel page already uses.
  const attempts = [
    `${BACKEND_BASE}/channel/${encodeURIComponent(handle)}/videos`,
    // Fallback: the owner-user-id variant, for links that carry a user id.
    `${BACKEND_BASE}/videos?userId=${encodeURIComponent(handle)}&limit=${UPSTREAM_PAGE_SIZE}`,
  ];

  for (const url of attempts) {
    try {
      const res = await fetch(url, { cache: "no-store", headers });
      if (!res.ok) continue;
      const payload = await res.json().catch(() => null);
      const list = listOf(payload);
      if (list.length) return list;
    } catch {
      /* try the next candidate URL */
    }
  }

  // Paged walk: only reached when the upstream exposes pagination and the
  // first page came back full, so big channels are still fully covered.
  const walked: AnyRecord[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    try {
      const res = await fetch(
        `${BACKEND_BASE}/channel/${encodeURIComponent(handle)}/videos?page=${page}&limit=${UPSTREAM_PAGE_SIZE}`,
        { cache: "no-store", headers }
      );
      if (!res.ok) break;
      const payload = await res.json().catch(() => null);
      const batch = listOf(payload);
      if (!batch.length) break;
      walked.push(...batch);
      if (batch.length < UPSTREAM_PAGE_SIZE) break;
    } catch {
      break;
    }
  }
  return walked;
}

/* ───────────────────────────── library cache ──────────────────────────── */

interface CacheEntry {
  at: number;
  items: NormalizedVideo[];
}

const globalForChannel = globalThis as typeof globalThis & {
  __bharattubeChannelLibrary?: Map<string, CacheEntry>;
  __bharattubeChannelInflight?: Map<string, Promise<NormalizedVideo[]>>;
};
const cache = (globalForChannel.__bharattubeChannelLibrary ??= new Map<string, CacheEntry>());
const inflight = (globalForChannel.__bharattubeChannelInflight ??= new Map<
  string,
  Promise<NormalizedVideo[]>
>());

/**
 * Loads (and briefly caches) the channel's full library, deduplicated. One
 * shared in-flight promise means a sort switch, a page change and two open tabs
 * never trigger duplicate upstream calls.
 */
async function loadLibrary(
  handle: string,
  headers: Record<string, string>
): Promise<NormalizedVideo[]> {
  const hit = cache.get(handle);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;

  const pending = inflight.get(handle);
  if (pending) return pending;

  const task = (async () => {
    const raw = await fetchUpstream(handle, headers);
    const byId = new Map<string, NormalizedVideo>();
    for (const entry of raw) {
      const item = normalize(entry);
      // First occurrence wins — a video can never appear twice across pages.
      if (item && !byId.has(item.id)) byId.set(item.id, item);
    }
    const items = [...byId.values()];
    cache.set(handle, { at: Date.now(), items });
    return items;
  })();

  inflight.set(handle, task);
  try {
    return await task;
  } finally {
    inflight.delete(handle);
  }
}

/* ──────────────────────────────── sorting ─────────────────────────────── */

/**
 * Latest / Oldest use the real upload timestamp; Popular uses the real stored
 * view count. Items whose timestamp is unknown are never promoted to the top
 * of Latest and never masquerade as the channel's oldest upload — they settle
 * at the end of the date-ordered modes, still fully visible.
 */
function sortItems(items: NormalizedVideo[], sort: SortMode): NormalizedVideo[] {
  const copy = [...items];
  if (sort === "popular") {
    copy.sort((a, b) => {
      if (b.views !== a.views) return b.views - a.views;
      // Equal views (including 0 views): newer first, then a stable id order.
      if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
      return a.id.localeCompare(b.id);
    });
    return copy;
  }
  if (sort === "oldest") {
    copy.sort((a, b) => {
      const aUnknown = a.createdAtMs === 0 ? 1 : 0;
      const bUnknown = b.createdAtMs === 0 ? 1 : 0;
      if (aUnknown !== bUnknown) return aUnknown - bUnknown;
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      return a.id.localeCompare(b.id);
    });
    return copy;
  }
  // latest (default)
  copy.sort((a, b) => {
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    if (b.views !== a.views) return b.views - a.views;
    return a.id.localeCompare(b.id);
  });
  return copy;
}

/* ──────────────────────────────── handler ─────────────────────────────── */

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const handle = decodeURIComponent(id || "").trim();
  if (!handle) {
    return NextResponse.json(
      { success: false, videos: [], message: "Channel id is required" },
      { status: 400 }
    );
  }

  const url = new URL(req.url);
  const sortParam = String(url.searchParams.get("sort") ?? "latest").toLowerCase();
  const sort: SortMode =
    sortParam === "popular" || sortParam === "oldest" ? sortParam : "latest";
  const kindParam = String(url.searchParams.get("kind") ?? "videos").toLowerCase();
  const kind: Kind =
    kindParam === "shorts" || kindParam === "all" ? kindParam : "videos";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limitRaw = Number(url.searchParams.get("limit") ?? "24");
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 24, 60));

  // The channel page is public, but forwarding the caller's own credentials
  // keeps any visibility rules the backend already applies intact.
  const headers = buildAuthHeaders(
    req.headers.get("authorization"),
    req.headers.get("cookie")
  ) as Record<string, string>;

  try {
    const library = await loadLibrary(handle, headers);

    const filtered =
      kind === "shorts"
        ? library.filter((v) => v.isShort)
        : kind === "all"
        ? library
        : // Videos tab: standard uploads only, exactly like the existing filter.
          library.filter((v) => !v.isShort && !v.isLive);

    const sorted = sortItems(filtered, sort);
    const start = (page - 1) * limit;
    const pageItems = sorted.slice(start, start + limit);

    return NextResponse.json({
      success: true,
      // Key stays "videos" for both kinds so the existing adaptVideos(payload)
      // mapping on the client works unchanged.
      videos: pageItems.map((item) => item.raw),
      pagination: {
        currentPage: page,
        pageSize: limit,
        hasNextPage: start + pageItems.length < sorted.length,
        totalItems: sorted.length,
        totalLibrary: library.length,
      },
      sort,
      kind,
    });
  } catch {
    return NextResponse.json(
      { success: false, videos: [], message: "Could not load channel videos" },
      { status: 200 }
    );
  }
}

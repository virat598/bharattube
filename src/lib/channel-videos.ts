"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Channel video sorting — client helpers.
 * ─────────────────────────────────────────────────────────────────────────
 * Sorting itself happens server-side in /api/channel/:id/videos, so a large
 * channel never has to be downloaded into the browser to be reordered. This
 * module only holds the shared option list, the per-channel persistence and a
 * thin fetch wrapper.
 *
 * Scope: browsing inside a channel. The Home recommendation algorithm, global
 * search ranking and Subscriptions ordering are untouched.
 */

export type ChannelSortMode = "latest" | "popular" | "oldest";
export type ChannelSectionKind = "videos" | "shorts";

/** YouTube-style compact chip labels, in the order they are rendered. */
export const CHANNEL_SORT_OPTIONS: Array<{ value: ChannelSortMode; label: string }> = [
  { value: "latest", label: "Latest" },
  { value: "popular", label: "Popular" },
  { value: "oldest", label: "Oldest" },
];

export const DEFAULT_CHANNEL_SORT: ChannelSortMode = "latest";

/** Page size used by the channel Videos / Shorts grids. */
export const CHANNEL_PAGE_SIZE = 24;

const STORAGE_PREFIX = "bharattube_channel_sort_v1";

function storageKey(channelKey: string, kind: ChannelSectionKind): string {
  return `${STORAGE_PREFIX}:${channelKey}:${kind}`;
}

export function isChannelSortMode(value: unknown): value is ChannelSortMode {
  return value === "latest" || value === "popular" || value === "oldest";
}

/**
 * The sort this viewer last chose for one section of one channel. Returning
 * null (rather than a default) lets the caller distinguish "never chosen" from
 * "explicitly Latest", and keeps the persisted choice authoritative.
 */
export function readChannelSort(
  channelKey: string,
  kind: ChannelSectionKind
): ChannelSortMode | null {
  if (typeof window === "undefined" || !channelKey) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(channelKey, kind));
    return isChannelSortMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Remembers the choice per channel and per section, so opening a video and
 * pressing Back returns to the same channel with the same sort still applied —
 * it is never silently reset to Latest.
 */
export function writeChannelSort(
  channelKey: string,
  kind: ChannelSectionKind,
  sort: ChannelSortMode
): void {
  if (typeof window === "undefined" || !channelKey) return;
  try {
    window.localStorage.setItem(storageKey(channelKey, kind), sort);
  } catch {
    /* private mode / full storage: the in-memory state still applies */
  }
}

export interface ChannelVideoPage {
  videos: unknown[];
  hasNextPage: boolean;
  currentPage: number;
  totalItems: number;
}

/**
 * Fetches one sorted page for one channel section. Returns null when the
 * endpoint is unavailable so the caller can fall back to the library it has
 * already loaded instead of showing an empty grid.
 */
export async function fetchChannelVideoPage(
  channelKey: string,
  kind: ChannelSectionKind,
  sort: ChannelSortMode,
  page: number,
  limit = CHANNEL_PAGE_SIZE
): Promise<ChannelVideoPage | null> {
  if (!channelKey) return null;
  try {
    const query = new URLSearchParams({
      kind,
      sort,
      page: String(page),
      limit: String(limit),
    });
    const res = await fetch(
      `/api/channel/${encodeURIComponent(channelKey)}/videos?${query.toString()}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      success?: boolean;
      videos?: unknown[];
      pagination?: { hasNextPage?: boolean; currentPage?: number; totalItems?: number };
    } | null;
    if (!payload || payload.success === false || !Array.isArray(payload.videos)) return null;
    return {
      videos: payload.videos,
      hasNextPage: Boolean(payload.pagination?.hasNextPage),
      currentPage: Number(payload.pagination?.currentPage) || page,
      totalItems: Number(payload.pagination?.totalItems) || payload.videos.length,
    };
  } catch {
    return null;
  }
}

/**
 * Client-side fallback sorter, used ONLY when the endpoint above is
 * unreachable (for example an offline backend). It mirrors the server rules so
 * the grid still behaves correctly, and never hides a video: items with an
 * unknown timestamp settle at the end of the date-ordered modes.
 */
export function sortAdaptedVideos<
  T extends { id: string | number; viewsCount?: number; createdAt?: string }
>(items: T[], sort: ChannelSortMode): T[] {
  const ms = (item: T) => {
    const parsed = item.createdAt ? new Date(item.createdAt).getTime() : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const views = (item: T) => Number(item.viewsCount) || 0;
  const copy = [...items];

  if (sort === "popular") {
    copy.sort((a, b) => {
      if (views(b) !== views(a)) return views(b) - views(a);
      if (ms(b) !== ms(a)) return ms(b) - ms(a);
      return String(a.id).localeCompare(String(b.id));
    });
    return copy;
  }
  if (sort === "oldest") {
    copy.sort((a, b) => {
      const aUnknown = ms(a) === 0 ? 1 : 0;
      const bUnknown = ms(b) === 0 ? 1 : 0;
      if (aUnknown !== bUnknown) return aUnknown - bUnknown;
      if (ms(a) !== ms(b)) return ms(a) - ms(b);
      return String(a.id).localeCompare(String(b.id));
    });
    return copy;
  }
  copy.sort((a, b) => {
    if (ms(b) !== ms(a)) return ms(b) - ms(a);
    if (views(b) !== views(a)) return views(b) - views(a);
    return String(a.id).localeCompare(String(b.id));
  });
  return copy;
}

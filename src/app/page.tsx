"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";

import { PlusCircle } from "lucide-react";
import { MixedFeed } from "@/components/MixedFeed";
import { VIDEO_CATEGORIES, formatDuration, formatCount } from "@/lib/format";
import {
  VideoItem,
  EmptyState,
  ErrorState,
} from "@/components/VideoComponents";
import { useApp } from "@/context/AppContext";
import { apiUrl } from "@/lib/api-config";
import { adaptVideos } from "@/lib/backend-adapter";
import { fetchRecommendedHome, fetchRecommendedShorts } from "@/lib/rec-feed";
import { rotateFeedSession } from "@/lib/rec-client";



/* ------------------------------------------------------------------ */
/* Instant-load cache: last good home feed, shown immediately on boot   */
/* while fresh data revalidates in the background (stale-while-         */
/* revalidate). This is what makes the app feel instant even when the   */
/* Render backend is cold-starting.                                     */
/* ------------------------------------------------------------------ */

const HOME_CACHE_KEY = "bharattube_home_base_v1";
const HOME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Upper bound on how long the FIRST paint waits for the Shorts response. Long
 * videos and Shorts are fetched in parallel and painted together, so one frame
 * is enough — but a hung Shorts endpoint must never hold the whole feed back.
 * If this expires the feed paints without Shorts and folds them in on arrival.
 */
const SHORTS_FIRST_PAINT_TIMEOUT_MS = 8000;

function readHomeCache(): VideoItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(HOME_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { base?: unknown; ts?: unknown };
    if (!Array.isArray(parsed.base) || typeof parsed.ts !== "number") return [];
    if (Date.now() - parsed.ts > HOME_CACHE_TTL_MS) return [];
    // Basic shape check so a corrupt entry never breaks rendering.
    return (parsed.base as VideoItem[]).filter(
      (v) => v && typeof v === "object" && v.id !== undefined
    );
  } catch {
    return [];
  }
}

function writeHomeCache(base: VideoItem[]) {
  if (typeof window === "undefined" || base.length === 0) return;
  try {
    // Cap size so the entry stays small. This must stay well above one page:
    // the user often opens a video, watches it, and comes back — restoring only
    // the first page made everything they had already scrolled to disappear.
    const slim = base.slice(0, 400);
    localStorage.setItem(
      HOME_CACHE_KEY,
      JSON.stringify({ base: slim, ts: Date.now() })
    );
  } catch {
    /* storage full/blocked — caching is best-effort only */
  }
}

async function timedFetch(url: string, init: RequestInit = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Videos per home page request. Using 50 ensures all currently uploaded long
 * videos from all creators are fetched and immediately visible in the feed,
 * while pagination seamlessly handles any larger library.
 */
const HOME_PAGE_SIZE = 50;
/** Shorts pulled per ranked request — wide enough to cover the whole library. */
const SHORTS_PAGE_SIZE = 100;

/**
 * Reads the backend's real pagination envelope so the feed knows whether more
 * eligible videos exist. Shape: { data: { pagination: { hasNextPage, currentPage,
 * totalPages, totalVideos } } }. Falls back to safe defaults if absent.
 */
function readPagination(payload: unknown): {
  hasNext: boolean;
  currentPage: number;
  totalPages: number;
} {
  const root = payload as Record<string, any> | null;
  const p = root?.data?.pagination ?? root?.pagination ?? {};
  const currentPage = Number(p?.currentPage) || 1;
  const totalPages = Number(p?.totalPages) || 0;
  const hasNext =
    typeof p?.hasNextPage === "boolean"
      ? p.hasNextPage
      : totalPages > 0
      ? currentPage < totalPages
      : false;
  return { hasNext, currentPage, totalPages };
}

export default function HomePage() {
  const { user, openUploadModal, feedRefreshTrigger } = useApp();

  const [selectedCategory, setSelectedCategory] = useState("All");
  /**
   * `baseVideos` = full merged feed (all categories). Loaded once, then
   * category filtering happens instantly on the client via useMemo — so
   * category taps and login/logout never trigger a full reload + spinner.
   */
  // NOTE: intentionally NOT initialized from localStorage — that would differ
  // between server render and first client render (hydration mismatch →
  // "Something went wrong"). Cache is applied in the mount effect below.
  const [baseVideos, setBaseVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  /** Infinite pagination: more eligible videos exist on the backend. */
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const userId = user?.id != null ? String(user.id) : null;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  /** Increments per request so a slow, older response can never win. */
  const requestSeqRef = useRef(0);
  /** True once the signed-in background refresh has run (avoids refetch loops). */
  const authedRefreshDoneRef = useRef(false);
  /** Last page successfully loaded, and a guard so loadMore never overlaps. */
  const loadedPageRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  /** Live snapshot of loaded videos for dedupe without stale closures. */
  const baseVideosRef = useRef<VideoItem[]>([]);
  baseVideosRef.current = baseVideos;

  /**
   * FAST home feed loader (stale-while-revalidate).
   *
   * Why the app used to feel slow:
   *  - every mount / category tap / login re-fetched the whole feed and showed
   *    a full-screen spinner, even when videos were already on screen;
   *  - the main /videos response waited for shorts before rendering;
   *  - the Render backend cold-starts (30s+), and there was no cache.
   *
   * Now:
   *  - base feed (videos + shorts) loads ONCE per mount/refresh, independent
   *    of category and login state; category filtering is instant,
   *    client-side — category taps never hit the network;
   *  - cached feed paints immediately (no blocking spinner with warm cache);
   *  - network revalidates silently in the background (`refreshing` dot).
   *  - watch history is never consulted here: home always shows the full
   *    feed, so the feed can never go empty because of history.
   */
  const hasBaseRef = useRef(false);

  const fetchBaseData = useCallback(async (opts?: { silent?: boolean; preserveOrder?: boolean; rotate?: boolean }) => {
    const seq = ++requestSeqRef.current;
    const isCurrent = () => seq === requestSeqRef.current;
    // Was the feed already populated BEFORE this run? A refresh (upload/login)
    // must PRESERVE everything already loaded (incl. pages 2,3… from infinite
    // scroll) and only fold in new videos — never shrink back to page 1.
    const wasLoaded = hasBaseRef.current && baseVideosRef.current.length > 0;
    const silent = Boolean(opts?.silent) || hasBaseRef.current;
    /**
     * App open with a warm cache must not visibly "refresh". The order already
     * on screen is kept, the background revalidation only folds in fresh
     * metadata and genuinely new videos, and no spinner / refreshing dot is
     * shown. A NEW ranking session (rotate + full re-rank) is started only on
     * an explicit refresh, so the feed still never goes stale.
     */
    const preserveOrder = Boolean(opts?.preserveOrder) && wasLoaded;
    if (opts?.rotate) rotateFeedSession();
    if (!preserveOrder) {
      if (silent) setRefreshing(true);
      else setLoading(true);
    }
    setError("");

      const uid = userIdRef.current;
      try {
        // Page 1 + Shorts are fetched in parallel and painted TOGETHER, so the
        // very first frame is already the complete feed. Home is ranked
        // server-side per viewer; the chronological backend URL is kept as a
        // fallback so the feed can never fail to render.
      // Fetch the full Shorts list (not just a preview): many creators upload
      // ONLY Shorts, so capping this hid their entire content from Home. The
      // personalised Shorts ranking is used so which Short appears where in the
      // feed follows the viewer's behaviour; the chronological endpoint stays
      // as a fallback so this can never blank the section.
      //
      // Started BEFORE the Home request is awaited: both surfaces now fly in
      // parallel. Previously the Shorts call was only created after the ranked
      // Home response had fully arrived, so the first complete frame cost an
      // extra serial round trip (that is the one-second gap where only long
      // videos were on screen).
      const shortsPromise = fetchRecommendedShorts(1, SHORTS_PAGE_SIZE)
        .then((payload) => payload ?? null)
        .catch(() => null);

        const rankedFirst = await fetchRecommendedHome(1, HOME_PAGE_SIZE);
        const videosPromise = rankedFirst
          ? Promise.resolve(new Response(JSON.stringify(rankedFirst)))
          : timedFetch(
              apiUrl(`/videos?feed=home&page=1&limit=${HOME_PAGE_SIZE}`),
              { cache: "no-store" },
              30000
            );

      const videoRes = await videosPromise;
      if (!videoRes.ok) {
        const body = await videoRes.json().catch(() => ({}));
        throw new Error(body?.message || `Server responded ${videoRes.status}`);
      }
      const videoData = await videoRes.json();
      if (!isCurrent()) return;

      const mainVideos = adaptVideos(videoData, "videos", {
        currentUserId: uid,
      }) as unknown as VideoItem[];

      const { hasNext } = readPagination(videoData);
      loadedPageRef.current = 1;
      hasMoreRef.current = hasNext;
      setHasMore(hasNext);

      // Paint helper: merges the Shorts preview when it arrives (progressive).
      const paintBase = (shortsData: unknown) => {
        if (!isCurrent()) return;
        // When this pass carries no Shorts payload, keep the Shorts that are
        // already on screen. Dropping them here was what made the feed lose its
        // Shorts for the second or two between the two paint phases.
        const feedShorts = shortsData
          ? (adaptVideos(shortsData, "shorts", { currentUserId: uid }) as unknown as VideoItem[])
          : baseVideosRef.current.filter((v) => v.isShort);

        // Page-1 videos (+ shorts preview), deduped, in backend order.
        const pageById = new Map<string, VideoItem>();
        for (const v of mainVideos) pageById.set(String(v.id), v);
        for (const s of feedShorts) {
          const key = String(s.id);
          const existing = pageById.get(key);
          pageById.set(key, existing ? { ...existing, ...s, isShort: true } : { ...s, isShort: true });
        }
        const pageVideos = Array.from(pageById.values());

        let merged: VideoItem[];
        if (preserveOrder) {
          // Keep exactly what the viewer is already looking at: same order, no
          // reshuffle. Fresh view/like metadata is folded into the existing
          // items and only videos that are not on screen yet get appended.
          const freshById = new Map(pageVideos.map((v) => [String(v.id), v]));
          const onScreen = baseVideosRef.current.map((v) => {
            const fresh = freshById.get(String(v.id));
            return fresh ? { ...v, ...fresh } : v;
          });
          const seen = new Set(onScreen.map((v) => String(v.id)));
          const additions = pageVideos.filter((v) => !seen.has(String(v.id)));
          merged = additions.length ? [...onScreen, ...additions] : onScreen;
        } else if (wasLoaded && baseVideosRef.current.length > pageVideos.length) {
          // If user had already scrolled to later pages (pages 2, 3...), keep those
          // later videos appended so they don't vanish on a background revalidate.
          const pageIds = new Set(pageVideos.map((v) => String(v.id)));
          const laterPageVideos = baseVideosRef.current.filter((v) => !pageIds.has(String(v.id)));
          merged = [...pageVideos, ...laterPageVideos];
        } else {
          merged = pageVideos;
        }

        hasBaseRef.current = true;
        setBaseVideos(merged);
        writeHomeCache(merged);
        setLoading(false);
        setRefreshing(false);
      };

      /**
       * ONE atomic paint — for a cold open and for a refresh alike.
       *
       * Long-form and Shorts are already requested in parallel above. The first
       * frame the viewer sees is now the real, complete feed: longs AND Shorts
       * in their final interleaved layout, with nothing popping in afterwards.
       * The previous two-phase paint (longs immediately, Shorts one or two
       * seconds later) is exactly what made the screen look like it refreshed
       * itself and made the Shorts appear with a jump on every app open.
       */
      const shortsData = await Promise.race([
        shortsPromise,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), SHORTS_FIRST_PAINT_TIMEOUT_MS);
        }),
      ]);
      if (!isCurrent()) return;
      paintBase(shortsData);

      if (!shortsData) {
        // Rare fallback only: the Shorts response was still pending when the
        // timeout expired. Fold it in the moment it lands — still no blank or
        // reshuffled frame, just the Shorts arriving late.
        const late = await shortsPromise.catch(() => null);
        if (late && isCurrent()) paintBase(late);
      }
    } catch (err) {
      if (!isCurrent()) return;
      // With content on screen, a failed refresh must never blank the page.
      if (!hasBaseRef.current) {
        const aborted = (err as Error)?.name === "AbortError";
        setError(
          aborted
            ? "The video server is waking up — please retry in a few seconds."
            : err instanceof TypeError
            ? "Network error — check your connection and retry."
            : (err as Error)?.message || "Unable to load videos from server."
        );
      }
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // NOTE: watch history is intentionally NOT used on the home page at all —
  // no hiding of watched videos, no Continue Watching row. Home always shows
  // the full feed (like YouTube). History lives on the /history page only.

  // Base feed: paint cache instantly on mount, then revalidate silently.
  // Runs once on mount + on explicit refresh (e.g. after upload).
  /** True only for the very first run — i.e. the moment the app is opened. */
  const initialOpenRef = useRef(true);

  useEffect(() => {
    const cached = readHomeCache();
    if (cached.length > 0) {
      hasBaseRef.current = true;
      setBaseVideos(cached);
      // Sync the ref in the SAME tick. `fetchBaseData` below reads it to decide
      // whether content is already on screen; React only updates the ref on the
      // next render, so without this line the loader believed the feed was
      // empty, skipped order-preservation and painted a "longs only" frame —
      // which is exactly why the Shorts blinked out for a second on open.
      baseVideosRef.current = cached;
      setLoading(false);
    }
    const isOpen = initialOpenRef.current;
    initialOpenRef.current = false;
    // App open → reuse the existing ranking session and keep the order that is
    // already painted, so the screen never visibly reloads. Every later run is
    // an explicit refresh (upload / triggerFeedRefresh) and does a full
    // personalised re-rank with a new session token.
    fetchBaseData({
      silent: cached.length > 0,
      preserveOrder: isOpen && cached.length > 0,
      rotate: !isOpen,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRefreshTrigger]);

  // One silent revalidate after login so like-states are correct (no spinner,
  // and exactly once — no refetch loop when the context replaces `user`).
  useEffect(() => {
    if (userId && !authedRefreshDoneRef.current) {
      authedRefreshDoneRef.current = true;
      // Purpose of this pass is correct like-states, not a re-rank: keeping the
      // on-screen order means signing in never makes the feed jump either.
      fetchBaseData({ silent: true, preserveOrder: true });
    }
    if (!userId) authedRefreshDoneRef.current = false;
  }, [userId, fetchBaseData]);

  /**
   * Instant client-side filtering: category taps never hit the network.
   *
   * Derived with useMemo (NOT useEffect + setState) on purpose: when
   * `baseVideos` updates, `videos` is computed in the SAME render. The old
   * effect-based version left one render where base was set but `videos` was
   * still [] — flashing the "No videos available yet" card on every app open.
   */
  const videos: VideoItem[] = React.useMemo(() => {
    if (selectedCategory === "All") return baseVideos;
    const want = selectedCategory.toLowerCase();
    return baseVideos.filter((item) => item.category?.toLowerCase() === want);
  }, [baseVideos, selectedCategory]);

  const fetchHomeData = useCallback(() => {
    fetchBaseData();
  }, [fetchBaseData]);

  /**
   * Infinite pagination: fetch the next page of eligible videos and append
   * them (deduped by id). Keeps going page-by-page until the backend's
   * `hasNextPage` is false — so NO creator's eligible video is left out just
   * because it sits on a later page. Guarded against overlap and stale runs.
   */
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const uid = userIdRef.current;
    let page = loadedPageRef.current;
    let stillMore = true;
    const collected: VideoItem[] = [];
    try {
      // The ranking is personalised, so it legitimately moves as the viewer
      // watches, likes and subscribes. That means "page 2" is not a fixed set:
      // a single page request can come back entirely full of videos we already
      // show, which used to stall the feed here and permanently skip every
      // video ranked behind them. Keep walking pages until at least one video
      // that is genuinely new to this session is found, or the library ends.
      for (let guard = 0; guard < 6 && stillMore && collected.length === 0; guard += 1) {
        page += 1;
        // Later pages stay personalised too (point 22): rank, then fall back.
        const ranked = await fetchRecommendedHome(page, HOME_PAGE_SIZE);
        const res = ranked
          ? new Response(JSON.stringify(ranked))
          : await timedFetch(
              apiUrl(`/videos?feed=home&page=${page}&limit=${HOME_PAGE_SIZE}`),
              { cache: "no-store" },
              20000
            );
        if (!res.ok) break;
        const data = await res.json();
        const incoming = adaptVideos(data, "videos", {
          currentUserId: uid,
        }) as unknown as VideoItem[];
        stillMore = readPagination(data).hasNext;

        const known = new Set([
          ...baseVideosRef.current.map((v) => String(v.id)),
          ...collected.map((v) => String(v.id)),
        ]);
        for (const v of incoming) {
          if (!known.has(String(v.id))) {
            known.add(String(v.id));
            collected.push(v);
          }
        }
      }

      if (collected.length) {
        setBaseVideos((prev) => {
          const seen = new Set(prev.map((v) => String(v.id)));
          const fresh = collected.filter((v) => !seen.has(String(v.id)));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      }
      loadedPageRef.current = page;
      // Stop only when the backend has genuinely nothing further to offer.
      hasMoreRef.current = stillMore;
      setHasMore(stillMore);
    } catch {
      /* transient — the sentinel will retry on the next scroll */
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-3 sm:py-4 max-w-[1700px] mx-auto">
      {/* Sticky Category Filter Bar */}
      <div className="sticky top-14 z-20 bg-zinc-50/95 dark:bg-[#0F0F0F]/95 backdrop-blur-md py-2.5 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 mb-5">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          {VIDEO_CATEGORIES.map((cat) => {
            const active = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`shrink-0 h-9 px-3.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  active
                    ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950"
                    : "bg-zinc-200/70 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                }`}
              >
                {cat}
              </button>
            );
          })}
          {refreshing && videos.length > 0 && (
            <span
              className="shrink-0 ml-1 self-center w-4 h-4 rounded-full border-2 border-zinc-300 dark:border-zinc-700 border-t-red-600 animate-spin"
              aria-label="Refreshing feed"
            />
          )}
        </div>
      </div>

      {/* Main Feed — spinner only when there is truly nothing to show */}
      {loading && videos.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
          <div className="w-10 h-10 rounded-full border-4 border-zinc-200 dark:border-zinc-700 border-t-red-600 animate-spin" />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Loading videos…
          </p>
        </div>
      ) : error && videos.length === 0 ? (
        <ErrorState message={error} onRetry={fetchHomeData} />
      ) : videos.length === 0 ? (
        <EmptyState
          title="No videos available yet"
          description={
            selectedCategory === "All"
              ? "The video catalog is currently empty. Be the first creator to upload and publish a real video or vertical Short."
              : `No videos have been published in the "${selectedCategory}" category yet.`
          }
          actionLabel="Upload a Video"
          onAction={openUploadModal}
          icon={<PlusCircle className="w-7 h-7 text-red-500" />}
        />
      ) : (
        <div>
          {/* One continuous vertical feed. Long videos and Shorts are interleaved
              in a fixed repeating rhythm (1 long → 2 Shorts → 2 Shorts → 3 long →
              …). There is no horizontal Shorts carousel anywhere on this page. */}
          {/* `key` remounts the feed on a category switch only, which resets how
                  far the feed has scrolled through its cycles. An upload refresh
                  deliberately does NOT remount it: remounting recreated every
                  card and thumbnail at once, which flashed the whole feed for a
                  second or two. New data flows in through the `videos` prop and
                  React reconciles the existing cards in place. */}
          <MixedFeed
            key={selectedCategory}
            videos={videos}
            hasMoreLongs={hasMore}
            loadingMore={loadingMore}
            onRequestMore={loadMore}
          />
        </div>
      )}
    </div>
  );
}

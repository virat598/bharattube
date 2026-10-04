"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { VideoCard, type VideoItem } from "@/components/VideoComponents";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Continuous vertical Home feed that interleaves long videos and Shorts.
 * ─────────────────────────────────────────────────────────────────────────
 * Shorts are NOT a horizontal carousel here. Every Short is a portrait card
 * inside a 2-column grid, and the whole page scrolls top-to-bottom in one
 * continuous feed.
 *
 * The order of long vs Short is dictated by this fixed repeating cycle — it is
 * deliberately NOT randomised, so the rhythm of the page is always the same:
 *
 *   1 long → 2 Shorts → 2 Shorts → 3 long → 2 Shorts → 2 Shorts → 3 long → (repeat)
 *
 * That is 4 long videos and 4 Shorts per cycle. Selection WITHIN each surface
 * already comes from the existing personalised recommendation endpoints, so
 * which specific videos fill these slots is personalised; only the shape of
 * the feed is fixed here.
 */

/** One repeating cycle of the feed, exactly as specified. */
const CYCLE: Array<{ kind: "long" | "short"; count: number }> = [
  { kind: "long", count: 1 },
  { kind: "short", count: 2 },
  { kind: "short", count: 2 },
  { kind: "long", count: 3 },
  { kind: "short", count: 2 },
  { kind: "short", count: 2 },
  { kind: "long", count: 3 },
];

const LONGS_PER_CYCLE = CYCLE.reduce((n, b) => (b.kind === "long" ? n + b.count : n), 0);
const SHORTS_PER_CYCLE = CYCLE.reduce((n, b) => (b.kind === "short" ? n + b.count : n), 0);

/** How many cycles to render before the user scrolls. */
const INITIAL_CYCLES = 2;
const CYCLES_PER_BATCH = 1;

/** A Short with neither a playable URL nor a thumbnail can never render. */
function usable(v: VideoItem): boolean {
  return Boolean(v && String(v.id) && (v.videoUrl || v.thumbnailUrl));
}

/** Portrait Short card for the 2-column grid. Thumbnail only — never a <video>. */
function ShortCell({ short }: { short: VideoItem }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const showImage = Boolean(short.thumbnailUrl) && !thumbFailed;

  return (
    <Link
      href={`/shorts?id=${short.id}`}
      className="group flex flex-col min-w-0 w-full select-none"
    >
      <div className="relative w-full aspect-[9/16] rounded-lg overflow-hidden bg-zinc-200 dark:bg-zinc-800">
        {showImage ? (
          <img
            src={short.thumbnailUrl}
            alt={short.title}
            loading="lazy"
            decoding="async"
            onError={() => setThumbFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-zinc-300 to-zinc-400 dark:from-zinc-700 dark:to-zinc-800" />
        )}

        {/* Title sits inside the thumbnail, YouTube-style. Views, duration and
            channel name are intentionally not shown on Home Shorts cards. */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-2 pt-6">
          <h3 className="text-[13px] font-medium leading-snug text-white line-clamp-2">
            {short.title}
          </h3>
        </div>
      </div>
    </Link>
  );
}

interface Block {
  key: string;
  kind: "long" | "short";
  items: VideoItem[];
}

export function MixedFeed({
  videos,
  hasMoreLongs,
  loadingMore,
  onRequestMore,
}: {
  /** Full ranked catalogue (already category-filtered by the caller). */
  videos: VideoItem[];
  /** True while the caller can still fetch more long-form pages. */
  hasMoreLongs: boolean;
  loadingMore: boolean;
  /** Ask the caller to load the next page of long-form videos. */
  onRequestMore: () => void;
}) {
  /**
   * Split the ranked catalogue into two ordered queues. Both keep the order the
   * recommendation service returned, and each video is used at most once, so a
   * previously watched video can never be repeated inside the same feed.
   */
  const { longs, shorts } = useMemo(() => {
    const longQueue: VideoItem[] = [];
    const shortQueue: VideoItem[] = [];
    const seen = new Set<string>();
    for (const v of videos) {
      if (!usable(v)) continue;
      const key = String(v.id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (v.isShort) shortQueue.push(v);
      else longQueue.push(v);
    }
    return { longs: longQueue, shorts: shortQueue };
  }, [videos]);

  /** Cycles that fit the currently available videos. */
  const maxCycles = useMemo(() => {
    const byLongs = Math.floor(longs.length / LONGS_PER_CYCLE);
    const byShorts = Math.floor(shorts.length / SHORTS_PER_CYCLE);
    return Math.max(byLongs, byShorts);
  }, [longs.length, shorts.length]);

  const [cycles, setCycles] = useState(INITIAL_CYCLES);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // A category switch or a refresh after upload remounts this component from
  // the parent via `key`, which naturally resets the rendered window. No effect
  // is needed here — see the `key` passed to <MixedFeed /> in page.tsx.

  /**
   * Render `n` complete cycles, then any healthy tail that is left over.
   * Pure — the cursors are folded through the accumulator rather than mutated,
   * so this stays a legitimate `useMemo`.
   */
  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    const cursor = { long: 0, short: 0 };

    const take = (kind: "long" | "short", count: number): VideoItem[] => {
      const queue = kind === "long" ? longs : shorts;
      const slice = queue.slice(cursor[kind], cursor[kind] + count);
      cursor[kind] += slice.length;
      return slice;
    };

    const complete = Math.min(cycles, maxCycles);
    for (let c = 0; c < complete; c += 1) {
      for (const step of CYCLE) {
        const items = take(step.kind, step.count);
        if (items.length) {
          // Content-derived key (first item's id), NOT a positional one. When a
          // re-rank inserts a video near the top, positional keys shifted for
          // every following block, so React threw all of them away and rebuilt
          // every thumbnail — the flash viewers saw as the page refreshing
          // itself. Stable keys let React move the existing blocks instead.
          out.push({ key: `${step.kind}-${String(items[0].id)}`, kind: step.kind, items });
        }
      }
    }

    // Tail: whatever remains after the last full cycle. Still shown (content is
    // never dropped) and grouped the same way as the body — Shorts in pairs of a
    // 2-column row, long videos in a normal grid — so the tail never produces a
    // ragged rhythm like a lone Short followed by two long blocks.
    if (cycles > maxCycles) {
      while (cursor.short < shorts.length) {
        const items = take("short", 2);
        if (!items.length) break;
        out.push({ key: `tail-s-${String(items[0].id)}`, kind: "short", items });
      }
      while (cursor.long < longs.length) {
        const items = take("long", 3);
        if (!items.length) break;
        out.push({ key: `tail-l-${String(items[0].id)}`, kind: "long", items });
      }
    }

    return out;
  }, [cycles, maxCycles, longs, shorts]);

  const loadMoreCycles = useCallback(() => {
    setCycles((prev) => {
      const next = prev + CYCLES_PER_BATCH;
      return next > maxCycles ? maxCycles : next;
    });
    // Running out of long-form videos: pull the next page from the caller.
    if (longs.length <= cycles * LONGS_PER_CYCLE && hasMoreLongs && !loadingMore) {
      onRequestMore();
    }
  }, [maxCycles, longs.length, cycles, hasMoreLongs, loadingMore, onRequestMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreCycles();
      },
      { rootMargin: "600px 0px" } // prefetch before the end is on screen
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMoreCycles]);

  if (!blocks.length) return null;

  return (
    <div className="space-y-6 sm:space-y-8">
      {blocks.map((block) =>
        block.kind === "long" ? (
          <section key={block.key} aria-label="Videos">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
              {block.items.map((video) => (
                <VideoCard key={video.id} video={video} />
              ))}
            </div>
          </section>
        ) : (
          <section key={block.key} aria-label="Shorts">
            {/* Strict 2-column portrait grid. No horizontal scrolling. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-x-3 gap-y-5 sm:gap-x-4">
              {block.items.map((short) => (
                <ShortCell key={short.id} short={short} />
              ))}
            </div>
          </section>
        )
      )}

      <div ref={sentinelRef} className="pt-4 pb-8 flex justify-center">
        {loadingMore ? (
          <div className="w-7 h-7 rounded-full border-4 border-zinc-200 dark:border-zinc-700 border-t-red-600 animate-spin" />
        ) : !hasMoreLongs && cycles >= maxCycles ? (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            You&apos;re all caught up
          </span>
        ) : null}
      </div>
    </div>
  );
}

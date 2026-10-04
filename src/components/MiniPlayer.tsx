"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, Maximize2, Play, Pause } from "lucide-react";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Mini player for long-form videos.
 * ─────────────────────────────────────────────────────────────────────────
 * When the viewer leaves a /watch page while the video is still playing, the
 * video keeps going in a small floating window (bottom-right) — the same
 * behaviour as YouTube. Tapping it returns to the watch page; ✕ closes it.
 *
 * Shorts deliberately never trigger this: they are a continuous vertical feed
 * and already have their own player.
 *
 * Implementation note: the mini player creates its OWN <video> element and
 * resumes from the timestamp captured at hand-off. Re-parenting the original
 * DOM node would fight React's ownership of that element, so a fresh element
 * is the reliable choice.
 */

export interface MiniPlayerVideo {
  videoId: string | number;
  videoUrl: string;
  thumbnailUrl: string;
  title: string;
  /** Playback position at the moment the viewer navigated away. */
  currentTime: number;
  duration: number;
}

interface MiniPlayerContextValue {
  /** Hand a playing video over to the mini player. */
  activate: (video: MiniPlayerVideo) => void;
  /** Close the mini player. */
  dismiss: () => void;
  /** True when the watch page currently owns this video (no mini player). */
  isOwnedByWatchPage: (videoId: string | number) => boolean;
  /** Tell the provider the watch page took this video back. */
  reclaim: (videoId: string | number) => void;
}

const MiniPlayerContext = createContext<MiniPlayerContextValue | undefined>(
  undefined
);

export function useMiniPlayer(): MiniPlayerContextValue {
  const ctx = useContext(MiniPlayerContext);
  if (!ctx) throw new Error("useMiniPlayer must be used inside MiniPlayerProvider");
  return ctx;
}

export function MiniPlayerProvider({ children }: { children: React.ReactNode }) {
  const [video, setVideo] = useState<MiniPlayerVideo | null>(null);
  /** Set while the full watch page is showing this same video. */
  const [reclaimedId, setReclaimedId] = useState<string | number | null>(null);

  const activate = useCallback((next: MiniPlayerVideo) => {
    setReclaimedId(null);
    setVideo(next);
  }, []);

  const dismiss = useCallback(() => {
    setVideo(null);
    setReclaimedId(null);
  }, []);

  const reclaim = useCallback((videoId: string | number) => {
    setReclaimedId(videoId);
  }, []);

  const isOwnedByWatchPage = useCallback(
    (videoId: string | number) =>
      video != null && String(reclaimedId) === String(videoId),
    [video, reclaimedId]
  );

  const value = useMemo(
    () => ({ activate, dismiss, isOwnedByWatchPage, reclaim }),
    [activate, dismiss, isOwnedByWatchPage, reclaim]
  );

  return (
    <MiniPlayerContext.Provider value={value}>
      {children}
      <MiniPlayerHost
        video={video}
        hidden={video != null && isOwnedByWatchPage(video.videoId)}
        onDismiss={dismiss}
      />
    </MiniPlayerContext.Provider>
  );
}

function MiniPlayerHost({
  video,
  hidden,
  onDismiss,
}: {
  video: MiniPlayerVideo | null;
  hidden: boolean;
  onDismiss: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  /** Mirrors `playing` so effects can read it without a re-subscribe. */
  const playingRef = useRef(true);
  const pathname = usePathname();

  /**
   * Leaving the mini player's own route (i.e. the viewer opened the watch page
   * again) hands control back to the real player, so two videos never play at
   * once.
   */
  useEffect(() => {
    if (!video) return;
    const el = videoRef.current;
    if (el) el.pause();
    // Pausing here is not state the render depends on; reflect it lazily.
    playingRef.current = false;
  }, [pathname, video]);

  // Keep the mini video in sync with the captured timestamp on hand-off.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !video) return;
    const seek = () => {
      if (video.currentTime > 0 && video.currentTime < (video.duration || Infinity)) {
        try {
          el.currentTime = video.currentTime;
        } catch {
          /* metadata not ready yet — nothing critical */
        }
      }
      void el.play().then(
        () => setPlaying(true),
        () => setPlaying(false)
      );
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener("loadedmetadata", seek, { once: true });
    return () => el.removeEventListener("loadedmetadata", seek);
  }, [video]);

  // No competing audio: close the mini player when the tab is hidden.
  useEffect(() => {
    if (!video) return;
    const onVisibility = () => {
      const el = videoRef.current;
      if (!el) return;
      if (document.hidden) {
        el.pause();
        setPlaying(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [video]);

  if (!video || hidden) return null;

  const watchHref = `/watch/${video.videoId}`;

  return (
    <div
      className="fixed z-[60] right-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] w-[248px] sm:right-5 sm:bottom-5 sm:w-[340px] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-700 shadow-2xl"
      role="complementary"
      aria-label="Mini player"
    >
      <div className="relative bg-black">
        <video
          ref={videoRef}
          src={video.videoUrl}
          poster={video.thumbnailUrl || undefined}
          playsInline
          className="w-full aspect-video bg-black"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={() => {
            const el = videoRef.current;
            if (!el) return;
            if (el.paused) void el.play().catch(() => {});
            else el.pause();
          }}
        />

        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => {
              const el = videoRef.current;
              if (!el) return;
              if (el.paused) void el.play().catch(() => {});
              else el.pause();
            }}
            className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-black/70 text-white hover:bg-black/90 transition-colors cursor-pointer"
          >
            {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <Link
            href={watchHref}
            aria-label="Expand video"
            className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-black/70 text-white hover:bg-black/90 transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </Link>
          <button
            type="button"
            aria-label="Close mini player"
            onClick={onDismiss}
            className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-black/70 text-white hover:bg-black/90 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <Link href={watchHref} className="block px-2.5 py-2">
        <span className="block text-[13px] font-medium leading-snug text-white line-clamp-2">
          {video.title}
        </span>
      </Link>
    </div>
  );
}

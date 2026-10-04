"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  Suspense,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Flame,
  ThumbsUp,
  MessageSquare,
  Share2,
  X,
  Play,
  Loader2,
  Send,
  CornerDownRight,
  Blend,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  UserAvatar,
  SubscribeButton,
  VideoItem,
  EmptyState,
  ErrorState,
} from "@/components/VideoComponents";
import { formatCount, formatTimeAgo } from "@/lib/format";
import { useApp } from "@/context/AppContext";
import { apiUrl } from "@/lib/api-config";
import { adaptVideos, channelHref } from "@/lib/backend-adapter";
import { toggleVideoLikeApi } from "@/lib/likes-manager";
import { adaptComments, type AdaptedComment } from "@/lib/comments";
import { createRemix, fetchRemixState, type RemixSource } from "@/lib/remix";
import { resolveChannelHandleForUser } from "@/lib/user-channel";
import { fetchRecommendedShorts } from "@/lib/rec-feed";
import { recordWatchSignal, recordInteractionSignal } from "@/lib/rec-client";

/** Double-tap window for the YouTube/TikTok-style like gesture. */
const DOUBLE_TAP_MS = 300;
/** A tap only counts when the finger barely moved (swipes must still scroll). */
const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 400;

/** Trigger a brief scale pop on the like button when double-tapped. */
let _likeBurstTimer: ReturnType<typeof setTimeout> | null = null;



/** One full-screen short. Plays only while it is the active slide. */
function ShortSlide({
  short,
  active,
  preloadHint,
  audioEnabledByUser,
  onAudioGesture,
  onOpenComments,
  onLiked,
  onViewCounted,
}: {
  short: VideoItem & { userReaction?: "like" | "dislike" | null };
  active: boolean;
  /**
   * How eagerly the browser may fetch this Short. Only the visible slide is
   * allowed "auto"; the immediately following slide gets "metadata" so a swipe
   * starts sooner; every other slide gets "none" and downloads nothing.
   */
  preloadHint: "auto" | "metadata" | "none";
  audioEnabledByUser: boolean;
  onAudioGesture: () => void;
  onOpenComments: () => void;
  onLiked: (likes: number, reaction: "like" | "dislike" | null) => void;
  onViewCounted: (videoId: string | number, views: number) => void;
}) {
  const { user, channel: myChannel, openAuthModal, openUploadModal, showToast } = useApp();

  /**
   * Own-Short detection. SubscribeButton compares user.id with the CHANNEL id,
   * which never match, so creators saw "Subscribe" on their own Shorts. Compare
   * channel identity instead: the session channel, or — when the session has
   * none — the real owner lookup (GET /channel/:handle → owner._id).
   */
  const [ownHandle, setOwnHandle] = useState<string | null>(null);
  useEffect(() => {
    if (!user) {
      setOwnHandle(null);
      return;
    }
    if (myChannel?.handle) {
      setOwnHandle(String(myChannel.handle));
      return;
    }
    let cancelled = false;
    resolveChannelHandleForUser(user.id).then((handle) => {
      if (!cancelled) setOwnHandle(handle);
    });
    return () => {
      cancelled = true;
    };
  }, [user, myChannel?.handle]);
  const isOwnShort = Boolean(
    user &&
      ((myChannel?.channelId != null &&
        String(myChannel.channelId) === String(short.creator.id)) ||
        (ownHandle &&
          ownHandle.toLowerCase() === String(short.creator.username || "").toLowerCase()))
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioEnabledByUserRef = useRef(audioEnabledByUser);
  audioEnabledByUserRef.current = audioEnabledByUser;
  const userPausedRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [busyLike, setBusyLike] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const seekingRef = useRef(false);

  /** Double-tap = like → like button scale pop. */
  const [likeBurst, setLikeBurst] = useState(false);
  const pendingTapRef = useRef<number | null>(null);
  const lastTapAtRef = useRef(0);
  const pointerStartRef = useRef<{ x: number; y: number; at: number } | null>(null);

  /** Real remix state from /api/remix (proxied to the Render backend). */
  const [remixSource, setRemixSource] = useState<RemixSource | null>(null);
  const [remixBusy, setRemixBusy] = useState(false);

  /** Thin seek bar drag state. */
  const [draggingSeek, setDraggingSeek] = useState(false);
  const seekBarRef = useRef<HTMLDivElement>(null);

  const watchedRef = useRef(0);
  const reportedRef = useRef(false);
  const sessionKeyRef = useRef("");

  useEffect(() => {
    let key = sessionStorage.getItem("bharattube_playback_session");
    if (!key) {
      key = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("bharattube_playback_session", key);
    }
    sessionKeyRef.current = key;
  }, []);

  // Play the active Short with audio whenever the browser permits it.
  // Browsers may block audible autoplay until a user gesture; in that case
  // keep playback going muted and enable audio automatically on first touch.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    if (!active) {
      v.pause();
      setBuffering(false);
      return;
    }

    let cancelled = false;
    // Restart from the top only when the element actually has metadata; setting
    // currentTime earlier is a silent no-op that can leave the seek bar stale.
    if (v.readyState >= 1) v.currentTime = 0;
    watchedRef.current = 0;
    reportedRef.current = false;
    userPausedRef.current = false;
    setBuffering(true);
    setPaused(false);
    v.volume = 1;
    v.muted = false;
    setMuted(false);

    const startPlayback = async () => {
      try {
        await v.play();
        if (!cancelled) setPaused(false);
      } catch {
        if (cancelled) return;

        // Muted autoplay is permitted by mobile browsers; video tap/swipe
        // automatically restores audio without a separate mute/unmute button.
        if (!audioEnabledByUserRef.current) {
          v.muted = true;
          setMuted(true);
          try {
            await v.play();
            if (!cancelled) setPaused(false);
          } catch {
            if (!cancelled) {
              setPaused(true);
              if (typeof navigator === "undefined" || navigator.onLine) {
                setBuffering(false);
              }
            }
          }
        } else {
          setPaused(true);
          if (typeof navigator === "undefined" || navigator.onLine) {
            setBuffering(false);
          }
        }
      }
    };

    void startPlayback();
    return () => {
      cancelled = true;
      v.pause();
    };
  }, [active, short.id]);

  // An actual browser gesture is required for audible media autoplay on some
  // phones. Any touch on the Short silently enables audio; no sound button is shown.
  const enableAudioFromGesture = () => {
    if (!active) return;
    onAudioGesture();
    const v = videoRef.current;
    if (!v) return;
    v.volume = 1;
    v.muted = false;
    setMuted(false);
  };

  useEffect(() => {
    if (!active) return;
    const onOffline = () => setBuffering(true);
    const onOnline = () => {
      const v = videoRef.current;
      if (!v || userPausedRef.current) return;
      setBuffering(true);
      void v.play().catch(() => {});
    };

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setBuffering(true);
    }
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [active]);

  // Refresh the visible count from the backend whenever this Short becomes
  // active, including after a page refresh or direct deep link.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch(apiUrl(`/views/${encodeURIComponent(String(short.id))}`), {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) return;
        const payload = await res.json().catch(() => ({}));
        const views = Number(payload?.views ?? payload?.data?.views ?? payload?.viewCount);
        if (!cancelled && Number.isFinite(views) && views >= 0) {
          onViewCounted(short.id, views);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, short.id, onViewCounted]);

  /**
   * Genuine Shorts view tracking against the real backend:
   * POST /views/:id records a view (auth when available), GET /views/:id
   * is the authoritative count. History is also posted so watch progress
   * stays in sync. The UI never increments locally.
   */
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.paused) return;
      watchedRef.current += 1;

      const duration = v.duration && Number.isFinite(v.duration) ? v.duration : short.duration || 1;
      const isFiveSecondCheckpoint = watchedRef.current % 5 === 0;
      const shouldReportView =
        !reportedRef.current &&
        watchedRef.current >= 2 &&
        (watchedRef.current === 2 || isFiveSecondCheckpoint);
      const shouldReportHistory = isFiveSecondCheckpoint;
      if (!shouldReportView && !shouldReportHistory) return;

      const body = JSON.stringify({
        watchedDuration: watchedRef.current,
        currentTime: Math.round(v.currentTime),
        duration: Math.round(duration),
      });
      const headers = { "Content-Type": "application/json" };

      // Ranking signal for the Shorts model: completion, rewatch and swipe-away
      // (point 17). Best-effort; cannot affect playback.
      recordWatchSignal({
        videoId: short.id,
        watchSeconds: watchedRef.current,
        videoSeconds: duration,
        watchPct: duration > 0 ? Math.min(1, watchedRef.current / duration) : 0,
        completed: duration > 0 && watchedRef.current / duration >= 0.9,
      });
      try {
        const [viewPost] = await Promise.all([
          shouldReportView
            ? fetch(apiUrl(`/views/${encodeURIComponent(String(short.id))}`), {
                method: "POST",
                credentials: "include",
                headers,
                body,
              }).catch(() => null)
            : Promise.resolve(null),
          shouldReportHistory
            ? fetch(apiUrl(`/history/${encodeURIComponent(String(short.id))}`), {
                method: "POST",
                credentials: "include",
                headers,
                body,
              }).catch(() => null)
            : Promise.resolve(null),
        ]);

        // The backend remains authoritative. A failed/auth-required request is
        // retried at the next checkpoint; it is never treated as a counted view.
        if (viewPost?.ok) reportedRef.current = true;

        if (shouldReportView && viewPost?.ok) {
          const countRes = await fetch(
            apiUrl(`/views/${encodeURIComponent(String(short.id))}`),
            { cache: "no-store" }
          );
          if (countRes.ok) {
            const latest = await countRes.json().catch(() => ({}));
            const views = Number(latest?.views ?? latest?.data?.views ?? latest?.viewCount);
            if (Number.isFinite(views) && views >= 0) onViewCounted(short.id, views);
          }
        }
      } catch {
        /* offline — retry on the next eligible playback interval */
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [active, short.id, short.duration, onViewCounted]);

  /**
   * Swipe-away detection for the Shorts ranking model. Leaving a Short after
   * barely watching it is an explicit NEGATIVE signal — distinct from a view —
   * and repeated swipe-aways push that video (and its topic) down for this
   * viewer instead of counting as engagement.
   */
  useEffect(() => {
    if (!active) return;
    return () => {
      const watched = watchedRef.current;
      const duration =
        (videoRef.current?.duration && Number.isFinite(videoRef.current.duration)
          ? videoRef.current.duration
          : 0) || short.duration || 0;
      if (!duration || watched <= 0) return;
      if (watched >= 1 && watched / duration < 0.2) {
        recordInteractionSignal("skip", short.id);
      }
    };
    // Teardown-only: reads the accumulated watch time at the moment of swipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, short.id]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      userPausedRef.current = false;
      enableAudioFromGesture();
      void v.play()
        .then(() => setPaused(false))
        .catch(() => setPaused(true));
    } else {
      userPausedRef.current = true;
      v.pause();
      setPaused(true);
      setBuffering(false);
    }
  };

  const handleLike = async () => {
    if (!user) {
      openAuthModal("login");
      showToast("Sign in to like this Short", "info");
      return;
    }
    if (busyLike) return;
    setBusyLike(true);

    const currentlyLiked = short.userReaction === "like";
    const nextLiked = !currentlyLiked;
    const prevLikes = short.likesCount;
    const optimisticLikes = Math.max(0, prevLikes + (nextLiked ? 1 : -1));

    // Update UI immediately
    onLiked(optimisticLikes, nextLiked ? "like" : null);

    try {
      const result = await toggleVideoLikeApi(short.id, currentlyLiked, user.id);
      if (typeof result.likesCount === "number") {
        onLiked(result.likesCount, result.nextLiked ? "like" : null);
      }
    } catch {
      onLiked(prevLikes, currentlyLiked ? "like" : null);
      showToast("Network error. Please try again.", "error");
    } finally {
      setBusyLike(false);
    }
  };

  /** Triggers a brief scale pop on the like button. */
  const triggerLikeBurst = () => {
    if (_likeBurstTimer) clearTimeout(_likeBurstTimer);
    setLikeBurst(true);
    _likeBurstTimer = setTimeout(() => setLikeBurst(false), 400);
  };

  /**
   * Double-tap on the Short itself = like.
   *
   * This calls the REAL like API (toggleVideoLikeApi → POST/DELETE /likes/:id),
   * so the backend record and the like counter actually change. Matching
   * YouTube Shorts, a second double-tap on an already-liked Short keeps the
   * like (it never un-likes) and only replays the heart feedback.
   */
  const handleDoubleTapLike = (_x: number, _y: number) => {
    triggerLikeBurst();

    if (!user) {
      openAuthModal("login");
      showToast("Sign in to like this Short", "info");
      return;
    }
    if (busyLike) return;
    if (short.userReaction === "like") return;

    void (async () => {
      setBusyLike(true);
      const prevLikes = short.likesCount;
      onLiked(Math.max(0, prevLikes + 1), "like");
      try {
        const result = await toggleVideoLikeApi(short.id, false, user.id);
        onLiked(
          typeof result.likesCount === "number" ? result.likesCount : Math.max(0, prevLikes + 1),
          "like"
        );
      } catch {
        onLiked(prevLikes, null);
        showToast("Network error. Please try again.", "error");
      } finally {
        setBusyLike(false);
      }
    })();
  };

  /**
   * One interaction layer handles the whole video surface: a single tap keeps
   * the existing play/pause behaviour, a double tap likes. Controls sit above
   * this layer and stop propagation, so they never trigger a like.
   */
  const handleSurfacePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    enableAudioFromGesture();
    pointerStartRef.current = { x: e.clientX, y: e.clientY, at: Date.now() };
  };

  const handleSurfacePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) return;

    const moved =
      Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y);
    const elapsed = Date.now() - start.at;
    // Let vertical swipes keep driving the snap feed.
    if (moved > TAP_SLOP_PX || elapsed > TAP_MAX_MS) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const now = Date.now();

    if (now - lastTapAtRef.current <= DOUBLE_TAP_MS) {
      // Second tap of a double tap — cancel the queued play/pause.
      lastTapAtRef.current = 0;
      if (pendingTapRef.current !== null) {
        window.clearTimeout(pendingTapRef.current);
        pendingTapRef.current = null;
      }
      handleDoubleTapLike(x, y);
      return;
    }

    lastTapAtRef.current = now;
    pendingTapRef.current = window.setTimeout(() => {
      pendingTapRef.current = null;
      togglePlay();
    }, DOUBLE_TAP_MS);
  };

  // Real source Short (proxied from the existing Render backend).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetchRemixState(short.id).then((state) => {
      if (!cancelled) setRemixSource(state.source);
    });
    return () => {
      cancelled = true;
    };
  }, [active, short.id]);

  /**
   * Remix: validates the source Short against the existing BharatTube backend,
   * then opens the existing upload studio so the new Short is really created.
   */
  const handleRemix = async () => {
    if (!user) {
      openAuthModal("login");
      showToast("Sign in to remix this Short", "info");
      return;
    }
    if (remixBusy) return;
    setRemixBusy(true);
    try {
      const result = await createRemix(short.id);
      setRemixSource(result.source);
      showToast("Remix started — record your version", "success");
      openUploadModal();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not start the remix", "error");
    } finally {
      setRemixBusy(false);
    }
  };

  /** Maps a pointer position on the thin bar to a real seek. */
  const seekFromPointer = (clientX: number) => {
    const bar = seekBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const total = Math.max(0.1, mediaDuration || short.duration || 1);
    const next = ratio * total;
    setCurrentTime(next);
    const v = videoRef.current;
    if (v) {
      try {
        v.currentTime = next;
      } catch {
        /* not seekable yet */
      }
    }
  };

  const handleSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    seekingRef.current = true;
    setDraggingSeek(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unsupported */
    }
    seekFromPointer(e.clientX);
  };

  const handleSeekPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSeek) return;
    e.stopPropagation();
    seekFromPointer(e.clientX);
  };

  const handleSeekPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSeek) return;
    e.stopPropagation();
    setDraggingSeek(false);
    seekingRef.current = false;
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/shorts?id=${short.id}`;
    // Native share sheet on mobile, clipboard fallback everywhere else.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: short.title, url });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied", "success");
    } catch {
      showToast(url, "info");
    }
  };

  const liked = short.userReaction === "like";

  return (
    <section
      onPointerDownCapture={enableAudioFromGesture}
      className="snap-item shorts-slide relative w-full flex items-center justify-center bg-black overflow-hidden"
    >
      <div className="shorts-stage relative flex items-center justify-center sm:rounded-2xl">
        <video
          ref={videoRef}
          src={short.videoUrl}
          poster={short.thumbnailUrl || undefined}
          loop
          muted={muted}
          playsInline
          preload={preloadHint}
          onLoadStart={() => {
            if (active) setBuffering(true);
          }}
          onWaiting={() => {
            if (active) setBuffering(true);
          }}
          onStalled={() => {
            if (active) setBuffering(true);
          }}
          onCanPlay={() => {
            if (active && !videoRef.current?.paused) setBuffering(false);
          }}
          onPlaying={() => {
            if (active) {
              setBuffering(false);
              setPaused(false);
            }
          }}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v && Number.isFinite(v.duration)) setMediaDuration(v.duration);
          }}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v || seekingRef.current) return;
            setCurrentTime(v.currentTime);
            if (Number.isFinite(v.duration) && v.duration > 0) {
              setMediaDuration(v.duration);
            }
          }}
          onPause={() => setPaused(true)}
          onError={() => {
            if (active && typeof navigator !== "undefined" && !navigator.onLine) {
              setBuffering(true);
            } else if (active) {
              setBuffering(false);
              setPaused(true);
            }
          }}
          className="h-full w-full object-cover object-center"
        />

        {/*
          Tap surface for the Short itself (single tap = play/pause,
          double tap = like). It sits above the video but below every control,
          so buttons can never trigger a like.
        */}
        {active && (
          <div
            className="absolute inset-0 z-10 touch-manipulation"
            onPointerDown={handleSurfacePointerDown}
            onPointerUp={handleSurfacePointerUp}
            onPointerCancel={() => {
              pointerStartRef.current = null;
            }}
            aria-label="Short playback area"
          />
        )}



        {/*
          YouTube Shorts-style progress bar: 2px, pinned flush to the absolute
          bottom of the video — no gradient, no padding, no background. Grows
          to 4px only while dragging.
        */}
        {active && (
          <div
            className="absolute inset-x-0 bottom-0 z-30"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <div
              ref={seekBarRef}
              data-dragging={draggingSeek}
              className="bt-shorts-track relative w-full cursor-pointer touch-none"
              onPointerDown={handleSeekPointerDown}
              onPointerMove={handleSeekPointerMove}
              onPointerUp={handleSeekPointerEnd}
              onPointerCancel={handleSeekPointerEnd}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-red-600"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(
                      0,
                      (Math.min(currentTime, Math.max(0.1, mediaDuration || short.duration || 1)) /
                        Math.max(0.1, mediaDuration || short.duration || 1)) *
                        100
                    )
                  )}%`,
                }}
              />
              <span
                className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white shadow transition-transform ${
                  draggingSeek ? "w-3 h-3" : "w-2 h-2"
                }`}
                style={{
                  left: `${Math.min(
                    100,
                    Math.max(
                      0,
                      (Math.min(currentTime, Math.max(0.1, mediaDuration || short.duration || 1)) /
                        Math.max(0.1, mediaDuration || short.duration || 1)) *
                        100
                    )
                  )}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {buffering && active && (
        <div
          role="status"
          aria-label="Loading Short video"
          className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
        >
          <span className="w-12 h-12 rounded-full bg-black/50 text-white flex items-center justify-center backdrop-blur-sm">
            <Loader2 className="w-7 h-7 animate-spin" />
          </span>
        </div>
      )}

      {paused && active && !buffering && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute inset-0 m-auto z-20 w-16 h-16 rounded-full bg-black/60 text-white flex items-center justify-center backdrop-blur-sm"
        >
          <Play className="w-7 h-7 fill-white ml-1" />
        </button>
      )}

      {/*
        Bottom info. Sits ABOVE the seek bar (pb-5 keeps the gradient off the
        2px track) but at a lower stacking order so the bar stays visible and
        draggable along the very bottom edge.
      */}
      <div className="absolute bottom-0 inset-x-0 z-20 p-4 pr-20 pb-5 bg-gradient-to-t from-black/80 to-transparent text-white px-safe pointer-events-none">
        <div className="pointer-events-auto">
        <div className="flex items-center gap-2.5 mb-2">
          <Link href={channelHref(short.creator)} aria-label={`Open ${short.creator.displayName} channel`}>
            <UserAvatar
              name={short.creator.displayName}
              avatarUrl={short.creator.avatarUrl}
              size="sm"
            />
          </Link>
          <Link
            href={channelHref(short.creator)}
            className="font-bold text-sm truncate hover:underline"
          >
            @{short.creator.username}
          </Link>
          <SubscribeButton
            channelId={short.creator.id}
            isOwner={isOwnShort}
            initialSubscribed={Boolean(
              (short as unknown as { isSubscribed?: boolean }).isSubscribed
            )}
            size="sm"
          />
        </div>
          <h2 className="text-sm font-semibold line-clamp-2">{short.title}</h2>
        </div>
      </div>

      {/* Right action rail */}
      <div className="absolute right-2 bottom-24 z-30 flex flex-col items-center gap-3.5 text-white px-safe">
        <button
          type="button"
          onClick={handleLike}
          disabled={busyLike}
          aria-label={liked ? "Remove like" : "Like"}
          aria-pressed={liked}
          className="flex flex-col items-center gap-1 cursor-pointer"
        >
          <span
            className={`w-11 h-11 rounded-full flex items-center justify-center transition-transform ${
              likeBurst ? "scale-125" : "scale-100"
            } ${liked ? "bg-white text-red-600" : "bg-black/50 text-white"}`}
            style={{ transitionDuration: "200ms" }}
          >
            <ThumbsUp className={`w-5 h-5 ${liked ? "fill-current" : ""}`} />
          </span>
          <span className="text-xs font-medium tabular-nums">
            {formatCount(short.likesCount)}
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenComments}
          aria-label="Comments"
          className="flex flex-col items-center gap-1 cursor-pointer"
        >
          <span className="w-11 h-11 rounded-full bg-black/50 flex items-center justify-center">
            <MessageSquare className="w-5 h-5" />
          </span>
          <span className="text-xs font-medium tabular-nums">
            {formatCount(short.commentsCount)}
          </span>
        </button>

        <button
          type="button"
          onClick={handleShare}
          aria-label="Share"
          className="flex flex-col items-center gap-1 cursor-pointer"
        >
          <span className="w-11 h-11 rounded-full bg-black/50 flex items-center justify-center">
            <Share2 className="w-5 h-5" />
          </span>
          <span className="text-xs font-medium">Share</span>
        </button>

        {/* Remix — validated against the backend, then opens the creator studio. */}
        <button
          type="button"
          onClick={handleRemix}
          disabled={remixBusy}
          aria-label="Remix this Short"
          className="flex flex-col items-center gap-1 cursor-pointer disabled:opacity-60"
        >
          <span
            className={`w-11 h-11 rounded-full flex items-center justify-center ${
              remixSource ? "bg-white text-red-600" : "bg-black/50 text-white"
            }`}
          >
            {remixBusy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Blend className="w-5 h-5" />
            )}
          </span>
          <span className="text-xs font-medium">Remix</span>
        </button>
      </div>
    </section>
  );
}

/**
 * All replies in a thread, at any depth, oldest first. The backend nests
 * `replies` recursively; rendering only `c.replies` dropped reply-of-reply.
 */
function flattenReplies(comment: AdaptedComment): AdaptedComment[] {
  const out: AdaptedComment[] = [];
  const seen = new Set<string>();
  const walk = (node: AdaptedComment, depth: number) => {
    if (depth > 20) return;
    for (const reply of node.replies || []) {
      const key = String(reply.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(reply);
      walk(reply, depth + 1);
    }
  };
  walk(comment, 0);
  return out.sort(
    (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)
  );
}

function CommentsSheet({
  videoId,
  onClose,
  onPosted,
}: {
  videoId: string | number;
  onClose: () => void;
  onPosted: () => void;
}) {
  const { user, openAuthModal, showToast } = useApp();
  const [items, setItems] = useState<AdaptedComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<AdaptedComment | null>(null);
  const [replyText, setReplyText] = useState("");
  /** Threads whose replies are expanded — hidden by default (like YouTube). */
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  /** Per-comment like state layered on top of the backend count. */
  const [likeState, setLikeState] = useState<
    Record<string, { liked: boolean; count: number }>
  >({});
  const [likeBusy, setLikeBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl(`/comments/${encodeURIComponent(String(videoId))}`), {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.message || data?.error || "Could not load comments.");
        setItems([]);
        return;
      }
      setItems(adaptComments(data, String(videoId)));
    } catch {
      setError("Could not load comments.");
    } finally {
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    load();
  }, [load]);

  const postComment = async (content: string, parentId: string | null) => {
    const res = await fetch(apiUrl(`/comments/${encodeURIComponent(String(videoId))}`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: content,
        parentComment: parentId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.message || data?.error || "Could not post comment");
    }
    await load();
    onPosted();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      openAuthModal("login");
      return;
    }
    const content = text.trim();
    if (!content || posting) return;
    setPosting(true);
    try {
      await postComment(content, null);
      setText("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not post comment", "error");
    } finally {
      setPosting(false);
    }
  };

  const submitReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      openAuthModal("login");
      return;
    }
    if (!replyingTo) return;
    const content = replyText.trim();
    if (!content || posting) return;
    const parent = replyingTo;
    setPosting(true);
    try {
      await postComment(content, String(parent.id));
      setReplyText("");
      setReplyingTo(null);
      // Reveal the thread so the freshly posted reply is visible.
      setOpenThreads((prev) => new Set(prev).add(String(parent.id)));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not post reply", "error");
    } finally {
      setPosting(false);
    }
  };

  const toggleThread = (id: string) =>
    setOpenThreads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Like/unlike a comment via the real POST /comments/:id/like route. */
  const likeComment = async (comment: AdaptedComment) => {
    if (!user) {
      openAuthModal("login");
      showToast("Sign in to like comments", "info");
      return;
    }
    const id = String(comment.id);
    if (likeBusy.has(id)) return;

    const current =
      likeState[id] ?? { liked: false, count: comment.likesCount || 0 };
    const nextLiked = !current.liked;
    const optimistic = {
      liked: nextLiked,
      count: Math.max(0, current.count + (nextLiked ? 1 : -1)),
    };
    setLikeState((prev) => ({ ...prev, [id]: optimistic }));
    setLikeBusy((prev) => new Set(prev).add(id));

    try {
      const res = await fetch(
        apiUrl(`/comments/${encodeURIComponent(id)}/like`),
        { method: "POST", credentials: "include" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Roll back on failure — never show a fake like.
        setLikeState((prev) => ({ ...prev, [id]: current }));
        showToast(
          res.status === 401
            ? "Sign in to like comments"
            : data?.message || data?.error || "Could not like comment",
          "error"
        );
        if (res.status === 401) openAuthModal("login");
        return;
      }
      const serverCount = Number(data?.likesCount);
      const serverLiked =
        typeof data?.isLiked === "boolean"
          ? data.isLiked
          : typeof data?.liked === "boolean"
          ? data.liked
          : nextLiked;
      setLikeState((prev) => ({
        ...prev,
        [id]: {
          liked: serverLiked,
          count: Number.isFinite(serverCount) ? serverCount : optimistic.count,
        },
      }));
    } catch {
      setLikeState((prev) => ({ ...prev, [id]: current }));
      showToast("Network error. Please try again.", "error");
    } finally {
      setLikeBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  /** A comment's like button (used for both comments and replies). */
  const renderLikeButton = (comment: AdaptedComment) => {
    const id = String(comment.id);
    const state = likeState[id] ?? {
      liked: false,
      count: comment.likesCount || 0,
    };
    return (
      <button
        type="button"
        onClick={() => likeComment(comment)}
        aria-pressed={state.liked}
        aria-label={state.liked ? "Remove like" : "Like comment"}
        className={`inline-flex items-center gap-1 text-[11px] font-medium cursor-pointer ${
          state.liked ? "text-red-600" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        }`}
      >
        <ThumbsUp className={`w-3.5 h-3.5 ${state.liked ? "fill-current" : ""}`} />
        {state.count > 0 && (
          <span className="tabular-nums">{formatCount(state.count)}</span>
        )}
      </button>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center sm:justify-center bg-black/70"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md h-[75dvh] sm:h-[70vh] rounded-t-2xl sm:rounded-2xl bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <span className="font-bold text-sm">
            Comments (
            {items.reduce((n, c) => n + 1 + (c.replies?.length || 0), 0)})
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comments"
            className="tap-target inline-flex items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="text-xs text-zinc-500 mb-3">{error}</p>
              <button
                type="button"
                onClick={load}
                className="px-4 py-2 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold"
              >
                Retry
              </button>
            </div>
          ) : items.length === 0 ? (
            <p className="text-center text-xs text-zinc-500 py-10">
              No comments yet. Be the first to comment.
            </p>
          ) : (
            items.map((c) => (
              <div key={c.id} className="space-y-2">
                <div className="flex items-start gap-2.5">
                  <UserAvatar
                    name={c.author?.displayName || "User"}
                    avatarUrl={c.author?.avatarUrl}
                    size="xs"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold text-zinc-900 dark:text-zinc-100">
                      @{c.author?.username || "user"}{" "}
                      <span className="font-normal text-zinc-500">
                        {formatTimeAgo(c.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-700 dark:text-zinc-300 mt-0.5 break-words">
                      {c.content}
                    </p>
                    <div className="mt-1 flex items-center gap-4">
                      {renderLikeButton(c)}
                      <button
                        type="button"
                        onClick={() => {
                          if (!user) {
                            openAuthModal("login");
                            return;
                          }
                          setReplyingTo(c);
                          setReplyText("");
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-red-600 cursor-pointer"
                      >
                        <CornerDownRight className="w-3 h-3" />
                        Reply
                      </button>
                    </div>

                    {/* "N replies" toggle — replies stay hidden until tapped */}
                    {(() => {
                      const replies = flattenReplies(c);
                      if (replies.length === 0) return null;
                      const open = openThreads.has(String(c.id));
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleThread(String(c.id))}
                            aria-expanded={open}
                            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 cursor-pointer"
                          >
                            {open ? (
                              <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5" />
                            )}
                            {replies.length}{" "}
                            {replies.length === 1 ? "reply" : "replies"}
                          </button>

                          {open && (
                            <div className="mt-2 space-y-2">
                              {replies.map((r) => (
                                <div key={r.id} className="flex items-start gap-2.5">
                                  <UserAvatar
                                    name={r.author?.displayName || "User"}
                                    avatarUrl={r.author?.avatarUrl}
                                    size="xs"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[11px] font-semibold text-zinc-900 dark:text-zinc-100">
                                      @{r.author?.username || "user"}{" "}
                                      <span className="font-normal text-zinc-500">
                                        {formatTimeAgo(r.createdAt)}
                                      </span>
                                    </div>
                                    <p className="text-xs text-zinc-700 dark:text-zinc-300 mt-0.5 break-words">
                                      {r.content}
                                    </p>
                                    <div className="mt-1">{renderLikeButton(r)}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
                {replyingTo && String(replyingTo.id) === String(c.id) && (
                  <form onSubmit={submitReply} className="ml-8 flex items-center gap-2">
                    <input
                      type="text"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      autoFocus
                      placeholder={`Reply to @${c.author?.username || "user"}`}
                      className="flex-1 min-w-0 px-3 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!replyText.trim() || posting}
                      className="text-xs font-medium text-red-600 disabled:opacity-40 cursor-pointer"
                    >
                      {posting ? "…" : "Post"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplyingTo(null)}
                      className="text-xs text-zinc-500 cursor-pointer"
                    >
                      Cancel
                    </button>
                  </form>
                )}
              </div>
            ))
          )}
        </div>

        {/* Input pinned above the on-screen keyboard */}
        <form
          onSubmit={submit}
          className="shrink-0 p-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-2 pb-safe bg-white dark:bg-zinc-900"
        >
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => {
              if (!user) openAuthModal("login");
            }}
            enterKeyHint="send"
            placeholder={user ? "Add a comment…" : "Sign in to comment"}
            aria-label="Add a comment"
            className="flex-1 min-w-0 px-3.5 py-2.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-sm focus:outline-none focus:ring-1 focus:ring-red-500"
          />
          <button
            type="submit"
            disabled={!text.trim() || posting}
            aria-label="Post comment"
            className="tap-target shrink-0 inline-flex items-center justify-center rounded-full bg-red-600 text-white disabled:opacity-40 active:scale-95"
          >
            {posting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function ShortsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialIdParam = searchParams.get("id");
  const { user, openUploadModal, feedRefreshTrigger } = useApp();

  const [shorts, setShorts] = useState<
    Array<VideoItem & { userReaction?: "like" | "dislike" | null }>
  >([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [audioEnabledByUser, setAudioEnabledByUser] = useState(false);
  const [commentsFor, setCommentsFor] = useState<string | number | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<Array<HTMLDivElement | null>>([]);
  const didInitialScroll = useRef(false);
  const loadingMoreRef = useRef(false);

  const mergeUnique = (
    prev: Array<VideoItem & { userReaction?: "like" | "dislike" | null }>,
    next: Array<VideoItem & { userReaction?: "like" | "dislike" | null }>
  ) => {
    const seen = new Set(prev.map((s) => String(s.id)));
    const extra = next.filter((s) => !seen.has(String(s.id)));
    return extra.length ? [...prev, ...extra] : prev;
  };

  const fetchShortsPage = useCallback(
    async (pageNum: number, append: boolean) => {
      const currentUserId = user?.id != null ? String(user.id) : null;
      // Shorts are ranked with their own model (completion, rewatch, swipe-away).
      // The chronological /shorts/feed stays as a fallback so the feed renders.
      const ranked = await fetchRecommendedShorts(pageNum, 8);
      const res = ranked
        ? new Response(JSON.stringify(ranked))
        : await fetch(apiUrl(`/shorts/feed?page=${pageNum}&limit=8`), {
            cache: "no-store",
          });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const list = adaptVideos(data, "shorts", { currentUserId }) as unknown as Array<
        VideoItem & { userReaction?: "like" | "dislike" | null }
      >;
      const pagination = data.pagination || data.data?.pagination || {};
      const more =
        Boolean(pagination.hasNextPage) ||
        (typeof pagination.totalPages === "number" && pageNum < pagination.totalPages);
      setHasMore(more);
      setPage(pageNum);
      if (append) setShorts((prev) => mergeUnique(prev, list));
      else setShorts(list);
      return list;
    },
    [user?.id]
  );

  const fetchShorts = useCallback(async () => {
    setLoading(true);
    setError("");
    setHasMore(true);
    setPage(1);
    try {
      const list = await fetchShortsPage(1, false);
      const deepId = typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("id")
        : null;
      if (deepId && !list.some((s) => String(s.id) === String(deepId))) {
        const one = await fetch(apiUrl(`/videos/${encodeURIComponent(deepId)}`), {
          cache: "no-store",
        });
        if (one.ok) {
          const payload = await one.json();
          const extra = adaptVideos(
            { videos: [payload.data ?? payload.video ?? payload] },
            "videos",
            { currentUserId: user?.id != null ? String(user.id) : null }
          ) as unknown as Array<VideoItem & { userReaction?: "like" | "dislike" | null }>;
          if (extra[0]) {
            setShorts((prev) => [extra[0], ...prev.filter((s) => String(s.id) !== String(extra[0].id))]);
          }
        }
      }
    } catch {
      setError("Could not load Shorts. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [fetchShortsPage, user?.id]);

  const updateShortViews = useCallback((videoId: string | number, views: number) => {
    setShorts((prev) =>
      prev.map((item) =>
        String(item.id) === String(videoId)
          ? { ...item, viewsCount: views }
          : item
      )
    );
  }, []);

  useEffect(() => {
    fetchShorts();
  }, [fetchShorts, feedRefreshTrigger]);

  useEffect(() => {
    if (!hasMore || loadingMoreRef.current || loading) return;
    if (shorts.length === 0) return;
    if (activeIndex < shorts.length - 2) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    fetchShortsPage(page + 1, true)
      .catch(() => {})
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [activeIndex, hasMore, shorts.length, page, fetchShortsPage, loading]);

  // Deep link: /shorts?id=123 scrolls to that short once loaded.
  useEffect(() => {
    if (didInitialScroll.current || shorts.length === 0 || !initialIdParam) return;
    const idx = shorts.findIndex((s) => String(s.id) === String(initialIdParam));
    if (idx >= 0) {
      didInitialScroll.current = true;
      setActiveIndex(idx);
      requestAnimationFrame(() => {
        slideRefs.current[idx]?.scrollIntoView({ block: "start" });
      });
    }
  }, [shorts, initialIdParam]);

  /** Native scroll-snap + IntersectionObserver = reliable swipe on all phones. */
  useEffect(() => {
    const root = containerRef.current;
    if (!root || shorts.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const idx = Number((entry.target as HTMLElement).dataset.index);
            if (!Number.isNaN(idx)) {
              setActiveIndex(idx);
              const id = shorts[idx]?.id;
              if (id) {
                // Keep the URL shareable as the user swipes.
                window.history.replaceState(null, "", `/shorts?id=${id}`);
              }
            }
          }
        });
      },
      { root, threshold: [0.6] }
    );

    slideRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [shorts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[70dvh]">
        <Loader2 className="w-7 h-7 text-red-600 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto px-4 py-10">
        <ErrorState message={error} onRetry={fetchShorts} />
      </div>
    );
  }

  if (shorts.length === 0) {
    return (
      <div className="max-w-md mx-auto px-4 py-10">
        <EmptyState
          title="No Shorts available yet"
          description="Vertical Shorts uploaded by creators will appear here."
          actionLabel="Create a Short"
          onAction={openUploadModal}
          icon={<Flame className="w-7 h-7 text-red-500" />}
        />
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        className="shorts-feed snap-y-mandatory w-full overflow-y-scroll overscroll-contain no-scrollbar"
      >
        {shorts.map((short, idx) => (
          <div
            key={short.id}
            data-index={idx}
            ref={(el) => {
              slideRefs.current[idx] = el;
            }}
          >
            <ShortSlide
              short={short}
              active={idx === activeIndex}
              preloadHint={
                idx === activeIndex
                  ? "auto"
                  : // Warm only the metadata (moov atom, a few KB) of the slide the
                    // user is about to swipe to. Nothing else is downloaded.
                  idx === activeIndex + 1
                  ? "metadata"
                  : "none"
              }
              audioEnabledByUser={audioEnabledByUser}
              onAudioGesture={() => setAudioEnabledByUser(true)}
              onOpenComments={() => setCommentsFor(short.id)}
              onLiked={(likes, reaction) =>
                setShorts((prev) =>
                  prev.map((s) =>
                    String(s.id) === String(short.id)
                      ? { ...s, likesCount: likes, userReaction: reaction }
                      : s
                  )
                )
              }
              onViewCounted={updateShortViews}
            />
          </div>
        ))}
      </div>

      {commentsFor !== null && (
        <CommentsSheet
          videoId={commentsFor}
          onClose={() => setCommentsFor(null)}
          onPosted={() =>
            setShorts((prev) =>
              prev.map((s) =>
                String(s.id) === String(commentsFor)
                  ? { ...s, commentsCount: (s.commentsCount || 0) + 1 }
                  : s
              )
            )
          }
        />
      )}
    </>
  );
}

export default function ShortsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-[70dvh] text-sm text-zinc-500">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      }
    >
      <ShortsContent />
    </Suspense>
  );
}

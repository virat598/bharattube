"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  Subtitles,
  RectangleHorizontal,
  RotateCcw,
  FastForward,
  Rewind,
} from "lucide-react";
import { formatDuration } from "@/lib/format";
import { apiUrl } from "@/lib/api-config";
import { recordWatchSignal, recordInteractionSignal } from "@/lib/rec-client";
import { useMiniPlayer } from "@/components/MiniPlayer";
import { useApp } from "@/context/AppContext";

/** Double-tap seek interval (YouTube uses 10s). */
const SEEK_SECONDS = 10;
/** Max gap between two taps that still counts as a double tap. */
const DOUBLE_TAP_MS = 300;
/** A tap only counts when the finger barely moved. */
const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 400;

interface CaptionTrackMeta {
  lang: string;
  label: string;
  src: string;
  kind?: string;
}

interface SeekFeedback {
  id: number;
  delta: number;
}

interface VideoPlayerProps {
  videoId: string | number;
  videoUrl: string;
  thumbnailUrl: string;
  title: string;
  initialDuration?: number;
  savedProgressSeconds?: number;
  theaterMode: boolean;
  onToggleTheater: () => void;
  onViewsUpdated?: (newViewsCount: number) => void;
  /** Account playback preferences (Settings → Playback). */
  autoPlay?: boolean;
  initialPlaybackRate?: number;
  initialCaptions?: boolean;
}

export function VideoPlayer({
  videoId,
  videoUrl,
  thumbnailUrl,
  title,
  initialDuration = 0,
  savedProgressSeconds = 0,
  theaterMode,
  onToggleTheater,
  onViewsUpdated,
  autoPlay = false,
  initialPlaybackRate = 1,
  initialCaptions = false,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { activate, reclaim, isOwnedByWatchPage } = useMiniPlayer();

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  /**
   * True when the browser blocked audible autoplay and we started muted
   * instead (shows the "Tap to unmute" pill). Cleared on first unmute.
   */
  const [autoplayMuted, setAutoplayMuted] = useState(false);
  const autoplayTriedRef = useRef(false);
  /** Idle timer that hides the controls 3s after the last interaction. */
  const hideTimerRef = useRef<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(initialPlaybackRate || 1);
  const [quality, setQuality] = useState("Auto (Source)");
  const qualitySeekRef = useRef<number | null>(null);
  const [captionsEnabled, setCaptionsEnabled] = useState(Boolean(initialCaptions));
  const [captionsNotice, setCaptionsNotice] = useState("");
  /** Real caption tracks resolved for this video (empty = genuinely none). */
  const [captionTracks, setCaptionTracks] = useState<CaptionTrackMeta[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resumedBanner, setResumedBanner] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  /**
   * YouTube-style surface behaviour: a single tap shows/hides the controls and
   * never pauses playback, a double tap seeks ±10s.
   */
  const [controlsVisible, setControlsVisible] = useState(true);
  /** Ref mirror so the tap handler (async timeout) reads fresh visibility. */
  const controlsVisibleRef = useRef(true);
  useEffect(() => {
    controlsVisibleRef.current = controlsVisible;
  }, [controlsVisible]);
  const [seekFeedback, setSeekFeedback] = useState<SeekFeedback | null>(null);
  const { user, showToast } = useApp();

  const gestureStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastTapAtRef = useRef(0);
  const pendingTapRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const qualityDimensions: Record<string, [number, number] | null> = {
    "Auto (Source)": null,
    "1080p HD": [1920, 1080],
    "720p": [1280, 720],
    "480p": [854, 480],
    "360p": [640, 360],
    "240p": [426, 240],
  };

  const buildQualityUrl = (source: string, selectedQuality: string) => {
    const dimensions = qualityDimensions[selectedQuality];
    if (
      !dimensions ||
      !/res\.cloudinary\.com\//i.test(source) ||
      !/\/(?:video|raw)\/upload\//i.test(source)
    ) {
      return source;
    }
    const [width, height] = dimensions;
    return source.replace(
      /\/(video|raw)\/upload\//i,
      "/$1/upload/c_limit,q_auto,w_" + width + ",h_" + height + "/"
    );
  };

  const playbackVideoUrl = buildQualityUrl(videoUrl, quality);

  const watchedSecondsRef = useRef(0);
  const lastPositionRef = useRef(0);
  const lastProgressSentRef = useRef(0);

  // Apply saved account preferences to the media element.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = initialPlaybackRate || 1;
  }, [initialPlaybackRate]);

  /**
   * YouTube-style autoplay: try with sound; if the browser blocks it (no
   * carried-over user gesture), start muted and show the unmute pill instead
   * of leaving the video paused. Runs once, right after the resume seek in
   * `handleLoadedMetadata` so playback starts from the saved position.
   */
  const tryAutoplay = useCallback(async () => {
    if (!autoPlay || autoplayTriedRef.current) return;
    autoplayTriedRef.current = true;
    const v = videoRef.current;
    if (!v) return;
    try {
      await v.play();
      setIsPlaying(true);
      return;
    } catch {
      /* audible autoplay blocked — fall through to muted start */
    }
    try {
      v.muted = true;
      setIsMuted(true);
      setAutoplayMuted(true);
      await v.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  }, [autoPlay]);

  /** Restart the 3s idle timer; called on every control interaction. */
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      const v = videoRef.current;
      // YouTube behaviour: hide only while playing; paused keeps controls up.
      if (v && !v.paused) setControlsVisible(false);
    }, 3000);
  }, []);

  // Start (or re-arm) the auto-hide timer whenever playback state changes.
  useEffect(() => {
    if (!isPlaying) {
      // Paused → controls stay on screen.
      setControlsVisible(true);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      return;
    }
    pokeControls();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [isPlaying, pokeControls]);

  // Resume from saved progress when metadata loads
  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.duration && !Number.isNaN(v.duration) && Number.isFinite(v.duration)) {
      setDuration(v.duration);
    }

    if (qualitySeekRef.current !== null) {
      const seekTo = Math.min(
        qualitySeekRef.current,
        Math.max(0, (v.duration || initialDuration || 0) - 0.25)
      );
      v.currentTime = Math.max(0, seekTo);
      setCurrentTime(Math.max(0, seekTo));
      qualitySeekRef.current = null;
      return;
    }

    if (
      savedProgressSeconds > 2 &&
      savedProgressSeconds < (v.duration || initialDuration) - 3
    ) {
      v.currentTime = savedProgressSeconds;
      setCurrentTime(savedProgressSeconds);
      setResumedBanner(true);
      setTimeout(() => setResumedBanner(false), 4000);
    }

    // Start playback now that duration/resume position are known.
    void tryAutoplay();
  };

  // New video → allow autoplay again and clear the muted fallback.
  useEffect(() => {
    autoplayTriedRef.current = false;
    setAutoplayMuted(false);
    setIsMuted(false);
    // The <video> element itself is reused across videos — reset its real
    // muted flag too, or the next audible attempt silently plays muted.
    if (videoRef.current) videoRef.current.muted = false;
  }, [videoId, videoUrl]);

  // Latest playback state for the unmount hand-off below (no re-subscribes).
  const playbackStateRef = useRef({ isPlaying: false, currentTime: 0, duration: initialDuration });
  playbackStateRef.current = { isPlaying, currentTime, duration };

  /**
   * Hand this video to the mini player when the viewer navigates away while it
   * is still playing. Only long videos do this — Shorts have their own
   * continuous feed and player.
   *
   * If the viewer comes straight back to this same video, the watch page owns
   * playback again and the mini player stays out of the way.
   */
  useEffect(() => {
    // Returning to a video that the mini player is holding: give it back.
    if (isOwnedByWatchPage(videoId)) reclaim(videoId);

    const el = videoRef.current;
    return () => {
      if (!el || !el.src) return;
      const wasPlaying = !el.paused && !el.ended;
      const at = Number.isFinite(el.currentTime) ? el.currentTime : playbackStateRef.current.currentTime;
      if (!wasPlaying || at <= 0) return;
      activate({
        videoId,
        videoUrl,
        thumbnailUrl,
        title,
        currentTime: at,
        duration: Number.isFinite(el.duration) ? el.duration : playbackStateRef.current.duration,
      });
    };
    // Hand-off is an unmount-only behaviour; the closure reads props at the
    // moment of teardown, which is exactly what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const reportProgress = useCallback(
    async (currPos: number, dur: number) => {
      if (!user || !dur || watchedSecondsRef.current <= 0) return;

      try {
        const res = await fetch(apiUrl(`/history/${encodeURIComponent(String(videoId))}`), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            watchedDuration: watchedSecondsRef.current,
            currentTime: Math.max(0, Math.min(currPos, dur)),
            duration: dur,
            completed: watchedSecondsRef.current / dur >= 0.95,
          }),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const counted = Boolean(data?.viewCounted ?? data?.data?.viewCounted);
          if (counted) {
            // The backend is authoritative; refresh the video's view count
            // instead of incrementing it locally.
            const videoRes = await fetch(apiUrl(`/videos/${encodeURIComponent(String(videoId))}`), {
              cache: "no-store",
            });
            if (videoRes.ok) {
              const payload = await videoRes.json().catch(() => ({}));
              const latest = payload?.data ?? payload?.video ?? payload;
              const views = Number(latest?.views);
              if (Number.isFinite(views)) onViewsUpdated?.(views);
            }
          }
        }
      } catch {
        // Telemetry must never interrupt playback.
      }
    },
    [videoId, user, onViewsUpdated]
  );

  // Count only genuine forward playback deltas. Seeking, paused time and
  // background time are not added to watchedDuration.
  useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.paused || v.seeking) return;

      const current = Math.max(0, Number(v.currentTime) || 0);
      const previous = lastPositionRef.current;
      const delta = current - previous;

      if (delta > 0 && delta <= 2.5) {
        watchedSecondsRef.current += delta;
      }
      lastPositionRef.current = current;

      const now = Date.now();
      if (now - lastProgressSentRef.current >= 4000) {
        lastProgressSentRef.current = now;
        void reportProgress(current, v.duration || duration || initialDuration || 1);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isPlaying, duration, initialDuration, reportProgress]);


  useEffect(() => {
    const v = videoRef.current;
    if (!v || quality === "Auto (Source)") return;

    const nextUrl = buildQualityUrl(videoUrl, quality);
    // Unsupported sources are rejected in the quality menu itself (see
    // selectQuality), so this effect never needs to reset state.
    if (nextUrl === videoUrl) return;

    qualitySeekRef.current = v.currentTime;
    const wasPlaying = !v.paused;
    setMediaError(false);
    v.src = nextUrl;
    v.load();
    if (wasPlaying) {
      const playAfterMetadata = () => {
        v.removeEventListener("loadedmetadata", playAfterMetadata);
        v.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      };
      v.addEventListener("loadedmetadata", playAfterMetadata);
    }
    // buildQualityUrl is a pure helper recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality, videoUrl]);

  /** Quality menu: only Cloudinary media has real transcoded variants. */
  const selectQuality = (next: string) => {
    setSettingsOpen(false);
    if (next !== "Auto (Source)" && buildQualityUrl(videoUrl, next) === videoUrl) {
      setQuality("Auto (Source)");
      showToast(
        "Additional quality variants are available for Cloudinary-hosted videos only.",
        "info"
      );
      return;
    }
    setQuality(next);
  };


  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      lastPositionRef.current = v.currentTime;
      v.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      v.pause();
      setIsPlaying(false);
      void reportProgress(v.currentTime, v.duration || duration || initialDuration || 1);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    const newTime = Number(e.target.value);
    setCurrentTime(newTime);
    if (v) {
      v.currentTime = newTime;
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    const val = Number(e.target.value);
    setVolume(val);
    setIsMuted(val === 0);
    if (val > 0) setAutoplayMuted(false);
    if (v) {
      v.volume = val;
      v.muted = val === 0;
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    v.muted = nextMuted;
    if (!nextMuted) setAutoplayMuted(false);
  };

  const changeSpeed = (rate: number) => {
    const v = videoRef.current;
    setPlaybackRate(rate);
    if (v) {
      v.playbackRate = rate;
    }
    setSettingsOpen(false);
  };

  /**
   * Resolves the REAL caption tracks for this video. When none exist the CC
   * button reports "No captions available" instead of faking subtitles.
   */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/captions/${encodeURIComponent(String(videoId))}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { tracks: [] }))
      .then((data: { tracks?: CaptionTrackMeta[] }) => {
        if (cancelled) return;
        const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
        setCaptionTracks(tracks);
        // Honour the account's caption preference only when tracks exist.
        setCaptionsEnabled(tracks.length > 0 && Boolean(initialCaptions));
      })
      .catch(() => {
        if (!cancelled) setCaptionTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, initialCaptions]);

  // Apply the requested caption mode to the native text tracks.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const list = v.textTracks;
    for (let i = 0; i < list.length; i += 1) {
      const track = list[i];
      if (track.kind !== "subtitles") continue;
      track.mode = captionsEnabled && captionTracks.length > 0 ? "showing" : "disabled";
    }
  }, [captionsEnabled, captionTracks, playbackVideoUrl]);

  const toggleCaptions = () => {
    if (captionTracks.length === 0) {
      setCaptionsNotice("No captions available");
      showToast("No captions available for this video", "info");
      window.setTimeout(() => setCaptionsNotice(""), 2400);
      return;
    }
    setCaptionsEnabled((enabled) => !enabled);
  };

  /** Seeks by a real interval and shows the ±10s ripple. */
  const applySeek = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const next = Math.min(Math.max(0, v.currentTime + delta), total || v.currentTime + delta);
    try {
      v.currentTime = next;
    } catch {
      return;
    }
    setCurrentTime(next);
    lastPositionRef.current = next;

    const feedback: SeekFeedback = { id: Date.now() + Math.random(), delta };
    setSeekFeedback(feedback);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      setSeekFeedback((current) => (current?.id === feedback.id ? null : current));
      feedbackTimerRef.current = null;
    }, 650);
  }, []);

  /**
   * Tap handling on the video surface. Controls keep their own click handlers
   * and stop propagation, so play/pause, CC, volume, settings and fullscreen
   * are never swallowed by the gesture layer.
   */
  const handleSurfacePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    gestureStartRef.current = { x: e.clientX, y: e.clientY, at: Date.now() };
  };

  const handleSurfacePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = gestureStartRef.current;
    gestureStartRef.current = null;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > TAP_SLOP_PX) return;
    if (Date.now() - start.at > TAP_MAX_MS) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const now = Date.now();

    if (now - lastTapAtRef.current <= DOUBLE_TAP_MS) {
      lastTapAtRef.current = 0;
      if (pendingTapRef.current !== null) {
        window.clearTimeout(pendingTapRef.current);
        pendingTapRef.current = null;
      }
      applySeek(localX < rect.width / 2 ? -SEEK_SECONDS : SEEK_SECONDS);
      return;
    }

    lastTapAtRef.current = now;
    pendingTapRef.current = window.setTimeout(() => {
      pendingTapRef.current = null;
      // A plain tap only toggles the control overlay — it never pauses.
      if (controlsVisibleRef.current) {
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
        setControlsVisible(false);
      } else {
        pokeControls();
      }
    }, DOUBLE_TAP_MS);
  };

  /** Landscape lock for mobile fullscreen; silently ignored when unsupported. */
  const lockLandscape = async () => {
    try {
      const orientation = screen.orientation as
        | (ScreenOrientation & { lock?: (mode: string) => Promise<void> })
        | undefined;
      if (typeof orientation?.lock === "function") {
        await orientation.lock("landscape");
        return;
      }
      const legacy = (
        screen as Screen & {
          lockOrientation?: (mode: string) => boolean;
          mozLockOrientation?: (mode: string) => boolean;
        }
      );
      legacy.lockOrientation?.("landscape");
      legacy.mozLockOrientation?.("landscape");
    } catch {
      // Orientation locking is a progressive enhancement (iOS Safari, desktop).
    }
  };

  const unlockOrientation = () => {
    try {
      const orientation = screen.orientation as
        | (ScreenOrientation & { unlock?: () => void })
        | undefined;
      orientation?.unlock?.();
    } catch {
      /* ignore */
    }
  };

  const toggleFullscreen = () => {
    const el = containerRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void })
      | null;
    const video = videoRef.current as
      | (HTMLVideoElement & {
          webkitEnterFullscreen?: () => void;
          webkitSupportsFullscreen?: boolean;
        })
      | null;
    if (!el) return;

    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };

    const isFs = Boolean(document.fullscreenElement || doc.webkitFullscreenElement);

    if (!isFs) {
      if (typeof el.requestFullscreen === "function") {
        el.requestFullscreen()
          .then(() => {
            setIsFullscreen(true);
            // Rotate to landscape on phones that support the Screen Orientation
            // API so the video fills the screen like YouTube.
            void lockLandscape();
          })
          .catch(() => {
            // Container fullscreen refused (e.g. iOS Safari) — fall back to
            // the native video fullscreen below.
            if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
          });
      } else if (typeof el.webkitRequestFullscreen === "function") {
        el.webkitRequestFullscreen();
        setIsFullscreen(true);
        void lockLandscape();
      } else if (video?.webkitEnterFullscreen) {
        // iPhone Safari only allows fullscreen on the <video> element itself.
        video.webkitEnterFullscreen();
      }
    } else if (typeof document.exitFullscreen === "function") {
      document.exitFullscreen()
        .then(() => {
          setIsFullscreen(false);
          unlockOrientation();
        })
        .catch(() => {});
    } else if (typeof doc.webkitExitFullscreen === "function") {
      doc.webkitExitFullscreen();
      setIsFullscreen(false);
      unlockOrientation();
    }
  };

  // Keep icon state in sync when the user exits fullscreen with a gesture, and
  // hide the surrounding page chrome (bottom nav/header) while fullscreen.
  useEffect(() => {
    const sync = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const active = Boolean(document.fullscreenElement || doc.webkitFullscreenElement);
      setIsFullscreen(active);
      document.body.classList.toggle("bt-player-fullscreen", active);
      if (!active) unlockOrientation();
      else void lockLandscape();
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      document.body.classList.remove("bt-player-fullscreen");
    };
  }, []);

  const effectiveDuration = Math.max(duration || initialDuration || 1, 1);
  const progressPercent = Math.min(
    100,
    Math.max(0, (currentTime / effectiveDuration) * 100)
  );

  return (
    <div
      ref={containerRef}
      className={`bt-player relative group bg-black rounded-2xl overflow-hidden select-none border border-zinc-800/80 shadow-2xl ${
        theaterMode ? "w-full aspect-video max-h-[78vh]" : "w-full aspect-video"
      }`}
    >
      <video
        ref={videoRef}
        src={playbackVideoUrl}
        poster={thumbnailUrl}
        playsInline
        onLoadedMetadata={handleLoadedMetadata}
        onSeeking={() => { lastPositionRef.current = videoRef.current?.currentTime || 0; }}
        onTimeUpdate={() => {
          if (videoRef.current) {
            setCurrentTime(videoRef.current.currentTime);
          }
        }}
        onPlay={() => { lastPositionRef.current = videoRef.current?.currentTime || 0; setIsPlaying(true); }}
        onPause={() => setIsPlaying(false)}
        onError={() => setMediaError(true)}
        onEnded={() => {
          setIsPlaying(false);
          if (videoRef.current) {
            void reportProgress(
              videoRef.current.currentTime,
              videoRef.current.duration || effectiveDuration
            );
          }
        }}
        className="w-full h-full object-contain cursor-pointer"
      >
        {/* Real caption tracks resolved from /api/captions/:videoId */}
        {captionTracks.map((track, index) => (
          <track
            key={`${track.src}-${index}`}
            kind="subtitles"
            src={track.src}
            srcLang={track.lang}
            label={track.label}
          />
        ))}
      </video>

      {/*
        Gesture surface: single tap toggles the controls, double tap on the
        left/right half seeks ∓10s. Sits above the video and below the controls.
      */}
      <div
        className="absolute inset-0 z-10 touch-manipulation"
        onPointerDown={handleSurfacePointerDown}
        onPointerUp={handleSurfacePointerUp}
        onPointerCancel={() => {
          gestureStartRef.current = null;
        }}
        aria-label="Video playback area"
      />

      {/* Double-tap seek feedback */}
      {seekFeedback && (
        <div
          key={seekFeedback.id}
          className={`bt-seek-ripple pointer-events-none absolute inset-y-0 ${
            seekFeedback.delta < 0 ? "left-0" : "right-0"
          } w-1/2 z-20 flex items-center justify-center`}
        >
          <span className="flex flex-col items-center gap-1 rounded-full bg-black/65 px-4 py-3 text-white backdrop-blur-sm">
            {seekFeedback.delta < 0 ? (
              <Rewind className="h-6 w-6" />
            ) : (
              <FastForward className="h-6 w-6" />
            )}
            <span className="text-xs font-semibold tabular-nums">
              {Math.abs(seekFeedback.delta)} seconds
            </span>
          </span>
        </div>
      )}

      {/* Resumed from Watch Progress Notification */}
      {resumedBanner && (
        <div className="absolute top-4 left-4 px-3.5 py-1.5 rounded-lg bg-black/80 border border-zinc-700 text-xs text-zinc-200 flex items-center gap-2 backdrop-blur-md">
          <RotateCcw className="w-3.5 h-3.5 text-red-500" />
          <span>Resumed from {formatDuration(savedProgressSeconds)}</span>
        </div>
      )}

      {/* Caption availability notice (never a fake subtitle line) */}
      {captionsNotice && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 z-20 -translate-x-1/2 rounded bg-black/85 px-3 py-1.5 text-xs font-medium text-white">
          {captionsNotice}
        </div>
      )}

      {mediaError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 text-center px-6">
          <p className="text-sm text-zinc-200">
            This video could not be played. It may still be processing or the
            file is unavailable.
          </p>
          <button
            type="button"
            onClick={() => {
              setMediaError(false);
              videoRef.current?.load();
            }}
            className="px-4 py-2 rounded-full bg-red-600 text-white text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      )}

      {/*
        Centre play button — YouTube-style: only while paused. While playing
        it is never shown; tap the screen to reveal the bottom controls bar.
      */}
      {!mediaError && !isPlaying && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          aria-label="Play video"
          className="absolute inset-0 z-20 m-auto h-14 w-14 rounded-full bg-black/55 text-white flex items-center justify-center cursor-pointer"
        >
          <Play className="h-6 w-6 fill-current ml-0.5" />
        </button>
      )}

      {/* "Tap to unmute" — only when the browser forced a muted autoplay. */}
      {autoplayMuted && isPlaying && !mediaError && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const v = videoRef.current;
            if (v) v.muted = false;
            setIsMuted(false);
            setAutoplayMuted(false);
            pokeControls();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          className="absolute top-3 left-3 z-20 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
        >
          <VolumeX className="h-4 w-4" />
          Tap to unmute
        </button>
      )}

      {/* Bottom Controls Bar */}
      <div
        onPointerDownCapture={() => pokeControls()}
        className={`absolute bottom-0 inset-x-0 z-30 bg-gradient-to-t from-black/95 via-black/70 to-transparent pt-8 pb-3 px-4 transition-opacity duration-200 ${
          controlsVisible
            ? "opacity-100"
            : "opacity-0 pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto"
        }`}
      >
        {/* Scrubbable Progress Bar */}
        <div className="relative flex items-center w-full mb-2.5">
          {/* Visual only: 3px track (was 6px); grows slightly on hover. */}
          <div className="w-full h-[3px] group-hover:h-1 transition-[height] duration-150 bg-zinc-600/80 rounded-full overflow-hidden">
            <div
              className="h-full bg-red-600"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={effectiveDuration}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            className="absolute -inset-y-2 inset-x-0 w-full h-[calc(100%+1rem)] opacity-0 cursor-pointer"
            aria-label="Seek video progress"
          />
        </div>

        {/* Controls Row */}
        <div className="flex items-center justify-between gap-2 text-white">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="p-1.5 rounded-lg hover:bg-white/15 transition-colors cursor-pointer"
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-white" />
              ) : (
                <Play className="w-5 h-5 fill-white" />
              )}
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleMute}
                className="p-1.5 rounded-lg hover:bg-white/15 transition-colors cursor-pointer"
                aria-label={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-5 h-5" />
                ) : (
                  <Volume2 className="w-5 h-5" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="bt-range hidden sm:block w-20"
                style={{ ["--bt-fill" as string]: `${(isMuted ? 0 : volume) * 100}%` } as React.CSSProperties}
                aria-label="Volume"
              />
            </div>

            {/* Timecode */}
            <div className="text-xs font-medium tabular-nums text-zinc-200 ml-1">
              <span>{formatDuration(currentTime)}</span>
              <span className="mx-1 text-zinc-400">/</span>
              <span>{formatDuration(effectiveDuration)}</span>
            </div>
          </div>

          {/* Right Controls */}
          <div className="flex items-center gap-1.5 relative">
            {/* Captions Toggle — uses the real caption tracks for this video */}
            <button
              type="button"
              onClick={toggleCaptions}
              title={
                captionTracks.length === 0
                  ? "No captions available"
                  : captionsEnabled
                  ? "Turn off captions"
                  : "Turn on captions"
              }
              aria-pressed={captionsEnabled}
              className={`p-1.5 rounded-lg hover:bg-white/15 transition-colors cursor-pointer ${
                captionsEnabled ? "text-red-500 bg-white/10" : "text-white"
              }`}
            >
              <Subtitles className="w-5 h-5" />
            </button>

            {/* Speed & Quality Settings */}
            <button
              type="button"
              onClick={() => setSettingsOpen((o) => !o)}
              title="Playback Settings"
              className="p-1.5 rounded-lg hover:bg-white/15 transition-colors cursor-pointer flex items-center gap-1 text-xs font-semibold"
            >
              <Settings className="w-4 h-4" />
              <span>{playbackRate}x</span>
            </button>

            {settingsOpen && (
              <div className="absolute bottom-11 right-0 w-56 rounded-xl bg-zinc-900/95 border border-zinc-700 p-3 shadow-2xl z-50 text-xs space-y-3 backdrop-blur-md">
                <div>
                  <div className="text-zinc-400 font-semibold mb-1.5">
                    Playback Speed
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => changeSpeed(rate)}
                        className={`py-1 rounded font-medium cursor-pointer ${
                          playbackRate === rate
                            ? "bg-red-600 text-white"
                            : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                        }`}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-zinc-400 font-semibold mb-1.5">
                    Stream Quality
                  </div>
                  <div className="flex flex-col gap-1">
                    {["Auto (Source)", "1080p HD", "720p", "480p", "360p", "240p"].map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => selectQuality(q)}
                        className={`px-2.5 py-1 rounded text-left cursor-pointer ${
                          quality === q
                            ? "bg-red-600/20 text-red-400 font-semibold"
                            : "hover:bg-zinc-800 text-zinc-300"
                        }`}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Theater Mode */}
            <button
              type="button"
              onClick={onToggleTheater}
              title="Theater Mode"
              className="hidden md:inline-flex p-1.5 rounded-lg hover:bg-white/15 transition-colors cursor-pointer"
            >
              <RectangleHorizontal className="w-5 h-5" />
            </button>

            {/* Fullscreen */}
            <button
              type="button"
              onClick={toggleFullscreen}
              title="Fullscreen"
              className="p-1.5 rounded-lg hover:bg-white/15 transition-colors cursor-pointer"
            >
              {isFullscreen ? (
                <Minimize className="w-5 h-5" />
              ) : (
                <Maximize className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

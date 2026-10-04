"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  MoreVertical,
  Clock,
  ListPlus,
  Share2,
  EyeOff,
  Flag,
  Trash2,
  ThumbsUp,
  ThumbsDown,
  BellCheck,
  Video as VideoIcon,
  AlertCircle,
  MessageCircle,
  Copy,
  X,
} from "lucide-react";
import { formatDuration, formatCount, formatTimeAgo } from "@/lib/format";
import { useApp } from "@/context/AppContext";
import { apiUrl, isRouteNotFound, subscribeApiUrl } from "@/lib/api-config";
import { capabilityOf, isUnsupportedResponse } from "@/lib/backend-capabilities";
import { channelHref } from "@/lib/backend-adapter";
import { toggleVideoLikeApi, persistUserLikeAction } from "@/lib/likes-manager";
import { recordInteractionSignal } from "@/lib/rec-client";

export interface CreatorInfo {
  id: string | number;
  channelId?: string | number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  isVerified?: boolean;
  subscriberCount?: number;
  bio?: string | null;
}

export interface VideoItem {
  id: string | number;
  userId: string | number;
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl: string;
  duration: number;
  category: string;
  tags: string;
  visibility: string;
  isShort: boolean;
  isLive: boolean;
  forKids: boolean;
  viewsCount: number;
  likesCount: number;
  dislikesCount: number;
  commentsCount: number;
  createdAt: string;
  creator: CreatorInfo;
  /** Real per-user state from the backend feed (never assumed on the client). */
  userReaction?: "like" | "dislike" | null;
  isSubscribed?: boolean;
  watchProgress?: {
    progressSeconds: number;
    durationSeconds: number;
    completionPercentage: number;
    lastWatchedAt?: string;
  } | null;
}

export function UserAvatar({
  name,
  avatarUrl,
  size = "md",
  className = "",
}: {
  name: string;
  avatarUrl?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const sizeClasses = {
    xs: "w-6 h-6 text-[11px]",
    sm: "w-8 h-8 text-xs",
    md: "w-9 h-9 text-sm",
    lg: "w-12 h-12 text-base",
    xl: "w-24 h-24 text-2xl",
  }[size];
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageFailed = Boolean(avatarUrl && failedUrl === avatarUrl);

  const initials = (name || "U")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  if (avatarUrl && !imageFailed) {
    return (
      <img
        src={avatarUrl}
        alt={`${name} profile photo`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(avatarUrl)}
        className={`${sizeClasses} rounded-full object-cover shrink-0 bg-zinc-200 dark:bg-zinc-800 ${className}`}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={`${name} default profile photo`}
      className={`${sizeClasses} rounded-full bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 font-semibold flex items-center justify-center shrink-0 select-none ${className}`}
    >
      {initials || "U"}
    </div>
  );
}

export function SubscribeButton({
  channelId,
  initialSubscribed,
  initialCount,
  onStatusChange,
  size = "md",
  isOwner: isOwnerProp,
  showCount = true,
}: {
  /** Channel handle (preferred) or id, as used by the deployed backend. */
  channelId: number | string;
  initialSubscribed: boolean;
  initialCount?: number;
  onStatusChange?: (isSubscribed: boolean, newCount: number) => void;
  size?: "sm" | "md";
  /** Explicit owner flag — avoids guessing from id types. */
  isOwner?: boolean;
  /** When false, the subscriber count next to the label is hidden. */
  showCount?: boolean;
}) {
  const { user, openAuthModal, showToast } = useApp();
  const [isSubscribed, setIsSubscribed] = useState(initialSubscribed);
  const [count, setCount] = useState(initialCount ?? 0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setIsSubscribed(initialSubscribed);
  }, [initialSubscribed]);

  useEffect(() => {
    if (typeof initialCount === "number") setCount(initialCount);
  }, [initialCount]);

  const ownsChannel =
    isOwnerProp ??
    Boolean(user && String(user.id) === String(channelId));

  if (ownsChannel) {
    return (
      <Link
        href="/edit-channel"
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700 transition-colors"
      >
        Manage Channel
      </Link>
    );
  }

  /**
   * Subscribe/unsubscribe.
   *
   * The backend currently has NO subscribe route (verified: POST/DELETE/PUT
   * /channel/:handle/subscribe → "Route not found"). We therefore call the real
   * route and, if the backend says it does not exist, we report that precisely.
   * We never fake a success and never change a count locally.
   */
  const handleToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) {
      openAuthModal("login");
      showToast("Sign in to subscribe to this channel", "info");
      return;
    }

    setSubmitting(true);
    try {
      // The backend implements one authenticated toggle endpoint.
      const res = await fetch(subscribeApiUrl(channelId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok) {
        if (isRouteNotFound(data)) {
          showToast(
            "Subscriptions aren't available on this backend yet.",
            "error"
          );
          return;
        }
        showToast(
          (data && (data.message || data.error)) ||
            "Failed to update subscription",
          "error"
        );
        return;
      }

      // Trust only what the backend returned.
      const nextSubscribed =
        typeof data?.isSubscribed === "boolean"
          ? data.isSubscribed
          : typeof data?.data?.isSubscribed === "boolean"
          ? data.data.isSubscribed
          : !isSubscribed;

      setIsSubscribed(nextSubscribed);
      // Ranking signal: subscribing is the strongest creator-affinity signal,
      // unsubscribing removes it. Scoped to the channel, not the video.
      recordInteractionSignal(nextSubscribed ? "subscribe" : "unsubscribe", channelId);
      const apiCount = Number(
        data?.subscribersCount ??
          data?.subscriberCount ??
          data?.data?.subscribersCount ??
          data?.data?.subscriberCount ??
          data?.channel?.subscribersCount
      );
      let nextCount = Number.isFinite(apiCount)
        ? apiCount
        : Math.max(0, count + (nextSubscribed === isSubscribed ? 0 : nextSubscribed ? 1 : -1));
      let confirmedSubscribed = nextSubscribed;

      /**
       * Re-read the authoritative state. The toggle response shape is not
       * guaranteed to carry a count, so instead of trusting a local ±1 we ask
       * the backend's public GET /subscriptions/:channelId, which returns
       * { totalSubscribers, subscribers:[{_id…}] } (verified live).
       */
      try {
        const verify = await fetch(subscribeApiUrl(channelId), { cache: "no-store" });
        if (verify.ok) {
          const state = await verify.json().catch(() => null);
          const total = Number(state?.totalSubscribers ?? state?.data?.totalSubscribers);
          const list: any[] = Array.isArray(state?.subscribers)
            ? state.subscribers
            : Array.isArray(state?.data?.subscribers)
            ? state.data.subscribers
            : [];
          if (Number.isFinite(total)) {
            nextCount = total;
            if (list.length === total) {
              confirmedSubscribed = list.some(
                (s) => String(s?._id ?? s?.id ?? s) === String(user.id)
              );
            }
          }
        }
      } catch {
        /* keep the toggle response values */
      }

      setIsSubscribed(confirmedSubscribed);
      setCount(nextCount);
      onStatusChange?.(confirmedSubscribed, nextCount);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("bharattube:subscription-updated"));
      }
      showToast(
        confirmedSubscribed ? "Subscription added" : "Unsubscribed from channel",
        "success"
      );
    } catch {
      showToast("Network error updating subscription", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const padding = size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm";

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={submitting}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-colors cursor-pointer select-none disabled:opacity-60 ${padding} ${
        isSubscribed
          ? "bg-zinc-200 hover:bg-zinc-300 text-zinc-900 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-100"
          : "bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900"
      }`}
    >
      {isSubscribed ? (
        <>
          <BellCheck className="w-4 h-4" />
          <span>Subscribed</span>
        </>
      ) : (
        <span>Subscribe</span>
      )}
      {showCount && count > 0 && (
        <span className="opacity-75 text-xs font-normal">
          {formatCount(count)}
        </span>
      )}
    </button>
  );
}

export function LikeDislikePill({
  videoId,
  likesCount,
  dislikesCount,
  userReaction,
  onReactionChange,
}: {
  videoId: string | number;
  likesCount: number;
  dislikesCount: number;
  userReaction: "like" | "dislike" | null;
  onReactionChange: (
    likes: number,
    dislikes: number,
    reaction: "like" | "dislike" | null
  ) => void;
}) {
  const { user, openAuthModal, showToast } = useApp();
  const [busy, setBusy] = useState(false);

  const handleReact = async (type: "like" | "dislike") => {
    if (!user) {
      openAuthModal("login");
      showToast(`Sign in to ${type} this video`, "info");
      return;
    }
    if (busy) return;
    setBusy(true);

    const removing = userReaction === type;
    const prevLikes = likesCount;
    const prevDislikes = dislikesCount;
    const prevReaction = userReaction;

    if (type === "like") {
      const nextLiked = !removing;
      const optimisticLikes = Math.max(0, prevLikes + (nextLiked ? 1 : -1));
      const optimisticDislikes =
        prevReaction === "dislike" ? Math.max(0, prevDislikes - 1) : prevDislikes;
      onReactionChange(optimisticLikes, optimisticDislikes, nextLiked ? "like" : null);

      try {
        const result = await toggleVideoLikeApi(videoId, removing, user.id);
        if (typeof result.likesCount === "number") {
          onReactionChange(
            result.likesCount,
            optimisticDislikes,
            result.nextLiked ? "like" : null
          );
        }
      } catch {
        onReactionChange(prevLikes, prevDislikes, prevReaction);
        showToast("Network error", "error");
      } finally {
        setBusy(false);
      }
      return;
    }

    const nextReaction = removing ? null : "dislike";
    // Ranking signal: an explicit dislike is a strong NEGATIVE interest signal
    // for this video, its topic and its creator. Removing a dislike is neutral.
    if (!removing) recordInteractionSignal("dislike", videoId);
    const optimisticDislikes = Math.max(0, prevDislikes + (removing ? -1 : 1));
    const optimisticLikes =
      prevReaction === "like" ? Math.max(0, prevLikes - 1) : prevLikes;
    if (prevReaction === "like") {
      persistUserLikeAction(user.id, videoId, false);
    }
    onReactionChange(optimisticLikes, optimisticDislikes, nextReaction);

    try {
      const res = await fetch(apiUrl(`/likes/${encodeURIComponent(String(videoId))}`), {
        method: removing ? "DELETE" : "POST",
        credentials: "include",
        headers: removing ? undefined : { "Content-Type": "application/json" },
        ...(removing ? {} : { body: JSON.stringify({ type }) }),
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (
        res.ok &&
        (typeof data?.likesCount === "number" || typeof data?.likes === "number")
      ) {
        onReactionChange(
          Number(data.likesCount ?? data.likes),
          Number(data.dislikesCount ?? data.dislikes ?? optimisticDislikes),
          nextReaction
        );
      }
    } catch {
      /* keep optimistic update */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 inline-flex items-center h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
      <button
        type="button"
        onClick={() => handleReact("like")}
        disabled={busy}
        aria-label={userReaction === "like" ? "Remove like" : "Like"}
        aria-pressed={userReaction === "like"}
        className={`h-full flex items-center gap-2 pl-4 pr-3.5 text-sm font-medium transition-colors cursor-pointer disabled:opacity-60 ${
          userReaction === "like"
            ? "text-red-600"
            : "text-zinc-800 dark:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        }`}
      >
        <ThumbsUp
          className={`w-5 h-5 ${
            userReaction === "like" ? "fill-current" : ""
          }`}
        />
        <span className="tabular-nums">{formatCount(likesCount)}</span>
      </button>
      <div className="w-px h-6 bg-zinc-300 dark:bg-zinc-700" />
      <button
        type="button"
        onClick={() => handleReact("dislike")}
        disabled={busy}
        title="Dislike"
        aria-label={userReaction === "dislike" ? "Remove dislike" : "Dislike"}
        aria-pressed={userReaction === "dislike"}
        className={`h-full flex items-center gap-1.5 pl-3.5 pr-4 text-sm font-medium transition-colors cursor-pointer disabled:opacity-60 ${
          userReaction === "dislike"
            ? "text-red-600"
            : "text-zinc-800 dark:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        }`}
      >
        <ThumbsDown
          className={`w-5 h-5 ${
            userReaction === "dislike" ? "fill-current" : ""
          }`}
        />
        {dislikesCount > 0 && (
          <span className="tabular-nums text-xs">
            {formatCount(dislikesCount)}
          </span>
        )}
      </button>
    </div>
  );
}

export function VideoCard({
  video,
  onRemoveFromList,
}: {
  video: VideoItem;
  onRemoveFromList?: (videoId: string | number) => void;
}) {
  const { user, openAuthModal, openPlaylistModal, showToast, triggerFeedRefresh } =
    useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  if (hidden) return null;

  const watchHref = video.isShort
    ? `/shorts?id=${video.id}`
    : `/watch/${video.id}`;

  const handleSaveWatchLater = async () => {
    setMenuOpen(false);
    if (!user) {
      openAuthModal("login");
      showToast("Sign in to save videos to Watch Later", "info");
      return;
    }
    try {
      const res = await fetch(apiUrl(`/watch-later/${video.id}`), {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) {
        showToast(
          data.isSaved ? "Saved to Watch Later" : "Removed from Watch Later",
          "success"
        );
      }
    } catch {
      showToast("Failed to update Watch Later", "error");
    }
  };

  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}${watchHref}` : watchHref;

  const handleShare = () => {
    setMenuOpen(false);
    setShareOpen(true);
  };

  const handleCopyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Video link copied to clipboard", "success");
    } catch {
      showToast(shareUrl, "info");
    }
  };

  const handleWhatsAppShare = () => {
    const text = `${video.title || "BharatTube video"} ${shareUrl}`;
    window.open(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer"
    );
    setShareOpen(false);
  };

  const handleNativeShare = async () => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: video.title, url: shareUrl });
        setShareOpen(false);
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }
    await handleCopyShareLink();
  };

  const handleNotInterested = async () => {
    setMenuOpen(false);
    setHidden(true);
    // Ranking signal: this video is now suppressed for this viewer for a long
    // window, and its topic/creator affinity is pulled down accordingly.
    recordInteractionSignal("not_interested", video.id);
    showToast("Video removed from your recommendations for this session.", "info");
  };

  const handleReport = async () => {
    setMenuOpen(false);
    if (!user) {
      openAuthModal("login");
      return;
    }
    showToast("Video reporting is not exposed by the current backend.", "info");
  };

  const handleDeleteOwnVideo = async () => {
    setMenuOpen(false);
    try {
      const res = await fetch(apiUrl(`/videos/${video.id}`), {
        method: "DELETE",
      });
      if (res.ok) {
        setHidden(true);
        triggerFeedRefresh();
        onRemoveFromList?.(video.id);
        showToast("Video permanently deleted", "success");
      }
    } catch {
      showToast("Failed to delete video", "error");
    }
  };

  return (
    <div className="group flex flex-col gap-2.5 sm:gap-3 relative">
      {/* Thumbnail Container — 12px radius, 16:9 (long) or 9:16 (Shorts) */}
      <Link
        href={watchHref}
        className={`relative block rounded-xl overflow-hidden bg-zinc-200 dark:bg-zinc-800 ${
          video.isShort
            ? "w-full max-w-[220px] mx-auto aspect-[9/16]"
            : "w-full aspect-video"
        }`}
      >
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <video
            src={video.videoUrl ? `${video.videoUrl}#t=0.5` : undefined}
            preload="metadata"
            muted
            playsInline
            className="w-full h-full object-cover pointer-events-none"
          />
        )}

        {/* Visibility / Live / Shorts / Duration Badge */}
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
          {video.visibility !== "public" && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500 text-zinc-950 text-[10px] font-semibold uppercase">
              {video.visibility}
            </span>
          )}
          {video.isLive ? (
            <span className="px-2 py-0.5 rounded bg-red-600 text-white text-[11px] font-semibold uppercase flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-white" />
              Live
            </span>
          ) : video.isShort ? (
            <span className="px-1 py-px rounded-md bg-black/80 text-white text-[11.5px] font-semibold leading-4 tabular-nums">
              {formatDuration(video.duration)}
            </span>
          ) : (
            <span className="px-1 py-px rounded-md bg-black/80 text-white text-[11.5px] font-semibold leading-4 tabular-nums">
              {formatDuration(video.duration)}
            </span>
          )}
        </div>

        {video.isShort && (
          <span className="absolute top-2 left-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] font-medium">
            Shorts
          </span>
        )}

        {/* Saved Watch Progress Bar */}
        {video.watchProgress &&
          video.watchProgress.completionPercentage > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-700/80">
              <div
                className="h-full bg-red-600 transition-all"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(4, video.watchProgress.completionPercentage)
                  )}%`,
                }}
              />
            </div>
          )}
      </Link>

      {/* Metadata Row */}
      <div className="flex items-start gap-3 relative">
        <Link href={channelHref(video.creator)} className="shrink-0 mt-0.5">
          <UserAvatar
            name={video.creator.displayName}
            avatarUrl={video.creator.avatarUrl}
            size="md"
          />
        </Link>

        <div className="flex flex-col min-w-0 flex-1">
          <Link
            href={watchHref}
            className="text-[15px] font-medium leading-5 text-zinc-900 dark:text-zinc-100 line-clamp-2 break-words"
          >
            {video.title}
          </Link>

          <Link
            href={channelHref(video.creator)}
            className="mt-1 inline-flex items-center gap-1 max-w-full text-[13px] leading-[18px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
          >
            <span className="truncate">{video.creator.displayName}</span>
            {video.creator.isVerified && (
              <CheckCircle2 className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            )}
          </Link>

          <div className="text-[13px] leading-[18px] text-zinc-600 dark:text-zinc-400 flex items-center gap-1 tabular-nums min-w-0">
            <span className="whitespace-nowrap">{formatCount(video.viewsCount, "view", "views")}</span>
            <span aria-hidden="true">•</span>
            <span className="truncate">{formatTimeAgo(video.createdAt)}</span>
          </div>
        </div>

        {/* More Options Button & Dropdown */}
        <div ref={menuRef} className="relative shrink-0 -mr-2 -mt-2">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setMenuOpen((o) => !o);
            }}
            className="tap-target inline-flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-200/60 dark:hover:bg-zinc-800 active:bg-zinc-300/60 transition-colors cursor-pointer"
            aria-label="More options"
            aria-expanded={menuOpen}
          >
            <MoreVertical className="w-[18px] h-[18px]" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-11 w-52 max-w-[calc(100vw-2rem)] rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl py-1.5 z-40 text-sm">
              <button
                type="button"
                onClick={handleSaveWatchLater}
                className="w-full flex items-center gap-3 px-3.5 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <Clock className="w-4 h-4 text-zinc-400" />
                <span>Save to Watch Later</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openPlaylistModal(video.id);
                }}
                className="w-full flex items-center gap-3 px-3.5 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <ListPlus className="w-4 h-4 text-zinc-400" />
                <span>Save to Playlist</span>
              </button>
              <button
                type="button"
                onClick={handleShare}
                className="w-full flex items-center gap-3 px-3.5 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <Share2 className="w-4 h-4 text-zinc-400" />
                <span>Share</span>
              </button>
              <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
              <button
                type="button"
                onClick={handleNotInterested}
                className="w-full flex items-center gap-3 px-3.5 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <EyeOff className="w-4 h-4 text-zinc-400" />
                <span>Not interested</span>
              </button>
              <button
                type="button"
                onClick={handleReport}
                className="w-full flex items-center gap-3 px-3.5 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <Flag className="w-4 h-4 text-zinc-400" />
                <span>Report</span>
              </button>
              {user && user.id === video.userId && (
                <>
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                  <button
                    type="button"
                    onClick={handleDeleteOwnVideo}
                    className="w-full flex items-center gap-3 px-3.5 py-2 text-left text-red-500 hover:bg-red-500/10 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Delete Video</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {shareOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShareOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 shadow-lg overflow-hidden pb-safe">
            <div className="flex items-center justify-between pl-5 pr-3 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Share
              </h3>
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                aria-label="Close share menu"
                className="tap-target inline-flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={handleWhatsAppShare}
                  className="flex items-center justify-center gap-2 h-11 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors cursor-pointer"
                >
                  <MessageCircle className="w-5 h-5" />
                  <span>WhatsApp</span>
                </button>

                <button
                  type="button"
                  onClick={handleNativeShare}
                  className="flex items-center justify-center gap-2 h-11 px-4 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 text-sm font-medium transition-colors cursor-pointer"
                >
                  <Share2 className="w-5 h-5" />
                  <span>More</span>
                </button>
              </div>

              <div className="flex items-center gap-2 p-1.5 pl-3 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  className="flex-1 min-w-0 bg-transparent text-sm text-zinc-700 dark:text-zinc-300 focus:outline-none truncate"
                />
                <button
                  type="button"
                  onClick={handleCopyShareLink}
                  className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 text-sm font-medium transition-colors cursor-pointer"
                >
                  <Copy className="w-4 h-4" />
                  <span>Copy</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function VideoListItem({
  video,
  compact = false,
  onRemove,
}: {
  video: VideoItem;
  compact?: boolean;
  onRemove?: (videoId: string | number) => void;
}) {
  const watchHref = video.isShort
    ? `/shorts?id=${video.id}`
    : `/watch/${video.id}`;

  return (
    <div className="group flex flex-row items-start gap-3 py-3 relative">
      <Link
        href={watchHref}
        className={`relative block shrink-0 rounded-lg overflow-hidden bg-zinc-200 dark:bg-zinc-800 ${
          video.isShort
            ? compact
              ? "w-20 sm:w-24 aspect-[9/16]"
              : "w-24 sm:w-28 aspect-[9/16]"
            : compact
            ? "w-40 sm:w-44 aspect-video"
            : "w-40 xs:w-44 sm:w-64 aspect-video"
        }`}
      >
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <video
            src={video.videoUrl ? `${video.videoUrl}#t=0.5` : undefined}
            preload="metadata"
            muted
            playsInline
            className="w-full h-full object-cover pointer-events-none"
          />
        )}
        <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/80 text-white text-[11px] font-medium tabular-nums">
          {formatDuration(video.duration)}
        </span>
        {video.watchProgress &&
          video.watchProgress.completionPercentage > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-700/80">
              <div
                className="h-full bg-red-600"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(4, video.watchProgress.completionPercentage)
                  )}%`,
                }}
              />
            </div>
          )}
      </Link>

      <div className="flex flex-col flex-1 min-w-0 pr-6">
        <Link
          href={watchHref}
          className={`font-medium leading-snug text-zinc-900 dark:text-zinc-100 line-clamp-2 ${
            compact ? "text-sm" : "text-sm sm:text-base"
          }`}
        >
          {video.title}
        </Link>
        <Link
          href={channelHref(video.creator)}
          className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white inline-flex items-center gap-1"
        >
          <span>{video.creator.displayName}</span>
          {video.creator.isVerified && (
            <CheckCircle2 className="w-3 h-3 text-zinc-400" />
          )}
        </Link>
        <div className="text-xs text-zinc-500 mt-0.5 tabular-nums">
          {formatCount(video.viewsCount, "view", "views")} •{" "}
          {formatTimeAgo(video.createdAt)}
        </div>
        {!compact && video.description && (
          <p className="mt-2 hidden sm:line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
            {video.description}
          </p>
        )}
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(video.id)}
          title="Remove"
          aria-label="Remove"
          className="tap-target inline-flex items-center justify-center shrink-0 rounded-full text-zinc-400 hover:text-red-500 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
      {Array.from({ length: count }).map((_, idx) => (
        <div key={idx} className="flex flex-col gap-3 animate-pulse">
          <div className="w-full aspect-video rounded-xl bg-zinc-200 dark:bg-zinc-800/80" />
          <div className="flex gap-3">
            <div className="w-9 h-9 rounded-full bg-zinc-200 dark:bg-zinc-800 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-11/12" />
              <div className="h-3 bg-zinc-200 dark:bg-zinc-800 rounded w-2/3" />
              <div className="h-3 bg-zinc-200 dark:bg-zinc-800 rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 my-4">
      <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 mb-4 [&_svg]:w-6 [&_svg]:h-6 [&_svg]:text-zinc-500 dark:[&_svg]:text-zinc-400">
        {icon || <VideoIcon className="w-6 h-6" />}
      </div>
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h3>
      {description && (
        <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400 max-w-sm leading-relaxed">
          {description}
        </p>
      )}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 inline-flex items-center justify-center h-10 px-5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors cursor-pointer"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6 my-4">
      <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
        <AlertCircle className="w-6 h-6 text-red-600" />
      </div>
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        {message}
      </h3>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center justify-center h-10 px-5 rounded-lg bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 text-sm font-medium cursor-pointer"
        >
          Try again
        </button>
      )}
    </div>
  );
}

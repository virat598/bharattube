"use client";

import React, { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Share2,
  Download,
  MessageCircle,
  Clock,
  ListPlus,
  Flag,
  CheckCircle2,
  ThumbsUp,
  MessageSquare,
  CornerDownRight,
  Trash2,
  Edit3,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  Copy,
} from "lucide-react";
import { VideoPlayer } from "@/components/VideoPlayer";
import {
  UserAvatar,
  SubscribeButton,
  LikeDislikePill,
  VideoListItem,
  VideoItem,
  ErrorState,
} from "@/components/VideoComponents";
import { formatCount, formatTimeAgo } from "@/lib/format";
import { useApp } from "@/context/AppContext";
import { apiUrl, channelApiUrl } from "@/lib/api-config";
import {
  adaptChannel,
  adaptVideo,
  adaptVideos,
  unwrapEnvelope,
  listOf,
  channelHref,
} from "@/lib/backend-adapter";
import { isUnsupportedResponse, capabilityOf } from "@/lib/backend-capabilities";
import { isVideoLikedByUser } from "@/lib/likes-manager";
import { resolveChannelHandleForUser } from "@/lib/user-channel";
import { fetchRecommendedHome, fetchRecommendedRelated } from "@/lib/rec-feed";
import { recordInteractionSignal } from "@/lib/rec-client";

interface CommentData {
  id: string;
  videoId: string;
  userId: string;
  parentId: string | null;
  /** Top-level comment this item belongs to (itself for roots). */
  threadId: string;
  /** Backend `repliesCount` (authoritative reply total for this comment). */
  repliesCount: number;
  content: string;
  likesCount: number;
  userLiked: boolean;
  createdAt: string;
  updatedAt: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    isVerified: boolean;
  };
}

/**
 * How many "Up Next" videos to ask for in one request. Sized to cover the whole
 * library rather than a token handful: a creator with many uploads must still be
 * able to reach every one of them from the watch page.
 */
const RELATED_LIMIT = 200;

export default function WatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const videoId = id;

  const { user, preferences, openAuthModal, openPlaylistModal, showToast } =
    useApp();
  const router = useRouter();

  const [video, setVideo] = useState<
    | (VideoItem & {
        userReaction: "like" | "dislike" | null;
        isSubscribed: boolean;
        isSaved: boolean;
      })
    | null
  >(null);
  const [relatedVideos, setRelatedVideos] = useState<VideoItem[]>([]);
  /** Owner user id of the video's channel (from GET /channel/:handle → owner._id). */
  const [creatorOwnerId, setCreatorOwnerId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [theaterMode, setTheaterMode] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [commentsExpanded, setCommentsExpanded] = useState(false);

  useEffect(() => {
    setDescExpanded(false);
    // Desktop shows the full thread immediately (YouTube desktop behaviour);
    // mobile keeps the compact card with the top-comment preview.
    setCommentsExpanded(
      typeof window !== "undefined" &&
        window.matchMedia("(min-width: 1024px)").matches
    );
  }, [videoId]);

  // Comments state
  const [comments, setComments] = useState<CommentData[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState("");
  /** Threads whose replies are expanded (YouTube-style "N replies" toggle). */
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  const [commentSort, setCommentSort] = useState<"newest" | "top">("newest");
  /** True when this backend exposes no comments route at all. */
  const [commentsUnsupported, setCommentsUnsupported] = useState(false);
  const [newCommentText, setNewCommentText] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  /**
   * Loads the video from the deployed backend.
   *
   * VERIFIED contract: GET /videos/:id → { success, statusCode, message, data }
   * where `data` is the video object (404 → "Video not found").
   * Related videos come from the real GET /videos list (backend has no
   * dedicated related endpoint).
   */
  const fetchWatchData = useCallback(async () => {
    setLoading(true);
    setError("");
    setCreatorOwnerId(null);
    try {
      const res = await fetch(apiUrl(`/videos/${videoId}`), { cache: "no-store" });
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }

      if (!res.ok) {
        const msg =
          payload && typeof payload === "object"
            ? String((payload as Record<string, any>).message || "")
            : "";
        setError(
          /route '.*' not found/i.test(msg)
            ? "Video playback isn't available on this backend."
            : msg || "Video unavailable"
        );
        return;
      }

      const adapted = adaptVideo(unwrapEnvelope(payload));
      if (!adapted) {
        setError("Video unavailable");
        return;
      }

      const rawVideo = unwrapEnvelope(payload) as any;
      const currentUserId = user?.id != null ? String(user.id) : "";
      const userReaction =
        currentUserId && isVideoLikedByUser(adapted.id, currentUserId, rawVideo?.likes)
          ? "like"
          : currentUserId &&
            Array.isArray(rawVideo?.dislikes) &&
            rawVideo.dislikes.some(
              (dislike: any) => String(dislike?._id ?? dislike) === currentUserId
            )
          ? "dislike"
          : null;

      setVideo({
        ...(adapted as unknown as VideoItem),
        userReaction,
        isSubscribed: false,
        isSaved: false,
      } as any);

      // The single-video payload often contains only a small populated channel
      // object. Read the authoritative channel record for its real avatar,
      // display name and subscriber count (the banner is not used here).
      const rawChannel = rawVideo?.channel;
      const channelHandle = String(
        rawChannel?.handle || adapted.creator.username || ""
      ).trim();
      if (channelHandle) {
        const channelRes = await fetch(channelApiUrl(channelHandle), {
          cache: "no-store",
          credentials: "include",
        }).catch(() => null);
        if (channelRes?.ok) {
          const channelPayload = await channelRes.json().catch(() => null);
          const fullChannel = adaptChannel(channelPayload, {
            currentUserId: currentUserId || null,
          });
          if (fullChannel) {
            setCreatorOwnerId(fullChannel.ownerUserId || null);
            setVideo((current) =>
              current
                ? {
                    ...current,
                    creator: {
                      ...current.creator,
                      id: fullChannel.id || current.creator.id,
                      channelId: fullChannel.id || current.creator.channelId,
                      username: fullChannel.username || current.creator.username,
                      displayName:
                        fullChannel.displayName || current.creator.displayName,
                      avatarUrl: fullChannel.avatarUrl,
                      isVerified: fullChannel.isVerified,
                      subscriberCount: fullChannel.subscriberCount,
                    },
                    isSubscribed: fullChannel.isSubscribed,
                  }
                : current
            );
          }
        }
      }

      // Resolve real subscription state from the backend's channel document.
      const channelId = rawChannel?._id || adapted.creator.channelId;
      if (channelId) {
        const subRes = await fetch(apiUrl(`/subscriptions/${encodeURIComponent(String(channelId))}`), {
          cache: "no-store",
          credentials: "include",
        });
        if (subRes.ok) {
          const subPayload = await subRes.json().catch(() => ({}));
          /**
           * VERIFIED response:
           *   { success, totalSubscribers, subscribers:[{_id,name,…}], isSubscribed }
           * `isSubscribed` is false both without a token and with an invalid
           * token (the route does not read the viewer's auth), so on its own it
           * made a subscribed viewer's button say "Subscribe" — and tapping the
           * toggle endpoint then UNsubscribed them. When the subscribers list
           * is complete (length === totalSubscribers) membership in it is the
           * real answer; otherwise either signal counts as subscribed.
           */
          const explicit =
            typeof subPayload?.isSubscribed === "boolean"
              ? subPayload.isSubscribed
              : typeof subPayload?.data?.isSubscribed === "boolean"
              ? subPayload.data.isSubscribed
              : null;
          const subscriberList: any[] = Array.isArray(subPayload?.subscribers)
            ? subPayload.subscribers
            : Array.isArray(subPayload?.data?.subscribers)
            ? subPayload.data.subscribers
            : [];
          const inList = Boolean(
            currentUserId &&
              subscriberList.some(
                (s) => String(s?._id ?? s?.id ?? s) === currentUserId
              )
          );
          setVideo((current) =>
            current
              ? {
                  ...current,
                  isSubscribed: !currentUserId
                    ? false
                    : subscriberList.length ===
                      Number(subPayload?.totalSubscribers ?? subPayload?.data?.totalSubscribers ?? -1)
                    ? inList
                    : Boolean(explicit) || inList || current.isSubscribed,
                  creator: {
                    ...current.creator,
                    subscriberCount: Number(
                      subPayload?.totalSubscribers ??
                        subPayload?.data?.totalSubscribers ??
                        current.creator.subscriberCount ??
                        0
                    ),
                  },
                }
              : current
          );
        }
      }

      // "Up Next" videos. Two things were wrong here before:
      //   1. GET /videos was called with no `limit`, so the backend applied its
      //      own default of 10 — only 9 related videos could ever appear.
      //   2. The list was then sliced to 15 as a second cap.
      // Every public video in the app must be reachable from here, so we ask the
      // existing personalised recommendation endpoint (which ranks and returns
      // the whole long-form library) and fall back to the plain list endpoint
      // with an explicit large limit. The current video is still excluded.
      // Related ranking is now video→video: shared topic, tags, title tokens,
      // same creator and co-watch neighbourhoods of the video being watched,
      // blended with this viewer's own interests. Unrelated popular videos no
      // longer fill this column. The personalised Home ranking and then the
      // plain backend list remain as fallbacks so this can never go empty.
      let relatedPayload: unknown = await fetchRecommendedRelated(videoId, RELATED_LIMIT);
      if (!relatedPayload) relatedPayload = await fetchRecommendedHome(1, RELATED_LIMIT);
      if (!relatedPayload) {
        const vres = await fetch(apiUrl(`/videos?limit=${RELATED_LIMIT}`), {
          cache: "no-store",
        });
        relatedPayload = vres.ok ? await vres.json().catch(() => null) : null;
      }

      if (relatedPayload) {
        const related = (adaptVideos(relatedPayload) as unknown as VideoItem[]).filter(
          (v) => String(v.id) !== String(videoId)
        );
        setRelatedVideos(related);
      } else {
        setRelatedVideos([]);
      }
    } catch {
      setError("Network error loading video.");
    } finally {
      setLoading(false);
    }
  }, [videoId, user?.id]);

  /**
   * Comments use the existing Mongo/Express route GET /comments/:videoId.
   *
   * VERIFIED contract:
   *   { success, totalComments, comments: [
   *       { _id, user:{_id,name,profilePhoto}, text, parentComment,
   *         likes[], likesCount, repliesCount, replies: [ ...same shape ] } ] }
   *
   * `replies` is recursive (a reply can carry its own `replies`). The old code
   * flattened only ONE level, so replies-to-replies were silently dropped.
   * Every level is now flattened and tagged with its top-level `threadId`, so
   * the whole conversation renders under the original comment (YouTube-style).
   */
  const fetchComments = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setCommentsLoading(true);
    setCommentsError("");
    try {
      const res = await fetch(
        apiUrl(`/comments/${encodeURIComponent(videoId)}`),
        { cache: "no-store" }
      );

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const unsupported = isUnsupportedResponse(payload);
        setCommentsUnsupported(unsupported);
        if (!unsupported) {
          setCommentsError(
            payload?.message || payload?.error || "Could not load comments."
          );
        }
        setComments([]);
        return;
      }

      const rawList = Array.isArray(payload?.comments)
        ? payload.comments
        : Array.isArray(payload?.data?.comments)
        ? payload.data.comments
        : Array.isArray(payload?.data)
        ? payload.data
        : [];

      const rawComments: Array<{ raw: any; threadId: string; parentId: string | null }> = [];
      const seen = new Set<string>();
      const walk = (
        node: any,
        threadId: string | null,
        parentId: string | null,
        depth: number
      ) => {
        const nodeId = String(node?._id ?? node?.id ?? "");
        if (!nodeId || seen.has(nodeId) || depth > 20) return;
        seen.add(nodeId);
        const ownThread = threadId ?? nodeId;
        const ownParent =
          threadId === null
            ? null
            : node?.parentComment
            ? String(node.parentComment?._id ?? node.parentComment)
            : parentId;
        rawComments.push({ raw: node, threadId: ownThread, parentId: ownParent });
        if (Array.isArray(node?.replies)) {
          for (const reply of node.replies) {
            if (reply && typeof reply === "object") {
              walk(reply, ownThread, nodeId, depth + 1);
            }
          }
        }
      };
      for (const raw of rawList) {
        // Only true roots start a thread; stray replies attach to their parent.
        if (raw?.parentComment) continue;
        walk(raw, null, null, 0);
      }
      // Replies returned flat at the top level (other backend shapes).
      for (const raw of rawList) {
        if (!raw?.parentComment) continue;
        const parentKey = String(raw.parentComment?._id ?? raw.parentComment);
        const parent = rawComments.find((c) => String(c.raw?._id) === parentKey);
        walk(raw, parent?.threadId ?? parentKey, parentKey, 1);
      }

      const mapComment = ({
        raw,
        threadId,
        parentId,
      }: {
        raw: any;
        threadId: string;
        parentId: string | null;
      }): CommentData => ({
        id: String(raw?._id ?? raw?.id ?? ""),
        videoId: String(raw?.video ?? videoId),
        userId: String(raw?.user?._id ?? raw?.user ?? ""),
        parentId,
        threadId,
        repliesCount: Number(raw?.repliesCount ?? 0) || 0,
        content: String(raw?.text ?? raw?.content ?? ""),
        likesCount: Number(raw?.likesCount ?? raw?.likes?.length ?? 0),
        userLiked: Boolean(
          user?.id &&
            Array.isArray(raw?.likes) &&
            raw.likes.some((like: any) => String(like?._id ?? like) === String(user.id))
        ),
        createdAt: String(raw?.createdAt ?? ""),
        updatedAt: String(raw?.updatedAt ?? raw?.createdAt ?? ""),
        author: {
          id: String(raw?.user?._id ?? raw?.user ?? ""),
          // The comment payload populates only {_id, name, profilePhoto};
          // `username` is absent, so the name is shown instead of an empty "@".
          username: String(raw?.user?.username ?? ""),
          displayName: String(raw?.user?.name ?? "BharatTube user"),
          avatarUrl: raw?.user?.profilePhoto || null,
          isVerified: false,
        },
      });

      setComments(rawComments.map(mapComment));
      setCommentsUnsupported(false);
    } catch {
      // Network failure: keep what is on screen, but say so.
      setCommentsError("Network error — could not load comments.");
    } finally {
      setCommentsLoading(false);
    }
  }, [videoId, user?.id]);


  useEffect(() => {
    fetchWatchData();
  }, [fetchWatchData]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const handleToggleWatchLater = async () => {
    if (!user) {
      openAuthModal("login");
      showToast("Sign in to save videos to Watch Later", "info");
      return;
    }
    if (!video) return;
    const res = await fetch(apiUrl(`/watch-later/${video.id}`), {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      const data = await res.json();
      setVideo((prev) => (prev ? { ...prev, isSaved: data.isSaved } : prev));
      showToast(
        data.isSaved ? "Saved to Watch Later" : "Removed from Watch Later",
        "success"
      );
    }
  };

  const handleDownload = () => {
    if (!video?.videoUrl) return;

    const source = video.videoUrl;
    // Cloudinary is the configured media provider. fl_attachment asks it to
    // return the existing asset as a download instead of changing storage or
    // creating a second media pipeline.
    const downloadUrl = /res\.cloudinary\.com\//i.test(source)
      ? source.replace(/\/(video|raw)\/upload\//i, "/$1/upload/fl_attachment/")
      : source;

    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    const extension = source.match(/\.(mp4|webm|mov|m4v)(?:$|\?)/i)?.[1]?.toLowerCase() || "mp4";
    anchor.download = `${video.title.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "bharattube-video"}.${extension}`;
    anchor.rel = "noopener";
    anchor.target = "_blank";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    showToast(
      /res\.cloudinary\.com\//i.test(source)
        ? "Download started"
        : "The video opened in a new tab. Use your browser's download option.",
      "info"
    );
  };

  const handleShare = () => {
    setShareOpen(true);
  };

  const handleCopyShareLink = async () => {
    const url = window.location.href;
    // Ranking signal: sharing is the strongest positive short of subscribing.
    recordInteractionSignal("share", videoId);
    try {
      await navigator.clipboard.writeText(url);
      showToast("Video link copied to clipboard", "success");
    } catch {
      showToast(url, "info");
    }
  };

  const handleNativeShare = async () => {
    const url = window.location.href;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: video?.title || "BharatTube", url });
        recordInteractionSignal("share", videoId);
        setShareOpen(false);
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }
    await handleCopyShareLink();
  };

  const handleWhatsAppShare = () => {
    const url = window.location.href;
    const text = `${video?.title || "BharatTube video"} ${url}`;
    window.open(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer"
    );
    setShareOpen(false);
  };

  const handleReportVideo = async () => {
    if (!user) {
      openAuthModal("login");
      return;
    }
    if (!video) return;
    await fetch(apiUrl(`/videos/${video.id}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "report",
        reason: "Reported from watch page",
      }),
    });
    showToast("Video reported to moderation team", "info");
  };

  const handleAddComment = async (e: React.FormEvent, parentId: string | null = null) => {
    e.preventDefault();
    if (!user) {
      openAuthModal("login");
      showToast("Sign in to post a comment", "info");
      return;
    }
    const content = (parentId ? replyText : newCommentText).trim();
    if (!content) return;

    setPostingComment(true);
    try {
      const res = await fetch(apiUrl(`/comments/${encodeURIComponent(videoId)}`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: content,
          parentComment: parentId,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Never swallow a failed post — show the backend's own reason.
        if (res.status === 401) {
          showToast("Your session expired. Please sign in again.", "error");
          openAuthModal("login");
        } else {
          showToast(
            result?.message || result?.error ||
              (parentId ? "Could not post reply" : "Could not post comment"),
            "error"
          );
        }
        return;
      }
      // Ranking signal: a posted comment is strong explicit interest.
      recordInteractionSignal("comment", videoId);
      if (parentId) {
        setReplyText("");
        setReplyingToId(null);
        // Show the new reply immediately under its thread.
        const thread = comments.find((c) => c.id === parentId)?.threadId ?? parentId;
        setOpenThreads((prev) => new Set(prev).add(thread));
      } else {
        setNewCommentText("");
      }
      await fetchComments({ silent: true });
      showToast(parentId ? "Reply added" : "Comment posted", "success");
    } catch {
      showToast("Network error. Please try again.", "error");
    } finally {
      setPostingComment(false);
    }
  };

  const handleEditComment = async (_commentId: string) => {
    showToast("Comment editing is not exposed by the current backend.", "info");
  };

  const handleDeleteComment = async (_commentId: string) => {
    showToast("Comment deletion is not exposed by the current backend.", "info");
  };

  const handleLikeComment = async (commentId: string | number) => {
    if (!user) {
      openAuthModal("login");
      return;
    }
    const res = await fetch(apiUrl(`/comments/${encodeURIComponent(String(commentId))}/like`), {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      const data = await res.json();
      setComments((prev) =>
        prev.map((c) =>
          String(c.id) === String(commentId)
            ? {
                ...c,
                likesCount: Number(data.likesCount ?? c.likesCount),
                userLiked: !c.userLiked,
              }
            : c
        )
      );
    }
  };

  const handleReportComment = async (_commentId: string) => {
    showToast("Comment reporting is not exposed by the current backend.", "info");
  };


  if (loading) {
    return (
      <div className="max-w-[1650px] mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6 animate-pulse">
        <div className="lg:col-span-2 space-y-4">
          <div className="w-full aspect-video rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-6 bg-zinc-200 dark:bg-zinc-800 rounded w-3/4" />
          <div className="h-12 bg-zinc-200 dark:bg-zinc-800 rounded-xl w-full" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 bg-zinc-200 dark:bg-zinc-800 rounded-xl"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <ErrorState
          message={error || "Video unavailable"}
          onRetry={fetchWatchData}
        />
      </div>
    );
  }

  // Sort chips were rendered but never applied — they now order the roots.
  const rootComments = comments
    .filter((c) => !c.parentId)
    .sort((a, b) =>
      commentSort === "top"
        ? b.likesCount - a.likesCount ||
          (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
        : (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    );
  /** Every reply in a thread (any depth), oldest first like YouTube. */
  const getReplies = (threadId: string) =>
    comments
      .filter((c) => c.parentId && c.threadId === threadId)
      .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  /** Opens a commenter's real channel (user id → owner → channel handle). */
  const openCommenterChannel = async (authorUserId: string) => {
    const handle = await resolveChannelHandleForUser(authorUserId);
    if (handle) {
      router.push(`/channel/${encodeURIComponent(handle)}`);
    } else {
      showToast("This user doesn't have a public channel yet.", "info");
    }
  };

  const toggleThread = (threadId: string) =>
    setOpenThreads((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });

  // Real top comment: highest backend like count, newest as the tie-breaker.
  const topComment = rootComments.reduce<CommentData | null>((best, comment) => {
    if (!best) return comment;
    if (comment.likesCount !== best.likesCount) {
      return comment.likesCount > best.likesCount ? comment : best;
    }
    return Date.parse(comment.createdAt || "") > Date.parse(best.createdAt || "")
      ? comment
      : best;
  }, null);

  const openComments = () => {
    setCommentsExpanded(true);
    requestAnimationFrame(() => {
      document
        .getElementById("watch-comments")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="max-w-[1650px] mx-auto px-0 sm:px-6 py-0 sm:py-5">
      <div
        className={`grid grid-cols-1 ${
          theaterMode ? "grid-cols-1" : "lg:grid-cols-12"
        } gap-0 lg:gap-6`}
      >
        {/* Primary Column: Player, Metadata, Creator, Comments */}
        {/*
          Sticky player scope:
          - Desktop (lg): this is a real col-span-8 grid item. `self-start`
            stops it stretching to the row height so the sticky player stays
            pinned through the whole comments list (Up Next sits beside it).
          - Mobile/tablet (<lg): `contents` removes THIS wrapper from the box
            tree, so its children (player, title, comments) become direct grid
            items. The sticky player's containing block then becomes the whole
            grid — which also includes the Up Next row — so the video stays
            pinned across the ENTIRE page scroll, exactly like the YouTube app.
            (`gap-0` on mobile keeps section spacing driven by their own mt-*,
            matching the previous look; Up Next re-adds its top gap below.)
        */}
        <div
          className={
            theaterMode
              ? "w-full self-start"
              : "contents lg:block lg:col-span-8 lg:self-start"
          }
        >
          {/*
            Sticky player (pure CSS): while the user scrolls the title,
            channel row, comments or Up Next, the playing video stays pinned to
            the top of the screen — the whole feed scrolls beneath it, exactly
            like the YouTube app. CSS `position: sticky` is GPU-smooth (no
            per-scroll JS), so it never jitters. It releases naturally when its
            column ends. `top-0` because the watch page hides the top navbar.
          */}
          <div className="sticky top-0 z-30 bg-black sm:rounded-xl overflow-hidden -mx-0">
            <VideoPlayer
              videoId={video.id}
              videoUrl={video.videoUrl}
              thumbnailUrl={video.thumbnailUrl}
              title={video.title}
              initialDuration={video.duration}
              savedProgressSeconds={video.watchProgress?.progressSeconds || 0}
              theaterMode={theaterMode}
              onToggleTheater={() => setTheaterMode((t) => !t)}
              onViewsUpdated={(newViews) =>
                setVideo((prev) =>
                  prev ? { ...prev, viewsCount: newViews } : prev
                )
              }
              autoPlay
              // NOTE: always true on the watch page — opening a video starts
              // playback immediately (YouTube behaviour). The account "autoplay"
              // preference no longer gates this.
              initialPlaybackRate={preferences?.defaultPlaybackRate ?? 1}
              initialCaptions={preferences?.captionsByDefault ?? false}
            />
          </div>

          {/* Video Title + compact metadata with YouTube-style “…more” */}
          <h1 className="mt-4 px-3 sm:px-0 text-lg sm:text-xl font-semibold text-zinc-900 dark:text-zinc-100 leading-snug">
            {video.title}
          </h1>

          <div className="mt-1 px-3 sm:px-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400 tabular-nums">
            <span>{formatCount(video.viewsCount, "view", "views")}</span>
            <span className="text-zinc-400">•</span>
            <span>{formatTimeAgo(video.createdAt)}</span>
            <span className="text-zinc-400">•</span>
            <span className="text-zinc-600 dark:text-zinc-300">{video.category}</span>
            <button
              type="button"
              onClick={() => setDescExpanded((open) => !open)}
              aria-expanded={descExpanded}
              aria-label={descExpanded ? "Show less description" : "Show more description"}
              className="ml-1 text-xs font-medium text-zinc-500 hover:text-red-600 transition-colors cursor-pointer"
            >
              {descExpanded ? "…less" : "…more"}
            </button>
          </div>

          {/* Expanded description stays on the same watch page */}
          {descExpanded && (
            <div className="mt-3 mx-3 sm:mx-0 px-3.5 py-3 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 text-sm">
              <div className="text-zinc-700 dark:text-zinc-300 whitespace-pre-line leading-relaxed">
                {video.description || "No description provided for this video."}
              </div>

              {video.tags && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {video.tags
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .map((tag, idx) => (
                      <span
                        key={idx}
                        className="text-xs text-red-500 font-medium"
                      >
                        #{tag}
                      </span>
                    ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => setDescExpanded(false)}
                className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-zinc-900 dark:text-white hover:underline cursor-pointer"
              >
                <span>Show less</span>
                <ChevronUp className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Compact actions directly below the title */}
          <div className="mt-3 flex items-center gap-2 overflow-x-auto no-scrollbar px-3 sm:px-0 pb-1">
            <LikeDislikePill
              videoId={video.id}
              likesCount={video.likesCount}
              dislikesCount={video.dislikesCount}
              userReaction={video.userReaction}
              onReactionChange={(likes, dislikes, reaction) => {
                setVideo((prev) =>
                  prev
                    ? {
                        ...prev,
                        likesCount: likes,
                        dislikesCount: dislikes,
                        userReaction: reaction,
                      }
                    : prev
                );
              }}
            />

            <button
              type="button"
              onClick={handleShare}
              className="shrink-0 inline-flex items-center gap-2 h-10 px-4 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 text-sm font-medium transition-colors cursor-pointer"
            >
              <Share2 className="w-5 h-5" />
              <span>Share</span>
            </button>

            <button
              type="button"
              onClick={handleToggleWatchLater}
              aria-pressed={video.isSaved}
              className={`shrink-0 inline-flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium transition-colors cursor-pointer ${
                video.isSaved
                  ? "bg-zinc-900 text-white dark:bg-zinc-100"
                  : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
              }`}
            >
              {video.isSaved ? <Check className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
              <span>{video.isSaved ? "Saved" : "Save"}</span>
            </button>

            <button
              type="button"
              onClick={() => openPlaylistModal(video.id)}
              className="shrink-0 inline-flex items-center gap-2 h-10 px-4 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 text-sm font-medium transition-colors cursor-pointer"
            >
              <ListPlus className="w-5 h-5" />
              <span>Playlist</span>
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className="shrink-0 inline-flex items-center gap-2 h-10 px-4 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 text-sm font-medium transition-colors cursor-pointer"
            >
              <Download className="w-5 h-5" />
              <span>Download</span>
            </button>

            <button
              type="button"
              onClick={handleReportVideo}
              title="Report video"
              aria-label="Report video"
              className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer"
            >
              <Flag className="w-5 h-5" />
            </button>
          </div>

          {/*
            Channel row directly above comments (YouTube-style):
            avatar + name on the left, Subscribe on the right.
            No subscriber count here — watch page shows only the
            avatar, name and subscribe control.
          */}
          <section
            aria-label="Channel information"
            className="mt-3 px-3 sm:px-0 flex items-center gap-3"
          >
            <Link href={channelHref(video.creator)} className="shrink-0">
              <UserAvatar
                name={video.creator.displayName}
                avatarUrl={video.creator.avatarUrl}
                size="lg"
              />
            </Link>
            <div className="min-w-0 flex-1">
              <Link
                href={channelHref(video.creator)}
                className="font-semibold text-sm sm:text-base text-zinc-900 dark:text-zinc-100 inline-flex items-center gap-1 max-w-full"
              >
                <span className="truncate">{video.creator.displayName}</span>
                {video.creator.isVerified && (
                  <CheckCircle2 className="w-4 h-4 text-zinc-400 shrink-0" />
                )}
              </Link>
            </div>
            <SubscribeButton
              channelId={video.creator.channelId || video.creator.id}
              isOwner={Boolean(
                user && creatorOwnerId && String(user.id) === creatorOwnerId
              )}
              initialSubscribed={video.isSubscribed}
              initialCount={video.creator.subscriberCount}
              showCount={false}
              onStatusChange={(sub, newCount) => {
                setVideo((prev) =>
                  prev
                    ? {
                        ...prev,
                        isSubscribed: sub,
                        creator: { ...prev.creator, subscriberCount: newCount },
                      }
                    : prev
                );
              }}
            />
          </section>

          {/*
            YouTube-style comments card: rounded rectangle with
            "Comments <count>" header, avatar + pill input, sort chips,
            and the comment thread — all inside one card.
          */}
          <section
            id="watch-comments"
            // Keep the header clear of the sticky player when scrolled into view.
            className="mt-4 mx-3 sm:mx-0 rounded-2xl bg-zinc-100 dark:bg-zinc-900/50 p-4 sm:p-5 scroll-mt-[58vw] lg:scroll-mt-6"
          >
            {/* Header row — always visible */}
            <div className="flex items-center justify-between mb-4">
              <button
                type="button"
                onClick={() =>
                  commentsExpanded
                    ? setCommentsExpanded(false)
                    : openComments()
                }
                aria-expanded={commentsExpanded}
                className="flex items-center gap-3 text-left cursor-pointer"
              >
                <span className="text-lg sm:text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  Comments{" "}
                  <span className="font-normal text-zinc-500 dark:text-zinc-400 text-base sm:text-lg ml-1">
                    {formatCount(comments.length)}
                  </span>
                </span>
                {commentsExpanded ? (
                  <ChevronUp className="w-4 h-4 text-zinc-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-zinc-400" />
                )}
              </button>

              {/* Sort toggle — YouTube-style dot icons */}
              {commentsExpanded && (
                <button
                  type="button"
                  onClick={() =>
                    setCommentSort((s) => (s === "top" ? "newest" : "top"))
                  }
                  className="flex items-center gap-1.5 p-1.5 rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-800 cursor-pointer"
                  title={
                    commentSort === "top"
                      ? "Switch to Newest first"
                      : "Switch to Top comments"
                  }
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                      commentSort === "top"
                        ? "bg-zinc-900 dark:bg-zinc-100"
                        : "bg-zinc-400 dark:bg-zinc-600"
                    }`}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                      commentSort === "newest"
                        ? "bg-zinc-900 dark:bg-zinc-100"
                        : "bg-zinc-400 dark:bg-zinc-600"
                    }`}
                  />
                </button>
              )}
            </div>

            {/*
              Collapsed card (mobile): like YouTube, show the real top comment
              when one exists; otherwise the avatar + "Add a comment" pill.
            */}
            {!commentsExpanded &&
              (commentsLoading && comments.length === 0 ? (
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full border-2 border-zinc-300 dark:border-zinc-700 border-t-red-600 animate-spin" />
                  <span className="text-sm text-zinc-500">Loading comments…</span>
                </div>
              ) : topComment ? (
                <button
                  type="button"
                  onClick={openComments}
                  className="w-full flex items-start gap-3 text-left cursor-pointer"
                >
                  <UserAvatar
                    name={topComment.author.displayName}
                    avatarUrl={topComment.author.avatarUrl}
                    size="sm"
                  />
                  <p className="flex-1 min-w-0 text-sm text-zinc-800 dark:text-zinc-200 line-clamp-2 break-words">
                    {topComment.content}
                  </p>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openComments}
                  className="w-full flex items-center gap-3 text-left cursor-pointer"
                >
                  <UserAvatar
                    name={user?.displayName || "Guest"}
                    avatarUrl={user?.avatarUrl}
                    size="md"
                  />
                  <div className="flex-1 h-10 rounded-full bg-zinc-200/70 dark:bg-zinc-800 flex items-center px-4 text-sm text-zinc-400 dark:text-zinc-500">
                    {commentsError ? "Tap to retry loading comments" : "Add a comment..."}
                  </div>
                </button>
              ))}

            {/* Expanded state */}
            {commentsExpanded && (
              <div>
                {/* Comment input */}
                <form
                  onSubmit={(e) => handleAddComment(e, null)}
                  className="flex items-start gap-3 mb-4"
                >
                  <UserAvatar
                    name={user?.displayName || "Guest"}
                    avatarUrl={user?.avatarUrl}
                    size="md"
                  />
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={newCommentText}
                      enterKeyHint="send"
                      aria-label="Add a comment"
                      onFocus={(e) => {
                        if (!user) openAuthModal("login");
                        setTimeout(
                          () =>
                            e.target.scrollIntoView({
                              block: "center",
                              behavior: "smooth",
                            }),
                          300
                        );
                      }}
                      onChange={(e) => setNewCommentText(e.target.value)}
                      placeholder="Add a comment..."
                      className="w-full h-10 rounded-full bg-zinc-200/70 dark:bg-zinc-800 px-4 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:focus:ring-zinc-600"
                    />
                    {newCommentText.trim() && (
                      <div className="flex justify-end gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => setNewCommentText("")}
                          className="px-3.5 py-1.5 rounded-full text-xs font-semibold text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={postingComment}
                          className="px-4 py-1.5 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-semibold hover:opacity-90 cursor-pointer"
                        >
                          Comment
                        </button>
                      </div>
                    )}
                  </div>
                </form>

            {/* Comments List */}
            {commentsUnsupported ? (
              <div className="py-10 text-center text-sm text-zinc-500 border border-dashed border-amber-500/40 bg-amber-500/5 rounded-2xl px-4">
                {capabilityOf("comments").message}
                <div className="text-[11px] text-zinc-500 mt-1">
                  The API responds{" "}
                  <span className="font-mono">
                    Route &apos;/comments&apos; not found
                  </span>
                  , so no comments are shown.
                </div>
              </div>
            ) : commentsLoading && comments.length === 0 ? (
              <div className="flex items-center justify-center py-10" role="status" aria-label="Loading comments">
                <div className="w-7 h-7 rounded-full border-[3px] border-zinc-300 dark:border-zinc-700 border-t-red-600 animate-spin" />
              </div>
            ) : commentsError && comments.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-zinc-500 mb-3">{commentsError}</p>
                <button
                  type="button"
                  onClick={() => fetchComments()}
                  className="px-4 py-2 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold cursor-pointer"
                >
                  Retry
                </button>
              </div>
            ) : rootComments.length === 0 ? (
              <div className="py-10 text-center text-sm text-zinc-500 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-2xl">
                No comments yet. Start the conversation!
              </div>
            ) : (
              <div className="space-y-5">
                {rootComments.map((comment) => {
                  const replies = getReplies(comment.id);
                  const threadOpen = openThreads.has(comment.id);
                  return (
                    <div key={comment.id} className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => openCommenterChannel(comment.userId)}
                        aria-label={`Open ${comment.author.displayName}'s channel`}
                        className="shrink-0 cursor-pointer"
                      >
                        <UserAvatar
                          name={comment.author.displayName}
                          avatarUrl={comment.author.avatarUrl}
                          size="md"
                        />
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => openCommenterChannel(comment.userId)}
                            className="font-bold text-zinc-900 dark:text-zinc-100 hover:underline cursor-pointer"
                          >
                            {comment.author.username
                              ? `@${comment.author.username}`
                              : comment.author.displayName}
                          </button>
                          <span className="text-zinc-500">
                            {formatTimeAgo(comment.createdAt)}
                          </span>
                        </div>

                        {editingCommentId === comment.id ? (
                          <div className="mt-2 space-y-2">
                            <input
                              type="text"
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              className="w-full px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                            />
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleEditComment(comment.id)}
                                className="px-3 py-1 rounded-full bg-red-600 text-white text-xs font-semibold cursor-pointer"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingCommentId(null)}
                                className="px-3 py-1 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">
                            {comment.content}
                          </p>
                        )}

                        <div className="mt-2 flex items-center gap-4 text-xs text-zinc-500">
                          <button
                            type="button"
                            onClick={() => handleLikeComment(comment.id)}
                            className={`inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-white cursor-pointer ${
                              comment.userLiked
                                ? "text-red-500 font-semibold"
                                : ""
                            }`}
                          >
                            <ThumbsUp className="w-3.5 h-3.5" />
                            <span>{comment.likesCount || ""}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              setReplyingToId(
                                replyingToId === comment.id ? null : comment.id
                              )
                            }
                            className="font-semibold hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                          >
                            Reply
                          </button>

                          {user && user.id === comment.userId && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCommentId(comment.id);
                                  setEditContent(comment.content);
                                }}
                                className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>Edit</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteComment(comment.id)}
                                className="inline-flex items-center gap-1 text-red-500 hover:underline cursor-pointer"
                              >
                                <Trash2 className="w-3 h-3" />
                                <span>Delete</span>
                              </button>
                            </>
                          )}

                          <button
                            type="button"
                            onClick={() => handleReportComment(comment.id)}
                            className="hover:text-red-500 cursor-pointer"
                          >
                            Report
                          </button>
                        </div>

                        {/* Reply Form */}
                        {replyingToId === comment.id && (
                          <form
                            onSubmit={(e) => handleAddComment(e, comment.id)}
                            className="mt-3 flex items-center gap-2"
                          >
                            <input
                              type="text"
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              placeholder={`Reply to @${comment.author.username}...`}
                              className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs"
                            />
                            <button
                              type="submit"
                              className="px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-semibold cursor-pointer"
                            >
                              Reply
                            </button>
                          </form>
                        )}

                        {/* Reply count toggle (count = real loaded replies) */}
                        {replies.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleThread(comment.id)}
                            aria-expanded={threadOpen}
                            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-full px-2 py-1 -ml-2 cursor-pointer"
                          >
                            {threadOpen ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                            {replies.length} {replies.length === 1 ? "reply" : "replies"}
                          </button>
                        )}

                        {/* Threaded Replies */}
                        {replies.length > 0 && threadOpen && (
                          <div className="mt-3 pl-4 border-l-2 border-zinc-200 dark:border-zinc-800 space-y-3">
                            {replies.map((reply) => (
                              <div
                                key={reply.id}
                                className="flex items-start gap-2.5"
                              >
                                <CornerDownRight className="w-3.5 h-3.5 text-zinc-400 mt-1 shrink-0" />
                                <UserAvatar
                                  name={reply.author.displayName}
                                  avatarUrl={reply.author.avatarUrl}
                                  size="xs"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="font-bold">
                                      {reply.author.username
                                        ? `@${reply.author.username}`
                                        : reply.author.displayName}
                                    </span>
                                    <span className="text-zinc-500">
                                      {formatTimeAgo(reply.createdAt)}
                                    </span>
                                  </div>
                                  <p className="text-xs text-zinc-800 dark:text-zinc-200 mt-0.5">
                                    {reply.content}
                                  </p>
                                  <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
                                    <button
                                      type="button"
                                      onClick={() => handleLikeComment(reply.id)}
                                      className={`inline-flex items-center gap-1 cursor-pointer ${
                                        reply.userLiked ? "text-red-500" : ""
                                      }`}
                                    >
                                      <ThumbsUp className="w-3 h-3" />
                                      <span>{reply.likesCount || ""}</span>
                                    </button>
                                    {user && user.id === reply.userId && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleDeleteComment(reply.id)
                                        }
                                        className="text-red-500 hover:underline cursor-pointer"
                                      >
                                        Delete
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
              </div>
            )}
          </section>

        </div>

        {/* Right Column: Up Next / Related Real Videos */}
        {/* mt-6 on mobile replaces the old grid gap (removed to keep the sticky
            player's grid boundary spanning the whole page); lg:mt-0 restores the
            side-by-side desktop layout. */}
        <div className={`px-3 sm:px-0 mt-6 lg:mt-0 ${theaterMode ? "w-full" : "lg:col-span-4"}`}>
          <h3 className="text-base font-bold mb-3">Up Next</h3>
          {relatedVideos.length === 0 ? (
            <div className="p-8 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-800 text-center text-xs text-zinc-500">
              No other public videos available yet.
            </div>
          ) : (
            <div className="space-y-2">
              {relatedVideos.map((rv) => (
                <VideoListItem key={rv.id} video={rv} compact />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Share Section / Modal */}
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
                  value={typeof window !== "undefined" ? window.location.href : ""}
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
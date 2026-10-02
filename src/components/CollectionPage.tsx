"use client";

import React, { useState, useEffect, useCallback } from "react";
import { History, Trash2, ListVideo } from "lucide-react";
import {
  VideoCard,
  VideoListItem,
  VideoItem,
  SkeletonGrid,
  EmptyState,
  ErrorState,
} from "./VideoComponents";
import { useApp } from "@/context/AppContext";
import { apiUrl } from "@/lib/api-config";
import { adaptVideos } from "@/lib/backend-adapter";
import { isVideoLikedByUser, toggleVideoLikeApi } from "@/lib/likes-manager";

type FeedKey = "history" | "liked" | "watch_later" | "my_videos";
type RemoveMode = "history" | "liked" | "watch_later" | "delete_video" | null;

export function CollectionPage({
  title,
  subtitle,
  icon,
  feed,
  layout = "list",
  removeMode = null,
  allowClearAll = false,
  emptyTitle,
  emptyDescription,
  emptyActionLabel,
  onEmptyAction,
  requiresAuth = true,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  feed: FeedKey;
  layout?: "list" | "grid";
  removeMode?: RemoveMode;
  allowClearAll?: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  requiresAuth?: boolean;
}) {
  const { user, loadingAuth, openAuthModal, showToast, triggerFeedRefresh, feedRefreshTrigger } =
    useApp();

  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const needsAuth = requiresAuth && !user;

  const load = useCallback(async () => {
    if (needsAuth) {
      setLoading(false);
      setVideos([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const currentUserId = user?.id != null ? String(user.id) : null;

      if (feed === "liked") {
        // Fetch videos and shorts, then strictly include ONLY videos explicitly liked by this user
        const [videoRes, shortsRes] = await Promise.all([
          fetch(apiUrl("/videos?limit=60"), { cache: "no-store", credentials: "include" }),
          fetch(apiUrl("/shorts/feed?limit=40"), { cache: "no-store", credentials: "include" }).catch(
            () => null
          ),
        ]);

        if (!videoRes.ok) throw new Error("Failed to load liked videos");
        const videoData = await videoRes.json();
        const mainVideos = adaptVideos(videoData, "videos", { currentUserId });

        let shortVideos: typeof mainVideos = [];
        if (shortsRes?.ok) {
          const shortsData = await shortsRes.json();
          shortVideos = adaptVideos(shortsData, "shorts", { currentUserId });
        }

        const byId = new Map<string, (typeof mainVideos)[number]>();
        for (const v of mainVideos) byId.set(String(v.id), v);
        for (const s of shortVideos) {
          const k = String(s.id);
          const existing = byId.get(k);
          byId.set(k, existing ? { ...existing, ...s, isShort: true } : { ...s, isShort: true });
        }

        const strictlyLiked = Array.from(byId.values()).filter((v) =>
          isVideoLikedByUser(v.id, currentUserId, v.rawLikes)
        );
        setVideos(strictlyLiked as unknown as VideoItem[]);
        return;
      }

      if (feed === "history") {
        const res = await fetch(apiUrl("/history"), {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) {
          setVideos([]);
          return;
        }
        const histData = await res.json();
        const historyItems =
          histData.history ||
          histData.data?.history ||
          (Array.isArray(histData.data) ? histData.data : []);

        const mapped: VideoItem[] = historyItems
          .map((item: any) => {
            const adapted = adaptVideos(
              { videos: [item?.video ?? item] },
              "videos",
              { currentUserId }
            )[0] as unknown as VideoItem | undefined;
            if (!adapted) return null;
            return {
              ...adapted,
              watchProgress: {
                progressSeconds: Number(item?.currentTime ?? item?.watchedDuration ?? 0),
                durationSeconds: Number(
                  item?.duration ?? item?.video?.duration ?? adapted.duration ?? 0
                ),
                completionPercentage: Number(item?.completionPercentage ?? 0),
                lastWatchedAt: item?.lastWatchedAt,
              },
            } as VideoItem;
          })
          .filter((v: VideoItem | null): v is VideoItem => Boolean(v));

        /*
          ROOT-CAUSE FIX for "every history row shows the same channel name":
          the /history endpoint does NOT populate each video's `channel`, so the
          adapter falls back to the generic "BharatTube creator" for all of them.
          The authoritative per-video channel lives on the public /videos and
          /shorts/feed lists. Fetch those ONCE (not per card — no N+1), build an
          id → real creator map, and fill in only the rows that need it. Rows
          whose channel was already populated are left untouched.
        */
        const needsCreator = mapped.filter(
          (v) => !v.creator?.displayName || v.creator.displayName === "BharatTube creator"
        );
        if (needsCreator.length > 0) {
          try {
            const [vidsRes, shortsRes] = await Promise.all([
              fetch(apiUrl("/videos?page=1&limit=500"), { cache: "no-store" }).catch(() => null),
              fetch(apiUrl("/shorts/feed?limit=500"), { cache: "no-store" }).catch(() => null),
            ]);
            const vidsJson = vidsRes?.ok ? await vidsRes.json().catch(() => null) : null;
            const shortsJson = shortsRes?.ok ? await shortsRes.json().catch(() => null) : null;
            const catalog = [
              ...((adaptVideos(vidsJson, "videos", { currentUserId }) as unknown as VideoItem[]) || []),
              ...((adaptVideos(shortsJson, "shorts", { currentUserId }) as unknown as VideoItem[]) || []),
            ];
            const creatorById = new Map<string, VideoItem["creator"]>();
            for (const v of catalog) {
              if (v?.id != null && v.creator?.displayName) {
                creatorById.set(String(v.id), v.creator);
              }
            }
            if (creatorById.size > 0) {
              for (let i = 0; i < mapped.length; i += 1) {
                const real = creatorById.get(String(mapped[i].id));
                if (real) mapped[i] = { ...mapped[i], creator: real };
              }
            }
          } catch {
            /* enrichment is best-effort; never block history on it */
          }
        }

        setVideos(mapped);
        return;
      }

      const res = await fetch(apiUrl(`/videos?feed=${feed}`), {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load");
      setVideos(adaptVideos(data, "videos", { currentUserId }) as unknown as VideoItem[]);
    } catch {
      setError("Could not load this section from the server.");
    } finally {
      setLoading(false);
    }
  }, [feed, needsAuth, user?.id]);

  useEffect(() => {
    if (!loadingAuth) load();
  }, [load, loadingAuth, feedRefreshTrigger]);

  const handleRemove = async (videoId: string | number) => {
    try {
      if (removeMode === "liked" && user) {
        await toggleVideoLikeApi(videoId, true, user.id);
        setVideos((prev) => prev.filter((v) => String(v.id) !== String(videoId)));
        triggerFeedRefresh();
        showToast("Removed from Liked videos", "success");
        return;
      }

      let res: Response;
      if (removeMode === "history") {
        res = await fetch(apiUrl("/activity"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_history_item", videoId }),
        });
      } else if (removeMode === "watch_later") {
        res = await fetch(apiUrl(`/videos/${encodeURIComponent(String(videoId))}`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "watch_later" }),
        });
      } else {
        res = await fetch(apiUrl(`/videos/${encodeURIComponent(String(videoId))}`), { method: "DELETE" });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data?.error || "Action failed", "error");
        return;
      }

      setVideos((prev) => prev.filter((v) => String(v.id) !== String(videoId)));
      triggerFeedRefresh();
      showToast(
        removeMode === "delete_video"
          ? "Video deleted"
          : removeMode === "watch_later"
          ? "Removed from Watch Later"
          : "Removed from watch history",
        "success"
      );
    } catch {
      showToast("Network error", "error");
    }
  };

  const handleClearAll = async () => {
    try {
      const res = await fetch(apiUrl("/activity"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_watch_history" }),
      });
      if (!res.ok) {
        showToast("Failed to clear watch history", "error");
        return;
      }
      setVideos([]);
      setConfirmClear(false);
      triggerFeedRefresh();
      showToast("Watch history cleared", "success");
    } catch {
      showToast("Network error", "error");
    }
  };

  return (
    <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 sm:mb-6">
        <div className="flex items-center gap-3 min-w-0">
          {icon && (
            <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 shrink-0">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
                {subtitle}
                {!loading && videos.length > 0 && (
                  <span className="tabular-nums">
                    {" "}
                    • {videos.length} {videos.length === 1 ? "video" : "videos"}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        {allowClearAll && videos.length > 0 && (
          <div className="flex items-center gap-2">
            {confirmClear ? (
              <>
                <span className="text-sm text-zinc-500">Clear all history?</span>
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="h-9 px-3.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium cursor-pointer"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="h-9 px-3.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-sm font-medium cursor-pointer"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="inline-flex items-center gap-2 h-9 px-3.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-sm font-medium cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>Clear all</span>
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        layout === "grid" ? (
          <SkeletonGrid count={8} />
        ) : (
          <div className="space-y-4 animate-pulse">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-40 sm:w-64 aspect-video rounded-lg bg-zinc-200 dark:bg-zinc-800 shrink-0" />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="h-4 w-11/12 rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-3 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-3 w-1/3 rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
              </div>
            ))}
          </div>
        )
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : needsAuth ? (
        <EmptyState
          title="Sign in required"
          description="This section stores private data that is only available to a signed-in account."
          actionLabel="Sign In"
          onAction={() => openAuthModal("login")}
          icon={icon || <ListVideo className="w-7 h-7 text-zinc-400" />}
        />
      ) : videos.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          actionLabel={emptyActionLabel}
          onAction={onEmptyAction}
          icon={icon || <ListVideo className="w-7 h-7 text-zinc-400" />}
        />
      ) : layout === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
          {videos.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              onRemoveFromList={
                removeMode ? (vid) => setVideos((p) => p.filter((x) => x.id !== vid)) : undefined
              }
            />
          ))}
        </div>
      ) : (
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {videos.map((v) => (
            <VideoListItem
              key={v.id}
              video={v}
              onRemove={removeMode ? () => handleRemove(v.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function HistoryIcon() {
  return <History className="w-5 h-5" />;
}

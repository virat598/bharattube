"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Tv } from "lucide-react";
import {
  VideoCard,
  VideoItem,
  UserAvatar,
  SkeletonGrid,
  EmptyState,
} from "@/components/VideoComponents";
import { useApp } from "@/context/AppContext";
import { apiUrl } from "@/lib/api-config";
import { adaptVideos, channelHref } from "@/lib/backend-adapter";
import { formatCount } from "@/lib/format";

/**
 * Subscriptions feed.
 *
 * The deployed Render/MongoDB backend has no "list my subscriptions" route
 * (GET /subscriptions → "Route not found"), and GET /videos ignores a
 * `feed=subscriptions` parameter — it simply returns the video catalogue.
 *
 * It DOES return each video with its embedded `channel` object, and that
 * object contains the channel's real `subscribers` array of user ids. So the
 * subscribed channels are derived from that real data (the same rule
 * `adaptChannel` uses for its `isSubscribed` flag), and the videos are grouped
 * per channel — YouTube-style: subscribed channels up top, their uploads below.
 *
 * Nothing is fabricated: a channel only appears here if the signed-in user's id
 * is genuinely present in that channel's subscribers array on the backend.
 */

interface SubscribedChannel {
  channelId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  subscriberCount: number;
  isVerified: boolean;
}

/** True when the channel's real subscribers array contains this user id. */
function isSubscribedTo(
  subscribers: unknown,
  currentUserId: string | null
): boolean {
  if (!currentUserId || !Array.isArray(subscribers)) return false;
  return subscribers.some((entry) => {
    const id =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, any>)._id ??
          (entry as Record<string, any>).id ??
          (entry as Record<string, any>).userId
        : entry;
    return id !== undefined && id !== null && String(id) === currentUserId;
  });
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export default function SubscriptionsPage() {
  const { user, authStatus, openAuthModal, feedRefreshTrigger } = useApp();
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [channels, setChannels] = useState<SubscribedChannel[]>([]);
  const [loading, setLoading] = useState(true);

  const currentUserId = user?.id != null ? String(user.id) : null;

  const loadSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      /**
       * GET /videos never returns Shorts (verified: 0 of its items have
       * isShort), so channels that upload only Shorts were never listed even
       * when subscribed. Read the Shorts feed too; both embed the channel's
       * real `subscribers` array.
       */
      const [res, shortsRes] = await Promise.all([
        fetch(apiUrl("/videos?limit=100"), { cache: "no-store", credentials: "include" }),
        fetch(apiUrl("/shorts/feed?limit=50"), { cache: "no-store", credentials: "include" }).catch(
          () => null
        ),
      ]);
      if (!res.ok) {
        setVideos([]);
        setChannels([]);
        return;
      }

      const data = await res.json().catch(() => ({}));
      const shortsData = shortsRes?.ok ? await shortsRes.json().catch(() => ({})) : {};
      const shortList: any[] =
        shortsData?.data?.videos ?? shortsData?.data?.shorts ?? shortsData?.videos ??
        shortsData?.shorts ?? [];
      const seenVideoIds = new Set<string>();
      const rawVideos: any[] = [
        ...((data?.data?.videos ?? data?.videos ?? data?.data ?? []) as any[]),
        ...(Array.isArray(shortList) ? shortList.map((item) => ({ ...item, isShort: true })) : []),
      ].filter((item) => {
        const key = String(item?._id ?? item?.id ?? "");
        if (!key || seenVideoIds.has(key)) return false;
        seenVideoIds.add(key);
        return true;
      });

      // Derive the real subscribed-channel list straight from the payload.
      const channelMap = new Map<string, SubscribedChannel>();
      const adapted: VideoItem[] = [];

      for (const raw of rawVideos) {
        const channel = raw?.channel ?? {};
        const channelId = pickString(
          channel._id,
          channel.id,
          raw?.channelId,
          raw?.channel?._id
        );

        if (channelId && isSubscribedTo(channel.subscribers, currentUserId)) {
          // Prefer the authoritative GET /channel/:handle record when needed,
          // but the embedded object already carries everything the UI shows.
          if (!channelMap.has(channelId)) {
            channelMap.set(channelId, {
              channelId,
              displayName:
                pickString(channel.channelName, channel.handle) || "Channel",
              username: pickString(channel.handle, channel.username),
              avatarUrl: pickString(channel.logo, channel.avatarUrl) || null,
              subscriberCount: Array.isArray(channel.subscribers)
                ? channel.subscribers.length
                : 0,
              isVerified: Boolean(channel.verified),
            });
          }
        }

        // Adapt to the real VideoItem shape the rest of the UI consumes.
        const adaptedItem = adaptVideos(
          { videos: [raw] },
          "videos",
          { currentUserId }
        )[0] as unknown as VideoItem | undefined;
        if (adaptedItem) adapted.push(adaptedItem);
      }

      setVideos(adapted);
      setChannels(Array.from(channelMap.values()));
    } catch {
      setVideos([]);
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    loadSubscriptions();
  }, [loadSubscriptions, user, feedRefreshTrigger]);

  /**
   * Only videos from channels the user is genuinely subscribed to. Videos are
   * keyed by the same channel id used to build the channel bar.
   */
  const subscribedChannelIds = useMemo(
    () => new Set(channels.map((c) => c.channelId)),
    [channels]
  );

  const feedVideos = useMemo(
    () =>
      videos.filter((video) => {
        const creator = (
          video as unknown as {
            creator?: { id?: string | number; channelId?: string | number };
          }
        ).creator;
        const id = String(creator?.channelId ?? creator?.id ?? "");
        return id ? subscribedChannelIds.has(id) : false;
      }),
    [videos, subscribedChannelIds]
  );

  /** Videos grouped per channel, newest first — like YouTube's sub feed. */
  const videosByChannel = useMemo(() => {
    const groups = new Map<string, VideoItem[]>();
    for (const video of feedVideos) {
      const creator = (
        video as unknown as {
          creator?: { id?: string | number; channelId?: string | number };
        }
      ).creator;
      const id = String(creator?.channelId ?? creator?.id ?? "");
      if (!id) continue;
      const list = groups.get(id) ?? [];
      list.push(video);
      groups.set(id, list);
    }
    for (const [, list] of groups) {
      list.sort(
        (a, b) =>
          (Date.parse(b.createdAt || "") || 0) -
          (Date.parse(a.createdAt || "") || 0)
      );
    }
    return groups;
  }, [feedVideos]);

  if (authStatus === "loading") {
    return (
      <div className="max-w-[1700px] mx-auto px-6 py-16">
        <SkeletonGrid count={8} />
      </div>
    );
  }

  if (authStatus !== "authenticated" || !user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <EmptyState
          title="No subscriptions yet"
          description="Sign in to subscribe to creators and see their latest video uploads here."
          actionLabel="Sign In"
          onAction={() => openAuthModal("login")}
          icon={<Tv className="w-7 h-7 text-red-500" />}
        />
      </div>
    );
  }

  return (
    <div className="max-w-[1700px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
          Subscriptions
        </h1>
      </div>

      {loading ? (
        <SkeletonGrid count={8} />
      ) : channels.length === 0 ? (
        <EmptyState
          title="No subscriptions yet"
          description="Channels you subscribe to will appear here along with their latest public uploads."
          icon={<Tv className="w-7 h-7 text-zinc-400" />}
        />
      ) : (
        <div className="space-y-8">
          {/* Subscribed channels bar */}
          <div className="flex items-start gap-5 overflow-x-auto no-scrollbar pb-4 border-b border-zinc-200 dark:border-zinc-800 -mx-4 px-4 sm:mx-0 sm:px-0">
            {channels.map((ch) => (
              <Link
                key={ch.channelId}
                href={channelHref({ id: ch.channelId, username: ch.username })}
                className="flex flex-col items-center gap-2 w-[84px] shrink-0 group"
              >
                <UserAvatar
                  name={ch.displayName}
                  avatarUrl={ch.avatarUrl}
                  size="lg"
                  className="!w-14 !h-14 !text-lg"
                />
                <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100 text-center truncate w-full group-hover:text-red-600">
                  {ch.displayName}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                  {formatCount(ch.subscriberCount, "subscriber", "subscribers")}
                </div>
              </Link>
            ))}
          </div>

          {/* Each subscribed channel with its own uploads */}
          {feedVideos.length === 0 ? (
            <EmptyState
              title="No videos uploaded by your subscribed channels yet"
              description="As soon as the channels you subscribed to publish public videos, they will appear right here."
            />
          ) : (
            Array.from(videosByChannel.entries()).map(
              ([channelId, channelVideos]) => {
                const channel = channels.find((c) => c.channelId === channelId);
                if (!channel) return null;
                return (
                  <section
                    key={channelId}
                    aria-label={`${channel.displayName} videos`}
                  >
                    <div className="flex items-center gap-2.5 mb-3">
                      <UserAvatar
                        name={channel.displayName}
                        avatarUrl={channel.avatarUrl}
                        size="sm"
                      />
                      <Link
                        href={channelHref({
                          id: channel.channelId,
                          username: channel.username,
                        })}
                        className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 hover:text-red-600"
                      >
                        {channel.displayName}
                      </Link>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                        {channelVideos.length}{" "}
                        {channelVideos.length === 1 ? "video" : "videos"}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
                      {channelVideos.map((video) => (
                        <VideoCard key={video.id} video={video} />
                      ))}
                    </div>
                  </section>
                );
              }
            )
          )}
        </div>
      )}
    </div>
  );
}

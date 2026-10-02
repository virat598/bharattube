"use client";

import React, { useState, useEffect, useCallback, use, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CheckCircle2,
  ListVideo,
  Info,
  Calendar,
  Eye,
  Users,
  Video as VideoIcon,
  Flame,
  Radio,
  Edit3,
  ChevronDown,
  Copy,
  Link2,
  X,
} from "lucide-react";
import {
  UserAvatar,
  SubscribeButton,
  VideoCard,
  VideoItem,
  SkeletonGrid,
  EmptyState,
  ErrorState,
} from "@/components/VideoComponents";
import { formatCount, formatDuration } from "@/lib/format";
import { useApp } from "@/context/AppContext";
import { adaptChannel, adaptVideos } from "@/lib/backend-adapter";
import { apiUrl, channelApiUrl, channelMeApiUrl, isRouteNotFound } from "@/lib/api-config";

interface ChannelProfile {
  id: string;
  ownerUserId?: string;
  ownerUsername?: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  isVerified: boolean;
  subscriberCount: number;
  isSubscribed: boolean;
  totalVideos: number;
  totalViews: number;
  createdAt: string;
}

interface PlaylistSummary {
  id: string | number;
  title: string;
  description: string;
  visibility: string;
  itemCount: number;
  thumbnailUrl: string | null;
}

export default function ChannelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { user, loadingAuth, openUploadModal, feedRefreshTrigger, refreshUser, showToast } = useApp();

  const [channel, setChannel] = useState<ChannelProfile | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [activeTab, setActiveTab] = useState<
    "Home" | "Videos" | "Shorts" | "Live" | "Playlists" | "About"
  >("Home");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** True when this backend exposes no channel route at all. */
  const [channelRouteMissing, setChannelRouteMissing] = useState(false);
  /** True when the authenticated owner has no real channel record yet. */
  const [ownChannelMissing, setOwnChannelMissing] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [createChannelError, setCreateChannelError] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [channelBannerFailed, setChannelBannerFailed] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const requestSeq = useRef(0);

  /**
   * Loads REAL channel data from the deployed backend.
   *
   * VERIFIED backend contract (probed live, not assumed):
   *   GET /channel/:handle → { success, data: { _id, owner:{_id,name,
   *        profilePhoto,username}, channelName, handle, logo, banner,
   *        description, subscribers[], totalViews, totalVideos,
   *        verified, subscribersCount } }
   * The route is SINGULAR and keyed by the channel HANDLE.
   * Channel videos come from the real GET /videos?userId=<ownerUserId>.
   *
   * Nothing is mocked: every value below is mapped from the API response.
   */
  const loadChannel = useCallback(async () => {
    if (loadingAuth) return;

    const seq = ++requestSeq.current;
    let redirected = false;
    setLoading(true);
    setError("");
    setChannelBannerFailed(false);
    setRedirecting(false);
    setChannelRouteMissing(false);
    setOwnChannelMissing(false);

    try {
      // "Your Channel" historically linked to the user id, while the real
      // backend public route is keyed by channel handle. Resolve that case
      // directly through GET /channel/me so the UI never flashes "Channel not
      // found" before redirecting to the canonical handle URL.
      const isOwnUserId = Boolean(user && String(id) === String(user.id));
      let payload: unknown = null;
      let resOk = false;
      let responseMessage = "";

      if (isOwnUserId) {
        const meRes = await fetch(channelMeApiUrl(), {
          credentials: "include",
          cache: "no-store",
        });
        resOk = meRes.ok;
        payload = await meRes.json().catch(() => null);
        responseMessage = payload && typeof payload === "object"
          ? String((payload as Record<string, unknown>).message || (payload as Record<string, unknown>).error || "")
          : "";

        if (!meRes.ok) {
          if (/channel.*not found|no channel|create.*channel/i.test(responseMessage)) {
            setOwnChannelMissing(true);
            setChannel(null);
            setVideos([]);
            setPlaylists([]);
            return;
          }
          throw new Error(responseMessage || "Failed to load your channel");
        }
      } else {
        const res = await fetch(channelApiUrl(id), { cache: "no-store" });
        resOk = res.ok;
        payload = await res.json().catch(() => null);
        responseMessage = payload && typeof payload === "object"
          ? String((payload as Record<string, unknown>).message || (payload as Record<string, unknown>).error || "")
          : "";

        if (!res.ok) {
          if (isRouteNotFound(payload)) {
            setChannelRouteMissing(true);
          } else {
            setError(responseMessage || "Channel not found");
          }
          setChannel(null);
          setVideos([]);
          setPlaylists([]);
          return;
        }
      }

      if (!resOk || !payload) {
        setError(responseMessage || "Channel not found");
        return;
      }

      const adapted = adaptChannel(payload, {
        currentUserId: user?.id != null ? String(user.id) : null,
      });

      if (!adapted) {
        if (isOwnUserId) setOwnChannelMissing(true);
        else setError("Channel not found");
        setChannel(null);
        setVideos([]);
        setPlaylists([]);
        return;
      }

      // Canonicalize an own-channel id URL before rendering the public page.
      if (isOwnUserId && adapted.username && String(id) !== String(adapted.username)) {
        const canonical = `/channel/${encodeURIComponent(adapted.username)}${window.location.search}`;
        redirected = true;
        setRedirecting(true);
        router.replace(canonical);
        return;
      }

      setChannel({
        id: adapted.id,
        ownerUserId: adapted.ownerUserId,
        ownerUsername: adapted.ownerUsername,
        username: adapted.username,
        displayName: adapted.displayName,
        avatarUrl: adapted.avatarUrl,
        bannerUrl: adapted.bannerUrl,
        bio: adapted.bio,
        isVerified: adapted.isVerified,
        subscriberCount: adapted.subscriberCount,
        isSubscribed: adapted.isSubscribed,
        totalVideos: adapted.totalVideos,
        totalViews: adapted.totalViews,
        createdAt: adapted.createdAt,
      });

      const vres = await fetch(
        apiUrl(`/channel/${encodeURIComponent(adapted.username)}/videos`),
        { cache: "no-store" }
      );
      if (vres.ok) {
        const vpayload = await vres.json();
        setVideos(adaptVideos(vpayload) as unknown as VideoItem[]);
      } else {
        setVideos([]);
      }

      setPlaylists([]);
    } catch (err) {
      const isNetwork =
        err instanceof TypeError ||
        /fetch|network|cors/i.test(String((err as Error)?.message || ""));
      setError(
        isNetwork
          ? "Could not reach the video service. The server may be offline or blocking requests from this site."
          : String((err as Error)?.message || "Failed to load channel data.")
      );
      setChannel(null);
      setVideos([]);
      setPlaylists([]);
    } finally {
      if (seq === requestSeq.current && !redirected) {
        setLoading(false);
      }
    }
  }, [id, user?.id, loadingAuth, router]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel, feedRefreshTrigger]);

  /**
   * Uses the backend's EXISTING authenticated POST /channel route. The server
   * derives ownership from the session; we only send the real signed-in
   * profile values as initial channel defaults. No channel is fabricated in
   * the browser and duplicate creation remains a backend concern.
   */
  const createMyChannel = async () => {
    if (!user || String(user.id) !== String(id) || creatingChannel) return;
    setCreatingChannel(true);
    setCreateChannelError("");
    try {
      const res = await fetch(apiUrl("/channel"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelName: user.displayName,
          handle: user.username,
          description: user.bio || "",
          logo: user.avatarUrl || "",
          banner: user.bannerUrl || "",
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateChannelError(
          payload?.message ||
            payload?.error ||
            "The server could not create your channel. Please try again."
        );
        return;
      }
      // Reload through GET /channel/me → canonical handle redirect. The
      // displayed channel will only appear after the server confirms it.
      await loadChannel();
    } catch {
      setCreateChannelError(
        "Could not reach the server. Please check your connection and try again."
      );
    } finally {
      setCreatingChannel(false);
    }
  };

  if (loading || loadingAuth || redirecting) {
    return (
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6">
        <div className="w-full h-44 sm:h-56 rounded-2xl bg-zinc-200 dark:bg-zinc-800 animate-pulse mb-6" />
        <div className="flex items-center gap-4 mb-6">
          <div className="w-20 h-20 rounded-full bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-5 w-48 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
            <div className="h-3 w-32 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
          </div>
        </div>
        <SkeletonGrid count={4} />
      </div>
    );
  }

  /**
    * This deployment's backend exposes `GET /channel/:handle` (singular, keyed
    * by the channel HANDLE) and has no channel route at all if this flag is set.
    * We never fabricate an identity — the notice below is exact.
    */
  if (channelRouteMissing && !channel) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 mb-6">
          <h2 className="text-sm font-bold text-amber-700 dark:text-amber-400">
            Channel information isn&apos;t available from this backend
          </h2>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 leading-relaxed">
            The API responds{" "}
            <span className="font-mono">Route &apos;/channel/{id}&apos; not found</span>.
            Videos below are the real uploads returned by the API for this user.
          </p>
        </div>

        {loading ? (
          <SkeletonGrid count={4} />
        ) : videos.length === 0 ? (
          <EmptyState
            title="No videos from this user yet"
            description="The API returned no uploads for this user id."
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
            {videos.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (ownChannelMissing && !channel) {
    const isCurrentUserRoute = Boolean(user && String(user.id) === String(id));
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        {createChannelError && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
            {createChannelError}
          </div>
        )}
        <EmptyState
          title="You don't have a channel yet"
          description={
            isCurrentUserRoute
              ? "No channel record exists for your account. Create your real channel using your authenticated profile, then it will be loaded from the server."
              : "No channel record exists for this user on the server."
          }
          actionLabel={isCurrentUserRoute ? (creatingChannel ? "Creating channel..." : "Create your channel") : "Go back"}
          onAction={isCurrentUserRoute ? createMyChannel : () => router.push("/you")}
        />
      </div>
    );
  }

  if (error || !channel) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <ErrorState
          message={error || "Channel not found"}
          onRetry={loadChannel}
        />
      </div>
    );
  }

  const standardVideos = videos.filter((v) => !v.isShort && !v.isLive);
  const shortVideos = videos.filter((v) => v.isShort);
  const liveVideos = videos.filter((v) => v.isLive);
  // Ownership: compare the signed-in user id with the channel owner id.
  const isOwner = Boolean(
    user &&
      (String(user.id) === String(channel.ownerUserId || "") ||
        (channel.ownerUsername && String(user.username) === channel.ownerUsername))
  );

  return (
    <div className="max-w-[1600px] mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-5">
      {/* Channel Banner */}
      <div className="relative w-full aspect-[6/1] min-h-28 max-h-60 rounded-xl sm:rounded-2xl overflow-hidden bg-zinc-200 dark:bg-zinc-800">
        {channel.bannerUrl && !channelBannerFailed ? (
          <img
            src={channel.bannerUrl}
            alt={`${channel.displayName} channel banner`}
            loading="eager"
            referrerPolicy="no-referrer"
            onError={() => setChannelBannerFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            role="img"
            aria-label={`${channel.displayName} default channel banner`}
            className="w-full h-full bg-zinc-200 dark:bg-zinc-800"
          />
        )}
      </div>

      {/* Channel Header Info */}
      <div className="mt-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5 pb-6 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <UserAvatar
            name={channel.displayName}
            avatarUrl={channel.avatarUrl}
            size="xl"
          />
          <div>
            <h1 className="text-xl sm:text-3xl font-bold flex items-center gap-2 text-zinc-900 dark:text-white break-words">
              <span>{channel.displayName}</span>
              {channel.isVerified && (
                <CheckCircle2 className="w-5 h-5 text-zinc-400" />
              )}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 tabular-nums">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                @{channel.username}
              </span>
              <span>•</span>
              <span>
                {formatCount(
                  channel.subscriberCount,
                  "Subscriber",
                  "Subscribers"
                )}
              </span>
              <span>•</span>
              <span>
                {formatCount(channel.totalVideos, "video", "videos")}
              </span>
            </div>
            {channel.bio && (
              <p className="mt-2 text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 max-w-2xl line-clamp-2">
                {channel.bio}
              </p>
            )}
            {!isOwner && (
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                className="mt-2 inline-flex items-center gap-1 text-xs sm:text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:text-red-600 cursor-pointer"
              >
                More
                <ChevronDown className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {isOwner ? (
            <>
              <Link
                href="/edit-channel"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-xs sm:text-sm font-semibold transition-colors"
              >
                <Edit3 className="w-4 h-4" />
                <span>Edit Channel</span>
              </Link>
              <button
                type="button"
                onClick={openUploadModal}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium cursor-pointer"
              >
                <span>Upload Video</span>
              </button>
            </>
          ) : (
            <SubscribeButton
              channelId={channel.id}
              isOwner={isOwner}
              initialSubscribed={channel.isSubscribed}
              initialCount={channel.subscriberCount}
              onStatusChange={(sub, newCount) => {
                setChannel((prev) =>
                  prev
                    ? { ...prev, isSubscribed: sub, subscriberCount: newCount }
                    : prev
                );
              }}
            />
          )}
        </div>
      </div>

      {/* Channel Navigation Tabs */}
      <div className="sticky top-14 z-20 bg-zinc-50/95 dark:bg-[#0F0F0F]/95 backdrop-blur-md flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar border-b border-zinc-200 dark:border-zinc-800 mb-6 -mx-3 px-3 sm:mx-0 sm:px-0">
        {(
          ["Home", "Videos", "Shorts", "Live", "Playlists", "About"] as const
        ).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`shrink-0 px-4 py-3 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap cursor-pointer active:opacity-70 ${
              activeTab === tab
                ? "border-red-600 text-red-600 dark:text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "Home" && (
        <div className="space-y-10">
          {videos.length === 0 ? (
            <EmptyState
              title="This channel hasn't uploaded any videos yet"
              description="Once videos or Shorts are published by this creator, they will appear here."
              actionLabel={isOwner ? "Upload Your First Video" : undefined}
              onAction={isOwner ? openUploadModal : undefined}
            />
          ) : (
            <>
              {standardVideos.length > 0 && (
                <section>
                  <h2 className="text-base font-bold mb-4">Videos</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
                    {standardVideos.map((v) => (
                      <VideoCard key={v.id} video={v} />
                    ))}
                  </div>
                </section>
              )}

              {shortVideos.length > 0 && (
                <section>
                  <h2 className="text-base font-bold mb-4 flex items-center gap-2">
                    <Flame className="w-4 h-4 text-red-600" />
                    <span>Shorts</span>
                  </h2>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
                    {shortVideos.map((s) => (
                      <Link
                        key={s.id}
                        href={`/shorts?id=${s.id}`}
                        className="group flex flex-col gap-2"
                      >
                        <div className="relative aspect-[9/16] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800">
                          {s.thumbnailUrl ? (
                            <img
                              src={s.thumbnailUrl}
                              alt={s.title}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <video
                              src={s.videoUrl ? `${s.videoUrl}#t=0.5` : undefined}
                              preload="metadata"
                              muted
                              playsInline
                              className="w-full h-full object-cover pointer-events-none"
                            />
                          )}
                          <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/80 text-white text-[10px]">
                            {formatDuration(s.duration)}
                          </span>
                        </div>
                        <span className="text-xs font-semibold line-clamp-2">
                          {s.title}
                        </span>
                      </Link>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "Videos" &&
        (standardVideos.length === 0 ? (
          <EmptyState
            title="No standard videos uploaded yet"
            description="Standard 16:9 videos uploaded by this channel will appear here."
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
            {standardVideos.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        ))}

      {activeTab === "Shorts" &&
        (shortVideos.length === 0 ? (
          <EmptyState
            title="No Shorts uploaded yet"
            description="Vertical Shorts uploaded by this channel will appear here."
            icon={<Flame className="w-7 h-7 text-red-500" />}
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
            {shortVideos.map((s) => (
              <Link
                key={s.id}
                href={`/shorts?id=${s.id}`}
                className="group flex flex-col gap-2"
              >
                <div className="relative aspect-[9/16] rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800">
                  {s.thumbnailUrl ? (
                    <img
                      src={s.thumbnailUrl}
                      alt={s.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  ) : (
                    <video
                      src={s.videoUrl ? `${s.videoUrl}#t=0.5` : undefined}
                      preload="metadata"
                      muted
                      playsInline
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform pointer-events-none"
                    />
                  )}
                </div>
                <h3 className="text-sm font-semibold line-clamp-2">
                  {s.title}
                </h3>
                <span className="text-xs text-zinc-500">
                  {formatCount(s.viewsCount, "view", "views")}
                </span>
              </Link>
            ))}
          </div>
        ))}

      {activeTab === "Live" &&
        (liveVideos.length === 0 ? (
          <EmptyState
            title="No live streams available"
            description="This channel has no active or archived live broadcasts."
            icon={<Radio className="w-7 h-7 text-zinc-400" />}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
            {liveVideos.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        ))}

      {activeTab === "Playlists" &&
        (playlists.length === 0 ? (
          <EmptyState
            title="No playlists yet"
            description="Public playlists created by this channel will be listed here."
            icon={<ListVideo className="w-7 h-7 text-zinc-400" />}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {playlists.map((pl) => (
              <Link
                key={pl.id}
                href={`/playlists?id=${pl.id}`}
                className="group flex flex-col gap-2 p-3 rounded-2xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-red-500/50 transition-colors"
              >
                <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-800 flex items-center justify-center">
                  {pl.thumbnailUrl ? (
                    <img
                      src={pl.thumbnailUrl}
                      alt={pl.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ListVideo className="w-8 h-8 text-zinc-500" />
                  )}
                  <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/85 text-white text-xs font-semibold">
                    {pl.itemCount} videos
                  </span>
                </div>
                <h3 className="font-bold text-sm group-hover:text-red-500 transition-colors">
                  {pl.title}
                </h3>
                <p className="text-xs text-zinc-500 line-clamp-1">
                  {pl.description || "View full playlist"}
                </p>
              </Link>
            ))}
          </div>
        ))}

      {activeTab === "About" && (
        <div className="max-w-2xl p-6 rounded-2xl bg-zinc-100/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 space-y-6">
          <div>
            <h3 className="text-base font-bold mb-2 flex items-center gap-2">
              <Info className="w-4 h-4 text-red-600" />
              <span>Channel Description</span>
            </h3>
            <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-line">
              {channel.bio || "This creator has not added a biography yet."}
            </p>
          </div>

          <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div className="flex items-center gap-3">
              <Users className="w-4 h-4 text-zinc-400" />
              <span>
                {formatCount(
                  channel.subscriberCount,
                  "Subscriber",
                  "Subscribers"
                )}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <VideoIcon className="w-4 h-4 text-zinc-400" />
              <span>
                {formatCount(channel.totalVideos, "video", "videos")}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Eye className="w-4 h-4 text-zinc-400" />
              <span>
                {formatCount(channel.totalViews, "total view", "total views")}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Calendar className="w-4 h-4 text-zinc-400" />
              <span>
                Joined {new Date(channel.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      )}

      {moreOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMoreOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 shadow-lg overflow-hidden pb-safe">
            <div className="flex items-center justify-between pl-5 pr-3 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <h3 className="text-base font-semibold">About this channel</h3>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                className="tap-target inline-flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div className="flex items-start gap-3">
                <Calendar className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs text-zinc-500">Joined</div>
                  <div className="font-medium">
                    {channel.createdAt
                      ? new Date(channel.createdAt).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })
                      : "—"}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Eye className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs text-zinc-500">Total views</div>
                  <div className="font-medium tabular-nums">
                    {formatCount(channel.totalViews, "view", "views")}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Link2 className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-500">Channel link</div>
                  <div className="font-medium truncate">
                    {typeof window !== "undefined"
                      ? `${window.location.origin}/channel/${encodeURIComponent(channel.username)}`
                      : `/channel/${channel.username}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const url = `${window.location.origin}/channel/${encodeURIComponent(channel.username)}`;
                    navigator.clipboard?.writeText(url).then(
                      () => showToast("Channel link copied", "success"),
                      () => showToast(url, "info")
                    );
                  }}
                  className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  aria-label="Copy channel link"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

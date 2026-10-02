"use client";

import React, { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Search, SlidersHorizontal, ListVideo, Loader2 } from "lucide-react";
import { MobileSearchBar } from "@/components/MobileSearchBar";
import { ErrorState } from "@/components/VideoComponents";
import {
  VideoListItem,
  VideoItem,
  UserAvatar,
  SubscribeButton,
  EmptyState,
} from "@/components/VideoComponents";
import { formatCount } from "@/lib/format";
import { apiUrl } from "@/lib/api-config";
import { adaptVideos, adaptChannelResults , channelHref } from "@/lib/backend-adapter";
import { useApp } from "@/context/AppContext";

interface ChannelResult {
  id: string | number;
  handle?: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  isVerified: boolean;
  subscriberCount: number;
  isSubscribed: boolean;
}

interface PlaylistResult {
  id: string | number;
  title: string;
  description: string;
  itemCount: number;
  thumbnailUrl: string | null;
  owner: { id: string | number; username: string; displayName: string };
}

function SearchContent() {
  const { user } = useApp();
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";

  const [filter, setFilter] = useState<"all" | "videos" | "channels" | "playlists">(
    "all"
  );
  const [sort, setSort] = useState<"relevance" | "latest" | "views">("relevance");

  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [channels, setChannels] = useState<ChannelResult[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      setVideos([]);
      setChannels([]);
      setPlaylists([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        apiUrl(`/search?q=${encodeURIComponent(query)}&limit=50`),
        { cache: "no-store", credentials: "include" }
      );
      if (!res.ok) {
        throw new Error("search failed");
      }
      const data = await res.json();

      // Map the backend's shapes onto what this page renders.
      // Videos: { _id, owner:{...}, thumbnail, views, createdAt, ... }
      // Channels: { _id, channelName, handle, logo, subscribers[] }
      let nextVideos = adaptVideos(data) as unknown as VideoItem[];
      let nextChannels = adaptChannelResults(data, "channels", {
        currentUserId: user?.id != null ? String(user.id) : null,
      }) as unknown as ChannelResult[];
      const nextPlaylists = (Array.isArray(data.playlists) ? data.playlists : [])
        .map((pl: any): PlaylistResult => ({
          id: String(pl?._id ?? pl?.id ?? ""),
          title: String(pl?.title ?? "Untitled playlist"),
          description: String(pl?.description ?? ""),
          itemCount: Number(pl?.itemCount ?? pl?.videos?.length ?? 0),
          thumbnailUrl: pl?.thumbnailUrl || pl?.thumbnail || pl?.videos?.[0]?.thumbnail || null,
          owner: {
            id: String(pl?.owner?._id ?? pl?.owner?.id ?? ""),
            username: String(pl?.owner?.username ?? ""),
            displayName: String(pl?.owner?.name ?? pl?.owner?.displayName ?? "BharatTube creator"),
          },
        }))
        .filter((pl: { id: string | number }) => Boolean(pl.id));

      if (filter === "videos") {
        nextChannels = [];
        nextPlaylists.length = 0;
      } else if (filter === "channels") {
        nextVideos = [];
        nextPlaylists.length = 0;
      } else if (filter === "playlists") {
        nextVideos = [];
        nextChannels = [];
      }

      if (sort === "latest") {
        nextVideos.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      } else if (sort === "views") {
        nextVideos.sort((a, b) => b.viewsCount - a.viewsCount);
      }

      setVideos(nextVideos);
      setChannels(nextChannels);
      setPlaylists(nextPlaylists);
    } catch {
      setError("Could not load search results. Check your connection and try again.");
      setVideos([]);
      setChannels([]);
      setPlaylists([]);
    } finally {
      setLoading(false);
    }
  }, [query, filter, sort, user?.id]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  const totalCount = videos.length + channels.length + playlists.length;

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-3 sm:py-6">
      {/* Mobile-first search input (header shows only an icon on phones) */}
      <div className="mb-4">
        <MobileSearchBar initialQuery={query} />
      </div>

      {/* Filter & Sort Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-5 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 max-w-full">
          {(["all", "videos", "channels", "playlists"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-semibold capitalize transition-colors cursor-pointer active:scale-95 ${
                filter === f
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950"
                  : "bg-zinc-200/80 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <SlidersHorizontal className="w-4 h-4 text-zinc-400" />
          <span className="text-zinc-500">Sort by:</span>
          <select
            value={sort}
            onChange={(e) =>
              setSort(e.target.value as "relevance" | "latest" | "views")
            }
            className="px-3 py-2 rounded-xl bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold"
          >
            <option value="relevance">Relevance</option>
            <option value="latest">Upload Date</option>
            <option value="views">View Count</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4" aria-live="polite" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-2xl bg-zinc-200 dark:bg-zinc-800"
            />
          ))}
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={runSearch} />
      ) : totalCount === 0 ? (
        <EmptyState
          title="No results found"
          description={
            query
              ? `No videos, channels, or playlists matched "${query}". Try different keywords or filters.`
              : "Enter a search query in the top search bar to find videos, channels, and playlists."
          }
          icon={<Search className="w-7 h-7 text-zinc-400" />}
        />
      ) : (
        <div className="space-y-8">
          {/* Matched Channels */}
          {channels.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
                Channels
              </h2>
              {channels.map((ch) => (
                <div
                  key={ch.id}
                  className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-zinc-100/70 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800"
                >
                  <Link
                    href={channelHref({ handle: ch.handle, id: ch.id })}
                    className="flex items-center gap-4"
                  >
                    <UserAvatar
                      name={ch.displayName}
                      avatarUrl={ch.avatarUrl}
                      size="lg"
                    />
                    <div>
                      <div className="font-bold text-base text-zinc-900 dark:text-white">
                        {ch.displayName}
                      </div>
                      <div className="text-xs text-zinc-500">
                        @{ch.username} •{" "}
                        {formatCount(
                          ch.subscriberCount,
                          "Subscriber",
                          "Subscribers"
                        )}
                      </div>
                      {ch.bio && (
                        <p className="text-xs text-zinc-500 mt-1 line-clamp-1">
                          {ch.bio}
                        </p>
                      )}
                    </div>
                  </Link>

                  <SubscribeButton
                    channelId={ch.id}
                    initialSubscribed={ch.isSubscribed}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Matched Playlists */}
          {playlists.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
                Playlists
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {playlists.map((pl) => (
                  <Link
                    key={pl.id}
                    href={`/playlists?id=${pl.id}`}
                    className="flex items-center gap-4 p-3 rounded-2xl bg-zinc-100/70 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 hover:border-red-500/40"
                  >
                    <div className="w-32 aspect-video rounded-xl overflow-hidden bg-zinc-800 flex items-center justify-center shrink-0">
                      {pl.thumbnailUrl ? (
                        <img
                          src={pl.thumbnailUrl}
                          alt={pl.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <ListVideo className="w-6 h-6 text-zinc-500" />
                      )}
                    </div>
                    <div>
                      <div className="font-bold text-sm">{pl.title}</div>
                      <div className="text-xs text-zinc-500">
                        {pl.owner.displayName} • {pl.itemCount} videos
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Matched Videos */}
          {videos.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
                Videos
              </h2>
              <div className="space-y-2">
                {videos.map((v) => (
                  <VideoListItem key={v.id} video={v} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-5xl mx-auto px-6 py-12 flex items-center justify-center gap-2 text-sm text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Searching…
        </div>
      }
    >
      <SearchContent />
    </Suspense>
  );
}

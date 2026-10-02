"use client";

import React, { useState, useEffect, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import {
  ListVideo,
  Plus,
  Trash2,
  Edit3,
  Play,
  ChevronUp,
  ChevronDown,
  X,
  Globe,
  Link2,
  Lock,
} from "lucide-react";
import {
  VideoListItem,
  VideoItem,
  EmptyState,
  ErrorState,
} from "@/components/VideoComponents";
import { useApp } from "@/context/AppContext";
import { apiUrl } from "@/lib/api-config";

interface PlaylistDetail {
  id: string | number;
  title: string;
  description: string;
  visibility: string;
  itemCount: number;
  thumbnailUrl: string | null;
  userId: string | number;
  owner?: { id: string | number; username: string; displayName: string };
  videos: VideoItem[];
}

interface PlaylistSummary {
  id: string | number;
  title: string;
  description: string;
  visibility: string;
  itemCount: number;
  thumbnailUrl: string | null;
  userId: string | number;
}

const VISIBILITY_ICON: Record<string, React.ReactNode> = {
  public: <Globe className="w-3 h-3" />,
  unlisted: <Link2 className="w-3 h-3" />,
  private: <Lock className="w-3 h-3" />,
};

function PlaylistsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const playlistIdParam = searchParams.get("id");

  const { user, loadingAuth, openAuthModal, showToast, feedRefreshTrigger } = useApp();

  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newVisibility, setNewVisibility] = useState("private");
  const [saving, setSaving] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editVisibility, setEditVisibility] = useState("private");

  // A specific playlist may be public; only the personal list requires auth.
  const needsAuth = !user && !playlistIdParam;

  const loadPlaylists = useCallback(async () => {
    if (needsAuth) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl("/playlists"), { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load playlists");
      setPlaylists(data.playlists || []);
    } catch {
      setError("Could not load playlists from the server.");
    } finally {
      setLoading(false);
    }
  }, [needsAuth]);

  const loadDetail = useCallback(async (pid: string | number) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl(`/playlists?id=${encodeURIComponent(String(pid))}`), { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Playlist unavailable");
      setDetail(data.playlist);
    } catch (e) {
      setDetail(null);
      setError(e instanceof Error ? e.message : "Playlist unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loadingAuth) return;
    if (playlistIdParam) {
      loadDetail(playlistIdParam);
    } else {
      setDetail(null);
      loadPlaylists();
    }
  }, [playlistIdParam, loadDetail, loadPlaylists, loadingAuth, feedRefreshTrigger]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title: newTitle.trim(),
          visibility: newVisibility,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data?.error || "Failed to create playlist", "error");
        return;
      }
      setNewTitle("");
      setCreateOpen(false);
      showToast("Playlist created", "success");
      router.push(`/playlists?id=${data.playlist.id}`);
    } catch {
      showToast("Network error", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setSaving(true);
    try {
      const res = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rename",
          playlistId: detail.id,
          title: editTitle.trim(),
          description: editDescription.trim(),
          visibility: editVisibility,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data?.error || "Failed to update playlist", "error");
        return;
      }
      setEditOpen(false);
      showToast("Playlist updated", "success");
      await loadDetail(detail.id);
    } catch {
      showToast("Network error", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (playlistId: string | number) => {
    try {
      const res = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", playlistId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data?.error || "Failed to delete playlist", "error");
        return;
      }
      showToast("Playlist deleted", "success");
      if (playlistIdParam) router.push("/playlists");
      else await loadPlaylists();
    } catch {
      showToast("Network error", "error");
    }
  };

  const handleRemoveVideo = async (videoId: string | number) => {
    if (!detail) return;
    try {
      const res = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "remove_video",
          playlistId: detail.id,
          videoId,
        }),
      });
      if (!res.ok) {
        showToast("Failed to remove video", "error");
        return;
      }
      showToast("Removed from playlist", "success");
      await loadDetail(detail.id);
    } catch {
      showToast("Network error", "error");
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    if (!detail) return;
    const next = [...detail.videos];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];

    const orderedVideoIds = next.map((v) => v.id);
    setDetail({ ...detail, videos: next });

    try {
      const res = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reorder",
          playlistId: detail.id,
          orderedVideoIds,
        }),
      });
      if (!res.ok) {
        showToast("Failed to save new order", "error");
        await loadDetail(detail.id);
      }
    } catch {
      showToast("Network error", "error");
      await loadDetail(detail.id);
    }
  };

  if (loadingAuth) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-16 text-sm text-zinc-500">
        Loading...
      </div>
    );
  }

  if (needsAuth) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10">
        <EmptyState
          title="Sign in to manage playlists"
          description="Playlists are stored per account in the database. Sign in to create, reorder and play your collections."
          actionLabel="Sign In"
          onAction={() => openAuthModal("login")}
          icon={<ListVideo className="w-7 h-7 text-zinc-400" />}
        />
      </div>
    );
  }

  /* ------------------------- Playlist detail view ------------------------ */
  if (playlistIdParam) {
    if (loading) {
      return (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-3 animate-pulse">
          <div className="h-40 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-8 w-1/3 rounded bg-zinc-200 dark:bg-zinc-800" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          ))}
        </div>
      );
    }

    if (error || !detail) {
      return (
        <div className="max-w-3xl mx-auto px-6 py-10">
          <ErrorState
            message={error || "Playlist unavailable"}
            onRetry={() => loadDetail(playlistIdParam)}
          />
          <div className="text-center mt-4">
            <Link href="/playlists" className="text-xs font-semibold text-red-500 hover:underline">
              ← Back to all playlists
            </Link>
          </div>
        </div>
      );
    }

    const isOwner = user ? String(user.id) === String(detail.userId) : false;

    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <Link
          href="/playlists"
          className="text-xs font-semibold text-zinc-500 hover:text-red-500 inline-flex items-center gap-1 mb-4"
        >
          ← All playlists
        </Link>

        <div className="flex flex-col sm:flex-row gap-5 mb-6">
          <div className="relative w-full sm:w-72 aspect-video rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800 shrink-0 flex items-center justify-center">
            {detail.thumbnailUrl ? (
              <img src={detail.thumbnailUrl} alt={detail.title} className="w-full h-full object-cover" />
            ) : (
              <ListVideo className="w-10 h-10 text-zinc-600" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold">{detail.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-200 dark:bg-zinc-800 capitalize">
                {VISIBILITY_ICON[detail.visibility]}
                {detail.visibility}
              </span>
              <span className="tabular-nums">
                {detail.videos.length} {detail.videos.length === 1 ? "video" : "videos"}
              </span>
              {detail.owner && <span>by {detail.owner.displayName}</span>}
            </div>
            {detail.description && (
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{detail.description}</p>
            )}

            {isOwner && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Link
                  href={
                    detail.videos.length > 0
                      ? `/watch/${detail.videos[0].id}?list=${detail.id}`
                      : "/playlists"
                  }
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold shadow transition-colors ${
                    detail.videos.length > 0
                      ? "bg-red-600 hover:bg-red-500 text-white"
                      : "bg-zinc-200 dark:bg-zinc-800 text-zinc-400 pointer-events-none"
                  }`}
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Play all</span>
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setEditTitle(detail.title);
                    setEditDescription(detail.description || "");
                    setEditVisibility(detail.visibility);
                    setEditOpen(true);
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-300 dark:hover:bg-zinc-700 cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Edit</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(detail.id)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 text-xs font-semibold text-red-500 hover:bg-red-500/10 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete playlist</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {detail.videos.length === 0 ? (
          <EmptyState
            title="This playlist is empty"
            description='Add videos using the "Save to Playlist" action on any video card or watch page.'
            icon={<ListVideo className="w-7 h-7 text-zinc-400" />}
          />
        ) : (
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
            {detail.videos.map((v, idx) => (
              <div key={`${v.id}-${idx}`} className="flex items-center gap-1 pr-2">
                <div className="w-9 text-center text-xs text-zinc-400 tabular-nums shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <VideoListItem video={v} compact onRemove={isOwner ? () => handleRemoveVideo(v.id) : undefined} />
                </div>
                {isOwner && (
                  <div className="flex flex-col shrink-0">
                    <button
                      type="button"
                      onClick={() => handleMove(idx, -1)}
                      disabled={idx === 0}
                      aria-label="Move up"
                      className="p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-white disabled:opacity-25 cursor-pointer"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMove(idx, 1)}
                      disabled={idx === detail.videos.length - 1}
                      aria-label="Move down"
                      className="p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-white disabled:opacity-25 cursor-pointer"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Edit playlist dialog */}
        {editOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-lg">
              <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
                <h3 className="font-bold text-sm">Edit playlist</h3>
                <button
                  type="button"
                  onClick={() => setEditOpen(false)}
                  className="p-1 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form onSubmit={handleRename} className="p-5 space-y-3">
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Playlist title"
                  className="w-full px-3.5 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                />
                <textarea
                  rows={2}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Description (optional)"
                  className="w-full px-3.5 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                />
                <select
                  value={editVisibility}
                  onChange={(e) => setEditVisibility(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setEditOpen(false)}
                    className="px-4 py-2 rounded-full text-xs font-semibold bg-zinc-200 dark:bg-zinc-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 rounded-full text-xs font-semibold bg-red-600 text-white disabled:opacity-60 cursor-pointer"
                  >
                    Save changes
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ---------------------------- Playlists list --------------------------- */
  return (
    <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-zinc-200/70 dark:bg-zinc-800/80 flex items-center justify-center text-red-600">
            <ListVideo className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Playlists</h1>
            <p className="text-xs text-zinc-500 tabular-nums">
              {playlists.length} {playlists.length === 1 ? "playlist" : "playlists"}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setCreateOpen((o) => !o)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New playlist</span>
        </button>
      </div>

      {createOpen && (
        <form
          onSubmit={handleCreate}
          className="mb-6 p-4 rounded-2xl bg-zinc-100/80 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row gap-3"
        >
          <input
            type="text"
            required
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Playlist title..."
            className="flex-1 px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
          />
          <select
            value={newVisibility}
            onChange={(e) => setNewVisibility(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
          </select>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold disabled:opacity-60 cursor-pointer"
          >
            Create
          </button>
        </form>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 animate-pulse">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-48 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          ))}
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={loadPlaylists} />
      ) : playlists.length === 0 ? (
        <EmptyState
          title="No playlists yet"
          description="Create a playlist to organise videos you want to watch or share."
          actionLabel="Create playlist"
          onAction={() => setCreateOpen(true)}
          icon={<ListVideo className="w-7 h-7 text-zinc-400" />}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {playlists.map((pl) => (
            <div
              key={pl.id}
              className="group rounded-2xl bg-zinc-100/70 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 overflow-hidden"
            >
              <Link href={`/playlists?id=${pl.id}`} className="block relative aspect-video bg-zinc-800">
                {pl.thumbnailUrl ? (
                  <img
                    src={pl.thumbnailUrl}
                    alt={pl.title}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ListVideo className="w-9 h-9 text-zinc-600" />
                  </div>
                )}
                <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/85 text-white text-[11px] font-semibold tabular-nums">
                  {pl.itemCount} videos
                </span>
              </Link>

              <div className="p-3.5">
                <Link
                  href={`/playlists?id=${pl.id}`}
                  className="font-bold text-sm block truncate group-hover:text-red-500 transition-colors"
                >
                  {pl.title}
                </Link>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="inline-flex items-center gap-1 capitalize">
                    {VISIBILITY_ICON[pl.visibility]}
                    {pl.visibility}
                  </span>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <Link
                    href={`/playlists?id=${pl.id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-[11px] font-semibold cursor-pointer"
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>Manage</span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleDelete(pl.id)}
                    title="Delete playlist"
                    className="p-1.5 rounded-full text-zinc-400 hover:text-red-500 hover:bg-red-500/10 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlaylistsPage() {
  return (
    <Suspense fallback={null}>
      <PlaylistsContent />
    </Suspense>
  );
}

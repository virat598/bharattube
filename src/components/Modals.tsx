"use client";

import React, { useState, useEffect } from "react";
import {
  X,
  Plus,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { AuthModal } from "./AuthModal";
import { UploadStudio } from "./UploadStudio";
import { apiUrl } from "@/lib/api-config";

export function GlobalModals() {
  const {
    authModalOpen,
    closeAuthModal,
    uploadModalOpen,
    closeUploadModal,
    playlistModalVideoId,
    closePlaylistModal,
  } = useApp();

  return (
    <>
      {authModalOpen && <AuthModal onClose={closeAuthModal} />}
      {uploadModalOpen && <UploadStudio onClose={closeUploadModal} />}
      {playlistModalVideoId !== null && (
        <PlaylistModal
          videoId={playlistModalVideoId}
          onClose={closePlaylistModal}
        />
      )}
    </>
  );
}

function PlaylistModal({
  videoId,
  onClose,
}: {
  videoId: string | number;
  onClose: () => void;
}) {
  const { showToast } = useApp();
  const [playlists, setPlaylists] = useState<
    Array<{ id: string | number; title: string; visibility: string; videoIds: Array<string | number> }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState("");
  const [newVisibility, setNewVisibility] = useState("public");
  const [creating, setCreating] = useState(false);

  const loadPlaylists = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/playlists"));
      const data = await res.json();
      if (Array.isArray(data.playlists)) {
        setPlaylists(data.playlists);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlaylists();
  }, []);

  const toggleVideoInPlaylist = async (
    playlistId: string | number,
    currentlyIncluded: boolean
  ) => {
    try {
      const res = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: currentlyIncluded ? "remove_video" : "add_video",
          playlistId,
          videoId,
        }),
      });
      if (res.ok) {
        showToast(
          currentlyIncluded ? "Removed from playlist" : "Added to playlist",
          "success"
        );
        await loadPlaylists();
      }
    } catch {
      showToast("Failed to update playlist", "error");
    }
  };

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title: newTitle.trim(),
          visibility: newVisibility,
          videoId,
        }),
      });
      if (res.ok) {
        setNewTitle("");
        showToast("Playlist created & video added", "success");
        await loadPlaylists();
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4">
      <div className="w-full max-w-sm max-h-[85dvh] rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 shadow-lg overflow-hidden flex flex-col pb-safe">
        <div className="flex items-center justify-between pl-5 pr-3 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Save to playlist
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tap-target inline-flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 max-h-64 overflow-y-auto space-y-2">
          {loading ? (
            <div className="text-xs text-zinc-500 py-4 text-center">
              Loading playlists...
            </div>
          ) : playlists.length === 0 ? (
            <div className="text-xs text-zinc-500 py-4 text-center">
              No playlists yet. Create your first playlist below.
            </div>
          ) : (
            playlists.map((pl) => {
              const included = pl.videoIds?.includes(videoId);
              return (
                <label
                  key={pl.id}
                  className="flex items-center justify-between p-2.5 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => toggleVideoInPlaylist(pl.id, included)}
                      className="w-4 h-4 accent-red-600"
                    />
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {pl.title}
                    </span>
                  </div>
                  <span className="text-[10px] uppercase px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-500">
                    {pl.visibility}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <form
          onSubmit={handleCreatePlaylist}
          className="p-5 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/50 space-y-3"
        >
          <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            <span>Create New Playlist</span>
          </div>
          <input
            type="text"
            required
            placeholder="Playlist name"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="w-full h-10 px-3 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-zinc-500"
          />
          <div className="flex items-center gap-2">
            <select
              value={newVisibility}
              onChange={(e) => setNewVisibility(e.target.value)}
              className="flex-1 h-10 px-3 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-900 dark:text-zinc-100"
            >
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
            <button
              type="submit"
              disabled={creating}
              className="h-10 px-4 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-medium cursor-pointer"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

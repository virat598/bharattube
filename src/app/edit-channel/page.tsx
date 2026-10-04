"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Camera,
  ImageIcon,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { UserAvatar } from "@/components/VideoComponents";
import { useApp } from "@/context/AppContext";
import { apiUrl, channelMeApiUrl } from "@/lib/api-config";
import { unwrapEnvelope } from "@/lib/backend-adapter";

const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

function EditChannelContent() {
  const { user, refreshUser, triggerFeedRefresh, showToast } = useApp();
  const router = useRouter();

  const [backendChannel, setBackendChannel] = useState<any>(null);
  const [channelName, setChannelName] = useState("");
  const [handle, setHandle] = useState("");
  const [description, setDescription] = useState("");
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<"photo" | "banner" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    const loadChannel = async () => {
      try {
        const res = await fetch(channelMeApiUrl(), {
          cache: "no-store",
          credentials: "include",
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.message || "Unable to load channel.");

        const loaded = unwrapEnvelope(payload);
        if (!loaded || typeof loaded !== "object") {
          throw new Error("Invalid channel response.");
        }

        if (cancelled) return;
        const next = (loaded as any).channel || loaded;
        setBackendChannel(next);
        setChannelName(next.channelName || "");
        setHandle(next.handle || "");
        setDescription(next.description || "");
        setProfilePhotoUrl(next.logo || null);
        setBannerUrl(next.banner || null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load channel.");
        }
      }
    };

    loadChannel();
    return () => {
      cancelled = true;
    };
  }, []);


  if (!user || !backendChannel) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-sm text-zinc-500">
        Loading your channel...
      </div>
    );
  }

  const handleImageChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    kind: "photo" | "banner"
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showToast("Image must be 5 MB or smaller.", "error");
      return;
    }

    const preview = URL.createObjectURL(file);
    if (kind === "photo") {
      setLogoFile(file);
      setProfilePhotoUrl(preview);
    } else {
      setBannerFile(file);
      setBannerUrl(preview);
    }

    e.target.value = "";
    setSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError("");
    setSaved(false);

    if (!channelName.trim()) {
      setError("Channel name cannot be empty.");
      return;
    }
    if (!/^[a-z0-9_]{3,30}$/.test(handle.trim())) {
      setError(
        "Handle must be 3–30 characters and can only contain lowercase letters, numbers and underscores."
      );
      return;
    }

    setSaving(true);
    try {
      const basicRes = await fetch(apiUrl("/channel"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channelName: channelName.trim(),
          handle: handle.trim(),
          description: description.trim(),
        }),
      });
      const basicPayload = await basicRes.json().catch(() => ({}));
      if (!basicRes.ok) {
        throw new Error(basicPayload?.message || "Unable to update channel.");
      }

      if (logoFile || bannerFile) {
        const formData = new FormData();
        if (logoFile) formData.append("logo", logoFile);
        if (bannerFile) formData.append("banner", bannerFile);

        const imageRes = await fetch(apiUrl("/channel/images"), {
          method: "PUT",
          body: formData,
          credentials: "include",
        });
        const imagePayload = await imageRes.json().catch(() => ({}));
        if (!imageRes.ok) {
          throw new Error(imagePayload?.message || "Unable to update channel images.");
        }
      }

      // Re-read the authoritative channel record after every successful write.
      const freshRes = await fetch(channelMeApiUrl(), {
        cache: "no-store",
        credentials: "include",
      });
      const freshPayload = await freshRes.json().catch(() => ({}));
      if (!freshRes.ok) {
        throw new Error(freshPayload?.message || "Channel was saved, but could not be refreshed.");
      }

      const fresh = unwrapEnvelope(freshPayload) as any;
      const next = fresh?.channel || fresh;
      setBackendChannel(next);
      setChannelName(next.channelName || "");
      setHandle(next.handle || "");
      setDescription(next.description || "");
      setProfilePhotoUrl(next.logo || null);
      setBannerUrl(next.banner || null);
      setLogoFile(null);
      setBannerFile(null);

      await refreshUser({ announceExpiry: false });
      triggerFeedRefresh();
      setSaved(true);
      showToast("Channel updated", "success");
      router.push(`/channel/${encodeURIComponent(next.handle)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update channel.");
    } finally {
      setSaving(false);
    }
  };


  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Edit channel</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Changes are saved to the database and appear everywhere immediately.
          </p>
        </div>
        <Link
          href="/you"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-300 dark:hover:bg-zinc-700"
        >
          <X className="w-3.5 h-3.5" />
          <span>Cancel</span>
        </Link>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/70 overflow-hidden"
        noValidate
      >
        {/* Banner */}
        <div className="relative h-40 sm:h-52 bg-gradient-to-r from-zinc-900 via-red-950/60 to-zinc-900">
          {bannerUrl ? (
            <img src={bannerUrl} alt="Channel banner" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-500 text-xs uppercase tracking-widest">
              No banner yet
            </div>
          )}
          <input
            ref={bannerInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => handleImageChange(e, "banner")}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => bannerInputRef.current?.click()}
            disabled={saving}
            className="absolute bottom-3 right-3 inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-black/70 hover:bg-black/85 text-white text-xs font-semibold backdrop-blur cursor-pointer disabled:opacity-60"
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Change banner</span>
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Avatar */}
          <div className="flex items-center gap-4 -mt-14">
            <div className="relative">
              <UserAvatar
                name={channelName || user.displayName}
                avatarUrl={profilePhotoUrl}
                size="xl"
                className="ring-4 ring-white dark:ring-zinc-900"
              />
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => handleImageChange(e, "photo")}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={saving}
                aria-label="Change profile picture"
                className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-red-600 hover:bg-red-500 text-white flex items-center justify-center shadow-lg cursor-pointer disabled:opacity-60"
              >
                <ImageIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="pt-10 text-xs text-zinc-500">
              Profile picture • recommended 800×800
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-medium">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {saved && !error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-500 font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Channel saved successfully.</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1.5">
                Channel name
              </label>
              <input
                type="text"
                required
                value={channelName}
                onChange={(e) => {
                  setChannelName(e.target.value);
                  setSaved(false);
                }}
                className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1.5">
                Handle
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">
                  @
                </span>
                <input
                  type="text"
                  required
                  value={handle}
                  onChange={(e) => {
                    setHandle(
                      e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")
                    );
                    setSaved(false);
                  }}
                  className="w-full pl-8 pr-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1.5">
              Description
            </label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setSaved(false);
              }}
              placeholder="Tell viewers what your channel is about..."
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <Link
              href="/you"
              className="px-5 py-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-300 dark:hover:bg-zinc-700"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-medium cursor-pointer"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{saving ? "Saving changes..." : "Save"}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function EditChannelPage() {
  return (
    <ProtectedRoute
      title="Sign in to edit your channel"
      description="Only the channel owner can edit channel details."
    >
      <EditChannelContent />
    </ProtectedRoute>
  );
}

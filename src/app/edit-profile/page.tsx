"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Camera,
  Loader2,
  Save,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { UserAvatar } from "@/components/VideoComponents";
import { apiUrl } from "@/lib/api-config";

const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

function EditProfileContent() {
  const { user, channel, refreshUser, showToast } = useApp();
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName || channel?.channelName || "");
    setUsername(user.username || channel?.handle || "");
    setBio(user.bio || channel?.description || "");
    setAvatarUrl(user.avatarUrl || channel?.profilePhotoUrl || null);
  }, [user, channel]);

  if (!user) return null;

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(apiUrl("/upload"), { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Could not upload photo.");
        return;
      }
      setAvatarUrl(data.url);
      setSaved(false);
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError("");
    setSaved(false);

    if (!displayName.trim()) {
      setError("Name cannot be empty.");
      return;
    }
    if (!HANDLE_RE.test(username.trim())) {
      setError(
        "Handle must be 3–30 characters and can only contain lowercase letters, numbers and underscores."
      );
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/auth", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          username: username.trim(),
          bio: bio.trim(),
          avatarUrl,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setError(data?.error || "Could not save profile.");
        return;
      }
      await refreshUser();
      setSaved(true);
      showToast("Profile saved", "success");
      router.replace("/you");
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto px-3 sm:px-4 py-4 pb-10">
      <div className="flex items-center gap-3 mb-5">
        <Link
          href="/you"
          className="p-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          aria-label="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-lg font-bold">Edit profile</h1>
          <p className="text-xs text-zinc-500">
            Changes save to your account and channel.
          </p>
        </div>
      </div>

      <form
        onSubmit={handleSave}
        className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden"
        noValidate
      >
        <div className="p-5 flex flex-col items-center gap-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="relative">
            <UserAvatar
              name={displayName || user.displayName}
              avatarUrl={avatarUrl}
              size="xl"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadAvatar(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-red-600 hover:bg-red-500 text-white flex items-center justify-center shadow-lg cursor-pointer disabled:opacity-60"
              aria-label="Change profile picture"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Camera className="w-4 h-4" />
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="text-xs font-semibold text-red-500 hover:underline cursor-pointer"
          >
            {uploading ? "Uploading..." : "Change profile picture"}
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-medium">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {saved && !error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-500 font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Profile saved.</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1.5">
              Name
            </label>
            <input
              type="text"
              required
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
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
                value={username}
                onChange={(e) => {
                  setUsername(
                    e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")
                  );
                  setSaved(false);
                }}
                className="w-full pl-8 pr-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1.5">
              Bio
            </label>
            <textarea
              rows={4}
              value={bio}
              onChange={(e) => {
                setBio(e.target.value);
                setSaved(false);
              }}
              placeholder="Tell people a little about yourself"
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
            />
          </div>

          <div className="p-3 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/50 text-xs text-zinc-500">
            <div className="font-semibold text-zinc-700 dark:text-zinc-300 mb-0.5">
              Email
            </div>
            <div className="break-all">{user.email}</div>
            <div className="mt-1">
              Email changes are managed securely from{" "}
              <Link href="/settings" className="text-red-500 font-semibold hover:underline">
                Settings → Security
              </Link>
              .
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <Link
            href="/you"
            className="px-5 py-2.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-200 dark:hover:bg-zinc-700"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving || uploading}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-medium cursor-pointer"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            <span>{saving ? "Saving..." : "Save"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export default function EditProfilePage() {
  return (
    <ProtectedRoute
      title="Sign in to edit your profile"
      description="Profile details belong to your signed-in account."
    >
      <EditProfileContent />
    </ProtectedRoute>
  );
}

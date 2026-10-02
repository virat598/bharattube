"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  Settings as SettingsIcon,
  ShieldCheck,
  Bell,
  Play,
  Palette,
  Database,
  Globe,
  Link2,
  HelpCircle,
  Info,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Sun,
  ChevronRight,
} from "lucide-react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useApp, ThemeMode, Preferences } from "@/context/AppContext";
import { apiFetch } from "@/lib/client";
import { formatCount } from "@/lib/format";
import { channelMeApiUrl } from "@/lib/api-config";
import { adaptChannel } from "@/lib/backend-adapter";

/**
 * Display defaults for settings toggles — the same values the app schema
 * documents. Used ONLY because this backend's /auth/me does not return a
 * preferences object; when the backend supplies one, its real values win.
 */
const DEFAULT_PREFERENCES: Preferences = {
  theme: "light",
  language: "en",
  autoplay: true,
  defaultPlaybackRate: 1,
  captionsByDefault: false,
  historyEnabled: true,
  searchHistoryEnabled: true,
  notifyUploads: true,
  notifyComments: true,
  notifyReplies: true,
  notifyLikes: true,
  notifySubscribers: true,
};

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/70 overflow-hidden">
      <header className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-red-600 shrink-0">
          {icon}
        </div>
        <div>
          <h2 className="text-sm font-bold">{title}</h2>
          {description && (
            <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
          )}
        </div>
      </header>
      <div className="p-5 space-y-5">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  busy,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-xs text-zinc-500 mt-0.5">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full shrink-0 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          checked ? "bg-red-600" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function SettingsContent() {
  const {
    user,
    channel,
    preferences,
    mailProvider,
    theme,
    setTheme,
    updatePreferences,
    logout,
    refreshUser,
    showToast,
  } = useApp();

  const [busyKey, setBusyKey] = useState<string | null>(null);

  /**
   * Real channel stats. The session `channel` object does not carry the
   * backend's `subscribersCount` / `totalVideos` fields, so this card always
   * showed 0. Read them from the existing authenticated GET /channel/me.
   */
  const [channelStats, setChannelStats] = useState<{
    subscribers: number;
    videos: number;
  } | null>(null);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch(channelMeApiUrl(), { cache: "no-store", credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (cancelled || !payload) return;
        const mapped = adaptChannel(payload, { currentUserId: String(user.id) });
        if (mapped) {
          setChannelStats({
            subscribers: mapped.subscriberCount,
            videos: mapped.totalVideos,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);



  // ROOT-CAUSE FIX: `preferences` is null with the deployed backend (its
  // /auth/me response carries no preferences object), and the old guard
  // `if (!user || !preferences) return null` made this whole page render
  // nothing — Settings "did not open". Render with the documented schema
  // defaults instead; real backend values override them whenever present.
  const prefs: Preferences = preferences ?? DEFAULT_PREFERENCES;

  if (!user) return null;

  const setPref = async (key: string, value: boolean | string | number) => {
    setBusyKey(key);
    await updatePreferences({ [key]: value } as any);
    setBusyKey(null);
  };

  const handleResendVerification = async () => {
    setBusyKey("verify");
    try {
      const { ok, data } = await apiFetch("/api/auth", {
        method: "POST",
        body: JSON.stringify({ action: "resend_verification" }),
      });
      if (!ok) {
        showToast(data?.error || "Could not send verification email", "error");
        return;
      }
      if (data.verificationLink) {
        showToast("Email delivery isn't configured — opening your verification link", "info");
        window.open(data.verificationLink, "_blank", "noopener");
      } else {
        showToast(data.message || "Verification email sent", "success");
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleSignOutEverywhere = async () => {
    setBusyKey("logout_all");
    try {
      const { ok } = await apiFetch("/api/auth", {
        method: "POST",
        body: JSON.stringify({ action: "logout_all" }),
      });
      if (ok) {
        showToast("Signed out of all devices", "success");
        await logout();
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearHistory = async () => {
    setBusyKey("clear_history");
    const { ok } = await apiFetch("/api/activity", {
      method: "POST",
      body: JSON.stringify({ action: "clear_watch_history" }),
    });
    setBusyKey(null);
    showToast(ok ? "Watch history cleared" : "Could not clear watch history", ok ? "success" : "error");
  };

  const handleClearSearchHistory = async () => {
    setBusyKey("clear_search");
    const { ok } = await apiFetch("/api/activity", {
      method: "POST",
      body: JSON.stringify({ action: "clear_search_history" }),
    });
    setBusyKey(null);
    showToast(ok ? "Search history cleared" : "Could not clear search history", ok ? "success" : "error");
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-zinc-200/70 dark:bg-zinc-800 flex items-center justify-center text-red-600">
          <SettingsIcon className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-xs text-zinc-500">
            Signed in as {user.email} • @{channel?.handle || user.username}
          </p>
        </div>
      </div>

      {/* ---------------------------- Account ---------------------------- */}
      <Section
        icon={<ShieldCheck className="w-4.5 h-4.5" />}
        title="Account"
        description="Your authentication identity and channel"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div className="p-3 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/60">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">
              Email
            </div>
            <div className="mt-1 break-all">{user.email}</div>
          </div>

          <div className="p-3 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/60">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">
              Channel
            </div>
            <div className="mt-1">{channel?.channelName || user.displayName}</div>
            <div className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">
              {formatCount(
                channelStats?.subscribers ?? channel?.subscriberCount ?? 0,
                "Subscriber",
                "Subscribers"
              )}{" "}
              •{" "}
              {formatCount(channelStats?.videos ?? channel?.videoCount ?? 0, "video", "videos")}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href="/you"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-300 dark:hover:bg-zinc-700"
          >
            Back to You <ChevronRight className="w-3.5 h-3.5" />
          </Link>
          <Link
            href="/edit-profile"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-300 dark:hover:bg-zinc-700"
          >
            Edit profile <ChevronRight className="w-3.5 h-3.5" />
          </Link>
          <Link
            href="/edit-channel"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-300 dark:hover:bg-zinc-700"
          >
            Edit channel <ChevronRight className="w-3.5 h-3.5" />
          </Link>
          <Link
            href={`/channel/${user.id}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 text-xs font-semibold hover:bg-zinc-300 dark:hover:bg-zinc-700"
          >
            View channel <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </Section>

      {/* ---------------------------- Privacy ---------------------------- */}
      <Section
        icon={<Database className="w-4.5 h-4.5" />}
        title="Privacy"
        description="These switches are enforced by the backend, not just the UI"
      >
        <Toggle
          label="Keep watch history"
          description="When off, watched videos and resume positions are not recorded."
          checked={prefs.historyEnabled}
          busy={busyKey === "historyEnabled"}
          onChange={(v) => setPref("historyEnabled", v)}
        />
        <Toggle
          label="Keep search history"
          description="When off, your searches are not stored and suggestions stop using them."
          checked={prefs.searchHistoryEnabled}
          busy={busyKey === "searchHistoryEnabled"}
          onChange={(v) => setPref("searchHistoryEnabled", v)}
        />
      </Section>

      {/* -------------------------- Notifications ------------------------ */}
      <Section
        icon={<Bell className="w-4.5 h-4.5" />}
        title="Notifications"
        description="Choose which events create a notification for your account"
      >
        <Toggle
          label="New uploads from subscribed channels"
          checked={prefs.notifyUploads}
          busy={busyKey === "notifyUploads"}
          onChange={(v) => setPref("notifyUploads", v)}
        />
        <Toggle
          label="Comments on my videos"
          checked={prefs.notifyComments}
          busy={busyKey === "notifyComments"}
          onChange={(v) => setPref("notifyComments", v)}
        />
        <Toggle
          label="Replies to my comments"
          checked={prefs.notifyReplies}
          busy={busyKey === "notifyReplies"}
          onChange={(v) => setPref("notifyReplies", v)}
        />
        <Toggle
          label="Likes on my videos"
          checked={prefs.notifyLikes}
          busy={busyKey === "notifyLikes"}
          onChange={(v) => setPref("notifyLikes", v)}
        />
        <Toggle
          label="New subscribers"
          checked={prefs.notifySubscribers}
          busy={busyKey === "notifySubscribers"}
          onChange={(v) => setPref("notifySubscribers", v)}
        />
      </Section>

      {/* ---------------------------- Playback --------------------------- */}
      <Section
        icon={<Play className="w-4.5 h-4.5" />}
        title="Playback"
        description="Applied every time you open a video"
      >
        <Toggle
          label="Autoplay videos"
          description="Start playback automatically when a watch page opens."
          checked={prefs.autoplay}
          busy={busyKey === "autoplay"}
          onChange={(v) => setPref("autoplay", v)}
        />
        <Toggle
          label="Always show captions"
          description="Turn the built-in caption overlay on by default."
          checked={prefs.captionsByDefault}
          busy={busyKey === "captionsByDefault"}
          onChange={(v) => setPref("captionsByDefault", v)}
        />

        <div>
          <div className="text-sm font-medium">Default playback speed</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => setPref("defaultPlaybackRate", rate)}
                disabled={busyKey === "defaultPlaybackRate"}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                  prefs.defaultPlaybackRate === rate
                    ? "bg-red-600 text-white"
                    : "bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* --------------------------- Appearance -------------------------- */}
      <Section icon={<Palette className="w-4.5 h-4.5" />} title="Appearance">
        <div className="grid grid-cols-3 gap-2 max-w-sm bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl">
          {(
            [
              { id: "light", label: "Light", icon: Sun },
              { id: "dark", label: "Dark", icon: Moon },
              { id: "system", label: "System", icon: Monitor },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTheme(t.id as ThemeMode);
                  setPref("theme", t.id);
                }}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold cursor-pointer ${
                  theme === t.id
                    ? "bg-white dark:bg-zinc-900 text-red-600 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* ------------------------------ Data ----------------------------- */}
      <Section
        icon={<Database className="w-4.5 h-4.5" />}
        title="Data"
        description="Manage the data stored against your account"
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleClearHistory}
            disabled={busyKey === "clear_history"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold cursor-pointer"
          >
            {busyKey === "clear_history" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>Clear watch history</span>
          </button>
          <button
            type="button"
            onClick={handleClearSearchHistory}
            disabled={busyKey === "clear_search"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold cursor-pointer"
          >
            {busyKey === "clear_search" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>Clear search history</span>
          </button>
        </div>
      </Section>

      {/* --------------------------- Language ---------------------------- */}
      <Section icon={<Globe className="w-4.5 h-4.5" />} title="Language">
        <select
          value={prefs.language}
          onChange={(e) => setPref("language", e.target.value)}
          className="px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm max-w-xs w-full"
        >
          <option value="en">English</option>
          <option value="hi">हिन्दी</option>
          <option value="es" disabled>
            Español — not available yet
          </option>
        </select>
      </Section>

      {/* ---------------------- Connected accounts ----------------------- */}
      <Section icon={<Link2 className="w-4.5 h-4.5" />} title="Connected accounts">
        <p className="text-xs text-zinc-500">
          No third-party sign-in providers are connected to this deployment yet, so
          there is nothing to link. This section is intentionally inactive rather
          than showing controls that do nothing.
        </p>
      </Section>

      {/* ------------------------- Help & About -------------------------- */}
      <Section icon={<HelpCircle className="w-4.5 h-4.5" />} title="Help & About">
        <div className="text-xs text-zinc-600 dark:text-zinc-400 space-y-1.5">
          <p className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-zinc-400" />
            BharatTube — video sharing platform.
          </p>
          <p>
            Passwords are hashed with scrypt and never stored or logged in plain
            text. Sessions are server-side rows that expire after 30 days.
          </p>
          <p>
            Account support: contact the server administrator
            {channel?.contactEmail ? ` (${channel.contactEmail})` : ""}.
          </p>
        </div>
      </Section>

      <div className="pb-4">
        <button
          type="button"
          onClick={logout}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border border-zinc-300 dark:border-zinc-700 text-sm font-semibold hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <ProtectedRoute
      title="Sign in to manage settings"
      description="Account, privacy, notification, playback and security settings belong to your signed-in account."
    >
      <SettingsContent />
    </ProtectedRoute>
  );
}

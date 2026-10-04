"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  User as UserIcon,
  ChevronRight,
  Film,
  Flame,
  Radio,
  ListVideo,
  History,
  ThumbsUp,
  Clock,
  Settings,
  LogOut,
  HelpCircle,
  Pencil,
  CheckCircle2,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { UserAvatar } from "@/components/VideoComponents";
import { formatCount } from "@/lib/format";
import { apiUrl, channelApiUrl, channelMeApiUrl } from "@/lib/api-config";
import { adaptChannel, adaptVideos, type AdaptedChannel } from "@/lib/backend-adapter";
import { isVideoLikedByUser } from "@/lib/likes-manager";

/** Compact navigation row used throughout the You hub. */
function YouRow({
  href,
  icon,
  title,
  subtitle,
  onClick,
  danger,
}: {
  href?: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  const className = `w-full flex items-center gap-4 px-4 min-h-[56px] py-2.5 text-left transition-colors cursor-pointer rounded-lg ${
    danger
      ? "hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600"
      : "hover:bg-zinc-100 dark:hover:bg-zinc-800/70 text-zinc-900 dark:text-zinc-100"
  }`;

  const body = (
    <>
      <div
        className={`w-6 h-6 flex items-center justify-center shrink-0 [&_svg]:w-5 [&_svg]:h-5 ${
          danger ? "text-red-600" : "text-zinc-600 dark:text-zinc-300"
        }`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-[15px] font-medium leading-snug ${danger ? "text-red-600" : ""}`}>
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{subtitle}</div>
        )}
      </div>
      <ChevronRight
        className={`w-4 h-4 shrink-0 ${
          danger ? "text-red-400" : "text-zinc-400"
        }`}
      />
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pt-4 first:pt-0">
      <h2 className="px-4 pb-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function YouPage() {
  const { user, channel, logout, showToast, feedRefreshTrigger } = useApp();
  const router = useRouter();
  const [ownChannel, setOwnChannel] = useState<AdaptedChannel | null>(null);
  const [counts, setCounts] = useState({
    videos: 0,
    shorts: 0,
    playlists: 0,
    history: 0,
    liked: 0,
    watchLater: 0,
  });
  const [signingOut, setSigningOut] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  /**
   * True once the channel lookup has finished. Until then the header shows a
   * lightweight placeholder instead of the user's PROFILE name/photo — that
   * personal-profile fallback was what flashed for a second before the real
   * channel resolved.
   */
  const [channelResolved, setChannelResolved] = useState(false);

  const refreshOwnChannel = useCallback(async (): Promise<AdaptedChannel | null> => {
    if (!user) return null;
    const currentUserId = String(user.id);
    const channelRes = await fetch(channelMeApiUrl(), {
      cache: "no-store",
      credentials: "include",
    }).catch(() => null);
    const channelPayload = channelRes?.ok
      ? await channelRes.json().catch(() => null)
      : null;
    let mapped = channelPayload
      ? adaptChannel(channelPayload, { currentUserId })
      : null;

    if (!mapped || mapped.subscriberCount === 0) {
      const ownHandle = String(mapped?.username || channel?.handle || user.username || "")
        .replace(/^@/, "")
        .trim();
      if (ownHandle) {
        const response = await fetch(channelApiUrl(ownHandle), {
          cache: "no-store",
          credentials: "include",
        }).catch(() => null);
        if (response?.ok) {
          const payload = await response.json().catch(() => null);
          const candidate = payload
            ? adaptChannel(payload, { currentUserId })
            : null;
          const belongsToUser =
            Boolean(candidate?.ownerUserId && candidate.ownerUserId === currentUserId) ||
            String(candidate?.username || "").toLowerCase() === ownHandle.toLowerCase();
          if (candidate && belongsToUser && (!mapped || candidate.subscriberCount > mapped.subscriberCount)) {
            mapped = candidate;
          }
        }
      }
    }
    return mapped;
  }, [user, channel?.handle]);

  useEffect(() => {
    const refresh = () => {
      void refreshOwnChannel().then((latest) => {
        if (latest) setOwnChannel(latest);
      });
    };
    window.addEventListener("bharattube:subscription-updated", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("bharattube:subscription-updated", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshOwnChannel]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      try {
        const currentUserId = user?.id != null ? String(user.id) : null;
        const [mappedOwnChannel, histRes, vidsRes, shortsRes, laterRes, plRes] = await Promise.all([
          refreshOwnChannel(),
          fetch(apiUrl("/history"), { cache: "no-store", credentials: "include" }).catch(() => null),
          fetch(apiUrl("/videos?limit=60"), { cache: "no-store", credentials: "include" }),
          fetch(apiUrl("/shorts/feed?limit=40"), { cache: "no-store", credentials: "include" }).catch(() => null),
          fetch(apiUrl("/videos?feed=watch_later"), { cache: "no-store" }),
          fetch(apiUrl("/playlists"), { cache: "no-store" }),
        ]);

        /**
         * Own uploads. The old call, GET /videos?feed=my_videos, could never
         * work: the backend ignores `feed=` (returns every public video) and
         * wraps lists as { data: { videos } }, so `my.videos` was always
         * undefined and both counts stayed 0. The channel's real upload list
         * is GET /channel/:handle/videos (verified: returns that channel's
         * videos and Shorts).
         */
        let ownUploads: Array<{ isShort?: boolean }> = [];
        const ownHandle = String(mappedOwnChannel?.username || channel?.handle || "")
          .replace(/^@/, "")
          .trim();
        if (ownHandle) {
          const uploadsRes = await fetch(
            apiUrl(`/channel/${encodeURIComponent(ownHandle)}/videos`),
            { cache: "no-store", credentials: "include" }
          ).catch(() => null);
          if (uploadsRes?.ok) {
            const uploadsPayload = await uploadsRes.json().catch(() => null);
            const list =
              (Array.isArray(uploadsPayload?.data) && uploadsPayload.data) ||
              uploadsPayload?.data?.videos ||
              uploadsPayload?.videos ||
              (Array.isArray(uploadsPayload) ? uploadsPayload : []);
            ownUploads = Array.isArray(list) ? list : [];
          }
        }
        const hist = histRes?.ok ? await histRes.json() : { history: [] };
        const vidsData = vidsRes.ok ? await vidsRes.json() : { videos: [] };
        const shortsData = shortsRes?.ok ? await shortsRes.json() : { shorts: [] };
        const later = laterRes.ok ? await laterRes.json() : { videos: [] };
        const pl = plRes.ok ? await plRes.json() : { playlists: [] };

        if (cancelled) return;
        setOwnChannel(mappedOwnChannel);

        const allAdapted = [
          ...adaptVideos(vidsData, "videos", { currentUserId }),
          ...adaptVideos(shortsData, "shorts", { currentUserId }),
        ];
        const uniqueIds = new Set<string>();
        let likedCount = 0;
        for (const item of allAdapted) {
          const idStr = String(item.id);
          if (uniqueIds.has(idStr)) continue;
          uniqueIds.add(idStr);
          if (isVideoLikedByUser(item.id, currentUserId, item.rawLikes)) {
            likedCount += 1;
          }
        }

        const histList =
          hist.history ||
          hist.data?.history ||
          (Array.isArray(hist.data) ? hist.data : []);

        const uploadedShorts = ownUploads.filter((v) => Boolean(v?.isShort)).length;
        // If the list is unavailable, fall back to the channel's authoritative
        // totalVideos for the long-form figure rather than showing a wrong 0.
        const uploadedLong =
          ownUploads.length > 0
            ? ownUploads.length - uploadedShorts
            : Math.max(0, Number(mappedOwnChannel?.totalVideos ?? 0));
        setCounts({
          videos: uploadedLong,
          shorts: uploadedShorts,
          playlists: (pl.playlists || []).length,
          history: Array.isArray(histList) ? histList.length : 0,
          liked: likedCount,
          watchLater: (later.videos || []).length,
        });
      } catch {
        /* keep zeros — empty states handle this */
      } finally {
        if (!cancelled) setChannelResolved(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, feedRefreshTrigger, refreshOwnChannel]);

  if (!user) return null;

  /**
   * Channel is "ready" as soon as we have any real channel data, or once the
   * lookup has finished. Until then we DON'T fall back to user.* (the personal
   * profile) — that fallback is exactly what flashed before the channel loaded.
   */
  const hasChannelData = Boolean(ownChannel || channel);
  const channelReady = hasChannelData || channelResolved;
  const displayName = ownChannel?.displayName || channel?.channelName || user.displayName;
  const handle = ownChannel?.username || channel?.handle || user.username;
  const avatarUrl = ownChannel?.avatarUrl || channel?.profilePhotoUrl || user.avatarUrl;
  const subscriberCount =
    ownChannel?.subscriberCount ?? channel?.subscriberCount ?? user.subscriberCount ?? 0;

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      setConfirmSignOut(false);
      router.replace("/");
    } catch {
      showToast("Could not sign out. Please try again.", "error");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-2 sm:px-4 py-4 pb-8">
      {/* ===================== TOP ACCOUNT AREA ===================== */}
      <section className="px-4 pt-2 pb-5 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-4">
          {channelReady ? (
            <>
              <UserAvatar
                name={displayName}
                avatarUrl={avatarUrl}
                size="xl"
                className="!w-16 !h-16 !text-xl"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <h1 className="text-lg sm:text-xl font-semibold truncate text-zinc-900 dark:text-white">
                    {displayName}
                  </h1>
                  {user.isVerified && (
                    <CheckCircle2 className="w-4 h-4 text-zinc-400 shrink-0" />
                  )}
                </div>
                <div className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
                  @{handle} <span className="text-zinc-400">•</span>{" "}
                  <span className="tabular-nums">
                    {formatCount(subscriberCount, "subscriber", "subscribers")}
                  </span>
                </div>
              </div>
            </>
          ) : (
            /* Placeholder while the channel loads — no profile flash */
            <>
              <div className="w-16 h-16 rounded-full bg-zinc-200 dark:bg-zinc-800 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="h-5 w-40 max-w-[60%] rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                <div className="h-4 w-56 max-w-[80%] rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
              </div>
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Link
            href={`/channel/${user.id}`}
            className="flex-1 inline-flex items-center justify-center gap-2 h-10 px-3 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
          >
            <UserIcon className="w-4 h-4" />
            <span>Your channel</span>
          </Link>
          <Link
            href="/edit-channel"
            className="flex-1 inline-flex items-center justify-center gap-2 h-10 px-3 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
          >
            <Pencil className="w-4 h-4" />
            <span>Edit channel</span>
          </Link>
        </div>

      </section>

      {/* ===================== YOUR CONTENT ===================== */}
      <Section title="Your content">
        <YouRow
          href="/my-videos"
          icon={<Film className="w-5 h-5" />}
          title="Your videos"
          subtitle={
            counts.videos === 0
              ? "No videos uploaded yet"
              : `${formatCount(counts.videos)} video${counts.videos === 1 ? "" : "s"}`
          }
        />
        <YouRow
          href="/my-videos?tab=shorts"
          icon={<Flame className="w-5 h-5" />}
          title="Shorts"
          subtitle={
            counts.shorts === 0
              ? "No Shorts yet"
              : `${formatCount(counts.shorts)} Short${counts.shorts === 1 ? "" : "s"}`
          }
        />
        <YouRow
          href={`/channel/${user.id}?tab=Live`}
          icon={<Radio className="w-5 h-5" />}
          title="Live"
          subtitle="Live streams and premieres"
        />
        <YouRow
          href="/playlists"
          icon={<ListVideo className="w-5 h-5" />}
          title="Playlists"
          subtitle={
            counts.playlists === 0
              ? "No playlists yet"
              : `${formatCount(counts.playlists)} playlist${counts.playlists === 1 ? "" : "s"}`
          }
        />
      </Section>

      {/* ===================== LIBRARY ===================== */}
      <Section title="Library">
        <YouRow
          href="/history"
          icon={<History className="w-5 h-5" />}
          title="History"
          subtitle={
            counts.history === 0
              ? "Videos you watch will appear here"
              : `${formatCount(counts.history)} in history`
          }
        />
        <YouRow
          href="/playlists"
          icon={<ListVideo className="w-5 h-5" />}
          title="Playlists"
          subtitle="Created and saved playlists"
        />
        <YouRow
          href="/liked"
          icon={<ThumbsUp className="w-5 h-5" />}
          title="Liked videos"
          subtitle={
            counts.liked === 0
              ? "No liked videos yet"
              : `${formatCount(counts.liked)} liked`
          }
        />
        <YouRow
          href="/watch-later"
          icon={<Clock className="w-5 h-5" />}
          title="Watch later"
          subtitle={
            counts.watchLater === 0
              ? "No videos saved for later"
              : `${formatCount(counts.watchLater)} saved`
          }
        />
      </Section>

      {/* ===================== ACCOUNT ===================== */}
      <Section title="Account">
        <YouRow
          href="/edit-profile"
          icon={<Pencil className="w-5 h-5" />}
          title="Edit profile"
          subtitle="Name, photo, handle and bio"
        />
        <YouRow
          href="/settings"
          icon={<Settings className="w-5 h-5" />}
          title="Settings"
          subtitle="Account, privacy, playback and more"
        />
      </Section>

      {/* ===================== SUPPORT + SIGN OUT ===================== */}
      <Section title="Support">
        <YouRow
          icon={<HelpCircle className="w-5 h-5" />}
          title="Help & feedback"
          subtitle="Contact support"
          onClick={() => {
            window.location.href = "mailto:support@bharattube.app?subject=Help%20%26%20Feedback";
          }}
        />
      </Section>

      <section className="pt-4 mt-2 border-t border-zinc-200 dark:border-zinc-800">
        <YouRow
          icon={<LogOut className="w-5 h-5" />}
          title="Sign out"
          subtitle="End your session on this device"
          danger
          onClick={() => setConfirmSignOut(true)}
        />
      </section>

      {/* Sign-out confirmation */}
      {confirmSignOut && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-lg p-5">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
              Sign out?
            </h3>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
              You will need to sign in again to access your channel, library and
              uploads.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmSignOut(false)}
                disabled={signingOut}
                className="flex-1 h-10 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-sm font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="flex-1 h-10 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-medium cursor-pointer"
              >
                {signingOut ? "Signing out..." : "Sign out"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function YouPageRoute() {
  return (
    <ProtectedRoute
      title="Sign in to view your account"
      description="Your channel, library and settings are private to your signed-in account."
    >
      <YouPage />
    </ProtectedRoute>
  );
}

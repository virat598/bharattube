"use client";

import React, { useState, useEffect, useRef } from "react";
import { recordSearchSignal } from "@/lib/rec-client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Menu,
  Search,
  Bell,
  Plus,
  Home,
  Flame,
  Tv,
  History,
  ListVideo,
  ThumbsUp,
  Clock,
  Film,
  User,
  LogOut,
  Edit3,
  Sun,
  Moon,
  Monitor,
  CheckCheck,
  X,
  Settings,
  ArrowLeft,
} from "lucide-react";
import { useApp, ThemeMode } from "@/context/AppContext";
import { UserAvatar } from "./VideoComponents";
import { BrandLogo } from "./BrandLogo";
import { formatTimeAgo } from "@/lib/format";
import { apiUrl } from "@/lib/api-config";
import { useSearchSuggest } from "@/lib/use-search-suggest";

interface NotificationRecord {
  id: string | number;
  type: string;
  title: string;
  message: string;
  link: string;
  isRead: boolean;
  createdAt: string;
  actor?: {
    id: string | number;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarExpanded } = useApp();
  const pathname = usePathname();

  /** Watch pages get full-bleed video like YouTube — no top navbar, no sidebar. */
  const isWatchPage =
    pathname.startsWith("/watch/") || pathname.startsWith("/shorts");

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-[#0F0F0F] text-zinc-900 dark:text-[#F1F1F1] transition-colors">
      {!isWatchPage && <TopNavbar />}

      <div
        className={`flex flex-1 ${
          isWatchPage ? "" : "pt-14 pb-nav md:pb-0"
        }`}
      >
        {!isWatchPage && <DesktopSidebar />}
        <main
          className={`flex-1 min-w-0 transition-all duration-200 ${
            isWatchPage
              ? ""
              : sidebarExpanded
              ? "md:pl-60"
              : "md:pl-[72px]"
          }`}
        >
          {children}
        </main>
      </div>

      <MobileBottomNav />
    </div>
  );
}

function TopNavbar() {
  const {
    user,
    theme,
    setTheme,
    setSidebarExpanded,
    unreadCount,
    setUnreadCount,
    refreshNotifications,
    hasAccounts,
    openAuthModal,
    logout,
    showToast,
  } = useApp();

  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const {
    history: searchHistory,
    suggestions,
    loading: searchSuggestionsLoading,
    refreshHistory,
    removeHistoryItem: removeSearchHistoryItem,
    clearAllHistory: clearSearchHistoryAll,
  } = useSearchSuggest({ query: searchQuery, userId: user?.id ?? null });

  const [notifOpen, setNotifOpen] = useState(false);
  const [notificationsList, setNotificationsList] = useState<
    NotificationRecord[]
  >([]);
  const [loadingNotifs, setLoadingNotifs] = useState(false);

  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const searchContainerRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        setSearchFocused(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const handleSearchSubmit = async (e?: React.FormEvent, qOverride?: string) => {
    e?.preventDefault();
    const q = (qOverride !== undefined ? qOverride : searchQuery).trim();
    setSearchFocused(false);
    setMobileSearchOpen(false);
    if (!q) return;

    fetch(apiUrl("/activity"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "record_search", query: q }),
    })
      .catch(() => {})
      .finally(() => {
        void refreshHistory();
      });

    // Search intent feeds the personalised Home ranking (point 2/24).
    recordSearchSignal(q);

    setSearchQuery(q);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  };

  const handleOpenMobileSearch = () => {
    setMobileSearchOpen(true);
    void refreshHistory();
    setTimeout(() => {
      mobileSearchInputRef.current?.focus();
    }, 50);
  };

  const handleClearSearchHistory = async () => {
    await clearSearchHistoryAll();
  };

  const normalizeNotificationItem = (raw: any): NotificationRecord => ({
    id: raw?._id ?? raw?.id ?? "",
    type: String(raw?.type ?? "info"),
    title: String(raw?.title ?? "Notification"),
    message: String(raw?.message ?? raw?.content ?? ""),
    link: String(raw?.link ?? "/"),
    isRead: Boolean(
      raw?.isRead ||
        raw?.read ||
        raw?.is_read ||
        raw?.readAt ||
        String(raw?.status || "").toLowerCase() === "read"
    ),
    createdAt: String(raw?.createdAt ?? new Date().toISOString()),
    actor: raw?.actor ?? null,
  });

  const openNotificationCenter = async () => {
    setNotifOpen((o) => !o);
    if (!notifOpen && user) {
      setLoadingNotifs(true);
      try {
        const res = await fetch(apiUrl("/activity?type=notifications"), {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data)
            ? data
            : Array.isArray(data.notifications)
            ? data.notifications
            : Array.isArray(data.data)
            ? data.data
            : [];
          const normalized: NotificationRecord[] = list.map(normalizeNotificationItem);
          const unread = normalized.filter((n) => !n.isRead);
          setNotificationsList(unread);
          setUnreadCount(unread.length);
        }
      } finally {
        setLoadingNotifs(false);
      }
    }
  };

  const markSingleRead = async (id: string | number, link: string) => {
    const previous = notificationsList;
    // Read notifications leave the unread list immediately.
    const next = previous.filter((n) => String(n.id) !== String(id));
    setNotificationsList(next);
    setUnreadCount((count) => Math.max(0, count - 1));

    const res = await fetch("/api/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "mark_notification_read",
        notificationId: id,
      }),
    }).catch(() => null);
    const result = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      // Backend did not record the read — restore the real unread list.
      setNotificationsList(previous);
      showToast(result?.error || "Could not mark notification as read", "error");
      await refreshNotifications();
    } else if (typeof result?.unreadCount === "number") {
      setUnreadCount(result.unreadCount);
    } else {
      await refreshNotifications();
    }

    setNotifOpen(false);
    if (link) router.push(link);
  };

  const markAllRead = async () => {
    const previous = notificationsList;
    setNotificationsList([]);
    setUnreadCount(0);

    const res = await fetch("/api/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_all_notifications_read" }),
    }).catch(() => null);
    const result = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      setNotificationsList(previous);
      showToast(result?.error || "Could not mark notifications as read", "error");
      await refreshNotifications();
      return;
    }
    // Count re-read from the backend after the update — never a local guess.
    setUnreadCount(typeof result?.unreadCount === "number" ? result.unreadCount : 0);
    if (!result || typeof result.unreadCount !== "number") {
      await refreshNotifications();
    }
  };

  return (
    <header className="fixed top-0 inset-x-0 h-14 z-40 bg-white dark:bg-[#0F0F0F] border-b border-zinc-200 dark:border-zinc-800 px-2 sm:px-4 px-safe flex items-center justify-between gap-2 sm:gap-4">
      {/* Left: Hamburger + Brand Logo */}
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        <button
          type="button"
          onClick={() => setSidebarExpanded((prev) => !prev)}
          className="hidden md:inline-flex tap-target items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          aria-label="Toggle navigation sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>

        <Link href="/" className="flex items-center gap-2 pl-1" aria-label="BharatTube home">
          <BrandLogo size={28} className="shrink-0" />
          <span className="font-bold text-lg tracking-tight text-zinc-900 dark:text-white">
            Bharat<span className="text-red-600">Tube</span>
          </span>
        </Link>
      </div>

      {/* Center: Search Bar + Autocomplete & History */}
      <div
        ref={searchContainerRef}
        className="hidden md:block flex-1 max-w-xl mx-2 relative"
      >
        <form
          onSubmit={(e) => handleSearchSubmit(e)}
          className="flex items-center w-full h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus-within:border-zinc-400 dark:focus-within:border-zinc-500 focus-within:bg-white dark:focus-within:bg-zinc-900 overflow-hidden transition-colors"
        >
          <Search className="w-4 h-4 text-zinc-500 ml-4 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onFocus={() => {
              setSearchFocused(true);
              void refreshHistory();
            }}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            className="w-full h-full px-3 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              className="p-2 text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <button
            type="submit"
            aria-label="Search"
            className="h-full px-4 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 border-l border-zinc-200 dark:border-zinc-700 cursor-pointer"
          >
            <Search className="w-4 h-4" />
          </button>
        </form>

        {/* Search Dropdown: Recent searches + live suggestions */}
        {searchFocused && (
          <div className="absolute left-0 right-0 top-11 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-lg py-2 z-50 text-sm max-h-[70vh] overflow-y-auto overscroll-contain">
            {!searchQuery.trim() ? (
              <>
                <div className="flex items-center justify-between px-4 py-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Recent searches
                  </span>
                  {searchHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearSearchHistory}
                      className="text-xs font-medium text-red-600 hover:underline cursor-pointer"
                    >
                      Clear history
                    </button>
                  )}
                </div>

                {searchHistory.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-zinc-500">
                    {user
                      ? "Your recent searches will appear here."
                      : "Sign in to see your recent searches."}
                  </div>
                ) : (
                  searchHistory.map((item) => (
                    <div
                      key={`history-${item}`}
                      className="group flex items-center pr-2"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery(item);
                          handleSearchSubmit(undefined, item);
                        }}
                        className="flex-1 min-w-0 flex items-center gap-3 pl-4 pr-2 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                      >
                        <History className="w-4 h-4 text-zinc-400 shrink-0" />
                        <span className="truncate">{item}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSearchHistoryItem(item)}
                        aria-label={`Remove ${item} from search history`}
                        className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-white cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </>
            ) : (
              <>
                {searchHistory.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                      From your searches
                    </div>
                    {searchHistory.map((item) => (
                      <button
                        key={`match-${item}`}
                        type="button"
                        onClick={() => {
                          setSearchQuery(item);
                          handleSearchSubmit(undefined, item);
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                      >
                        <History className="w-4 h-4 text-zinc-400 shrink-0" />
                        <span className="truncate">{item}</span>
                      </button>
                    ))}
                  </>
                )}

                {searchSuggestionsLoading && suggestions.length === 0 && (
                  <div className="px-4 py-3 text-sm text-zinc-500">
                    Searching…
                  </div>
                )}

                {suggestions.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                      {searchHistory.length > 0 ? "Videos & channels" : "Suggestions"}
                    </div>
                    {suggestions.map((sug) => (
                      <button
                        key={`sug-${sug}`}
                        type="button"
                        onClick={() => {
                          setSearchQuery(sug);
                          handleSearchSubmit(undefined, sug);
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                      >
                        <Search className="w-4 h-4 text-zinc-400 shrink-0" />
                        <span className="truncate">{sug}</span>
                      </button>
                    ))}
                  </>
                )}

                {!searchSuggestionsLoading &&
                  suggestions.length === 0 &&
                  searchHistory.length === 0 && (
                    <div className="px-4 py-6 text-center text-sm text-zinc-500">
                      Press Enter to search for “{searchQuery.trim()}”
                    </div>
                  )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Mobile Full-Width Search Overlay (YouTube-style) */}
      {mobileSearchOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-white dark:bg-[#0F0F0F] flex flex-col">
          <div className="h-14 px-2 flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setMobileSearchOpen(false)}
              aria-label="Close search"
              className="tap-target inline-flex items-center justify-center rounded-full text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200/70 dark:hover:bg-zinc-800"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <form
              onSubmit={(e) => handleSearchSubmit(e)}
              className="flex-1 flex items-center h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus-within:border-zinc-400 dark:focus-within:border-zinc-500 focus-within:bg-white dark:focus-within:bg-zinc-900 overflow-hidden transition-colors"
            >
              <input
                ref={mobileSearchInputRef}
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCapitalize="none"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search BharatTube"
                className="w-full min-w-0 h-full px-4 bg-transparent text-base text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    mobileSearchInputRef.current?.focus();
                  }}
                  aria-label="Clear search query"
                  className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
              <button
                type="submit"
                aria-label="Search"
                className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                <Search className="w-5 h-5" />
              </button>
            </form>
          </div>

          {/* Suggestions sit directly under the field, above the keyboard */}
          <div className="flex-1 overflow-y-auto overscroll-contain pb-nav">
            {!searchQuery.trim() ? (
              <>
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Recent searches
                  </span>
                  {searchHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearSearchHistory}
                      className="text-sm font-medium text-red-600 cursor-pointer"
                    >
                      Clear history
                    </button>
                  )}
                </div>

                {searchHistory.length === 0 ? (
                  <div className="px-6 py-10 text-center text-sm text-zinc-500 leading-relaxed">
                    {user
                      ? "Searches you make will be listed here."
                      : "Sign in to see your recent searches."}
                  </div>
                ) : (
                  searchHistory.map((item) => (
                    <div
                      key={`m-history-${item}`}
                      className="flex items-center pr-2"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery(item);
                          handleSearchSubmit(undefined, item);
                        }}
                        className="flex-1 min-w-0 flex items-center gap-3.5 pl-4 pr-2 h-12 text-left text-base text-zinc-800 dark:text-zinc-200 active:bg-zinc-100 dark:active:bg-zinc-800 cursor-pointer"
                      >
                        <History className="w-5 h-5 text-zinc-400 shrink-0" />
                        <span className="truncate">{item}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSearchHistoryItem(item)}
                        aria-label={`Remove ${item} from search history`}
                        className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-400 active:bg-zinc-100 dark:active:bg-zinc-800 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </>
            ) : (
              <>
                {searchHistory.length > 0 && (
                  <>
                    <div className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      From your searches
                    </div>
                    {searchHistory.map((item) => (
                      <button
                        key={`m-match-${item}`}
                        type="button"
                        onClick={() => {
                          setSearchQuery(item);
                          handleSearchSubmit(undefined, item);
                        }}
                        className="w-full flex items-center gap-3.5 px-4 h-12 text-left text-base text-zinc-800 dark:text-zinc-200 active:bg-zinc-100 dark:active:bg-zinc-800 cursor-pointer"
                      >
                        <History className="w-5 h-5 text-zinc-400 shrink-0" />
                        <span className="truncate">{item}</span>
                      </button>
                    ))}
                  </>
                )}

                {searchSuggestionsLoading && suggestions.length === 0 && (
                  <div className="px-4 py-3 text-sm text-zinc-500">Searching…</div>
                )}

                {suggestions.length > 0 && (
                  <>
                    <div className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      {searchHistory.length > 0 ? "Videos & channels" : "Suggestions"}
                    </div>
                    {suggestions.map((sug) => (
                      <button
                        key={`m-sug-${sug}`}
                        type="button"
                        onClick={() => {
                          setSearchQuery(sug);
                          handleSearchSubmit(undefined, sug);
                        }}
                        className="w-full flex items-center gap-3.5 px-4 h-12 text-left text-base text-zinc-800 dark:text-zinc-200 active:bg-zinc-100 dark:active:bg-zinc-800 cursor-pointer"
                      >
                        <Search className="w-5 h-5 text-zinc-400 shrink-0" />
                        <span className="truncate">{sug}</span>
                      </button>
                    ))}
                  </>
                )}

                {!searchSuggestionsLoading &&
                  suggestions.length === 0 &&
                  searchHistory.length === 0 && (
                    <div className="px-6 py-10 text-center text-sm text-zinc-500 leading-relaxed">
                      Tap search to look for “{searchQuery.trim()}”
                    </div>
                  )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Right: Search (mobile) + Upload + Notifications + User Menu */}
      <div className="flex items-center gap-0.5 sm:gap-2 shrink-0">
        <button
          type="button"
          onClick={handleOpenMobileSearch}
          aria-label="Search"
          className="md:hidden tap-target inline-flex items-center justify-center rounded-full text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <Search className="w-5 h-5" />
        </button>

        {/* Notification Center */}
        <div ref={notifRef} className="relative">
          <button
            type="button"
            onClick={openNotificationCenter}
            aria-label={
              unreadCount > 0
                ? `Notifications, ${unreadCount} unread`
                : "Notifications"
            }
            aria-expanded={notifOpen}
            className="relative tap-target inline-flex items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center ring-2 ring-white dark:ring-[#0F0F0F]">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="fixed sm:absolute left-2 right-2 sm:left-auto sm:right-0 top-16 sm:top-12 w-auto sm:w-96 max-w-[calc(100vw-1rem)] rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-lg overflow-hidden z-50">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
                <span className="font-semibold text-sm">Notifications</span>
                {(unreadCount > 0 || notificationsList.some((n) => !n.isRead)) && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    className="inline-flex items-center gap-1.5 text-xs text-red-600 hover:underline font-medium cursor-pointer"
                  >
                    <CheckCheck className="w-4 h-4" />
                    <span>Mark all as read</span>
                  </button>
                )}
              </div>

              <div className="max-h-[70vh] sm:max-h-96 overflow-y-auto overscroll-contain divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                {!user ? (
                  <div className="p-8 text-center text-xs text-zinc-500">
                    Sign in to view your notifications.
                  </div>
                ) : loadingNotifs ? (
                  <div className="p-8 text-center text-xs text-zinc-500">
                    Loading notifications...
                  </div>
                ) : notificationsList.length === 0 ? (
                  <div className="py-12 px-6 text-center">
                    <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                      <Bell className="w-6 h-6 text-zinc-500" />
                    </div>
                    <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                      No notifications yet
                    </div>
                    <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                      New uploads, comments and likes will show up here.
                    </p>
                  </div>
                ) : (
                  notificationsList.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => markSingleRead(n.id, n.link)}
                      className={`w-full flex items-start gap-3 p-3.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/80 transition-colors cursor-pointer ${
                        !n.isRead ? "bg-red-500/5" : ""
                      }`}
                    >
                      <UserAvatar
                        name={n.actor?.displayName || "A"}
                        avatarUrl={n.actor?.avatarUrl}
                        size="sm"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                          {n.title}
                        </div>
                        <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-2 mt-0.5">
                          {n.message}
                        </p>
                        <div className="text-[11px] text-zinc-400 mt-1">
                          {formatTimeAgo(n.createdAt)}
                        </div>
                      </div>
                      {!n.isRead && (
                        <span className="w-2 h-2 rounded-full bg-red-600 mt-1.5 shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* User Profile / Sign-in Button */}
        {user ? (
          <div ref={userMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen((o) => !o)}
              aria-label="Account menu"
              aria-expanded={userMenuOpen}
              className="tap-target flex items-center justify-center rounded-full cursor-pointer"
            >
              <UserAvatar
                name={user.displayName}
                avatarUrl={user.avatarUrl}
                size="sm"
              />
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-12 w-64 max-w-[calc(100vw-1rem)] max-h-[75vh] overflow-y-auto overscroll-contain rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-lg py-2 z-50 text-sm">
                <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
                  <UserAvatar
                    name={user.displayName}
                    avatarUrl={user.avatarUrl}
                    size="md"
                  />
                  <div className="min-w-0">
                    <div className="font-bold truncate text-zinc-900 dark:text-white">
                      {user.displayName}
                    </div>
                    <div className="text-xs text-zinc-500 truncate">
                      @{user.username}
                    </div>
                  </div>
                </div>

                <div className="py-1">
                  <Link
                    href={`/channel/${user.id}`}
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
                  >
                    <User className="w-4 h-4 text-zinc-400" />
                    <span>Your Channel</span>
                  </Link>
                  <Link
                    href="/you"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
                  >
                    <User className="w-4 h-4 text-zinc-400" />
                    <span>You</span>
                  </Link>
                  <Link
                    href="/edit-channel"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
                  >
                    <Edit3 className="w-4 h-4 text-zinc-400" />
                    <span>Edit channel</span>
                  </Link>
                  <Link
                    href="/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
                  >
                    <Settings className="w-4 h-4 text-zinc-400" />
                    <span>Settings</span>
                  </Link>
                  <Link
                    href="/my-videos"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
                  >
                    <Film className="w-4 h-4 text-zinc-400" />
                    <span>Your videos</span>
                  </Link>
                </div>

                {/* Theme Mode Switcher */}
                <div className="px-4 py-2.5 border-t border-zinc-200 dark:border-zinc-800">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                    Appearance ({theme})
                  </div>
                  <div className="grid grid-cols-3 gap-1 bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl">
                    {[
                      { id: "light", label: "Light", icon: Sun },
                      { id: "dark", label: "Dark", icon: Moon },
                      { id: "system", label: "System", icon: Monitor },
                    ].map((t) => {
                      const Icon = t.icon;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTheme(t.id as ThemeMode)}
                          className={`flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
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
                </div>

                <div className="border-t border-zinc-200 dark:border-zinc-800 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setUserMenuOpen(false);
                      logout();
                    }}
                    className="w-full flex items-center gap-3 px-4 py-2 text-left text-red-500 hover:bg-red-500/10 cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openAuthModal()}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm font-medium transition-colors cursor-pointer"
          >
            <User className="w-4 h-4" />
            <span>{hasAccounts ? "Sign in" : "Create account"}</span>
          </button>
        )}
      </div>
    </header>
  );
}

function DesktopSidebar() {
  const pathname = usePathname();
  const { sidebarExpanded } = useApp();

  const primaryLinks = [
    { href: "/", label: "Home", icon: Home },
    { href: "/shorts", label: "Shorts", icon: Flame },
    { href: "/subscriptions", label: "Subscriptions", icon: Tv },
  ];

  const libraryLinks = [
    { href: "/you", label: "You", icon: User },
    { href: "/history", label: "History", icon: History },
    { href: "/playlists", label: "Playlists", icon: ListVideo },
    { href: "/liked", label: "Liked videos", icon: ThumbsUp },
    { href: "/watch-later", label: "Watch Later", icon: Clock },
    { href: "/my-videos", label: "Your videos", icon: Film },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  if (!sidebarExpanded) {
    return (
      <aside className="hidden md:flex flex-col items-center fixed top-14 left-0 bottom-0 w-[72px] bg-white dark:bg-[#0F0F0F] py-2 gap-1 z-30">
        {[...primaryLinks, { href: "/you", label: "You", icon: User }].map(
          (item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center justify-center w-16 py-3 rounded-lg text-[10px] gap-1.5 transition-colors ${
                  active
                    ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/70"
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="truncate max-w-full px-1">{item.label}</span>
              </Link>
            );
          }
        )}
      </aside>
    );
  }

  return (
    <aside className="hidden md:flex flex-col fixed top-14 left-0 bottom-0 w-60 bg-white dark:bg-[#0F0F0F] px-3 py-3 overflow-y-auto z-30">
      <div className="space-y-0.5">
        {primaryLinks.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-4 h-10 px-3 rounded-lg text-sm transition-colors ${
                active
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium"
                  : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/70"
              }`}
            >
              <Icon
                className={`w-5 h-5 ${
                  active ? "text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-zinc-400"
                }`}
              />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="my-3 border-t border-zinc-200 dark:border-zinc-800" />

      <div className="px-3 py-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Library
      </div>
      <div className="space-y-0.5 mt-0.5">
        {libraryLinks.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-4 h-10 px-3 rounded-lg text-sm transition-colors ${
                active
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium"
                  : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/70"
              }`}
            >
              <Icon
                className={`w-5 h-5 ${
                  active ? "text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-zinc-400"
                }`}
              />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}

function MobileBottomNav() {
  const pathname = usePathname();
  const { openUploadModal } = useApp();

  const items = [
    { href: "/", label: "Home", icon: Home, match: (p: string) => p === "/" },
    {
      href: "/shorts",
      label: "Shorts",
      icon: Flame,
      match: (p: string) => p.startsWith("/shorts"),
    },
    {
      href: "/subscriptions",
      label: "Subscriptions",
      icon: Tv,
      match: (p: string) => p.startsWith("/subscriptions"),
    },
    {
      href: "/you",
      label: "You",
      icon: User,
      // Library screens are reached from You, so keep the tab lit there too.
      match: (p: string) =>
        ["/you", "/history", "/liked", "/watch-later", "/playlists", "/my-videos", "/settings", "/edit-profile", "/edit-channel"].some(
          (r) => p === r || p.startsWith(`${r}/`)
        ),
    },
  ];

  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-[#0F0F0F] border-t border-zinc-200 dark:border-zinc-800 pb-safe px-safe"
    >
      <div className="h-14 flex items-stretch justify-around">
        {items.slice(0, 2).map((item) => (
          <NavTab key={item.href} item={item} pathname={pathname} />
        ))}

        <button
          type="button"
          onClick={openUploadModal}
          aria-label="Create — upload a video"
          className="flex flex-col items-center justify-center gap-1 flex-1 min-w-0 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 cursor-pointer"
        >
          <span className="w-9 h-9 -mt-1 rounded-full bg-red-600 text-white flex items-center justify-center">
            <Plus className="w-5 h-5" />
          </span>
          <span className="truncate">Create</span>
        </button>

        {items.slice(2).map((item) => (
          <NavTab key={item.href} item={item} pathname={pathname} />
        ))}
      </div>
    </nav>
  );
}

function NavTab({
  item,
  pathname,
}: {
  item: {
    href: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    match: (p: string) => boolean;
  };
  pathname: string;
}) {
  const Icon = item.icon;
  const active = item.match(pathname);
  return (
    <Link
      href={item.href}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={`flex flex-col items-center justify-center gap-1 flex-1 min-w-0 text-[11px] font-medium transition-colors ${
        active
          ? "text-red-600"
          : "text-zinc-600 dark:text-zinc-400"
      }`}
    >
      <Icon className={`w-5 h-5 shrink-0 ${active ? "stroke-[2.25]" : ""}`} />
      <span className="truncate max-w-full px-0.5">{item.label}</span>
    </Link>
  );
}

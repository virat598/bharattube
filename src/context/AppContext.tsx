"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  UNAUTHORIZED_EVENT,
  installAuthFetchInterceptor,
  saveSessionToken,
  clearSessionToken,
  getSessionToken,
  saveSessionSnapshot,
  loadSessionSnapshot,
} from "@/lib/client";
import {
  USE_EXTERNAL_BACKEND,
  authEndpoints,
  normalizeMeResponse,
  describeOAuthError,
  apiUrl,
} from "@/lib/api-config";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface UserProfile {
  /** Numeric in the built-in backend; may be a string/UUID with an external backend. */
  id: number | string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  isVerified: boolean;
  emailVerified: boolean;
  subscriberCount: number;
  createdAt: string;
  updatedAt?: string;
}

export interface ChannelProfile {
  channelId: string | number;
  ownerUserId: string | number;
  channelName: string;
  handle: string;
  profilePhotoUrl: string | null;
  bannerUrl: string | null;
  description: string;
  links: { label: string; url: string }[];
  contactEmail: string | null;
  subscriberCount: number;
  videoCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Preferences {
  theme: string;
  language: string;
  autoplay: boolean;
  defaultPlaybackRate: number;
  captionsByDefault: boolean;
  historyEnabled: boolean;
  searchHistoryEnabled: boolean;
  notifyUploads: boolean;
  notifyComments: boolean;
  notifyReplies: boolean;
  notifyLikes: boolean;
  notifySubscribers: boolean;
}

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";
export type ThemeMode = "dark" | "light" | "system";

interface SessionPayload {
  user?: UserProfile | null;
  channel?: ChannelProfile | null;
  preferences?: Preferences | null;
  token?: string | null;
}

interface AppContextType {
  /* auth */
  authStatus: AuthStatus;
  loadingAuth: boolean;
  user: UserProfile | null;
  channel: ChannelProfile | null;
  preferences: Preferences | null;
  hasAccounts: boolean;
  mailProvider: string;
  refreshUser: (opts?: { announceExpiry?: boolean }) => Promise<void>;
  applySessionUser: (payload: SessionPayload) => void;
  updatePreferences: (patch: Partial<Preferences>) => Promise<boolean>;
  logout: () => Promise<void>;
  signOut: () => Promise<void>;
  ensureSignedIn: (message?: string) => boolean;

  /* ui */
  theme: ThemeMode;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: ThemeMode) => void;
  sidebarExpanded: boolean;
  setSidebarExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  unreadCount: number;
  setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
  refreshNotifications: () => Promise<void>;

  /* modals */
  authModalOpen: boolean;
  authModalInitialTab: "login" | "signup";
  openAuthModal: (tab?: "login" | "signup") => void;
  closeAuthModal: () => void;
  uploadModalOpen: boolean;
  openUploadModal: () => void;
  closeUploadModal: () => void;
  playlistModalVideoId: string | number | null;
  openPlaylistModal: (videoId: string | number) => void;
  closePlaylistModal: () => void;

  /* feed */
  feedRefreshTrigger: number;
  triggerFeedRefresh: () => void;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<UserProfile | null>(null);
  const [channel, setChannel] = useState<ChannelProfile | null>(null);
  /**
   * Always starts as `null` so the server render and the first client render
   * match exactly. Stored preferences are read in the effect below — reading
   * them inside the state initializer causes a hydration mismatch, which
   * React reports as "Something went wrong".
   */
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [hasAccounts, setHasAccounts] = useState(true);
  const [mailProvider, setMailProvider] = useState("none");

  const [theme, setThemeState] = useState<ThemeMode>("light");
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("light");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalInitialTab, setAuthModalInitialTab] = useState<"login" | "signup">("login");
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [playlistModalVideoId, setPlaylistModalVideoId] = useState<string | number | null>(null);
  const [feedRefreshTrigger, setFeedRefreshTrigger] = useState(0);

  /**
   * Restores stored preferences on mount (client only, after hydration) and
   * persists every subsequent change so settings survive page reloads.
   *
   * `hydratedPrefsRef` marks the initial restore so we never wipe the stored
   * value before it has been read.
   */
  const hydratedPrefsRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hydratedPrefsRef.current) {
      hydratedPrefsRef.current = true;
      try {
        const raw = localStorage.getItem("bharattube_preferences");
        const stored = raw ? JSON.parse(raw) : null;
        if (stored && typeof stored === "object") {
          setPreferences(stored as Preferences);
        }
      } catch {
        /* corrupt storage — fall through with defaults */
      }
      return;
    }
    if (preferences) {
      localStorage.setItem("bharattube_preferences", JSON.stringify(preferences));
    } else {
      localStorage.removeItem("bharattube_preferences");
    }
  }, [preferences]);

  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);

  const hadSessionRef = useRef(false);
  const themeSyncedRef = useRef(false);

  const showToast = useCallback(
    (message: string, type: "success" | "error" | "info" = "info") => {
      setToast({ message, type });
      setTimeout(() => {
        setToast((prev) => (prev?.message === message ? null : prev));
      }, 3600);
    },
    []
  );

  /* ------------------------- theme handling ------------------------- */

  useEffect(() => {
    const hasExplicitChoice =
      localStorage.getItem("bharattube_theme_explicit") === "1";
    const saved = localStorage.getItem("bharattube_theme") as ThemeMode | null;

    // Older builds persisted their dark default as though it were a user
    // preference. Only retain a stored theme when the user explicitly picked it.
    if (hasExplicitChoice && saved && ["dark", "light", "system"].includes(saved)) {
      setThemeState(saved);
    } else {
      localStorage.setItem("bharattube_theme", "light");
      localStorage.removeItem("aether_theme");
    }
  }, []);

  useEffect(() => {
    const applyTheme = (mode: ThemeMode) => {
      const effective: "dark" | "light" =
        mode === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : mode;

      setResolvedTheme(effective);
      const root = document.documentElement;
      root.classList.toggle("dark", effective === "dark");
      root.classList.toggle("light", effective !== "dark");
    };

    applyTheme(theme);
    localStorage.setItem("bharattube_theme", theme);
  }, [theme]);

  const setTheme = useCallback((newTheme: ThemeMode) => {
    try {
      localStorage.setItem("bharattube_theme_explicit", "1");
      localStorage.setItem("bharattube_theme", newTheme);
    } catch {
      /* storage can be disabled in a private browsing context */
    }
    setThemeState(newTheme);
  }, []);

  /* ------------------------- session loading ------------------------ */

  const applySession = useCallback((payload: SessionPayload) => {
    if (payload.token) saveSessionToken(payload.token);
    hadSessionRef.current = true;
    setHasAccounts(true);
    setUser(payload.user ?? null);
    setChannel(payload.channel ?? null);
    // Preserve locally stored preferences — the backend does not supply them.
    setPreferences((prev) => prev ?? payload.preferences ?? null);
    setAuthStatus("authenticated");
    setAuthModalOpen(false);
    // Durable snapshot — survives remounts / soft navigations in the iframe.
    if (payload.user) {
      saveSessionSnapshot({
        user: payload.user,
        channel: payload.channel ?? null,
        preferences: payload.preferences ?? null,
        token: payload.token || getSessionToken(),
      });
    }
  }, []);

  const clearSession = useCallback(() => {
    hadSessionRef.current = false;
    setUser(null);
    setChannel(null);
    setPreferences(null);
    setUnreadCount(0);
    setAuthStatus("unauthenticated");
    clearSessionToken();
  }, []);

  const refreshUser = useCallback(
    async (opts?: { announceExpiry?: boolean }) => {
      try {
        // Always re-seed the interceptor before reading the session so a token
        // that was just saved is attached to this request.
        installAuthFetchInterceptor();

        /* External backend (Express /api/v1): read session via /auth/me. */
        if (USE_EXTERNAL_BACKEND) {
          if (typeof window !== "undefined") {
            const urlParams = new URLSearchParams(window.location.search);
            const qToken =
              urlParams.get("token") ||
              urlParams.get("accessToken") ||
              urlParams.get("access_token") ||
              urlParams.get("jwt") ||
              urlParams.get("authToken");
            if (qToken) {
              saveSessionToken(qToken);
              urlParams.delete("token");
              urlParams.delete("accessToken");
              urlParams.delete("access_token");
              urlParams.delete("jwt");
              urlParams.delete("authToken");
              const cleanSearch = urlParams.toString();
              const cleanUrl =
                window.location.pathname +
                (cleanSearch ? `?${cleanSearch}` : "") +
                window.location.hash;
              window.history.replaceState(null, "", cleanUrl);
            }
            const qError =
              urlParams.get("error") ||
              urlParams.get("google_error") ||
              urlParams.get("errorCode");
            if (qError) {
              showToast(describeOAuthError(urlParams), "error");
              urlParams.delete("error");
              urlParams.delete("google_error");
              urlParams.delete("errorCode");
              const cleanSearch = urlParams.toString();
              const cleanUrl =
                window.location.pathname +
                (cleanSearch ? `?${cleanSearch}` : "") +
                window.location.hash;
              window.history.replaceState(null, "", cleanUrl);
            }
          }

          // Timeout so a cold/slow backend never hangs app boot — the app
          // proceeds as guest and the retry effect re-confirms the session.
          const authController = new AbortController();
          const authTimer = setTimeout(() => authController.abort(), 10000);
          let extRes: Response;
          try {
            extRes = await fetch(authEndpoints.me, {
              cache: "no-store",
              credentials: "include",
              signal: authController.signal,
            });
          } finally {
            clearTimeout(authTimer);
          }
          if (extRes.status === 401) {
            const wasSignedIn = hadSessionRef.current;
            clearSession();
            if (wasSignedIn && opts?.announceExpiry) {
              showToast("Your session expired. Please sign in again.", "info");
            } else if (!wasSignedIn) {
              setAuthStatus("unauthenticated");
            }
            return;
          }
          if (!extRes.ok) return; // transient error: keep current state

          const payload = await extRes.json();
          const normalized = normalizeMeResponse(payload);
          if (!normalized?.user) {
            setAuthStatus((prev) =>
              prev === "loading" ? "unauthenticated" : prev
            );
            return;
          }
          if (normalized.token) saveSessionToken(normalized.token);

          hadSessionRef.current = true;
          setUser(normalized.user);
          setChannel(null);
          setPreferences(null);
          setAuthStatus("authenticated");
          saveSessionSnapshot({
            user: normalized.user,
            channel: null,
            preferences: null,
            token: normalized.token || getSessionToken(),
          });
          return;
        }

        const res = await fetch("/api/auth", {
          cache: "no-store",
          credentials: "include",
        });
        // A server hiccup must never silently sign the user out.
        if (!res.ok) return;

        const data = await res.json();
        if (typeof data?.hasAccounts === "boolean") setHasAccounts(data.hasAccounts);
        if (typeof data?.mailProvider === "string") setMailProvider(data.mailProvider);

        if (data?.authenticated && data?.user) {
          if (data.token) saveSessionToken(data.token);

          hadSessionRef.current = true;
          setUser(data.user);
          setChannel(data.channel ?? null);
          // The backend has no preferences endpoint, so `data.preferences` is
          // always absent here. Overwriting with null used to throw away
          // whatever the viewer had just switched in Settings, which is why
          // the toggles looked broken. Keep the stored/local value instead.
          setPreferences((prev) => prev ?? data.preferences ?? null);
          setAuthStatus("authenticated");
          saveSessionSnapshot({
            user: data.user,
            channel: data.channel ?? null,
            preferences: data.preferences ?? null,
            token: data.token || getSessionToken(),
          });

          if (!themeSyncedRef.current && data.preferences?.theme) {
            themeSyncedRef.current = true;
            const t = data.preferences.theme;
            if (t === "dark" || t === "light" || t === "system") {
              try {
                localStorage.setItem("bharattube_theme_explicit", "1");
                localStorage.setItem("bharattube_theme", t);
              } catch {
                /* ignore storage errors */
              }
              setThemeState(t);
            }
          }
          return;
        }

        // Only clear when the server EXPLICITLY says the session is gone, or
        // a protected call returned 401 (announceExpiry). Never wipe a just-
        // applied login because a parallel boot refresh raced the token write.
        const wasSignedIn = hadSessionRef.current;
        const tokenStillPresent = Boolean(getSessionToken());
        if (opts?.announceExpiry || data?.sessionExpired) {
          clearSession();
          if (wasSignedIn) {
            showToast(
              data?.sessionExpired
                ? "Your session expired. Please sign in again."
                : "You have been signed out.",
              "info"
            );
          }
        } else if (!wasSignedIn && !tokenStillPresent) {
          setAuthStatus("unauthenticated");
        }
        // else: keep the current signed-in UI; a later refresh will confirm.
      } catch {
        // Network failure: keep whatever state we already have.
        setAuthStatus((prev) => (prev === "loading" ? "unauthenticated" : prev));
      }
    },
    [clearSession, showToast]
  );

  /* Any 401 from the API means the session is no longer valid. */
  useEffect(() => {
    const onUnauthorized = () => refreshUser({ announceExpiry: true });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refreshUser]);

  const refreshNotifications = useCallback(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(apiUrl("/activity?type=notifications"), {
        cache: "no-store",
        signal: controller.signal,
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

        const unread = list.filter(
          (n: { isRead?: boolean; read?: boolean }) => !n.isRead && !n.read
        ).length;
        setUnreadCount(unread);
      }
    } catch {
      /* ignore */
    } finally {
      clearTimeout(timer);
    }
  }, []);

  // Boot: restore any durable snapshot immediately so Sign In → You never
  // flashes the lock screen, then confirm with the server.
  useEffect(() => {
    installAuthFetchInterceptor();

    const snap = loadSessionSnapshot();
    if (snap?.user) {
      hadSessionRef.current = true;
      setHasAccounts(true);
      setUser(snap.user);
      setChannel(snap.channel ?? null);
      // Snapshot may carry a stale/null preferences object; localStorage is the
      // more recent source, so only fill in when nothing is loaded yet.
      setPreferences((prev) => prev ?? snap.preferences ?? null);
      setAuthStatus("authenticated");
    }

    refreshUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One gentle retry only if we still have no session after boot.
  useEffect(() => {
    if (authStatus !== "unauthenticated") return;
    const t = setTimeout(() => refreshUser(), 800);
    return () => clearTimeout(t);
  }, [authStatus, refreshUser]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      setUnreadCount(0);
      return;
    }
    void refreshNotifications();
    // Poll the backend so genuinely new notifications increase the badge.
    const interval = setInterval(() => {
      void refreshNotifications();
    }, 30_000);
    return () => clearInterval(interval);
  }, [authStatus, refreshNotifications]);

  /* --------------------------- auth actions -------------------------- */

  const applySessionUser = useCallback(
    (payload: SessionPayload) => applySession(payload),
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      if (USE_EXTERNAL_BACKEND) {
        await fetch(authEndpoints.logout, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
      } else {
        await fetch("/api/auth", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "logout" }),
        });
      }
    } catch {
      /* even if the request fails, the local session must end */
    }
    clearSessionToken();
    clearSession();
    showToast("Signed out of your account", "info");
  }, [clearSession, showToast]);

  const ensureSignedIn = useCallback(
    (message = "Please sign in to continue.") => {
      if (authStatus === "authenticated" && user) return true;
      setAuthModalInitialTab(hasAccounts ? "login" : "signup");
      setAuthModalOpen(true);
      showToast(message, "info");
      return false;
    },
    [authStatus, user, hasAccounts, showToast]
  );

  const updatePreferences = useCallback(
    async (patch: Partial<Preferences>) => {
      if (authStatus !== "authenticated") return false;

      // Optimistic local update, rolled back if the server rejects it.
      const previous = preferences;
      setPreferences((prev) => (prev ? { ...prev, ...patch } : prev));
      if (patch.theme === "dark" || patch.theme === "light" || patch.theme === "system") {
        setThemeState(patch.theme);
      }

      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update_preferences", preferences: patch }),
        });
        const data = await res.json();
        if (!res.ok) {
          setPreferences(previous);
          showToast(data?.error || "Could not save setting", "error");
          return false;
        }
        // The route echoes the patch back. Merge it over the existing prefs so
        // the stored object always holds every key, not just the one just
        // changed — a partial object would leave later reads undefined.
        setPreferences((prev) => ({ ...(previous ?? {}), ...(prev ?? {}), ...patch }) as Preferences);
        return true;
      } catch {
        setPreferences(previous);
        showToast("Unable to connect. Please try again.", "error");
        return false;
      }
    },
    [authStatus, preferences, showToast]
  );

  /* ------------------------------ modals ----------------------------- */

  const openAuthModal = useCallback(
    (tab?: "login" | "signup") => {
      setAuthModalInitialTab(tab ?? (hasAccounts ? "login" : "signup"));
      setAuthModalOpen(true);
    },
    [hasAccounts]
  );

  const closeAuthModal = useCallback(() => setAuthModalOpen(false), []);

  const openUploadModal = useCallback(() => {
    if (authStatus !== "authenticated") {
      openAuthModal();
      showToast("Sign in to upload and publish videos", "info");
      return;
    }
    setUploadModalOpen(true);
  }, [authStatus, openAuthModal, showToast]);

  const closeUploadModal = useCallback(() => setUploadModalOpen(false), []);

  const openPlaylistModal = useCallback(
    (videoId: string | number) => {
      if (authStatus !== "authenticated") {
        openAuthModal();
        showToast("Sign in to save videos to playlists", "info");
        return;
      }
      setPlaylistModalVideoId(videoId);
    },
    [authStatus, openAuthModal, showToast]
  );

  const closePlaylistModal = useCallback(() => setPlaylistModalVideoId(null), []);

  const triggerFeedRefresh = useCallback(
    () => setFeedRefreshTrigger((c) => c + 1),
    []
  );

  return (
    <AppContext.Provider
      value={{
        authStatus,
        loadingAuth: authStatus === "loading",
        user,
        channel,
        preferences,
        hasAccounts,
        mailProvider,
        refreshUser,
        applySessionUser,
        updatePreferences,
        logout,
        signOut: logout,
        ensureSignedIn,
        theme,
        resolvedTheme,
        setTheme,
        sidebarExpanded,
        setSidebarExpanded,
        unreadCount,
        setUnreadCount,
        refreshNotifications,
        authModalOpen,
        authModalInitialTab,
        openAuthModal,
        closeAuthModal,
        uploadModalOpen,
        openUploadModal,
        closeUploadModal,
        playlistModalVideoId,
        openPlaylistModal,
        closePlaylistModal,
        feedRefreshTrigger,
        triggerFeedRefresh,
        showToast,
      }}
    >
      {children}
      {toast && (
        <div className="fixed bottom-20 md:bottom-6 right-6 z-[100] flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-medium bg-zinc-900 text-white border-zinc-700/80">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              toast.type === "error"
                ? "bg-red-500"
                : toast.type === "success"
                ? "bg-emerald-500"
                : "bg-sky-500"
            }`}
          />
          <span>{toast.message}</span>
        </div>
      )}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

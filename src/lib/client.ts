export const UNAUTHORIZED_EVENT = "aether:unauthorized";

/**
 * Primary token key expected by the deployed BharatTube backend.
 * Google OAuth callback stores exactly: localStorage.setItem("bharattube_token", token)
 * and the API client reads localStorage.getItem("bharattube_token") and sends
 * Authorization: Bearer <token>.
 */
export const PRIMARY_SESSION_TOKEN_KEY = "bharattube_token";

export const SESSION_TOKEN_KEY = "bharattube_session_token";
export const LEGACY_SESSION_TOKEN_KEY = "aether_session_token";
export const SESSION_COOKIE_NAME = "bharattube_session_client";
export const LEGACY_SESSION_COOKIE_NAME = "aether_session_client";
export const SESSION_SNAPSHOT_KEY = "bharattube_session_snapshot";
export const LEGACY_SESSION_SNAPSHOT_KEY = "aether_session_snapshot";

import { EXTERNAL_API_BASE } from "./api-config";

/* ------------------------------------------------------------------ */
/* Session token storage                                               */
/* ------------------------------------------------------------------ */

/**
 * Survivability order for the bearer token (preview iframes block cookies
 * and sometimes localStorage):
 *   1. In-memory (current JS heap)
 *   2. sessionStorage (survives soft reloads / SPA remounts in the same tab)
 *   3. localStorage (survives full browser restarts when allowed)
 *   4. A non-HttpOnly same-site cookie written from JS (survives full page
 *      reloads even when storage APIs throw)
 */
let memoryToken: string | null = null;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  try {
    const match = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function writeCookie(name: string, value: string, maxAgeSeconds: number) {
  if (typeof document === "undefined") return;
  try {
    const secure =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "; Secure"
        : "";
    // SameSite=None is required inside a cross-site preview iframe; Lax is fine
    // for first-party / local HTTP.
    const sameSite =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "None"
        : "Lax";
    document.cookie = `${name}=${encodeURIComponent(
      value
    )}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=${sameSite}${secure}`;
  } catch {
    /* ignore */
  }
}

function clearCookie(name: string) {
  if (typeof document === "undefined") return;
  try {
    const secure =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "; Secure"
        : "";
    const sameSite =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "None"
        : "Lax";
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=${sameSite}${secure}`;
  } catch {
    /* ignore */
  }
}

const ALL_TOKEN_KEYS = [
  PRIMARY_SESSION_TOKEN_KEY,
  SESSION_TOKEN_KEY,
  LEGACY_SESSION_TOKEN_KEY,
];

function readFromStorage(store: Storage | undefined): string | null {
  if (!store) return null;
  try {
    for (const key of ALL_TOKEN_KEYS) {
      const value = store.getItem(key);
      if (value) return value;
    }
    return null;
  } catch {
    return null;
  }
}

function writeToStorage(store: Storage | undefined, value: string) {
  if (!store) return;
  try {
    // Primary key required by the backend and OAuth callback
    store.setItem(PRIMARY_SESSION_TOKEN_KEY, value);
    // Backwards-compatible keys
    store.setItem(SESSION_TOKEN_KEY, value);
  } catch {
    /* ignore */
  }
}

function removeFromStorage(store: Storage | undefined) {
  if (!store) return;
  try {
    for (const key of ALL_TOKEN_KEYS) {
      store.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

export function getSessionToken(): string | null {
  if (memoryToken) return memoryToken;
  if (typeof window === "undefined") return null;

  const fromSession =
    readFromStorage(window.sessionStorage) ||
    (() => {
      try {
        return window.sessionStorage.getItem(LEGACY_SESSION_TOKEN_KEY);
      } catch {
        return null;
      }
    })();
  if (fromSession) {
    memoryToken = fromSession;
    return fromSession;
  }

  const fromLocal =
    readFromStorage(window.localStorage) ||
    (() => {
      try {
        return window.localStorage.getItem(LEGACY_SESSION_TOKEN_KEY);
      } catch {
        return null;
      }
    })();
  if (fromLocal) {
    memoryToken = fromLocal;
    return fromLocal;
  }

  const fromCookie =
    readCookie(SESSION_COOKIE_NAME) || readCookie(LEGACY_SESSION_COOKIE_NAME);
  if (fromCookie) {
    memoryToken = fromCookie;
    return fromCookie;
  }

  return null;
}

export function saveSessionToken(token?: string | null): void {
  if (!token) return;
  memoryToken = token;
  if (typeof window === "undefined") return;

  writeToStorage(window.sessionStorage, token);
  writeToStorage(window.localStorage, token);
  // 30 days — matches the server session TTL.
  writeCookie(SESSION_COOKIE_NAME, token, 30 * 24 * 60 * 60);
}

export function clearSessionToken(): void {
  memoryToken = null;
  if (typeof window === "undefined") return;
  removeFromStorage(window.sessionStorage);
  removeFromStorage(window.localStorage);
  try {
    window.sessionStorage.removeItem(LEGACY_SESSION_TOKEN_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_TOKEN_KEY);
  } catch {
    /* ignore */
  }
  clearCookie(SESSION_COOKIE_NAME);
  clearCookie(LEGACY_SESSION_COOKIE_NAME);
  try {
    window.sessionStorage.removeItem(SESSION_SNAPSHOT_KEY);
    window.localStorage.removeItem(SESSION_SNAPSHOT_KEY);
    window.sessionStorage.removeItem(LEGACY_SESSION_SNAPSHOT_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

/** Full session snapshot so a remount/navigation never loses the signed-in user. */
export function saveSessionSnapshot(snapshot: {
  user: unknown;
  channel: unknown;
  preferences: unknown;
  token?: string | null;
}): void {
  if (typeof window === "undefined") return;
  if (snapshot.token) saveSessionToken(snapshot.token);
  const payload = JSON.stringify({
    user: snapshot.user,
    channel: snapshot.channel,
    preferences: snapshot.preferences,
    token: snapshot.token || getSessionToken(),
    savedAt: Date.now(),
  });
  try {
    window.sessionStorage.setItem(SESSION_SNAPSHOT_KEY, payload);
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.setItem(SESSION_SNAPSHOT_KEY, payload);
  } catch {
    /* ignore */
  }
}

export function loadSessionSnapshot(): {
  user: any;
  channel: any;
  preferences: any;
  token: string | null;
} | null {
  if (typeof window === "undefined") return null;
  const raw =
    (() => {
      try {
        return (
          window.sessionStorage.getItem(SESSION_SNAPSHOT_KEY) ||
          window.sessionStorage.getItem(LEGACY_SESSION_SNAPSHOT_KEY)
        );
      } catch {
        return null;
      }
    })() ||
    (() => {
      try {
        return (
          window.localStorage.getItem(SESSION_SNAPSHOT_KEY) ||
          window.localStorage.getItem(LEGACY_SESSION_SNAPSHOT_KEY)
        );
      } catch {
        return null;
      }
    })();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data?.user?.id) return null;
    // Snapshots older than 30 days are ignored.
    if (data.savedAt && Date.now() - data.savedAt > 30 * 24 * 60 * 60 * 1000) {
      return null;
    }
    if (data.token) saveSessionToken(data.token);
    return {
      user: data.user,
      channel: data.channel ?? null,
      preferences: data.preferences ?? null,
      token: data.token || getSessionToken(),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Global fetch interceptor                                            */
/* ------------------------------------------------------------------ */

let interceptorInstalled = false;

/**
 * Attaches `Authorization: Bearer <session>` to every same-origin /api request.
 * Must be installed synchronously before the first session read so a just-saved
 * token is never lost to a race with the boot-time GET /api/auth.
 */
export function installAuthFetchInterceptor(): void {
  if (typeof window === "undefined" || interceptorInstalled) return;
  interceptorInstalled = true;

  // Seed memory from durable storage the moment the interceptor is installed,
  // before any request fires.
  getSessionToken();

  const originalFetch = window.fetch.bind(window);

  // External backend base (e.g. https://bharattube-...onrender.com/api/v1)
  const externalBase = (
    EXTERNAL_API_BASE ||
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.VITE_API_URL ||
    "https://bharattube-ylmq.onrender.com/api/v1"
  ).replace(/\/+$/, "");

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const token = getSessionToken();
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url;

      // Attach auth to our own /api routes AND to the configured external
      // backend, so cross-origin JWT auth works for every request.
      const isSameOriginApi =
        url.startsWith("/api/") ||
        url.startsWith(`${window.location.origin}/api/`);
      const isExternalApi = externalBase && url.startsWith(externalBase);

      if ((isSameOriginApi || isExternalApi) && token) {
        const merged = new Headers(
          init?.headers ??
            (typeof input !== "string" && !(input instanceof URL)
              ? input.headers
              : undefined)
        );
        if (!merged.has("authorization")) {
          merged.set("authorization", `Bearer ${token}`);
        }
        // credentials:"include" lets a cookie-session backend also work; a
        // JWT-header backend simply ignores it.
        init = { ...(init ?? {}), headers: merged, credentials: "include" };
      }
    } catch {
      /* never break the request because of the interceptor */
    }

    return originalFetch(input as RequestInfo | URL, init);
  };
}

/* Install as soon as this module is evaluated on the client. */
if (typeof window !== "undefined") {
  installAuthFetchInterceptor();
}

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */

export async function apiFetch<T = any>(
  url: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: T }> {
  // Guarantee the interceptor is live even if this helper is called before
  // React mounts the AppProvider.
  installAuthFetchInterceptor();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
    credentials: "include",
  });

  if (res.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }

  return { ok: res.ok, status: res.status, data };
}

export async function authRequest(
  action: "signup" | "login" | "logout",
  payload: Record<string, unknown> = {}
) {
  return apiFetch<{
    success?: boolean;
    authenticated?: boolean;
    user?: any;
    channel?: any;
    preferences?: any;
    token?: string;
    error?: string;
    message?: string;
    emailVerificationLink?: string;
    resetLink?: string;
    verificationLink?: string;
    mailDelivered?: boolean;
  }>("/api/auth", {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  });
}

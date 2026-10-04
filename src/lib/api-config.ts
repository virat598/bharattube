"use client";

/**
 * ─────────────────────────────────────────────────────────────────────
 * SINGLE FRONTEND API BASE CONFIGURATION
 * ─────────────────────────────────────────────────────────────────────
 *
 * BharatTube ships as a Next.js app with same-origin API routes under
 * `/api/...`. It can also be pointed at an EXTERNAL backend (for example a
 * Node/Express API) by setting ONE public environment variable:
 *
 *   NEXT_PUBLIC_API_URL=http://localhost:5000/api/v1
 *
 *   (In a Vite project this same value is `VITE_API_URL`. Only the variable
 *    prefix differs; the base URL and every path are identical.)
 *
 * No other file should hard-code a host. Everything auth-related is built
 * from this base so the same UI works against:
 *   - the built-in same-origin backend (default), or
 *   - the external Express backend's auth contract.
 *
 * External Express auth contract used here:
 *   GET  {BASE}/auth/google           -> starts Google OAuth (full redirect)
 *   GET  {BASE}/auth/google/callback  -> handled entirely by the backend
 *   GET  {BASE}/auth/me               -> current session user (cookie)
 *   POST {BASE}/auth/login
 *   POST {BASE}/auth/logout
 *
 * All authenticated calls use `credentials: "include"` so the existing
 * session cookie established by the backend is sent.
 */

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * External API base, e.g. http://localhost:5000/api/v1 (empty = built-in).
 * Accepts the Next public var and — for parity with a Vite frontend — the
 * VITE_API_URL name too, so the same value works in either project.
 */
export const EXTERNAL_API_BASE: string = trimTrailingSlash(
  process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.VITE_API_URL ||
    "https://bharattube-ylmq.onrender.com/api/v1"
);

/** True when an external backend is configured (default true for BharatTube). */
export const USE_EXTERNAL_BACKEND = Boolean(
  EXTERNAL_API_BASE && /^https?:\/\//i.test(EXTERNAL_API_BASE)
);

export const IS_DEV_LOCAL =
  typeof window !== "undefined" &&
  /^http:\/\/(localhost|127\.0\.0\.1)/i.test(EXTERNAL_API_BASE);

/**
 * Authentication endpoints.
 * With an external base these match the Express contract (/auth/google,
 * /auth/me, /auth/logout). Without one they map to the built-in same-origin
 * routes (/api/auth/google, /api/auth).
 */
export const authEndpoints = {
  /**
   * Starts the backend's Google OAuth. This is a real top-level navigation to
   * the backend, which then redirects to its own configured frontend.
   */
  google: USE_EXTERNAL_BACKEND
    ? `${EXTERNAL_API_BASE}/auth/google`
    : "/api/auth/google",

  /** The backend completes OAuth here (server-side; no frontend logic). */
  googleCallback: USE_EXTERNAL_BACKEND
    ? `${EXTERNAL_API_BASE}/auth/google/callback`
    : "/api/auth/google/callback",

  /** Current authenticated user ("me"). Proxy-aware. */
  me: USE_EXTERNAL_BACKEND ? `${EXTERNAL_API_BASE}/auth/me` : "/api/auth",

  logout: USE_EXTERNAL_BACKEND ? `${EXTERNAL_API_BASE}/auth/logout` : "/api/auth",

  login: USE_EXTERNAL_BACKEND ? `${EXTERNAL_API_BASE}/auth/login` : "/api/auth",

  /**
   * Email/password account creation on the external backend.
   * Different Express projects name this differently, so the client tries
   * these in order until one is not a 404.
   */
  registerCandidates: USE_EXTERNAL_BACKEND
    ? [
        `${EXTERNAL_API_BASE}/auth/register`,
        `${EXTERNAL_API_BASE}/auth/signup`,
        `${EXTERNAL_API_BASE}/auth/sign-up`,
        `${EXTERNAL_API_BASE}/users/register`,
        `${EXTERNAL_API_BASE}/users`,
      ]
    : ["/api/auth"],
} as const;

/** Resolve backend media fields without changing absolute CDN/data/blob URLs. */
export function mediaUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const raw = value.trim();
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;

  try {
    const api = new URL(EXTERNAL_API_BASE);
    return new URL(raw.startsWith("/") ? raw : `/${raw}`, api.origin).toString();
  } catch {
    return raw;
  }
}

/**
 * Build a URL for any backend resource path (e.g. "/videos", "/comments").
 * With an external backend it becomes `${BASE}${path}`; otherwise the
 * built-in same-origin `/api${path}` route is used.
 */
export function apiUrl(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (!USE_EXTERNAL_BACKEND) {
    return `/api${clean}`;
  }

  // Map legacy activity queries directly to real backend endpoints
  if (clean.startsWith("/activity?type=notifications")) {
    // Same-origin proxy normalises backend notification envelopes/read flags.
    return `/api${clean}`;
  }
  if (clean.startsWith("/activity?type=search")) {
    try {
      const parsed = new URL(clean, "http://dummy");
      const q = parsed.searchParams.get("q") || "";
      return q
        ? `${EXTERNAL_API_BASE}/search?q=${encodeURIComponent(q)}`
        : `${EXTERNAL_API_BASE}/search`;
    } catch {
      return `${EXTERNAL_API_BASE}/search`;
    }
  }
  if (clean === "/activity" || clean.startsWith("/activity?")) {
    // Route to same-origin /api/activity which safely delegates without Postgres
    return `/api${clean}`;
  }

  return `${EXTERNAL_API_BASE}${clean}`;
}

/**
 * Candidate video-upload endpoints on the external backend. Express projects
 * name this route differently; the client tries each (skipping 404s) so we
 * connect to whichever the existing backend actually exposes — never invented.
 * FormData is posted with credentials; Content-Type is left to the browser.
 */
/** The connected MongoDB/Express backend has one canonical video creation endpoint. */
export const videoUploadCandidates: string[] = USE_EXTERNAL_BACKEND
  ? [`${EXTERNAL_API_BASE}/videos`]
  : ["/api/upload"];

/**
 * Unwrap a list from any of the envelope shapes the deployed backend uses.
 *
 * The production backend replies as:
 *   { success, statusCode, message, data: { videos: [...] } }
 * while some routes return a flat array or { videos: [...] }.
 * This keeps every page working against the real API without duplicating
 * shape-sniffing logic, and never fabricates data (always returns [] if absent).
 */
export function unwrapList<T = unknown>(payload: unknown, key: string): T[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object"
    ? (root.data as Record<string, unknown>)
    : null) as Record<string, unknown> | null;

  const candidates = [
    root[key],
    data ? data[key] : undefined,
    root.data,
    root.items,
    root.results,
    payload,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c as T[];
  }
  return [];
}

/** True when the backend answered "route not found" (missing endpoint). */
export function isMissingRoute(status: number, payload?: unknown): boolean {
  if (status !== 404) return false;
  const msg =
    payload && typeof payload === "object"
      ? String((payload as Record<string, unknown>).message || "")
      : "";
  return msg.includes("not found") || status === 404;
}

/**
 * True only when the backend replied that the ROUTE does not exist
 * ("Route '/api/v1/x' not found"), as opposed to a resource 404
 * ("Video not found"). Used to distinguish a missing feature from missing data.
 */
export function isRouteNotFound(payload: unknown): boolean {
  const msg =
    payload && typeof payload === "object"
      ? String((payload as Record<string, unknown>).message || "")
      : "";
  return /route '.*' not found/i.test(msg);
}

/**
 * Channel URL for the deployed backend.
 *
 * VERIFIED: the backend exposes `GET /channel/:handle` (singular, keyed by the
 * channel HANDLE). There is no `/channels` collection route, and an ObjectId
 * returns "Channel not found". So we always address a channel by its handle.
 */
export function channelApiUrl(handleOrId: string): string {
  const key = encodeURIComponent(String(handleOrId || "").trim());
  return `${EXTERNAL_API_BASE}/channel/${key}`;
}

/** The connected backend uses POST /subscriptions/:channelId for subscribe/unsubscribe. */
export function subscribeApiUrl(channelId: string | number): string {
  const key = encodeURIComponent(String(channelId ?? "").trim());
  return `${EXTERNAL_API_BASE}/subscriptions/${key}`;
}

/**
 * Authenticated "my channel" lookup — VERIFIED to exist on the backend
 * (GET /channel/me returns 401 "No Token Provided" without auth).
 *
 * Needed because the backend resolves channels only by HANDLE, while "Your
 * Channel" links are built from the signed-in user's id. The channel page
 * resolves that id through this endpoint to obtain the real handle.
 */
export function channelMeApiUrl(): string {
  return USE_EXTERNAL_BACKEND ? `${EXTERNAL_API_BASE}/channel/me` : "/api/channels/me";
}

/**
 * Google login must start by redirecting the user to:
 * https://bharattube-ylmq.onrender.com/api/v1/auth/google
 *
 * The frontend does NOT append any incorrect callback URL or query parameters.
 * The backend manages the Google OAuth client and redirect URI directly.
 */
export function googleLoginUrl(): string {
  return authEndpoints.google;
}

/**
 * Normalise the many shapes a "/me" style endpoint can return into the
 * BharatTube user object the existing auth context expects.
 * Never invents metrics — optional fields are left for the UI to derive.
 */
export interface NormalizedMe {
  user: {
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
    updatedAt: string;
  };
  token?: string | null;
  raw: unknown;
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
function pickNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

export function normalizeMeResponse(payload: unknown): NormalizedMe | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;

  // Unwrap common envelopes: { data: { user } }, { user }, { data: {...} }
  const candidate: Record<string, unknown> =
    (root.user && typeof root.user === "object"
      ? (root.user as Record<string, unknown>)
      : root.data && typeof root.data === "object"
      ? ((root.data as Record<string, unknown>).user &&
        typeof (root.data as Record<string, unknown>).user === "object"
          ? ((root.data as Record<string, unknown>).user as Record<string, unknown>)
          : (root.data as Record<string, unknown>))
      : root) as Record<string, unknown>;

  const id =
    pickNumber(candidate.id, candidate._id, candidate.userId, root.id) ??
    (typeof candidate._id === "string" ? candidate._id : 0);

  const email = pickString(candidate.email, candidate.emailAddress)?.toLowerCase();
  if (!email) return null;

  const displayName =
    pickString(
      candidate.displayName,
      candidate.fullName,
      candidate.name,
      candidate.channelName,
      candidate.username,
      email.split("@")[0]
    ) || email.split("@")[0];

  const username = pickString(
    candidate.username,
    candidate.handle,
    candidate.slug,
    candidate.channelHandle,
    email.split("@")[0]
  )
    .replace(/^@/, "")
    .replace(/\s+/g, "");

  const avatarUrl =
    pickString(
      candidate.avatarUrl,
      candidate.avatar,
      candidate.profilePicture,
      candidate.picture,
      candidate.image
    ) || null;

  const bannerUrl =
    pickString(candidate.bannerUrl, candidate.banner, candidate.coverImage) ||
    null;
  const bio = pickString(candidate.bio, candidate.description, candidate.about);

  const dataEnvelope =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : {};
  const token =
    pickString(
      root.token,
      (root as { accessToken?: unknown }).accessToken,
      (root as { access_token?: unknown }).access_token,
      dataEnvelope.token,
      (dataEnvelope as { accessToken?: unknown }).accessToken,
      candidate.token,
      (candidate as { accessToken?: unknown }).accessToken
    ) || null;

  return {
    user: {
      id,
      email,
      username,
      displayName,
      avatarUrl,
      bannerUrl: bannerUrl || null,
      bio: bio || "",
      isVerified: Boolean(
        candidate.isVerified ?? candidate.verified ?? candidate.emailVerified
      ),
      emailVerified: Boolean(candidate.emailVerified ?? candidate.verified),
      subscriberCount: pickNumber(candidate.subscriberCount, candidate.subscribers) ?? 0,
      createdAt:
        (candidate.createdAt as string) ||
        (candidate.created_at as string) ||
        new Date().toISOString(),
      updatedAt:
        (candidate.updatedAt as string) ||
        (candidate.updated_at as string) ||
        new Date().toISOString(),
    },
    token,
    raw: payload,
  };
}

/** Map OAuth error/cancel query params (Google + common backends) to friendly text. */
export function describeOAuthError(searchParams: URLSearchParams): string {
  const error = (
    searchParams.get("error") ||
    searchParams.get("google_error") ||
    searchParams.get("errorCode") ||
    ""
  ).toLowerCase();

  if (
    error === "access_denied" ||
    error === "cancelled" ||
    error === "cancel" ||
    searchParams.get("cancelled") !== null ||
    searchParams.get("cancelledByUser") !== null
  ) {
    return "Google sign-in was cancelled. You can try again whenever you're ready.";
  }
  if (error === "state_mismatch" || error === "invalid_state" || error === "oauthstate") {
    return "Google sign-in could not be verified. Please try again.";
  }
  if (error.includes("network") || error === "network_error") {
    return "We couldn't reach the authentication server. Check your connection and try again.";
  }
  if (error.includes("session") || error.includes("unauthorized") || error === "unauthorized") {
    return "We couldn't establish your session after Google sign-in. Please try again.";
  }
  if (error) {
    return "Google sign-in failed. Please try again or use your email and password.";
  }
  return "We couldn't complete Google sign-in. Please try again.";
}

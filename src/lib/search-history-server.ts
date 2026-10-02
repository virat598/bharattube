/**
 * Server-only helpers for the existing BharatTube Render backend.
 * This module only proxies the production API.
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

const MAX_QUERY_LENGTH = 120;

export type AuthedHeaders = { Authorization?: string; Cookie?: string };

export function buildAuthHeaders(
  authorization: string | null,
  cookie: string | null
): AuthedHeaders {
  const headers: AuthedHeaders = {};
  if (authorization) headers.Authorization = authorization;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export async function resolveUserKey(
  headers: AuthedHeaders
): Promise<string | null> {
  if (!headers.Authorization && !headers.Cookie) return null;
  try {
    const res = await fetch(`${BACKEND_BASE}/auth/me`, {
      headers: headers as Record<string, string>,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const data = payload?.data ?? payload;
    const user = data?.user ?? data;
    const id = pickString(user?._id, user?.id, user?.userId);
    if (id) return `u:${id}`;
    const fallback = pickString(user?.email, user?.username, user?.handle);
    return fallback ? `a:${fallback.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

export function normalizeQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

function historyList(payload: any): string[] {
  const list = Array.isArray(payload?.searchHistory)
    ? payload.searchHistory
    : Array.isArray(payload?.data?.searchHistory)
    ? payload.data.searchHistory
    : Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
    ? payload
    : [];
  return list
    .map((item: any) =>
      normalizeQuery(typeof item === "string" ? item : item?.query ?? item?.search)
    )
    .filter(Boolean);
}

async function historyRequest(
  headers: AuthedHeaders,
  init?: RequestInit,
  query = ""
): Promise<Response | null> {
  try {
    return await fetch(
      `${BACKEND_BASE}/search-history${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      {
        ...init,
        headers: {
          ...(init?.headers || {}),
          ...headers,
        },
        cache: "no-store",
      }
    );
  } catch {
    return null;
  }
}

/** Uses the existing backend endpoint when present; otherwise returns empty. */
export async function listSearchHistory(
  headers: AuthedHeaders,
  limit = 12
): Promise<string[]> {
  const res = await historyRequest(headers);
  if (!res?.ok) return [];
  const payload = await res.json().catch(() => ({}));
  return historyList(payload).slice(0, limit);
}

export async function matchSearchHistory(
  headers: AuthedHeaders,
  query: string,
  limit = 6
): Promise<string[]> {
  const res = await historyRequest(headers, undefined, query);
  if (!res?.ok) return [];
  const payload = await res.json().catch(() => ({}));
  const q = query.toLowerCase();
  return historyList(payload)
    .filter((item) => item.toLowerCase().includes(q))
    .slice(0, limit);
}

export async function recordSearchQuery(
  headers: AuthedHeaders,
  query: string
): Promise<void> {
  await historyRequest(headers, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

export async function removeSearchQuery(
  headers: AuthedHeaders,
  query: string
): Promise<void> {
  await historyRequest(headers, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

export async function clearSearchHistory(headers: AuthedHeaders): Promise<void> {
  await historyRequest(headers, { method: "DELETE" });
}

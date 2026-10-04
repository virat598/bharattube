import { NextRequest, NextResponse } from "next/server";
import {
  buildAuthHeaders,
  clearSearchHistory,
  listSearchHistory,
  matchSearchHistory,
  normalizeQuery,
  recordSearchQuery,
  removeSearchQuery,
  resolveUserKey,
} from "@/lib/search-history-server";

export const dynamic = "force-dynamic";

/**
 * Route handler for /api/activity.
 *
 * This route safely proxies activity calls to BharatTube's existing deployed
 * Node + Express + MongoDB backend. It does not initialize local storage.
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

/** Accepts every list envelope the backend uses for notifications. */
function extractNotificationList(data: any): Record<string, unknown>[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.notifications)) return data.notifications;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.notifications)) return data.data.notifications;
  return [];
}

function normalizeNotification(n: Record<string, unknown>) {
  return {
    ...n,
    id: n.id ?? n._id ?? "",
    isRead: Boolean(
      n.isRead ||
        n.read ||
        n.is_read ||
        n.readAt ||
        String(n.status || "").toLowerCase() === "read"
    ),
  };
}

/** Re-reads the backend so the returned unread count is authoritative. */
async function fetchNotifications(headers: HeadersInit) {
  const res = await fetch(`${BACKEND_BASE}/notifications`, {
    headers,
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return { ok: false as const, status: res?.status || 502, list: [] };
  const data = await res.json().catch(() => ({}));
  return {
    ok: true as const,
    status: 200,
    list: extractNotificationList(data).map(normalizeNotification),
  };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") || "notifications";
    const authHeader = req.headers.get("authorization") || "";
    const cookieHeader = req.headers.get("cookie") || "";

    const headers = buildAuthHeaders(authHeader, cookieHeader);

    if (type === "notifications") {
      try {
        const res = await fetch(`${BACKEND_BASE}/notifications`, {
          headers,
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          const notifications = extractNotificationList(data).map(normalizeNotification);
          // Always derive the badge from the same records rendered in the list.
          // This prevents a stale backend aggregate from counting read items.
          const unreadCount = notifications.filter(
            (n: { isRead: boolean }) => !n.isRead
          ).length;
          return NextResponse.json({ notifications, unreadCount });
        }
      } catch {
        // Backend offline or error
      }
      return NextResponse.json({ notifications: [], unreadCount: 0 });
    }

    if (type === "search") {
      const q = normalizeQuery(searchParams.get("q"));

      // Search history belongs to the signed-in account only.
      const userKey = await resolveUserKey(headers);

      // No query yet -> return this user's recent searches immediately so the
      // search screen is useful before a single character is typed.
      if (!q) {
        const searchHistory = userKey ? await listSearchHistory(headers) : [];
        return NextResponse.json({
          videos: [],
          channels: [],
          playlists: [],
          searchHistory,
          suggestions: [],
        });
      }

      // Live suggestions from the real BharatTube backend.
      let videos: Record<string, unknown>[] = [];
      let channels: Record<string, unknown>[] = [];
      let playlists: Record<string, unknown>[] = [];

      try {
        const res = await fetch(`${BACKEND_BASE}/search?q=${encodeURIComponent(q)}`, {
          headers,
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          videos = Array.isArray(data?.videos)
            ? data.videos
            : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data)
            ? data
            : [];
          channels = Array.isArray(data?.channels) ? data.channels : [];
          playlists = Array.isArray(data?.playlists) ? data.playlists : [];
        }
      } catch {
        // Backend offline — history matches still returned below.
      }

      // Suggestion strings are derived ONLY from real data: existing video
      // titles, channel names and the user's own previous searches.
      const fromVideos = videos
        .map((v) => normalizeQuery(v?.title ?? v?.name))
        .filter(Boolean);
      const fromChannels = channels
        .map((c) =>
          normalizeQuery(c?.channelName ?? c?.name ?? c?.handle ?? c?.username)
        )
        .filter(Boolean);

      const searchHistory = userKey ? await matchSearchHistory(headers, q) : [];

      const suggestions: string[] = [];
      const seen = new Set<string>();
      for (const item of [...fromVideos, ...fromChannels]) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push(item);
        if (suggestions.length >= 8) break;
      }

      return NextResponse.json({
        videos,
        channels,
        playlists,
        searchHistory,
        suggestions,
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("GET /api/activity error:", err);
    return NextResponse.json({ notifications: [], unreadCount: 0 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      // Empty or invalid body
    }

    const action = String(body.action || "");
    const authHeader = req.headers.get("authorization") || "";
    const cookieHeader = req.headers.get("cookie") || "";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildAuthHeaders(authHeader, cookieHeader),
    };

    if (action === "clear_watch_history") {
      try {
        await fetch(`${BACKEND_BASE}/history`, {
          method: "DELETE",
          headers,
        });
      } catch {
        // Safe fallback
      }
      return NextResponse.json({ success: true });
    }

    if (action === "remove_history_item") {
      const videoId = body.videoId;
      if (videoId) {
        try {
          await fetch(`${BACKEND_BASE}/history/${videoId}`, {
            method: "DELETE",
            headers,
          });
        } catch {
          // Safe fallback
        }
      }
      return NextResponse.json({ success: true });
    }

    /**
     * Mark all as read.
     *
     * The backend exposes only PATCH /notifications/:id (verified: any
     * /notifications/<x> PATCH is auth-gated, /notifications/:id/read is 404).
     * The old code PATCHed "/notifications/read", which the backend treats as
     * a notification id — so it failed and the badge came back. We now mark
     * every real unread notification through the verified per-id route and
     * then re-read the backend so the returned count is authoritative.
     */
    if (action === "mark_all_notifications_read") {
      const current = await fetchNotifications(headers);
      if (!current.ok) {
        return NextResponse.json(
          {
            error:
              current.status === 401
                ? "Your session has expired. Please sign in again."
                : "Could not load notifications",
          },
          { status: current.status }
        );
      }
      const unreadIds = current.list
        .filter((n) => !n.isRead && n.id)
        .map((n) => String(n.id));

      const results = await Promise.all(
        unreadIds.map((nid) =>
          fetch(`${BACKEND_BASE}/notifications/${encodeURIComponent(nid)}`, {
            method: "PATCH",
            headers,
          })
            .then((r) => r.ok)
            .catch(() => false)
        )
      );
      const failed = results.filter((ok) => !ok).length;

      const after = await fetchNotifications(headers);
      const unreadCount = after.ok
        ? after.list.filter((n) => !n.isRead).length
        : failed;

      if (failed > 0 && unreadCount > 0) {
        return NextResponse.json(
          {
            error: `${failed} notification(s) could not be marked as read`,
            unreadCount,
          },
          { status: 502 }
        );
      }
      return NextResponse.json({ success: true, unreadCount });
    }

    if (action === "mark_notification_read") {
      const notifId = body.notificationId;
      if (!notifId) {
        return NextResponse.json({ error: "Notification id is required" }, { status: 400 });
      }
      const readRes = await fetch(
        `${BACKEND_BASE}/notifications/${encodeURIComponent(String(notifId))}`,
        { method: "PATCH", headers }
      ).catch(() => null);
      if (!readRes?.ok) {
        const payload = await readRes?.json().catch(() => ({}));
        return NextResponse.json(
          { error: payload?.message || payload?.error || "Could not mark notification as read" },
          { status: readRes?.status || 502 }
        );
      }
      const after = await fetchNotifications(headers);
      return NextResponse.json({
        success: true,
        unreadCount: after.ok ? after.list.filter((n) => !n.isRead).length : null,
      });
    }

    // Per-user search history persistence.
    if (action === "record_search") {
      const query = normalizeQuery(body.query);
      if (query) {
        const userKey = await resolveUserKey(headers);
        if (userKey) await recordSearchQuery(headers, query);
      }
      return NextResponse.json({ success: true });
    }

    if (action === "remove_search_history") {
      const query = normalizeQuery(body.query);
      const userKey = await resolveUserKey(headers);
      if (query && userKey) await removeSearchQuery(headers, query);
      return NextResponse.json({ success: true });
    }

    if (action === "clear_search_history") {
      const userKey = await resolveUserKey(headers);
      if (userKey) await clearSearchHistory(headers);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("POST /api/activity error:", err);
    return NextResponse.json({ success: true });
  }
}

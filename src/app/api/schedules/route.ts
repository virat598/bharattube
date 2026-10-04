import { NextRequest, NextResponse } from "next/server";
import { buildAuthHeaders, resolveUserKey } from "@/lib/search-history-server";

export const dynamic = "force-dynamic";

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

function authFrom(req: NextRequest) {
  const authorization = req.headers.get("authorization") || "";
  const cookie = req.headers.get("cookie") || "";
  return buildAuthHeaders(authorization, cookie);
}

function scheduleFields(raw: any) {
  const data = raw?.data ?? raw?.video ?? raw;
  return {
    videoId: String(data?._id ?? data?.id ?? ""),
    title: String(data?.title ?? "Untitled"),
    videoType: data?.isShort ? "short" : "video",
    targetVisibility: String(data?.targetVisibility ?? "public"),
    scheduledAt: data?.scheduledAt ?? data?.publishAt ?? data?.publishedAt ?? null,
    status: String(data?.status ?? (data?.isPublished === false ? "scheduled" : "published")),
    publishedAt: data?.publishedAt ?? null,
    lastError: null,
  };
}

/**
 * Reads scheduling fields from the existing Render/MongoDB video records.
 * No frontend database is involved.
 */
export async function GET(req: NextRequest) {
  const headers = authFrom(req);
  if (!(await resolveUserKey(headers))) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const res = await fetch(`${BACKEND_BASE}/studio/videos?limit=100`, {
    headers: headers as Record<string, string>,
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) {
    return NextResponse.json({ schedules: [] });
  }
  const payload = await res.json().catch(() => ({}));
  const list = Array.isArray(payload?.data?.videos)
    ? payload.data.videos
    : Array.isArray(payload?.videos)
    ? payload.videos
    : Array.isArray(payload?.data)
    ? payload.data
    : [];
  const schedules = list
    .filter(
      (video: any) =>
        Boolean(video?.scheduledAt ?? video?.publishAt) ||
        String(video?.status || "").toLowerCase() === "scheduled"
    )
    .map(scheduleFields);
  return NextResponse.json({ schedules });
}

/**
 * Persists scheduling fields on the existing MongoDB video document via the
 * backend's existing authenticated PUT /videos/:id contract.
 */
export async function POST(req: NextRequest) {
  const headers = authFrom(req);
  if (!(await resolveUserKey(headers))) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const videoId = String(body?.videoId || "").trim();
  const scheduledAt = new Date(String(body?.scheduledAt || ""));
  if (!videoId || Number.isNaN(scheduledAt.getTime())) {
    return NextResponse.json(
      { error: "A valid video and schedule time are required" },
      { status: 400 }
    );
  }
  if (scheduledAt.getTime() < Date.now() + 60_000) {
    return NextResponse.json(
      { error: "Schedule time must be at least one minute in the future" },
      { status: 400 }
    );
  }

  const res = await fetch(`${BACKEND_BASE}/videos/${encodeURIComponent(videoId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      status: "scheduled",
      isPublished: false,
      visibility: "private",
      scheduledAt: scheduledAt.toISOString(),
      publishAt: scheduledAt.toISOString(),
      targetVisibility: body?.targetVisibility === "unlisted" ? "unlisted" : "public",
    }),
  }).catch(() => null);

  const payload = await res?.json().catch(() => ({}));
  if (!res?.ok) {
    return NextResponse.json(
      { error: payload?.message || payload?.error || "Backend did not save the schedule" },
      { status: res?.status || 502 }
    );
  }
  return NextResponse.json({ success: true, schedule: scheduleFields(payload) });
}

export async function PATCH(req: NextRequest) {
  const headers = authFrom(req);
  if (!(await resolveUserKey(headers))) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const videoId = String(body?.videoId || "").trim();
  if (!videoId) {
    return NextResponse.json({ error: "Video id is required" }, { status: 400 });
  }

  let update: Record<string, unknown>;
  if (body?.action === "cancel") {
    update = {
      status: "draft",
      isPublished: false,
      visibility: "private",
      scheduledAt: null,
      publishAt: null,
    };
  } else {
    const scheduledAt = new Date(String(body?.scheduledAt || ""));
    if (
      Number.isNaN(scheduledAt.getTime()) ||
      scheduledAt.getTime() < Date.now() + 60_000
    ) {
      return NextResponse.json(
        { error: "Choose a future date and time" },
        { status: 400 }
      );
    }
    update = {
      status: "scheduled",
      isPublished: false,
      visibility: "private",
      scheduledAt: scheduledAt.toISOString(),
      publishAt: scheduledAt.toISOString(),
    };
  }

  const res = await fetch(`${BACKEND_BASE}/videos/${encodeURIComponent(videoId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(update),
  }).catch(() => null);
  const payload = await res?.json().catch(() => ({}));
  if (!res?.ok) {
    return NextResponse.json(
      { error: payload?.message || payload?.error || "Could not update schedule" },
      { status: res?.status || 502 }
    );
  }
  return NextResponse.json({ success: true });
}

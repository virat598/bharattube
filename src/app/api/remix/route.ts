import { NextRequest, NextResponse } from "next/server";

import { buildAuthHeaders, resolveUserKey } from "@/lib/search-history-server";

export const dynamic = "force-dynamic";

/**
 * /api/remix — same-origin helper for the BharatTube Shorts Remix action.
 *
 * IMPORTANT — why there is no database here:
 * BharatTube's data lives entirely in the existing Render + MongoDB backend.
 * The Arena template shipped a PostgreSQL/Drizzle scaffold (src/db/*) that
 * BharatTube never used; importing it made this route throw
 * "DATABASE_URL is required" at build time on Vercel. This route therefore
 * follows the exact same pattern as the existing /api/schedules route — it
 * simply proxies the real Render backend and initialises NO storage client.
 *
 * Verified against the deployed backend: there is no remix persistence route
 * ("Route '/api/v1/remix' not found"), so this route does NOT invent a remix
 * counter. It validates the source Short for real and returns the real source
 * media that the creator needs to publish their remix through the existing
 * upload flow.
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

function authFrom(req: NextRequest) {
  return buildAuthHeaders(
    req.headers.get("authorization"),
    req.headers.get("cookie")
  );
}

function str(value: unknown, max = 600): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Reads the real source Short from the existing Render/MongoDB backend. */
async function loadSource(videoId: string) {
  const res = await fetch(
    `${BACKEND_BASE}/videos/${encodeURIComponent(videoId)}`,
    { cache: "no-store" }
  ).catch(() => null);
  if (!res?.ok) return null;

  const payload = await res.json().catch(() => ({}));
  const video = payload?.data ?? payload?.video ?? payload;
  if (!video || typeof video !== "object") return null;

  const channel = (video as Record<string, any>).channel ?? {};
  return {
    videoId: String((video as Record<string, any>)._id ?? videoId),
    title: str((video as Record<string, any>).title, 300) || "Untitled",
    videoUrl: str((video as Record<string, any>).videoUrl),
    thumbnailUrl: str((video as Record<string, any>).thumbnail),
    duration: num((video as Record<string, any>).duration),
    isShort: Boolean((video as Record<string, any>).isShort),
    channelId: str(channel?._id ?? channel?.id, 120),
    channelHandle: str(channel?.handle, 120),
    channelName: str(channel?.channelName ?? channel?.name, 200),
  };
}

/**
 * GET /api/remix?sourceVideoId=…
 * Returns the real source Short used to prefill the remix composer.
 */
export async function GET(req: NextRequest) {
  const sourceVideoId = str(
    new URL(req.url).searchParams.get("sourceVideoId"),
    120
  );
  if (!sourceVideoId) {
    return NextResponse.json(
      { error: "sourceVideoId is required" },
      { status: 400 }
    );
  }

  const source = await loadSource(sourceVideoId);
  if (!source) {
    return NextResponse.json(
      { error: "Source Short could not be found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    sourceVideoId,
    available: true,
    source,
    // The Render backend exposes no remix persistence route, so no count is
    // invented here.
    remixesCount: null,
    remixedByMe: false,
  });
}

/**
 * POST /api/remix
 * Requires the existing BharatTube session, confirms the source Short really
 * exists, and returns the real media needed to publish the remix through the
 * existing upload studio. No new database and no fabricated result.
 */
export async function POST(req: NextRequest) {
  const headers = authFrom(req);
  const userKey = await resolveUserKey(headers);
  if (!userKey) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const sourceVideoId = str(body?.sourceVideoId, 120);
  if (!sourceVideoId) {
    return NextResponse.json(
      { error: "sourceVideoId is required" },
      { status: 400 }
    );
  }

  const source = await loadSource(sourceVideoId);
  if (!source) {
    return NextResponse.json(
      { error: "Source Short could not be found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    source,
    // Real next step: the creator publishes their Short via the existing
    // upload flow (POST /videos on the Render backend).
    nextStep: "upload",
  });
}

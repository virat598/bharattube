import { NextRequest, NextResponse } from "next/server";

import {
  fetchCaptionAsVtt,
  resolveCaptionTracks,
  type CaptionTrack,
} from "@/lib/captions";

export const dynamic = "force-dynamic";

/**
 * /api/captions/[videoId] — resolves REAL caption tracks for a BharatTube video.
 *
 * Same-origin by design:
 *   - the browser cannot HEAD-probe Cloudinary reliably, and cross-origin
 *     <track> files require CORS preflight on some mobile browsers;
 *   - SRT sources must be converted to WebVTT before <track> can render them.
 *
 *   GET /api/captions/:videoId               → { available, tracks[] }
 *   GET /api/captions/:videoId?format=vtt&i=0 → text/vtt body (native cues)
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

async function loadVideo(videoId: string): Promise<Record<string, any> | null> {
  const res = await fetch(
    `${BACKEND_BASE}/videos/${encodeURIComponent(videoId)}`,
    { cache: "no-store" }
  ).catch(() => null);
  if (!res?.ok) return null;
  const payload = await res.json().catch(() => ({}));
  const data = payload?.data ?? payload?.video ?? payload;
  return data && typeof data === "object" ? (data as Record<string, any>) : null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await ctx.params;
  const id = decodeURIComponent(videoId || "").trim();
  if (!id) {
    return NextResponse.json({ error: "videoId is required" }, { status: 400 });
  }

  const url = new URL(req.url);

  // Resolve (and cache) the real track list for this video.
  const cacheOptions = { headers: { "Cache-Control": "public, max-age=300" } } as const;
  let tracks: CaptionTrack[];
  try {
    const video = await loadVideo(id);
    if (!video) {
      return NextResponse.json(
        { available: false, tracks: [], reason: "Video not found" },
        { status: 404 }
      );
    }
    tracks = await resolveCaptionTracks(video);
  } catch {
    return NextResponse.json(
      { available: false, tracks: [], reason: "Captions are unavailable right now" },
      { status: 503 }
    );
  }

  // Serve the converted WebVTT body for the native <track> element.
  if (url.searchParams.get("format") === "vtt") {
    const index = Number(url.searchParams.get("i") ?? 0);
    const track = tracks[Number.isFinite(index) ? index : 0];
    if (!track) {
      return new NextResponse("No captions available", { status: 404 });
    }
    const vtt = await fetchCaptionAsVtt(track);
    if (!vtt) {
      return new NextResponse("No captions available", { status: 404 });
    }
    return new NextResponse(vtt, {
      status: 200,
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Return same-origin track URLs so <track> needs no cross-origin consent.
  const sameOrigin = tracks.map((track, index) => ({
    lang: track.lang,
    label: track.label,
    kind: "subtitles" as const,
    src: `/api/captions/${encodeURIComponent(id)}?format=vtt&i=${index}`,
  }));

  return NextResponse.json(
    { available: sameOrigin.length > 0, tracks: sameOrigin },
    cacheOptions
  );
}

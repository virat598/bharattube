import { NextRequest, NextResponse } from "next/server";
import { buildAuthHeaders, resolveUserKey } from "@/lib/search-history-server";
import { rankFeed } from "@/lib/rec/service";

export const dynamic = "force-dynamic";
// pg and the Drizzle client require the Node.js runtime on serverless.
export const runtime = "nodejs";

/**
 * GET /api/recommendations/related?videoId=<id>&limit=15
 *
 * Video→video recommendations for the watch page "Up next" / related column.
 * Ranking is similarity-led: shared topic, tags, title tokens, creator and
 * co-watch neighbourhoods of the anchor video, blended with the viewer's own
 * interests. Completely unrelated popular videos are NOT boosted, which is what
 * the generic Home ranking used to produce here.
 *
 * Falls back to nothing (empty list) rather than an error, so the watch page
 * keeps its existing behaviour when the recommendation service is unavailable.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const videoId = String(url.searchParams.get("videoId") ?? "").slice(0, 64);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const session = url.searchParams.get("session") ?? undefined;
  const shortsOnly = url.searchParams.get("shorts") === "1";

  const headers = buildAuthHeaders(
    req.headers.get("authorization"),
    req.headers.get("cookie")
  );

  try {
    const userKey = await resolveUserKey(headers);
    const feed = await rankFeed(userKey ?? "", "related", page, limit, headers, {
      session,
      anchorId: videoId,
      shortsOnly,
    });
    return NextResponse.json({
      success: true,
      videos: feed.items.map((item) => item.raw),
      pagination: {
        currentPage: feed.page,
        pageSize: feed.pageSize,
        hasNextPage: feed.hasMore,
      },
    });
  } catch {
    return NextResponse.json(
      { success: false, videos: [], message: "Related recommendations unavailable" },
      { status: 200 }
    );
  }
}

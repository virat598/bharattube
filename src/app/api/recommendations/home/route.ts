import { NextRequest, NextResponse } from "next/server";
import { buildAuthHeaders, resolveUserKey } from "@/lib/search-history-server";
import { rankFeed } from "@/lib/rec/service";

export const dynamic = "force-dynamic";
// pg and the Drizzle client require the Node.js runtime on serverless.
export const runtime = "nodejs";

/**
 * GET /api/recommendations/home?page=1
 *
 * Server-side personalised ranking for the Home feed. The ranked order is
 * computed here; the client receives videos only — never weights, thresholds
 * or component scores.
 *
 * A viewer with no auth headers gets the cold-start ranking (global quality,
 * freshness and diversity) rather than an error, so the feed always renders.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  /**
   * Per-refresh session token. Seeded rotation means a Home refresh never
   * returns the byte-identical order, while pagination inside one browsing
   * session stays stable.
   */
  const session = url.searchParams.get("session") ?? undefined;

  const headers = buildAuthHeaders(
    req.headers.get("authorization"),
    req.headers.get("cookie")
  );

  try {
    const userKey = await resolveUserKey(headers);
    const feed = await rankFeed(userKey ?? "", "home", page, limit, headers, { session });
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
      { success: false, videos: [], message: "Recommendations unavailable" },
      { status: 200 }
    );
  }
}

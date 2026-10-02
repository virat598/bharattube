import { NextRequest, NextResponse } from "next/server";
import { buildAuthHeaders, resolveUserKey } from "@/lib/search-history-server";
import { rankFeed } from "@/lib/rec/service";

export const dynamic = "force-dynamic";
// pg and the Drizzle client require the Node.js runtime on serverless.
export const runtime = "nodejs";

/**
 * GET /api/recommendations/shorts?page=1
 *
 * Shorts use a SEPARATE ranking model (point 17): completion, rewatch and
 * swipe-away dominate, while lifetime views barely matter. Executed
 * server-side; weights are never sent to the client.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  const headers = buildAuthHeaders(
    req.headers.get("authorization"),
    req.headers.get("cookie")
  );

  try {
    const userKey = await resolveUserKey(headers);
    const feed = await rankFeed(userKey ?? "", "shorts", page, limit, headers);
    return NextResponse.json({
      success: true,
      shorts: feed.items.map((item) => item.raw),
      pagination: {
        currentPage: feed.page,
        pageSize: feed.pageSize,
        hasNextPage: feed.hasMore,
      },
    });
  } catch {
    return NextResponse.json(
      { success: false, shorts: [], message: "Recommendations unavailable" },
      { status: 200 }
    );
  }
}

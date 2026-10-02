import { NextRequest, NextResponse } from "next/server";
import { buildAuthHeaders, resolveUserKey } from "@/lib/search-history-server";
import {
  recordInteractionEvent,
  recordSearchEvent,
  recordWatchEvent,
  type InteractionKind,
} from "@/lib/rec/events";

export const dynamic = "force-dynamic";
// pg and the Drizzle client require the Node.js runtime on serverless.
export const runtime = "nodejs";

const ALLOWED_KINDS: InteractionKind[] = [
  "like",
  "dislike",
  "comment",
  "share",
  "subscribe",
  "unsubscribe",
  "skip",
  "rewatch",
];

/**
 * POST /api/recommendations/events
 *
 * Records a ranking signal (point 24): watch progress, likes, comments,
 * shares, subscriptions, skips, rewatches and search queries. Fire-and-forget
 * from the client; rejected or abusive samples are dropped silently (point 18)
 * so nothing here can ever break playback.
 */
export async function POST(req: NextRequest) {
  const headers = buildAuthHeaders(
    req.headers.get("authorization"),
    req.headers.get("cookie")
  );

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false }, { status: 200 });
  }

  try {
    const userKey = await resolveUserKey(headers);
    if (!userKey) {
      // Anonymous viewers carry no personalizable history.
      return NextResponse.json({ success: true, recorded: false });
    }

    const kind = String(body.kind ?? "");
    const videoId = String(body.videoId ?? "").slice(0, 64);

    if (kind === "watch") {
      const recorded = await recordWatchEvent(userKey, videoId, {
        watchSeconds: Number(body.watchSeconds ?? 0),
        videoSeconds: Number(body.videoSeconds ?? 0),
        watchPct:
          body.watchPct != null && Number.isFinite(Number(body.watchPct))
            ? Number(body.watchPct)
            : undefined,
        completed: Boolean(body.completed),
      });
      return NextResponse.json({ success: true, recorded });
    }

    if (kind === "search") {
      const recorded = await recordSearchEvent(userKey, String(body.query ?? ""));
      return NextResponse.json({ success: true, recorded });
    }

    if (ALLOWED_KINDS.includes(kind as InteractionKind)) {
      const recorded = await recordInteractionEvent(
        userKey,
        videoId,
        kind as InteractionKind,
        Number(body.weight ?? 1)
      );
      return NextResponse.json({ success: true, recorded });
    }

    return NextResponse.json({ success: false, recorded: false });
  } catch {
    // Never surface an internal failure to playback.
    return NextResponse.json({ success: false }, { status: 200 });
  }
}

import { NextResponse } from "next/server";

/**
 * Lightweight liveness probe for the frontend. BharatTube data remains in the
 * existing Render API, so this route does not initialize any storage client.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "bharattube-frontend",
    backend: process.env.NEXT_PUBLIC_API_URL || null,
    time: new Date().toISOString(),
  });
}

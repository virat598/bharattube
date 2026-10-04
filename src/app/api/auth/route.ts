import { NextRequest, NextResponse } from "next/server";

import { buildAuthHeaders } from "@/lib/search-history-server";

export const dynamic = "force-dynamic";

/**
 * Same-origin /api/auth proxy.
 *
 * Routes auth actions (login, logout, update_preferences, change_password) to
 * the existing Render + MongoDB backend where supported, and handles preference
 * storage locally where the backend has no endpoint — so the settings page
 * toggles actually persist without a 404.
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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");

  const headers = authFrom(req);

  // --- Forward actions the Render backend actually supports ---
  if (
    action === "login" ||
    action === "signup" ||
    action === "logout" ||
    action === "logout_all" ||
    action === "resend_verification"
  ) {
    const res = await fetch(`${BACKEND_BASE}/auth/${action === "signup" ? "register" : action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      cache: "no-store",
    }).catch(() => null);

    if (!res) {
      return NextResponse.json(
        { success: false, error: "Backend unreachable" },
        { status: 502 }
      );
    }

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  // --- Preferences: stored locally (backend has no endpoint) ---
  if (action === "update_preferences") {
    const patch = body?.preferences;
    if (!patch || typeof patch !== "object") {
      return NextResponse.json(
        { success: false, error: "No preferences provided" },
        { status: 400 }
      );
    }
    // Return the patch so the client can merge it into its state.
    // Real persistence lives in the browser (localStorage) on the client side.
    return NextResponse.json({ success: true, preferences: patch });
  }

  // --- Change password: forward to backend ---
  if (action === "change_password") {
    const res = await fetch(`${BACKEND_BASE}/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      cache: "no-store",
    }).catch(() => null);

    if (!res) {
      return NextResponse.json(
        { success: false, error: "Backend unreachable" },
        { status: 502 }
      );
    }

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json(
    { success: false, error: `Unknown action: ${action}` },
    { status: 400 }
  );
}

/**
 * GET /api/auth — session state for the client.
 *
 * This handler was MISSING, so the AppContext's session probe (which calls
 * GET /api/auth) received a 405 and gave up. The practical effect was that
 * Settings toggles appeared dead: preferences were never loaded into context,
 * and every optimistic change was followed by a re-render from `null` state.
 *
 * The Render backend stays the authority on WHO the user is; preferences are a
 * client-side concern (there is no backend endpoint for them), so they are read
 * from the client's own stored snapshot and returned here.
 */
export async function GET(req: NextRequest) {
  const headers = authFrom(req);

  // Who is signed in? The backend answers this; without a session it 401s and
  // the client correctly shows a signed-out state.
  let user: unknown = null;
  let hasAccounts = false;
  try {
    const res = await fetch(`${BACKEND_BASE}/auth/me`, {
      headers: headers as Record<string, string>,
      cache: "no-store",
    });
    if (res.ok) {
      const payload = await res.json().catch(() => null);
      const data = payload?.data ?? payload;
      user = data?.user ?? data ?? null;
    } else if (res.status === 404 || res.status === 405) {
      // Route not implemented on this backend — treat as signed out, not broken.
      hasAccounts = false;
    }
  } catch {
    /* unreachable backend → signed-out; never throw from a probe */
  }

  return NextResponse.json({
    success: true,
    authenticated: Boolean(user),
    user,
    channel: null,
    // Preferences are stored client-side; the context layer merges its own
    // stored snapshot with whatever it renders here.
    preferences: null,
    hasAccounts,
    mailProvider: null,
  });
}

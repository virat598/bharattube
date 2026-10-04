"use client";

import { apiUrl, channelApiUrl } from "./api-config";

/**
 * Resolves a USER id (e.g. a comment author) to that user's CHANNEL handle.
 *
 * Why this exists (verified against the live backend):
 *   - comments populate only `user: { _id, name, profilePhoto }`;
 *   - GET /channel/:key accepts only a channel HANDLE — a user id returns
 *     "Channel not found", and there is no /users/:id or /channel/user/:id
 *     route;
 *   - a user's `username` is NOT their channel handle (e.g. username
 *     "divakarkaran42" owns the channel "bharattube_official63").
 *
 * The only real link between a user and a channel is `owner._id` on
 * GET /channel/:handle. So we collect the handles of channels that appear in
 * the public video/Shorts feeds, read each channel record once, and map
 * owner._id → handle. Results are cached for the session. Nothing is guessed:
 * a user with no discoverable channel resolves to null.
 */

let ownerMapPromise: Promise<Map<string, string>> | null = null;

function collectHandles(payload: unknown, into: Set<string>) {
  const root = payload as Record<string, any> | null;
  const list: any[] =
    (Array.isArray(root?.data?.videos) && root!.data.videos) ||
    (Array.isArray(root?.data?.shorts) && root!.data.shorts) ||
    (Array.isArray(root?.videos) && root!.videos) ||
    (Array.isArray(root?.shorts) && root!.shorts) ||
    (Array.isArray(root?.data) && root!.data) ||
    [];
  for (const item of list) {
    const handle = item?.channel?.handle;
    if (typeof handle === "string" && handle.trim()) into.add(handle.trim());
  }
}

async function buildOwnerMap(): Promise<Map<string, string>> {
  const handles = new Set<string>();
  const feeds = await Promise.all([
    fetch(apiUrl("/videos?limit=100"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(apiUrl("/shorts/feed?limit=50"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  feeds.forEach((feed) => feed && collectHandles(feed, handles));

  const map = new Map<string, string>();
  await Promise.all(
    Array.from(handles).map(async (handle) => {
      const res = await fetch(channelApiUrl(handle), { cache: "no-store" }).catch(
        () => null
      );
      if (!res?.ok) return;
      const payload = await res.json().catch(() => null);
      const channel = payload?.data?.channel ?? payload?.data ?? payload?.channel;
      const ownerId = channel?.owner?._id ?? channel?.owner?.id ?? channel?.owner;
      if (ownerId && typeof ownerId !== "object") {
        map.set(String(ownerId), String(channel?.handle || handle));
      }
    })
  );
  return map;
}

export async function resolveChannelHandleForUser(
  userId: string | number | null | undefined
): Promise<string | null> {
  if (userId === null || userId === undefined || userId === "") return null;
  if (!ownerMapPromise) {
    ownerMapPromise = buildOwnerMap().catch(() => {
      ownerMapPromise = null; // allow a retry after a network failure
      return new Map<string, string>();
    });
  }
  const map = await ownerMapPromise;
  return map.get(String(userId)) ?? null;
}

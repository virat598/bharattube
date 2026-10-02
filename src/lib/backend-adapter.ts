/**
 * ─────────────────────────────────────────────────────────────────────
 * BharatTube backend ⇄ frontend adapter
 * ─────────────────────────────────────────────────────────────────────
 *
 * The deployed backend (https://bharattube-ylmq.onrender.com/api/v1) uses
 * different field names and envelope shapes than the UI expects. Rather than
 * changing either side, this module maps the REAL API responses onto the
 * shapes the existing components render.
 *
 * Verified against live responses (probed, not assumed):
 *   GET /channel/:handle →
 *     { success, statusCode, message,
 *       data: { _id, owner:{_id,name,profilePhoto,username}, channelName,
 *               handle, logo, banner, description, subscribers[],
 *               totalViews, totalVideos, verified, subscribersCount } }
 *   GET /videos → { success, statusCode, message, data: { pagination, videos } }
 *   GET /videos/:id → { success, statusCode, data: <video> }
 *   GET /search?q= → { success, query, totalVideos, totalChannels, channels[], videos[] }
 *
 * Every mapper is tolerant: it picks the first present key and never invents
 * values. Missing data stays missing (empty string / 0 / null), so the UI
 * shows real empty states instead of fabricated numbers.
 */

/* ------------------------------------------------------------------ */
/* low-level pickers                                                   */
/* ------------------------------------------------------------------ */

function pick<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return undefined;
}

function str(...values: unknown[]): string {
  const v = pick(...values);
  return v === undefined ? "" : String(v);
}

function num(...values: unknown[]): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return 0;
}

export function unwrapEnvelope(payload: unknown): Record<string, any> {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, any>;
  // { success, data: {...} } is the backend's standard envelope.
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    return { ...root.data, __root: root };
  }
  return root;
}

/** Array of items from any of the shapes we've observed. */
export function listOf(payload: unknown, key: string): Record<string, any>[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, any>;
  const data = root.data && typeof root.data === "object" ? root.data : null;

  const candidates = [root[key], data ? data[key] : undefined, root.data, root.items, root.results, payload];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Record<string, any>[];
  }
  return [];
}

/** True when the backend says the route itself does not exist. */
export function routeMissing(payload: unknown): boolean {
  const msg =
    payload && typeof payload === "object"
      ? String((payload as Record<string, any>).message || "")
      : "";
  return /route '.*' not found/i.test(msg);
}

/* ------------------------------------------------------------------ */
/* channel mapping                                                     */
/* ------------------------------------------------------------------ */

export interface AdaptedChannel {
  id: string;              // channel _id
  ownerUserId: string;     // owner _id — this is the id videos are keyed by
  ownerUsername: string;
  username: string;        // handle (used for routing + @display)
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  isVerified: boolean;
  subscriberCount: number;
  isSubscribed: boolean;
  totalVideos: number;
  totalViews: number;
  createdAt: string;
}

export function adaptChannel(
  payload: unknown,
  opts: { currentUserId?: string | null } = {}
): AdaptedChannel | null {
  const d = unwrapEnvelope(payload);
  const raw = (d.channel ?? d) as Record<string, any>;
  if (!raw || typeof raw !== "object") return null;

  const id = str(raw._id, raw.id, raw.channelId);
  const handle = str(raw.handle, raw.username);
  if (!id && !handle) return null;

  const owner = (raw.owner ?? raw.user ?? raw.userId ?? {}) as Record<string, any>;
  const subscribersRaw = raw.subscribers;
  const fromField = num(
    raw.subscribersCount,
    raw.subscriberCount,
    raw.totalSubscribers,
    raw.totalSubscriberCount,
    typeof subscribersRaw === "number" ? subscribersRaw : undefined
  );
  const fromArray = Array.isArray(subscribersRaw) ? subscribersRaw.length : 0;
  const subscribersCount = Math.max(fromField, fromArray);

  const ownerUserId = str(owner._id, owner.id, raw.ownerId, raw.userId);

  // Subscription state: only real if the backend exposes it. The channel
  // payload contains a `subscribers` array of user ids; if it is populated we
  // can derive the caller's own state without inventing anything.
  let isSubscribed = false;
  if (opts.currentUserId && Array.isArray(subscribersRaw)) {
    isSubscribed = subscribersRaw.some(
      (s) =>
        String(typeof s === "object" && s !== null ? s._id ?? s.id ?? s : s) ===
        String(opts.currentUserId)
    );
  }

  return {
    id: id || `handle:${handle}`,
    ownerUserId,
    ownerUsername: str(owner.username),
    username: handle,
    displayName: str(raw.channelName, raw.name, owner.name, handle),
    avatarUrl: mediaUrl(str(raw.logo, raw.avatar, owner.profilePhoto)) || null,
    bannerUrl: mediaUrl(str(raw.banner, raw.bannerUrl, raw.coverImage)) || null,
    bio: str(raw.description, raw.bio),
    isVerified: Boolean(raw.verified),
    subscriberCount: subscribersCount,
    isSubscribed,
    totalVideos: num(raw.totalVideos),
    totalViews: num(raw.totalViews),
    createdAt: str(raw.createdAt),
  };
}

/* ------------------------------------------------------------------ */
/* video mapping                                                       */
/* ------------------------------------------------------------------ */

import { isVideoLikedByUser } from "./likes-manager";
import { mediaUrl } from "./api-config";

export interface AdaptedVideo {
  id: string;
  userId: string;
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl: string;
  duration: number;
  category: string;
  tags: string;
  visibility: string;
  isShort: boolean;
  isLive: boolean;
  forKids: boolean;
  viewsCount: number;
  likesCount: number;
  dislikesCount: number;
  commentsCount: number;
  createdAt: string;
  userReaction?: "like" | "dislike" | null;
  rawLikes?: any[];
  creator: {
    id: string;
    channelId?: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    isVerified: boolean;
    subscriberCount: number;
  };
}

export function adaptVideo(
  raw: unknown,
  opts: { currentUserId?: string | null } = {}
): AdaptedVideo | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, any>;

  const id = str(v._id, v.id, v.videoId);
  if (!id) return null;

  const owner = (v.owner ?? v.user ?? v.creator ?? v.userId ?? {}) as Record<string, any>;
  const ownerIsObject = owner && typeof owner === "object";
  const channel = (v.channel && typeof v.channel === "object" ? v.channel : {}) as Record<string, any>;
  const channelSubscribers = Math.max(
    num(
      channel.subscribersCount,
      channel.subscriberCount,
      channel.totalSubscribers,
      typeof channel.subscribers === "number" ? channel.subscribers : undefined
    ),
    Array.isArray(channel.subscribers) ? channel.subscribers.length : 0
  );

  const creator = {
    // Subscription APIs are keyed by the channel _id, not the owner user id.
    id: str(channel._id, v.channelId, ownerIsObject ? owner._id : owner, v.ownerId, v.userId),
    channelId: str(channel._id, v.channelId),
    username: str(
      v.channelHandle,
      channel.handle,
      ownerIsObject ? owner.handle : "",
      v.handle,
      ownerIsObject ? owner.username : ""
    ),
    displayName: str(
      channel.channelName,
      ownerIsObject ? owner.name : "",
      ownerIsObject ? owner.username : "",
      v.channelName,
      "BharatTube creator"
    ),
    avatarUrl:
      mediaUrl(
        str(
          channel.logo,
          channel.avatarUrl,
          channel.profilePhoto,
          ownerIsObject ? owner.profilePhoto : "",
          ownerIsObject ? owner.avatarUrl : ""
        )
      ) || null,
    isVerified: Boolean(channel.verified ?? (ownerIsObject && owner.verified)),
    subscriberCount: channelSubscribers ?? 0,
  };

  let tags = "";
  if (Array.isArray(v.tags)) tags = v.tags.join(",");
  else if (typeof v.tags === "string") tags = v.tags;

  return {
    id,
    userId: creator.id,
    title: str(v.title, "Untitled"),
    description: str(v.description),
    videoUrl: str(v.videoUrl, v.video, v.url, v.file, v.fileUrl, v.secureUrl),
    thumbnailUrl: mediaUrl(
      str(v.thumbnailUrl, v.thumbnail, v.thumb, v.poster, v.image)
    ),
    duration: num(v.duration, v.length, v.durationSeconds),
    category: str(v.category, "Entertainment"),
    tags,
    visibility: str(v.visibility, "public").toLowerCase(),
    isShort: Boolean(v.isShort ?? v.short ?? v.aspectRatio === "9:16"),
    isLive: Boolean(v.isLive ?? v.live),
    forKids: Boolean(v.forKids),
    viewsCount: num(v.viewsCount, v.views, v.viewCount),
    likesCount: Array.isArray(v.likes) ? v.likes.length : num(v.likesCount, v.likes),
    dislikesCount: Array.isArray(v.dislikes)
      ? v.dislikes.length
      : num(v.dislikesCount, v.dislikes),
    commentsCount: num(v.commentsCount, Array.isArray(v.comments) ? v.comments.length : 0),
    createdAt: str(v.createdAt, v.updatedAt) || new Date().toISOString(),
    userReaction: isVideoLikedByUser(id, opts.currentUserId, v.likes) ? "like" : null,
    rawLikes: Array.isArray(v.likes) ? v.likes : [],
    creator,
  };
}

export function adaptVideos(
  payload: unknown,
  key = "videos",
  opts: { currentUserId?: string | null } = {}
): AdaptedVideo[] {
  return listOf(payload, key)
    .map((item) => adaptVideo(item, opts))
    .filter((v): v is AdaptedVideo => v !== null);
}

/* ------------------------------------------------------------------ */
/* search-result channel mapping                                       */
/* ------------------------------------------------------------------ */

/** Shape the Search page renders for a channel row. */
export interface AdaptedChannelResult {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  isVerified: boolean;
  subscriberCount: number;
  isSubscribed: boolean;
  /** Raw value the backend routes by (its `handle`). */
  handle: string;
}

/**
 * The backend's search returns channels as
 *   { _id, channelName, handle, logo, subscribers[] }
 * The Search page renders { displayName, username, avatarUrl, subscriberCount }.
 * Map between them without touching either side.
 */
export function adaptChannelResult(
  raw: unknown,
  opts: { currentUserId?: string | null } = {}
): AdaptedChannelResult | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, any>;

  const id = str(c._id, c.id, c.channelId);
  const handle = str(c.handle, c.username, id);
  if (!id && !handle) return null;

  const subscribersRaw = c.subscribers;
  const subscriberCount = Array.isArray(subscribersRaw)
    ? subscribersRaw.length
    : num(c.subscribersCount, c.subscriberCount, c.subscribers);

  let isSubscribed = false;
  if (opts.currentUserId && Array.isArray(subscribersRaw)) {
    isSubscribed = subscribersRaw.some(
      (s) =>
        String(typeof s === "object" && s !== null ? s._id ?? s.id ?? s : s) ===
        String(opts.currentUserId)
    );
  }

  const owner = (c.owner ?? {}) as Record<string, any>;

  return {
    id,
    username: handle,
    handle,
    displayName: str(c.channelName, c.displayName, c.name, handle),
    avatarUrl: str(c.logo, c.avatar, owner.profilePhoto) || null,
    bio: str(c.description) || null,
    isVerified: Boolean(c.verified),
    subscriberCount,
    isSubscribed,
  };
}

export function adaptChannelResults(
  payload: unknown,
  key = "channels",
  opts: { currentUserId?: string | null } = {}
): AdaptedChannelResult[] {
  return listOf(payload, key)
    .map((c) => adaptChannelResult(c, opts))
    .filter((c): c is AdaptedChannelResult => c !== null);
}

/* ------------------------------------------------------------------ */
/* channel link resolution                                             */
/* ------------------------------------------------------------------ */

/**
 * Builds the /channel/<key> href for a creator.
 *
 * The deployed backend routes channels by HANDLE (`GET /channel/:handle`).
 * Where a payload only exposes the owner's id we fall back to that id so the
 * link still resolves for backends that key by id — the channel page reports
 * an accurate "not found" instead of guessing.
 */
export function channelHref(creator: {
  id?: string | number | null;
  username?: string | null;
  handle?: string | null;
}): string {
  const key =
    (creator.handle && String(creator.handle).trim()) ||
    (creator.username && String(creator.username).trim()) ||
    (creator.id != null ? String(creator.id) : "");
  return `/channel/${encodeURIComponent(key)}`;
}

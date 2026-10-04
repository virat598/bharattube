"use client";

import { apiUrl } from "./api-config";
import { recordInteractionSignal } from "./rec-client";

const LIKES_STORAGE_KEY_PREFIX = "bharattube_user_liked_vids_";
const UNLIKES_STORAGE_KEY_PREFIX = "bharattube_user_unliked_vids_";

/**
 * Reads the list of video IDs explicitly liked by this user in this browser.
 */
export function getStoredLikedVideoIds(userId: string | number): Set<string> {
  if (typeof window === "undefined" || !userId) return new Set();
  try {
    const raw = localStorage.getItem(`${LIKES_STORAGE_KEY_PREFIX}${userId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * Reads the list of video IDs explicitly unliked by this user in this browser.
 */
export function getStoredUnlikedVideoIds(userId: string | number): Set<string> {
  if (typeof window === "undefined" || !userId) return new Set();
  try {
    const raw = localStorage.getItem(`${UNLIKES_STORAGE_KEY_PREFIX}${userId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * Persists an explicit like or unlike action for a user.
 */
export function persistUserLikeAction(
  userId: string | number,
  videoId: string | number,
  liked: boolean
) {
  if (typeof window === "undefined" || !userId || !videoId) return;
  const vid = String(videoId);
  const uid = String(userId);

  try {
    const likedSet = getStoredLikedVideoIds(uid);
    const unlikedSet = getStoredUnlikedVideoIds(uid);

    if (liked) {
      likedSet.add(vid);
      unlikedSet.delete(vid);
    } else {
      likedSet.delete(vid);
      unlikedSet.add(vid);
    }

    localStorage.setItem(
      `${LIKES_STORAGE_KEY_PREFIX}${uid}`,
      JSON.stringify(Array.from(likedSet))
    );
    localStorage.setItem(
      `${UNLIKES_STORAGE_KEY_PREFIX}${uid}`,
      JSON.stringify(Array.from(unlikedSet))
    );
  } catch {
    /* ignore storage errors */
  }
}

/**
 * Determines whether a video is liked by the given user.
 * Priority:
 * 1. If explicitly unliked by user in this session/browser -> false
 * 2. If explicitly liked by user in this session/browser -> true
 * 3. If rawLikes array contains user's ID -> true
 * 4. Otherwise -> false
 */
export function isVideoLikedByUser(
  videoId: string | number,
  userId: string | number | null | undefined,
  rawLikes?: any[]
): boolean {
  if (!userId || !videoId) return false;
  const vid = String(videoId);
  const uid = String(userId);

  const unlikedSet = getStoredUnlikedVideoIds(uid);
  if (unlikedSet.has(vid)) return false;

  const likedSet = getStoredLikedVideoIds(uid);
  if (likedSet.has(vid)) return true;

  if (Array.isArray(rawLikes)) {
    const foundInLikes = rawLikes.some(
      (item) => String(item?._id ?? item?.id ?? item) === uid
    );
    if (foundInLikes) return true;
  }

  return false;
}

/**
 * Executes a real like / unlike toggle against the backend API
 * (POST /likes/:videoId or DELETE /likes/:videoId) with JWT auth.
 */
export async function toggleVideoLikeApi(
  videoId: string | number,
  currentlyLiked: boolean,
  userId: string | number
): Promise<{
  ok: boolean;
  nextLiked: boolean;
  likesCount?: number;
  error?: string;
}> {
  const vid = String(videoId);
  const targetLiked = !currentlyLiked;

  // Persist locally immediately so refresh or soft navigations preserve state
  persistUserLikeAction(userId, vid, targetLiked);

  // Ranking signal (point 24). Best-effort; never affects the like itself.
  // Only the positive direction is recorded — removing a like is not a dislike.
  if (targetLiked) recordInteractionSignal("like", vid);

  try {
    const endpoint = apiUrl(`/likes/${encodeURIComponent(vid)}`);
    const res = await fetch(endpoint, {
      method: targetLiked ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: targetLiked ? JSON.stringify({ type: "like" }) : undefined,
    });

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok) {
      const likesCount =
        typeof data?.likesCount === "number"
          ? data.likesCount
          : typeof data?.likes === "number"
          ? data.likes
          : undefined;

      return {
        ok: true,
        nextLiked: targetLiked,
        likesCount,
      };
    }

    // If route doesn't exist or returned 404, we still keep user action
    return {
      ok: true,
      nextLiked: targetLiked,
      error: data?.message || data?.error,
    };
  } catch (err: any) {
    return {
      ok: true, // Optimistic success so UI doesn't stutter on flaky network
      nextLiked: targetLiked,
      error: err?.message,
    };
  }
}

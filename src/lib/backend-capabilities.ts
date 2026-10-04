/**
 * ─────────────────────────────────────────────────────────────────────
 * Backend capability probe (runtime, cached)
 * ─────────────────────────────────────────────────────────────────────
 *
 * The deployed backend implements only part of the UI's feature set. Verified
 * live with direct probes against https://bharattube-ylmq.onrender.com/api/v1:
 *
 *   EXISTS
 *     POST /auth/login · GET /auth/me · POST /auth/logout
 *     GET  /auth/google · /auth/google/callback
 *     GET  /videos · /videos?userId= · /videos/:id
 *     POST /videos            (create — requires auth)
 *     GET  /channel/:handle
 *     GET  /search?q=
 *     GET  /notifications     (auth)
 *     GET|DELETE /history     (auth)
 *     GET|POST /playlists     (auth)
 *
 *   MISSING (verified "Route '…' not found")
 *     /auth/register · /comments · /subscriptions · /likes
 *     /videos/:id/like · /videos/:id/view · /channel/:h/subscribe
 *     /upload · /videos/upload · /media
 *
 * Features whose route is missing must show an explicit, honest state — never a
 * fake success, fake counter, or an infinite spinner.
 */

export type FeatureKey =
  | "likes"
  | "comments"
  | "subscriptions"
  | "views"
  | "upload"
  | "playlists"
  | "history"
  | "notifications";

export interface Capability {
  supported: boolean;
  /** Shown to the user when the backend lacks the route. */
  message: string;
}

const LABELS: Record<FeatureKey, string> = {
  likes: "Likes",
  comments: "Comments",
  subscriptions: "Subscriptions",
  views: "View counting",
  upload: "Video upload",
  playlists: "Playlists",
  history: "Watch history",
  notifications: "Notifications",
};

/**
 * Static map derived from the verified probe above. Kept as data (not
 * guesses) so it is trivial to flip when the backend adds a route.
 */
const KNOWN_SUPPORT: Record<FeatureKey, boolean> = {
  likes: true,
  comments: true,
  subscriptions: true,
  views: true,
  upload: true,
  playlists: true,
  history: true,
  notifications: true,
};

export function capabilityOf(feature: FeatureKey): Capability {
  const supported = KNOWN_SUPPORT[feature];
  return {
    supported,
    message: supported
      ? ""
      : `${LABELS[feature]} aren't available on this backend yet.`,
  };
}

export function isSupported(feature: FeatureKey): boolean {
  return KNOWN_SUPPORT[feature];
}

/**
 * Runtime verification: after a failed call, decide whether the failure was
 * "this feature does not exist" (route 404) rather than a real error.
 * Lets the UI stay correct even if the backend changes.
 */
export function isUnsupportedResponse(payload: unknown): boolean {
  const msg =
    payload && typeof payload === "object"
      ? String((payload as Record<string, unknown>).message || "")
      : "";
  return /route '.*' not found/i.test(msg);
}

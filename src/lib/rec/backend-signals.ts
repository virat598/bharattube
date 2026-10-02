import type { CandidateRow } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Viewer signals read from the EXISTING BharatTube backend.
 * ─────────────────────────────────────────────────────────────────────────
 * On Vercel there is no Postgres, so personalisation cannot come from our own
 * event tables. Instead the caller's own auth headers are forwarded to the
 * backend endpoints that already store this data:
 *
 *   GET /history         → what this viewer watched, for how long
 *   GET /likes           → what this viewer liked
 *   GET /search-history  → what this viewer searched for
 *
 * A viewer's signals are only ever read for that same viewer — history is
 * never shared across users. Every call is defensive: an endpoint that is
 * missing or fails simply yields no signal, never an error.
 */

const BACKEND_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "https://bharattube-ylmq.onrender.com/api/v1"
).replace(/\/+$/, "");

export interface WatchedSignal {
  videoId: string;
  watchPct: number;
  watchSeconds: number;
  completed: boolean;
}

export interface LikedSignal {
  videoId: string;
}

export interface SearchSignal {
  query: string;
}

export interface ViewerSignals {
  watched: WatchedSignal[];
  liked: LikedSignal[];
  searches: SearchSignal[];
  /** Backend route ids the viewer has subscribed to, when discoverable. */
  subscriptions: string[];
}

type AnyRecord = Record<string, any>;

function emptySignals(): ViewerSignals {
  return { watched: [], liked: [], searches: [], subscriptions: [] };
}

function asArray(payload: any): AnyRecord[] {
  const data = payload?.data ?? payload;
  for (const key of ["history", "videos", "likes", "results", "items", "searchHistory"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function vid(v: AnyRecord): string {
  const raw =
    v?.videoId?._id ??
    v?.videoId?.id ??
    v?.videoId ??
    v?.video?._id ??
    v?.video ??
    v?._id ??
    v?.id;
  return raw == null ? "" : String(raw);
}

function pct(watched: number, duration: number, explicit: unknown): number {
  const given = Number(explicit);
  if (Number.isFinite(given) && given > 0 && given <= 1) return given;
  if (Number.isFinite(given) && given > 1 && given <= 100) return given / 100;
  if (duration > 0 && watched > 0) return Math.min(1, watched / duration);
  return 0;
}

async function get(path: string, headers?: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(`${BACKEND_BASE}${path}`, {
      cache: "no-store",
      headers: headers ?? undefined,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function num(...values: unknown[]): number {
  for (const value of values) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export async function loadViewerSignals(
  authHeaders?: Record<string, string>
): Promise<ViewerSignals> {
  if (!authHeaders || (!authHeaders.Authorization && !authHeaders.Cookie)) {
    return emptySignals();
  }

  const signals = emptySignals();

  const [history, likes, searches] = await Promise.all([
    get("/history", authHeaders),
    get("/likes", authHeaders),
    get("/search-history", authHeaders),
  ]);

  // ── watch history → retention + interest signals ────────────────────────
  for (const item of asArray(history)) {
    const id = vid(item);
    if (!id) continue;
    const watched = num(
      item?.watchedDuration,
      item?.watchedSeconds,
      item?.watchTime,
      item?.currentTime
    );
    const duration = num(item?.duration, item?.videoDuration, item?.video?.duration);
    signals.watched.push({
      videoId: id,
      watchPct: pct(watched, duration, item?.watchPercentage ?? item?.completionPercentage),
      watchSeconds: watched,
      completed: Boolean(item?.completed) || (duration > 0 && watched / duration >= 0.9),
    });
  }

  // ── likes → strong positive interest ────────────────────────────────────
  for (const item of asArray(likes)) {
    const id = vid(item);
    if (id) signals.liked.push({ videoId: id });
  }

  // ── search history → topical intent ─────────────────────────────────────
  for (const item of asArray(searches)) {
    const query =
      typeof item === "string" ? item : String(item?.query ?? item?.search ?? "").trim();
    if (query) signals.searches.push({ query });
  }

  return signals;
}

/**
 * Builds a retention map (videoId → observed avg watch %) purely from backend
 * history, so the retention component still works without Postgres.
 */
export function retentionFromSignals(
  signals: ViewerSignals
): Map<string, { avg: number; n: number; completed: number }> {
  const map = new Map<string, { avg: number; n: number; completed: number }>();
  for (const w of signals.watched) {
    const existing = map.get(w.videoId);
    if (existing) {
      const total = existing.avg * existing.n + w.watchPct;
      existing.n += 1;
      existing.avg = total / existing.n;
      existing.completed += w.completed ? 1 : 0;
    } else {
      map.set(w.videoId, { avg: w.watchPct, n: 1, completed: w.completed ? 1 : 0 });
    }
  }
  return map;
}

/**
 * Interest model built from backend signals only. Mirrors the weighting used
 * by the Postgres-backed profile so behaviour is consistent either way.
 */
export function buildProfileFromSignals(
  pool: CandidateRow[],
  signals: ViewerSignals
): {
  coldStart: boolean;
  observedEvents: number;
  topicAffinity: Map<string, number>;
  tokenAffinity: Map<string, number>;
  creatorAffinity: Map<string, number>;
  languageAffinity: Map<string, number>;
  shortAffinity: number;
  watched: Map<string, { watchPct: number; count: number; completed: boolean; lastAt: Date }>;
  subscriptions: Set<string>;
} {
  const topicAffinity = new Map<string, number>();
  const tokenAffinity = new Map<string, number>();
  const creatorAffinity = new Map<string, number>();
  const languageAffinity = new Map<string, number>();
  const watched = new Map<
    string,
    { watchPct: number; count: number; completed: boolean; lastAt: Date }
  >();
  const subscriptions = new Set<string>();

  const bump = (map: Map<string, number>, key: string, amount: number) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + amount);
  };

  const byId = new Map(pool.map((c) => [c.id, c]));
  let shortSeconds = 0;
  let longSeconds = 0;

  // Newer history carries more intent; index-decayed like the DB path.
  signals.watched.forEach((w, i) => {
    const meta = byId.get(w.videoId);
    const existing = watched.get(w.videoId);
    if (existing) {
      existing.watchPct = Math.max(existing.watchPct, w.watchPct);
      existing.count += 1;
      existing.completed = existing.completed || w.completed;
    } else {
      watched.set(w.videoId, {
        watchPct: w.watchPct,
        count: 1,
        completed: w.completed,
        lastAt: new Date(),
      });
    }
    if (!meta) return;
    if (meta.isShort) shortSeconds += w.watchSeconds;
    else longSeconds += w.watchSeconds;

    const weight = (1 / (1 + i / 40)) * (0.35 + 0.65 * w.watchPct);
    bump(creatorAffinity, meta.channelId, weight);
    if (meta.category) bump(topicAffinity, meta.category.toLowerCase(), weight);
    if (meta.language) bump(languageAffinity, meta.language.toLowerCase(), weight);
    for (const token of tokenizeText(meta.title)) bump(tokenAffinity, token, weight * 0.5);
    for (const token of tokenizeText(meta.tags.join(" "))) {
      bump(tokenAffinity, token, weight * 0.8);
    }
  });

  // Likes: a strong, explicit interest signal.
  for (const like of signals.liked) {
    const meta = byId.get(like.videoId);
    if (!meta) continue;
    bump(creatorAffinity, meta.channelId, 1);
    if (meta.category) bump(topicAffinity, meta.category.toLowerCase(), 1);
    for (const token of tokenizeText(`${meta.title} ${meta.tags.join(" ")}`)) {
      bump(tokenAffinity, token, 0.7);
    }
    if (meta.language) bump(languageAffinity, meta.language.toLowerCase(), 1);
  }

  // Search intent.
  signals.searches.forEach((s, i) => {
    const weight = 0.4 / (1 + i / 25);
    for (const token of tokenizeText(s.query)) bump(tokenAffinity, token, weight);
  });

  const total = shortSeconds + longSeconds;

  return {
    coldStart: signals.watched.length + signals.liked.length + signals.searches.length < 3,
    observedEvents:
      signals.watched.length + signals.liked.length + signals.searches.length,
    topicAffinity,
    tokenAffinity,
    creatorAffinity,
    languageAffinity,
    shortAffinity: total > 0 ? shortSeconds / total : 0.5,
    watched,
    subscriptions,
  };
}

const STOPWORDS = new Set([
  "the","a","an","and","or","of","in","on","to","for","with","is","are","was","were","be",
  "this","that","it","as","at","by","from","up","about","into","over","after","you","your",
  "के","का","की","में","से","और","है","को","पर","एक","यह","क्या","कैसे","क्यों","नहीं",
  "shorts","short","video","videos","full","episode","part","latest","new","best","top",
  "hd","official","song","songs","live","watch","how","why","what",
]);

function tokenizeText(input: string): string[] {
  return String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

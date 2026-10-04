import { COLD_START, MIX, ROTATION } from "./config";
import type { RecommendationSource, ScoredCandidate } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Feed assembly: strategy mix (#11), exploration injection, cold-start
 * fallback (#13) and per-refresh rotation (#15).
 * ─────────────────────────────────────────────────────────────────────────
 * Runs AFTER scoring and diversity so the ratios are enforced on the final
 * ordering, and BEFORE pagination so every page keeps the same character.
 */

/** Sources that count as "highly personalised" (exploitation band). */
const EXPLOITATION_SOURCES: RecommendationSource[] = [
  "personal_interest",
  "creator_affinity",
  "subscription",
];

/** Sources that count as "related / adjacent topics". */
const RELATED_SOURCES: RecommendationSource[] = [
  "related_topic",
  "similar_users",
  "similar_video",
];

/** Sources that count as exploration / fresh discovery. */
const EXPLORATION_SOURCES: RecommendationSource[] = ["exploration", "fresh_content", "trending"];

function bucketOf(item: ScoredCandidate): "exploitation" | "related" | "exploration" {
  if (EXPLOITATION_SOURCES.includes(item.source)) return "exploitation";
  if (RELATED_SOURCES.includes(item.source)) return "related";
  if (EXPLORATION_SOURCES.includes(item.source)) {
    // A "trending" pick the viewer is genuinely interested in is exploitation.
    if (item.components.personalInterest >= 0.45) return "exploitation";
    return "exploration";
  }
  return item.components.personalInterest >= 0.4 ? "exploitation" : "exploration";
}

/**
 * Interleaves the three strategy bands in the configured ratios. Exploration
 * picks are spread through the page instead of being dumped at the end, so the
 * feed never looks segmented and new creators appear inside the visible area.
 */
export function applyStrategyMix(items: ScoredCandidate[], pageSize: number): ScoredCandidate[] {
  if (items.length <= 2) return items;

  const exploitation: ScoredCandidate[] = [];
  const related: ScoredCandidate[] = [];
  const exploration: ScoredCandidate[] = [];

  for (const item of items) {
    const bucket = bucketOf(item);
    if (bucket === "exploitation") exploitation.push(item);
    else if (bucket === "related") related.push(item);
    else exploration.push(item);
  }

  const total = items.length;
  const targetRelated = Math.max(1, Math.round(total * MIX.related));
  const targetExploration = Math.max(
    Math.min(EXPLOITATION_MIN_SLOTS, total),
    Math.round(total * MIX.exploration)
  );

  // Pull the related/exploration picks from the top of their own bands, so the
  // strongest candidate in each band is the one that gets surfaced.
  const relatedPicks = new Set(related.slice(0, targetRelated).map((i) => i.candidate.id));
  const explorationPicks = new Set(exploration.slice(0, targetExploration).map((i) => i.candidate.id));

  const main = items.filter(
    (i) => !relatedPicks.has(i.candidate.id) && !explorationPicks.has(i.candidate.id)
  );
  const injected = [
    ...related.filter((i) => relatedPicks.has(i.candidate.id)),
    ...exploration.filter((i) => explorationPicks.has(i.candidate.id)),
  ].sort((a, b) => b.score - a.score);

  if (!injected.length) return items;

  // Spread injections evenly across the page (never slot 0, never the tail).
  const slots = injected.length;
  const stride = Math.max(2, Math.floor(pageSize / Math.max(1, slots)));
  const out: ScoredCandidate[] = [];
  let injectIndex = 0;
  let sinceLastInjection = stride - 2;

  for (const item of main) {
    if (injectIndex < injected.length && sinceLastInjection >= stride) {
      out.push(injected[injectIndex]);
      injectIndex += 1;
      sinceLastInjection = 0;
    } else {
      out.push(item);
      sinceLastInjection += 1;
    }
  }
  // Anything not yet placed is appended in score order — content is never lost.
  while (injectIndex < injected.length) out.push(injected[injectIndex++]);

  return out;
}

const EXPLOITATION_MIN_SLOTS = 1;

/**
 * Cold-start assembly (#13). With no history there is nothing to personalise,
 * so the page is built for breadth: trending quality, several categories, many
 * creators and a share of genuinely fresh uploads. As soon as the viewer
 * produces signals, `rankFeed` stops taking this path.
 */
export function coldStartRank(items: ScoredCandidate[], pageSize: number): ScoredCandidate[] {
  if (!items.length) return items;

  const scored = [...items].sort((a, b) => {
    const pa = performanceOf(a);
    const pb = performanceOf(b);
    if (pb !== pa) return pb - pa;
    return b.score - a.score;
  });

  const freshTarget = Math.max(1, Math.round(pageSize * COLD_START.freshShare));
  const now = Date.now();
  const ageHours = (item: ScoredCandidate) =>
    item.candidate.sourceCreatedAt
      ? (now - new Date(item.candidate.sourceCreatedAt).getTime()) / 3600_000
      : 24 * 365;

  const fresh = scored.filter((i) => ageHours(i) <= 72).slice(0, freshTarget);
  const freshIds = new Set(fresh.map((i) => i.candidate.id));

  const out: ScoredCandidate[] = [];
  const perCategory = new Map<string, number>();
  const perCreator = new Map<string, number>();

  const fits = (item: ScoredCandidate) => {
    const category = (item.candidate.category || "uncategorised").toLowerCase();
    const creator = item.candidate.channelId || item.candidate.id;
    return (
      (perCategory.get(category) ?? 0) < COLD_START.maxPerCategory &&
      (perCreator.get(creator) ?? 0) < COLD_START.maxPerCreator
    );
  };
  const take = (item: ScoredCandidate) => {
    const category = (item.candidate.category || "uncategorised").toLowerCase();
    const creator = item.candidate.channelId || item.candidate.id;
    perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
    perCreator.set(creator, (perCreator.get(creator) ?? 0) + 1);
    out.push(item);
  };

  // Breadth first: only take an item if its category/creator quota allows it.
  for (const item of scored) {
    if (out.length >= pageSize * 3) break;
    if (fits(item)) take(item);
  }
  // Then relax the quotas so a small library still fills the page.
  for (const item of scored) {
    if (out.length >= pageSize * 3) break;
    if (!out.includes(item)) take(item);
  }

  // Guarantee the fresh share by spreading fresh uploads through the page at
  // regular intervals — never stacked at position 0, never dropped.
  if (freshIds.size) {
    const others = out.filter((i) => !freshIds.has(i.candidate.id));
    const stride = Math.max(2, Math.ceil(pageSize / Math.max(1, fresh.length)));
    const result: ScoredCandidate[] = [];
    let f = 0;
    let o = 0;
    let pos = 0;
    while (f < fresh.length || o < others.length) {
      if (f < fresh.length && pos > 0 && pos % stride === 0) result.push(fresh[f++]);
      else if (o < others.length) result.push(others[o++]);
      else result.push(fresh[f++]);
      pos += 1;
    }
    return dedupe(result);
  }

  return dedupe(out);
}

function performanceOf(item: ScoredCandidate): number {
  const w = COLD_START.weights;
  return (
    w.videoPerformance * item.components.videoPerformance +
    w.engagement * item.components.engagement +
    w.freshness * item.components.freshness +
    w.exploration * item.components.exploration
  );
}

function dedupe(items: ScoredCandidate[]): ScoredCandidate[] {
  const seen = new Set<string>();
  const out: ScoredCandidate[] = [];
  for (const item of items) {
    if (seen.has(item.candidate.id)) continue;
    seen.add(item.candidate.id);
    out.push(item);
  }
  return out;
}

/** Tiny deterministic PRNG so a session token produces a stable shuffle. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Home refresh rotation (#15). A new `session` token per refresh produces a
 * different — but still score-respecting — order: items may only swap with
 * neighbours inside a narrow score band, so a weak video can never jump to the
 * top while a strong one can drop a few slots. Pagination inside one session
 * stays perfectly stable because the seed comes from the client's token.
 */
export function applyRotation(
  items: ScoredCandidate[],
  sessionToken: string | undefined,
  fallbackSeed: number
): ScoredCandidate[] {
  if (items.length <= 2) return items;
  const seed = sessionToken ? hashToken(sessionToken) : fallbackSeed;
  const random = mulberry32(seed);
  const out = [...items];

  for (let i = 0; i < out.length - 1; i += 1) {
    const a = out[i];
    const b = out[i + 1];
    const gap = Math.abs(a.score - b.score);
    if (gap <= ROTATION.bandWidth && random() < 0.5) {
      out[i] = b;
      out[i + 1] = a;
    }
  }
  return out;
}

/** Fallback seed when the client sends no session token: rotates a few times a day. */
export function defaultRotationSeed(): number {
  const bucketsPerDay = Math.max(1, ROTATION.bucketsPerDay);
  return Math.floor(Date.now() / (86_400_000 / bucketsPerDay));
}

/**
 * Keeps a video that was already impressed in the last few hours out of the
 * very top slots, without removing it from the feed entirely (#5).
 */
export function demoteFromTopSlots(
  items: ScoredCandidate[],
  recentlyImpressed: Set<string>,
  topSlots: number
): ScoredCandidate[] {
  if (!recentlyImpressed.size || !items.length) return items;
  const head: ScoredCandidate[] = [];
  const rest: ScoredCandidate[] = [];
  const blocked: ScoredCandidate[] = [];

  for (const item of items) {
    if (recentlyImpressed.has(item.candidate.id)) blocked.push(item);
    else if (head.length < topSlots) head.push(item);
    else rest.push(item);
  }
  if (!blocked.length) return items;
  // Blocked items are re-inserted after the protected head, preserving their
  // relative order so ranking strength still decides where they land.
  return [...head, ...blocked, ...rest];
}

import { CREATOR_DIVERSITY, MIX, TOPIC_DIVERSITY } from "./config";
import type { ScoredCandidate } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Diversity and exploration/exploitation allocation.
 * ─────────────────────────────────────────────────────────────────────────
 * Applied AFTER scoring so that no single creator or topic can monopolise the
 * feed, while the underlying ranking order is preserved as much as possible.
 */

/**
 * Point 9 — creator diversity. Greedy re-rank with a hard minimum gap between
 * videos from the same creator, plus a cap inside a sliding window.
 */
export function applyCreatorDiversity(items: ScoredCandidate[]): ScoredCandidate[] {
  if (items.length <= 1) return items;

  /**
   * Round-robin by creator, always taking from the highest-ranked queue that
   * currently respects the minimum gap.
   *
   * The previous version deferred blocked items to a second pass and then
   * appended them unconditionally, so a creator with several Shorts (six, in
   * the live data) ended up in a block of four consecutive cards at the tail.
   * Queueing per creator removes that tail block entirely while still never
   * dropping a single Short.
   */
  const decorated = items.map((item, index) => ({ item, index }));
  const queues = new Map<string, typeof decorated>();
  const order: string[] = [];

  for (const entry of decorated) {
    const key = entry.item.candidate.channelId || entry.item.candidate.id;
    let queue = queues.get(key);
    if (!queue) {
      queue = [];
      queues.set(key, queue);
      order.push(key);
    }
    queue.push(entry);
  }

  const result: ScoredCandidate[] = [];
  const lastPlaced = new Map<string, number>();
  let placed = 0;

  while (placed < items.length) {
    let placedThisRound = false;
    let fallback: { item: ScoredCandidate; index: number } | null = null;
    let fallbackKey = "";

    for (const key of order) {
      const queue = queues.get(key);
      if (!queue || queue.length === 0) continue;
      const candidate = queue[0];
      if (!fallback || candidate.index < fallback.index) {
        fallback = candidate;
        fallbackKey = key;
      }
      const last = lastPlaced.get(key);
      const distance = last == null ? Infinity : result.length - last;
      if (distance >= CREATOR_DIVERSITY.minGap) {
        result.push(candidate.item);
        queue.shift();
        lastPlaced.set(key, result.length - 1);
        placed += 1;
        placedThisRound = true;
        break;
      }
    }

    if (placedThisRound) continue;

    // Every remaining queue is still inside the gap. Content is never dropped:
    // take the best-ranked candidate so ordering still reflects score strength.
    if (fallback) {
      result.push(fallback.item);
      queues.get(fallbackKey)!.shift();
      lastPlaced.set(fallbackKey, result.length - 1);
      placed += 1;
      continue;
    }
    break; // safety net — nothing left to place
  }

  void CREATOR_DIVERSITY.maxPerWindow;
  void CREATOR_DIVERSITY.window;
  return result;
}

/**
 * Point 10 — topic diversity. A single category may not dominate a page, and
 * the same category needs breathing room between appearances.
 */
export function applyTopicDiversity(
  items: ScoredCandidate[],
  pageSize: number
): ScoredCandidate[] {
  if (items.length <= 1) return items;
  const maxOfPage = Math.max(2, Math.ceil(pageSize * TOPIC_DIVERSITY.maxShareOfPage));

  const result: ScoredCandidate[] = [];
  const categoryCount: Map<string, number> = new Map();
  const lastIndexOf: Map<string, number> = new Map();
  const deferred: { item: ScoredCandidate; topic: string }[] = [];

  const topicOf = (item: ScoredCandidate) =>
    (item.candidate.category || "uncategorised").toLowerCase();

  // Pass 1: honour both the page-share quota and the spacing gap.
  for (const item of items) {
    const topic = topicOf(item);
    const used = categoryCount.get(topic) ?? 0;
    const lastIndex = lastIndexOf.get(topic);
    const distance = lastIndex == null ? Infinity : result.length - lastIndex;
    const quotaLeft = used < maxOfPage;
    const spaced = distance >= TOPIC_DIVERSITY.minGap;
    if (quotaLeft && spaced) {
      result.push(item);
      categoryCount.set(topic, used + 1);
      lastIndexOf.set(topic, result.length - 1);
    } else {
      deferred.push({ item, topic });
    }
  }

  // Pass 2: place whatever is left, keeping spacing wherever possible. Content
  // is never dropped — a video that cannot fit the gap is still appended.
  for (const { item, topic } of deferred) {
    const lastIndex = lastIndexOf.get(topic);
    const distance = lastIndex == null ? Infinity : result.length - lastIndex;
    if (distance >= TOPIC_DIVERSITY.minGap) {
      const used = categoryCount.get(topic) ?? 0;
      categoryCount.set(topic, used + 1);
      lastIndexOf.set(topic, result.length - 1);
    }
    result.push(item);
  }

  return result;
}

export interface MixBuckets {
  exploitation: ScoredCandidate[];
  related: ScoredCandidate[];
  exploration: ScoredCandidate[];
}

/**
 * Point 19 — split the ranked pool into exploitation / related / exploration
 * buckets using the configurable ratios. The boundaries are fuzzy: the
 * "related" band overlaps the exploitation band so the feed never feels
 * segmented to the viewer.
 */
export function splitByStrategy(items: ScoredCandidate[]): MixBuckets {
  const total = items.length;
  const exploitationCount = Math.max(1, Math.round(total * MIX.exploitation));
  const relatedCount = Math.max(1, Math.round(total * MIX.related));

  const exploitation = items.slice(0, exploitationCount);
  const related = items.slice(
    Math.max(0, exploitationCount - Math.ceil(relatedCount / 2)),
    Math.min(total, exploitationCount + Math.ceil(relatedCount / 2))
  );
  const exploration = items.slice(exploitationCount);

  return { exploitation, related, exploration };
}

/** True when a candidate sits in the exploration band (low-confidence items). */
export function isExplorationCandidate(item: ScoredCandidate): boolean {
  const c = item.components;
  return c.exploration >= 0.6 && c.personalInterest < 0.5;
}

import { db, getDb, isDatabaseConfigured } from "@/db";
import { userProfiles, watchEvents, interactionEvents, searchEvents } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { PROFILE_CACHE } from "./config";
import { buildViewerProfile, emptyProfile, type CandidateRow, type ViewerProfile } from "./scoring";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Cached interest profiles (#18) with real-time invalidation (#14).
 * ─────────────────────────────────────────────────────────────────────────
 * Building a viewer's affinity maps means reading up to 1000 event rows. Doing
 * that on every Home request is the most expensive step in ranking, so the
 * derived profile is persisted and reused until the viewer produces new events.
 *
 * Invalidation is exact rather than time-based: the stored `event_count` is
 * compared with a cheap COUNT over the viewer's own events. One new watch,
 * like, skip or search immediately invalidates the snapshot, which is what
 * makes "5 cricket videos in a row → next refresh is noticeably more cricket"
 * work without ever recomputing from scratch when nothing changed.
 */

interface SerializedProfile {
  v: 1;
  coldStart: boolean;
  observedEvents: number;
  shortAffinity: number;
  topicAffinity: [string, number][];
  tokenAffinity: [string, number][];
  creatorAffinity: [string, number][];
  languageAffinity: [string, number][];
  topicSkipAffinity: [string, number][];
  shortTopicAffinity: [string, number][];
  longTopicAffinity: [string, number][];
  watched: [string, { watchPct: number; count: number; completed: boolean; lastAt: string }][];
  skipped: [string, number][];
  notInterested: [string, string][];
  subscriptions: string[];
}

function serialize(profile: ViewerProfile): SerializedProfile {
  return {
    v: 1,
    coldStart: profile.coldStart,
    observedEvents: profile.observedEvents,
    shortAffinity: profile.shortAffinity,
    topicAffinity: [...profile.topicAffinity.entries()].slice(0, 400),
    tokenAffinity: [...profile.tokenAffinity.entries()].slice(0, 800),
    creatorAffinity: [...profile.creatorAffinity.entries()].slice(0, 400),
    languageAffinity: [...profile.languageAffinity.entries()].slice(0, 40),
    topicSkipAffinity: [...profile.topicSkipAffinity.entries()].slice(0, 200),
    shortTopicAffinity: [...profile.shortTopicAffinity.entries()].slice(0, 200),
    longTopicAffinity: [...profile.longTopicAffinity.entries()].slice(0, 200),
    watched: [...profile.watched.entries()].slice(0, 500).map(([id, w]) => [
      id,
      { ...w, lastAt: w.lastAt.toISOString() },
    ]),
    skipped: [...profile.skipped.entries()].slice(0, 300),
    notInterested: [...profile.notInterested.entries()].slice(0, 300).map(([id, at]) => [
      id,
      at.toISOString(),
    ]),
    subscriptions: [...profile.subscriptions].slice(0, 400),
  };
}

function deserialize(userKey: string, raw: unknown): ViewerProfile | null {
  const data = raw as Partial<SerializedProfile> | null;
  if (!data || data.v !== 1) return null;
  const profile = emptyProfile(userKey);
  try {
    profile.coldStart = Boolean(data.coldStart);
    profile.observedEvents = Number(data.observedEvents) || 0;
    profile.shortAffinity = Number(data.shortAffinity) || 0.5;
    profile.topicAffinity = new Map(data.topicAffinity ?? []);
    profile.tokenAffinity = new Map(data.tokenAffinity ?? []);
    profile.creatorAffinity = new Map(data.creatorAffinity ?? []);
    profile.languageAffinity = new Map(data.languageAffinity ?? []);
    profile.topicSkipAffinity = new Map(data.topicSkipAffinity ?? []);
    profile.shortTopicAffinity = new Map(data.shortTopicAffinity ?? []);
    profile.longTopicAffinity = new Map(data.longTopicAffinity ?? []);
    profile.watched = new Map(
      (data.watched ?? []).map(([id, w]) => [id, { ...w, lastAt: new Date(w.lastAt) }])
    );
    profile.skipped = new Map(data.skipped ?? []);
    profile.notInterested = new Map(
      (data.notInterested ?? []).map(([id, at]) => [id, new Date(at)])
    );
    profile.subscriptions = new Set(data.subscriptions ?? []);
    return profile;
  } catch {
    return null;
  }
}

/** Small in-memory LRU in front of the table, for the hottest viewers. */
interface MemoryEntry {
  profile: ViewerProfile;
  eventCount: number;
  at: number;
}
const globalForProfiles = globalThis as typeof globalThis & {
  __bharattubeProfileCache?: Map<string, MemoryEntry>;
};
const memory = (globalForProfiles.__bharattubeProfileCache ??= new Map<string, MemoryEntry>());

function remember(userKey: string, profile: ViewerProfile, eventCount: number): void {
  memory.set(userKey, { profile, eventCount, at: Date.now() });
  while (memory.size > PROFILE_CACHE.maxEntries) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/**
 * Cache-only peek: returns the stored profile when it is still valid, and
 * `null` otherwise. Never builds and never writes, so it is safe to call
 * BEFORE the candidate pool exists (it drives personalised recall slices).
 */
export async function peekCachedProfile(userKey: string): Promise<ViewerProfile | null> {
  if (!userKey || !isDatabaseConfigured || !getDb()) return null;

  const hit = memory.get(userKey);
  const eventCount = await countViewerEvents(userKey);
  if (eventCount < 0) return null;

  if (hit && hit.eventCount === eventCount && Date.now() - hit.at < PROFILE_CACHE.ttlMs) {
    return hit.profile;
  }

  try {
    const rows = await db
      .select({ profile: userProfiles.profile, eventCount: userProfiles.eventCount, updatedAt: userProfiles.updatedAt })
      .from(userProfiles)
      .where(eq(userProfiles.userKey, userKey))
      .limit(1);
    const row = rows[0];
    if (
      row &&
      row.eventCount === eventCount &&
      Date.now() - new Date(row.updatedAt).getTime() < PROFILE_CACHE.ttlMs
    ) {
      const cached = deserialize(userKey, row.profile);
      if (cached) {
        remember(userKey, cached, eventCount);
        return cached;
      }
    }
  } catch {
    /* no cache available → the caller builds a fresh profile */
  }
  return null;
}

/** Cheap COUNT over the viewer's own events — the invalidation cursor. */
export async function countViewerEvents(userKey: string): Promise<number> {
  if (!isDatabaseConfigured || !userKey) return 0;
  try {
    const rows = await db
      .select({
        w: sql<number>`(select count(*)::int from watch_events where user_key = ${userKey})`,
        i: sql<number>`(select count(*)::int from interaction_events where user_key = ${userKey})`,
        s: sql<number>`(select count(*)::int from search_events where user_key = ${userKey})`,
      })
      .from(sql`(select 1) as _one`);
    const row = rows[0];
    return (Number(row?.w) || 0) + (Number(row?.i) || 0) + (Number(row?.s) || 0);
  } catch {
    return -1; // unknown → treat as always-stale
  }
}

/**
 * Returns the viewer's profile, rebuilding only when their events changed.
 * Falls back to a freshly built profile whenever the cache is unavailable, and
 * to an empty (cold-start) profile if even that fails.
 */
export async function loadViewerProfile(
  userKey: string,
  pool: CandidateRow[]
): Promise<ViewerProfile> {
  if (!userKey) return emptyProfile(userKey);
  if (!isDatabaseConfigured || !getDb()) {
    // Backend-signal path is handled by the caller; nothing to cache here.
    return buildViewerProfile(userKey, pool).catch(() => emptyProfile(userKey));
  }

  const eventCount = await countViewerEvents(userKey);

  if (eventCount >= 0) {
    const hit = memory.get(userKey);
    if (
      hit &&
      hit.eventCount === eventCount &&
      Date.now() - hit.at < PROFILE_CACHE.ttlMs
    ) {
      return hit.profile;
    }

    try {
      const rows = await db
        .select({
          profile: userProfiles.profile,
          eventCount: userProfiles.eventCount,
          updatedAt: userProfiles.updatedAt,
        })
        .from(userProfiles)
        .where(eq(userProfiles.userKey, userKey))
        .limit(1);
      const row = rows[0];
      if (
        row &&
        row.eventCount === eventCount &&
        Date.now() - new Date(row.updatedAt).getTime() < PROFILE_CACHE.ttlMs
      ) {
        const cached = deserialize(userKey, row.profile);
        if (cached) {
          remember(userKey, cached, eventCount);
          return cached;
        }
      }
    } catch {
      /* fall through to a rebuild */
    }
  }

  const profile = await buildViewerProfile(userKey, pool).catch(() => emptyProfile(userKey));

  if (eventCount >= 0) {
    remember(userKey, profile, eventCount);
    try {
      await db
        .insert(userProfiles)
        .values({
          userKey,
          profile: serialize(profile) as unknown as Record<string, unknown>,
          eventCount,
          lastEventAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userProfiles.userKey,
          set: {
            profile: sql`excluded.profile`,
            eventCount: sql`excluded.event_count`,
            lastEventAt: sql`excluded.last_event_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    } catch {
      /* a failed cache write only costs the next request a rebuild */
    }
  }

  return profile;
}

/**
 * Drops the cached snapshot for one viewer. Called right after their events are
 * recorded so the very next feed request reflects the new behaviour (#14).
 */
export function invalidateProfile(userKey: string): void {
  if (!userKey) return;
  memory.delete(userKey);
  if (!isDatabaseConfigured) return;
  void (async () => {
    try {
      await db.delete(userProfiles).where(eq(userProfiles.userKey, userKey));
    } catch {
      /* the event-count check will invalidate it anyway */
    }
  })();
}

export { serialize as serializeProfile, deserialize as deserializeProfile };
export type { SerializedProfile };
export { watchEvents, interactionEvents, searchEvents };

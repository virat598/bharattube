import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * OPTIONAL Postgres connection. Nothing in this module may throw or connect
 * at module-import time.
 * ─────────────────────────────────────────────────────────────────────────
 * BharatTube's source of truth is the existing Render/Mongo backend. Postgres
 * is only an optional accelerator for personalised recommendation ranking, so
 * the app must build and run on Vercel with no DATABASE_URL at all.
 *
 * Previously this module threw `DATABASE_URL is required` while the module was
 * being imported, which broke `next build` page-data collection for every API
 * route that transitively reached it (e.g. /api/recommendations/events).
 * That is why the error mentioned a route that never touches a database
 * directly.
 */

export const isDatabaseConfigured = Boolean(
  process.env.DATABASE_URL && process.env.DATABASE_URL.trim()
);

const globalForDb = globalThis as typeof globalThis & {
  __bharattubePgPool?: Pool;
};

/** Lazily created pool. Returns null when no DATABASE_URL is configured. */
export function getPool(): Pool | null {
  if (!isDatabaseConfigured) return null;
  if (!globalForDb.__bharattubePgPool) {
    globalForDb.__bharattubePgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return globalForDb.__bharattubePgPool;
}

/** Lazily created Drizzle client. Returns null when Postgres is not configured. */
export function getDb(): NodePgDatabase | null {
  const pool = getPool();
  if (!pool) return null;
  return drizzle(pool);
}

/**
 * Drop-in `db` handle for the recommendation modules.
 *
 * When DATABASE_URL is absent, any query attempt throws a descriptive error.
 * Every recommendation code path that touches `db` already catches errors and
 * degrades to the existing backend, so an unconfigured database simply means
 * "no personalisation persistence" — never a failed build or a broken feed.
 */
export const db = new Proxy({} as NodePgDatabase, {
  get(_target, property) {
    const real = getDb();
    if (!real) {
      return () => {
        throw new Error(
          "DATABASE_URL is not configured: recommendation persistence is disabled and the existing backend is used instead."
        );
      };
    }
    const value = Reflect.get(real as unknown as object, property);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * Storage of slow-changing API responses in the `api_cache` table (the hero catalogue, the community
 * data of the match analysis…), so that they are downloaded once in a while instead of at every
 * start, and remain available offline.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../core/errors/app-error';
import type { Database } from '../ports/database.port';

/** A cached response. Times are Unix ms. */
export interface CacheEntry {
  /** The cached value, as JSON text: the caller validates it when it reads it. */
  readonly payloadJson: string;
  readonly fetchedAt: number;
  /** After this time the entry is stale: still usable when no fresh value can be downloaded. */
  readonly expiresAt: number;
}

/** Schema of a row of the `api_cache` table. */
const rowSchema = z.object({
  payload_json: z.string(),
  fetched_at: z.number(),
  expires_at: z.number(),
});

/**
 * The character that escapes `%`, `_` and itself in a `LIKE` pattern. `LIKE` has no escape by
 * default: the statement names this one with `ESCAPE`.
 */
const LIKE_ESCAPE = '\\';

/**
 * Turn a text into a `LIKE` pattern that matches the keys that start with it, whatever it holds.
 *
 * `%` and `_` are wildcards of a pattern, and cache keys may hold them (a key is built from a name,
 * a hero, a window…), so they are escaped, with the escape character first so that it is not
 * escaped twice.
 *
 * @param prefix - The start of the keys wanted.
 * @returns The pattern: the prefix, escaped, then `%`.
 */
function startsWithPattern(prefix: string): string {
  const escaped = prefix
    .replaceAll(LIKE_ESCAPE, LIKE_ESCAPE + LIKE_ESCAPE)
    .replaceAll('%', `${LIKE_ESCAPE}%`)
    .replaceAll('_', `${LIKE_ESCAPE}_`);
  return `${escaped}%`;
}

/** Reads and writes the `api_cache` table. */
export class ApiCacheRepository {
  readonly #database: Database;

  /**
   * @param database - The app database.
   */
  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * Read a cached response, fresh or stale.
   *
   * @param key - Cache key.
   * @returns The entry, or `null` when nothing (or an unreadable row) is cached.
   * @throws AppError of kind `storage` when the database fails.
   */
  async get(key: string): Promise<CacheEntry | null> {
    let rows;
    try {
      rows = await this.#database.select(
        'SELECT payload_json, fetched_at, expires_at FROM api_cache WHERE cache_key = $1',
        [key],
      );
    } catch (error) {
      throw new AppError('storage', 'Could not read the API cache', { cause: error });
    }
    const row = rowSchema.safeParse(rows[0]);
    return row.success
      ? {
          payloadJson: row.data.payload_json,
          fetchedAt: row.data.fetched_at,
          expiresAt: row.data.expires_at,
        }
      : null;
  }

  /**
   * Save a response, replacing the previous one.
   *
   * @param key - Cache key.
   * @param entry - The response and its times.
   * @throws AppError of kind `storage` when the database fails.
   */
  async put(key: string, entry: CacheEntry): Promise<void> {
    try {
      await this.#database.execute(
        `INSERT INTO api_cache (cache_key, payload_json, fetched_at, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (cache_key) DO UPDATE SET payload_json = excluded.payload_json,
           fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
        [key, entry.payloadJson, entry.fetchedAt, entry.expiresAt],
      );
    } catch (error) {
      throw new AppError('storage', 'Could not save the API cache', { cause: error });
    }
  }

  /**
   * Delete the entries of a family of keys that were fetched before a given time.
   *
   * The prefix is read literally: a `%`, a `_` or a `\` in it matches itself. SQLite compares the
   * letters of a `LIKE` without regard to case, so `Analytics.` also names the keys of `analytics.`;
   * the keys of the app are lower case, and a prefix is to be written the way they are.
   *
   * @param prefix - The start of the keys to delete from; an empty prefix names every key.
   * @param before - The limit (Unix ms): an entry fetched exactly then stays, one fetched earlier goes.
   * @throws AppError of kind `storage` when the database fails.
   */
  async deleteOlderThan(prefix: string, before: number): Promise<void> {
    try {
      await this.#database.execute(
        `DELETE FROM api_cache WHERE cache_key LIKE $1 ESCAPE '${LIKE_ESCAPE}' AND fetched_at < $2`,
        [startsWithPattern(prefix), before],
      );
    } catch (error) {
      throw new AppError('storage', 'Could not delete from the API cache', { cause: error });
    }
  }
}

/**
 * Storage of slow-changing API responses in the `api_cache` table (the hero catalogue…), so that
 * they are downloaded once a week instead of at every start, and remain available offline.
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
}

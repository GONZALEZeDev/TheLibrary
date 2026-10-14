/**
 * Storage of the synchronisation state in the `sync_state` table: small JSON values that must
 * survive a restart.
 *
 * - The times of the last match history requests: the politeness budget counts per hour, so
 *   restarting the app must not reset it.
 * - The end of a pause requested by deadlock-api (HTTP 429 or 503).
 * - Per account: the last synchronisation and whether the account is protected (HTTP 403).
 *
 * A value that cannot be read back (damaged, or written by an incompatible version) is logged and
 * replaced by its default: the synchronisation state is never worth blocking the app for.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { MAX_PAUSE_MS } from '../core/deadlock-api/api-response';
import type { AccountId } from '../core/domain/account';
import { AppError } from '../core/errors/app-error';
import {
  accountSyncStateSchema,
  INITIAL_ACCOUNT_SYNC_STATE,
  type AccountSyncState,
} from '../core/sync/sync-status';
import type { Database } from '../ports/database.port';
import type { Logger } from '../ports/logger.port';

/** Key of the times (Unix ms) of the recent match history requests. */
const HISTORY_REQUESTS_KEY = 'api.history_requests';

/** Key of the end (Unix ms) of the pause requested by deadlock-api. */
const API_PAUSE_KEY = 'api.paused_until';

/**
 * Key of the synchronisation state of an account. The key contains the account id: keys are never
 * logged.
 *
 * @param accountId - The account.
 * @returns The key.
 */
function accountKey(accountId: AccountId): string {
  return `account.${String(accountId)}.sync`;
}

/** Schema of a row of the `sync_state` table. */
const rowSchema = z.object({ value_json: z.string() });

/** Reads and writes the `sync_state` table. */
export class SyncStateRepository {
  readonly #database: Database;
  readonly #logger: Logger;
  readonly #now: () => number;

  /**
   * @param database - The app database.
   * @param logger - Where unreadable values are reported.
   * @param now - Current time (Unix ms), written as `updated_at` and bounding a saved pause.
   */
  constructor(database: Database, logger: Logger, now: () => number = Date.now) {
    this.#database = database;
    this.#logger = logger;
    this.#now = now;
  }

  /**
   * The times of the recent match history requests.
   *
   * @returns Unix ms timestamps, possibly older than the budget window.
   */
  getHistoryRequests(): Promise<number[]> {
    return this.#read(HISTORY_REQUESTS_KEY, z.array(z.number()), []);
  }

  /**
   * Replace the times of the recent match history requests.
   *
   * @param timestamps - Unix ms timestamps.
   */
  async setHistoryRequests(timestamps: readonly number[]): Promise<void> {
    await this.#write(HISTORY_REQUESTS_KEY, timestamps);
  }

  /**
   * The end of the pause requested by deadlock-api.
   *
   * No pause lasts more than {@link MAX_PAUSE_MS} from the moment it is saved, so a saved end
   * further ahead means that the system clock moved backwards since: the end is brought back to
   * that bound and saved again, instead of stopping the synchronisation until the clock catches up.
   *
   * @returns Unix ms, or `null` when no pause was requested.
   */
  async getPausedUntil(): Promise<number | null> {
    const pausedUntil = await this.#read(API_PAUSE_KEY, z.number().nullable(), null);
    const latestEnd = this.#now() + MAX_PAUSE_MS;
    if (pausedUntil === null || pausedUntil <= latestEnd) {
      return pausedUntil;
    }
    await this.setPausedUntil(latestEnd);
    return latestEnd;
  }

  /**
   * Save the end of the pause requested by deadlock-api.
   *
   * @param until - Unix ms, or `null` to clear it.
   */
  async setPausedUntil(until: number | null): Promise<void> {
    await this.#write(API_PAUSE_KEY, until);
  }

  /**
   * The synchronisation state of an account.
   *
   * @param accountId - The account.
   * @returns Its state; the initial state when it was never synchronised.
   */
  getAccountState(accountId: AccountId): Promise<AccountSyncState> {
    return this.#read(accountKey(accountId), accountSyncStateSchema, INITIAL_ACCOUNT_SYNC_STATE);
  }

  /**
   * Save the synchronisation state of an account.
   *
   * @param accountId - The account.
   * @param state - Its new state.
   */
  async setAccountState(accountId: AccountId, state: AccountSyncState): Promise<void> {
    await this.#write(accountKey(accountId), state);
  }

  /**
   * Read and validate a value.
   *
   * @param key - Key of the value.
   * @param schema - Schema of the value.
   * @param fallback - Value returned when nothing valid is stored.
   * @returns The stored value, or `fallback`.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #read<T>(key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
    let rows;
    try {
      rows = await this.#database.select('SELECT value_json FROM sync_state WHERE key = $1', [key]);
    } catch (error) {
      throw new AppError('storage', 'Could not read the synchronisation state', { cause: error });
    }
    if (rows.length === 0) {
      return fallback;
    }
    const row = rowSchema.safeParse(rows[0]);
    const value = row.success ? schema.safeParse(parseJson(row.data.value_json)) : null;
    if (value?.success !== true) {
      // The key itself is not logged: it may contain an account id.
      this.#logger.log('warn', 'sync.state', 'Ignored an unreadable synchronisation state value', {
        key: key.startsWith('account.') ? 'account.{account_id}.sync' : key,
      });
      return fallback;
    }
    return value.data;
  }

  /**
   * Save a value.
   *
   * @param key - Key of the value.
   * @param value - JSON-serialisable value.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #write(key: string, value: unknown): Promise<void> {
    try {
      await this.#database.execute(
        `INSERT INTO sync_state (key, value_json, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), this.#now()],
      );
    } catch (error) {
      throw new AppError('storage', 'Could not save the synchronisation state', { cause: error });
    }
  }
}

/**
 * Parse JSON without throwing.
 *
 * @param text - The text to parse.
 * @returns The parsed value, or `undefined` when the text is not JSON.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Storage of the Steam account the user linked to the app, in the one row of the `linked_account`
 * table.
 *
 * The link lives in the same database as the matches it governs, so the two can only be lost
 * together. This repository is the narrow `AccountSource` of the synchronisation (the id of the
 * account to synchronise, or none), and gives the account service what it needs to link, refresh and
 * unlink the account: read the row, replace it, delete it, and subscribe to its changes. The account
 * service is the only writer of the link.
 *
 * The rank of the account (its current badge, and when it was fetched) lives in two more columns of
 * the same row: it is account data, so it goes with the link and never outlives a switch to another
 * account. It is read and written apart from the link, and a write of the rank does not tell the
 * subscribers of the link.
 *
 * A row that cannot be read back (damaged, or written by an incompatible version) is a storage
 * error and never "no account": the app must not take a damaged link for a first launch, which would
 * offer to link an account over the data of the one it forgot. What a reader needs decides how much
 * of the row it validates: the whole account for {@link LinkedAccountRepository.getLinkedAccount},
 * only the account id for {@link LinkedAccountRepository.currentAccountId}, so that a damaged
 * profile (persona name, avatar) never stops what only needs the id. The same rules apply before a
 * write, so the repository never stores an account that it would refuse to read back. Nothing of the
 * account is logged or put in an error (a persona name, an avatar hash or an account id identifies a
 * player): the errors name the column that is wrong and the kind of problem, never its value.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import {
  AVATAR_HASH_PATTERN,
  MAX_AVATAR_BASE64_LENGTH,
  MAX_PERSONA_NAME_LENGTH,
  type LinkedAccount,
} from '../core/account/linked-account';
import { parseAccountId, type AccountId } from '../core/domain/account';
import { AppError, errorLogContext, toAppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { Database, SqlRow } from '../ports/database.port';
import type { Logger } from '../ports/logger.port';

/** The `id` of the one row of the table (the table refuses any other). */
const LINKED_ACCOUNT_ROW_ID = 1;

/** Reads the account id of the linked account, and nothing else. */
const SELECT_ACCOUNT_ID = 'SELECT account_id FROM linked_account WHERE id = $1';

/** Reads the whole linked account. */
const SELECT_LINKED_ACCOUNT = `SELECT account_id, persona_name, avatar_base64, avatar_hash, linked_at, profile_fetched_at
   FROM linked_account WHERE id = $1`;

/** Reads the rank of the linked account, with the account id that tells whose rank it is. */
const SELECT_RANK =
  'SELECT account_id, rank_badge, rank_fetched_at FROM linked_account WHERE id = $1';

/** Writes the rank of the linked account, only if the row still holds the account it is for. */
const UPDATE_RANK =
  'UPDATE linked_account SET rank_badge = $1, rank_fetched_at = $2 WHERE id = $3 AND account_id = $4';

/** The highest rank badge: sub-rank 6 of tier 11. Equal to the limit in the table. */
const MAX_RANK_BADGE = 116;

/** Schema of the account id column: what {@link parseAccountId} accepts, as a number. */
const accountIdSchema = z
  .int()
  .refine((value): value is AccountId => parseAccountId(value) !== null, {
    message: 'Invalid account id',
  });

/** Schema of the only column `currentAccountId` reads. */
const accountIdRowSchema = z.object({ account_id: accountIdSchema });

/**
 * Schema of the whole row of the `linked_account` table, read from the database or about to be
 * written.
 *
 * The table already refuses most of what this schema refuses, but only this schema knows the format
 * of a hash (lowercase hexadecimal, not just 40 characters), the range of a persona name and what an
 * account id is, and it also guards a row that an older or a newer version of the app wrote.
 */
const rowSchema = z
  .object({
    account_id: accountIdSchema,
    persona_name: z.string().min(1).max(MAX_PERSONA_NAME_LENGTH).nullable(),
    avatar_base64: z.string().max(MAX_AVATAR_BASE64_LENGTH).nullable(),
    avatar_hash: z.string().regex(AVATAR_HASH_PATTERN).nullable(),
    linked_at: z.int(),
    profile_fetched_at: z.int().nullable(),
  })
  .refine((row) => (row.avatar_base64 === null) === (row.avatar_hash === null), {
    // The hash is the one to blame: an avatar cannot be checked or refreshed without it.
    path: ['avatar_hash'],
    message: 'An avatar and its hash go together',
  });

/** Schema of a rank badge (`tier × 10 + sub-rank`, 0 for an unranked player). */
const rankBadgeSchema = z.int().min(0).max(MAX_RANK_BADGE);

/**
 * Schema of the columns {@link LinkedAccountRepository.getRank} reads. The two rank columns are
 * `NULL` until the rank is fetched, and the account id says whose rank they hold.
 */
const rankRowSchema = z.object({
  account_id: accountIdSchema,
  rank_badge: rankBadgeSchema.nullable(),
  rank_fetched_at: z.int().nullable(),
});

/** Schema of the rank {@link LinkedAccountRepository.setRank} is about to write: both columns set. */
const rankToWriteSchema = z.object({
  rank_badge: rankBadgeSchema,
  rank_fetched_at: z.int(),
});

/**
 * The rank of the linked account, as the app last fetched it.
 */
export interface LinkedAccountRank {
  /** The rank badge: `tier × 10 + sub-rank` (0 to 116), 0 when the player is unranked. */
  readonly badge: number;
  /** When the rank was fetched, in Unix milliseconds. */
  readonly fetchedAt: number;
}

/**
 * Validate a row, read from the table or about to be written.
 *
 * @param schema - Schema of the row.
 * @param row - The row.
 * @param message - What is wrong, for the logs.
 * @returns The validated row.
 * @throws AppError of kind `storage` when the row does not match the schema. Its context holds the
 *   column and the kind of problem of the first issue, never the value.
 */
function parseRow<T>(schema: z.ZodType<T>, row: unknown, message: string): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('storage', message, {
      context: { field: issue?.path.map(String).join('.') ?? '', code: issue?.code ?? 'unknown' },
    });
  }
  return parsed.data;
}

/** Reads and writes the `linked_account` table. */
export class LinkedAccountRepository implements AccountSource {
  readonly #database: Database;
  readonly #logger: Logger;
  readonly #listeners = new Set<() => void>();

  /**
   * @param database - The app database.
   * @param logger - Where a failing listener is reported.
   */
  constructor(database: Database, logger: Logger) {
    this.#database = database;
    this.#logger = logger;
  }

  /**
   * The account to synchronise.
   *
   * It reads and validates the account id only, not the profile: the synchronisation, the startup
   * sweep and an unlink need nothing else, so a damaged persona name or avatar must not stop them.
   * A row whose account id is invalid is a storage error all the same, never "no account".
   *
   * @returns Its account id, or `null` when no account is linked.
   * @throws AppError of kind `storage` when the database fails or the account id is invalid.
   */
  async currentAccountId(): Promise<AccountId | null> {
    const row = await this.#readRow(SELECT_ACCOUNT_ID);
    return row === undefined
      ? null
      : parseRow(accountIdRowSchema, row, 'The stored linked account is invalid').account_id;
  }

  /**
   * The linked account, profile included.
   *
   * @returns The account, or `null` when none is linked (a first launch, or after an unlink).
   * @throws AppError of kind `storage` when the database fails or any column of the row is
   *   invalid, the profile included (use {@link LinkedAccountRepository.currentAccountId} when only
   *   the id matters): a row that cannot be read is never reported as "no account".
   */
  async getLinkedAccount(): Promise<LinkedAccount | null> {
    const row = await this.#readRow(SELECT_LINKED_ACCOUNT);
    if (row === undefined) {
      return null;
    }
    const stored = parseRow(rowSchema, row, 'The stored linked account is invalid');
    return {
      accountId: stored.account_id,
      personaName: stored.persona_name,
      avatarBase64: stored.avatar_base64,
      avatarHash: stored.avatar_hash,
      linkedAt: stored.linked_at,
      profileFetchedAt: stored.profile_fetched_at,
    };
  }

  /**
   * The rank of an account, as it was last fetched.
   *
   * It reads the account id and the two rank columns only, not the profile, so that a damaged
   * persona name or avatar never stops the analysis from reading the rank. The rank is account data:
   * it is the rank of the linked account and of no other one.
   *
   * @param accountId - The account whose rank is wanted.
   * @returns Its rank, or `null` when no account is linked, another account is linked, or the rank
   *   was never fetched (either rank column is empty).
   * @throws AppError of kind `storage` when the database fails or the row is invalid (a badge
   *   outside 0 to 116, a time that is not an integer, an invalid account id). Its context names the
   *   column and the kind of problem, never the value.
   */
  async getRank(accountId: AccountId): Promise<LinkedAccountRank | null> {
    const row = await this.#readRow(SELECT_RANK);
    if (row === undefined) {
      return null;
    }
    const stored = parseRow(rankRowSchema, row, 'The stored rank is invalid');
    if (
      stored.account_id !== accountId ||
      stored.rank_badge === null ||
      stored.rank_fetched_at === null
    ) {
      return null;
    }
    return { badge: stored.rank_badge, fetchedAt: stored.rank_fetched_at };
  }

  /**
   * Link an account: insert the row, or replace the account already linked, in one statement.
   * The account is validated against the rules of the read first, so that a row this repository
   * would refuse to read back is never written. The listeners are told once the row is saved.
   *
   * The rank of the row stays when the account is the one already linked (the daily refresh of the
   * profile saves the same account again) and is cleared when it is another one: a switch of
   * account must never carry the rank of the old account over to the new one, which would compare
   * the matches of the new account with the wrong community. A first link has no row to keep a rank
   * from, so both rank columns start empty.
   *
   * @param account - The account to link.
   * @throws AppError of kind `storage` when the account is invalid (an uppercase hash, a persona
   *   name that is too long, an avatar without its hash…) or the database fails or refuses it;
   *   nothing is written and the listeners are not told then.
   */
  async setLinkedAccount(account: LinkedAccount): Promise<void> {
    const row = parseRow(
      rowSchema,
      {
        account_id: account.accountId,
        persona_name: account.personaName,
        avatar_base64: account.avatarBase64,
        avatar_hash: account.avatarHash,
        linked_at: account.linkedAt,
        profile_fetched_at: account.profileFetchedAt,
      },
      'The linked account is invalid',
    );
    await this.#run(
      () =>
        this.#database.execute(
          `INSERT INTO linked_account
             (id, account_id, persona_name, avatar_base64, avatar_hash, linked_at, profile_fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             account_id = excluded.account_id,
             persona_name = excluded.persona_name,
             avatar_base64 = excluded.avatar_base64,
             avatar_hash = excluded.avatar_hash,
             linked_at = excluded.linked_at,
             profile_fetched_at = excluded.profile_fetched_at,
             rank_badge = CASE WHEN linked_account.account_id = excluded.account_id
               THEN linked_account.rank_badge ELSE NULL END,
             rank_fetched_at = CASE WHEN linked_account.account_id = excluded.account_id
               THEN linked_account.rank_fetched_at ELSE NULL END`,
          [
            LINKED_ACCOUNT_ROW_ID,
            row.account_id,
            row.persona_name,
            row.avatar_base64,
            row.avatar_hash,
            row.linked_at,
            row.profile_fetched_at,
          ],
        ),
      'Could not save the linked account',
    );
    this.#notify();
  }

  /**
   * Save the rank of the linked account, in one statement.
   *
   * It writes nothing when the account linked is not `accountId` (it was switched or unlinked while
   * the rank was being fetched): the rank of the old account must not land on the new one. It does
   * not tell the listeners, because the rank is no part of what they read again (the account and its
   * profile).
   *
   * @param accountId - The account the rank is for.
   * @param badge - The rank badge: `tier × 10 + sub-rank`, from 0 (unranked) to 116.
   * @param fetchedAt - When the rank was fetched, in Unix milliseconds.
   * @throws AppError of kind `storage` when the badge is not an integer from 0 to 116, the time is
   *   not an integer, or the database fails or refuses the write; nothing is written then. The
   *   context of an invalid value names the column and the kind of problem, never the value.
   */
  async setRank(accountId: AccountId, badge: number, fetchedAt: number): Promise<void> {
    const rank = parseRow(
      rankToWriteSchema,
      { rank_badge: badge, rank_fetched_at: fetchedAt },
      'The rank is invalid',
    );
    await this.#run(
      () =>
        this.#database.execute(UPDATE_RANK, [
          rank.rank_badge,
          rank.rank_fetched_at,
          LINKED_ACCOUNT_ROW_ID,
          accountId,
        ]),
      'Could not save the rank',
    );
  }

  /**
   * Unlink the account: delete the row, in one statement. The listeners are told once it is
   * deleted, also when no account was linked. The matches of the account are not touched here.
   *
   * @throws AppError of kind `storage` when the database fails; the listeners are not told then.
   */
  async clearLinkedAccount(): Promise<void> {
    await this.#run(
      () =>
        this.#database.execute('DELETE FROM linked_account WHERE id = $1', [LINKED_ACCOUNT_ROW_ID]),
      'Could not clear the linked account',
    );
    this.#notify();
  }

  /**
   * Subscribe to the changes of the linked account, in the shape of `useSyncExternalStore`.
   *
   * @param listener - Called after the account is linked, replaced or unlinked. It reads the
   *   account again if it needs it.
   * @returns A function that unsubscribes the listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Read the one row of the table, as the database returns it (not validated).
   *
   * @param sql - A `SELECT` of columns of the row, with the row id as its one parameter.
   * @returns The row, or `undefined` when no account is linked.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #readRow(sql: string): Promise<SqlRow | undefined> {
    const rows = await this.#run(
      () => this.#database.select(sql, [LINKED_ACCOUNT_ROW_ID]),
      'Could not read the linked account',
    );
    return rows[0];
  }

  /**
   * Tell every listener that the linked account changed. A failing listener is logged and skipped:
   * it must neither fail the write that is already saved nor keep the other listeners uninformed.
   */
  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.log(
          'warn',
          'account',
          'A listener of the linked account failed',
          errorLogContext(toAppError(error)),
        );
      }
    }
  }

  /**
   * Run a database call and wrap its failure in an `AppError` of kind `storage`.
   *
   * @param call - The database call.
   * @param message - Description of the operation, for the logs.
   * @returns The result of the call.
   */
  async #run<T>(call: () => Promise<T>, message: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new AppError('storage', message, { cause: error });
    }
  }
}

/**
 * Storage of the detail status of the matches, in the detail columns of the `matches` table.
 *
 * The detail queue reads it to pick the next match whose detail must be downloaded and writes the
 * outcome of each attempt; the screens read it to count the details by status and to tell where one
 * match stands (with the few fields of the match that its eligibility depends on, so that the
 * caller can apply `isDetailEligible` to it). The rules of the queue live in `core`
 * (`isDetailEligible`, `isRetryDue`, `afterFailedAttempt`): this repository only applies them in
 * SQL, with the same constants and the same comparisons, and never computes a retry delay itself.
 *
 * It never writes the history columns, and the synchronisation of the history never writes the
 * detail columns, so a match that is already archived stays archived when its history is
 * synchronised again. Every row read back is validated, so a damaged database is reported as an
 * error instead of reaching the queue or the screens.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { parseMatchId, type MatchId, type MatchSummary } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import {
  ARCHIVED_GAME_MODE,
  ARCHIVED_MATCH_MODES,
  DETAIL_STATUSES,
  DETAIL_WINDOW_MS,
  MAX_RETRY_DELAY_MS,
  type DetailState,
  type DetailStatus,
} from '../core/match-detail/detail-status';
import type { Database, SqlValue } from '../ports/database.port';

// The statuses the queries name. They are typed as `DetailStatus`, so a status the core does not
// know is a compile error, and they are bound as parameters instead of being written in the SQL.

/** The detail was never fetched, and no attempt failed yet. */
const PENDING: DetailStatus = 'pending';

/** An attempt failed for a reason that may go away; the next one waits for its date. */
const RETRY: DetailStatus = 'retry';

/** The detail is archived. */
const READY: DetailStatus = 'ready';

/** The next match the queue should download the detail of. */
export interface DueMatch {
  readonly matchId: MatchId;
  /** How many attempts were counted as failures so far (0 for a match never tried). */
  readonly attempts: number;
}

/** What the queue stored about the detail of one match, with the fields its eligibility reads. */
export interface StoredDetail {
  readonly status: DetailStatus;
  /** How many attempts were counted as failures so far. */
  readonly attempts: number;
  /** When the next attempt is due, in Unix milliseconds; `null` when none is planned. */
  readonly nextAttemptAt: number | null;
  /** Error code of the last counted failure; `null` when there is none. */
  readonly lastError: string | null;
  /** Size of the archive file in bytes; `null` unless the detail is `ready`. */
  readonly archivedBytes: number | null;
  /**
   * The fields of the match that `isDetailEligible` reads, as the history synchronisation stored
   * them: they tell whether the queue archives this match, whatever its status says.
   */
  readonly match: Pick<MatchSummary, 'heroId' | 'gameMode' | 'matchMode' | 'startTime'>;
}

/** How many of the eligible matches stand in each state of the queue. */
export interface DetailSummary {
  /** Details archived (`ready`). */
  readonly archived: number;
  /** Details still to download (`pending`), or to download again later (`retry`). */
  readonly waiting: number;
  /** Details the queue gave up on after too many failures. */
  readonly unavailable: number;
  /** Details the API answered with but the app cannot use. */
  readonly invalid: number;
}

/** Schema of a stored match id: positive safe integer, as {@link parseMatchId} accepts. */
const matchIdSchema = z.int().refine((value): value is MatchId => parseMatchId(value) !== null, {
  message: 'Invalid match id',
});

/** Schema of a counter of attempts. */
const attemptsSchema = z.int().nonnegative();

/** Schema of the row `nextDue` reads. */
const dueRowSchema = z.object({ match_id: matchIdSchema, detail_attempts: attemptsSchema });

/**
 * Schema of the row `getDetail` reads: the detail columns of the `matches` table, and the history
 * columns the eligibility of the match depends on (validated as `MatchesRepository` validates
 * them).
 */
const detailRowSchema = z.object({
  detail_status: z.enum(DETAIL_STATUSES),
  detail_attempts: attemptsSchema,
  detail_next_attempt_at: z.int().nullable(),
  detail_last_error: z.string().nullable(),
  archived_bytes: z.int().nonnegative().nullable(),
  hero_id: z.int(),
  game_mode: z.int(),
  match_mode: z.int(),
  start_time: z.int(),
});

/** Schema of a row `summary` reads: how many matches have one status. */
const countRowSchema = z.object({
  detail_status: z.enum(DETAIL_STATUSES),
  total: z.int().nonnegative(),
});

/**
 * The values of one statement, with the placeholders that name them.
 *
 * The database port wants `$1`, `$2`… numbered in order of first appearance. Binding a value
 * returns the next placeholder, so a statement written left to right with `${params.bind(…)}` is
 * numbered correctly, and no value is ever written in the SQL text.
 */
class SqlParams {
  /** The values bound so far, to hand to the database with the statement. */
  readonly values: SqlValue[] = [];

  /**
   * Bind a value.
   *
   * @param value - The value.
   * @returns Its placeholder, e.g. `$3` for the third value.
   */
  bind(value: SqlValue): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }

  /**
   * Bind several values, for an `IN (…)` list.
   *
   * @param values - The values; at least one, since `IN ()` is not valid SQL.
   * @returns Their placeholders, separated by commas.
   */
  bindAll(values: Iterable<SqlValue>): string {
    return [...values].map((value) => this.bind(value)).join(', ');
  }
}

/**
 * The `WHERE` conditions that select the matches of a player whose detail is archived: the SQL
 * form of `isDetailEligible`.
 *
 * @param params - The values of the statement, to which the conditions bind theirs.
 * @param accountId - The player.
 * @param now - The current time, in Unix milliseconds.
 * @returns The conditions, to be joined with `AND`.
 */
function eligibleConditions(params: SqlParams, accountId: AccountId, now: number): string {
  // `start_time` is in Unix seconds while `now` and the window are in milliseconds, so the limit
  // is converted to seconds once, here. It stays fractional on purpose: with a `now` that is not a
  // whole second, a match that started on the whole second before the limit is out, exactly as
  // the core's `startTime * 1000 >= now - window` says. A limit that is not a whole second is at
  // least a thousandth away from the nearest one, far more than the rounding error of a double,
  // so the comparison of a whole `start_time` with it cannot differ from the core's.
  // The values are bound in the order the conditions are written, as the port requires.
  return `account_id = ${params.bind(accountId)}
      AND hero_id = ${params.bind(PAIGE_HERO_ID)}
      AND game_mode = ${params.bind(ARCHIVED_GAME_MODE)}
      AND match_mode IN (${params.bindAll(ARCHIVED_MATCH_MODES)})
      AND start_time >= ${params.bind((now - DETAIL_WINDOW_MS) / 1000)}`;
}

/**
 * The `WHERE` condition that selects one match of a player.
 *
 * @param params - The values of the statement, to which the condition binds its own.
 * @param accountId - The player.
 * @param matchId - The match.
 * @returns The condition.
 */
function matchCondition(params: SqlParams, accountId: AccountId, matchId: MatchId): string {
  return `account_id = ${params.bind(accountId)} AND match_id = ${params.bind(matchId)}`;
}

/**
 * Validate a row read from the database.
 *
 * @param schema - Schema of the row.
 * @param row - The row.
 * @param message - What was being read, for the logs.
 * @returns The validated row.
 * @throws AppError of kind `storage` when the row does not match the schema.
 */
function parseRow<T>(schema: z.ZodType<T>, row: unknown, message: string): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Only the field and the kind of problem are kept, never the stored value.
    throw new AppError('storage', message, {
      context: { field: issue?.path.map(String).join('.') ?? '', code: issue?.code ?? 'unknown' },
    });
  }
  return parsed.data;
}

/** Reads and writes the detail columns of the `matches` table. */
export class MatchDetailRepository {
  readonly #database: Database;

  /**
   * @param database - The app database.
   */
  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * The most recent match whose detail is worth downloading now.
   *
   * A match qualifies when it is eligible (`isDetailEligible`) and either `pending`, or `retry`
   * with a date that is due (`isRetryDue`: reached, or so far ahead that only a clock set back can
   * explain it). Among them, the most recent one comes first, and the one with the highest id when
   * two started at the same second.
   *
   * @param accountId - The player.
   * @param now - The current time, in Unix milliseconds.
   * @param excluding - Matches to skip, such as the ones being downloaded already.
   * @returns The match and the attempts counted for it, or `null` when none is due.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async nextDue(
    accountId: AccountId,
    now: number,
    excluding: ReadonlySet<MatchId>,
  ): Promise<DueMatch | null> {
    const params = new SqlParams();
    // `IN ()` is not valid SQL: without matches to skip, the condition is left out.
    const skip = (): string =>
      excluding.size === 0 ? '' : `AND match_id NOT IN (${params.bindAll(excluding)})`;
    // The placeholders are numbered as the text is read, so each part is written after the one
    // that precedes it.
    const sql = `SELECT match_id, detail_attempts FROM matches
       WHERE ${eligibleConditions(params, accountId, now)}
         AND (detail_status = ${params.bind(PENDING)}
              OR (detail_status = ${params.bind(RETRY)}
                  AND (detail_next_attempt_at IS NULL
                       OR detail_next_attempt_at <= ${params.bind(now)}
                       OR detail_next_attempt_at > ${params.bind(now + MAX_RETRY_DELAY_MS)})))
         ${skip()}
       ORDER BY start_time DESC, match_id DESC LIMIT 1`;
    const rows = await this.#run(
      () => this.#database.select(sql, params.values),
      'Could not read the next match to download',
    );
    const [row] = rows;
    if (row === undefined) {
      return null;
    }
    const due = parseRow(dueRowSchema, row, 'A stored detail state is invalid');
    return { matchId: due.match_id, attempts: due.detail_attempts };
  }

  /**
   * What the queue stored about the detail of a match, with the fields of the match that its
   * eligibility depends on.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @returns Its detail state, or `null` when the match is not stored.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async getDetail(accountId: AccountId, matchId: MatchId): Promise<StoredDetail | null> {
    const params = new SqlParams();
    const sql = `SELECT detail_status, detail_attempts, detail_next_attempt_at, detail_last_error,
              archived_bytes, hero_id, game_mode, match_mode, start_time
       FROM matches WHERE ${matchCondition(params, accountId, matchId)}`;
    const rows = await this.#run(
      () => this.#database.select(sql, params.values),
      'Could not read the detail state of a match',
    );
    const [row] = rows;
    if (row === undefined) {
      return null;
    }
    const stored = parseRow(detailRowSchema, row, 'A stored detail state is invalid');
    return {
      status: stored.detail_status,
      attempts: stored.detail_attempts,
      nextAttemptAt: stored.detail_next_attempt_at,
      lastError: stored.detail_last_error,
      archivedBytes: stored.archived_bytes,
      match: {
        heroId: stored.hero_id,
        gameMode: stored.game_mode,
        matchMode: stored.match_mode,
        startTime: stored.start_time,
      },
    };
  }

  /**
   * Record that the detail of a match is archived. The failures counted before are forgotten.
   * Nothing happens when the match is not stored.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @param archivedBytes - Size of the archive file, in bytes.
   * @throws AppError of kind `storage` when the database fails.
   */
  async markReady(accountId: AccountId, matchId: MatchId, archivedBytes: number): Promise<void> {
    const params = new SqlParams();
    const sql = `UPDATE matches
       SET detail_status = ${params.bind(READY)}, detail_attempts = 0,
           detail_next_attempt_at = NULL, detail_last_error = NULL,
           archived_bytes = ${params.bind(archivedBytes)}
       WHERE ${matchCondition(params, accountId, matchId)}`;
    await this.#run(
      () => this.#database.execute(sql, params.values),
      'Could not record an archived match',
    );
  }

  /**
   * Record the outcome of an attempt that counted as a failure (see `afterFailedAttempt`). The
   * state is stored as given; the archive size is left alone, since an archive is recorded by
   * {@link MatchDetailRepository.markReady}. Nothing happens when the match is not stored.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @param state - The new state of the detail, computed by the core.
   * @throws AppError of kind `storage` when the database fails.
   */
  async saveState(accountId: AccountId, matchId: MatchId, state: DetailState): Promise<void> {
    const params = new SqlParams();
    const sql = `UPDATE matches
       SET detail_status = ${params.bind(state.status)},
           detail_attempts = ${params.bind(state.attempts)},
           detail_next_attempt_at = ${params.bind(state.nextAttemptAt)},
           detail_last_error = ${params.bind(state.lastError)}
       WHERE ${matchCondition(params, accountId, matchId)}`;
    await this.#run(
      () => this.#database.execute(sql, params.values),
      'Could not save the detail state of a match',
    );
  }

  /**
   * Put a match back in the queue as if it was never tried: its failures and its archive size are
   * forgotten. Nothing happens when the match is not stored.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @throws AppError of kind `storage` when the database fails.
   */
  async resetToPending(accountId: AccountId, matchId: MatchId): Promise<void> {
    const params = new SqlParams();
    const sql = `UPDATE matches
       SET detail_status = ${params.bind(PENDING)}, detail_attempts = 0,
           detail_next_attempt_at = NULL, detail_last_error = NULL, archived_bytes = NULL
       WHERE ${matchCondition(params, accountId, matchId)}`;
    await this.#run(
      () => this.#database.execute(sql, params.values),
      'Could not reset the detail state of a match',
    );
  }

  /**
   * Count the eligible matches of a player by state of the queue. The matches the queue never
   * archives (Street Brawl, private lobbies, other heroes, older than 90 days) are not counted,
   * whatever their status.
   *
   * @param accountId - The player.
   * @param now - The current time, in Unix milliseconds.
   * @returns The counts; `waiting` adds the `pending` and the `retry` matches.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async summary(accountId: AccountId, now: number): Promise<DetailSummary> {
    const params = new SqlParams();
    const sql = `SELECT detail_status, COUNT(*) AS total FROM matches
       WHERE ${eligibleConditions(params, accountId, now)}
       GROUP BY detail_status`;
    const rows = await this.#run(
      () => this.#database.select(sql, params.values),
      'Could not count the details',
    );
    // A status with no match has no row: every status starts at zero, and the record type makes
    // the compiler refuse a status the core adds without a count here.
    const counts: Record<DetailStatus, number> = {
      pending: 0,
      retry: 0,
      ready: 0,
      unavailable: 0,
      invalid: 0,
    };
    for (const row of rows) {
      const { detail_status: status, total } = parseRow(
        countRowSchema,
        row,
        'A stored detail count is invalid',
      );
      counts[status] = total;
    }
    return {
      archived: counts.ready,
      waiting: counts.pending + counts.retry,
      unavailable: counts.unavailable,
      invalid: counts.invalid,
    };
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

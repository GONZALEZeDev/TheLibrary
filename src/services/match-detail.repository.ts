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
import { matchIdSchema, type MatchId, type MatchSummary } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import { ARCHIVE_FORMAT, type ArchiveFormat } from '../core/match-detail/archive-envelope';
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

/** The detail was archived, but its file was removed to free space. */
const EVICTED: DetailStatus = 'evicted';

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
  /**
   * Size of the archive file in bytes; `null` unless the detail is `ready`, or `evicted` (the size
   * of the file that was removed).
   */
  readonly archivedBytes: number | null;
  /**
   * Format of the archive file: `2` for a current one, `1` for a format-1 file whose refresh
   * failed for good, and `null` for a file written before the format was recorded (a format-1 file
   * that was never tried for a refresh) or when the detail is neither `ready` nor `evicted`.
   */
  readonly archiveFormat: ArchiveFormat | null;
  /**
   * The fields of the match that `isDetailEligible` reads, as the history synchronisation stored
   * them: they tell whether the queue archives this match, whatever its status says.
   */
  readonly match: Pick<MatchSummary, 'heroId' | 'gameMode' | 'matchMode' | 'startTime'>;
}

/** How many of the Paige matches stand in each state of the queue. */
export interface DetailSummary {
  /** Details archived (`ready`), whatever the age of the match: an archive outlives the window. */
  readonly archived: number;
  /** Details still to download (`pending`), or to download again later (`retry`), in the window. */
  readonly waiting: number;
  /** Details the queue gave up on after too many failures, in the window. */
  readonly unavailable: number;
  /** Details the API answered with but the app cannot use, in the window. */
  readonly invalid: number;
  /** Details archived once whose file was removed to free space (`evicted`), in the window. */
  readonly evicted: number;
}

/** An archive the storage may remove to free space, with the size it frees. */
export interface EvictionCandidate {
  /** The match whose archive file may be removed. */
  readonly matchId: MatchId;
  /** Size of its archive file, in bytes. */
  readonly archivedBytes: number;
}

/** Schema of a counter of attempts. */
const attemptsSchema = z.int().nonnegative();

/** Schema of the format of an archive file: the formats the app reads, or none recorded. */
const archiveFormatSchema = z.union([z.literal(1), z.literal(2)]).nullable();

/** Schema of the row `nextDue` and `nextStale` read. */
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
  archive_format: archiveFormatSchema,
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

/** Schema of a size of archive file, in bytes. */
const bytesSchema = z.int().nonnegative();

/** Schema of a row `listEvictionCandidates` reads. */
const candidateRowSchema = z.object({ match_id: matchIdSchema, archived_bytes: bytesSchema });

/** Schema of the row `sumArchivedBytes` reads. */
const totalBytesRowSchema = z.object({ total: bytesSchema });

/** Schema of the row `averageArchiveBytes` reads: SQLite's `AVG` is a real, `NULL` over no row. */
const averageBytesRowSchema = z.object({ average: z.number().nonnegative().nullable() });

/** Schema of a row `listReadyMatchIds` reads. */
const matchIdRowSchema = z.object({ match_id: matchIdSchema });

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
 * @param statusKeptPastWindow - A status whose matches are kept whatever their age: the 90 days of
 *   the window do not apply to them, the other conditions do. Without it, the window applies to
 *   every match.
 * @returns The conditions, to be joined with `AND`.
 */
function eligibleConditions(
  params: SqlParams,
  accountId: AccountId,
  now: number,
  statusKeptPastWindow?: DetailStatus,
): string {
  // The values are bound in the order the conditions are written, as the port requires.
  const identity = `account_id = ${params.bind(accountId)}
      AND hero_id = ${params.bind(PAIGE_HERO_ID)}
      AND game_mode = ${params.bind(ARCHIVED_GAME_MODE)}
      AND match_mode IN (${params.bindAll(ARCHIVED_MATCH_MODES)})`;
  // `start_time` is in Unix seconds while `now` and the window are in milliseconds, so the limit
  // is converted to seconds once, here. It stays fractional on purpose: with a `now` that is not a
  // whole second, a match that started on the whole second before the limit is out, exactly as
  // the core's `startTime * 1000 >= now - window` says. A limit that is not a whole second is at
  // least a thousandth away from the nearest one, far more than the rounding error of a double,
  // so the comparison of a whole `start_time` with it cannot differ from the core's.
  const inWindow = `start_time >= ${params.bind((now - DETAIL_WINDOW_MS) / 1000)}`;
  return statusKeptPastWindow === undefined
    ? `${identity}
      AND ${inWindow}`
    : `${identity}
      AND (${inWindow} OR detail_status = ${params.bind(statusKeptPastWindow)})`;
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
    return this.#nextMatch(
      accountId,
      now,
      excluding,
      // `pending`, or `retry` with a date that is due (the SQL form of `isRetryDue`).
      (params) => `(detail_status = ${params.bind(PENDING)}
              OR (detail_status = ${params.bind(RETRY)}
                  AND (detail_next_attempt_at IS NULL
                       OR detail_next_attempt_at <= ${params.bind(now)}
                       OR detail_next_attempt_at > ${params.bind(now + MAX_RETRY_DELAY_MS)})))`,
      'Could not read the next match to download',
    );
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
              archived_bytes, archive_format, hero_id, game_mode, match_mode, start_time
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
      archiveFormat: stored.archive_format,
      match: {
        heroId: stored.hero_id,
        gameMode: stored.game_mode,
        matchMode: stored.match_mode,
        startTime: stored.start_time,
      },
    };
  }

  /**
   * The most recent archived match whose file is of an unknown format: written before the format
   * was recorded, so a format 1 that was never tried for a refresh.
   *
   * A match qualifies when it is eligible (`isDetailEligible`, so within the 90 days) and `ready`
   * with no format recorded. A match marked final ({@link MatchDetailRepository.markRefreshFinal})
   * or archived in the current format has one, so it never comes back. Among them, the most recent
   * one comes first, and the one with the highest id when two started at the same second.
   *
   * @param accountId - The player.
   * @param now - The current time, in Unix milliseconds.
   * @param excluding - Matches to skip, such as the ones being downloaded already.
   * @returns The match, with no attempt counted (a refresh never counts one), or `null` when none
   *   is left to refresh.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async nextStale(
    accountId: AccountId,
    now: number,
    excluding: ReadonlySet<MatchId>,
  ): Promise<DueMatch | null> {
    return this.#nextMatch(
      accountId,
      now,
      excluding,
      // `ready` with no format recorded: a format-1 file never tried for a refresh.
      (params) => `detail_status = ${params.bind(READY)}
         AND archive_format IS NULL`,
      'Could not read the next match to refresh',
    );
  }

  /**
   * Record that the detail of a match is archived. The failures counted before are forgotten.
   * Nothing happens when the match is not stored.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @param archivedBytes - Size of the archive file, in bytes.
   * @param archiveFormat - Format of the archive file.
   * @throws AppError of kind `storage` when the database fails.
   */
  async markReady(
    accountId: AccountId,
    matchId: MatchId,
    archivedBytes: number,
    archiveFormat: ArchiveFormat,
  ): Promise<void> {
    const params = new SqlParams();
    const sql = `UPDATE matches
       SET detail_status = ${params.bind(READY)}, detail_attempts = 0,
           detail_next_attempt_at = NULL, detail_last_error = NULL,
           archived_bytes = ${params.bind(archivedBytes)},
           archive_format = ${params.bind(archiveFormat)}
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
   * Record that the refresh of a format-1 archive failed for good, so that it is never tried
   * again: the match stays `ready`, with its file and its size, and only its format changes.
   * Nothing happens when the match is not stored, or no longer `ready` (reset in the meantime: it
   * has no archive left to record a format for).
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @throws AppError of kind `storage` when the database fails.
   */
  async markRefreshFinal(accountId: AccountId, matchId: MatchId): Promise<void> {
    const params = new SqlParams();
    // The placeholders are numbered as the text is read, so each part is written after the one
    // that precedes it.
    const sql = `UPDATE matches
       SET archive_format = ${params.bind(1)}
       WHERE ${matchCondition(params, accountId, matchId)}
         AND detail_status = ${params.bind(READY)}`;
    await this.#run(
      () => this.#database.execute(sql, params.values),
      'Could not record a refresh that failed for good',
    );
  }

  /**
   * Put a match back in the queue as if it was never tried: its failures, its archive size and its
   * archive format are forgotten. Nothing happens when the match is not stored.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @throws AppError of kind `storage` when the database fails.
   */
  async resetToPending(accountId: AccountId, matchId: MatchId): Promise<void> {
    const params = new SqlParams();
    const sql = `UPDATE matches
       SET detail_status = ${params.bind(PENDING)}, detail_attempts = 0,
           detail_next_attempt_at = NULL, detail_last_error = NULL, archived_bytes = NULL,
           archive_format = NULL
       WHERE ${matchCondition(params, accountId, matchId)}`;
    await this.#run(
      () => this.#database.execute(sql, params.values),
      'Could not reset the detail state of a match',
    );
  }

  /**
   * Record that the archive file of a match was removed to free space: the match goes from `ready`
   * to `evicted`. Its archive size and its format are kept, as the record of what was removed.
   * Nothing happens when the match is not stored, or not `ready` (only an archive can be evicted).
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @returns Whether the match was `ready` and is now `evicted`; `false` when nothing changed, so
   *   that the caller leaves the file of a row someone else changed meanwhile alone.
   * @throws AppError of kind `storage` when the database fails.
   */
  async markEvicted(accountId: AccountId, matchId: MatchId): Promise<boolean> {
    const params = new SqlParams();
    // The placeholders are numbered as the text is read, so each part is written after the one
    // that precedes it.
    const sql = `UPDATE matches
       SET detail_status = ${params.bind(EVICTED)}
       WHERE ${matchCondition(params, accountId, matchId)}
         AND detail_status = ${params.bind(READY)}`;
    // The statement changes one row (the account and the match make the key) or none.
    const changed = await this.#run(
      () => this.#database.execute(sql, params.values),
      'Could not record an evicted archive',
    );
    return changed > 0;
  }

  /**
   * Count the Paige matches of a player by state of the queue, in the one statement.
   *
   * The matches the queue never archives (Street Brawl, private lobbies, other heroes) are not
   * counted, whatever their status. The 90 days of the window apply to the matches still to do or
   * given up on, but not to the archived ones: an archive stays on disk, and is still shown by the
   * list and the match page, once its match is older than 90 days, so the count of the archives
   * keeps it too. An evicted match has no file left, so it is counted apart, within the window like
   * the others.
   *
   * @param accountId - The player.
   * @param now - The current time, in Unix milliseconds.
   * @returns The counts; `waiting` adds the `pending` and the `retry` matches.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async summary(accountId: AccountId, now: number): Promise<DetailSummary> {
    const params = new SqlParams();
    // The `ready` matches are the status kept past the window: their archive outlives it.
    const sql = `SELECT detail_status, COUNT(*) AS total FROM matches
       WHERE ${eligibleConditions(params, accountId, now, READY)}
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
      evicted: 0,
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
      evicted: counts.evicted,
    };
  }

  /**
   * The archives the storage may remove to free space, in the order it removes them: every `ready`
   * match of a player but the `protectedCount` newest `ready` Paige matches, oldest first.
   *
   * Only Paige archives are protected, since only they feed the review and the analysis: an archive
   * of another hero, if one is ever stored, is a candidate whatever its age. Matches are ordered by
   * start time, and by match id when two started at the same second, so the order is total: the
   * protected ones are the last in that order, and the candidates come from its start.
   *
   * @param accountId - The player.
   * @param protectedCount - How many of the newest Paige archives are never candidates: a whole
   *   number, 0 or more.
   * @returns The candidates with the size of their file, oldest first; a `ready` match with no size
   *   recorded counts as 0 bytes, as {@link MatchDetailRepository.sumArchivedBytes} counts it.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async listEvictionCandidates(
    accountId: AccountId,
    protectedCount: number,
  ): Promise<readonly EvictionCandidate[]> {
    const params = new SqlParams();
    // The placeholders are numbered as the text is read, so each part is written after the one
    // that precedes it.
    const sql = `SELECT match_id, COALESCE(archived_bytes, 0) AS archived_bytes FROM matches
       WHERE account_id = ${params.bind(accountId)}
         AND detail_status = ${params.bind(READY)}
         AND match_id NOT IN (
           SELECT match_id FROM matches
           WHERE account_id = ${params.bind(accountId)}
             AND detail_status = ${params.bind(READY)}
             AND hero_id = ${params.bind(PAIGE_HERO_ID)}
           ORDER BY start_time DESC, match_id DESC
           LIMIT ${params.bind(protectedCount)})
       ORDER BY start_time ASC, match_id ASC`;
    const rows = await this.#run(
      () => this.#database.select(sql, params.values),
      'Could not read the archives to evict',
    );
    return rows.map((row) => {
      const candidate = parseRow(candidateRowSchema, row, 'A stored archive size is invalid');
      return { matchId: candidate.match_id, archivedBytes: candidate.archived_bytes };
    });
  }

  /**
   * How many bytes the archive files of a player take: the sizes of the `ready` matches, whatever
   * their hero or age. An evicted match has no file left, so it is not counted.
   *
   * @param accountId - The player.
   * @returns The total, in bytes; 0 without an archive.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async sumArchivedBytes(accountId: AccountId): Promise<number> {
    const params = new SqlParams();
    // `SUM` over no row is `NULL`, hence the `COALESCE`; a row with no size adds nothing.
    const sql = `SELECT COALESCE(SUM(archived_bytes), 0) AS total FROM matches
       WHERE account_id = ${params.bind(accountId)}
         AND detail_status = ${params.bind(READY)}`;
    const rows = await this.#run(
      () => this.#database.select(sql, params.values),
      'Could not sum the archive sizes',
    );
    return parseRow(totalBytesRowSchema, rows[0], 'A stored archive size is invalid').total;
  }

  /**
   * The mean size of an archive file of a player, over the `ready` matches archived in the current
   * format: an older format holds less, so it would make the mean too small.
   *
   * @param accountId - The player.
   * @returns The mean, in bytes (not rounded), or `null` when the player has no archive in the
   *   current format.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async averageArchiveBytes(accountId: AccountId): Promise<number | null> {
    const params = new SqlParams();
    const sql = `SELECT AVG(archived_bytes) AS average FROM matches
       WHERE account_id = ${params.bind(accountId)}
         AND detail_status = ${params.bind(READY)}
         AND archive_format = ${params.bind(ARCHIVE_FORMAT)}`;
    const rows = await this.#run(
      () => this.#database.select(sql, params.values),
      'Could not average the archive sizes',
    );
    return parseRow(averageBytesRowSchema, rows[0], 'A stored archive size is invalid').average;
  }

  /**
   * The matches of a player whose detail is archived (`ready`), whatever their hero or age.
   *
   * @param accountId - The player.
   * @returns Their ids.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async listReadyMatchIds(accountId: AccountId): Promise<ReadonlySet<MatchId>> {
    const params = new SqlParams();
    const sql = `SELECT match_id FROM matches
       WHERE account_id = ${params.bind(accountId)}
         AND detail_status = ${params.bind(READY)}`;
    const rows = await this.#run(
      () => this.#database.select(sql, params.values),
      'Could not read the archived matches',
    );
    return new Set(
      rows.map((row) => parseRow(matchIdRowSchema, row, 'A stored match id is invalid').match_id),
    );
  }

  /**
   * The most recent eligible match of a player whose status qualifies, for
   * {@link MatchDetailRepository.nextDue} and {@link MatchDetailRepository.nextStale}.
   *
   * Both share everything but which statuses qualify and what a failure says: the eligibility
   * (`isDetailEligible`), the matches to skip, the order (the most recent first, and the one with
   * the highest id when two started at the same second), and the validation of the row.
   *
   * @param accountId - The player.
   * @param now - The current time, in Unix milliseconds.
   * @param excluding - Matches to skip, such as the ones being downloaded already.
   * @param statusCondition - Writes the condition on the status (`nextDue`: `pending` or a due
   *   `retry`; `nextStale`: `ready` with no format), binding its values to the given parameters. It
   *   is called after the eligibility conditions are bound and before the matches to skip, the
   *   order in which the text is read.
   * @param message - What a failure of the database says (`nextDue`: the next match to download;
   *   `nextStale`: the next match to refresh).
   * @returns The match and the attempts counted for it, or `null` when none qualifies.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async #nextMatch(
    accountId: AccountId,
    now: number,
    excluding: ReadonlySet<MatchId>,
    statusCondition: (params: SqlParams) => string,
    message: string,
  ): Promise<DueMatch | null> {
    const params = new SqlParams();
    // `IN ()` is not valid SQL: without matches to skip, the condition is left out.
    const skip = (): string =>
      excluding.size === 0 ? '' : `AND match_id NOT IN (${params.bindAll(excluding)})`;
    // The placeholders are numbered as the text is read, so each part is written after the one
    // that precedes it.
    const sql = `SELECT match_id, detail_attempts FROM matches
       WHERE ${eligibleConditions(params, accountId, now)}
         AND ${statusCondition(params)}
         ${skip()}
       ORDER BY start_time DESC, match_id DESC LIMIT 1`;
    const rows = await this.#run(() => this.#database.select(sql, params.values), message);
    const [row] = rows;
    if (row === undefined) {
      return null;
    }
    const next = parseRow(dueRowSchema, row, 'A stored detail state is invalid');
    return { matchId: next.match_id, attempts: next.detail_attempts };
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

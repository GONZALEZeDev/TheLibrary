/**
 * Storage of the values of the match analysis, the metrics and the damage by source, in the
 * `match_projections` and `match_metrics` tables.
 *
 * Analysing a match starts from its archived detail, a large file. The projection reads that file
 * once and keeps its numbers here: one row per projected match (`match_projections`: which version
 * of the metrics produced it, the badge the player had, whether a player left, whether the match
 * could not be analysed at all) and one row per stored value of that match (`match_metrics`: a
 * metric, with a key such as `kda` or `souls_per_min_mid.community_window`, or a damage value, with
 * a key such as `damage_source.<class name>`; and a number or `null`). Neither table is a source of
 * truth: the archive can rebuild both, and the rows of an account are deleted with the rest of its
 * data.
 *
 * The database never holds a transaction across calls (see the database port), so a projection is
 * written in an order that makes an interruption harmless instead of atomic: the projection row,
 * which says the match is done, is taken away first and written last. Every row read back is
 * validated, so a damaged database is reported as an error instead of reaching the analysis. No
 * account id and no value is put in an error: the errors name the column that is wrong and the kind
 * of problem.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { parseAccountId, type AccountId } from '../core/domain/account';
import { matchIdSchema, type MatchId } from '../core/domain/match';
import { MAX_BADGE, MIN_BADGE } from '../core/domain/rank';
import { AppError } from '../core/errors/app-error';
import type { DetailStatus } from '../core/match-detail/detail-status';
import type { Database, SqlRow, SqlValue } from '../ports/database.port';

/** The values of the metrics of one match, by metric key; `null` when the metric was not computed. */
export type MetricValues = ReadonlyMap<string, number | null>;

/** What a projection says about a match, besides its metrics. */
export interface ProjectionRecord {
  /** The version of the metric definitions that produced the metrics. */
  readonly version: number;
  /**
   * The badge the player had in the match, from `MIN_BADGE` to `MAX_BADGE` (`core/domain/rank`);
   * `null` when the match shows none.
   */
  readonly playerBadge: number | null;
  /** Whether a player left the match. */
  readonly hasLeaver: boolean;
  /** Whether the match could not be analysed at all: it has no metrics and is not tried again. */
  readonly failed: boolean;
  /** When the match was projected, in Unix milliseconds. */
  readonly projectedAt: number;
}

/** A stored projection, with the two fields of the match that the analysis needs next to it. */
export interface StoredProjection extends ProjectionRecord {
  readonly matchId: MatchId;
  /** Duration of the match, in seconds (from the `matches` table). */
  readonly durationS: number;
  /** Start of the match, in Unix seconds (from the `matches` table). */
  readonly startTime: number;
}

/** A match played before another one, with its metrics: what the habits of the player are made of. */
export interface PreviousMatch {
  readonly matchId: MatchId;
  /** Duration of the match, in seconds. */
  readonly durationS: number;
  /** The metrics of the match; empty when it has none. */
  readonly values: MetricValues;
}

/** The status of a match whose detail is archived: the only matches that can be projected. */
const READY: DetailStatus = 'ready';

/** Columns written for each metric, in the order of the parameters of a row. */
const METRIC_COLUMNS = ['account_id', 'match_id', 'metric_key', 'value'] as const;

/**
 * Rows written per statement. 50 rows of 4 columns make 200 parameters, far below SQLite's limit
 * (32,766), while the metrics and the damage sources of a match take one or two statements (the
 * same size as the batch of the match history).
 */
const BATCH_SIZE = 50;

/** Schema of a boolean column: 0 or 1, as SQLite has no boolean type. */
const flagSchema = z.union([z.literal(0), z.literal(1)]);

/**
 * Schema of the columns of a projection row that are not a key. It is the rule of both directions:
 * a projection is checked against it before it is written, so that the repository never stores a
 * row that it would refuse to read back.
 */
const projectionRowSchema = z.object({
  projection_version: z.int(),
  player_badge: z.int().min(MIN_BADGE).max(MAX_BADGE).nullable(),
  has_leaver: flagSchema,
  failed: flagSchema,
  projected_at: z.int(),
});

/** Schema of the row `getProjection` reads: the projection, and the match's own two columns. */
const storedProjectionRowSchema = projectionRowSchema.extend({
  duration_s: z.int(),
  start_time: z.int(),
});

/**
 * Schema of a metric of a row, read or about to be written. `z.number()` refuses `NaN` and the
 * infinities: SQLite would keep an infinity, but the desktop driver hands it back as `null`, so the
 * two databases would not agree on what was stored.
 */
const metricRowSchema = z.object({
  metric_key: z.string().min(1),
  value: z.number().nullable(),
});

/** Schema of a row of the metrics of several matches, as `listPrevious` reads them. */
const matchMetricRowSchema = metricRowSchema.extend({ match_id: matchIdSchema });

/** Schema of the row of a match id, which the same shared rule as the match history validates. */
const matchIdRowSchema = z.object({ match_id: matchIdSchema });

/** Schema of a match id and its duration, as `listPrevious` reads them. */
const previousMatchRowSchema = z.object({ match_id: matchIdSchema, duration_s: z.int() });

/** Schema of the row `countAccount` reads. */
const totalRowSchema = z.object({ total: z.int().nonnegative() });

/**
 * Schema of a row `listAccountIds` reads. It only tells a number from anything else: whether the
 * number is a Steam account id is `parseAccountId`'s to say, row by row, so that one damaged row is
 * skipped instead of failing the whole list.
 */
const accountRowSchema = z.object({ account_id: z.int() });

/**
 * Validate a row, read from the database or about to be written.
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

/**
 * Read the match ids of rows that hold one in a `match_id` column, in the order of the rows.
 *
 * @param rows - The rows of a query.
 * @returns The match ids.
 * @throws AppError of kind `storage` when a row holds no valid match id (never the value).
 */
function parseMatchIds(rows: readonly SqlRow[]): MatchId[] {
  return rows.map(
    (row) => parseRow(matchIdRowSchema, row, 'A stored match id is invalid').match_id,
  );
}

/** Reads and writes the `match_projections` and `match_metrics` tables. */
export class MetricsRepository {
  readonly #database: Database;

  /**
   * @param database - The app database.
   */
  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * Save the projection of a match: its metrics, and the row that says it is done. The projection
   * replaces the one stored, if any: a key that the new values do not hold is gone.
   *
   * The writes are four, in this order, because the database offers no transaction across calls:
   * the projection row of the match is deleted, then its old metrics, the new metrics are inserted
   * (in batches of 50), and the projection row is written **last**. The row is what says the match
   * is done, so it is the first thing taken away and the last thing given back: a crash or a
   * failure at any point in between leaves no projection row, whatever version the old one had, and
   * the match needs a projection again: {@link MetricsRepository.listToProject} and
   * {@link MetricsRepository.listToProjectUpTo} list it, so it is projected again at the end of the
   * next synchronisation, or sooner when the page of the match, or of a later match whose window
   * holds it, is opened. A projection row therefore never stands over metrics that were deleted or
   * not all written.
   *
   * The projection and the values are checked before the first write: a projection that the table
   * would refuse, or a value that is not a finite number, leaves everything stored untouched.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @param projection - The projection row.
   * @param values - The metrics of the match; `null` for a metric that could not be computed.
   * @throws AppError of kind `storage` when the projection or a value is invalid (its context names
   *   the column and the kind of problem, never the value), or the database fails.
   */
  async saveProjection(
    accountId: AccountId,
    matchId: MatchId,
    projection: ProjectionRecord,
    values: MetricValues,
  ): Promise<void> {
    const row = parseRow(
      projectionRowSchema,
      {
        projection_version: projection.version,
        player_badge: projection.playerBadge,
        has_leaver: projection.hasLeaver ? 1 : 0,
        failed: projection.failed ? 1 : 0,
        projected_at: projection.projectedAt,
      },
      'The projection is invalid',
    );
    const metrics = [...values].map(([metricKey, value]) =>
      parseRow(metricRowSchema, { metric_key: metricKey, value }, 'A metric is invalid'),
    );

    // 1. The projection row goes first: from now on the match is not done, and it stays so until
    // step 4, however this save ends.
    await this.#run(
      () =>
        this.#database.execute(
          'DELETE FROM match_projections WHERE account_id = $1 AND match_id = $2',
          [accountId, matchId],
        ),
      'Could not delete the old projection of a match',
    );
    // 2. The old metrics of the match: a key that the new values do not hold must be gone.
    await this.#run(
      () =>
        this.#database.execute(
          'DELETE FROM match_metrics WHERE account_id = $1 AND match_id = $2',
          [accountId, matchId],
        ),
      'Could not delete the old metrics of a match',
    );
    // 3. The new metrics, in batches. An upsert, so that saving a match is idempotent: a save that
    // overlaps another one for the same match (or one that is redone) finds rows already there, and
    // replaces their value instead of failing on the primary key.
    for (let start = 0; start < metrics.length; start += BATCH_SIZE) {
      const batch = metrics.slice(start, start + BATCH_SIZE);
      // One `($1, $2, $3, $4)` group per metric: parameters numbered in order of appearance.
      const groups = batch.map((_, index) => {
        const first = index * METRIC_COLUMNS.length;
        return `(${METRIC_COLUMNS.map((__, column) => `$${String(first + column + 1)}`).join(', ')})`;
      });
      await this.#run(
        () =>
          this.#database.execute(
            `INSERT INTO match_metrics (${METRIC_COLUMNS.join(', ')}) VALUES ${groups.join(', ')}
             ON CONFLICT (account_id, match_id, metric_key) DO UPDATE SET value = excluded.value`,
            batch.flatMap((metric): SqlValue[] => [
              accountId,
              matchId,
              metric.metric_key,
              metric.value,
            ]),
          ),
        'Could not save the metrics of a match',
      );
    }
    // 4. The projection row, last: it says that the metrics above are complete.
    await this.#run(
      () =>
        this.#database.execute(
          `INSERT INTO match_projections
             (account_id, match_id, projection_version, player_badge, has_leaver, failed, projected_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (account_id, match_id) DO UPDATE SET
             projection_version = excluded.projection_version,
             player_badge = excluded.player_badge,
             has_leaver = excluded.has_leaver,
             failed = excluded.failed,
             projected_at = excluded.projected_at`,
          [
            accountId,
            matchId,
            row.projection_version,
            row.player_badge,
            row.has_leaver,
            row.failed,
            row.projected_at,
          ],
        ),
      'Could not save the projection of a match',
    );
  }

  /**
   * The matches of a player that are still to project: their detail is archived (`ready`) and they
   * have no projection of this version, because they have none or one of another version. A match
   * whose projection failed is not listed again before the version changes.
   *
   * @param accountId - The player.
   * @param version - The current version of the projection.
   * @returns The match ids, most recent first (the highest id first when two matches started at the
   *   same second).
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async listToProject(accountId: AccountId, version: number): Promise<readonly MatchId[]> {
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT m.match_id
           FROM matches AS m
           LEFT JOIN match_projections AS p
             ON p.account_id = m.account_id AND p.match_id = m.match_id
           WHERE m.account_id = $1 AND m.detail_status = $2
             AND (p.match_id IS NULL OR p.projection_version <> $3)
           ORDER BY m.start_time DESC, m.match_id DESC`,
          [accountId, READY, version],
        ),
      'Could not list the matches to project',
    );
    return parseMatchIds(rows);
  }

  /**
   * The matches to project so that one match can be analysed: the match itself, when it needs a
   * projection, then those of the matches played before it that need one. A match needs a
   * projection when its detail is archived (`ready`) and it has none of this version, because it
   * has none or one of another version; a match whose projection of this version failed does not
   * need one, as in {@link MetricsRepository.listToProject}.
   *
   * The habits of a match are made of the matches played right before it, so `limit` is the size of
   * that window: the `limit` most recent `ready` matches that started strictly before the match (two
   * matches of the same second are not earlier than each other), leaving out the ones that failed
   * with this version, which {@link MetricsRepository.listPrevious} does not count either. The ones
   * of the window that need a projection are listed; the others are in the window all the same, so
   * asking again for a match lists nothing instead of going back further. Once they are projected,
   * `listPrevious` finds the window again, less the matches the analysis could not read.
   *
   * A match whose detail is not archived (or that is not stored) has no window: nothing is
   * listed for it, since the page of such a match shows no analysis.
   *
   * It takes two statements: the match, then the window. The second is not sent when `limit` allows
   * no earlier match.
   *
   * @param accountId - The player.
   * @param matchId - The match to analyse.
   * @param version - The current version of the projection.
   * @param limit - Size of the window of earlier matches; fewer than 1 (or not a whole number)
   *   gives none, so only the match itself.
   * @returns The match itself first (if it needs a projection), then the matches of the window that
   *   need one, most recent first (the highest id first when two matches started at the same
   *   second); empty when `matchId` is not stored for the player or its detail is not archived, or
   *   nothing needs a projection.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async listToProjectUpTo(
    accountId: AccountId,
    matchId: MatchId,
    version: number,
    limit: number,
  ): Promise<readonly MatchId[]> {
    const matchRows = await this.#run(
      () =>
        this.#database.select(
          `SELECT m.match_id
           FROM matches AS m
           LEFT JOIN match_projections AS p
             ON p.account_id = m.account_id AND p.match_id = m.match_id
           WHERE m.account_id = $1 AND m.match_id = $2 AND m.detail_status = $3
             AND (p.match_id IS NULL OR p.projection_version <> $4)`,
          [accountId, matchId, READY, version],
        ),
      'Could not list the match to project',
    );
    const matchIds = parseMatchIds(matchRows);
    // SQLite reads a negative `LIMIT` as "no limit": the whole history must not come back from a
    // limit that is a mistake.
    if (!Number.isInteger(limit) || limit < 1) {
      return matchIds;
    }

    // The window is cut first (the inner query), then the matches of it that need a projection are
    // kept (the outer one): a limit applied after that filter would reach further back every time
    // it is asked. The window is read for an archived match only (`ref.detail_status`), and leaves
    // out the matches that failed with this version, as `listPrevious` does, so that what is
    // projected is exactly what the habits are made of. `$3` and `$4` are used twice: the same
    // parameter, bound once.
    const earlierRows = await this.#run(
      () =>
        this.#database.select(
          `SELECT w.match_id
           FROM (
             SELECT m.account_id, m.match_id, m.start_time, p.projection_version
             FROM matches AS ref
             JOIN matches AS m ON m.account_id = ref.account_id AND m.start_time < ref.start_time
             LEFT JOIN match_projections AS p
               ON p.account_id = m.account_id AND p.match_id = m.match_id
             WHERE ref.account_id = $1 AND ref.match_id = $2 AND ref.detail_status = $3
               AND m.detail_status = $3
               AND (p.match_id IS NULL OR p.projection_version <> $4 OR p.failed = 0)
             ORDER BY m.start_time DESC, m.match_id DESC
             LIMIT $5
           ) AS w
           WHERE w.projection_version IS NULL OR w.projection_version <> $4
           ORDER BY w.start_time DESC, w.match_id DESC`,
          [accountId, matchId, READY, version, limit],
        ),
      'Could not list the earlier matches to project',
    );
    return [...matchIds, ...parseMatchIds(earlierRows)];
  }

  /**
   * The projection of a match, with the duration and the start of the match.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @returns The projection, or `null` when the match has none (or is no longer stored).
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async getProjection(accountId: AccountId, matchId: MatchId): Promise<StoredProjection | null> {
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT p.projection_version, p.player_badge, p.has_leaver, p.failed, p.projected_at,
                  m.duration_s, m.start_time
           FROM match_projections AS p
           JOIN matches AS m ON m.account_id = p.account_id AND m.match_id = p.match_id
           WHERE p.account_id = $1 AND p.match_id = $2`,
          [accountId, matchId],
        ),
      'Could not read the projection of a match',
    );
    const [row] = rows;
    if (row === undefined) {
      return null;
    }
    const stored = parseRow(storedProjectionRowSchema, row, 'A stored projection is invalid');
    return {
      matchId,
      version: stored.projection_version,
      playerBadge: stored.player_badge,
      hasLeaver: stored.has_leaver === 1,
      failed: stored.failed === 1,
      projectedAt: stored.projected_at,
      durationS: stored.duration_s,
      startTime: stored.start_time,
    };
  }

  /**
   * The metrics of a match.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @returns The values by metric key, in the order of the keys; empty when the match has none.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async getValues(accountId: AccountId, matchId: MatchId): Promise<MetricValues> {
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT metric_key, value FROM match_metrics
           WHERE account_id = $1 AND match_id = $2
           ORDER BY metric_key`,
          [accountId, matchId],
        ),
      'Could not read the metrics of a match',
    );
    return new Map(
      rows.map((row) => {
        const metric = parseRow(metricRowSchema, row, 'A stored metric is invalid');
        return [metric.metric_key, metric.value] as const;
      }),
    );
  }

  /**
   * The matches a player played before a match, with their metrics: the habits the match is
   * compared with. Only the matches projected with `version` and not failed count, and only the
   * ones that started strictly before the match.
   *
   * It takes two statements: the matches, then the metrics of all of them (a list of `limit` match
   * ids, which is the size of the habits window and far below the number of parameters SQLite
   * accepts).
   *
   * @param accountId - The player.
   * @param matchId - The match the previous ones are looked up for.
   * @param version - The version of the projection the previous matches must have.
   * @param limit - Maximum number of matches; fewer than 1 (or not a whole number) gives none.
   * @returns The previous matches, most recent first (the highest id first when two matches started
   *   at the same second); empty when `matchId` is not stored.
   * @throws AppError of kind `storage` when the database fails or returns an invalid row.
   */
  async listPrevious(
    accountId: AccountId,
    matchId: MatchId,
    version: number,
    limit: number,
  ): Promise<readonly PreviousMatch[]> {
    // SQLite reads a negative `LIMIT` as "no limit": the whole history must not come back from a
    // limit that is a mistake.
    if (!Number.isInteger(limit) || limit < 1) {
      return [];
    }
    const matchRows = await this.#run(
      () =>
        this.#database.select(
          `SELECT m.match_id, m.duration_s
           FROM matches AS ref
           JOIN matches AS m ON m.account_id = ref.account_id AND m.start_time < ref.start_time
           JOIN match_projections AS p ON p.account_id = m.account_id AND p.match_id = m.match_id
           WHERE ref.account_id = $1 AND ref.match_id = $2
             AND p.projection_version = $3 AND p.failed = 0
           ORDER BY m.start_time DESC, m.match_id DESC
           LIMIT $4`,
          [accountId, matchId, version, limit],
        ),
      'Could not list the previous matches',
    );
    const matches = matchRows.map((row) =>
      parseRow(previousMatchRowSchema, row, 'A stored previous match is invalid'),
    );
    if (matches.length === 0) {
      return [];
    }

    // The values of all the matches in one statement, grouped by match here.
    const placeholders = matches.map((_, index) => `$${String(index + 2)}`);
    const metricRows = await this.#run(
      () =>
        this.#database.select(
          `SELECT match_id, metric_key, value FROM match_metrics
           WHERE account_id = $1 AND match_id IN (${placeholders.join(', ')})
           ORDER BY match_id, metric_key`,
          [accountId, ...matches.map((match) => match.match_id)],
        ),
      'Could not read the metrics of the previous matches',
    );
    const valuesByMatch = new Map<MatchId, Map<string, number | null>>();
    for (const row of metricRows) {
      const metric = parseRow(matchMetricRowSchema, row, 'A stored metric is invalid');
      const values = valuesByMatch.get(metric.match_id) ?? new Map<string, number | null>();
      values.set(metric.metric_key, metric.value);
      valuesByMatch.set(metric.match_id, values);
    }
    return matches.map((match) => ({
      matchId: match.match_id,
      durationS: match.duration_s,
      values: valuesByMatch.get(match.match_id) ?? new Map<string, number | null>(),
    }));
  }

  /**
   * Delete every projection and every metric of a player, in two statements: the projection rows
   * first. An interruption between the two leaves metrics without a projection row, which nothing
   * reads and which {@link MetricsRepository.listAccountIds} still reports, so the next sweep
   * deletes them; the opposite order could leave a row that says "done" over no metrics.
   *
   * @param accountId - The player.
   * @throws AppError of kind `storage` when the database fails.
   */
  async deleteAccount(accountId: AccountId): Promise<void> {
    await this.#run(
      () =>
        this.#database.execute('DELETE FROM match_projections WHERE account_id = $1', [accountId]),
      'Could not delete the projections of the account',
    );
    await this.#run(
      () => this.#database.execute('DELETE FROM match_metrics WHERE account_id = $1', [accountId]),
      'Could not delete the metrics of the account',
    );
  }

  /**
   * Count the rows a player has in the two tables (projection rows and metric rows together): what
   * is left to delete, or to check that it is gone.
   *
   * @param accountId - The player.
   * @returns The number of rows.
   * @throws AppError of kind `storage` when the database fails or returns an unexpected row.
   */
  async countAccount(accountId: AccountId): Promise<number> {
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT (SELECT COUNT(*) FROM match_projections WHERE account_id = $1)
                + (SELECT COUNT(*) FROM match_metrics WHERE account_id = $2) AS total`,
          [accountId, accountId],
        ),
      'Could not count the rows of the account',
    );
    return parseRow(totalRowSchema, rows[0], 'Unexpected result while counting the rows').total;
  }

  /**
   * The accounts that have projections or metrics, whether or not one of them is the linked
   * account: the startup sweep deletes the data of every account but the linked one.
   *
   * A stored account id that is no Steam account id (a damaged database can hold one: the tables do
   * not check the column) is left out instead of failing the list, and is never handed out as an
   * account to delete.
   *
   * @returns Each account id once, lowest first, whichever table holds it.
   * @throws AppError of kind `storage` when the database fails.
   */
  async listAccountIds(): Promise<readonly AccountId[]> {
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT account_id FROM match_projections
           UNION
           SELECT account_id FROM match_metrics
           ORDER BY account_id`,
        ),
      'Could not list the accounts',
    );
    const accountIds: AccountId[] = [];
    for (const row of rows) {
      const parsed = accountRowSchema.safeParse(row);
      const accountId = parsed.success ? parseAccountId(parsed.data.account_id) : null;
      if (accountId !== null) {
        accountIds.push(accountId);
      }
    }
    return accountIds;
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

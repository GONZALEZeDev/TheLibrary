/**
 * Tests of the storage of the metrics of the analysis, on an in-memory database with the real
 * migrations.
 *
 * @packageDocumentation
 */
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { MIGRATIONS, SqlJsDatabase } from '../adapters/dev/sql-js-database.adapter';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { isAppError, type AppError } from '../core/errors/app-error';
import type { Database, SqlRow } from '../ports/database.port';
import { createTestDatabase, matchSummary, testAccountId, testMatchId } from '../test/test-data';
import { LinkedAccountRepository } from './linked-account.repository';
import { MatchesRepository } from './matches.repository';
import { MetricsRepository, type ProjectionRecord } from './metrics.repository';

/** The account of the tests. */
const ACCOUNT_ID = testAccountId(1000001);

/** Another account, whose rows the methods of {@link ACCOUNT_ID} must never reach. */
const OTHER_ACCOUNT_ID = testAccountId(2000001);

/** A third account, for the tests that need three. */
const THIRD_ACCOUNT_ID = testAccountId(2000002);

/** A fourth account, which only an orphan row of the metrics table belongs to. */
const FOURTH_ACCOUNT_ID = testAccountId(2000003);

/** Match ids of the tests: the nth match is `FIRST_MATCH_ID + n`. */
const FIRST_MATCH_ID = 100000001;

/** The projection version the tests ask for. */
const VERSION = 1;

/**
 * The id of the nth match of a test.
 *
 * @param n - The position, from 0.
 * @returns The match id.
 */
function matchId(n: number): MatchId {
  return testMatchId(FIRST_MATCH_ID + n);
}

/**
 * Make the projection of a match: the current version, a ranked Silver-like badge and a clean
 * match, unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The projection.
 */
function projection(overrides: Partial<ProjectionRecord> = {}): ProjectionRecord {
  return {
    version: VERSION,
    playerBadge: 65,
    hasLeaver: false,
    failed: false,
    projectedAt: 1_760_000_000_000,
    ...overrides,
  };
}

/**
 * Make a map of metric values.
 *
 * @param entries - The key and the value of each metric.
 * @returns The map.
 */
function metricValues(
  entries: Readonly<Record<string, number | null>>,
): Map<string, number | null> {
  return new Map(Object.entries(entries));
}

/** A match to seed: the fields the queries read. */
interface SeededMatch {
  readonly n: number;
  readonly accountId?: AccountId;
  readonly startTime: number;
  readonly durationS?: number;
  /** The detail status of the match; `ready` unless given. */
  readonly detailStatus?: string;
}

/**
 * Store matches through the repository of the history, then set their detail status the way the
 * detail queue does.
 *
 * @param database - The database.
 * @param matches - The matches.
 */
async function seedMatches(database: Database, matches: readonly SeededMatch[]): Promise<void> {
  await new MatchesRepository(database).upsertMany(
    matches.map((match) =>
      matchSummary({
        accountId: match.accountId ?? ACCOUNT_ID,
        matchId: FIRST_MATCH_ID + match.n,
        startTime: match.startTime,
        durationS: match.durationS ?? 1_800,
      }),
    ),
  );
  for (const match of matches) {
    await database.execute(
      'UPDATE matches SET detail_status = $1 WHERE account_id = $2 AND match_id = $3',
      [match.detailStatus ?? 'ready', match.accountId ?? ACCOUNT_ID, FIRST_MATCH_ID + match.n],
    );
  }
}

/**
 * The statements a database receives, in order, with the database that records them.
 *
 * @param database - The database to wrap.
 * @returns The wrapper, and the statements it received so far.
 */
function recordStatements(database: Database): {
  readonly database: Database;
  readonly statements: string[];
} {
  const statements: string[] = [];
  return {
    statements,
    database: {
      execute: (sql, params) => {
        statements.push(sql);
        return database.execute(sql, params);
      },
      select: (sql, params) => {
        statements.push(sql);
        return database.select(sql, params);
      },
    },
  };
}

/**
 * Everything an error shows: its message and its context. A test looks in it for a value that must
 * never be there.
 *
 * @param error - The error.
 * @returns The message and the context as one text.
 */
function shownBy(error: AppError): string {
  return `${error.message} ${JSON.stringify(error.context)}`;
}

/**
 * Count the rows of a table, for an account.
 *
 * @param database - The database.
 * @param table - A table with an `account_id` column.
 * @param accountId - The account.
 * @returns The number of rows.
 */
async function countRows(
  database: Database,
  table: 'match_projections' | 'match_metrics',
  accountId: AccountId,
): Promise<number> {
  const rows = await database.select(
    `SELECT COUNT(*) AS total FROM ${table} WHERE account_id = $1`,
    [accountId],
  );
  return Number(rows[0]?.total);
}

describe('MetricsRepository', () => {
  describe('saveProjection, getProjection and getValues', () => {
    it('saves values and the projection, and reads them back', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000, durationS: 1_954 }]);
      const repository = new MetricsRepository(database);
      const values = metricValues({ kda: 3.5, 'souls_per_min_mid.community_window': 812.25 });

      await repository.saveProjection(ACCOUNT_ID, matchId(0), projection(), values);

      await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.toEqual({
        matchId: matchId(0),
        version: VERSION,
        playerBadge: 65,
        hasLeaver: false,
        failed: false,
        projectedAt: 1_760_000_000_000,
        // Joined from the match itself, not stored with the projection.
        durationS: 1_954,
        startTime: 1_700_000_000,
      });
      await expect(repository.getValues(ACCOUNT_ID, matchId(0))).resolves.toEqual(values);
    });

    it('stores the flags as 0 and 1 and reads them back as booleans', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const repository = new MetricsRepository(database);

      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection({ hasLeaver: true, failed: true, playerBadge: null }),
        new Map(),
      );

      await expect(
        database.select('SELECT has_leaver, failed, player_badge FROM match_projections'),
      ).resolves.toEqual([{ has_leaver: 1, failed: 1, player_badge: null }]);
      await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.toMatchObject({
        hasLeaver: true,
        failed: true,
        playerBadge: null,
      });
    });

    it('re-projecting replaces the old keys', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const repository = new MetricsRepository(database);
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection({ version: 1, playerBadge: 65 }),
        metricValues({ kda: 3, retired_metric: 9, kept_metric: 1 }),
      );

      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection({ version: 2, playerBadge: 72, projectedAt: 1_770_000_000_000 }),
        metricValues({ kda: 4, kept_metric: 2, new_metric: 7 }),
      );

      // `retired_metric` is absent from the new map, so it is gone; nothing is left over.
      await expect(repository.getValues(ACCOUNT_ID, matchId(0))).resolves.toEqual(
        metricValues({ kda: 4, kept_metric: 2, new_metric: 7 }),
      );
      await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.toMatchObject({
        version: 2,
        playerBadge: 72,
        projectedAt: 1_770_000_000_000,
      });
      await expect(countRows(database, 'match_projections', ACCOUNT_ID)).resolves.toBe(1);
    });

    it('keeps a NULL value as null', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const repository = new MetricsRepository(database);

      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ kda: null, deaths_per_min: 0, ratio: -1.25 }),
      );

      const values = await repository.getValues(ACCOUNT_ID, matchId(0));
      // A metric that could not be computed stays a row with a NULL value: it is not a missing key
      // and it is not 0.
      expect(values.has('kda')).toBe(true);
      expect(values.get('kda')).toBeNull();
      expect(values.get('deaths_per_min')).toBe(0);
      expect(values.get('ratio')).toBe(-1.25);
    });

    it('saves more values than one statement holds', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const recorder = recordStatements(database);
      const repository = new MetricsRepository(recorder.database);
      const values = new Map<string, number | null>(
        Array.from({ length: 123 }, (_, index) => [`metric_${String(index)}`, index / 4] as const),
      );

      await repository.saveProjection(ACCOUNT_ID, matchId(0), projection(), values);

      await expect(repository.getValues(ACCOUNT_ID, matchId(0))).resolves.toEqual(values);
      // 123 values in batches of 50: three inserts of metrics.
      expect(
        recorder.statements.filter((sql) => sql.includes('INSERT INTO match_metrics')),
      ).toHaveLength(3);
    });

    it('takes the projection row away first and writes it back last', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const recorder = recordStatements(database);
      const repository = new MetricsRepository(recorder.database);

      await repository.saveProjection(ACCOUNT_ID, matchId(0), projection(), metricValues({ a: 1 }));

      // The projection row is what says "done": it goes first and comes back last, so that an
      // interruption anywhere in between leaves the match to project again.
      expect(
        recorder.statements.map((sql) => /(DELETE FROM|INSERT INTO) (\w+)/.exec(sql)?.[0]),
      ).toEqual([
        'DELETE FROM match_projections',
        'DELETE FROM match_metrics',
        'INSERT INTO match_metrics',
        'INSERT INTO match_projections',
      ]);
    });

    it.each([
      'DELETE FROM match_metrics',
      'INSERT INTO match_metrics',
      'INSERT INTO match_projections',
    ])(
      'leaves no projection row when a save over a row of the same version fails at %s',
      async (failingStatement) => {
        const database = createTestDatabase();
        await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
        const repository = new MetricsRepository(database);
        await repository.saveProjection(
          ACCOUNT_ID,
          matchId(0),
          projection({ version: VERSION }),
          metricValues({ kda: 3 }),
        );
        await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([]);
        // One statement of the save fails, as a crash or a full disk would make it.
        const failing: Database = {
          select: (sql, params) => database.select(sql, params),
          execute: (sql, params) =>
            sql.startsWith(failingStatement)
              ? Promise.reject(new Error('disk full'))
              : database.execute(sql, params),
        };

        await expect(
          new MetricsRepository(failing).saveProjection(
            ACCOUNT_ID,
            matchId(0),
            projection({ version: VERSION }),
            metricValues({ kda: 4 }),
          ),
        ).rejects.toMatchObject({ kind: 'storage' });

        // The old row did not stay over metrics that were deleted or not all written: the match
        // has no projection, so it is listed again although the version did not change.
        await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.toBeNull();
        await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([matchId(0)]);
      },
    );

    it('saves over metric rows that are already there instead of failing on them', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      // Another save of the same match writes its row between the delete and the insert of this one.
      const overlapped: Database = {
        select: (sql, params) => database.select(sql, params),
        execute: async (sql, params) => {
          const changed = await database.execute(sql, params);
          if (sql.startsWith('DELETE FROM match_metrics')) {
            await database.execute(
              'INSERT INTO match_metrics (account_id, match_id, metric_key, value) VALUES ($1, $2, $3, $4)',
              [ACCOUNT_ID, matchId(0), 'kda', 100],
            );
          }
          return changed;
        },
      };

      await new MetricsRepository(overlapped).saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ kda: 4, ratio: 0.5 }),
      );

      // The value of the save replaces the row that was in the way.
      await expect(
        new MetricsRepository(database).getValues(ACCOUNT_ID, matchId(0)),
      ).resolves.toEqual(metricValues({ kda: 4, ratio: 0.5 }));
    });

    it('finishes two overlapping saves of the same match', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const repository = new MetricsRepository(database);
      const first = metricValues({ kda: 1, ratio: 0.1, deaths_per_min: 0.2 });
      const second = metricValues({ kda: 2, ratio: 0.3, deaths_per_min: 0.4 });

      // Started together, the two saves interleave their statements on the one database.
      await Promise.all([
        repository.saveProjection(ACCOUNT_ID, matchId(0), projection(), first),
        repository.saveProjection(ACCOUNT_ID, matchId(0), projection(), second),
      ]);

      const values = await repository.getValues(ACCOUNT_ID, matchId(0));
      expect([first, second]).toContainEqual(values);
      await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.not.toBeNull();
      await expect(countRows(database, 'match_projections', ACCOUNT_ID)).resolves.toBe(1);
    });

    it('keeps the rows of each account and each match apart', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [
        { n: 0, startTime: 1_700_000_000 },
        { n: 1, startTime: 1_700_001_000 },
        { n: 0, accountId: OTHER_ACCOUNT_ID, startTime: 1_700_000_000 },
      ]);
      const repository = new MetricsRepository(database);

      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ kda: 1 }),
      );
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(1),
        projection(),
        metricValues({ kda: 2 }),
      );
      await repository.saveProjection(
        OTHER_ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ kda: 3 }),
      );
      // Re-projecting one match leaves the other match and the other account alone.
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ kda: 10 }),
      );

      await expect(repository.getValues(ACCOUNT_ID, matchId(0))).resolves.toEqual(
        metricValues({ kda: 10 }),
      );
      await expect(repository.getValues(ACCOUNT_ID, matchId(1))).resolves.toEqual(
        metricValues({ kda: 2 }),
      );
      await expect(repository.getValues(OTHER_ACCOUNT_ID, matchId(0))).resolves.toEqual(
        metricValues({ kda: 3 }),
      );
    });

    it('answers null for a match without a projection, and an empty map without values', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const repository = new MetricsRepository(database);

      await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.toBeNull();
      await expect(repository.getProjection(ACCOUNT_ID, matchId(9))).resolves.toBeNull();
      await expect(repository.getValues(ACCOUNT_ID, matchId(0))).resolves.toEqual(new Map());
    });

    it('answers null for a projection whose match is no longer stored', async () => {
      const database = createTestDatabase();
      const repository = new MetricsRepository(database);
      // The projection of a match the history no longer holds has no duration to join.
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ kda: 1 }),
      );

      await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.toBeNull();
    });

    it('refuses a value that is not a finite number, and writes nothing', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const repository = new MetricsRepository(database);

      for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
        await expect(
          repository.saveProjection(
            ACCOUNT_ID,
            matchId(0),
            projection(),
            metricValues({ kda: 1, ratio: bad }),
          ),
        ).rejects.toMatchObject({ kind: 'storage' });
      }

      // Neither a value of the map nor the projection row was written.
      await expect(countRows(database, 'match_metrics', ACCOUNT_ID)).resolves.toBe(0);
      await expect(countRows(database, 'match_projections', ACCOUNT_ID)).resolves.toBe(0);
    });

    it('refuses a projection the table would not hold', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_700_000_000 }]);
      const repository = new MetricsRepository(database);

      for (const bad of [
        projection({ playerBadge: 0 }),
        projection({ playerBadge: 117 }),
        projection({ playerBadge: 65.5 }),
        projection({ version: 1.5 }),
      ]) {
        await expect(
          repository.saveProjection(ACCOUNT_ID, matchId(0), bad, metricValues({ kda: 1 })),
        ).rejects.toMatchObject({ kind: 'storage' });
      }
      await expect(countRows(database, 'match_metrics', ACCOUNT_ID)).resolves.toBe(0);
    });

    it('names the column and the code of a refused projection, never its value', async () => {
      const repository = new MetricsRepository(createTestDatabase());

      const error = await repository
        .saveProjection(ACCOUNT_ID, matchId(0), projection({ playerBadge: 987654 }), new Map())
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        kind: 'storage',
        context: { field: 'player_badge', code: 'too_big' },
      });
      expect(isAppError(error) ? shownBy(error) : '').not.toContain('987654');
    });
  });

  describe('listToProject', () => {
    it('lists the ready matches to project, most recent first', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [
        { n: 0, startTime: 1_000 }, // never projected: listed
        { n: 1, startTime: 3_000 }, // projected with an old version: listed
        { n: 2, startTime: 2_000, detailStatus: 'pending' }, // detail not archived: left out
        { n: 3, startTime: 4_000, detailStatus: 'retry' },
        { n: 4, startTime: 5_000, detailStatus: 'unavailable' },
        { n: 5, startTime: 6_000, detailStatus: 'invalid' },
        { n: 6, startTime: 7_000 }, // projected with the current version: left out
        { n: 7, startTime: 8_000 }, // projected with a newer version: listed
        { n: 8, startTime: 9_000 }, // failed with the current version: left out, not retried
        { n: 9, startTime: 3_000 }, // same start time as match 1: the higher id comes first
        { n: 0, accountId: OTHER_ACCOUNT_ID, startTime: 10_000 }, // another account: left out
      ]);
      const repository = new MetricsRepository(database);
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(1),
        projection({ version: 0 }),
        new Map(),
      );
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(6),
        projection({ version: 1 }),
        new Map(),
      );
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(7),
        projection({ version: 2 }),
        new Map(),
      );
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(8),
        projection({ version: 1, failed: true }),
        new Map(),
      );

      await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([
        matchId(7),
        matchId(9),
        matchId(1),
        matchId(0),
      ]);
    });

    it('lists nothing when every ready match is projected with the version', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_000 }]);
      const repository = new MetricsRepository(database);
      await repository.saveProjection(ACCOUNT_ID, matchId(0), projection(), new Map());

      await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([]);
      await expect(repository.listToProject(OTHER_ACCOUNT_ID, VERSION)).resolves.toEqual([]);
    });
  });

  describe('forgetProjection', () => {
    it('forgets a projection so the match is projected again', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [
        { n: 0, startTime: 1_000 },
        { n: 1, startTime: 2_000 },
        { n: 0, accountId: OTHER_ACCOUNT_ID, startTime: 1_000 },
      ]);
      const repository = new MetricsRepository(database);
      for (const [accountId, n] of [
        [ACCOUNT_ID, 0],
        [ACCOUNT_ID, 1],
        [OTHER_ACCOUNT_ID, 0],
      ] as const) {
        await repository.saveProjection(
          accountId,
          matchId(n),
          projection(),
          metricValues({ kda: 2 }),
        );
      }
      await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([]);

      await repository.forgetProjection(ACCOUNT_ID, matchId(0));

      // The match has no projection any more, so the next catch-up projects it again.
      await expect(repository.getProjection(ACCOUNT_ID, matchId(0))).resolves.toBeNull();
      await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([matchId(0)]);
      // Only its projection row is gone: its values stay until the next save replaces them.
      await expect(repository.getValues(ACCOUNT_ID, matchId(0))).resolves.toEqual(
        metricValues({ kda: 2 }),
      );
      // The other match of the account, and the same match of another account, keep theirs.
      await expect(repository.getProjection(ACCOUNT_ID, matchId(1))).resolves.not.toBeNull();
      await expect(repository.getProjection(OTHER_ACCOUNT_ID, matchId(0))).resolves.not.toBeNull();

      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ avoidable_deaths: 1 }),
      );

      // The next save replaces the values whole, and the match is done again.
      await expect(repository.getValues(ACCOUNT_ID, matchId(0))).resolves.toEqual(
        metricValues({ avoidable_deaths: 1 }),
      );
      await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([]);
    });

    it('does nothing for a match that has no projection', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [{ n: 0, startTime: 1_000 }]);
      const repository = new MetricsRepository(database);

      await repository.forgetProjection(ACCOUNT_ID, matchId(0));

      await expect(repository.listToProject(ACCOUNT_ID, VERSION)).resolves.toEqual([matchId(0)]);
    });
  });

  describe('listToProjectUpTo', () => {
    /**
     * Seed the matches and the projections the tests of the projection on demand read; the match to
     * analyse is #7. Its window of earlier archived matches is #5, #3, #2, #11, #10 and #1, from the
     * most recent, and of those #5, #2, #11, #10 and #1 need a projection, in that order.
     *
     * @param database - The database.
     */
    async function seedHistory(database: Database): Promise<void> {
      await seedMatches(database, [
        { n: 1, startTime: 1_000 }, // never projected: needs one
        { n: 2, startTime: 2_000 }, // projected with an old version: needs one
        { n: 3, startTime: 3_000 }, // projected with the version: in the window, done
        { n: 4, startTime: 3_500 }, // failed with the version: not in the window, not retried
        { n: 5, startTime: 3_600 }, // failed with an old version: needs one
        { n: 6, startTime: 4_000, detailStatus: 'pending' }, // detail not archived: not in the window
        { n: 7, startTime: 5_000 }, // the match to analyse
        { n: 8, startTime: 5_000 }, // same start time as the match: not earlier
        { n: 9, startTime: 6_000 }, // later than the match
        { n: 10, startTime: 1_500 },
        { n: 11, startTime: 1_500 }, // same start time as match 10: the higher id comes first
        { n: 1, accountId: OTHER_ACCOUNT_ID, startTime: 500 }, // another account: left out
        { n: 2, accountId: OTHER_ACCOUNT_ID, startTime: 600 },
      ]);
      const repository = new MetricsRepository(database);
      const save = (n: number, record: ProjectionRecord) =>
        repository.saveProjection(ACCOUNT_ID, matchId(n), record, new Map());
      await save(2, projection({ version: 0 }));
      await save(3, projection());
      await save(4, projection({ failed: true }));
      await save(5, projection({ version: 0, failed: true }));
    }

    it('lists the match first, then the earlier ones that need a projection, most recent first', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 10),
      ).resolves.toEqual([
        matchId(7),
        matchId(5),
        matchId(2),
        matchId(11),
        matchId(10),
        matchId(1),
      ]);
    });

    it.each([
      // The window is the `limit` most recent earlier archived matches, whatever their projection:
      // #3 is projected, and still uses up a place of it. #4 failed with the version, as `listPrevious`
      // sees it, so it is not in the window: with a limit of 3 the window is #5, #3 and #2.
      { limit: 1, expected: [7, 5] },
      { limit: 2, expected: [7, 5] },
      { limit: 3, expected: [7, 5, 2] },
      { limit: 4, expected: [7, 5, 2, 11] },
      { limit: 5, expected: [7, 5, 2, 11, 10] },
      { limit: 6, expected: [7, 5, 2, 11, 10, 1] },
      // A window larger than the history reaches every earlier archived match, and no more.
      { limit: 500, expected: [7, 5, 2, 11, 10, 1] },
    ])('lists the match and the window of $limit earlier matches', async ({ limit, expected }) => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, limit),
      ).resolves.toEqual(expected.map(matchId));
    });

    it('lists nothing more when the matches it listed are projected, instead of going further back', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);
      const listed = await repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 3);
      expect(listed).toEqual([matchId(7), matchId(5), matchId(2)]);
      for (const id of listed) {
        await repository.saveProjection(ACCOUNT_ID, id, projection(), new Map());
      }

      // #11, #10 and #1 still need a projection, but they are not in the window of #7.
      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 3),
      ).resolves.toEqual([]);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'lists only the match itself for a limit of %s',
      async (limit) => {
        const database = createTestDatabase();
        await seedHistory(database);
        const repository = new MetricsRepository(database);

        // A negative limit means "no limit" to SQLite: it must not list the whole history.
        await expect(
          repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, limit),
        ).resolves.toEqual([matchId(7)]);
        // And nothing at all when the match does not need a projection either.
        await expect(
          repository.listToProjectUpTo(ACCOUNT_ID, matchId(3), VERSION, limit),
        ).resolves.toEqual([]);
      },
    );

    it('leaves the match out when it is projected with the version or failed with it', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);
      await repository.saveProjection(ACCOUNT_ID, matchId(7), projection(), new Map());

      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 10),
      ).resolves.toEqual([matchId(5), matchId(2), matchId(11), matchId(10), matchId(1)]);

      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(7),
        projection({ failed: true }),
        new Map(),
      );

      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 10),
      ).resolves.toEqual([matchId(5), matchId(2), matchId(11), matchId(10), matchId(1)]);
      // A newer version of the projection asks for all of it again.
      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION + 1, 10),
      ).resolves.toEqual([
        matchId(7),
        matchId(5),
        matchId(4),
        matchId(3),
        matchId(2),
        matchId(11),
        matchId(10),
        matchId(1),
      ]);
    });

    it('lists the window of the projected matches as the habits read it', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      const listed = await repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 4);
      for (const id of listed) {
        await repository.saveProjection(ACCOUNT_ID, id, projection(), new Map());
      }

      // Everything the call listed is now a previous match of #7, and nothing else is: the window
      // of the projection is the window of the habits.
      const previous = await repository.listPrevious(ACCOUNT_ID, matchId(7), VERSION, 4);
      expect(previous.map((match) => match.matchId)).toEqual([
        matchId(5),
        matchId(3),
        matchId(2),
        matchId(11),
      ]);
      expect(listed.slice(1)).toEqual([matchId(5), matchId(2), matchId(11)]);
    });

    it('lists nothing for a match whose detail is not archived', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      // #6 is `pending`: neither the match nor its earlier ones are listed, whatever the limit.
      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(6), VERSION, 10),
      ).resolves.toEqual([]);
      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(6), VERSION, 0),
      ).resolves.toEqual([]);
    });

    it('lists nothing for a match that is not stored', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(500), VERSION, 10),
      ).resolves.toEqual([]);
    });

    it('keeps the matches of each account apart', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      // The match of one account is no match of the other, and each one sees its own earlier ones.
      await expect(
        repository.listToProjectUpTo(OTHER_ACCOUNT_ID, matchId(7), VERSION, 10),
      ).resolves.toEqual([]);
      await expect(
        repository.listToProjectUpTo(OTHER_ACCOUNT_ID, matchId(2), VERSION, 10),
      ).resolves.toEqual([matchId(2), matchId(1)]);
      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(2), VERSION, 10),
      ).resolves.toEqual([matchId(2), matchId(11), matchId(10), matchId(1)]);

      // The other account projects the same two match ids (#2 and #1, which both accounts hold): that
      // says nothing about the matches of ACCOUNT_ID, in the match itself or in its window.
      for (const n of [1, 2]) {
        await repository.saveProjection(OTHER_ACCOUNT_ID, matchId(n), projection(), new Map());
      }
      await expect(
        repository.listToProjectUpTo(OTHER_ACCOUNT_ID, matchId(2), VERSION, 10),
      ).resolves.toEqual([]);
      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(2), VERSION, 10),
      ).resolves.toEqual([matchId(2), matchId(11), matchId(10), matchId(1)]);
    });

    it('asks the database for the earlier matches only when the limit allows some', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const recorder = recordStatements(database);
      const repository = new MetricsRepository(recorder.database);

      await repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 0);
      expect(recorder.statements).toHaveLength(1);

      await repository.listToProjectUpTo(ACCOUNT_ID, matchId(7), VERSION, 5);
      expect(recorder.statements).toHaveLength(3);
    });
  });

  describe('listPrevious', () => {
    /**
     * Seed the matches and the projections the tests of the previous matches read; the match under
     * analysis is #10.
     *
     * @param database - The database.
     */
    async function seedHistory(database: Database): Promise<void> {
      await seedMatches(database, [
        { n: 1, startTime: 1_000, durationS: 1_100 },
        { n: 2, startTime: 2_000, durationS: 1_200 },
        { n: 3, startTime: 3_000, durationS: 1_300 }, // failed: left out
        { n: 4, startTime: 3_500, durationS: 1_400 }, // old version: left out
        { n: 5, startTime: 4_000, durationS: 1_500 }, // not projected: left out
        { n: 6, startTime: 5_000, durationS: 1_600 }, // same start time as the match: left out
        { n: 7, startTime: 6_000, durationS: 1_700 }, // later than the match: left out
        { n: 8, startTime: 4_500, durationS: 1_800 },
        { n: 9, startTime: 2_500, durationS: 1_900 }, // projected, without any value
        { n: 10, startTime: 5_000, durationS: 2_000 }, // the match under analysis
        { n: 1, accountId: OTHER_ACCOUNT_ID, startTime: 500 }, // another account: left out
      ]);
      const repository = new MetricsRepository(database);
      const save = (n: number, record: ProjectionRecord, entries: Record<string, number | null>) =>
        repository.saveProjection(ACCOUNT_ID, matchId(n), record, metricValues(entries));
      await save(1, projection(), { kda: 1, ratio: null });
      await save(2, projection(), { kda: 2 });
      await save(3, projection({ failed: true }), { kda: 3 });
      await save(4, projection({ version: 0 }), { kda: 4 });
      await save(6, projection(), { kda: 6 });
      await save(7, projection(), { kda: 7 });
      await save(8, projection(), { kda: 8, ratio: 0.5 });
      await save(9, projection(), {});
      await save(10, projection(), { kda: 10 });
      await repository.saveProjection(
        OTHER_ACCOUNT_ID,
        matchId(1),
        projection(),
        metricValues({ kda: 99 }),
      );
    }

    it('lists the previous matches by start time', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      const previous = await repository.listPrevious(ACCOUNT_ID, matchId(10), VERSION, 10);

      // Only earlier matches, projected with the version and not failed, most recent first.
      expect(previous).toEqual([
        { matchId: matchId(8), durationS: 1_800, values: metricValues({ kda: 8, ratio: 0.5 }) },
        { matchId: matchId(9), durationS: 1_900, values: new Map() },
        { matchId: matchId(2), durationS: 1_200, values: metricValues({ kda: 2 }) },
        { matchId: matchId(1), durationS: 1_100, values: metricValues({ kda: 1, ratio: null }) },
      ]);
    });

    it('lists at most the limit, the most recent ones', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      const previous = await repository.listPrevious(ACCOUNT_ID, matchId(10), VERSION, 2);

      expect(previous.map((match) => match.matchId)).toEqual([matchId(8), matchId(9)]);
      await expect(repository.listPrevious(ACCOUNT_ID, matchId(10), VERSION, 0)).resolves.toEqual(
        [],
      );
      // A negative limit means "no limit" to SQLite: it must not list the whole history.
      await expect(repository.listPrevious(ACCOUNT_ID, matchId(10), VERSION, -1)).resolves.toEqual(
        [],
      );
    });

    it('lists nothing for a match that is not stored', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const repository = new MetricsRepository(database);

      await expect(repository.listPrevious(ACCOUNT_ID, matchId(500), VERSION, 10)).resolves.toEqual(
        [],
      );
      await expect(
        repository.listPrevious(OTHER_ACCOUNT_ID, matchId(10), VERSION, 10),
      ).resolves.toEqual([]);
    });

    it('asks the database for the values of the matches in one statement', async () => {
      const database = createTestDatabase();
      await seedHistory(database);
      const recorder = recordStatements(database);

      await new MetricsRepository(recorder.database).listPrevious(
        ACCOUNT_ID,
        matchId(10),
        VERSION,
        10,
      );

      // One query for the matches, one for all their values: not one query per match.
      expect(recorder.statements).toHaveLength(2);
    });
  });

  describe('listRecent', () => {
    /**
     * Seed the matches and the projections the tests of the recent matches read. The ones left out
     * are named in a comment; #7 and #6 started at the same second.
     *
     * @param database - The database.
     */
    async function seedRecent(database: Database): Promise<void> {
      await seedMatches(database, [
        { n: 1, startTime: 1_000, durationS: 1_100 },
        { n: 2, startTime: 2_000, durationS: 1_200 },
        { n: 3, startTime: 3_000, durationS: 1_300 }, // failed: left out
        { n: 4, startTime: 3_500, durationS: 1_400 }, // old version: left out
        { n: 5, startTime: 4_000, durationS: 1_500 }, // not projected: left out
        { n: 6, startTime: 5_000, durationS: 1_600 },
        { n: 7, startTime: 5_000, durationS: 1_700 }, // same start time as #6: the higher id first
        { n: 8, startTime: 4_500, durationS: 1_800 },
        { n: 9, startTime: 2_500, durationS: 1_900 }, // projected, without any value
        { n: 10, startTime: 6_000, durationS: 2_000, detailStatus: 'retry' }, // detail not archived
        // Another account's match with the same id, the most recent of all: left out.
        { n: 1, accountId: OTHER_ACCOUNT_ID, startTime: 7_000, durationS: 1_000 },
      ]);
      const repository = new MetricsRepository(database);
      const save = (n: number, record: ProjectionRecord, entries: Record<string, number | null>) =>
        repository.saveProjection(ACCOUNT_ID, matchId(n), record, metricValues(entries));
      await save(1, projection(), { kda: 1, ratio: null });
      await save(2, projection(), { kda: 2 });
      await save(3, projection({ failed: true }), { kda: 3 });
      await save(4, projection({ version: 0 }), { kda: 4 });
      await save(6, projection(), { kda: 6 });
      await save(7, projection(), { kda: 7 });
      await save(8, projection(), { kda: 8, ratio: 0.5 });
      await save(9, projection(), {});
      await save(10, projection(), { kda: 10 });
      await repository.saveProjection(
        OTHER_ACCOUNT_ID,
        matchId(1),
        projection(),
        metricValues({ kda: 99 }),
      );
    }

    it('lists the most recent projected matches with their values', async () => {
      const database = createTestDatabase();
      await seedRecent(database);
      const repository = new MetricsRepository(database);

      const recent = await repository.listRecent(ACCOUNT_ID, VERSION, 10);

      // Most recent first, the highest id first when two matches started at the same second.
      expect(recent).toEqual([
        {
          matchId: matchId(7),
          startTime: 5_000,
          durationS: 1_700,
          values: metricValues({ kda: 7 }),
        },
        {
          matchId: matchId(6),
          startTime: 5_000,
          durationS: 1_600,
          values: metricValues({ kda: 6 }),
        },
        {
          matchId: matchId(8),
          startTime: 4_500,
          durationS: 1_800,
          values: metricValues({ kda: 8, ratio: 0.5 }),
        },
        { matchId: matchId(9), startTime: 2_500, durationS: 1_900, values: new Map() },
        {
          matchId: matchId(2),
          startTime: 2_000,
          durationS: 1_200,
          values: metricValues({ kda: 2 }),
        },
        {
          matchId: matchId(1),
          startTime: 1_000,
          durationS: 1_100,
          values: metricValues({ kda: 1, ratio: null }),
        },
      ]);
    });

    it('lists at most the limit, the most recent ones', async () => {
      const database = createTestDatabase();
      await seedRecent(database);
      const repository = new MetricsRepository(database);

      const ids = async (limit: number): Promise<MatchId[]> =>
        (await repository.listRecent(ACCOUNT_ID, VERSION, limit)).map((match) => match.matchId);

      await expect(ids(1)).resolves.toEqual([matchId(7)]);
      await expect(ids(3)).resolves.toEqual([matchId(7), matchId(6), matchId(8)]);
      // A limit that is a mistake lists nothing; a negative one means "no limit" to SQLite, and
      // must not list the whole history.
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        await expect(ids(limit)).resolves.toEqual([]);
      }
    });

    it('lists only matches of the current version', async () => {
      const database = createTestDatabase();
      await seedRecent(database);
      const repository = new MetricsRepository(database);

      const current = await repository.listRecent(ACCOUNT_ID, VERSION, 10);
      const old = await repository.listRecent(ACCOUNT_ID, 0, 10);

      // #4 alone has the old version; it is not among the matches of the current one.
      expect(current.map((match) => match.matchId)).not.toContain(matchId(4));
      expect(old).toEqual([
        {
          matchId: matchId(4),
          startTime: 3_500,
          durationS: 1_400,
          values: metricValues({ kda: 4 }),
        },
      ]);
      await expect(repository.listRecent(ACCOUNT_ID, VERSION + 1, 10)).resolves.toEqual([]);
    });

    it('leaves failed projections out', async () => {
      const database = createTestDatabase();
      await seedRecent(database);
      const repository = new MetricsRepository(database);

      const recent = await repository.listRecent(ACCOUNT_ID, VERSION, 10);

      // #3 has the current version and stored values, but its projection failed.
      expect(recent.map((match) => match.matchId)).not.toContain(matchId(3));
      expect(recent.some((match) => match.values.get('kda') === 3)).toBe(false);
    });

    it('leaves out the matches whose detail is not archived', async () => {
      const database = createTestDatabase();
      await seedMatches(database, [
        { n: 0, startTime: 1_000 },
        { n: 1, startTime: 2_000, detailStatus: 'pending' },
        { n: 2, startTime: 3_000, detailStatus: 'retry' },
        { n: 3, startTime: 4_000, detailStatus: 'unavailable' },
        { n: 4, startTime: 5_000, detailStatus: 'invalid' },
      ]);
      const repository = new MetricsRepository(database);
      for (let n = 0; n <= 4; n += 1) {
        await repository.saveProjection(
          ACCOUNT_ID,
          matchId(n),
          projection(),
          metricValues({ kda: n }),
        );
      }

      const recent = await repository.listRecent(ACCOUNT_ID, VERSION, 10);

      expect(recent.map((match) => match.matchId)).toEqual([matchId(0)]);
    });

    it('reads nothing for another account', async () => {
      const database = createTestDatabase();
      await seedRecent(database);
      const repository = new MetricsRepository(database);

      // An account with no match gets nothing; the other account gets its own match with its own
      // values, although the first account has a match with the same id.
      await expect(repository.listRecent(THIRD_ACCOUNT_ID, VERSION, 10)).resolves.toEqual([]);
      await expect(repository.listRecent(OTHER_ACCOUNT_ID, VERSION, 10)).resolves.toEqual([
        {
          matchId: matchId(1),
          startTime: 7_000,
          durationS: 1_000,
          values: metricValues({ kda: 99 }),
        },
      ]);
    });

    it('asks the database for the values of the matches in one statement', async () => {
      const database = createTestDatabase();
      await seedRecent(database);
      const recorder = recordStatements(database);

      await new MetricsRepository(recorder.database).listRecent(ACCOUNT_ID, VERSION, 10);

      // One query for the matches, one for all their values: not one query per match.
      expect(recorder.statements).toHaveLength(2);
    });

    it('reads no values when there is no match to read them for', async () => {
      const database = createTestDatabase();
      await seedRecent(database);
      const recorder = recordStatements(database);
      const repository = new MetricsRepository(recorder.database);

      // An account with no match: the matches are asked for, their values are not.
      await repository.listRecent(THIRD_ACCOUNT_ID, VERSION, 10);
      expect(recorder.statements).toHaveLength(1);

      // A limit that is a mistake: the matches are not even asked for, so the count stays at one.
      await repository.listRecent(ACCOUNT_ID, VERSION, 0);
      expect(recorder.statements).toHaveLength(1);
    });
  });

  describe('accounts', () => {
    it('deletes, counts and lists accounts across both tables', async () => {
      const database = createTestDatabase();
      const repository = new MetricsRepository(database);
      await seedMatches(database, [
        { n: 0, startTime: 1_000 },
        { n: 0, accountId: OTHER_ACCOUNT_ID, startTime: 1_000 },
        { n: 0, accountId: THIRD_ACCOUNT_ID, startTime: 1_000 },
      ]);
      await repository.saveProjection(
        ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ a: 1, b: 2, c: null }),
      );
      await repository.saveProjection(
        OTHER_ACCOUNT_ID,
        matchId(0),
        projection(),
        metricValues({ a: 1 }),
      );
      // An account with metric rows and no projection row (a save that stopped halfway), and one with
      // a projection row and no metric rows: each still counts and is listed.
      await database.execute(
        'INSERT INTO match_metrics (account_id, match_id, metric_key, value) VALUES ($1, $2, $3, $4)',
        [FOURTH_ACCOUNT_ID, FIRST_MATCH_ID, 'orphan', 1],
      );
      await repository.saveProjection(THIRD_ACCOUNT_ID, matchId(0), projection(), new Map());

      // Rows of both tables: 1 projection + 3 metrics, 1 + 1, 1 + 0, 0 + 1 (an orphan row).
      await expect(repository.countAccount(ACCOUNT_ID)).resolves.toBe(4);
      await expect(repository.countAccount(OTHER_ACCOUNT_ID)).resolves.toBe(2);
      await expect(repository.countAccount(THIRD_ACCOUNT_ID)).resolves.toBe(1);
      await expect(repository.countAccount(FOURTH_ACCOUNT_ID)).resolves.toBe(1);
      await expect(repository.countAccount(testAccountId(4000001))).resolves.toBe(0);
      // Each account once, lowest first, whichever table holds it.
      await expect(repository.listAccountIds()).resolves.toEqual([
        ACCOUNT_ID,
        OTHER_ACCOUNT_ID,
        THIRD_ACCOUNT_ID,
        FOURTH_ACCOUNT_ID,
      ]);

      await repository.deleteAccount(OTHER_ACCOUNT_ID);
      await repository.deleteAccount(FOURTH_ACCOUNT_ID);

      await expect(repository.countAccount(OTHER_ACCOUNT_ID)).resolves.toBe(0);
      await expect(countRows(database, 'match_projections', OTHER_ACCOUNT_ID)).resolves.toBe(0);
      await expect(countRows(database, 'match_metrics', OTHER_ACCOUNT_ID)).resolves.toBe(0);
      await expect(repository.listAccountIds()).resolves.toEqual([ACCOUNT_ID, THIRD_ACCOUNT_ID]);
      // The other accounts keep everything, and deleting twice (a retried unlink) is harmless.
      await expect(repository.countAccount(ACCOUNT_ID)).resolves.toBe(4);
      await expect(repository.countAccount(THIRD_ACCOUNT_ID)).resolves.toBe(1);
      await expect(repository.deleteAccount(OTHER_ACCOUNT_ID)).resolves.toBeUndefined();
    });

    it('lists no account on an empty database', async () => {
      const repository = new MetricsRepository(createTestDatabase());

      await expect(repository.listAccountIds()).resolves.toEqual([]);
      await expect(repository.countAccount(ACCOUNT_ID)).resolves.toBe(0);
    });

    it('leaves out a stored account id that is no Steam account id', async () => {
      const database = createTestDatabase();
      await database.execute(
        'INSERT INTO match_metrics (account_id, match_id, metric_key, value) VALUES ($1, $2, $3, $4)',
        [0, FIRST_MATCH_ID, 'kda', 1],
      );
      await database.execute(
        'INSERT INTO match_metrics (account_id, match_id, metric_key, value) VALUES ($1, $2, $3, $4)',
        [ACCOUNT_ID, FIRST_MATCH_ID, 'kda', 1],
      );

      // A damaged row is skipped instead of failing the list, and never handed out to delete.
      await expect(new MetricsRepository(database).listAccountIds()).resolves.toEqual([ACCOUNT_ID]);
    });
  });

  describe('damaged rows and failures', () => {
    /**
     * A database that answers the same rows to every query.
     *
     * @param rows - The rows.
     * @returns The database.
     */
    function answering(rows: readonly SqlRow[]): Database {
      return {
        execute: () => Promise.resolve(0),
        select: () => Promise.resolve(rows),
      };
    }

    it('reports a stored value that is not a number as a storage error without the value', async () => {
      const repository = new MetricsRepository(
        answering([{ metric_key: 'kda', value: 'secret-text' }]),
      );

      const error = await repository
        .getValues(ACCOUNT_ID, matchId(0))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        kind: 'storage',
        context: { field: 'value', code: 'invalid_type' },
      });
      expect(isAppError(error) ? shownBy(error) : '').not.toContain('secret-text');
    });

    it('reports a damaged projection row as a storage error without the value', async () => {
      const repository = new MetricsRepository(
        answering([
          {
            projection_version: 1,
            player_badge: 4242,
            has_leaver: 0,
            failed: 0,
            projected_at: 1,
            duration_s: 1_800,
            start_time: 1,
          },
        ]),
      );

      const error = await repository
        .getProjection(ACCOUNT_ID, matchId(0))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        kind: 'storage',
        context: { field: 'player_badge', code: 'too_big' },
      });
      expect(isAppError(error) ? shownBy(error) : '').not.toContain('4242');
    });

    it('reports a damaged match id of the previous matches as a storage error', async () => {
      const repository = new MetricsRepository(answering([{ match_id: -5, duration_s: 1_800 }]));

      await expect(
        repository.listPrevious(ACCOUNT_ID, matchId(0), VERSION, 5),
      ).rejects.toMatchObject({ kind: 'storage', context: { field: 'match_id' } });
    });

    it('reports a damaged row of the recent matches as a storage error without the value', async () => {
      const damagedId = new MetricsRepository(
        answering([{ match_id: -5, start_time: 1_000, duration_s: 1_800 }]),
      );
      const damagedStart = new MetricsRepository(
        answering([{ match_id: matchId(1), start_time: 'secret-text', duration_s: 1_800 }]),
      );

      await expect(damagedId.listRecent(ACCOUNT_ID, VERSION, 5)).rejects.toMatchObject({
        kind: 'storage',
        context: { field: 'match_id' },
      });
      const error = await damagedStart
        .listRecent(ACCOUNT_ID, VERSION, 5)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        kind: 'storage',
        context: { field: 'start_time', code: 'invalid_type' },
      });
      expect(isAppError(error) ? shownBy(error) : '').not.toContain('secret-text');
    });

    describe('values of the previous and the recent matches', () => {
      /**
       * A database whose first query lists one match, and whose second one (the values of the
       * matches) answers as given.
       *
       * @param second - What the second query answers.
       * @returns The database.
       */
      function listingOneMatch(second: () => Promise<readonly SqlRow[]>): Database {
        let calls = 0;
        return {
          execute: () => Promise.resolve(0),
          select: () => {
            calls += 1;
            return calls === 1
              ? Promise.resolve([{ match_id: matchId(1), start_time: 1_000, duration_s: 1_800 }])
              : second();
          },
        };
      }

      /**
       * Both methods read the values of their matches through the same statement: the name of the
       * matches, the call, and what a failure of that statement is called.
       */
      const readers: readonly [
        string,
        (repository: MetricsRepository) => Promise<readonly unknown[]>,
        string,
      ][] = [
        [
          'previous',
          (repository) => repository.listPrevious(ACCOUNT_ID, matchId(0), VERSION, 5),
          'Could not read the metrics of the previous matches',
        ],
        [
          'recent',
          (repository) => repository.listRecent(ACCOUNT_ID, VERSION, 5),
          'Could not read the metrics of the recent matches',
        ],
      ];

      it.each(readers)(
        'reports a damaged value of the %s matches as a storage error without the value',
        async (_name, read) => {
          const repository = new MetricsRepository(
            listingOneMatch(() =>
              Promise.resolve([{ match_id: matchId(1), metric_key: 'kda', value: 'secret-text' }]),
            ),
          );

          const error = await read(repository).catch((caught: unknown) => caught);

          expect(error).toMatchObject({
            kind: 'storage',
            message: 'A stored metric is invalid',
            context: { field: 'value', code: 'invalid_type' },
          });
          expect(isAppError(error) ? shownBy(error) : '').not.toContain('secret-text');
        },
      );

      it.each(readers)(
        'reports a failure of the query of the values of the %s matches as a storage error',
        async (_name, read, failureMessage) => {
          const repository = new MetricsRepository(
            listingOneMatch(() => Promise.reject(new Error('disk I/O error'))),
          );

          await expect(read(repository)).rejects.toMatchObject({
            kind: 'storage',
            message: failureMessage,
            cause: new Error('disk I/O error'),
          });
        },
      );
    });

    it('reports a damaged match id of the match to project as a storage error', async () => {
      const repository = new MetricsRepository(answering([{ match_id: -5 }]));

      // With a limit that allows no earlier match, the first statement is the only one.
      await expect(
        repository.listToProjectUpTo(ACCOUNT_ID, matchId(0), VERSION, 0),
      ).rejects.toMatchObject({ kind: 'storage', context: { field: 'match_id' } });
    });

    it('reports a damaged match id of the earlier matches to project as a storage error', async () => {
      // The first statement (the match itself) answers no row; only the second one is damaged.
      let calls = 0;
      const damagedSecond: Database = {
        execute: () => Promise.resolve(0),
        select: () => {
          calls += 1;
          return Promise.resolve(calls === 1 ? [] : [{ match_id: -5 }]);
        },
      };

      await expect(
        new MetricsRepository(damagedSecond).listToProjectUpTo(ACCOUNT_ID, matchId(0), VERSION, 5),
      ).rejects.toMatchObject({ kind: 'storage', context: { field: 'match_id' } });
      expect(calls).toBe(2);
    });

    it('reports a failure of the query of the earlier matches to project as a storage error', async () => {
      let calls = 0;
      const failingSecond: Database = {
        execute: () => Promise.resolve(0),
        select: () => {
          calls += 1;
          return calls === 1 ? Promise.resolve([]) : Promise.reject(new Error('disk I/O error'));
        },
      };

      await expect(
        new MetricsRepository(failingSecond).listToProjectUpTo(ACCOUNT_ID, matchId(0), VERSION, 5),
      ).rejects.toMatchObject({ kind: 'storage', cause: new Error('disk I/O error') });
      expect(calls).toBe(2);
    });

    it('reports an unexpected count as a storage error', async () => {
      const repository = new MetricsRepository(answering([{ total: -1 }]));

      await expect(repository.countAccount(ACCOUNT_ID)).rejects.toMatchObject({
        kind: 'storage',
        context: { field: 'total' },
      });
    });

    it('reports a database failure of each method as a storage error', async () => {
      const broken: Database = {
        execute: () => Promise.reject(new Error('disk I/O error')),
        select: () => Promise.reject(new Error('disk I/O error')),
      };
      const repository = new MetricsRepository(broken);
      const calls: readonly (() => Promise<unknown>)[] = [
        () =>
          repository.saveProjection(ACCOUNT_ID, matchId(0), projection(), metricValues({ a: 1 })),
        () => repository.forgetProjection(ACCOUNT_ID, matchId(0)),
        () => repository.listToProject(ACCOUNT_ID, VERSION),
        () => repository.listToProjectUpTo(ACCOUNT_ID, matchId(0), VERSION, 5),
        () => repository.getProjection(ACCOUNT_ID, matchId(0)),
        () => repository.getValues(ACCOUNT_ID, matchId(0)),
        () => repository.listPrevious(ACCOUNT_ID, matchId(0), VERSION, 5),
        () => repository.listRecent(ACCOUNT_ID, VERSION, 5),
        () => repository.deleteAccount(ACCOUNT_ID),
        () => repository.countAccount(ACCOUNT_ID),
        () => repository.listAccountIds(),
      ];

      for (const call of calls) {
        await expect(call()).rejects.toMatchObject({
          kind: 'storage',
          cause: new Error('disk I/O error'),
        });
      }
    });
  });

  describe('migration 4', () => {
    /** The statement that writes a `linked_account` row the way migration 3 knew it. */
    const OLD_LINKED_ACCOUNT_INSERT = `INSERT INTO linked_account
      (id, account_id, persona_name, avatar_base64, avatar_hash, linked_at, profile_fetched_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`;

    it('refuses nothing in linked_account rows written before 0004', async () => {
      // The database of a user who ran the app before this migration: migrations 1 to 3, a linked
      // account written by the app of that time, then migration 4 applied on top of it (as the SQL
      // plugin does at the next start).
      const migration4 = MIGRATIONS.at(3);
      if (migration4 === undefined) {
        throw new Error('migrations/0004_analysis.sql is missing');
      }
      const oldRow = `INSERT INTO linked_account
        (id, account_id, persona_name, avatar_base64, avatar_hash, linked_at, profile_fetched_at)
        VALUES (1, ${String(ACCOUNT_ID)}, 'Fixture Player', NULL, NULL, 1700000000000, NULL)`;
      const database = new SqlJsDatabase(
        () => initSqlJs(),
        [...MIGRATIONS.slice(0, 3), oldRow, migration4],
      );

      const account = await new LinkedAccountRepository(
        database,
        new MemoryLogger(),
      ).getLinkedAccount();

      expect(account).toEqual({
        accountId: ACCOUNT_ID,
        personaName: 'Fixture Player',
        avatarBase64: null,
        avatarHash: null,
        linkedAt: 1_700_000_000_000,
        profileFetchedAt: null,
      });
      // The two columns of 0004 are NULL: no rank known, never fetched.
      await expect(
        database.select('SELECT rank_badge, rank_fetched_at FROM linked_account'),
      ).resolves.toEqual([{ rank_badge: null, rank_fetched_at: null }]);
    });

    it('holds a rank badge from 0 to 116 and refuses another', async () => {
      const database = createTestDatabase();
      await database.execute(OLD_LINKED_ACCOUNT_INSERT, [1, ACCOUNT_ID, null, null, null, 0, null]);

      for (const badge of [0, 1, 116]) {
        await database.execute('UPDATE linked_account SET rank_badge = $1, rank_fetched_at = $2', [
          badge,
          1_700_000_000_000,
        ]);
      }
      for (const badge of [-1, 117]) {
        await expect(
          database.execute('UPDATE linked_account SET rank_badge = $1', [badge]),
        ).rejects.toThrow();
      }

      await expect(database.select('SELECT rank_badge FROM linked_account')).resolves.toEqual([
        { rank_badge: 116 },
      ]);
    });

    it('holds a player badge from 1 to 116 or none, and refuses another', async () => {
      const database = createTestDatabase();
      const insert = `INSERT INTO match_projections
        (account_id, match_id, projection_version, player_badge, has_leaver, failed, projected_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`;

      await database.execute(insert, [ACCOUNT_ID, matchId(1), 1, null, 0, 0, 0]);
      await database.execute(insert, [ACCOUNT_ID, matchId(2), 1, 1, 0, 0, 0]);
      await database.execute(insert, [ACCOUNT_ID, matchId(3), 1, 116, 1, 1, 0]);

      for (const bad of [
        [matchId(4), 0, 0, 0], // badge 0 is "no rank known": the projection stores NULL instead
        [matchId(5), 117, 0, 0],
        [matchId(6), 65, 2, 0], // a boolean is 0 or 1
        [matchId(7), 65, 0, 2],
      ] as const) {
        const [match, badge, hasLeaver, failed] = bad;
        await expect(
          database.execute(insert, [ACCOUNT_ID, match, 1, badge, hasLeaver, failed, 0]),
        ).rejects.toThrow();
      }
      await expect(countRows(database, 'match_projections', ACCOUNT_ID)).resolves.toBe(3);
    });
  });
});

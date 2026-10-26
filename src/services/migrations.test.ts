/**
 * Tests of the migrations that rebuild a table, on the real files of `migrations/` applied in order
 * on sql.js, over rows written before the rebuild (as the database of a user who ran an older
 * version of the app holds them).
 *
 * @packageDocumentation
 */
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, SqlJsDatabase } from '../adapters/dev/sql-js-database.adapter';
import type { SqlValue } from '../ports/database.port';

/** How many migrations come before the one that adds the `evicted` status (0001 to 0005). */
const MIGRATIONS_BEFORE_EVICTED = 5;

/**
 * The columns of `matches` before migration 6, in the order of the live table: those of 0001, then
 * those 0002 added, then the one 0005 added.
 */
const MATCH_COLUMNS = [
  'account_id',
  'match_id',
  'hero_id',
  'start_time',
  'duration_s',
  'game_mode',
  'match_mode',
  'won',
  'kills',
  'deaths',
  'assists',
  'net_worth',
  'last_hits',
  'denies',
  'rank_delta',
  'synced_at',
  'detail_status',
  'detail_attempts',
  'detail_next_attempt_at',
  'detail_last_error',
  'archived_bytes',
  'archive_format',
] as const;

/** One row of `matches`, keyed by column. */
type MatchRow = Readonly<Record<(typeof MATCH_COLUMNS)[number], SqlValue>>;

/**
 * A row with every column set, to a value no other column of the row holds: a column copied into
 * its neighbour cannot go unnoticed. The values respect the CHECK constraints of the table.
 *
 * @param n - The position of the row, from 1; it makes the match id and every number unique.
 * @param status - Its detail status.
 * @returns The row.
 */
function fullRow(n: number, status: string): MatchRow {
  // Each integer column gets its own range, so that no two columns of a row share a value.
  const value = (column: number): number => n * 1_000 + column;
  return {
    account_id: 1_000_001,
    match_id: 100_000_000 + n,
    hero_id: value(3),
    start_time: 1_790_000_000 + value(4),
    duration_s: value(5),
    game_mode: value(6),
    match_mode: value(7),
    won: n % 2,
    kills: value(9),
    deaths: value(10),
    assists: value(11),
    net_worth: value(12),
    last_hits: value(13),
    denies: value(14),
    rank_delta: -value(15),
    synced_at: 1_790_000_000_000 + value(16),
    detail_status: status,
    detail_attempts: value(18),
    detail_next_attempt_at: 1_790_000_000_000 + value(19),
    detail_last_error: `error_${String(n)}`,
    archived_bytes: value(21),
    archive_format: (n % 2) + 1,
  };
}

/**
 * The rows written before the rebuild: one of every status the table knew, every column set; one
 * whose nullable columns are all `NULL`; and one of another player.
 */
const SEEDED_ROWS: readonly MatchRow[] = [
  fullRow(1, 'pending'),
  fullRow(2, 'retry'),
  fullRow(3, 'ready'),
  fullRow(4, 'unavailable'),
  fullRow(5, 'invalid'),
  {
    ...fullRow(6, 'pending'),
    rank_delta: null,
    detail_next_attempt_at: null,
    detail_last_error: null,
    archived_bytes: null,
    archive_format: null,
  },
  { ...fullRow(7, 'ready'), account_id: 2_000_001 },
];

/**
 * Write a value in SQL, for the seed of the test (the migrations run as plain SQL, without
 * parameters).
 *
 * @param value - The value.
 * @returns Its SQL literal.
 */
function sqlLiteral(value: SqlValue): string {
  if (value === null) {
    return 'NULL';
  }
  return typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value);
}

/** The SQL that writes {@link SEEDED_ROWS}, with every column named. */
const SEED = SEEDED_ROWS.map(
  (row) =>
    `INSERT INTO matches (${MATCH_COLUMNS.join(', ')})
     VALUES (${MATCH_COLUMNS.map((column) => sqlLiteral(row[column])).join(', ')});`,
).join('\n');

/**
 * The SQL of the migration that adds the `evicted` status: the sixth file of `migrations/`.
 *
 * @returns The text of the file.
 * @throws Error when the file is missing, or is not that migration.
 */
function evictedStatusMigration(): string {
  const migration = MIGRATIONS.at(MIGRATIONS_BEFORE_EVICTED);
  if (!migration?.includes("'evicted'")) {
    throw new Error('migrations/0006_evicted_status.sql is missing');
  }
  return migration;
}

/**
 * The database of a user who ran the app before the rebuild: migrations 1 to 5 and the seeded
 * rows.
 *
 * @returns The database.
 */
function databaseBefore(): SqlJsDatabase {
  return new SqlJsDatabase(
    () => initSqlJs(),
    [...MIGRATIONS.slice(0, MIGRATIONS_BEFORE_EVICTED), SEED],
  );
}

/**
 * The same database once the app applied migration 6 to it, as the SQL plugin does at the next
 * start.
 *
 * @returns The database.
 */
function databaseAfter(): SqlJsDatabase {
  return new SqlJsDatabase(
    () => initSqlJs(),
    [...MIGRATIONS.slice(0, MIGRATIONS_BEFORE_EVICTED), SEED, evictedStatusMigration()],
  );
}

/** Reads every row of `matches`, every column named, in the order of the primary key. */
const SELECT_ALL_ROWS = `SELECT ${MATCH_COLUMNS.join(', ')} FROM matches
  ORDER BY account_id, match_id`;

/** Reads the definition of every column of `matches`: name, type, `NOT NULL`, default, key. */
const SELECT_COLUMNS =
  'SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(\'matches\')';

/** Reads whether `matches` is `STRICT` and `WITHOUT ROWID`. */
const SELECT_TABLE_KIND = "SELECT strict, wr FROM pragma_table_list('matches')";

/** Reads the names of the tables of the database. */
const SELECT_TABLES = "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name";

/** Reads the indexes of `matches`, with the SQL that created them. */
const SELECT_INDEXES = `SELECT name, sql FROM sqlite_schema
  WHERE type = 'index' AND tbl_name = 'matches' ORDER BY name`;

describe('migration 6 (the evicted status)', () => {
  it('keeps every row and column through the rebuild', async () => {
    const before = databaseBefore();
    const after = databaseAfter();

    // Every row comes through with every value in its own column.
    await expect(after.select(SELECT_ALL_ROWS)).resolves.toEqual(SEEDED_ROWS);
    // The columns keep their order, types, constraints of nullity, defaults and key...
    const columns = await before.select(SELECT_COLUMNS);
    expect(columns).toHaveLength(MATCH_COLUMNS.length);
    await expect(after.select(SELECT_COLUMNS)).resolves.toEqual(columns);
    // ...and the table stays STRICT and WITHOUT ROWID.
    await expect(after.select(SELECT_TABLE_KIND)).resolves.toEqual([{ strict: 1, wr: 1 }]);
    // The temporary table of the rebuild is gone: the database holds the same tables as before.
    await expect(after.select(SELECT_TABLES)).resolves.toEqual(await before.select(SELECT_TABLES));
  });

  it('accepts the evicted status and refuses an unknown one', async () => {
    const before = databaseBefore();
    const after = databaseAfter();
    const ready = `WHERE match_id = ${String(fullRow(3, 'ready').match_id)}`;

    // The status did not exist before the migration...
    await expect(
      before.execute(`UPDATE matches SET detail_status = 'evicted' ${ready}`),
    ).rejects.toThrow();
    // ...and it is accepted after it.
    await expect(
      after.execute(`UPDATE matches SET detail_status = 'evicted' ${ready}`),
    ).resolves.toBe(1);
    await expect(after.select(`SELECT detail_status FROM matches ${ready}`)).resolves.toEqual([
      { detail_status: 'evicted' },
    ]);
    // An unknown status is still refused, and so are the values the other checks refuse.
    await expect(
      after.execute(`UPDATE matches SET detail_status = 'done' ${ready}`),
    ).rejects.toThrow();
    await expect(after.execute(`UPDATE matches SET won = 2 ${ready}`)).rejects.toThrow();
    await expect(after.execute(`UPDATE matches SET archive_format = 0 ${ready}`)).rejects.toThrow();
    // A row written without the detail columns still starts as a pending match never tried.
    await after.execute(
      `INSERT INTO matches (account_id, match_id, hero_id, start_time, duration_s, game_mode,
         match_mode, won, kills, deaths, assists, net_worth, last_hits, denies, synced_at)
       VALUES (1000001, 100000099, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1)`,
    );
    await expect(
      after.select('SELECT detail_status, detail_attempts FROM matches WHERE match_id = 100000099'),
    ).resolves.toEqual([{ detail_status: 'pending', detail_attempts: 0 }]);
  });

  it('recreates the two indexes', async () => {
    const indexes = await databaseBefore().select(SELECT_INDEXES);

    expect(indexes.map(({ name }) => name)).toEqual(['matches_by_hero', 'matches_by_start_time']);
    // The same names on the same columns, created by the same SQL.
    await expect(databaseAfter().select(SELECT_INDEXES)).resolves.toEqual(indexes);
  });
});

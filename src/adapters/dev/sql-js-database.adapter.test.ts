/**
 * Tests of the sql.js database adapter, on the real migration files.
 *
 * @packageDocumentation
 */
import initSqlJs from 'sql.js';
import { describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, SqlJsDatabase } from './sql-js-database.adapter';

/**
 * Create a database on the real migrations. Under Node, sql.js finds its WebAssembly file itself.
 *
 * @returns The database.
 */
function createDatabase(): SqlJsDatabase {
  return new SqlJsDatabase(() => initSqlJs());
}

describe('SqlJsDatabase', () => {
  it('reads the migration files of the repository, in order', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    expect(MIGRATIONS[0]).toContain('CREATE TABLE matches');
  });

  it('creates the tables of the migrations on first use', async () => {
    const rows = await createDatabase().select(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );

    expect(rows.map((row) => row.name)).toEqual([
      'api_cache',
      'linked_account',
      'match_metrics',
      'match_projections',
      'matches',
      'sync_state',
    ]);
  });

  it('runs statements with parameters and returns the rows by column name', async () => {
    const database = createDatabase();

    const changed = await database.execute(
      'INSERT INTO sync_state (key, value_json, updated_at) VALUES ($1, $2, $3), ($4, $5, $6)',
      ['a', '1', 10, 'b', 'null', 20],
    );
    const rows = await database.select(
      'SELECT key, value_json, updated_at FROM sync_state WHERE updated_at > $1 ORDER BY key',
      [5],
    );

    expect(changed).toBe(2);
    expect(rows).toEqual([
      { key: 'a', value_json: '1', updated_at: 10 },
      { key: 'b', value_json: 'null', updated_at: 20 },
    ]);
  });

  it('refuses parameters that do not first appear as $1, $2… in order', async () => {
    const database = createDatabase();

    await expect(
      database.select('SELECT * FROM sync_state WHERE key = $2 AND updated_at = $1', ['a', 1]),
    ).rejects.toThrow('Parameter $2 first appears where $1 is expected');
    await expect(database.select('SELECT * FROM sync_state WHERE key = $1', [])).rejects.toThrow(
      'The statement has 1 parameters but 0 values were given',
    );
  });

  it('lets a parameter appear several times', async () => {
    const rows = await createDatabase().select('SELECT $1 + $1 AS doubled, $2 AS other', [21, 'x']);

    expect(rows).toEqual([{ doubled: 42, other: 'x' }]);
  });

  it('refuses to execute two statements in one call, and runs none of them', async () => {
    const database = createDatabase();

    await expect(
      database.execute(
        "INSERT INTO sync_state (key, value_json, updated_at) VALUES ('a', '1', 10); " +
          "INSERT INTO sync_state (key, value_json, updated_at) VALUES ('b', '2', 20)",
      ),
    ).rejects.toThrow('The SQL holds more than one statement');
    // sql.js alone would have run the first INSERT and dropped the second one.
    await expect(database.select('SELECT key FROM sync_state')).resolves.toEqual([]);
  });

  it('refuses a query followed by another statement', async () => {
    await expect(createDatabase().select('SELECT 1 AS one; SELECT 2 AS two')).rejects.toThrow(
      'The SQL holds more than one statement',
    );
  });

  it('refuses a second statement that cannot be prepared yet, and keeps the SQLite error as its cause', async () => {
    // The second statement fails to prepare (no such table): it is still reported as a second one.
    await expect(
      createDatabase().execute("DELETE FROM sync_state; DELETE FROM missing_table WHERE key = 'a'"),
    ).rejects.toMatchObject({
      message: expect.stringContaining('The SQL holds more than one statement') as unknown,
      cause: expect.objectContaining({
        message: expect.stringContaining('no such table: missing_table') as unknown,
      }) as unknown,
    });
  });

  it.each(['', '   ', '-- just a comment', ';'])(
    'refuses SQL that holds no statement: %j',
    async (sql) => {
      const database = createDatabase();

      await expect(database.execute(sql)).rejects.toThrow('The SQL holds no statement');
      await expect(database.select(sql)).rejects.toThrow('The SQL holds no statement');
    },
  );

  it('accepts one statement followed by a semicolon, whitespace and a comment', async () => {
    const database = createDatabase();

    const changed = await database.execute(
      "INSERT INTO sync_state (key, value_json, updated_at) VALUES ('a', '1', 10); -- the only one\n",
    );
    const rows = await database.select('SELECT key FROM sync_state; /* done */ ');

    expect(changed).toBe(1);
    expect(rows).toEqual([{ key: 'a' }]);
  });

  it('does not take a semicolon inside a literal or a comment for a second statement', async () => {
    const database = createDatabase();

    await database.execute(
      "INSERT INTO sync_state (key, value_json, updated_at) VALUES ('a;b', 'x; y', 10) -- not; two",
    );
    const rows = await database.select("SELECT key, value_json FROM sync_state WHERE key = 'a;b'");

    expect(rows).toEqual([{ key: 'a;b', value_json: 'x; y' }]);
  });

  it('propagates SQL errors as they are', async () => {
    await expect(createDatabase().select('SELECT * FROM missing_table')).rejects.toThrow(
      'no such table: missing_table',
    );
  });

  it('tries again after sql.js failed to load', async () => {
    const load = vi
      .fn<() => ReturnType<typeof initSqlJs>>()
      .mockRejectedValueOnce(new Error('wasm download failed'))
      .mockImplementation(() => initSqlJs());
    const database = new SqlJsDatabase(load);

    await expect(database.select('SELECT 1 AS one')).rejects.toThrow('wasm download failed');
    await expect(database.select('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

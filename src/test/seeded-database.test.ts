/**
 * Tests of the seeded database: the seed runs once, before any statement, and a failed seed is the
 * outcome of every statement. The wrapped database is a recorder, so the order of the calls is
 * what the tests read.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import type { Database, SqlRow } from '../ports/database.port';
import { SeededDatabase } from './seeded-database';

/** A database that records the statements it runs, in order, and answers one row per query. */
class RecordingDatabase implements Database {
  /** Every call, oldest first, as `execute <sql>` or `select <sql>`. */
  readonly calls: string[] = [];

  execute(sql: string): Promise<number> {
    this.calls.push(`execute ${sql}`);
    return Promise.resolve(1);
  }

  select(sql: string): Promise<readonly SqlRow[]> {
    this.calls.push(`select ${sql}`);
    return Promise.resolve([{ answer: sql }]);
  }
}

/**
 * Make a promise that a test settles by hand.
 *
 * @returns The promise and the function that resolves it.
 */
function openGate(): { readonly gate: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

describe('SeededDatabase', () => {
  it('runs the seed once, on the wrapped database, before the first of many statements', async () => {
    const inner = new RecordingDatabase();
    const seed = vi.fn(async (database: Database) => {
      await database.execute('seed');
    });
    const database = new SeededDatabase(inner, seed);

    // Nothing runs at construction: the seed waits for the first statement.
    expect(seed).not.toHaveBeenCalled();
    await expect(database.execute('A')).resolves.toBe(1);
    await expect(database.select('B')).resolves.toEqual([{ answer: 'B' }]);
    await database.execute('C');

    // The seed was given the wrapped database, not the seeded one, so it cannot wait for itself.
    expect(seed).toHaveBeenCalledExactlyOnceWith(inner);
    expect(inner.calls).toEqual(['execute seed', 'execute A', 'select B', 'execute C']);
  });

  it('makes statements started in the same tick share one seed and run after it', async () => {
    const inner = new RecordingDatabase();
    const { gate, open } = openGate();
    const seed = vi.fn(async (database: Database) => {
      await gate;
      await database.execute('seed');
    });
    const database = new SeededDatabase(inner, seed);

    const execution = database.execute('A');
    const query = database.select('B');

    // Both statements wait: one seed is under way and nothing reached the database yet.
    expect(seed).toHaveBeenCalledTimes(1);
    expect(inner.calls).toEqual([]);

    open();
    await Promise.all([execution, query]);

    expect(seed).toHaveBeenCalledTimes(1);
    expect(inner.calls).toEqual(['execute seed', 'execute A', 'select B']);
  });

  describe.each([
    [
      'throws before it returns a promise',
      (error: Error) =>
        vi.fn((): Promise<void> => {
          throw error;
        }),
    ],
    ['rejects', (error: Error) => vi.fn((): Promise<void> => Promise.reject(error))],
  ])('when the seed %s', (_name, makeSeed) => {
    it('fails every statement with that error and does not run the seed again', async () => {
      const inner = new RecordingDatabase();
      const failure = new Error('The seed failed');
      const seed = makeSeed(failure);
      const database = new SeededDatabase(inner, seed);

      await expect(database.execute('A')).rejects.toBe(failure);
      await expect(database.select('B')).rejects.toBe(failure);
      await expect(database.execute('C')).rejects.toBe(failure);

      // One attempt only, and no statement slipped through to a database without its seed.
      expect(seed).toHaveBeenCalledTimes(1);
      expect(inner.calls).toEqual([]);
    });
  });
});

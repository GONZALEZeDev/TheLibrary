/**
 * Test helper: a {@link Database} that runs a seed before its first statement.
 *
 * @packageDocumentation
 */
import type { Database, SqlRow, SqlValue } from '../ports/database.port';

/**
 * {@link Database} that wraps another one and runs a seed (typically: link the account of the test)
 * before the first statement goes through.
 *
 * The seed is lazy for a reason: `createTestServices` stays synchronous, and nothing can write to
 * the database before the migrations have run, which only happens on the first statement. Running
 * the seed on the first `execute` or `select` instead puts it after the migrations and before
 * anything else, so every statement of the services runs after the link is in place, without any
 * test having to wait for a setup step. The seed receives the wrapped database, not this one, so it
 * cannot wait for itself.
 *
 * If the seed fails, whether it throws or rejects, every statement fails with that same error and
 * the seed is not run again: a database whose seed did not run is not the one the test asked for,
 * and a second attempt could hide the failure behind a half-written seed.
 */
export class SeededDatabase implements Database {
  readonly #inner: Database;
  readonly #seed: (database: Database) => Promise<void>;
  /**
   * The outcome of the seed, started by the first statement and kept for good: concurrent callers
   * share the same pending promise, and a failure stays the outcome of every later statement.
   */
  #seeded: Promise<void> | undefined;

  /**
   * @param inner - The database that runs the statements.
   * @param seed - Fills the database; it is called once, with `inner`, before the first statement.
   */
  constructor(inner: Database, seed: (database: Database) => Promise<void>) {
    this.#inner = inner;
    this.#seed = seed;
  }

  /**
   * Run a statement that returns no rows, once the seed has run.
   *
   * @param sql - One SQL statement.
   * @param params - Values of `$1`, `$2`…
   * @returns The number of rows the statement changed.
   */
  async execute(sql: string, params?: readonly SqlValue[]): Promise<number> {
    await this.#ensureSeeded();
    return this.#inner.execute(sql, params);
  }

  /**
   * Run a query, once the seed has run.
   *
   * @param sql - One statement that answers rows: a `SELECT`, or a pragma such as the checkpoint of
   *   the write-ahead log.
   * @param params - Values of `$1`, `$2`…
   * @returns The rows, in the order of the query.
   */
  async select(sql: string, params?: readonly SqlValue[]): Promise<readonly SqlRow[]> {
    await this.#ensureSeeded();
    return this.#inner.select(sql, params);
  }

  /**
   * Wait for the seed, starting it on the first call.
   *
   * The seed is started inside a promise executor, which turns a seed that throws before it returns
   * a promise into a rejection: both kinds of failure are then kept as the outcome, instead of the
   * throw escaping once and the seed running again at the next statement.
   *
   * @returns A promise resolved once the seed has run, or rejected with its failure.
   */
  #ensureSeeded(): Promise<void> {
    this.#seeded ??= new Promise<void>((resolve) => {
      resolve(this.#seed(this.#inner));
    });
    return this.#seeded;
  }
}

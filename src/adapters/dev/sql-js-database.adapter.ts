/**
 * {@link Database} backed by sql.js (SQLite compiled to WebAssembly), for tests and the browser dev
 * mode.
 *
 * The database lives in memory: it is created empty, with every migration of `migrations/`
 * applied, on first use, and disappears with the page or the test. The desktop app uses the Tauri
 * SQL plugin instead (`adapters/tauri`); both run the same SQL on the same SQLite engine.
 *
 * @packageDocumentation
 */
import type { SqlJsStatic, Database as SqlJsHandle, ParamsObject } from 'sql.js';
import type { Database, SqlRow, SqlValue } from '../../ports/database.port';

/**
 * SQL of every migration of `migrations/`, in file name order (`0001_…`, `0002_…`): the files the
 * desktop app embeds, read as text by Vite at build time.
 */
export const MIGRATIONS: readonly string[] = Object.entries(
  import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true }),
)
  .toSorted(([first], [second]) => first.localeCompare(second))
  .map(([, sql]) => sql);

/** {@link Database} running SQLite in memory with sql.js. */
export class SqlJsDatabase implements Database {
  readonly #loadSqlJs: () => Promise<SqlJsStatic>;
  readonly #migrations: readonly string[];
  /** The database, created on first use; concurrent callers share the same pending promise. */
  #handle: Promise<SqlJsHandle> | undefined;

  /**
   * @param loadSqlJs - Loads the sql.js module. The browser passes the URL of its WebAssembly
   *   file; Node (the tests) finds it by itself.
   * @param migrations - SQL applied to the new database, in order; {@link MIGRATIONS} by default.
   */
  constructor(loadSqlJs: () => Promise<SqlJsStatic>, migrations: readonly string[] = MIGRATIONS) {
    this.#loadSqlJs = loadSqlJs;
    this.#migrations = migrations;
  }

  /**
   * Run a statement that returns no rows.
   *
   * @param sql - One SQL statement.
   * @param params - Values of `$1`, `$2`…
   * @returns The number of rows the statement changed.
   * @throws Error when `sql` does not hold exactly one statement (a programming error).
   */
  async execute(sql: string, params: readonly SqlValue[] = []): Promise<number> {
    const handle = await this.#open();
    assertSingleStatement(handle, sql);
    handle.run(sql, toBindings(sql, params));
    return handle.getRowsModified();
  }

  /**
   * Run a query.
   *
   * @param sql - One `SELECT` statement.
   * @param params - Values of `$1`, `$2`…
   * @returns The rows, keyed by column name.
   * @throws Error when `sql` does not hold exactly one statement (a programming error).
   */
  async select(sql: string, params: readonly SqlValue[] = []): Promise<readonly SqlRow[]> {
    const handle = await this.#open();
    assertSingleStatement(handle, sql);
    const statement = handle.prepare(sql, toBindings(sql, params));
    try {
      const rows: SqlRow[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      // A prepared statement holds WebAssembly memory until it is freed.
      statement.free();
    }
  }

  /**
   * Get the database, creating it on first use.
   *
   * @returns The sql.js database.
   */
  #open(): Promise<SqlJsHandle> {
    this.#handle ??= this.#create().catch((error: unknown) => {
      // Forget the failed attempt, so that the next call tries again instead of failing forever.
      this.#handle = undefined;
      throw error;
    });
    return this.#handle;
  }

  /**
   * Create an empty database and apply every migration.
   *
   * @returns The new database.
   */
  async #create(): Promise<SqlJsHandle> {
    const SQL = await this.#loadSqlJs();
    const handle = new SQL.Database();
    for (const migration of this.#migrations) {
      handle.exec(migration);
    }
    return handle;
  }
}

/**
 * Refuse an SQL string that does not hold exactly one statement.
 *
 * The desktop driver (sqlx behind the Tauri SQL plugin) runs every statement of the string, while
 * `run` and `prepare` of sql.js silently run only the first one and drop the rest: a second
 * statement would work in the app and be ignored by the tests. This check makes the tests fail on
 * it instead. Migrations are not concerned: they go through `exec`, which runs every statement.
 *
 * sql.js counts the statements itself, by preparing them without running them, so a `;` inside a
 * literal or a comment is not taken for a separator, and a trailing `;`, whitespace or comment is
 * not a statement.
 *
 * @param handle - The sql.js database that is about to run the statement.
 * @param sql - The statement given to the port.
 * @throws Error when `sql` holds no statement (empty, or only whitespace and comments) or more
 *   than one (a programming error). When the text after the first statement cannot be prepared
 *   (e.g. a table that does not exist yet), the SQLite error is the `cause`. An invalid first
 *   statement throws its own SQL error, as it would when it runs.
 */
function assertSingleStatement(handle: SqlJsHandle, sql: string): void {
  const statements = handle.iterateStatements(sql);
  let count = 0;
  let tailError: unknown;
  try {
    // `next()` frees the statement it returned before, and the iterator frees its copy of `sql`
    // once it is exhausted or fails: reading it to the end (or until it throws) releases the
    // WebAssembly memory it holds.
    while (!statements.next().done) {
      count += 1;
    }
  } catch (error) {
    if (count === 0) {
      throw error;
    }
    // Text follows the first statement and it is neither a statement that can be prepared nor
    // whitespace or a comment: it counts as one more statement, and SQLite's complaint about it
    // is kept as the cause.
    count += 1;
    tailError = error;
  }
  if (count === 0) {
    throw new Error('The SQL holds no statement, but a call runs exactly one');
  }
  if (count > 1) {
    throw new Error(
      'The SQL holds more than one statement, but a call runs exactly one (the desktop driver would run all of them, sql.js only the first)',
      tailError === undefined ? undefined : { cause: tailError },
    );
  }
}

/**
 * Turn `$1`, `$2`… values into the named bindings of sql.js.
 *
 * SQLite treats `$1` as a name, while the desktop driver binds values by position: both only agree
 * when the parameters first appear in the order `$1`, `$2`… This check makes the tests fail on a
 * statement that would silently bind the wrong values in the desktop app.
 *
 * @param sql - The statement.
 * @param params - Values of `$1`, `$2`…
 * @returns The bindings, e.g. `{ $1: 42, $2: 'x' }`.
 * @throws Error when the parameters are not numbered in order of appearance, or when their number
 *   does not match the values (a programming error).
 */
function toBindings(sql: string, params: readonly SqlValue[]): ParamsObject {
  const numbers = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  const firstAppearances = numbers.filter((number, index) => numbers.indexOf(number) === index);
  firstAppearances.forEach((number, index) => {
    if (number !== index + 1) {
      throw new Error(
        `Parameter $${String(number)} first appears where $${String(index + 1)} is expected`,
      );
    }
  });
  if (firstAppearances.length !== params.length) {
    throw new Error(
      `The statement has ${String(firstAppearances.length)} parameters but ${String(params.length)} values were given`,
    );
  }
  return Object.fromEntries(params.map((value, index) => [`$${String(index + 1)}`, value]));
}

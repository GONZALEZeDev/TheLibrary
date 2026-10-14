/**
 * Database port: the SQLite database of the app.
 *
 * The same SQL runs on both adapters: the Tauri SQL plugin in the desktop app, sql.js (SQLite
 * compiled to WebAssembly) in the browser dev mode and in the tests. The schema comes from the
 * migration files of `migrations/`, applied by the adapters before the first statement.
 *
 * Rules for the SQL written against this port:
 * - parameters are written `$1`, `$2`… and first appear in that order in the statement (the
 *   desktop driver binds them by position; the development adapter checks the order);
 * - one statement per call, and no transaction spanning several calls: the desktop plugin runs
 *   statements on a connection pool, so consecutive calls may use different connections.
 *
 * @packageDocumentation
 */

/**
 * A value bound to a parameter. Booleans are not accepted: the desktop plugin would store them as
 * the text `'true'`; write 0 or 1 instead. Numbers must be safe integers or finite decimals.
 */
export type SqlValue = string | number | null;

/** A row read by {@link Database.select}, keyed by column name. To be validated by the caller. */
export type SqlRow = Readonly<Record<string, unknown>>;

/** Runs SQL statements on the app database. */
export interface Database {
  /**
   * Run a statement that returns no rows (`INSERT`, `UPDATE`, `DELETE`…).
   *
   * @param sql - One SQL statement.
   * @param params - Values of `$1`, `$2`…
   * @returns The number of rows the statement changed.
   */
  execute(sql: string, params?: readonly SqlValue[]): Promise<number>;

  /**
   * Run a query.
   *
   * @param sql - One `SELECT` statement.
   * @param params - Values of `$1`, `$2`…
   * @returns The rows, in the order of the query.
   */
  select(sql: string, params?: readonly SqlValue[]): Promise<readonly SqlRow[]>;
}

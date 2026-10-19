/**
 * {@link Database} backed by the Tauri SQL plugin (desktop app).
 *
 * The Rust shell opens the database at startup and applies its migrations
 * (`plugins.sql.preload` in `tauri.conf.json`, migration list in `src-tauri/src/lib.rs`). The
 * webview only reaches that open database with `Database.get`: it is not granted the plugin's
 * `load` command, which could open any file.
 *
 * @packageDocumentation
 */
import SqlPluginDatabase from '@tauri-apps/plugin-sql';
import type { Database, SqlRow, SqlValue } from '../../ports/database.port';

/**
 * Connection string of the database the shell opened. It must stay equal to `DATABASE_URL` in
 * `src-tauri/src/lib.rs`: the plugin finds the open connection by this exact string.
 */
export const DATABASE_URL = 'sqlite:thelibrary.db';

/** The methods of the plugin's database handle this adapter uses; tests pass a fake. */
export type PluginDatabase = Pick<SqlPluginDatabase, 'execute' | 'select'>;

/** {@link Database} running statements through `@tauri-apps/plugin-sql`. */
export class TauriDatabase implements Database {
  readonly #database: PluginDatabase;

  /**
   * @param database - Handle of the open database; `Database.get` creates it without any IPC call,
   *   so construction never fails.
   */
  constructor(database: PluginDatabase = SqlPluginDatabase.get(DATABASE_URL)) {
    this.#database = database;
  }

  /**
   * Run a statement that returns no rows.
   *
   * @param sql - One SQL statement.
   * @param params - Values of `$1`, `$2`…
   * @returns The number of rows the statement changed.
   */
  async execute(sql: string, params: readonly SqlValue[] = []): Promise<number> {
    const result = await this.#database.execute(sql, [...params]);
    return result.rowsAffected;
  }

  /**
   * Run a query.
   *
   * @param sql - One statement that answers rows: a `SELECT`, or a pragma such as the checkpoint of
   *   the write-ahead log.
   * @param params - Values of `$1`, `$2`…
   * @returns The rows, keyed by column name.
   */
  select(sql: string, params: readonly SqlValue[] = []): Promise<readonly SqlRow[]> {
    return this.#database.select<SqlRow[]>(sql, [...params]);
  }
}

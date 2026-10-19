/**
 * Maintenance of the database file itself, rather than of what is stored in it.
 *
 * Deleting rows does not shrink the SQLite file: the freed pages keep their old content until the
 * file is compacted. After the data of an account is deleted, that content is still on disk, so the
 * account data service compacts the database.
 *
 * Compacting is two steps, because the desktop database is in WAL (write-ahead log) mode: the SQL
 * plugin's driver creates new databases that way, and the mode is kept in the file. `VACUUM` writes
 * the compacted database into the log, and the main file keeps its old pages, deleted data included,
 * until a checkpoint copies the log into it. Nothing guarantees one before the app exits, so the
 * compaction ends with its own checkpoint. A database that is not in WAL mode (sql.js, in the tests
 * and the browser dev mode) has no log: the checkpoint answers at once, as done.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../core/errors/app-error';
import type { Database } from '../ports/database.port';

/**
 * Empties the write-ahead log into the main file and truncates the log (`TRUNCATE`: the log file
 * is made empty, not just reused). It answers one row.
 */
const CHECKPOINT = 'PRAGMA wal_checkpoint(TRUNCATE)';

/**
 * Schema of the row the checkpoint answers (columns `busy`, `log` and `checkpointed`). Only `busy`
 * matters: it is 0 when the checkpoint completed, and 1 when it was blocked by another connection
 * (a reader or a writer) and so copied nothing, or only part of the log. A database without a log
 * answers 0 as well.
 */
const checkpointRowSchema = z.object({ busy: z.int() });

/** Compacts the database file. */
export class DatabaseMaintenanceRepository {
  readonly #database: Database;

  /**
   * @param database - The app database.
   */
  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * Compact the database, then checkpoint it, so that the file itself no longer holds the deleted
   * data. `VACUUM` is a single statement that cannot run inside a transaction, and it rewrites the
   * whole database, so it must run while nothing else uses the database (the synchronisation is
   * suspended around a change of account, or has not started yet). A checkpoint that is blocked
   * would leave the old pages in the main file, so it is a failure like the others: the caller keeps
   * its flag set and compacts again at the next start.
   *
   * @throws AppError of kind `storage` when the database fails, the disk being full included (the
   *   rebuilt file needs room as large as the database), or when the checkpoint did not complete.
   */
  async vacuum(): Promise<void> {
    try {
      await this.#database.execute('VACUUM');
    } catch (error) {
      throw new AppError('storage', 'Could not compact the database', { cause: error });
    }
    await this.#checkpoint();
  }

  /**
   * Copy the write-ahead log into the main file and empty it, and check that it completed.
   *
   * @throws AppError of kind `storage` when the statement fails, when its answer is not the row
   *   expected, or when the checkpoint was busy and so did not complete.
   */
  async #checkpoint(): Promise<void> {
    let rows;
    try {
      // The checkpoint is a pragma, not a query, but it answers a row, which only `select` returns.
      rows = await this.#database.select(CHECKPOINT);
    } catch (error) {
      throw new AppError('storage', 'Could not checkpoint the database after compacting it', {
        cause: error,
      });
    }
    const answer = checkpointRowSchema.safeParse(rows[0]);
    if (!answer.success) {
      throw new AppError('storage', 'Unexpected answer while checkpointing the database');
    }
    if (answer.data.busy !== 0) {
      throw new AppError('storage', 'The checkpoint of the compacted database did not complete', {
        context: { busy: answer.data.busy },
      });
    }
  }
}

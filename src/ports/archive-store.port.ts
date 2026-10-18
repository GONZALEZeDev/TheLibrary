/**
 * Archive store port: the files of the match-detail archive.
 *
 * The archive keeps one compressed file per match under the app's local data directory (the paths
 * come from `core/match-detail/archive-layout.ts`, never assembled by an adapter). The port moves
 * opaque bytes: compressing, serialising and validating them is the job of the services and of
 * `core/`, so an adapter never looks inside a file.
 *
 * Adapters do not wrap their failures: a full disk, a denied path or a missing folder propagate as
 * they are (see `src/adapters/README.md`), and the service that calls the port wraps them.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';

/** Reads and writes the archive files of the matches. */
export interface ArchiveStore {
  /**
   * Replace the archive of a match.
   *
   * The write is atomic: the bytes go to a temporary file first, which is then renamed over the
   * archive, so a crash never leaves a half-written archive under its final name. The folder of
   * the account is created when it does not exist yet.
   *
   * @param accountId - The account the archive is pruned for.
   * @param matchId - The match.
   * @param bytes - The compressed archive.
   * @returns A promise resolved once the archive is in place.
   */
  write(accountId: AccountId, matchId: MatchId, bytes: Uint8Array): Promise<void>;

  /**
   * Read the archive of a match.
   *
   * @param accountId - The account the archive is pruned for.
   * @param matchId - The match.
   * @returns The compressed archive, or `null` when the match has none.
   */
  read(accountId: AccountId, matchId: MatchId): Promise<Uint8Array | null>;

  /**
   * Delete the temporary files an interrupted write left in the folder of an account.
   *
   * Archives, the quarantine folder that the account folder holds and the files of other accounts
   * are never touched. A missing folder is not an error:
   * there is nothing to remove. Every leftover is tried even when one cannot be deleted, and the
   * first failure is reported once all have been tried.
   *
   * @param accountId - The account whose leftovers are removed.
   * @returns A promise resolved once the leftovers are gone.
   * @throws The first deletion failure, after every leftover was tried.
   */
  removeTemporaryFiles(accountId: AccountId): Promise<void>;

  /**
   * Keep a response that could not be used, for a look when diagnosing.
   *
   * The response goes to the quarantine folder of the account, inside the folder of its archives:
   * it is deleted with the account's data, and the folder never holds the response of another
   * account. Only the most recent ones of an account stay (`QUARANTINE_LIMIT` in
   * `archive-layout.ts`): once its folder is over that number, the oldest are deleted. A
   * quarantined file is never read back by the app.
   *
   * @param accountId - The account the response was fetched for.
   * @param matchId - The match the response was fetched for.
   * @param at - When the response was quarantined, in Unix milliseconds.
   * @param bytes - The response, zstd-compressed (the caller compresses it, as it does an archive).
   * @returns A promise resolved once the response is kept and the folder is trimmed.
   */
  quarantine(accountId: AccountId, matchId: MatchId, at: number, bytes: Uint8Array): Promise<void>;

  /**
   * List what the archive folder holds directly: the folder of each account, and anything else put
   * there (the quarantine folder of the first layout, a file of the user). Only the names of the
   * entries are returned, never what the folders hold. The order is the one the platform gives.
   *
   * @returns The names of the entries, folders and files; empty when the archive folder does not
   *   exist yet.
   * @throws Whatever the platform rejects with when the folder exists but cannot be listed.
   */
  listEntries(): Promise<readonly string[]>;

  /**
   * Delete an entry of the archive folder, with everything it holds: the folder of an account goes
   * with its archives, its leftovers and its quarantine. An entry that does not exist is not an
   * error: there is nothing to remove.
   *
   * @param name - The name of the entry, as {@link ArchiveStore.listEntries} gives it. It must pass
   *   `isArchiveEntryName` (`archive-layout.ts`): a name that could reach outside the archive folder
   *   is a mistake of the caller, not something to clean up after.
   * @returns A promise resolved once the entry is gone.
   * @throws Error, before anything is touched, when the name is not a single entry name; its message
   *   does not quote the name, which can be an account id. Whatever the platform rejects with when
   *   the entry exists but cannot be removed (a file held open by another program, say).
   */
  removeEntry(name: string): Promise<void>;
}

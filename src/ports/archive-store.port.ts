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
   * Archives and the files of other accounts are never touched. A missing folder is not an error:
   * there is nothing to remove.
   *
   * @param accountId - The account whose leftovers are removed.
   * @returns A promise resolved once the leftovers are gone.
   */
  removeTemporaryFiles(accountId: AccountId): Promise<void>;

  /**
   * Keep a response that could not be used, for a look when diagnosing.
   *
   * Only the most recent ones stay (`QUARANTINE_LIMIT` in `archive-layout.ts`): once the folder
   * is over that number, the oldest are deleted. A quarantined file is never read back by the app.
   *
   * @param matchId - The match the response was fetched for.
   * @param at - When the response was quarantined, in Unix milliseconds.
   * @param bytes - The response as it was received.
   * @returns A promise resolved once the response is kept and the folder is trimmed.
   */
  quarantine(matchId: MatchId, at: number, bytes: Uint8Array): Promise<void>;
}

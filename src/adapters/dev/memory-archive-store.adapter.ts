/**
 * In-memory {@link ArchiveStore} for tests and the browser dev mode.
 *
 * The archive folder is a map from path to bytes. The keys are exactly the paths the desktop
 * adapter writes (built by `core/match-detail/archive-layout.ts`), so a test can look at the
 * "disk" the same way it would look at the folder. The store keeps and returns copies of the
 * bytes, like a file would: changing an array after handing it over never changes the archive.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../../core/domain/account';
import type { MatchId } from '../../core/domain/match';
import {
  archiveFolder,
  archivePath,
  isTemporaryArchiveName,
  quarantineFileName,
  QUARANTINE_FOLDER,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from '../../core/match-detail/archive-layout';
import type { ArchiveStore } from '../../ports/archive-store.port';

/** What a leftover temporary file contains: the content of an interrupted write does not matter. */
const LEFTOVER_BYTES: readonly number[] = [0];

/** {@link ArchiveStore} that keeps the files of the archive in memory. */
export class MemoryArchiveStore implements ArchiveStore {
  /** Every file of the archive folder: path (from the archive layout) → bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;

  /** The same map as {@link MemoryArchiveStore.files}, typed as writable for this class only. */
  readonly #stored = new Map<string, Uint8Array>();

  /** The failure the next {@link MemoryArchiveStore.write} throws instead of writing. */
  #nextWriteError: Error | null = null;

  /** Starts with an empty archive folder. */
  constructor() {
    this.files = this.#stored;
  }

  /**
   * Store a copy of the archive of a match, replacing the previous one.
   *
   * @param accountId - The account the archive is pruned for.
   * @param matchId - The match.
   * @param bytes - The compressed archive.
   * @returns A promise resolved once the archive is stored.
   * @throws The error given to {@link MemoryArchiveStore.failNextWrite}, once, when one is queued.
   */
  write(accountId: AccountId, matchId: MatchId, bytes: Uint8Array): Promise<void> {
    if (this.#nextWriteError !== null) {
      const error = this.#nextWriteError;
      this.#nextWriteError = null;
      return Promise.reject(error);
    }
    // The desktop adapter writes `….tmp` then renames it over the archive: the rename leaves no
    // temporary file, and a leftover one of an earlier crash is overwritten by that same write.
    this.#stored.delete(temporaryArchivePath(accountId, matchId));
    this.#stored.set(archivePath(accountId, matchId), bytes.slice());
    return Promise.resolve();
  }

  /**
   * Read a copy of the archive of a match.
   *
   * @param accountId - The account the archive is pruned for.
   * @param matchId - The match.
   * @returns The archive, or `null` when there is none.
   */
  read(accountId: AccountId, matchId: MatchId): Promise<Uint8Array | null> {
    const bytes = this.#stored.get(archivePath(accountId, matchId));
    return Promise.resolve(bytes === undefined ? null : bytes.slice());
  }

  /**
   * Delete the temporary files of an account; archives, other accounts and the quarantine stay.
   *
   * @param accountId - The account whose leftovers are removed.
   * @returns A promise resolved once the leftovers are gone.
   */
  removeTemporaryFiles(accountId: AccountId): Promise<void> {
    const folderPrefix = `${archiveFolder(accountId)}/`;
    for (const path of [...this.#stored.keys()]) {
      // The trailing `/` of the prefix keeps `archive/1234` from matching `archive/12345/…`.
      if (
        path.startsWith(folderPrefix) &&
        isTemporaryArchiveName(path.slice(folderPrefix.length))
      ) {
        this.#stored.delete(path);
      }
    }
    return Promise.resolve();
  }

  /**
   * Keep a copy of an invalid response, then delete the oldest ones over the limit.
   *
   * @param matchId - The match the response was fetched for.
   * @param at - When the response was quarantined, in Unix milliseconds.
   * @param bytes - The response as it was received.
   * @returns A promise resolved once the response is kept and the folder is trimmed.
   */
  quarantine(matchId: MatchId, at: number, bytes: Uint8Array): Promise<void> {
    this.#stored.set(`${QUARANTINE_FOLDER}/${quarantineFileName(matchId, at)}`, bytes.slice());

    // The names start with the time padded to a fixed width: sorting them as text sorts them by
    // time, oldest first, so the ones to drop are at the front of the list.
    const quarantined = [...this.#stored.keys()]
      .filter((path) => path.startsWith(`${QUARANTINE_FOLDER}/`))
      .sort();
    for (const path of quarantined.slice(0, Math.max(0, quarantined.length - QUARANTINE_LIMIT))) {
      this.#stored.delete(path);
    }
    return Promise.resolve();
  }

  /**
   * Test helper: make the next {@link MemoryArchiveStore.write} fail with this error. Only that
   * one write fails; the following ones succeed again.
   *
   * @param error - The error the write rejects with.
   */
  failNextWrite(error: Error): void {
    this.#nextWriteError = error;
  }

  /**
   * Test helper: leave the temporary file of an interrupted write, as a crash would.
   *
   * @param accountId - The account the interrupted write was for.
   * @param matchId - The match.
   */
  addTemporaryFile(accountId: AccountId, matchId: MatchId): void {
    this.#stored.set(temporaryArchivePath(accountId, matchId), Uint8Array.from(LEFTOVER_BYTES));
  }
}

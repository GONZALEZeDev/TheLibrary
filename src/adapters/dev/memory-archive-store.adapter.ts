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
  ARCHIVE_ROOT,
  isArchiveEntryName,
  isQuarantineFileName,
  isTemporaryArchiveName,
  quarantineFolder,
  quarantinePath,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from '../../core/match-detail/archive-layout';
import type { ArchiveStore } from '../../ports/archive-store.port';

/**
 * What a file added by a test helper contains when its content does not matter: a leftover
 * temporary file (the content of an interrupted write is worthless) or a file of the folder that
 * the test only needs to see listed or removed.
 */
const PLACEHOLDER_BYTES: readonly number[] = [0];

/**
 * The first name of a path relative to a folder.
 *
 * @param relativePath - A path without a leading `/`, e.g. `1234/100000001.json.zst`.
 * @returns The name before the first `/`, or the whole path when it has none.
 */
function firstSegment(relativePath: string): string {
  const separator = relativePath.indexOf('/');
  return separator === -1 ? relativePath : relativePath.slice(0, separator);
}

/** {@link ArchiveStore} that keeps the files of the archive in memory. */
export class MemoryArchiveStore implements ArchiveStore {
  /** Every file of the archive folder: path (from the archive layout) → bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;

  /** The same map as {@link MemoryArchiveStore.files}, typed as writable for this class only. */
  readonly #stored = new Map<string, Uint8Array>();

  /** The failure the next {@link MemoryArchiveStore.write} throws instead of writing. */
  #nextWriteError: Error | null = null;

  /** The failure the next {@link MemoryArchiveStore.removeEntry} throws instead of removing. */
  #nextRemoveError: Error | null = null;

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
      if (!path.startsWith(folderPrefix)) {
        continue;
      }
      const name = path.slice(folderPrefix.length);
      // Only the files directly in the folder, as in the desktop adapter, which lists that folder
      // alone: what the quarantine folder holds is not a leftover of a write, whatever its name.
      if (!name.includes('/') && isTemporaryArchiveName(name)) {
        this.#stored.delete(path);
      }
    }
    return Promise.resolve();
  }

  /**
   * Keep a copy of an invalid response in the quarantine folder of its account, then delete the
   * oldest ones of that folder over the limit.
   *
   * @param accountId - The account the response was fetched for.
   * @param matchId - The match the response was fetched for.
   * @param at - When the response was quarantined, in Unix milliseconds.
   * @param bytes - The response, zstd-compressed.
   * @returns A promise resolved once the response is kept and the folder is trimmed.
   */
  quarantine(accountId: AccountId, matchId: MatchId, at: number, bytes: Uint8Array): Promise<void> {
    this.#stored.set(quarantinePath(accountId, matchId, at), bytes.slice());

    // Only the files named like a quarantined response count, as in the desktop adapter. The names
    // start with the time padded to a fixed width: sorting them as text sorts them by time, oldest
    // first, so the ones to drop are at the front of the list. Only the folder of this account is
    // looked at: the limit is per account.
    const folderPrefix = `${quarantineFolder(accountId)}/`;
    const quarantined = [...this.#stored.keys()]
      .filter(
        (path) =>
          path.startsWith(folderPrefix) && isQuarantineFileName(path.slice(folderPrefix.length)),
      )
      .sort();
    for (const path of quarantined.slice(0, Math.max(0, quarantined.length - QUARANTINE_LIMIT))) {
      this.#stored.delete(path);
    }
    return Promise.resolve();
  }

  /**
   * List the names directly under the archive folder: the first segment of every path below it,
   * each name once. A folder exists as long as a file is in it, as on the keys of the map.
   *
   * @returns The names, in the order their first file was stored; empty when nothing is stored.
   */
  listEntries(): Promise<readonly string[]> {
    const rootPrefix = `${ARCHIVE_ROOT}/`;
    const names = new Set<string>();
    for (const path of this.#stored.keys()) {
      if (path.startsWith(rootPrefix)) {
        names.add(firstSegment(path.slice(rootPrefix.length)));
      }
    }
    return Promise.resolve([...names]);
  }

  /**
   * Delete an entry of the archive folder: the file of that name, or every file below the folder
   * of that name.
   *
   * @param name - The name of the entry; it must be a single name (`isArchiveEntryName`).
   * @returns A promise resolved once the entry is gone.
   * @throws Error, as the desktop adapter does, for a name that is not a single entry name.
   * @throws The error given to {@link MemoryArchiveStore.failNextRemove}, once, when one is queued.
   */
  removeEntry(name: string): Promise<void> {
    if (!isArchiveEntryName(name)) {
      // Refused before the queued failure is looked at, so a refused name does not use it up.
      return Promise.reject(new Error('The name of an archive entry must be a single plain name'));
    }
    if (this.#nextRemoveError !== null) {
      const error = this.#nextRemoveError;
      this.#nextRemoveError = null;
      return Promise.reject(error);
    }
    const entryPath = `${ARCHIVE_ROOT}/${name}`;
    // The trailing `/` keeps the entry `1234` from taking the files of the entry `12345`.
    const entryPrefix = `${entryPath}/`;
    for (const path of [...this.#stored.keys()]) {
      if (path === entryPath || path.startsWith(entryPrefix)) {
        this.#stored.delete(path);
      }
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
   * Test helper: make the next {@link MemoryArchiveStore.removeEntry} fail with this error. Only
   * that one removal fails; the following ones succeed again. A name that is refused (it is not a
   * single entry name) does not use the failure up.
   *
   * @param error - The error the removal rejects with.
   */
  failNextRemove(error: Error): void {
    this.#nextRemoveError = error;
  }

  /**
   * Test helper: leave the temporary file of an interrupted write, as a crash would.
   *
   * @param accountId - The account the interrupted write was for.
   * @param matchId - The match.
   */
  addTemporaryFile(accountId: AccountId, matchId: MatchId): void {
    this.addFile(temporaryArchivePath(accountId, matchId));
  }

  /**
   * Test helper: put a file at any path of the archive folder, such as one the app does not
   * write (a file of the user, or the quarantine folder of the first layout).
   *
   * @param path - The path, as the archive layout builds them (`archive/…`).
   * @param bytes - What the file holds; one byte by default, when the content does not matter.
   */
  addFile(path: string, bytes: Uint8Array = Uint8Array.from(PLACEHOLDER_BYTES)): void {
    this.#stored.set(path, bytes.slice());
  }
}

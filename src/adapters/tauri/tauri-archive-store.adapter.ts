/**
 * {@link ArchiveStore} backed by the Tauri file system plugin (desktop app).
 *
 * The archive lives under the app's local data folder (`%LOCALAPPDATA%\<app id>\archive\…` on
 * Windows): every call passes `BaseDirectory.AppLocalData`, and the paths come from
 * `core/match-detail/archive-layout.ts`, relative to that base. The plugin only reaches the
 * `archive` folder: the permissions and the scope are granted in `src-tauri/capabilities/default.json`.
 *
 * The plugin's `readFile` and `readDir` throw when the path does not exist, whereas the port treats
 * a missing archive as `null` and a missing folder as "nothing to do": the adapter asks `exists`
 * first where that matters. Its `rename` replaces an existing destination on Windows, which is
 * what makes the write atomic.
 *
 * @packageDocumentation
 */
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile,
  remove,
  rename,
  writeFile,
} from '@tauri-apps/plugin-fs';
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

/** The functions of `@tauri-apps/plugin-fs` this adapter uses; tests pass a fake. */
export type FsFunctions = Pick<
  typeof import('@tauri-apps/plugin-fs'),
  'mkdir' | 'writeFile' | 'readFile' | 'exists' | 'readDir' | 'remove' | 'rename'
>;

/** The real plugin, the default of the adapter. */
const pluginFs: FsFunctions = { mkdir, writeFile, readFile, exists, readDir, remove, rename };

/** Options of every call: the archive paths are relative to the local application data folder. */
const AT_LOCAL_DATA = { baseDir: BaseDirectory.AppLocalData } as const;

/** Options of `mkdir`: the `archive` folder itself does not exist either on a first launch. */
const MAKE_FOLDERS = { ...AT_LOCAL_DATA, recursive: true } as const;

/** Options of `rename`, which takes a base directory for each of its two paths. */
const RENAME_AT_LOCAL_DATA = {
  oldPathBaseDir: BaseDirectory.AppLocalData,
  newPathBaseDir: BaseDirectory.AppLocalData,
} as const;

/**
 * The name of a quarantined response, as {@link quarantineFileName} builds it: the time padded to
 * at least 15 digits, a dash, the match id, the archive extension. Anything else found in the
 * quarantine folder is not ours to delete.
 */
const QUARANTINE_NAME = /^\d{15,}-\d+\.json\.zst$/;

/** {@link ArchiveStore} keeping the archive files with `@tauri-apps/plugin-fs`. */
export class TauriArchiveStore implements ArchiveStore {
  readonly #fs: FsFunctions;

  /**
   * @param fs - The plugin's functions; replaced by a fake in tests.
   */
  constructor(fs: FsFunctions = pluginFs) {
    this.#fs = fs;
  }

  /**
   * Replace the archive of a match, atomically.
   *
   * The bytes go to `<archive>.tmp`, which is then renamed over the archive. When either step
   * fails, the temporary file is removed (best effort) and the original error is rethrown: the
   * previous archive, if any, is left as it was.
   *
   * @param accountId - The account the archive is pruned for.
   * @param matchId - The match.
   * @param bytes - The compressed archive.
   * @returns A promise resolved once the archive is in place.
   * @throws Whatever the plugin rejects with: a full disk, a denied path…
   */
  async write(accountId: AccountId, matchId: MatchId, bytes: Uint8Array): Promise<void> {
    const temporaryPath = temporaryArchivePath(accountId, matchId);
    // The account folder, and the `archive` folder above it on a first launch. No temporary file
    // exists yet, so a failure here has nothing to clean up.
    await this.#fs.mkdir(archiveFolder(accountId), MAKE_FOLDERS);
    try {
      await this.#fs.writeFile(temporaryPath, bytes, AT_LOCAL_DATA);
      await this.#fs.rename(temporaryPath, archivePath(accountId, matchId), RENAME_AT_LOCAL_DATA);
    } catch (error) {
      // Do not leave the half-written file for the next start-up cleanup to find.
      await this.#removeQuietly(temporaryPath);
      throw error;
    }
  }

  /**
   * Read the archive of a match.
   *
   * @param accountId - The account the archive is pruned for.
   * @param matchId - The match.
   * @returns The compressed archive, or `null` when the match has none.
   * @throws Whatever the plugin rejects with when the file exists but cannot be read.
   */
  async read(accountId: AccountId, matchId: MatchId): Promise<Uint8Array | null> {
    const path = archivePath(accountId, matchId);
    // `readFile` throws on a missing file, which would be indistinguishable from a real failure.
    if (!(await this.#fs.exists(path, AT_LOCAL_DATA))) {
      return null;
    }
    return this.#fs.readFile(path, AT_LOCAL_DATA);
  }

  /**
   * Delete the temporary files an interrupted write left in the folder of an account.
   *
   * Only that folder is listed, and only the files named like a temporary archive are removed:
   * the archives, the files of other accounts and the quarantine are never touched.
   *
   * The cleanup is best effort: a file that cannot be removed (one held open by an antivirus, say)
   * does not keep the others from being tried. The first failure is thrown once every leftover
   * has had its turn.
   *
   * @param accountId - The account whose leftovers are removed.
   * @returns A promise resolved once the leftovers are gone.
   * @throws Whatever the plugin rejects with when the folder cannot be listed, or, after all the
   *   other leftovers were tried, the first failure to remove one.
   */
  async removeTemporaryFiles(accountId: AccountId): Promise<void> {
    const folder = archiveFolder(accountId);
    // `readDir` throws on a missing folder; before the first archive there is nothing to remove.
    if (!(await this.#fs.exists(folder, AT_LOCAL_DATA))) {
      return;
    }
    // The first failure to remove a file; boxed, as a plugin may reject with any value.
    let firstFailure: { readonly error: unknown } | null = null;
    for (const entry of await this.#fs.readDir(folder, AT_LOCAL_DATA)) {
      // A folder or a link that happens to be named like a temporary file is not a leftover.
      if (entry.isFile && isTemporaryArchiveName(entry.name)) {
        try {
          await this.#fs.remove(`${folder}/${entry.name}`, AT_LOCAL_DATA);
        } catch (error) {
          // Keep going: one undeletable file must not leave the other leftovers in place.
          firstFailure ??= { error };
        }
      }
    }
    if (firstFailure !== null) {
      throw firstFailure.error;
    }
  }

  /**
   * Keep a response that could not be used, then delete the oldest ones over the limit.
   *
   * The response is written straight to its final name, not through a temporary file: a
   * half-written quarantined file is harmless, as nothing ever reads it back.
   *
   * @param matchId - The match the response was fetched for.
   * @param at - When the response was quarantined, in Unix milliseconds.
   * @param bytes - The response as it was received.
   * @returns A promise resolved once the response is kept and the folder is trimmed.
   * @throws Whatever the plugin rejects with: a full disk, a denied path…
   */
  async quarantine(matchId: MatchId, at: number, bytes: Uint8Array): Promise<void> {
    await this.#fs.mkdir(QUARANTINE_FOLDER, MAKE_FOLDERS);
    await this.#fs.writeFile(
      `${QUARANTINE_FOLDER}/${quarantineFileName(matchId, at)}`,
      bytes,
      AT_LOCAL_DATA,
    );

    // The folder exists (it was just made), so listing it cannot fail on a missing path. Only the
    // files named like a quarantined response count: a folder or a stray file is left alone.
    // The names start with the time padded to a fixed width, so sorting them as text sorts them
    // by time, oldest first: the ones to drop are at the front of the list.
    const quarantined = (await this.#fs.readDir(QUARANTINE_FOLDER, AT_LOCAL_DATA))
      .filter((entry) => entry.isFile && QUARANTINE_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of quarantined.slice(0, Math.max(0, quarantined.length - QUARANTINE_LIMIT))) {
      await this.#fs.remove(`${QUARANTINE_FOLDER}/${name}`, AT_LOCAL_DATA);
    }
  }

  /**
   * Remove a file, ignoring any failure: used where the caller already has an error to report and
   * the file may not even exist (the write that failed may never have created it).
   *
   * @param path - The file, relative to the local application data folder.
   * @returns A promise that always resolves.
   */
  async #removeQuietly(path: string): Promise<void> {
    try {
      await this.#fs.remove(path, AT_LOCAL_DATA);
    } catch {
      // Best effort: the leftover is removed by `removeTemporaryFiles` at the next start-up, and
      // the error that matters is the one of the failed write, not this one.
    }
  }
}

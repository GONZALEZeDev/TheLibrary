/**
 * The layout of the archive folder.
 *
 * Every path here is relative to the app's local data directory (Tauri's `AppLocalData` base
 * directory) and uses `/` as separator, which that base directory also accepts on Windows. Paths
 * are only built here: the code that reads and writes the archive never assembles one by hand.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../domain/account';
import type { MatchId } from '../domain/match';

/** The folder that holds everything the app archives. */
export const ARCHIVE_ROOT = 'archive';

/** The folder of the archives that could not be read (kept for a look, never read again). */
export const QUARANTINE_FOLDER = `${ARCHIVE_ROOT}/quarantine`;

/** How many quarantined archives are kept: the 20 most recent. */
export const QUARANTINE_LIMIT = 20;

/** The extension of an archive: JSON compressed with zstd. */
const ARCHIVE_EXTENSION = '.json.zst';

/** The extension added to an archive while it is being written, before it is renamed. */
const TEMPORARY_SUFFIX = '.tmp';

/**
 * The folder that holds the archives of an account.
 *
 * @param accountId - The account the archives were pruned for.
 * @returns The folder, e.g. `archive/123456789`.
 */
export function archiveFolder(accountId: AccountId): string {
  return `${ARCHIVE_ROOT}/${String(accountId)}`;
}

/**
 * The archive of a match.
 *
 * @param accountId - The account the archive is pruned for.
 * @param matchId - The match.
 * @returns The path of the archive, e.g. `archive/123456789/117958378.json.zst`.
 */
export function archivePath(accountId: AccountId, matchId: MatchId): string {
  return `${archiveFolder(accountId)}/${String(matchId)}${ARCHIVE_EXTENSION}`;
}

/**
 * The file an archive is written to before it takes its final name.
 *
 * Writing there then renaming means a crash never leaves a half-written archive under the final
 * name; the leftovers are recognised by {@link isTemporaryArchiveName}.
 *
 * @param accountId - The account the archive is pruned for.
 * @param matchId - The match.
 * @returns The path of the temporary file: the archive path followed by `.tmp`.
 */
export function temporaryArchivePath(accountId: AccountId, matchId: MatchId): string {
  return `${archivePath(accountId, matchId)}${TEMPORARY_SUFFIX}`;
}

/**
 * The name a quarantined archive is moved to.
 *
 * The time is padded to 15 digits (a millisecond time has 13 today) so that sorting the names as
 * plain text sorts them by time: the oldest ones are the first to drop when the folder is over
 * {@link QUARANTINE_LIMIT}.
 *
 * @param matchId - The match of the quarantined archive.
 * @param at - When the archive was quarantined, in Unix milliseconds.
 * @returns The file name, e.g. `001792154119000-117958378.json.zst`.
 */
export function quarantineFileName(matchId: MatchId, at: number): string {
  return `${String(at).padStart(15, '0')}-${String(matchId)}${ARCHIVE_EXTENSION}`;
}

/**
 * Whether a file name is a temporary archive file, left by a write that did not finish.
 *
 * @param name - A file name from an archive folder.
 * @returns `true` when the name ends with `.json.zst.tmp`.
 */
export function isTemporaryArchiveName(name: string): boolean {
  return name.endsWith(`${ARCHIVE_EXTENSION}${TEMPORARY_SUFFIX}`);
}

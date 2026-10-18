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

/**
 * The name of the folder, inside the folder of an account, that holds the API responses that could
 * not be used (kept for a look, never read again).
 */
const QUARANTINE_SUBFOLDER = 'quarantine';

/**
 * The name of the quarantine folder of the first layout of the archive, which sat directly under
 * {@link ARCHIVE_ROOT} and held the responses of every account together. Nothing writes there any
 * more: the name is only known so that the cleanup of the archive folder can remove what is left,
 * since the responses it holds cannot be told apart by account.
 */
export const LEGACY_QUARANTINE_ENTRY = 'quarantine';

/** How many quarantined responses are kept for an account: the 20 most recent. */
export const QUARANTINE_LIMIT = 20;

/** The extension of an archive: JSON compressed with zstd. */
const ARCHIVE_EXTENSION = '.json.zst';

/** The extension added to an archive while it is being written, before it is renamed. */
const TEMPORARY_SUFFIX = '.tmp';

/**
 * The name of the folder of an account, directly under {@link ARCHIVE_ROOT}: its id. Everything the
 * app keeps for an account lives in that folder, so deleting the folder deletes the account's data.
 *
 * @param accountId - The account.
 * @returns The name of its folder, e.g. `123456789`.
 */
export function accountFolderName(accountId: AccountId): string {
  return String(accountId);
}

/**
 * The folder that holds the archives of an account.
 *
 * @param accountId - The account the archives were pruned for.
 * @returns The folder, e.g. `archive/123456789`.
 */
export function archiveFolder(accountId: AccountId): string {
  return `${ARCHIVE_ROOT}/${accountFolderName(accountId)}`;
}

/**
 * The folder of the API responses of an account that could not be used (kept for a look, never
 * read again). It holds the responses, zstd-compressed, of the matches whose detail was refused: an
 * archive that cannot be read back is never moved here. It sits inside the folder of the account,
 * so that it goes with the account and never holds the responses of another one.
 *
 * @param accountId - The account the responses were fetched for.
 * @returns The folder, e.g. `archive/123456789/quarantine`.
 */
export function quarantineFolder(accountId: AccountId): string {
  return `${archiveFolder(accountId)}/${QUARANTINE_SUBFOLDER}`;
}

/**
 * The archive of a match.
 *
 * @param accountId - The account the archive is pruned for.
 * @param matchId - The match.
 * @returns The path of the archive, e.g. `archive/123456789/100000001.json.zst`.
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
 * The name of a quarantined response, in the quarantine folder.
 *
 * The time is padded to 15 digits (a millisecond time has 13 today) so that sorting the names as
 * plain text sorts them by time: the oldest ones are the first to drop when the folder is over
 * {@link QUARANTINE_LIMIT}.
 *
 * @param matchId - The match the response was fetched for.
 * @param at - When the response was quarantined, in Unix milliseconds.
 * @returns The file name, e.g. `001792154119000-100000001.json.zst`.
 */
export function quarantineFileName(matchId: MatchId, at: number): string {
  return `${String(at).padStart(15, '0')}-${String(matchId)}${ARCHIVE_EXTENSION}`;
}

/**
 * The file of a quarantined response.
 *
 * @param accountId - The account the response was fetched for.
 * @param matchId - The match the response was fetched for.
 * @param at - When the response was quarantined, in Unix milliseconds.
 * @returns The path, e.g. `archive/123456789/quarantine/001792154119000-100000001.json.zst`.
 */
export function quarantinePath(accountId: AccountId, matchId: MatchId, at: number): string {
  return `${quarantineFolder(accountId)}/${quarantineFileName(matchId, at)}`;
}

/**
 * What {@link quarantineFileName} builds: the time padded to at least 15 digits, a dash, the match
 * id, the archive extension. It is the one copy of that shape outside the function itself.
 */
const QUARANTINE_NAME = /^\d{15,}-\d+\.json\.zst$/;

/**
 * Whether a file name is a quarantined response, named by {@link quarantineFileName}. The stores
 * trim the quarantine folder by name, so anything else found there (a note, a folder, a file of
 * another program) is not ours to delete.
 *
 * @param name - A file name from the quarantine folder.
 * @returns `true` when the name has the shape of {@link quarantineFileName}.
 */
export function isQuarantineFileName(name: string): boolean {
  return QUARANTINE_NAME.test(name);
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

/**
 * What cannot be in the name of an entry of the archive folder: a path separator, which would
 * reach another folder, and the drive or stream separator of Windows.
 */
const FORBIDDEN_IN_ENTRY_NAME = /[/\\:]/;

/** The first code unit that is not a control character: U+0000 to U+001F come before it. */
const FIRST_NON_CONTROL_CODE = 0x20;

/**
 * Whether a string holds a control character (U+0000 to U+001F). NUL ends a path in the system
 * calls, and the others have no place in the name of a file the app made or listed.
 *
 * @param text - The string to look at.
 * @returns `true` when at least one character is a control character.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < FIRST_NON_CONTROL_CODE) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a string is the name of one entry directly under {@link ARCHIVE_ROOT}: a non-empty single
 * name with
 * - no `/`, `\` or `:`, which would reach another folder, a drive or a stream of a file;
 * - no control character (U+0000 to U+001F), NUL being the one that ends a path in system calls;
 * - no `.` or space at the end: Windows strips them from the name of a file or folder, so `..` could
 *   be asked for as `.. ` or `...`, and would resolve to the parent folder. This also refuses `.`
 *   and `..` themselves.
 *
 * The stores check the name they are asked to remove with it, so that removing an entry can never
 * reach outside the archive folder, whatever the caller built the name from.
 *
 * @param name - A name to remove from the archive folder.
 * @returns `true` when the name is a single, plain entry name.
 */
export function isArchiveEntryName(name: string): boolean {
  return (
    name !== '' &&
    !name.endsWith('.') &&
    !name.endsWith(' ') &&
    !FORBIDDEN_IN_ENTRY_NAME.test(name) &&
    !hasControlCharacter(name)
  );
}

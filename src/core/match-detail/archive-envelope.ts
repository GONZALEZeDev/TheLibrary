/**
 * The envelope written in each archive file, and its byte encoding.
 *
 * An archive file holds one match detail, already pruned for the tracked player (see
 * `./pruning`), wrapped with what the reader needs to trust it: the format of the file, the account
 * it was pruned for and when it was fetched. The envelope is serialised as JSON in UTF-8; the bytes
 * are what the compressor and the file storage handle, so this module knows nothing of either.
 *
 * Reading is strict: the bytes come from a file on the user's disk, which can be truncated, edited
 * or written by a newer version of the app, so anything unexpected is refused with an
 * `invalid_payload` error instead of being half-read. No error ever holds a value of the file: the
 * payload belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../domain/account';
import { parseAccountId } from '../domain/account';
import { AppError } from '../errors/app-error';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import type { RawMatchMetadata } from '../deadlock-api/match-metadata.schema';

/**
 * The format of the archive files this version writes.
 *
 * Format 2 keeps the movement paths of all twelve players; format 1 kept only the tracked
 * player's. A file of a format this version does not know (written by a newer version of the app,
 * for instance) is refused rather than guessed at: bump this number, and widen
 * {@link ArchiveFormat}, whenever the envelope changes in a way an older reader could not cope with.
 */
export const ARCHIVE_FORMAT = 2;

/**
 * The formats of archive file this version can read: the current one and the one before it, whose
 * files stay readable (they only lack the paths of the other players).
 */
export type ArchiveFormat = 1 | 2;

/** What an archive file holds. */
export interface ArchiveEnvelope {
  /**
   * The format of the file: {@link ARCHIVE_FORMAT} for an envelope this version created, the
   * file's own format for one it decoded (so a format-1 file is never passed off as a current one).
   */
  readonly archiveFormat: ArchiveFormat;
  /** The tracked account the payload was pruned for: the player the archive is about. */
  readonly prunedForAccountId: AccountId;
  /** When the detail was fetched from the API, in Unix milliseconds. */
  readonly fetchedAt: number;
  /** The match detail, pruned for {@link ArchiveEnvelope.prunedForAccountId}. */
  readonly payload: RawMatchMetadata;
}

/**
 * Wrap a pruned match detail in an envelope, ready to be encoded.
 *
 * @param payload - The match detail, already pruned for the account.
 * @param accountId - The tracked account the detail was pruned for.
 * @param fetchedAt - When the detail was fetched from the API, in Unix milliseconds.
 * @returns The envelope.
 */
export function createArchiveEnvelope(
  payload: RawMatchMetadata,
  accountId: AccountId,
  fetchedAt: number,
): ArchiveEnvelope {
  return {
    archiveFormat: ARCHIVE_FORMAT,
    prunedForAccountId: accountId,
    fetchedAt,
    payload,
  };
}

/**
 * Encode an envelope as the bytes of an archive file: its JSON text, in UTF-8.
 *
 * The JSON is compact (no indentation) since the bytes are compressed right after.
 *
 * @param envelope - The envelope to encode; it is not modified.
 * @returns The UTF-8 bytes of the envelope.
 */
export function encodeArchiveEnvelope(envelope: ArchiveEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/**
 * Decode and validate the bytes of an archive file.
 *
 * The format is checked before anything else, so that a file of a later format is reported as such
 * whatever its other fields hold. Formats 1 and 2 are both read, and the envelope keeps the format
 * of the file it came from. The payload goes through the same schema as a fresh API response,
 * except the match id: the reader only has bytes, and the match id belongs to the file name.
 *
 * @param bytes - The UTF-8 bytes of the envelope.
 * @returns The envelope.
 * @throws AppError of kind `invalid_payload` and message `The archive is unreadable`, whose context
 *   `issue` tells which check failed, never a value of the file:
 *   - `archive_utf8`: the bytes are not valid UTF-8;
 *   - `archive_json`: the text is not JSON (an empty or truncated file included);
 *   - `archive_shape`: the JSON is not an object;
 *   - `archive_format`: the `archiveFormat` is not 1 or 2 (missing, another number, or not a number);
 *   - `prunedForAccountId: invalid_value` or `fetchedAt: invalid_value`: that field is not valid;
 *   - `payload.<path>: <code>`: the payload is not a match detail (or `payload: <code>` when it is
 *     missing or not an object), `<path>: <code>` being the first problem found by the schema.
 */
export function decodeArchiveEnvelope(bytes: Uint8Array): ArchiveEnvelope {
  const value = parseJson(decodeUtf8(bytes));
  if (!isRecord(value)) {
    throw unreadableArchive('archive_shape');
  }
  // Checking both values (rather than a range) lets the compiler narrow the field to `ArchiveFormat`.
  const { archiveFormat } = value;
  if (archiveFormat !== 1 && archiveFormat !== 2) {
    throw unreadableArchive('archive_format');
  }
  const accountId = parseAccountId(value.prunedForAccountId);
  if (accountId === null) {
    throw unreadableArchive('prunedForAccountId: invalid_value');
  }
  // Times are Unix milliseconds: a non-negative safe integer, never text or a decimal.
  const { fetchedAt } = value;
  if (typeof fetchedAt !== 'number' || !Number.isSafeInteger(fetchedAt) || fetchedAt < 0) {
    throw unreadableArchive('fetchedAt: invalid_value');
  }
  // Built here, not through `createArchiveEnvelope`, which stamps the current format: this one
  // carries the format the file was written in.
  return {
    archiveFormat,
    prunedForAccountId: accountId,
    fetchedAt,
    payload: parsePayload(value.payload),
  };
}

/**
 * Decode UTF-8 bytes to text, refusing invalid UTF-8.
 *
 * The decoder is `fatal`: by default it would silently replace an invalid sequence with U+FFFD and
 * hand back a text that is not the one that was written.
 *
 * @param bytes - The bytes of the file.
 * @returns The text.
 * @throws AppError of kind `invalid_payload` (`archive_utf8`) when the bytes are not valid UTF-8.
 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // The decoder's error says nothing more than the issue does, so it is not kept as the cause.
    throw unreadableArchive('archive_utf8');
  }
}

/**
 * Parse the JSON text of an archive.
 *
 * @param text - The text of the file.
 * @returns The parsed value.
 * @throws AppError of kind `invalid_payload` (`archive_json`) when the text is not JSON.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The engine's syntax error quotes a piece of the text, i.e. a value of the file: it is
    // dropped, not kept as the cause, so that it can never reach a log.
    throw unreadableArchive('archive_json');
  }
}

/**
 * Validate the payload of an envelope as a match detail.
 *
 * @param payload - The `payload` field of the parsed file.
 * @returns The validated match detail.
 * @throws AppError of kind `invalid_payload` (`payload.<path>: <code>`) when it is not one.
 */
function parsePayload(payload: unknown): RawMatchMetadata {
  try {
    return parseMatchMetadata(payload);
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }
    throw unreadableArchive(prefixWithPayload(error.context.issue), error);
  }
}

/**
 * Locate a problem of the match detail schema inside the envelope: `<path>: <code>` becomes
 * `payload.<path>: <code>`.
 *
 * @param issue - The `issue` of the schema's error.
 * @returns The same problem, located under `payload`.
 */
function prefixWithPayload(issue: unknown): string {
  if (typeof issue !== 'string') {
    return 'payload';
  }
  // The schema names a problem on the detail itself `(root)`: the payload is then the whole path.
  const root = '(root)';
  return issue.startsWith(root) ? `payload${issue.slice(root.length)}` : `payload.${issue}`;
}

/**
 * Build the error of an archive that cannot be read.
 *
 * @param issue - Which check failed (see {@link decodeArchiveEnvelope}); never a value of the file.
 * @param cause - The underlying error, when it is safe to keep (it holds no value of the file).
 * @returns The error to throw.
 */
function unreadableArchive(issue: string, cause?: unknown): AppError {
  return new AppError('invalid_payload', 'The archive is unreadable', {
    ...(cause === undefined ? {} : { cause }),
    context: { issue },
  });
}

/**
 * Tell whether a parsed JSON value is an object (not `null`, not an array).
 *
 * @param value - A parsed JSON value.
 * @returns `true` for an object, whose fields can then be read.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

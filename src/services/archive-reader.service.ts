/**
 * The archive reader: turns the file of an archived match back into its envelope, or tells that the
 * archive cannot be used. It is shared by everything that works from the archives (the match page
 * and the services built on it), so that one set of rules says what an unreadable archive is and how
 * it is logged.
 *
 * Reading goes through three steps, in this order: read the file, decompress it, decode the
 * envelope. What can go wrong in them falls in two kinds:
 * - a problem with what the archive holds says something about the archive: the file is absent
 *   (logged at `info` level, since a folder emptied by hand is not a failure of the app), or the
 *   data is damaged (it does not decompress, or it does not decode as an envelope), which is logged
 *   as a warning. Either way the answer is `unreadable`, and the caller decides what it means for
 *   the match (the match page puts it back to `pending`). The file itself is never touched;
 * - a failure that says nothing about the archive is an error for the caller, so that it does not
 *   touch the match: the disk cannot read the file (a lock, a permission), or the compressor is
 *   broken (its worker failed to load or crashed). The archive may be perfectly fine.
 *
 * The caller that goes further (the match page reads the facts of the match from the envelope) tells
 * the reader when that step finds the archive unusable, with {@link ArchiveReaderService.reportUnreadable},
 * so that every line about an unreadable archive has the same shape.
 *
 * Nothing here logs a value of an archive or an account id: a line holds the step and the codes of
 * the failure (a field path and an issue code), and a path quoted by an error of the disk has the
 * account id replaced.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { AppError, isAppError } from '../core/errors/app-error';
import { decodeArchiveEnvelope, type ArchiveEnvelope } from '../core/match-detail/archive-envelope';
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Compressor } from '../ports/compressor.port';
import type { Logger } from '../ports/logger.port';
import { describeErrorForLog } from './match-detail-verdicts';

/** What {@link ArchiveReaderService} needs. */
export interface ArchiveReaderServiceDependencies {
  /** Where the archives are kept. */
  readonly archive: ArchiveStore;
  /** Decompresses the archives. */
  readonly compressor: Compressor;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * The step of the reading of an archive that failed, for the log: the record of the database, the
 * read of the file, its decompression, the decoding of the envelope, the reading of the facts.
 * (A failed read of the file is not a log line but the error of the caller: it names the step in its
 * context. The record and the facts are the caller's steps, which it reports with
 * {@link ArchiveReaderService.reportUnreadable}.)
 */
export type ArchiveReadStep = 'record' | 'read' | 'decompress' | 'decode' | 'summarize';

/** What the reading of an archive ended in. */
export type ArchiveRead =
  /** The archive was read and decoded. */
  | { readonly kind: 'read'; readonly envelope: ArchiveEnvelope }
  /** The archive cannot be used because of what it holds: it is absent or damaged (already logged). */
  | { readonly kind: 'unreadable' };

/** The scope of the log lines about the archives: the one of the detail queue, which writes them. */
const LOG_SCOPE = 'detail';

/** Reads the archives of the matches back, and reports the ones that cannot be used. */
export class ArchiveReaderService {
  readonly #archive: ArchiveStore;
  readonly #compressor: Compressor;
  readonly #logger: Logger;

  /**
   * @param dependencies - See {@link ArchiveReaderServiceDependencies}.
   */
  constructor(dependencies: ArchiveReaderServiceDependencies) {
    this.#archive = dependencies.archive;
    this.#compressor = dependencies.compressor;
    this.#logger = dependencies.logger;
  }

  /**
   * Read the archive of a match: read the file, decompress it, decode the envelope.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match.
   * @returns The envelope, or `unreadable` when the archive cannot be used because of what it holds:
   *   the file is absent (logged at `info` level), or the data is damaged at a step after the read
   *   (logged as a warning, with the step).
   * @throws AppError of kind `storage` when the file cannot be read, or when the compressor is
   *   broken: neither says anything about the archive, so the caller must not touch the match.
   */
  async readArchive(accountId: AccountId, matchId: MatchId): Promise<ArchiveRead> {
    const compressed = await this.#readFile(accountId, matchId);
    if (compressed === null) {
      this.#logger.log('info', LOG_SCOPE, 'Detail archive is missing', { matchId });
      return { kind: 'unreadable' };
    }
    // Where the reading stands, for the log of a failure.
    let step: ArchiveReadStep = 'decompress';
    try {
      const decompressed = await this.#compressor.decompress(compressed);
      step = 'decode';
      return { kind: 'read', envelope: decodeArchiveEnvelope(decompressed) };
    } catch (error) {
      // The worker compressor tells a problem of the data (`invalid_payload`: the codec ran and
      // failed on these bytes, which are not a zstd frame) from a broken compressor (any other
      // kind of `AppError`, `storage`: the worker crashed, or answered that it could not load its
      // codec, say because the WebAssembly was refused). Only the first says something about the
      // archive. What is not an `AppError` is the codec's own error, thrown by the compressor of
      // the tests for a bad frame: a data problem.
      if (step === 'decompress' && isAppError(error) && error.kind !== 'invalid_payload') {
        throw error;
      }
      this.reportUnreadable(accountId, matchId, step, error);
      return { kind: 'unreadable' };
    }
  }

  /**
   * Log an archive that cannot be read, as a warning. The line holds the step and the codes of the
   * failure: the errors of the archive carry the problem as a field path and an issue code, never a
   * value of the file, and a path in an error of the disk has the account id replaced.
   *
   * The reader logs the steps it takes by itself; this is for the steps of the caller (the record of
   * the database, the reading of the facts of the envelope), so that all the lines look alike.
   *
   * @param accountId - The tracked account, kept out of the log.
   * @param matchId - The match.
   * @param step - The step that failed.
   * @param error - What was caught.
   */
  reportUnreadable(
    accountId: AccountId,
    matchId: MatchId,
    step: ArchiveReadStep,
    error: unknown,
  ): void {
    this.#logger.log('warn', LOG_SCOPE, 'Detail archive is unreadable', {
      // The stack is kept for what is not an `AppError` (the compressor's library, a bug): the
      // errors of the app say by themselves what failed.
      ...describeErrorForLog(error, accountId, !isAppError(error)),
      matchId,
      step,
    });
  }

  /**
   * Read the file of an archive.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match.
   * @returns The compressed archive, or `null` when the match has no file.
   * @throws AppError of kind `storage` when the file exists but cannot be read. The adapters do not
   *   wrap their failures, so it is wrapped here, without the raw error as its cause: the error of
   *   the disk may quote the path, which holds the account id, and the interface logs what it
   *   catches. The description of the failure is in the context instead, with the account id
   *   replaced, as the log of the queue does.
   */
  async #readFile(accountId: AccountId, matchId: MatchId): Promise<Uint8Array | null> {
    try {
      return await this.#archive.read(accountId, matchId);
    } catch (error) {
      throw new AppError('storage', 'The archive of a match could not be read', {
        context: { ...describeErrorForLog(error, accountId, false), step: 'read', matchId },
      });
    }
  }
}

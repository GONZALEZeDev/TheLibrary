/**
 * The detail queue: downloads the detail of every Paige match of the linked account that is due,
 * prunes it to the tracked player, compresses and archives it, and records how each attempt went.
 * It also serves what the interface shows of it: the count of the details by status, the detail of
 * one match, and the retry of a match that failed.
 *
 * A run (`MatchDetailService.runQueue`) starts by removing the temporary files an interrupted write
 * left behind (a file that cannot be removed is logged and does not stop the run: the next write of
 * its match replaces it), then two pullers take the matches `MatchDetailRepository.nextDue` offers,
 * most recent first, until none is due. For one match the steps are, in this order:
 * download, validate (for the match that was asked for), find the tracked player, prune, wrap in an
 * envelope, read the facts of the match page back from it (the door check), encode, compress, write
 * the archive, and only then record the match as archived. The record comes last: if anything
 * before it fails, the database still says the match is to do, and a file already written is simply
 * written again by the next attempt.
 *
 * What an attempt can end in, and what it costs (the rules are in `./match-detail-verdicts`):
 * - the API answers with an HTTP status that says it has no detail (404), failed, refused, or was
 *   not understood, or it answers with no body: a counted failure, retried later (`retry`, then
 *   `unavailable` at the 6th);
 * - the answer is a detail the app cannot use (not a match detail, another match, without the
 *   tracked player, whose facts cannot be read back, a body over 10 MB): a counted failure that is
 *   final (`invalid`). The raw body is quarantined for a look, when there is one;
 * - the answer is a success whose body is not JSON (the page of a proxy or of a security product):
 *   one counted failure, retried later, the body quarantined, and the run stops as a `network`
 *   failure: the next match would get the same page;
 * - the failure says nothing about the match, so no attempt is counted and the run stops, leaving the
 *   match as it was: a pause asked by deadlock-api (`paused`), the network, a timeout, or a failure
 *   with no HTTP status (`network`), or a local failure, which is anything that is not the API's
 *   doing (`storage`): the disk, the database, the compressor, or a bug.
 *
 * When a puller stops the run, the other one finishes the match it holds (its outcome is recorded
 * like any other) and takes no new one. A run never throws: what went wrong is in its report and in
 * the log. Failures are logged here, once each (`warn` for a final verdict, for a match given up and
 * for a stop; `info` for a pause); the log never holds a body, a value of a payload or an account id.
 *
 * The reading side (`getSummary`, `getMatchDetail`, `resetForRetry`) works for the linked account,
 * which it resolves itself: the interface never handles an account id. The database says where a
 * match stands, and only an archived (`ready`) match has a file to read. A file that is absent, or
 * that cannot be read back, is not an error for the page: the match goes back to `pending` and the
 * view says `missing`, so that the next run downloads it again. That cannot loop, since the queue
 * archives nothing whose facts it could not read back: the same detail would be refused as `invalid`.
 * The file of an unreadable archive is left alone, for the next archive written to replace it.
 *
 * @packageDocumentation
 */
import { METADATA_MAX_CONCURRENCY } from '../core/deadlock-api/budgets';
import { parseMatchMetadata } from '../core/deadlock-api/match-metadata.schema';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { AppError, errorLogContext, isAppError, toAppError } from '../core/errors/app-error';
import {
  createArchiveEnvelope,
  decodeArchiveEnvelope,
  encodeArchiveEnvelope,
} from '../core/match-detail/archive-envelope';
import { summarizeArchive, type ArchiveFacts } from '../core/match-detail/archive-facts';
import { afterFailedAttempt, isDetailEligible } from '../core/match-detail/detail-status';
import { findTrackedPlayer, pruneForPlayer } from '../core/match-detail/pruning';
import type { AccountSource } from '../ports/account-source.port';
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Compressor } from '../ports/compressor.port';
import type { Logger } from '../ports/logger.port';
import type { DeadlockApiService, MetadataFetch } from './deadlock-api.service';
import type { DetailSummary, DueMatch, MatchDetailRepository } from './match-detail.repository';
import {
  describeErrorForLog,
  describeInvalidPayload,
  invalid,
  judgeDownloadError,
  retryable,
  stopOf,
  unreadableAnswer,
  type Attempt,
  type DetailRunStop,
} from './match-detail-verdicts';

export type { DetailRunStop } from './match-detail-verdicts';
export type { DetailSummary } from './match-detail.repository';

/** What {@link MatchDetailService} needs. */
export interface MatchDetailServiceDependencies {
  /**
   * The linked account. The queue itself is given the account of each run; the source is for the
   * reading side of the service (the summary and the detail of a match shown by the interface).
   */
  readonly accountSource: AccountSource;
  /** Downloads the details. */
  readonly api: DeadlockApiService;
  /** Where the detail state of each match is kept. */
  readonly repository: MatchDetailRepository;
  /** Where the archives and the quarantined responses are kept. */
  readonly archive: ArchiveStore;
  /** Compresses the archives. */
  readonly compressor: Compressor;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
  /** Random source of the retry delays, in [0, 1); `Math.random` by default. */
  readonly random?: () => number;
}

/** How a run of the queue went. */
export interface DetailRunReport {
  /** Matches whose detail was archived. */
  readonly archived: number;
  /** Matches whose attempt failed and will be tried again later. */
  readonly retried: number;
  /** Matches given up after their sixth counted failure. */
  readonly unavailable: number;
  /** Matches whose answer cannot be used (final). */
  readonly invalid: number;
  /** Why the run ended early, or `null` when it went through every due match. */
  readonly stoppedBy: DetailRunStop | null;
}

/** What the match page shows about the detail of one match. */
export type MatchDetailView =
  /** No account is linked, so there is no match to show. */
  | { readonly kind: 'no_account' }
  /**
   * The app does not archive this match: it is unknown, or not a normal-mode Paige match of the
   * last 90 days. Only a match with no archive can be this: an archive is shown whatever its age.
   */
  | { readonly kind: 'not_eligible' }
  /**
   * The detail is to be downloaded (`pending`, with no date) or to be downloaded again after a
   * failed attempt (`retry`, with the date from which the queue tries it again, in Unix ms).
   */
  | { readonly kind: 'waiting'; readonly nextAttemptAt: number | null }
  /** The queue gave up after too many failed attempts. */
  | { readonly kind: 'unavailable'; readonly lastError: string | null }
  /** The API answered with a detail the app cannot use. */
  | { readonly kind: 'invalid'; readonly lastError: string | null }
  /**
   * The match was recorded as archived but its file is absent or cannot be read. It was put back
   * to `pending`: the next run of the queue downloads it again.
   */
  | { readonly kind: 'missing' }
  /** The detail is archived: what the page shows of it, and the size of the archive file. */
  | { readonly kind: 'ready'; readonly facts: ArchiveFacts; readonly archivedBytes: number };

/** The scope of the log lines of the queue. */
const LOG_SCOPE = 'detail';

/**
 * How many matches are processed at the same time: as many as deadlock-api allows in flight. While
 * one match is compressed and written, the other one is already downloading.
 */
const PULLER_COUNT = METADATA_MAX_CONCURRENCY;

/** What a run counts as it goes. Read by the pullers, which share one object, and by the report. */
interface RunState {
  archived: number;
  retried: number;
  unavailable: number;
  invalid: number;
  /** Responses kept in the quarantine folder during this run (only the log line counts them). */
  quarantined: number;
  /** The first reason the run was stopped for; once set, no puller starts a new match. */
  stoppedBy: DetailRunStop | null;
}

/**
 * The step of the reading of an archive that failed, for the log: the record of the database, the
 * read of the file, its decompression, the decoding of the envelope, the reading of the facts.
 */
type ArchiveReadStep = 'record' | 'read' | 'decompress' | 'decode' | 'summarize';

/**
 * Downloads, archives and keeps track of the detail of the matches of the linked account, and reads
 * it back for the interface.
 */
export class MatchDetailService {
  readonly #accountSource: AccountSource;
  readonly #api: DeadlockApiService;
  readonly #repository: MatchDetailRepository;
  readonly #archive: ArchiveStore;
  readonly #compressor: Compressor;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #listeners = new Set<() => void>();

  /**
   * @param dependencies - See {@link MatchDetailServiceDependencies}.
   */
  constructor(dependencies: MatchDetailServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#api = dependencies.api;
    this.#repository = dependencies.repository;
    this.#archive = dependencies.archive;
    this.#compressor = dependencies.compressor;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
  }

  /**
   * Process every due match of the account: download its detail, archive it, and record the
   * outcome. Matches are taken most recent first, two at a time.
   *
   * @param accountId - The tracked account.
   * @param syncRunId - Id of the synchronisation that runs the queue, to tie the log lines to it.
   * @returns How the run went. It never rejects: a failure ends the run and is in the report
   *   (`stoppedBy`) and in the log.
   */
  async runQueue(accountId: AccountId, syncRunId: string): Promise<DetailRunReport> {
    const run: RunState = {
      archived: 0,
      retried: 0,
      unavailable: 0,
      invalid: 0,
      quarantined: 0,
      stoppedBy: null,
    };
    try {
      // An interrupted write left a temporary file: it is useless, and the next write replaces it.
      await this.#archive.removeTemporaryFiles(accountId);
    } catch (error) {
      // Not a reason to stop: a leftover is harmless, so a file that cannot be deleted (held open by
      // another program, say) must not keep the matches from being archived, run after run.
      this.#logLeftoversKept(accountId, syncRunId, error);
    }
    // The matches the pullers hold or held in this run. A match is tried once per run, whatever
    // becomes of it, and this is how the pullers keep from taking the same match.
    const taken = new Set<MatchId>();
    await Promise.all(
      Array.from({ length: PULLER_COUNT }, () => this.#pull(accountId, syncRunId, run, taken)),
    );
    const report: DetailRunReport = {
      archived: run.archived,
      retried: run.retried,
      unavailable: run.unavailable,
      invalid: run.invalid,
      stoppedBy: run.stoppedBy,
    };
    this.#logger.log('info', LOG_SCOPE, 'Detail queue ended', {
      syncRunId,
      archived: run.archived,
      retried: run.retried,
      unavailable: run.unavailable,
      invalid: run.invalid,
      quarantined: run.quarantined,
      stoppedBy: run.stoppedBy,
    });
    return report;
  }

  /**
   * Be told after each match whose outcome was recorded (progress). An arrow function, so that it
   * can be passed as is to React's `useSyncExternalStore`.
   *
   * @param listener - Called after each recorded match.
   * @returns A function that unsubscribes the listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Count the details of the linked account by status, for the banner of the interface. Only the
   * matches the queue archives are counted (see `MatchDetailRepository.summary`).
   *
   * @returns The counts, or `null` when no account is linked.
   * @throws AppError of kind `storage` when the database fails.
   */
  async getSummary(): Promise<DetailSummary | null> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return null;
    }
    return this.#repository.summary(accountId, this.#now());
  }

  /**
   * Tell what the match page shows about the detail of a match of the linked account: the facts of
   * its archive, or why there is none.
   *
   * The checks are made in this order, and the order matters:
   * 1. a match the app does not know is `not_eligible`;
   * 2. an archived (`ready`) match is read, whatever its age: the file is there, so the page shows
   *    it even once the match has aged past the 90 days of the window;
   * 3. any other match that the queue would not archive (`isDetailEligible`) is `not_eligible`;
   * 4. a `pending` or `retry` match is `waiting`, and an `unavailable` or `invalid` one says so,
   *    with the code of its last failure.
   *
   * An archive that is absent, or that cannot be read back at any step (including the facts), is
   * not an error for the page: the match is put back to `pending` and the view is `missing`. The
   * file of an unreadable archive is not deleted; the next archive written replaces it.
   *
   * @param matchId - The match.
   * @returns What to show.
   * @throws AppError of kind `storage` when the database fails. That includes the failure to put a
   *   match back to `pending`: the view is a read for the interface, which shows the error, and
   *   answering `missing` while the database still says `ready` would be a lie, since the queue
   *   would never download the match. The next read tries again.
   */
  async getMatchDetail(matchId: MatchId): Promise<MatchDetailView> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { kind: 'no_account' };
    }
    const stored = await this.#repository.getDetail(accountId, matchId);
    if (stored === null) {
      return { kind: 'not_eligible' };
    }
    if (stored.status === 'ready') {
      return this.#showArchive(accountId, matchId, stored.archivedBytes);
    }
    // The rule is the core's, with the fields the repository read: a copy of it here would drift.
    if (!isDetailEligible(stored.match, this.#now())) {
      return { kind: 'not_eligible' };
    }
    switch (stored.status) {
      case 'pending':
        return { kind: 'waiting', nextAttemptAt: null };
      case 'retry':
        return { kind: 'waiting', nextAttemptAt: stored.nextAttemptAt };
      case 'unavailable':
        return { kind: 'unavailable', lastError: stored.lastError };
      case 'invalid':
        return { kind: 'invalid', lastError: stored.lastError };
    }
  }

  /**
   * Put a failed match back in the queue, for the "Retry" action: only an `unavailable` or an
   * `invalid` match goes back to `pending`, so that the next run downloads it again. Any other
   * match is left as it is (a match that waits for its retry date, or is archived, has nothing to
   * retry), and so is one the app does not know. Without a linked account, nothing happens.
   *
   * The state is read, then written, which is not atomic. That is harmless: the queue never takes
   * an `unavailable` or an `invalid` match, so nothing changes it in between except this same call.
   *
   * @param matchId - The match.
   * @throws AppError of kind `storage` when the database fails.
   */
  async resetForRetry(matchId: MatchId): Promise<void> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return;
    }
    const stored = await this.#repository.getDetail(accountId, matchId);
    if (stored?.status === 'unavailable' || stored?.status === 'invalid') {
      await this.#repository.resetToPending(accountId, matchId);
    }
  }

  /**
   * One puller: take the due matches one after the other and process them, until none is due or the
   * run is stopped. It never rejects: whatever goes wrong stops the run.
   *
   * @param accountId - The tracked account.
   * @param syncRunId - Id of the run in the logs.
   * @param run - What the run counts, shared with the other puller.
   * @param taken - The matches taken in this run, shared with the other puller.
   */
  async #pull(
    accountId: AccountId,
    syncRunId: string,
    run: RunState,
    taken: Set<MatchId>,
  ): Promise<void> {
    for (;;) {
      let due: DueMatch | null;
      try {
        due = await this.#claimNext(accountId, taken);
      } catch (error) {
        this.#stop(run, stopOf(error), error, accountId, syncRunId);
        return;
      }
      if (due === null) {
        return;
      }
      // The stop is read here, once the match is claimed and right before it starts: the other
      // puller may have stopped the run while the database was answering. The match is given back,
      // untouched, as if it had not been offered.
      if (run.stoppedBy !== null) {
        taken.delete(due.matchId);
        return;
      }
      try {
        await this.#process(accountId, due, run, syncRunId);
      } catch (error) {
        this.#stop(run, stopOf(error), error, accountId, syncRunId, due.matchId);
        return;
      }
    }
  }

  /**
   * Take the next due match for the calling puller, so that the other one cannot take it.
   *
   * The other puller asks for its own match at the same time, and both questions are answered from
   * the same state of the database: they can both name the same match. The match is therefore
   * claimed once the answer is back, in the same synchronous block as the check, without any
   * `await` in between: the first puller to get the answer claims the match, and the other asks
   * again, now that it is excluded.
   *
   * @param accountId - The tracked account.
   * @param taken - The matches taken in this run; the claimed match is added to it.
   * @returns The claimed match, or `null` when none is due.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #claimNext(accountId: AccountId, taken: Set<MatchId>): Promise<DueMatch | null> {
    // Each round either claims a match, or sees that the other puller claimed the one it was
    // offered: the matches are finite, and each round that does not claim excludes one more.
    for (;;) {
      const due = await this.#repository.nextDue(accountId, this.#now(), taken);
      if (due === null) {
        return null;
      }
      if (!taken.has(due.matchId)) {
        taken.add(due.matchId);
        return due;
      }
    }
  }

  /**
   * Attempt one match and record the outcome.
   *
   * @param accountId - The tracked account.
   * @param due - The match, with the failures counted before.
   * @param run - What the run counts.
   * @param syncRunId - Id of the run in the logs.
   * @throws The error that stops the run: nothing was recorded for the match (or, for a response
   *   that could not be quarantined, only its verdict).
   */
  async #process(
    accountId: AccountId,
    due: DueMatch,
    run: RunState,
    syncRunId: string,
  ): Promise<void> {
    const { matchId } = due;
    const attempt = await this.#attempt(accountId, matchId);
    if (attempt.outcome === 'archived') {
      run.archived += 1;
      this.#logger.log('debug', LOG_SCOPE, 'Detail archived', {
        syncRunId,
        matchId,
        archivedBytes: attempt.archivedBytes,
      });
      this.#notify();
      return;
    }
    if (attempt.stopRun !== undefined) {
      // Before anything slow (the record, the compression of the body): the other puller must not
      // start a match in the meantime.
      this.#stop(run, stopOf(attempt.stopRun), attempt.stopRun, accountId, syncRunId, matchId);
    }
    const state = afterFailedAttempt(
      due.attempts,
      attempt.failure,
      attempt.lastError,
      this.#now(),
      this.#random,
    );
    await this.#repository.saveState(accountId, matchId, state);
    // Counted once recorded: a failure whose state could not be saved is not in the report.
    if (state.status === 'invalid') {
      run.invalid += 1;
    } else if (state.status === 'unavailable') {
      run.unavailable += 1;
    } else {
      run.retried += 1;
    }
    // A routine retry is for whoever debugs; a final verdict, or a match given up, is worth a line
    // in the log file. Only the error code is logged: a field path and an issue code, never a value.
    this.#logger.log(
      state.status === 'retry' ? 'debug' : 'warn',
      LOG_SCOPE,
      'Detail attempt failed',
      {
        syncRunId,
        matchId,
        status: state.status,
        attempts: state.attempts,
        lastError: state.lastError,
      },
    );
    this.#notify();
    if (attempt.body !== undefined) {
      // After the verdict is saved: the verdict matters more than the copy of the response. If the
      // copy fails, the run stops, but the match is not asked again.
      await this.#quarantine(matchId, attempt.body);
      run.quarantined += 1;
    }
  }

  /**
   * Download the detail of a match and archive it, or tell why it cannot be.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match.
   * @returns The archive that was written and recorded, or the failure to record.
   * @throws The error that stops the run (a pause, the network, or a local failure).
   */
  async #attempt(accountId: AccountId, matchId: MatchId): Promise<Attempt> {
    let fetched: MetadataFetch;
    try {
      fetched = await this.#api.fetchMatchMetadata(matchId);
    } catch (error) {
      return judgeDownloadError(error);
    }
    switch (fetched.kind) {
      case 'paused':
        // The same error as the other requests of the API raise when it asks to pause.
        throw new AppError('rate_limited', 'deadlock-api asked to pause', {
          context: { pausedUntil: fetched.until },
        });
      case 'not_found':
        return retryable('not_found (404)');
      case 'invalid':
        // An answer with no body at all (a 204, say) is a hiccup of the API: it comes back. One
        // with a body that cannot be used is not what the API sends (a proxy, a security product).
        return fetched.body === ''
          ? retryable('empty_body')
          : unreadableAnswer(fetched.issue, fetched.body);
      case 'fetched':
        return this.#archiveDetail(accountId, matchId, fetched.json, fetched.body);
    }
  }

  /**
   * Validate a downloaded detail, prune it to the tracked player and archive it.
   *
   * The archive is written first and the match recorded as archived last: a failure in between
   * leaves a match that is still to do, never one that is recorded without its file.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match that was requested.
   * @param json - The parsed payload, not validated yet.
   * @param body - The text the payload was parsed from, kept for the quarantine.
   * @returns The archive that was written, or the invalid verdict.
   * @throws The error that stops the run: the compressor, the archive or the database failed.
   */
  async #archiveDetail(
    accountId: AccountId,
    matchId: MatchId,
    json: unknown,
    body: string,
  ): Promise<Attempt> {
    let encoded: Uint8Array;
    try {
      // The expected match id makes a detail of another match invalid, whatever else it holds.
      const metadata = parseMatchMetadata(json, matchId);
      const { playerSlot } = findTrackedPlayer(metadata, accountId);
      // Neither the parsed payload nor the pruned one is ever modified: they share their parts.
      const envelope = createArchiveEnvelope(
        pruneForPlayer(metadata, playerSlot),
        accountId,
        this.#now(),
      );
      // The door check: an archive is only kept if the facts of the match page can be read back
      // from it, so a `ready` match always has some. A detail that fails here is as final as any
      // other the app cannot use. Without it, the page would find the file unreadable, put the
      // match back to `pending`, and the queue would archive the same detail again, for ever.
      summarizeArchive(envelope);
      encoded = encodeArchiveEnvelope(envelope);
    } catch (error) {
      // Only a payload that is not what was asked for is a verdict on the match. Any other error
      // here is a bug, which must stop the run instead of marking the match.
      if (isAppError(error) && error.kind === 'invalid_payload') {
        return invalid(describeInvalidPayload(error), body);
      }
      throw error;
    }
    const compressed = await this.#compressor.compress(encoded);
    await this.#archive.write(accountId, matchId, compressed);
    await this.#repository.markReady(accountId, matchId, compressed.length);
    return { outcome: 'archived', archivedBytes: compressed.length };
  }

  /**
   * Keep a response that could not be used, compressed, in the quarantine folder.
   *
   * @param matchId - The match the response was fetched for.
   * @param body - The text of the response, as it was received.
   * @throws The error of the compressor or of the archive: it stops the run.
   */
  async #quarantine(matchId: MatchId, body: string): Promise<void> {
    const compressed = await this.#compressor.compress(new TextEncoder().encode(body));
    await this.#archive.quarantine(matchId, this.#now(), compressed);
  }

  /**
   * Show the archive of a match recorded as archived, or put the match back to `pending` when it
   * cannot be shown.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match, recorded as `ready`.
   * @param archivedBytes - The size of the archive file as the database recorded it.
   * @returns The facts of the archive, or `missing` once the match is back to `pending`.
   * @throws AppError of kind `storage` when the match cannot be put back to `pending`.
   */
  async #showArchive(
    accountId: AccountId,
    matchId: MatchId,
    archivedBytes: number | null,
  ): Promise<MatchDetailView> {
    if (archivedBytes === null) {
      // `markReady` writes the status and the size together: a ready row without a size is damaged.
      // It is refused before the file is opened, and handled like a file that cannot be read.
      this.#logUnreadable(
        accountId,
        matchId,
        'record',
        new AppError('storage', 'A ready match has no archive size', {
          context: { issue: 'archived_bytes_missing' },
        }),
      );
    } else {
      const facts = await this.#readFacts(accountId, matchId);
      if (facts !== null) {
        return { kind: 'ready', facts, archivedBytes };
      }
    }
    // Whatever was wrong, the file is not deleted. The next download writes the archive again
    // (replacing it), and a detail that cannot be read back is refused by the queue instead of
    // archived, so this never loops.
    await this.#repository.resetToPending(accountId, matchId);
    return { kind: 'missing' };
  }

  /**
   * Read the facts of the archive of a match: read the file, decompress it, decode the envelope,
   * and summarise the tracked player.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match.
   * @returns The facts, or `null` when the archive cannot be shown: the file is absent (logged at
   *   `info` level, since a folder emptied by hand is not a failure of the app), or any step failed
   *   (logged as a warning). The failure never leaves this method.
   */
  async #readFacts(accountId: AccountId, matchId: MatchId): Promise<ArchiveFacts | null> {
    // Where the reading stands, for the log of a failure.
    let step: ArchiveReadStep = 'read';
    try {
      const compressed = await this.#archive.read(accountId, matchId);
      if (compressed === null) {
        this.#logger.log('info', LOG_SCOPE, 'Detail archive is missing', { matchId });
        return null;
      }
      step = 'decompress';
      const decompressed = await this.#compressor.decompress(compressed);
      step = 'decode';
      const envelope = decodeArchiveEnvelope(decompressed);
      step = 'summarize';
      return summarizeArchive(envelope);
    } catch (error) {
      this.#logUnreadable(accountId, matchId, step, error);
      return null;
    }
  }

  /**
   * Log an archive that cannot be read, as a warning. The line holds the step and the codes of the
   * failure: the errors of the archive carry the problem as a field path and an issue code, never a
   * value of the file, and a path in an error of the disk has the account id replaced.
   *
   * @param accountId - The tracked account, kept out of the log.
   * @param matchId - The match.
   * @param step - The step that failed.
   * @param error - What was caught.
   */
  #logUnreadable(
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
   * Log the temporary files that could not be removed at the start of a run, as a warning. The line
   * holds the codes and the cause of the failure with the account id replaced, and its stack, like
   * the other failures of the disk.
   *
   * @param accountId - The tracked account, kept out of the log.
   * @param syncRunId - Id of the run in the logs.
   * @param error - What was caught.
   */
  #logLeftoversKept(accountId: AccountId, syncRunId: string, error: unknown): void {
    this.#logger.log('warn', LOG_SCOPE, 'Leftover temporary files could not be removed', {
      ...describeErrorForLog(error, accountId, !isAppError(error)),
      syncRunId,
    });
  }

  /**
   * End the run: no puller starts a new match from now on. The first reason is the one reported; a
   * later one (the other puller may fail too) is logged but does not replace it.
   *
   * A pause is logged at the `info` level, since it is routine, and a network failure at `warn`:
   * neither has a stack, which would say nothing more than the kind. A local failure is logged at
   * `warn`, with its cause and its stack.
   *
   * @param run - What the run counts.
   * @param stop - Why the run stops.
   * @param error - What was caught.
   * @param accountId - The tracked account, kept out of the log.
   * @param syncRunId - Id of the run in the logs.
   * @param matchId - The match being processed when it failed, if any.
   */
  #stop(
    run: RunState,
    stop: DetailRunStop,
    error: unknown,
    accountId: AccountId,
    syncRunId: string,
    matchId?: MatchId,
  ): void {
    run.stoppedBy ??= stop;
    this.#logger.log(stop === 'paused' ? 'info' : 'warn', LOG_SCOPE, 'Detail queue stopped', {
      ...describeErrorForLog(error, accountId, stop === 'storage'),
      syncRunId,
      stoppedBy: stop,
      ...(matchId === undefined ? {} : { matchId }),
    });
  }

  /**
   * Tell every listener that a match was recorded. A failing listener is logged and skipped: it
   * must neither break the run nor keep the other listeners uninformed.
   */
  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.log(
          'warn',
          LOG_SCOPE,
          'A listener of the detail queue failed',
          errorLogContext(toAppError(error)),
        );
      }
    }
  }
}

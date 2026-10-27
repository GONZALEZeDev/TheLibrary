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
 * Once no match is due, the same two pullers refresh the archives of the first format, which kept
 * only the tracked player's path: the `ready` matches of the last 90 days whose format was never
 * recorded (`MatchDetailRepository.nextStale`), most recent first, each tried once per run. A
 * refresh goes through the very steps of a download and writes the new archive over the old one;
 * then the projection of the match is forgotten, so that the analysis makes it again from the new
 * file, and only then is the match recorded with the current format, so that a failure in between
 * leaves it to refresh again. A refresh never loses a match: the match stays `ready` throughout,
 * and the old file stays until the new one replaces it. A failed refresh counts no attempt and
 * changes nothing but, when the failure is final (deadlock-api no longer has the match, or its
 * answer cannot be used), the recorded format, so that the match keeps its old archive and is
 * never tried again. Any other failure about the match is tried again at the next run, and one that
 * says nothing about it (a pause, the network, a local failure) stops the run, as for a download.
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
 * match stands, and only an archived (`ready`) match has a file to read. The file is read by the
 * archive reader (`./archive-reader.service`), which tells whether the archive could be used and
 * logs why not; the service reads the facts of the match page from the envelope it gives back, and
 * decides what the page shows. A file that is absent, or whose content is damaged (it does not
 * decompress, decode, or yield the facts of the match), is not an error for the page: the match
 * goes back to `pending`, so that the next run downloads it again, and the view says `missing`; or,
 * when the match is past the 90 days and so will not be downloaded, it is marked `evicted` (it
 * keeps its metrics) and the view says `evicted_lost`. That cannot loop, since the queue archives
 * nothing whose facts it could not read back: the same detail would be refused as `invalid`. The
 * file of a damaged archive is left alone, for the next archive written to replace it. A failure
 * that says nothing about the archive (the disk cannot be read, the compressor is broken) is an
 * error for the page, and the match stays as it is: the archive may be fine, and a match past the
 * 90 days that was marked `evicted` could never come back.
 *
 * @packageDocumentation
 */
import { METADATA_MAX_CONCURRENCY } from '../core/deadlock-api/budgets';
import { parseMatchMetadata } from '../core/deadlock-api/match-metadata.schema';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { AppError, errorLogContext, isAppError, toAppError } from '../core/errors/app-error';
import {
  ARCHIVE_FORMAT,
  createArchiveEnvelope,
  encodeArchiveEnvelope,
} from '../core/match-detail/archive-envelope';
import { summarizeArchive, type ArchiveFacts } from '../core/match-detail/archive-facts';
import { afterFailedAttempt, isDetailEligible } from '../core/match-detail/detail-status';
import { findTrackedPlayer, pruneForPlayer } from '../core/match-detail/pruning';
import type { AccountSource } from '../ports/account-source.port';
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Compressor } from '../ports/compressor.port';
import type { Logger } from '../ports/logger.port';
import type { ArchiveReaderService } from './archive-reader.service';
import type { DeadlockApiService, MetadataFetch } from './deadlock-api.service';
import type {
  DetailSummary,
  DueMatch,
  MatchDetailRepository,
  StoredDetail,
} from './match-detail.repository';
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
  /** Reads the archives back, for the match page. */
  readonly reader: ArchiveReaderService;
  /**
   * Forgets the projection of a refreshed match, which must be projected again: the projection
   * service of the analysis, see {@link ProjectionForgetter}.
   */
  readonly projections: ProjectionForgetter;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
  /** Random source of the retry delays, in [0, 1); `Math.random` by default. */
  readonly random?: () => number;
}

/**
 * The one thing the queue asks of the analysis: forget the projection of a match whose archive it
 * replaced, so that the next catch-up projects it again from the new file.
 *
 * The app wires `ProjectionService`, not the `MetricsRepository` it stores through: the forgetting
 * waits its turn behind a projection in flight, which may have read the old file already and would
 * otherwise save its projection back over the forgetting.
 */
export interface ProjectionForgetter {
  /**
   * Forget the projection of a match, so that it is listed as one to project.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @throws AppError of kind `storage` when the database fails.
   */
  forgetProjection(accountId: AccountId, matchId: MatchId): Promise<void>;
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
  /** Matches archived again in the current format, over their format-1 archive. */
  readonly refreshed: number;
  /** Why the run ended early, or `null` when it went through every due match. */
  readonly stoppedBy: DetailRunStop | null;
}

/**
 * What the interface shows of the detail queue: the counts by status, and why the last run of the
 * queue ended early.
 */
export interface DetailSummaryView extends DetailSummary {
  /**
   * Why the last run of the queue that ended since the app started stopped before it went through
   * every due match, or `null` when that run went through them, or when none has ended yet. Kept in
   * memory only: a restart forgets it.
   */
  readonly lastStop: DetailRunStop | null;
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
   * The match was recorded as archived but its file is absent or damaged, and the match is still
   * inside the 90 days. It was put back to `pending`: the next run of the queue downloads it again.
   */
  | { readonly kind: 'missing' }
  /**
   * The archive file of the match was removed to keep the archive folder under its size limit, and
   * the match is still inside the 90 days. It was put back to `pending`: the page asks for the
   * download that fetches it again.
   */
  | { readonly kind: 'evicted' }
  /**
   * The match is `evicted` and past the 90 days: its archive file was removed to keep the archive
   * folder under its size limit, or it was found absent or damaged once the match was past them
   * (it was then marked `evicted`). Its stored metrics are kept, and the queue only downloads the
   * matches of the last 90 days: the archive is gone for good.
   */
  | { readonly kind: 'evicted_lost' }
  /** The detail is archived: what the page shows of it, and the size of the archive file. */
  | { readonly kind: 'ready'; readonly facts: ArchiveFacts; readonly archivedBytes: number };

/** The scope of the log lines of the queue. */
const LOG_SCOPE = 'detail';

/**
 * How many matches are processed at the same time: as many as deadlock-api allows in flight. While
 * one match is compressed and written, the other one is already downloading.
 */
const PULLER_COUNT = METADATA_MAX_CONCURRENCY;

/**
 * The code of the failure of a download that deadlock-api answered with a 404: it does not have the
 * match. A download tries it again later; for a refresh, it is final: the API served the match
 * once, so a 404 now says it no longer does.
 */
const NOT_FOUND_ERROR = 'not_found (404)';

/** What a run counts as it goes. Read by the pullers, which share one object, and by the report. */
interface RunState {
  archived: number;
  retried: number;
  unavailable: number;
  invalid: number;
  refreshed: number;
  /** Responses kept in the quarantine folder during this run (only the log line counts them). */
  quarantined: number;
  /** The first reason the run was stopped for; once set, no puller starts a new match. */
  stoppedBy: DetailRunStop | null;
}

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
  readonly #reader: ArchiveReaderService;
  readonly #projections: ProjectionForgetter;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #listeners = new Set<() => void>();

  /**
   * Why the last run that ended stopped, by account (`null`: it went through). An account has no
   * entry until one of its runs has ended.
   */
  readonly #lastStops = new Map<AccountId, DetailRunStop | null>();

  /**
   * @param dependencies - See {@link MatchDetailServiceDependencies}.
   */
  constructor(dependencies: MatchDetailServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#api = dependencies.api;
    this.#repository = dependencies.repository;
    this.#archive = dependencies.archive;
    this.#compressor = dependencies.compressor;
    this.#reader = dependencies.reader;
    this.#projections = dependencies.projections;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
  }

  /**
   * Process every due match of the account: download its detail, archive it, and record the
   * outcome. Matches are taken most recent first, two at a time. Once none is due, the format-1
   * archives of the last 90 days are refreshed the same way (see the module documentation).
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
      refreshed: 0,
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
    // The download pool: each puller claims the next due match, and downloads and archives it.
    const claimDue = (): Promise<DueMatch | null> =>
      this.#claimWith(
        (excluding) => this.#repository.nextDue(accountId, this.#now(), excluding),
        taken,
      );
    const download = (due: DueMatch): Promise<void> =>
      this.#process(accountId, due, run, syncRunId);
    await Promise.all(
      Array.from({ length: PULLER_COUNT }, () =>
        this.#pullWith(claimDue, download, taken, run, accountId, syncRunId),
      ),
    );
    // The refresh of the format-1 archives comes once both pullers are done with the due matches,
    // so that it never delays a match that has no archive at all, and only when nothing stopped
    // the run: what stopped it (a pause, the network, the disk) would stop the refresh as well.
    if (run.stoppedBy === null) {
      // A set of its own: a match that was downloaded in this run is now of the current format, so
      // it is not offered again; this one makes each match to refresh tried once per run.
      const refreshTaken = new Set<MatchId>();
      // The refresh pool: each puller claims the next format-1 archive, and archives it again.
      const claimStale = (): Promise<DueMatch | null> =>
        this.#claimWith(
          (excluding) => this.#repository.nextStale(accountId, this.#now(), excluding),
          refreshTaken,
        );
      const refresh = (stale: DueMatch): Promise<void> =>
        this.#refresh(accountId, stale.matchId, run, syncRunId);
      await Promise.all(
        Array.from({ length: PULLER_COUNT }, () =>
          this.#pullWith(claimStale, refresh, refreshTaken, run, accountId, syncRunId),
        ),
      );
    }
    const report: DetailRunReport = {
      archived: run.archived,
      retried: run.retried,
      unavailable: run.unavailable,
      invalid: run.invalid,
      refreshed: run.refreshed,
      stoppedBy: run.stoppedBy,
    };
    // Kept for the banner: a run that stops on its first match records nothing, so the counts do
    // not change, and without this nothing would tell the user that the queue is stuck.
    this.#lastStops.set(accountId, run.stoppedBy);
    this.#logger.log('info', LOG_SCOPE, 'Detail queue ended', {
      syncRunId,
      archived: run.archived,
      retried: run.retried,
      unavailable: run.unavailable,
      invalid: run.invalid,
      refreshed: run.refreshed,
      quarantined: run.quarantined,
      stoppedBy: run.stoppedBy,
    });
    return report;
  }

  /**
   * Forget what the queue keeps in memory about an account: why its last run stopped. It is called
   * when the data of the account is deleted, so that the summary of the account, should it be
   * linked again, does not tell the stop of a run that belongs to the deleted data.
   *
   * @param accountId - The account whose data is deleted.
   */
  forgetAccount(accountId: AccountId): void {
    this.#lastStops.delete(accountId);
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
   * Count the details of the linked account by status, and tell why the last run of the queue
   * stopped, for the banner of the interface. Only the matches the queue archives are counted (see
   * `MatchDetailRepository.summary`).
   *
   * @returns The counts and the reason of the last stop, or `null` when no account is linked.
   * @throws AppError of kind `storage` when the database fails.
   */
  async getSummary(): Promise<DetailSummaryView | null> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return null;
    }
    const counts = await this.#repository.summary(accountId, this.#now());
    return { ...counts, lastStop: this.#lastStops.get(accountId) ?? null };
  }

  /**
   * Tell what the match page shows about the detail of a match of the linked account: the facts of
   * its archive, or why there is none.
   *
   * The checks are made in this order, and the order matters:
   * 1. a match the app does not know is `not_eligible`;
   * 2. an archived (`ready`) match is read, whatever its age: the file is there, so the page shows
   *    it even once the match has aged past the 90 days of the window;
   * 3. an `evicted` match (no archive file left, its metrics kept: the file was removed to keep the
   *    archive folder under its size limit, or found missing past the 90 days) is told before the
   *    eligibility check, so that an old one is not taken for a match the app never archives:
   *    inside the 90 days it is put back to `pending` and the view is `evicted` (the page asks for
   *    the download that fetches it again), past them the view is `evicted_lost` and the row is
   *    left as it is;
   * 4. any other match that the queue would not archive (`isDetailEligible`) is `not_eligible`;
   * 5. a `pending` or `retry` match is `waiting`, and an `unavailable` or `invalid` one says so,
   *    with the code of its last failure.
   *
   * An archive that is absent, or whose content cannot be used at any step (it does not
   * decompress, decode, or yield the facts), is not an error for the page: while the match is
   * inside the 90 days it is put back to `pending` and the view is `missing` (the next run
   * downloads it again); once it is past them it is marked `evicted`, keeping its metrics, and the
   * view is `evicted_lost` (it never will be). A row someone else changed meanwhile is left as it
   * is, and the view is the one of its current state. The file of a damaged archive is not deleted;
   * the next archive written replaces it.
   *
   * A failure that says nothing about the content is an error for the page, and changes nothing:
   * the file cannot be read (a lock, a permission), or the compressor is broken (its worker failed
   * to load or crashed). The archive may be perfectly fine, and recording it as missing would at
   * best download it again for nothing and at worst, for a match past the 90 days, detach an
   * archive from the database for ever. The next view tries again.
   *
   * @param matchId - The match.
   * @returns What to show.
   * @throws AppError of kind `storage` when the database fails, when the archive file cannot be
   *   read, or when the compressor is broken. The failure to record a missing archive is one too:
   *   the view is a read for the interface, which shows the error, and answering `missing` while
   *   the database still says `ready` would be a lie, since the queue would never download the
   *   match. The next read tries again.
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
      return this.#showArchive(accountId, matchId, stored);
    }
    // The rule is the core's, with the fields the repository read: a copy of it here would drift.
    const eligible = isDetailEligible(stored.match, this.#now());
    // An evicted match is told before the eligibility check: it did have an archive, so a match past
    // the 90 days is "gone" (`evicted_lost`) rather than one the app never archives.
    if (stored.status === 'evicted') {
      if (!eligible) {
        return { kind: 'evicted_lost' };
      }
      // The file is gone, and the queue downloads a `pending` match: put it back, as for an archive
      // that cannot be read. The download itself is asked for by the page (see `resetForRetry`).
      await this.#repository.resetToPending(accountId, matchId);
      return { kind: 'evicted' };
    }
    if (!eligible) {
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
   * Put a match whose detail is missing back in the queue, for the "Retry" action and for the
   * download of an evicted match: only an `unavailable`, an `invalid` or an `evicted` match goes
   * back to `pending`, so that the next run downloads it again. Any other match is left as it is (a
   * match that waits for its retry date, or is archived, has nothing to retry), and so is one the
   * app does not know. Without a linked account, nothing happens.
   *
   * The state is read, then written, which is not atomic. That is harmless: the queue never takes
   * an `unavailable`, an `invalid` or an `evicted` match, so nothing changes it in between except
   * this same call (and `getMatchDetail`, which puts an `evicted` match back the same way).
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
    if (
      stored?.status === 'unavailable' ||
      stored?.status === 'invalid' ||
      stored?.status === 'evicted'
    ) {
      await this.#repository.resetToPending(accountId, matchId);
    }
  }

  /**
   * One puller: take the matches one after the other and work on each, until none is left or the
   * run is stopped. It never rejects: whatever goes wrong stops the run.
   *
   * Both pools of a run share this loop: claim a match, stop the run when the claim fails, give the
   * match back when the run was stopped meanwhile, work on it, and stop the run when the work fails.
   * They differ in what they pass: the download pool claims from `MatchDetailRepository.nextDue`
   * and works with {@link MatchDetailService.#process}; the refresh pool claims from
   * `MatchDetailRepository.nextStale` and works with {@link MatchDetailService.#refresh}.
   *
   * @param claim - Claims the next match of the pool (see {@link MatchDetailService.#claimWith}),
   *   or answers `null` when none is left.
   * @param work - Downloads or refreshes the claimed match; it rejects with the error that stops
   *   the run.
   * @param taken - The matches the pool took in this run, shared with the other puller; `claim`
   *   adds to it.
   * @param run - What the run counts, shared with the other puller.
   * @param accountId - The tracked account.
   * @param syncRunId - Id of the run in the logs.
   */
  async #pullWith(
    claim: () => Promise<DueMatch | null>,
    work: (match: DueMatch) => Promise<void>,
    taken: Set<MatchId>,
    run: RunState,
    accountId: AccountId,
    syncRunId: string,
  ): Promise<void> {
    for (;;) {
      let match: DueMatch | null;
      try {
        match = await claim();
      } catch (error) {
        this.#stop(run, stopOf(error), error, accountId, syncRunId);
        return;
      }
      if (match === null) {
        return;
      }
      // The stop is read here, once the match is claimed and right before it starts: the other
      // puller may have stopped the run while the database was answering. The match is given back,
      // untouched, as if it had not been offered.
      if (run.stoppedBy !== null) {
        taken.delete(match.matchId);
        return;
      }
      try {
        await work(match);
      } catch (error) {
        this.#stop(run, stopOf(error), error, accountId, syncRunId, match.matchId);
        return;
      }
    }
  }

  /**
   * Take the next match of a pool for the calling puller, so that the other one cannot take it.
   *
   * The other puller asks for its own match at the same time, and both questions are answered from
   * the same state of the database: they can both name the same match. The match is therefore
   * claimed once the answer is back, in the same synchronous block as the check, without any
   * `await` in between: the first puller to get the answer claims the match, and the other asks
   * again, now that it is excluded. Both pools claim this way, and differ only in the query they
   * pass: `MatchDetailRepository.nextDue` for the downloads, `MatchDetailRepository.nextStale` for
   * the refresh.
   *
   * @param next - Asks the database for the next match of the pool, skipping the given ones; the
   *   current time is read at each call.
   * @param taken - The matches the pool took in this run; the claimed match is added to it.
   * @returns The claimed match, or `null` when none is left.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #claimWith(
    next: (excluding: ReadonlySet<MatchId>) => Promise<DueMatch | null>,
    taken: Set<MatchId>,
  ): Promise<DueMatch | null> {
    // Each round either claims a match, or sees that the other puller claimed the one it was
    // offered: the matches are finite, and each round that does not claim excludes one more.
    for (;;) {
      const match = await next(taken);
      if (match === null) {
        return null;
      }
      if (!taken.has(match.matchId)) {
        taken.add(match.matchId);
        return match;
      }
    }
  }

  /**
   * Refresh one match: download its detail again, archive it in the current format over its
   * format-1 archive, and forget its projection; or, when that fails, leave the match as it was.
   *
   * The download and the archive are the very steps of a download ({@link MatchDetailService.#attempt}),
   * with one more between the write and the record: the new file replaces the old one whole, or not
   * at all, then the projection of the match is forgotten, and only then is the match recorded with
   * the current format. The match is `ready` before, during and after, with a file the page and the
   * analysis can read. Until the record, the database still holds no format: whatever fails after the
   * write (the forgetting, or the record itself), the next run refreshes the match again, and its
   * projection is forgotten or made again from the new file in the meantime, never left as the one
   * of the old file.
   *
   * A failure about the match is judged as a download judges it, but costs nothing: no attempt is
   * counted, no state is saved, and no body is quarantined (the match already has an archive). It
   * is logged on one line, and only a final one is recorded: deadlock-api no longer has the match
   * (a 404), or its answer cannot be used (`invalid`). Then the match keeps its format-1 archive for
   * good. Any other is tried again at the next run, and an answer that is not JSON also stops this
   * one, as it does for a download.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match, `ready` with a format-1 archive.
   * @param run - What the run counts.
   * @param syncRunId - Id of the run in the logs.
   * @throws The error that stops the run (a pause, the network, or a local failure): the match is
   *   still recorded with no format, with its old file, or with the new one when the failure came
   *   after the write; so the next run refreshes it again.
   */
  async #refresh(
    accountId: AccountId,
    matchId: MatchId,
    run: RunState,
    syncRunId: string,
  ): Promise<void> {
    // Forgotten after the write, never before: a projection forgotten while the old file is still
    // there could be made again from it, and then never again. And before the record: if the
    // forgetting fails, the match is still to refresh.
    const attempt = await this.#attempt(accountId, matchId, () =>
      this.#projections.forgetProjection(accountId, matchId),
    );
    if (attempt.outcome === 'archived') {
      run.refreshed += 1;
      this.#logger.log('debug', LOG_SCOPE, 'Match archive refreshed', {
        syncRunId,
        matchId,
        archivedBytes: attempt.archivedBytes,
      });
      this.#notify();
      return;
    }
    if (attempt.stopRun !== undefined) {
      // Before anything slow, as for a download: the other puller must not start a match meanwhile.
      this.#stop(run, stopOf(attempt.stopRun), attempt.stopRun, accountId, syncRunId, matchId);
    }
    // The code of the failure, as a download records it: an error kind and a status or a field
    // path, never a value of the payload.
    this.#logger.log('info', LOG_SCOPE, 'Match archive refresh failed', {
      syncRunId,
      matchId,
      kind: attempt.lastError,
    });
    if (attempt.failure === 'invalid' || attempt.lastError === NOT_FOUND_ERROR) {
      await this.#repository.markRefreshFinal(accountId, matchId);
      this.#notify();
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
      await this.#quarantine(accountId, matchId, attempt.body);
      run.quarantined += 1;
    }
  }

  /**
   * Download the detail of a match and archive it, or tell why it cannot be.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match.
   * @param beforeRecord - Work to do once the archive is written and before it is recorded; none
   *   for a download (see {@link MatchDetailService.#archiveDetail}).
   * @returns The archive that was written and recorded, or the failure to record.
   * @throws The error that stops the run (a pause, the network, or a local failure).
   */
  async #attempt(
    accountId: AccountId,
    matchId: MatchId,
    beforeRecord?: () => Promise<void>,
  ): Promise<Attempt> {
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
        return retryable(NOT_FOUND_ERROR);
      case 'invalid':
        // An answer with no body at all (a 204, say) is a hiccup of the API: it comes back. One
        // with a body that cannot be used is not what the API sends (a proxy, a security product).
        return fetched.body === ''
          ? retryable('empty_body')
          : unreadableAnswer(fetched.issue, fetched.body);
      case 'fetched':
        return this.#archiveDetail(accountId, matchId, fetched.json, fetched.body, beforeRecord);
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
   * @param beforeRecord - Work to do once the archive is written and before it is recorded: the
   *   refresh forgets the projection of the match there. A failure of it stops the run with the
   *   match not recorded, like a failure of the write.
   * @returns The archive that was written, or the invalid verdict.
   * @throws The error that stops the run: the compressor, the archive, `beforeRecord` or the
   *   database failed.
   */
  async #archiveDetail(
    accountId: AccountId,
    matchId: MatchId,
    json: unknown,
    body: string,
    beforeRecord?: () => Promise<void>,
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
    await beforeRecord?.();
    await this.#repository.markReady(accountId, matchId, compressed.length, ARCHIVE_FORMAT);
    return { outcome: 'archived', archivedBytes: compressed.length };
  }

  /**
   * Keep a response that could not be used, compressed, in the quarantine folder of the account.
   *
   * @param accountId - The tracked account the response was fetched for.
   * @param matchId - The match the response was fetched for.
   * @param body - The text of the response, as it was received.
   * @throws The error of the compressor or of the archive: it stops the run.
   */
  async #quarantine(accountId: AccountId, matchId: MatchId, body: string): Promise<void> {
    const compressed = await this.#compressor.compress(new TextEncoder().encode(body));
    await this.#archive.quarantine(accountId, matchId, this.#now(), compressed);
  }

  /**
   * Show the archive of a match recorded as archived, or record that it is absent or damaged, by
   * the one rule of the app for a missing archive (`MatchDetailRepository.markArchiveMissing`).
   *
   * @param accountId - The tracked account.
   * @param matchId - The match, recorded as `ready`.
   * @param stored - What the database holds about the match: the size of the archive file as it
   *   recorded it.
   * @returns The facts of the archive; or, once the missing archive is recorded, `missing` when the
   *   match is back to `pending` (the next run downloads it again), `evicted_lost` when it is past
   *   the 90 days and now `evicted`, and the view of the row as it is now when someone else changed
   *   it meanwhile.
   * @throws AppError of kind `storage` when the file cannot be read, when the compressor is broken,
   *   or when the missing archive cannot be recorded. Any error of the reading of the facts that is
   *   not a problem of the archive (a bug) is thrown as it is.
   */
  async #showArchive(
    accountId: AccountId,
    matchId: MatchId,
    stored: Pick<StoredDetail, 'archivedBytes'>,
  ): Promise<MatchDetailView> {
    const { archivedBytes } = stored;
    if (archivedBytes === null) {
      // `markReady` writes the status and the size together: a ready row without a size is damaged.
      // It is refused before the file is opened, and handled like a file that cannot be read.
      this.#reader.reportUnreadable(
        accountId,
        matchId,
        'record',
        new AppError('storage', 'A ready match has no archive size', {
          context: { issue: 'archived_bytes_missing' },
        }),
      );
    } else {
      // The reader logs an archive that is absent or damaged. A file it cannot read, or a broken
      // compressor, rejects here, and the match is left as it is.
      const read = await this.#reader.readArchive(accountId, matchId);
      if (read.kind === 'read') {
        try {
          return { kind: 'ready', facts: summarizeArchive(read.envelope), archivedBytes };
        } catch (error) {
          // Only a payload that lacks what the facts expect says something about the archive. Any
          // other error is a bug, which is an error for the page: the match is left as it is.
          if (!isAppError(error) || error.kind !== 'invalid_payload') {
            throw error;
          }
          this.#reader.reportUnreadable(accountId, matchId, 'summarize', error);
        }
      }
    }
    // Whatever was wrong, the file is not deleted. The next download writes the archive again
    // (replacing it), and a detail that cannot be read back is refused by the queue instead of
    // archived, so this never loops. The repository cuts the window of the last 90 days where the
    // queue cuts it: `missing` promises a download that `nextDue` makes.
    const outcome = await this.#repository.markArchiveMissing(accountId, matchId, this.#now());
    switch (outcome) {
      case 'pending':
        return { kind: 'missing' };
      case 'evicted':
        // Past the window the queue never downloads it again: the match keeps its metrics, and its
        // page says the detail is gone, as for an archive removed to free space.
        return { kind: 'evicted_lost' };
      case 'unchanged':
        // Someone else changed the row since it was read (the storage evicted it, the analysis put
        // it back to `pending`): the page answers from the row as it is now. Another turn here
        // would take a new archive, written and found unusable meanwhile, so this ends.
        return this.getMatchDetail(matchId);
    }
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

/**
 * The projection: turns archived matches into the metric values the analysis stores, so that the
 * pages never read an archive to compare a match.
 *
 * Analysing a match starts from its archive, a large compressed file. The projection reads each
 * archive once, runs the metrics of the registry on it (`../core/analysis/registry`) and keeps the
 * values in the database (`./metrics.repository`). It works on the matches whose detail is archived
 * and that have no projection of the current version, which is every new match, and every match
 * after the version changes (the archives are on the disk already, so a new version needs no
 * network). There are two ways to ask for it, which share the rules below:
 * - {@link ProjectionService.catchUp} is for every archived match that lacks a projection, most
 *   recent first. The synchronisation runs it at the end of each of its runs, so that the matches it
 *   archived, and every match after a new version, are analysed before their page is opened;
 * - {@link ProjectionService.projectMatch} is for one match, when its page is opened and finds it
 *   not analysed yet (before the end of the run that archived it, or after a new version and before
 *   the next run): it projects the match and the earlier archived matches its habits are made of,
 *   and nothing else.
 *
 * The projections run one at a time, whoever asks: a call made while a projection runs waits for it
 * to end, then runs. Side by side, two projections would list the same matches and project them
 * twice, and two saves of one match at once can leave a projection row standing over metrics that
 * were deleted. A call that waited finds done what the earlier one projected, and projects what is
 * left. However a projection ends, the next one runs. The forgetting of a projection
 * ({@link ProjectionService.forgetProjection}, for an archive the detail queue replaced) takes its
 * turn the same way, so that it never runs in the middle of a projection of the old file.
 *
 * What a match can end in, and what it costs:
 * - the archive is projected: its values are stored, with the badge of the player, whether somebody
 *   left, and the version (`projected`). A metric the archive does not hold what it needs for is an
 *   unknown value (`null`), which is no failure; a metric that throws is the same, and it is told
 *   in the log, once for each metric in a run. The values are the metrics and, next to them, the
 *   damage sources of the match (`../core/analysis/damage-sources`) and its review values
 *   (`../core/analysis/review/review-values`: the deaths of each phase, the first purchase of each
 *   shop item, the places on the scoreboard). A match with no damage matrix has no damage source,
 *   which is no news; a match whose damage matrix is not what is expected has none either, and it
 *   is told in the log, once in a run. The review values come from three parts of the archive, the
 *   death details, the items and the scoreboard, each read on its own: death details that miss a
 *   death give no value and no news, and a part that is not what is expected gives none either,
 *   and it is told in the log, once in a run, whichever part it was. None of this costs the match
 *   its metrics, nor makes it fail: it is projected, and not projected again before the version
 *   changes;
 * - the analysis cannot read the match, since the archive does not hold what it expects of a match
 *   (`failed`): the match is stored as failed, with no values. That is a verdict on the match, which
 *   is not tried again before the version changes: downloading it again would give the same detail;
 * - the archive is absent or damaged (`reset`): in the window of the last 90 days, the match goes
 *   back to `pending`, so that the next run of the detail queue downloads it again, and it has no
 *   projection until then. That cannot loop, since the queue only archives a detail it could read
 *   back. Past the window, where the queue never downloads a match, an absent archive is marked
 *   `evicted`, and the match keeps the metrics it has. A match that is not `ready` any more by then
 *   (evicted by the storage since the run listed it) is left as it is, and not counted;
 * - the archive is damaged and past the window (`kept`): nothing is recorded, so the match stays
 *   `ready` and its file stays on disk. Marked `evicted`, its file would be deleted by the
 *   reconciliation of the archives at the next start, and nothing could download it again; while
 *   the cause may be the app itself (a bug of the decoding, an archive written by a later version),
 *   which a later version reads again. The match is not tried again before the app restarts, unless
 *   its file changes (a new download);
 * - {@link MAX_CONSECUTIVE_DAMAGED} damaged archives in a row mean that the reading itself is
 *   likely broken, not the archives: from then on, until the app restarts, no damaged archive is put
 *   back to `pending` either (it is `kept`), so that a bug of the decoding cannot send every match
 *   of the window back to the queue. It is told in the log, once, as an error;
 * - the failure says nothing about the match, so nothing is recorded and the match is left as it was
 *   (`skipped`): the file cannot be read, the compressor or the database fails, or the code has a
 *   bug on this archive. It is told in the log, once, and the run goes on with the next match, so
 *   that one archive that always fails does not keep the others from being projected. The skipped
 *   match still lacks a projection, so the next run that lists it tries it again: the next
 *   synchronisation, or the next opening of a page whose window holds it (the analysis finds that
 *   window incomplete, and asks again);
 * - three failures in a row mean that the cause is not one archive but the disk, the compressor or
 *   the database, which would fail the same way on every match: the run stops (`stoppedBy:
 *   'storage'`). Any match that gets through (projected, failed, reset or kept) ends the streak. The
 *   matches already projected stay so, and the next run that lists the others goes on from there
 *   (the next synchronisation, or the next opening of a page). The list of the matches to project
 *   failing stops the run at once, since there is nothing to go on with.
 *
 * A run never throws: what went wrong is in its report and in the log. Between two matches it gives
 * the event loop a turn, so that the compression of the archives and the metrics, which run on the
 * thread of the interface, do not freeze it for the whole run.
 *
 * The log never holds an account id, a value of an archive or the message of the error of a metric,
 * which could quote one: a line holds the match, the key of the metric, and the kind of the failure
 * or the field path and the issue code of the payload.
 *
 * @packageDocumentation
 */
import { avoidableDeathCount, judgeDeaths } from '../core/analysis/avoidable-deaths';
import { readDamageMatrix, type DamageMatrixRead } from '../core/analysis/damage-matrix';
import { projectDamageSources } from '../core/analysis/damage-sources';
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import { buildMatchContext, type MatchContext } from '../core/analysis/match-context';
import type { MetricKey } from '../core/analysis/metric';
import { projectMetrics, PROJECTION_VERSION } from '../core/analysis/registry';
import { projectReviewValues } from '../core/analysis/review/review-values';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { isAppError, issueOf, toAppError, type AppError } from '../core/errors/app-error';
import type { ArchiveEnvelope } from '../core/match-detail/archive-envelope';
import { readScoreboard } from '../core/match-detail/scoreboard';
import { readTrackedDeathTimes } from '../core/match-detail/tracked-deaths';
import { readTrackedItems } from '../core/match-detail/tracked-items';
import type { LogContext, Logger } from '../ports/logger.port';
import type { ArchiveReaderService } from './archive-reader.service';
import type { MatchDetailRepository } from './match-detail.repository';
import { describeErrorForLog } from './match-detail-verdicts';
import type { MetricsRepository, MetricValues } from './metrics.repository';

/** What {@link ProjectionService} needs. */
export interface ProjectionServiceDependencies {
  /** Reads the archives of the matches. */
  readonly reader: ArchiveReaderService;
  /** Where the projections are kept, and which matches still need one. */
  readonly metrics: MetricsRepository;
  /**
   * Where the detail state of the matches is kept: a match with no usable archive goes back to
   * `pending`, or past the window of the last 90 days to `evicted` (an absent file) or stays as it
   * is (a damaged one).
   */
  readonly details: MatchDetailRepository;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
  /**
   * Gives the event loop a turn; a message posted on a channel and received in a later task by
   * default (a timer would be throttled while the window is hidden). It is called between two
   * matches, and is replaced by the tests.
   */
  readonly yieldToEventLoop?: () => Promise<void>;
}

/** How a run of the projection went. */
export interface ProjectionReport {
  /** Matches whose metrics were stored. */
  readonly projected: number;
  /** Matches the analysis cannot read, stored as failed. */
  readonly failed: number;
  /**
   * Matches whose archive is absent or damaged, put back to `pending` (in the window of the last 90
   * days), or whose archive is absent and that were marked `evicted` (past it). A match that was not
   * `ready` any more is not counted.
   */
  readonly reset: number;
  /**
   * Matches whose archive is damaged and that were left `ready`, file kept: past the window of the
   * last 90 days, or once too many damaged archives in a row stopped the resets. Nothing was
   * recorded for them.
   */
  readonly kept: number;
  /** Matches left as they were because a failure that is not about them hit them. */
  readonly skipped: number;
  /** Why the run ended early, or `null` when it went through every match. */
  readonly stoppedBy: 'storage' | null;
}

/** The scope of the log lines of the projection. */
const LOG_SCOPE = 'projection';

/**
 * How many matches in a row may fail before the run stops. One archive that always fails is
 * skipped; this many in a row is not one archive any more.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How many damaged archives in a row stop the resets of damaged archives until the app restarts.
 * One damaged archive is a damaged file; this many in a row is more likely the reading itself.
 */
const MAX_CONSECUTIVE_DAMAGED = 3;

/** What a run reports when the list of its matches cannot be read: it stops before the first match. */
const STOPPED_AT_ONCE: ProjectionReport = {
  projected: 0,
  failed: 0,
  reset: 0,
  kept: 0,
  skipped: 0,
  stoppedBy: 'storage',
};

/** What {@link ProjectionService} did with a match whose archive it could read or not. */
type MatchOutcome = 'done' | 'damaged';

/**
 * The key of a match among the archives kept damaged: the account and the match, since the same
 * match can be archived for two accounts linked one after the other.
 *
 * @param accountId - The tracked account.
 * @param matchId - The match.
 * @returns The key.
 */
function keptArchiveKey(accountId: AccountId, matchId: MatchId): string {
  return `${String(accountId)}/${String(matchId)}`;
}

/** What a run counts as it goes, and what it already told about. */
interface RunState {
  projected: number;
  failed: number;
  reset: number;
  kept: number;
  skipped: number;
  /** The keys of the metrics that were told as not computed in this run. */
  readonly toldKeys: Set<MetricKey>;
  /** Whether this run told that a damage matrix could not be read. */
  hasToldDamageNotRead: boolean;
  /** Whether this run told that a part of an archive the review values need could not be read. */
  hasToldReviewNotRead: boolean;
}

/**
 * A line the run tells once, about content of an archive that is not what is expected: the flag of
 * {@link RunState} that remembers it was told, and its message.
 */
interface TellOnceLine {
  readonly flag: 'hasToldDamageNotRead' | 'hasToldReviewNotRead';
  readonly message: 'Damage sources not read' | 'Review values not read';
}

/** The line about a damage matrix that could not be read. */
const DAMAGE_NOT_READ: TellOnceLine = {
  flag: 'hasToldDamageNotRead',
  message: 'Damage sources not read',
};

/** The line about a part of an archive, whichever, that the review values could not be read from. */
const REVIEW_NOT_READ: TellOnceLine = {
  flag: 'hasToldReviewNotRead',
  message: 'Review values not read',
};

/**
 * Whether an error is a verdict on the content of an archive: the payload lacks what is expected of
 * it (`invalid_payload`). Any other error says nothing about the content (the file, the compressor,
 * the database, or a bug on this archive), and must be seen as what it is instead of being taken
 * for a verdict.
 *
 * @param error - What was caught.
 * @returns `true` for the `invalid_payload` error of an `AppError`.
 */
function isPayloadVerdict(error: unknown): error is AppError {
  return isAppError(error) && error.kind === 'invalid_payload';
}

/**
 * Give the event loop a turn: post a message on a channel of the page, and resolve when it arrives,
 * which is in a later task, after the events (the clicks, the typing) that are already waiting.
 *
 * It is a message and not a timer because Chromium throttles the timers of a window that is hidden
 * or minimised, down to one per minute, which would stretch a run of a few hundred matches to hours
 * while the window is out of sight. Message events are not throttled.
 *
 * @returns A promise resolved when the message is received. The channel is closed by then.
 */
function yieldWithMessage(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      // Closing one port disconnects the pair, so no handle stays open after the yield.
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Projects the archived matches of the linked account into the values of their metrics. */
export class ProjectionService {
  readonly #reader: ArchiveReaderService;
  readonly #metrics: MetricsRepository;
  readonly #details: MatchDetailRepository;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #yieldToEventLoop: () => Promise<void>;

  /**
   * Resolves when every projection asked for so far has ended, whatever way: it never rejects. The
   * next projection waits for it, which is what makes the projections follow one another.
   */
  #tail: Promise<void> = Promise.resolve();

  /**
   * The matches whose archive was found damaged and kept (see {@link keptArchiveKey}), with the size
   * of their file as the database recorded it: the runs leave them out until the app restarts, so
   * that the same file is not read, and logged, at every synchronisation, but read again a match
   * whose file changed. A restart tries them all again, possibly with a version that reads them.
   */
  readonly #keptArchives = new Map<string, number | null>();

  /**
   * Whether {@link MAX_CONSECUTIVE_DAMAGED} damaged archives in a row were met: from then on, until
   * the app restarts, a damaged archive is kept instead of being put back to `pending`.
   */
  #damageResetsStopped = false;

  /**
   * @param dependencies - See {@link ProjectionServiceDependencies}.
   */
  constructor(dependencies: ProjectionServiceDependencies) {
    this.#reader = dependencies.reader;
    this.#metrics = dependencies.metrics;
    this.#details = dependencies.details;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
    this.#yieldToEventLoop = dependencies.yieldToEventLoop ?? yieldWithMessage;
  }

  /**
   * Project every archived match that has no projection of the current version, most recent first:
   * what the synchronisation runs at the end of each of its runs. It waits for the projection that
   * is running, if any, then runs (see the module).
   *
   * @param accountId - The tracked account.
   * @param syncRunId - Id of the run that asks for the projection, to tie the log lines to it.
   * @returns How the run went. It never rejects: a failure is in the report (`skipped`, and
   *   `stoppedBy` when it ends the run) and in the log.
   */
  catchUp(accountId: AccountId, syncRunId: string): Promise<ProjectionReport> {
    return this.#inTurn(() => this.#catchUpNow(accountId, syncRunId));
  }

  /**
   * Project a match and the earlier archived matches its habits are made of, those of them that
   * have no projection of the current version: what the page of a match needs before it can show
   * the analysis. The match comes first, then the earlier ones, most recent first. The earlier
   * matches are the {@link PERSONAL_WINDOW} archived matches that precede the match, leaving out the
   * ones the analysis could not read (the habits do not count them either): once they are projected,
   * asking again projects nothing, whatever the older matches lack. A match the analysis cannot read
   * is found out by projecting it, so the window then moves back by one match at the next call.
   *
   * It waits for the projection that is running, if any, then runs (see the module): after a
   * catch-up of the synchronisation, it finds the window projected already, and projects nothing.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match to analyse.
   * @returns How the run went. It never rejects: a failure is in the report (`skipped`, and
   *   `stoppedBy` when it ends the run) and in the log. A match that is not stored, or whose detail
   *   is not archived, or whose window is projected already, gives a report with no match in it:
   *   nothing is projected for a match the page shows no analysis of.
   */
  projectMatch(accountId: AccountId, matchId: MatchId): Promise<ProjectionReport> {
    return this.#inTurn(() => this.#projectMatchNow(accountId, matchId));
  }

  /**
   * Forget the projection of a match whose archive was just replaced by one that holds more, so that
   * the next projection that lists it makes it again from the new file: what the detail queue calls
   * when it refreshes an archive, once the new file is written and before it records it.
   *
   * It takes its turn like a projection, and that is the point: a projection that runs meanwhile may
   * have read the old file already. Deleted while it runs, the projection row would be written back
   * by its save, made from the old file and of the current version, so never made again. In turn,
   * that projection ends first and the forgetting then deletes what it saved, while a projection
   * that starts after it reads the new file.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match.
   * @returns A promise resolved once the projection is forgotten.
   * @throws AppError of kind `storage` when the database fails: unlike a projection, the caller has
   *   to know, since the match keeps a projection made from the old file.
   */
  forgetProjection(accountId: AccountId, matchId: MatchId): Promise<void> {
    return this.#inTurn(() => {
      // A new file replaces the one that may have been kept damaged: it deserves a reading.
      this.#keptArchives.delete(keptArchiveKey(accountId, matchId));
      return this.#metrics.forgetProjection(accountId, matchId);
    });
  }

  /**
   * Run a projection (or the forgetting of one) once the ones asked for before it have ended, and
   * make the next one wait for it in turn. The turn passes on however the work ends: a projection
   * never rejects, but one that does all the same (a logger that throws, against the contract of its
   * port) must neither keep the next ones waiting nor make them fail; nor must a forgetting that
   * fails.
   *
   * @param projection - The work; it is called once the earlier ones have ended.
   * @returns What the work resolves to, or rejects with.
   */
  #inTurn<T>(projection: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(projection);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The work of {@link ProjectionService.catchUp}, once its turn has come.
   *
   * @param accountId - The tracked account.
   * @param syncRunId - Id of the run that asks for the projection, to tie the log lines to it.
   * @returns How the run went. It never rejects.
   */
  async #catchUpNow(accountId: AccountId, syncRunId: string): Promise<ProjectionReport> {
    // From the start of the work, not of the call: the time spent waiting for the turn was another
    // projection's.
    const startedAt = this.#now();
    const tags: LogContext = { syncRunId };

    let matchIds: readonly MatchId[];
    try {
      matchIds = await this.#metrics.listToProject(accountId, PROJECTION_VERSION);
    } catch (error) {
      // Nothing to go on with: no match is known.
      this.#logFailure('Projection stopped', error, accountId, tags);
      return STOPPED_AT_ONCE;
    }

    const report = await this.#projectAll(accountId, matchIds, tags);
    this.#logDone(report, startedAt, tags);
    return report;
  }

  /**
   * The work of {@link ProjectionService.projectMatch}, once its turn has come.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match to analyse.
   * @returns How the run went. It never rejects.
   */
  async #projectMatchNow(accountId: AccountId, matchId: MatchId): Promise<ProjectionReport> {
    // From the start of the work, as for a catch-up.
    const startedAt = this.#now();

    let matchIds: readonly MatchId[];
    try {
      matchIds = await this.#metrics.listToProjectUpTo(
        accountId,
        matchId,
        PROJECTION_VERSION,
        PERSONAL_WINDOW,
      );
    } catch (error) {
      // Nothing to go on with: no match is known.
      this.#logFailure('Projection stopped', error, accountId, {}, matchId);
      return STOPPED_AT_ONCE;
    }

    // No run id: a line about a match names that match, and the line that closes the run names the
    // match the page was opened on, which is not always the same.
    const report = await this.#projectAll(accountId, matchIds, {});
    this.#logDone(report, startedAt, { matchId });
    return report;
  }

  /**
   * Project the matches of a list, one after the other, with the rules both entry points share: a
   * match whose archive is absent or damaged goes back to `pending` in the window of the last 90
   * days, past it an absent archive is marked `evicted` and a damaged one is kept, one the analysis
   * cannot read is stored as failed, a failure that is not about a match leaves it as it was, and
   * the run stops after {@link MAX_CONSECUTIVE_FAILURES} such failures in a row. The matches kept
   * damaged earlier in the life of the app are left out. It gives the event loop a turn between two
   * matches.
   *
   * @param accountId - The tracked account.
   * @param matchIds - The matches to project, in the order to project them.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @returns How the run went. It never rejects.
   */
  async #projectAll(
    accountId: AccountId,
    matchIds: readonly MatchId[],
    tags: LogContext,
  ): Promise<ProjectionReport> {
    const run: RunState = {
      projected: 0,
      failed: 0,
      reset: 0,
      kept: 0,
      skipped: 0,
      toldKeys: new Set(),
      hasToldDamageNotRead: false,
      hasToldReviewNotRead: false,
    };
    let stoppedBy: ProjectionReport['stoppedBy'] = null;
    // The matches that failed one after the other, up to the one being projected.
    let failuresInARow = 0;
    // The archives found damaged one after the other, up to the one being projected.
    let damagedInARow = 0;
    const toProject = await this.#leaveOutKept(accountId, matchIds);
    for (const [index, matchId] of toProject.entries()) {
      try {
        // Between two matches, never before the first one: a run with nothing to do is instant.
        if (index > 0) {
          await this.#yieldToEventLoop();
        }
        const outcome = await this.#projectOne(accountId, tags, matchId, run);
        if (outcome === 'damaged') {
          damagedInARow += 1;
          // Decided before this archive is recorded, so that it is kept too.
          if (damagedInARow >= MAX_CONSECUTIVE_DAMAGED && !this.#damageResetsStopped) {
            this.#damageResetsStopped = true;
            this.#logger.log('error', LOG_SCOPE, 'Damaged archives in a row: kept from now on', {
              ...tags,
              matchId,
              damagedInARow,
            });
          }
          await this.#recordDamaged(accountId, matchId, run);
        } else {
          damagedInARow = 0;
        }
        // Projected, failed, reset, kept or left as it was found: the match got through, so the
        // failures were not general.
        failuresInARow = 0;
      } catch (error) {
        // Nothing was recorded for this match: it stays as it was, and the next run that lists it
        // tries it again.
        run.skipped += 1;
        failuresInARow += 1;
        if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
          // Each failure is logged once: the last one is the line that stops the run.
          this.#logFailure('Projection stopped', error, accountId, tags, matchId);
          stoppedBy = 'storage';
          break;
        }
        this.#logFailure('Match not projected', error, accountId, tags, matchId);
      }
    }
    return {
      projected: run.projected,
      failed: run.failed,
      reset: run.reset,
      kept: run.kept,
      skipped: run.skipped,
      stoppedBy,
    };
  }

  /**
   * Record a match whose archive is there but damaged: back to `pending` in the window of the last
   * 90 days, so that the queue downloads it again; kept as it is past it, or in the window once the
   * resets are stopped (see the module). A kept match is left out of the runs until the app
   * restarts, or until its file changes.
   *
   * @param accountId - The tracked account.
   * @param matchId - The match.
   * @param run - What the run counts.
   * @throws AppError of kind `storage` when the database fails: nothing was recorded.
   */
  async #recordDamaged(accountId: AccountId, matchId: MatchId, run: RunState): Promise<void> {
    const outcome = this.#damageResetsStopped
      ? 'kept'
      : await this.#details.markArchiveDamaged(accountId, matchId, this.#now());
    if (outcome === 'pending') {
      run.reset += 1;
      return;
    }
    // Kept, the match is remembered with the size of its file as the database holds it, so that a
    // new file written for it later (a new download, a refresh) is read again. That read also
    // checks the match is still `ready`: with the resets stopped, nothing else did.
    const stored = outcome === 'kept' ? await this.#details.getDetail(accountId, matchId) : null;
    if (stored?.status !== 'ready') {
      // Not `ready` any more (evicted by the storage since the run listed it, or put back to
      // `pending` by its page): it is left as it is, and not counted.
      return;
    }
    run.kept += 1;
    this.#keptArchives.set(keptArchiveKey(accountId, matchId), stored.archivedBytes);
  }

  /**
   * Leave out of a list the matches kept damaged earlier in the life of the app, as long as their
   * file is the one that was kept: still `ready`, with the same size recorded. A match whose row
   * changed since (downloaded again, evicted) is forgotten and stays in the list. Only the kept
   * matches cost a read of the database.
   *
   * @param accountId - The tracked account.
   * @param matchIds - The matches to project.
   * @returns The matches to project, in the same order.
   */
  async #leaveOutKept(
    accountId: AccountId,
    matchIds: readonly MatchId[],
  ): Promise<readonly MatchId[]> {
    const kept: MatchId[] = [];
    for (const matchId of matchIds) {
      const key = keptArchiveKey(accountId, matchId);
      if (!this.#keptArchives.has(key)) {
        continue;
      }
      try {
        const stored = await this.#details.getDetail(accountId, matchId);
        if (stored?.status === 'ready' && stored.archivedBytes === this.#keptArchives.get(key)) {
          kept.push(matchId);
          continue;
        }
      } catch {
        // The database fails: the match stays in the list, where its projection meets the same
        // failure and tells it, as for any other match.
        continue;
      }
      this.#keptArchives.delete(key);
    }
    return kept.length === 0 ? matchIds : matchIds.filter((matchId) => !kept.includes(matchId));
  }

  /**
   * Tell what a run did, in one line: at the `info` level when it did something, and at the `debug`
   * level when it did nothing, which is routine (the window of a match is projected already).
   *
   * @param report - How the run went.
   * @param startedAt - When the run started (Unix ms).
   * @param tags - What names the run in the line: its id, or the match it was asked for.
   */
  #logDone(report: ProjectionReport, startedAt: number, tags: LogContext): void {
    const counted = report.projected + report.failed + report.reset + report.kept + report.skipped;
    this.#logger.log(counted > 0 ? 'info' : 'debug', LOG_SCOPE, 'Projection done', {
      ...tags,
      projected: report.projected,
      failed: report.failed,
      reset: report.reset,
      kept: report.kept,
      skipped: report.skipped,
      durationMs: this.#now() - startedAt,
    });
  }

  /**
   * Project one match and record the outcome.
   *
   * @param accountId - The tracked account.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @param matchId - The match.
   * @param run - What the run counts.
   * @returns `damaged` when the archive is there but damaged, which the caller records (see
   *   {@link ProjectionService.#recordDamaged}); `done` when the match is dealt with (projected, failed, or its absent archive recorded).
   * @throws The error that keeps the match from being projected (the file, the compressor, the
   *   database, or a bug): nothing was recorded for the match.
   */
  async #projectOne(
    accountId: AccountId,
    tags: LogContext,
    matchId: MatchId,
    run: RunState,
  ): Promise<MatchOutcome> {
    // The reader logs an archive that is absent or damaged. A file it cannot read, or a broken
    // compressor, rejects here: the archive may be fine, so the match is left as it is (skipped).
    const read = await this.#reader.readArchive(accountId, matchId);
    if (read.kind === 'unreadable') {
      if (read.reason === 'damaged') {
        return 'damaged';
      }
      // An absent file has nothing left to lose: back to `pending` in the window, so that the
      // queue downloads it again, `evicted` past it. A match that is not `ready` any more (evicted
      // by the storage since it was listed) is left as it is, and is not counted.
      const outcome = await this.#details.markArchiveMissing(accountId, matchId, this.#now());
      if (outcome !== 'unchanged') {
        run.reset += 1;
      }
      return 'done';
    }

    let context: MatchContext;
    try {
      context = buildMatchContext(read.envelope);
    } catch (error) {
      // Only a payload that lacks what the analysis expects is a verdict on the match. Any other
      // error is a bug, which must be seen as one instead of marking the match.
      if (!isPayloadVerdict(error)) {
        throw error;
      }
      await this.#metrics.saveProjection(
        accountId,
        matchId,
        {
          version: PROJECTION_VERSION,
          playerBadge: null,
          hasLeaver: false,
          failed: true,
          projectedAt: this.#now(),
        },
        new Map(),
      );
      run.failed += 1;
      this.#logger.log('warn', LOG_SCOPE, 'Match could not be analysed', {
        ...tags,
        matchId,
        issue: issueOf(error),
      });
      return 'done';
    }

    // The metrics, then the damage sources and the review values next to them: their keys never
    // meet (a damage or review key starts with the prefix of its family, or is the key of Valve's
    // top three), so nothing is overwritten.
    const metricValues = projectMetrics(context, (key, error) => {
      this.#logMetricFailure(run, tags, matchId, key, error);
    });
    const damageValues = this.#projectDamageSources(run, tags, matchId, read.envelope);
    const reviewValues = this.#projectReviewValues(
      run,
      tags,
      matchId,
      read.envelope,
      context.durationS,
    );
    const values: MetricValues = new Map([...metricValues, ...damageValues, ...reviewValues]);
    await this.#metrics.saveProjection(
      accountId,
      matchId,
      {
        version: PROJECTION_VERSION,
        playerBadge: context.trackedBadge,
        hasLeaver: context.hasLeaver,
        failed: false,
        projectedAt: this.#now(),
      },
      values,
    );
    run.projected += 1;
    return 'done';
  }

  /**
   * Tell that a metric could not be computed, the first time it happens in a run. A metric that
   * throws does so on most matches (a payload that changed), so the log would otherwise hold a line
   * for each match. Only the kind of the error is logged: its message could quote a value of the
   * archive, which belongs to the players.
   *
   * It is called by the registry from the `catch` of a failed metric, so it never throws: telling
   * about a metric is not worth losing the projection of a match, or the run.
   *
   * @param run - What the run counts, and the metrics it told about.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @param matchId - The match being projected.
   * @param key - The key of the metric that failed.
   * @param error - What the metric threw.
   */
  #logMetricFailure(
    run: RunState,
    tags: LogContext,
    matchId: MatchId,
    key: MetricKey,
    error: unknown,
  ): void {
    try {
      if (run.toldKeys.has(key)) {
        return;
      }
      run.toldKeys.add(key);
      this.#logger.log('info', LOG_SCOPE, 'Metric not computed', {
        ...tags,
        matchId,
        key,
        kind: toAppError(error).kind,
      });
    } catch {
      // The logger promises not to throw; if it does, the metric is `null` all the same.
    }
  }

  /**
   * Work out the damage-source values of a match from its archive. A match with no damage matrix
   * has none, and so has a match whose damage matrix is not what is expected (the payload changed,
   * say): the metrics of the match do not depend on it, so the match is projected all the same,
   * and the problem is told, once in a run.
   *
   * @param run - What the run counts, and what it told about.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @param matchId - The match being projected.
   * @param envelope - The decoded archive of the match.
   * @returns The values by key; none when the damage sources cannot be read.
   * @throws The error that is not about the content of the matrix (a bug): the match is not
   *   projected, as for any failure that says nothing about the match.
   */
  #projectDamageSources(
    run: RunState,
    tags: LogContext,
    matchId: MatchId,
    envelope: ArchiveEnvelope,
  ): ReadonlyMap<string, number> {
    let read: DamageMatrixRead | null;
    try {
      read = readDamageMatrix(envelope);
    } catch (error) {
      // Only a matrix that is not what is expected is a verdict on the damage sources. Any other
      // error is a bug, which must be seen as one instead of silently dropping the damage.
      if (!isPayloadVerdict(error)) {
        throw error;
      }
      this.#tellOnce(run, DAMAGE_NOT_READ, tags, matchId, error);
      return new Map();
    }
    // No matrix: some matches come without one, which is no news.
    return read === null ? new Map() : projectDamageSources(read);
  }

  /**
   * Tell that content of an archive is not what is expected (the damage matrix, a part the review
   * values need), the first time it happens in a run for the line given. A change of the payload
   * hits most matches, so the log would otherwise hold a line for each match. The line holds the
   * place and the code of the problem, never a value of the archive.
   *
   * It never throws, like the line about a metric that failed: telling about the damage sources or
   * the review values is not worth losing the metrics of a match, which are computed already.
   *
   * @param run - What the run counts, and what it told about.
   * @param line - The line to tell: its message, and the flag of the run that remembers it.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @param matchId - The match being projected.
   * @param error - The `invalid_payload` error of the content.
   */
  #tellOnce(
    run: RunState,
    line: TellOnceLine,
    tags: LogContext,
    matchId: MatchId,
    error: AppError,
  ): void {
    try {
      if (run[line.flag]) {
        return;
      }
      run[line.flag] = true;
      this.#logger.log('info', LOG_SCOPE, line.message, {
        ...tags,
        matchId,
        issue: issueOf(error),
      });
    } catch {
      // The logger promises not to throw; if it does, the match lacks those values all the same.
    }
  }

  /**
   * Work out the review values of a match from its archive: the deaths of each phase, the first
   * purchase of each shop item and the deaths before it, the places on the scoreboard, the avoidable
   * deaths. They come from four parts of the archive, each read on its own, so that a part that
   * cannot be read costs the match its own values and no other: a scoreboard that cannot be read
   * still leaves the deaths and the items, and so on. The metrics of the match do not depend on any
   * of them, so the match is projected all the same, and the problem is told, once in a run.
   *
   * @param run - What the run counts, and what it told about.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @param matchId - The match being projected.
   * @param envelope - The decoded archive of the match.
   * @param durationS - The length of the match, in seconds.
   * @returns The values by key; none for a part that is incomplete or cannot be read.
   * @throws The error that is not about the content of a part (a bug): the match is not
   *   projected, as for any failure that says nothing about the match.
   */
  #projectReviewValues(
    run: RunState,
    tags: LogContext,
    matchId: MatchId,
    envelope: ArchiveEnvelope,
    durationS: number,
  ): ReadonlyMap<string, number> {
    return projectReviewValues({
      durationS,
      // Death details that miss a death are `null` already: unknown, which is no news.
      deathTimesS: this.#readReviewPart(run, tags, matchId, () => readTrackedDeathTimes(envelope)),
      items: this.#readReviewPart(run, tags, matchId, () => readTrackedItems(envelope)),
      scoreboard: this.#readReviewPart(run, tags, matchId, () => readScoreboard(envelope)),
      // `null` when the deaths are incomplete or the positions of the other players are not all known.
      avoidableDeaths: this.#readReviewPart(run, tags, matchId, () =>
        avoidableDeathCount(judgeDeaths(envelope)),
      ),
    });
  }

  /**
   * Read one part of an archive the review values need, and leave it unknown when it is not what is
   * expected.
   *
   * @param run - What the run counts, and what it told about.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @param matchId - The match being projected.
   * @param read - Reads the part from the archive.
   * @returns What the reader gives, `null` when it is `null` (the part is incomplete) or when the
   *   part is not what is expected (the payload changed, say).
   * @throws The error that is not about the content of the part (a bug): only a part that is not
   *   what is expected is a verdict on the review values, and any other error must be seen as what
   *   it is instead of silently dropping them.
   */
  #readReviewPart<Part>(
    run: RunState,
    tags: LogContext,
    matchId: MatchId,
    read: () => Part,
  ): Part | null {
    try {
      return read();
    } catch (error) {
      if (!isPayloadVerdict(error)) {
        throw error;
      }
      // Whichever part it is, the run tells about the first one that fails.
      this.#tellOnce(run, REVIEW_NOT_READ, tags, matchId, error);
      return null;
    }
  }

  /**
   * Log a failure that is not about the match it hit (a match that is skipped, or the run that
   * stops), as a warning. The line holds the kind and the context of the error with the account id
   * replaced (the error of a file or of the database may quote a path or a query, which holds it).
   * The stack is kept for what is not an `AppError` (a bug): the errors of the app say by
   * themselves what failed.
   *
   * @param message - `Match not projected` for a match that is skipped, `Projection stopped` for
   *   the failure that ends the run.
   * @param error - What was caught.
   * @param accountId - The tracked account, kept out of the log.
   * @param tags - What every line about a match holds besides its own fields: the run it belongs to.
   * @param matchId - The match being projected when it failed, or the match the run was asked for
   *   when the list of its matches failed; none when the run is not about one match.
   */
  #logFailure(
    message: 'Match not projected' | 'Projection stopped',
    error: unknown,
    accountId: AccountId,
    tags: LogContext,
    matchId?: MatchId,
  ): void {
    this.#logger.log('warn', LOG_SCOPE, message, {
      ...describeErrorForLog(error, accountId, !isAppError(error)),
      ...tags,
      ...(matchId === undefined ? {} : { matchId }),
    });
  }
}

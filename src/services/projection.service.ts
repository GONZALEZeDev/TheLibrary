/**
 * The projection: turns every archived match into the metric values the analysis stores, so that the
 * pages never read an archive to compare a match.
 *
 * Analysing a match starts from its archive, a large compressed file. The projection reads each
 * archive once, runs the metrics of the registry on it (`../core/analysis/registry`) and keeps the
 * values in the database (`./metrics.repository`). It is a catch-up: it works on the matches whose
 * detail is archived and that have no projection of the current version, which is every new match
 * after a synchronisation, and every match after the version changes (the archives are on the disk
 * already, so a new version needs no network). A synchronisation runs it after the detail queue.
 *
 * What a match can end in, and what it costs:
 * - the archive is projected: its values are stored, with the badge of the player, whether somebody
 *   left, and the version (`projected`). A metric the archive does not hold what it needs for is an
 *   unknown value (`null`), which is no failure; a metric that throws is the same, and it is told
 *   in the log, once for each metric in a run;
 * - the analysis cannot read the match, since the archive does not hold what it expects of a match
 *   (`failed`): the match is stored as failed, with no values. That is a verdict on the match, which
 *   is not tried again before the version changes: downloading it again would give the same detail;
 * - the archive is absent or damaged (`reset`): the match goes back to `pending`, so that the next
 *   run of the detail queue downloads it again, and it has no projection until then. That cannot
 *   loop, since the queue only archives a detail it could read back;
 * - the failure says nothing about the match, so nothing is recorded and the match is left as it was
 *   (`skipped`): the file cannot be read, the compressor or the database fails, or the code has a
 *   bug on this archive. It is told in the log, once, and the run goes on with the next match, so
 *   that one archive that always fails does not keep the others from being projected. The skipped
 *   match is tried again at the next run;
 * - three failures in a row mean that the cause is not one archive but the disk, the compressor or
 *   the database, which would fail the same way on every match: the run stops (`stoppedBy:
 *   'storage'`). Any match that gets through (projected, failed or reset) ends the streak. The
 *   matches already projected stay so, and the next run goes on from there. The list of the matches
 *   to project failing stops the run at once, since there is nothing to go on with.
 *
 * A run never throws: what went wrong is in its report and in the log. Between two matches it gives
 * the event loop a turn, so that the compression of the archives and the metrics, which run on the
 * thread of the interface, do not freeze it for the whole catch-up.
 *
 * The log never holds an account id, a value of an archive or the message of the error of a metric,
 * which could quote one: a line holds the match, the key of the metric, and the kind of the failure
 * or the field path and the issue code of the payload.
 *
 * @packageDocumentation
 */
import { buildMatchContext, type MatchContext } from '../core/analysis/match-context';
import type { MetricKey } from '../core/analysis/metric';
import { projectMetrics, PROJECTION_VERSION } from '../core/analysis/registry';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { isAppError, toAppError } from '../core/errors/app-error';
import type { Logger } from '../ports/logger.port';
import type { ArchiveReaderService } from './archive-reader.service';
import type { MatchDetailRepository } from './match-detail.repository';
import { describeErrorForLog } from './match-detail-verdicts';
import type { MetricsRepository } from './metrics.repository';

/** What {@link ProjectionService} needs. */
export interface ProjectionServiceDependencies {
  /** Reads the archives of the matches. */
  readonly reader: ArchiveReaderService;
  /** Where the projections are kept, and which matches still need one. */
  readonly metrics: MetricsRepository;
  /** Where the detail state of the matches is kept: a match with no usable archive goes back to `pending`. */
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
  /** Matches whose archive is absent or damaged, put back to `pending`. */
  readonly reset: number;
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

/** What a run counts as it goes, and the metrics it already told about. */
interface RunState {
  projected: number;
  failed: number;
  reset: number;
  skipped: number;
  /** The keys of the metrics that were told as not computed in this run. */
  readonly toldKeys: Set<MetricKey>;
}

/**
 * Give the event loop a turn: post a message on a channel of the page, and resolve when it arrives,
 * which is in a later task, after the events (the clicks, the typing) that are already waiting.
 *
 * It is a message and not a timer because Chromium throttles the timers of a window that is hidden
 * or minimised, down to one per minute, which would stretch a catch-up of a few hundred matches to
 * hours when the app synchronises from the tray. Message events are not throttled.
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
   * Project every archived match that has no projection of the current version, most recent first.
   *
   * @param accountId - The tracked account.
   * @param syncRunId - Id of the synchronisation that runs the projection, to tie the log lines to it.
   * @returns How the run went. It never rejects: a failure is in the report (`skipped`, and
   *   `stoppedBy` when it ends the run) and in the log.
   */
  async catchUp(accountId: AccountId, syncRunId: string): Promise<ProjectionReport> {
    const startedAt = this.#now();
    const run: RunState = { projected: 0, failed: 0, reset: 0, skipped: 0, toldKeys: new Set() };

    let matchIds: readonly MatchId[];
    try {
      matchIds = await this.#metrics.listToProject(accountId, PROJECTION_VERSION);
    } catch (error) {
      // Nothing to go on with: no match is known.
      this.#logFailure('Projection stopped', error, accountId, syncRunId);
      return { projected: 0, failed: 0, reset: 0, skipped: 0, stoppedBy: 'storage' };
    }

    let stoppedBy: ProjectionReport['stoppedBy'] = null;
    // The matches that failed one after the other, up to the one being projected.
    let failuresInARow = 0;
    for (const [index, matchId] of matchIds.entries()) {
      try {
        // Between two matches, never before the first one: a catch-up with nothing to do is instant.
        if (index > 0) {
          await this.#yieldToEventLoop();
        }
        await this.#projectMatch(accountId, syncRunId, matchId, run);
        // Projected, failed or reset: the match got through, so the failures were not general.
        failuresInARow = 0;
      } catch (error) {
        // Nothing was recorded for this match: it stays as it was, and the next run tries it again.
        run.skipped += 1;
        failuresInARow += 1;
        if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
          // Each failure is logged once: the last one is the line that stops the run.
          this.#logFailure('Projection stopped', error, accountId, syncRunId, matchId);
          stoppedBy = 'storage';
          break;
        }
        this.#logFailure('Match not projected', error, accountId, syncRunId, matchId);
      }
    }

    // Routine when nothing was done (the common case: every synchronisation runs a catch-up).
    this.#logger.log(
      run.projected + run.failed + run.reset + run.skipped > 0 ? 'info' : 'debug',
      LOG_SCOPE,
      'Projection done',
      {
        syncRunId,
        projected: run.projected,
        failed: run.failed,
        reset: run.reset,
        skipped: run.skipped,
        durationMs: this.#now() - startedAt,
      },
    );
    return {
      projected: run.projected,
      failed: run.failed,
      reset: run.reset,
      skipped: run.skipped,
      stoppedBy,
    };
  }

  /**
   * Project one match and record the outcome.
   *
   * @param accountId - The tracked account.
   * @param syncRunId - Id of the run in the logs.
   * @param matchId - The match.
   * @param run - What the run counts.
   * @throws The error that keeps the match from being projected (the file, the compressor, the
   *   database, or a bug): nothing was recorded for the match.
   */
  async #projectMatch(
    accountId: AccountId,
    syncRunId: string,
    matchId: MatchId,
    run: RunState,
  ): Promise<void> {
    // The reader logs an archive that is absent or damaged. A file it cannot read, or a broken
    // compressor, rejects here: the archive may be fine, so the match is left as it is (skipped).
    const read = await this.#reader.readArchive(accountId, matchId);
    if (read.kind === 'unreadable') {
      await this.#details.resetToPending(accountId, matchId);
      run.reset += 1;
      return;
    }

    let context: MatchContext;
    try {
      context = buildMatchContext(read.envelope);
    } catch (error) {
      // Only a payload that lacks what the analysis expects is a verdict on the match. Any other
      // error is a bug, which must be seen as one instead of marking the match.
      if (!isAppError(error) || error.kind !== 'invalid_payload') {
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
      const { issue } = error.context;
      this.#logger.log('warn', LOG_SCOPE, 'Match could not be analysed', {
        syncRunId,
        matchId,
        issue: typeof issue === 'string' ? issue : 'unknown',
      });
      return;
    }

    const values = projectMetrics(context, (key, error) => {
      this.#logMetricFailure(run, syncRunId, matchId, key, error);
    });
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
   * @param syncRunId - Id of the run in the logs.
   * @param matchId - The match being projected.
   * @param key - The key of the metric that failed.
   * @param error - What the metric threw.
   */
  #logMetricFailure(
    run: RunState,
    syncRunId: string,
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
        syncRunId,
        matchId,
        key,
        kind: toAppError(error).kind,
      });
    } catch {
      // The logger promises not to throw; if it does, the metric is `null` all the same.
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
   * @param syncRunId - Id of the run in the logs.
   * @param matchId - The match being projected when it failed, if any.
   */
  #logFailure(
    message: 'Match not projected' | 'Projection stopped',
    error: unknown,
    accountId: AccountId,
    syncRunId: string,
    matchId?: MatchId,
  ): void {
    this.#logger.log('warn', LOG_SCOPE, message, {
      ...describeErrorForLog(error, accountId, !isAppError(error)),
      syncRunId,
      ...(matchId === undefined ? {} : { matchId }),
    });
  }
}

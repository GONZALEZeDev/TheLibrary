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
 * left. However a projection ends, the next one runs.
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
 * - the archive is absent or damaged (`reset`): the match goes back to `pending`, so that the next
 *   run of the detail queue downloads it again, and it has no projection until then. That cannot
 *   loop, since the queue only archives a detail it could read back;
 * - the failure says nothing about the match, so nothing is recorded and the match is left as it was
 *   (`skipped`): the file cannot be read, the compressor or the database fails, or the code has a
 *   bug on this archive. It is told in the log, once, and the run goes on with the next match, so
 *   that one archive that always fails does not keep the others from being projected. The skipped
 *   match still lacks a projection, so the next run that lists it tries it again: the next
 *   synchronisation, or the next opening of a page whose window holds it (the analysis finds that
 *   window incomplete, and asks again);
 * - three failures in a row mean that the cause is not one archive but the disk, the compressor or
 *   the database, which would fail the same way on every match: the run stops (`stoppedBy:
 *   'storage'`). Any match that gets through (projected, failed or reset) ends the streak. The
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

/** What a run reports when the list of its matches cannot be read: it stops before the first match. */
const STOPPED_AT_ONCE: ProjectionReport = {
  projected: 0,
  failed: 0,
  reset: 0,
  skipped: 0,
  stoppedBy: 'storage',
};

/** What a run counts as it goes, and what it already told about. */
interface RunState {
  projected: number;
  failed: number;
  reset: number;
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
   * Run a projection once the ones asked for before it have ended, and make the next one wait for it
   * in turn. The turn passes on however the projection ends: a projection never rejects, but one
   * that does all the same (a logger that throws, against the contract of its port) must neither
   * keep the next ones waiting nor make them fail.
   *
   * @param projection - The work of the projection; it is called once the earlier ones have ended.
   * @returns What the projection resolves to, or rejects with.
   */
  #inTurn(projection: () => Promise<ProjectionReport>): Promise<ProjectionReport> {
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
   * match that cannot be read goes back to `pending`, one the analysis cannot read is stored as
   * failed, a failure that is not about a match leaves it as it was, and the run stops after
   * {@link MAX_CONSECUTIVE_FAILURES} such failures in a row. It gives the event loop a turn between
   * two matches.
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
      skipped: 0,
      toldKeys: new Set(),
      hasToldDamageNotRead: false,
      hasToldReviewNotRead: false,
    };
    let stoppedBy: ProjectionReport['stoppedBy'] = null;
    // The matches that failed one after the other, up to the one being projected.
    let failuresInARow = 0;
    for (const [index, matchId] of matchIds.entries()) {
      try {
        // Between two matches, never before the first one: a run with nothing to do is instant.
        if (index > 0) {
          await this.#yieldToEventLoop();
        }
        await this.#projectOne(accountId, tags, matchId, run);
        // Projected, failed or reset: the match got through, so the failures were not general.
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
      skipped: run.skipped,
      stoppedBy,
    };
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
    const counted = report.projected + report.failed + report.reset + report.skipped;
    this.#logger.log(counted > 0 ? 'info' : 'debug', LOG_SCOPE, 'Projection done', {
      ...tags,
      projected: report.projected,
      failed: report.failed,
      reset: report.reset,
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
   * @throws The error that keeps the match from being projected (the file, the compressor, the
   *   database, or a bug): nothing was recorded for the match.
   */
  async #projectOne(
    accountId: AccountId,
    tags: LogContext,
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
      return;
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
   * purchase of each shop item and the deaths before it, the places on the scoreboard. They come
   * from three parts of the archive, each read on its own, so that a part that cannot be read costs
   * the match its own values and no other: a scoreboard that cannot be read still leaves the deaths
   * and the items, and so on. The metrics of the match do not depend on any of them, so the match is
   * projected all the same, and the problem is told, once in a run.
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

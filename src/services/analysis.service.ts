/**
 * The match analysis: what the match page shows when it compares one match with the community and
 * with the player's own habits.
 *
 * The numbers come from three places. The values of the 24 metrics of a match, and the habits (the
 * values of the earlier matches), are the projection kept in the database (`./projection.service`,
 * `./metrics.repository`). The community data (the percentiles of the metrics and the average course
 * of a match, for a rank and a match length) is the cache of `./benchmark.service`. The phase table
 * is the only part read from the archive of the match (`./archive-reader.service`): the totals of
 * the souls, the damage and the kills in each phase, and their share of the team. This service reads
 * all of it; the comparisons and the view types are in `./analysis-view`, a pure module. Where a
 * match stands before any of it is read (the states below) is decided by `./analysis-subject`,
 * which the damage view of the match page shares.
 *
 * Every archived match is analysed after each synchronisation: at the end of its run, the
 * synchronisation projects every archived match that has no projection of the current version. A
 * page that opens a match still not analysed (before the end of the run that archived it, or after a
 * new version of the metrics and before the next run) analyses it as a fallback, behind a dialog:
 * {@link AnalysisService.analyseMatch} makes the projection of the match and of the earlier matches
 * its habits are made of, and answers the analysis; {@link AnalysisService.getMatchAnalysis} only
 * reads what is stored. The projection writes rows for the linked account, so the fallback runs in
 * the exclusive section of the synchronisation ({@link ExclusiveRunner}): an account change waits
 * for it, and a new analysis is refused while the account changes. The analyses follow one another,
 * whatever the matches (see {@link AnalysisService.analyseMatch}), and the projection service runs
 * one projection at a time, whether the synchronisation or a page asks for it.
 *
 * What a page can be told about a match (`MatchAnalysisView`):
 * - `not_analysed`: there is nothing to analyse. No account is linked, or the detail of the match is
 *   not archived, or its archive cannot be read (the detail view explains the archive);
 * - `pending`: the match is archived but the projection has not run on it yet, or ran with an older
 *   version of the metrics; or it has, but not on every earlier match its habits are made of (the
 *   match was projected as part of the window of a later match, whose window stops before its own
 *   ends). The page asks for {@link AnalysisService.analyseMatch}, which does it, and which fails
 *   rather than answer `pending` again;
 * - `failed`: the analysis cannot read the match, since its archive lacks what the analysis needs;
 * - `ready`: the analysis, see `MatchAnalysis`.
 *
 * A match is compared with the rank the player had in it (a ranked match), or with the rank the
 * player has now (an unranked match), or with every rank when there is neither, over matches of
 * about the same length. Everything the community cannot tell (nothing cached, a cohort too small,
 * a metric the community has no reference for) is told in the view and never replaced by a number,
 * so that the page can say "no comparison" instead of a wrong one. A page opening asks for the
 * analysis with {@link AnalysisService.analyseMatch}, then for the community data with
 * {@link AnalysisService.refreshCommunity}, and reads the analysis again.
 *
 * Nothing is logged on the normal path. Two lines are written here, each at most once per match:
 * one for a match whose archive no longer holds what the analysis needs, which carries the match and
 * the field path and the issue code of the payload; one for a match whose length in the database and
 * in the archive differ, which carries the match only. Never an account id or a value, the lengths
 * included.
 *
 * @packageDocumentation
 */
import { cohortRankFor, durationWindowOf, type Cohort } from '../core/analysis/cohort';
import { PREVIOUS_LOOKUP } from '../core/analysis/insights/thresholds';
import { buildMatchContext, type MatchContext } from '../core/analysis/match-context';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import type { MatchId } from '../core/domain/match';
import { AppError, isAppError, issueOf } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import {
  analysisSubjectOf,
  type AnalysisSubject,
  type AnalysisSubjectDependencies,
} from './analysis-subject';
import { buildAnalysis, type MatchAnalysisView } from './analysis-view';
import type { ArchiveReaderService } from './archive-reader.service';
import type { BenchmarkService, CohortRefresh } from './benchmark.service';
import type { LinkedAccountRank, LinkedAccountRepository } from './linked-account.repository';
import type { MatchDetailRepository } from './match-detail.repository';
import type { MetricsRepository, StoredProjection } from './metrics.repository';
import type { ProjectionService } from './projection.service';
import { ReportOnce } from './report-once';

/**
 * Runs a task in a section that a change of the linked account waits for, and refuses once the
 * account is changing. It is the part of the synchronisation the analysis needs
 * (`SyncService.runExclusive` implements it), so that the analysis does not depend on the rest.
 */
export interface ExclusiveRunner {
  /**
   * Run a task that writes for the linked account.
   *
   * @param task - The work to do. It reads the linked account itself, inside the section: an
   *   account id read before the task is admitted may be the one of an account that is gone.
   * @returns What the task resolves to.
   * @throws AppError of kind `unexpected` when the section refuses the task because the account is
   *   changing (`isSuspensionRefusal` tells it); otherwise what the task throws, unchanged.
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T>;
}

/** What {@link AnalysisService} needs. */
export interface AnalysisServiceDependencies {
  /** The linked account. The service works for it only, which it resolves itself. */
  readonly accountSource: AccountSource;
  /** Where the projections of the matches are kept: their values, and the habits of the player. */
  readonly metrics: MetricsRepository;
  /** Where the detail state of the matches is kept: only an archived match can be analysed. */
  readonly details: MatchDetailRepository;
  /** Reads the archive of a match, for its phase table. */
  readonly reader: ArchiveReaderService;
  /** The community data of the cohorts. */
  readonly benchmarks: BenchmarkService;
  /** Where the rank of the linked account is kept. */
  readonly accounts: LinkedAccountRepository;
  /** Projects a match, and the earlier ones its habits are made of, when its page asks for it. */
  readonly projection: ProjectionService;
  /** The section the on-demand analysis runs in: the synchronisation, which an account change suspends. */
  readonly exclusive: ExclusiveRunner;
  /** Structured logger. */
  readonly logger: Logger;
}

/** The scope of the log line of this service. */
const LOG_SCOPE = 'analysis';

/**
 * The cohort a match is compared with: the rank the player had in it (the current rank of the
 * player for an unranked match, every rank without either) over matches of about the same length.
 *
 * @param projection - The projection of the match.
 * @param rank - The current rank of the player, if it is known.
 * @returns The cohort.
 */
function cohortOf(projection: StoredProjection, rank: LinkedAccountRank | null): Cohort {
  return {
    rank: cohortRankFor(projection.playerBadge, rank?.badge ?? null),
    window: durationWindowOf(projection.durationS),
  };
}

/** Compares the matches of the linked account with the community and with the player's habits. */
export class AnalysisService {
  /** What {@link analysisSubjectOf} reads to find where a match stands (the gate the damage view shares). */
  readonly #subjectDeps: AnalysisSubjectDependencies;
  readonly #metrics: MetricsRepository;
  readonly #reader: ArchiveReaderService;
  readonly #benchmarks: BenchmarkService;
  readonly #accounts: LinkedAccountRepository;
  readonly #projection: ProjectionService;
  readonly #exclusive: ExclusiveRunner;

  /**
   * Reports a match as unanalysable or as having two lengths. Such a match stays so until it is
   * projected again, and the page reads its analysis every time it is shown: each problem of a
   * match is reported once, not at every read.
   */
  readonly #reports: ReportOnce;

  /**
   * The analyses that are running or waiting for their turn ({@link AnalysisService.analyseMatch}),
   * by match. A call for a match that is being analysed gets the running promise. The run leaves
   * the map when the work ends, inside the exclusive section, so that no run is left in it once an
   * account change has been let through; a run that was refused leaves it at once.
   */
  readonly #analyses = new Map<MatchId, Promise<MatchAnalysisView>>();

  /**
   * Resolves when every analysis asked for so far has ended, whatever way: it never rejects. The
   * next analysis waits for it, which is what makes the analyses follow one another.
   */
  #tail: Promise<void> = Promise.resolve();

  /**
   * @param dependencies - See {@link AnalysisServiceDependencies}.
   */
  constructor(dependencies: AnalysisServiceDependencies) {
    this.#subjectDeps = {
      accountSource: dependencies.accountSource,
      details: dependencies.details,
      metrics: dependencies.metrics,
    };
    this.#metrics = dependencies.metrics;
    this.#reader = dependencies.reader;
    this.#benchmarks = dependencies.benchmarks;
    this.#accounts = dependencies.accounts;
    this.#projection = dependencies.projection;
    this.#exclusive = dependencies.exclusive;
    this.#reports = new ReportOnce(dependencies.logger, LOG_SCOPE);
  }

  /**
   * Read the analysis of a match of the linked account, as it is stored: compare each of its
   * metrics with the community data in the cache and with the habits of the player, pick the
   * strengths and the weaknesses, and add the phase table. Nothing is projected and nothing is
   * downloaded: the page asks for the projection with {@link AnalysisService.analyseMatch}, and for
   * the community data with {@link AnalysisService.refreshCommunity}.
   *
   * @param matchId - The match.
   * @returns What the page shows, see {@link MatchAnalysisView}. A match that is not archived, or
   *   whose archive is absent or damaged, is `not_analysed`; one without a projection of the
   *   current version, or whose window of habits holds an archived match without one, is `pending`;
   *   one the analysis cannot read is `failed`.
   * @throws AppError of kind `storage` when the database fails, or when the file of the archive
   *   cannot be read or the compressor is broken (neither says anything about the match). Any other
   *   error is a bug and is not hidden behind a state.
   */
  async getMatchAnalysis(matchId: MatchId): Promise<MatchAnalysisView> {
    return this.#viewOf(matchId, await analysisSubjectOf(this.#subjectDeps, matchId, 'window'));
  }

  /**
   * Analyse a match of the linked account when its page is opened: project the match and the
   * earlier archived matches its habits are made of, those of them that have no projection of the
   * current version, then answer the analysis as {@link AnalysisService.getMatchAnalysis} does. A
   * match whose window is projected already projects nothing, so asking twice costs one reading.
   * Nothing is downloaded: the page asks for the community data with
   * {@link AnalysisService.refreshCommunity}.
   *
   * Once the projection has run, the answer depends on the match alone. An earlier match of the
   * window that the projection skipped (its file could not be read, say) leaves the window
   * incomplete, which neither fails the call nor makes it answer `pending`: the analysis is shown,
   * with the habits that could be projected, and the next opening of the page asks again, which
   * tries that match again.
   *
   * The work runs in the exclusive section of the synchronisation ({@link ExclusiveRunner}), which
   * an account change waits for and which refuses new work once the account is changing. The linked
   * account is read inside the section, so that an account change between the call and the
   * admission of the work is seen: nothing is projected for the account that was linked before.
   *
   * One analysis runs per match, and one at a time. A call for a match that is being analysed gets
   * that run (it may have been admitted before an account change began). A call for another match
   * makes a run of its own, which waits for the earlier ones to end: the windows of two matches
   * overlap, so analyses side by side would project the same matches twice, and two saves of one
   * match at once can leave a projection row standing over metrics that were deleted. A run waits
   * inside the section, so an account change waits for the runs queued behind it as well; one that
   * is refused ends at once and does not let the next one slip past the running ones.
   *
   * @param matchId - The match.
   * @returns What the page shows, see {@link MatchAnalysisView}. Without an account, or for a match
   *   whose detail is not archived, it is `not_analysed` and nothing is projected. It is never
   *   `pending`: a match the projection could not store is a failure of the call, see below.
   * @throws AppError of kind `unexpected` carrying `context.reason = 'suspended'` when the account is
   *   changing: nothing was analysed (`isSuspensionRefusal` tells it from a failure). AppError of
   *   kind `storage` when the database fails, when the file of the archive cannot be read or the
   *   compressor is broken, and when the match is still not projected once the projection has run.
   *   That last case covers every way the projection can fail to store the match, a bug in the
   *   projection included: the projection never rejects, it logs what went wrong (with its stack,
   *   for a bug) and skips the match, so the rejection only says that the match was not stored and
   *   the log says why; the next call tries again. Any other error, from outside the projection, is
   *   a bug and is not hidden behind a state.
   */
  analyseMatch(matchId: MatchId): Promise<MatchAnalysisView> {
    const running = this.#analyses.get(matchId);
    if (running !== undefined) {
      return running;
    }
    const previous = this.#tail;
    // The run is registered in the very turn it starts in, so that no call can slip in between.
    const run = this.#exclusive.runExclusive(() => this.#analyseInTurn(previous, matchId));
    this.#analyses.set(matchId, run);
    // Never rejects, so that a failed analysis does not keep the next ones from running.
    const ended = run.then(
      () => undefined,
      () => undefined,
    );
    // Waits for the earlier runs too: a refused run ends at once, before they do.
    this.#tail = Promise.all([previous, ended]).then(() => undefined);
    // The path of a run that was refused, whose work never started; a run that was not refused has
    // left the map already, and a newer run for the same match must stay in it.
    void ended.then(() => {
      if (this.#analyses.get(matchId) === run) {
        this.#analyses.delete(matchId);
      }
    });
    return run;
  }

  /**
   * Download the community data a match is compared with, unless the cache holds it still fresh. The
   * match page calls it when its analysis tab opens, then reads the analysis again; one download
   * serves every match of the same rank and length for a day.
   *
   * @param matchId - The match.
   * @returns `fresh` when nothing was requested: the cached data is less than a day old, or there is
   *   nothing to compare yet (no account, a match whose detail is not archived, a match that
   *   {@link AnalysisService.getMatchAnalysis} calls `pending`, or a projection that failed).
   *   `updated` when new data was downloaded and stored, `unavailable` when it could not be (the
   *   cached data, if any, stays as it was).
   * @throws AppError of kind `storage` when the database fails. The download itself never rejects.
   */
  async refreshCommunity(matchId: MatchId): Promise<CohortRefresh> {
    const subject = await analysisSubjectOf(this.#subjectDeps, matchId, 'window');
    if (subject.kind !== 'projected') {
      return 'fresh';
    }
    const { accountId, projection } = subject;
    const rank = await this.#accounts.getRank(accountId);
    return this.#benchmarks.refresh(accountId, cohortOf(projection, rank));
  }

  /**
   * What {@link AnalysisService.analyseMatch} runs in the exclusive section: wait for the earlier
   * analyses to end, do the work, and leave the map of the running analyses when it is over. The
   * run leaves the map here, inside the section, and not only when its promise settles a few turns
   * later: the account change that waits for the section must find the map empty when it gets
   * through, or a call for the same match made for the new account would get the view of the old
   * one.
   *
   * @param previous - Resolves when the analyses asked for before this one have ended; it never
   *   rejects.
   * @param matchId - The match.
   * @returns The view, see {@link AnalysisService.analyseMatch}.
   * @throws AppError, see {@link AnalysisService.analyseMatch}.
   */
  async #analyseInTurn(previous: Promise<void>, matchId: MatchId): Promise<MatchAnalysisView> {
    try {
      await previous;
      return await this.#analyseInSection(matchId);
    } finally {
      this.#analyses.delete(matchId);
    }
  }

  /**
   * The work of an analysis: find where the match stands, project it with the earlier matches its
   * habits are made of when it is `pending` (the match itself, or its window), and answer the view.
   * The linked account is read here, inside the section, by the same gate that reads the state of
   * the match, and never before: the section is what keeps it from changing until the work has
   * ended.
   *
   * The report of the projection is not read: it never rejects, and tells what went wrong in the
   * log. Afterwards the match alone decides. A match it could not store (a failure that is not about
   * the match, or a run stopped by three of them) is still `pending`, which is a failure of the
   * analysis; the message holds neither the match nor the account. An earlier match it could not
   * store only leaves the window incomplete: the view is answered all the same, and the next call
   * finds the window `pending` again and tries that match again.
   *
   * @param matchId - The match.
   * @returns The view, see {@link AnalysisService.analyseMatch}.
   * @throws AppError of kind `storage` when the database fails, when the file of the archive cannot
   *   be read or the compressor is broken, or when the projection did not store the match.
   */
  async #analyseInSection(matchId: MatchId): Promise<MatchAnalysisView> {
    let subject = await analysisSubjectOf(this.#subjectDeps, matchId, 'window');
    if (subject.kind === 'pending') {
      await this.#projection.projectMatch(subject.accountId, matchId);
      // The window is not looked at again: an earlier match the projection keeps skipping would
      // otherwise fail the analysis of a match that is projected, or answer `pending`, which the
      // page would ask for again.
      subject = await analysisSubjectOf(this.#subjectDeps, matchId, 'match');
      if (subject.kind === 'pending') {
        throw new AppError(
          'storage',
          'The match could not be analysed: its projection was not stored',
        );
      }
    }
    return this.#viewOf(matchId, subject);
  }

  /**
   * Build what the page shows from where a match stands: the state when there is nothing to
   * compare, otherwise the analysis, read from the archive, the projection, the habits, the rank and
   * the cache of the community data.
   *
   * @param matchId - The match.
   * @param subject - Where the match stands, from {@link analysisSubjectOf}.
   * @returns The view, see {@link AnalysisService.getMatchAnalysis}.
   * @throws AppError of kind `storage` when the database fails, or when the file of the archive
   *   cannot be read or the compressor is broken. Any other error is a bug.
   */
  async #viewOf(matchId: MatchId, subject: AnalysisSubject): Promise<MatchAnalysisView> {
    if (subject.kind !== 'projected') {
      return { kind: subject.kind };
    }
    const { accountId, projection } = subject;

    // The archive is the only heavy read: it comes before the others, which are no use without it.
    const archive = await this.#reader.readArchive(accountId, matchId);
    if (archive.kind === 'unreadable') {
      // The reader told why; the detail view of the match explains the archive.
      return { kind: 'not_analysed' };
    }
    let context: MatchContext;
    try {
      context = buildMatchContext(archive.envelope);
    } catch (error) {
      // Only a payload that lacks what the analysis expects is a verdict on the match. Any other
      // error is a bug, which must be seen as one.
      if (!isAppError(error) || error.kind !== 'invalid_payload') {
        throw error;
      }
      this.#reports.warn(matchId, 'Match could not be analysed', { issue: issueOf(error) });
      return { kind: 'failed' };
    }

    if (context.durationS !== projection.durationS) {
      // The view leaves out what a different window would make wrong; the line is the evidence of
      // how often the two lengths really differ.
      this.#reports.warn(matchId, 'Match lengths disagree');
    }

    const [values, previous, rank] = await Promise.all([
      this.#metrics.getValues(accountId, matchId),
      this.#metrics.listPrevious(accountId, matchId, PROJECTION_VERSION, PREVIOUS_LOOKUP),
      this.#accounts.getRank(accountId),
    ]);
    const cohortRead = await this.#benchmarks.read(cohortOf(projection, rank));
    return {
      kind: 'ready',
      analysis: buildAnalysis({ projection, context, values, previous, cohortRead }),
    };
  }
}

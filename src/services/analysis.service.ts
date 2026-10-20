/**
 * The match analysis: what the match page shows when it compares one match with the community and
 * with the player's own habits.
 *
 * The numbers come from three places, all prepared before the page opens. The values of the 24
 * metrics of a match, and the habits (the values of the earlier matches), are the projection kept in
 * the database (`./projection.service`, `./metrics.repository`). The community data (the percentiles
 * of the metrics and the average course of a match, for a rank and a match length) is the cache of
 * `./benchmark.service`. The phase table is the only part read from the archive of the match
 * (`./archive-reader.service`): the totals of the souls, the damage and the kills in each phase, and
 * their share of the team. This service reads all of it; the comparisons and the view types are in
 * `./analysis-view`, a pure module.
 *
 * What a page can be told about a match (`MatchAnalysisView`):
 * - `not_analysed`: there is nothing to analyse. No account is linked, or the detail of the match is
 *   not archived, or its archive cannot be read (the detail view explains the archive);
 * - `pending`: the match is archived but the projection has not run on it yet, or ran with an older
 *   version of the metrics. The next synchronisation does it;
 * - `failed`: the analysis cannot read the match, since its archive lacks what the analysis needs;
 * - `ready`: the analysis, see `MatchAnalysis`.
 *
 * A match is compared with the rank the player had in it (a ranked match), or with the rank the
 * player has now (an unranked match), or with every rank when there is neither, over matches of
 * about the same length. Everything the community cannot tell (nothing cached, a cohort too small,
 * a metric the community has no reference for) is told in the view and never replaced by a number,
 * so that the page can say "no comparison" instead of a wrong one. A page opening asks for the
 * community data with {@link AnalysisService.refreshCommunity}, then reads the analysis again.
 *
 * Nothing is logged on the normal path. The one line written here, for a match whose archive no
 * longer holds what the analysis needs, carries the match and the field path and the issue code of
 * the payload; never an account id or a value.
 *
 * @packageDocumentation
 */
import { cohortRankFor, durationWindowOf, type Cohort } from '../core/analysis/cohort';
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import { buildMatchContext, type MatchContext } from '../core/analysis/match-context';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { isAppError, type AppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import { buildAnalysis, type MatchAnalysisView } from './analysis-view';
import type { ArchiveReaderService } from './archive-reader.service';
import type { BenchmarkService, CohortRefresh } from './benchmark.service';
import type { LinkedAccountRank, LinkedAccountRepository } from './linked-account.repository';
import type { MatchDetailRepository } from './match-detail.repository';
import type { MetricsRepository, StoredProjection } from './metrics.repository';

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
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * What a match is before anything is read for its analysis: a state that says there is nothing to
 * compare yet (the kinds of {@link MatchAnalysisView} that are not `ready`), or the account and the
 * projection to go on from.
 */
type Subject =
  | { readonly kind: 'not_analysed' | 'pending' | 'failed' }
  | {
      readonly kind: 'projected';
      readonly accountId: AccountId;
      readonly projection: StoredProjection;
    };

/** The scope of the log line of this service. */
const LOG_SCOPE = 'analysis';

/**
 * How many earlier matches are read to find the habits of the player: five times
 * {@link PERSONAL_WINDOW}. The habits of a metric are its {@link PERSONAL_WINDOW} most recent known
 * values, and a metric is often unknown (the late game of a short match, the lane of a player the
 * archive gives none), so reading only the last 20 matches would leave such a metric with too few
 * values to compare with.
 */
const PREVIOUS_LOOKUP = 5 * PERSONAL_WINDOW;

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
  readonly #accountSource: AccountSource;
  readonly #metrics: MetricsRepository;
  readonly #details: MatchDetailRepository;
  readonly #reader: ArchiveReaderService;
  readonly #benchmarks: BenchmarkService;
  readonly #accounts: LinkedAccountRepository;
  readonly #logger: Logger;

  /**
   * The matches already reported as unanalysable. Such a match stays so until it is projected
   * again, and the page reads its analysis every time it is shown: it is reported once, not at
   * every read.
   */
  readonly #reportedMatches = new Set<MatchId>();

  /**
   * @param dependencies - See {@link AnalysisServiceDependencies}.
   */
  constructor(dependencies: AnalysisServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#metrics = dependencies.metrics;
    this.#details = dependencies.details;
    this.#reader = dependencies.reader;
    this.#benchmarks = dependencies.benchmarks;
    this.#accounts = dependencies.accounts;
    this.#logger = dependencies.logger;
  }

  /**
   * Analyse a match of the linked account: compare each of its metrics with the community data in
   * the cache and with the habits of the player, pick the strengths and the weaknesses, and add the
   * phase table. Nothing is downloaded: the page asks for the community data with
   * {@link AnalysisService.refreshCommunity}.
   *
   * @param matchId - The match.
   * @returns What the page shows, see {@link MatchAnalysisView}. A match that is not archived, or
   *   whose archive is absent or damaged, is `not_analysed`; one without a projection of the
   *   current version is `pending`; one the analysis cannot read is `failed`.
   * @throws AppError of kind `storage` when the database fails, or when the file of the archive
   *   cannot be read or the compressor is broken (neither says anything about the match). Any other
   *   error is a bug and is not hidden behind a state.
   */
  async getMatchAnalysis(matchId: MatchId): Promise<MatchAnalysisView> {
    const subject = await this.#subjectOf(matchId);
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
      this.#reportUnanalysable(matchId, error);
      return { kind: 'failed' };
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

  /**
   * Download the community data a match is compared with, unless the cache holds it still fresh. A
   * page calls it when it opens, then reads the analysis again; one download serves every match of
   * the same rank and length for a day.
   *
   * @param matchId - The match.
   * @returns `fresh` when nothing was requested: the cached data is less than a day old, or there is
   *   nothing to compare (no account, a match whose detail is not archived, no projection of the
   *   current version for the match, or a projection that failed). `updated` when new data was
   *   downloaded and stored, `unavailable` when it could not be (the cached data, if any, stays as
   *   it was).
   * @throws AppError of kind `storage` when the database fails. The download itself never rejects.
   */
  async refreshCommunity(matchId: MatchId): Promise<CohortRefresh> {
    const subject = await this.#subjectOf(matchId);
    if (subject.kind !== 'projected') {
      return 'fresh';
    }
    const { accountId, projection } = subject;
    const rank = await this.#accounts.getRank(accountId);
    return this.#benchmarks.refresh(accountId, cohortOf(projection, rank));
  }

  /**
   * Find where a match stands before anything heavy is read for it: the one gate that
   * {@link AnalysisService.getMatchAnalysis} and {@link AnalysisService.refreshCommunity} share, so
   * that a match is downloaded community data for only when it can be analysed.
   *
   * @param matchId - The match.
   * @returns `not_analysed` without an account or for a match whose detail is not archived;
   *   `pending` without a projection of the current version; `failed` for a projection that could
   *   not read the match; the account and the projection otherwise.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #subjectOf(matchId: MatchId): Promise<Subject> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { kind: 'not_analysed' };
    }
    const detail = await this.#details.getDetail(accountId, matchId);
    if (detail?.status !== 'ready') {
      return { kind: 'not_analysed' };
    }
    const projection = await this.#metrics.getProjection(accountId, matchId);
    if (projection?.version !== PROJECTION_VERSION) {
      return { kind: 'pending' };
    }
    return projection.failed ? { kind: 'failed' } : { kind: 'projected', accountId, projection };
  }

  /**
   * Log, once per match, that the archive of a match no longer holds what the analysis needs. The
   * line holds the match and the field path and the issue code of the payload, never a value of it.
   *
   * @param matchId - The match.
   * @param error - The `invalid_payload` error of the match context.
   */
  #reportUnanalysable(matchId: MatchId, error: AppError): void {
    if (this.#reportedMatches.has(matchId)) {
      return;
    }
    this.#reportedMatches.add(matchId);
    const { issue } = error.context;
    this.#logger.log('warn', LOG_SCOPE, 'Match could not be analysed', {
      matchId,
      issue: typeof issue === 'string' ? issue : 'unknown',
    });
  }
}

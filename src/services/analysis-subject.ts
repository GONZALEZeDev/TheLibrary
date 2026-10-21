/**
 * Where a match stands before anything heavy is read for it: the one gate every view of the analysis
 * of a match shares.
 *
 * The analysis of a match (`./analysis.service`) and the damage view (`./match-breakdown.service`)
 * both start from the projection kept in the database, and both must tell the same states the same
 * way: nothing to analyse yet (`not_analysed`), projection still to run (`pending`), projection that
 * could not read the match (`failed`), or the account and the projection to go on from
 * (`projected`). {@link analysisSubjectOf} is that decision, so that the two cannot drift apart. It
 * reads the database only: no archive, no download, no write.
 *
 * @packageDocumentation
 */
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import type { AccountSource } from '../ports/account-source.port';
import type { MatchDetailRepository } from './match-detail.repository';
import type { MetricsRepository, StoredProjection } from './metrics.repository';

/**
 * What a match is before anything is read for its analysis: a state that says there is nothing to
 * compare yet (the states of the view of an analysis that are not `ready`), or the account and the
 * projection to go on from. A `pending` match carries the account it is pending for, since that is
 * the account the projection is made for.
 */
export type AnalysisSubject =
  | { readonly kind: 'not_analysed' | 'failed' }
  | { readonly kind: 'pending'; readonly accountId: AccountId }
  | {
      readonly kind: 'projected';
      readonly accountId: AccountId;
      readonly projection: StoredProjection;
    };

/**
 * What {@link analysisSubjectOf} needs to find projected, with the current version of the metrics,
 * to call a match `projected` rather than `pending`:
 * - `match`: the match itself. It tells whether the analysis of a match that was just projected can
 *   be shown: it can, even when an earlier match of its window could not be projected;
 * - `window`: the match, and every earlier match of the window its habits are made of (the ones
 *   `MetricsRepository.listToProjectUpTo` lists). It tells a page whether to ask for the analysis:
 *   a match projected as part of the window of a later match has only the part of its own window
 *   that the two windows share.
 */
export type RequiredProjection = 'match' | 'window';

/** What {@link analysisSubjectOf} reads: the linked account, the archive state and the projection. */
export interface AnalysisSubjectDependencies {
  /** The linked account. A match is looked at for it only. */
  readonly accountSource: AccountSource;
  /** Where the detail state of the matches is kept: only an archived match can be analysed. */
  readonly details: MatchDetailRepository;
  /** Where the projections of the matches are kept. */
  readonly metrics: MetricsRepository;
}

/**
 * Find where a match stands before anything heavy is read for it: the one gate that
 * `AnalysisService.getMatchAnalysis`, `AnalysisService.analyseMatch` and
 * `AnalysisService.refreshCommunity` share, so that a match is projected, or downloaded community
 * data for, only when it can be analysed; and that the damage view shares with them, so that it
 * answers the same states the same way.
 *
 * The window is looked at last, for a match that is projected and not failed only: it costs the
 * two statements of `MetricsRepository.listToProjectUpTo`, and a failed match has no analysis
 * for habits to complete.
 *
 * @param deps - See {@link AnalysisSubjectDependencies}.
 * @param matchId - The match.
 * @param required - What has to be projected for the match not to be `pending`, see
 *   {@link RequiredProjection}.
 * @returns `not_analysed` without an account or for a match whose detail is not archived;
 *   `pending` (with the account it is pending for) without a projection of the current version,
 *   or, when `required` is `window`, while an earlier match of its window lacks one; `failed` for
 *   a projection that could not read the match; the account and the projection otherwise.
 * @throws AppError of kind `storage` when the database fails.
 */
export async function analysisSubjectOf(
  deps: AnalysisSubjectDependencies,
  matchId: MatchId,
  required: RequiredProjection,
): Promise<AnalysisSubject> {
  const accountId = await deps.accountSource.currentAccountId();
  if (accountId === null) {
    return { kind: 'not_analysed' };
  }
  const detail = await deps.details.getDetail(accountId, matchId);
  if (detail?.status !== 'ready') {
    return { kind: 'not_analysed' };
  }
  const projection = await deps.metrics.getProjection(accountId, matchId);
  if (projection?.version !== PROJECTION_VERSION) {
    return { kind: 'pending', accountId };
  }
  if (projection.failed) {
    return { kind: 'failed' };
  }
  if (required === 'window') {
    // The match itself is projected, so what is listed is the window: the earlier matches the
    // analysis of this match would project.
    const toProject = await deps.metrics.listToProjectUpTo(
      accountId,
      matchId,
      PROJECTION_VERSION,
      PERSONAL_WINDOW,
    );
    if (toProject.length > 0) {
      return { kind: 'pending', accountId };
    }
  }
  return { kind: 'projected', accountId, projection };
}

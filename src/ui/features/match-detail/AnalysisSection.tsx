/**
 * The analysis of a match on its page: what stood out in it, the phase table and the metrics by
 * family, each compared with the players of the same rank and with the habits of the player.
 *
 * The section reads the analysis from the local database (`useMatchAnalysis`), which is quick, and
 * shows it at once. The comparison with the community comes after: the page asks for the community
 * data when it opens (`useCommunityRefresh`), the analysis is read again when the data is in (or
 * when the cache already held it), and until then the line above the metrics says that the
 * comparison is loading. When the data cannot come (no network, a cohort too small, a refresh that
 * failed) that line says there is no comparison with the rank for now; the section never turns that
 * into an error, since the comparison with the habits stands by itself.
 *
 * What the section shows depends on the state of the analysis:
 * - `ready`: the summary, the phase table and the families, in a section whose title (hidden, for
 *   assistive technologies) heads them;
 * - `pending`: the match is archived and nobody has analysed it yet, or the earlier matches its
 *   habits are made of are not all analysed yet (the match was analysed as part of the habits of a
 *   later match). The section starts the analysis (`useAnalyseMatch`), once, and a dialog says that
 *   it is under way until the analysis is shown. If it fails, the dialog says so and offers to close;
 *   the page then keeps its facts and says that the match could not be analysed, and opening the
 *   page again tries again. If the service refuses it because the linked account is changing,
 *   nothing is reported: the section keeps the sentence of an analysis in progress, and starts the
 *   analysis again when the view is read again, which is what the account change does by resetting
 *   the queries;
 * - `failed`: a sentence saying so (the analysis lacks what it needs in the archive of the match);
 * - `not_analysed`: nothing, the detail of the match above already says why there is no analysis.
 *
 * The analysis runs once per opening of the page. A view read as `pending` after it has shown the
 * analysis means that the habits are still incomplete: an earlier match could not be analysed (its
 * file could not be read, say), or the synchronisation has archived one since. The section keeps
 * the analysis it showed, and the next opening of the page analyses the habits again. An account
 * change resets the queries, which leaves the section without a view for a moment: the section
 * then forgets the analysis it started and the one it showed, both of the account linked before, so
 * that a page left open analyses the match again for the account linked now when it needs to.
 *
 * @packageDocumentation
 */
import { LoaderCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../core/domain/match';
import { toAppError } from '../../../core/errors/app-error';
import type { CommunityState, MatchAnalysisView } from '../../../services/analysis-view';
import { BUTTON_CLASSES, DIALOG_ACTIONS_CLASS } from '../../components/button-styles';
import { Dialog } from '../../components/Dialog';
import { focusOnMount } from '../../components/focus-on-mount';
import { InsightSummary } from './InsightSummary';
import { MetricFamilies } from './MetricFamilies';
import { PhaseTable } from './PhaseTable';
import { useAnalyseMatch, useCommunityRefresh, useMatchAnalysis } from './use-match-analysis';

/** Props of {@link AnalysisSection}. */
export interface AnalysisSectionProps {
  /**
   * The match whose analysis the section shows. The page gives the section a `key` of the match, so
   * that what one match did to the section (a failed analysis, a dialog the player closed) is not
   * carried over to the next match.
   */
  readonly matchId: MatchId;
}

/** The view of a match whose analysis is there. */
type ReadyView = Extract<MatchAnalysisView, { kind: 'ready' }>;

/**
 * Tell whether the community data has to be asked for.
 *
 * It is when the match is not compared with a fresh cohort: the data was never downloaded
 * (`missing`), it could not be used (`unavailable`: asking again costs a read of the cache, and the
 * service downloads only when something is due), or it is a day old or more (`stale`).
 *
 * @param community - Where the comparison with the community stands.
 * @returns Whether to ask the service for the community data.
 */
function needsCommunityData(community: CommunityState): boolean {
  return community.kind !== 'available' || community.stale;
}

/**
 * The analysis of one match.
 *
 * @returns The analysis, or the sentence of an analysis that is not there (yet) with the dialog of
 *   the analysis that runs, or nothing for a match there is nothing to analyse in.
 */
export function AnalysisSection({ matchId }: AnalysisSectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const analysis = useMatchAnalysis(matchId);
  const read = analysis.data;
  const analyse = useAnalyseMatch(matchId);
  const { mutate: startAnalysis } = analyse;

  // The last analysis read, which the section keeps over a later read that says `pending` (see
  // `view`). It is a value derived from the earlier renders, so it is kept the way React keeps one:
  // in a state set during the render, when the read changes. A read with no view is a reset of the
  // queries, which an account change does: the analysis belonged to the account linked before.
  const [lastAnalysis, setLastAnalysis] = useState<ReadyView | null>(null);
  if (read?.kind === 'ready' && read !== lastAnalysis) {
    setLastAnalysis(read);
  } else if (read === undefined && lastAnalysis !== null) {
    setLastAnalysis(null);
  }
  // What the section shows: what was read, except a `pending` read once the analysis of this
  // opening has answered with the analysis. Its habits are still incomplete then (an earlier match
  // could not be analysed, or one was archived since), which only the next opening analyses again:
  // the section keeps the analysis instead of the sentence of an analysis in progress that would
  // never end, since this opening does not start the analysis again.
  const view =
    read?.kind === 'pending' && analyse.data?.kind === 'ready' && lastAnalysis !== null
      ? lastAnalysis
      : read;

  // The data is asked for only once there is an analysis to compare: for any other state the
  // service would download nothing anyway.
  const community = view?.kind === 'ready' ? view.analysis.community : null;
  const refresh = useCommunityRefresh(matchId, community !== null && needsCommunityData(community));

  // The match the analysis was started for, so that a re-render, or a failure, never starts it
  // again: only a new opening of the page does (the section is mounted again), or the view of the
  // account linked after an account change. The service would answer a second call with the run in
  // progress, but nothing is gained by asking.
  const startedFor = useRef<MatchId | null>(null);
  // Whether the player closed the dialog that says the analysis failed. The failure itself stays in
  // the mutation: the sentence under the facts keeps saying it.
  const [failureClosed, setFailureClosed] = useState(false);

  // What was read decides, not what is shown: a read that says `pending` under a kept analysis
  // finds `startedFor` set, and starts nothing.
  const hasRead = read !== undefined;
  const needsAnalysis = read?.kind === 'pending';
  // The moment the view was last read. It is a dependency of the effect for the one case where the
  // effect has to run again for a view that did not change: the analysis was refused while the
  // account changed (`startedFor` was cleared then), and the view, read again after the change, is
  // `pending` still. Reads that follow a start leave `startedFor` set, and start nothing.
  const readAt = analysis.dataUpdatedAt;
  useEffect(() => {
    if (!hasRead) {
      // No view: the queries were reset, which an account change does (see `resetAccountData`).
      // What was started was for the account linked before. The view read next is the one of the
      // account linked now, and if it is `pending`, the analysis starts again.
      startedFor.current = null;
      return;
    }
    if (!needsAnalysis || startedFor.current === matchId) {
      return;
    }
    startedFor.current = matchId;
    startAnalysis(undefined, {
      onSuccess: (analysed) => {
        // `null` is the refusal of an account change, not an analysis: the view is read again after
        // the change, and if it is still `pending` then, the analysis is to start again.
        if (analysed === null) {
          startedFor.current = null;
        }
      },
    });
  }, [hasRead, needsAnalysis, readAt, matchId, startAnalysis]);

  if (view === undefined) {
    // While the analysis is read (from the local database, so in a blink) nothing is shown. A failed
    // refresh keeps the view already shown: the error only replaces an empty section.
    return analysis.isError ? (
      <p role="alert" className="text-sm text-loss">
        {t(`errors.kind.${toAppError(analysis.error).kind}`)}
      </p>
    ) : null;
  }
  switch (view.kind) {
    case 'not_analysed':
      return null;
    case 'pending': {
      const failed = analyse.isError;
      return (
        <>
          {/* One live region whose text changes with the analysis, so that a screen reader says that
              it failed even when the dialog that said it is gone (the browser closes a dialog by
              itself on a second Escape in a row, without the page being asked). */}
          <p role="status" className="text-sm text-fg-muted">
            {t(failed ? 'analysis.failed' : 'analysis.pending')}
          </p>
          {/* Escape and the close button end the dialog of a failure. The one of a running analysis
              ignores them: the analysis cannot be given up, and ends by itself. */}
          <Dialog
            open={analyse.isPending || (failed && !failureClosed)}
            title={t('analysis.analysing.title')}
            onClose={() => {
              if (failed) {
                setFailureClosed(true);
              }
            }}
          >
            {failed ? (
              <>
                <p role="alert" className="text-sm">
                  {t('analysis.analysing.failed')}
                </p>
                <div className={DIALOG_ACTIONS_CLASS}>
                  {/* The button appears in place of the text of the analysis that ran: the focus
                      goes to it, or the keyboard would have nothing to reach. */}
                  <button
                    type="button"
                    ref={focusOnMount}
                    onClick={() => {
                      setFailureClosed(true);
                    }}
                    className={BUTTON_CLASSES.subtle}
                  >
                    {t('analysis.analysing.close')}
                  </button>
                </div>
              </>
            ) : (
              <p role="status" className="flex items-start gap-3 text-sm">
                <LoaderCircle
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 animate-spin text-accent-bright"
                />
                {t('analysis.analysing.body')}
              </p>
            )}
          </Dialog>
        </>
      );
    }
    case 'failed':
      return <p className="text-sm text-fg-muted">{t('analysis.failed')}</p>;
    case 'ready':
      return (
        <section aria-labelledby={titleId}>
          {/* The title sits between the title of the page and the titles of the families, so that
              the headings go down one level at a time. It is for assistive technologies: the
              layouts show nothing above the summary, and the phase table has its own caption. */}
          <h2 id={titleId} className="sr-only">
            {t('analysis.title')}
          </h2>
          <div className="space-y-6">
            <InsightSummary
              strengths={view.analysis.strengths}
              weaknesses={view.analysis.weaknesses}
            />
            <PhaseTable phases={view.analysis.phases} />
            <MetricFamilies
              families={view.analysis.families}
              community={view.analysis.community}
              // A download under way makes the missing comparisons "loading", when the data was
              // never downloaded: a cohort that is known to be too small is not coming. A refresh
              // that failed is no longer fetching: the line says there is no comparison for now.
              communityLoading={view.analysis.community.kind === 'missing' && refresh.isFetching}
            />
          </div>
        </section>
      );
  }
}

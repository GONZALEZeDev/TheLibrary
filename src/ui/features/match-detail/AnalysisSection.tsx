/**
 * The analysis of a match on its page, in the analysis tab: what stood out in it, the phase table and
 * the metrics by family, each compared with the players of the same rank and with the habits of the
 * player.
 *
 * The section reads the analysis from the local database (`useMatchAnalysis`), which is quick, and
 * shows it at once. The comparison with the community comes after: the section asks for the community
 * data when it shows the analysis (`useCommunityRefresh`), the analysis is read again when the data is
 * in (or when the cache already held it), and until then the line above the metrics says that the
 * comparison is loading. When the data cannot come (no network, a cohort too small, a refresh that
 * failed) that line says there is no comparison with the rank for now; the section never turns that
 * into an error, since the comparison with the habits stands by itself.
 *
 * What the section shows depends on the state of the analysis:
 * - `ready`: the summary, the phase table and the families, in a section whose title (hidden, for
 *   assistive technologies) heads them;
 * - `pending`: nothing. The match waits for its analysis, which the page runs above the tabs
 *   (`AnalysisRun`), with the sentence and the dialog that say how it goes;
 * - `failed`: a sentence saying so (the analysis lacks what it needs in the archive of the match);
 * - `not_analysed`: nothing, the detail of the match above already says why there is no analysis.
 *
 * A view read as `pending` after the run of the page has answered with the analysis means that the
 * habits are still incomplete: an earlier match could not be analysed (its file could not be read,
 * say), or the synchronisation has archived one since. The section shows the last analysis read
 * during this opening of the page, which the run keeps for it (even while another tab is open), and
 * the next opening of the page analyses the habits again. An account change resets the queries, and
 * the run forgets that analysis, of the account linked before.
 *
 * @packageDocumentation
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../core/domain/match';
import type { CommunityState } from '../../../services/community-placement';
import { StatusLine } from '../../components/StatusLine';
import { useAnalysisRun } from './AnalysisRun';
import { InsightSummary } from './InsightSummary';
import { MetricFamilies } from './MetricFamilies';
import { PhaseTable } from './PhaseTable';
import { useCommunityRefresh, useMatchAnalysis } from './use-match-analysis';

/** Props of {@link AnalysisSection}. */
export interface AnalysisSectionProps {
  /**
   * The match whose analysis the section shows. The section sits under the run of the analysis of
   * the page (`AnalysisRun`), which the page keys by the match: moving from one match to another
   * mounts both again, without what they kept of the first one.
   */
  readonly matchId: MatchId;
}

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
 * @returns The analysis, or the sentence of an analysis that cannot be made, or nothing for a match
 *   that waits for its analysis or has nothing to analyse in.
 */
export function AnalysisSection({ matchId }: AnalysisSectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const analysis = useMatchAnalysis(matchId);
  const read = analysis.data;
  // The last analysis read is kept by the run of the page, which outlives this section: the section
  // is unmounted while another tab is open.
  const { analysedReady, lastAnalysis } = useAnalysisRun();
  // What the section shows: what was read, except a `pending` read once the run of this opening has
  // answered with the analysis. Its habits are still incomplete then (an earlier match could not be
  // analysed, or one was archived since), which only the next opening analyses again: the section
  // shows the last analysis read instead of an analysis to wait for that would never come, since this
  // opening does not start the analysis again. The run says nothing above the tabs then.
  const view =
    read?.kind === 'pending' && analysedReady && lastAnalysis !== null ? lastAnalysis : read;

  // The data is asked for only once there is an analysis to compare: for any other state the
  // service would download nothing anyway.
  const community = view?.kind === 'ready' ? view.analysis.community : null;
  const refresh = useCommunityRefresh(matchId, community !== null && needsCommunityData(community));

  if (view === undefined) {
    // While the analysis is read (from the local database, so in a blink) nothing is shown. A failed
    // refresh keeps the view already shown: the error only replaces an empty section.
    return analysis.isError ? <StatusLine kind="error" error={analysis.error} /> : null;
  }
  switch (view.kind) {
    case 'not_analysed':
      return null;
    case 'pending':
      // The run above the tabs says that the analysis is under way, or that it failed.
      return null;
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

/**
 * The run of the analysis of a match on its page, above the tabs, and where it stands for the tabs.
 *
 * Every archived match is analysed after each synchronisation, so the page usually finds the analysis
 * made. A match whose analysis is still `pending` is analysed when its page opens, as a fallback: the
 * match is archived and nobody has analysed it yet, or the earlier matches its habits are made of are
 * not all analysed yet (the match was analysed as part of the habits of a later match). The run
 * starts the analysis (`useAnalyseMatch`), once, whatever tab is open, and a dialog says that it is
 * under way until it ends; above the tabs, a sentence says that the analysis is in progress. If it
 * fails, the dialog says so and offers to close; the sentence then says that the match could not be
 * analysed, and opening the page again tries again. If the service refuses it because the linked
 * account is changing, nothing is reported: the sentence stays the one of an analysis in progress,
 * and the run starts the analysis again when the view is read again, which is what the account change
 * does by resetting the queries.
 *
 * The analysis runs once per opening of the page: the run lives in the page, not in a tab, so moving
 * from one tab to another neither starts it again nor loses what it knows. A view read as `pending`
 * after the run has answered with the analysis means that the habits are still incomplete: an earlier
 * match could not be analysed (its file could not be read, say), or the synchronisation has archived
 * one since. The run does not start again and says nothing of it: it keeps the last analysis read,
 * which the analysis tab shows instead (see `AnalysisSection`), even after the player has been to
 * another tab, and the next opening of the page analyses the habits again. An account change resets
 * the queries, which leaves the run without a view for a moment: it then forgets the analysis it
 * started and the one it kept, both of the account linked before, so that a page left open analyses
 * the match again for the account linked now when it needs to.
 *
 * The tabs read where the run stands with {@link useAnalysisRun}.
 *
 * @packageDocumentation
 */
import { LoaderCircle } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../core/domain/match';
import type { MatchAnalysisView } from '../../../services/analysis-view';
import { Button } from '../../components/Button';
import { DIALOG_ACTIONS_CLASS } from '../../components/button-styles';
import { Dialog } from '../../components/Dialog';
import { focusOnMount } from '../../components/focus-on-mount';
import { useAnalyseMatch, useMatchAnalysis } from './use-match-analysis';

/** The view of a match whose analysis is there. */
type ReadyView = Extract<MatchAnalysisView, { kind: 'ready' }>;

/** Where the run of the analysis of the page stands, as the tabs under it read it. */
export interface AnalysisRunState {
  /**
   * Whether the run of this opening of the page answered with the analysis (`ready`). A view read as
   * `pending` after that is a window of habits still incomplete, not an analysis to wait for.
   */
  readonly analysedReady: boolean;
  /**
   * The last analysis read during this opening of the page: `null` before the first one, and after
   * an account change. Once the run has answered with the analysis, the analysis tab shows it over a
   * later read that says `pending`. The run keeps it, and not the tab, which is unmounted while
   * another tab is open.
   */
  readonly lastAnalysis: ReadyView | null;
}

/** Where the run of the page stands; `null` outside an {@link AnalysisRun}. */
const AnalysisRunContext = createContext<AnalysisRunState | null>(null);

/** Props of {@link AnalysisRun}. */
export interface AnalysisRunProps {
  /**
   * The match whose analysis runs. The page gives the run a `key` of the match, so that what one
   * match did to the run (a failed analysis, a dialog the player closed) is not carried over to the
   * next match.
   */
  readonly matchId: MatchId;
  /** The tabs of the match, under the sentence of the run. */
  readonly children: ReactNode;
}

/**
 * The run of the analysis of one match, around the tabs of its page.
 *
 * @returns The sentence and the dialog of an analysis that is not there yet, if it is not, above the
 *   tabs, which can read where the run stands.
 */
export function AnalysisRun({ matchId, children }: AnalysisRunProps) {
  const { t } = useTranslation();
  const analysis = useMatchAnalysis(matchId);
  const read = analysis.data;
  const analyse = useAnalyseMatch(matchId);
  const { mutate: startAnalysis } = analyse;

  // The last analysis read, which the analysis tab shows over a later read that says `pending` (see
  // `AnalysisSection`). It is a value derived from the earlier renders, so it is kept the way React
  // keeps one: in a state set during the render, when the read changes. A read with no view is a
  // reset of the queries, which an account change does: the analysis belonged to the account linked
  // before.
  const [lastAnalysis, setLastAnalysis] = useState<ReadyView | null>(null);
  if (read?.kind === 'ready' && read !== lastAnalysis) {
    setLastAnalysis(read);
  } else if (read === undefined && lastAnalysis !== null) {
    setLastAnalysis(null);
  }

  // The match the analysis was started for, so that a re-render, or a failure, never starts it
  // again: only a new opening of the page does (the run is mounted again), or the view of the
  // account linked after an account change. The service would answer a second call with the run in
  // progress, but nothing is gained by asking.
  const startedFor = useRef<MatchId | null>(null);
  // Whether the player closed the dialog that says the analysis failed. The failure itself stays in
  // the mutation: the sentence above the tabs keeps saying it.
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

  const analysedReady = analyse.data?.kind === 'ready';
  const failed = analyse.isError;
  // One object per state of the run, so that the tabs that read it render again only when it changes.
  // A failed run is not in it: the sentence above the tabs says it, and each tab reads the failure of
  // its own view.
  const state = useMemo(() => ({ analysedReady, lastAnalysis }), [analysedReady, lastAnalysis]);
  // The sentence and the dialog are for an analysis still to come: a `pending` read, except once the
  // run of this opening has answered with the analysis and the analysis tab shows the last one read
  // instead (the rule of `AnalysisSection`). The habits are still incomplete then, which only the next
  // opening analyses again: a sentence of an analysis in progress would never end, since the run does
  // not start the analysis again.
  const waiting = needsAnalysis && !(analysedReady && lastAnalysis !== null);

  return (
    <AnalysisRunContext value={state}>
      <div className="space-y-6">
        {waiting && (
          // One live region whose text changes with the analysis, so that a screen reader says that
          // it failed even when the dialog that said it is gone (the browser closes a dialog by itself
          // on a second Escape in a row, without the page being asked).
          <p role="status" className="text-sm text-fg-muted">
            {t(failed ? 'analysis.failed' : 'analysis.pending')}
          </p>
        )}
        {children}
      </div>
      {waiting && (
        // Escape and the close button end the dialog of a failure. The one of a running analysis
        // ignores them: the analysis cannot be given up, and ends by itself.
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
                {/* The button appears in place of the text of the analysis that ran: the focus goes
                    to it, or the keyboard would have nothing to reach. */}
                <Button
                  look="subtle"
                  ref={focusOnMount}
                  onClick={() => {
                    setFailureClosed(true);
                  }}
                >
                  {t('analysis.analysing.close')}
                </Button>
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
      )}
    </AnalysisRunContext>
  );
}

/**
 * Read where the run of the analysis of the page stands.
 *
 * @returns Whether the run of this opening answered with the analysis, and the last analysis read
 *   during this opening (see {@link AnalysisRunState}).
 * @throws Error when called outside an {@link AnalysisRun} (a programming error: the tabs of a match
 *   are always rendered inside its run).
 */
export function useAnalysisRun(): AnalysisRunState {
  const state = useContext(AnalysisRunContext);
  if (state === null) {
    throw new Error('useAnalysisRun() must be used inside <AnalysisRun>');
  }
  return state;
}

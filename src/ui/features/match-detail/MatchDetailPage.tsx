/**
 * Match detail screen: the match in a header, then its tabs, or why there is no detail.
 *
 * Every match the history holds has a header under the title (`MatchHeader`: the hero, the date, the
 * type, the result, the duration, the K/D/A and the souls), read from its row of the history, so it
 * is the same whatever the state of the detail. It is part of the title block of the page, close
 * under the title it describes. A match with no row has no header.
 *
 * An archived match then shows four tabs, and only the open one is built:
 * - the analysis (`AnalysisSection`): the strengths and weaknesses, the phase table and the metrics
 *   by family, then one line about the archive of the match;
 * - the timeline (`TimelineTab`): the souls of the player over the match with their deaths, kills and
 *   purchases, and the list of their deaths, with the ones that were avoidable;
 * - the damage and build (`DamageTab`): the damage by source compared with the player's habits, and
 *   the final build;
 * - the players (`PlayersTab`): the twelve players of the match and the player's places among them.
 *
 * The open tab is kept in the address of the page (`?tab=`): the analysis when the address names no
 * tab, or one the page does not have. Opening another tab replaces the address instead of adding one
 * to the history, so that going back leaves the match rather than walking back through its tabs.
 *
 * Any other match says why it has no archive, and has no tabs: the app does not archive it, it waits
 * for its first or its next attempt, deadlock-api could not give its detail, the detail cannot be
 * read, or the archive file is gone (the match is then downloaded again, or, past the 90 days,
 * never). An archive file removed to free space is the same: inside the 90 days the page starts the
 * download itself when it opens, with no button. A match that failed for good has a "Retry"
 * button. A failure to read the archive file or to decompress it is not an explanation of the match
 * but an error of the page, shown like any other.
 *
 * Every archived match is analysed after each synchronisation, so the page usually finds the analysis
 * made. A match still not analysed (opened before the end of the synchronisation that archived it, or
 * after a new version of the metrics) is analysed when its page opens, as a fallback, whatever tab is
 * open: the run (`AnalysisRun`) sits above the tabs, with the sentence and the dialog that say how it
 * goes, and the damage tab, which has nothing to show until the analysis is stored, is read again
 * when it is.
 *
 * Above the title of every state of the page is a link back to the match list.
 *
 * @packageDocumentation
 */
import { getRouteApi, Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { ArrowLeft, RotateCw, UserRound } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../core/domain/match';
import type { ArchiveFacts } from '../../../core/match-detail/archive-facts';
import type { MatchDetailView } from '../../../services/match-detail.service';
import type { MatchTab } from '../../app/router';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { StatusLine } from '../../components/StatusLine';
import { Tabs } from '../../components/Tabs';
import { formatShortDateTimeMs } from '../../format/date';
import { LinkAccountButton } from '../account/LinkAccountButton';
import {
  useHeroAssets,
  useMatchSummary,
  useRefreshOnSync,
  useSyncRunning,
} from '../matches/use-matches';
import { AnalysisRun } from './AnalysisRun';
import { AnalysisSection } from './AnalysisSection';
import { DamageTab } from './DamageTab';
import { MatchHeader } from './MatchHeader';
import { PlayersTab } from './PlayersTab';
import { TimelineTab } from './TimelineTab';
import { useMatchDetail, useRetryDetail } from './use-match-detail';

/**
 * Typed access to the parameters and the search parameters of the `/matches/$matchId` route (see
 * `ui/app/router.ts`).
 */
const matchDetailRoute = getRouteApi('/matches/$matchId');

/** The view of an archived match, the one that has tabs. */
type ReadyView = Extract<MatchDetailView, { kind: 'ready' }>;

/**
 * Translation key of the name of each tab of an archived match, in display order: the analysis, the
 * timeline, the damage and build, the players. The `satisfies` clause makes the compiler reject this
 * table as soon as a tab is added to {@link MatchTab} without a name here, or a name is given to a
 * tab that does not exist. (The router validates the `tab` of the address against the same ids; this
 * page does not read them from `router.ts`, which imports the page.)
 */
const TAB_LABEL_KEYS = {
  analysis: 'matchDetail.tabs.analysis',
  timeline: 'matchDetail.tabs.timeline',
  damage: 'matchDetail.tabs.damage',
  players: 'matchDetail.tabs.players',
} as const satisfies Readonly<Record<MatchTab, string>>;

/**
 * The tabs of an archived match, in display order: the keys of {@link TAB_LABEL_KEYS}, which are
 * exactly the tabs (its `satisfies` clause), in the order they are written there.
 */
const TAB_IDS = Object.keys(TAB_LABEL_KEYS) as readonly MatchTab[];

/** The tabs of an archived match: the one open, and how to open another. */
interface TabsControl {
  /** The tab open, from the address of the page. */
  readonly selected: MatchTab;
  /** Opens a tab, by writing it in the address of the page. */
  readonly onSelect: (tab: MatchTab) => void;
}

/** How the page writes dates and sizes, in the language of the interface. */
interface Formatters {
  /** Writes a Unix ms time as a short date and short time, like the match list and the banner. */
  readonly dateTime: (time: number) => string;
  /** Sizes in kilobytes, with one decimal at most. */
  readonly kilobytes: Intl.NumberFormat;
}

/** The "Retry" button of a match whose detail failed. */
interface RetryAction {
  /** Whether the button cannot be used now: a synchronisation is running, or the retry is. */
  readonly disabled: boolean;
  /** Called when the button is clicked. */
  readonly onRetry: () => void;
}

/**
 * The "Retry" button, drawn with the same look as the "Sync now" button of the matches page. Its
 * icon turns while the button is disabled, that is while a synchronisation or the retry runs.
 *
 * @param t - Translation function.
 * @param retry - What the button does and whether it can be used.
 * @returns The button.
 */
function renderRetryButton(t: TFunction, retry: RetryAction) {
  return (
    <Button
      look="subtle"
      icon={RotateCw}
      spinning={retry.disabled}
      onClick={retry.onRetry}
      disabled={retry.disabled}
    >
      {t('matchDetail.retry')}
    </Button>
  );
}

/**
 * The link back to the match list, above the title of the page.
 *
 * It goes to the list as the sidebar does: the router keeps no search parameters of the list to go
 * back to, and the list does not use its filters yet (see `matchesSearchSchema`).
 *
 * @param t - Translation function.
 * @returns The link.
 */
function renderBackLink(t: TFunction) {
  return (
    <Link
      to="/matches"
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-accent-bright underline-offset-4 hover:underline"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t('matchDetail.back')}
    </Link>
  );
}

/**
 * A block saying why a match has no archive, and what can be done about it.
 *
 * @param sentences - What there is to say, in reading order.
 * @param action - What the player can do about it, if anything.
 * @returns The block.
 */
function renderExplanation(sentences: readonly string[], action?: ReactNode) {
  return (
    <Panel padding="normal" className="space-y-4 text-sm">
      <div className="space-y-1">
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
      {action}
    </Panel>
  );
}

/**
 * The line about the archive of a match: how many stat snapshots and items bought it holds, how
 * big the file is and when it was downloaded.
 *
 * @param facts - What the archive holds about the tracked player.
 * @param archivedBytes - Size of the archive file.
 * @param t - Translation function.
 * @param format - How to write dates and sizes.
 * @returns The line.
 */
function renderArchiveLine(
  facts: ArchiveFacts,
  archivedBytes: number,
  t: TFunction,
  format: Formatters,
) {
  return (
    <p className="text-sm text-fg-muted">
      {t('matchDetail.archiveLine', {
        snapshots: facts.snapshots,
        items: facts.itemsBought,
        size: format.kilobytes.format(archivedBytes / 1024),
        date: format.dateTime(facts.fetchedAt),
      })}
    </p>
  );
}

/**
 * The panel of the open tab of an archived match.
 *
 * @param tab - The open tab.
 * @param view - What the services say of the archived match.
 * @param matchId - The match.
 * @param t - Translation function.
 * @param format - How to write dates and sizes.
 * @returns The analysis then the archive line, the timeline, the damage and build, or the players.
 */
function renderTabPanel(
  tab: MatchTab,
  view: ReadyView,
  matchId: MatchId,
  t: TFunction,
  format: Formatters,
) {
  switch (tab) {
    case 'analysis':
      return (
        <div className="space-y-6">
          <AnalysisSection matchId={matchId} />
          {renderArchiveLine(view.facts, view.archivedBytes, t, format)}
        </div>
      );
    case 'timeline':
      return <TimelineTab matchId={matchId} />;
    case 'damage':
      return <DamageTab matchId={matchId} />;
    case 'players':
      return <PlayersTab matchId={matchId} />;
  }
}

/**
 * What the page shows of a match under its header, depending on what the services say of it.
 *
 * @param view - What the services say of the match.
 * @param matchId - The match.
 * @param t - Translation function.
 * @param format - How to write dates and sizes.
 * @param retry - The "Retry" button, shown for the matches that failed.
 * @param tabs - The tabs of an archived match: the open one, and how to open another.
 * @returns The tabs of an archived match under the run of its analysis, or the explanation of why
 *   there is no detail.
 */
function renderView(
  view: MatchDetailView,
  matchId: MatchId,
  t: TFunction,
  format: Formatters,
  retry: RetryAction,
  tabs: TabsControl,
) {
  switch (view.kind) {
    case 'ready':
      // The tabs, and the analysis that runs above them, are only for an archived match: the others
      // have nothing to analyse nor to break down. The run is keyed by the match, so that moving from
      // one match to another does not carry the state of the first one's analysis (a failure, a
      // dialog the player closed, the analysis the analysis tab keeps) over to the second.
      return (
        <AnalysisRun key={matchId} matchId={matchId}>
          <Tabs
            label={t('matchDetail.tabs.label')}
            tabs={TAB_IDS.map((id) => ({ id, label: t(TAB_LABEL_KEYS[id]) }))}
            selected={tabs.selected}
            onSelect={tabs.onSelect}
          >
            {renderTabPanel(tabs.selected, view, matchId, t, format)}
          </Tabs>
        </AnalysisRun>
      );
    case 'no_account':
      // Said like the matches page says it: there is no match without an account. The player can
      // link one from here, as from the matches page.
      return (
        <EmptyState
          icon={UserRound}
          title={t('matches.noAccount.title')}
          description={t('matches.noAccount.description')}
        >
          <LinkAccountButton />
        </EmptyState>
      );
    case 'not_eligible':
      return renderExplanation([t('matchDetail.notEligible')]);
    case 'waiting':
      // A match never tried has no date yet.
      return renderExplanation(
        view.nextAttemptAt === null
          ? [t('matchDetail.waiting')]
          : [
              t('matchDetail.waiting'),
              t('matchDetail.nextAttempt', { time: format.dateTime(view.nextAttemptAt) }),
            ],
      );
    case 'unavailable':
      return renderExplanation([t('matchDetail.unavailable')], renderRetryButton(t, retry));
    case 'invalid':
      return renderExplanation([t('matchDetail.invalid')], renderRetryButton(t, retry));
    case 'missing':
      return renderExplanation([t('matchDetail.missing')]);
    case 'lost':
      // Nothing to retry: the queue only downloads the matches of the last 90 days.
      return renderExplanation([t('matchDetail.lost')]);
    case 'evicted':
      // No button: the page starts the download itself (see `MatchDetailPage`).
      return renderExplanation([t('matchDetail.evicted')]);
    case 'evicted_lost':
      // Nothing to retry either: the match is past the 90 days the queue downloads.
      return renderExplanation([t('matchDetail.evictedLost')]);
  }
}

/**
 * Match detail screen.
 *
 * @returns The match detail page.
 */
export function MatchDetailPage() {
  const { t, i18n } = useTranslation();
  const { matchId } = matchDetailRoute.useParams();
  // The search parameters are validated by the route: `tab` is always one of the tabs.
  const { tab } = matchDetailRoute.useSearch();
  const navigate = matchDetailRoute.useNavigate();
  const detail = useMatchDetail(matchId);
  const retry = useRetryDetail(matchId);
  const viewKind = detail.data?.kind;
  // An evicted match (its archive file was removed to free space, and the match is inside the 90
  // days) was put back in the queue when the service read it, but nothing starts the queue for it:
  // the next scheduled synchronisation would take it, which can be a long wait for a page the player
  // is looking at. So the page starts the detail run of the match itself, with the same hook as the
  // "Retry" button, once per match: the ref stops a re-render, or the replayed effect of the strict
  // mode, from starting it again (the view turns `waiting` as soon as the match is read again).
  const downloadStartedFor = useRef<MatchId | null>(null);
  const { mutate: retryDownload } = retry;
  useEffect(() => {
    if (viewKind !== 'evicted' || downloadStartedFor.current === matchId) {
      return;
    }
    downloadStartedFor.current = matchId;
    retryDownload();
  }, [matchId, viewKind, retryDownload]);
  const syncRunning = useSyncRunning();
  // A synchronisation changes what the page shows (the queue archives a waiting match, a retry
  // changes the state of the match): the page reads the match again whenever one runs or advances.
  useRefreshOnSync();
  const format: Formatters = {
    dateTime: (time) => formatShortDateTimeMs(time, i18n.language),
    kilobytes: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
  };
  // The row of the match in the history: `null` is an answer (the account has no such match, or no
  // account is linked), `undefined` means the row is still being read. The header needs the row
  // alone, so it does not wait for the detail; and it does not wait for the hero catalogue either
  // (the hero is named by its id until the catalogue is there). The catalogue is only asked for
  // when there is a match to show a hero for: without a row, the page contacts nobody.
  const match = useMatchSummary(matchId).data ?? null;
  const heroes = useHeroAssets(match !== null);
  const hero =
    match === null ? undefined : heroes.data?.find((candidate) => candidate.id === match.heroId);

  let body: ReactNode = null;
  if (detail.data !== undefined) {
    // A failed refresh keeps the view already shown: the error only replaces an empty screen.
    body = renderView(
      detail.data,
      matchId,
      t,
      format,
      {
        // The queue is alone to download details, so a retry waits for the run in progress to end.
        disabled: syncRunning || retry.isPending,
        onRetry: () => {
          retry.mutate();
        },
      },
      {
        selected: tab,
        onSelect: (next) => {
          // `replace`: the tabs of a match are one entry of the history (see the header of this
          // file). The tabs never ask for the tab already open, so no navigation is for nothing.
          void navigate({
            to: '/matches/$matchId',
            params: { matchId },
            search: { tab: next },
            replace: true,
          });
        },
      },
    );
  } else if (detail.isError) {
    body = <StatusLine kind="error" error={detail.error} />;
  }
  // While the view is read (from the local database, so in a blink) only the title is shown.

  return (
    <>
      {renderBackLink(t)}
      {/* The facts of the match are the content of the title block: close under the title they
          describe, with the space of the block below them. */}
      <PageHeader title={t('matchDetail.title', { matchId })}>
        {match === null ? undefined : <MatchHeader match={match} hero={hero} />}
      </PageHeader>
      {body}
    </>
  );
}

/**
 * Match detail screen: the facts of the archived detail of a match, or why there is none.
 *
 * An archived match shows what its archive holds about the tracked player. Any other match says
 * why it has no archive: the app does not archive it, it waits for its first or its next attempt,
 * deadlock-api could not give its detail, the detail cannot be read, or the archive file is gone
 * (the match is then downloaded again, or, past the 90 days, never). A match that failed for good
 * has a "Retry" button. A failure to read the archive file or to decompress it is not an
 * explanation of the match but an error of the page, shown like any other.
 *
 * Milestone M2b ships the facts and the explanations; the timeline, strengths and weaknesses,
 * scoreboard and build order arrive in later milestones.
 *
 * @packageDocumentation
 */
import { getRouteApi } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { RotateCw, UserRound } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppError } from '../../../core/errors/app-error';
import type { ArchiveFacts } from '../../../core/match-detail/archive-facts';
import type { MatchDetailView } from '../../../services/match-detail.service';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { formatDuration } from '../matches/MatchesTable';
import { useRefreshOnSync, useSyncRunning } from '../matches/use-matches';
import { useMatchDetail, useRetryDetail } from './use-match-detail';

/** Typed access to the parameters of the `/matches/$matchId` route (see `ui/app/router.ts`). */
const matchDetailRoute = getRouteApi('/matches/$matchId');

/** How the page writes dates, counts and sizes, in the language of the interface. */
interface Formatters {
  /** Short date and short time, like the match list and the banner. */
  readonly dateTime: Intl.DateTimeFormat;
  /** Whole numbers, with the separators of the language. */
  readonly integer: Intl.NumberFormat;
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
 * The "Retry" button, looking like the "Sync now" button of the matches page.
 *
 * @param t - Translation function.
 * @param retry - What the button does and whether it can be used.
 * @returns The button.
 */
function renderRetryButton(t: TFunction, retry: RetryAction) {
  return (
    <button
      type="button"
      onClick={retry.onRetry}
      disabled={retry.disabled}
      className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-raised px-4 py-2 text-sm font-medium hover:border-accent-bright disabled:cursor-not-allowed disabled:opacity-60"
    >
      <RotateCw aria-hidden="true" className={retry.disabled ? 'size-4 animate-spin' : 'size-4'} />
      {t('matchDetail.retry')}
    </button>
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
    <section className="space-y-4 rounded-xl border border-border bg-surface p-4 text-sm">
      <div className="space-y-1">
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
      {action}
    </section>
  );
}

/**
 * The facts of an archived match, as a list of terms and definitions.
 *
 * @param facts - What the archive holds about the tracked player.
 * @param archivedBytes - Size of the archive file.
 * @param t - Translation function.
 * @param format - How to write dates, counts and sizes.
 * @returns The list.
 */
function renderFacts(facts: ArchiveFacts, archivedBytes: number, t: TFunction, format: Formatters) {
  // Each line is a term and its definition, in reading order. The result is also conveyed by its
  // word, never by its colour alone.
  const lines: readonly (readonly [label: string, value: ReactNode])[] = [
    [
      t('matchDetail.facts.result'),
      <span key="result" className={facts.won ? 'text-win' : 'text-loss'}>
        {facts.won ? t('matches.table.win') : t('matches.table.loss')}
      </span>,
    ],
    [t('matchDetail.facts.duration'), formatDuration(facts.durationS)],
    // Written like the K / D / A column of the match list.
    [
      t('matchDetail.facts.kda'),
      `${String(facts.kills)} / ${String(facts.deaths)} / ${String(facts.assists)}`,
    ],
    [t('matchDetail.facts.netWorth'), format.integer.format(facts.netWorth)],
    [t('matchDetail.facts.snapshots'), String(facts.snapshots)],
    [t('matchDetail.facts.items'), String(facts.itemsBought)],
    [
      t('matchDetail.facts.archive'),
      t('matchDetail.facts.archiveValue', {
        size: format.kilobytes.format(archivedBytes / 1024),
        date: format.dateTime.format(facts.fetchedAt),
      }),
    ],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-3 rounded-xl border border-border bg-surface p-4 text-sm">
      {lines.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-fg-muted">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * What the page shows of a match, depending on what the services say of it.
 *
 * @param view - What the services say of the match.
 * @param t - Translation function.
 * @param format - How to write dates, counts and sizes.
 * @param retry - The "Retry" button, shown for the matches that failed.
 * @returns The facts, or the explanation of why there are none.
 */
function renderView(view: MatchDetailView, t: TFunction, format: Formatters, retry: RetryAction) {
  switch (view.kind) {
    case 'ready':
      return renderFacts(view.facts, view.archivedBytes, t, format);
    case 'no_account':
      // Said like the matches page says it: there is no match without an account.
      return (
        <EmptyState
          icon={UserRound}
          title={t('matches.noAccount.title')}
          description={t('matches.noAccount.description')}
        />
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
              t('matchDetail.nextAttempt', { time: format.dateTime.format(view.nextAttemptAt) }),
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
  const detail = useMatchDetail(matchId);
  const retry = useRetryDetail(matchId);
  const syncRunning = useSyncRunning();
  // A synchronisation changes what the page shows (the queue archives a waiting match, a retry
  // changes the state of the match): the page reads the match again whenever one runs or advances.
  useRefreshOnSync();
  const format: Formatters = {
    dateTime: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }),
    integer: new Intl.NumberFormat(i18n.language),
    kilobytes: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
  };

  let body: ReactNode = null;
  if (detail.data !== undefined) {
    // A failed refresh keeps the view already shown: the error only replaces an empty screen.
    body = renderView(detail.data, t, format, {
      // The queue is alone to download details, so a retry waits for the run in progress to end.
      disabled: syncRunning || retry.isPending,
      onRetry: () => {
        retry.mutate();
      },
    });
  } else if (detail.isError) {
    body = (
      <p role="alert" className="text-sm text-loss">
        {t(`errors.kind.${toAppError(detail.error).kind}`)}
      </p>
    );
  }
  // While the view is read (from the local database, so in a blink) only the title is shown.

  return (
    <>
      <PageHeader title={t('matchDetail.title', { matchId })} />
      {body}
    </>
  );
}

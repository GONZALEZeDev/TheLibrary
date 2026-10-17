/**
 * Banner of the synchronisation, above the match list: when the history was last synchronised,
 * whether it is complete, why it is not up to date, how far the archive of the Paige match details
 * is, whether the detail queue is stuck on a local failure, and a button to synchronise now. While
 * it is shown, every synchronisation (started by the button, the schedule or the startup) refreshes
 * the status and the matches, and the progress of the detail queue refreshes the counts of the
 * details and the matches as it goes.
 *
 * Milestone M2a ships it as a plain banner; the screens milestone (M5) gives it its final design.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toAppError } from '../../../core/errors/app-error';
import type { SyncStatus } from '../../../core/sync/sync-status';
import type { DetailSummaryView } from '../../../services/match-detail.service';
import {
  useDetailSummary,
  useRefreshOnSync,
  useSyncNow,
  useSyncRunning,
  useSyncStatus,
} from './use-matches';

/**
 * Build the sentences describing a synchronisation status.
 *
 * @param status - The status.
 * @param t - Translation function.
 * @param formatTime - Formats a Unix ms time for display.
 * @returns The sentences, in reading order.
 */
function describeStatus(
  status: SyncStatus,
  t: TFunction,
  formatTime: (time: number) => string,
): string[] {
  if (!status.accountLinked) {
    return [t('matches.sync.noAccount')];
  }
  const { lastSync } = status;
  const sentences =
    lastSync === null
      ? [t('matches.sync.never')]
      : [t('matches.sync.lastSync', { time: formatTime(lastSync.finishedAt) })];
  if (lastSync?.outcome === 'synced' && lastSync.newMatches > 0) {
    sentences.push(t('matches.sync.newMatches', { number: lastSync.newMatches }));
  }
  if (lastSync?.outcome === 'failed' && lastSync.errorKind !== null) {
    sentences.push(t('matches.sync.failed', { reason: t(`errors.kind.${lastSync.errorKind}`) }));
  }
  if (lastSync?.outcome === 'budget_exhausted') {
    sentences.push(
      lastSync.historyFetchedAt === null
        ? t('matches.sync.budgetNever')
        : t('matches.sync.budget', { time: formatTime(lastSync.historyFetchedAt) }),
    );
  }
  // "Refreshed from Steam" describes the download that just ended; "possibly incomplete" stays true
  // of the stored history whatever happened since.
  if (lastSync?.outcome === 'synced' && lastSync.historyFromSteam === true) {
    sentences.push(t('matches.sync.upToDate'));
  } else if (lastSync?.historyFromSteam === false) {
    sentences.push(t('matches.sync.partial'));
  }
  if (status.pausedUntil !== null) {
    sentences.push(t('matches.sync.paused', { time: formatTime(status.pausedUntil) }));
  }
  if (status.protectedAccount) {
    sentences.push(t('matches.sync.protected'));
  }
  return sentences;
}

/**
 * Build the line about the progress of the match details: how many are archived, waiting for their
 * download or for a new attempt, and unavailable, then how many are invalid, if any.
 *
 * @param summary - The counts of the details; `null` when no account is linked, and `undefined`
 *   until they are read.
 * @param t - Translation function.
 * @returns The line, or `null` when there is nothing to say: the counts are not known, or no match
 *   is eligible for an archive yet (the banner would only say "0, 0, 0").
 */
function describeDetails(
  summary: DetailSummaryView | null | undefined,
  t: TFunction,
): string | null {
  if (summary === null || summary === undefined) {
    return null;
  }
  const { archived, waiting, unavailable, invalid } = summary;
  if (archived + waiting + unavailable + invalid === 0) {
    return null;
  }
  const line = t('matches.sync.details', { archived, waiting, unavailable });
  // Invalid details are final and rare: they are only worth a mention when there are some.
  return invalid > 0 ? `${line} ${t('matches.sync.detailsInvalid', { count: invalid })}` : line;
}

/**
 * Build the sentence that says the detail queue is stuck: the last run stopped on a local failure
 * (the archive folder or the compressor), and the next one will most likely stop the same way. The
 * counts alone would look like a queue that goes on.
 *
 * Only that stop is worth a sentence. A pause is already said by the status of the synchronisation,
 * and a network failure comes with a failed synchronisation, which says so too.
 *
 * @param summary - The counts of the details and the reason of the last stop; `null` when no
 *   account is linked, and `undefined` until they are read.
 * @param t - Translation function.
 * @returns The sentence, or `null` when the last run was not stopped by a local failure.
 */
function describeDetailsStop(
  summary: DetailSummaryView | null | undefined,
  t: TFunction,
): string | null {
  return summary?.lastStop === 'storage'
    ? t('matches.sync.detailsStopped', { reason: t('errors.kind.storage') })
    : null;
}

/**
 * Synchronisation banner.
 *
 * @returns The banner.
 */
export function SyncBanner() {
  const { t, i18n } = useTranslation();
  const status = useSyncStatus();
  const detailSummary = useDetailSummary();
  const running = useSyncRunning();
  const syncNow = useSyncNow();
  useRefreshOnSync();
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  let sentences: string[] = [];
  if (status.isError) {
    // The status could not be read (a damaged database…): say so instead of an empty banner.
    sentences = [t(`errors.kind.${toAppError(status.error).kind}`)];
  } else if (status.data !== undefined) {
    sentences = describeStatus(status.data, t, (time) => dateTime.format(time));
  }
  // A failed read of the counts only hides their line: the query client logs the failure, and the
  // status above already says when the local data cannot be read.
  const detailsLine = describeDetails(detailSummary.data, t);
  const detailsStopLine = describeDetailsStop(detailSummary.data, t);
  const hint = status.data?.missingAccountHint ?? null;

  return (
    <section className="mb-6 flex items-start justify-between gap-6 rounded-xl border border-border bg-surface p-4">
      <div className="space-y-1 text-sm">
        {/* Read again by screen readers whenever the status changes. */}
        <div aria-live="polite" className="space-y-1">
          {sentences.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
          {hint !== null && <p className="font-mono text-xs text-fg-muted">{hint}</p>}
        </div>
        {/* Outside the live region: the queue updates the counts up to once a second, and a screen
            reader would read them out at every change. (The hint above only shows without an
            account, when there is no line.) The sentence of a stuck queue follows the counts, and
            shows even when there are none to show. */}
        {detailsLine !== null && <p>{detailsLine}</p>}
        {detailsStopLine !== null && <p>{detailsStopLine}</p>}
      </div>
      <button
        type="button"
        onClick={() => {
          syncNow.mutate();
        }}
        disabled={running || status.data?.accountLinked !== true}
        className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface-raised px-4 py-2 text-sm font-medium hover:border-accent-bright disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RefreshCw aria-hidden="true" className={running ? 'size-4 animate-spin' : 'size-4'} />
        {running ? t('matches.sync.running') : t('matches.sync.now')}
      </button>
    </section>
  );
}

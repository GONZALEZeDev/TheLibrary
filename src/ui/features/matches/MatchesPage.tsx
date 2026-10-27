/**
 * Match history screen: the synchronisation banner, the filters of the history and the whole history
 * of the player under them, grouped by local day.
 *
 * The filters are the `hero` and `result` search parameters of the route (Paige and every result
 * unless the address says otherwise). When the account has no match, the screen says so and shows
 * no filter; when it has matches but none fits the filters, it says that instead, under the filters.
 *
 * @packageDocumentation
 */
import { getRouteApi } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { History, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import type { HistoryFilter } from '../../../services/matches.service';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { StatusLine } from '../../components/StatusLine';
import { LinkAccountButton } from '../account/LinkAccountButton';
import { HistoryFilters } from './HistoryFilters';
import { HistoryList } from './HistoryList';
import { SyncBanner } from './SyncBanner';
import { useHeroNames, useHistory } from './use-matches';

/** Typed access to the search parameters of the `/matches` route (see `ui/app/router.ts`). */
const matchesRoute = getRouteApi('/matches');

/** What the list part of the screen is drawn from, see {@link renderList}. */
interface ListState {
  /** State of the history query. */
  readonly history: ReturnType<typeof useHistory>;
  /** Hero names, once known. */
  readonly heroNames: ReadonlyMap<HeroId, string> | undefined;
  /** The time the days of the list are told against (Unix ms). */
  readonly now: number;
  /** The filter of the address. */
  readonly filter: HistoryFilter;
  /** Writes a new filter in the address. */
  readonly onFilterChange: (filter: HistoryFilter) => void;
}

/**
 * The list part of the screen, depending on what is known.
 *
 * @param state - The query, the hero names, the time and the filter.
 * @param t - Translation function.
 * @returns The loading message, the error, an empty state, or the filters and what they keep.
 */
function renderList(state: ListState, t: TFunction) {
  const { history, heroNames, now, filter, onFilterChange } = state;
  if (history.isPending) {
    return <StatusLine kind="loading" text={t('matches.loading')} />;
  }
  // A failed refresh keeps the matches already shown: the error only replaces an empty screen.
  if (history.data === undefined) {
    return <StatusLine kind="error" error={history.error} />;
  }
  const view = history.data;
  if (view.kind === 'no_account') {
    // A new player can link from wherever they land: the link resets this query, so the list is
    // replaced by the matches the first synchronisation brings.
    return (
      <EmptyState
        icon={UserRound}
        title={t('matches.noAccount.title')}
        description={t('matches.noAccount.description')}
      >
        <LinkAccountButton />
      </EmptyState>
    );
  }
  // The account has no match at all, whatever the filters: nothing to filter yet.
  if (view.total === 0) {
    return (
      <EmptyState
        icon={History}
        title={t('matches.empty.title')}
        description={t('matches.empty.description')}
      />
    );
  }
  const filteredEmpty = view.matches.length === 0;
  return (
    <>
      <HistoryFilters filter={filter} onChange={onFilterChange} />
      {/* A live region that stays mounted under the filters, empty while the list has rows: a screen
          reader announces the sentence when a pick empties the list, which it would not do for a
          region that appears with its text. */}
      <div role="status">
        {filteredEmpty && (
          <Panel as="div" padding="normal" className="text-sm">
            {t('matches.filteredEmpty')}
          </Panel>
        )}
      </div>
      {!filteredEmpty && <HistoryList matches={view.matches} heroNames={heroNames} now={now} />}
    </>
  );
}

/**
 * Match history screen.
 *
 * @returns The matches page.
 */
export function MatchesPage() {
  const { t } = useTranslation();
  // The search parameters are validated by the route: always a hero (or `all`) and a result. The
  // page is their only reader; the filters show what it gives them.
  const filter = matchesRoute.useSearch();
  const navigate = matchesRoute.useNavigate();
  const history = useHistory(filter);
  const hasMatches = history.data?.kind === 'ready' && history.data.total > 0;
  const heroNames = useHeroNames(hasMatches);

  // The time "today" and "yesterday" are told against: the latest read of the history, so a list
  // left open past midnight moves its days on at the next synchronisation, which reads it again.
  // While a new filter shows the list of the previous one (a placeholder, which has no read time),
  // it is the time the page opened, read once when it mounts.
  const [openedAt] = useState(() => Date.now());
  const now = Math.max(openedAt, history.dataUpdatedAt);

  return (
    <>
      <PageHeader title={t('matches.title')} />
      <SyncBanner />
      {renderList(
        {
          history,
          heroNames: heroNames.data,
          now,
          filter,
          // `replace`: a pick replaces the current entry of the browser history instead of adding
          // one, so going back leaves the list, as it would without the filters, instead of undoing
          // the picks one by one.
          onFilterChange: (next) => {
            void navigate({ search: next, replace: true });
          },
        },
        t,
      )}
    </>
  );
}

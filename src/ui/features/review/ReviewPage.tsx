/**
 * Review screen: the player's last matches summed up, set against the players of the tier above and
 * against the matches before, or why there is no review.
 *
 * The review (`useReview`) is read from the local database, so it is quick and works offline. The
 * page then shows one of:
 * - the invitation to link a Steam account, the same one the match list gives, when none is linked;
 * - one sentence, when the account has no analysed match yet: the review fills after the next
 *   synchronisation;
 * - the review: the lines under the title, then five tabs, one for each part of the review
 *   (`ReviewSummary`, `ReviewStats`, `ReviewDeaths`, `ReviewDamage` and `ReviewPlayers`). Only the
 *   open tab is built.
 * While the review is read, only the title is shown; a review that cannot be read says why, in place
 * of the tabs.
 *
 * **The lines under the title** say what the figures below are measured against:
 * - the matches the review covers: their number and their dates, written once when they were all
 *   played the same day;
 * - the matches the progress is measured against, or that there are too few of them to measure it;
 * - the comparison with the tier above: the tier (the player's own when it is the highest, or every
 *   rank when the player has none), then what makes it less than whole when that applies: matches
 *   compared with every rank because the tier holds too few of their length, matches that have no
 *   comparison yet (it comes with a download), matches that have none to have (too few Paige players
 *   of their length, even over every rank), data a day old or more. When there is no comparison at
 *   all, the line says that one is being downloaded or that it is unavailable;
 * - the item statistics the resistance items are compared with, when they are not there or not
 *   whole: not downloaded yet, a day old or more, of every rank, or holding nothing for the tier.
 *   They are cached apart from the cohorts, so the line is told whatever the cohorts say. Fresh
 *   statistics need no line, and neither does a review with no item to have them of (the resistance
 *   section says why).
 *
 * **The comparison** is downloaded by the page when it opens, if the review lacks it or holds it old
 * (`useReviewCommunityRefresh`), and the review is read again once the data is in the cache. The
 * download waits for the first read of the review to end: asked for earlier, the read that follows
 * the download would join the read still going, which may have looked at the cache too soon.
 *
 * The open tab is kept in the address of the page (`?tab=`): the summary when the address names no
 * tab, or one the page does not have. Opening another tab replaces the address instead of adding one
 * to the history, so that going back leaves the review rather than walking back through its tabs.
 *
 * A synchronisation changes what the review sums up (it stores and analyses matches), so the page
 * reads the review again whenever one runs or advances.
 *
 * @packageDocumentation
 */
import { getRouteApi } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CohortRank, ComparedWith } from '../../../core/analysis/cohort';
import { MIN_PERSONAL_MATCHES } from '../../../core/analysis/insights/thresholds';
import { RANK_TIER_NAMES } from '../../../core/domain/rank';
import { toAppError } from '../../../core/errors/app-error';
import type {
  Review,
  ReviewCommunity,
  ReviewItemStats,
  ReviewWindow,
} from '../../../services/review-view';
import type { ReviewTab } from '../../app/router';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';
import { LinkAccountButton } from '../account/LinkAccountButton';
import { useRefreshOnSync } from '../matches/use-matches';
import { ReviewDamage } from './ReviewDamage';
import { ReviewDeaths } from './ReviewDeaths';
import { ReviewPlayers } from './ReviewPlayers';
import { ReviewStats } from './ReviewStats';
import { ReviewSummary } from './ReviewSummary';
import { useReview, useReviewCommunityRefresh } from './use-review';

/**
 * Typed access to the search parameters of the `/review` route (see `ui/app/router.ts`).
 */
const reviewRoute = getRouteApi('/review');

/**
 * Translation key of the name of each tab, in display order: the summary, the stats, the deaths, the
 * damage, the players. The `satisfies` clause makes the compiler reject this table as soon as a tab
 * is added to {@link ReviewTab} without a name here, or a name is given to a tab that does not exist.
 * (The router validates the `tab` of the address against the same ids; this page does not read them
 * from `router.ts`, which imports the page.)
 */
const TAB_LABEL_KEYS = {
  summary: 'review.tabs.summary',
  stats: 'review.tabs.stats',
  deaths: 'review.tabs.deaths',
  damage: 'review.tabs.damage',
  players: 'review.tabs.players',
} as const satisfies Readonly<Record<ReviewTab, string>>;

/**
 * The tabs, in display order: the keys of {@link TAB_LABEL_KEYS}, which are exactly the tabs (its
 * `satisfies` clause), in the order they are written there.
 */
const TAB_IDS = Object.keys(TAB_LABEL_KEYS) as readonly ReviewTab[];

/** Milliseconds in a second: the start of a match is in seconds, a date wants milliseconds. */
const MS_PER_SECOND = 1_000;

/** What the page knows of the download of the comparison. */
type CommunityRefresh = ReturnType<typeof useReviewCommunityRefresh>;

/**
 * Tell whether the review lacks the comparison with the tier above, or holds it old: the page then
 * asks for it.
 *
 * The item statistics are part of it: a download cut short after the cohorts (the budget of the
 * minute is spent in that order) leaves complete cohorts and no item statistics, and the cohorts
 * alone would not call for another download for a day. A download that cannot give them (no
 * resistance item to ask for) leaves the review saying there are no items, so the page does not ask
 * for what cannot come. Even a review that stays due after a download cannot loop: the download
 * is asked for once when it becomes needed, and not again while it stays needed (the review read
 * again after it does not change that), only the next time the page opens.
 *
 * @param community - Where the comparison stands.
 * @returns `true` when none of the matches is compared, when some are not (those with data too thin
 *   to compare with included: their data is old in its turn one day, and a download renews it), when
 *   any of the data compared with is a day old or more, or when the item statistics are missing or a
 *   day old.
 */
function lacksCommunityData(community: ReviewCommunity): boolean {
  return (
    community.itemStats.kind === 'missing' ||
    community.itemStats.kind === 'stale' ||
    community.kind === 'missing' ||
    community.stale ||
    community.missingMatches > 0 ||
    community.unusableMatches > 0
  );
}

/**
 * The line about the matches the review covers.
 *
 * @param recent - The last matches.
 * @param day - How to write a date.
 * @param t - Translation function.
 * @returns "Your last 12 matches, Oct 3 to Oct 20", "Your last 6 matches, on Oct 20" when they were
 *   all played on one day, or "Your last match, Oct 20" for one. `null` for a window with no dates
 *   (one with no match, which a review is never made of).
 */
function windowLine(recent: ReviewWindow, day: Intl.DateTimeFormat, t: TFunction): string | null {
  const { count, firstStartTime, lastStartTime } = recent;
  if (firstStartTime === null || lastStartTime === null) {
    return null;
  }
  const from = day.format(firstStartTime * MS_PER_SECOND);
  const to = day.format(lastStartTime * MS_PER_SECOND);
  // The format has the year, the month and the day: two times that write the same date are on the
  // same calendar day, in the time zone of the player. "From the 20th to the 20th" would say less
  // than "on the 20th".
  if (count > 1 && from === to) {
    return t('review.windowOneDay', { count, date: from });
  }
  return t('review.window', { count, from, to });
}

/**
 * The line about the matches the progress is measured against.
 *
 * @param before - The matches before the last ones.
 * @param t - Translation function.
 * @returns What the progress is measured against, or that there are too few matches before to
 *   measure it: a smaller window gives too few values for a median to say anything.
 */
function progressLine(before: ReviewWindow, t: TFunction): string {
  return before.count >= MIN_PERSONAL_MATCHES
    ? t('review.before', { count: before.count })
    : t('review.noBefore');
}

/**
 * The line that says which players the review compares with.
 *
 * The tier is named in English whatever the language of the interface, like the game's.
 *
 * @param rank - The rank of the players compared with.
 * @param comparedWith - How that rank relates to the player's own. It decides the sentence, not the
 *   rank alone: the highest tier is the tier above for the player one tier under it, and the player's
 *   own tier for a player in it.
 * @param t - Translation function.
 * @returns The tier above the player's, the player's own tier when it is the highest, or every rank
 *   when the player has none.
 */
function tierLine(rank: CohortRank, comparedWith: ComparedWith, t: TFunction): string {
  // The rank and how it relates to the player's are given together by the service, so a cohort of
  // every rank is never the tier above or the own tier; testing the rank too lets the compiler see
  // that a tier is there to name.
  if (rank.kind === 'all' || comparedWith === 'every_rank') {
    return t('review.cohort.all');
  }
  const tier = RANK_TIER_NAMES[rank.tier] ?? String(rank.tier);
  return comparedWith === 'own_tier'
    ? t('review.cohort.own', { tier })
    : t('review.cohort.tier', { tier });
}

/**
 * The lines about the comparison with the tier above.
 *
 * @param community - Where the comparison stands.
 * @param refresh - The download of the comparison.
 * @param day - How to write a date.
 * @param t - Translation function.
 * @returns With a comparison: the tier, then a line for each of the matches compared with every
 *   rank, the matches with no comparison yet, the matches with none to have, and the age of the data,
 *   when they apply. Without one:
 *   that it is being downloaded, that it is unavailable once the download ended without it, or
 *   nothing while the download has not begun.
 */
function cohortLines(
  community: ReviewCommunity,
  refresh: CommunityRefresh,
  day: Intl.DateTimeFormat,
  t: TFunction,
): string[] {
  if (community.kind === 'missing') {
    // Whether the download runs is read before its answer: the query keeps the answer of the last
    // visit until the ask of this one ends, and that answer says nothing of the ask that runs now.
    if (refresh.isFetching) {
      return [t('review.cohort.loading')];
    }
    // The download ended and the comparison is still not there: it failed, none of it could be had,
    // or what could be had compares none of the matches.
    return refresh.isError || refresh.data !== undefined ? [t('review.cohort.unavailable')] : [];
  }
  const lines = [tierLine(community.rank, community.comparedWith, t)];
  if (community.fallbackMatches > 0) {
    lines.push(t('review.cohort.fallback', { count: community.fallbackMatches }));
  }
  if (community.missingMatches > 0) {
    lines.push(t('review.cohort.partial', { count: community.missingMatches }));
  }
  if (community.unusableMatches > 0) {
    lines.push(t('review.cohort.tooFew', { count: community.unusableMatches }));
  }
  if (community.stale) {
    lines.push(t('review.cohort.stale', { date: day.format(community.fetchedAt) }));
  }
  return lines;
}

/**
 * The line about the item statistics the resistance items are compared with.
 *
 * @param itemStats - Where the item statistics of the tier stand.
 * @param day - How to write a date.
 * @param t - Translation function.
 * @returns What makes them less than whole (not downloaded yet, old, of every rank, holding nothing
 *   for the tier), or `null` when nothing does or when there are no items to have them of.
 */
function itemStatsLine(
  itemStats: ReviewItemStats,
  day: Intl.DateTimeFormat,
  t: TFunction,
): string | null {
  switch (itemStats.kind) {
    case 'fresh':
    case 'no_items':
      return null;
    case 'missing':
      return t('review.itemStats.missing');
    case 'stale':
      return t('review.itemStats.stale', { date: day.format(itemStats.fetchedAt) });
    case 'fallback':
      return t('review.itemStats.fallback');
    case 'none':
      return t('review.itemStats.none');
  }
}

/**
 * The lines under the title: the matches covered, what the progress is measured against, and the
 * comparison with the tier above, the item statistics included.
 *
 * @param review - The review.
 * @param refresh - The download of the comparison.
 * @param day - How to write a date.
 * @param t - Translation function.
 * @returns The lines. The comparison is a live region: it changes while the page is open (the
 *   download ends, the review is read again), and a screen reader says so.
 */
function renderHeaderLines(
  review: Review,
  refresh: CommunityRefresh,
  day: Intl.DateTimeFormat,
  t: TFunction,
) {
  const covered = windowLine(review.recent, day, t);
  const comparison = cohortLines(review.community, refresh, day, t);
  const itemStats = itemStatsLine(review.community.itemStats, day, t);
  return (
    <div className="space-y-1 text-sm text-fg-muted">
      {covered === null ? null : <p>{covered}</p>}
      <p>{progressLine(review.before, t)}</p>
      <div role="status" className="space-y-1">
        {(itemStats === null ? comparison : [...comparison, itemStats]).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
}

/**
 * The panel of the open tab.
 *
 * @param tab - The open tab.
 * @param review - The review.
 * @returns The part of the review the tab is about.
 */
function renderTabPanel(tab: ReviewTab, review: Review) {
  switch (tab) {
    case 'summary':
      return <ReviewSummary summary={review.summary} />;
    case 'stats':
      return <ReviewStats stats={review.stats} />;
    case 'deaths':
      return <ReviewDeaths deaths={review.deaths} />;
    case 'damage':
      return <ReviewDamage damage={review.damage} recent={review.recent} before={review.before} />;
    case 'players':
      return <ReviewPlayers players={review.players} />;
  }
}

/**
 * Review screen.
 *
 * @returns The review page.
 */
export function ReviewPage() {
  const { t, i18n } = useTranslation();
  // The search parameters are validated by the route: `tab` is always one of the tabs.
  const { tab } = reviewRoute.useSearch();
  const navigate = reviewRoute.useNavigate();
  const review = useReview();
  // A synchronisation stores and analyses matches, which the review sums up: the page reads the
  // review again whenever one runs or advances.
  useRefreshOnSync();
  const view = review.data;
  const ready = view?.kind === 'ready' ? view.review : null;
  // The comparison is asked for once the review has been read, and only for a review that lacks it.
  // Asked for from the first render, the read that follows the download would join the first read of
  // the review and not start another (see `useReviewCommunityRefresh`).
  const refresh = useReviewCommunityRefresh(ready !== null && lacksCommunityData(ready.community));
  const day = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });

  let body: ReactNode = null;
  if (ready !== null) {
    body = (
      <Tabs
        label={t('review.tabs.label')}
        tabs={TAB_IDS.map((id) => ({ id, label: t(TAB_LABEL_KEYS[id]) }))}
        selected={tab}
        onSelect={(next) => {
          // `replace`: the tabs of the review are one entry of the history (see the header of this
          // file). The tabs never ask for the tab already open, so no navigation is for nothing.
          void navigate({ to: '/review', search: { tab: next }, replace: true });
        }}
      >
        {renderTabPanel(tab, ready)}
      </Tabs>
    );
  } else if (view?.kind === 'no_account') {
    // A new player can link from wherever they land: the link resets the review, which is read
    // again for the account.
    body = (
      <EmptyState
        icon={UserRound}
        title={t('matches.noAccount.title')}
        description={t('matches.noAccount.description')}
      >
        <LinkAccountButton />
      </EmptyState>
    );
  } else if (view?.kind === 'empty') {
    body = (
      <section className="rounded-xl border border-border bg-surface p-4 text-sm">
        <p>{t('review.empty')}</p>
      </section>
    );
  } else if (review.isError) {
    // A failed read of the review again keeps the review already shown: the error only replaces an
    // empty screen.
    body = (
      <p role="alert" className="text-sm text-loss">
        {t(`errors.kind.${toAppError(review.error).kind}`)}
      </p>
    );
  }
  // While the review is read (from the local database, so in a blink) only the title is shown.

  return (
    <>
      <PageHeader title={t('review.title')}>
        {ready === null ? undefined : renderHeaderLines(ready, refresh, day, t)}
      </PageHeader>
      {body}
    </>
  );
}

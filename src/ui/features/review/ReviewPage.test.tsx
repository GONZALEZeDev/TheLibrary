/**
 * Tests of the review screen, rendered inside the whole application (router, shell, providers) on
 * the development adapters: synthetic deadlock-api, in-memory database and archive. The tabs have
 * their own tests (`ReviewSummary.test.tsx` and its neighbours) and so do the hooks
 * (`use-review.test.tsx`): here, the route, the menu, the states of the page, the lines under its
 * title and the download of the comparison when the page opens.
 *
 * Most tests synchronise a small synthetic history first, like the application does, which archives
 * and projects its Paige matches, so the review can be read at once. The comparison with the tier
 * above is not in the cache yet: the page asks for it when it opens, which is what the tests of the
 * cohort line look at. The player's rank in that history is Sentinel 4, so the tier above is
 * Mystic. A test about a line of the page that the small history does not reach (a window of
 * another size, an old comparison) changes what the service says of the review and keeps the rest.
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
  type FixtureHttpClient,
} from '../../../adapters/dev/fixture-http-client.adapter';
import { createUnrankedPlayerRankFixture } from '../../../adapters/dev/fixtures/analytics.fixture';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import { durationWindowOf, type CohortRank } from '../../../core/analysis/cohort';
import { MIN_PERSONAL_MATCHES, REVIEW_MATCHES } from '../../../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../../../core/analysis/registry';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import type { AppServices } from '../../../services/app-services';
import { ApiCacheRepository } from '../../../services/api-cache.repository';
import { MetricsRepository } from '../../../services/metrics.repository';
import { cohortsByCoverage, type ReviewCommunityRefresh } from '../../../services/review.service';
import type { Review, ReviewWindow } from '../../../services/review-view';
import { HERO_STATS_PATH } from '../../../test/community-test-kit';
import {
  createTestQueryClient,
  createTestServices,
  projectArchivedMatches,
  type TestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter, REVIEW_TABS, type ReviewTab } from '../../app/router';
import { createI18n } from '../../i18n/i18n';

/** Time of the tests: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

/**
 * Size of the synthetic history. It is archived and projected before every test, so it is kept
 * short: just long enough to hold a few archived Paige matches, in more than one duration window.
 */
const MATCH_COUNT = 15;

/** The start of the path of every community request of the fixture API. */
const ANALYTICS_PREFIX = '/v1/analytics/';

/** The requests the download of one cohort makes: its size, its benchmarks and its curve. */
const REQUESTS_PER_COHORT = 3;

/** The requests the download of the item statistics makes. */
const ITEM_STATS_REQUESTS = 2;

/** How long a test waits to see that nothing more happens: well over a few turns of the event loop. */
const SETTLE_MS = 50;

/** When the item statistics of the tests that set them by hand were downloaded. */
const ITEMS_FETCHED_AT = Date.UTC(2026, 9, 19, 8, 0, 0);

/** The tier above the player's: the player is Sentinel 4 in the synthetic history, and tier 5 is Mystic. */
const TIER_ABOVE: CohortRank = { kind: 'tier', tier: 5 };

/** The names of the tabs, in English, by the id the address gives them. */
const TAB_NAMES: Readonly<Record<ReviewTab, string>> = {
  summary: 'Summary',
  stats: 'Stats',
  deaths: 'Deaths and resistance',
  damage: 'Damage by source',
  players: 'Players',
};

/** The title of the first section of each tab, in English: the proof that the tab shows its panel. */
const TAB_TITLES: Readonly<Record<ReviewTab, string>> = {
  summary: 'To work on',
  stats: 'Combat',
  deaths: 'Your deaths by phase',
  damage: 'Your damage to heroes by source',
  players: 'Your places among the 12 players',
};

/** The sentences of the page that do not depend on the review, in English. */
const EN = {
  title: 'Review',
  noBefore: 'Not enough earlier matches to measure progress',
  tierAbove: 'Compared with Paige players in Mystic, the tier above yours, last 30 days',
  everyRank: 'Compared with Paige players of every rank (no rank known for you), last 30 days',
  loading: 'Downloading the comparison…',
  unavailable: 'Comparison unavailable for now',
  empty: 'No analysed match yet: the review fills after the next synchronisation.',
  noAccount: 'No account linked',
  linkAccount: 'Link my Steam account',
  storageError: 'Local data could not be read or saved.',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Replace every run of white space (the narrow no-break spaces some locales write in dates included)
 * by one plain space, the way Testing Library reads the text of a page.
 *
 * @param text - Any text.
 * @returns The text with plain spaces only.
 */
function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Let the page go on for a moment, to see that nothing more happens.
 *
 * @returns A promise settled once the moment has passed.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  });
}

/**
 * Write a day the way the page does: medium date, in the language of the page.
 *
 * @param language - Language of the page.
 * @param time - A time, in Unix ms.
 * @returns The date, with plain spaces.
 */
function formatDay(language: Language, time: number): string {
  return normalizeSpaces(new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(time));
}

/**
 * A time on a day of the test, in the time zone the test runs in, so that "the same day" does not
 * depend on where the test runs.
 *
 * @param day - The day of October 2026.
 * @param hour - The hour, from 0 to 23.
 * @returns The time, in Unix seconds, as the start of a match is.
 */
function localTime(day: number, hour: number): number {
  return new Date(2026, 9, day, hour).getTime() / 1000;
}

/**
 * Synchronise a small synthetic history, so that its Paige matches are archived and projected.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @returns The test services.
 */
async function setUp(options: TestServicesOptions = {}): Promise<TestServices> {
  const test = createTestServices({
    now: () => NOW,
    handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    ...options,
  });
  await test.services.sync.syncNow('startup');
  // The synchronisation projected the matches already: this only makes sure of it.
  await projectArchivedMatches(test, { now: () => NOW });
  return test;
}

/** Options of {@link renderReview}. */
interface RenderOptions {
  /** Language of the interface; English by default. */
  readonly language?: Language;
  /** The query client of the page; a test one by default. A test of two visits shares one. */
  readonly queryClient?: QueryClient;
  /** The address the application opens at; the review without a tab by default. */
  readonly url?: string;
}

/**
 * Render the application at an address, by default the review.
 *
 * @param test - The services of the test.
 * @param options - See {@link RenderOptions}.
 * @returns The router and its history, to inspect, and the means to close the page.
 */
async function renderReview(
  test: TestServices,
  {
    language = 'en',
    queryClient = createTestQueryClient(test.logger),
    url = '/review',
  }: RenderOptions = {},
) {
  const i18n = await createI18n(language);
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createAppRouter(history);
  const { unmount } = render(
    <AppProviders services={test.services} queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, history, unmount };
}

/**
 * Read the review the way the page does, and require that there is one.
 *
 * @param services - The services of the test.
 * @returns The review.
 */
async function readReview(services: AppServices): Promise<Review> {
  const view = await services.review.getReview();
  if (view.kind !== 'ready') {
    expect.unreachable(`the review is ${view.kind}, not ready`);
  }
  return view.review;
}

/**
 * Make the review say something else of itself, and keep the rest of it.
 *
 * @param services - The services of the test.
 * @param change - Gives the review the page must see in place of the one the service reads.
 * @returns The spy on the review, to count the reads.
 */
function serveReview(services: AppServices, change: (review: Review) => Review) {
  const read = services.review.getReview.bind(services.review);
  return vi.spyOn(services.review, 'getReview').mockImplementation(async () => {
    const view = await read();
    return view.kind === 'ready' ? { kind: 'ready', review: change(view.review) } : view;
  });
}

/**
 * Give the review windows of the size and the dates the test needs.
 *
 * @param recent - The last matches.
 * @param before - The matches before them; the ones of the review by default.
 * @returns What {@link serveReview} takes.
 */
function withWindows(recent: ReviewWindow, before?: ReviewWindow): (review: Review) => Review {
  return (review) => ({ ...review, recent, before: before ?? review.before });
}

/**
 * Keep the page from downloading anything, for a test that is not about the download: the answer is
 * that none could be had.
 *
 * @param services - The services of the test.
 */
function noDownload(services: AppServices): void {
  vi.spyOn(services.review, 'refreshCommunity').mockResolvedValue('unavailable');
}

/**
 * Give the player a rank: the request for the rank of the player is answered with a badge, and every
 * other request as the fixture API does.
 *
 * @param badge - The badge of the player, `0` for a player who has none.
 * @returns The handler.
 */
function withBadge(badge: number): FixtureHandler {
  const fixtureApi = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
  return (request) =>
    /\/v1\/players\/\d+\/rank$/.test(request.url)
      ? jsonResponse(
          badge === 0
            ? createUnrankedPlayerRankFixture()
            : { badge, rank: Math.floor(badge / 10), subrank: badge % 10, last_match: null },
        )
      : fixtureApi(request);
}

/**
 * Count the requests the community data was asked for.
 *
 * @param http - The client of the test services.
 * @returns How many requests the analytics endpoints received so far.
 */
function analyticsRequests(http: FixtureHttpClient): number {
  return http.requests.filter((request) =>
    new URL(request.url).pathname.startsWith(ANALYTICS_PREFIX),
  ).length;
}

/**
 * The duration window a community request asks for.
 *
 * @param url - The URL of the request.
 * @returns The window as `<min>-<max>`, in seconds.
 */
function windowKeyOf(url: URL): string {
  return `${url.searchParams.get('min_duration_s') ?? ''}-${url.searchParams.get('max_duration_s') ?? ''}`;
}

/**
 * Watch for a text to appear on the page, even for a moment: a line that shows for one render is
 * gone by the time a test looks, but Testing Library's observer sees the node come in.
 *
 * @param text - The text to watch for.
 * @returns Whether it was seen, and the means to stop watching.
 */
function watchForText(text: string) {
  let seen = false;
  const look = (records: readonly MutationRecord[]) => {
    for (const record of records) {
      if (normalizeSpaces(record.target.textContent ?? '').includes(text)) seen = true;
      for (const node of record.addedNodes) {
        if (normalizeSpaces(node.textContent ?? '').includes(text)) seen = true;
      }
    }
  };
  const observer = new MutationObserver(look);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    wasSeen: () => {
      look(observer.takeRecords());
      return seen;
    },
    stop: () => {
      observer.disconnect();
    },
  };
}

describe('ReviewPage', () => {
  describe('route and menu', () => {
    it('shows the review in the menu, Settings last', async () => {
      const user = userEvent.setup();
      const test = await setUp();
      noDownload(test.services);
      const { router } = await renderReview(test, { url: '/dashboard' });

      const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
      const links = within(nav).getAllByRole('link');
      expect(links.map((link) => link.textContent)).toEqual([
        'Dashboard',
        'Matches',
        'Review',
        'Settings',
      ]);
      // The settings keep the bottom of the sidebar, under the review.
      expect(links.at(-1)).toHaveClass('mt-auto');

      await user.click(within(nav).getByRole('link', { name: 'Review' }));

      // The link opens the review on its first tab, and is marked as the current page.
      expect(await screen.findByRole('heading', { level: 1, name: EN.title })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/review');
      expect(router.state.location.search).toEqual({ tab: 'summary' });
      expect(within(nav).getByRole('link', { name: 'Review' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
        'aria-current',
      );
    });

    it('opens the summary for an unknown tab', async () => {
      const test = await setUp();
      noDownload(test.services);
      const { router } = await renderReview(test, { url: '/review?tab=nope' });

      expect(await screen.findByRole('tab', { selected: true })).toHaveAccessibleName(
        TAB_NAMES.summary,
      );
      expect(
        await screen.findByRole('heading', { level: 2, name: TAB_TITLES.summary }),
      ).toBeInTheDocument();
      // The address is corrected, not kept as typed.
      expect(router.state.location.search).toEqual({ tab: 'summary' });
    });

    it('lists the five tabs in order', async () => {
      const test = await setUp();
      noDownload(test.services);
      await renderReview(test);

      const tablist = await screen.findByRole('tablist', { name: 'Review sections' });
      expect(
        within(tablist)
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Summary', 'Stats', 'Deaths and resistance', 'Damage by source', 'Players']);
    });

    it.each(REVIEW_TABS)(
      'opens the %s tab the address names, with its first section',
      async (tab) => {
        const test = await setUp();
        noDownload(test.services);
        await renderReview(test, { url: `/review?tab=${tab}` });

        expect(await screen.findByRole('tab', { selected: true })).toHaveAccessibleName(
          TAB_NAMES[tab],
        );
        // The first section of the panel is the one that names the tab's content, and no other tab's.
        const panel = within(await screen.findByRole('tabpanel'));
        const [first] = await panel.findAllByRole('heading', { level: 2 });
        expect(first).toHaveTextContent(TAB_TITLES[tab]);
      },
    );

    it('keeps the tab in the URL without adding history entries', async () => {
      const user = userEvent.setup();
      const test = await setUp();
      noDownload(test.services);
      const { router, history } = await renderReview(test);
      expect(await screen.findByRole('tab', { selected: true })).toHaveAccessibleName(
        TAB_NAMES.summary,
      );
      const entries = history.length;

      await user.click(screen.getByRole('tab', { name: TAB_NAMES.deaths }));

      // The address names the tab now, and the tab shows its panel in place of the summary.
      await waitFor(() => {
        expect(router.state.location.search).toEqual({ tab: 'deaths' });
      });
      expect(router.state.location.pathname).toBe('/review');
      expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(TAB_NAMES.deaths);
      expect(
        await screen.findByRole('heading', { level: 2, name: TAB_TITLES.deaths }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: TAB_TITLES.summary })).not.toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: TAB_NAMES.players }));

      await waitFor(() => {
        expect(router.state.location.search).toEqual({ tab: 'players' });
      });
      expect(
        await screen.findByRole('heading', { level: 2, name: TAB_TITLES.players }),
      ).toBeInTheDocument();
      // Each tab replaced the address of the one before: going back leaves the review, not the tab.
      expect(history.length).toBe(entries);
    });
  });

  describe('states', () => {
    it('invites to link an account', async () => {
      const test = createTestServices({
        now: () => NOW,
        handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
        accountId: null,
      });
      const refresh = vi.spyOn(test.services.review, 'refreshCommunity');
      await renderReview(test);

      const page = within(await screen.findByRole('main'));
      expect(await page.findByRole('heading', { level: 1, name: EN.title })).toBeInTheDocument();
      expect(
        await page.findByRole('heading', { level: 2, name: EN.noAccount }),
      ).toBeInTheDocument();
      // The same button as the match list offers, and it is enabled.
      expect(page.getByRole('button', { name: EN.linkAccount })).toBeEnabled();
      expect(page.queryByRole('tablist')).not.toBeInTheDocument();
      await settle();
      // Nothing is downloaded for a page that shows no review to compare.
      expect(refresh).not.toHaveBeenCalled();
    });

    it('says the review fills after the next synchronisation', async () => {
      const test = await setUp();
      // Archived matches with no projection of the current metrics: a page opened before the end of
      // the synchronisation, or after a new version of the metrics.
      await new MetricsRepository(test.database).deleteAccount(FIXTURE_ACCOUNT_ID);
      const refresh = vi.spyOn(test.services.review, 'refreshCommunity');
      await renderReview(test);

      const page = within(await screen.findByRole('main'));
      expect(await page.findByText(EN.empty)).toBeInTheDocument();
      expect(page.getByRole('heading', { level: 1, name: EN.title })).toBeInTheDocument();
      expect(page.queryByRole('tablist')).not.toBeInTheDocument();
      await settle();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('shows why the review cannot be read', async () => {
      const test = await setUp();
      vi.spyOn(test.services.review, 'getReview').mockRejectedValue(
        new AppError('storage', 'The matches cannot be read'),
      );
      await renderReview(test);

      // The title stays, and the message of the kind of error replaces the review.
      expect(await screen.findByRole('alert')).toHaveTextContent(EN.storageError);
      expect(screen.getByRole('heading', { level: 1, name: EN.title })).toBeInTheDocument();
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('reads the review again after a synchronisation', async () => {
      const test = await setUp();
      const read = vi.spyOn(test.services.review, 'getReview');
      const refresh = vi.spyOn(test.services.review, 'refreshCommunity');
      await renderReview(test);
      await screen.findByText(EN.tierAbove);
      expect(refresh).toHaveBeenCalledTimes(1);
      const readsBeforeSync = read.mock.calls.length;

      // The page reads the review again whenever a synchronisation runs: the matches it sums up
      // are the ones the synchronisation stores and analyses.
      await test.services.sync.syncNow('manual');
      await waitFor(() => {
        expect(read.mock.calls.length).toBeGreaterThan(readsBeforeSync);
      });
      await settle();

      // The comparison is not downloaded again for it: the data is as good as it was.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByText(EN.tierAbove)).toBeInTheDocument();
    });
  });

  describe('the lines under the title', () => {
    it('writes the first and the last date of the matches', async () => {
      const test = await setUp();
      noDownload(test.services);
      serveReview(
        test.services,
        withWindows({
          count: 12,
          firstStartTime: localTime(10, 20),
          lastStartTime: localTime(20, 21),
        }),
      );
      await renderReview(test);

      const from = formatDay('en', localTime(10, 20) * 1000);
      const to = formatDay('en', localTime(20, 21) * 1000);
      expect(await screen.findByText(`Your last 12 matches, ${from} to ${to}`)).toBeInTheDocument();
    });

    it('writes one date when the last matches were all played the same day', async () => {
      const test = await setUp();
      noDownload(test.services);
      serveReview(
        test.services,
        withWindows({
          count: 6,
          firstStartTime: localTime(20, 8),
          lastStartTime: localTime(20, 22),
        }),
      );
      await renderReview(test);

      const day = formatDay('en', localTime(20, 8) * 1000);
      expect(await screen.findByText(`Your last 6 matches, on ${day}`)).toBeInTheDocument();
      // Not "from the 20th to the 20th".
      expect(screen.queryByText(`Your last 6 matches, ${day} to ${day}`)).not.toBeInTheDocument();
    });

    it('writes the date of a single match', async () => {
      const test = await setUp();
      noDownload(test.services);
      serveReview(
        test.services,
        withWindows({
          count: 1,
          firstStartTime: localTime(20, 8),
          lastStartTime: localTime(20, 8),
        }),
      );
      await renderReview(test);

      const day = formatDay('en', localTime(20, 8) * 1000);
      expect(await screen.findByText(`Your last match, ${day}`)).toBeInTheDocument();
    });

    it('says there are not enough earlier matches to measure progress', async () => {
      const test = await setUp();
      const { before } = await readReview(test.services);
      // The small history holds too few matches before the last ones, which is what the line is for.
      expect(before.count).toBeLessThan(MIN_PERSONAL_MATCHES);
      await renderReview(test);

      expect(await screen.findByText(EN.noBefore)).toBeInTheDocument();
      expect(screen.queryByText(/^Progress: against/)).not.toBeInTheDocument();
    });

    it.each([
      [
        MIN_PERSONAL_MATCHES,
        `Progress: against the ${String(MIN_PERSONAL_MATCHES)} matches before`,
      ],
      [REVIEW_MATCHES, `Progress: against the ${String(REVIEW_MATCHES)} matches before`],
      [MIN_PERSONAL_MATCHES - 1, EN.noBefore],
    ])('says what the progress is measured against with %i matches before', async (count, line) => {
      const test = await setUp();
      noDownload(test.services);
      serveReview(test.services, (review) => ({
        ...review,
        before: { ...review.before, count },
      }));
      await renderReview(test);

      expect(await screen.findByText(line)).toBeInTheDocument();
    });

    it('writes the lines in French', async () => {
      const test = await setUp();
      noDownload(test.services);
      serveReview(
        test.services,
        withWindows(
          { count: 12, firstStartTime: localTime(10, 20), lastStartTime: localTime(20, 21) },
          {
            count: REVIEW_MATCHES,
            firstStartTime: localTime(1, 8),
            lastStartTime: localTime(9, 8),
          },
        ),
      );
      await renderReview(test, { language: 'fr' });

      const from = formatDay('fr', localTime(10, 20) * 1000);
      const to = formatDay('fr', localTime(20, 21) * 1000);
      expect(
        await screen.findByText(`Tes 12 dernières parties, du ${from} au ${to}`),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Bilan' })).toBeInTheDocument();
      expect(
        screen.getByText(`Progression : face aux ${String(REVIEW_MATCHES)} parties d'avant`),
      ).toBeInTheDocument();
      expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName('Résumé');
      expect(
        within(screen.getByRole('tablist'))
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Résumé', 'Stats', 'Morts et résistance', 'Dégâts par source', 'Joueurs']);
    });

    it('writes the one date in French', async () => {
      const test = await setUp();
      noDownload(test.services);
      serveReview(
        test.services,
        withWindows({
          count: 6,
          firstStartTime: localTime(20, 8),
          lastStartTime: localTime(20, 22),
        }),
      );
      await renderReview(test, { language: 'fr' });

      const day = formatDay('fr', localTime(20, 8) * 1000);
      expect(await screen.findByText(`Tes 6 dernières parties, le ${day}`)).toBeInTheDocument();
    });
  });

  describe('the comparison', () => {
    it('says which tier the review compares with', async () => {
      const test = await setUp();
      const { community } = await readReview(test.services);
      // The player is Sentinel 4: the tier above is Mystic.
      expect(community.rank).toEqual(TIER_ABOVE);
      await renderReview(test);

      expect(await screen.findByText(EN.tierAbove)).toBeInTheDocument();
      // The download is over and complete: nothing else is said of the comparison.
      expect(screen.queryByText(EN.loading)).not.toBeInTheDocument();
      expect(screen.queryByText(EN.unavailable)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Data of /)).not.toBeInTheDocument();
      // The item statistics came with it, fresh: nothing is said of them either.
      expect(screen.queryByText(/item statistics/i)).not.toBeInTheDocument();
    });

    it.each([
      {
        kind: 'missing',
        en: 'No item statistics yet: the resistance items have no tier figure',
        fr: "Pas encore de statistiques d'objets : les objets de résistance n'ont pas de chiffre du palier",
      },
      {
        kind: 'stale',
        en: `Item statistics of ${formatDay('en', ITEMS_FETCHED_AT)}`,
        fr: `Statistiques d'objets du ${formatDay('fr', ITEMS_FETCHED_AT)}`,
      },
      {
        kind: 'fallback',
        en: 'Item statistics of every rank: too few matches in that tier',
        fr: "Statistiques d'objets de tous les rangs : trop peu de parties dans ce palier",
      },
      {
        kind: 'none',
        en: 'No item statistics for that tier',
        fr: "Pas de statistiques d'objets pour ce palier",
      },
    ] as const)('says when the item statistics are $kind', async ({ kind, en, fr }) => {
      const itemStats =
        kind === 'missing' ? { kind } : ({ kind, fetchedAt: ITEMS_FETCHED_AT } as const);
      for (const [language, line] of [
        ['en', en],
        ['fr', fr],
      ] as const) {
        const test = await setUp();
        noDownload(test.services);
        serveReview(test.services, (review) => ({
          ...review,
          community: { ...review.community, itemStats },
        }));
        const { unmount } = await renderReview(test, { language });

        // One line, among the lines about the comparison, which a screen reader is told of.
        const status = await screen.findByRole('status');
        expect(await within(status).findByText(line)).toBeInTheDocument();
        unmount();
      }
    });

    it.each(['fresh', 'no_items'] as const)(
      'says nothing of the item statistics when they are %s',
      async (kind) => {
        // Without items to ask for, the resistance section says why it has no item: the header
        // does not say it again.
        const itemStats = kind === 'fresh' ? { kind, fetchedAt: ITEMS_FETCHED_AT } : { kind };
        const test = await setUp();
        noDownload(test.services);
        serveReview(test.services, (review) => ({
          ...review,
          community: { ...review.community, itemStats },
        }));
        await renderReview(test);

        expect(await screen.findByText(EN.noBefore)).toBeInTheDocument();
        await settle();
        expect(screen.queryByText(/item statistics/i)).not.toBeInTheDocument();
      },
    );

    it.each([
      {
        what: 'the tier above the player when it is the highest one',
        // Ascendant 6: Eternus is a tier above, not the player's own.
        badge: 106,
        line: 'Compared with Paige players in Eternus, the tier above yours, last 30 days',
      },
      {
        what: 'the own tier of a player of the highest tier',
        // Eternus 6: no tier above, so the same tier, and the line says so.
        badge: 116,
        line: 'Compared with Paige players in Eternus, your own tier (the highest), last 30 days',
      },
      { what: 'every rank when the player has none', badge: 0, line: EN.everyRank },
    ])('says the review compares with $what', async ({ badge, line }) => {
      const test = await setUp({ handler: withBadge(badge) });
      await renderReview(test);

      expect(await screen.findByText(line)).toBeInTheDocument();
      // One sentence about the players compared with, not two.
      expect(screen.getAllByText(/^Compared with Paige players/)).toHaveLength(1);
    });

    it('says the own tier in French', async () => {
      const test = await setUp({ handler: withBadge(116) });
      await renderReview(test, { language: 'fr' });

      expect(
        await screen.findByText(
          'Comparé aux joueurs de Paige Eternus, ton propre palier (le plus haut), sur 30 jours',
        ),
      ).toBeInTheDocument();
    });

    it('says the comparison is partial', async () => {
      // The download of one duration window fails: the matches of that window have no comparison.
      const api = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
      const failing: { window: string | null } = { window: null };
      const handler: FixtureHandler = (request) => {
        const url = new URL(request.url);
        return failing.window !== null &&
          url.pathname === HERO_STATS_PATH &&
          windowKeyOf(url) === failing.window
          ? jsonResponse({}, 500)
          : api(request);
      };
      const test = await setUp({ handler });
      const recent = await new MetricsRepository(test.database).listRecent(
        FIXTURE_ACCOUNT_ID,
        PROJECTION_VERSION,
        REVIEW_MATCHES,
      );
      // The window of the fewest matches, worked out from the matches and not from the review.
      const cohorts = cohortsByCoverage(recent, TIER_ABOVE);
      const lastCohort = cohorts.at(-1) ?? expect.unreachable('the history holds matches');
      expect(cohorts.length, 'the matches span more than one window').toBeGreaterThan(1);
      failing.window = `${String(lastCohort.window.minS)}-${String(lastCohort.window.maxS)}`;
      const missing = recent.filter(
        ({ durationS }) => durationWindowOf(durationS).minS === lastCohort.window.minS,
      ).length;
      const refresh = vi.spyOn(test.services.review, 'refreshCommunity');
      await renderReview(test);

      const sentence = `No comparison yet for ${String(missing)} ${missing === 1 ? 'match' : 'matches'}: it will come at a next opening`;
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      // The matches that were compared say what they were compared with.
      expect(screen.getByText(EN.tierAbove)).toBeInTheDocument();
      await settle();
      // It will come at a next opening: the page does not insist.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(EN.loading)).not.toBeInTheDocument();
    });

    it('says how the comparison was made when matches fall back, miss it or the data is old', async () => {
      const test = await setUp();
      noDownload(test.services);
      const fetchedAt = Date.UTC(2026, 9, 20, 8, 0, 0);
      serveReview(test.services, (review) => ({
        ...review,
        community: {
          kind: 'available',
          rank: TIER_ABOVE,
          comparedWith: 'tier_above',
          itemStats: { kind: 'fresh', fetchedAt },
          fallbackMatches: 3,
          missingMatches: 1,
          unusableMatches: 2,
          stale: true,
          fetchedAt,
        },
      }));
      await renderReview(test);

      // One line for the tier, then one for each thing that makes the comparison less than whole.
      expect(await screen.findByText(EN.tierAbove)).toBeInTheDocument();
      expect(
        screen.getByText('3 matches compared with every rank: too few matches in that tier'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('No comparison yet for 1 match: it will come at a next opening'),
      ).toBeInTheDocument();
      // The matches whose length holds too few players are told apart: no opening will bring theirs.
      expect(
        screen.getByText('No comparison for 2 matches: too few Paige players in their length'),
      ).toBeInTheDocument();
      expect(screen.getByText(`Data of ${formatDay('en', fetchedAt)}`)).toBeInTheDocument();
      // The comparison is there, whatever its age: it is not said to be unavailable.
      await settle();
      expect(screen.queryByText(EN.unavailable)).not.toBeInTheDocument();
    });

    it.each([
      {
        language: 'en',
        missing: 0,
        unusable: 1,
        line: 'No comparison for 1 match: too few Paige players in its length',
      },
      {
        language: 'fr',
        missing: 0,
        unusable: 1,
        line: 'Pas de comparaison pour 1 partie : trop peu de joueurs de Paige sur sa durée',
      },
      {
        language: 'fr',
        missing: 0,
        unusable: 3,
        line: 'Pas de comparaison pour 3 parties : trop peu de joueurs de Paige sur leur durée',
      },
      {
        language: 'fr',
        missing: 2,
        unusable: 0,
        line: 'Pas encore de comparaison pour 2 parties : elle viendra à une prochaine ouverture',
      },
    ] as const)(
      'counts apart the matches with no comparison to come: $missing missing, $unusable unusable, in $language',
      async ({ language, missing, unusable, line }) => {
        const test = await setUp();
        noDownload(test.services);
        serveReview(test.services, (review) => ({
          ...review,
          community: {
            kind: 'available',
            rank: TIER_ABOVE,
            comparedWith: 'tier_above',
            itemStats: { kind: 'fresh', fetchedAt: NOW },
            fallbackMatches: 0,
            missingMatches: missing,
            unusableMatches: unusable,
            stale: false,
            fetchedAt: NOW,
          },
        }));
        await renderReview(test, { language });

        const status = await screen.findByRole('status');
        expect(await within(status).findByText(line)).toBeInTheDocument();
        // One line for each count that is not 0, and none for the other.
        const otherLine =
          missing === 0 ? /prochaine ouverture|next opening/ : /sur (sa|leur) durée/;
        expect(within(status).queryByText(otherLine)).not.toBeInTheDocument();
      },
    );

    it('says the comparison is downloading until the answer comes', async () => {
      const test = await setUp();
      let answer: (outcome: ReviewCommunityRefresh) => void = () => undefined;
      vi.spyOn(test.services.review, 'refreshCommunity').mockReturnValue(
        new Promise<ReviewCommunityRefresh>((resolve) => {
          answer = resolve;
        }),
      );
      await renderReview(test);

      // The review shows, with no comparison yet, and says that one is coming.
      expect(await screen.findByText(EN.loading)).toBeInTheDocument();
      expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(TAB_NAMES.summary);
      expect(screen.queryByText(EN.tierAbove)).not.toBeInTheDocument();
      expect(screen.queryByText(EN.unavailable)).not.toBeInTheDocument();

      act(() => {
        answer('unavailable');
      });

      // Nothing could be downloaded: the page says so instead of waiting for ever.
      expect(await screen.findByText(EN.unavailable)).toBeInTheDocument();
      expect(screen.queryByText(EN.loading)).not.toBeInTheDocument();
    });

    it.each([
      { what: 'an unavailable answer', download: () => Promise.resolve('unavailable' as const) },
      {
        what: 'a failed download',
        download: () => Promise.reject(new AppError('storage', 'The data cannot be stored')),
      },
    ])('says the comparison is unavailable after $what', async ({ download }) => {
      const test = await setUp();
      vi.spyOn(test.services.review, 'refreshCommunity').mockImplementation(download);
      await renderReview(test);

      expect(await screen.findByText(EN.unavailable)).toBeInTheDocument();
      // The review itself is still there, with its tabs: only the comparison is missing.
      expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(TAB_NAMES.summary);
      expect(screen.queryByText(EN.loading)).not.toBeInTheDocument();
      expect(screen.queryByText(EN.tierAbove)).not.toBeInTheDocument();
    });

    it('does not show the answer of the last visit while the new download runs', async () => {
      const test = await setUp();
      const queryClient = createTestQueryClient(test.logger);
      const refresh = vi
        .spyOn(test.services.review, 'refreshCommunity')
        .mockResolvedValueOnce('unavailable');
      const first = await renderReview(test, { queryClient });
      expect(await screen.findByText(EN.unavailable)).toBeInTheDocument();
      first.unmount();

      // The query still holds the answer of the first visit: "unavailable". The second visit asks
      // again, and the answer is not there yet.
      refresh.mockReturnValue(new Promise<ReviewCommunityRefresh>(() => undefined));
      const unavailableShown = watchForText(EN.unavailable);
      try {
        await renderReview(test, { queryClient });

        expect(await screen.findByText(EN.loading)).toBeInTheDocument();
        await settle();
        // Not even for one render: the old answer says nothing of the download that is running.
        expect(unavailableShown.wasSeen()).toBe(false);
        expect(refresh).toHaveBeenCalledTimes(2);
      } finally {
        unavailableShown.stop();
      }
    });

    it('downloads the comparison once when the page opens', async () => {
      const test = await setUp();
      const { services, http } = test;
      const refresh = vi.spyOn(services.review, 'refreshCommunity');
      const requestsBefore = analyticsRequests(http);
      // One download: a cohort for each duration window of the last matches, then the item
      // statistics.
      const recent = await new MetricsRepository(test.database).listRecent(
        FIXTURE_ACCOUNT_ID,
        PROJECTION_VERSION,
        REVIEW_MATCHES,
      );
      const windows = cohortsByCoverage(recent, TIER_ABOVE).length;
      await renderReview(test);

      // The review is compared with the tier above once the data is in the cache.
      expect(await screen.findByText(EN.tierAbove)).toBeInTheDocument();
      // Time for a loop to show itself: a second download.
      await settle();

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(analyticsRequests(http) - requestsBefore).toBe(
        windows * REQUESTS_PER_COHORT + ITEM_STATS_REQUESTS,
      );
      expect(screen.queryByText(EN.loading)).not.toBeInTheDocument();
    });

    it('downloads the item statistics when the cohorts are fresh but they are missing', async () => {
      const test = await setUp();
      const { services, http } = test;
      // A first download that was cut short before its last step (the budget of the minute): the
      // cohorts are in the cache and fresh, the item statistics are not.
      await expect(services.review.refreshCommunity()).resolves.toBe('updated');
      await new ApiCacheRepository(test.database).deleteOlderThan(
        'analytics.items.',
        Number.MAX_SAFE_INTEGER,
      );
      const before = await readReview(services);
      expect(before.community).toMatchObject({
        kind: 'available',
        missingMatches: 0,
        unusableMatches: 0,
        stale: false,
        itemStats: { kind: 'missing' },
      });
      const refresh = vi.spyOn(services.review, 'refreshCommunity');
      const requestsBefore = analyticsRequests(http);
      await renderReview(test);

      // The page asks, though nothing about the cohorts calls for it...
      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
      });
      await waitFor(async () => {
        expect((await readReview(services)).community).toMatchObject({
          itemStats: { kind: 'fresh' },
        });
      });
      await settle();

      // ... downloads the item statistics only, and does not ask again once they are in.
      expect(analyticsRequests(http) - requestsBefore).toBe(ITEM_STATS_REQUESTS);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByText(EN.tierAbove)).toBeInTheDocument();
    });

    it('asks once when the item statistics stay due, and does not loop', async () => {
      // The download cannot change it (a failed request, a catalogue that names no resistance item):
      // the review read again says the same, and the page must not ask again for it.
      const test = await setUp();
      const refresh = vi.spyOn(test.services.review, 'refreshCommunity').mockResolvedValue('fresh');
      // Every match is compared with fresh cohorts: the item statistics are all that is due.
      const read = serveReview(test.services, (review) => ({
        ...review,
        community: {
          kind: 'available',
          rank: TIER_ABOVE,
          comparedWith: 'tier_above',
          itemStats: { kind: 'missing' },
          fallbackMatches: 0,
          missingMatches: 0,
          unusableMatches: 0,
          stale: false,
          fetchedAt: NOW,
        },
      }));
      await renderReview(test);

      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
      });
      // The review is read again after the answer (`fresh` reads it in case it was behind)...
      await waitFor(() => {
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      const reads = read.mock.calls.length;
      await settle();

      // ... and that is all: no second ask, no more reads.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(reads);
    });

    it('waits for the first read of the review before it downloads the comparison', async () => {
      const test = await setUp();
      const { review } = test.services;
      const events: string[] = [];
      const read = review.getReview.bind(review);
      const download = review.refreshCommunity.bind(review);
      vi.spyOn(review, 'getReview').mockImplementation(async () => {
        const view = await read();
        events.push('read');
        return view;
      });
      vi.spyOn(review, 'refreshCommunity').mockImplementation(() => {
        events.push('download');
        return download();
      });
      await renderReview(test);

      expect(await screen.findByText(EN.tierAbove)).toBeInTheDocument();
      await settle();

      // Asked for from the first render, the download would end while the first read still goes on:
      // the review read again would join that read, and the page would not see the data.
      expect(events).toEqual(['read', 'download', 'read']);
    });
  });
});

/**
 * Tests of the dashboard screen, rendered inside the whole application (router, shell, providers) on
 * the development adapters: a synthetic deadlock-api and an in-memory database. The banner has its
 * own tests (`SyncBanner.test.tsx`) and so has the link button (`LinkSteamDialog.test.tsx`): these
 * check that the dashboard puts them where the player needs them, and that it follows the account.
 *
 * The matches of the dashboard are synchronised from a history written by hand, so that the results,
 * the figures and the dates are known. The details of the matches are not downloaded (the history
 * answers 404 for them), which leaves the review without an analysed match; the tests about its
 * points serve a review written by hand instead, as the points are all the dashboard reads of it.
 *
 * The texts each language must say are written out in full below, not read from the catalogues: they
 * are what the player reads, and a test that took them from the catalogue would pass whatever the
 * catalogue says.
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../../../adapters/dev/fixture-http-client.adapter';
import {
  FIXTURE_ACCOUNT_ID,
  type RawMatchHistoryRow,
} from '../../../adapters/dev/fixtures/match-history.fixture';
import { matchHistoryRequest } from '../../../core/deadlock-api/endpoints';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import { AccountService } from '../../../services/account.service';
import type { Review, ReviewRow, ReviewSubject, ReviewView } from '../../../services/review-view';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { clickSyncNow, waitUntilIdle } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { createI18n } from '../../i18n/i18n';

/** Time of the tests: the matches below are dated from it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Seconds in a day: the start of a match is in Unix seconds. */
const DAY_S = 86_400;

/** Infernus, a hero of the synthetic catalogue other than Paige. */
const INFERNUS_HERO_ID = 1;

/** The game mode of the normal game, and the one of Street Brawl. */
const NORMAL_GAME_MODE = 1;
const STREET_BRAWL_GAME_MODE = 4;

/** The unranked and the ranked match modes of the normal game. */
const UNRANKED_MATCH_MODE = 1;
const RANKED_MATCH_MODE = 4;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** The texts of the dashboard that depend on the language. */
const STRINGS = {
  en: {
    emptyLatest: 'No Paige match yet.',
    oneMatch: 'Your last match',
    threeMatches: 'Your last 3 matches',
    tenMatches: 'Your last 10 matches',
    win: 'Win',
    loss: 'Loss',
    record: 'Wins',
    kda: 'Average K / D / A',
    average: '7.0 / 3.0 / 18.0',
    loading: 'Computing the review…',
    weaknesses: 'To work on',
    strengths: 'Your strengths',
    noWeakness: 'No recurring weakness',
    noStrength: 'No recurring strength',
    weakness: 'weakness',
    strength: 'strength',
    reviewEmpty: 'No analysed match yet: the review fills after the next synchronisation.',
    seeReview: 'See the full review',
    seeMatches: 'All my matches',
    reviewTitle: 'Review',
    matchesTitle: 'Matches',
    labels: { kda: 'KDA', accuracy: 'Accuracy', lastHits: 'Last hits', denies: 'Denies' },
    earlyDeaths: 'Deaths in early',
    netWorthPlace: 'Place in Souls',
  },
  fr: {
    emptyLatest: "Aucune partie de Paige pour l'instant.",
    oneMatch: 'Ta dernière partie',
    threeMatches: 'Tes 3 dernières parties',
    tenMatches: 'Tes 10 dernières parties',
    win: 'Victoire',
    loss: 'Défaite',
    record: 'Victoires',
    kda: 'K / D / A moyen',
    average: '7,0 / 3,0 / 18,0',
    loading: 'Calcul du Bilan…',
    weaknesses: 'À travailler',
    strengths: 'Tes points forts',
    noWeakness: 'Aucun point faible récurrent',
    noStrength: 'Aucun point fort récurrent',
    weakness: 'point faible',
    strength: 'point fort',
    reviewEmpty:
      "Aucune partie analysée pour l'instant : le bilan se remplit après la prochaine synchronisation.",
    seeReview: 'Voir le Bilan complet',
    seeMatches: 'Toutes mes parties',
    reviewTitle: 'Bilan',
    matchesTitle: 'Parties',
    labels: { kda: 'KDA', accuracy: 'Précision', lastHits: 'Last hits', denies: 'Denies' },
    earlyDeaths: 'Morts en early',
    netWorthPlace: 'Place en Âmes',
  },
} as const;

/** What a test says about a match it adds to the synthetic history. */
interface MatchSpec {
  readonly matchId: number;
  /** How long before {@link NOW} the match started, in days. */
  readonly daysAgo: number;
  readonly won: boolean;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  /** Paige by default. */
  readonly heroId?: number;
  /** The normal game by default. */
  readonly gameMode?: number;
  /** Unranked by default. */
  readonly matchMode?: number;
}

/** A row of the history of deadlock-api, whose fields the specs of the matches replace. */
const TEMPLATE_ROW: RawMatchHistoryRow = {
  account_id: FIXTURE_ACCOUNT_ID,
  match_id: 100_000_000,
  hero_id: PAIGE_HERO_ID,
  hero_level: 30,
  start_time: 0,
  game_mode: NORMAL_GAME_MODE,
  match_mode: UNRANKED_MATCH_MODE,
  player_team: 0,
  player_kills: 0,
  player_deaths: 0,
  player_assists: 0,
  denies: 10,
  net_worth: 30_000,
  last_hits: 150,
  team_abandoned: null,
  abandoned_time_s: null,
  match_duration_s: 1_800,
  match_result: 0,
  objectives_mask_team0: 0,
  objectives_mask_team1: 0,
  brawl_score_team0: null,
  brawl_score_team1: null,
  brawl_avg_round_time_s: null,
  ranked_display_badge: null,
  ranked_delta: null,
  ranked_calibration_match: null,
  ranked_used_demotion_protection: null,
  player_match_outcome: 0,
};

/**
 * Write a match as deadlock-api sends it. The player is on team 0, and the winning team is 0 for a
 * win and 1 for a loss: the rule the app reads.
 *
 * @param spec - What the test says about the match.
 * @returns The row.
 */
function toRow(spec: MatchSpec): RawMatchHistoryRow {
  return {
    ...TEMPLATE_ROW,
    match_id: spec.matchId,
    hero_id: spec.heroId ?? PAIGE_HERO_ID,
    // An hour earlier than the exact age: no match sits on the edge of a day.
    start_time: Math.floor(NOW / 1000) - spec.daysAgo * DAY_S - 3_600,
    game_mode: spec.gameMode ?? NORMAL_GAME_MODE,
    match_mode: spec.matchMode ?? UNRANKED_MATCH_MODE,
    match_result: spec.won ? 0 : 1,
    player_kills: spec.kills,
    player_deaths: spec.deaths,
    player_assists: spec.assists,
  };
}

/**
 * Three normal-mode Paige matches, newest first: 2 wins out of 3, and 21 kills, 9 deaths and 54
 * assists in all, which average 7.0 / 3.0 / 18.0. The second one is ranked: the figures count both
 * modes.
 */
const THREE_PAIGE_MATCHES: readonly MatchSpec[] = [
  { matchId: 100_000_001, daysAgo: 1, won: true, kills: 9, deaths: 3, assists: 15 },
  {
    matchId: 100_000_002,
    daysAgo: 2,
    won: true,
    kills: 6,
    deaths: 4,
    assists: 21,
    matchMode: RANKED_MATCH_MODE,
  },
  { matchId: 100_000_003, daysAgo: 3, won: false, kills: 6, deaths: 2, assists: 18 },
];

/** What the dashboard must leave out, though it is recent: a Street Brawl match and another hero. */
const IGNORED_MATCHES: readonly MatchSpec[] = [
  {
    matchId: 100_000_004,
    daysAgo: 0,
    won: true,
    kills: 40,
    deaths: 0,
    assists: 40,
    gameMode: STREET_BRAWL_GAME_MODE,
  },
  {
    matchId: 100_000_005,
    daysAgo: 0,
    won: true,
    kills: 20,
    deaths: 0,
    assists: 20,
    heroId: INFERNUS_HERO_ID,
  },
];

/**
 * Twelve lost Paige matches, newest first, one a day: two more than the dashboard shows.
 *
 * @returns The matches.
 */
function twelveMatches(): readonly MatchSpec[] {
  return Array.from({ length: 12 }, (_, index) => ({
    matchId: 100_000_100 + index,
    daysAgo: index + 1,
    won: false,
    kills: 1,
    deaths: 1,
    assists: 1,
  }));
}

/**
 * The synthetic deadlock-api, except that the history of the account is the one given. Every match
 * detail is a 404, which keeps the synchronisation from compressing and archiving the Paige matches
 * (seconds of work that are not what these tests are about).
 *
 * @param matches - The matches of the account, most recent first.
 * @returns The handler.
 */
function historyOf(matches: readonly MatchSpec[]): FixtureHandler {
  const rows = matches.map(toRow);
  const historyUrl = matchHistoryRequest(FIXTURE_ACCOUNT_ID).url;
  // No history of its own: the fixtures only answer what the test does not.
  const fixtures = createFixtureApi({ now: NOW, matchCount: 0 });
  return (request) => {
    if (request.url === historyUrl) {
      return jsonResponse(rows, 200, { 'called-steam': 'true' });
    }
    return /\/v1\/matches\/\d+\/metadata/.test(request.url)
      ? jsonResponse({ status: 404, error: 'Match not found' }, 404)
      : fixtures(request);
  };
}

/**
 * Render the application on a URL, on services already built.
 *
 * @param test - The services of the test.
 * @param url - The initial URL, e.g. `/dashboard`.
 * @param language - Language of the interface.
 * @returns The test services, the query client of the page, the router, and a simulated user.
 */
async function renderPage(test: TestServices, url = '/dashboard', language: Language = 'en') {
  const queryClient = createTestQueryClient(test.logger);
  const i18n = await createI18n(language);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
  render(
    <AppProviders services={test.services} queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...test, queryClient, router, user: userEvent.setup() };
}

/**
 * Render the application on a URL, on services built for it.
 *
 * @param url - The initial URL, e.g. `/dashboard`.
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @param language - Language of the interface.
 * @returns What {@link renderPage} returns.
 */
async function renderDashboard(
  url: string,
  options: TestServicesOptions = {},
  language: Language = 'en',
) {
  return renderPage(createTestServices({ now: () => NOW, ...options }), url, language);
}

/**
 * Build the services of an account whose history is the given matches, and synchronise it, so that
 * the matches are stored when the page opens.
 *
 * @param matches - The matches of the account, most recent first.
 * @returns The test services.
 */
async function setUp(matches: readonly MatchSpec[]): Promise<TestServices> {
  const test = createTestServices({ now: () => NOW, handler: historyOf(matches) });
  await test.services.sync.syncNow('startup');
  return test;
}

/**
 * Render the dashboard of an account whose history is the given matches.
 *
 * @param matches - The matches of the account, most recent first.
 * @param language - Language of the interface.
 * @returns What {@link renderPage} returns.
 */
async function renderSynchronised(matches: readonly MatchSpec[], language: Language = 'en') {
  return renderPage(await setUp(matches), '/dashboard', language);
}

/** A tile of the figures: its label and its value, as the player reads them. */
type Tile = readonly [label: string, value: string];

/**
 * Read the tiles of the figures, in reading order.
 *
 * @returns A label and a value for each tile.
 */
function readTiles(): Tile[] {
  return screen.queryAllByRole('term').map((term): Tile => {
    const value = term.nextElementSibling?.textContent ?? expect.unreachable('A term has a value');
    return [term.textContent, value];
  });
}

/**
 * The links of the row of results, in the order of the row.
 *
 * @param title - The title of the section of the results.
 * @returns The links.
 */
function resultLinks(title: string): HTMLElement[] {
  const section = screen.getByRole('region', { name: title });
  return within(within(section).getByRole('list')).getAllByRole('link');
}

/**
 * A row of the review for a point, with no match behind it.
 *
 * @param subject - The point.
 * @param side - The side of the summary the point is on.
 * @returns The row.
 */
function rowOf(subject: ReviewSubject, side: 'weakness' | 'strength'): ReviewRow {
  return {
    subject,
    unit: 'deaths',
    better: 'lower',
    value: 1.6,
    count: 18,
    comparedValue: 1.6,
    reference: 1.3,
    difference: { kind: 'absolute', amount: 0.3 },
    gapWithinNoise: false,
    weak: 7,
    strong: 2,
    marked: 18,
    side,
    progress: { before: 1.8, direction: 'better' },
    matches: [],
  };
}

/** A weakness about a metric of the match page, which the review lists on its stats tab. */
const metricRow = (
  key: 'kda' | 'accuracy' | 'last_hits' | 'denies',
  side: 'weakness' | 'strength',
) => rowOf({ kind: 'metric', key }, side);

/** A weakness about the deaths of a phase, which the review lists on its deaths tab. */
const deathsRow = rowOf({ kind: 'phase_deaths', phase: 'early' }, 'weakness');

/** A strength about a place among the players, which the review lists on its players tab. */
const placeRow = rowOf({ kind: 'place', stat: 'netWorth' }, 'strength');

/**
 * Serve a review written by hand: the dashboard reads the summary of it, and the community data is
 * complete, so that no download is asked for.
 *
 * @param test - The services of the test.
 * @param summary - The summary of the review.
 */
function serveSummary(test: TestServices, summary: Review['summary']): void {
  const view: ReviewView = {
    kind: 'ready',
    review: {
      summary,
      community: {
        kind: 'available',
        rank: { kind: 'tier', tier: 5 },
        comparedWith: 'tier_above',
        itemStats: { kind: 'fresh', fetchedAt: NOW },
        fallbackMatches: 0,
        missingMatches: 0,
        unusableMatches: 0,
        stale: false,
        fetchedAt: NOW,
      },
    } as Review,
  };
  vi.spyOn(test.services.review, 'getReview').mockResolvedValue(view);
}

/** Lets a test hold the answer of a read until it decides to release it. */
function gate<T>() {
  let release: (answer: T) => void = () => undefined;
  const answered = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { answered, release };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DashboardPage', () => {
  it.each([
    {
      language: 'en',
      heading: 'Dashboard',
      title: 'Link your Steam account',
      description: 'Link your Steam account so TheLibrary can analyse your matches.',
      button: 'Link my Steam account',
      dialog: 'Link your Steam account',
    },
    {
      language: 'fr',
      heading: 'Tableau de bord',
      title: 'Lier ton compte Steam',
      description: "Lier ton compte Steam permet à TheLibrary d'analyser tes parties.",
      button: 'Lier mon compte Steam',
      dialog: 'Lier ton compte Steam',
    },
  ] as const)(
    'invites to link an account, in $language',
    async ({ language, heading, title, description, button, dialog }) => {
      const { http, user } = await renderDashboard('/dashboard', { accountId: null }, language);

      expect(await screen.findByRole('heading', { level: 2, name: title })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      // Nothing to synchronise, no results and no review: only the way to link an account.
      expect(screen.queryByRole('term')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(http.requests).toEqual([]);

      // The button is the real one: it opens the dialog of the sign-in. The sidebar has a button of
      // the same name, so the one of the page is looked for in the page content only.
      await user.click(within(screen.getByRole('main')).getByRole('button', { name: button }));
      expect(await screen.findByRole('dialog', { name: dialog })).toBeInTheDocument();
    },
  );

  it('says the account is loading', async () => {
    const { answered, release } = gate<null>();
    vi.spyOn(AccountService.prototype, 'getLinkedAccount').mockReturnValue(answered);
    await renderDashboard('/dashboard');

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    // Neither the invitation nor the numbers can be told before the account is known.
    expect(screen.queryByRole('button', { name: 'Link my Steam account' })).not.toBeInTheDocument();

    release(null);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Link your Steam account' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('says why the account cannot be read, without inviting to link another', async () => {
    vi.spyOn(AccountService.prototype, 'getLinkedAccount').mockRejectedValue(
      new AppError('storage', 'The linked account cannot be read'),
    );
    await renderDashboard('/dashboard');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    // An account that cannot be read is not an account that is missing: linking another one over it
    // would be the wrong advice.
    expect(screen.queryByRole('button', { name: 'Link my Steam account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
  });

  it('shows the synchronisation banner once an account is linked', async () => {
    await renderDashboard('/dashboard');

    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    // The invitation is for a user without an account.
    expect(screen.queryByRole('button', { name: 'Link my Steam account' })).not.toBeInTheDocument();
  });

  it('ignores the period and the hero of an old address', async () => {
    await renderDashboard('/dashboard?period=7d&hero=1');

    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('says there is no Paige match yet, in %s', async (language) => {
    const strings = STRINGS[language];
    // A match of another hero and one of Street Brawl are not Paige matches of the normal game.
    await renderSynchronised(IGNORED_MATCHES, language);

    expect(await screen.findByText(strings.emptyLatest)).toBeInTheDocument();
    // No row of results and no figures of nothing.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)(
    'shows the results of the last matches newest first, each opening its match, in %s',
    async (language) => {
      const strings = STRINGS[language];
      const { user, router } = await renderSynchronised(
        [...IGNORED_MATCHES, ...THREE_PAIGE_MATCHES],
        language,
      );

      await screen.findByRole('region', { name: strings.threeMatches });
      const links = resultLinks(strings.threeMatches);
      // Newest first: a win, a win, then the loss. The words are the ones a screen reader says, as
      // the letter of the badge is for the eyes.
      expect(links).toHaveLength(3);
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '/matches/100000001',
        '/matches/100000002',
        '/matches/100000003',
      ]);
      // Each link says which match it opens: the result, then the day and time of the match.
      const startOf = (spec: MatchSpec) =>
        new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
          toRow(spec).start_time * 1000,
        );
      const expected = [
        [strings.win, THREE_PAIGE_MATCHES[0]],
        [strings.win, THREE_PAIGE_MATCHES[1]],
        [strings.loss, THREE_PAIGE_MATCHES[2]],
      ] as const;
      expected.forEach(([word, spec], index) => {
        expect(links[index]).toHaveAccessibleName(
          expect.stringContaining(`${word}, ${startOf(spec ?? expect.unreachable())}`),
        );
      });

      // The link really opens the match.
      await user.click(links[2] ?? expect.unreachable());
      expect(router.state.location.pathname).toBe('/matches/100000003');
    },
  );

  it('shows the matches a synchronisation stores, without reopening the page', async () => {
    // The history of the account grows between the two synchronisations.
    let history: readonly MatchSpec[] = THREE_PAIGE_MATCHES.slice(0, 1);
    const handler = (request: Parameters<FixtureHandler>[0]) => historyOf(history)(request);
    const test = createTestServices({ now: () => NOW, handler });
    await test.services.sync.syncNow('startup');
    const { user } = await renderPage(test);

    expect(await screen.findByRole('region', { name: STRINGS.en.oneMatch })).toBeInTheDocument();
    expect(readTiles()).toEqual([
      [STRINGS.en.record, '1 / 1'],
      [STRINGS.en.kda, '9.0 / 3.0 / 15.0'],
    ]);

    history = THREE_PAIGE_MATCHES;
    await clickSyncNow(user);
    await waitUntilIdle(test.services.sync);

    // The results and the figures follow the synchronisation: the same page now sums up three.
    expect(
      await screen.findByRole('region', { name: STRINGS.en.threeMatches }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: STRINGS.en.oneMatch })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(readTiles()).toEqual([
        [STRINGS.en.record, '2 / 3'],
        [STRINGS.en.kda, STRINGS.en.average],
      ]);
    });
  });

  it.each([
    { language: 'en', title: 'Your last match' },
    { language: 'fr', title: 'Ta dernière partie' },
  ] as const)('titles one match by its count, in $language', async ({ language, title }) => {
    await renderSynchronised(THREE_PAIGE_MATCHES.slice(0, 1), language);

    expect(await screen.findByRole('region', { name: title })).toBeInTheDocument();
    expect(resultLinks(title)).toHaveLength(1);
  });

  it.each(LANGUAGES)('titles fewer than 10 matches by their count, in %s', async (language) => {
    await renderSynchronised(THREE_PAIGE_MATCHES, language);

    expect(
      await screen.findByRole('region', { name: STRINGS[language].threeMatches }),
    ).toBeInTheDocument();
  });

  it('shows the 10 latest matches and no more', async () => {
    await renderSynchronised(twelveMatches());

    expect(await screen.findByRole('region', { name: STRINGS.en.tenMatches })).toBeInTheDocument();
    const links = resultLinks(STRINGS.en.tenMatches);
    expect(links).toHaveLength(10);
    expect(links[0]).toHaveAttribute('href', '/matches/100000100');
    expect(links[9]).toHaveAttribute('href', '/matches/100000109');
  });

  it.each(LANGUAGES)(
    'shows the wins and the average K/D/A of the last matches, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderSynchronised([...IGNORED_MATCHES, ...THREE_PAIGE_MATCHES], language);

      await screen.findByRole('region', { name: strings.threeMatches });
      // Two wins out of three, and the averages with one decimal in the writing of the language.
      expect(readTiles()).toEqual([
        [strings.record, '2 / 3'],
        [strings.kda, strings.average],
      ]);
    },
  );

  it.each(LANGUAGES)('shows the figures before the review is computed, in %s', async (language) => {
    const strings = STRINGS[language];
    const test = await setUp(THREE_PAIGE_MATCHES);
    const { answered, release } = gate<ReviewView>();
    vi.spyOn(test.services.review, 'getReview').mockReturnValue(answered);
    await renderPage(test, '/dashboard', language);

    // The review is not there yet, and the page says so; the results and the figures do not wait
    // for it.
    expect(await screen.findByRole('region', { name: strings.threeMatches })).toBeInTheDocument();
    expect(readTiles()).toHaveLength(2);
    expect(screen.getByText(strings.loading)).toBeInTheDocument();

    release({ kind: 'empty' });
    expect(await screen.findByText(strings.reviewEmpty)).toBeInTheDocument();
    expect(screen.queryByText(strings.loading)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)(
    'shows three weaknesses and three strengths of the review, each opening its tab, in %s',
    async (language) => {
      const strings = STRINGS[language];
      const test = await setUp(THREE_PAIGE_MATCHES);
      // Four of each: the dashboard keeps the first three, in the order the review gives them.
      serveSummary(test, {
        weaknesses: [
          metricRow('last_hits', 'weakness'),
          deathsRow,
          metricRow('kda', 'weakness'),
          metricRow('accuracy', 'weakness'),
        ],
        strengths: [
          placeRow,
          metricRow('denies', 'strength'),
          metricRow('accuracy', 'strength'),
          metricRow('kda', 'strength'),
        ],
      });
      await renderPage(test, '/dashboard', language);

      const weaknesses = await screen.findByRole('region', { name: strings.weaknesses });
      const strengths = screen.getByRole('region', { name: strings.strengths });
      // What a row says (its arrow, its name, the hidden word of its side) and where it leads.
      const linksOf = (section: HTMLElement) =>
        within(section)
          .getAllByRole('listitem')
          .map((item) => [item.textContent, within(item).getByRole('link').getAttribute('href')]);
      expect(linksOf(weaknesses)).toEqual([
        [`▼${strings.labels.lastHits} ${strings.weakness}`, '/review?tab=stats'],
        [`▼${strings.earlyDeaths} ${strings.weakness}`, '/review?tab=deaths'],
        [`▼${strings.labels.kda} ${strings.weakness}`, '/review?tab=stats'],
      ]);
      expect(linksOf(strengths)).toEqual([
        [`▲${strings.netWorthPlace} ${strings.strength}`, '/review?tab=players'],
        [`▲${strings.labels.denies} ${strings.strength}`, '/review?tab=stats'],
        [`▲${strings.labels.accuracy} ${strings.strength}`, '/review?tab=stats'],
      ]);
    },
  );

  it.each(LANGUAGES)('shows only the points the review has, in %s', async (language) => {
    const strings = STRINGS[language];
    const test = await setUp(THREE_PAIGE_MATCHES);
    serveSummary(test, { weaknesses: [metricRow('kda', 'weakness')], strengths: [] });
    await renderPage(test, '/dashboard', language);

    const weaknesses = await screen.findByRole('region', { name: strings.weaknesses });
    expect(within(weaknesses).getAllByRole('link')).toHaveLength(1);
    // A side with no point says so, as the review does, and has no empty list.
    const strengths = screen.getByRole('region', { name: strings.strengths });
    expect(within(strengths).getByText(strings.noStrength)).toBeInTheDocument();
    expect(within(strengths).queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(strings.noWeakness)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('says the review is empty, in %s', async (language) => {
    const strings = STRINGS[language];
    await renderSynchronised(THREE_PAIGE_MATCHES, language);

    // The details are not downloaded, so no match is analysed: the review has nothing to sum up.
    expect(await screen.findByText(strings.reviewEmpty)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: strings.weaknesses })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: strings.strengths })).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('links to the full review and to all matches, in %s', async (language) => {
    const strings = STRINGS[language];
    const { user } = await renderSynchronised(THREE_PAIGE_MATCHES, language);

    const main = within(await screen.findByRole('main'));
    await user.click(await main.findByRole('link', { name: strings.seeReview }));
    expect(
      await screen.findByRole('heading', { level: 1, name: strings.reviewTitle }),
    ).toBeInTheDocument();

    // Back to the dashboard, then to the history.
    await user.click(
      within(screen.getByRole('navigation')).getByRole('link', {
        name: language === 'en' ? 'Dashboard' : 'Tableau de bord',
      }),
    );
    await user.click(await main.findByRole('link', { name: strings.seeMatches }));
    expect(
      await screen.findByRole('heading', { level: 1, name: strings.matchesTitle }),
    ).toBeInTheDocument();
  });
});

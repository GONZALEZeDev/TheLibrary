/**
 * Tests of the dashboard screen, rendered inside the whole application (router, shell, providers) on
 * the development adapters: a synthetic deadlock-api and an in-memory database. The banner has its
 * own tests (`SyncBanner.test.tsx`) and so has the link button (`LinkSteamDialog.test.tsx`): these
 * check that the dashboard puts them where the player needs them, and that the numbers follow the
 * account, the period and the hero.
 *
 * The texts each language must say are written out in full below, not read from the catalogues: they
 * are what the player reads, and a test that took them from the catalogue would pass whatever the
 * catalogue says.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
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
import { PAIGE_HERO_ID, type HeroId } from '../../../core/domain/hero';
import type { Period } from '../../../core/domain/period';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import { AccountService } from '../../../services/account.service';
import { MatchesService, type PeriodSummary } from '../../../services/matches.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { clickSyncNow, waitUntilIdle } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { createI18n } from '../../i18n/i18n';
import { MATCHES_QUERY_KEY } from '../matches/use-matches';

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
    // An hour earlier than the exact age: no match sits on the edge of a period.
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
 * The normal-mode Paige matches of the last 7 days: 2 wins out of 3, and 21 kills, 9 deaths and 54
 * assists in all. One of them is ranked: the numbers count both modes.
 */
const RECENT_PAIGE_MATCHES: readonly MatchSpec[] = [
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

/** What the numbers must leave out, though it is recent: a Street Brawl match and another hero. */
const IGNORED_RECENT_MATCHES: readonly MatchSpec[] = [
  {
    matchId: 100_000_004,
    daysAgo: 1,
    won: true,
    kills: 40,
    deaths: 0,
    assists: 40,
    gameMode: STREET_BRAWL_GAME_MODE,
  },
  {
    matchId: 100_000_005,
    daysAgo: 1,
    won: true,
    kills: 20,
    deaths: 0,
    assists: 20,
    heroId: INFERNUS_HERO_ID,
  },
];

/**
 * Normal-mode Paige matches older than a week: a win 10 days ago, a loss 20 days ago and a win 60
 * days ago (3 kills, 3 deaths and 3 assists each). A longer period holds more of them.
 */
const OLDER_PAIGE_MATCHES: readonly MatchSpec[] = [
  { matchId: 100_000_006, daysAgo: 10, won: true, kills: 3, deaths: 3, assists: 3 },
  { matchId: 100_000_007, daysAgo: 20, won: false, kills: 3, deaths: 3, assists: 3 },
  { matchId: 100_000_008, daysAgo: 60, won: true, kills: 3, deaths: 3, assists: 3 },
];

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
 * Render the application on a URL.
 *
 * @param url - The initial URL, e.g. `/dashboard?period=7d`.
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @param language - Language of the interface.
 * @returns The test services, the query client of the page, and a simulated user.
 */
async function renderDashboard(
  url: string,
  options: TestServicesOptions = {},
  language: Language = 'en',
) {
  const testServices = createTestServices({ now: () => NOW, ...options });
  const queryClient = createTestQueryClient(testServices.logger);
  const i18n = await createI18n(language);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
  render(
    <AppProviders services={testServices.services} queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...testServices, queryClient, user: userEvent.setup() };
}

/** A tile of the numbers: its label and its value, as the player reads them. */
type Tile = readonly [label: string, value: string];

/**
 * Read the tiles of the numbers, in reading order.
 *
 * The space CLDR puts before a percent sign (French writes "67 %") is a no-break space, and which
 * one (U+00A0 or U+202F) depends on the version of ICU that Node ships: both are read as a plain
 * space, so that the tests give the same verdict on every supported Node.
 *
 * @returns A label and a value for each tile; throws when there is none.
 */
function readTiles(): Tile[] {
  return screen.getAllByRole('term').map((term): Tile => {
    const value = term.nextElementSibling?.textContent ?? expect.unreachable('A term has a value');
    return [term.textContent, value.replace(/[\u00a0\u202f]/g, ' ')];
  });
}

/**
 * The tiles the player reads, in English.
 *
 * @param values - The four values, in the order of the tiles.
 * @returns The tiles.
 */
function englishTiles(values: readonly [string, string, string, string]): Tile[] {
  const labels = ['Matches played', 'Wins', 'Win rate', 'Average K / D / A'] as const;
  return labels.map((label, index): Tile => [label, values[index] ?? expect.unreachable()]);
}

/**
 * Wait until the numbers of a period have been read again since the matches last changed.
 *
 * The end of a synchronisation invalidates the matches queries, the numbers of the period among
 * them, and the page reads them again: until then the page still shows what it showed before the
 * synchronisation. A test that expects the page to show nothing new (a period without a match) has
 * to wait for that read first, or it would pass whatever the numbers come to be.
 *
 * Call it once the synchronisation is over ({@link waitUntilIdle}): its last notification is what
 * invalidates the query, and it is sent before the synchronisation stops running.
 *
 * @param queryClient - The query client of the page.
 * @param period - The period of the numbers.
 * @param heroId - The hero of the numbers.
 */
async function waitUntilPeriodIsRead(
  queryClient: QueryClient,
  period: Period,
  heroId: HeroId,
): Promise<void> {
  await waitFor(() => {
    const state = queryClient.getQueryState([...MATCHES_QUERY_KEY, 'period', period, heroId]);
    // Read at least once, up to date (an invalidated query is not until its new answer is in), and
    // no read going on.
    expect(state?.status).toBe('success');
    expect(state?.isInvalidated).toBe(false);
    expect(state?.fetchStatus).toBe('idle');
  });
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
    'invites a new user to link their Steam account, in $language',
    async ({ language, heading, title, description, button, dialog }) => {
      const { http, user } = await renderDashboard('/dashboard', { accountId: null }, language);

      expect(await screen.findByRole('heading', { level: 2, name: title })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      // Nothing to synchronise and nothing to count: only the way to link an account.
      expect(screen.queryByRole('term')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
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

  it('shows the synchronisation and the numbers of the period once linked', async () => {
    const { services, user } = await renderDashboard('/dashboard', {
      handler: historyOf([...RECENT_PAIGE_MATCHES, ...IGNORED_RECENT_MATCHES]),
    });

    // Before the first synchronisation the banner says so, and the period has nothing in it.
    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(await screen.findByText('No match in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link my Steam account' })).not.toBeInTheDocument();

    await clickSyncNow(user);

    // Three Paige matches of the normal game: the Street Brawl match and the other hero's are left out.
    await waitFor(() => {
      expect(readTiles()).toEqual(englishTiles(['3', '2', '67%', '7.0 / 3.0 / 18.0']));
    });
    expect(await screen.findByText(/^Last synchronisation: /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Paige, last 30 days' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Normal-mode matches, unranked and ranked.')).toBeInTheDocument();
    expect(screen.queryByText('No match in this period.')).not.toBeInTheDocument();
    await waitUntilIdle(services.sync);
  });

  it.each([
    { period: '7d', days: 7, values: ['3', '2', '67%', '7.0 / 3.0 / 18.0'] },
    { period: '30d', days: 30, values: ['5', '3', '60%', '5.4 / 3.0 / 12.0'] },
    { period: '90d', days: 90, values: ['6', '4', '67%', '5.0 / 3.0 / 10.5'] },
  ] as const)('follows the period of the address: $period', async ({ period, days, values }) => {
    const { services, user } = await renderDashboard(`/dashboard?period=${period}`, {
      handler: historyOf([...RECENT_PAIGE_MATCHES, ...OLDER_PAIGE_MATCHES]),
    });

    await clickSyncNow(user);

    await waitFor(() => {
      expect(readTiles()).toEqual(englishTiles(values));
    });
    expect(
      screen.getByRole('heading', { level: 2, name: `Paige, last ${String(days)} days` }),
    ).toBeInTheDocument();
    await waitUntilIdle(services.sync);
  });

  it('follows the hero of the address', async () => {
    const { services, user } = await renderDashboard(
      `/dashboard?hero=${String(INFERNUS_HERO_ID)}`,
      {
        handler: historyOf([...RECENT_PAIGE_MATCHES, ...IGNORED_RECENT_MATCHES]),
      },
    );

    await clickSyncNow(user);

    // The one normal-mode match of Infernus, and the name of the hero comes from the catalogue.
    await waitFor(() => {
      expect(readTiles()).toEqual(englishTiles(['1', '1', '100%', '20.0 / 0.0 / 20.0']));
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Infernus, last 30 days' }),
    ).toBeInTheDocument();
    await waitUntilIdle(services.sync);
  });

  it('names a hero the catalogue does not know by its id', async () => {
    await renderDashboard('/dashboard?hero=999');

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Hero #999, last 30 days' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('No match in this period.')).toBeInTheDocument();
  });

  it('says when the period has no match', async () => {
    const { services, queryClient, user } = await renderDashboard('/dashboard?period=7d', {
      handler: historyOf(OLDER_PAIGE_MATCHES),
    });
    // Before the synchronisation there is no match at all: the numbers are already read.
    expect(await screen.findByText('No match in this period.')).toBeInTheDocument();

    await clickSyncNow(user);

    expect(await screen.findByText(/^Last synchronisation: /)).toBeInTheDocument();
    await waitUntilIdle(services.sync);
    // The matches are stored, but none is in the last 7 days: a sentence, not a row of zeros. The
    // page must have read the numbers again since the matches arrived: until it has, it shows what
    // it showed before the synchronisation, and the assertions below would hold whatever it counts.
    await expect(services.matches.listRecent(10)).resolves.toMatchObject({ total: 3 });
    await waitUntilPeriodIsRead(queryClient, '7d', PAIGE_HERO_ID);
    expect(screen.getByText('No match in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Paige, last 7 days' }),
    ).toBeInTheDocument();
  });

  it('says the numbers are loading', async () => {
    const { answered, release } = gate<PeriodSummary>();
    vi.spyOn(MatchesService.prototype, 'getPeriodSummary').mockReturnValue(answered);
    await renderDashboard('/dashboard');

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    // The banner does not wait for the numbers.
    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();

    release({ kind: 'empty' });
    expect(await screen.findByText('No match in this period.')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('says why the numbers cannot be shown when they cannot be read', async () => {
    vi.spyOn(MatchesService.prototype, 'getPeriodSummary').mockRejectedValue(
      new AppError('storage', 'The matches cannot be summed up'),
    );
    await renderDashboard('/dashboard');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    // The rest of the screen is still there, and no number is made up.
    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
  });

  it('speaks French, with the numbers written the French way', async () => {
    const { services, user } = await renderDashboard(
      '/dashboard',
      { handler: historyOf([...RECENT_PAIGE_MATCHES, ...IGNORED_RECENT_MATCHES]) },
      'fr',
    );

    await clickSyncNow(user, 'Synchroniser');

    await waitFor(() => {
      expect(readTiles()).toEqual([
        ['Parties jouées', '3'],
        ['Victoires', '2'],
        ['Taux de victoire', '67 %'],
        ['K / D / A moyen', '7,0 / 3,0 / 18,0'],
      ]);
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Paige, 30 derniers jours' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Parties en mode normal, classées ou non.')).toBeInTheDocument();
    await waitUntilIdle(services.sync);
  });
});

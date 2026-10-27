/**
 * Tests of the match history screen, rendered inside the whole application (router, shell,
 * providers) on the development adapters: synthetic deadlock-api and in-memory database. The
 * banner has its own tests (`SyncBanner.test.tsx`), and so has the windowing hook
 * (`use-windowed-rows.test.tsx`).
 *
 * The days are told against the clock of the machine, as the page tells them; the services keep
 * their fixed clock ({@link NOW}), which only decides which matches are in the 90-day window of the
 * archive.
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi, jsonResponse } from '../../../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
} from '../../../adapters/dev/fixtures/match-history.fixture';
import { isMetadataMissing } from '../../../adapters/dev/fixtures/match-metadata.fixture';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { parseMatchId, type MatchSummary } from '../../../core/domain/match';
import { AppError } from '../../../core/errors/app-error';
import type { DetailStatus } from '../../../core/match-detail/detail-status';
import type { Language } from '../../../core/settings/language';
import { MatchesRepository } from '../../../services/matches.repository';
import {
  MatchesService,
  type HistoryView,
  type MatchListItem,
} from '../../../services/matches.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { matchSummary } from '../../../test/test-data';
import { clickSyncNow, waitUntilIdle } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { formatMediumDate, formatTime, localDayKey, MS_PER_SECOND } from '../../format/date';
import { createI18n } from '../../i18n/i18n';

/** Time of the services: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Size of the synthetic history of the tests that do not need a long one. A synchronisation also
 * downloads and archives the details of its Paige matches, which a longer history makes slow (two
 * seconds for the default 240 matches); this one has four of them.
 */
const MATCH_COUNT = 12;

/**
 * Size of the synthetic history of the tests of the Detail column. It is the smallest one that holds
 * a Paige match whose detail deadlock-api does not have (the 14th match of the fixtures), next to
 * Paige matches whose detail it has: {@link expectedDetailRows} checks that the history offers both.
 */
const DETAIL_MATCH_COUNT = 14;

/**
 * How long a test waits for a link to show its matches, in milliseconds. A link is a chain of
 * services (the listener, Steam, the profile, the database, then the first synchronisation), not a
 * single read: the default of Testing Library (one second) is too tight for a busy machine.
 */
const LINK_WAIT_MS = 4_000;

/** Height of a row of the list, in pixels: the one the page windows its rows with. */
const ROW_HEIGHT_PX = 44;

/** Rows the page renders when `<main>` reports no height, as in jsdom. */
const MIN_RENDERED_ROWS = 30;

/** Rows the page renders above and below the visible ones. */
const OVERSCAN_ROWS = 10;

/** What the page says, in one language: written in full, never read from the catalogues. */
interface PageStrings {
  readonly language: Language;
  /** The name of the list. */
  readonly caption: string;
  /** The headers of the columns, in order. */
  readonly columns: readonly string[];
  readonly today: string;
  readonly yesterday: string;
  readonly win: string;
  readonly loss: string;
  readonly ranked: string;
  /** The labels of the Detail column. */
  readonly detail: Readonly<Record<'archived' | 'waiting' | 'unavailable' | 'invalid', string>>;
  readonly evicted: string;
  /** The hidden text of a match the app does not archive. */
  readonly notArchived: string;
  readonly filters: string;
  readonly resultLegend: string;
  readonly heroLegend: string;
  readonly allResults: string;
  readonly wins: string;
  readonly losses: string;
  readonly paige: string;
  readonly allHeroes: string;
  readonly filteredEmpty: string;
  /** The title of the empty history. */
  readonly empty: string;
}

/** The page in English. */
const EN: PageStrings = {
  language: 'en',
  caption: 'Matches',
  columns: ['Time', 'Type', 'Hero', 'Result', 'K / D / A', 'Duration', 'Detail'],
  today: 'Today',
  yesterday: 'Yesterday',
  win: 'Win',
  loss: 'Loss',
  ranked: 'Ranked',
  detail: {
    archived: 'Archived',
    waiting: 'Waiting',
    unavailable: 'Unavailable',
    invalid: 'Invalid',
  },
  evicted: 'Archive removed',
  notArchived: 'not archived',
  filters: 'Filters',
  resultLegend: 'Result',
  heroLegend: 'Hero',
  allResults: 'All',
  wins: 'Wins',
  losses: 'Losses',
  paige: 'Paige',
  allHeroes: 'All heroes',
  filteredEmpty: 'No match fits these filters.',
  empty: 'No matches yet',
};

/** The page in French. */
const FR: PageStrings = {
  language: 'fr',
  caption: 'Parties',
  columns: ['Heure', 'Type', 'Héros', 'Résultat', 'K / D / A', 'Durée', 'Détail'],
  today: "Aujourd'hui",
  yesterday: 'Hier',
  win: 'Victoire',
  loss: 'Défaite',
  ranked: 'Classée',
  detail: {
    archived: 'Archivée',
    waiting: 'En attente',
    unavailable: 'Indisponible',
    invalid: 'Invalide',
  },
  evicted: 'Archive supprimée',
  notArchived: 'non archivée',
  filters: 'Filtres',
  resultLegend: 'Résultat',
  heroLegend: 'Héros',
  allResults: 'Toutes',
  wins: 'Victoires',
  losses: 'Défaites',
  paige: 'Paige',
  allHeroes: 'Tous les héros',
  filteredEmpty: 'Aucune partie ne correspond à ces filtres.',
  empty: "Aucune partie pour l'instant",
};

/** Both languages, for the tests that run in each. */
const LANGUAGES = [EN, FR] as const;

/** One match of the list, and the text of its cell in the Detail column. */
interface DetailRow {
  readonly matchId: number;
  /** What the cell says to a screen reader: "not archived" when the match has no detail. */
  readonly detail: string;
}

/**
 * What the Detail column must show once the synchronisation has archived what it can, worked out
 * from the synthetic fixtures and not from the application.
 *
 * Every match of the fixtures is a normal-mode match of the 90 days before `now`, so every Paige
 * match is one the app archives: it is "archived" when deadlock-api has its detail, and "waiting" for
 * its first retry when it does not (one match in seven, see `isMetadataMissing`). The matches of the
 * other heroes have no detail at all.
 *
 * @param matchCount - Size of the synthetic history.
 * @param now - End of the synthetic history, and time of the application (Unix ms).
 * @param strings - The page, in the language of the interface.
 * @returns A row per match, most recent first like the list.
 */
function expectedDetailRows(matchCount: number, now: number, strings: PageStrings): DetailRow[] {
  const rows = createMatchHistoryFixture({ now, count: matchCount }).map((row): DetailRow => {
    if (row.hero_id !== PAIGE_HERO_ID) {
      return { matchId: row.match_id, detail: strings.notArchived };
    }
    const matchId = parseMatchId(row.match_id) ?? expect.unreachable();
    return {
      matchId,
      detail: isMetadataMissing(matchId) ? strings.detail.waiting : strings.detail.archived,
    };
  });
  // The history must hold what the tests are about, whatever the fixtures become.
  expect(rows.some((row) => row.detail === strings.detail.archived)).toBe(true);
  expect(rows.some((row) => row.detail === strings.detail.waiting)).toBe(true);
  expect(rows.some((row) => row.detail === strings.notArchived)).toBe(true);
  return rows;
}

/**
 * The text of an element as a screen reader says it: the hidden texts in, and what is hidden from
 * assistive technologies (the initial of a result badge) out.
 *
 * @param element - A cell of the list.
 * @returns Its spoken text.
 */
function spokenText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent;
}

/** One match of the list, and the spoken text of each of its cells. */
interface MatchRow {
  readonly matchId: number;
  /** The spoken text of the cells, in the order of the columns. */
  readonly cells: readonly string[];
}

/**
 * Read the match rows of the list (the day rows are left out).
 *
 * @param table - The list of the matches.
 * @returns A row per rendered match, in the order of the list, with the match its link opens.
 */
function readRows(table: HTMLElement): MatchRow[] {
  return within(table)
    .getAllByRole('row')
    .filter((row) => within(row).queryByRole('link') !== null)
    .map((row): MatchRow => {
      const href = within(row).getByRole('link').getAttribute('href') ?? '';
      const matchId = Number(/\/matches\/(\d+)$/.exec(href)?.[1]);
      const cells = within(row).getAllByRole('cell').map(spokenText);
      return { matchId, cells };
    });
}

/**
 * Read the rows of the list as a sequence: a day row by its label, a match row by its id.
 *
 * @param table - The list of the matches.
 * @returns `day:<label>` or `match:<id>` for each rendered row under the header row.
 */
function readSequence(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => {
      const header = within(row).queryByRole('rowheader');
      if (header !== null) {
        return `day:${header.textContent}`;
      }
      const href = within(row).getByRole('link').getAttribute('href') ?? '';
      return `match:${/\/matches\/(\d+)$/.exec(href)?.[1] ?? ''}`;
    });
}

/**
 * Read the Detail column of the list.
 *
 * @param table - The list of the matches.
 * @returns A row per match, in the order of the list.
 */
function readDetailRows(table: HTMLElement): DetailRow[] {
  return readRows(table).map(({ matchId, cells }): DetailRow => {
    // The Detail column is the seventh, after the duration.
    return { matchId, detail: cells[6] ?? expect.unreachable() };
  });
}

/** One match of the list, and the text of its cell in the Type column. */
interface TypeRow {
  readonly matchId: number;
  /** The text of the cell: empty when the app does not know the type of the match. */
  readonly type: string;
}

/**
 * Read the Type column of the list.
 *
 * @param table - The list of the matches.
 * @returns A row per match, in the order of the list.
 */
function readTypeRows(table: HTMLElement): TypeRow[] {
  return readRows(table).map(({ matchId, cells }): TypeRow => {
    // The Type column is the second, after the time.
    return { matchId, type: cells[1] ?? expect.unreachable() };
  });
}

/**
 * The heights of the spacers that stand for the rows left out of the window.
 *
 * @param table - The list of the matches.
 * @returns The height in pixels of each spacer, from the top of the list down.
 */
function spacerHeights(table: HTMLElement): number[] {
  return [...table.querySelectorAll('tr[aria-hidden="true"] > td')].map((cell) =>
    Number.parseFloat((cell as HTMLElement).style.height),
  );
}

/** The two mode codes that give a match its type (see `matchTypeOf`). */
interface ModeCodes {
  readonly gameMode: number;
  readonly matchMode: number;
}

/** The codes of a normal match: the normal game, unranked. */
const NORMAL_CODES: ModeCodes = { gameMode: 1, matchMode: 1 };

/** The codes of a ranked match: the normal game, ranked. */
const RANKED_CODES: ModeCodes = { gameMode: 1, matchMode: 4 };

/** The codes of a Street Brawl match: its own game mode. */
const STREET_BRAWL_CODES: ModeCodes = { gameMode: 4, matchMode: 1 };

/** The codes of a custom match: the private lobby match mode. */
const CUSTOM_CODES: ModeCodes = { gameMode: 1, matchMode: 2 };

/** One pair of codes for each type a match can have. */
const CODES_OF_EACH_TYPE: readonly ModeCodes[] = [
  NORMAL_CODES,
  RANKED_CODES,
  STREET_BRAWL_CODES,
  CUSTOM_CODES,
];

/** First synthetic match id of the rows the tests seed themselves; each next row takes one more. */
const FIRST_SEEDED_MATCH_ID = 100_000_001;

/**
 * Start of the most recent seeded match (Unix s): a day before {@link NOW}. Each next row starts an
 * hour earlier, so that the list shows the rows in the order they are given.
 */
const SEEDED_START_S = Math.floor(NOW / 1000) - 86_400;

/**
 * Build the matches of the player a test seeds in the database, one per pair of codes.
 *
 * @param modes - The two mode codes of each match, in the order the list must show them.
 * @returns Paige matches of the player of the test services, with consecutive ids from
 *   {@link FIRST_SEEDED_MATCH_ID}.
 */
function seededMatches(modes: readonly ModeCodes[]): MatchSummary[] {
  return modes.map(({ gameMode, matchMode }, index) =>
    matchSummary({
      accountId: FIXTURE_ACCOUNT_ID,
      matchId: FIRST_SEEDED_MATCH_ID + index,
      startTime: SEEDED_START_S - index * 3_600,
      gameMode,
      matchMode,
    }),
  );
}

/**
 * A local time of the clock of the machine, a number of days ago.
 *
 * @param daysAgo - 0 for today, 1 for yesterday…
 * @param hour - Local hour of the day.
 * @returns The time in Unix seconds.
 */
function localTimeDaysAgo(daysAgo: number, hour: number): number {
  const now = new Date();
  return (
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour).getTime() /
    MS_PER_SECOND
  );
}

/**
 * Serve the list from a mock of the service: the matches given, whatever the filter.
 *
 * @param matches - The matches of the list, with their detail status.
 */
function serveHistory(matches: readonly MatchListItem[]): void {
  vi.spyOn(MatchesService.prototype, 'listHistory').mockResolvedValue({
    kind: 'ready',
    total: matches.length,
    matches,
  });
}

/**
 * Render the application on the matches page.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @param language - Language of the interface.
 * @param matches - Matches to store before the page reads its list, see {@link seededMatches}.
 * @param url - The address the page opens at, with its search.
 * @returns The test services, and the router of the page; failed queries are logged to their
 *   `logger`.
 */
async function renderMatchesPage(
  options: TestServicesOptions = {},
  language: Language = 'en',
  matches: readonly MatchSummary[] = [],
  url = '/matches',
) {
  const testServices = createTestServices({ now: () => NOW, ...options });
  if (matches.length > 0) {
    await new MatchesRepository(testServices.database).upsertMany(matches);
  }
  const i18n = await createI18n(language);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
  render(
    <AppProviders
      services={testServices.services}
      queryClient={createTestQueryClient(testServices.logger)}
      i18n={i18n}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...testServices, router };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // A test that selects text (the click that ends a selection) must not leave it to the next one,
  // even when one of its assertions fails half way: the row click would then stop at the selection
  // guard and fail every later test for the wrong reason.
  window.getSelection()?.removeAllRanges();
});

describe('MatchesPage', () => {
  it('says the matches are loading', async () => {
    // The matches query waits until the test releases its answer.
    const gate: { release?: (answer: HistoryView) => void } = {};
    const answered = new Promise<HistoryView>((resolve) => {
      gate.release = resolve;
    });
    vi.spyOn(MatchesService.prototype, 'listHistory').mockReturnValue(answered);
    await renderMatchesPage();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading the matches…');

    gate.release?.({ kind: 'ready', total: 0, matches: [] });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'No matches yet' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading the matches…')).not.toBeInTheDocument();
  });

  it('says why the matches cannot be shown when they cannot be read', async () => {
    vi.spyOn(MatchesService.prototype, 'listHistory').mockRejectedValue(
      new AppError('storage', 'The matches cannot be read'),
    );
    await renderMatchesPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the matches shown when a later refresh fails', async () => {
    const user = userEvent.setup();
    const { services, logger } = await renderMatchesPage(
      { handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }) },
      'en',
      [],
      '/matches?hero=all',
    );
    await clickSyncNow(user);
    const table = await screen.findByRole('table', { name: EN.caption });
    await waitFor(() => {
      expect(readRows(table)).toHaveLength(MATCH_COUNT);
    });

    // Every read fails from now on: a synchronisation refreshes the matches when it starts and
    // when it ends, and a single failed read could be repaired by the next one.
    vi.spyOn(MatchesService.prototype, 'listHistory').mockRejectedValue(
      new AppError('storage', 'The matches cannot be read'),
    );
    await services.sync.syncNow('manual');

    // The failure of the refresh is logged by the query client: the refresh has failed by then.
    await waitFor(() => {
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          scope: 'query',
          context: expect.objectContaining({ query: 'matches.history.all.all' }) as unknown,
        }),
      );
    });
    expect(readRows(screen.getByRole('table', { name: EN.caption }))).toHaveLength(MATCH_COUNT);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains that no account is linked and contacts nobody', async () => {
    const { http } = await renderMatchesPage({ accountId: null });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: EN.filters })).not.toBeInTheDocument();
    expect(http.requests).toEqual([]);
  });

  it('links an account from the empty match list', async () => {
    const user = userEvent.setup();
    const { services } = await renderMatchesPage(
      { accountId: null, handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }) },
      'en',
      [],
      '/matches?hero=all',
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
    ).toBeInTheDocument();

    // The real button, in the empty state: the dialog explains, then Steam answers on Continue. The
    // sidebar has a button of the same name, so the one of the page is looked for in the page
    // content only.
    await user.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Link my Steam account' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    // The link starts the first synchronisation: the list shows the matches of the fixtures once
    // it has stored them, and the empty state is gone.
    const table = await screen.findByRole('table', { name: EN.caption }, { timeout: LINK_WAIT_MS });
    await waitFor(
      () => {
        expect(readDetailRows(table).map((row) => row.matchId)).toEqual(
          createMatchHistoryFixture({ now: NOW, count: MATCH_COUNT }).map((row) => row.match_id),
        );
      },
      { timeout: LINK_WAIT_MS },
    );
    expect(
      screen.queryByRole('heading', { level: 2, name: 'No account linked' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link my Steam account' })).not.toBeInTheDocument();
    // The test must not end under the background work of the link (the detail queue).
    await waitUntilIdle(services.sync, LINK_WAIT_MS);
  });

  it.each(LANGUAGES)('says the history is empty, in $language', async (strings) => {
    await renderMatchesPage({}, strings.language);

    expect(
      await screen.findByRole('heading', { level: 2, name: strings.empty }),
    ).toBeInTheDocument();
    // Nothing to filter: the filters come with the first match.
    expect(screen.queryByRole('group', { name: strings.filters })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)(
    'groups matches by local day with today and yesterday, in $language',
    async (strings) => {
      // Two matches today, one yesterday and one three days ago, by the clock of the machine.
      const times = [
        localTimeDaysAgo(0, 11),
        localTimeDaysAgo(0, 9),
        localTimeDaysAgo(1, 22),
        localTimeDaysAgo(3, 12),
      ];
      await renderMatchesPage(
        {},
        strings.language,
        times.map((startTime, index) =>
          matchSummary({
            accountId: FIXTURE_ACCOUNT_ID,
            matchId: FIRST_SEEDED_MATCH_ID + index,
            startTime,
          }),
        ),
      );
      const table = await screen.findByRole('table', { name: strings.caption });

      const id = (index: number) => `match:${String(FIRST_SEEDED_MATCH_ID + index)}`;
      expect(readSequence(table)).toEqual([
        `day:${strings.today}`,
        id(0),
        id(1),
        `day:${strings.yesterday}`,
        id(2),
        // An older day is written as a date, in the language of the interface.
        `day:${formatMediumDate(times[3] ?? expect.unreachable(), strings.language)}`,
        id(3),
      ]);
    },
  );

  it.each(LANGUAGES)(
    'shows the time, type, hero, result, K/D/A, duration and archive state of a match, in $language',
    async (strings) => {
      // A win today and a loss yesterday, by the clock of the machine.
      const win = matchSummary({ matchId: 1, startTime: localTimeDaysAgo(0, 11) });
      const loss = matchSummary({
        matchId: 2,
        startTime: localTimeDaysAgo(1, 10),
        won: false,
        kills: 2,
        deaths: 9,
        assists: 4,
        durationS: 1_805,
      });
      serveHistory([
        { ...win, detailStatus: 'ready' },
        { ...loss, detailStatus: 'pending' },
      ]);
      await renderMatchesPage({}, strings.language);
      const table = await screen.findByRole('table', { name: strings.caption });

      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((header) => header.textContent),
      ).toEqual(strings.columns);
      // The hero names come from the catalogue, read once the list knows it has matches.
      await within(table).findAllByText('Paige');
      // The time cell is the link of the match. Its name says the day before the time: a list of
      // the links of the page never shows two matches as the same bare time.
      const winTime = `${strings.today}, ${formatTime(win.startTime, strings.language)}`;
      const lossTime = `${strings.yesterday}, ${formatTime(loss.startTime, strings.language)}`;
      expect(within(table).getByRole('link', { name: winTime })).toHaveAttribute(
        'href',
        '/matches/1',
      );
      expect(within(table).getByRole('link', { name: lossTime })).toHaveAttribute(
        'href',
        '/matches/2',
      );
      expect(readRows(table)).toEqual([
        {
          matchId: 1,
          cells: [
            winTime,
            strings.ranked,
            'Paige',
            strings.win,
            '7 / 3 / 18',
            '34:30',
            strings.detail.archived,
          ],
        },
        {
          matchId: 2,
          cells: [
            lossTime,
            strings.ranked,
            'Paige',
            strings.loss,
            '2 / 9 / 4',
            '30:05',
            strings.detail.waiting,
          ],
        },
      ]);
    },
  );

  it.each(LANGUAGES)('labels an evicted match, in $language', async (strings) => {
    serveHistory([{ ...matchSummary({ matchId: 1 }), detailStatus: 'evicted' }]);
    await renderMatchesPage({}, strings.language);
    const table = await screen.findByRole('table', { name: strings.caption });

    expect(readDetailRows(table)).toEqual([{ matchId: 1, detail: strings.evicted }]);
  });

  it.each(LANGUAGES)(
    'tells a screen reader a match is not archived, in $language',
    async (strings) => {
      // A custom match: the app does not archive it.
      await renderMatchesPage({}, strings.language, seededMatches([CUSTOM_CODES]));
      const table = await screen.findByRole('table', { name: strings.caption });

      const [row] = readRows(table);
      expect(row?.cells[6]).toBe(strings.notArchived);
      // The words are for a screen reader only: the eye sees an empty cell, no text and no dash.
      expect(within(table).getByText(strings.notArchived)).toHaveClass('sr-only');
    },
  );

  it.each(LANGUAGES)('labels every detail status, in $language', async (strings) => {
    // The synchronisation reaches `unavailable` and `invalid` only after six failures or an
    // unusable answer: the list is served directly, one match per status (`pending` and `retry`
    // share a label), and one without a detail.
    const statuses: (DetailStatus | null)[] = [
      'pending',
      'retry',
      'ready',
      'unavailable',
      'invalid',
      'evicted',
      null,
    ];
    serveHistory(
      statuses.map((detailStatus, index) => ({
        ...matchSummary({ matchId: index + 1, startTime: SEEDED_START_S - index * 60 }),
        detailStatus,
      })),
    );
    await renderMatchesPage({}, strings.language);
    const table = await screen.findByRole('table', { name: strings.caption });

    expect(readDetailRows(table).map((row) => row.detail)).toEqual([
      strings.detail.waiting,
      strings.detail.waiting,
      strings.detail.archived,
      strings.detail.unavailable,
      strings.detail.invalid,
      strings.evicted,
      strings.notArchived,
    ]);
  });

  it.each(LANGUAGES)('opens a match from its row, in $language', async (strings) => {
    const user = userEvent.setup();
    // A custom match: the app does not archive it, so the page that opens has nothing to download.
    const { router } = await renderMatchesPage({}, strings.language, seededMatches([CUSTOM_CODES]));
    const table = await screen.findByRole('table', { name: strings.caption });
    // The K/D/A cell is no link: the click lands away from the time.
    const cell = within(table).getByText('7 / 3 / 18');
    expect(cell.closest('a')).toBeNull();

    await user.click(cell);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/matches/${String(FIRST_SEEDED_MATCH_ID)}`);
    });
  });

  it('opens the match from the link of its time', async () => {
    const user = userEvent.setup();
    await renderMatchesPage({}, 'en', seededMatches([CUSTOM_CODES]));
    const table = await screen.findByRole('table', { name: EN.caption });

    await user.click(within(table).getByRole('link'));

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: `Match ${String(FIRST_SEEDED_MATCH_ID)}`,
      }),
    ).toBeInTheDocument();
  });

  it('opens the match once when the link is clicked', async () => {
    const user = userEvent.setup();
    const { router } = await renderMatchesPage({}, 'en', seededMatches([CUSTOM_CODES]));
    const table = await screen.findByRole('table', { name: EN.caption });
    const navigate = vi.spyOn(router, 'navigate');

    await user.click(within(table).getByRole('link'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/matches/${String(FIRST_SEEDED_MATCH_ID)}`);
    });
    // The link navigates by itself: the click it sends up to the row must not navigate again.
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('does not open the match when the click ends a text selection', async () => {
    const { router } = await renderMatchesPage({}, 'en', seededMatches([CUSTOM_CODES]));
    const table = await screen.findByRole('table', { name: EN.caption });
    const cell = within(table).getByText('7 / 3 / 18');
    const navigate = vi.spyOn(router, 'navigate');

    // The player has selected the score to copy it: the mouse button released at the end of the
    // selection is a click on the row, which must leave the page alone. The click is fired directly
    // because user-event moves the selection with the pointer, which would end it.
    window.getSelection()?.selectAllChildren(cell);
    expect(window.getSelection()?.toString()).toBe('7 / 3 / 18');
    fireEvent.click(cell);
    expect(navigate).not.toHaveBeenCalled();

    // Once the selection is gone, the same click opens the match.
    window.getSelection()?.removeAllRanges();
    fireEvent.click(cell);
    expect(navigate).toHaveBeenCalledTimes(1);
    // The navigation ends before the test does.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/matches/${String(FIRST_SEEDED_MATCH_ID)}`);
    });
  });

  it('keeps one link per match row, and none on the day rows', async () => {
    await renderMatchesPage({}, 'en', seededMatches(CODES_OF_EACH_TYPE));
    const table = await screen.findByRole('table', { name: EN.caption });

    const rows = within(table).getAllByRole('row').slice(1);
    const matchRows = rows.filter((row) => within(row).queryByRole('rowheader') === null);
    expect(matchRows).toHaveLength(CODES_OF_EACH_TYPE.length);
    for (const row of matchRows) {
      // The link is the only way in for the keyboard: the row is neither a link nor a stop of its
      // own, so the click on the row is a shortcut for the mouse and nothing more.
      expect(within(row).getAllByRole('link')).toHaveLength(1);
      expect(row).not.toHaveAttribute('tabindex');
      // The row has the same highlight for the keyboard (the focus is on its link) as for the
      // mouse (the pointer is on it).
      expect(row).toHaveClass(
        'cursor-pointer',
        'hover:bg-surface-raised',
        'focus-within:bg-surface-raised',
      );
    }
    for (const row of rows.filter((candidate) => !matchRows.includes(candidate))) {
      expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    }
  });

  it('labels Street Brawl, custom, normal and ranked matches', async () => {
    await renderMatchesPage(
      {},
      'en',
      seededMatches([STREET_BRAWL_CODES, CUSTOM_CODES, NORMAL_CODES, RANKED_CODES]),
    );
    const table = await screen.findByRole('table', { name: EN.caption });

    expect(readTypeRows(table)).toEqual([
      { matchId: FIRST_SEEDED_MATCH_ID, type: 'Street Brawl' },
      { matchId: FIRST_SEEDED_MATCH_ID + 1, type: 'Custom' },
      { matchId: FIRST_SEEDED_MATCH_ID + 2, type: 'Normal' },
      { matchId: FIRST_SEEDED_MATCH_ID + 3, type: 'Ranked' },
    ]);
  });

  it('labels the types of the matches in French', async () => {
    await renderMatchesPage(
      {},
      'fr',
      seededMatches([STREET_BRAWL_CODES, CUSTOM_CODES, NORMAL_CODES, RANKED_CODES]),
    );
    const table = await screen.findByRole('table', { name: FR.caption });

    expect(readTypeRows(table).map((row) => row.type)).toEqual([
      'Street Brawl',
      'Personnalisée',
      'Normale',
      'Classée',
    ]);
  });

  it('shows no label for unknown codes', async () => {
    // A game mode that came with a later version of the game, and a match mode of the normal game
    // that the app does not know.
    await renderMatchesPage(
      {},
      'en',
      seededMatches([
        { gameMode: 9, matchMode: 1 },
        { gameMode: 1, matchMode: 6 },
      ]),
    );
    const table = await screen.findByRole('table', { name: EN.caption });

    expect(readTypeRows(table)).toEqual([
      { matchId: FIRST_SEEDED_MATCH_ID, type: '' },
      { matchId: FIRST_SEEDED_MATCH_ID + 1, type: '' },
    ]);
  });

  it('shows heroes by their id when the catalogue is unavailable', async () => {
    const user = userEvent.setup();
    const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
    await renderMatchesPage({
      handler: (request) =>
        request.url.includes('/assets/heroes') ? jsonResponse({}, 500) : fixtures(request),
    });

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: EN.caption });
    expect((await within(table).findAllByText('Hero #67')).length).toBeGreaterThan(0);
  });

  it('speaks French, but keeps the hero names in English', async () => {
    const user = userEvent.setup();
    await renderMatchesPage(
      { handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }) },
      'fr',
    );

    await clickSyncNow(user, 'Synchroniser');

    const table = await screen.findByRole('table', { name: FR.caption });
    expect(screen.getByRole('heading', { level: 1, name: 'Parties' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Héros' })).toBeInTheDocument();
    expect((await within(table).findAllByText('Paige')).length).toBeGreaterThan(0);
  });

  it.each(LANGUAGES)('filters by result and hero, in $language', async (strings) => {
    const user = userEvent.setup();
    const otherHero = PAIGE_HERO_ID + 1;
    // A Paige win, a Paige loss and a loss with another hero, newest first.
    await renderMatchesPage({}, strings.language, [
      matchSummary({ accountId: FIXTURE_ACCOUNT_ID, matchId: 1, startTime: SEEDED_START_S }),
      matchSummary({
        accountId: FIXTURE_ACCOUNT_ID,
        matchId: 2,
        startTime: SEEDED_START_S - 3_600,
        won: false,
      }),
      matchSummary({
        accountId: FIXTURE_ACCOUNT_ID,
        matchId: 3,
        startTime: SEEDED_START_S - 7_200,
        won: false,
        heroId: otherHero,
      }),
    ]);
    const table = await screen.findByRole('table', { name: strings.caption });
    const filters = screen.getByRole('group', { name: strings.filters });
    const results = within(filters).getByRole('group', { name: strings.resultLegend });
    const heroes = within(filters).getByRole('group', { name: strings.heroLegend });
    const ids = () => readRows(table).map((row) => row.matchId);

    // The address carries no filter: Paige, every result.
    expect(within(results).getByRole('radio', { name: strings.allResults })).toBeChecked();
    expect(within(heroes).getByRole('radio', { name: strings.paige })).toBeChecked();
    expect(ids()).toEqual([1, 2]);

    const losses = within(results).getByRole('radio', { name: strings.losses });
    await user.click(losses);
    await waitFor(() => {
      expect(ids()).toEqual([2]);
    });
    // The list in place of the previous one, without a loading step: the radio keeps the focus.
    expect(losses).toHaveFocus();

    await user.click(within(heroes).getByRole('radio', { name: strings.allHeroes }));
    await waitFor(() => {
      expect(ids()).toEqual([2, 3]);
    });

    await user.click(within(results).getByRole('radio', { name: strings.wins }));
    await waitFor(() => {
      expect(ids()).toEqual([1]);
    });
  });

  it.each(LANGUAGES)('keeps the filters in the address, in $language', async (strings) => {
    const user = userEvent.setup();
    const { router } = await renderMatchesPage(
      {},
      strings.language,
      seededMatches([NORMAL_CODES]),
      '/matches?result=loss',
    );
    // The address is read: the radios say what it says.
    const filters = await screen.findByRole('group', { name: strings.filters });
    expect(within(filters).getByRole('radio', { name: strings.losses })).toBeChecked();
    const entries = router.history.length;

    await user.click(within(filters).getByRole('radio', { name: strings.allHeroes }));

    // Every hero, written `all`; the result filter is kept.
    await waitFor(() => {
      expect(router.state.location.searchStr).toContain('hero=all');
    });
    expect(router.state.location.search).toEqual({ hero: 'all', result: 'loss' });

    await user.click(within(filters).getByRole('radio', { name: strings.wins }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ hero: 'all', result: 'win' });
    });
    // A filter replaces the entry of the history: going back leaves the page, not the filter.
    expect(router.history.length).toBe(entries);
  });

  it.each(LANGUAGES)('says no match fits the filters, in $language', async (strings) => {
    const user = userEvent.setup();
    // Only Paige wins.
    await renderMatchesPage({}, strings.language, seededMatches([NORMAL_CODES]));
    await screen.findByRole('table', { name: strings.caption });
    // A live region waits under the filters, empty while the list has rows.
    const region = screen.getAllByRole('status').find((status) => status.textContent === '');
    expect(region).toBeDefined();

    await user.click(screen.getByRole('radio', { name: strings.losses }));

    // The same region, still mounted, now says it: a screen reader announces the change.
    await waitFor(() => {
      expect(region).toHaveTextContent(strings.filteredEmpty);
    });
    expect(region).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The filters stay, to change them; the empty history is another sentence.
    expect(screen.getByRole('group', { name: strings.filters })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: strings.empty }),
    ).not.toBeInTheDocument();
  });

  /** A long Paige history, one match an hour, newest first, and the rows the list makes of it. */
  async function renderLongHistory(matchCount: number) {
    const matches = Array.from({ length: matchCount }, (_, index) =>
      matchSummary({
        accountId: FIXTURE_ACCOUNT_ID,
        matchId: FIRST_SEEDED_MATCH_ID + index,
        startTime: SEEDED_START_S - index * 3_600,
      }),
    );
    // One day row for each local day, plus a row for each match.
    const rowCount =
      new Set(matches.map((match) => localDayKey(match.startTime))).size + matchCount;
    await renderMatchesPage({}, 'en', matches);
    const table = await screen.findByRole('table', { name: EN.caption });
    return { table, rowCount };
  }

  /**
   * The positions of the rendered rows, as the list tells a screen reader.
   *
   * @param table - The list of the matches.
   * @returns The `aria-rowindex` of each rendered row under the header row.
   */
  function renderedRowIndexes(table: HTMLElement): number[] {
    return within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => Number(row.getAttribute('aria-rowindex')));
  }

  it('renders the first rows of a long history only, and keeps the height of the rest', async () => {
    const { table, rowCount } = await renderLongHistory(120);

    // jsdom lays nothing out: `<main>` has no height, so the list renders its first rows. The
    // header row is the first one of the table.
    expect(table).toHaveAttribute('aria-rowcount', String(rowCount + 1));
    expect(renderedRowIndexes(table)).toEqual(
      Array.from({ length: MIN_RENDERED_ROWS }, (_, index) => index + 2),
    );
    // No row is left out above; the rows left out below keep their height.
    expect(spacerHeights(table)).toEqual([(rowCount - MIN_RENDERED_ROWS) * ROW_HEIGHT_PX]);
  });

  it('renders the rows near the part of the history scrolled into view', async () => {
    const { table, rowCount } = await renderLongHistory(120);
    const main = screen.getByRole('main');

    // `<main>` scrolls the page: ten rows high, scrolled down by fifty rows.
    Object.defineProperty(main, 'clientHeight', { configurable: true, value: 10 * ROW_HEIGHT_PX });
    Object.defineProperty(main, 'scrollTop', { configurable: true, value: 50 * ROW_HEIGHT_PX });
    fireEvent.scroll(main);

    // Rows 50 to 60 are in view, plus the overscan on each side.
    const first = 50 - OVERSCAN_ROWS;
    const end = 60 + OVERSCAN_ROWS;
    await waitFor(() => {
      expect(renderedRowIndexes(table)).toEqual(
        Array.from({ length: end - first }, (_, index) => first + index + 2),
      );
    });
    expect(spacerHeights(table)).toEqual([first * ROW_HEIGHT_PX, (rowCount - end) * ROW_HEIGHT_PX]);
  });

  it('measures the list again when the content above it changes height', async () => {
    // jsdom has no ResizeObserver: a recording one stands in, as a browser would give it.
    const observers: { callback: ResizeObserverCallback; observed: Set<Element> }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly #record: { callback: ResizeObserverCallback; observed: Set<Element> };
        constructor(callback: ResizeObserverCallback) {
          this.#record = { callback, observed: new Set() };
          observers.push(this.#record);
        }
        observe(element: Element) {
          this.#record.observed.add(element);
        }
        unobserve(element: Element) {
          this.#record.observed.delete(element);
        }
        disconnect() {
          this.#record.observed.clear();
        }
      },
    );
    const { table } = await renderLongHistory(120);
    const main = screen.getByRole('main');
    const filters = screen.getByRole('group', { name: EN.filters });
    // What sits above the list is watched: the filters, among others.
    const watcher = observers.find((observer) => observer.observed.has(filters));
    expect(watcher).toBeDefined();

    // The content above grows by ten rows (an error line in the banner, say): the body of the table
    // now starts 440 px down, and the watcher reports it.
    const body = table.querySelector('tbody') ?? expect.unreachable();
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({
      top: 10 * ROW_HEIGHT_PX,
    } as DOMRect);
    act(() => {
      watcher?.callback([], {} as ResizeObserver);
    });
    // `<main>`, ten rows high, is then scrolled down by fifty rows: forty of them into the list.
    Object.defineProperty(main, 'clientHeight', { configurable: true, value: 10 * ROW_HEIGHT_PX });
    Object.defineProperty(main, 'scrollTop', { configurable: true, value: 50 * ROW_HEIGHT_PX });
    fireEvent.scroll(main);

    // Rows 40 to 50 are in view, plus the overscan on each side.
    await waitFor(() => {
      expect(renderedRowIndexes(table)[0]).toBe(40 - OVERSCAN_ROWS + 2);
    });
    expect(renderedRowIndexes(table).at(-1)).toBe(50 + OVERSCAN_ROWS + 1);
  });

  it('shows the detail status of Paige matches', async () => {
    const user = userEvent.setup();
    const expected = expectedDetailRows(DETAIL_MATCH_COUNT, NOW, EN);
    await renderMatchesPage(
      { handler: createFixtureApi({ now: NOW, matchCount: DETAIL_MATCH_COUNT }) },
      'en',
      [],
      '/matches?hero=all',
    );

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: EN.caption });
    // The list first shows every Paige match waiting for its detail; the detail queue then
    // archives those deadlock-api has, so the column is read once it shows what the fixtures say.
    await waitFor(() => {
      expect(readDetailRows(table)).toEqual(expected);
    });
  });

  it('says nothing but "not archived" in the detail column for other heroes', async () => {
    const user = userEvent.setup();
    const otherHeroMatchIds = new Set(
      createMatchHistoryFixture({ now: NOW, count: DETAIL_MATCH_COUNT })
        .filter((row) => row.hero_id !== PAIGE_HERO_ID)
        .map((row) => row.match_id),
    );
    await renderMatchesPage(
      { handler: createFixtureApi({ now: NOW, matchCount: DETAIL_MATCH_COUNT }) },
      'en',
      [],
      '/matches?hero=all',
    );

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: EN.caption });
    // Once the queue has archived a Paige match, the column is live: a status given to another
    // hero's match would show by now.
    await within(table).findAllByText('Archived');
    const otherHeroRows = readDetailRows(table).filter((row) => otherHeroMatchIds.has(row.matchId));
    expect(otherHeroRows).toHaveLength(otherHeroMatchIds.size);
    expect(otherHeroRows).toEqual(
      otherHeroRows.map(({ matchId }) => ({ matchId, detail: EN.notArchived })),
    );
  });

  it('judges the 90-day window of the detail with the clock of the application', async () => {
    const user = userEvent.setup();
    // A history of 2020, read by an application whose clock is in 2020: the matches are in the
    // window for it, and years out of it for the wall clock. A list that judged the window with the
    // wall clock would show no status to the match deadlock-api lacks (the others are archived,
    // which a match shows whatever its age).
    const past = Date.UTC(2020, 0, 15, 12, 0, 0);
    const expected = expectedDetailRows(DETAIL_MATCH_COUNT, past, EN);
    await renderMatchesPage(
      { now: () => past, handler: createFixtureApi({ now: past, matchCount: DETAIL_MATCH_COUNT }) },
      'en',
      [],
      '/matches?hero=all',
    );

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: EN.caption });
    await waitFor(() => {
      expect(readDetailRows(table)).toEqual(expected);
    });
  });

  it('shows the detail status in French', async () => {
    const user = userEvent.setup();
    const expected = expectedDetailRows(DETAIL_MATCH_COUNT, NOW, FR);
    await renderMatchesPage(
      { handler: createFixtureApi({ now: NOW, matchCount: DETAIL_MATCH_COUNT }) },
      'fr',
      [],
      '/matches?hero=all',
    );

    await clickSyncNow(user, 'Synchroniser');

    const table = await screen.findByRole('table', { name: FR.caption });
    expect(within(table).getByRole('columnheader', { name: 'Détail' })).toBeInTheDocument();
    await waitFor(() => {
      expect(readDetailRows(table)).toEqual(expected);
    });
  });
});

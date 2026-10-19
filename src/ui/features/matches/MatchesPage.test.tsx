/**
 * Tests of the match history screen, rendered inside the whole application (router, shell,
 * providers) on the development adapters: synthetic deadlock-api and in-memory database. The
 * banner has its own tests (`SyncBanner.test.tsx`).
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi, jsonResponse } from '../../../adapters/dev/fixture-http-client.adapter';
import { createMatchHistoryFixture } from '../../../adapters/dev/fixtures/match-history.fixture';
import { isMetadataMissing } from '../../../adapters/dev/fixtures/match-metadata.fixture';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { parseMatchId } from '../../../core/domain/match';
import { AppError } from '../../../core/errors/app-error';
import type { DetailStatus } from '../../../core/match-detail/detail-status';
import type { Language } from '../../../core/settings/language';
import { MatchesService, type RecentMatches } from '../../../services/matches.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { matchSummary } from '../../../test/test-data';
import { clickSyncNow, waitUntilIdle } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { createI18n } from '../../i18n/i18n';

/** Time of the tests: the synthetic history ends 2 hours before it. */
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

/** The labels the Detail column gives to a Paige match, in the language of the interface. */
interface DetailLabels {
  /** The detail is archived. */
  readonly archived: string;
  /** The detail is to be downloaded (or downloaded again). */
  readonly waiting: string;
}

/** The labels of the Detail column in English. */
const ENGLISH_DETAIL_LABELS: DetailLabels = { archived: 'Archived', waiting: 'Waiting' };

/** The labels of the Detail column in French. */
const FRENCH_DETAIL_LABELS: DetailLabels = { archived: 'Archivée', waiting: 'En attente' };

/** One match of the table, and the text of its cell in the Detail column. */
interface DetailRow {
  readonly matchId: number;
  /** The text of the cell: empty when the match has no detail. */
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
 * @param labels - The labels of the Detail column.
 * @returns A row per match, most recent first like the table.
 */
function expectedDetailRows(matchCount: number, now: number, labels: DetailLabels): DetailRow[] {
  const rows = createMatchHistoryFixture({ now, count: matchCount }).map((row): DetailRow => {
    if (row.hero_id !== PAIGE_HERO_ID) {
      return { matchId: row.match_id, detail: '' };
    }
    const matchId = parseMatchId(row.match_id) ?? expect.unreachable();
    return {
      matchId,
      detail: isMetadataMissing(matchId) ? labels.waiting : labels.archived,
    };
  });
  // The history must hold what the tests are about, whatever the fixtures become.
  expect(rows.some((row) => row.detail === labels.archived)).toBe(true);
  expect(rows.some((row) => row.detail === labels.waiting)).toBe(true);
  expect(rows.some((row) => row.detail === '')).toBe(true);
  return rows;
}

/**
 * Read the Detail column of the table.
 *
 * @param table - The table of the matches.
 * @returns A row per match, in the order of the table.
 */
function readDetailRows(table: HTMLElement): DetailRow[] {
  // The first row holds the headers.
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row): DetailRow => {
      const href = within(row).getByRole('link').getAttribute('href') ?? '';
      const matchId = Number(/\/matches\/(\d+)$/.exec(href)?.[1]);
      const cells = within(row).getAllByRole('cell');
      // The Detail column is the sixth.
      return { matchId, detail: cells[5]?.textContent ?? expect.unreachable() };
    });
}

/**
 * Render the application on the matches page.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @param language - Language of the interface.
 * @returns The test services; failed queries are logged to their `logger`.
 */
async function renderMatchesPage(options: TestServicesOptions = {}, language: Language = 'en') {
  const testServices = createTestServices({ now: () => NOW, ...options });
  const i18n = await createI18n(language);
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/matches'] }));
  render(
    <AppProviders
      services={testServices.services}
      queryClient={createTestQueryClient(testServices.logger)}
      i18n={i18n}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return testServices;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MatchesPage', () => {
  it('says the matches are loading', async () => {
    // The matches query waits until the test releases its answer.
    const gate: { release?: (answer: RecentMatches) => void } = {};
    const answered = new Promise<RecentMatches>((resolve) => {
      gate.release = resolve;
    });
    vi.spyOn(MatchesService.prototype, 'listRecent').mockReturnValue(answered);
    await renderMatchesPage();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading the matches…');

    gate.release?.({ accountLinked: true, total: 0, matches: [] });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'No matches yet' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading the matches…')).not.toBeInTheDocument();
  });

  it('says why the matches cannot be shown when they cannot be read', async () => {
    vi.spyOn(MatchesService.prototype, 'listRecent').mockRejectedValue(
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
    const { services, logger } = await renderMatchesPage({
      handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    });
    await clickSyncNow(user);
    expect(await screen.findByRole('table', { name: 'Most recent matches' })).toBeInTheDocument();

    // Every read fails from now on: a synchronisation refreshes the matches when it starts and
    // when it ends, and a single failed read could be repaired by the next one.
    vi.spyOn(MatchesService.prototype, 'listRecent').mockRejectedValue(
      new AppError('storage', 'The matches cannot be read'),
    );
    await services.sync.syncNow('manual');

    // The failure of the refresh is logged by the query client: the refresh has failed by then.
    await waitFor(() => {
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          scope: 'query',
          context: expect.objectContaining({ query: 'matches.recent' }) as unknown,
        }),
      );
    });
    const table = screen.getByRole('table', { name: 'Most recent matches' });
    // The header and the matches.
    expect(within(table).getAllByRole('row')).toHaveLength(MATCH_COUNT + 1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains that no account is linked and contacts nobody', async () => {
    const { http } = await renderMatchesPage({ accountId: null });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
    ).toBeInTheDocument();
    expect(http.requests).toEqual([]);
  });

  it('links an account from the empty match list', async () => {
    const user = userEvent.setup();
    const { services } = await renderMatchesPage({
      accountId: null,
      handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    });
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
    const table = await screen.findByRole(
      'table',
      { name: 'Most recent matches' },
      { timeout: LINK_WAIT_MS },
    );
    expect(readDetailRows(table).map((row) => row.matchId)).toEqual(
      createMatchHistoryFixture({ now: NOW, count: MATCH_COUNT }).map((row) => row.match_id),
    );
    expect(
      screen.queryByRole('heading', { level: 2, name: 'No account linked' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link my Steam account' })).not.toBeInTheDocument();
    // The test must not end under the background work of the link (the detail queue).
    await waitUntilIdle(services.sync, LINK_WAIT_MS);
  });

  it('shows an empty history before the first synchronisation', async () => {
    await renderMatchesPage();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No matches yet' }),
    ).toBeInTheDocument();
  });

  it('lists the 100 most recent matches with the hero names once synchronised', async () => {
    const user = userEvent.setup();
    // One match more than the list shows: the smallest history that proves the limit. The test is
    // about the list, so deadlock-api serves the history only: every match detail is a 404, which
    // keeps the synchronisation from compressing and archiving them (seconds of work, whose
    // duration would depend on the machine, against a test timeout of 5 s).
    const fixtures = createFixtureApi({ now: NOW, matchCount: 101 });
    await renderMatchesPage({
      handler: (request) =>
        /\/v1\/matches\/\d+\/metadata/.test(request.url)
          ? jsonResponse({ status: 404, error: 'Match not found' }, 404)
          : fixtures(request),
    });

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    expect(within(table).getAllByRole('row')).toHaveLength(101);
    expect(screen.getByText('The 100 most recent of your 101 matches.')).toBeInTheDocument();
    expect(within(table).getAllByText('Paige').length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/^(Win|Loss)$/)).toHaveLength(100);
  });

  it('lists every match, without counting them, when they all fit in the list', async () => {
    const user = userEvent.setup();
    await renderMatchesPage({ handler: createFixtureApi({ now: NOW, matchCount: 5 }) });

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(screen.queryByText(/most recent of your/)).not.toBeInTheDocument();
  });

  it('links each match to its detail page', async () => {
    const user = userEvent.setup();
    await renderMatchesPage({ handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }) });
    await clickSyncNow(user);
    const table = await screen.findByRole('table', { name: 'Most recent matches' });

    await user.click(within(table).getAllByRole('link')[0] ?? expect.unreachable());

    expect(
      await screen.findByRole('heading', { level: 1, name: /^Match \d+$/ }),
    ).toBeInTheDocument();
  });

  it('shows heroes by their id when the catalogue is unavailable', async () => {
    const user = userEvent.setup();
    const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
    await renderMatchesPage({
      handler: (request) =>
        request.url.includes('/assets/heroes') ? jsonResponse({}, 500) : fixtures(request),
    });

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    expect(within(table).getAllByText('Hero #67').length).toBeGreaterThan(0);
  });

  it('speaks French, but keeps the hero names in English', async () => {
    const user = userEvent.setup();
    await renderMatchesPage(
      { handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }) },
      'fr',
    );

    await clickSyncNow(user, 'Synchroniser');

    const table = await screen.findByRole('table', { name: 'Parties les plus récentes' });
    expect(screen.getByRole('heading', { level: 1, name: 'Parties' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Héros' })).toBeInTheDocument();
    expect(within(table).getAllByText('Paige').length).toBeGreaterThan(0);
  });

  it('shows the detail status of Paige matches', async () => {
    const user = userEvent.setup();
    const expected = expectedDetailRows(DETAIL_MATCH_COUNT, NOW, ENGLISH_DETAIL_LABELS);
    await renderMatchesPage({
      handler: createFixtureApi({ now: NOW, matchCount: DETAIL_MATCH_COUNT }),
    });

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    // The Detail column is the sixth, after the duration.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Date', 'Hero', 'Result', 'K / D / A', 'Duration', 'Detail']);
    // The table first shows every Paige match waiting for its detail; the detail queue then
    // archives those deadlock-api has, so the column is read once it shows what the fixtures say.
    await waitFor(() => {
      expect(readDetailRows(table)).toEqual(expected);
    });
  });

  it('shows nothing in the detail column for other heroes', async () => {
    const user = userEvent.setup();
    const otherHeroMatchIds = new Set(
      createMatchHistoryFixture({ now: NOW, count: DETAIL_MATCH_COUNT })
        .filter((row) => row.hero_id !== PAIGE_HERO_ID)
        .map((row) => row.match_id),
    );
    await renderMatchesPage({
      handler: createFixtureApi({ now: NOW, matchCount: DETAIL_MATCH_COUNT }),
    });

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    // Once the queue has archived a Paige match, the column is live: a status given to another
    // hero's match would show by now.
    await within(table).findAllByText('Archived');
    const otherHeroRows = readDetailRows(table).filter((row) => otherHeroMatchIds.has(row.matchId));
    expect(otherHeroRows).toHaveLength(otherHeroMatchIds.size);
    expect(otherHeroRows).toEqual(otherHeroRows.map(({ matchId }) => ({ matchId, detail: '' })));
  });

  it.each([
    {
      language: 'en',
      caption: 'Most recent matches',
      labels: ['Waiting', 'Waiting', 'Archived', 'Unavailable', 'Invalid', ''],
    },
    {
      language: 'fr',
      caption: 'Parties les plus récentes',
      labels: ['En attente', 'En attente', 'Archivée', 'Indisponible', 'Invalide', ''],
    },
  ] as const)('labels every detail status, in $language', async ({ language, caption, labels }) => {
    // The synchronisation reaches `unavailable` and `invalid` only after six failures or an
    // unusable answer: the list is served directly, one match per status (`pending` and `retry`
    // share a label), and one without a detail.
    const statuses: (DetailStatus | null)[] = [
      'pending',
      'retry',
      'ready',
      'unavailable',
      'invalid',
      null,
    ];
    vi.spyOn(MatchesService.prototype, 'listRecent').mockResolvedValue({
      accountLinked: true,
      total: statuses.length,
      matches: statuses.map((detailStatus, index) => ({
        ...matchSummary({ matchId: index + 1 }),
        detailStatus,
      })),
    });
    await renderMatchesPage({}, language);

    const table = await screen.findByRole('table', { name: caption });

    expect(readDetailRows(table).map((row) => row.detail)).toEqual(labels);
  });

  it('judges the 90-day window of the detail with the clock of the application', async () => {
    const user = userEvent.setup();
    // A history of 2020, read by an application whose clock is in 2020: the matches are in the
    // window for it, and years out of it for the wall clock. A list that judged the window with the
    // wall clock would show no status to the match deadlock-api lacks (the others are archived,
    // which a match shows whatever its age).
    const past = Date.UTC(2020, 0, 15, 12, 0, 0);
    const expected = expectedDetailRows(DETAIL_MATCH_COUNT, past, ENGLISH_DETAIL_LABELS);
    await renderMatchesPage({
      now: () => past,
      handler: createFixtureApi({ now: past, matchCount: DETAIL_MATCH_COUNT }),
    });

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    await waitFor(() => {
      expect(readDetailRows(table)).toEqual(expected);
    });
  });

  it('shows the detail status in French', async () => {
    const user = userEvent.setup();
    const expected = expectedDetailRows(DETAIL_MATCH_COUNT, NOW, FRENCH_DETAIL_LABELS);
    await renderMatchesPage(
      { handler: createFixtureApi({ now: NOW, matchCount: DETAIL_MATCH_COUNT }) },
      'fr',
    );

    await clickSyncNow(user, 'Synchroniser');

    const table = await screen.findByRole('table', { name: 'Parties les plus récentes' });
    expect(within(table).getByRole('columnheader', { name: 'Détail' })).toBeInTheDocument();
    await waitFor(() => {
      expect(readDetailRows(table)).toEqual(expected);
    });
  });
});

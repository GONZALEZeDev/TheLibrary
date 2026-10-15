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
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import { MatchesService, type RecentMatches } from '../../../services/matches.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { clickSyncNow } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { createI18n } from '../../i18n/i18n';

/** Time of the tests: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

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
    const { services, logger } = await renderMatchesPage();
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
    expect(within(table).getAllByRole('row')).toHaveLength(101); // The header and the 100 matches.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains that no account is linked and contacts nobody', async () => {
    const { http } = await renderMatchesPage({ accountId: null });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
    ).toBeInTheDocument();
    expect(http.requests).toEqual([]);
  });

  it('shows an empty history before the first synchronisation', async () => {
    await renderMatchesPage();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No matches yet' }),
    ).toBeInTheDocument();
  });

  it('lists the 100 most recent matches with the hero names once synchronised', async () => {
    const user = userEvent.setup();
    await renderMatchesPage();

    await clickSyncNow(user);

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    expect(within(table).getAllByRole('row')).toHaveLength(101);
    expect(screen.getByText('The 100 most recent of your 240 matches.')).toBeInTheDocument();
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
    await renderMatchesPage();
    await clickSyncNow(user);
    const table = await screen.findByRole('table', { name: 'Most recent matches' });

    await user.click(within(table).getAllByRole('link')[0] ?? expect.unreachable());

    expect(
      await screen.findByRole('heading', { level: 1, name: /^Match \d+$/ }),
    ).toBeInTheDocument();
  });

  it('shows heroes by their id when the catalogue is unavailable', async () => {
    const user = userEvent.setup();
    const fixtures = createFixtureApi({ now: NOW });
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
    await renderMatchesPage({}, 'fr');

    await clickSyncNow(user, 'Synchroniser');

    const table = await screen.findByRole('table', { name: 'Parties les plus récentes' });
    expect(screen.getByRole('heading', { level: 1, name: 'Parties' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Héros' })).toBeInTheDocument();
    expect(within(table).getAllByText('Paige').length).toBeGreaterThan(0);
  });
});

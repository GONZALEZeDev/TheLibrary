/**
 * Tests of the match history screen, rendered inside the whole application (router, shell,
 * providers) on the development adapters: synthetic deadlock-api and in-memory database. The
 * banner has its own tests (`SyncBanner.test.tsx`).
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFixtureApi, jsonResponse } from '../../../adapters/dev/fixture-http-client.adapter';
import type { Language } from '../../../core/settings/language';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
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
 * @returns The test services.
 */
async function renderMatchesPage(options: TestServicesOptions = {}, language: Language = 'en') {
  const testServices = createTestServices({ now: () => NOW, ...options });
  const i18n = await createI18n(language);
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/matches'] }));
  render(
    <AppProviders
      services={testServices.services}
      queryClient={createTestQueryClient()}
      i18n={i18n}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return testServices;
}

describe('MatchesPage', () => {
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

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    expect(within(table).getAllByRole('row')).toHaveLength(101);
    expect(screen.getByText('The 100 most recent of your 240 matches.')).toBeInTheDocument();
    expect(within(table).getAllByText('Paige').length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/^(Win|Loss)$/)).toHaveLength(100);
  });

  it('lists every match, without counting them, when they all fit in the list', async () => {
    const user = userEvent.setup();
    await renderMatchesPage({ handler: createFixtureApi({ now: NOW, matchCount: 5 }) });

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(screen.queryByText(/most recent of your/)).not.toBeInTheDocument();
  });

  it('links each match to its detail page', async () => {
    const user = userEvent.setup();
    await renderMatchesPage();
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
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

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    const table = await screen.findByRole('table', { name: 'Most recent matches' });
    expect(within(table).getAllByText('Hero #67').length).toBeGreaterThan(0);
  });

  it('speaks French, but keeps the hero names in English', async () => {
    const user = userEvent.setup();
    await renderMatchesPage({}, 'fr');

    await user.click(await screen.findByRole('button', { name: 'Synchroniser' }));

    const table = await screen.findByRole('table', { name: 'Parties les plus récentes' });
    expect(screen.getByRole('heading', { level: 1, name: 'Parties' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Héros' })).toBeInTheDocument();
    expect(within(table).getAllByText('Paige').length).toBeGreaterThan(0);
  });
});

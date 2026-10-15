/**
 * Tests of the application routes, rendered with the real providers, shell and pages.
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient, createTestServices } from '../../test/create-test-services';
import { createI18n } from '../i18n/i18n';
import { AppProviders } from './AppProviders';
import { createAppRouter } from './router';

/**
 * Render the whole application at `url`, in English, on the development adapters.
 *
 * @param url - Initial URL, e.g. `/dashboard?period=7d`.
 * @returns The router, to inspect its state.
 */
async function renderAppAt(url: string) {
  const { services } = createTestServices();
  const i18n = await createI18n('en');
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
  render(
    <AppProviders services={services} queryClient={createTestQueryClient()} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return router;
}

describe('application routes', () => {
  // RouterProvider resolves routes asynchronously: the first assertion of each test must await.

  it('redirects / to the dashboard', async () => {
    const router = await renderAppAt('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/dashboard');
  });

  it('replaces invalid search parameters with their defaults', async () => {
    const router = await renderAppAt('/dashboard?period=1y&hero=-3');

    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    expect(router.state.location.search).toEqual({ period: '30d', hero: 67 });
  });

  it('navigates with the sidebar and marks the current page', async () => {
    const user = userEvent.setup();
    const router = await renderAppAt('/dashboard');

    await user.click(await screen.findByRole('link', { name: 'Matches' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Matches' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/matches');
    expect(screen.getByRole('link', { name: 'Matches' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('shows the match detail with the id taken from the URL', async () => {
    await renderAppAt('/matches/108501737');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Match 108501737' }),
    ).toBeInTheDocument();
  });

  it.each(['/matches/abc', '/matches/0', '/matches/-5', '/matches/1.5', '/matches/0123'])(
    'shows the not-found page for the invalid match id of %s',
    async (url) => {
      await renderAppAt(url);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
      ).toBeInTheDocument();
    },
  );

  it('shows the not-found page inside the shell for an unknown URL', async () => {
    await renderAppAt('/nowhere');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });
});

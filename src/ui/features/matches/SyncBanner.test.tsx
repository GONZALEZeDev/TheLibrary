/**
 * Tests of the synchronisation banner, with the real providers and the development adapters:
 * synthetic deadlock-api and in-memory database.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../../../adapters/dev/fixture-http-client.adapter';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import { SyncService } from '../../../services/sync.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { SyncBanner } from './SyncBanner';

/** Time of the tests: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Render the banner.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @param language - Language of the interface.
 * @returns The test services.
 */
async function renderBanner(options: TestServicesOptions = {}, language: Language = 'en') {
  const testServices = createTestServices({ now: () => NOW, ...options });
  const i18n = await createI18n(language);
  render(
    <AppProviders
      services={testServices.services}
      queryClient={createTestQueryClient()}
      i18n={i18n}
    >
      <SyncBanner />
    </AppProviders>,
  );
  return testServices;
}

/**
 * A handler answering the match history with a fixed response and the rest like the fixtures.
 *
 * @param status - Status of the history response.
 * @param body - Body of the history response.
 * @param headers - Headers of the history response.
 * @returns The handler.
 */
function historyAnswers(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FixtureHandler {
  const fixtures = createFixtureApi({ now: NOW });
  return (request) =>
    request.url.endsWith('/match-history')
      ? jsonResponse(body, status, headers)
      : fixtures(request);
}

/**
 * Format a time like the banner does, in English.
 *
 * @param time - Unix ms.
 * @returns The formatted date and time.
 */
function formatTime(time: number): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short' }).format(time);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SyncBanner', () => {
  it('says that no account is linked and disables the button', async () => {
    await renderBanner({ accountId: null });

    expect(await screen.findByText('No Steam account is linked.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });

  it('says that the history was never synchronised', async () => {
    await renderBanner();

    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('synchronises on demand and reports the outcome', async () => {
    const user = userEvent.setup();
    const { http } = await renderBanner();

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(
      await screen.findByText(`Last synchronisation: ${formatTime(NOW)}.`),
    ).toBeInTheDocument();
    expect(screen.getByText('New matches: 240.')).toBeInTheDocument();
    expect(screen.getByText('History refreshed from Steam.')).toBeInTheDocument();
    expect(http.requests).toHaveLength(1);
  });

  it('shows the running synchronisation, whoever started it', async () => {
    // The answer of deadlock-api waits until the test releases it.
    const gate: { release?: () => void } = {};
    const answered = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const fixtures = createFixtureApi({ now: NOW });
    const { services } = await renderBanner({
      handler: async (request) => {
        await answered;
        return fixtures(request);
      },
    });
    await screen.findByText('Not synchronised yet.');

    const sync = services.sync.syncNow('schedule');

    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
    gate.release?.();
    await sync;
    expect(await screen.findByText('New matches: 240.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('tells when the synchronisation failed, with the reason', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: historyAnswers(500, {}) });

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(
      await screen.findByText(
        'The last synchronisation failed: The data service is temporarily unavailable. Please try again later.',
      ),
    ).toBeInTheDocument();
  });

  it('warns that a history deadlock-api did not refresh from Steam may be incomplete', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: historyAnswers(429, [], { 'called-steam': 'false' }) });

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(
      await screen.findByText(
        'History possibly incomplete: deadlock-api only knows the matches it collected itself.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the pause deadlock-api asked for', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: historyAnswers(429, {}, { 'retry-after': '600' }) });

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(
      await screen.findByText(
        `deadlock-api asked to slow down: synchronisation paused until ${formatTime(NOW + 600_000)}.`,
      ),
    ).toBeInTheDocument();
  });

  it('explains that a protected account is no longer synchronised automatically', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: historyAnswers(403, {}) });

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(
      await screen.findByText(
        "This account's data is private on deadlock-api: automatic synchronisation is stopped.",
      ),
    ).toBeInTheDocument();
  });

  it('says why the status cannot be shown instead of an empty banner', async () => {
    vi.spyOn(SyncService.prototype, 'getStatus').mockRejectedValue(
      new AppError('storage', 'The synchronisation state cannot be read'),
    );

    await renderBanner();

    expect(await screen.findByText('Local data could not be read or saved.')).toBeInTheDocument();
  });

  it('speaks French', async () => {
    const user = userEvent.setup();
    await renderBanner({}, 'fr');

    await user.click(await screen.findByRole('button', { name: 'Synchroniser' }));

    expect(await screen.findByText('Nouvelles parties : 240.')).toBeInTheDocument();
  });
});

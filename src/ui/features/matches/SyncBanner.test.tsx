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
import { HISTORY_RATE_LIMIT } from '../../../core/deadlock-api/budgets';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import type { AppServices } from '../../../services/app-services';
import { SyncService } from '../../../services/sync.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { clickSyncNow } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { SyncBanner } from './SyncBanner';

/** Time of the tests: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Said when the history was just downloaded and refreshed from Steam. */
const REFRESHED_SENTENCE = 'History refreshed from Steam.';

/** Said when deadlock-api did not refresh the history from Steam. */
const INCOMPLETE_SENTENCE =
  'History possibly incomplete: deadlock-api only knows the matches it collected itself.';

/** Said when the last synchronisation failed because deadlock-api answered with a 500 error. */
const FAILED_SENTENCE =
  'The last synchronisation failed: The data service is temporarily unavailable. Please try again later.';

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
 * A handler whose answers the test changes between two synchronisations.
 *
 * @param first - Answers the requests until `switchTo` is called.
 * @returns The handler to give to the services, and `switchTo`, which replaces its answers.
 */
function changingHandler(first: FixtureHandler) {
  let current = first;
  const handler: FixtureHandler = (request) => current(request);
  return {
    handler,
    switchTo(next: FixtureHandler): void {
      current = next;
    },
  };
}

/**
 * Use up the budget of the history requests with manual synchronisations, then synchronise once
 * more. The clock is fixed, so they all fall in the same hour: that last one is refused locally.
 *
 * @param services - The services of the test.
 */
async function synchroniseBeyondTheBudget(services: AppServices): Promise<void> {
  for (let attempt = 0; attempt <= HISTORY_RATE_LIMIT.limit; attempt += 1) {
    // One at a time, like the user: a synchronisation started while one runs would join it.
    await services.sync.syncNow('manual');
  }
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

    await clickSyncNow(user);

    expect(
      await screen.findByText(`Last synchronisation: ${formatTime(NOW)}.`),
    ).toBeInTheDocument();
    expect(screen.getByText('New matches: 240.')).toBeInTheDocument();
    expect(screen.getByText(REFRESHED_SENTENCE)).toBeInTheDocument();
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

    await clickSyncNow(user);

    expect(await screen.findByText(FAILED_SENTENCE)).toBeInTheDocument();
  });

  it('warns that a history deadlock-api did not refresh from Steam may be incomplete', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: historyAnswers(429, [], { 'called-steam': 'false' }) });

    await clickSyncNow(user);

    expect(await screen.findByText(INCOMPLETE_SENTENCE)).toBeInTheDocument();
  });

  it('shows the pause deadlock-api asked for', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: historyAnswers(429, {}, { 'retry-after': '600' }) });

    await clickSyncNow(user);

    expect(
      await screen.findByText(
        `deadlock-api asked to slow down: synchronisation paused until ${formatTime(NOW + 600_000)}.`,
      ),
    ).toBeInTheDocument();
  });

  it('explains that a protected account is no longer synchronised automatically', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: historyAnswers(403, {}) });

    await clickSyncNow(user);

    expect(
      await screen.findByText(
        "This account's data is private on deadlock-api: automatic synchronisation is stopped.",
      ),
    ).toBeInTheDocument();
  });

  it('says when the request limit is reached, with the time of the last download', async () => {
    const { services, http } = await renderBanner();
    await screen.findByText('Not synchronised yet.');

    await synchroniseBeyondTheBudget(services);

    expect(
      await screen.findByText(
        `Request limit reached for now. History last downloaded: ${formatTime(NOW)}.`,
      ),
    ).toBeInTheDocument();
    // The refused synchronisation sent nothing: only the allowed ones reached deadlock-api.
    expect(http.requests).toHaveLength(HISTORY_RATE_LIMIT.limit);
  });

  it('says the history will come later when the limit is reached before any download', async () => {
    const { services } = await renderBanner({ handler: historyAnswers(500, {}) });
    await screen.findByText('Not synchronised yet.');

    await synchroniseBeyondTheBudget(services);

    expect(
      await screen.findByText(
        'Request limit reached for now: the history will be downloaded at a later synchronisation.',
      ),
    ).toBeInTheDocument();
  });

  it('no longer says the history was refreshed from Steam once a later synchronisation failed', async () => {
    const user = userEvent.setup();
    const answers = changingHandler(createFixtureApi({ now: NOW }));
    await renderBanner({ handler: answers.handler });
    await clickSyncNow(user);
    expect(await screen.findByText(REFRESHED_SENTENCE)).toBeInTheDocument();

    answers.switchTo(historyAnswers(500, {}));
    await clickSyncNow(user);

    expect(await screen.findByText(FAILED_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(REFRESHED_SENTENCE)).not.toBeInTheDocument();
  });

  it('no longer says the history was refreshed from Steam once a later synchronisation was paused', async () => {
    const user = userEvent.setup();
    const answers = changingHandler(createFixtureApi({ now: NOW }));
    await renderBanner({ handler: answers.handler });
    await clickSyncNow(user);
    expect(await screen.findByText(REFRESHED_SENTENCE)).toBeInTheDocument();

    answers.switchTo(historyAnswers(429, {}, { 'retry-after': '600' }));
    await clickSyncNow(user);

    expect(
      await screen.findByText(
        `deadlock-api asked to slow down: synchronisation paused until ${formatTime(NOW + 600_000)}.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(REFRESHED_SENTENCE)).not.toBeInTheDocument();
  });

  it('keeps warning that the history may be incomplete after a failed synchronisation', async () => {
    const user = userEvent.setup();
    const answers = changingHandler(historyAnswers(429, [], { 'called-steam': 'false' }));
    await renderBanner({ handler: answers.handler });
    await clickSyncNow(user);
    expect(await screen.findByText(INCOMPLETE_SENTENCE)).toBeInTheDocument();

    answers.switchTo(historyAnswers(500, {}));
    await clickSyncNow(user);

    expect(await screen.findByText(FAILED_SENTENCE)).toBeInTheDocument();
    expect(screen.getByText(INCOMPLETE_SENTENCE)).toBeInTheDocument();
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

    await clickSyncNow(user, 'Synchroniser');

    expect(await screen.findByText('Nouvelles parties : 240.')).toBeInTheDocument();
  });
});

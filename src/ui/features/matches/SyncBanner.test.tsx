/**
 * Tests of the synchronisation banner, with the real providers and the development adapters:
 * synthetic deadlock-api and in-memory database. The last block tests the throttle of the
 * refreshes on its own, with fake timers.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../../../adapters/dev/fixture-http-client.adapter';
import { HISTORY_RATE_LIMIT, METADATA_MAX_CONCURRENCY } from '../../../core/deadlock-api/budgets';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import type { AppServices } from '../../../services/app-services';
import { MatchDetailService, type DetailSummary } from '../../../services/match-detail.service';
import { SyncService } from '../../../services/sync.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { clickSyncNow } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { SyncBanner } from './SyncBanner';
import { createThrottle } from './use-matches';

/** Time of the tests: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Size of the synthetic history of the tests that do not care about it. A synchronisation also
 * downloads and archives the details of its Paige matches, which a longer history makes slow (two
 * seconds for the default 240 matches); this one has four of them.
 */
const MATCH_COUNT = 12;

/** Said when the history was just downloaded and refreshed from Steam. */
const REFRESHED_SENTENCE = 'History refreshed from Steam.';

/** Said when deadlock-api did not refresh the history from Steam. */
const INCOMPLETE_SENTENCE =
  'History possibly incomplete: deadlock-api only knows the matches it collected itself.';

/** Said when the last synchronisation failed because deadlock-api answered with a 500 error. */
const FAILED_SENTENCE =
  'The last synchronisation failed: The data service is temporarily unavailable. Please try again later.';

/** Said when the detail queue stopped on a local failure (the disk, the compressor...). */
const DETAILS_STOPPED_SENTENCE =
  'Match details cannot be saved right now: Local data could not be read or saved.';

/** Key of the query that reads the summary of the match details. */
const DETAILS_SUMMARY_KEY = ['details', 'summary'] as const;

/** The URL of a match detail request. */
const METADATA_URL = /\/v1\/matches\/\d+\/metadata/;

/**
 * Render the banner on services the test has built, for the test that must watch them before the
 * banner starts to use them.
 *
 * @param testServices - The services of the test.
 * @param language - Language of the interface.
 * @param embedded - Whether the banner is drawn without its own panel.
 * @returns The test services, and the query client of the banner.
 */
async function renderBannerOn(
  testServices: TestServices,
  language: Language = 'en',
  embedded = false,
) {
  const queryClient = createTestQueryClient();
  const i18n = await createI18n(language);
  render(
    <AppProviders services={testServices.services} queryClient={queryClient} i18n={i18n}>
      <SyncBanner embedded={embedded} />
    </AppProviders>,
  );
  return { ...testServices, queryClient };
}

/**
 * Render the banner.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @param language - Language of the interface.
 * @returns The test services, and the query client of the banner.
 */
async function renderBanner(options: TestServicesOptions = {}, language: Language = 'en') {
  return renderBannerOn(createTestServices({ now: () => NOW, ...options }), language);
}

/**
 * The sentence the banner says about the match details, in English, without the one about the
 * invalid details.
 *
 * @param summary - The counts of the details.
 * @returns The sentence.
 */
function detailsSentence({ archived, waiting, unavailable }: DetailSummary): string {
  return `Paige match details: ${String(archived)} archived, ${String(waiting)} waiting, ${String(unavailable)} unavailable.`;
}

/**
 * The counts of the details the services hold now.
 *
 * @param services - The services of the test, with a linked account.
 * @returns The counts.
 */
async function summaryOf(services: AppServices): Promise<DetailSummary> {
  return (await services.details.getSummary()) ?? expect.unreachable('An account is linked');
}

/**
 * Wait until the banner has read the summary of the details. A test that expects the line to be
 * missing waits for it first: otherwise the line could be missing only because the summary has not
 * arrived yet, and the test would pass whatever the banner does with it.
 *
 * @param queryClient - The query client of the banner.
 */
async function waitForSummary(queryClient: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(queryClient.getQueryState(DETAILS_SUMMARY_KEY)?.status).toBe('success');
  });
}

/**
 * A handler that lets one match detail through and holds all the others until the test releases
 * them, so that the detail queue stops with one match archived and the synchronisation still runs.
 * The detail that goes through is the first the API holds: a 404 is held like the rest, since its
 * match would only wait for a new attempt, and the line of the banner would not change.
 *
 * @param fixtures - The synthetic deadlock-api.
 * @returns The handler, `whenHeld` (settled once every puller of the queue holds a detail, told by
 *   the handler: nothing polls the clock), and `release`.
 */
function holdAllDetailsButOne(fixtures: FixtureHandler) {
  let oneThrough = false;
  let held = 0;
  let allHeld = (): void => undefined;
  const whenHeld = new Promise<void>((resolve) => {
    allHeld = resolve;
  });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: FixtureHandler = async (request) => {
    const response = await fixtures(request);
    if (!METADATA_URL.test(request.url)) {
      return response;
    }
    if (!oneThrough && response.status === 200) {
      oneThrough = true;
      return response;
    }
    held += 1;
    if (held >= METADATA_MAX_CONCURRENCY) {
      allHeld();
    }
    await released;
    return response;
  };
  return { handler, whenHeld, release };
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
  // A test that fakes the timers must not leave them faked for the next one.
  vi.useRealTimers();
});

describe('SyncBanner', () => {
  it('says that no account is linked and disables the button', async () => {
    await renderBanner({ accountId: null });

    expect(await screen.findByText('No Steam account is linked.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });

  it('draws no panel of its own when embedded, and keeps its content and its button', async () => {
    await renderBannerOn(createTestServices({ now: () => NOW }), 'en', true);

    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
    // The live region that announces the status is still there, holding the status.
    const liveRegion = screen.getByText('Not synchronised yet.').closest('[aria-live]');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    // The frame and the margin belong to the section that holds the banner.
    expect(document.querySelector('section')).toBeNull();
    expect(document.querySelector('.mb-6')).toBeNull();
  });

  it('draws its own panel by default', async () => {
    await renderBanner();

    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(document.querySelector('section')).not.toBeNull();
  });

  it('says that the history was never synchronised', async () => {
    await renderBanner();

    expect(await screen.findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('synchronises on demand and reports the outcome', async () => {
    const user = userEvent.setup();
    const { http } = await renderBanner({
      handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    });

    await clickSyncNow(user);

    expect(
      await screen.findByText(`Last synchronisation: ${formatTime(NOW)}.`),
    ).toBeInTheDocument();
    expect(screen.getByText(`New matches: ${String(MATCH_COUNT)}.`)).toBeInTheDocument();
    expect(screen.getByText(REFRESHED_SENTENCE)).toBeInTheDocument();
    // One request for the history: the others, if any, are for the details of the matches.
    expect(http.requests.filter((request) => request.url.endsWith('/match-history'))).toHaveLength(
      1,
    );
  });

  it('shows the running synchronisation, whoever started it', async () => {
    // The answer of deadlock-api waits until the test releases it.
    const gate: { release?: () => void } = {};
    const answered = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
    const { services } = await renderBanner({
      handler: async (request) => {
        await answered;
        return fixtures(request);
      },
    });
    await screen.findByText('Not synchronised yet.');

    const sync = services.sync.syncNow('schedule');

    // The button stays enabled while a synchronisation runs: it only ignores the press.
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeEnabled();
    gate.release?.();
    await sync;
    expect(await screen.findByText(`New matches: ${String(MATCH_COUNT)}.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('keeps the focus on the button and starts no second synchronisation when it is pressed while one runs', async () => {
    const user = userEvent.setup();
    // The answer of deadlock-api waits until the test releases it.
    const gate: { release?: () => void } = {};
    const answered = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
    const { services } = await renderBanner({
      handler: async (request) => {
        await answered;
        return fixtures(request);
      },
    });
    await screen.findByText('Not synchronised yet.');
    const syncNow = vi.spyOn(services.sync, 'syncNow');

    // The first synchronisation is the one the user starts with the button.
    await clickSyncNow(user);
    const button = await screen.findByRole('button', { name: 'Syncing…' });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();

    // A press while it runs does nothing, and the focus does not fall to the page.
    await user.click(button);
    await user.keyboard('{Enter}');

    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
    gate.release?.();
    expect(await screen.findByText(`New matches: ${String(MATCH_COUNT)}.`)).toBeInTheDocument();
    // The run ends (the detail queue included): the same button is back, and still has the focus.
    expect(await screen.findByRole('button', { name: 'Sync now' })).toHaveFocus();
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
    const { services, http } = await renderBanner({
      handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    });
    await screen.findByText('Not synchronised yet.');

    await synchroniseBeyondTheBudget(services);

    expect(
      await screen.findByText(
        `Request limit reached for now. History last downloaded: ${formatTime(NOW)}.`,
      ),
    ).toBeInTheDocument();
    // The refused synchronisation asked for no history: only the allowed ones reached deadlock-api.
    expect(http.requests.filter((request) => request.url.endsWith('/match-history'))).toHaveLength(
      HISTORY_RATE_LIMIT.limit,
    );
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
    const answers = changingHandler(createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }));
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
    const answers = changingHandler(createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }));
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

  it('shows the progress of the match details', async () => {
    const { services } = await renderBanner({
      handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    });
    await screen.findByText('Not synchronised yet.');

    await services.sync.syncNow('manual');

    // What the services count after the run is what the banner says, whatever the fixtures hold.
    const summary = await summaryOf(services);
    expect(summary.archived).toBeGreaterThan(0);
    const line = await screen.findByText(detailsSentence(summary));
    expect(line).toBeInTheDocument();
    // The queue updates the line up to once a second: it stays out of the live region, which would
    // make screen readers read it out at every change. The status sentences stay in it.
    expect(line.closest('[aria-live]')).toBeNull();
    expect(
      (await screen.findByText(REFRESHED_SENTENCE)).closest('[aria-live="polite"]'),
    ).not.toBeNull();
  });

  it('mentions invalid details only when there are some', async () => {
    const getSummary = vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue({
      archived: 5,
      waiting: 2,
      unavailable: 1,
      invalid: 3,
      evicted: 0,
      lastStop: null,
    });
    const { queryClient } = await renderBanner();

    expect(
      await screen.findByText(
        'Paige match details: 5 archived, 2 waiting, 1 unavailable. 3 invalid.',
      ),
    ).toBeInTheDocument();

    getSummary.mockResolvedValue({
      archived: 7,
      waiting: 1,
      unavailable: 1,
      invalid: 0,
      evicted: 0,
      lastStop: null,
    });
    await act(() => queryClient.invalidateQueries({ queryKey: ['details'] }));

    expect(
      await screen.findByText('Paige match details: 7 archived, 1 waiting, 1 unavailable.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/invalid/)).not.toBeInTheDocument();
  });

  it('shows no detail line without eligible matches', async () => {
    const { services, queryClient } = await renderBanner();
    await screen.findByText('Not synchronised yet.');

    await waitForSummary(queryClient);

    // Nothing was synchronised, so no match is eligible: the summary is read, and it is empty.
    expect(await summaryOf(services)).toEqual({
      archived: 0,
      waiting: 0,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
      lastStop: null,
    });
    expect(screen.queryByText(/Paige match details/)).not.toBeInTheDocument();
  });

  it('shows no detail line without a linked account', async () => {
    const { services, queryClient } = await renderBanner({ accountId: null });
    await screen.findByText('No Steam account is linked.');

    await waitForSummary(queryClient);

    expect(await services.details.getSummary()).toBeNull();
    expect(screen.queryByText(/Paige match details/)).not.toBeInTheDocument();
  });

  it('refreshes the progress of the match details whenever a synchronisation runs', async () => {
    const getSummary = vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue({
      archived: 1,
      waiting: 4,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
      lastStop: null,
    });
    const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
    const { services } = await renderBanner({
      // The network is down for the details: the queue stops at the first one without recording
      // anything, so nothing tells the banner about a detail and only the synchronisation can
      // refresh its line.
      handler: (request) =>
        METADATA_URL.test(request.url)
          ? Promise.reject(new AppError('network', 'The network is down'))
          : fixtures(request),
    });
    expect(
      await screen.findByText('Paige match details: 1 archived, 4 waiting, 0 unavailable.'),
    ).toBeInTheDocument();

    getSummary.mockResolvedValue({
      archived: 3,
      waiting: 2,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
      lastStop: null,
    });
    await services.sync.syncNow('manual');

    expect(
      await screen.findByText('Paige match details: 3 archived, 2 waiting, 0 unavailable.'),
    ).toBeInTheDocument();
  });

  it('refreshes the progress of the match details while the queue runs', async () => {
    const held = holdAllDetailsButOne(createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }));
    const { services } = await renderBanner({ handler: held.handler });
    await screen.findByText('Not synchronised yet.');

    const run = services.sync.syncNow('manual');
    try {
      // The queue is held: one match is archived, the others wait for the test.
      await held.whenHeld;
      const summary = await summaryOf(services);

      expect(services.sync.isRunning()).toBe(true);
      expect(summary.archived).toBe(1);
      expect(await screen.findByText(detailsSentence(summary))).toBeInTheDocument();
    } finally {
      // Whatever the assertions said, the run ends: a failing test leaves no synchronisation
      // blocked on the gate.
      held.release();
      await run;
    }
  });

  it('reads the details and the matches again as the queue records matches, at most once a second', async () => {
    const testServices = createTestServices({ now: () => NOW });
    const { details } = testServices.services;
    // Play the queue: keep the listener the banner gives it, and call it like the queue does after
    // each match it records.
    let recordMatch = (): void => expect.unreachable('The banner does not listen to the queue');
    const subscribe = details.subscribe;
    vi.spyOn(details, 'subscribe').mockImplementation((listener) => {
      recordMatch = listener;
      return subscribe(listener);
    });
    const { queryClient } = await renderBannerOn(testServices);
    // Let the banner finish loading before the timers are faked, so that nothing it does after the
    // test started waits for a clock the test moves by hand.
    await screen.findByText('Not synchronised yet.');
    await waitForSummary(queryClient);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    vi.useFakeTimers();

    // A burst: the first match is applied at once, the others wait for the end of the second.
    recordMatch();
    recordMatch();
    recordMatch();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['details'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['matches'] });
    vi.advanceTimersByTime(999);
    expect(invalidate).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(4);

    // A match recorded while the banner goes away is not applied: nobody waits for it.
    recordMatch();
    cleanup();
    vi.advanceTimersByTime(10_000);
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it('says when the match details cannot be saved, as long as the last run was stopped by it', async () => {
    const user = userEvent.setup();
    const testServices = createTestServices({
      now: () => NOW,
      handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    });
    // The disk refuses the first archive: the queue stops on a local failure.
    testServices.archiveStore.failNextWrite(new Error('There is not enough space on the disk'));
    await renderBannerOn(testServices);
    await screen.findByText('Not synchronised yet.');

    await clickSyncNow(user, 'Sync now');

    // The counts alone would look like a queue that goes on, so the banner says it is stuck. The
    // sentence stays out of the live region, like the line of the counts.
    const sentence = await screen.findByText(DETAILS_STOPPED_SENTENCE);
    expect(sentence.closest('[aria-live]')).toBeNull();
    expect(screen.getByText(/^Paige match details: /)).toBeInTheDocument();
    expect((await screen.findByText(REFRESHED_SENTENCE)).closest('[aria-live]')).not.toBeNull();

    // The disk works again: the next run goes through, and the sentence goes away.
    await clickSyncNow(user, 'Sync now');
    await waitFor(() => {
      expect(screen.queryByText(DETAILS_STOPPED_SENTENCE)).not.toBeInTheDocument();
    });
    expect((await testServices.services.details.getSummary())?.lastStop).toBeNull();
  });

  it('says it even when no match is counted', async () => {
    vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue({
      archived: 0,
      waiting: 0,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
      lastStop: 'storage',
    });

    await renderBanner();

    expect(await screen.findByText(DETAILS_STOPPED_SENTENCE)).toBeInTheDocument();
    // There is no line of counts to read "0, 0, 0".
    expect(screen.queryByText(/Paige match details/)).not.toBeInTheDocument();
  });

  it.each([null, 'paused', 'network'] as const)(
    'does not say the match details cannot be saved when the last run stopped on %s',
    async (lastStop) => {
      vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue({
        archived: 1,
        waiting: 4,
        unavailable: 0,
        invalid: 0,
        evicted: 0,
        lastStop,
      });

      await renderBanner();

      // The counts are read, so the sentence is missing for a reason.
      expect(
        await screen.findByText('Paige match details: 1 archived, 4 waiting, 0 unavailable.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/cannot be saved/)).not.toBeInTheDocument();
    },
  );

  it('says in French that the match details cannot be saved', async () => {
    vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue({
      archived: 3,
      waiting: 2,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
      lastStop: 'storage',
    });

    await renderBanner({}, 'fr');

    expect(
      await screen.findByText(
        "Le détail des parties ne peut pas être enregistré pour l'instant : Impossible de lire ou d'enregistrer les données locales.",
      ),
    ).toBeInTheDocument();
  });

  it('speaks French', async () => {
    const user = userEvent.setup();
    await renderBanner({ handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }) }, 'fr');

    await clickSyncNow(user, 'Synchroniser');

    expect(
      await screen.findByText(`Nouvelles parties : ${String(MATCH_COUNT)}.`),
    ).toBeInTheDocument();
  });

  it('says the progress of the match details in French', async () => {
    vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue({
      archived: 5,
      waiting: 2,
      unavailable: 1,
      invalid: 3,
      evicted: 0,
      lastStop: null,
    });

    await renderBanner({}, 'fr');

    expect(
      await screen.findByText(
        'Détail des parties Paige : archivées 5, en attente 2, indisponibles 1. Invalides : 3.',
      ),
    ).toBeInTheDocument();
  });

  describe('with thousands of matches', () => {
    /** A first synchronisation can bring more than 999 matches. */
    const NEW_MATCHES = 1_234;

    /** The status of a synchronisation that brought {@link NEW_MATCHES} matches. */
    const SYNCED_STATUS = {
      accountLinked: true,
      lastSync: {
        finishedAt: NOW,
        outcome: 'synced',
        errorKind: null,
        newMatches: NEW_MATCHES,
        historyFetchedAt: NOW,
        historyFromSteam: true,
      },
      pausedUntil: null,
      protectedAccount: false,
    } as const;

    /** Details counts that all have a thousands separator. */
    const BIG_SUMMARY = {
      archived: 12_345,
      waiting: 2_000,
      unavailable: 1_000,
      invalid: 4_321,
      evicted: 0,
      lastStop: null,
    } as const;

    it('groups the digits of the counts in English', async () => {
      vi.spyOn(SyncService.prototype, 'getStatus').mockResolvedValue(SYNCED_STATUS);
      vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue(BIG_SUMMARY);

      await renderBanner();

      expect(await screen.findByText('New matches: 1,234.')).toBeInTheDocument();
      expect(
        await screen.findByText(
          'Paige match details: 12,345 archived, 2,000 waiting, 1,000 unavailable. 4,321 invalid.',
        ),
      ).toBeInTheDocument();
    });

    it('groups the digits of the counts in French', async () => {
      vi.spyOn(SyncService.prototype, 'getStatus').mockResolvedValue(SYNCED_STATUS);
      vi.spyOn(MatchDetailService.prototype, 'getSummary').mockResolvedValue(BIG_SUMMARY);
      // The separator comes from `Intl.NumberFormat('fr')` (a narrow no-break space in current
      // engines), so the test does not hard-code it.
      const format = new Intl.NumberFormat('fr');
      expect(format.format(NEW_MATCHES)).not.toBe(String(NEW_MATCHES));
      // The matcher folds every white space of the page into a plain space, so fold the expected one
      // too.
      const french = (count: number): string => format.format(count).replace(/\s/g, ' ');

      await renderBanner({}, 'fr');

      expect(
        await screen.findByText(`Nouvelles parties : ${french(NEW_MATCHES)}.`),
      ).toBeInTheDocument();
      expect(
        await screen.findByText(
          `Détail des parties Paige : archivées ${french(12_345)}, en attente ${french(2_000)}, indisponibles ${french(1_000)}. Invalides : ${french(4_321)}.`,
        ),
      ).toBeInTheDocument();
    });
  });
});

describe('createThrottle', () => {
  /** The interval of the throttles of the tests. */
  const INTERVAL_MS = 1000;

  // The timers go back to real ones in the `afterEach` of the file.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runs the first call at once', () => {
    const action = vi.fn();
    const throttle = createThrottle(action, INTERVAL_MS);

    throttle.trigger();

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('runs a burst once at once and once more when the interval ends', () => {
    const action = vi.fn();
    const throttle = createThrottle(action, INTERVAL_MS);

    throttle.trigger();
    throttle.trigger();
    throttle.trigger();
    expect(action).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERVAL_MS - 1);
    expect(action).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(2);

    // Nothing is left to run.
    vi.advanceTimersByTime(10 * INTERVAL_MS);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('never runs more than once per interval', () => {
    const action = vi.fn();
    const throttle = createThrottle(action, INTERVAL_MS);

    throttle.trigger();
    vi.advanceTimersByTime(INTERVAL_MS / 2);
    throttle.trigger();
    // The call of the burst runs when its interval ends, and starts the next interval.
    vi.advanceTimersByTime(INTERVAL_MS / 2);
    expect(action).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(200);
    throttle.trigger();
    vi.advanceTimersByTime(INTERVAL_MS - 200 - 1);
    expect(action).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(3);
  });

  it('runs a call at once after a quiet interval', () => {
    const action = vi.fn();
    const throttle = createThrottle(action, INTERVAL_MS);
    throttle.trigger();
    vi.advanceTimersByTime(INTERVAL_MS);

    throttle.trigger();

    expect(action).toHaveBeenCalledTimes(2);
  });

  it('forgets the call that waits when it is cancelled', () => {
    const action = vi.fn();
    const throttle = createThrottle(action, INTERVAL_MS);
    throttle.trigger();
    throttle.trigger();

    throttle.cancel();
    vi.advanceTimersByTime(10 * INTERVAL_MS);

    expect(action).toHaveBeenCalledTimes(1);
    // The throttle starts again from nothing: the next call runs at once.
    throttle.trigger();
    expect(action).toHaveBeenCalledTimes(2);
  });
});

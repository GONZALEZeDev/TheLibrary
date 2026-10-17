/**
 * Tests of the match detail screen, rendered inside the whole application (router, shell,
 * providers) on the development adapters: synthetic deadlock-api, in-memory database and archive.
 *
 * Most tests synchronise a small synthetic history first, like the application does, so the page
 * shows the real state of a match. What the page must show is worked out from the synthetic
 * history rows (the fixtures) and from what the services say of the match, never from numbers
 * written in the tests. The failed states (`unavailable`, `invalid`) are reached for real, by
 * making deadlock-api answer badly; the sentences of every explanation are checked in both
 * languages against a service that answers each view in turn.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../../../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  type RawMatchHistoryRow,
} from '../../../adapters/dev/fixtures/match-history.fixture';
import { isMetadataMissing } from '../../../adapters/dev/fixtures/match-metadata.fixture';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import type { MatchId } from '../../../core/domain/match';
import { AppError } from '../../../core/errors/app-error';
import { MAX_RETRY_DELAY_MS } from '../../../core/match-detail/detail-status';
import type { Language } from '../../../core/settings/language';
import type { AppServices } from '../../../services/app-services';
import { MatchDetailService, type MatchDetailView } from '../../../services/match-detail.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { testMatchId } from '../../../test/test-data';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { createI18n } from '../../i18n/i18n';

/** Time of the tests: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Size of the synthetic history. It is the smallest one that holds a Paige match whose detail
 * deadlock-api does not have (the 14th match of the fixtures), next to Paige matches whose detail
 * it has and matches of other heroes: {@link pickRow} checks that the history offers each.
 */
const MATCH_COUNT = 14;

/** The URL of a match detail request. */
const METADATA_URL = /\/v1\/matches\/\d+\/metadata/;

/** The rows of the synthetic history, most recent first. */
const HISTORY: readonly RawMatchHistoryRow[] = createMatchHistoryFixture({
  now: NOW,
  count: MATCH_COUNT,
});

/**
 * Find a row of the synthetic history.
 *
 * @param what - What the row must be, for the failure message.
 * @param matches - Tells whether a row is the one wanted.
 * @returns The first row that matches.
 */
function pickRow(what: string, matches: (row: RawMatchHistoryRow) => boolean): RawMatchHistoryRow {
  return HISTORY.find(matches) ?? expect.unreachable(`The synthetic history holds no ${what}`);
}

/** A Paige match whose detail deadlock-api has: the queue archives it. */
const ARCHIVED_ROW = pickRow(
  'archived Paige match',
  (row) => row.hero_id === PAIGE_HERO_ID && !isMetadataMissing(testMatchId(row.match_id)),
);

/** A Paige match whose detail deadlock-api does not have: it waits for its next attempt. */
const MISSING_ROW = pickRow(
  'Paige match without a detail',
  (row) => row.hero_id === PAIGE_HERO_ID && isMetadataMissing(testMatchId(row.match_id)),
);

/** A match of another hero: the app never archives it. */
const OTHER_HERO_ROW = pickRow('match of another hero', (row) => row.hero_id !== PAIGE_HERO_ID);

/** The id of {@link ARCHIVED_ROW}. */
const ARCHIVED_ID = testMatchId(ARCHIVED_ROW.match_id);

/** The id of {@link MISSING_ROW}. */
const MISSING_ID = testMatchId(MISSING_ROW.match_id);

/** The id of {@link OTHER_HERO_ROW}. */
const OTHER_HERO_ID = testMatchId(OTHER_HERO_ROW.match_id);

/** A match the app has never heard of: no row of the synthetic history has this id. */
const UNKNOWN_ID = testMatchId(1);

/** What the page says, in one language. */
interface PageStrings {
  readonly notEligible: string;
  readonly waiting: string;
  readonly nextAttempt: (time: string) => string;
  readonly unavailable: string;
  readonly invalid: string;
  readonly missing: string;
  readonly retry: string;
  readonly win: string;
  readonly loss: string;
  readonly facts: {
    readonly result: string;
    readonly duration: string;
    readonly kda: string;
    readonly netWorth: string;
    readonly snapshots: string;
    readonly items: string;
    readonly archive: string;
    readonly archiveValue: (size: string, date: string) => string;
  };
}

/** The strings of the page, by language. */
const STRINGS: Record<Language, PageStrings> = {
  en: {
    notEligible:
      'Match details are archived for your normal-mode Paige matches of the last 90 days.',
    waiting: 'Waiting for the match detail.',
    nextAttempt: (time) => `Next attempt: ${time}.`,
    unavailable: 'deadlock-api does not have the detail of this match.',
    invalid: 'The detail of this match could not be read.',
    missing: 'The archive of this match is missing: it will be downloaded again.',
    retry: 'Retry',
    win: 'Win',
    loss: 'Loss',
    facts: {
      result: 'Result',
      duration: 'Duration',
      kda: 'K/D/A',
      netWorth: 'Net worth',
      snapshots: 'Stat snapshots',
      items: 'Items bought',
      archive: 'Archive',
      archiveValue: (size, date) => `${size} KB, ${date}`,
    },
  },
  fr: {
    notEligible:
      'Le détail est archivé pour tes parties Paige en mode normal des 90 derniers jours.',
    waiting: 'Détail en attente.',
    nextAttempt: (time) => `Prochaine tentative : ${time}.`,
    unavailable: "deadlock-api n'a pas le détail de cette partie.",
    invalid: 'Le détail de cette partie est illisible.',
    missing: "L'archive de cette partie est introuvable : elle sera téléchargée à nouveau.",
    retry: 'Réessayer',
    win: 'Victoire',
    loss: 'Défaite',
    facts: {
      result: 'Résultat',
      duration: 'Durée',
      kda: 'K/D/A',
      netWorth: 'Âmes',
      snapshots: 'Relevés de stats',
      items: 'Objets achetés',
      archive: 'Archive',
      archiveValue: (size, date) => `${size} Ko, ${date}`,
    },
  },
};

/** The `ready` case of {@link MatchDetailView}. */
type ReadyView = Extract<MatchDetailView, { kind: 'ready' }>;

/** One line of the facts: the term and its definition. */
type Fact = readonly [term: string, definition: string];

/**
 * Replace every run of white space (the narrow no-break spaces of French numbers and dates
 * included) by one plain space, the way Testing Library reads the text of a page, so that a text
 * built here and the same text read from the page compare equal whatever the locale writes.
 *
 * @param text - Any text.
 * @returns The text with plain spaces only.
 */
function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Format a date and time like the page does: short date, short time, in the language of the page.
 *
 * @param language - Language of the page.
 * @param time - Unix ms.
 * @returns The formatted date and time, with plain spaces.
 */
function formatDateTime(language: Language, time: number): string {
  return normalizeSpaces(
    new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(time),
  );
}

/**
 * What the facts of an archived match must show, in reading order, worked out from the history row
 * the synthetic API invented the match from (the result, the duration, the K/D/A and the net worth
 * of the player) and from what the services say of the archive (the rest).
 *
 * @param language - Language of the page.
 * @param row - The history row of the match.
 * @param view - What the services say of the archived match.
 * @returns The terms and definitions the page must show.
 */
function expectedFacts(language: Language, row: RawMatchHistoryRow, view: ReadyView): Fact[] {
  const strings = STRINGS[language];
  const { facts } = strings;
  const integer = new Intl.NumberFormat(language);
  const kilobytes = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const minutes = Math.floor(row.match_duration_s / 60);
  const seconds = row.match_duration_s % 60;
  const lines: Fact[] = [
    [facts.result, row.match_result === row.player_team ? strings.win : strings.loss],
    [facts.duration, `${String(minutes)}:${String(seconds).padStart(2, '0')}`],
    [
      facts.kda,
      `${String(row.player_kills)} / ${String(row.player_deaths)} / ${String(row.player_assists)}`,
    ],
    [facts.netWorth, integer.format(row.net_worth)],
    [facts.snapshots, String(view.facts.snapshots)],
    [facts.items, String(view.facts.itemsBought)],
    [
      facts.archive,
      facts.archiveValue(
        kilobytes.format(view.archivedBytes / 1024),
        formatDateTime(language, view.facts.fetchedAt),
      ),
    ],
  ];
  return lines.map(([term, definition]): Fact => [
    normalizeSpaces(term),
    normalizeSpaces(definition),
  ]);
}

/**
 * Read the facts the page shows: every term of its definition list, with its definition.
 *
 * @returns The terms and definitions, in the order of the page.
 */
function readFacts(): Fact[] {
  const terms = screen.getAllByRole('term');
  const definitions = screen.getAllByRole('definition');
  expect(definitions).toHaveLength(terms.length);
  return terms.map((term, index): Fact => [
    normalizeSpaces(term.textContent),
    normalizeSpaces(definitions[index]?.textContent ?? ''),
  ]);
}

/**
 * What the services say of a match that must be archived.
 *
 * @param services - The services of the test.
 * @param matchId - The match.
 * @returns The archived view.
 */
async function archivedView(services: AppServices, matchId: MatchId): Promise<ReadyView> {
  const view = await services.details.getMatchDetail(matchId);
  if (view.kind !== 'ready') {
    return expect.unreachable(`The match should be archived, but its view is ${view.kind}`);
  }
  return view;
}

/**
 * When the services plan the next attempt for a match that waits for one.
 *
 * @param services - The services of the test.
 * @param matchId - The match.
 * @returns The date of the next attempt, in Unix ms.
 */
async function nextAttemptOf(services: AppServices, matchId: MatchId): Promise<number> {
  const view = await services.details.getMatchDetail(matchId);
  if (view.kind !== 'waiting' || view.nextAttemptAt === null) {
    return expect.unreachable(`The match should wait for a date, but its view is ${view.kind}`);
  }
  return view.nextAttemptAt;
}

/**
 * Build the test services on a synthetic history and run the first synchronisation, so the matches
 * and their details are stored like the application stores them.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @returns The test services.
 */
async function synchronised(options: TestServicesOptions = {}): Promise<TestServices> {
  const testServices = createTestServices({
    now: () => NOW,
    handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    ...options,
  });
  await testServices.services.sync.syncNow('manual');
  return testServices;
}

/** Options of {@link renderMatchDetail}. */
interface RenderOptions {
  /** Language of the interface; English by default. */
  readonly language?: Language;
  /** The query client of the page, for the test that must watch it; a test one by default. */
  readonly queryClient?: QueryClient;
}

/**
 * Render the application on the detail page of a match.
 *
 * @param matchId - The match.
 * @param testServices - The services of the test.
 * @param options - See {@link RenderOptions}.
 */
async function renderMatchDetail(
  matchId: MatchId,
  testServices: TestServices,
  { language = 'en', queryClient = createTestQueryClient(testServices.logger) }: RenderOptions = {},
): Promise<void> {
  const i18n = await createI18n(language);
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/matches/${String(matchId)}`] }),
  );
  render(
    <AppProviders services={testServices.services} queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
}

/**
 * Tell how many match details the synthetic API was asked for.
 *
 * @param testServices - The services of the test.
 * @returns The number of requests for a match detail so far.
 */
function detailRequestCount({ http }: TestServices): number {
  return http.requests.filter((request) => METADATA_URL.test(request.url)).length;
}

/** The ways a test makes deadlock-api fail the detail of a match. */
type Failure = 'unavailable' | 'invalid';

/** A synchronised application whose matches have failed their detail, see {@link failedDetails}. */
interface FailedDetails {
  readonly testServices: TestServices;
  /** Makes deadlock-api answer as the given handler does from now on. */
  readonly answerWith: (handler: FixtureHandler) => void;
  /** Makes deadlock-api serve the details from now on. */
  readonly serveDetails: () => void;
}

/**
 * Synchronise an application whose deadlock-api fails the detail of every match until the Paige
 * matches reach a final state, for real:
 * - `unavailable`: the API has no detail for any match (404). Each synchronisation counts one more
 *   failure; the sixth is final. The clock moves forward past the longest retry delay between two
 *   runs, so that every match is due again;
 * - `invalid`: the API answers with a body that is not a match detail, which is final at once.
 *
 * @param failure - The final state to reach.
 * @returns The application, and the means to change what deadlock-api answers.
 */
async function failedDetails(failure: Failure): Promise<FailedDetails> {
  const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
  let current: FixtureHandler = (request) => {
    if (!METADATA_URL.test(request.url)) {
      return fixtures(request);
    }
    return failure === 'unavailable'
      ? jsonResponse({ status: 404, error: 'Match not found' }, 404)
      : jsonResponse({ not: 'a match detail' });
  };
  let clock = NOW;
  const testServices = createTestServices({
    now: () => clock,
    handler: (request) => current(request),
  });
  const { sync } = testServices.services;
  await sync.syncNow('manual');
  if (failure === 'unavailable') {
    // Five more failures after the one of the first synchronisation: the sixth makes it final.
    for (let run = 0; run < 5; run += 1) {
      clock += MAX_RETRY_DELAY_MS;
      await sync.syncNow('detail');
    }
  }
  // The precondition of the tests: the match is in the state they are about.
  await expect(testServices.services.details.getMatchDetail(ARCHIVED_ID)).resolves.toMatchObject({
    kind: failure,
  });
  return {
    testServices,
    answerWith: (handler) => {
      current = handler;
    },
    serveDetails: () => {
      current = fixtures;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MatchDetailPage', () => {
  it('shows the facts of an archived match', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(
      await screen.findByRole('heading', { level: 1, name: `Match ${String(ARCHIVED_ID)}` }),
    ).toBeInTheDocument();
    await screen.findAllByRole('term');
    // The facts of the page are those of the history row of the match and of its archive.
    expect(readFacts()).toEqual(expectedFacts('en', ARCHIVED_ROW, view));
    // An archive is a few kilobytes: the size has one decimal at most.
    expect(readFacts().at(-1)?.[1]).toMatch(/^\d+(\.\d)? KB, /);
    // Nothing to retry, nothing to explain.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText(STRINGS.en.waiting)).not.toBeInTheDocument();
  });

  it('explains why a match is not archived', async () => {
    const testServices = await synchronised();
    // The match is stored, but it is not a Paige match.
    await expect(testServices.services.details.getMatchDetail(OTHER_HERO_ID)).resolves.toEqual({
      kind: 'not_eligible',
    });

    await renderMatchDetail(OTHER_HERO_ID, testServices);

    expect(await screen.findByText(STRINGS.en.notEligible)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: `Match ${String(OTHER_HERO_ID)}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('explains that a match the app does not know is not archived', async () => {
    const testServices = await synchronised();
    await expect(testServices.services.details.getMatchDetail(UNKNOWN_ID)).resolves.toEqual({
      kind: 'not_eligible',
    });

    await renderMatchDetail(UNKNOWN_ID, testServices);

    expect(await screen.findByText(STRINGS.en.notEligible)).toBeInTheDocument();
  });

  it('explains that no account is linked and contacts nobody', async () => {
    const testServices = createTestServices({ now: () => NOW, accountId: null });

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    expect(testServices.http.requests).toEqual([]);
  });

  it('shows the next attempt of a waiting match', async () => {
    // The API has no detail for this match: its first attempt failed and it waits for the next.
    const testServices = await synchronised();
    const nextAttemptAt = await nextAttemptOf(testServices.services, MISSING_ID);

    await renderMatchDetail(MISSING_ID, testServices);

    expect(await screen.findByText(STRINGS.en.waiting)).toBeInTheDocument();
    expect(
      screen.getByText(STRINGS.en.nextAttempt(formatDateTime('en', nextAttemptAt))),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
  });

  it('gives no next attempt to a match that was never tried', async () => {
    const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
    // The network is down for the details: the queue stops at the first one without recording
    // anything, so every Paige match is still to be downloaded.
    const testServices = await synchronised({
      handler: (request) =>
        METADATA_URL.test(request.url)
          ? Promise.reject(new AppError('network', 'The network is down'))
          : fixtures(request),
    });
    await expect(testServices.services.details.getMatchDetail(ARCHIVED_ID)).resolves.toEqual({
      kind: 'waiting',
      nextAttemptAt: null,
    });

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(await screen.findByText(STRINGS.en.waiting)).toBeInTheDocument();
    expect(screen.queryByText(/Next attempt/)).not.toBeInTheDocument();
  });

  it('retries an unavailable match', async () => {
    const user = userEvent.setup();
    const { testServices, serveDetails } = await failedDetails('unavailable');
    serveDetails();
    await renderMatchDetail(ARCHIVED_ID, testServices);
    expect(await screen.findByText(STRINGS.en.unavailable)).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    const requestsBefore = detailRequestCount(testServices);

    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    // The status changes: the match is archived, and the page shows its facts instead of the
    // explanation and the button.
    await screen.findAllByRole('term');
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(readFacts()).toEqual(expectedFacts('en', ARCHIVED_ROW, view));
    expect(screen.queryByText(STRINGS.en.unavailable)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    // Only the match asked for was downloaded again: the others are still unavailable.
    expect(detailRequestCount(testServices)).toBe(requestsBefore + 1);
  });

  it('retries an invalid match', async () => {
    const user = userEvent.setup();
    const { testServices, serveDetails } = await failedDetails('invalid');
    serveDetails();
    await renderMatchDetail(ARCHIVED_ID, testServices);
    expect(await screen.findByText(STRINGS.en.invalid)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    await screen.findAllByRole('term');
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(readFacts()).toEqual(expectedFacts('en', ARCHIVED_ROW, view));
    expect(screen.queryByText(STRINGS.en.invalid)).not.toBeInTheDocument();
  });

  it('shows a match whose retry failed again as waiting for its next attempt', async () => {
    const user = userEvent.setup();
    // deadlock-api still has no detail for the match: the retry fails once more, which counts as
    // the first failure of a match that starts again.
    const { testServices } = await failedDetails('unavailable');
    await renderMatchDetail(ARCHIVED_ID, testServices);

    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(STRINGS.en.waiting)).toBeInTheDocument();
    const nextAttemptAt = await nextAttemptOf(testServices.services, ARCHIVED_ID);
    expect(
      screen.getByText(STRINGS.en.nextAttempt(formatDateTime('en', nextAttemptAt))),
    ).toBeInTheDocument();
    expect(screen.queryByText(STRINGS.en.unavailable)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('disables the retry button while a synchronisation is running', async () => {
    const { testServices, answerWith } = await failedDetails('unavailable');
    await renderMatchDetail(ARCHIVED_ID, testServices);
    const button = await screen.findByRole('button', { name: 'Retry' });
    expect(button).toBeEnabled();

    // The next synchronisation holds on its first request, the one for the history, until the test
    // releases it.
    const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerWith(async (request) => {
      if (request.url.endsWith('/match-history')) {
        await released;
      }
      return fixtures(request);
    });
    const run = testServices.services.sync.syncNow('manual');
    try {
      await waitFor(() => {
        expect(button).toBeDisabled();
      });
    } finally {
      // Whatever the assertion said, the run ends: a failing test leaves no synchronisation
      // blocked on the gate.
      release();
      await run;
    }

    // The match is still unavailable (a synchronisation does not retry it): the button is back.
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
  });

  it('disables the retry button while its own retry is under way', async () => {
    const user = userEvent.setup();
    const { testServices, serveDetails } = await failedDetails('unavailable');
    serveDetails();
    const { details, sync } = testServices.services;
    await renderMatchDetail(ARCHIVED_ID, testServices);
    const button = await screen.findByRole('button', { name: 'Retry' });

    // The retry starts by putting the match back in the queue, before any synchronisation runs:
    // hold it there until the test releases it.
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const putBack = details.resetForRetry.bind(details);
    const resetForRetry = vi.spyOn(details, 'resetForRetry').mockImplementation(async (matchId) => {
      await released;
      await putBack(matchId);
    });
    try {
      await user.click(button);

      // Only the retry itself holds the button: no synchronisation is running yet.
      await waitFor(() => {
        expect(button).toBeDisabled();
      });
      expect(sync.isRunning()).toBe(false);
    } finally {
      // Whatever the assertions said, the retry goes on: a failing test leaves nothing blocked on
      // the gate.
      release();
    }

    // The retry runs its course: the match is archived and the page shows its facts.
    await screen.findAllByRole('term');
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(readFacts()).toEqual(expectedFacts('en', ARCHIVED_ROW, view));
    expect(resetForRetry).toHaveBeenCalledTimes(1);
    expect(resetForRetry).toHaveBeenCalledWith(ARCHIVED_ID);
  });

  it('says when the archive is missing', async () => {
    const testServices = await synchronised();
    await archivedView(testServices.services, ARCHIVED_ID);
    // The database says the detail is archived, but the folder holds no file for it.
    vi.spyOn(testServices.archiveStore, 'read').mockResolvedValue(null);

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(await screen.findByText(STRINGS.en.missing)).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('refreshes the counts and the matches, once, when the archive is missing', async () => {
    const testServices = await synchronised();
    await archivedView(testServices.services, ARCHIVED_ID);
    vi.spyOn(testServices.archiveStore, 'read').mockResolvedValue(null);
    const queryClient = createTestQueryClient(testServices.logger);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });

    expect(await screen.findByText(STRINGS.en.missing)).toBeInTheDocument();
    // The service put the match back to pending, so the banner and the list changed. The page does
    // not read its own match again: it would only repeat what the service just did.
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['details', 'summary'] },
      { queryKey: ['matches'] },
    ]);
  });

  it('shows the match again once its archive was downloaded again', async () => {
    const testServices = await synchronised();
    // Only the first read finds the file missing; the next synchronisation writes it again.
    vi.spyOn(testServices.archiveStore, 'read').mockResolvedValueOnce(null);
    await renderMatchDetail(ARCHIVED_ID, testServices);
    expect(await screen.findByText(STRINGS.en.missing)).toBeInTheDocument();

    await testServices.services.sync.syncNow('detail');

    await screen.findAllByRole('term');
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(readFacts()).toEqual(expectedFacts('en', ARCHIVED_ROW, view));
    expect(screen.queryByText(STRINGS.en.missing)).not.toBeInTheDocument();
  });

  it('says why the detail cannot be shown when it cannot be read', async () => {
    vi.spyOn(MatchDetailService.prototype, 'getMatchDetail').mockRejectedValue(
      new AppError('storage', 'The detail cannot be read'),
    );

    await renderMatchDetail(ARCHIVED_ID, createTestServices({ now: () => NOW }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    // The title does not depend on the detail.
    expect(
      screen.getByRole('heading', { level: 1, name: `Match ${String(ARCHIVED_ID)}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
  });

  it('speaks French', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);

    await renderMatchDetail(ARCHIVED_ID, testServices, { language: 'fr' });

    expect(
      await screen.findByRole('heading', { level: 1, name: `Partie ${String(ARCHIVED_ID)}` }),
    ).toBeInTheDocument();
    await screen.findAllByRole('term');
    expect(readFacts()).toEqual(expectedFacts('fr', ARCHIVED_ROW, view));
  });
});

/** A view the page explains: what it says of it in a language, and whether it offers a retry. */
interface ExplainedView {
  readonly name: string;
  readonly view: MatchDetailView;
  /** The sentences the page says, in reading order. */
  readonly says: (strings: PageStrings, language: Language) => string[];
  readonly offersRetry: boolean;
}

/** The date of the next attempt in the views below. */
const NEXT_ATTEMPT_AT = NOW + 5 * 60_000;

/** Every view that is an explanation, and what the page says of it. */
const EXPLAINED_VIEWS: readonly ExplainedView[] = [
  {
    name: 'a match that is not archived',
    view: { kind: 'not_eligible' },
    says: (strings) => [strings.notEligible],
    offersRetry: false,
  },
  {
    name: 'a match that was never tried',
    view: { kind: 'waiting', nextAttemptAt: null },
    says: (strings) => [strings.waiting],
    offersRetry: false,
  },
  {
    name: 'a match that waits for its next attempt',
    view: { kind: 'waiting', nextAttemptAt: NEXT_ATTEMPT_AT },
    says: (strings, language) => [
      strings.waiting,
      strings.nextAttempt(formatDateTime(language, NEXT_ATTEMPT_AT)),
    ],
    offersRetry: false,
  },
  {
    name: 'an unavailable match',
    view: { kind: 'unavailable', lastError: 'not_found (404)' },
    says: (strings) => [strings.unavailable],
    offersRetry: true,
  },
  {
    name: 'an invalid match',
    view: { kind: 'invalid', lastError: 'invalid_payload (match_info.players: invalid_type)' },
    says: (strings) => [strings.invalid],
    offersRetry: true,
  },
  {
    name: 'a match whose archive is missing',
    view: { kind: 'missing' },
    says: (strings) => [strings.missing],
    offersRetry: false,
  },
];

describe.each(['en', 'fr'] as const)('MatchDetailPage in %s', (language) => {
  it.each(EXPLAINED_VIEWS)('explains $name', async ({ view, says, offersRetry }) => {
    vi.spyOn(MatchDetailService.prototype, 'getMatchDetail').mockResolvedValue(view);
    const strings = STRINGS[language];
    const expected = says(strings, language);

    await renderMatchDetail(ARCHIVED_ID, createTestServices({ now: () => NOW }), { language });

    for (const sentence of expected) {
      expect(await screen.findByText(normalizeSpaces(sentence))).toBeInTheDocument();
    }
    // The page says what it has to say and no more: the sentences of the other views are absent.
    const others = EXPLAINED_VIEWS.flatMap((other) => other.says(strings, language)).filter(
      (sentence) => !expected.includes(sentence),
    );
    for (const sentence of others) {
      expect(screen.queryByText(normalizeSpaces(sentence))).not.toBeInTheDocument();
    }
    if (offersRetry) {
      expect(screen.getByRole('button', { name: strings.retry })).toBeEnabled();
    } else {
      expect(screen.queryByRole('button', { name: strings.retry })).not.toBeInTheDocument();
    }
  });
});

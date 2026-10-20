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
 * The analysis under the facts of an archived match is checked the same way: against what the
 * analysis service says of the match once the page has asked for the community data, with the
 * synthetic deadlock-api held back where a test must see the page before the data comes, and the
 * states of the analysis that the fixtures do not reach for real (`failed`, `not_analysed`, a
 * refresh that fails) played by a service that answers them. The synchronisation analyses every
 * match it archives; a match that is archived and not projected yet (the tests delete the
 * projections) is analysed when its page opens, behind a dialog: those tests hold the analysis back,
 * or make it fail, to see the page in between. The small history fits in the window of the habits of
 * its newest match; the test of a match analysed as part of the window of a later one synchronises
 * a longer history ({@link LONG_MATCH_COUNT}) and goes from one page to the other, as a player does.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TFunction } from 'i18next';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../../../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
  type RawMatchHistoryRow,
} from '../../../adapters/dev/fixtures/match-history.fixture';
import { isMetadataMissing } from '../../../adapters/dev/fixtures/match-metadata.fixture';
import type { Insight } from '../../../core/analysis/insights/insights';
import { PERSONAL_WINDOW } from '../../../core/analysis/insights/thresholds';
import { PHASE_STATS, type PhaseStat } from '../../../core/analysis/phases';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import type { MatchId } from '../../../core/domain/match';
import { AppError } from '../../../core/errors/app-error';
import { MAX_RETRY_DELAY_MS } from '../../../core/match-detail/detail-status';
import type { Language } from '../../../core/settings/language';
import type { MatchAnalysis } from '../../../services/analysis-view';
import type { AppServices } from '../../../services/app-services';
import { MatchDetailService, type MatchDetailView } from '../../../services/match-detail.service';
import { MetricsRepository } from '../../../services/metrics.repository';
import {
  createTestQueryClient,
  createTestServices,
  projectArchivedMatches,
  type TestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { testMatchId } from '../../../test/test-data';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { createI18n } from '../../i18n/i18n';
import { DETAILS_QUERY_KEY } from '../matches/use-matches';
import { formatDuration } from '../matches/MatchesTable';
import { formatPhaseTotal, metricLabel } from './analysis-format';

/** Time of the tests: the synthetic history ends 2 hours before it. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** How long a test waits to see that nothing more happens: well over a few turns of the event loop. */
const SETTLE_MS = 50;

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

/**
 * The matches of a synthetic history that the queue archives: the Paige matches whose detail
 * deadlock-api has. Every match of the histories of these tests is in the 90 days the queue covers.
 *
 * @param history - The rows of the history, most recent first.
 * @returns The ids of the matches, most recent first.
 */
function archivedIdsOf(history: readonly RawMatchHistoryRow[]): MatchId[] {
  return history
    .map((row) => ({ heroId: row.hero_id, matchId: testMatchId(row.match_id) }))
    .filter(({ heroId, matchId }) => heroId === PAIGE_HERO_ID && !isMetadataMissing(matchId))
    .map(({ matchId }) => matchId);
}

/** The matches the queue archives from {@link HISTORY}, most recent first ({@link ARCHIVED_ID}). */
const ARCHIVED_IDS = archivedIdsOf(HISTORY);

/**
 * Size of the synthetic history of the test that opens a match inside the window of the habits of
 * another one: 80 matches, of which 23 are archived Paige matches. That is more than the newest
 * match and the 20 matches of its window, so the window of the next match holds a match that the
 * analysis of the newest one does not project.
 */
const LONG_MATCH_COUNT = 80;

/** The matches the queue archives from the history of {@link LONG_MATCH_COUNT} matches. */
const LONG_ARCHIVED_IDS = archivedIdsOf(
  createMatchHistoryFixture({ now: NOW, count: LONG_MATCH_COUNT }),
);

/** What the page says, in one language. */
interface PageStrings {
  readonly notEligible: string;
  readonly waiting: string;
  readonly nextAttempt: (time: string) => string;
  readonly unavailable: string;
  readonly invalid: string;
  readonly missing: string;
  readonly lost: string;
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
    unavailable: 'deadlock-api could not give the detail of this match after several attempts.',
    invalid: 'The detail of this match could not be read.',
    missing: 'The archive of this match is missing: it will be downloaded again.',
    lost: 'The archive of this match is gone: matches older than 90 days are not downloaded again.',
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
    unavailable:
      "deadlock-api n'a pas pu fournir le détail de cette partie après plusieurs tentatives.",
    invalid: 'Le détail de cette partie est illisible.',
    missing: "L'archive de cette partie est introuvable : elle sera téléchargée à nouveau.",
    lost: "L'archive de cette partie a disparu : les parties de plus de 90 jours ne sont plus téléchargées.",
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

/** What the page says while it analyses a match, when it cannot, and of the way back, in one language. */
interface AnalysingStrings {
  /** The title of the dialog, which is also its name. */
  readonly dialog: string;
  /** The sentence of the dialog while the analysis runs, as far as it identifies it. */
  readonly body: RegExp;
  /** The sentence of the dialog when the analysis failed. */
  readonly failed: string;
  /** The button of the dialog that failed. */
  readonly close: string;
  /** The sentence under the facts while the analysis is not there yet. */
  readonly pending: string;
  /** The sentence under the facts of a match whose analysis failed. */
  readonly cannotAnalyse: string;
  /** The name of the table of the analysis, the proof that it is shown. */
  readonly phaseTable: string;
  /** The text of the link to the match list. */
  readonly back: string;
  /** The title of the match list. */
  readonly listTitle: string;
}

/** The strings of the analysis dialog and of the back link, by language. */
const ANALYSING_STRINGS: Record<Language, AnalysingStrings> = {
  en: {
    dialog: 'Analysing the match…',
    body: /^TheLibrary is computing the metrics of this match/,
    failed: 'The analysis could not be done.',
    close: 'Close',
    pending: 'Analysis in progress…',
    cannotAnalyse: 'This match could not be analysed.',
    phaseTable: 'By phase',
    back: 'Back to matches',
    listTitle: 'Matches',
  },
  fr: {
    dialog: 'Analyse de la partie en cours…',
    body: /^TheLibrary calcule les statistiques de cette partie/,
    failed: "L'analyse n'a pas pu être faite.",
    close: 'Fermer',
    pending: 'Analyse en cours…',
    cannotAnalyse: "Cette partie n'a pas pu être analysée.",
    phaseTable: 'Par phase',
    back: 'Revenir aux parties',
    listTitle: 'Parties',
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
 * and their details are stored like the application stores them. The synchronisation analyses the
 * matches it archives; their projections are deleted here, so that none of them is projected yet,
 * as a page opened before the end of the synchronisation finds them, and the page of one analyses it
 * when it opens.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @returns The test services.
 */
async function archived(options: TestServicesOptions = {}): Promise<TestServices> {
  const testServices = createTestServices({
    now: () => NOW,
    handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    ...options,
  });
  await testServices.services.sync.syncNow('manual');
  if (testServices.accountId !== null) {
    await new MetricsRepository(testServices.database).deleteAccount(testServices.accountId);
  }
  return testServices;
}

/**
 * Build the test services like {@link archived} does, then project the matches they archived, as the
 * end of the synchronisation does: a page then finds the analysis made and shows it at once.
 *
 * @param options - Options of the test services; the clock is fixed at {@link NOW}.
 * @returns The test services.
 */
async function synchronised(options: TestServicesOptions = {}): Promise<TestServices> {
  const testServices = await archived(options);
  await projectArchivedMatches(testServices, { now: options.now ?? (() => NOW) });
  return testServices;
}

/** Options of {@link renderMatchDetail}. */
interface RenderOptions {
  /** Language of the interface; English by default. */
  readonly language?: Language;
  /** The query client of the page, for the test that must watch it; a test one by default. */
  readonly queryClient?: QueryClient;
  /**
   * Whether the page is rendered inside `<StrictMode>`, as `main.tsx` does in development: React then
   * renders twice and replays the effects (mount, unmount, mount). Off by default.
   */
  readonly strict?: boolean;
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
  {
    language = 'en',
    queryClient = createTestQueryClient(testServices.logger),
    strict = false,
  }: RenderOptions = {},
): Promise<void> {
  const i18n = await createI18n(language);
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/matches/${String(matchId)}`] }),
  );
  const page = (
    <AppProviders services={testServices.services} queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  render(strict ? <StrictMode>{page}</StrictMode> : page);
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

/** The start of the path of every community request of the synthetic API. */
const COMMUNITY_PATH_PREFIX = '/v1/analytics/';

/**
 * Tell how many community requests (the sizes of a cohort, its benchmarks, its curve) the synthetic
 * API was asked for.
 *
 * @param testServices - The services of the test.
 * @returns The number of community requests so far.
 */
function communityRequestCount({ http }: TestServices): number {
  return http.requests.filter((request) =>
    new URL(request.url).pathname.startsWith(COMMUNITY_PATH_PREFIX),
  ).length;
}

/**
 * Hold the community requests of the synthetic API back until the test lets them through, so that
 * the page can be seen between the local analysis and the community data. Requests of any other kind
 * (the history, the details, the rank) are answered at once.
 *
 * @returns The handler to give the services, and the means to let the community data through.
 */
function holdCommunityBack(): { readonly handler: FixtureHandler; readonly release: () => void } {
  const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    handler: async (request) => {
      if (new URL(request.url).pathname.startsWith(COMMUNITY_PATH_PREFIX)) {
        await released;
      }
      return fixtures(request);
    },
    release,
  };
}

/**
 * Hold the analysis of the matches back until the test lets it go, so that the page can be seen
 * while the analysis runs. Once let go, the analysis is the service's own, or fails with the error
 * the test gives.
 *
 * @param services - The services of the test.
 * @param failure - What the analysis fails with once let go; none by default: it succeeds.
 * @returns The spy on the analysis, and the means to let it go.
 */
function holdAnalysisBack(
  services: AppServices,
  failure?: Error,
): {
  readonly analyse: MockInstance<AppServices['analysis']['analyseMatch']>;
  readonly release: () => void;
} {
  const analyseMatch = services.analysis.analyseMatch.bind(services.analysis);
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const analyse = vi
    .spyOn(services.analysis, 'analyseMatch')
    .mockImplementation(async (matchId) => {
      await released;
      if (failure !== undefined) {
        throw failure;
      }
      return analyseMatch(matchId);
    });
  return { analyse, release };
}

/**
 * Hold every analysis back until the test lets it go, each one in its turn: unlike
 * {@link holdAnalysisBack}, whose analyses all go once it lets them, an analysis asked for after a
 * release waits for the next one. Once let go, the analysis is the service's own.
 *
 * @param services - The services of the test.
 * @returns The spy on the analysis, and the means to let go the analyses that wait.
 */
function holdEveryAnalysisBack(services: AppServices): {
  readonly analyse: MockInstance<AppServices['analysis']['analyseMatch']>;
  readonly release: () => void;
} {
  const analyseMatch = services.analysis.analyseMatch.bind(services.analysis);
  const waiting: (() => void)[] = [];
  const analyse = vi
    .spyOn(services.analysis, 'analyseMatch')
    .mockImplementation(async (matchId) => {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
      return analyseMatch(matchId);
    });
  return {
    analyse,
    release: () => {
      for (const letGo of waiting.splice(0)) {
        letGo();
      }
    },
  };
}

/**
 * Make the archive of one match impossible to read, every time, as a file another program holds
 * would be: the projection skips that match whenever it is asked to project it. The other archives
 * are read as usual.
 *
 * @param testServices - The services of the test.
 * @param locked - The match whose archive cannot be read.
 */
function lockArchive(testServices: TestServices, locked: MatchId): void {
  const { archiveStore } = testServices;
  const read = archiveStore.read.bind(archiveStore);
  vi.spyOn(archiveStore, 'read').mockImplementation((accountId, matchId) =>
    matchId === locked ? Promise.reject(new Error('Access is denied')) : read(accountId, matchId),
  );
}

/** Let the page go on for a moment, to see that nothing more happens. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  });
}

/**
 * What the analysis service says of a match that must be analysed.
 *
 * @param services - The services of the test.
 * @param matchId - The match.
 * @returns The analysis, with whatever community data the cache holds by now.
 */
async function readyAnalysis(services: AppServices, matchId: MatchId): Promise<MatchAnalysis> {
  const view = await services.analysis.getMatchAnalysis(matchId);
  if (view.kind !== 'ready') {
    return expect.unreachable(`The match should be analysed, but its view is ${view.kind}`);
  }
  return view.analysis;
}

/** The name of a gauge: a metric compared with the rank says its place in words. */
const GAUGE_NAME = /^Percentile /;

/**
 * Wait until the page compares the match with the community: the data has been asked for, stored,
 * and the analysis read again, so that the gauges are drawn.
 */
async function findComparison(): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByRole('img', { name: GAUGE_NAME }).length).toBeGreaterThan(0);
  });
}

/**
 * Check the pills of one side of the summary.
 *
 * @param listName - The name of the list, as the page says it.
 * @param arrow - The arrow of the side.
 * @param word - The hidden word of the side.
 * @param insights - The insights the service gives for the side, strongest first.
 * @param t - Translation function of the language of the page.
 */
function expectPills(
  listName: string,
  arrow: string,
  word: string,
  insights: readonly Insight[],
  t: TFunction,
): void {
  if (insights.length === 0) {
    // A side with nothing to say has no list.
    expect(screen.queryByRole('list', { name: listName })).not.toBeInTheDocument();
    return;
  }
  const pills = within(screen.getByRole('list', { name: listName })).getAllByRole('listitem');
  expect(pills.map((pill) => normalizeSpaces(pill.textContent))).toEqual(
    insights.map((insight) => `${arrow}${metricLabel(insight.key, t, 'en')}${word}`),
  );
}

/**
 * Get one cell of the phase table.
 *
 * @param figure - The name of the figure, as the row header says it.
 * @param column - The place of the phase among the columns, from 0.
 * @returns The cell.
 */
function phaseCell(figure: string, column: number): HTMLElement {
  const row =
    screen.getByRole('rowheader', { name: figure }).closest('tr') ??
    expect.unreachable('A row header sits in a row');
  return within(row).getAllByRole('cell')[column] ?? expect.unreachable('The row has no such cell');
}

/**
 * Press Tab until the focus reaches an element: the way a keyboard user gets to a row of the page.
 *
 * @param user - The simulated user.
 * @param target - The element to reach.
 */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement): Promise<void> {
  const MAX_STOPS = 60;
  for (let stop = 0; stop < MAX_STOPS && document.activeElement !== target; stop += 1) {
    await user.tab();
  }
  expect(target).toHaveFocus();
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
    // The way back to the list does not depend on the match either.
    expect(screen.getByRole('link', { name: ANALYSING_STRINGS.en.back })).toBeInTheDocument();
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

  it('offers to link an account from a match page without an account', async () => {
    const user = userEvent.setup();
    const testServices = createTestServices({ now: () => NOW, accountId: null });

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
    ).toBeInTheDocument();
    // The button is the real one: it opens the dialog of the sign-in, which starts nothing until the
    // player goes on. The sidebar has a button of the same name, so the one of the page is looked for
    // in the page content only.
    await user.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Link my Steam account' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Link your Steam account' })).toBeVisible();
    expect(testServices.signInGateway.openedUrls).toEqual([]);
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

  it('says when the archive is lost, and refreshes the counts and the matches, once', async () => {
    // The clock of the services moves on by hand: the match is archived now and shown 91 days later.
    let clock = NOW;
    const testServices = await synchronised({ now: () => clock });
    await archivedView(testServices.services, ARCHIVED_ID);
    clock = NOW + 91 * 24 * 60 * 60_000;
    // The database says the detail is archived, but the folder holds no file for it.
    vi.spyOn(testServices.archiveStore, 'read').mockResolvedValue(null);
    const queryClient = createTestQueryClient(testServices.logger);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });

    // Not "it will be downloaded again": it will not, the match is past the window.
    expect(await screen.findByText(STRINGS.en.lost)).toBeInTheDocument();
    expect(screen.queryByText(STRINGS.en.missing)).not.toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    // The service put the match back to pending, so the banner and the list changed.
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['details', 'summary'] },
      { queryKey: ['matches'] },
    ]);
  });

  it('shows the error, and keeps the match archived, when the archive file cannot be read', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    vi.spyOn(testServices.archiveStore, 'read').mockRejectedValueOnce(
      new Error(`Access is denied to archive/${String(FIXTURE_ACCOUNT_ID)}/file.json.zst`),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The page's own error path: the translated message of the kind, not "the archive is missing".
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.queryByText(STRINGS.en.missing)).not.toBeInTheDocument();
    expect(screen.queryByText(STRINGS.en.lost)).not.toBeInTheDocument();
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    // The failure is logged once by the query client, with the step and without the account id.
    const failures = testServices.logger.entries.filter((entry) => entry.scope === 'query');
    expect(failures).toMatchObject([
      { level: 'error', context: { kind: 'storage', step: 'read', query: 'details.match' } },
    ]);
    expect(JSON.stringify(failures)).not.toContain(String(FIXTURE_ACCOUNT_ID));
    // The match was not put back to pending: its archive is still shown once the file reads again.
    await expect(archivedView(testServices.services, ARCHIVED_ID)).resolves.toEqual(view);
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
    // The title and the way back do not depend on the detail.
    expect(
      screen.getByRole('heading', { level: 1, name: `Match ${String(ARCHIVED_ID)}` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: ANALYSING_STRINGS.en.back })).toBeInTheDocument();
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

describe('MatchDetailPage analysis', () => {
  it('a ready Paige match shows the summary, the phase table and the families', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    const { t } = await createI18n('en');

    await renderMatchDetail(ARCHIVED_ID, testServices);
    await findComparison();

    // What the page shows is what the service says of the match, with the community data in.
    const analysis = await readyAnalysis(testServices.services, ARCHIVED_ID);
    expect(analysis.community.kind).toBe('available');
    // The synthetic match stands out somewhere: the checks of the summary are not empty ones.
    expect(analysis.strengths.length + analysis.weaknesses.length).toBeGreaterThan(0);

    // The facts keep their place, and the analysis comes under them.
    expect(readFacts()).toEqual(expectedFacts('en', ARCHIVED_ROW, view));
    const main = screen.getByRole('main');
    expect(Array.from(main.querySelectorAll('dl, table')).map((part) => part.tagName)).toEqual([
      'DL',
      'TABLE',
    ]);
    // The headings go down one level at a time: the page, then the analysis (one hidden title, the
    // layouts show none), then the families.
    expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual([
      'H1',
      'H2',
      ...analysis.families.map(() => 'H3'),
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'Analysis' })).toHaveClass('sr-only');

    // The summary: strengths then weaknesses, as pills.
    expectPills('Strengths', '▲', 'strength', analysis.strengths, t);
    expectPills('Weaknesses', '▼', 'weakness', analysis.weaknesses, t);
    expect(screen.queryByText('Nothing stands out in this match.')).not.toBeInTheDocument();

    // The phase table: the phases the match reached, the four figures, and their totals.
    const table = screen.getByRole('table', { name: 'By phase' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(
      analysis.phases.map(
        ({ span }) =>
          `${t(`analysis.phase.${span.phase}`)} · ${formatDuration(span.startS)} → ${formatDuration(span.endS)}`,
      ),
    );
    const figureNames = (stat: PhaseStat): string => t(`analysis.phaseStat.${stat}`);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((header) => header.textContent),
    ).toEqual(PHASE_STATS.map(figureNames));
    for (const stat of PHASE_STATS) {
      analysis.phases.forEach((column, index) => {
        expect(phaseCell(figureNames(stat), index)).toHaveTextContent(
          formatPhaseTotal(column.cells[stat].total, stat, 'en'),
        );
      });
    }

    // The families: their titles in order, each over the metrics of its family.
    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual(
      analysis.families.map(({ family }) => t(`analysis.family.${family}`)),
    );
    for (const { family, rows } of analysis.families) {
      const section = screen.getByRole('region', { name: t(`analysis.family.${family}`) });
      expect(
        within(section)
          .getAllByRole('group')
          .map((row) => row.getAttribute('aria-label')),
      ).toEqual(rows.map((row) => metricLabel(row.key, t, 'en')));
    }
    // The title heads the whole analysis: the summary, the table and every family are in its section.
    const analysisSection = screen.getByRole('region', { name: 'Analysis' });
    expect(
      within(analysisSection).getAllByRole('list', { name: /^(Strengths|Weaknesses)$/ }),
    ).toHaveLength(
      [analysis.strengths, analysis.weaknesses].filter((side) => side.length > 0).length,
    );
    expect(analysisSection).toContainElement(table);
    expect(within(analysisSection).getAllByRole('heading', { level: 3 })).toHaveLength(
      analysis.families.length,
    );
    // The line that says whom the match is compared with, and no waiting for the data any more.
    expect(screen.getByText(/^Compared with Paige players/)).toBeInTheDocument();
    expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
  });

  it('evidence shows on focus and hides on Escape', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();
    await renderMatchDetail(ARCHIVED_ID, testServices);
    await findComparison();

    // A row of the families, reached with the keyboard.
    const row = screen.getByRole('group', { name: 'KDA' });
    const panel = within(row).getByRole('tooltip');
    await tabTo(user, row);

    // The focus describes the row by its evidence and opens the panel.
    expect(row).toHaveAttribute('aria-describedby', panel.id);
    expect(row).toHaveAccessibleDescription(/Percentile (\d+|< 1|> 99) of your rank/);
    expect(row).toHaveAccessibleDescription(/reference matches|Not enough data yet/);
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');

    await user.keyboard('{Escape}');

    expect(row).toHaveFocus();
    expect(panel).toHaveClass('hidden');
    expect(panel).not.toHaveClass('group-focus-visible:block');
    expect(panel).not.toHaveClass('group-hover:block');

    // The same goes for a cell of the phase table.
    const cell = within(phaseCell('Souls', 0)).getByRole('group', { name: 'Souls at 10:00' });
    const cellPanel = within(cell).getByRole('tooltip');
    await tabTo(user, cell);

    // Leaving the row opened its panel again, and the cell opens its own.
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
    expect(cell).toHaveAttribute('aria-describedby', cellPanel.id);
    expect(cellPanel).toHaveClass('group-hover:block', 'group-focus-visible:block');

    await user.keyboard('{Escape}');

    expect(cellPanel).toHaveClass('hidden');
    expect(cellPanel).not.toHaveClass('group-focus-visible:block');
    // The presses of Tab through the whole page take about three seconds on their own, and more
    // while the other test files run beside this one: the default five seconds are too tight.
  }, 15_000);

  it('a waiting match shows no analysis', async () => {
    const testServices = await synchronised();
    const read = vi.spyOn(testServices.services.analysis, 'getMatchAnalysis');
    const refresh = vi.spyOn(testServices.services.analysis, 'refreshCommunity');

    await renderMatchDetail(MISSING_ID, testServices);

    expect(await screen.findByText(STRINGS.en.waiting)).toBeInTheDocument();
    expect(screen.queryByText('Analysis in progress…')).not.toBeInTheDocument();
    expect(screen.queryByText('This match could not be analysed.')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The analysis is not even asked for.
    expect(read).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the community part loads after the local analysis', async () => {
    const { handler, release } = holdCommunityBack();
    const testServices = await synchronised({ handler });

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices);

      // The local analysis is on the page while the community data is still on its way.
      expect(await screen.findByRole('table', { name: 'By phase' })).toBeInTheDocument();
      expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
      // The line above the families says so, once; the metrics that have a reference in the
      // community wait with a dash.
      const waiting = await screen.findAllByText('Loading the comparison with your rank…');
      expect(waiting).toHaveLength(1);
      expect(within(screen.getByRole('group', { name: 'KDA' })).getByText('—')).toBeInTheDocument();
      expect(screen.queryAllByRole('img', { name: GAUGE_NAME })).toEqual([]);
      expect(screen.queryByText('No comparison with your rank for now')).not.toBeInTheDocument();
    } finally {
      // Whatever the assertions said, the data comes: a failing test leaves no download blocked.
      release();
    }

    await findComparison();
    expect(communityRequestCount(testServices)).toBeGreaterThan(0);
    expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
    expect(screen.getByText(/^Compared with Paige players/)).toBeInTheDocument();
  });

  it('does not say the comparison is loading while it asks again about a cohort that is too small', async () => {
    const testServices = await synchronised();
    const analysis = await readyAnalysis(testServices.services, ARCHIVED_ID);
    // The cache holds no data here: play a service whose data was downloaded and holds too few
    // matches, which leaves every comparison with the community missing.
    const read = vi.spyOn(testServices.services.analysis, 'getMatchAnalysis').mockResolvedValue({
      kind: 'ready',
      analysis: { ...analysis, community: { kind: 'unavailable' } },
    });
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi
      .spyOn(testServices.services.analysis, 'refreshCommunity')
      .mockImplementation(async () => {
        await released;
        return 'fresh';
      });

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices);

      // The page asks again, as it does at every opening, and the answer is on its way...
      expect(await screen.findByRole('table', { name: 'By phase' })).toBeInTheDocument();
      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
      });
      // ... but it is not data that is coming, so nothing says it is loading. The line above the
      // families says there is no comparison, once; the metrics are a dash.
      expect(screen.getByText('No comparison with your rank for now')).toBeInTheDocument();
      expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }

    // The answer is `fresh`, which may mean that another page stored the data meanwhile: the
    // analysis is read again, once. The view is still without data here, and the page does not ask
    // again for it: no loop.
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says there is no comparison for now, and shows no error, when the community data cannot be refreshed', async () => {
    const testServices = await synchronised();
    vi.spyOn(testServices.services.analysis, 'refreshCommunity').mockRejectedValue(
      new AppError('storage', 'The community data cannot be saved'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The analysis stays, compared with the habits of the player only.
    expect(await screen.findByRole('table', { name: 'By phase' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('No comparison with your rank for now')).toBeInTheDocument();
    });
    expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('img', { name: GAUGE_NAME })).toEqual([]);
    // The failure is logged by the query client, with the name of the query and not its parameters.
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'query')).toMatchObject([
      { level: 'error', context: { kind: 'storage' } },
    ]);
  });

  it('asks again for the community data when the cache only holds a day-old copy', async () => {
    // The clock of the services moves on by hand: the data is downloaded now, the page opens 25
    // hours later.
    let clock = NOW;
    const testServices = await synchronised({ now: () => clock });
    await expect(testServices.services.analysis.refreshCommunity(ARCHIVED_ID)).resolves.toBe(
      'updated',
    );
    const requestsBefore = communityRequestCount(testServices);
    clock = NOW + 25 * 60 * 60_000;

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The copy of the cache is shown at once, dated since it is stale...
    expect(await screen.findByText(/^Compared with Paige players.*\(from /)).toBeInTheDocument();
    // ... and the page downloads a new one, which is not dated.
    await waitFor(() => {
      expect(screen.getByText(/^Compared with Paige players/)).not.toHaveTextContent('(from ');
    });
    expect(communityRequestCount(testServices)).toBeGreaterThan(requestsBefore);
  });

  it('says when the analysis of a match cannot be made', async () => {
    const testServices = await synchronised();
    vi.spyOn(testServices.services.analysis, 'getMatchAnalysis').mockResolvedValue({
      kind: 'failed',
    });
    const refresh = vi.spyOn(testServices.services.analysis, 'refreshCommunity');

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(await screen.findByText('This match could not be analysed.')).toBeInTheDocument();
    expect(screen.getAllByRole('term').length).toBeGreaterThan(0);
    expect(screen.queryByText('Analysis in progress…')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Nothing to compare: nothing is downloaded.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows nothing of the analysis of a match there is nothing to analyse in', async () => {
    const testServices = await synchronised();
    const read = vi
      .spyOn(testServices.services.analysis, 'getMatchAnalysis')
      .mockResolvedValue({ kind: 'not_analysed' });
    const refresh = vi.spyOn(testServices.services.analysis, 'refreshCommunity');

    await renderMatchDetail(ARCHIVED_ID, testServices);

    await screen.findAllByRole('term');
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
    // Not even a sentence: the facts above say all there is to say.
    expect(screen.queryByText('This match could not be analysed.')).not.toBeInTheDocument();
    expect(screen.queryByText('Analysis in progress…')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows the error of the analysis like any other, and keeps the facts', async () => {
    const testServices = await synchronised();
    vi.spyOn(testServices.services.analysis, 'getMatchAnalysis').mockRejectedValue(
      new AppError('storage', 'The analysis cannot be read'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.getAllByRole('term').length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('speaks French', async () => {
    const testServices = await synchronised();
    const { t } = await createI18n('fr');

    await renderMatchDetail(ARCHIVED_ID, testServices, { language: 'fr' });
    await findComparison();

    const analysis = await readyAnalysis(testServices.services, ARCHIVED_ID);
    expect(screen.getByRole('heading', { level: 2, name: 'Analyse' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Par phase' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual(
      analysis.families.map(({ family }) => t(`analysis.family.${family}`)),
    );
    expect(screen.getByText(/^Comparé aux joueurs de Paige/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'KDA' })).toHaveAccessibleDescription(
      /Percentile (\d+|< 1|> 99) de ton rang/,
    );
    expect(screen.queryByText('By phase')).not.toBeInTheDocument();
  });
});

describe('MatchDetailPage analysis start', () => {
  it('the analysis is started once', async () => {
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analyse, release } = holdAnalysisBack(testServices.services);

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
      await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });

      // The page reads what it shows again while the analysis runs, as a synchronisation makes it
      // do: the view is still `pending`, and the analysis is not asked for a second time.
      await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
      await settle();
      expect(analyse).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await findComparison();

    // Nor is it once the analysis is shown, whatever reads the page again.
    await testServices.services.sync.syncNow('manual');
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
    await settle();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
  });

  it.each([
    // The view is read after the section mounted: the start is not in the replay of the mount.
    { opening: 'the first opening of the page', cached: false },
    // The view is in the cache already, `pending` still (a page opened again after an attempt that
    // was refused): the section starts the analysis as it mounts, which StrictMode then replays.
    { opening: 'a page opened again with the view in the cache', cached: true },
  ])(
    'is started once inside StrictMode, which replays the effects, and the dialog closes onto the analysis: $opening',
    async ({ cached }) => {
      const testServices = await archived();
      const queryClient = createTestQueryClient(testServices.logger);
      if (cached) {
        queryClient.setQueryData([...DETAILS_QUERY_KEY, 'analysis', ARCHIVED_ID], {
          kind: 'pending',
        });
      }
      const { analyse, release } = holdAnalysisBack(testServices.services);

      try {
        await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient, strict: true });

        // StrictMode mounts the effects, unmounts them and mounts them again: the start survives the
        // replay (the ref does), and the dialog is open once.
        await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });
        await settle();
        expect(analyse).toHaveBeenCalledTimes(1);
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
      } finally {
        release();
      }

      // The dialog closes onto the analysis, still one call.
      expect(
        await screen.findByRole('table', { name: ANALYSING_STRINGS.en.phaseTable }),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(screen.queryByText(ANALYSING_STRINGS.en.pending)).not.toBeInTheDocument();
      expect(analyse).toHaveBeenCalledTimes(1);
      expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
      await findComparison();
    },
  );

  it('does not analyse a match that is projected already', async () => {
    const testServices = await synchronised();
    const analyse = vi.spyOn(testServices.services.analysis, 'analyseMatch');

    await renderMatchDetail(ARCHIVED_ID, testServices);
    await findComparison();

    // The view is `ready` from the first read: there is nothing to start, and no dialog.
    expect(analyse).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not close the dialog while the analysis runs', async () => {
    const testServices = await archived();
    const { release } = holdAnalysisBack(testServices.services);

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices);
      const dialog = await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });

      // Escape asks the dialog to close, and the page refuses: the analysis cannot be given up.
      const notPrevented = fireEvent(dialog, new Event('cancel', { cancelable: true }));
      await settle();

      expect(notPrevented).toBe(false);
      expect(screen.getByRole('dialog', { name: ANALYSING_STRINGS.en.dialog })).toBeVisible();
    } finally {
      release();
    }
    await findComparison();
  });

  it('closes the dialog of a failed analysis on Escape too', async () => {
    const testServices = await archived();
    vi.spyOn(testServices.services.analysis, 'analyseMatch').mockRejectedValue(
      new AppError('storage', 'The match could not be analysed'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);
    const dialog = await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });
    await within(dialog).findByText(ANALYSING_STRINGS.en.failed);

    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText(ANALYSING_STRINGS.en.cannotAnalyse)).toHaveAttribute('role', 'status');
  });

  it('says under the facts that the analysis failed even when the browser closed the dialog by itself', async () => {
    const testServices = await archived();
    const { release } = holdAnalysisBack(
      testServices.services,
      new AppError('storage', 'The match could not be analysed'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);
    const dialog = await screen.findByRole<HTMLDialogElement>('dialog', {
      name: ANALYSING_STRINGS.en.dialog,
    });
    // The sentence of the analysis in progress is a live region, and it is the one that will say it.
    const sentence = screen.getByText(ANALYSING_STRINGS.en.pending);
    expect(sentence).toHaveAttribute('role', 'status');

    // A second Escape in a row: the browser closes the dialog without asking the page, which
    // ignores the close while the analysis runs (see `Dialog`).
    act(() => {
      dialog.close();
    });
    release();

    // The failure is not lost with the dialog: the same live region now says it.
    await waitFor(() => {
      expect(sentence).toHaveTextContent(ANALYSING_STRINGS.en.cannotAnalyse);
    });
    expect(sentence).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a refusal because the account is changing leaves the section pending, without an error', async () => {
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { sync } = testServices.services;
    // An account change is under way: the section the analysis runs in refuses new work.
    await sync.suspend();
    const requestsBefore = communityRequestCount(testServices);
    const analyse = vi.spyOn(testServices.services.analysis, 'analyseMatch');

    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
    await waitFor(() => {
      expect(analyse).toHaveBeenCalledTimes(1);
    });
    await expect(analyse.mock.results[0]?.value).rejects.toMatchObject({
      context: { reason: 'suspended' },
    });
    await settle();

    // Not a failure: no error, no dialog, the sentence of an analysis that is not there yet. The
    // facts are shown, and none of the analysis.
    expect(screen.getByText(ANALYSING_STRINGS.en.pending)).toBeInTheDocument();
    expect(screen.getAllByRole('term').length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(ANALYSING_STRINGS.en.cannotAnalyse)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Strengths' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'mutation')).toEqual([]);
    // There is nothing to compare yet: nothing is downloaded for it.
    expect(communityRequestCount(testServices)).toBe(requestsBefore);

    // The account change is over and the queries are reset (see `resetAccountData`): the next read
    // of the view starts the analysis again.
    sync.resume();
    await queryClient.resetQueries({ queryKey: [...DETAILS_QUERY_KEY, 'analysis'] });

    expect(
      await screen.findByRole('table', { name: ANALYSING_STRINGS.en.phaseTable }),
    ).toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(2);
    await findComparison();
  });

  it('analyses the newest match, then a match of its window, behind the dialog both times', async () => {
    const user = userEvent.setup();
    const strings = ANALYSING_STRINGS.en;
    const testServices = await archived({
      handler: createFixtureApi({ now: NOW, matchCount: LONG_MATCH_COUNT }),
    });
    const [newest = expect.unreachable(), inside = expect.unreachable()] = LONG_ARCHIVED_IDS;
    expect(
      LONG_ARCHIVED_IDS.length,
      'a match is left out of the window of the newest one',
    ).toBeGreaterThan(1 + PERSONAL_WINDOW);
    const { analyse, release } = holdEveryAnalysisBack(testServices.services);

    await renderMatchDetail(newest, testServices);
    await screen.findByRole('dialog', { name: strings.dialog });
    release();
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await findComparison();

    // Back to the list, and on to the next match. The analysis of the newest one projected it, but
    // not the whole window of its own habits: the page analyses it, behind the dialog again.
    await user.click(screen.getByRole('link', { name: strings.back }));
    await screen.findByRole('heading', { level: 1, name: strings.listTitle });
    await user.click(
      screen
        .getAllByRole('link')
        .find((link) => link.getAttribute('href') === `/matches/${String(inside)}`) ??
        expect.unreachable('the list links to the match'),
    );
    await screen.findByRole('dialog', { name: strings.dialog });
    expect(screen.getByText(strings.pending)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    release();

    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(analyse.mock.calls).toEqual([[newest], [inside]]);
    // Its habits are a full window, for a metric every match knows.
    const { families } = await readyAnalysis(testServices.services, inside);
    const kda = families.flatMap((family) => family.rows).find((row) => row.key === 'kda');
    expect(kda?.personal?.count).toBe(PERSONAL_WINDOW);
    await findComparison();
  });

  it('starts the analysis again on a page left open while the account changes', async () => {
    const strings = ANALYSING_STRINGS.en;
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analysis } = testServices.services;
    const { analyse, release } = holdEveryAnalysisBack(testServices.services);
    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
    await screen.findByRole('dialog', { name: strings.dialog });
    release();
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();

    // The link moves to an account that holds the match too (a match the two players played
    // together), archived and not analysed yet: erasing the analysis rows plays it.
    await new MetricsRepository(testServices.database).deleteAccount(FIXTURE_ACCOUNT_ID);
    // The account change resets the queries (see `resetAccountData`), and the read that follows
    // takes a moment, as it does on the database of the desktop app: the section is left without a
    // view in between, the section staying where it is.
    const getMatchAnalysis = analysis.getMatchAnalysis.bind(analysis);
    let letReadGo = (): void => undefined;
    const readHeld = new Promise<void>((resolve) => {
      letReadGo = resolve;
    });
    vi.spyOn(analysis, 'getMatchAnalysis').mockImplementation(async (matchId) => {
      await readHeld;
      return getMatchAnalysis(matchId);
    });
    const reset = queryClient.resetQueries({ queryKey: [...DETAILS_QUERY_KEY, 'analysis'] });
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: strings.phaseTable })).not.toBeInTheDocument();
    });
    letReadGo();
    await act(async () => {
      await reset;
    });

    // The view of the account linked now is `pending`: its analysis starts, behind the dialog.
    await screen.findByRole('dialog', { name: strings.dialog });
    release();
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(2);
    await findComparison();
  });

  it('keeps the analysis of a match whose window holds a match that cannot be projected', async () => {
    const strings = ANALYSING_STRINGS.en;
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analysis } = testServices.services;
    lockArchive(testServices, ARCHIVED_IDS[1] ?? expect.unreachable('a match is in the window'));
    const analyse = vi.spyOn(analysis, 'analyseMatch');
    const refresh = vi.spyOn(analysis, 'refreshCommunity');

    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    // The page asks for the community data, then reads the analysis again. The window of the habits
    // is still incomplete, so that read says `pending`, and nothing is downloaded.
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    await expect(refresh.mock.results[0]?.value).resolves.toBe('fresh');
    await settle();
    await expect(analysis.getMatchAnalysis(ARCHIVED_ID)).resolves.toEqual({ kind: 'pending' });

    // The page keeps the analysis, and does not ask for it again: the next opening of the page
    // tries the window again.
    const expectAnalysisKept = (moment: string): void => {
      expect(screen.getByRole('table', { name: strings.phaseTable }), moment).toBeInTheDocument();
      expect(screen.queryByText(strings.pending), moment).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog'), moment).not.toBeInTheDocument();
      expect(analyse, moment).toHaveBeenCalledTimes(1);
    };
    expectAnalysisKept('after the community refresh');
    // Nor when a synchronisation reads the page again.
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
    await settle();
    expectAnalysisKept('after a synchronisation');
  });
});

describe.each(['en', 'fr'] as const)('MatchDetailPage analysing dialog in %s', (language) => {
  const strings = ANALYSING_STRINGS[language];

  it('a match not analysed yet shows the analysing dialog, then its analysis', async () => {
    const testServices = await archived();
    const { analyse, release } = holdAnalysisBack(testServices.services);

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices, { language });

      // The dialog says what is going on. It has no button: the analysis cannot be given up.
      const dialog = await screen.findByRole('dialog', { name: strings.dialog });
      expect(dialog).toBeVisible();
      expect(within(dialog).getByText(strings.body)).toBeInTheDocument();
      expect(within(dialog).queryByRole('button')).not.toBeInTheDocument();
      // The facts are on the page behind it, and the analysis is not there yet.
      await screen.findAllByRole('term');
      expect(screen.getByText(strings.pending)).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      // The headings go down one level at a time while the dialog is open: the page, then the title
      // of the dialog (the title of the analysis, hidden, is only there once the analysis is).
      expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual([
        'H1',
        'H2',
      ]);
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(strings.dialog);
    } finally {
      release();
    }

    // The analysis is shown, and the dialog goes away with the sentence of the analysis in progress.
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(strings.pending)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.cannotAnalyse)).not.toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
    await findComparison();
  });

  it('an analysis error says so and keeps the facts', async () => {
    const user = userEvent.setup();
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analyse, release } = holdAnalysisBack(
      testServices.services,
      new AppError('storage', 'The match could not be analysed: its projection was not stored'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices, { language, queryClient });
    const dialog = await screen.findByRole('dialog', { name: strings.dialog });
    expect(within(dialog).getByText(strings.body)).toBeInTheDocument();
    // The sentence under the facts is one live region: its text changes, and says it failed.
    const sentence = screen.getByText(strings.pending);
    expect(sentence).toHaveAttribute('role', 'status');
    release();

    // The dialog says it, in place of what it said while it ran, and offers to close.
    expect(await within(dialog).findByText(strings.failed)).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(strings.failed);
    expect(within(dialog).queryByText(strings.body)).not.toBeInTheDocument();
    const close = within(dialog).getByRole('button', { name: strings.close });
    // The focus is on the button, so that the keyboard closes the dialog without a search.
    expect(close).toHaveFocus();

    await user.click(close);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // The page keeps its facts and says that the match could not be analysed, in the live region
    // that said the analysis was in progress.
    expect(screen.getAllByRole('term').length).toBeGreaterThan(0);
    expect(screen.getByText(strings.cannotAnalyse)).toBe(sentence);
    expect(sentence).toHaveAttribute('role', 'status');
    expect(screen.queryByText(strings.pending)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // No second attempt, not even when the page reads its view again (the match is still
    // `pending`): opening the page again is what tries again.
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
    await settle();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(strings.cannotAnalyse)).toBeInTheDocument();
    // The failure is logged once, by the query client, with the kind and the name of the mutation.
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'mutation')).toMatchObject(
      [{ level: 'error', context: { kind: 'storage', mutation: 'details.analyse' } }],
    );
  });

  it('the back link goes to the match list', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();

    await renderMatchDetail(ARCHIVED_ID, testServices, { language });

    const link = await screen.findByRole('link', { name: strings.back });
    // It comes before the title of the page.
    expect(link.compareDocumentPosition(screen.getByRole('heading', { level: 1 }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(link).toHaveAttribute('href', '/matches');

    await user.click(link);

    expect(
      await screen.findByRole('heading', { level: 1, name: strings.listTitle }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: strings.back })).not.toBeInTheDocument();
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
  {
    // Nothing can be retried: the queue never downloads a match past the 90 days.
    name: 'a match whose archive is lost',
    view: { kind: 'lost' },
    says: (strings) => [strings.lost],
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

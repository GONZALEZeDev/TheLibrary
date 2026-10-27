/**
 * The shared harness of the tests of the match page: the synthetic history the tests take their
 * matches from, the services on the development adapters (synthetic deadlock-api, in-memory
 * database and archive), the strings of the page in both languages, the rendering of the page
 * inside the whole application, and the waits.
 *
 * The tests of the page (`MatchDetailPage.test.tsx`) and the tests of its analysis
 * (`MatchDetailPage.analysis.test.tsx`) read the same fixtures and the same sentences from here, so
 * that what the page must show is worked out the same way in both: from the synthetic history rows
 * and from what the services say of the match, never from numbers written in the tests. A helper
 * that only one of the two files uses stays in that file.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { expect, vi, type MockInstance } from 'vitest';
import { createFixtureApi } from '../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  type RawMatchHistoryRow,
} from '../adapters/dev/fixtures/match-history.fixture';
import {
  FIXTURE_HERO_CATALOGUE,
  type RawCatalogueHero,
} from '../adapters/dev/fixtures/heroes.fixture';
import { isMetadataMissing } from '../adapters/dev/fixtures/match-metadata.fixture';
import { PAIGE_HERO_ID, type HeroId } from '../core/domain/hero';
import type { MatchId } from '../core/domain/match';
import { matchTypeOf, type MatchType } from '../core/domain/match-type';
import type { Language } from '../core/settings/language';
import type { AppServices } from '../services/app-services';
import type { MatchDetailView } from '../services/match-detail.service';
import { MetricsRepository } from '../services/metrics.repository';
import { AppProviders } from '../ui/app/AppProviders';
import { createAppRouter } from '../ui/app/router';
import { createI18n } from '../ui/i18n/i18n';
import {
  createTestQueryClient,
  createTestServices,
  projectArchivedMatches,
  type TestServices,
  type TestServicesOptions,
} from './create-test-services';
import { testMatchId } from './test-data';

/** Time of the tests: the synthetic history ends 2 hours before it. */
export const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** How long a test waits to see that nothing more happens: well over a few turns of the event loop. */
export const SETTLE_MS = 50;

/**
 * Size of the synthetic history. It is the smallest one that holds a Paige match whose detail
 * deadlock-api does not have (the 14th match of the fixtures), next to Paige matches whose detail
 * it has and matches of other heroes: {@link pickRow} checks that the history offers each.
 */
export const MATCH_COUNT = 14;

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
export function pickRow(
  what: string,
  matches: (row: RawMatchHistoryRow) => boolean,
): RawMatchHistoryRow {
  return HISTORY.find(matches) ?? expect.unreachable(`The synthetic history holds no ${what}`);
}

/** A Paige match whose detail deadlock-api has: the queue archives it. */
export const ARCHIVED_ROW = pickRow(
  'archived Paige match',
  (row) => row.hero_id === PAIGE_HERO_ID && !isMetadataMissing(testMatchId(row.match_id)),
);

/** A Paige match whose detail deadlock-api does not have: it waits for its next attempt. */
export const MISSING_ROW = pickRow(
  'Paige match without a detail',
  (row) => row.hero_id === PAIGE_HERO_ID && isMetadataMissing(testMatchId(row.match_id)),
);

/** The id of {@link ARCHIVED_ROW}. */
export const ARCHIVED_ID = testMatchId(ARCHIVED_ROW.match_id);

/** The id of {@link MISSING_ROW}. */
export const MISSING_ID = testMatchId(MISSING_ROW.match_id);

/**
 * Find a hero in the catalogue of the fixtures.
 *
 * @param heroId - The hero, as a history row names it.
 * @returns The raw hero: its English name and its portraits.
 */
export function catalogueHeroOf(heroId: HeroId): RawCatalogueHero {
  return (
    FIXTURE_HERO_CATALOGUE.find((hero) => hero.id === heroId) ??
    expect.unreachable('The hero catalogue of the fixtures lacks a hero of the history')
  );
}

/**
 * The matches of a synthetic history that the queue archives: the Paige matches whose detail
 * deadlock-api has. Every match of the histories of these tests is in the 90 days the queue covers.
 *
 * @param history - The rows of the history, most recent first.
 * @returns The ids of the matches, most recent first.
 */
export function archivedIdsOf(history: readonly RawMatchHistoryRow[]): MatchId[] {
  return history
    .map((row) => ({ heroId: row.hero_id, matchId: testMatchId(row.match_id) }))
    .filter(({ heroId, matchId }) => heroId === PAIGE_HERO_ID && !isMetadataMissing(matchId))
    .map(({ matchId }) => matchId);
}

/** The matches the queue archives from {@link HISTORY}, most recent first ({@link ARCHIVED_ID}). */
export const ARCHIVED_IDS = archivedIdsOf(HISTORY);

/** What the page says, in one language. */
export interface PageStrings {
  readonly notEligible: string;
  readonly waiting: string;
  readonly nextAttempt: (time: string) => string;
  readonly unavailable: string;
  readonly invalid: string;
  readonly missing: string;
  readonly retry: string;
  readonly win: string;
  readonly loss: string;
  /** The labels of the figures of the header that a bare number would leave unclear. */
  readonly header: {
    readonly duration: string;
    readonly kda: string;
    readonly souls: string;
    /** The name of a hero the catalogue does not know, from its id. */
    readonly unknownHero: (heroId: HeroId) => string;
  };
  /** The label of each match type in the header. */
  readonly matchTypes: Readonly<Record<MatchType, string>>;
  /** The line about the archive at the end of an archived match. */
  readonly archiveLine: (snapshots: string, items: string, size: string, date: string) => string;
}

/** The strings of the page, by language. */
export const STRINGS: Record<Language, PageStrings> = {
  en: {
    notEligible:
      'Match details are archived for your normal-mode Paige matches of the last 90 days.',
    waiting: 'Waiting for the match detail.',
    /**
     * @param time - When the next attempt is due, as the page writes it.
     * @returns The line of the next attempt.
     */
    nextAttempt: (time) => `Next attempt: ${time}.`,
    unavailable: 'deadlock-api could not give the detail of this match after several attempts.',
    invalid: 'The detail of this match could not be read.',
    missing: 'The archive of this match is missing: it will be downloaded again.',
    retry: 'Retry',
    win: 'Win',
    loss: 'Loss',
    header: {
      duration: 'Duration',
      kda: 'K / D / A',
      souls: 'Souls',
      /**
       * @param heroId - The id of a hero the catalogue does not know.
       * @returns The name the page gives that hero.
       */
      unknownHero: (heroId) => `Hero #${String(heroId)}`,
    },
    matchTypes: {
      normal: 'Normal',
      ranked: 'Ranked',
      street_brawl: 'Street Brawl',
      custom: 'Custom',
    },
    /**
     * @param snapshots - The number of snapshots, as the page writes it.
     * @param items - The number of items bought, as the page writes it.
     * @param size - The size of the archive in kilobytes, as the page writes it.
     * @param date - The day the detail was downloaded, as the page writes it.
     * @returns The line about the archive of the match.
     */
    archiveLine: (snapshots, items, size, date) =>
      `Archive: ${snapshots} snapshots, ${items} items bought, ${size} KB, downloaded ${date}`,
  },
  fr: {
    notEligible:
      'Le détail est archivé pour tes parties Paige en mode normal des 90 derniers jours.',
    waiting: 'Détail en attente.',
    /**
     * @param time - When the next attempt is due, as the page writes it.
     * @returns The line of the next attempt.
     */
    nextAttempt: (time) => `Prochaine tentative : ${time}.`,
    unavailable:
      "deadlock-api n'a pas pu fournir le détail de cette partie après plusieurs tentatives.",
    invalid: 'Le détail de cette partie est illisible.',
    missing: "L'archive de cette partie est introuvable : elle sera téléchargée à nouveau.",
    retry: 'Réessayer',
    win: 'Victoire',
    loss: 'Défaite',
    header: {
      duration: 'Durée',
      kda: 'K / D / A',
      souls: 'Âmes',
      /**
       * @param heroId - The id of a hero the catalogue does not know.
       * @returns The name the page gives that hero.
       */
      unknownHero: (heroId) => `Héros n°${String(heroId)}`,
    },
    matchTypes: {
      normal: 'Normale',
      ranked: 'Classée',
      street_brawl: 'Street Brawl',
      custom: 'Personnalisée',
    },
    /**
     * @param snapshots - The number of snapshots, as the page writes it.
     * @param items - The number of items bought, as the page writes it.
     * @param size - The size of the archive in kilobytes, as the page writes it.
     * @param date - The day the detail was downloaded, as the page writes it.
     * @returns The line about the archive of the match.
     */
    archiveLine: (snapshots, items, size, date) =>
      `Archive : ${snapshots} instantanés, ${items} objets achetés, ${size} Ko, téléchargée le ${date}`,
  },
};

/**
 * The start of the archive line in each language: enough to tell whether the page shows one, and
 * unlike no other text of the page.
 */
export const ARCHIVE_LINE_START: Record<Language, RegExp> = {
  en: /^Archive: /,
  fr: /^Archive : /,
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
  /** The sentence of the analysis while it is not there yet. */
  readonly pending: string;
  /** The sentence of a match whose analysis failed. */
  readonly cannotAnalyse: string;
  /** The name of the table of the analysis, the proof that it is shown. */
  readonly phaseTable: string;
  /** The text of the link to the match list. */
  readonly back: string;
  /** The title of the match list. */
  readonly listTitle: string;
}

/** The strings of the analysis dialog and of the back link, by language. */
export const ANALYSING_STRINGS: Record<Language, AnalysingStrings> = {
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

/**
 * Replace every run of white space (the narrow no-break spaces of French numbers and dates
 * included) by one plain space, the way Testing Library reads the text of a page, so that a text
 * built here and the same text read from the page compare equal whatever the locale writes.
 *
 * @param text - Any text.
 * @returns The text with plain spaces only.
 */
export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Format a date and time like the page does: short date, short time, in the language of the page.
 *
 * @param language - Language of the page.
 * @param time - Unix ms.
 * @returns The formatted date and time, with plain spaces.
 */
export function formatDateTime(language: Language, time: number): string {
  return normalizeSpaces(
    new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(time),
  );
}

/** What the header of a match must say, worked out from the stored match. */
export interface HeaderFacts {
  /** The text of the hero: its English name, or the name the page falls back to. */
  readonly hero: string;
  /** Start of the match, in Unix seconds. */
  readonly startTime: number;
  /** The type of the match, or `null` for modes the app does not know: the header says nothing. */
  readonly matchType: MatchType | null;
  /** Whether the player's team won. */
  readonly won: boolean;
  /** Duration of the match, in seconds. */
  readonly durationS: number;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  /** The souls of the player. */
  readonly netWorth: number;
}

/**
 * What the header must say of a match of the synthetic history: everything comes from the history
 * row the synthetic API invented the match from, and the hero's name from the catalogue it serves.
 *
 * @param row - The history row of the match.
 * @returns What the header must say.
 */
export function headerFactsOfRow(row: RawMatchHistoryRow): HeaderFacts {
  return {
    hero: catalogueHeroOf(row.hero_id).name,
    startTime: row.start_time,
    matchType: matchTypeOf({ gameMode: row.game_mode, matchMode: row.match_mode }),
    won: row.match_result === row.player_team,
    durationS: row.match_duration_s,
    kills: row.player_kills,
    deaths: row.player_deaths,
    assists: row.player_assists,
    netWorth: row.net_worth,
  };
}

/**
 * Write a duration as `minutes:seconds`, the way the match list and the header do.
 *
 * @param seconds - Duration in seconds.
 * @returns The duration, e.g. `34:05`.
 */
function clockOf(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * What the header of a match must show, one text per item, in reading order: the hero, the date,
 * the type (left out when the match has none), the result, the duration, the K/D/A and the souls.
 *
 * @param language - Language of the page.
 * @param facts - What the header must say.
 * @returns The texts of the items of the header.
 */
export function expectedHeader(language: Language, facts: HeaderFacts): string[] {
  const strings = STRINGS[language];
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  const souls = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });
  const items: (string | null)[] = [
    facts.hero,
    date.format(facts.startTime * 1000),
    facts.matchType === null ? null : strings.matchTypes[facts.matchType],
    facts.won ? strings.win : strings.loss,
    `${strings.header.duration} ${clockOf(facts.durationS)}`,
    `${strings.header.kda} ${String(facts.kills)} / ${String(facts.deaths)} / ${String(facts.assists)}`,
    `${strings.header.souls} ${souls.format(facts.netWorth)}`,
  ];
  return items.filter((item) => item !== null).map(normalizeSpaces);
}

/**
 * Find the header of the match: the list that comes right under the title of the page, in the same
 * header element as the title (so that the space the page leaves is between the two together and
 * what follows them).
 *
 * @returns The list, or `null` when the page shows no header.
 */
export function findHeader(): HTMLElement | null {
  const title = screen.getByRole('heading', { level: 1 });
  return title.closest('header')?.querySelector('ul') ?? null;
}

/**
 * Get the header of the match, which the test expects the page to show.
 *
 * @returns The list.
 */
export function requireHeader(): HTMLElement {
  return findHeader() ?? expect.unreachable('The page shows no header under its title');
}

/**
 * Read the header the page shows.
 *
 * @returns The text of each item of the header, in the order of the page.
 */
export function readHeader(): string[] {
  return within(requireHeader())
    .getAllByRole('listitem')
    .map((item) => normalizeSpaces(item.textContent));
}

/**
 * What the archive line of an archived match must say, worked out from what the services say of the
 * archive.
 *
 * @param language - Language of the page.
 * @param view - What the services say of the archived match.
 * @returns The line, with plain spaces.
 */
function expectedArchiveLine(language: Language, view: ReadyView): string {
  const kilobytes = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  return normalizeSpaces(
    STRINGS[language].archiveLine(
      String(view.facts.snapshots),
      String(view.facts.itemsBought),
      kilobytes.format(view.archivedBytes / 1024),
      formatDateTime(language, view.facts.fetchedAt),
    ),
  );
}

/**
 * Wait for the archive line of an archived match, written as the services' view of the archive says.
 *
 * @param language - Language of the page.
 * @param view - What the services say of the archived match.
 * @returns The element that holds the line.
 */
export async function findArchiveLine(language: Language, view: ReadyView): Promise<HTMLElement> {
  return screen.findByText(expectedArchiveLine(language, view));
}

/**
 * What the services say of a match that must be archived.
 *
 * @param services - The services of the test.
 * @param matchId - The match.
 * @returns The archived view.
 */
export async function archivedView(services: AppServices, matchId: MatchId): Promise<ReadyView> {
  const view = await services.details.getMatchDetail(matchId);
  if (view.kind !== 'ready') {
    return expect.unreachable(`The match should be archived, but its view is ${view.kind}`);
  }
  return view;
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
export async function archived(options: TestServicesOptions = {}): Promise<TestServices> {
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
export async function synchronised(options: TestServicesOptions = {}): Promise<TestServices> {
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
  /**
   * The value of the `tab` search parameter of the address the page opens at, as a link or a typed
   * address would give it: any text, a tab id or not. None by default, which opens the analysis.
   */
  readonly tab?: string;
}

/** The page {@link renderMatchDetail} rendered: its router and the history under it, to inspect. */
interface RenderedPage {
  readonly router: ReturnType<typeof createAppRouter>;
  readonly history: RouterHistory;
}

/**
 * Render the application on the detail page of a match.
 *
 * @param matchId - The match.
 * @param testServices - The services of the test.
 * @param options - See {@link RenderOptions}.
 * @param options.language - Language of the interface; English by default.
 * @param options.queryClient - The query client of the page; a test one by default.
 * @param options.strict - Whether to render the page inside `<StrictMode>`; off by default.
 * @param options.tab - The `tab` search parameter of the address the page opens at; none by default.
 * @returns The router of the page and its history.
 */
export async function renderMatchDetail(
  matchId: MatchId,
  testServices: TestServices,
  {
    language = 'en',
    queryClient = createTestQueryClient(testServices.logger),
    strict = false,
    tab,
  }: RenderOptions = {},
): Promise<RenderedPage> {
  const i18n = await createI18n(language);
  const search = tab === undefined ? '' : `?${new URLSearchParams({ tab }).toString()}`;
  const history = createMemoryHistory({ initialEntries: [`/matches/${String(matchId)}${search}`] });
  const router = createAppRouter(history);
  const page = (
    <AppProviders services={testServices.services} queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  render(strict ? <StrictMode>{page}</StrictMode> : page);
  return { router, history };
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
export function holdAnalysisBack(
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
 * Make the archive of one match impossible to read, every time, as a file another program holds
 * would be: the projection skips that match whenever it is asked to project it. The other archives
 * are read as usual.
 *
 * @param testServices - The services of the test.
 * @param locked - The match whose archive cannot be read.
 */
export function lockArchive(testServices: TestServices, locked: MatchId): void {
  const { archiveStore } = testServices;
  const read = archiveStore.read.bind(archiveStore);
  vi.spyOn(archiveStore, 'read').mockImplementation((accountId, matchId) =>
    matchId === locked ? Promise.reject(new Error('Access is denied')) : read(accountId, matchId),
  );
}

/** Let the page go on for a moment, to see that nothing more happens. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  });
}

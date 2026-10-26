/**
 * Tests of the match detail screen, rendered inside the whole application (router, shell,
 * providers) on the development adapters: synthetic deadlock-api, in-memory database and archive.
 * The analysis shown on the page is tested in `MatchDetailPage.analysis.test.tsx`, and the helpers
 * both files use are in `src/test/match-detail-page.tsx`.
 *
 * Most tests synchronise a small synthetic history first, like the application does, so the page
 * shows the real state of a match. What the page must show is worked out from the synthetic
 * history rows (the fixtures) and from what the services say of the match, never from numbers
 * written in the tests. The failed states (`unavailable`, `invalid`) are reached for real, by
 * making deadlock-api answer badly; the sentences of every explanation are checked in both
 * languages against a service that answers each view in turn.
 *
 * Every match with a row in the history has a header under the title of the page (the hero, the
 * date, the type, the result, the duration, the K/D/A and the souls). It is worked out from the
 * history row the synthetic API invented the match from, or from a row the test stores itself for a
 * match the fixtures do not hold (a Street Brawl match); an archived match ends with one line about
 * its archive. The header does not wait for the detail, and the page goes on working when the row
 * or the hero catalogue cannot be read.
 *
 * An archived match has four tabs (the analysis, the timeline, the damage and build, the players),
 * the one open kept in the address of the page: the tests open the page at an address that names a
 * tab, or none, and look at the router to see what the address says. What each tab shows is tested
 * with the tab; here, that the right one shows, and that the analysis of a match not analysed yet
 * runs whatever the tab open, the damage tab showing the damage once it is done.
 *
 * @packageDocumentation
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../../../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import { PAIGE_HERO_ID, type HeroAsset } from '../../../core/domain/hero';
import type { MatchId, MatchSummary } from '../../../core/domain/match';
import type { MatchType } from '../../../core/domain/match-type';
import { AppError } from '../../../core/errors/app-error';
import { MAX_RETRY_DELAY_MS } from '../../../core/match-detail/detail-status';
import type { Language } from '../../../core/settings/language';
import type { AppServices } from '../../../services/app-services';
import { MatchDetailRepository } from '../../../services/match-detail.repository';
import { MatchDetailService, type MatchDetailView } from '../../../services/match-detail.service';
import { MatchesRepository } from '../../../services/matches.repository';
import { SyncService } from '../../../services/sync.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
} from '../../../test/create-test-services';
import {
  ANALYSING_STRINGS,
  ARCHIVE_LINE_START,
  ARCHIVED_ID,
  ARCHIVED_IDS,
  ARCHIVED_ROW,
  archived,
  archivedView,
  catalogueHeroOf,
  expectedHeader,
  findArchiveLine,
  findHeader,
  formatDateTime,
  type HeaderFacts,
  headerFactsOfRow,
  holdAnalysisBack,
  lockArchive,
  MATCH_COUNT,
  MISSING_ID,
  MISSING_ROW,
  normalizeSpaces,
  NOW,
  type PageStrings,
  pickRow,
  readHeader,
  renderMatchDetail,
  requireHeader,
  settle,
  STRINGS,
  synchronised,
} from '../../../test/match-detail-page';
import { matchSummary, testMatchId } from '../../../test/test-data';
import type { MatchTab } from '../../app/router';
import { DETAILS_QUERY_KEY } from '../matches/use-matches';

/** The URL of a match detail request. */
const METADATA_URL = /\/v1\/matches\/\d+\/metadata/;

/** A match of another hero: the app never archives it. */
const OTHER_HERO_ROW = pickRow('match of another hero', (row) => row.hero_id !== PAIGE_HERO_ID);

/** The id of {@link OTHER_HERO_ROW}. */
const OTHER_HERO_ID = testMatchId(OTHER_HERO_ROW.match_id);

/** A match the app has never heard of: no row of the synthetic history has this id. */
const UNKNOWN_ID = testMatchId(1);

/**
 * A Street Brawl match, which the synthetic history does not hold (it has normal-mode matches only):
 * the tests store it themselves. Its id is below every id of the history, which starts at 108600000
 * and goes down by a few thousand per match.
 */
const STREET_BRAWL_ID = testMatchId(100_000_001);

/** A match of a game mode the app does not know, stored by the tests like {@link STREET_BRAWL_ID}. */
const UNKNOWN_MODE_ID = testMatchId(100_000_002);

/** The names of the tabs of an archived match, in English, by the id the address gives them. */
const TAB_NAMES: Readonly<Record<MatchTab, string>> = {
  analysis: 'Analysis',
  timeline: 'Timeline',
  damage: 'Damage and build',
  players: 'Players',
};

/** What the page says of an evicted match, by language (the shared strings of the tests lack them). */
const EVICTED_STRINGS: Readonly<Record<Language, { evicted: string; evictedLost: string }>> = {
  en: {
    evicted: "This match's archive was removed to free space: it is being downloaded again.",
    evictedLost:
      "This match's archive was removed to free space, and matches older than 90 days are not downloaded again.",
  },
  fr: {
    evicted:
      "L'archive de cette partie a été supprimée pour faire de la place : elle est téléchargée à nouveau.",
    evictedLost:
      "L'archive de cette partie a été supprimée pour faire de la place, et les parties de plus de 90 jours ne sont plus téléchargées.",
  },
};

/** The title of the damage tab in English: the proof that the tab shows the damage of the match. */
const DAMAGE_TITLE = 'Your damage to heroes, by source';

/** The title of the players tab in English: the proof that the tab shows the players of the match. */
const PLAYERS_TITLE = 'The 12 players';

/**
 * What the header must say of a match the test stored itself.
 *
 * @param summary - The match, as stored.
 * @param matchType - The type the header must give it, as the test knows it from the game's codes.
 * @returns What the header must say.
 */
function headerFactsOfSummary(summary: MatchSummary, matchType: MatchType | null): HeaderFacts {
  return {
    hero: catalogueHeroOf(summary.heroId).name,
    startTime: summary.startTime,
    matchType,
    won: summary.won,
    durationS: summary.durationS,
    kills: summary.kills,
    deaths: summary.deaths,
    assists: summary.assists,
    netWorth: summary.netWorth,
  };
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
  it('shows the header of an archived match from the history row', async () => {
    const testServices = await synchronised();
    const facts = headerFactsOfRow(ARCHIVED_ROW);
    // A normal-mode match has a type to show: without one, the check below could not see it.
    expect(facts.matchType).not.toBeNull();

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(
      await screen.findByRole('heading', { level: 1, name: `Match ${String(ARCHIVED_ID)}` }),
    ).toBeInTheDocument();
    // Under the title, the header says what the history row of the match says: the hero, the date,
    // the type, the result, the duration, the K/D/A and the souls.
    await waitFor(() => {
      expect(readHeader()).toEqual(expectedHeader('en', facts));
    });
    // The result is a word as much as a colour, like the one of the match list.
    expect(
      within(requireHeader()).getByText(facts.won ? STRINGS.en.win : STRINGS.en.loss),
    ).toHaveClass(facts.won ? 'text-win' : 'text-loss');
    // Nothing to retry, nothing to explain.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText(STRINGS.en.waiting)).not.toBeInTheDocument();
  });

  it('keeps the header of the match with the title it describes', async () => {
    const testServices = await synchronised();

    await renderMatchDetail(ARCHIVED_ID, testServices);

    await waitFor(() => {
      expect(findHeader()).not.toBeNull();
    });
    // The facts are in the header of the title, after it and close under it...
    const title = screen.getByRole('heading', { level: 1 });
    const header = requireHeader();
    expect(title.closest('header')).toContainElement(header);
    expect(title.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // ... and leave the space below them to the header of the page, not to a margin of their own: the
    // facts are not closer to the tabs than to the title they describe.
    expect(header.className).not.toMatch(/\bmb-/);
    expect(header.parentElement).toHaveClass('mt-2');
  });

  it('shows the header and the explanation for a Street Brawl match', async () => {
    const testServices = await synchronised();
    // A Street Brawl match of the player (game mode 4), which the synthetic history does not hold.
    const brawl = matchSummary({
      accountId: FIXTURE_ACCOUNT_ID,
      matchId: STREET_BRAWL_ID,
      gameMode: 4,
    });
    await new MatchesRepository(testServices.database).upsertMany([brawl]);

    await renderMatchDetail(STREET_BRAWL_ID, testServices);

    // The page says why the match has no archive, as it does for any match the app does not
    // archive, ...
    expect(await screen.findByText(STRINGS.en.notEligible)).toBeInTheDocument();
    // ... under a header that names the type of the match.
    await waitFor(() => {
      expect(readHeader()).toEqual(
        expectedHeader('en', headerFactsOfSummary(brawl, 'street_brawl')),
      );
    });
    expect(readHeader()).toContain('Street Brawl');
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
  });

  it('says nothing of the type of a match whose modes the app does not know', async () => {
    const testServices = await synchronised();
    // A game mode that no rule of the app reads: one that came with a later version of the game.
    const unknown = matchSummary({
      accountId: FIXTURE_ACCOUNT_ID,
      matchId: UNKNOWN_MODE_ID,
      gameMode: 9,
    });
    await new MatchesRepository(testServices.database).upsertMany([unknown]);

    await renderMatchDetail(UNKNOWN_MODE_ID, testServices);

    expect(await screen.findByText(STRINGS.en.notEligible)).toBeInTheDocument();
    // The header has the other six items, and no label rather than a wrong one.
    await waitFor(() => {
      expect(readHeader()).toEqual(expectedHeader('en', headerFactsOfSummary(unknown, null)));
    });
    expect(readHeader()).toHaveLength(6);
  });

  it('shows the archive line instead of the facts block', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The archive says its snapshots, its items, its size and its date in one line...
    const line = await findArchiveLine('en', view);
    // An archive is a few kilobytes: the size has one decimal at most.
    expect(line).toHaveTextContent(/, \d+(\.\d)? KB, /);
    // ... which comes after the analysis, at the end of the page...
    const analysis = await screen.findByRole('region', { name: 'Analysis' });
    expect(analysis.compareDocumentPosition(line)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // ... and the block of terms and definitions is gone, with the figures the header gives now.
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
    expect(screen.getByRole('main').querySelector('dl')).toBeNull();
    expect(screen.queryByText('Stat snapshots')).not.toBeInTheDocument();
    expect(screen.queryByText('Items bought')).not.toBeInTheDocument();
  });

  it("shows the hero's English name and image", async () => {
    const testServices = await synchronised();
    const paige = catalogueHeroOf(PAIGE_HERO_ID);

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The name is the English one of the catalogue, the first item of the header.
    await waitFor(() => {
      expect(readHeader()[0]).toBe(paige.name);
    });
    // Its small portrait comes with it. It is decorative, the name being written next to it, and
    // 24 pixels wide.
    const image =
      requireHeader().querySelector('img') ??
      expect.unreachable('The header shows the portrait of the hero');
    expect(image).toHaveAttribute('src', paige.images.icon_image_small_webp);
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveClass('size-6');
    const heroItem = within(requireHeader()).getAllByRole('listitem')[0];
    expect(image.closest('li')).toBe(heroItem);
    // The item is as high as the portrait (24 px) even before the portrait is there: a catalogue
    // that arrives late does not make the line grow.
    expect(heroItem).toHaveClass('min-h-6');
  });

  it('shows no image for a hero without a portrait', async () => {
    const testServices = await synchronised();
    const noPortrait: HeroAsset = {
      id: PAIGE_HERO_ID,
      name: catalogueHeroOf(PAIGE_HERO_ID).name,
      imageUrl: null,
      loadout: null,
    };
    vi.spyOn(testServices.services.heroes, 'getHeroAssets').mockResolvedValue([noPortrait]);

    await renderMatchDetail(ARCHIVED_ID, testServices);

    await waitFor(() => {
      expect(readHeader()[0]).toBe(noPortrait.name);
    });
    expect(requireHeader().querySelector('img')).toBeNull();
    // The hero item keeps the height of a portrait: the line is the same with or without one.
    expect(within(requireHeader()).getAllByRole('listitem')[0]).toHaveClass('min-h-6');
  });

  it('shows the name of the hero alone when its portrait fails to load', async () => {
    const testServices = await synchronised();
    const paige = catalogueHeroOf(PAIGE_HERO_ID);

    await renderMatchDetail(ARCHIVED_ID, testServices);

    await waitFor(() => {
      expect(readHeader()[0]).toBe(paige.name);
    });
    // The portrait lives on a remote bucket: offline, the browser would show its broken-image icon
    // in the first line of the page.
    fireEvent.error(
      requireHeader().querySelector('img') ??
        expect.unreachable('The header shows the portrait of the hero'),
    );

    // The name stays, with no picture and no square in its place; the line keeps its height.
    expect(requireHeader().querySelector('img')).toBeNull();
    expect(readHeader()[0]).toBe(paige.name);
    const heroItem = within(requireHeader()).getAllByRole('listitem')[0];
    expect(heroItem?.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(heroItem).toHaveClass('min-h-6');
  });

  it.each(['en', 'fr'] as const)(
    'names a hero the catalogue does not know by its id, in %s',
    async (language) => {
      const testServices = await synchronised();
      const getHeroAssets = vi
        .spyOn(testServices.services.heroes, 'getHeroAssets')
        .mockResolvedValue([]);

      await renderMatchDetail(ARCHIVED_ID, testServices, { language });

      // The catalogue answers, without the hero: the header keeps the id, in the language of the
      // page, and shows no image.
      await waitFor(() => {
        expect(getHeroAssets).toHaveBeenCalledTimes(1);
      });
      await settle();
      expect(readHeader()[0]).toBe(STRINGS[language].header.unknownHero(PAIGE_HERO_ID));
      expect(requireHeader().querySelector('img')).toBeNull();
    },
  );

  it('names the hero by its id, and shows no error, when the hero catalogue cannot be read', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    vi.spyOn(testServices.services.heroes, 'getHeroAssets').mockRejectedValue(
      new AppError('network', 'The hero catalogue cannot be downloaded'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The page is the page of the match, with its header: the catalogue only names the hero.
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
    await waitFor(() => {
      expect(testServices.logger.entries.filter((entry) => entry.scope === 'query')).toHaveLength(
        1,
      );
    });
    await settle();
    expect(readHeader()).toEqual(
      expectedHeader('en', {
        ...headerFactsOfRow(ARCHIVED_ROW),
        hero: STRINGS.en.header.unknownHero(ARCHIVED_ROW.hero_id),
      }),
    );
    expect(requireHeader().querySelector('img')).toBeNull();
    // No error on the page: the failure is for the log, once, without the parameters of the query.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'query')).toMatchObject([
      { level: 'error', context: { kind: 'network', query: 'heroes.assets' } },
    ]);
  });

  it('shows no header, and no error, when the row of the match cannot be read', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    vi.spyOn(testServices.services.matches, 'getMatch').mockRejectedValue(
      new AppError('storage', 'The match cannot be read'),
    );
    const getHeroAssets = vi.spyOn(testServices.services.heroes, 'getHeroAssets');

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The detail does not depend on the row: the page shows the match as usual, without a header.
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
    await waitFor(() => {
      expect(testServices.logger.entries.filter((entry) => entry.scope === 'query')).toHaveLength(
        1,
      );
    });
    await settle();
    expect(findHeader()).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // With no row there is no hero to name: the catalogue is not even asked for.
    expect(getHeroAssets).not.toHaveBeenCalled();
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'query')).toMatchObject([
      { level: 'error', context: { kind: 'storage', query: 'matches.one' } },
    ]);
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
    // The header does not depend on the archive: it comes from the history row of any match.
    await waitFor(() => {
      expect(readHeader()).toEqual(expectedHeader('en', headerFactsOfRow(OTHER_HERO_ROW)));
    });
    // The way back to the list does not depend on the match either.
    expect(screen.getByRole('link', { name: ANALYSING_STRINGS.en.back })).toBeInTheDocument();
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('explains that a match the app does not know is not archived', async () => {
    const testServices = await synchronised();
    await expect(testServices.services.details.getMatchDetail(UNKNOWN_ID)).resolves.toEqual({
      kind: 'not_eligible',
    });

    await renderMatchDetail(UNKNOWN_ID, testServices);

    expect(await screen.findByText(STRINGS.en.notEligible)).toBeInTheDocument();
    // The history has no row for it: there is nothing to put in a header.
    await settle();
    expect(findHeader()).toBeNull();
  });

  it('explains that no account is linked and contacts nobody', async () => {
    const testServices = createTestServices({ now: () => NOW, accountId: null });

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
    ).toBeInTheDocument();
    await settle();
    expect(findHeader()).toBeNull();
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
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
    // The header is the one of the history row, whatever the state of the detail.
    await waitFor(() => {
      expect(readHeader()).toEqual(expectedHeader('en', headerFactsOfRow(MISSING_ROW)));
    });
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
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
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
    const requestsBefore = detailRequestCount(testServices);

    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    // The status changes: the match is archived, and the page shows its archive line instead of the
    // explanation and the button.
    await screen.findByText(ARCHIVE_LINE_START.en);
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
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

    await screen.findByText(ARCHIVE_LINE_START.en);
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
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

    // The retry runs its course: the match is archived and the page shows its archive line.
    await screen.findByText(ARCHIVE_LINE_START.en);
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
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
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
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
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
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
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
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

    await screen.findByText(ARCHIVE_LINE_START.en);
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
    expect(screen.queryByText(STRINGS.en.missing)).not.toBeInTheDocument();
  });

  it('downloads an evicted match again, once, when its page opens', async () => {
    const testServices = await synchronised();
    const { details, sync } = testServices.services;
    await new MatchDetailRepository(testServices.database).markEvicted(
      testServices.accountId ?? expect.unreachable('the services have a linked account'),
      ARCHIVED_ID,
    );
    // The download is held until the test lets it go, so that the page can be seen while it runs.
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retryDetail = vi.spyOn(sync, 'retryDetail').mockImplementation(() => released);

    // Inside `<StrictMode>`, which replays the effects: the page must still ask for one download.
    await renderMatchDetail(ARCHIVED_ID, testServices, { strict: true });

    try {
      expect(await screen.findByText(EVICTED_STRINGS.en.evicted)).toBeInTheDocument();
      // The download is automatic: no button, no tabs.
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      await waitFor(() => {
        expect(retryDetail).toHaveBeenCalledTimes(1);
      });
      expect(retryDetail).toHaveBeenCalledWith(ARCHIVED_ID);
      // The service put the match back to pending when the page read it.
      await expect(details.getMatchDetail(ARCHIVED_ID)).resolves.toMatchObject({
        kind: 'waiting',
      });
    } finally {
      // Whatever the assertions said, the download ends: a failing test leaves nothing blocked.
      release();
    }

    // The page reads the match again once the download is over, and does not ask for it twice.
    await settle();
    expect(retryDetail).toHaveBeenCalledTimes(1);
  });

  it('asks for the download of each evicted match its page shows, and for none twice', async () => {
    const [first, second] = ARCHIVED_IDS;
    if (first === undefined || second === undefined) {
      throw new Error('The synthetic history archives two matches');
    }
    const testServices = createTestServices({ now: () => NOW });
    const retryDetail = vi.spyOn(testServices.services.sync, 'retryDetail').mockResolvedValue();
    // Every read says the archive was removed, and the views are in the cache before the page
    // renders: it has a view from its very first render, so under `<StrictMode>` the effect that
    // asks for the download runs, and is replayed, with the view in hand.
    vi.spyOn(MatchDetailService.prototype, 'getMatchDetail').mockResolvedValue({ kind: 'evicted' });
    const queryClient = createTestQueryClient(testServices.logger);
    for (const matchId of [first, second]) {
      queryClient.setQueryData([...DETAILS_QUERY_KEY, 'match', matchId], { kind: 'evicted' });
    }

    const { router } = await renderMatchDetail(first, testServices, { queryClient, strict: true });

    expect(await screen.findByText(EVICTED_STRINGS.en.evicted)).toBeInTheDocument();
    // The run settles and the page reads the match again (still evicted): no second download.
    await settle();
    expect(retryDetail.mock.calls).toEqual([[first]]);

    // Another evicted match on the same page is another download, and only one.
    await router.navigate({
      to: '/matches/$matchId',
      params: { matchId: second },
      search: { tab: 'analysis' },
    });
    await waitFor(() => {
      expect(retryDetail.mock.calls).toEqual([[first], [second]]);
    });
    await settle();
    expect(retryDetail.mock.calls).toEqual([[first], [second]]);
  });

  it('refreshes the counts and the matches, once, when it puts an evicted match back', async () => {
    const testServices = await synchronised();
    await new MatchDetailRepository(testServices.database).markEvicted(
      testServices.accountId ?? expect.unreachable('the services have a linked account'),
      ARCHIVED_ID,
    );
    // The download never ends in this test, so only the refresh of the read itself is seen.
    vi.spyOn(testServices.services.sync, 'retryDetail').mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const queryClient = createTestQueryClient(testServices.logger);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });

    expect(await screen.findByText(EVICTED_STRINGS.en.evicted)).toBeInTheDocument();
    // The service put the match back to pending, so the banner and the list changed.
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['details', 'summary'] },
      { queryKey: ['matches'] },
    ]);
  });

  it('shows an evicted match again once the download fetched its archive', async () => {
    const testServices = await synchronised();
    await new MatchDetailRepository(testServices.database).markEvicted(
      testServices.accountId ?? expect.unreachable('the services have a linked account'),
      ARCHIVED_ID,
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The real download runs: the archive is written again and the page shows it.
    await screen.findByText(ARCHIVE_LINE_START.en);
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
    expect(screen.queryByText(EVICTED_STRINGS.en.evicted)).not.toBeInTheDocument();
  });

  it('says an evicted match older than 90 days is gone, and asks for no download', async () => {
    // The clock of the services moves on by hand: the match is archived now and shown 91 days later.
    let clock = NOW;
    const testServices = await synchronised({ now: () => clock });
    await new MatchDetailRepository(testServices.database).markEvicted(
      testServices.accountId ?? expect.unreachable('the services have a linked account'),
      ARCHIVED_ID,
    );
    clock = NOW + 91 * 24 * 60 * 60_000;
    const retryDetail = vi.spyOn(testServices.services.sync, 'retryDetail');
    const syncNow = vi.spyOn(testServices.services.sync, 'syncNow');

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(await screen.findByText(EVICTED_STRINGS.en.evictedLost)).toBeInTheDocument();
    expect(screen.queryByText(EVICTED_STRINGS.en.evicted)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await settle();
    expect(retryDetail).not.toHaveBeenCalled();
    expect(syncNow).not.toHaveBeenCalled();
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
    expect(screen.queryByText(ARCHIVE_LINE_START.en)).not.toBeInTheDocument();
  });

  it('shows the French labels', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);

    await renderMatchDetail(ARCHIVED_ID, testServices, { language: 'fr' });

    expect(
      await screen.findByRole('heading', { level: 1, name: `Partie ${String(ARCHIVED_ID)}` }),
    ).toBeInTheDocument();
    // The header and the archive line are in French: the labels, the type, the result, the date and
    // the numbers. The hero keeps its English name.
    await waitFor(() => {
      expect(readHeader()).toEqual(expectedHeader('fr', headerFactsOfRow(ARCHIVED_ROW)));
    });
    expect(readHeader()[0]).toBe(catalogueHeroOf(ARCHIVED_ROW.hero_id).name);
    expect(await findArchiveLine('fr', view)).toBeInTheDocument();
  });
});

describe('MatchDetailPage tabs', () => {
  const strings = ANALYSING_STRINGS.en;

  it('opens the analysis tab for an unknown tab', async () => {
    const testServices = await synchronised();

    const { router } = await renderMatchDetail(ARCHIVED_ID, testServices, { tab: 'bogus' });

    // The address names no tab the page has: the page opens the analysis, as for an address that
    // names none, and the address says so.
    const selected = await screen.findByRole('tab', { selected: true });
    expect(selected).toHaveAccessibleName(TAB_NAMES.analysis);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(
      Object.values(TAB_NAMES),
    );
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(TAB_NAMES.analysis);
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ tab: 'analysis' });
  });

  it('shows no tabs for a match with no archive', async () => {
    const testServices = await synchronised();
    const { breakdown } = testServices.services;
    const getDamageTab = vi.spyOn(breakdown, 'getDamageTab');
    const getPlayersTab = vi.spyOn(breakdown, 'getPlayersTab');

    // Even when the address names a tab: the tabs are for an archived match only.
    await renderMatchDetail(MISSING_ID, testServices, { tab: 'damage' });

    expect(await screen.findByText(STRINGS.en.waiting)).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    // Nothing of the tabs is read either.
    expect(getDamageTab).not.toHaveBeenCalled();
    expect(getPlayersTab).not.toHaveBeenCalled();
  });

  it('runs the fallback analysis once from the damage tab', async () => {
    const testServices = await archived();
    const { analyse, release } = holdAnalysisBack(testServices.services);
    const getDamageTab = vi.spyOn(testServices.services.breakdown, 'getDamageTab');

    try {
      // Inside StrictMode, which mounts the effects twice: the start survives the replay.
      await renderMatchDetail(ARCHIVED_ID, testServices, { tab: 'damage', strict: true });

      // The damage tab is open, and the match is analysed all the same, behind the dialog: the page
      // starts the analysis, whatever the tab.
      await screen.findByRole('dialog', { name: strings.dialog });
      expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(TAB_NAMES.damage);
      // The sentence of the analysis in progress sits above the tabs, where every tab shows it.
      const sentence = screen.getByText(strings.pending);
      expect(sentence).toHaveAttribute('role', 'status');
      expect(sentence.compareDocumentPosition(screen.getByRole('tablist'))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      // The tab has nothing to show yet: the match is not projected.
      await waitFor(() => {
        expect(getDamageTab).toHaveBeenCalled();
      });
      await expect(getDamageTab.mock.results[0]?.value).resolves.toEqual({ kind: 'pending' });
      await settle();
      expect(screen.queryByRole('heading', { name: DAMAGE_TITLE })).not.toBeInTheDocument();
      expect(analyse).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    } finally {
      release();
    }

    // Once the analysis is stored, the tab is read again and shows the damage of the match.
    expect(
      await screen.findByRole('heading', { level: 2, name: DAMAGE_TITLE }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(strings.pending)).not.toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
    // The analysis tab was never opened: none of the analysis is on the page.
    expect(screen.queryByRole('table', { name: strings.phaseTable })).not.toBeInTheDocument();
  });

  it('runs the fallback analysis once from the players tab, which does not wait for it', async () => {
    const testServices = await archived();
    const { analyse, release } = holdAnalysisBack(testServices.services);

    try {
      // Inside StrictMode, which mounts the effects twice: the start survives the replay.
      await renderMatchDetail(ARCHIVED_ID, testServices, { tab: 'players', strict: true });

      // The players tab is open, and the match is analysed all the same, behind the dialog, with
      // the sentence above the tabs.
      await screen.findByRole('dialog', { name: strings.dialog });
      expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(TAB_NAMES.players);
      const sentence = screen.getByText(strings.pending);
      expect(sentence).toHaveAttribute('role', 'status');
      expect(sentence.compareDocumentPosition(screen.getByRole('tablist'))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      // The players are read from the archive of the match, not from its analysis: they show while
      // the analysis runs.
      expect(
        await screen.findByRole('heading', { level: 2, name: PLAYERS_TITLE }),
      ).toBeInTheDocument();
      await settle();
      expect(analyse).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    } finally {
      release();
    }

    // The dialog and the sentence go once the analysis is stored; the players stay.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(strings.pending)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: PLAYERS_TITLE })).toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
    expect(screen.queryByRole('table', { name: strings.phaseTable })).not.toBeInTheDocument();
  });

  it('keeps the tab in the URL', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();
    const { router, history } = await renderMatchDetail(ARCHIVED_ID, testServices);
    expect(await screen.findByRole('tab', { selected: true })).toHaveAccessibleName(
      TAB_NAMES.analysis,
    );
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    const entries = history.length;

    await user.click(screen.getByRole('tab', { name: TAB_NAMES.damage }));

    // The address names the tab now, and the tab shows its panel in place of the analysis.
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'damage' });
    });
    expect(router.state.location.pathname).toBe(`/matches/${String(ARCHIVED_ID)}`);
    expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(TAB_NAMES.damage);
    expect(
      await screen.findByRole('heading', { level: 2, name: DAMAGE_TITLE }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: strings.phaseTable })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: TAB_NAMES.players }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'players' });
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: PLAYERS_TITLE }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: DAMAGE_TITLE })).not.toBeInTheDocument();
    // Each tab replaced the address of the one before: going back leaves the match, not the tab.
    expect(history.length).toBe(entries);
  });

  it('moves between tabs with the keyboard', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();
    const { router } = await renderMatchDetail(ARCHIVED_ID, testServices);
    const analysisTab = await screen.findByRole('tab', {
      name: TAB_NAMES.analysis,
      selected: true,
    });
    act(() => {
      analysisTab.focus();
    });

    // The timeline is the next tab, and the damage and build the one after it.
    await user.keyboard('{ArrowRight}{ArrowRight}');

    // The tab takes the focus and the selection, and shows its panel.
    const damageTab = screen.getByRole('tab', { name: TAB_NAMES.damage });
    expect(damageTab).toHaveFocus();
    await waitFor(() => {
      expect(damageTab).toHaveAttribute('aria-selected', 'true');
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: DAMAGE_TITLE }),
    ).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ tab: 'damage' });

    await user.keyboard('{ArrowLeft}{ArrowLeft}');

    // And back to the analysis.
    expect(analysisTab).toHaveFocus();
    await waitFor(() => {
      expect(analysisTab).toHaveAttribute('aria-selected', 'true');
    });
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ tab: 'analysis' });
  });

  it('keeps the analysis of a match whose window cannot be completed after a visit to another tab', async () => {
    const user = userEvent.setup();
    const testServices = await archived();
    const { analysis } = testServices.services;
    lockArchive(testServices, ARCHIVED_IDS[1] ?? expect.unreachable('a match is in the window'));
    const analyse = vi.spyOn(analysis, 'analyseMatch');
    const refresh = vi.spyOn(analysis, 'refreshCommunity');
    await renderMatchDetail(ARCHIVED_ID, testServices);
    // The analysis runs and is shown; the read that follows the community refresh says `pending`,
    // the window of the habits being incomplete, and the page keeps the analysis (see the test of
    // the analysis start).
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    await settle();
    await expect(analysis.getMatchAnalysis(ARCHIVED_ID)).resolves.toEqual({ kind: 'pending' });

    // The player looks at the damage, then comes back to the analysis, whose read still says
    // `pending`: the analysis tab is mounted again over it.
    await user.click(screen.getByRole('tab', { name: TAB_NAMES.damage }));
    expect(
      await screen.findByRole('heading', { level: 2, name: DAMAGE_TITLE }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: TAB_NAMES.analysis }));
    await settle();

    // The analysis tab shows the analysis of this opening again, and nothing says it is in progress.
    expect(screen.getByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    expect(screen.queryByText(strings.pending)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(1);
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
  {
    // The download is automatic, so there is no button to press.
    name: 'a match whose archive was evicted',
    view: { kind: 'evicted' },
    says: (_strings, language) => [EVICTED_STRINGS[language].evicted],
    offersRetry: false,
  },
  {
    name: 'a match whose evicted archive is gone',
    view: { kind: 'evicted_lost' },
    says: (_strings, language) => [EVICTED_STRINGS[language].evictedLost],
    offersRetry: false,
  },
];

/** The kinds of view of a match the app stores and archives, whose detail the page cannot show. */
const NO_DETAIL_KINDS: readonly MatchDetailView['kind'][] = [
  'unavailable',
  'invalid',
  'missing',
  'lost',
  'evicted',
  'evicted_lost',
];

/** The explained views of {@link NO_DETAIL_KINDS}: the header must stay over their sentence. */
const NO_DETAIL_VIEWS = EXPLAINED_VIEWS.filter(({ view }) => NO_DETAIL_KINDS.includes(view.kind));

describe.each(['en', 'fr'] as const)('MatchDetailPage in %s', (language) => {
  beforeEach(() => {
    // The page of an evicted match asks for its download: these tests play the views, not the run.
    vi.spyOn(SyncService.prototype, 'retryDetail').mockResolvedValue();
  });

  it.each(NO_DETAIL_VIEWS)('shows the header of $name', async ({ view, says, offersRetry }) => {
    // The match is stored and synchronised; only what the services say of its detail is played.
    const testServices = await synchronised();
    vi.spyOn(MatchDetailService.prototype, 'getMatchDetail').mockResolvedValue(view);
    const strings = STRINGS[language];

    await renderMatchDetail(ARCHIVED_ID, testServices, { language });

    // The sentence of the view is under the header of the history row, which does not depend on the
    // detail: the same hero, date, type, result and figures as for an archived match.
    for (const sentence of says(strings, language)) {
      expect(await screen.findByText(normalizeSpaces(sentence))).toBeInTheDocument();
    }
    await waitFor(() => {
      expect(readHeader()).toEqual(expectedHeader(language, headerFactsOfRow(ARCHIVED_ROW)));
    });
    expect(screen.queryByText(ARCHIVE_LINE_START[language])).not.toBeInTheDocument();
    // The button of a view that offers a retry sits with the header, not instead of it.
    if (offersRetry) {
      expect(screen.getByRole('button', { name: strings.retry })).toBeEnabled();
    } else {
      expect(screen.queryByRole('button', { name: strings.retry })).not.toBeInTheDocument();
    }
  });

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
    // The tabs are for an archived match: the sentence stands alone under the header.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});

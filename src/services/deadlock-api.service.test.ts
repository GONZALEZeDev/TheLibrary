/**
 * Tests of the deadlock-api service, with the development HTTP client and an in-memory database.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import {
  FIXTURE_EXPRESS_SHOT_ID,
  FIXTURE_PAIGE_ABILITY_IDS,
  FIXTURE_SHOP_ITEM_IDS,
} from '../adapters/dev/fixtures/assets.fixture';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
} from '../adapters/dev/fixtures/match-history.fixture';
import { isMetadataMissing } from '../adapters/dev/fixtures/match-metadata.fixture';
import { FIXTURE_AVATAR_HASH, FIXTURE_PERSONA_NAME } from '../adapters/dev/fixtures/steam.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { DEFAULT_PAUSE_MS } from '../core/deadlock-api/api-response';
import { ASSET_IMAGE_ORIGIN } from '../core/deadlock-api/assets.schema';
import {
  itemsRequest,
  MAX_RESPONSE_BYTES,
  matchMetadataRequest,
  ranksRequest,
  type CohortQuery,
} from '../core/deadlock-api/endpoints';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { RANK_TIER_NAMES } from '../core/domain/rank';
import { AppError, errorLogContext, isAppError } from '../core/errors/app-error';
import type { Database } from '../ports/database.port';
import type { HttpRequest, HttpResponse } from '../ports/http-client.port';
import { createTestDatabase, testAccountId, testMatchId } from '../test/test-data';
import {
  DeadlockApiService,
  type AnalyticsFetch,
  type MetadataFetch,
} from './deadlock-api.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MINUTE = 60_000;

/**
 * Build the service on the given handler, with a controllable clock.
 *
 * The service does not really sleep: its `sleep` records the wait it was asked for, lets the test
 * act "meanwhile" (`sleeper.during`), then moves the clock forward by that wait.
 *
 * @param handler - Answers the requests; the fixture API by default.
 * @param database - The database; a fresh one by default.
 * @returns The service, its HTTP client, logger, clock and sleeper.
 */
function setUp(
  handler: FixtureHandler = createFixtureApi({ now: START, matchCount: 5 }),
  database: Database = createTestDatabase(),
) {
  const clock = { now: START };
  const sleeper = {
    /** The wait of each call of `sleep`, in milliseconds, oldest first. */
    calls: [] as number[],
    /** How many requests had been sent when each call of `sleep` was made and time went by. */
    sentWhileSleeping: [] as number[],
    /** Runs while the service sleeps, before the clock moves: what happens meanwhile. */
    during: undefined as (() => Promise<void> | void) | undefined,
  };
  const http = new FixtureHttpClient(handler);
  const logger = new MemoryLogger();
  const syncState = new SyncStateRepository(database, logger, () => clock.now);
  const api = new DeadlockApiService(http, syncState, logger, {
    appVersion: '0.1.0',
    now: () => clock.now,
    sleep: async (ms) => {
      sleeper.calls.push(ms);
      // Time goes by while the service sleeps: the other calls do all they can without waiting.
      await settle();
      sleeper.sentWhileSleeping.push(http.requests.length);
      await sleeper.during?.();
      clock.now += ms;
    },
  });
  return { api, http, logger, clock, syncState, sleeper };
}

describe('DeadlockApiService.fetchMatchHistory', () => {
  it('downloads and validates the history, with the User-Agent, timeout and size limit of the app', async () => {
    const { api, http } = setUp();

    const result = await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });

    expect(result).toMatchObject({ kind: 'fetched', fromSteam: true });
    expect(result.kind === 'fetched' ? result.matches : []).toHaveLength(5);
    expect(http.requests).toEqual([
      {
        method: 'GET',
        url: 'https://api.deadlock-api.com/v1/players/1000001/match-history',
        headers: {
          'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
          Accept: 'application/json',
        },
        timeoutMs: 15_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
    ]);
  });

  it('lets automatic requests use 6 requests per hour and keeps the last 2 for the user', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 6; index += 1) {
      clock.now = START + index * MINUTE;
      await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }
    clock.now = START + 6 * MINUTE;

    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + 60 * MINUTE,
    });
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'budget_exhausted' });
    expect(http.requests).toHaveLength(8);
  });

  it('keeps counting the budget after a restart', async () => {
    const database = createTestDatabase();
    const first = setUp(undefined, database);
    for (let index = 0; index < 6; index += 1) {
      await first.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }

    const restarted = setUp(undefined, database);

    await expect(
      restarted.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'budget_exhausted' });
    expect(restarted.http.requests).toHaveLength(0);
  });

  it('lets the budget recover within the hour when the system clock moved backwards', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 6; index += 1) {
      clock.now = START + index * MINUTE;
      await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }

    clock.now = START - 48 * 60 * MINUTE;
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'budget_exhausted' });
    clock.now += 61 * MINUTE;
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    expect(http.requests).toHaveLength(7);
  });

  it('never lets overlapping calls exceed the budget', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 5; index += 1) {
      clock.now = START + index * MINUTE;
      await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }

    const results = await Promise.all([
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ]);

    expect(results.map((result) => result.kind).toSorted()).toEqual([
      'budget_exhausted',
      'fetched',
    ]);
    expect(http.requests).toHaveLength(6);
  });

  it('counts a request that failed', async () => {
    const { api, syncState } = setUp(() => {
      throw new AppError('network', 'The request failed');
    });

    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })).rejects.toThrow(
      AppError,
    );
    await expect(syncState.getHistoryRequests()).resolves.toEqual([START]);
  });

  it('uses the stored history that a 429 still returns, as not refreshed from Steam', async () => {
    const { api } = setUp(() => jsonResponse([], 429, { 'called-steam': 'false' }));

    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })).resolves.toEqual({
      kind: 'fetched',
      matches: [],
      fromSteam: false,
    });
  });

  it('saves the pause deadlock-api asks for and sends nothing until it ends, even after a restart', async () => {
    const database = createTestDatabase();
    const first = setUp(
      () => jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
      database,
    );

    await expect(
      first.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toEqual({ kind: 'paused', until: START + 120_000 });

    const restarted = setUp(undefined, database);
    restarted.clock.now = START + 60_000;
    await expect(
      restarted.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toEqual({ kind: 'paused', until: START + 120_000 });
    expect(restarted.http.requests).toHaveLength(0);

    restarted.clock.now = START + 120_001;
    await expect(
      restarted.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'fetched' });
  });

  it('logs the pause without the account id', async () => {
    const { api, logger } = setUp(() => jsonResponse('', 503, { 'retry-after': '5' }));

    await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'deadlock-api asked to pause the requests',
        context: expect.objectContaining({
          endpoint: '/v1/players/{account_id}/match-history',
          status: 503,
        }) as unknown,
      }),
    );
    expect(JSON.stringify(logger.entries)).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'service_unavailable'],
  ] as const)('reports a %s as %s', async (status, kind) => {
    const { api } = setUp(() => jsonResponse({}, status));

    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).rejects.toMatchObject({ kind });
  });

  it('removes the account id that a transport error quotes', async () => {
    const { api } = setUp(() => {
      throw new AppError('network', 'The request failed', {
        cause:
          'error sending request for url (https://api.deadlock-api.com/v1/players/1000001/match-history)',
      });
    });

    const error = await api
      .fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: 'network',
      context: { endpoint: '/v1/players/{account_id}/match-history' },
      cause:
        'error sending request for url (https://api.deadlock-api.com/v1/players/{account_id}/match-history)',
    });
  });

  it('logs the rows it had to drop', async () => {
    const valid = JSON.parse(
      (
        await new FixtureHttpClient(createFixtureApi({ now: START, matchCount: 1 })).get({
          url: 'https://api.deadlock-api.com/v1/players/1000001/match-history',
          headers: {},
          timeoutMs: 1,
          maxBodyBytes: 1_000_000,
        })
      ).body,
    ) as unknown[];
    const { api, logger } = setUp(() => jsonResponse([...valid, { match_id: 'broken' }]));

    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'Ignored invalid rows of the match history',
        context: expect.objectContaining({ invalidRows: 1 }) as unknown,
      }),
    );
  });
});

describe('DeadlockApiService.fetchHeroes', () => {
  it('downloads the playable heroes', async () => {
    const { api } = setUp();

    const heroes = await api.fetchHeroes();

    expect(heroes.map((hero) => hero.name)).toContain('Paige');
    // Baba is still in development in the fixture catalogue: no hero a player cannot pick.
    expect(heroes.map((hero) => hero.name)).not.toContain('Baba');
  });

  it('fetches the heroes with their images and loadout', async () => {
    const { api } = setUp();

    const heroes = await api.fetchHeroes();

    // Paige's loadout is the real one (hero asset 67): the weapon, the melee and the four
    // signature abilities, the ultimate last.
    expect(heroes.find((hero) => hero.id === PAIGE_HERO_ID)).toEqual({
      id: PAIGE_HERO_ID,
      name: 'Paige',
      imageUrl: `${ASSET_IMAGE_ORIGIN}assets-api-res/images/heroes/bookworm_sm.webp`,
      loadout: {
        weapon: 'citadel_weapon_bookworm_set2',
        melee: 'ability_melee_bookworm',
        abilities: [
          'ability_bookworm_dragonfire',
          'ability_bookworm_knightbarrier',
          'ability_bookworm_aoemagic',
          'ability_bookworm_knightcharge',
        ],
      },
    });
    // Every playable hero of the fixture has a portrait on the asset bucket and a whole loadout.
    for (const hero of heroes) {
      expect(hero.imageUrl?.startsWith(ASSET_IMAGE_ORIGIN)).toBe(true);
      expect(hero.loadout?.abilities).toHaveLength(4);
    }
  });

  it('allows 2 requests per second', async () => {
    const { api, clock } = setUp();

    await api.fetchHeroes();
    await api.fetchHeroes();
    await expect(api.fetchHeroes()).rejects.toMatchObject({ kind: 'rate_limited' });
    clock.now += 1_000;
    await expect(api.fetchHeroes()).resolves.not.toHaveLength(0);
  });

  it('respects a pause asked for on another endpoint', async () => {
    const { api, syncState } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    await expect(api.fetchHeroes()).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

describe('DeadlockApiService asset requests', () => {
  it('fetches the item and rank catalogues through the asset budget', async () => {
    const { api, http } = setUp();

    const items = await api.fetchItemCatalogue();
    const ranks = await api.fetchRankCatalogue();

    expect(http.requests.map((request) => request.url)).toEqual([
      itemsRequest().url,
      ranksRequest().url,
    ]);
    // Express Shot: the one shop item a Paige match damages with, a weapon item of tier 3.
    const expressShot = items.find((item) => item.className === 'upgrade_express_shot');
    expect(expressShot).toMatchObject({
      id: 690458959,
      name: 'Express Shot',
      kind: 'upgrade',
      slot: 'weapon',
      tier: 3,
    });
    expect(expressShot?.imageUrl?.startsWith(ASSET_IMAGE_ORIGIN)).toBe(true);
    // Paige's weapon: the real class name and id of the game data.
    expect(items.find((item) => item.className === 'citadel_weapon_bookworm_set2')).toMatchObject({
      id: 4260448939,
      name: "Chapter's End",
      kind: 'weapon',
    });
    // The twelve tiers, Obscurus to Eternus, each with a badge on the asset bucket.
    expect(ranks.map((rank) => rank.tier)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ranks.map((rank) => rank.name)).toEqual(RANK_TIER_NAMES);
    for (const rank of ranks) {
      expect(rank.imageUrl?.startsWith(ASSET_IMAGE_ORIGIN)).toBe(true);
    }
    // The three requests share one budget: the hero catalogue is refused in the same second.
    await expect(api.fetchHeroes()).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(http.requests).toHaveLength(2);
  });

  it('refuses the third asset request of a second without sending it', async () => {
    const { api, http, clock } = setUp();
    await api.fetchHeroes();
    await api.fetchItemCatalogue();

    // Whichever catalogue asks, the third request of the second is refused with the time it may
    // be sent, and none of them reaches the network.
    for (const refused of [
      () => api.fetchHeroes(),
      () => api.fetchItemCatalogue(),
      () => api.fetchRankCatalogue(),
    ]) {
      await expect(refused()).rejects.toMatchObject({
        kind: 'rate_limited',
        context: { nextAllowedAt: START + 1_000 },
      });
    }
    expect(http.requests).toHaveLength(2);

    // A refused request is not counted: a second later, the budget is whole again.
    clock.now += 1_000;
    await expect(api.fetchRankCatalogue()).resolves.toHaveLength(12);
    await expect(api.fetchItemCatalogue()).resolves.not.toHaveLength(0);
    expect(http.requests).toHaveLength(4);
  });

  it('throws rate_limited during a pause', async () => {
    const { api, http, syncState } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    await expect(api.fetchItemCatalogue()).rejects.toMatchObject({
      kind: 'rate_limited',
      context: { pausedUntil: START + 5_000 },
    });
    await expect(api.fetchRankCatalogue()).rejects.toMatchObject({
      kind: 'rate_limited',
      context: { pausedUntil: START + 5_000 },
    });
    // Nothing was sent, and the refusals used none of the asset budget.
    expect(http.requests).toHaveLength(0);
    await syncState.setPausedUntil(null);
    await api.fetchItemCatalogue();
    await expect(api.fetchRankCatalogue()).resolves.toHaveLength(12);
  });

  it('throws the pause deadlock-api asks for and keeps it for the next requests', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
    );

    await expect(api.fetchItemCatalogue()).rejects.toMatchObject({ kind: 'rate_limited' });

    await expect(syncState.getPausedUntil()).resolves.toBe(START + 120_000);
    await expect(api.fetchRankCatalogue()).rejects.toMatchObject({
      kind: 'rate_limited',
      context: { pausedUntil: START + 120_000 },
    });
    expect(http.requests).toHaveLength(1);
  });

  it('lets an empty catalogue fail as invalid_payload', async () => {
    const { api } = setUp(() => jsonResponse([]));

    // The cache service of the catalogues treats it as a failed download.
    await expect(api.fetchItemCatalogue()).rejects.toMatchObject({ kind: 'invalid_payload' });
    await expect(api.fetchRankCatalogue()).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it('serves catalogues that agree with each other and with the ids they export', async () => {
    const { api } = setUp();
    const items = await api.fetchItemCatalogue();
    const heroes = await api.fetchHeroes();
    const idOf = (className: string) => items.find((item) => item.className === className)?.id;
    const loadoutOf = (heroId: number) =>
      heroes.find((hero) => hero.id === heroId)?.loadout ??
      expect.unreachable('the hero has a loadout');

    // Paige's whole loadout is in the item catalogue, her signatures under the exported ids.
    const paige = loadoutOf(PAIGE_HERO_ID);
    expect(paige.abilities.map(idOf)).toEqual(FIXTURE_PAIGE_ABILITY_IDS);
    expect(idOf(paige.weapon)).toBe(4260448939);
    expect(idOf(paige.melee)).toBe(3850113264);
    // The ability of another hero is there too, under that hero's loadout and not Paige's.
    const [otherAbility = ''] = loadoutOf(1).abilities;
    expect(items.find((item) => item.className === otherAbility)).toMatchObject({
      kind: 'ability',
      name: 'Flame Wave',
    });
    expect(paige.abilities).not.toContain(otherAbility);
    // The catalogue has an entry without a name, which the parser reads as unnamed.
    expect(items.filter((item) => item.name === null)).toHaveLength(1);

    // Every id is unique: `item_id` and `ability_id` of a match name one entry.
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    // The exported shop ids are the shop items of the catalogue, Express Shot among them, over the
    // three slots and the tiers 1 to 4, each shown by an image of the asset bucket.
    const shopItems = items.filter((item) => item.kind === 'upgrade');
    expect(shopItems.map((item) => item.id)).toEqual(FIXTURE_SHOP_ITEM_IDS);
    expect(FIXTURE_SHOP_ITEM_IDS).toContain(FIXTURE_EXPRESS_SHOT_ID);
    expect(new Set(shopItems.map((item) => item.slot))).toEqual(
      new Set(['weapon', 'vitality', 'spirit']),
    );
    expect(new Set(shopItems.map((item) => item.tier))).toEqual(new Set([1, 2, 3, 4]));
    for (const item of shopItems) {
      expect(item.imageUrl?.startsWith(ASSET_IMAGE_ORIGIN)).toBe(true);
    }
  });
});

/** Answers every request with a small valid JSON: for the tests that ignore the detail itself. */
const ANSWER_OK: FixtureHandler = () => jsonResponse({ match_info: {} });

/** What a successful call answers, whatever the match. */
const FETCHED = expect.objectContaining({ kind: 'fetched' }) as unknown;

/**
 * Let every promise that can settle without a timer settle, so that a test can check that
 * something did not happen (a request that stayed unsent).
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A handler that keeps every response until the test releases it. */
interface HeldResponses {
  readonly handler: FixtureHandler;
  /** Answer the oldest request still waiting. */
  readonly releaseNext: () => void;
  /** The most requests that were waiting at the same time. */
  readonly peak: () => number;
}

/**
 * Build a handler whose responses wait for the test, to observe requests that overlap.
 *
 * @param answer - The response of the n-th request received (0 for the first one).
 * @returns The handler, and the controls of the test.
 */
function holdResponses(
  answer: (request: HttpRequest, index: number) => HttpResponse = () => jsonResponse({}),
): HeldResponses {
  const waiting: (() => void)[] = [];
  let received = 0;
  let peak = 0;
  return {
    handler: async (request) => {
      const index = received;
      received += 1;
      const released = new Promise<void>((resolve) => waiting.push(resolve));
      peak = Math.max(peak, waiting.length);
      await released;
      return answer(request, index);
    },
    releaseNext: () => waiting.shift()?.(),
    peak: () => peak,
  };
}

/**
 * Narrow the result of a download to the one that carries the detail.
 *
 * @param result - The result.
 * @returns The same result, known to be `fetched`.
 */
function expectFetched(result: MetadataFetch): Extract<MetadataFetch, { kind: 'fetched' }> {
  if (result.kind !== 'fetched') {
    expect.unreachable(`expected a fetched detail, got ${result.kind}`);
  }
  return result;
}

describe('DeadlockApiService.fetchMatchMetadata', () => {
  /** A match of the fixture history that the fixture API serves. */
  const servedMatch =
    createMatchHistoryFixture({ now: START, count: 5 })
      .map((row) => testMatchId(row.match_id))
      .find((matchId) => !isMetadataMissing(matchId)) ??
    expect.unreachable('the fixture history holds a served match');

  it('fetches a match detail with disable_steam=true', async () => {
    const { api, http } = setUp();

    const fetched = expectFetched(await api.fetchMatchMetadata(servedMatch));

    expect(JSON.parse(fetched.body)).toEqual(fetched.json);
    expect(fetched.json).toMatchObject({ match_info: { match_id: servedMatch } });
    expect(http.requests).toEqual([
      {
        method: 'GET',
        url: `https://api.deadlock-api.com/v1/matches/${String(servedMatch)}/metadata?disable_steam=true`,
        headers: {
          'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
          Accept: 'application/json',
        },
        timeoutMs: 15_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
    ]);
    expect(http.requests[0]?.url).toBe(matchMetadataRequest(servedMatch).url);
  });

  it('reports a match the API does not have', async () => {
    const { api, syncState } = setUp();

    // 42 is not in the fixture history: the API answers 404, and no pause follows.
    await expect(api.fetchMatchMetadata(testMatchId(42))).resolves.toEqual({ kind: 'not_found' });
    await expect(syncState.getPausedUntil()).resolves.toBeNull();
  });

  it('reports a body that is not JSON with the body', async () => {
    const body = '<html>Bad gateway</html>';
    const { api, syncState } = setUp(() => ({ status: 200, headers: {}, body }));

    await expect(api.fetchMatchMetadata(testMatchId(1))).resolves.toEqual({
      kind: 'invalid',
      issue: 'not_json',
      body,
    });
    await expect(syncState.getPausedUntil()).resolves.toBeNull();
  });

  it('pauses on a 429 and answers paused', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
    );

    await expect(api.fetchMatchMetadata(testMatchId(1))).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 120_000);

    // The pause is respected: the next call sends nothing.
    await expect(api.fetchMatchMetadata(testMatchId(2))).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    expect(http.requests).toHaveLength(1);
  });

  it('pauses on a 503 without Retry-After for the default delay', async () => {
    const { api, syncState } = setUp(() => jsonResponse({ status: 503 }, 503));

    await expect(api.fetchMatchMetadata(testMatchId(1))).resolves.toEqual({
      kind: 'paused',
      until: START + DEFAULT_PAUSE_MS,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + DEFAULT_PAUSE_MS);
  });

  it('answers paused without sending while a pause is running', async () => {
    const { api, http, syncState, sleeper } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    await expect(api.fetchMatchMetadata(servedMatch)).resolves.toEqual({
      kind: 'paused',
      until: START + 5_000,
    });
    expect(http.requests).toHaveLength(0);
    expect(sleeper.calls).toEqual([]);
  });

  it('keeps the latest pause when two responses ask for one', async () => {
    // Two requests are in flight and both answer in the same moment, in either order: the pause
    // that ends last must win, whichever answer is saved first.
    for (const retryAfters of [
      [300, 60],
      [60, 300],
    ] as const) {
      const held = holdResponses((_request, index) =>
        jsonResponse({ status: 429 }, 429, { 'retry-after': String(retryAfters[index]) }),
      );
      const { api, http, syncState } = setUp(held.handler);
      const first = api.fetchMatchMetadata(testMatchId(1));
      const second = api.fetchMatchMetadata(testMatchId(2));
      await vi.waitFor(() => {
        expect(http.requests).toHaveLength(2);
      });

      held.releaseNext();
      held.releaseNext();
      const results = await Promise.all([first, second]);

      await expect(syncState.getPausedUntil()).resolves.toBe(START + 300_000);
      // A call reports the pause that is really running once its own is saved.
      expect(results[1]).toEqual({ kind: 'paused', until: START + 300_000 });
      expect(results[0]).toEqual({ kind: 'paused', until: START + retryAfters[0] * 1000 });
    }
  });

  it('keeps the latest pause across the families of requests', async () => {
    // The pause the history request asks for must not shorten the one the detail asked for.
    const held = holdResponses((request) =>
      jsonResponse({ status: 429 }, 429, {
        'retry-after': request.url.includes('/metadata') ? '300' : '60',
      }),
    );
    const { api, http, syncState } = setUp(held.handler);
    const detail = api.fetchMatchMetadata(testMatchId(1));
    const history = api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false });
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });

    held.releaseNext();
    held.releaseNext();
    const results = await Promise.all([detail, history]);

    await expect(syncState.getPausedUntil()).resolves.toBe(START + 300_000);
    expect(results).toEqual([
      { kind: 'paused', until: START + 300_000 },
      { kind: 'paused', until: START + 300_000 },
    ]);
  });

  it('keeps saving the pauses after a write failed', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '60' }),
    );
    vi.spyOn(syncState, 'setPausedUntil').mockRejectedValueOnce(
      new AppError('storage', 'Could not save the synchronisation state'),
    );

    // The first pause cannot be saved, so the call fails and no pause is running...
    await expect(api.fetchMatchMetadata(testMatchId(1))).rejects.toMatchObject({ kind: 'storage' });
    // ...but the failure does not jam the saving of the next pauses.
    await expect(api.fetchMatchMetadata(testMatchId(2))).resolves.toEqual({
      kind: 'paused',
      until: START + 60_000,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 60_000);
    expect(http.requests).toHaveLength(2);
  });

  it('answers paused to a call that starts while a pause is being saved', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '60' }),
    );
    const save = syncState.setPausedUntil.bind(syncState);
    let secondCall: Promise<MetadataFetch> | undefined;
    vi.spyOn(syncState, 'setPausedUntil').mockImplementation(async (until) => {
      // The write is under way, not done: another call starts now and runs as far as it can.
      secondCall = api.fetchMatchMetadata(testMatchId(2));
      await settle();
      await save(until);
    });

    await api.fetchMatchMetadata(testMatchId(1));

    // The second call waited for the write instead of reading the database as it was before.
    await expect(secondCall).resolves.toEqual({ kind: 'paused', until: START + 60_000 });
    expect(http.requests).toHaveLength(1);
  });

  it('waits for the next slot instead of exceeding 5 requests per second', async () => {
    const { api, http, sleeper } = setUp(ANSWER_OK);

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((id) => api.fetchMatchMetadata(testMatchId(id))),
    );

    // Exactly 5 requests went out right away; the 6th slept for the whole second, then went out.
    expect(sleeper.calls).toEqual([1_000]);
    expect(sleeper.sentWhileSleeping).toEqual([5]);
    expect(http.requests).toHaveLength(6);
    expect(results).toEqual(Array.from({ length: 6 }, () => FETCHED));
  });

  it('waits only until the oldest requests have left the window', async () => {
    const { api, clock, sleeper } = setUp(ANSWER_OK);
    for (const id of [1, 2, 3]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }
    clock.now = START + 400;
    for (const id of [4, 5]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }

    await api.fetchMatchMetadata(testMatchId(6));

    // The 3 oldest requests (at START) leave the window at START + 1,000: 600 ms from now.
    expect(sleeper.calls).toEqual([600]);
    expect(clock.now).toBe(START + 1_000);
  });

  it('never lets overlapping calls take the last slot twice', async () => {
    const { api, http, sleeper } = setUp(ANSWER_OK);
    for (const id of [1, 2, 3, 4]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }

    await Promise.all([
      api.fetchMatchMetadata(testMatchId(5)),
      api.fetchMatchMetadata(testMatchId(6)),
    ]);

    // One of the two took the 5th slot; the other one slept until a slot was free.
    expect(sleeper.calls).toEqual([1_000]);
    expect(sleeper.sentWhileSleeping).toEqual([5]);
    expect(http.requests).toHaveLength(6);
  });

  it('sleeps with a timer when no sleep function is given', async () => {
    const database = createTestDatabase();
    // Open the database before the timers are faked: opening it may need real timers.
    await database.select('SELECT 1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(START);
      const logger = new MemoryLogger();
      const http = new FixtureHttpClient(ANSWER_OK);
      const api = new DeadlockApiService(http, new SyncStateRepository(database, logger), logger, {
        appVersion: '0.1.0',
      });

      const calls = [1, 2, 3, 4, 5, 6].map((id) => api.fetchMatchMetadata(testMatchId(id)));
      await vi.advanceTimersByTimeAsync(0);
      expect(http.requests).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(999);
      expect(http.requests).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(http.requests).toHaveLength(6);
      await expect(Promise.all(calls)).resolves.toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a call that slept when a pause was saved in the meantime', async () => {
    const { api, http, syncState, sleeper } = setUp(ANSWER_OK);
    for (const id of [1, 2, 3, 4, 5]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }
    // While the 6th call waits for its slot, another request is told to pause.
    sleeper.during = () => syncState.setPausedUntil(START + 31_000);

    await expect(api.fetchMatchMetadata(testMatchId(6))).resolves.toEqual({
      kind: 'paused',
      until: START + 31_000,
    });
    expect(http.requests).toHaveLength(5);
  });

  it('sends at most 2 requests at a time', async () => {
    const held = holdResponses();
    const { api, http, sleeper } = setUp(held.handler);

    const calls = [1, 2, 3, 4].map((id) => api.fetchMatchMetadata(testMatchId(id)));
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });
    await settle();
    expect(http.requests).toHaveLength(2);

    // Each answer frees a slot for exactly one more request.
    for (const sent of [3, 4]) {
      held.releaseNext();
      await vi.waitFor(() => {
        expect(http.requests).toHaveLength(sent);
      });
      await settle();
      expect(http.requests).toHaveLength(sent);
    }
    held.releaseNext();
    held.releaseNext();
    await Promise.all(calls);

    expect(held.peak()).toBe(2);
    expect(sleeper.calls).toEqual([]);
  });

  it('answers paused at once to a call that would wait for a slot', async () => {
    const held = holdResponses();
    const { api, http, syncState } = setUp(held.handler);
    const inFlight = [1, 2].map((id) => api.fetchMatchMetadata(testMatchId(id)));
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });
    await syncState.setPausedUntil(START + 30_000);

    // Both slots are taken, but the call does not queue for one just to learn about the pause.
    await expect(api.fetchMatchMetadata(testMatchId(3))).resolves.toEqual({
      kind: 'paused',
      until: START + 30_000,
    });

    held.releaseNext();
    held.releaseNext();
    await Promise.all(inFlight);
    expect(http.requests).toHaveLength(2);
  });

  it('answers paused to the calls waiting for a slot when a response asks for a pause', async () => {
    const held = holdResponses((_request, index) =>
      index === 0 ? jsonResponse({ status: 429 }, 429, { 'retry-after': '60' }) : jsonResponse({}),
    );
    const { api, http, clock } = setUp(held.handler);
    const [first, second, third, fourth] = [1, 2, 3, 4].map((id) =>
      api.fetchMatchMetadata(testMatchId(id)),
    );
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });

    held.releaseNext();

    // The third and fourth calls get a slot one after the other, see the pause and send nothing.
    const paused = { kind: 'paused', until: START + 60_000 };
    await expect(Promise.all([first, third, fourth])).resolves.toEqual([paused, paused, paused]);
    expect(http.requests).toHaveLength(2);
    held.releaseNext();
    await expect(second).resolves.toEqual(FETCHED);

    // No slot was lost on the way: once the pause is over, two more requests go out together.
    clock.now = START + 61_000;
    const later = [5, 6].map((id) => api.fetchMatchMetadata(testMatchId(id)));
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(4);
    });
    held.releaseNext();
    held.releaseNext();
    await expect(Promise.all(later)).resolves.toEqual([FETCHED, FETCHED]);
  });

  const failures: readonly (readonly [string, FixtureHandler])[] = [
    [
      'a network error',
      () => {
        throw new AppError('network', 'The request failed');
      },
    ],
    [
      'a timeout',
      () => {
        throw new AppError('timeout', 'The request timed out');
      },
    ],
    ['a server error', () => jsonResponse({}, 500)],
    ['a refusal', () => jsonResponse({}, 403)],
    ['a missing match', () => jsonResponse({}, 404)],
    ['a body that is not JSON', () => ({ status: 200, headers: {}, body: 'nope' })],
    ['a 429', () => jsonResponse({}, 429, { 'retry-after': '1' })],
  ];

  it.each(failures)('frees its slot after %s', async (_name, fail) => {
    let received = 0;
    const { api, http, clock } = setUp((request) => {
      received += 1;
      return received <= 2 ? fail(request) : jsonResponse({});
    });

    // Two calls that end badly would keep both slots for good if either of them were not freed.
    for (const id of [1, 2]) {
      await api.fetchMatchMetadata(testMatchId(id)).catch(() => undefined);
      clock.now += 2 * MINUTE;
    }

    await expect(api.fetchMatchMetadata(testMatchId(3))).resolves.toEqual(FETCHED);
    expect(http.requests).toHaveLength(3);
  });

  it.each([
    [403, 'forbidden'],
    [500, 'service_unavailable'],
    [418, 'unexpected'],
  ] as const)('throws a %s as %s', async (status, kind) => {
    const { api } = setUp(() => jsonResponse({}, status));

    await expect(api.fetchMatchMetadata(testMatchId(1))).rejects.toMatchObject({
      kind,
      context: { endpoint: '/v1/matches/{match_id}/metadata', status },
    });
  });

  it('throws a body over 10 MB as an invalid payload', async () => {
    const { api } = setUp(() => ({
      status: 200,
      headers: {},
      body: 'x'.repeat(MAX_RESPONSE_BYTES + 1),
    }));

    await expect(api.fetchMatchMetadata(testMatchId(1))).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('throws a network error as an AppError without the account id', async () => {
    const { api, logger } = setUp(() => {
      throw new AppError('network', 'The request failed', {
        // The network layer quotes the URL it failed on: an account id in it must not survive.
        cause: `error sending request for url (https://api.deadlock-api.com/v1/players/${String(FIXTURE_ACCOUNT_ID)}/match-history)`,
      });
    });

    const error = await api.fetchMatchMetadata(testMatchId(1)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: 'network',
      context: { endpoint: '/v1/matches/{match_id}/metadata' },
      cause:
        'error sending request for url (https://api.deadlock-api.com/v1/players/{account_id}/match-history)',
    });
    expect(
      JSON.stringify([isAppError(error) ? errorLogContext(error) : null, logger.entries]),
    ).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('never logs a response body', async () => {
    const marker = 'BODY-MARKER-4f2a';
    const answers: readonly HttpResponse[] = [
      jsonResponse({ note: marker }),
      { status: 200, headers: {}, body: `<html>${marker}</html>` },
      jsonResponse({ error: marker }, 404),
      jsonResponse({ error: marker }, 429, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 503, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 403),
      jsonResponse({ error: marker }, 500),
    ];

    for (const answer of answers) {
      const { api, logger } = setUp(() => answer);

      const result = await api.fetchMatchMetadata(testMatchId(1)).catch((error: unknown) => error);

      // What a caller logs for a failure is the log context of its error: no body there either.
      const loggedByCaller = isAppError(result) ? errorLogContext(result) : null;
      expect(JSON.stringify([logger.entries, loggedByCaller])).not.toContain(marker);
      // The check means something only if the request itself was logged.
      expect(logger.entries.length).toBeGreaterThan(0);
    }
  });
});

describe('DeadlockApiService.fetchSteamProfile', () => {
  /** An account the fixture API knows nothing about: deadlock-api answers it an empty list. */
  const unknownAccountId = testAccountId(2_000_001);

  const PROFILE_URL = 'https://api.deadlock-api.com/v1/players/steam?account_ids=1000001';

  /** The two ways to ask: from the cache of deadlock-api, or with a refresh from Steam. */
  const plain = { refresh: false };
  const refreshed = { refresh: true };

  it('asks deadlock-api for the Steam profile of an account', async () => {
    const { api, http, logger } = setUp();

    const result = await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);

    expect(result).toEqual({
      kind: 'fetched',
      profile: { personaName: FIXTURE_PERSONA_NAME, avatarHash: FIXTURE_AVATAR_HASH },
    });
    expect(http.requests).toEqual([
      {
        method: 'GET',
        url: PROFILE_URL,
        headers: {
          'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
          Accept: 'application/json',
        },
        timeoutMs: 15_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
    ]);
    // The request is logged by the template of its endpoint, never by its URL.
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        message: 'Request answered',
        context: expect.objectContaining({
          endpoint: '/v1/players/steam',
          status: 200,
        }) as unknown,
      }),
    );
    expect(JSON.stringify(logger.entries)).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('asks Steam to refresh only when told', async () => {
    const { api, http } = setUp();

    await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);

    expect(http.requests.map((request) => request.url)).toEqual([
      PROFILE_URL,
      `${PROFILE_URL}&refresh=true`,
    ]);
  });

  it('reports an unknown player as no profile', async () => {
    const { api, syncState } = setUp();

    await expect(api.fetchSteamProfile(unknownAccountId, plain)).resolves.toEqual({
      kind: 'fetched',
      profile: null,
    });
    // An empty list is an answer, not a failure: no pause follows.
    await expect(syncState.getPausedUntil()).resolves.toBeNull();
  });

  it('keeps to 10 profile requests a minute and 3 refreshes an hour', async () => {
    const { api, http, clock } = setUp();

    // The minute: 10 requests go out, the 11th waits until the first one leaves the window.
    for (let index = 0; index < 10; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + MINUTE,
    });
    expect(http.requests).toHaveLength(10);
    clock.now = START + MINUTE;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);

    // The hour: 3 refreshes, a minute apart so that the minute is never what stops them.
    for (const minutes of [2, 3, 4]) {
      clock.now = START + minutes * MINUTE;
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
    }
    clock.now = START + 5 * MINUTE;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + 62 * MINUTE,
    });
    // The budget of the refreshes does not stop the requests that do not refresh.
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    expect(http.requests).toHaveLength(15);

    clock.now = START + 62 * MINUTE;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
  });

  it('counts a refresh in the minute as well as in the hour', async () => {
    const { api } = setUp();
    for (let index = 0; index < 3; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }

    // The 3 refreshes used 3 of the 10 requests of the minute: 7 more fit, not 8.
    for (let index = 0; index < 7; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toMatchObject({
      kind: 'budget_exhausted',
    });
  });

  it('counts a refresh that the hour refuses in no window', async () => {
    const { api, http } = setUp();
    for (let index = 0; index < 3; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toMatchObject({
      kind: 'budget_exhausted',
    });

    // Had the refused refresh been counted in the minute, only 6 more requests would fit.
    for (let index = 0; index < 7; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    }
    expect(http.requests).toHaveLength(10);
  });

  it('counts a refresh that the minute refuses in no window', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 10; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + MINUTE,
    });

    // Had the refused refresh been counted in the hour, only 2 refreshes would be left.
    clock.now = START + MINUTE;
    for (let index = 0; index < 3; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
    }
    expect(http.requests).toHaveLength(13);
  });

  it('answers the later date when both budgets refuse', async () => {
    // The hour is the later one: 3 refreshes and 7 other requests at the same moment.
    const sameMoment = setUp();
    for (let index = 0; index < 3; index += 1) {
      await sameMoment.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }
    for (let index = 0; index < 7; index += 1) {
      await sameMoment.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }
    await expect(sameMoment.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + 60 * MINUTE,
    });

    // The minute is the later one: the oldest refresh leaves the hour half a minute before the
    // oldest request leaves the minute.
    const lateInTheHour = setUp();
    for (const minutes of [0, 1, 2]) {
      lateInTheHour.clock.now = START + minutes * MINUTE;
      await lateInTheHour.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }
    lateInTheHour.clock.now = START + 59.5 * MINUTE;
    for (let index = 0; index < 10; index += 1) {
      await lateInTheHour.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }
    await expect(
      lateInTheHour.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed),
    ).resolves.toEqual({ kind: 'budget_exhausted', nextAllowedAt: START + 60.5 * MINUTE });
  });

  it('never lets overlapping calls exceed the budget', async () => {
    const { api, http } = setUp();
    for (let index = 0; index < 9; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }

    const results = await Promise.all([
      api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain),
      api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain),
    ]);

    expect(results.map((result) => result.kind).toSorted()).toEqual([
      'budget_exhausted',
      'fetched',
    ]);
    expect(http.requests).toHaveLength(10);
  });

  it('pauses on a 429 and answers paused', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
    );

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 120_000);

    // The pause is shared by every family of requests: the next calls send nothing.
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false })).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    expect(http.requests).toHaveLength(1);
  });

  it('pauses on a 503 without Retry-After for the default delay', async () => {
    const { api, syncState } = setUp(() => jsonResponse({ status: 503 }, 503));

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual({
      kind: 'paused',
      until: START + DEFAULT_PAUSE_MS,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + DEFAULT_PAUSE_MS);
  });

  it('answers a pause that another request asked for, without sending or counting anything', async () => {
    const { api, http, syncState, clock } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    for (let index = 0; index < 12; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
        kind: 'paused',
        until: START + 5_000,
      });
    }
    expect(http.requests).toHaveLength(0);

    // The pause is over, and the calls it stopped used none of the budgets.
    clock.now = START + 5_000;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'service_unavailable'],
    [418, 'unexpected'],
  ] as const)('throws a %s as %s', async (status, kind) => {
    const { api } = setUp(() => jsonResponse({}, status));

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).rejects.toMatchObject({
      kind,
      context: { endpoint: '/v1/players/steam', status },
    });
  });

  it('throws an answer that is not a list as an invalid payload', async () => {
    const { api } = setUp(() => jsonResponse({ account_id: FIXTURE_ACCOUNT_ID }));

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('removes the account id that a transport error quotes', async () => {
    const { api, logger } = setUp(() => {
      throw new AppError('network', 'The request failed', {
        cause: `error sending request for url (${PROFILE_URL}&refresh=true)`,
      });
    });

    const error = await api
      .fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: 'network',
      context: { endpoint: '/v1/players/steam' },
      cause:
        'error sending request for url (https://api.deadlock-api.com/v1/players/steam?account_ids={account_id}&refresh=true)',
    });
    expect(
      JSON.stringify([isAppError(error) ? errorLogContext(error) : null, logger.entries]),
    ).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('never logs the persona name', async () => {
    const marker = 'NAME-MARKER-7d3b';
    const answers: readonly HttpResponse[] = [
      jsonResponse([{ account_id: FIXTURE_ACCOUNT_ID, personaname: marker }]),
      jsonResponse({ personaname: marker }),
      jsonResponse([{ personaname: marker }]),
      { status: 200, headers: {}, body: `<html>${marker}</html>` },
      jsonResponse({ error: marker }, 404),
      jsonResponse({ error: marker }, 429, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 503, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 403),
      jsonResponse({ error: marker }, 500),
    ];

    for (const answer of answers) {
      const { api, logger } = setUp(() => answer);

      const result = await api
        .fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)
        .catch((error: unknown) => error);

      // What a caller logs for a failure is the log context of its error: no name there either.
      const loggedByCaller = isAppError(result) ? errorLogContext(result) : null;
      expect(JSON.stringify([logger.entries, loggedByCaller])).not.toContain(marker);
      // The check means something only if the request itself was logged.
      expect(logger.entries.length).toBeGreaterThan(0);
    }
  });
});

describe('DeadlockApiService community requests', () => {
  const BASE_URL = 'https://api.deadlock-api.com';
  const USER_AGENT = 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)';

  /** Paige in Sentinel (tier 4), over the 25-30 minute window, since a UTC midnight. */
  const query: CohortQuery = {
    heroId: PAIGE_HERO_ID,
    sinceUnixS: 1_789_344_000,
    minDurationS: 1500,
    maxDurationS: 1799,
    badge: { min: 41, max: 46 },
  };

  /** The filters every community request of `query` carries. */
  const FILTERS =
    'min_unix_timestamp=1789344000&min_duration_s=1500&max_duration_s=1799&min_average_badge=41&max_average_badge=46';

  /** One request of the service, with what the tests need to know of it. */
  interface CommunityCall {
    /** The method of the service, for the titles. */
    readonly method: string;
    /** Call the method. */
    readonly run: (api: DeadlockApiService) => Promise<AnalyticsFetch<unknown>>;
    /** The template of the endpoint: what the logs and the errors name. */
    readonly endpoint: string;
    /** A JSON body that is not the kind of answer the method expects. */
    readonly invalidBody: unknown;
  }

  /** The three requests that share the analytics budget. */
  const ANALYTICS_CALLS: readonly CommunityCall[] = [
    {
      method: 'fetchMetricBenchmark',
      run: (api) => api.fetchMetricBenchmark(query),
      endpoint: '/v1/analytics/player-stats/metrics',
      invalidBody: [],
    },
    {
      method: 'fetchPerformanceCurve',
      run: (api) => api.fetchPerformanceCurve(query),
      endpoint: '/v1/analytics/player-performance-curve',
      invalidBody: {},
    },
    {
      method: 'fetchHeroSample',
      run: (api) => api.fetchHeroSample(query),
      endpoint: '/v1/analytics/hero-stats',
      invalidBody: {},
    },
  ];

  /** The request of the rank, which has a budget of its own. */
  const RANK_CALL: CommunityCall = {
    method: 'fetchPlayerRank',
    run: (api) => api.fetchPlayerRank(FIXTURE_ACCOUNT_ID),
    endpoint: '/v1/players/{account_id}/rank',
    invalidBody: { badge: 'gold' },
  };

  const CALLS: readonly CommunityCall[] = [...ANALYTICS_CALLS, RANK_CALL];

  /**
   * Narrow the result of a community request to the value it fetched.
   *
   * @param result - The result.
   * @returns The value, known to be fetched.
   */
  function fetchedValue<T>(result: AnalyticsFetch<T>): T {
    if (result.kind !== 'fetched') {
      expect.unreachable(`expected a fetched value, got ${result.kind}`);
    }
    return result.value;
  }

  it("sends each request with the exact URL and the app's User-Agent", async () => {
    const { api, http } = setUp();

    await api.fetchMetricBenchmark(query);
    await api.fetchPerformanceCurve(query);
    await api.fetchHeroSample(query);
    await api.fetchPlayerRank(FIXTURE_ACCOUNT_ID);

    expect(http.requests).toEqual(
      [
        `${BASE_URL}/v1/analytics/player-stats/metrics?hero_ids=67&game_mode=normal&${FILTERS}`,
        `${BASE_URL}/v1/analytics/player-performance-curve?hero_ids=67&game_mode=normal&resolution=0&${FILTERS}`,
        // The hero statistics have no hero filter: the hero is not sent.
        `${BASE_URL}/v1/analytics/hero-stats?game_mode=normal&${FILTERS}`,
        `${BASE_URL}/v1/players/1000001/rank`,
      ].map((url) => ({
        method: 'GET',
        url,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 15_000,
        maxBodyBytes: 10 * 1024 * 1024,
      })),
    );
  });

  it('returns the benchmark, the curve, the sample and the badge of the fixture API', async () => {
    const { api } = setUp();

    const benchmark = fetchedValue(await api.fetchMetricBenchmark(query));
    const curve = fetchedValue(await api.fetchPerformanceCurve(query));

    expect([...benchmark.keys()]).toHaveLength(11);
    // The curve stops at the longest match of the window: 1799 s, so its last point is 1500 s.
    expect(curve.map((point) => point.timeS)).toEqual([180, 360, 540, 720, 900, 1200, 1500]);
    expect(fetchedValue(await api.fetchHeroSample(query))).toBe(2422);
    expect(fetchedValue(await api.fetchPlayerRank(FIXTURE_ACCOUNT_ID))).toBe(44);
  });

  it('reads the sample of the hero of the query', async () => {
    const { api } = setUp();

    // Another hero of the statistics, then a hero the answer has no row for.
    expect(fetchedValue(await api.fetchHeroSample({ ...query, heroId: 1 }))).toBeGreaterThan(0);
    expect(fetchedValue(await api.fetchHeroSample({ ...query, heroId: 999 }))).toBe(0);
  });

  it('refuses the 21st analytics request of a minute without sending it', async () => {
    const { api, http, clock } = setUp();

    // The three kinds of analytics request share one window: 20 of them in any mix fill it.
    for (let index = 0; index < 20; index += 1) {
      const call = ANALYTICS_CALLS[index % ANALYTICS_CALLS.length] ?? expect.unreachable();
      await expect(call.run(api)).resolves.toEqual(FETCHED);
    }
    expect(http.requests).toHaveLength(20);
    for (const call of ANALYTICS_CALLS) {
      await expect(call.run(api)).resolves.toEqual({
        kind: 'budget_exhausted',
        nextAllowedAt: START + MINUTE,
      });
    }
    expect(http.requests).toHaveLength(20);

    // The refused requests were not counted: the window frees up as soon as the first one leaves.
    clock.now = START + MINUTE;
    await expect(api.fetchHeroSample(query)).resolves.toEqual(FETCHED);
    expect(http.requests).toHaveLength(21);
  });

  it('allows 3 rank requests an hour', async () => {
    const { api, http, clock } = setUp();

    for (let index = 0; index < 3; index += 1) {
      clock.now = START + index * MINUTE;
      await expect(api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).resolves.toEqual(FETCHED);
    }
    clock.now = START + 3 * MINUTE;

    await expect(api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + 60 * MINUTE,
    });
    expect(http.requests).toHaveLength(3);
    clock.now = START + 60 * MINUTE;
    await expect(api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).resolves.toEqual(FETCHED);
  });

  it('keeps the rank budget and the analytics budget apart', async () => {
    // The rank budget spent leaves the analytics requests alone.
    const rankSpent = setUp();
    for (let index = 0; index < 3; index += 1) {
      await rankSpent.api.fetchPlayerRank(FIXTURE_ACCOUNT_ID);
    }
    await expect(rankSpent.api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).resolves.toMatchObject({
      kind: 'budget_exhausted',
    });
    for (let index = 0; index < 20; index += 1) {
      await expect(rankSpent.api.fetchHeroSample(query)).resolves.toEqual(FETCHED);
    }

    // And the analytics budget spent leaves the rank request alone.
    const analyticsSpent = setUp();
    for (let index = 0; index < 20; index += 1) {
      await analyticsSpent.api.fetchHeroSample(query);
    }
    await expect(analyticsSpent.api.fetchHeroSample(query)).resolves.toMatchObject({
      kind: 'budget_exhausted',
    });
    await expect(analyticsSpent.api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).resolves.toEqual(FETCHED);
  });

  it('counts a request that failed', async () => {
    const { api, http } = setUp(() => {
      throw new AppError('network', 'The request failed');
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).rejects.toMatchObject({
        kind: 'network',
      });
    }

    // A request that fails still reached deadlock-api: it used its place in the budget.
    await expect(api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).resolves.toMatchObject({
      kind: 'budget_exhausted',
    });
    expect(http.requests).toHaveLength(3);
  });

  it('never lets overlapping calls exceed the budget', async () => {
    const { api, http } = setUp();
    for (let index = 0; index < 19; index += 1) {
      await api.fetchMetricBenchmark(query);
    }

    const results = await Promise.all([
      api.fetchPerformanceCurve(query),
      api.fetchHeroSample(query),
    ]);

    expect(results.map((result) => result.kind).toSorted()).toEqual([
      'budget_exhausted',
      'fetched',
    ]);
    expect(http.requests).toHaveLength(20);

    // The rank has its own window, and the same guarantee.
    const rank = setUp();
    await rank.api.fetchPlayerRank(FIXTURE_ACCOUNT_ID);
    await rank.api.fetchPlayerRank(FIXTURE_ACCOUNT_ID);
    const rankResults = await Promise.all([
      rank.api.fetchPlayerRank(FIXTURE_ACCOUNT_ID),
      rank.api.fetchPlayerRank(FIXTURE_ACCOUNT_ID),
    ]);

    expect(rankResults.map((result) => result.kind).toSorted()).toEqual([
      'budget_exhausted',
      'fetched',
    ]);
    expect(rank.http.requests).toHaveLength(3);
  });

  it('answers paused during a pause', async () => {
    const { api, http, syncState, clock } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    // Far more calls than the budgets allow: none is sent and none is counted.
    for (let index = 0; index < 25; index += 1) {
      for (const call of CALLS) {
        await expect(call.run(api)).resolves.toEqual({ kind: 'paused', until: START + 5_000 });
      }
    }
    expect(http.requests).toHaveLength(0);

    // The pause is over, and the calls it stopped used none of the budgets.
    clock.now = START + 5_000;
    for (let index = 0; index < 20; index += 1) {
      await expect(api.fetchPerformanceCurve(query)).resolves.toEqual(FETCHED);
    }
    for (let index = 0; index < 3; index += 1) {
      await expect(api.fetchPlayerRank(FIXTURE_ACCOUNT_ID)).resolves.toEqual(FETCHED);
    }
    expect(http.requests).toHaveLength(23);
  });

  it.each(CALLS)('$method pauses on a 429 and answers paused', async (call) => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
    );

    await expect(call.run(api)).resolves.toEqual({ kind: 'paused', until: START + 120_000 });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 120_000);

    // The pause is shared by every family of requests: the next calls send nothing.
    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false })).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, { refresh: false })).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    expect(http.requests).toHaveLength(1);
  });

  it.each(CALLS)(
    '$method pauses on a 503 without Retry-After for the default delay',
    async (call) => {
      const { api, syncState } = setUp(() => jsonResponse({ status: 503 }, 503));

      await expect(call.run(api)).resolves.toEqual({
        kind: 'paused',
        until: START + DEFAULT_PAUSE_MS,
      });
      await expect(syncState.getPausedUntil()).resolves.toBe(START + DEFAULT_PAUSE_MS);
    },
  );

  it.each(CALLS)('$method throws the failures of the API as errors', async (call) => {
    const failures = [
      [403, 'forbidden'],
      [404, 'not_found'],
      [500, 'service_unavailable'],
      [418, 'unexpected'],
    ] as const;

    for (const [status, kind] of failures) {
      const { api } = setUp(() => jsonResponse({}, status));

      await expect(call.run(api)).rejects.toMatchObject({
        kind,
        context: { endpoint: call.endpoint, status },
      });
    }
  });

  it.each(CALLS)('$method throws a failure of the transport as an error', async (call) => {
    const { api } = setUp(() => {
      throw new AppError('timeout', 'The request timed out');
    });

    await expect(call.run(api)).rejects.toMatchObject({
      kind: 'timeout',
      context: { endpoint: call.endpoint },
    });
  });

  it.each(CALLS)(
    '$method throws an answer of the wrong shape as an invalid payload',
    async (call) => {
      const { api } = setUp(() => jsonResponse(call.invalidBody));

      await expect(call.run(api)).rejects.toMatchObject({ kind: 'invalid_payload' });
    },
  );

  it('removes the account id that a transport error quotes', async () => {
    const { api, logger } = setUp(() => {
      throw new AppError('network', 'The request failed', {
        cause: `error sending request for url (${BASE_URL}/v1/players/1000001/rank)`,
      });
    });

    const error = await api.fetchPlayerRank(FIXTURE_ACCOUNT_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: 'network',
      context: { endpoint: '/v1/players/{account_id}/rank' },
      cause: `error sending request for url (${BASE_URL}/v1/players/{account_id}/rank)`,
    });
    expect(
      JSON.stringify([isAppError(error) ? errorLogContext(error) : null, logger.entries]),
    ).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('logs the rank endpoint as a template', async () => {
    const { api, logger } = setUp();

    await api.fetchPlayerRank(FIXTURE_ACCOUNT_ID);

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        message: 'Request answered',
        context: expect.objectContaining({
          endpoint: '/v1/players/{account_id}/rank',
          status: 200,
        }) as unknown,
      }),
    );
    expect(JSON.stringify(logger.entries)).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it.each(ANALYTICS_CALLS)('$method logs its endpoint without any filter', async (call) => {
    const { api, logger } = setUp();

    await call.run(api);

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        message: 'Request answered',
        context: expect.objectContaining({ endpoint: call.endpoint, status: 200 }) as unknown,
      }),
    );
    // The query of the community is not logged: only the template of the endpoint is.
    expect(JSON.stringify(logger.entries)).not.toContain('min_unix_timestamp');
  });

  it('never logs a value of the answer', async () => {
    const marker = 'VALUE-MARKER-3f9a';
    const answers: readonly HttpResponse[] = [
      jsonResponse([marker]),
      jsonResponse({ marker }),
      jsonResponse({ badge: marker }),
      jsonResponse(marker),
      { status: 200, headers: {}, body: `<html>${marker}</html>` },
      jsonResponse({ error: marker }, 404),
      jsonResponse({ error: marker }, 429, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 503, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 403),
      jsonResponse({ error: marker }, 500),
    ];

    for (const call of CALLS) {
      for (const answer of answers) {
        const { api, logger } = setUp(() => answer);

        const result = await call.run(api).catch((error: unknown) => error);

        // What a caller logs for a failure is the log context of its error: no value there either.
        const loggedByCaller = isAppError(result) ? errorLogContext(result) : null;
        expect(JSON.stringify([logger.entries, loggedByCaller])).not.toContain(marker);
        // The check means something only if the request itself was logged.
        expect(logger.entries.length).toBeGreaterThan(0);
      }
    }
  });
});

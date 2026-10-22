/**
 * Tests of the item statistics service, with the fixture API, a fake clock and an in-memory
 * database that holds the cache.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { createFixtureApi, jsonResponse } from '../adapters/dev/fixture-http-client.adapter';
import { createItemStatsFixture } from '../adapters/dev/fixtures/analytics.fixture';
import { FIXTURE_RESISTANCE_ITEM_IDS } from '../adapters/dev/fixtures/assets.fixture';
import type { Cohort, CohortRank } from '../core/analysis/cohort';
import { MIN_COHORT_MATCHES } from '../core/analysis/insights/thresholds';
import { ANALYTICS_RATE_LIMIT } from '../core/deadlock-api/budgets';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { AppError } from '../core/errors/app-error';
import {
  communityLines,
  failingAt,
  HERO_STATS_PATH,
  overriding,
  queryOf,
  requestedPaths,
  setUpCommunity,
  withSampleSizes,
  type CommunityOptions,
} from '../test/community-test-kit';
import { testAccountId } from '../test/test-data';
import type { ApiCacheRepository } from './api-cache.repository';
import { BenchmarkService, COHORT_MAX_AGE_MS } from './benchmark.service';
import {
  ItemBenchmarkService,
  type ItemBenchmarkData,
  type ItemBenchmarkRead,
  type ItemTiming,
} from './item-benchmark.service';

const START = Date.UTC(2026, 9, 20, 15, 30, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ACCOUNT_ID = testAccountId(1000001);
const OTHER_ACCOUNT_ID = testAccountId(2000001);

/** The start of the period the service asks for at `START`: 30 days before the UTC midnight, in s. */
const SINCE_UNIX_S = Date.UTC(2026, 9, 20) / 1000 - 30 * 86_400;

/** The rank the review compares a Ritualist with: the tier above, Emissary. */
const TIER_7: CohortRank = { kind: 'tier', tier: 7 };

/** The rank of every player: the rank of an account that has none, and the fallback of a tier. */
const ALL_RANKS: CohortRank = { kind: 'all' };

/** The cache keys of the item statistics of {@link TIER_7} and {@link ALL_RANKS}. */
const TIER_7_KEY = 'analytics.items.tier7';
const ALL_RANKS_KEY = 'analytics.items.all';

/** The twelve items the review looks at, as the fixture API describes them. */
const ITEM_IDS = FIXTURE_RESISTANCE_ITEM_IDS;

/** An item the fixture API knows nothing of: nobody bought it. */
const UNBOUGHT_ITEM_ID = 999_999;

/** The path of the request for the purchases of the items, after the one for the size of the tier. */
const ITEM_STATS_PATH = '/v1/analytics/item-stats';

/** The parts of the log lines of the service that do not depend on the test. */
const SCOPE = 'community';
const UNAVAILABLE = 'Item statistics unavailable';
const DOWNLOADED = 'Item statistics downloaded';
const INCOMPLETE = 'Item statistics incomplete';
const UNREADABLE = 'Cached item statistics are unreadable';
const ACCOUNT_CHANGED = 'Item statistics not stored, the account changed';

/**
 * The query parameters every request carries, whatever the tier: the mode, the period and the
 * duration window that holds a match of any length.
 */
const ANY_LENGTH_FILTERS = {
  game_mode: 'normal',
  min_unix_timestamp: String(SINCE_UNIX_S),
  min_duration_s: '0',
  max_duration_s: '7000',
};

/** The query parameters of the requests for {@link TIER_7}: Emissary is badges 71 to 76. */
const TIER_7_FILTERS = { ...ANY_LENGTH_FILTERS, min_average_badge: '71', max_average_badge: '76' };

/** The query parameters only the request for the item statistics carries. */
const ITEM_STATS_PARAMETERS = {
  hero_ids: String(PAIGE_HERO_ID),
  bucket: 'game_time_min',
  min_matches: '1',
};

/**
 * Build the service on the environment of the community tests.
 *
 * @param options - See {@link CommunityOptions}.
 * @returns The service, and everything {@link setUpCommunity} builds under it: the deadlock-api
 *   service, the cache, the HTTP client, the logger, the clock, a way to change the handler, the
 *   synchronisation state (where the pause is kept), the account source and the linked account.
 */
function setUp(options: CommunityOptions = {}) {
  const community = setUpCommunity(START, ACCOUNT_ID, options);
  const { api, cache, accountSource, logger, now } = community;
  const service = new ItemBenchmarkService({ api, cache, accountSource, logger, now });
  return { ...community, service };
}

/**
 * What the fixture API gives for some items, worked out from its raw rows: the purchases of each
 * item by minute, and their total.
 *
 * @param itemIds - The items.
 * @returns The timing of each item.
 */
function expectedItems(itemIds: readonly number[]): Map<number, ItemTiming> {
  const rows = createItemStatsFixture();
  return new Map(
    itemIds.map((itemId) => {
      const own = rows.filter((row) => row.item_id === itemId);
      return [
        itemId,
        {
          purchases: own.reduce((total, row) => total + row.matches, 0),
          minutes: new Map(own.map((row) => [row.bucket, row.matches])),
        },
      ];
    }),
  );
}

/** The data of an entry that is cached, or a failure of the test. */
function cachedData(read: ItemBenchmarkRead): ItemBenchmarkData {
  if (read.kind !== 'cached') {
    throw new Error('The item statistics should be cached');
  }
  return read.data;
}

describe('ItemBenchmarkService.refresh', () => {
  it('downloads the item stats of the tier above and keeps the asked items', async () => {
    const { service, http, cache } = setUp();

    await expect(service.read(TIER_7, ITEM_IDS)).resolves.toEqual({ kind: 'missing' });
    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');

    // The size of the tier, then its item statistics: two requests, however many items are asked.
    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, ITEM_STATS_PATH]);
    expect(http.requests.map((request) => queryOf(request.url))).toEqual([
      TIER_7_FILTERS,
      { ...ITEM_STATS_PARAMETERS, ...TIER_7_FILTERS },
    ]);
    // The API describes sixteen items, and the entry holds the twelve that were asked.
    expect(createItemStatsFixture().some((row) => !ITEM_IDS.includes(row.item_id))).toBe(true);
    await expect(service.read(TIER_7, ITEM_IDS)).resolves.toEqual({
      kind: 'cached',
      stale: false,
      data: {
        wanted: TIER_7,
        used: TIER_7,
        sampleMatches: 2_422,
        items: expectedItems(ITEM_IDS),
        fetchedAt: START,
      },
    });
    // The entry is kept for a day, under the key of the tier.
    await expect(cache.get(TIER_7_KEY)).resolves.toMatchObject({
      fetchedAt: START,
      expiresAt: START + COHORT_MAX_AGE_MS,
    });
  });

  it('stores the asked items only', async () => {
    const { service, cache } = setUp();
    const asked = ITEM_IDS.slice(0, 3);

    await service.refresh(ACCOUNT_ID, TIER_7, asked);

    const stored = await cache.get(TIER_7_KEY);
    const payload = JSON.parse(stored?.payloadJson ?? 'null') as { items: [number, unknown][] };
    expect(payload.items.map(([itemId]) => itemId)).toEqual(asked);
    expect(cachedData(await service.read(TIER_7, asked)).items).toEqual(expectedItems(asked));
  });

  it('asks for no badge range for every rank', async () => {
    const { service, http, cache } = setUp();

    await expect(service.refresh(ACCOUNT_ID, ALL_RANKS, ITEM_IDS)).resolves.toBe('updated');

    expect(http.requests.map((request) => queryOf(request.url))).toEqual([
      ANY_LENGTH_FILTERS,
      { ...ITEM_STATS_PARAMETERS, ...ANY_LENGTH_FILTERS },
    ]);
    expect(cachedData(await service.read(ALL_RANKS, ITEM_IDS))).toMatchObject({
      wanted: ALL_RANKS,
      used: ALL_RANKS,
    });
    await expect(cache.get(ALL_RANKS_KEY)).resolves.not.toBeNull();
  });

  it.each([
    { label: 'the first second of the day', time: Date.UTC(2026, 9, 20), sinceDays: 0 },
    { label: 'the last second of the day', time: Date.UTC(2026, 9, 20, 23, 59, 59), sinceDays: 0 },
    { label: 'the first second of the next day', time: Date.UTC(2026, 9, 21), sinceDays: 1 },
  ])('asks for 30 days before the UTC midnight at $label', async ({ time, sinceDays }) => {
    const { service, http, clock } = setUp();
    clock.now = time;

    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);

    expect(http.requests).toHaveLength(2);
    for (const request of http.requests) {
      expect(queryOf(request.url).min_unix_timestamp).toBe(
        String(SINCE_UNIX_S + sinceDays * 86_400),
      );
    }
  });

  it('falls back to all ranks for a small tier', async () => {
    const { service, http, cache } = setUp({
      handler: withSampleSizes({ tier: MIN_COHORT_MATCHES - 1, all: 5_000 }),
    });

    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');

    // The size of the tier, then the size of every rank, then the item statistics of the latter.
    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, HERO_STATS_PATH, ITEM_STATS_PATH]);
    expect(http.requests.map((request) => 'min_average_badge' in queryOf(request.url))).toEqual([
      true,
      false,
      false,
    ]);
    expect(queryOf(http.requests[2]?.url ?? '')).toEqual({
      ...ITEM_STATS_PARAMETERS,
      ...ANY_LENGTH_FILTERS,
    });
    // The entry stays under the key of the tier that was asked for.
    await expect(cache.get(ALL_RANKS_KEY)).resolves.toBeNull();
    expect(cachedData(await service.read(TIER_7, ITEM_IDS))).toMatchObject({
      wanted: TIER_7,
      used: ALL_RANKS,
      sampleMatches: 5_000,
      items: expectedItems(ITEM_IDS),
    });
  });

  it('keeps the tier at exactly the smallest size that can be compared', async () => {
    const { service, http } = setUp({
      handler: withSampleSizes({ tier: MIN_COHORT_MATCHES, all: 5_000 }),
    });

    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);

    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, ITEM_STATS_PATH]);
    expect(cachedData(await service.read(TIER_7, ITEM_IDS))).toMatchObject({
      used: TIER_7,
      sampleMatches: MIN_COHORT_MATCHES,
    });
  });

  it('stores an entry without items when all ranks are too small, and keeps it for a day', async () => {
    const { service, http } = setUp({
      handler: withSampleSizes({ tier: 10, all: MIN_COHORT_MATCHES - 1 }),
    });

    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');

    // No item statistics are requested for a cohort that cannot be used.
    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, HERO_STATS_PATH]);
    // The entry says there is nothing to compare with, whichever items are asked for.
    await expect(service.read(TIER_7, ITEM_IDS)).resolves.toEqual({
      kind: 'cached',
      stale: false,
      data: {
        wanted: TIER_7,
        used: null,
        sampleMatches: MIN_COHORT_MATCHES - 1,
        items: new Map(),
        fetchedAt: START,
      },
    });
    await expect(service.read(TIER_7, ITEM_IDS.slice(0, 2))).resolves.toMatchObject({
      kind: 'cached',
    });
    // The answer is kept like any other: asking again does not ask deadlock-api again.
    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('fresh');
    expect(http.requests).toHaveLength(2);
  });

  it('has no fallback for every rank', async () => {
    const { service, http } = setUp({ handler: withSampleSizes({ tier: 5_000, all: 150 }) });

    await expect(service.refresh(ACCOUNT_ID, ALL_RANKS, ITEM_IDS)).resolves.toBe('updated');

    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH]);
    expect(cachedData(await service.read(ALL_RANKS, ITEM_IDS))).toMatchObject({
      wanted: ALL_RANKS,
      used: null,
      sampleMatches: 150,
    });
  });

  it('answers fresh without a request when the cache is fresh', async () => {
    const { service, http, clock } = setUp();
    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
    expect(http.requests).toHaveLength(2);

    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('fresh');
    clock.now = START + DAY - 1;
    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('fresh');
    // A subset of the items is covered too.
    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS.slice(0, 2))).resolves.toBe('fresh');

    expect(http.requests).toHaveLength(2);
  });

  it('refreshes an entry that is a day old, and keeps the ranks apart', async () => {
    const { service, http, clock } = setUp();
    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
    // Another rank has its own entry.
    await expect(service.read(ALL_RANKS, ITEM_IDS)).resolves.toEqual({ kind: 'missing' });

    clock.now = START + DAY;
    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');

    expect(http.requests).toHaveLength(4);
    expect(cachedData(await service.read(TIER_7, ITEM_IDS)).fetchedAt).toBe(START + DAY);
  });

  it('refreshes an entry dated in the future', async () => {
    const { service, http, clock } = setUp();
    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
    // The system clock moved backwards: the entry would otherwise stay fresh until it catches up.
    clock.now = START - HOUR;

    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');

    expect(http.requests).toHaveLength(4);
  });

  it('downloads again when the cached entry lacks an asked item', async () => {
    const { service, http } = setUp();
    const asked = ITEM_IDS.slice(0, 3);
    await service.refresh(ACCOUNT_ID, TIER_7, asked);

    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS.slice(0, 4))).resolves.toBe(
      'updated',
    );

    expect(http.requests).toHaveLength(4);
    expect(cachedData(await service.read(TIER_7, ITEM_IDS.slice(0, 4))).items).toEqual(
      expectedItems(ITEM_IDS.slice(0, 4)),
    );
  });

  it('records an item nobody bought as no purchase, so the entry stays complete', async () => {
    const { service, http, logger } = setUp();
    const asked = [ITEM_IDS[0] ?? 0, UNBOUGHT_ITEM_ID];

    await expect(service.refresh(ACCOUNT_ID, TIER_7, asked)).resolves.toBe('updated');

    const { items } = cachedData(await service.read(TIER_7, asked));
    expect(items.get(UNBOUGHT_ITEM_ID)).toEqual({ purchases: 0, minutes: new Map() });
    expect(items.get(asked[0] ?? 0)?.purchases).toBeGreaterThan(0);
    // The entry covers both items: it is fresh, and it is not downloaded again.
    await expect(service.refresh(ACCOUNT_ID, TIER_7, asked)).resolves.toBe('fresh');
    expect(http.requests).toHaveLength(2);
    // Only the item that was bought counts in the diagnostic, and one bought item is no problem.
    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { items: 1, sampleMatches: 2_422, fallback: false },
      },
    ]);
  });

  it('ignores an asked id that is not a positive whole number, so the entry stays readable', async () => {
    const { service, cache, http, logger } = setUp();
    const valid = ITEM_IDS.slice(0, 2);
    const asked = [...valid, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    await expect(service.refresh(ACCOUNT_ID, TIER_7, asked)).resolves.toBe('updated');

    // Only the valid items are stored: the others could not be read back.
    const stored = await cache.get(TIER_7_KEY);
    const payload = JSON.parse(stored?.payloadJson ?? 'null') as { items: [number, unknown][] };
    expect(payload.items.map(([itemId]) => itemId)).toEqual(valid);
    // The same list reads back, and so does the valid part of it.
    expect(cachedData(await service.read(TIER_7, asked)).items).toEqual(expectedItems(valid));
    await expect(service.read(TIER_7, valid)).resolves.toMatchObject({ kind: 'cached' });
    // The invalid ids are not asked of the entry either: it is fresh, and nothing is reported.
    await expect(service.refresh(ACCOUNT_ID, TIER_7, asked)).resolves.toBe('fresh');
    expect(http.requests).toHaveLength(2);
    expect(communityLines(logger).map((entry) => entry.message)).toEqual([DOWNLOADED]);
  });

  it('sums the purchases of an item over its minutes', async () => {
    const { service } = setUp();

    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);

    for (const timing of cachedData(await service.read(TIER_7, ITEM_IDS)).items.values()) {
      expect(timing.minutes.size).toBeGreaterThan(0);
      expect(timing.purchases).toBe([...timing.minutes.values()].reduce((a, b) => a + b, 0));
    }
  });

  it('writes nothing after an account change', async () => {
    for (const accountAfter of [OTHER_ACCOUNT_ID, null]) {
      const { service, cache, answer, link, logger } = setUp();
      const fixtureApi = answer.handler;
      // The last request of the download is the one that sees the account change.
      answer.handler = (request) => {
        if (new URL(request.url).pathname === ITEM_STATS_PATH) {
          link.accountId = accountAfter;
        }
        return fixtureApi(request);
      };

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
      // A download dropped on purpose is no failure: a `debug` line says so, and nothing else.
      expect(communityLines(logger)).toEqual([
        { level: 'debug', scope: SCOPE, message: ACCOUNT_CHANGED, context: {} },
      ]);
    }
  });

  describe('when the item statistics cannot be fetched', () => {
    it('answers unavailable while deadlock-api is paused, and sends nothing', async () => {
      const { service, http, logger, syncState, cache } = setUp();
      await syncState.setPausedUntil(START + 5 * MINUTE);

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      expect(http.requests).toHaveLength(0);
      await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
      // A pause is expected: a `debug` line, not a warning.
      expect(communityLines(logger)).toEqual([
        { level: 'debug', scope: SCOPE, message: UNAVAILABLE, context: { kind: 'paused' } },
      ]);
    });

    it('answers unavailable when deadlock-api asks for a pause, and stops there', async () => {
      const { service, http, logger } = setUp({
        handler: overriding(ITEM_STATS_PATH, () => jsonResponse({}, 429, { 'retry-after': '120' })),
      });

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');
      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      // The size, then the item statistics that asked for the pause; the pause stops the rest.
      expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, ITEM_STATS_PATH]);
      expect(communityLines(logger).map((entry) => [entry.level, entry.context])).toEqual([
        ['debug', { kind: 'paused' }],
        ['debug', { kind: 'paused' }],
      ]);
    });

    it('answers unavailable when the budget of the minute is spent', async () => {
      const { service, api, http, logger, cache } = setUp();
      // The requests of the minute are spent before the service asks for its own.
      for (let index = 0; index < ANALYTICS_RATE_LIMIT.limit; index += 1) {
        await api.fetchHeroSample({
          heroId: PAIGE_HERO_ID,
          sinceUnixS: SINCE_UNIX_S,
          minDurationS: 0,
          maxDurationS: 7_000,
          badge: null,
        });
      }

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      // A request over the budget is not even sent.
      expect(http.requests).toHaveLength(ANALYTICS_RATE_LIMIT.limit);
      await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
      expect(communityLines(logger)).toEqual([
        {
          level: 'debug',
          scope: SCOPE,
          message: UNAVAILABLE,
          context: { kind: 'budget_exhausted' },
        },
      ]);
    });

    it('answers unavailable when the budget is spent by the size of the tier', async () => {
      const { service, api, http, logger, cache } = setUp();
      // One request is left in the minute: the size takes it, and the item statistics are refused.
      for (let index = 0; index < ANALYTICS_RATE_LIMIT.limit - 1; index += 1) {
        await api.fetchHeroSample({
          heroId: PAIGE_HERO_ID,
          sinceUnixS: SINCE_UNIX_S,
          minDurationS: 0,
          maxDurationS: 7_000,
          badge: null,
        });
      }

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      expect(http.requests).toHaveLength(ANALYTICS_RATE_LIMIT.limit);
      expect(requestedPaths(http).at(-1)).toBe(HERO_STATS_PATH);
      await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
      expect(communityLines(logger)).toEqual([
        {
          level: 'debug',
          scope: SCOPE,
          message: UNAVAILABLE,
          context: { kind: 'budget_exhausted' },
        },
      ]);
    });

    it.each([
      {
        failure: 'the network drops at the size',
        handler: failingAt(HERO_STATS_PATH),
        context: { kind: 'network', endpoint: HERO_STATS_PATH },
      },
      {
        failure: 'deadlock-api fails at the item statistics',
        handler: overriding(ITEM_STATS_PATH, () => jsonResponse({}, 500)),
        context: { kind: 'service_unavailable', endpoint: ITEM_STATS_PATH },
      },
      {
        failure: 'the item statistics are not a list',
        handler: overriding(ITEM_STATS_PATH, () => jsonResponse({ secret: 'value' })),
        context: { kind: 'invalid_payload' },
      },
    ])('answers unavailable and stores nothing when $failure', async ({ handler, context }) => {
      const { service, cache, logger } = setUp({ handler });

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
      expect(communityLines(logger)).toEqual([
        { level: 'warn', scope: SCOPE, message: UNAVAILABLE, context },
      ]);
      expect(JSON.stringify(logger.entries)).not.toContain('secret');
    });

    it('keeps serving the stale entry', async () => {
      const { service, clock, answer, logger } = setUp();
      await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
      const data = cachedData(await service.read(TIER_7, ITEM_IDS));
      clock.now = START + 3 * DAY;
      answer.handler = failingAt(HERO_STATS_PATH);

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      await expect(service.read(TIER_7, ITEM_IDS)).resolves.toEqual({
        kind: 'cached',
        stale: true,
        data,
      });
      expect(communityLines(logger).map((entry) => entry.message)).toContain(UNAVAILABLE);
    });

    it.each([
      { step: 'reading the cache', cacheFails: (sql: string) => sql.startsWith('SELECT') },
      { step: 'writing the entry', cacheFails: (sql: string) => sql.startsWith('INSERT') },
    ])('never rejects when $step fails', async ({ cacheFails }) => {
      const { service, logger } = setUp({ cacheFails });

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      expect(communityLines(logger)).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: UNAVAILABLE,
          context: expect.objectContaining({ kind: 'storage' }) as unknown,
        }),
      );
    });

    it('never rejects when the linked account cannot be read', async () => {
      const { service, cache, link, logger } = setUp();
      link.failure = new AppError('storage', 'The linked account is invalid');

      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('unavailable');

      await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
      expect(communityLines(logger)).toEqual([
        { level: 'warn', scope: SCOPE, message: UNAVAILABLE, context: { kind: 'storage' } },
      ]);
    });
  });

  describe('when refreshes overlap', () => {
    it('shares one download between two calls, and starts anew once it is over', async () => {
      const { service, http } = setUp();

      const first = service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
      const second = service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);

      // The very same promise, not two runs that happen to agree.
      expect(second).toBe(first);
      await expect(Promise.all([first, second])).resolves.toEqual(['updated', 'updated']);
      expect(http.requests).toHaveLength(2);
      // The run is over: the next call is a call of its own, and it finds the cache fresh.
      const third = service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
      expect(third).not.toBe(first);
      await expect(third).resolves.toBe('fresh');
      expect(http.requests).toHaveLength(2);
    });

    it('runs the ranks apart', async () => {
      const { service, http } = setUp();

      await expect(
        Promise.all([
          service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS),
          service.refresh(ACCOUNT_ID, ALL_RANKS, ITEM_IDS),
        ]),
      ).resolves.toEqual(['updated', 'updated']);

      expect(http.requests).toHaveLength(4);
    });

    it('shares the run whichever account asks, and checks the account once, inside it', async () => {
      const { service, http, cache, link } = setUp();
      // The account is no longer the one that started the run when the download ends.
      link.accountId = OTHER_ACCOUNT_ID;

      const results = await Promise.all([
        service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS),
        service.refresh(OTHER_ACCOUNT_ID, TIER_7, ITEM_IDS),
      ]);

      // The run is the first caller's: its account is not the linked one, so nothing is stored for
      // either caller, and one set of requests was sent.
      expect(results).toEqual(['unavailable', 'unavailable']);
      expect(http.requests).toHaveLength(2);
      await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
    });

    it('shares a failure too, and tries again at the next call', async () => {
      const { service, http, answer, logger } = setUp({ handler: failingAt(HERO_STATS_PATH) });

      await expect(
        Promise.all([
          service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS),
          service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS),
        ]),
      ).resolves.toEqual(['unavailable', 'unavailable']);
      // One run, one request, one line: the second caller did not fail on its own.
      expect(http.requests).toHaveLength(1);
      expect(communityLines(logger)).toHaveLength(1);

      // A failed run does not stay in the way.
      answer.handler = createFixtureApi({ now: START, matchCount: 1 });
      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');
    });
  });
});

describe('ItemBenchmarkService.read', () => {
  it('says missing when nothing is cached, and sends nothing', async () => {
    const { service, http } = setUp();

    await expect(service.read(TIER_7, ITEM_IDS)).resolves.toEqual({ kind: 'missing' });

    expect(http.requests).toHaveLength(0);
  });

  it('answers missing when an asked item is not cached', async () => {
    const { service, http, logger } = setUp();
    const cachedItems = ITEM_IDS.slice(0, 3);
    await service.refresh(ACCOUNT_ID, TIER_7, cachedItems);
    const linesBefore = logger.entries.length;

    await expect(service.read(TIER_7, cachedItems)).resolves.toMatchObject({ kind: 'cached' });
    await expect(service.read(TIER_7, cachedItems.slice(1))).resolves.toMatchObject({
      kind: 'cached',
    });
    await expect(service.read(TIER_7, ITEM_IDS.slice(0, 4))).resolves.toEqual({ kind: 'missing' });

    // An entry that lacks an item is complete for the items it holds: nothing to report.
    expect(logger.entries).toHaveLength(linesBefore);
    expect(http.requests).toHaveLength(2);
  });

  it.each([
    { label: 'a day old, to the millisecond', now: START + DAY, stale: true },
    { label: 'less than a day old', now: START + DAY - 1, stale: false },
    { label: 'dated in the future', now: START - 1, stale: true },
    { label: 'fetched right now', now: START, stale: false },
  ])('tells whether an entry is stale: $label', async ({ now, stale }) => {
    const { service, clock } = setUp();
    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
    clock.now = now;

    const read = await service.read(TIER_7, ITEM_IDS);

    expect(read).toMatchObject({ kind: 'cached', stale });
  });

  it('rejects with a storage error when the cache cannot be read', async () => {
    const { service } = setUp({ cacheFails: (sql) => sql.startsWith('SELECT') });

    await expect(service.read(TIER_7, ITEM_IDS)).rejects.toMatchObject({ kind: 'storage' });
  });

  describe('an entry that cannot be read', () => {
    /** Ways to make the stored JSON of an entry say something else, the way a damaged file would. */
    const damages: readonly { label: string; damage: (stored: string) => string }[] = [
      { label: 'text that is not JSON', damage: () => '{"used": "a secret value' },
      {
        label: 'JSON of another shape',
        damage: () => JSON.stringify({ used: 'a secret value' }),
      },
      {
        label: 'a tier that does not exist',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { used: object };
          payload.used = { kind: 'tier', tier: 99 };
          return JSON.stringify(payload);
        },
      },
      {
        label: 'a number of purchases that is not a count',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { items: [number, [number, unknown][]][] };
          const minute = payload.items[0]?.[1][0];
          if (minute !== undefined) {
            minute[1] = 'a secret value';
          }
          return JSON.stringify(payload);
        },
      },
      {
        label: 'a negative minute',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { items: [number, [number, number][]][] };
          const minute = payload.items[0]?.[1][0];
          if (minute !== undefined) {
            minute[0] = -1;
          }
          return JSON.stringify(payload);
        },
      },
      {
        label: 'an item that is not a pair',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { items: unknown[] };
          payload.items.push(['a secret value']);
          return JSON.stringify(payload);
        },
      },
    ];

    /** Store the entry of {@link TIER_7} damaged, as fresh as the real one was. */
    async function storeDamaged(
      cache: ApiCacheRepository,
      damage: (stored: string) => string,
    ): Promise<void> {
      const stored = await cache.get(TIER_7_KEY);
      await cache.put(TIER_7_KEY, {
        payloadJson: damage(stored?.payloadJson ?? ''),
        fetchedAt: START,
        expiresAt: START + DAY,
      });
    }

    it.each(damages)('is missing, and logged once with no value: $label', async ({ damage }) => {
      const { service, cache, logger } = setUp();
      await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
      await storeDamaged(cache, damage);
      const linesBefore = communityLines(logger).length;

      await expect(service.read(TIER_7, ITEM_IDS)).resolves.toEqual({ kind: 'missing' });
      await expect(service.read(TIER_7, ITEM_IDS)).resolves.toEqual({ kind: 'missing' });

      expect(communityLines(logger).slice(linesBefore)).toEqual([
        {
          level: 'warn',
          scope: SCOPE,
          message: UNREADABLE,
          context: { issue: expect.any(String) as unknown },
        },
      ]);
      expect(JSON.stringify(logger.entries)).not.toContain('secret');
    });

    it.each(damages)('is replaced by a refresh: $label', async ({ damage }) => {
      const { service, cache, http } = setUp();
      await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
      await storeDamaged(cache, damage);

      // The entry is not fresh: it does not count as one.
      await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');

      expect(http.requests).toHaveLength(4);
      expect(cachedData(await service.read(TIER_7, ITEM_IDS)).items).toEqual(
        expectedItems(ITEM_IDS),
      );
    });

    it('is reported again once it was rewritten and damaged again', async () => {
      const { service, cache, logger } = setUp();
      const unreadableLines = () =>
        communityLines(logger).filter((entry) => entry.message === UNREADABLE);
      await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
      await storeDamaged(cache, () => 'not json');
      await service.read(TIER_7, ITEM_IDS);
      expect(unreadableLines()).toHaveLength(1);

      await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
      await storeDamaged(cache, () => 'not json');
      await service.read(TIER_7, ITEM_IDS);

      // The refresh found the entry already reported, and replaced it; the entry damaged again is
      // a new problem.
      expect(unreadableLines()).toHaveLength(2);
    });
  });
});

describe('the diagnostic of a download', () => {
  it('counts what was downloaded, and nothing else', async () => {
    const { service, logger, http } = setUp();

    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);

    // Counts and a flag: never the tier, an item or a value.
    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { items: 12, sampleMatches: 2_422, fallback: false },
      },
    ]);
    // No account id is sent or logged.
    for (const request of http.requests) {
      expect(request.url).not.toContain(String(ACCOUNT_ID));
    }
    expect(JSON.stringify(logger.entries)).not.toContain(String(ACCOUNT_ID));
  });

  it('tells when the cohort is the all-ranks fallback', async () => {
    const { service, logger } = setUp({ handler: withSampleSizes({ tier: 12, all: 5_000 }) });

    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);

    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { items: 12, sampleMatches: 5_000, fallback: true },
      },
    ]);
  });

  it('warns when items were asked for and the cohort bought none of them', async () => {
    const { service, logger } = setUp({
      handler: overriding(ITEM_STATS_PATH, () => jsonResponse([])),
    });

    await expect(service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS)).resolves.toBe('updated');

    // Counts only: how many were bought, and how many were asked.
    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { items: 0, sampleMatches: 2_422, fallback: false },
      },
      {
        level: 'warn',
        scope: SCOPE,
        message: INCOMPLETE,
        context: { items: 0, askedItems: ITEM_IDS.length },
      },
    ]);
  });

  it('does not warn about the purchases when no item was asked for', async () => {
    const { service, logger } = setUp({
      handler: overriding(ITEM_STATS_PATH, () => jsonResponse([])),
    });

    await service.refresh(ACCOUNT_ID, TIER_7, []);

    expect(communityLines(logger).map((entry) => entry.message)).toEqual([DOWNLOADED]);
  });

  it('counts no item for a cohort that is too small', async () => {
    const { service, logger } = setUp({ handler: withSampleSizes({ tier: 12, all: 199 }) });

    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);

    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { items: 0, sampleMatches: 199, fallback: false },
      },
    ]);
  });
});

describe('the entries of the item statistics in the cache', () => {
  it('are deleted with the other entries of the analytics once a week old', async () => {
    const { service, api, cache, accountSource, logger, clock } = setUp();
    const benchmarks = new BenchmarkService({
      api,
      cache,
      accountSource,
      logger,
      now: () => clock.now,
    });
    await service.refresh(ACCOUNT_ID, TIER_7, ITEM_IDS);
    await service.refresh(ACCOUNT_ID, ALL_RANKS, ITEM_IDS);
    // The entry of the tier is a week and a day old when a cohort of the analysis is downloaded.
    clock.now = START + 8 * DAY;
    await service.refresh(ACCOUNT_ID, ALL_RANKS, ITEM_IDS);
    const cohort: Cohort = { rank: TIER_7, window: { minS: 1_500, maxS: 1_799 } };

    await benchmarks.refresh(ACCOUNT_ID, cohort);

    await expect(cache.get(TIER_7_KEY)).resolves.toBeNull();
    await expect(cache.get(ALL_RANKS_KEY)).resolves.not.toBeNull();
  });
});

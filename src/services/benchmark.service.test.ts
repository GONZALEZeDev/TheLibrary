/**
 * Tests of the community data service, with the fixture API, a fake clock and an in-memory database
 * that holds the cache.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { createFixtureApi, jsonResponse } from '../adapters/dev/fixture-http-client.adapter';
import {
  createMetricBenchmarkFixture,
  createPerformanceCurveFixture,
} from '../adapters/dev/fixtures/analytics.fixture';
import type { Cohort } from '../core/analysis/cohort';
import { ANALYTICS_RATE_LIMIT } from '../core/deadlock-api/budgets';
import { parseMetricBenchmark } from '../core/deadlock-api/metric-benchmark.schema';
import { parsePerformanceCurve } from '../core/deadlock-api/performance-curve.schema';
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
import {
  ANALYTICS_PURGE_AGE_MS,
  BenchmarkService,
  COHORT_MAX_AGE_MS,
  communityPeriodStartS,
  type CohortData,
  type CohortRead,
} from './benchmark.service';

const START = Date.UTC(2026, 9, 20, 15, 30, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ACCOUNT_ID = testAccountId(1000001);
const OTHER_ACCOUNT_ID = testAccountId(2000001);

/** The start of the period the service asks for at `START`: 30 days before the UTC midnight, in s. */
const SINCE_UNIX_S = Date.UTC(2026, 9, 20) / 1000 - 30 * 86_400;

/** A cohort of tier 4 (Sentinel) in the window of the matches from 25 to 30 minutes. */
const TIER_4: Cohort = { rank: { kind: 'tier', tier: 4 }, window: { minS: 1_500, maxS: 1_799 } };

/** The cohort of every rank in the same window: the fallback of {@link TIER_4}. */
const ALL_RANKS: Cohort = { rank: { kind: 'all' }, window: TIER_4.window };

/** The cache key of {@link TIER_4}. */
const TIER_4_KEY = 'analytics.cohort.v2.tier4.1500-1799';

/** The cache key {@link TIER_4} had before the curve held the deaths of the community. */
const TIER_4_EARLIER_KEY = 'analytics.cohort.tier4.1500-1799';

/** The paths of the other two community requests of a cohort, after the one for its size. */
const BENCHMARK_PATH = '/v1/analytics/player-stats/metrics';
const CURVE_PATH = '/v1/analytics/player-performance-curve';

/** The parts of the log lines of the service that do not depend on the test. */
const SCOPE = 'community';
const UNAVAILABLE = 'Community data unavailable';
const DOWNLOADED = 'Community data downloaded';
const INCOMPLETE = 'Community data incomplete';
const UNREADABLE = 'Cached community data is unreadable';
const ACCOUNT_CHANGED = 'Community data not stored, the account changed';

/** The query parameters every community request of the window of {@link TIER_4} carries. */
const WINDOW_FILTERS = {
  game_mode: 'normal',
  min_unix_timestamp: String(SINCE_UNIX_S),
  min_duration_s: '1500',
  max_duration_s: '1799',
};

/** The query parameters every community request of {@link TIER_4} carries: Sentinel is badges 41 to 46. */
const TIER_4_FILTERS = { ...WINDOW_FILTERS, min_average_badge: '41', max_average_badge: '46' };

/**
 * Build the service on the environment of the community tests.
 *
 * @param options - See {@link CommunityOptions}.
 * @returns The service, and everything {@link setUpCommunity} builds under it: the deadlock-api
 *   service, the cache, the HTTP client, the logger, the clock, a way to change the handler, the
 *   synchronisation state (where the pause is kept) and the linked account.
 */
function setUp(options: CommunityOptions = {}) {
  const community = setUpCommunity(START, ACCOUNT_ID, options);
  const { api, cache, accountSource, logger, now } = community;
  const service = new BenchmarkService({ api, cache, accountSource, logger, now });
  return { ...community, service };
}

/**
 * The JSON that was stored for {@link TIER_4} before the curve held deaths: the very data the
 * fixture API gives, with four counters in each point of the curve.
 *
 * @returns The JSON of the entry.
 */
function earlierFormatJson(): string {
  const withoutDeaths = (counters: object) =>
    Object.fromEntries(Object.entries(counters).filter(([counter]) => counter !== 'deaths'));
  const curve = parsePerformanceCurve(createPerformanceCurveFixture(TIER_4.window.maxS)).map(
    (point) => ({
      timeS: point.timeS,
      avg: withoutDeaths(point.avg),
      std: withoutDeaths(point.std),
    }),
  );
  return JSON.stringify({
    wanted: TIER_4,
    used: TIER_4,
    sampleMatches: 2_422,
    benchmark: [...parseMetricBenchmark(createMetricBenchmarkFixture())],
    curve,
  });
}

/** The data of a cohort that is cached, or a failure of the test. */
function cachedData(read: CohortRead): CohortData {
  if (read.kind !== 'cached') {
    throw new Error('The cohort should be cached');
  }
  return read.data;
}

describe('communityPeriodStartS', () => {
  it.each([
    { label: 'the first second of a day', time: Date.UTC(2026, 9, 20), sinceDays: 0 },
    { label: 'the last second of a day', time: Date.UTC(2026, 9, 20, 23, 59, 59), sinceDays: 0 },
    { label: 'the first second of the next day', time: Date.UTC(2026, 9, 21), sinceDays: 1 },
  ])('is 30 days before the UTC midnight at $label', ({ time, sinceDays }) => {
    expect(communityPeriodStartS(time)).toBe(SINCE_UNIX_S + sinceDays * 86_400);
  });

  it('is the period the service asks for', async () => {
    const { service, http } = setUp();

    await service.refresh(ACCOUNT_ID, TIER_4);

    for (const request of http.requests) {
      expect(new URL(request.url).searchParams.get('min_unix_timestamp')).toBe(
        String(communityPeriodStartS(START)),
      );
    }
  });
});

describe('the ages of the community data', () => {
  it('keeps a cohort for a day and purges analytics entries after a week', () => {
    expect(COHORT_MAX_AGE_MS).toBe(DAY);
    expect(ANALYTICS_PURGE_AGE_MS).toBe(7 * DAY);
  });
});

describe('BenchmarkService.refresh', () => {
  it('fetches size, benchmark and curve once, then answers fresh', async () => {
    const { service, http } = setUp();

    await expect(service.read(TIER_4)).resolves.toEqual({ kind: 'missing' });
    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');
    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, BENCHMARK_PATH, CURVE_PATH]);

    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('fresh');
    expect(http.requests).toHaveLength(3);
    // What was stored is what the API gave, once validated: the maps and the curve survive the JSON.
    await expect(service.read(TIER_4)).resolves.toEqual({
      kind: 'cached',
      stale: false,
      data: {
        wanted: TIER_4,
        used: TIER_4,
        sampleMatches: 2_422,
        benchmark: parseMetricBenchmark(createMetricBenchmarkFixture()),
        curve: parsePerformanceCurve(createPerformanceCurveFixture(TIER_4.window.maxS)),
        fetchedAt: START,
      },
    });
  });

  it('stores and reads a cohort with its deaths', async () => {
    const { service, cache } = setUp();

    await service.refresh(ACCOUNT_ID, TIER_4);

    const { curve } = cachedData(await service.read(TIER_4));
    const raw = createPerformanceCurveFixture(TIER_4.window.maxS);
    expect(curve.length).toBeGreaterThan(0);
    expect(curve.map((point) => point.avg.deaths)).toEqual(raw.map((point) => point.deaths_avg));
    expect(curve.map((point) => point.std.deaths)).toEqual(raw.map((point) => point.deaths_std));
    // The entry is under the key of the format that holds them, and holds them in each point.
    const stored = await cache.get(TIER_4_KEY);
    const payload = JSON.parse(stored?.payloadJson ?? 'null') as {
      curve: { avg: { deaths: number }; std: { deaths: number } }[];
    };
    expect(payload.curve.map((point) => point.avg.deaths)).toEqual(
      raw.map((point) => point.deaths_avg),
    );
    expect(payload.curve.map((point) => point.std.deaths)).toEqual(
      raw.map((point) => point.deaths_std),
    );
  });

  it('asks for the badge range of the tier, the window, the period and the hero, and nothing else', async () => {
    const { service, http } = setUp();

    await service.refresh(ACCOUNT_ID, TIER_4);

    expect(http.requests.map((request) => queryOf(request.url))).toEqual([
      TIER_4_FILTERS,
      { hero_ids: String(PAIGE_HERO_ID), ...TIER_4_FILTERS },
      { hero_ids: String(PAIGE_HERO_ID), resolution: '0', ...TIER_4_FILTERS },
    ]);
    for (const request of http.requests) {
      expect(request.url).not.toContain(String(ACCOUNT_ID));
    }
  });

  it('asks for no badge range for every rank', async () => {
    const { service, http } = setUp();

    await expect(service.refresh(ACCOUNT_ID, ALL_RANKS)).resolves.toBe('updated');

    expect(http.requests.map((request) => queryOf(request.url))).toEqual([
      WINDOW_FILTERS,
      { hero_ids: String(PAIGE_HERO_ID), ...WINDOW_FILTERS },
      { hero_ids: String(PAIGE_HERO_ID), resolution: '0', ...WINDOW_FILTERS },
    ]);
  });

  it.each([
    { label: 'the first second of the day', time: Date.UTC(2026, 9, 20), sinceDays: 0 },
    { label: 'the last second of the day', time: Date.UTC(2026, 9, 20, 23, 59, 59), sinceDays: 0 },
    { label: 'the first second of the next day', time: Date.UTC(2026, 9, 21), sinceDays: 1 },
  ])('asks for 30 days before the UTC midnight at $label', async ({ time, sinceDays }) => {
    const { service, http, clock } = setUp();
    clock.now = time;

    await service.refresh(ACCOUNT_ID, TIER_4);

    expect(http.requests).toHaveLength(3);
    for (const request of http.requests) {
      expect(new URL(request.url).searchParams.get('min_unix_timestamp')).toBe(
        String(SINCE_UNIX_S + sinceDays * 86_400),
      );
    }
  });

  it('falls back to all ranks under 200 matches', async () => {
    const { service, http } = setUp({ handler: withSampleSizes({ tier: 199, all: 5_000 }) });

    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

    // The size of the tier, then the size of every rank, then the benchmark and the curve of the latter.
    expect(requestedPaths(http)).toEqual([
      HERO_STATS_PATH,
      HERO_STATS_PATH,
      BENCHMARK_PATH,
      CURVE_PATH,
    ]);
    expect(http.requests.map((request) => 'min_average_badge' in queryOf(request.url))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    const data = cachedData(await service.read(TIER_4));
    expect(data).toMatchObject({ wanted: TIER_4, used: ALL_RANKS, sampleMatches: 5_000 });
    expect(data.benchmark.size).toBe(11);
    expect(data.curve.length).toBeGreaterThan(0);
  });

  it('keeps the tier at exactly 200 matches', async () => {
    const { service, http } = setUp({ handler: withSampleSizes({ tier: 200, all: 5_000 }) });

    await service.refresh(ACCOUNT_ID, TIER_4);

    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, BENCHMARK_PATH, CURVE_PATH]);
    expect(cachedData(await service.read(TIER_4))).toMatchObject({
      used: TIER_4,
      sampleMatches: 200,
    });
  });

  it('stores an unavailable cohort when all ranks are too small', async () => {
    const { service, http } = setUp({ handler: withSampleSizes({ tier: 10, all: 199 }) });

    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

    // No benchmark nor curve is requested for a cohort that cannot be used.
    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, HERO_STATS_PATH]);
    await expect(service.read(TIER_4)).resolves.toEqual({
      kind: 'cached',
      stale: false,
      data: {
        wanted: TIER_4,
        used: null,
        sampleMatches: 199,
        benchmark: new Map(),
        curve: [],
        fetchedAt: START,
      },
    });
    // The answer is kept like any other: asking again does not ask deadlock-api again.
    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('fresh');
    expect(http.requests).toHaveLength(2);
  });

  it('has no fallback for the cohort of every rank', async () => {
    const { service, http } = setUp({ handler: withSampleSizes({ tier: 5_000, all: 150 }) });

    await expect(service.refresh(ACCOUNT_ID, ALL_RANKS)).resolves.toBe('updated');

    expect(requestedPaths(http)).toEqual([HERO_STATS_PATH]);
    expect(cachedData(await service.read(ALL_RANKS))).toMatchObject({
      wanted: ALL_RANKS,
      used: null,
      sampleMatches: 150,
    });
  });

  it('refreshes an entry that is stale, and keeps the cohorts apart', async () => {
    const { service, http, clock } = setUp();
    await service.refresh(ACCOUNT_ID, TIER_4);
    clock.now = START + DAY - 1;
    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('fresh');
    // Another cohort has its own entry.
    await expect(service.read(ALL_RANKS)).resolves.toEqual({ kind: 'missing' });

    clock.now = START + DAY;
    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

    expect(http.requests).toHaveLength(6);
    expect(cachedData(await service.read(TIER_4)).fetchedAt).toBe(START + DAY);
  });

  it('writes nothing when the account changed during the fetch', async () => {
    for (const accountAfter of [OTHER_ACCOUNT_ID, null]) {
      const { service, cache, answer, link, logger } = setUp();
      const fixtureApi = answer.handler;
      // The last request of the cohort is the one that sees the account change.
      answer.handler = (request) => {
        if (new URL(request.url).pathname === CURVE_PATH) {
          link.accountId = accountAfter;
        }
        return fixtureApi(request);
      };
      const old = { payloadJson: '{}', fetchedAt: START - 8 * DAY, expiresAt: START - 7 * DAY };
      await cache.put('analytics.cohort.v2.tier1.0-1199', old);

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

      await expect(cache.get(TIER_4_KEY)).resolves.toBeNull();
      // Nothing was written, so nothing was purged either.
      await expect(cache.get('analytics.cohort.v2.tier1.0-1199')).resolves.toEqual(old);
      // A download dropped on purpose is no failure: a `debug` line says so, and nothing else.
      expect(communityLines(logger)).toEqual([
        { level: 'debug', scope: SCOPE, message: ACCOUNT_CHANGED, context: {} },
      ]);
    }
  });

  it('purges analytics entries older than 7 days only', async () => {
    const { service, cache } = setUp();
    const entryFetchedAt = (fetchedAt: number) => ({
      payloadJson: '[]',
      fetchedAt,
      expiresAt: fetchedAt + DAY,
    });
    await cache.put('analytics.cohort.tier1.0-1199', entryFetchedAt(START - 7 * DAY - 1));
    await cache.put('analytics.something.else', entryFetchedAt(START - 30 * DAY));
    // Exactly 7 days old is not older than 7 days.
    await cache.put('analytics.cohort.tier2.0-1199', entryFetchedAt(START - 7 * DAY));
    await cache.put('analytics.cohort.tier3.0-1199', entryFetchedAt(START - DAY));
    // The entries of the current format are purged by the same rule.
    await cache.put('analytics.cohort.v2.tier1.0-1199', entryFetchedAt(START - 7 * DAY - 1));
    await cache.put('analytics.cohort.v2.tier2.0-1199', entryFetchedAt(START - 7 * DAY));
    // Not an analytics entry: kept, however old.
    await cache.put('heroes.english', entryFetchedAt(START - 90 * DAY));

    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

    const kept: string[] = [];
    for (const key of [
      'analytics.cohort.tier1.0-1199',
      'analytics.something.else',
      'analytics.cohort.tier2.0-1199',
      'analytics.cohort.tier3.0-1199',
      'analytics.cohort.v2.tier1.0-1199',
      'analytics.cohort.v2.tier2.0-1199',
      'heroes.english',
      TIER_4_KEY,
    ]) {
      if ((await cache.get(key)) !== null) {
        kept.push(key);
      }
    }
    expect(kept).toEqual([
      'analytics.cohort.tier2.0-1199',
      'analytics.cohort.tier3.0-1199',
      'analytics.cohort.v2.tier2.0-1199',
      'heroes.english',
      TIER_4_KEY,
    ]);
  });

  it('keeps the new data when the purge fails, and logs it', async () => {
    const { service, logger } = setUp({ cacheFails: (sql) => sql.startsWith('DELETE') });

    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

    expect(cachedData(await service.read(TIER_4)).sampleMatches).toBe(2_422);
    expect(communityLines(logger)).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Could not purge the old community data',
        context: expect.objectContaining({ kind: 'storage' }) as unknown,
      }),
    );
  });

  describe('when the community data cannot be fetched', () => {
    it('answers unavailable while deadlock-api is paused, and sends nothing', async () => {
      const { service, http, logger, syncState, cache } = setUp();
      await syncState.setPausedUntil(START + 5 * MINUTE);

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

      expect(http.requests).toHaveLength(0);
      await expect(cache.get(TIER_4_KEY)).resolves.toBeNull();
      // A pause is expected: a `debug` line, not a warning.
      expect(communityLines(logger)).toEqual([
        { level: 'debug', scope: SCOPE, message: UNAVAILABLE, context: { kind: 'paused' } },
      ]);
    });

    it('answers unavailable when deadlock-api asks for a pause, and stops there', async () => {
      const { service, http, logger } = setUp({
        handler: overriding(BENCHMARK_PATH, () => jsonResponse({}, 429, { 'retry-after': '120' })),
      });

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');
      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

      // The size, then the benchmark that asked for the pause; the pause stops the other requests.
      expect(requestedPaths(http)).toEqual([HERO_STATS_PATH, BENCHMARK_PATH]);
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
          maxDurationS: 1_199,
          badge: null,
        });
      }

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

      // A request over the budget is not even sent.
      expect(http.requests).toHaveLength(ANALYTICS_RATE_LIMIT.limit);
      await expect(cache.get(TIER_4_KEY)).resolves.toBeNull();
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
        failure: 'deadlock-api fails at the benchmark',
        handler: overriding(BENCHMARK_PATH, () => jsonResponse({}, 500)),
        context: { kind: 'service_unavailable', endpoint: BENCHMARK_PATH },
      },
      {
        failure: 'the curve is not a list',
        handler: overriding(CURVE_PATH, () => jsonResponse({ secret: 'value' })),
        context: { kind: 'invalid_payload' },
      },
    ])('answers unavailable and stores nothing when $failure', async ({ handler, context }) => {
      const { service, cache, logger } = setUp({ handler });

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

      await expect(cache.get(TIER_4_KEY)).resolves.toBeNull();
      expect(communityLines(logger)).toEqual([
        { level: 'warn', scope: SCOPE, message: UNAVAILABLE, context },
      ]);
    });

    it('keeps serving the stale entry', async () => {
      const { service, clock, answer, logger } = setUp();
      await service.refresh(ACCOUNT_ID, TIER_4);
      const data = cachedData(await service.read(TIER_4));
      clock.now = START + 3 * DAY;
      answer.handler = failingAt(HERO_STATS_PATH);

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

      await expect(service.read(TIER_4)).resolves.toEqual({ kind: 'cached', stale: true, data });
      expect(communityLines(logger).map((entry) => entry.message)).toContain(UNAVAILABLE);
    });

    it.each([
      { step: 'reading the cache', cacheFails: (sql: string) => sql.startsWith('SELECT') },
      { step: 'writing the entry', cacheFails: (sql: string) => sql.startsWith('INSERT') },
    ])('never rejects when $step fails', async ({ cacheFails }) => {
      const { service, logger } = setUp({ cacheFails });

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

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

      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('unavailable');

      await expect(cache.get(TIER_4_KEY)).resolves.toBeNull();
      expect(communityLines(logger)).toEqual([
        { level: 'warn', scope: SCOPE, message: UNAVAILABLE, context: { kind: 'storage' } },
      ]);
    });
  });

  describe('when refreshes overlap', () => {
    it('shares one run between calls for a stale cohort, and starts anew once it is over', async () => {
      const { service, http, clock } = setUp();
      await service.refresh(ACCOUNT_ID, TIER_4);
      clock.now = START + DAY;
      expect(http.requests).toHaveLength(3);

      const first = service.refresh(ACCOUNT_ID, TIER_4);
      const second = service.refresh(ACCOUNT_ID, TIER_4);

      // The very same promise, not two runs that happen to agree.
      expect(second).toBe(first);
      await expect(Promise.all([first, second])).resolves.toEqual(['updated', 'updated']);
      expect(http.requests).toHaveLength(6);
      // The run is over: the next call is a call of its own, and it finds the cache fresh.
      const third = service.refresh(ACCOUNT_ID, TIER_4);
      expect(third).not.toBe(first);
      await expect(third).resolves.toBe('fresh');
      expect(http.requests).toHaveLength(6);
    });

    it('runs the cohorts apart', async () => {
      const { service, http } = setUp();

      await expect(
        Promise.all([service.refresh(ACCOUNT_ID, TIER_4), service.refresh(ACCOUNT_ID, ALL_RANKS)]),
      ).resolves.toEqual(['updated', 'updated']);

      expect(http.requests).toHaveLength(6);
    });

    it('shares the run whichever account asks, and checks the account once, inside it', async () => {
      const { service, http, cache, link } = setUp();
      // The account is no longer the one that started the run when the download ends.
      link.accountId = OTHER_ACCOUNT_ID;

      const results = await Promise.all([
        service.refresh(ACCOUNT_ID, TIER_4),
        service.refresh(OTHER_ACCOUNT_ID, TIER_4),
      ]);

      // The run is the first caller's: its account is not the linked one, so nothing is stored for
      // either caller, and one set of requests was sent.
      expect(results).toEqual(['unavailable', 'unavailable']);
      expect(http.requests).toHaveLength(3);
      await expect(cache.get(TIER_4_KEY)).resolves.toBeNull();
    });

    it('shares a failure too, and tries again at the next call', async () => {
      const { service, http, answer, logger } = setUp({ handler: failingAt(HERO_STATS_PATH) });

      await expect(
        Promise.all([service.refresh(ACCOUNT_ID, TIER_4), service.refresh(ACCOUNT_ID, TIER_4)]),
      ).resolves.toEqual(['unavailable', 'unavailable']);
      // One run, one request, one line: the second caller did not fail on its own.
      expect(http.requests).toHaveLength(1);
      expect(communityLines(logger)).toHaveLength(1);

      // A failed run does not stay in the way.
      answer.handler = createFixtureApi({ now: START, matchCount: 1 });
      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');
    });
  });
});

describe('BenchmarkService.read', () => {
  it('says missing when nothing is cached', async () => {
    const { service, http } = setUp();

    await expect(service.read(TIER_4)).resolves.toEqual({ kind: 'missing' });

    // Reading never fetches.
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    { label: 'a day old, to the millisecond', now: START + DAY, stale: true },
    { label: 'less than a day old', now: START + DAY - 1, stale: false },
    { label: 'dated in the future', now: START - 1, stale: true },
    { label: 'fetched right now', now: START, stale: false },
  ])('tells whether an entry is stale: $label', async ({ now, stale }) => {
    const { service, clock } = setUp();
    await service.refresh(ACCOUNT_ID, TIER_4);
    clock.now = now;

    const read = await service.read(TIER_4);

    expect(read).toMatchObject({ kind: 'cached', stale });
  });

  it('refreshes an entry dated in the future', async () => {
    const { service, http, clock } = setUp();
    await service.refresh(ACCOUNT_ID, TIER_4);
    // The system clock moved backwards: the entry would otherwise stay fresh until it catches up.
    clock.now = START - HOUR;

    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

    expect(http.requests).toHaveLength(6);
  });

  it('never reads a cohort cached in the format without deaths', async () => {
    const { service, cache, http, logger } = setUp();
    const earlier = {
      payloadJson: earlierFormatJson(),
      fetchedAt: START,
      expiresAt: START + DAY,
    };
    await cache.put(TIER_4_EARLIER_KEY, earlier);

    await expect(service.read(TIER_4)).resolves.toEqual({ kind: 'missing' });

    // The entry is under another key: it is not looked at, so it is not reported as unreadable.
    expect(logger.entries).toEqual([]);
    // It does not count as fresh data either: the cohort is downloaded, and the entry is left alone.
    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');
    expect(http.requests).toHaveLength(3);
    await expect(cache.get(TIER_4_EARLIER_KEY)).resolves.toEqual(earlier);
  });

  it('rejects with a storage error when the cache cannot be read', async () => {
    const { service } = setUp({ cacheFails: (sql) => sql.startsWith('SELECT') });

    await expect(service.read(TIER_4)).rejects.toMatchObject({ kind: 'storage' });
  });

  describe('an entry that cannot be read', () => {
    /** Ways to make the stored JSON of a cohort say something else, the way a damaged file would. */
    const damages: readonly { label: string; damage: (stored: string) => string }[] = [
      { label: 'text that is not JSON', damage: () => '{"wanted": "a secret value' },
      {
        label: 'JSON of another shape',
        damage: () => JSON.stringify({ wanted: 'a secret value' }),
      },
      {
        label: 'a table of percentiles that is not complete',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { benchmark: [string, number[]][] };
          payload.benchmark[0]?.[1].pop();
          return JSON.stringify(payload);
        },
      },
      {
        label: 'a point of the curve without the average deaths',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { curve: { avg: object }[] };
          Reflect.deleteProperty(payload.curve[0]?.avg ?? {}, 'deaths');
          return JSON.stringify(payload);
        },
      },
      {
        label: 'a point of the curve without the deviation of the deaths',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { curve: { std: object }[] };
          Reflect.deleteProperty(payload.curve[0]?.std ?? {}, 'deaths');
          return JSON.stringify(payload);
        },
      },
      {
        label: 'a metric that the app does not know',
        damage: (stored: string): string => {
          const payload = JSON.parse(stored) as { benchmark: [string, number[]][] };
          payload.benchmark.push(['a_secret_metric', [1, 2, 3, 4, 5, 6, 7, 8, 9]]);
          return JSON.stringify(payload);
        },
      },
    ];

    it.each(damages)('is missing, and logged once with no value: $label', async ({ damage }) => {
      const { service, cache, logger } = setUp();
      await service.refresh(ACCOUNT_ID, TIER_4);
      const stored = await cache.get(TIER_4_KEY);
      await cache.put(TIER_4_KEY, {
        payloadJson: damage(stored?.payloadJson ?? ''),
        fetchedAt: START,
        expiresAt: START + DAY,
      });
      const linesBefore = communityLines(logger).length;

      await expect(service.read(TIER_4)).resolves.toEqual({ kind: 'missing' });
      await expect(service.read(TIER_4)).resolves.toEqual({ kind: 'missing' });

      const lines = communityLines(logger).slice(linesBefore);
      expect(lines).toEqual([
        {
          level: 'warn',
          scope: SCOPE,
          message: UNREADABLE,
          context: expect.any(Object) as unknown,
        },
      ]);
      expect(JSON.stringify(logger.entries)).not.toContain('secret');
    });

    it.each(damages)('is replaced by a refresh: $label', async ({ damage }) => {
      const { service, cache, http } = setUp();
      await service.refresh(ACCOUNT_ID, TIER_4);
      const stored = await cache.get(TIER_4_KEY);
      await cache.put(TIER_4_KEY, {
        payloadJson: damage(stored?.payloadJson ?? ''),
        fetchedAt: START,
        expiresAt: START + DAY,
      });

      // The entry is not fresh: it does not count as one.
      await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

      expect(http.requests).toHaveLength(6);
      expect(cachedData(await service.read(TIER_4)).sampleMatches).toBe(2_422);
    });
  });
});

describe('the diagnostic of a download', () => {
  it('counts what was downloaded, and nothing else', async () => {
    const { service, logger } = setUp();

    await service.refresh(ACCOUNT_ID, TIER_4);

    // Counts and a flag: never the tier, the window or a value.
    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { benchmarkKeys: 11, curvePoints: 7, sampleMatches: 2_422, fallback: false },
      },
    ]);
  });

  it('tells when the cohort is the all-ranks fallback', async () => {
    const { service, logger } = setUp({ handler: withSampleSizes({ tier: 12, all: 5_000 }) });

    await service.refresh(ACCOUNT_ID, TIER_4);

    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { benchmarkKeys: 11, curvePoints: 7, sampleMatches: 5_000, fallback: true },
      },
    ]);
  });

  it('counts nothing for a cohort that is too small, without calling it incomplete', async () => {
    const { service, logger } = setUp({ handler: withSampleSizes({ tier: 12, all: 199 }) });

    await service.refresh(ACCOUNT_ID, TIER_4);

    expect(communityLines(logger)).toEqual([
      {
        level: 'info',
        scope: SCOPE,
        message: DOWNLOADED,
        context: { benchmarkKeys: 0, curvePoints: 0, sampleMatches: 199, fallback: false },
      },
    ]);
  });

  it.each([
    {
      answer: 'a benchmark without any metric',
      handler: overriding(BENCHMARK_PATH, () => jsonResponse({})),
      counts: { benchmarkKeys: 0, curvePoints: 7 },
    },
    {
      answer: 'a curve without any point',
      handler: overriding(CURVE_PATH, () => jsonResponse([])),
      counts: { benchmarkKeys: 11, curvePoints: 0 },
    },
  ])('warns about $answer', async ({ handler, counts }) => {
    const { service, logger } = setUp({ handler });

    await expect(service.refresh(ACCOUNT_ID, TIER_4)).resolves.toBe('updated');

    expect(communityLines(logger).map((entry) => entry.message)).toEqual([DOWNLOADED, INCOMPLETE]);
    expect(communityLines(logger)[1]).toEqual({
      level: 'warn',
      scope: SCOPE,
      message: INCOMPLETE,
      context: counts,
    });
  });
});

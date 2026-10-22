/**
 * Tests of the synthetic community data: each body must pass the same validation as a real answer
 * of deadlock-api, and hold what the dev mode and the tests of the services rely on.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { CurveStat } from '../../../core/analysis/metric';
import { RESISTANCE_ITEMS } from '../../../core/analysis/review/resistance-items';
import { PERCENTILE_POINTS } from '../../../core/analysis/statistics';
import {
  DEADLOCK_API_BASE_URL,
  heroSampleRequest,
  itemStatsRequest,
  metricBenchmarkRequest,
  MAX_RESPONSE_BYTES,
  performanceCurveRequest,
  playerRankRequest,
  REQUEST_TIMEOUT_MS,
  type CohortQuery,
} from '../../../core/deadlock-api/endpoints';
import { parseHeroSample } from '../../../core/deadlock-api/hero-sample.schema';
import { parseItemStats, type ItemStatsRow } from '../../../core/deadlock-api/item-stats.schema';
import { parseMetricBenchmark } from '../../../core/deadlock-api/metric-benchmark.schema';
import { parsePerformanceCurve } from '../../../core/deadlock-api/performance-curve.schema';
import { parsePlayerRank } from '../../../core/deadlock-api/player-rank.schema';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import type { HttpRequest } from '../../../ports/http-client.port';
import { testAccountId } from '../../../test/test-data';
import { createFixtureApi, FixtureHttpClient } from '../fixture-http-client.adapter';
import {
  createHeroSamplesFixture,
  createItemStatsFixture,
  createMetricBenchmarkFixture,
  createPerformanceCurveFixture,
  createPlayerRankFixture,
  createUnrankedPlayerRankFixture,
} from './analytics.fixture';
import {
  FIXTURE_ITEM_CATALOGUE,
  FIXTURE_RESISTANCE_ITEM_IDS,
  FIXTURE_SHOP_ITEM_IDS,
} from './assets.fixture';
import { FIXTURE_ACCOUNT_ID } from './match-history.fixture';

/** The five counters of the curve the app reads. */
const CURVE_STATS: readonly CurveStat[] = [
  'net_worth',
  'player_damage',
  'boss_damage',
  'kills',
  'deaths',
];

/** The minutes around which the purchases of an item of each tier peak: the first and the last. */
const PEAK_MINUTES: Readonly<Record<number, readonly [number, number]>> = {
  2: [12, 15],
  3: [25, 30],
  4: [33, 38],
};

/**
 * The tier of a shop item of the fixture catalogue.
 *
 * @param itemId - The id of the item.
 * @returns Its tier, or `undefined` when the catalogue has no shop item under that id.
 */
function tierOf(itemId: number): number | undefined {
  const entry = FIXTURE_ITEM_CATALOGUE.find((item) => item.id === itemId);
  return entry?.type === 'upgrade' ? entry.item_tier : undefined;
}

/**
 * The minute in which an item was bought most.
 *
 * @param rows - The rows of the item statistics, as the parser reads them.
 * @param itemId - The item.
 * @returns The minute holding the most purchases of the item, or `undefined` when it has no row.
 */
function peakMinuteOf(rows: readonly ItemStatsRow[], itemId: number): number | undefined {
  const own = rows.filter((row) => row.itemId === itemId);
  return own.toSorted((first, second) => second.purchases - first.purchases)[0]?.minute;
}

/**
 * The times of the points of a curve.
 *
 * @param maxDurationS - The longest match of the window.
 * @returns The `game_time` of each point, as the parser reads it.
 */
function curveTimes(maxDurationS: number): number[] {
  return parsePerformanceCurve(createPerformanceCurveFixture(maxDurationS)).map(
    (point) => point.timeS,
  );
}

describe('createMetricBenchmarkFixture', () => {
  const body = createMetricBenchmarkFixture();
  const benchmark = parseMetricBenchmark(body);

  it('holds the 11 metrics the app reads, in full', () => {
    expect([...benchmark.keys()].toSorted()).toEqual(
      [
        'accuracy',
        'boss_damage_per_min',
        'deaths',
        'denies',
        'kda',
        'last_hits',
        'net_worth_per_min',
        'player_damage_per_min',
        'player_damage_taken_per_min',
        'teammate_barriering',
        'teammate_healing',
      ].toSorted(),
    );
  });

  it('gives the nine percentiles of each metric in increasing order', () => {
    for (const [key, table] of benchmark) {
      expect(table, key).toHaveLength(PERCENTILE_POINTS.length);
      // A count metric ties at 0 in the lower tail, like the real answer: increasing, not strictly.
      expect(table, key).toEqual(table.toSorted((first, second) => first - second));
      expect(table[8], key).toBeGreaterThan(table[0] ?? Infinity);
    }
  });

  it('holds metrics the app does not read, like the real answer', () => {
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['kills', 'assists']));
  });

  it('is the same every time', () => {
    expect(JSON.stringify(createMetricBenchmarkFixture())).toBe(JSON.stringify(body));
  });
});

describe('createPerformanceCurveFixture', () => {
  it('has a point at 180, 360, 540, 720 and 900 s, then every 300 s, up to the longest match', () => {
    expect(curveTimes(1799)).toEqual([180, 360, 540, 720, 900, 1200, 1500]);
    expect(curveTimes(1800)).toEqual([180, 360, 540, 720, 900, 1200, 1500, 1800]);
    expect(curveTimes(1199)).toEqual([180, 360, 540, 720, 900]);
    expect(curveTimes(7000).at(-1)).toBe(6900);
  });

  it('has no point for a window shorter than the first one', () => {
    expect(createPerformanceCurveFixture(179)).toEqual([]);
  });

  it('is cumulative: the average and the deviation of each counter never decrease', () => {
    const points = parsePerformanceCurve(createPerformanceCurveFixture(7000));

    expect(points.length).toBeGreaterThan(10);
    for (const stat of CURVE_STATS) {
      for (const field of ['avg', 'std'] as const) {
        const values = points.map((point) => point[field][stat]);
        expect(values, `${stat} ${field}`).toEqual(
          values.toSorted((first, second) => first - second),
        );
      }
      // The average strictly grows: a player always has more souls, damage and kills later on.
      const averages = points.map((point) => point.avg[stat]);
      expect(new Set(averages).size, stat).toBe(averages.length);
    }
  });

  it('gives plausible values: souls and damage in the thousands at 25 minutes', () => {
    const point = parsePerformanceCurve(createPerformanceCurveFixture(1799)).at(-1);

    expect(point?.timeS).toBe(1500);
    expect(point?.avg.net_worth).toBeGreaterThan(15_000);
    expect(point?.avg.net_worth).toBeLessThan(40_000);
    expect(point?.avg.kills).toBeGreaterThan(1);
    expect(point?.std.net_worth).toBeGreaterThan(0);
  });

  it('is the same every time', () => {
    expect(JSON.stringify(createPerformanceCurveFixture(1799))).toBe(
      JSON.stringify(createPerformanceCurveFixture(1799)),
    );
  });
});

describe('createHeroSamplesFixture', () => {
  const body = createHeroSamplesFixture();

  it('counts 2422 matches for Paige', () => {
    expect(parseHeroSample(body, PAIGE_HERO_ID)).toBe(2422);
  });

  it('counts the matches of a couple of other heroes and none for an absent one', () => {
    expect(parseHeroSample(body, 1)).toBeGreaterThan(0);
    expect(parseHeroSample(body, 2)).toBeGreaterThan(0);
    expect(parseHeroSample(body, 999)).toBe(0);
  });

  it('has one row per hero', () => {
    const heroIds = body.map((row) => row.hero_id);

    expect(new Set(heroIds).size).toBe(heroIds.length);
  });
});

describe('createItemStatsFixture', () => {
  const body = createItemStatsFixture();
  const itemIds = [...new Set(body.map((row) => row.item_id))];

  it('holds the 12 resistance items and 4 other shop items, over the minutes 6 to 40', () => {
    const others = itemIds.filter((itemId) => !FIXTURE_RESISTANCE_ITEM_IDS.includes(itemId));

    expect(itemIds).toEqual(expect.arrayContaining([...FIXTURE_RESISTANCE_ITEM_IDS]));
    expect(others).toHaveLength(4);
    for (const itemId of others) {
      expect(FIXTURE_SHOP_ITEM_IDS).toContain(itemId);
    }
    const minutes = body.map((row) => row.bucket);
    expect(Math.min(...minutes)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...minutes)).toBeLessThanOrEqual(40);
    // One row per (item, minute) pair, like the answer to a request with a minute bucket.
    expect(new Set(body.map((row) => `${String(row.item_id)}:${String(row.bucket)}`)).size).toBe(
      body.length,
    );
  });

  it('has the fields of a real row, and counts that agree with each other', () => {
    expect(body.length).toBeGreaterThan(100);
    for (const row of body) {
      expect(Object.keys(row).toSorted()).toEqual(
        [
          'avg_buy_time_relative',
          'avg_buy_time_s',
          'avg_sell_time_relative',
          'avg_sell_time_s',
          'bucket',
          'item_id',
          'losses',
          'matches',
          'players',
          'sold',
          'wins',
        ].toSorted(),
      );
      // An (item, minute) pair has purchases, and each is won or lost; a buyer buys it at least once.
      expect(row.matches).toBeGreaterThanOrEqual(1);
      expect(row.wins + row.losses).toBe(row.matches);
      expect(row.players).toBeGreaterThanOrEqual(1);
      expect(row.players).toBeLessThanOrEqual(row.matches);
      // The mean buy time falls in the minute of the row.
      expect(row.avg_buy_time_s).toBeGreaterThanOrEqual(row.bucket * 60);
      expect(row.avg_buy_time_s).toBeLessThan((row.bucket + 1) * 60);
      // Only the sold purchases have a sell time, which comes after the purchase.
      expect(row.sold).toBeLessThanOrEqual(row.matches);
      if (row.sold === 0) {
        expect(row.avg_sell_time_s).toBe(0);
      } else {
        expect(row.avg_sell_time_s).toBeGreaterThan(row.avg_buy_time_s);
      }
    }
  });

  it('peaks around minute 12 to 15 for a tier 2 item, 25 to 30 for tier 3 and 33 to 38 for tier 4', () => {
    const rows = parseItemStats(body);

    for (const itemId of itemIds) {
      const tier = tierOf(itemId);
      const [first, last] = PEAK_MINUTES[tier ?? 0] ?? expect.unreachable(`tier ${String(tier)}`);
      const peak = peakMinuteOf(rows, itemId);

      expect(peak, String(itemId)).toBeGreaterThanOrEqual(first);
      expect(peak, String(itemId)).toBeLessThanOrEqual(last);
    }
  });

  it('leaves out the minutes an item is not bought in: a run of minutes, not the whole range', () => {
    const rows = parseItemStats(body);

    for (const itemId of itemIds) {
      const minutes = rows.filter((row) => row.itemId === itemId).map((row) => row.minute);
      const first = Math.min(...minutes);
      const last = Math.max(...minutes);
      const tier = tierOf(itemId);

      // Fewer rows than the 35 minutes of the range, and no gap inside the run.
      expect(minutes.length, String(itemId)).toBeLessThan(35);
      expect(last - first + 1, String(itemId)).toBe(minutes.length);
      // A late item is not bought early, and an early one is not bought late.
      if (tier === 4) {
        expect(first, String(itemId)).toBeGreaterThanOrEqual(20);
      }
      if (tier === 2) {
        expect(last, String(itemId)).toBeLessThanOrEqual(25);
      }
    }
  });

  it('is the same every time', () => {
    expect(JSON.stringify(createItemStatsFixture())).toBe(JSON.stringify(body));
  });
});

describe('createPlayerRankFixture', () => {
  it('is Sentinel 4 (badge 44), with no ranked match to report', () => {
    expect(createPlayerRankFixture()).toEqual({ badge: 44, rank: 4, subrank: 4, last_match: null });
    expect(parsePlayerRank(createPlayerRankFixture())).toBe(44);
  });

  it('is unranked for a player the API knows no rank of', () => {
    expect(createUnrankedPlayerRankFixture()).toEqual({
      badge: 0,
      rank: 0,
      subrank: 0,
      last_match: null,
    });
    expect(parsePlayerRank(createUnrankedPlayerRankFixture())).toBe(0);
  });
});

describe('createFixtureApi community routes', () => {
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

  const query: CohortQuery = {
    heroId: PAIGE_HERO_ID,
    sinceUnixS: 1_789_344_000,
    minDurationS: 1500,
    maxDurationS: 1799,
    badge: { min: 41, max: 46 },
  };

  /**
   * Build a GET request with the default limits of the app.
   *
   * @param url - URL to request.
   * @returns The request.
   */
  function get(url: string): HttpRequest {
    return { url, headers: {}, timeoutMs: REQUEST_TIMEOUT_MS, maxBodyBytes: MAX_RESPONSE_BYTES };
  }

  /**
   * Request a URL and read the JSON of the answer.
   *
   * @param url - URL to request.
   * @returns The status and the parsed body.
   */
  async function fetchJson(url: string): Promise<{ status: number; json: unknown }> {
    const response = await client.get(get(url));
    return { status: response.status, json: JSON.parse(response.body) as unknown };
  }

  it('serves the benchmark, the curve, the hero statistics and the rank of the requests of the app', async () => {
    const benchmark = await fetchJson(metricBenchmarkRequest(query).url);
    const curve = await fetchJson(performanceCurveRequest(query).url);
    const heroes = await fetchJson(heroSampleRequest(query).url);
    const rank = await fetchJson(playerRankRequest(FIXTURE_ACCOUNT_ID).url);

    expect([benchmark.status, curve.status, heroes.status, rank.status]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(parseMetricBenchmark(benchmark.json).size).toBe(11);
    expect(parsePerformanceCurve(curve.json).at(-1)?.timeS).toBe(1500);
    expect(parseHeroSample(heroes.json, PAIGE_HERO_ID)).toBe(2422);
    expect(parsePlayerRank(rank.json)).toBe(44);
  });

  it('serves the item stats of the resistance items by minute', async () => {
    const stats = await fetchJson(itemStatsRequest(query).url);
    const rows = parseItemStats(stats.json);

    expect(stats.status).toBe(200);
    // The answer reads like the real one, and does not depend on the community asked for.
    const otherCommunity = await fetchJson(
      itemStatsRequest({ ...query, heroId: 1, badge: null, sinceUnixS: 0 }).url,
    );
    expect(otherCommunity.json).toEqual(stats.json);
    for (const [index, resistance] of RESISTANCE_ITEMS.entries()) {
      const itemId = FIXTURE_RESISTANCE_ITEM_IDS[index] ?? expect.unreachable('twelve ids');
      const [first, last] = PEAK_MINUTES[resistance.tier] ?? expect.unreachable('tier 2 to 4');
      const peak = peakMinuteOf(rows, itemId);

      // Every resistance item has purchases over many minutes, peaking where its tier is bought.
      expect(
        rows.filter((row) => row.itemId === itemId).length,
        resistance.className,
      ).toBeGreaterThan(10);
      expect(peak, resistance.className).toBeGreaterThanOrEqual(first);
      expect(peak, resistance.className).toBeLessThanOrEqual(last);
    }
  });

  it('gives the curve the length of the duration window asked for, and ignores the rest', async () => {
    const times = async (url: string): Promise<number[]> =>
      parsePerformanceCurve((await fetchJson(url)).json).map((point) => point.timeS);
    const base = `${DEADLOCK_API_BASE_URL}/v1/analytics/player-performance-curve`;

    await expect(times(`${base}?max_duration_s=1199&min_duration_s=0`)).resolves.toEqual([
      180, 360, 540, 720, 900,
    ]);
    // The same window under another hero, period and badge range: the same curve.
    await expect(
      times(performanceCurveRequest({ ...query, heroId: 1, badge: null, sinceUnixS: 0 }).url),
    ).resolves.toEqual(await times(performanceCurveRequest(query).url));
    // Without a window, the curve runs as far as the longest match of the API.
    expect((await times(base)).at(-1)).toBe(6900);
    expect((await times(`${base}?hero_ids=67`)).at(-1)).toBe(6900);
  });

  it('serves the rank of the tracked account, and no rank for any other player', async () => {
    const otherAccount = testAccountId(2_000_001);
    const otherTracked = new FixtureHttpClient(
      createFixtureApi({ now: NOW, accountId: otherAccount }),
    );
    const rankOf = async (accountClient: FixtureHttpClient, url: string): Promise<number> =>
      parsePlayerRank(JSON.parse((await accountClient.get(get(url))).body));

    await expect(rankOf(client, playerRankRequest(FIXTURE_ACCOUNT_ID).url)).resolves.toBe(44);
    await expect(rankOf(client, playerRankRequest(otherAccount).url)).resolves.toBe(0);
    await expect(rankOf(otherTracked, playerRankRequest(otherAccount).url)).resolves.toBe(44);
  });

  it('answers a GET only, and 404 for any other path', async () => {
    const post = await client.postForm({
      ...get(metricBenchmarkRequest(query).url),
      form: '',
    });

    expect(post.status).toBe(404);
    await expect(fetchJson(`${DEADLOCK_API_BASE_URL}/v1/analytics/unknown`)).resolves.toMatchObject(
      { status: 404 },
    );
    await expect(
      fetchJson(`${DEADLOCK_API_BASE_URL}/v1/players/${String(FIXTURE_ACCOUNT_ID)}/rank/history`),
    ).resolves.toMatchObject({ status: 404 });
  });
});

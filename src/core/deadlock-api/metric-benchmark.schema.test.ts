/**
 * Tests of the reading of deadlock-api's community benchmark
 * (`GET /v1/analytics/player-stats/metrics`).
 *
 * Every payload here is synthetic: it has the shape of a real answer (a statistics object per metric,
 * with metrics the app does not read) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { BenchmarkKey } from '../analysis/metric';
import { PERCENTILE_POINTS } from '../analysis/statistics';
import { parseMetricBenchmark } from './metric-benchmark.schema';

/**
 * The median of each benchmark of the tests (made up). Typed as a record so that the compiler
 * checks it holds every {@link BenchmarkKey}: it is the list the parser's own list is compared with.
 */
const MEDIANS: Readonly<Record<BenchmarkKey, number>> = {
  kda: 4,
  player_damage_per_min: 600,
  accuracy: 0.5,
  deaths: 4,
  player_damage_taken_per_min: 500,
  net_worth_per_min: 1000,
  last_hits: 130,
  denies: 2,
  teammate_healing: 2000,
  teammate_barriering: 5000,
  boss_damage_per_min: 200,
};

/** The 11 benchmark keys the parser must read, in the order of {@link MEDIANS}. */
const BENCHMARK_KEYS = Object.keys(MEDIANS) as BenchmarkKey[];

/**
 * The value of a made-up benchmark at one percentile point: increasing with the point, and equal to
 * the median at the 50th.
 *
 * @param median - The median of the benchmark.
 * @param point - The percentile point (1 to 99).
 * @returns The value at that point.
 */
function valueAt(median: number, point: number): number {
  return (median * point) / 50;
}

/**
 * The statistics of one metric in the exact shape of the API: the average, the standard deviation
 * and the nine percentiles the app reads.
 *
 * @param median - The median of the benchmark.
 * @param overrides - Fields to change (or to add).
 * @returns The raw statistics.
 */
function rawStatistics(median: number, overrides: Record<string, unknown> = {}) {
  const percentiles = Object.fromEntries(
    PERCENTILE_POINTS.map((point) => [`percentile${String(point)}`, valueAt(median, point)]),
  );
  return { avg: median, std: median / 4, ...percentiles, ...overrides };
}

/**
 * The body of the answer: the 11 benchmarks, and metrics the app does not read.
 *
 * @param overrides - Metrics to change, add or (with `undefined`) remove.
 * @returns The raw body.
 */
function rawBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kills: rawStatistics(3),
    assists: rawStatistics(12),
    crit_shot_rate: rawStatistics(0),
    ...Object.fromEntries(BENCHMARK_KEYS.map((key) => [key, rawStatistics(MEDIANS[key])])),
    ...overrides,
  };
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      Reflect.deleteProperty(body, key);
    }
  }
  return body;
}

/**
 * The table the parser must read for a made-up benchmark.
 *
 * @param median - The median of the benchmark.
 * @returns The value at each percentile point, in order.
 */
function expectedTable(median: number): number[] {
  return PERCENTILE_POINTS.map((point) => valueAt(median, point));
}

describe('parseMetricBenchmark', () => {
  it('parses the 11 tables', () => {
    const benchmark = parseMetricBenchmark(rawBody());

    expect([...benchmark.keys()].toSorted()).toEqual(BENCHMARK_KEYS.toSorted());
    for (const key of BENCHMARK_KEYS) {
      expect(benchmark.get(key)).toEqual(expectedTable(MEDIANS[key]));
    }
  });

  it('reads the nine percentiles in the order of the percentile points', () => {
    const body = rawBody({
      kda: {
        percentile99: 99,
        percentile95: 95,
        percentile90: 90,
        percentile75: 75,
        percentile50: 50,
        percentile25: 25,
        percentile10: 10,
        percentile5: 5,
        percentile1: 1,
      },
    });

    expect(parseMetricBenchmark(body).get('kda')).toEqual([...PERCENTILE_POINTS]);
  });

  it('keeps the values as the API gives them, the counts included', () => {
    // The percentiles are quantiles of a sketch with a 1 % error: a count comes back as 1.010.
    const deaths = [0, 0, 1.01, 1.994, 4.015, 5.99, 7.925, 8.935, 10.9];
    const body = rawBody({
      deaths: {
        avg: 4,
        std: 2.7,
        ...Object.fromEntries(
          PERCENTILE_POINTS.map((point, index) => [`percentile${String(point)}`, deaths[index]]),
        ),
      },
    });

    expect(parseMetricBenchmark(body).get('deaths')).toEqual(deaths);
  });

  it('ignores the metrics the app does not read, and the other fields of a metric', () => {
    const benchmark = parseMetricBenchmark(
      rawBody({ brand_new_metric: { anything: true }, kda: rawStatistics(4, { skew: 1 }) }),
    );

    expect(benchmark.size).toBe(BENCHMARK_KEYS.length);
    expect(benchmark.get('kda')).toEqual(expectedTable(4));
  });

  it('keeps the metrics it can read', () => {
    const body = rawBody({
      // Absent.
      kda: undefined,
      // A percentile that is a string, then one that is null, then one that is missing.
      deaths: rawStatistics(4, { percentile50: '4.015' }),
      accuracy: rawStatistics(0.5, { percentile99: null }),
      denies: rawStatistics(2, { percentile5: undefined }),
      // Numbers JSON can carry (1e999) or not (NaN), neither of which is a measure.
      boss_damage_per_min: rawStatistics(200, { percentile75: Infinity }),
      teammate_barriering: rawStatistics(5000, { percentile1: NaN }),
      // Not even statistics.
      last_hits: null,
      teammate_healing: [1, 2, 3],
      net_worth_per_min: 'text',
    });

    const benchmark = parseMetricBenchmark(body);

    expect([...benchmark.keys()].toSorted()).toEqual(
      ['player_damage_per_min', 'player_damage_taken_per_min'].toSorted(),
    );
    expect(benchmark.get('player_damage_per_min')).toEqual(expectedTable(600));
    expect(benchmark.get('player_damage_taken_per_min')).toEqual(expectedTable(500));
  });

  it('gives no table at all for an empty answer', () => {
    expect(parseMetricBenchmark({}).size).toBe(0);
  });

  it('refuses a body that is not an object, without quoting it', () => {
    // The planted text, like any value of the body, must stay out of the error.
    const planted = 'Planted 987654321';
    const bodies: unknown[] = [null, undefined, planted, 987654321, true, [], [rawBody()]];
    for (const body of bodies) {
      expect(() => parseMetricBenchmark(body)).toThrow(
        expect.objectContaining({
          kind: 'invalid_payload',
          message: 'The community benchmark is invalid',
          context: { issue: '(root): invalid_type' },
        }),
      );
    }
  });
});

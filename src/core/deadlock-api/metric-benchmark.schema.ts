/**
 * Validation of deadlock-api's community benchmark (`GET /v1/analytics/player-stats/metrics`).
 *
 * The answer is a JSON object keyed by metric name (about thirty metrics). Each entry gives the
 * average, the standard deviation and nine percentiles of the metric over the players of the
 * requested cohort. The app compares a match with the percentiles of the eleven metrics it analyses
 * and reads nothing else: the average and the deviation are none of its business, and the answer
 * does not say how many players the cohort holds (that comes from the hero statistics).
 *
 * The percentiles are quantiles of a sketch with a 1 % relative error, so a count metric does not
 * come back as a whole number (a median of 4 deaths reads 4.015, a first quartile of 2 reads 1.994).
 * They are kept as they are: whether to round them depends on the metric, which is the analysis' call.
 *
 * This module is lenient on purpose. A metric that is absent, or whose nine percentiles are not all
 * finite numbers, is left out: the metric is then simply compared with the player's habits alone,
 * and the other ten keep their community reference. A table is never partial. Only a body that is
 * not even an object is an error.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { BenchmarkKey } from '../analysis/metric';
import { PERCENTILE_POINTS, type PercentileTable } from '../analysis/statistics';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';

/**
 * The community reference of each metric the analysis compares: the nine percentiles of its
 * benchmark, in the order of the percentile points. A metric the answer cannot give is missing.
 */
export type MetricBenchmark = ReadonlyMap<BenchmarkKey, PercentileTable>;

/** The metrics the app reads out of the answer: the names of the 11 benchmarks it compares. */
const BENCHMARK_KEYS = [
  'kda',
  'player_damage_per_min',
  'accuracy',
  'deaths',
  'player_damage_taken_per_min',
  'net_worth_per_min',
  'last_hits',
  'denies',
  'teammate_healing',
  'teammate_barriering',
  'boss_damage_per_min',
] as const satisfies readonly BenchmarkKey[];

/**
 * The body of the answer, or the statistics of one metric: an object with any field. Every value is
 * validated on its own, so that one odd metric cannot make the others unreadable.
 */
const objectSchema = z.record(z.string(), z.unknown());

/** One percentile: a finite number (Zod refuses `NaN` and the infinite values). */
const percentileSchema = z.number();

/**
 * Read the percentiles of one metric out of its statistics.
 *
 * @param statistics - The statistics of the metric, as the answer holds them.
 * @returns The nine percentiles, in the order of the percentile points, or `null` when the
 *   statistics are not an object or when any of the nine percentiles is missing or not a finite number.
 */
function readPercentiles(statistics: unknown): PercentileTable | null {
  const fields = objectSchema.safeParse(statistics);
  if (!fields.success) {
    return null;
  }
  const table: number[] = [];
  for (const point of PERCENTILE_POINTS) {
    // The API names the fields after the points (`percentile1`, `percentile5`…).
    const value = percentileSchema.safeParse(fields.data[`percentile${String(point)}`]);
    if (!value.success) {
      return null;
    }
    table.push(value.data);
  }
  return table;
}

/**
 * Read the community benchmark of a cohort out of deadlock-api's answer.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The percentiles of each of the 11 metrics the answer holds in full; the metrics it lacks
 *   or holds in part are missing from the map. The other metrics of the answer are ignored.
 * @throws AppError of kind `invalid_payload` when the body is not an object (the context `issue` is
 *   `<path>: <code>` of the first problem, never a value of the payload).
 */
export function parseMetricBenchmark(body: unknown): MetricBenchmark {
  const metrics = objectSchema.safeParse(body);
  if (!metrics.success) {
    throw new AppError('invalid_payload', 'The community benchmark is invalid', {
      context: { issue: describeFirstIssue(metrics.error) },
    });
  }
  const benchmark = new Map<BenchmarkKey, PercentileTable>();
  for (const key of BENCHMARK_KEYS) {
    const table = readPercentiles(metrics.data[key]);
    if (table !== null) {
      benchmark.set(key, table);
    }
  }
  return benchmark;
}

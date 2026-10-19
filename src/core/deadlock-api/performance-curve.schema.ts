/**
 * Validation of deadlock-api's performance curve (`GET /v1/analytics/player-performance-curve`).
 *
 * The answer is a JSON array with one point per time of the match. Each point gives, for about
 * thirty counters, the average and the standard deviation over the players of the cohort at that
 * time. The averages are cumulative since the start of the match (souls, kills, damage… so far), and
 * the points are 180, 360, 540, 720 and 900 seconds into the match, then every 300 seconds, as far
 * as the longest match of the cohort: a late point only averages the players whose match lasted
 * that long, and the answer does not say how many they are.
 *
 * The app reads the four counters its phase analysis compares (souls, damage to heroes, damage to
 * objectives, kills) and nothing else. This module is lenient on purpose: a point that lacks one of
 * them, or holds a value that is not a measure, is left out, and the others stay usable. Only a body
 * that is not even a list is an error.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { CurveStat } from '../analysis/metric';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';

/** One point of the community curve: what the cohort had, on average, at one time of the match. */
export interface CurvePoint {
  /** The time of the point, in seconds since the start of the match. */
  readonly timeS: number;
  /** The average of each counter, cumulated since the start of the match. */
  readonly avg: Readonly<Record<CurveStat, number>>;
  /** The standard deviation of each counter across the players of the cohort (0 or more). */
  readonly std: Readonly<Record<CurveStat, number>>;
}

/**
 * One point of the answer (only the fields the app uses). The object is loose: the many other
 * counters of the point are none of the app's business and are not read.
 *
 * `z.number()` only accepts finite numbers, and a deviation cannot be negative.
 */
const curvePointRowSchema = z.looseObject({
  game_time: z.int().nonnegative(),
  net_worth_avg: z.number(),
  net_worth_std: z.number().nonnegative(),
  player_damage_avg: z.number(),
  player_damage_std: z.number().nonnegative(),
  boss_damage_avg: z.number(),
  boss_damage_std: z.number().nonnegative(),
  kills_avg: z.number(),
  kills_std: z.number().nonnegative(),
});

/** One validated point of the answer. */
type CurvePointRow = z.infer<typeof curvePointRowSchema>;

/** The body of the answer: a list of anything, each point being validated on its own. */
const curveBodySchema = z.array(z.unknown());

/**
 * Map a validated point of the answer to the point the app keeps.
 *
 * @param row - A validated point.
 * @returns The point.
 */
function toCurvePoint(row: CurvePointRow): CurvePoint {
  return {
    timeS: row.game_time,
    avg: {
      net_worth: row.net_worth_avg,
      player_damage: row.player_damage_avg,
      boss_damage: row.boss_damage_avg,
      kills: row.kills_avg,
    },
    std: {
      net_worth: row.net_worth_std,
      player_damage: row.player_damage_std,
      boss_damage: row.boss_damage_std,
      kills: row.kills_std,
    },
  };
}

/**
 * Read the community curve of a cohort out of deadlock-api's answer.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The readable points, sorted by time. When two readable points share a time the first one
 *   of the answer is kept, so that a time never has two values. The curve is empty when the cohort
 *   has no readable point.
 * @throws AppError of kind `invalid_payload` when the body is not an array (the context `issue` is
 *   `<path>: <code>` of the first problem, never a value of the payload).
 */
export function parsePerformanceCurve(body: unknown): readonly CurvePoint[] {
  const elements = curveBodySchema.safeParse(body);
  if (!elements.success) {
    throw new AppError('invalid_payload', 'The performance curve is invalid', {
      context: { issue: describeFirstIssue(elements.error) },
    });
  }
  const pointsByTime = new Map<number, CurvePoint>();
  for (const element of elements.data) {
    const row = curvePointRowSchema.safeParse(element);
    // A point that does not fit the schema is skipped, never reported: one odd point must not hide
    // the others, and the same goes for a repeated time (the first reading stays).
    if (row.success && !pointsByTime.has(row.data.game_time)) {
      pointsByTime.set(row.data.game_time, toCurvePoint(row.data));
    }
  }
  return [...pointsByTime.values()].toSorted((first, second) => first.timeS - second.timeS);
}

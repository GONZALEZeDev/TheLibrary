/**
 * Validation of the sample size of a cohort in deadlock-api's hero statistics
 * (`GET /v1/analytics/hero-stats`).
 *
 * The community benchmark and the community curve do not say how many players their cohort holds,
 * and a cohort too small to mean anything must not be compared with. The hero statistics of the same
 * cohort do say: the answer is a JSON array with one row per hero (the endpoint has no hero filter),
 * each counting the matches the hero was played in over the same players as the benchmark. The app
 * reads the `matches` of the hero it analyses, and nothing else of the row.
 *
 * This module is lenient on purpose: a row it cannot read is skipped, and a hero without a readable
 * row has no match in the cohort. Only a body that is not even a list is an error.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { HeroId } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';

/**
 * One row of the answer (only the fields the app uses). The object is loose: the many counters of
 * the row (wins, kills, damage…) are none of the app's business and are not read.
 */
const heroSampleRowSchema = z.looseObject({
  hero_id: z.int(),
  matches: z.int().nonnegative(),
});

/** The body of the answer: a list of anything, each row being validated on its own. */
const heroSampleBodySchema = z.array(z.unknown());

/**
 * Read the sample size of a hero out of deadlock-api's hero statistics.
 *
 * @param body - The parsed JSON body of the response.
 * @param heroId - The hero whose sample was requested.
 * @returns The number of matches the hero was played in, in the first readable row of the hero, or
 *   `0` when the answer has no readable row for it (the cohort holds no match of the hero).
 * @throws AppError of kind `invalid_payload` when the body is not an array (the context `issue` is
 *   `<path>: <code>` of the first problem, never a value of the payload).
 */
export function parseHeroSample(body: unknown, heroId: HeroId): number {
  const rows = heroSampleBodySchema.safeParse(body);
  if (!rows.success) {
    throw new AppError('invalid_payload', 'The hero statistics are invalid', {
      context: { issue: describeFirstIssue(rows.error) },
    });
  }
  for (const element of rows.data) {
    const row = heroSampleRowSchema.safeParse(element);
    // A row that does not fit the schema is skipped, never reported: one odd row must not hide the
    // row of the hero.
    if (row.success && row.data.hero_id === heroId) {
      return row.data.matches;
    }
  }
  return 0;
}

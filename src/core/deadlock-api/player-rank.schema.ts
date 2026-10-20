/**
 * Validation of deadlock-api's player rank (`GET /v1/players/{account_id}/rank`).
 *
 * The answer is the rank a player ended their latest ranked match with: a `badge`, the tier and the
 * sub-rank it is made of, and the match itself. The app compares the player's unranked matches with
 * the community of their current rank, and only needs the badge: `tier × 10 + subrank`, with the
 * progress the last ranked match awarded. It is `0` (tier 0, the Obscurus tier) when none of the
 * player's recent ranked matches reports a rank, for instance for a player still in their placement
 * matches.
 *
 * Unlike the cosmetic data of the Steam profile, the rank decides which community the analysis
 * compares with, so a badge that is not one is an error, not something to skip.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { MAX_BADGE } from '../domain/rank';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';

/**
 * The answer (only the field the app uses). The object is loose: the tier, the sub-rank and the
 * last ranked match are none of the app's business and are not read. The badge is `0` (no rank
 * known) or a badge, from `MIN_BADGE` (1) to {@link MAX_BADGE}.
 */
const playerRankSchema = z.looseObject({
  badge: z.int().min(0).max(MAX_BADGE),
});

/**
 * Read the rank badge of a player out of deadlock-api's answer.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The badge, a whole number from 0 (no rank known) to {@link MAX_BADGE}.
 * @throws AppError of kind `invalid_payload` when the body is not an object, or its `badge` is not a
 *   whole number from 0 to {@link MAX_BADGE} (the context `issue` is `<path>: <code>` of the first
 *   problem, never a value of the payload).
 */
export function parsePlayerRank(body: unknown): number {
  const rank = playerRankSchema.safeParse(body);
  if (!rank.success) {
    throw new AppError('invalid_payload', 'The player rank is invalid', {
      context: { issue: describeFirstIssue(rank.error) },
    });
  }
  return rank.data.badge;
}

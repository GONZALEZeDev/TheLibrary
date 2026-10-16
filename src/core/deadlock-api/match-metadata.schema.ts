/**
 * Validation of deadlock-api's match detail (`GET /v1/matches/{match_id}/metadata`).
 *
 * The detail is a payload of about 1 MB (up to 1.6 MB) and the app archives it after pruning, so
 * this schema is deliberately narrow and permissive at once:
 * - it validates only the fields the app relies on (who played, in which slot, and the slots the
 *   movement paths and the damage matrix refer to), never the big arrays element by element;
 * - every object is loose: a key the schema does not name is kept untouched, so the pruning and the
 *   archive see the payload exactly as the API sent it.
 *
 * Integers use `z.int()`, which accepts any safe integer: the API sends unsigned 32-bit values
 * (item ids go up to 4,204,808,176), which a signed 32-bit check would wrongly refuse.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { MatchId } from '../domain/match';
import { AppError } from '../errors/app-error';

/** A slot number: an integer, `0` being the non-player (neutrals, objectives…) in the damage matrix. */
const slot = z.int();

/**
 * One player of the match.
 *
 * `account_id` is `0` in private lobbies and `player_slot` (1 to 12) is the join key with the
 * paths and the damage matrix: `players[]` itself is not ordered by slot.
 */
const playerSchema = z.looseObject({
  account_id: z.int().nonnegative(),
  player_slot: z.int().nonnegative(),
  team: z.int(),
  hero_id: z.int().nonnegative(),
});

/** The movement path of one player (only its slot is validated, the arrays are kept as they are). */
const pathSchema = z.looseObject({ player_slot: slot });

/** The movement paths of the match; absent on some matches. */
const matchPathsSchema = z.looseObject({ paths: z.array(pathSchema) });

/** The damage a dealer's source did to one target (the damage samples are kept as they are). */
const damageToPlayerSchema = z.looseObject({ target_player_slot: slot });

/** One damage source (a weapon, an ability…) of a dealer. */
const damageSourceSchema = z.looseObject({ damage_to_players: z.array(damageToPlayerSchema) });

/** Everything one dealer did; the dealer at slot `0` is not a player. */
const damageDealerSchema = z.looseObject({
  dealer_player_slot: slot,
  damage_sources: z.array(damageSourceSchema),
});

/** Who damaged whom, from which source, over time; absent on some matches. */
const damageMatrixSchema = z.looseObject({ damage_dealers: z.array(damageDealerSchema) });

/** The `match_info` object: the match itself, its players, and the optional paths and damage. */
const matchInfoSchema = z.looseObject({
  match_id: z.int().min(1),
  start_time: z.int(),
  duration_s: z.int().nonnegative(),
  game_mode: z.int(),
  match_mode: z.int(),
  players: z.array(playerSchema).min(1),
  match_paths: matchPathsSchema.optional(),
  damage_matrix: damageMatrixSchema.optional(),
});

/**
 * The whole detail. Besides `match_info`, a real payload carries `hero_build_ids`,
 * `pregame_hero_ids` and `banned_hero_ids`: the loose object keeps them without validating them.
 */
const matchMetadataSchema = z.looseObject({ match_info: matchInfoSchema });

/**
 * A validated match detail, unknown keys included.
 *
 * Only the fields named by the schema are typed; every other key of the API is carried along
 * unchanged under the index signature, so it can be pruned, archived and read back as received.
 */
export type RawMatchMetadata = z.infer<typeof matchMetadataSchema>;

/**
 * Validate a match detail and keep it as the API sent it.
 *
 * @param body - The parsed JSON body of the response.
 * @param expectedMatchId - The match that was requested. When given, a detail describing another
 *   match is refused; the archive reader and the contract check call without it, since they only
 *   need the shape.
 * @returns The validated detail, with every key the schema does not name left untouched.
 * @throws AppError of kind `invalid_payload` when the body does not match the schema (the
 *   context `issue` is `<path>: <code>` of the first problem, never a value of the payload), or
 *   when it describes another match than `expectedMatchId` (`issue` is `match_id`).
 */
export function parseMatchMetadata(body: unknown, expectedMatchId?: MatchId): RawMatchMetadata {
  const parsed = matchMetadataSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('invalid_payload', 'The match detail is invalid', {
      context: { issue: describeFirstIssue(parsed.error) },
    });
  }
  if (expectedMatchId !== undefined && parsed.data.match_info.match_id !== expectedMatchId) {
    throw new AppError('invalid_payload', 'The match detail is invalid', {
      context: { issue: 'match_id' },
    });
  }
  return parsed.data;
}

/**
 * Describe the first problem of a failed validation as `<path>: <code>`, e.g.
 * `match_info.players.0.player_slot: invalid_type`.
 *
 * Only the path and the issue code are used: Zod's messages can echo parts of the input, and the
 * payload belongs to players (account ids), so no value may reach an error or a log.
 *
 * @param error - The validation error.
 * @returns The path and code of its first issue.
 */
function describeFirstIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) {
    return 'invalid payload';
  }
  // An issue on the body itself (not an object) has an empty path.
  const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
  return `${path}: ${issue.code}`;
}

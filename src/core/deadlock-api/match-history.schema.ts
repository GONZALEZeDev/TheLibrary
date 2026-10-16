/**
 * Validation and mapping of deadlock-api's match history (`GET /v1/players/{account_id}/match-history`).
 *
 * This is the anti-corruption layer of the history: the schema describes only the fields the app
 * uses (unknown fields are ignored), and the mapper turns the API's rows into {@link MatchSummary}
 * objects. Nothing outside this module touches a raw history row.
 *
 * Rows are validated one by one: a single malformed row is dropped and reported, so that one odd
 * match never blocks the synchronisation of all the others.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { AccountId } from '../domain/account';
import { parseMatchId, type MatchId, type MatchSummary } from '../domain/match';
import { AppError } from '../errors/app-error';

/** A count or a duration: an integer that cannot be negative. */
const count = z.int().nonnegative();

/**
 * One row of the history, as deadlock-api returns it (only the fields the app uses).
 *
 * Field meanings come from the OpenAPI document and Valve's game data; `match_result` and
 * `player_team` are undocumented, see {@link toMatchSummary} for how they are used.
 */
const matchHistoryRowSchema = z.object({
  account_id: z.int(),
  // `parseMatchId` is the one validation of a match id: a row it rejects is an invalid row, and the
  // type guard gives the parsed field the `MatchId` brand without a cast.
  match_id: z.int().refine((value): value is MatchId => parseMatchId(value) !== null, {
    message: 'Invalid match id',
  }),
  hero_id: z.int().positive(),
  start_time: count,
  match_duration_s: count,
  game_mode: z.int(),
  match_mode: z.int(),
  player_team: z.int(),
  match_result: z.int(),
  player_kills: count,
  player_deaths: count,
  player_assists: count,
  net_worth: count,
  last_hits: count,
  denies: count,
  // Absent or null when the match changed no rank.
  ranked_delta: z.int().nullish(),
});

/** One validated row of the history. */
type MatchHistoryRow = z.infer<typeof matchHistoryRowSchema>;

/** The history of one player, validated. */
export interface MatchHistory {
  /** The valid rows, in the order of the response (most recent first). */
  readonly matches: readonly MatchSummary[];
  /** Number of rows dropped because they did not match the schema. */
  readonly invalidRows: number;
  /** Where and why the first dropped row failed, for the logs; `null` when no row was dropped. */
  readonly firstIssue: string | null;
}

/**
 * Validate a match history response and map it to match summaries.
 *
 * A row describing another player than `accountId` is invalid too: the response must be about the
 * requested player only.
 *
 * @param body - The parsed JSON body of the response.
 * @param accountId - The player whose history was requested.
 * @returns The valid matches and a report of the dropped rows.
 * @throws AppError of kind `invalid_payload` when the body is not an array, or when it has rows and
 *   none of them is valid (the format of the API has most likely changed).
 */
export function parseMatchHistory(body: unknown, accountId: AccountId): MatchHistory {
  if (!Array.isArray(body)) {
    throw new AppError('invalid_payload', 'The match history is not an array', {
      context: { endpoint: '/v1/players/{account_id}/match-history' },
    });
  }
  const matches: MatchSummary[] = [];
  let invalidRows = 0;
  let firstIssue: string | null = null;
  for (const [index, row] of body.entries()) {
    const parsed = matchHistoryRowSchema.safeParse(row);
    const issue = parsed.success
      ? parsed.data.account_id === accountId
        ? null
        : 'account_id: row of another player'
      : describeFirstIssue(parsed.error);
    if (parsed.success && issue === null) {
      matches.push(toMatchSummary(parsed.data, accountId));
    } else {
      invalidRows += 1;
      firstIssue ??= `[${String(index)}].${issue ?? 'unknown issue'}`;
    }
  }
  if (body.length > 0 && matches.length === 0) {
    throw new AppError('invalid_payload', 'No row of the match history is valid', {
      context: { rows: body.length, firstIssue },
    });
  }
  return { matches, invalidRows, firstIssue };
}

/**
 * Map a validated row to a match summary.
 *
 * Win rule: the player won when `match_result` (the winning team) equals `player_team`. Neither
 * field is documented, but this rule matched the documented `player_match_outcome` on every live
 * row checked on 2026-10-14; `player_match_outcome` itself is 0 ("invalid") on most older matches,
 * so it cannot be used instead.
 *
 * @param row - A validated row.
 * @param accountId - The player of the history.
 * @returns The match summary.
 */
function toMatchSummary(row: MatchHistoryRow, accountId: AccountId): MatchSummary {
  return {
    accountId,
    matchId: row.match_id,
    heroId: row.hero_id,
    startTime: row.start_time,
    durationS: row.match_duration_s,
    gameMode: row.game_mode,
    matchMode: row.match_mode,
    won: row.match_result === row.player_team,
    kills: row.player_kills,
    deaths: row.player_deaths,
    assists: row.player_assists,
    netWorth: row.net_worth,
    lastHits: row.last_hits,
    denies: row.denies,
    rankDelta: row.ranked_delta ?? null,
  };
}

/**
 * Describe the first problem of a failed validation, e.g. `hero_id: Invalid input: expected int`.
 *
 * @param error - The validation error.
 * @returns The path and message of its first issue.
 */
function describeFirstIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  return issue === undefined ? 'invalid row' : `${issue.path.join('.')}: ${issue.message}`;
}

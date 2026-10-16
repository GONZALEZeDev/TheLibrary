/**
 * The few facts the match detail page reads back from an archive.
 *
 * The archive holds a whole match detail (pruned for the tracked player), but the first version of
 * the page only shows a handful of figures about him. This module reads exactly those, with a
 * schema that names only the fields it needs and ignores everything else, so that an archive
 * stays readable as the API (and the rest of the app) evolves.
 *
 * Like every reader of an archive, it never puts a value of the payload in an error: the payload
 * belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import type { ArchiveEnvelope } from './archive-envelope';
import { findTrackedPlayer } from './pruning';

/** What the match detail page shows about the tracked player in an archived match. */
export interface ArchiveFacts {
  /** `true` when the tracked player's team won the match. */
  readonly won: boolean;
  /** The length of the match, in seconds. */
  readonly durationS: number;
  /** His kills. */
  readonly kills: number;
  /** His deaths. */
  readonly deaths: number;
  /** His assists. */
  readonly assists: number;
  /** His souls at the end of the match. */
  readonly netWorth: number;
  /** The number of statistic snapshots the archive holds for him (one is taken at the match end). */
  readonly snapshots: number;
  /** The number of items he bought (the ability upgrades of his list are not counted). */
  readonly itemsBought: number;
  /** When the archived detail was fetched from the API, in Unix milliseconds. */
  readonly fetchedAt: number;
}

/** A count the API reports for a player: a non-negative integer. */
const count = z.int().nonnegative();

/**
 * The fields of the tracked player's entry that the facts need. The object is loose: every other
 * field of the player is ignored.
 *
 * `stats` (the cumulative statistic snapshots) and `items` (the item purchases and the ability
 * upgrades) may be absent from a player's entry: an absent array counts as empty.
 */
const trackedPlayerSchema = z.looseObject({
  kills: count,
  deaths: count,
  assists: count,
  net_worth: count,
  // Only the number of snapshots is read, so their content is not checked.
  stats: z.array(z.unknown()).optional(),
  items: z.array(z.looseObject({ upgrade_id: count.optional() })).optional(),
});

/** The fields of `match_info` that the facts need (the object is loose, like the player's). */
const matchInfoSchema = z.looseObject({
  // The team that won the match, numbered like `players[].team`.
  winning_team: z.int(),
});

/**
 * Summarise the tracked player of an archive.
 *
 * The tracked player is the one the archive was pruned for. He is found by account id exactly like
 * the pruning does, so an archive that would not have been written (no such player, several of
 * them, not playing Paige) is not read either.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The facts about the tracked player.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or malformed. The
 *   context `issue` is one of `findTrackedPlayer`'s (`tracked_player_missing`…), or
 *   `tracked_player.<path>: <code>` / `match_info.<path>: <code>` for a field that is not what
 *   the facts expect; never a value of the payload.
 */
export function summarizeArchive(envelope: ArchiveEnvelope): ArchiveFacts {
  const { payload, prunedForAccountId } = envelope;
  // Lookup and checks first: past this point, exactly one player has the tracked account id.
  const tracked = findTrackedPlayer(payload, prunedForAccountId);
  const entry = payload.match_info.players.find(
    (player) => player.account_id === prunedForAccountId,
  );
  const player = readFields(trackedPlayerSchema, entry, 'tracked_player');
  const matchInfo = readFields(matchInfoSchema, payload.match_info, 'match_info');
  return {
    won: matchInfo.winning_team === tracked.team,
    durationS: payload.match_info.duration_s,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    netWorth: player.net_worth,
    snapshots: player.stats?.length ?? 0,
    // The items of a player mix purchases and ability unlocks/upgrades: a non-zero `upgrade_id`
    // marks the latter, which are not items he bought.
    itemsBought: (player.items ?? []).filter((item) => (item.upgrade_id ?? 0) === 0).length,
    fetchedAt: envelope.fetchedAt,
  };
}

/**
 * Read the fields of a part of the payload with a schema.
 *
 * @param schema - The schema of the fields to read.
 * @param value - The part of the payload.
 * @param name - What the part is, the start of the path of a problem.
 * @returns The validated fields.
 * @throws AppError of kind `invalid_payload` (`<name>.<path>: <code>`) when the part does not match
 *   the schema. Zod's message is not used: it can echo a part of the input.
 */
function readFields<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  name: string,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const [issue] = parsed.error.issues;
  // An issue on the part itself has an empty path.
  const path = [name, ...(issue?.path ?? []).map(String)].join('.');
  throw new AppError('invalid_payload', 'The archive is unreadable', {
    context: { issue: `${path}: ${issue?.code ?? 'invalid'}` },
  });
}

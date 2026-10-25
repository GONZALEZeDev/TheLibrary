/**
 * User-centric pruning of a match detail.
 *
 * A match detail weighs about 1 MB, most of it the movement paths of the twelve players and the
 * damage matrix. The app mostly analyses the tracked player, so before a detail is compressed and
 * archived it is reduced to what concerns them (see `docs/adr/0003-user-centric-archive-zstd.md`):
 * the damage of the other players that does not involve them is dropped, and everything else is
 * kept exactly as the API sent it. The movement paths of all twelve players are kept (archive
 * format 2): they tell who was near the tracked player when they died.
 *
 * Both functions are pure: they never modify their input.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../domain/account';
import { PAIGE_HERO_ID } from '../domain/hero';
import { AppError } from '../errors/app-error';
import type { RawMatchMetadata } from '../deadlock-api/match-metadata.schema';

/** The tracked player in a match detail: where to find them in the slot-indexed parts. */
export interface TrackedPlayer {
  /** Their slot (1 to 12): the key of their movement path and of their damage in the detail. */
  readonly playerSlot: number;
  /** Their team, as numbered by the API. */
  readonly team: number;
}

/** One damage dealer of the damage matrix, as typed by the match detail schema. */
type DamageDealer = NonNullable<
  NonNullable<RawMatchMetadata['match_info']['damage_matrix']>
>['damage_dealers'][number];

/**
 * Find the tracked player among the players of a match.
 *
 * The detail lists the players in no particular order, so they are found by account id and never by
 * position. The match must hold exactly one player with that account id, and that player must be
 * playing Paige: the archive only holds Paige matches of the tracked account, so anything else
 * means the detail does not describe the match the history announced.
 *
 * @param metadata - The validated match detail.
 * @param accountId - The tracked account.
 * @returns Their slot and their team.
 * @throws AppError of kind `invalid_payload` when no player, or several players, have this account
 *   id, or when they are not playing Paige (the context `issue` is `tracked_player_missing`,
 *   `tracked_player_ambiguous` or `tracked_player_not_paige`; the account id itself is never
 *   put in the error).
 */
export function findTrackedPlayer(metadata: RawMatchMetadata, accountId: AccountId): TrackedPlayer {
  const candidates = metadata.match_info.players.filter(
    (player) => player.account_id === accountId,
  );
  const [player, ...others] = candidates;
  if (player === undefined) {
    throw new AppError('invalid_payload', 'The tracked player is not in the match detail', {
      context: { issue: 'tracked_player_missing' },
    });
  }
  // Two players with one account id would make every slot-based choice below a guess.
  if (others.length > 0) {
    throw new AppError(
      'invalid_payload',
      'Several players of the match detail have the tracked account id',
      {
        context: { issue: 'tracked_player_ambiguous' },
      },
    );
  }
  if (player.hero_id !== PAIGE_HERO_ID) {
    throw new AppError('invalid_payload', 'The tracked player is not playing Paige in this match', {
      context: { issue: 'tracked_player_not_paige' },
    });
  }
  return { playerSlot: player.player_slot, team: player.team };
}

/**
 * Reduce a match detail to what concerns the tracked player.
 *
 * This is the only thing dropped: in the damage matrix, the damage that involves neither the
 * tracked player as dealer nor as target (every damage entry of another dealer that does not target
 * them, then the damage sources and the dealers that are left empty).
 *
 * Everything else is copied unchanged: all the players, the movement paths of all twelve of them
 * (`match_info.match_paths`, whole), `sample_time_s` and `source_details` (the damage sources refer
 * to `source_details` by index, so it must stay whole), and every field the schema does not name.
 * The non-player dealer (slot `0`) is treated like any other dealer: what it does to the tracked
 * player is kept, and the tracked player's damage to a non-player target (slot `0`) is kept with
 * the rest of their damage.
 *
 * The input is never modified. The result shares the parts that are kept as they are (such as the
 * players) with the input, which is safe because neither is ever mutated.
 *
 * @param metadata - The validated match detail.
 * @param trackedSlot - The slot of the tracked player, see {@link findTrackedPlayer}.
 * @returns A new detail, pruned for that player.
 */
export function pruneForPlayer(metadata: RawMatchMetadata, trackedSlot: number): RawMatchMetadata {
  const matchInfo = metadata.match_info;
  const { damage_matrix: damageMatrix } = matchInfo;
  return {
    ...metadata,
    match_info: {
      ...matchInfo,
      // The paths stay whole (they come with `...matchInfo`). The damage matrix is optional in the
      // payload: an absent part stays absent (no key is added), so the archive still describes what
      // the API sent.
      ...(damageMatrix === undefined
        ? {}
        : {
            damage_matrix: {
              ...damageMatrix,
              damage_dealers: pruneDamageDealers(damageMatrix.damage_dealers, trackedSlot),
            },
          }),
    },
  };
}

/**
 * Prune the dealers of the damage matrix for one player.
 *
 * The tracked player's own dealer is kept whole (what they deal, to anyone). Any other dealer is
 * reduced to the damage it did to the tracked player, and disappears when nothing is left.
 *
 * @param dealers - The damage dealers of the match.
 * @param trackedSlot - The slot of the tracked player.
 * @returns The dealers that concern the tracked player, in their original order.
 */
function pruneDamageDealers(dealers: readonly DamageDealer[], trackedSlot: number): DamageDealer[] {
  const kept: DamageDealer[] = [];
  for (const dealer of dealers) {
    if (dealer.dealer_player_slot === trackedSlot) {
      kept.push(dealer);
      continue;
    }
    // Only the entries aimed at the tracked player survive; `source_details_index` and every
    // other field of a source stay as they are.
    const sources = dealer.damage_sources
      .map((source) => ({
        ...source,
        damage_to_players: source.damage_to_players.filter(
          (entry) => entry.target_player_slot === trackedSlot,
        ),
      }))
      .filter((source) => source.damage_to_players.length > 0);
    if (sources.length > 0) {
      kept.push({ ...dealer, damage_sources: sources });
    }
  }
  return kept;
}

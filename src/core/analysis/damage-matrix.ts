/**
 * The tracked player's damage to enemy heroes, by source, read from the damage matrix of an
 * archived match.
 *
 * The damage matrix says who dealt how much damage to whom, with which source, at each sample of a
 * time grid. This module keeps what the analysis needs from it: the tracked player's own damage to
 * the heroes of the other team, summed per source (a weapon, an ability, an item) at each sample.
 * How the matrix is laid out:
 * - `source_details` holds, in two parallel lists, the stat type and the name of each source;
 *   a damage source refers to it by index, and only stat type {@link DAMAGE_STAT_TYPE} is damage
 *   (the others are healing, mitigation, regeneration…);
 * - the five category rows ({@link AGGREGATE_SOURCE_NAMES}) duplicate the per-source rows, so they
 *   are left out or the damage would be counted twice;
 * - the weapons of some heroes report their critical hits as a separate source named after the
 *   weapon and {@link CRIT_SUFFIX}; the two are one weapon, so they are merged;
 * - the damage of a source to a target is a cumulative series, right-aligned on `sample_time_s`:
 *   the leading zeros are trimmed, so the last value is the final total and a series shorter than
 *   the grid starts at a later sample;
 * - the grid is the matrix's own (every 180 s or so, not always regular), which is not the
 *   grid of the statistic snapshots.
 *
 * In an archive only the tracked player's own dealer is whole: the other dealers keep only the
 * damage aimed at the tracked player (see `../match-detail/pruning`), so only the tracked player's
 * dealer is read.
 *
 * Like every reader of an archive, it never puts a value of the payload in an error: the payload
 * belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { RawMatchMetadata } from '../deadlock-api/match-metadata.schema';
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import { readArchiveFields } from '../match-detail/archive-fields';
import { findTrackedPlayer } from '../match-detail/pruning';
import { readTrackedItems } from '../match-detail/tracked-items';
import type { ItemEntry } from '../match-detail/tracked-items';

/** The stat type of damage in `source_details` (the other types are healing, mitigation…). */
export const DAMAGE_STAT_TYPE = 0;

/**
 * The category rows of the damage matrix. Each one adds up the per-source rows of its category, so
 * summing them with the sources counts the same damage twice.
 */
export const AGGREGATE_SOURCE_NAMES = [
  'Bullet',
  'Ability',
  'Melee',
  'UnknownAbility',
  'Misc',
] as const;

/** The end of the name of the source that holds the critical hits of another source. */
export const CRIT_SUFFIX = '_crit';

/** The tracked player's damage to enemy heroes, as read from an archived match. */
export interface DamageMatrixRead {
  /** The time of each sample, in seconds since the start of the match, as the matrix gives them. */
  readonly sampleTimesS: readonly number[];
  /**
   * The cumulative damage to enemy heroes of each source at each sample, by class name. A source
   * and its critical hits are one entry, named after the source. Every series has one value per
   * sample (zeros before the source first dealt damage). A source is in the map as soon as it has
   * a row aimed at an enemy hero, even when that row is empty or all zeros: to know whether a
   * source dealt damage, test the last value of its series (`> 0`), not its presence. A source
   * with no such row at all is not in the map.
   */
  readonly sources: ReadonlyMap<string, readonly number[]>;
  /** The cumulative damage to enemy heroes of all the sources together, at each sample. */
  readonly total: readonly number[];
  /** The entries of the tracked player's `items[]`, sorted, see {@link readTrackedItems}. */
  readonly items: readonly ItemEntry[];
}

/**
 * Tell whether no value of a list is smaller than the one before it.
 *
 * @param values - The list.
 * @returns `true` for a list that never goes back (equal neighbours included), an empty one or a
 *   single value included.
 */
function isNonDecreasing(values: readonly number[]): boolean {
  // A missing predecessor cannot happen (the index is in the list); infinity makes it fail closed.
  return values.every(
    (value, index) => index === 0 || value >= (values[index - 1] ?? Number.POSITIVE_INFINITY),
  );
}

/**
 * What the reader needs of a damage matrix besides its dealers: the time grid, and the table of
 * sources the dealers refer to by index.
 *
 * The grid never goes back (it is regular or not, and its last sample, the match end, may repeat the
 * one before it): whoever places a time on it relies on that. The two lists of the table are
 * parallel, so a stat type without a name (or the reverse) is a payload problem rather than a
 * source to guess.
 */
const matrixHeaderSchema = z.looseObject({
  sample_time_s: z.array(z.number().nonnegative()).refine(isNonDecreasing),
  source_details: z
    .looseObject({ stat_type: z.array(z.int()), source_name: z.array(z.string()) })
    .refine((details) => details.stat_type.length === details.source_name.length),
});

/**
 * The schema of a dealer's damage sources, for a given source table: the first pass over the
 * dealer, which only checks what is needed to decide whether a row is kept (which source it is, and
 * who it is aimed at). A source index must be in the table, and so the schema is built per matrix.
 *
 * The series themselves are not checked here: a row that is left out is none of the reader's
 * business, and one odd value in it must not make the matrix unreadable (see {@link seriesSchema}).
 *
 * @param sourceCount - The number of sources of the table.
 * @returns The schema of one dealer. It is loose, like every reader's.
 */
function dealerSchema(sourceCount: number) {
  return z.looseObject({
    damage_sources: z.array(
      z.looseObject({
        source_details_index: z
          .int()
          .nonnegative()
          .max(sourceCount - 1),
        damage_to_players: z.array(z.looseObject({ target_player_slot: z.int() })),
      }),
    ),
  });
}

/**
 * The schema of the damage series of a row that is kept: a cumulative series cannot hold more
 * values than the grid has samples (it is right-aligned on it, with the leading zeros trimmed).
 *
 * @param sampleCount - The number of samples of the grid.
 * @returns The schema of one series.
 */
function seriesSchema(sampleCount: number) {
  return z.array(z.number().nonnegative()).max(sampleCount);
}

/**
 * A series of zeros, the damage of a source before it has dealt any.
 *
 * @param sampleCount - The number of samples of the grid.
 * @returns A new series with one `0` per sample.
 */
function zeros(sampleCount: number): number[] {
  return Array.from({ length: sampleCount }, () => 0);
}

/**
 * Add a cumulative series to a sum, aligning its end on the sum's: element `k` of a series of
 * length `L` belongs to sample `N − L + k`, `N` being the number of samples.
 *
 * @param sum - The sum over the samples; it is modified.
 * @param series - The series to add, no longer than the sum.
 */
function addRightAligned(sum: number[], series: readonly number[]): void {
  const offset = sum.length - series.length;
  for (const [position, value] of series.entries()) {
    sum[offset + position] = (sum[offset + position] ?? 0) + value;
  }
}

/**
 * The slots of the enemy heroes: the players of the other team. The slot `0` of the matrix is the
 * non-player (neutrals, objectives…) and never a hero.
 *
 * @param players - The players of the match.
 * @param team - The team of the tracked player.
 * @returns The slots of the players who are not in that team.
 */
function enemySlots(
  players: RawMatchMetadata['match_info']['players'],
  team: number,
): ReadonlySet<number> {
  return new Set(
    players
      .filter((player) => player.team !== team && player.player_slot > 0)
      .map((player) => player.player_slot),
  );
}

/**
 * Name the class of a source: a critical-hit row is named after the source it belongs to.
 *
 * @param sourceName - The `source_name` of a damage source.
 * @returns The name without {@link CRIT_SUFFIX}; a name that is only the suffix is kept as it is.
 */
function classNameOf(sourceName: string): string {
  if (!sourceName.endsWith(CRIT_SUFFIX)) {
    return sourceName;
  }
  const base = sourceName.slice(0, -CRIT_SUFFIX.length);
  return base === '' ? sourceName : base;
}

/**
 * Read the tracked player's damage to enemy heroes from an archived match.
 *
 * The tracked player is the one the archive was pruned for. They are found by account id exactly
 * like the pruning does, so an archive that would not have been written (no such player, several of
 * them, not playing Paige) is not read either.
 *
 * It keeps the tracked player's dealer only; the targets that are players of the other team; the
 * rows of stat type {@link DAMAGE_STAT_TYPE}; and no {@link AGGREGATE_SOURCE_NAMES} row (nor the
 * critical hits of one). Only the rows it keeps have their damage series checked: whatever is wrong
 * in a row it leaves out does not matter.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The damage by source, with the player's items; `null` when the match has no damage
 *   matrix. A player with no dealer in the matrix dealt no damage: they have no source.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or the matrix is not
 *   what is expected. The context `issue` is one of `findTrackedPlayer`'s
 *   (`tracked_player_missing`…), or `damage_matrix.<path>: <code>`; never a value of the payload.
 *   Inside the dealers, the path is the position of the dealer in `damage_dealers`, then that of
 *   the source in `damage_sources` and of the target in `damage_to_players`. A source index outside
 *   the table and a series longer than the grid are both `too_big`; a sample grid that goes back is
 *   `damage_matrix.sample_time_s: custom`. The problems of the items are those of
 *   {@link readTrackedItems}.
 */
export function readDamageMatrix(envelope: ArchiveEnvelope): DamageMatrixRead | null {
  const { payload } = envelope;
  const tracked = findTrackedPlayer(payload, envelope.prunedForAccountId);
  const matrix = payload.match_info.damage_matrix;
  if (matrix === undefined) {
    return null;
  }
  const header = readArchiveFields(matrixHeaderSchema, matrix, 'damage_matrix');
  const { stat_type: statTypes, source_name: sourceNames } = header.source_details;
  const sampleCount = header.sample_time_s.length;
  const dealerShape = dealerSchema(sourceNames.length);
  const seriesShape = seriesSchema(sampleCount);
  const enemies = enemySlots(payload.match_info.players, tracked.team);

  const sources = new Map<string, number[]>();
  for (const [dealerIndex, dealer] of matrix.damage_dealers.entries()) {
    if (dealer.dealer_player_slot !== tracked.playerSlot) {
      continue;
    }
    // Only the tracked player's dealer is read, and so only it has to be right.
    const dealerPath = `damage_matrix.damage_dealers.${String(dealerIndex)}`;
    const { damage_sources: damageSources } = readArchiveFields(dealerShape, dealer, dealerPath);
    for (const [sourceIndex, source] of damageSources.entries()) {
      const sourceName = sourceNames[source.source_details_index];
      // The index is inside the table (checked by the schema), so a name is always there: this
      // only narrows the type.
      if (sourceName === undefined || statTypes[source.source_details_index] !== DAMAGE_STAT_TYPE) {
        continue;
      }
      // The crit suffix goes first: the critical hits of a category row are not a source either.
      const className = classNameOf(sourceName);
      if ((AGGREGATE_SOURCE_NAMES as readonly string[]).includes(className)) {
        continue;
      }
      for (const [targetIndex, target] of source.damage_to_players.entries()) {
        if (!enemies.has(target.target_player_slot)) {
          continue;
        }
        // Only a row that is kept has its series checked.
        const damage = readArchiveFields(
          seriesShape,
          target.damage,
          `${dealerPath}.damage_sources.${String(sourceIndex)}.damage_to_players.${String(targetIndex)}.damage`,
        );
        // A source and its crit row share one entry: their series are added.
        const series = sources.get(className) ?? zeros(sampleCount);
        addRightAligned(series, damage);
        sources.set(className, series);
      }
    }
  }

  // The sources are whole series (one value per sample), so the total is their sum sample by sample.
  const total = zeros(sampleCount);
  for (const series of sources.values()) {
    addRightAligned(total, series);
  }
  return {
    sampleTimesS: header.sample_time_s,
    sources,
    total,
    items: readTrackedItems(envelope),
  };
}

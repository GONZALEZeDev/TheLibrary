/**
 * The damage values the projection stores for a match: what each source dealt, how much damage the
 * player dealt while they owned each shop item, and when each ability was unlocked.
 *
 * They are plain numbers, stored one per key in the match's metrics, so that a later view can work
 * out the shares, the kinds and the habits with the catalogues (which this module cannot reach).
 * There are three families of keys, each with its own prefix:
 * - `damage_source.<class name>`: the damage a source dealt to enemy heroes over the whole match;
 * - `item_owned_damage.<item id>`: the damage the player dealt to enemy heroes, all sources
 *   together, while they owned that shop item (to tell an item that was bought late from a weak one);
 * - `ability_unlocked_at.<item id>`: the second an ability of the hero was unlocked (to tell an
 *   ability that was not available yet from one that was not used).
 *
 * The damage while an item is owned is measured on the total of the damage matrix, not on the
 * statistic snapshots, whose interpolation errs by up to 18 % of the damage. The total is a
 * cumulative series sampled on the matrix's own grid, which starts after the match does: the damage
 * before the first sample is interpolated from an implicit point, 0 damage at 0 s.
 *
 * @packageDocumentation
 */
import type { DamageMatrixRead } from './damage-matrix';

/** The prefix of the keys of the damage a source dealt. */
const DAMAGE_SOURCE_PREFIX = 'damage_source.';

/** The prefix of the keys of the damage dealt while a shop item was owned. */
const ITEM_OWNED_DAMAGE_PREFIX = 'item_owned_damage.';

/** The prefix of the keys of the time an ability was unlocked. */
const ABILITY_UNLOCK_PREFIX = 'ability_unlocked_at.';

/**
 * The prefixes of the three families of keys, dot included, so that no other key can start with one
 * (`damage_source_x` does not).
 */
export const DAMAGE_KEY_PREFIXES = [
  DAMAGE_SOURCE_PREFIX,
  ITEM_OWNED_DAMAGE_PREFIX,
  ABILITY_UNLOCK_PREFIX,
] as const;

/**
 * The key of the damage a source dealt to enemy heroes.
 *
 * @param className - The class name of the source, with its critical hits merged in (see
 *   {@link DamageMatrixRead.sources}).
 * @returns `damage_source.<class name>`.
 */
export function damageSourceKey(className: string): string {
  return `${DAMAGE_SOURCE_PREFIX}${className}`;
}

/**
 * The key of the damage the player dealt to enemy heroes while they owned a shop item.
 *
 * @param itemId - The asset id of the shop item.
 * @returns `item_owned_damage.<item id>`.
 */
export function itemOwnedDamageKey(itemId: number): string {
  return `${ITEM_OWNED_DAMAGE_PREFIX}${String(itemId)}`;
}

/**
 * The key of the time an ability was unlocked.
 *
 * @param itemId - The asset id of the ability (the id its entries in `items[]` carry).
 * @returns `ability_unlocked_at.<item id>`.
 */
export function abilityUnlockKey(itemId: number): string {
  return `${ABILITY_UNLOCK_PREFIX}${String(itemId)}`;
}

/**
 * The damage the player had dealt to enemy heroes, all sources together, at a given time.
 *
 * The total of the read is known at the samples only. Between two samples the damage is taken to
 * grow linearly, and before the first one it grows from an implicit point at 0 s with no damage
 * (the first sample is at 180 s or so, and a purchase can come before it). After the last sample,
 * which is the end of the match, the damage is the final total.
 *
 * @param read - The damage matrix read; its sample times must not decrease, as the matrix gives
 *   them.
 * @param timeS - The time, in seconds since the start of the match.
 * @returns The cumulative damage at that time; `0` at or before the start of the match, and for a
 *   read without samples.
 */
export function damageAt(read: DamageMatrixRead, timeS: number): number {
  if (timeS <= 0) {
    return 0;
  }
  // The line starts at the implicit point (0 s, no damage).
  let previousTimeS = 0;
  let previousDamage = 0;
  for (const [position, sampleTimeS] of read.sampleTimesS.entries()) {
    // The total has one value per sample; should it ever be shorter, it stays where it was.
    const damage = read.total[position] ?? previousDamage;
    if (timeS <= sampleTimeS) {
      // The time is on this stretch (and so after `previousTimeS`: the stretch is not empty).
      const fraction = (timeS - previousTimeS) / (sampleTimeS - previousTimeS);
      return previousDamage + (damage - previousDamage) * fraction;
    }
    previousTimeS = sampleTimeS;
    previousDamage = damage;
  }
  // After the last sample (or without any): the final total.
  return previousDamage;
}

/** A period during which a shop item was owned, in seconds since the start of the match. */
interface OwnedPeriod {
  /** When the item was bought. */
  readonly startS: number;
  /** When it left the inventory, or the end of the match when it was kept. */
  readonly endS: number;
}

/**
 * Merge the periods that overlap into one, so that the damage dealt during an overlap is not counted
 * twice. Periods that only touch are merged too, which changes nothing to the damage they hold.
 *
 * @param periods - The periods, in any order.
 * @returns The merged periods, sorted, with no overlap.
 */
function mergePeriods(periods: readonly OwnedPeriod[]): readonly OwnedPeriod[] {
  const merged: OwnedPeriod[] = [];
  for (const period of periods.toSorted((first, second) => first.startS - second.startS)) {
    const last = merged.at(-1);
    if (last !== undefined && period.startS <= last.endS) {
      // This period starts inside the last one (the periods are sorted by start): it extends it.
      merged[merged.length - 1] = { startS: last.startS, endS: Math.max(last.endS, period.endS) };
    } else {
      merged.push(period);
    }
  }
  return merged;
}

/**
 * Compute the damage values to store for a match.
 *
 * Three families of keys, see the module's description:
 * - one `damage_source.<class name>` for each source whose final damage is above 0 (a source that
 *   never hit an enemy hero gets nothing);
 * - one `item_owned_damage.<item id>` for each shop item the player had, whether or not the item
 *   itself dealt damage. A period of ownership runs from the purchase to the sale, or to the last
 *   sample (the end of the match) for an item that was kept; the periods of an item bought several
 *   times are merged where they overlap, then added. An item bought at the end gets `0`;
 * - one `ability_unlocked_at.<item id>` for each ability of the hero in the player's items, valued
 *   at its earliest entry. The unlock has an entry of its own in the payload, but it is not relied
 *   on: when it is missing, the first upgrade stands for it, and the entries need not be sorted.
 *
 * @param read - The damage matrix read of the match, see {@link DamageMatrixRead}.
 * @returns The values by key; empty for a player with no damage and no items.
 */
export function projectDamageSources(read: DamageMatrixRead): ReadonlyMap<string, number> {
  const values = new Map<string, number>();

  // The series are cumulative, so the last value of each is the damage of the whole match.
  for (const [className, series] of read.sources) {
    const finalDamage = series.at(-1) ?? 0;
    if (finalDamage > 0) {
      values.set(damageSourceKey(className), finalDamage);
    }
  }

  // The match ends on the last sample; an item that was kept is owned until then.
  const matchEndS = read.sampleTimesS.at(-1) ?? 0;
  const periodsByItem = new Map<number, OwnedPeriod[]>();
  const unlockTimes = new Map<number, number>();
  for (const item of read.items) {
    if (item.isShopItem) {
      // A sale cannot come before the purchase; if the payload says so, the item was owned for no
      // time.
      const period = { startS: item.timeS, endS: Math.max(item.soldAtS ?? matchEndS, item.timeS) };
      periodsByItem.set(item.itemId, [...(periodsByItem.get(item.itemId) ?? []), period]);
    } else {
      unlockTimes.set(
        item.itemId,
        Math.min(unlockTimes.get(item.itemId) ?? item.timeS, item.timeS),
      );
    }
  }

  for (const [itemId, periods] of periodsByItem) {
    // The damage dealt during a period is what the total gained between its two ends.
    let ownedDamage = 0;
    for (const { startS, endS } of mergePeriods(periods)) {
      ownedDamage += damageAt(read, endS) - damageAt(read, startS);
    }
    values.set(itemOwnedDamageKey(itemId), ownedDamage);
  }
  for (const [abilityId, unlockedAtS] of unlockTimes) {
    values.set(abilityUnlockKey(abilityId), unlockedAtS);
  }
  return values;
}

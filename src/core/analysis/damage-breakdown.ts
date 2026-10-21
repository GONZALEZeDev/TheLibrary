/**
 * The damage breakdown of a match: the damage sources of the player with their share of the damage,
 * their usual share (the player's habit) and whether the match used the source more or less than
 * usual, so that the player sees which ability, item or weapon to use more.
 *
 * It works from the values stored for the match and for the earlier ones (see `./damage-sources`),
 * the hero's loadout and the item catalogue, which core cannot reach by itself: the shares, the
 * kinds and the habits are computed here, when the match is shown, and not stored.
 *
 * - A source is classified by the hero's **loadout** first: the weapon, the melee, a signature
 *   ability. A source that is not one of them is an **item** when the catalogue knows it as a shop
 *   item (`upgrade`), and an **other** source otherwise (an ability of another hero, the zipline).
 * - A source is compared on its **share** of the damage dealt in the match. An item is compared on
 *   its share of the damage dealt **while it was owned** instead: an item bought late would always
 *   look weak on the whole match.
 * - The habit is the median share over the earlier matches where the source **appears** (it was
 *   unlocked, owned or dealt damage, depending on its kind). A match where the source did not
 *   appear says nothing about it and does not count.
 *
 * @packageDocumentation
 */
import type { CatalogueItem } from '../deadlock-api/assets.schema';
import type { HeroLoadout } from '../domain/hero';
import { abilityUnlockKey, damageSourceKey, itemOwnedDamageKey } from './damage-sources';
import { DAMAGE_SHARE_MIN_GAP, PERSONAL_WINDOW, STRONG_Z } from './insights/thresholds';
import { comparePersonal } from './references';

/** What a damage source is: one of the hero's own, a shop item, or anything else. */
export type SourceKind = 'weapon' | 'melee' | 'ability' | 'item' | 'other';

/** The values stored for a match: a number under each key, or `null` when it is not known. */
type StoredValues = ReadonlyMap<string, number | null>;

/** What the breakdown needs to be built. */
export interface DamageBreakdownInput {
  /** The values stored for the match. */
  readonly current: ReadonlyMap<string, number | null>;
  /**
   * The values stored for the earlier matches, the newest first. They must be the matches of the
   * same hero as `current`: the weapon and the melee appear in every one of them, which only holds
   * for the same loadout. The caller reads at most `PREVIOUS_LOOKUP` of them (see
   * `./insights/thresholds`), and the habit of a source takes the {@link PERSONAL_WINDOW} first ones
   * where it appears.
   */
  readonly previous: readonly ReadonlyMap<string, number | null>[];
  /** The hero's weapon, melee and four signature abilities, by class name. */
  readonly loadout: HeroLoadout;
  /** The item catalogue by class name, which is how the damage rows name their source. */
  readonly itemsByClassName: ReadonlyMap<string, CatalogueItem>;
}

/** One line of the breakdown: a damage source and how the match used it. */
export interface DamageSourceRow {
  /** The class name of the source, with its critical hits merged in. */
  readonly className: string;
  /** What the source is. */
  readonly kind: SourceKind;
  /** The asset id of the source in the catalogue, or `null` when the catalogue does not know it. */
  readonly itemId: number | null;
  /** The English name of the source: the catalogue's, or its class name made readable. */
  readonly name: string;
  /** The image of the source, or `null` when it has none. */
  readonly imageUrl: string | null;
  /** The damage the source dealt to enemy heroes in the match. */
  readonly damage: number;
  /** The share of the match's damage that the source dealt, from 0 to 1 (0 without any damage). */
  readonly share: number;
  /**
   * The share the source is compared on, from 0 to 1:
   * - for an item, its damage over the damage the player dealt while owning it (capped at 1: that
   *   damage is interpolated on a coarse grid, so it can fall short of the item's own), `null` when
   *   it is not known or not above 0;
   * - for any other source, its {@link DamageSourceRow.share}, `null` when the match has no damage;
   * - `null` for an ability that is not unlocked.
   */
  readonly comparedShare: number | null;
  /**
   * The player's habit for the source: the median of its compared share over the earlier matches
   * where it appears, and how many matches that is. `null` when there is no compared share, or too
   * few earlier matches.
   */
  readonly habit: { readonly median: number; readonly count: number } | null;
  /** The compared share minus the usual one, as a share (0.1 is 10 points); `null` without a habit. */
  readonly gap: number | null;
  /**
   * Whether the source was used more (`above`) or less (`below`) than usual; `null` if neither.
   * The share must be at least `DAMAGE_SHARE_MIN_GAP` (5 points) away from the usual one, and, when
   * the habit varies, at least `STRONG_Z` robust deviations away too (see `./insights/thresholds`).
   */
  readonly flag: 'above' | 'below' | null;
  /**
   * Whether the ability was unlocked in the match (always `true` for the other kinds). An ability
   * the catalogue does not know cannot be checked, and counts as unlocked.
   */
  readonly unlocked: boolean;
}

/** The damage breakdown of a match. */
export interface DamageBreakdown {
  /** The damage dealt to enemy heroes, all sources together. */
  readonly totalDamage: number;
  /**
   * The lines, the sources that were unlocked first, by share from the largest (a tie goes by class
   * name), then the abilities that were not unlocked, in the order of the loadout.
   */
  readonly rows: readonly DamageSourceRow[];
}

/** A damage source, described by the loadout and the catalogue. */
interface Source {
  /** The class name of the source. */
  readonly className: string;
  /** What the source is. */
  readonly kind: SourceKind;
  /** The catalogue entry of the source, if the catalogue has one. */
  readonly entry: CatalogueItem | undefined;
}

/** The values stored for a match, with the damage keys read out of them. */
interface MatchReading {
  /** The values stored for the match, whatever their key. */
  readonly values: StoredValues;
  /** The class names of the sources whose damage is known, without the prefix of their key. */
  readonly sourceNames: readonly string[];
  /** The damage of all the sources whose damage is known. */
  readonly totalDamage: number;
}

/**
 * The prefix of the keys of the damage a source dealt (it ends with a dot): what the key of a source
 * with an empty class name is, so that it follows the key builder and not the order of a list.
 */
const DAMAGE_SOURCE_PREFIX = damageSourceKey('');

/**
 * The prefixes the class name of a source may start with, longest first where one contains another
 * (`citadel_ability_` before `citadel_`), so that the first one that matches is the right one.
 */
const SOURCE_NAME_PREFIX = /^(?:citadel_ability_|citadel_weapon_|ability_|upgrade_|citadel_)/;

/**
 * How much a gap may fall short of {@link DAMAGE_SHARE_MIN_GAP} and still reach it. A gap is the
 * difference of two shares, which are not exact in binary (0.35 − 0.3 is 0.04999999999999999), so
 * without it a gap of exactly 5 points could stay under the threshold. The error of a difference of
 * two numbers under 1 is under one epsilon.
 */
const GAP_TOLERANCE = Number.EPSILON;

/**
 * Make the class name of a source readable, for a source the catalogue has no name for.
 *
 * One leading `citadel_ability_`, `citadel_weapon_`, `ability_`, `upgrade_` or `citadel_` is
 * stripped and the underscores become spaces: `citadel_ability_zip_line` reads "zip line". A name
 * that is only a prefix is kept as it is.
 *
 * @param className - The class name of the source.
 * @returns The readable name.
 */
export function readableSourceName(className: string): string {
  const readable = className.replace(SOURCE_NAME_PREFIX, '').replaceAll('_', ' ');
  return readable === '' ? className : readable;
}

/**
 * Read a stored value, an unknown one (`null`) being the same as an absent one.
 *
 * @param values - The values of a match.
 * @param key - The key to read.
 * @returns The value, or `null` when the key is absent or its value is not known.
 */
function read(values: StoredValues, key: string): number | null {
  return values.get(key) ?? null;
}

/**
 * Read the damage keys of a match.
 *
 * @param values - The values stored for the match.
 * @returns The reading; its `sourceNames` is empty when the match has no known damage by source.
 */
function readMatch(values: StoredValues): MatchReading {
  const sourceNames: string[] = [];
  let totalDamage = 0;
  // The prefix ends with a dot, so no other family of keys, and no look-alike, is read as damage.
  for (const [key, value] of values) {
    if (value !== null && key.startsWith(DAMAGE_SOURCE_PREFIX)) {
      sourceNames.push(key.slice(DAMAGE_SOURCE_PREFIX.length));
      totalDamage += value;
    }
  }
  return { values, sourceNames, totalDamage };
}

/**
 * The damage a source dealt in a match.
 *
 * @param match - The reading of the match.
 * @param className - The class name of the source.
 * @returns The damage, or `null` when the match holds none for the source.
 */
function damageOf(match: MatchReading, className: string): number | null {
  return read(match.values, damageSourceKey(className));
}

/**
 * Describe a source by the loadout, then by the catalogue.
 *
 * @param className - The class name of the source.
 * @param loadout - The hero's loadout.
 * @param itemsByClassName - The item catalogue by class name.
 * @returns The source.
 */
function describeSource(
  className: string,
  loadout: HeroLoadout,
  itemsByClassName: ReadonlyMap<string, CatalogueItem>,
): Source {
  const entry = itemsByClassName.get(className);
  let kind: SourceKind = 'other';
  if (className === loadout.weapon) {
    kind = 'weapon';
  } else if (className === loadout.melee) {
    kind = 'melee';
  } else if (loadout.abilities.includes(className)) {
    kind = 'ability';
  } else if (entry?.kind === 'upgrade') {
    kind = 'item';
  }
  return { className, kind, entry };
}

/**
 * Whether an ability was unlocked in a match. An ability the catalogue does not know has no id to
 * look its unlock up with, so it counts as unlocked in every match.
 *
 * @param match - The reading of the match.
 * @param ability - The ability.
 * @returns Whether it was unlocked.
 */
function isUnlockedIn(match: MatchReading, ability: Source): boolean {
  const abilityId = ability.entry?.id;
  return abilityId === undefined || read(match.values, abilityUnlockKey(abilityId)) !== null;
}

/**
 * The damage the player dealt while owning an item, all sources together.
 *
 * @param match - The reading of the match.
 * @param item - The item.
 * @returns The damage, or `null` when the item was not owned (or its damage is not known).
 */
function ownedDamageIn(match: MatchReading, item: Source): number | null {
  const itemId = item.entry?.id;
  return itemId === undefined ? null : read(match.values, itemOwnedDamageKey(itemId));
}

/**
 * Whether a source appears in a match, which makes the match one of the source's habits:
 * - the weapon and the melee always do;
 * - an ability does when it was unlocked;
 * - an item does when the player owned it, whether or not it dealt damage;
 * - any other source does when it dealt damage.
 *
 * @param match - The reading of the match.
 * @param source - The source.
 * @returns Whether the source appears in the match.
 */
function appearsIn(match: MatchReading, source: Source): boolean {
  switch (source.kind) {
    case 'weapon':
    case 'melee':
      return true;
    case 'ability':
      return isUnlockedIn(match, source);
    case 'item':
      return ownedDamageIn(match, source) !== null;
    case 'other':
      return damageOf(match, source.className) !== null;
  }
}

/**
 * The share a source is compared on in a match (see {@link DamageSourceRow.comparedShare}).
 *
 * @param match - The reading of the match.
 * @param source - The source.
 * @returns The share, or `null` when the match does not give one.
 */
function comparedShareIn(match: MatchReading, source: Source): number | null {
  const damage = damageOf(match, source.className) ?? 0;
  if (source.kind === 'item') {
    const owned = ownedDamageIn(match, source);
    // The damage while owned is interpolated, so the item can seem to deal more than all of it.
    return owned !== null && owned > 0 ? Math.min(1, damage / owned) : null;
  }
  return match.totalDamage > 0 ? damage / match.totalDamage : null;
}

/**
 * Tell whether a share is above or below the usual one.
 *
 * A share is flagged only when it is at least {@link DAMAGE_SHARE_MIN_GAP} away from the usual one:
 * a smaller difference is not worth showing, however steady the habit is (a source that always
 * deals 3 % has a tiny spread, and 3.5 % is many deviations away). On top of that, when the habit
 * varies, the robust z-score must be at least {@link STRONG_Z} either way. When it does not vary
 * (`z` is `null`), the gap alone decides.
 *
 * @param z - The robust z-score, `null` when the habit does not vary.
 * @param gap - The share minus the usual one.
 * @returns The flag, in the direction of the gap.
 */
function flagOf(z: number | null, gap: number): 'above' | 'below' | null {
  if (Math.abs(gap) + GAP_TOLERANCE < DAMAGE_SHARE_MIN_GAP) {
    return null;
  }
  if (z !== null && Math.abs(z) < STRONG_Z) {
    return null;
  }
  // The z-score has the sign of the gap (the spread is above 0), so the gap gives the direction.
  return gap > 0 ? 'above' : 'below';
}

/**
 * Compare the share of a source with its habit.
 *
 * @param source - The source.
 * @param comparedShare - The share the source is compared on in the match, or `null` for none.
 * @param previous - The earlier matches, the newest first.
 * @returns The habit, the gap and the flag; all `null` when there is nothing to compare or too few
 *   earlier matches.
 */
function compareWithHabit(
  source: Source,
  comparedShare: number | null,
  previous: readonly MatchReading[],
): Pick<DamageSourceRow, 'habit' | 'gap' | 'flag'> {
  const none = { habit: null, gap: null, flag: null };
  if (comparedShare === null) {
    return none;
  }
  // The most recent matches where the source appears and gives a share, up to the habit's window.
  const earlierShares = previous
    .filter((match) => appearsIn(match, source))
    .map((match) => comparedShareIn(match, source))
    .filter((share) => share !== null)
    .slice(0, PERSONAL_WINDOW);
  const comparison = comparePersonal({
    value: comparedShare,
    previous: earlierShares,
    display: 'absolute',
    scale: 1,
  });
  if (comparison === null) {
    return none;
  }
  const gap = comparedShare - comparison.median;
  return {
    habit: { median: comparison.median, count: comparison.count },
    gap,
    flag: flagOf(comparison.z, gap),
  };
}

/**
 * Build the line of a source.
 *
 * @param source - The source.
 * @param current - The reading of the match.
 * @param previous - The earlier matches, the newest first.
 * @returns The line.
 */
function buildRow(
  source: Source,
  current: MatchReading,
  previous: readonly MatchReading[],
): DamageSourceRow {
  const damage = damageOf(current, source.className) ?? 0;
  // An ability that is not unlocked has nothing to compare with the habit.
  const unlocked = source.kind !== 'ability' || isUnlockedIn(current, source);
  const comparedShare = unlocked ? comparedShareIn(current, source) : null;
  return {
    className: source.className,
    kind: source.kind,
    itemId: source.entry?.id ?? null,
    name: source.entry?.name ?? readableSourceName(source.className),
    imageUrl: source.entry?.imageUrl ?? null,
    damage,
    share: current.totalDamage > 0 ? damage / current.totalDamage : 0,
    comparedShare,
    ...compareWithHabit(source, comparedShare, previous),
    unlocked,
  };
}

/**
 * Order two lines by share, the largest first, then by class name.
 *
 * @param first - A line.
 * @param second - Another line, of a different source.
 * @returns A negative number when `first` comes first.
 */
function byShareThenClassName(first: DamageSourceRow, second: DamageSourceRow): number {
  if (first.share !== second.share) {
    return second.share - first.share;
  }
  return first.className < second.className ? -1 : 1;
}

/**
 * Build the damage breakdown of a match.
 *
 * The lines are:
 * - every source that dealt damage in the match;
 * - the weapon and the melee, always (at 0 % when unused);
 * - each signature ability that dealt damage in an earlier match where it was unlocked, even if it
 *   did not in this one (an ability that never deals damage, like Plot Armor, never shows).
 *
 * An ability that was not unlocked in the match is listed as such, with no comparison. The unlock
 * is read from the ability's id in the catalogue; an ability the catalogue does not know cannot be
 * checked, and counts as unlocked.
 *
 * @param input - The values of the match and of the earlier ones, the loadout and the catalogue.
 * @returns The breakdown, or `null` when the match holds no known damage by source: the player dealt
 *   no damage to heroes (the projection writes no `damage_source.` key then), the archive had no
 *   damage matrix, or the match is not projected yet.
 */
export function buildDamageBreakdown(input: DamageBreakdownInput): DamageBreakdown | null {
  const { loadout, itemsByClassName } = input;
  const current = readMatch(input.current);
  if (current.sourceNames.length === 0) {
    return null;
  }
  const previous = input.previous.map(readMatch);
  const describe = (className: string): Source =>
    describeSource(className, loadout, itemsByClassName);

  // The sources to list: the weapon and the melee, the sources with damage, and the abilities that
  // dealt damage in an earlier match where they were unlocked.
  const listed = new Set([
    loadout.weapon,
    loadout.melee,
    ...current.sourceNames.filter((className) => (damageOf(current, className) ?? 0) > 0),
  ]);
  for (const className of loadout.abilities) {
    const ability = describe(className);
    if (
      previous.some(
        (match) => isUnlockedIn(match, ability) && (damageOf(match, className) ?? 0) > 0,
      )
    ) {
      listed.add(className);
    }
  }

  const rows = [...listed].map((className) => buildRow(describe(className), current, previous));
  const unlocked = rows.filter((row) => row.unlocked).toSorted(byShareThenClassName);
  // Only an ability can be locked: those go last, in the order of the loadout.
  const locked = rows
    .filter((row) => !row.unlocked)
    .toSorted(
      (first, second) =>
        loadout.abilities.indexOf(first.className) - loadout.abilities.indexOf(second.className),
    );
  return { totalDamage: current.totalDamage, rows: [...unlocked, ...locked] };
}

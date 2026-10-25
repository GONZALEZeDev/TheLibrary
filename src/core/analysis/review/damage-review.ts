/**
 * The damage the player dealt to enemy heroes, by source, over a window of matches and over the
 * window before it: what share of the damage each source dealt, now and before, so that the review
 * shows how the player's damage moved from one source to another.
 *
 * It works from the values stored for each match (see `../damage-sources`), the hero's loadout and
 * the item catalogue, as the damage tab of the match page does, and it reads and classifies the
 * sources with the same functions (see `../damage-breakdown`): a source is a weapon, a melee, an
 * ability, an item or an other source here exactly when it is one there.
 *
 * - A share is **pooled**: the damage a source dealt over all the matches of the window, over all the
 *   damage of the window. It is not the mean of the shares of the matches, which would give a match
 *   of little damage the weight of a match of much.
 * - The stored damage of a source already holds its critical hits: the projection merges them into
 *   the source before it stores the damage.
 * - The sources of both windows are listed, so that a source the player stopped using shows with a
 *   share of 0 now.
 * - A window that dealt no damage at all has no share, rather than shares of 0: there is nothing to
 *   share. Nor does a window before of fewer than `MIN_PERSONAL_MATCHES` matches, like every figure of
 *   the review made of so few: the progress of the review is not measured against it either.
 *
 * @packageDocumentation
 */
import type { CatalogueItem } from '../../deadlock-api/assets.schema';
import type { HeroLoadout } from '../../domain/hero';
import {
  byClassName,
  damageOf,
  describeSource,
  readMatch,
  sourceIdentityOf,
} from '../damage-breakdown';
import type { DamageSourceRow, StoredValues } from '../damage-breakdown';
import { MIN_PERSONAL_MATCHES } from '../insights/thresholds';

/** What the damage shares need to be built. */
export interface DamageSharesInput {
  /** The values stored for each match of the window being reviewed. */
  readonly now: readonly StoredValues[];
  /** The values stored for each match of the window before it. */
  readonly before: readonly StoredValues[];
  /** The hero's weapon, melee and four signature abilities, by class name. */
  readonly loadout: HeroLoadout;
  /** The item catalogue by class name, which is how the damage rows name their source. */
  readonly itemsByClassName: ReadonlyMap<string, CatalogueItem>;
}

/**
 * One line of the review: a damage source, described as in the damage tab of a match, and its share
 * of the damage, now and before.
 */
export interface DamageShareRow extends Pick<
  DamageSourceRow,
  'className' | 'kind' | 'itemId' | 'name' | 'imageUrl'
> {
  /**
   * The share of the window's damage that the source dealt, from 0 to 1: its damage over all the
   * matches of the window, over all the damage of the window (0 for a source that dealt none). `null`
   * when the window dealt no damage at all: there is nothing to share.
   */
  readonly shareNow: number | null;
  /**
   * The same share over the window before, from 0 to 1, or `null` when that window dealt no damage
   * at all (there is nothing to share, so no share to compare with) or holds fewer than
   * {@link MIN_PERSONAL_MATCHES} matches (a share of so few says little).
   */
  readonly shareBefore: number | null;
  /** In how many matches of the window the source dealt damage. */
  readonly appearsNow: number;
  /** In how many matches of the window before the source dealt damage. */
  readonly appearsBefore: number;
}

/** What one source dealt over a window. */
interface SourceTotal {
  /** The damage the source dealt in all the matches of the window. */
  damage: number;
  /** In how many matches of the window it dealt damage. */
  matches: number;
}

/** The damage of a window of matches, pooled. */
interface PooledWindow {
  /** The damage of all the sources in all the matches of the window. */
  readonly totalDamage: number;
  /** The sources that dealt damage in the window, by class name. */
  readonly sources: ReadonlyMap<string, SourceTotal>;
}

/**
 * Pool the damage of a window of matches.
 *
 * @param window - The values stored for each match of the window.
 * @returns The damage of the window, in all and by source. A source is in it as soon as it dealt
 *   damage in one match; a match without damage by source adds nothing.
 */
function poolWindow(window: readonly StoredValues[]): PooledWindow {
  const sources = new Map<string, SourceTotal>();
  let totalDamage = 0;
  for (const values of window) {
    const match = readMatch(values);
    totalDamage += match.totalDamage;
    for (const className of match.sourceNames) {
      const damage = damageOf(match, className) ?? 0;
      // A source that dealt nothing in a match did not appear in it.
      if (damage > 0) {
        const total = sources.get(className) ?? { damage: 0, matches: 0 };
        total.damage += damage;
        total.matches += 1;
        sources.set(className, total);
      }
    }
  }
  return { totalDamage, sources };
}

/**
 * The share of a window's damage that a source dealt.
 *
 * @param damage - The damage the source dealt in the window.
 * @param window - The window.
 * @returns The share, or `null` when the window dealt no damage.
 */
function shareIn(damage: number, window: PooledWindow): number | null {
  return window.totalDamage > 0 ? damage / window.totalDamage : null;
}

/**
 * Order two lines by share now, the largest first, then by share before the same way, then by class
 * name. The shares of a window are all known or all `null`, so a missing one never has to be compared
 * with a known one.
 *
 * @param first - A line.
 * @param second - Another line, of a different source.
 * @returns A negative number when `first` comes first.
 */
function byShareNowThenBeforeThenClassName(first: DamageShareRow, second: DamageShareRow): number {
  const firstNow = first.shareNow ?? 0;
  const secondNow = second.shareNow ?? 0;
  if (firstNow !== secondNow) {
    return secondNow - firstNow;
  }
  const firstBefore = first.shareBefore ?? 0;
  const secondBefore = second.shareBefore ?? 0;
  if (firstBefore !== secondBefore) {
    return secondBefore - firstBefore;
  }
  return byClassName(first, second);
}

/**
 * Work out each damage source's share of the damage over a window of matches and over the window
 * before it.
 *
 * There is a line for every source that dealt damage in either window, classified and named as in the
 * match page. The lines are sorted by share now, the largest first, then by share before, then by
 * class name.
 *
 * @param input - The values of the matches of both windows, the loadout and the catalogue.
 * @returns The lines; none when neither window dealt any damage by source.
 */
export function damageShares(input: DamageSharesInput): readonly DamageShareRow[] {
  const now = poolWindow(input.now);
  const before = poolWindow(input.before);
  // A window before of too few matches gives no share at all, whatever damage it holds.
  const beforeShared = input.before.length >= MIN_PERSONAL_MATCHES;

  // A source that was used in one window only still has a line, with nothing in the other.
  const classNames = new Set([...now.sources.keys(), ...before.sources.keys()]);
  const rows = [...classNames].map((className): DamageShareRow => {
    const source = describeSource(className, input.loadout, input.itemsByClassName);
    const nowTotal = now.sources.get(className);
    const beforeTotal = before.sources.get(className);
    return {
      className,
      kind: source.kind,
      ...sourceIdentityOf(source),
      shareNow: shareIn(nowTotal?.damage ?? 0, now),
      shareBefore: beforeShared ? shareIn(beforeTotal?.damage ?? 0, before) : null,
      appearsNow: nowTotal?.matches ?? 0,
      appearsBefore: beforeTotal?.matches ?? 0,
    };
  });
  return rows.toSorted(byShareNowThenBeforeThenClassName);
}

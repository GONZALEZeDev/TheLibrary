/**
 * The review values the projection stores for a match: how many times the player died in each
 * phase, when they first bought each shop item and how many times they had died by then, the place
 * they took among the twelve players on each figure of the scoreboard, and Valve's top three.
 *
 * They are plain numbers, stored one per key in the match's metrics, so that a later view can
 * compare the matches with each other and with the community without opening the archives again.
 * There are five families of keys, each with its own prefix, and one key apart:
 * - `phase_deaths.<phase>`: the deaths of the player in the phase as played (all deaths, whoever or
 *   whatever caused them);
 * - `phase_deaths.<phase>.community_window`: their deaths over the stretch of the phase that the
 *   community data of the match's duration window covers, which is what the community average is
 *   read on;
 * - `item_bought_at.<item id>`: the second a shop item was first bought;
 * - `deaths_before_item.<item id>`: the deaths of the player before that purchase;
 * - `scoreboard_place.<figure>` and `scoreboard_place_of.<figure>`: the place of the player on a
 *   figure of the scoreboard (1 for the best), and how many players have that figure;
 * - `valve_rank`: the place of the player in Valve's top three of the match, or `0` outside it.
 *
 * A value that is not known is not written, and never replaced by `0`: the deaths are unknown when
 * the death details of the archive are incomplete, the items when the archive holds none, the
 * places when it holds no scoreboard. A `0` is always a count of nothing, or a player outside the
 * top three.
 *
 * @packageDocumentation
 */
import type { PlaceStat, ScoreboardRead } from '../../match-detail/scoreboard';
import { placesOf } from '../../match-detail/scoreboard';
import type { ItemEntry } from '../../match-detail/tracked-items';
import { communitySpan, durationWindowOf } from '../cohort';
import { phaseSpans } from '../phases';
import type { Phase } from '../phases';
import { COMMUNITY_WINDOW_SUFFIX } from '../registry';

/** The prefix of the keys of the deaths of a phase. */
const PHASE_DEATHS_PREFIX = 'phase_deaths.';

/** The prefix of the keys of the time a shop item was first bought. */
const ITEM_BOUGHT_AT_PREFIX = 'item_bought_at.';

/** The prefix of the keys of the deaths before the first purchase of a shop item. */
const DEATHS_BEFORE_ITEM_PREFIX = 'deaths_before_item.';

/** The prefix of the keys of the place of the player on a figure of the scoreboard. */
const SCOREBOARD_PLACE_PREFIX = 'scoreboard_place.';

/** The prefix of the keys of the number of players that have a figure of the scoreboard. */
const SCOREBOARD_PLACE_OF_PREFIX = 'scoreboard_place_of.';

/**
 * The key of the place of the player in Valve's top three: `1` to `3`, or `0` when the match has a
 * top three and the player is not in it. It has no prefix, as there is one value only.
 */
export const VALVE_RANK_KEY = 'valve_rank';

/**
 * The prefixes of the five families of keys, dot included, so that no other key can start with one
 * (`phase_deaths_x` does not, and `scoreboard_place_of.` does not start with `scoreboard_place.`).
 * {@link VALVE_RANK_KEY} is a key of its own and has none.
 */
export const REVIEW_KEY_PREFIXES = [
  PHASE_DEATHS_PREFIX,
  ITEM_BOUGHT_AT_PREFIX,
  DEATHS_BEFORE_ITEM_PREFIX,
  SCOREBOARD_PLACE_PREFIX,
  SCOREBOARD_PLACE_OF_PREFIX,
] as const;

/**
 * The key of the deaths of the player in a phase.
 *
 * @param phase - The phase.
 * @returns `phase_deaths.<phase>`.
 */
export function phaseDeathsKey(phase: Phase): string {
  return `${PHASE_DEATHS_PREFIX}${phase}`;
}

/**
 * The key of the deaths of the player over the stretch of a phase that the community data covers.
 *
 * @param phase - The phase.
 * @returns `phase_deaths.<phase>.community_window`.
 */
export function phaseDeathsWindowKey(phase: Phase): string {
  return `${phaseDeathsKey(phase)}${COMMUNITY_WINDOW_SUFFIX}`;
}

/**
 * The key of the time a shop item was first bought.
 *
 * @param itemId - The asset id of the shop item.
 * @returns `item_bought_at.<item id>`.
 */
export function itemBoughtAtKey(itemId: number): string {
  return `${ITEM_BOUGHT_AT_PREFIX}${String(itemId)}`;
}

/**
 * The key of the deaths of the player before the first purchase of a shop item.
 *
 * @param itemId - The asset id of the shop item.
 * @returns `deaths_before_item.<item id>`.
 */
export function deathsBeforeItemKey(itemId: number): string {
  return `${DEATHS_BEFORE_ITEM_PREFIX}${String(itemId)}`;
}

/**
 * The key of the place of the player on a figure of the scoreboard.
 *
 * @param stat - The figure.
 * @returns `scoreboard_place.<figure>`.
 */
export function scoreboardPlaceKey(stat: PlaceStat): string {
  return `${SCOREBOARD_PLACE_PREFIX}${stat}`;
}

/**
 * The key of the number of players that have a figure of the scoreboard (the player included),
 * which the place on that figure is out of.
 *
 * @param stat - The figure.
 * @returns `scoreboard_place_of.<figure>`.
 */
export function scoreboardPlaceOfKey(stat: PlaceStat): string {
  return `${SCOREBOARD_PLACE_OF_PREFIX}${stat}`;
}

/** What the review values of a match are worked out from. */
export interface ReviewValuesInput {
  /** The length of the match, in seconds. */
  readonly durationS: number;
  /**
   * When the tracked player died, in seconds since the start of the match, in any order; `null`
   * when the archive does not tell them all (see `readTrackedDeathTimes`).
   */
  readonly deathTimesS: readonly number[] | null;
  /**
   * The entries of the tracked player's items (shop items, ability unlocks and upgrades); `null`
   * when they are not known.
   */
  readonly items: readonly ItemEntry[] | null;
  /** The scoreboard of the match; `null` when it is not known. */
  readonly scoreboard: ScoreboardRead | null;
}

/** One value to store, as a key and its number. */
type ValueEntry = readonly [key: string, value: number];

/**
 * The number of deaths in a window of the match.
 *
 * The window starts at `startS` (included) and ends at `endS` (excluded), so that consecutive
 * windows never count a death twice. The exception is the window that ends with the match
 * (`endS === durationS`): a death in the very last second belongs to nothing else, so it is counted.
 * It is the rule `killsIn` applies to kills.
 *
 * @param deathTimesS - When the player died, in any order.
 * @param startS - The start of the window, in seconds since the start of the match.
 * @param endS - The end of the window, in seconds since the start of the match.
 * @param durationS - The length of the match, in seconds.
 * @returns The number of deaths of the window.
 */
function deathsIn(
  deathTimesS: readonly number[],
  startS: number,
  endS: number,
  durationS: number,
): number {
  const endsWithMatch = endS === durationS;
  return deathTimesS.filter(
    (timeS) => timeS >= startS && (endsWithMatch ? timeS <= endS : timeS < endS),
  ).length;
}

/**
 * The deaths of each phase, over the phase and over the stretch the community data covers.
 *
 * @param durationS - The length of the match, in seconds.
 * @param deathTimesS - When the player died, in any order.
 * @returns The entries to store, in the order of the match. A phase the match does not reach, or
 *   too short to compare, has none; a stretch the community data covers too little of has no
 *   `community_window` entry.
 */
function phaseDeathEntries(
  durationS: number,
  deathTimesS: readonly number[],
): readonly ValueEntry[] {
  const window = durationWindowOf(durationS);
  return phaseSpans(durationS)
    .filter((span) => span.comparable)
    .flatMap((span) => {
      const entries: ValueEntry[] = [
        [phaseDeathsKey(span.phase), deathsIn(deathTimesS, span.startS, span.endS, durationS)],
      ];
      const stretch = communitySpan(span, window);
      if (stretch !== null) {
        entries.push([
          phaseDeathsWindowKey(span.phase),
          deathsIn(deathTimesS, stretch.startS, stretch.endS, durationS),
        ]);
      }
      return entries;
    });
}

/**
 * The first purchase of each shop item, and the deaths before it.
 *
 * @param items - The entries of the player's items, in any order.
 * @param deathTimesS - When the player died, in any order; `null` when it is not known.
 * @returns The entries to store. An ability unlock or upgrade has none, and a shop item that was
 *   bought several times (bought, sold, bought again) is the time of its first purchase. The
 *   deaths before it are left out when the deaths are not known.
 */
function itemEntries(
  items: readonly ItemEntry[],
  deathTimesS: readonly number[] | null,
): readonly ValueEntry[] {
  const firstBoughtAtS = new Map<number, number>();
  for (const item of items) {
    if (item.isShopItem) {
      firstBoughtAtS.set(
        item.itemId,
        Math.min(firstBoughtAtS.get(item.itemId) ?? item.timeS, item.timeS),
      );
    }
  }
  const entries: ValueEntry[] = [];
  for (const [itemId, boughtAtS] of firstBoughtAtS) {
    entries.push([itemBoughtAtKey(itemId), boughtAtS]);
    if (deathTimesS !== null) {
      // A death at the very second of the purchase is not before it.
      entries.push([
        deathsBeforeItemKey(itemId),
        deathTimesS.filter((timeS) => timeS < boughtAtS).length,
      ]);
    }
  }
  return entries;
}

/**
 * The places of the tracked player on the scoreboard, and their place in Valve's top three.
 *
 * @param scoreboard - The scoreboard of the match.
 * @returns The entries to store. A figure the player has no value for has no place (see
 *   `placesOf`). The rank in the top three is the player's, `0` when another player has one and
 *   they have none. It is left out when nobody has one (the match has no top three) and when the
 *   scoreboard does not hold the player: `0` only ever says that the player is not in a top three.
 */
function scoreboardEntries(scoreboard: ScoreboardRead): readonly ValueEntry[] {
  const entries: ValueEntry[] = placesOf(scoreboard).flatMap(
    ({ stat, place, of }): ValueEntry[] => [
      [scoreboardPlaceKey(stat), place],
      [scoreboardPlaceOfKey(stat), of],
    ],
  );
  const tracked = scoreboard.players.find((player) => player.slot === scoreboard.trackedSlot);
  if (tracked !== undefined && scoreboard.players.some((player) => player.mvpRank !== null)) {
    entries.push([VALVE_RANK_KEY, tracked.mvpRank ?? 0]);
  }
  return entries;
}

/**
 * Compute the review values to store for a match.
 *
 * Four kinds of values, see the module's description:
 * - the deaths of each phase the match reached and that lasts long enough to compare (see
 *   `PhaseSpan.comparable`), over the phase and, when the community data covers enough of it, over
 *   the stretch it covers (`communitySpan`);
 * - the first purchase of each shop item and the deaths before it;
 * - the place of the tracked player on each figure of the scoreboard, and how many players have it;
 * - their place in Valve's top three.
 *
 * Each kind is written when its input is known, whatever the others are: a match whose death
 * details are incomplete still has its items and its places.
 *
 * @param input - What the values are worked out from, see {@link ReviewValuesInput}.
 * @returns The values by key; empty when nothing is known.
 */
export function projectReviewValues(input: ReviewValuesInput): ReadonlyMap<string, number> {
  const { durationS, deathTimesS, items, scoreboard } = input;
  return new Map([
    ...(deathTimesS === null ? [] : phaseDeathEntries(durationS, deathTimesS)),
    ...(items === null ? [] : itemEntries(items, deathTimesS)),
    ...(scoreboard === null ? [] : scoreboardEntries(scoreboard)),
  ]);
}

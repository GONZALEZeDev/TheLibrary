/**
 * Tests of the review values of a match.
 *
 * The inputs are built by hand: a few death times, the entries of the tracked player's items and a
 * scoreboard of twelve players whose figures depend on their slot. Every figure the tests expect is
 * worked out in a comment from those inputs, so that a reader can check it without running anything.
 * Nothing here comes from a real match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { ScoreboardPlayer, ScoreboardRead } from '../../match-detail/scoreboard';
import { SCOREBOARD_PLACE_STATS } from '../../match-detail/scoreboard';
import type { ItemEntry } from '../../match-detail/tracked-items';
import {
  DAMAGE_KEY_PREFIXES,
  abilityUnlockKey,
  damageSourceKey,
  itemOwnedDamageKey,
} from '../damage-sources';
import { PHASES } from '../phases';
import { METRICS, communityWindowKey } from '../registry';
import {
  REVIEW_KEY_PREFIXES,
  VALVE_RANK_KEY,
  deathsBeforeItemKey,
  itemBoughtAtKey,
  phaseDeathsKey,
  phaseDeathsWindowKey,
  projectReviewValues,
  scoreboardPlaceKey,
  scoreboardPlaceOfKey,
} from './review-values';
import type { ReviewValuesInput } from './review-values';

/** The slot of the tracked player on the scoreboards of the tests. */
const TRACKED_SLOT = 9;

/** The asset ids of the items and abilities of the tests (synthetic). */
const FIRST_ITEM_ID = 9_001;
const SECOND_ITEM_ID = 9_002;
const ABILITY_ID = 7_001;

/**
 * A shop item of the tracked player.
 *
 * @param itemId - The asset id of the item.
 * @param boughtAtS - When it was bought, in seconds.
 * @param soldAtS - When it left the inventory, or `null` when it was kept to the end.
 * @returns The entry.
 */
function shopItem(itemId: number, boughtAtS: number, soldAtS: number | null = null): ItemEntry {
  return { itemId, timeS: boughtAtS, soldAtS, isShopItem: true, imbuedAbilityId: null };
}

/**
 * An entry of one of the hero's abilities (an unlock or an upgrade: the projection does not tell).
 *
 * @param abilityId - The asset id of the ability.
 * @param timeS - When the entry was made, in seconds.
 * @returns The entry.
 */
function abilityEntry(abilityId: number, timeS: number): ItemEntry {
  return { itemId: abilityId, timeS, soldAtS: null, isShopItem: false, imbuedAbilityId: null };
}

/**
 * A scoreboard of twelve players whose figures depend on their slot (a higher slot is better on
 * every figure, so that a mix-up of players shows in the places), with nobody in the top three.
 *
 * @param fieldsBySlot - Fields to change, by slot.
 * @returns The scoreboard; the tracked player is the one of {@link TRACKED_SLOT}.
 */
function scoreboardOf(
  fieldsBySlot: Readonly<Record<number, Partial<ScoreboardPlayer>>> = {},
): ScoreboardRead {
  const players = Array.from({ length: 12 }, (_, index): ScoreboardPlayer => {
    const slot = index + 1;
    return {
      slot,
      team: slot <= 6 ? 0 : 1,
      heroId: 100 + slot,
      kills: 0,
      deaths: 0,
      assists: 0,
      netWorth: 1_000 * slot,
      lastHits: 50 + slot,
      denies: 0,
      heroDamage: 100 * slot,
      objectiveDamage: 10 * slot,
      support: slot,
      mvpRank: null,
      badge: null,
      ...fieldsBySlot[slot],
    };
  });
  return { trackedSlot: TRACKED_SLOT, winningTeam: 1, ranked: true, players };
}

/**
 * The input of a projection: a 40-minute match that holds nothing else than what a test gives.
 *
 * @param overrides - Fields to change.
 * @returns The input.
 */
function input(overrides: Partial<ReviewValuesInput> = {}): ReviewValuesInput {
  return { durationS: 2_400, deathTimesS: null, items: null, scoreboard: null, ...overrides };
}

/**
 * The values of one family of keys, as a plain object to compare.
 *
 * @param values - The projected values.
 * @param prefix - The start of the keys to keep.
 * @returns The values by key.
 */
function valuesWith(values: ReadonlyMap<string, number>, prefix: string): Record<string, number> {
  return Object.fromEntries([...values].filter(([key]) => key.startsWith(prefix)));
}

describe('the keys of the review values', () => {
  it('builds the key families', () => {
    expect(phaseDeathsKey('early')).toBe('phase_deaths.early');
    expect(phaseDeathsWindowKey('late')).toBe('phase_deaths.late.community_window');
    expect(itemBoughtAtKey(FIRST_ITEM_ID)).toBe('item_bought_at.9001');
    expect(deathsBeforeItemKey(FIRST_ITEM_ID)).toBe('deaths_before_item.9001');
    expect(scoreboardPlaceKey('netWorth')).toBe('scoreboard_place.netWorth');
    expect(scoreboardPlaceOfKey('lastHits')).toBe('scoreboard_place_of.lastHits');
    expect(VALVE_RANK_KEY).toBe('valve_rank');
  });

  it('lists the prefixes every key but the rank starts with', () => {
    expect(REVIEW_KEY_PREFIXES).toEqual([
      'phase_deaths.',
      'item_bought_at.',
      'deaths_before_item.',
      'scoreboard_place.',
      'scoreboard_place_of.',
    ]);
    const keys = [
      ...PHASES.flatMap((phase) => [phaseDeathsKey(phase), phaseDeathsWindowKey(phase)]),
      itemBoughtAtKey(FIRST_ITEM_ID),
      deathsBeforeItemKey(FIRST_ITEM_ID),
      ...SCOREBOARD_PLACE_STATS.flatMap((stat) => [
        scoreboardPlaceKey(stat),
        scoreboardPlaceOfKey(stat),
      ]),
    ];
    // One family each: `scoreboard_place_of.` is not taken for `scoreboard_place.`.
    for (const key of keys) {
      expect(REVIEW_KEY_PREFIXES.filter((prefix) => key.startsWith(prefix))).toHaveLength(1);
    }
    expect(REVIEW_KEY_PREFIXES.some((prefix) => VALVE_RANK_KEY.startsWith(prefix))).toBe(false);
  });
});

describe('projectReviewValues', () => {
  describe('the deaths of each phase', () => {
    it('counts the deaths of each phase as played', () => {
      // The phases of a 2 400 s match are [0, 600), [600, 1 500) and [1 500, 2 400], the last one
      // including the end of the match: 30 and 590 are early, 600 and 1 499 mid, 1 500 and 2 400 late.
      const values = projectReviewValues(
        input({ durationS: 2_400, deathTimesS: [30, 590, 600, 1_499, 1_500, 2_400] }),
      );

      expect(values.get(phaseDeathsKey('early'))).toBe(2);
      expect(values.get(phaseDeathsKey('mid'))).toBe(2);
      expect(values.get(phaseDeathsKey('late'))).toBe(2);
    });

    it('does not rely on the death times being sorted', () => {
      const values = projectReviewValues(input({ deathTimesS: [1_500, 30, 600, 590] }));

      expect(valuesWith(values, 'phase_deaths.')).toMatchObject({
        'phase_deaths.early': 2,
        'phase_deaths.mid': 1,
        'phase_deaths.late': 1,
      });
    });

    it('counts the deaths within the community stretch', () => {
      // The window of a 2 400 s match is 2 400 to 2 699 s, which every match of it reaches until
      // 2 400 s: the stretch of the late game runs from 1 500 to 2 400 s, the end of the match, so
      // a death at 2 400 s is in it. The early and the mid games are covered whole.
      const values = projectReviewValues(
        input({ durationS: 2_400, deathTimesS: [30, 590, 600, 1_499, 1_500, 2_400] }),
      );

      expect(valuesWith(values, 'phase_deaths.')).toEqual({
        'phase_deaths.early': 2,
        'phase_deaths.early.community_window': 2,
        'phase_deaths.mid': 2,
        'phase_deaths.mid.community_window': 2,
        'phase_deaths.late': 2,
        'phase_deaths.late.community_window': 2,
      });
    });

    it('stops the community stretch at the shortest match of the window', () => {
      // A 2 500 s match is in the same window (2 400 to 2 699 s). Its late game runs from 1 500 to
      // 2 500 s: the deaths at 1 500, 2 400, 2 450 and 2 500 s are all in it, the last one being at
      // the end of the match. The stretch stops at 2 400 s, which is not the end of the match, so
      // it holds the death at 1 500 s only.
      const values = projectReviewValues(
        input({ durationS: 2_500, deathTimesS: [1_500, 2_400, 2_450, 2_500] }),
      );

      expect(values.get(phaseDeathsKey('late'))).toBe(4);
      expect(values.get(phaseDeathsWindowKey('late'))).toBe(1);
    });

    it('writes no community stretch where the community data covers too little of the phase', () => {
      // A 1 700 s match has a late game of 200 s (3.3 minutes, enough to compare), but its window
      // starts at 1 500 s: the community data covers none of the late game.
      const values = projectReviewValues(input({ durationS: 1_700, deathTimesS: [100, 1_550] }));

      expect(values.get(phaseDeathsKey('late'))).toBe(1);
      expect(values.has(phaseDeathsWindowKey('late'))).toBe(false);
      expect(values.get(phaseDeathsKey('mid'))).toBe(0);
    });

    it('writes no death keys when the death details are incomplete', () => {
      const values = projectReviewValues(
        input({
          deathTimesS: null,
          items: [shopItem(FIRST_ITEM_ID, 300)],
          scoreboard: scoreboardOf(),
        }),
      );

      // The deaths are unknown, never 0; what does not depend on them is still written.
      expect(valuesWith(values, 'phase_deaths.')).toEqual({});
      expect(valuesWith(values, 'deaths_before_item.')).toEqual({});
      expect(valuesWith(values, 'item_bought_at.')).toEqual({ 'item_bought_at.9001': 300 });
      // The tracked player (slot 9) is behind the players of slots 10 to 12 on every figure.
      expect(valuesWith(values, 'scoreboard_place.')).toEqual({
        'scoreboard_place.netWorth': 4,
        'scoreboard_place.heroDamage': 4,
        'scoreboard_place.objectiveDamage': 4,
        'scoreboard_place.support': 4,
        'scoreboard_place.lastHits': 4,
      });
    });

    it('writes no key for a phase too short to compare', () => {
      // The late game of a 1 600 s match lasts 100 s, under the three minutes a phase needs.
      const values = projectReviewValues(
        input({ durationS: 1_600, deathTimesS: [100, 700, 1_550] }),
      );

      // The window of the match starts at 1 500 s, where the mid game ends: both are covered whole.
      expect(valuesWith(values, 'phase_deaths.')).toEqual({
        'phase_deaths.early': 1,
        'phase_deaths.early.community_window': 1,
        'phase_deaths.mid': 1,
        'phase_deaths.mid.community_window': 1,
      });
    });

    it('writes a zero for a phase in which the player did not die', () => {
      const values = projectReviewValues(input({ deathTimesS: [] }));

      expect(valuesWith(values, 'phase_deaths.')).toMatchObject({
        'phase_deaths.early': 0,
        'phase_deaths.mid': 0,
        'phase_deaths.late': 0,
      });
    });
  });

  describe('the shop items', () => {
    it('writes the first purchase of each shop item and the deaths before it', () => {
      // The first item is bought at 300 s, sold at 500 s and bought again at 800 s: it counts once,
      // at its first purchase. The entries are not in time order. The second item is bought at 650 s:
      // the death at 650 s is not before it.
      const values = projectReviewValues(
        input({
          deathTimesS: [100, 250, 400, 650, 900],
          items: [
            shopItem(FIRST_ITEM_ID, 800),
            shopItem(SECOND_ITEM_ID, 650),
            shopItem(FIRST_ITEM_ID, 300, 500),
          ],
        }),
      );

      expect(valuesWith(values, 'item_bought_at.')).toEqual({
        'item_bought_at.9001': 300,
        'item_bought_at.9002': 650,
      });
      // Before 300 s: the deaths at 100 and 250 s. Before 650 s: those at 100, 250 and 400 s.
      expect(valuesWith(values, 'deaths_before_item.')).toEqual({
        'deaths_before_item.9001': 2,
        'deaths_before_item.9002': 3,
      });
    });

    it('writes a zero for an item bought before the first death', () => {
      const values = projectReviewValues(
        input({ deathTimesS: [500], items: [shopItem(FIRST_ITEM_ID, 120)] }),
      );

      expect(values.get(deathsBeforeItemKey(FIRST_ITEM_ID))).toBe(0);
    });

    it('ignores ability unlocks and upgrades', () => {
      const values = projectReviewValues(
        input({
          deathTimesS: [100],
          items: [
            abilityEntry(ABILITY_ID, 60),
            abilityEntry(ABILITY_ID, 700),
            shopItem(FIRST_ITEM_ID, 300),
          ],
        }),
      );

      expect(valuesWith(values, 'item_bought_at.')).toEqual({ 'item_bought_at.9001': 300 });
      expect(valuesWith(values, 'deaths_before_item.')).toEqual({ 'deaths_before_item.9001': 1 });
    });

    it('writes no item key for no items', () => {
      expect(valuesWith(projectReviewValues(input({ items: [] })), 'item_bought_at.')).toEqual({});
      expect(valuesWith(projectReviewValues(input({ items: null })), 'item_bought_at.')).toEqual(
        {},
      );
    });
  });

  describe('the scoreboard', () => {
    it('writes the places and their counts', () => {
      // The tracked player (slot 9) has 9 000 souls (the players of slots 10 to 12 have more: 4th of
      // 12), the most damage to heroes (1st, among the 11 players whose damage is known), no damage to
      // objectives (last of 12), no known support (no place), and as many last hits as the player of
      // slot 12 (62): ties share the best place, so 1st.
      const values = projectReviewValues(
        input({
          scoreboard: scoreboardOf({
            4: { heroDamage: null },
            [TRACKED_SLOT]: { heroDamage: 5_000, objectiveDamage: 0, support: null, lastHits: 62 },
          }),
        }),
      );

      expect(Object.fromEntries(values)).toEqual({
        'scoreboard_place.netWorth': 4,
        'scoreboard_place_of.netWorth': 12,
        'scoreboard_place.heroDamage': 1,
        'scoreboard_place_of.heroDamage': 11,
        'scoreboard_place.objectiveDamage': 12,
        'scoreboard_place_of.objectiveDamage': 12,
        'scoreboard_place.lastHits': 1,
        'scoreboard_place_of.lastHits': 12,
      });
    });

    it("writes the tracked player's rank in the top three, 0 outside it, nothing without one", () => {
      const rankOf = (fieldsBySlot: Readonly<Record<number, Partial<ScoreboardPlayer>>>) =>
        projectReviewValues(input({ scoreboard: scoreboardOf(fieldsBySlot) })).get(VALVE_RANK_KEY);

      // In the top three: their place.
      expect(rankOf({ 3: { mvpRank: 1 }, [TRACKED_SLOT]: { mvpRank: 2 }, 7: { mvpRank: 3 } })).toBe(
        2,
      );
      expect(rankOf({ [TRACKED_SLOT]: { mvpRank: 1 } })).toBe(1);
      // Outside it: the match has a top three, and they are not in it.
      expect(rankOf({ 3: { mvpRank: 1 }, 7: { mvpRank: 2 }, 12: { mvpRank: 3 } })).toBe(0);
      // No top three at all (an older match): not 0, which would say they were left out of it.
      expect(rankOf({})).toBeUndefined();
    });

    it('writes no rank when the scoreboard does not hold the tracked player', () => {
      // Another player is in the top three, but the tracked slot is not on the scoreboard: 0 would
      // say that the tracked player was left out of the top three, which is not known.
      const scoreboard = { ...scoreboardOf({ 3: { mvpRank: 1 } }), trackedSlot: 99 };

      const values = projectReviewValues(input({ scoreboard }));

      expect(values).toEqual(new Map());
    });

    it('writes no scoreboard key without a scoreboard', () => {
      const values = projectReviewValues(input({ deathTimesS: [100], scoreboard: null }));

      expect(values.has(VALVE_RANK_KEY)).toBe(false);
      expect(valuesWith(values, 'scoreboard_place')).toEqual({});
    });
  });

  it('writes nothing for a match that holds nothing', () => {
    expect(projectReviewValues(input())).toEqual(new Map());
  });

  it('writes nothing for a match of no time', () => {
    expect(projectReviewValues(input({ durationS: 0, deathTimesS: [] }))).toEqual(new Map());
  });

  it('never writes a key that overlaps the metric or damage keys', () => {
    // A full projection, and every key the builders can make, so that a family that the projection
    // leaves out of this match is checked as well.
    const projected = projectReviewValues({
      durationS: 2_700,
      deathTimesS: [100, 700, 2_000],
      items: [shopItem(FIRST_ITEM_ID, 300), abilityEntry(ABILITY_ID, 60)],
      scoreboard: scoreboardOf({ [TRACKED_SLOT]: { mvpRank: 1 } }),
    });
    const built = [
      ...PHASES.flatMap((phase) => [phaseDeathsKey(phase), phaseDeathsWindowKey(phase)]),
      itemBoughtAtKey(FIRST_ITEM_ID),
      deathsBeforeItemKey(FIRST_ITEM_ID),
      ...SCOREBOARD_PLACE_STATS.flatMap((stat) => [
        scoreboardPlaceKey(stat),
        scoreboardPlaceOfKey(stat),
      ]),
      VALVE_RANK_KEY,
    ];
    // The keys of the metrics, with their community windows, and the damage keys the damage
    // builders make: the other values of a match's projection.
    const metricKeys = METRICS.flatMap((metric) => [metric.key, communityWindowKey(metric.key)]);
    const damageKeys = [
      damageSourceKey('citadel_weapon_test'),
      itemOwnedDamageKey(FIRST_ITEM_ID),
      abilityUnlockKey(ABILITY_ID),
    ];

    expect(projected.size).toBeGreaterThan(0);
    // No review key is a metric key or starts a family of damage keys...
    for (const key of new Set([...projected.keys(), ...built])) {
      expect(key.startsWith(damageSourceKey('')), key).toBe(false);
      expect(
        DAMAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
        key,
      ).toBe(false);
      expect(metricKeys.includes(key), key).toBe(false);
    }
    // ...and no metric key or damage key is the rank or starts a family of review keys.
    for (const key of [...metricKeys, ...damageKeys]) {
      expect(
        REVIEW_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
        key,
      ).toBe(false);
      expect(key, key).not.toBe(VALVE_RANK_KEY);
    }
  });
});

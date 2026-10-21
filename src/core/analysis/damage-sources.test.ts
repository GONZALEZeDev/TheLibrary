/**
 * Tests of the damage source values.
 *
 * The reads are built by hand: a small time grid, a few cumulative series, the entries of the
 * tracked player's items. Every figure the tests expect is worked out in a comment from the series,
 * so that a reader can check it without running anything. Nothing here comes from a real match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { ItemEntry } from '../match-detail/tracked-items';
import type { DamageMatrixRead } from './damage-matrix';
import {
  abilityUnlockKey,
  DAMAGE_KEY_PREFIXES,
  damageAt,
  damageSourceKey,
  itemOwnedDamageKey,
  projectDamageSources,
} from './damage-sources';

/**
 * The time of each sample, in seconds. The last one is the end of the match (18:00), which is how
 * the matrix is laid out in practice.
 */
const SAMPLES = [180, 360, 540, 720, 900, 1080];

/** The class names of the two sources the tests use: the weapon, and a shop item that deals damage. */
const WEAPON = 'citadel_weapon_bookworm_set2';
const EXPRESS_SHOT = 'upgrade_express_shot';

/**
 * The cumulative damage of the two sources at each sample. The weapon deals damage all along; the
 * item only from the sample at 720 s, the first one after the tests buy it (585 s).
 *
 * The total of the two, which the tests compute their expectations from, is 100, 300, 600, 1 200,
 * 1 900 and 2 600 at the six samples.
 */
const DEFAULT_SOURCES: Readonly<Record<string, readonly number[]>> = {
  [WEAPON]: [100, 300, 600, 1000, 1400, 1800],
  [EXPRESS_SHOT]: [0, 0, 0, 200, 500, 800],
};

/** The asset ids of the items and abilities of the tests (synthetic). */
const EXPRESS_SHOT_ID = 9_001;
const OTHER_ITEM_ID = 9_002;
const FIRST_ABILITY_ID = 7_001;
const SECOND_ABILITY_ID = 7_002;

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
 * A damage matrix read, whose total is the sum of its sources at each sample, as in a real one.
 *
 * @param options - What to change from the defaults: the entries of the items, the series of the
 *   sources by class name, the time grid.
 * @returns The read.
 */
function damageRead(
  options: {
    readonly items?: readonly ItemEntry[];
    readonly sources?: Readonly<Record<string, readonly number[]>>;
    readonly sampleTimesS?: readonly number[];
  } = {},
): DamageMatrixRead {
  const { items = [], sources = DEFAULT_SOURCES, sampleTimesS = SAMPLES } = options;
  const series = Object.values(sources);
  return {
    sampleTimesS,
    sources: new Map(Object.entries(sources)),
    total: sampleTimesS.map((_, position) =>
      series.reduce((sum, values) => sum + (values[position] ?? 0), 0),
    ),
    items,
  };
}

/**
 * The value stored under a key, or a failure when there is none (so that a missing key is read as a
 * failed test rather than as `undefined`).
 *
 * @param values - The projected values.
 * @param key - The key to read.
 * @returns The value.
 */
function valueOf(values: ReadonlyMap<string, number>, key: string): number {
  const value = values.get(key);
  expect(value, `no value under ${key}`).toBeDefined();
  return value ?? Number.NaN;
}

describe('the keys of the damage values', () => {
  it('builds the three key families', () => {
    expect(damageSourceKey(WEAPON)).toBe(`damage_source.${WEAPON}`);
    expect(itemOwnedDamageKey(EXPRESS_SHOT_ID)).toBe('item_owned_damage.9001');
    expect(abilityUnlockKey(FIRST_ABILITY_ID)).toBe('ability_unlocked_at.7001');
  });

  it('lists the prefixes every key starts with', () => {
    expect(DAMAGE_KEY_PREFIXES).toEqual([
      'damage_source.',
      'item_owned_damage.',
      'ability_unlocked_at.',
    ]);
    for (const key of [
      damageSourceKey(WEAPON),
      itemOwnedDamageKey(EXPRESS_SHOT_ID),
      abilityUnlockKey(FIRST_ABILITY_ID),
    ]) {
      expect(DAMAGE_KEY_PREFIXES.filter((prefix) => key.startsWith(prefix))).toHaveLength(1);
    }
  });
});

describe('damageAt', () => {
  it('gives the value of the total at a sample', () => {
    const read = damageRead();
    expect(damageAt(read, 540)).toBeCloseTo(600, 9);
    expect(damageAt(read, 1_080)).toBeCloseTo(2_600, 9);
  });

  it('interpolates linearly between two samples', () => {
    // 585 s is a quarter of the way (45 s of 180 s) from the sample at 540 s (600 damage) to the one
    // at 720 s (1 200): 600 + 0.25 × 600 = 750.
    expect(damageAt(damageRead(), 585)).toBeCloseTo(750, 9);
  });

  it('starts from nothing at the start of the match', () => {
    const read = damageRead();
    // Before the first sample (180 s, 100 damage) the line starts at (0 s, 0): half-way is 50.
    expect(damageAt(read, 90)).toBeCloseTo(50, 9);
    expect(damageAt(read, 0)).toBe(0);
    // A time before the match is no damage rather than a negative one.
    expect(damageAt(read, -30)).toBe(0);
  });

  it('stays at the last sample after it', () => {
    expect(damageAt(damageRead(), 5_000)).toBeCloseTo(2_600, 9);
  });

  it('follows a grid that is not regular', () => {
    // A grid like a real one's, with a missing sample before the end: 1 980 s, 2 160 s, then 2 409 s.
    const read = damageRead({
      sources: { [WEAPON]: [5_000, 6_000, 8_490] },
      sampleTimesS: [1_980, 2_160, 2_409],
    });
    // Half-way (990 s) of the stretch from the implicit (0 s, 0) to the first sample: 5 000 / 2.
    expect(damageAt(read, 990)).toBeCloseTo(2_500, 9);
    // Half-way of the last stretch (2 284.5 s): 6 000 + 0.5 × 2 490 = 7 245.
    expect(damageAt(read, 2_284.5)).toBeCloseTo(7_245, 9);
  });

  it('is nothing for a match without samples', () => {
    expect(damageAt(damageRead({ sources: {}, sampleTimesS: [] }), 600)).toBe(0);
  });
});

describe('projectDamageSources', () => {
  it("stores each source's final damage", () => {
    const values = projectDamageSources(damageRead());
    expect(values.get(damageSourceKey(WEAPON))).toBe(1_800);
    expect(values.get(damageSourceKey(EXPRESS_SHOT))).toBe(800);
  });

  it('stores nothing for a source that dealt no damage to heroes', () => {
    const values = projectDamageSources(
      damageRead({
        sources: { ...DEFAULT_SOURCES, ability_bookworm_aoemagic: [0, 0, 0, 0, 0, 0] },
      }),
    );
    expect(values.has(damageSourceKey('ability_bookworm_aoemagic'))).toBe(false);
    // The sources that did deal damage are still there.
    expect(values.has(damageSourceKey(WEAPON))).toBe(true);
    expect(values.has(damageSourceKey(EXPRESS_SHOT))).toBe(true);
  });

  it('measures the damage dealt while an item was owned', () => {
    const values = projectDamageSources(damageRead({ items: [shopItem(EXPRESS_SHOT_ID, 585)] }));
    // Bought at 585 s, between the samples at 540 s (600) and 720 s (1 200): 750 had been dealt.
    // The item was kept to the end of the match, 1 080 s, when the total was 2 600: 2 600 − 750.
    expect(valueOf(values, itemOwnedDamageKey(EXPRESS_SHOT_ID))).toBeCloseTo(1_850, 9);
  });

  it('ends an owned interval at the sale', () => {
    const values = projectDamageSources(
      damageRead({ items: [shopItem(EXPRESS_SHOT_ID, 585, 900)] }),
    );
    // Sold at 900 s, a sample, when the total was 1 900: 1 900 − 750.
    expect(valueOf(values, itemOwnedDamageKey(EXPRESS_SHOT_ID))).toBeCloseTo(1_150, 9);
  });

  it('interpolates from 0 for a purchase before the first sample', () => {
    const values = projectDamageSources(damageRead({ items: [shopItem(EXPRESS_SHOT_ID, 90)] }));
    // Bought at 90 s, half-way from (0 s, 0) to the sample at 180 s (100): 50 had been dealt.
    // The match ended on 2 600: 2 600 − 50.
    expect(valueOf(values, itemOwnedDamageKey(EXPRESS_SHOT_ID))).toBeCloseTo(2_550, 9);
  });

  it('gives no owned damage to an item bought at the end', () => {
    const values = projectDamageSources(
      damageRead({
        items: [shopItem(EXPRESS_SHOT_ID, 1_080), shopItem(OTHER_ITEM_ID, 1_100)],
      }),
    );
    // Bought on the last sample, or after it (the clock of the purchase may run past the last
    // sample): no damage was dealt while owned, and never a negative one.
    expect(values.get(itemOwnedDamageKey(EXPRESS_SHOT_ID))).toBe(0);
    expect(values.get(itemOwnedDamageKey(OTHER_ITEM_ID))).toBe(0);
  });

  it('adds up the damage of every period an item was owned', () => {
    const values = projectDamageSources(
      damageRead({
        // Owned from 180 s to 360 s, sold, bought again at 540 s and kept.
        items: [shopItem(EXPRESS_SHOT_ID, 180, 360), shopItem(EXPRESS_SHOT_ID, 540)],
      }),
    );
    // First period: 300 − 100 = 200. Second period: 2 600 − 600 = 2 000.
    expect(valueOf(values, itemOwnedDamageKey(EXPRESS_SHOT_ID))).toBeCloseTo(2_200, 9);
  });

  it('counts the damage of overlapping periods once', () => {
    const values = projectDamageSources(
      damageRead({
        // Owned from 180 s to 540 s and from 360 s to 720 s: the item was owned from 180 s to 720 s.
        items: [shopItem(EXPRESS_SHOT_ID, 180, 540), shopItem(EXPRESS_SHOT_ID, 360, 720)],
      }),
    );
    // 1 200 − 100 = 1 100; adding the two periods would count 360 s to 540 s twice (1 400).
    expect(valueOf(values, itemOwnedDamageKey(EXPRESS_SHOT_ID))).toBeCloseTo(1_100, 9);
  });

  it('counts an item that was sold before it was bought as owned for no time', () => {
    const values = projectDamageSources(
      damageRead({ items: [shopItem(EXPRESS_SHOT_ID, 720, 360)] }),
    );
    expect(values.get(itemOwnedDamageKey(EXPRESS_SHOT_ID))).toBe(0);
  });

  it("reads an ability's unlock as its earliest entry, whatever its kind", () => {
    const values = projectDamageSources(
      damageRead({
        // No entry for the unlock itself, and the entries are not in order: the earliest is 400 s.
        items: [
          abilityEntry(FIRST_ABILITY_ID, 700),
          abilityEntry(FIRST_ABILITY_ID, 400),
          abilityEntry(FIRST_ABILITY_ID, 1_000),
          abilityEntry(SECOND_ABILITY_ID, 60),
        ],
      }),
    );
    expect(values.get(abilityUnlockKey(FIRST_ABILITY_ID))).toBe(400);
    expect(values.get(abilityUnlockKey(SECOND_ABILITY_ID))).toBe(60);
  });

  it('keeps shop items and abilities in their own families', () => {
    const values = projectDamageSources(
      damageRead({ items: [shopItem(EXPRESS_SHOT_ID, 585), abilityEntry(FIRST_ABILITY_ID, 400)] }),
    );
    // An ability has no owned damage and a shop item has no unlock time.
    expect(values.has(itemOwnedDamageKey(FIRST_ABILITY_ID))).toBe(false);
    expect(values.has(abilityUnlockKey(EXPRESS_SHOT_ID))).toBe(false);
    expect([...values.keys()].toSorted()).toEqual(
      [
        abilityUnlockKey(FIRST_ABILITY_ID),
        damageSourceKey(EXPRESS_SHOT),
        damageSourceKey(WEAPON),
        itemOwnedDamageKey(EXPRESS_SHOT_ID),
      ].toSorted(),
    );
  });

  it('projects nothing for a match without damage nor items', () => {
    expect(projectDamageSources(damageRead({ sources: {}, sampleTimesS: [] })).size).toBe(0);
  });
});

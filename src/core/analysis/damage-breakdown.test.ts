/**
 * Tests of the damage breakdown: the list of damage sources of a match with their share, their usual
 * share and whether the player used the source more or less than usual.
 *
 * The values of a match are built by hand, the way the projection stores them (one number per key),
 * and so is the catalogue. Every figure the tests expect is worked out in a comment from the values,
 * so that a reader can check it without running anything. Nothing here comes from a real match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { CatalogueItem } from '../deadlock-api/assets.schema';
import type { HeroLoadout } from '../domain/hero';
import { buildDamageBreakdown, readableSourceName } from './damage-breakdown';
import type { DamageBreakdown, DamageSourceRow } from './damage-breakdown';
import { abilityUnlockKey, damageSourceKey, itemOwnedDamageKey } from './damage-sources';

/** The values stored for one match, as the metrics repository hands them over. */
type Stored = Map<string, number | null>;

/** The class names of the hero's loadout, then of the other sources the tests use. */
const WEAPON = 'citadel_weapon_bookworm_set2';
const MELEE = 'ability_melee_bookworm';
const BOOKWYRM = 'ability_bookworm_dragonfire';
const PLOT_ARMOR = 'ability_bookworm_knightbarrier';
const CAPTIVATING_READ = 'ability_bookworm_aoemagic';
const RALLYING_CHARGE = 'ability_bookworm_knightcharge';
const EXPRESS_SHOT = 'upgrade_express_shot';
const SPIRIT_BURN = 'upgrade_spirit_burn';
/** A shop item the catalogue does not name. */
const SLOW_FADE = 'upgrade_slow_fade';
/** An ability of another hero, which the catalogue knows. */
const OTHER_HERO_ABILITY = 'citadel_ability_shiv_defer_damage';
/** A source the catalogue does not know at all. */
const ZIP_LINE = 'citadel_ability_zip_line';

/** The asset ids of the catalogue entries (synthetic). */
const BOOKWYRM_ID = 8_003;
const PLOT_ARMOR_ID = 8_004;
const CAPTIVATING_READ_ID = 8_005;
const RALLYING_CHARGE_ID = 8_006;
const EXPRESS_SHOT_ID = 9_001;
const SPIRIT_BURN_ID = 9_002;
const SLOW_FADE_ID = 9_003;
const OTHER_HERO_ABILITY_ID = 8_101;

/** The loadout of the hero: the abilities are the signatures, in slot order. */
const LOADOUT: HeroLoadout = {
  weapon: WEAPON,
  melee: MELEE,
  abilities: [BOOKWYRM, PLOT_ARMOR, CAPTIVATING_READ, RALLYING_CHARGE],
};

/**
 * One entry of the catalogue.
 *
 * @param id - The asset id.
 * @param className - The class name.
 * @param name - The English name, or `null` when the catalogue has none.
 * @param kind - The kind of the entry.
 * @returns The entry.
 */
function entry(
  id: number,
  className: string,
  name: string | null,
  kind: CatalogueItem['kind'],
): CatalogueItem {
  return {
    id,
    className,
    name,
    kind,
    slot: kind === 'upgrade' ? 'weapon' : null,
    tier: kind === 'upgrade' ? 3 : null,
    imageUrl: `https://assets-bucket.deadlock-api.com/${className}.webp`,
  };
}

/** The catalogue of the tests: the loadout, three shop items and an ability of another hero. */
const CATALOGUE: readonly CatalogueItem[] = [
  entry(8_001, WEAPON, "Chapter's End", 'weapon'),
  entry(8_002, MELEE, 'Melee', 'ability'),
  entry(BOOKWYRM_ID, BOOKWYRM, 'Bookwyrm', 'ability'),
  entry(PLOT_ARMOR_ID, PLOT_ARMOR, 'Plot Armor', 'ability'),
  entry(CAPTIVATING_READ_ID, CAPTIVATING_READ, 'Captivating Read', 'ability'),
  entry(RALLYING_CHARGE_ID, RALLYING_CHARGE, 'Rallying Charge', 'ability'),
  entry(EXPRESS_SHOT_ID, EXPRESS_SHOT, 'Express Shot', 'upgrade'),
  entry(SPIRIT_BURN_ID, SPIRIT_BURN, 'Spirit Burn', 'upgrade'),
  entry(SLOW_FADE_ID, SLOW_FADE, null, 'upgrade'),
  entry(OTHER_HERO_ABILITY_ID, OTHER_HERO_ABILITY, 'Bloodletting', 'ability'),
];

/** The four signature abilities, unlocked at some time of the match (seconds). */
const ALL_UNLOCKED = {
  [BOOKWYRM_ID]: 200,
  [PLOT_ARMOR_ID]: 30,
  [CAPTIVATING_READ_ID]: 150,
  [RALLYING_CHARGE_ID]: 400,
};

/** What a match stores, by family of keys. */
interface StoredOptions {
  /** The damage by class name. */
  readonly damage?: Readonly<Record<string, number | null>>;
  /** The damage dealt while an item was owned, by item id. */
  readonly owned?: Readonly<Record<number, number | null>>;
  /** The unlock time of an ability, by ability id. */
  readonly unlocked?: Readonly<Record<number, number | null>>;
}

/**
 * The values of a match, stored under their keys.
 *
 * @param options - What the match stores.
 * @returns The values.
 */
function stored(options: StoredOptions = {}): Stored {
  const values: Stored = new Map();
  for (const [className, damage] of Object.entries(options.damage ?? {})) {
    values.set(damageSourceKey(className), damage);
  }
  for (const [itemId, damage] of Object.entries(options.owned ?? {})) {
    values.set(itemOwnedDamageKey(Number(itemId)), damage);
  }
  for (const [abilityId, timeS] of Object.entries(options.unlocked ?? {})) {
    values.set(abilityUnlockKey(Number(abilityId)), timeS);
  }
  return values;
}

/**
 * Run the breakdown on a catalogue.
 *
 * @param current - The values of the match.
 * @param previous - The values of the earlier matches, newest first.
 * @param catalogue - The catalogue to name the sources with.
 * @param loadout - The loadout of the hero.
 * @returns The breakdown, or `null` for a match without damage.
 */
function run(
  current: Stored,
  previous: readonly Stored[],
  catalogue: readonly CatalogueItem[] = CATALOGUE,
  loadout: HeroLoadout = LOADOUT,
): DamageBreakdown | null {
  return buildDamageBreakdown({
    current,
    previous,
    loadout,
    itemsByClassName: new Map(
      catalogue.map((item): [string, CatalogueItem] => [item.className, item]),
    ),
  });
}

/**
 * Run the breakdown of a match that is expected to have one.
 *
 * @param current - The values of the match.
 * @param previous - The values of the earlier matches, newest first.
 * @returns The breakdown.
 */
function breakdownOf(current: Stored, previous: readonly Stored[] = []): DamageBreakdown {
  const result = run(current, previous);
  if (result === null) {
    throw new Error('the match should have a breakdown');
  }
  return result;
}

/**
 * The row of a source, or a failure when the breakdown has none.
 *
 * @param result - The breakdown.
 * @param className - The class name of the source.
 * @returns The row.
 */
function rowOf(result: DamageBreakdown, className: string): DamageSourceRow {
  const row = result.rows.find((candidate) => candidate.className === className);
  if (row === undefined) {
    throw new Error(`no row for ${className}`);
  }
  return row;
}

/**
 * The class names of the rows, in order.
 *
 * @param result - The breakdown.
 * @returns The class names.
 */
function namesOf(result: DamageBreakdown): string[] {
  return result.rows.map((row) => row.className);
}

/**
 * A match where the weapon dealt a share of the damage and the melee the rest, 10 000 in all, so
 * that the shares are `percent / 100` and `1 - percent / 100`.
 *
 * @param percent - The weapon's share of the damage, a whole number between 1 and 99.
 * @returns The values.
 */
function weaponMatch(percent: number): Stored {
  return stored({ damage: { [WEAPON]: percent * 100, [MELEE]: (100 - percent) * 100 } });
}

/**
 * A match where the melee dealt a given damage out of 10 000 and the weapon the rest, so that the
 * melee's share is `meleeDamage / 10 000`.
 *
 * @param meleeDamage - The damage of the melee, a whole number between 1 and 9 999.
 * @returns The values.
 */
function meleeMatch(meleeDamage: number): Stored {
  return stored({ damage: { [WEAPON]: 10_000 - meleeDamage, [MELEE]: meleeDamage } });
}

/**
 * The row of the weapon in a match where it dealt a share of the damage, with earlier matches where
 * it dealt others.
 *
 * @param percent - The weapon's share of the damage in the match.
 * @param earlierPercents - Its share in the earlier matches, newest first.
 * @returns The row of the weapon.
 */
function weaponRowOf(percent: number, earlierPercents: readonly number[]): DamageSourceRow {
  const earlier = earlierPercents.map((earlierPercent) => weaponMatch(earlierPercent));
  return rowOf(breakdownOf(weaponMatch(percent), earlier), WEAPON);
}

describe('buildDamageBreakdown', () => {
  it('splits the damage by source with shares of the match total', () => {
    // 3 000 + 6 000 + 1 000 = 10 000 in all, so the shares are 0.3, 0.6 and 0.1.
    const result = breakdownOf(
      stored({
        damage: { [WEAPON]: 3_000, [BOOKWYRM]: 6_000, [MELEE]: 1_000 },
        unlocked: { [BOOKWYRM_ID]: 200 },
      }),
    );

    expect(result.totalDamage).toBe(10_000);
    // The abilities that dealt nothing (and never did) have no line; the rows go by share.
    expect(result.rows.map((row) => [row.className, row.kind, row.name, row.share])).toEqual([
      [BOOKWYRM, 'ability', 'Bookwyrm', 0.6],
      [WEAPON, 'weapon', "Chapter's End", 0.3],
      [MELEE, 'melee', 'Melee', 0.1],
    ]);
    // Nothing is compared yet, and a source other than an item is compared on its share.
    for (const row of result.rows) {
      expect(row).toMatchObject({ unlocked: true, habit: null, gap: null, flag: null });
      expect(row.comparedShare).toBe(row.share);
    }
    expect(rowOf(result, WEAPON)).toMatchObject({
      damage: 3_000,
      itemId: 8_001,
      imageUrl: `https://assets-bucket.deadlock-api.com/${WEAPON}.webp`,
    });
  });

  it('compares an item on its share while owned', () => {
    // The item dealt 4 617 of the 27 729 damage of the match (23 112 + 4 617), but the player dealt
    // 22 072 damage while they owned it: it is compared on 4 617 / 22 072, not on 4 617 / 27 729.
    const result = breakdownOf(
      stored({
        damage: { [WEAPON]: 23_112, [EXPRESS_SHOT]: 4_617 },
        owned: { [EXPRESS_SHOT_ID]: 22_072 },
      }),
    );

    expect(result.totalDamage).toBe(27_729);
    const item = rowOf(result, EXPRESS_SHOT);
    expect(item).toMatchObject({
      kind: 'item',
      itemId: EXPRESS_SHOT_ID,
      name: 'Express Shot',
      damage: 4_617,
    });
    expect(item.share).toBeCloseTo(0.1665, 4);
    expect(item.comparedShare).toBeCloseTo(0.2092, 4);
    // The weapon is still compared on its share of the whole match: 23 112 / 27 729.
    const weapon = rowOf(result, WEAPON);
    expect(weapon.comparedShare).toBe(weapon.share);
    expect(weapon.share).toBeCloseTo(0.8335, 4);
  });

  it('caps the share of an item while owned at 1', () => {
    // The damage while owned is interpolated, so it can fall below the item's own damage (5 000
    // against 4 000 here): the share is capped at 1, in this match and in the habit, where five
    // earlier matches at 6 000 against 4 000 are five shares of 1 and not of 1.5.
    const owned = { [EXPRESS_SHOT_ID]: 4_000 };
    const earlier = Array.from({ length: 5 }, () =>
      stored({ damage: { [WEAPON]: 4_000, [EXPRESS_SHOT]: 6_000 }, owned }),
    );

    const item = rowOf(
      breakdownOf(stored({ damage: { [WEAPON]: 5_000, [EXPRESS_SHOT]: 5_000 }, owned }), earlier),
      EXPRESS_SHOT,
    );

    expect(item.share).toBeCloseTo(0.5, 9);
    expect(item.comparedShare).toBe(1);
    expect(item.habit).toEqual({ median: 1, count: 5 });
    expect(item.gap).toBeCloseTo(0, 9);
    expect(item.flag).toBeNull();
  });

  it('has no comparison for an item whose damage while owned is not known', () => {
    // The key is absent, 0 or null: the item cannot be compared, but it dealt damage and is listed.
    const result = breakdownOf(
      stored({
        damage: {
          [WEAPON]: 7_000,
          [EXPRESS_SHOT]: 1_000,
          [SPIRIT_BURN]: 1_000,
          [SLOW_FADE]: 1_000,
        },
        owned: { [SPIRIT_BURN_ID]: 0, [SLOW_FADE_ID]: null },
      }),
    );

    for (const className of [EXPRESS_SHOT, SPIRIT_BURN, SLOW_FADE]) {
      const item = rowOf(result, className);
      expect(item.kind).toBe('item');
      expect(item.share).toBeCloseTo(0.1, 9);
      expect(item.comparedShare).toBeNull();
      expect(item).toMatchObject({ habit: null, gap: null, flag: null });
    }
  });

  it('classifies each source by the loadout first, then by the catalogue', () => {
    const result = breakdownOf(
      stored({
        damage: {
          [WEAPON]: 100,
          [MELEE]: 100,
          [BOOKWYRM]: 100,
          [EXPRESS_SHOT]: 100,
          [OTHER_HERO_ABILITY]: 100,
          [ZIP_LINE]: 100,
        },
      }),
    );

    expect(Object.fromEntries(result.rows.map((row) => [row.className, row.kind]))).toEqual({
      [WEAPON]: 'weapon',
      [MELEE]: 'melee',
      [BOOKWYRM]: 'ability',
      [EXPRESS_SHOT]: 'item',
      [OTHER_HERO_ABILITY]: 'other',
      [ZIP_LINE]: 'other',
    });
  });

  it('always lists the weapon and melee', () => {
    // Only an ability dealt damage: the weapon and the melee are listed at 0 %, and compared on it.
    const result = breakdownOf(
      stored({ damage: { [BOOKWYRM]: 800 }, unlocked: { [BOOKWYRM_ID]: 200 } }),
    );

    // The two 0 % rows come after the ability, by class name.
    expect(namesOf(result)).toEqual([BOOKWYRM, MELEE, WEAPON]);
    for (const className of [WEAPON, MELEE]) {
      expect(rowOf(result, className)).toMatchObject({
        damage: 0,
        share: 0,
        comparedShare: 0,
        unlocked: true,
      });
    }
    expect(rowOf(result, WEAPON).name).toBe("Chapter's End");
  });

  it('lists an ability that never dealt damage only if it did in an earlier match', () => {
    // Captivating Read dealt damage in an earlier match where it was unlocked: it is listed, at 0 %.
    // Plot Armor never deals damage, and Rallying Charge dealt some in a match where it was not
    // unlocked (which the projection cannot produce): neither is listed. Bookwyrm never did.
    const earlier = [
      stored({
        damage: { [WEAPON]: 800, [CAPTIVATING_READ]: 200 },
        unlocked: { [CAPTIVATING_READ_ID]: 150 },
      }),
      stored({ damage: { [WEAPON]: 700, [RALLYING_CHARGE]: 300 } }),
    ];
    const result = breakdownOf(
      stored({ damage: { [WEAPON]: 1_000 }, unlocked: ALL_UNLOCKED }),
      earlier,
    );

    expect(namesOf(result)).toEqual([WEAPON, CAPTIVATING_READ, MELEE]);
    expect(rowOf(result, CAPTIVATING_READ)).toMatchObject({
      damage: 0,
      share: 0,
      unlocked: true,
    });
  });

  it('marks an ability not unlocked, with no comparison', () => {
    // Bookwyrm and Captivating Read are not unlocked in this match, but dealt damage in the six
    // earlier ones (a habit of 0.2 and 0.1 that must not be compared with this match).
    const earlier = Array.from({ length: 6 }, () =>
      stored({
        damage: {
          [WEAPON]: 5_000,
          [BOOKWYRM]: 2_000,
          [CAPTIVATING_READ]: 1_000,
          [RALLYING_CHARGE]: 2_000,
        },
        unlocked: ALL_UNLOCKED,
      }),
    );
    const result = breakdownOf(
      stored({
        damage: { [WEAPON]: 1_000 },
        unlocked: { [CAPTIVATING_READ_ID]: null, [RALLYING_CHARGE_ID]: 400 },
      }),
      earlier,
    );

    for (const className of [BOOKWYRM, CAPTIVATING_READ]) {
      expect(rowOf(result, className)).toMatchObject({
        unlocked: false,
        damage: 0,
        share: 0,
        comparedShare: null,
        habit: null,
        gap: null,
        flag: null,
      });
    }
    // The unlocked rows come first, by share then by class name; the abilities not unlocked come
    // last, in the order of the loadout (Bookwyrm is the first signature, Captivating Read the third).
    expect(namesOf(result)).toEqual([WEAPON, RALLYING_CHARGE, MELEE, BOOKWYRM, CAPTIVATING_READ]);
    // The ability unlocked in this match is compared as usual: 0 against a usual 0.2.
    expect(rowOf(result, RALLYING_CHARGE)).toMatchObject({ unlocked: true, flag: 'below' });
  });

  it('treats an ability missing from the catalogue as unlocked', () => {
    // Without a catalogue entry there is no id to look the unlock up with: the ability counts as
    // unlocked in every match, and is named from its class name.
    const unknownAbility = 'ability_unknown_hero_skill';
    const loadout: HeroLoadout = { ...LOADOUT, abilities: [unknownAbility] };
    const earlier = [stored({ damage: { [unknownAbility]: 100 } })];

    const result = run(stored({ damage: { [WEAPON]: 900 } }), earlier, CATALOGUE, loadout);

    expect(result).not.toBeNull();
    expect(result?.rows.map((row) => [row.className, row.name, row.unlocked, row.itemId])).toEqual([
      [WEAPON, "Chapter's End", true, 8_001],
      [MELEE, 'Melee', true, 8_002],
      [unknownAbility, 'unknown hero skill', true, null],
    ]);
  });

  it('compares with the median of the last 20 matches where the source appears', () => {
    // 50 earlier matches, newest first. The item was owned in the even ones only (25 matches) and
    // dealt, over the damage dealt while it was owned (10 000):
    // - 1 000 (0.1) in the 12 newest of them;
    // - 5 000 (0.5) in the 8 next;
    // - 9 000 (0.9) in the 5 oldest, which are past the 20 matches of the habit.
    // So the habit is 0.1 (the median of 12 values of 0.1 and 8 of 0.5), over 20 matches. The odd
    // matches, where the item was not owned, count for nothing: not as 0 %, not as a match.
    const damageWhileOwned = (ownedRank: number): number => {
      if (ownedRank < 12) {
        return 1_000;
      }
      return ownedRank < 20 ? 5_000 : 9_000;
    };
    const earlier = Array.from({ length: 50 }, (_, position) =>
      position % 2 === 1
        ? stored({ damage: { [WEAPON]: 5_000 } })
        : stored({
            damage: { [WEAPON]: 5_000, [EXPRESS_SHOT]: damageWhileOwned(position / 2) },
            owned: { [EXPRESS_SHOT_ID]: 10_000 },
          }),
    );

    const result = breakdownOf(
      stored({
        damage: { [WEAPON]: 7_000, [EXPRESS_SHOT]: 3_000 },
        owned: { [EXPRESS_SHOT_ID]: 10_000 },
      }),
      earlier,
    );

    const item = rowOf(result, EXPRESS_SHOT);
    expect(item.comparedShare).toBeCloseTo(0.3, 9);
    expect(item.habit?.count).toBe(20);
    expect(item.habit?.median).toBeCloseTo(0.1, 9);
    expect(item.gap).toBeCloseTo(0.2, 9);
  });

  it('counts an item owned without dealing damage as 0 % in the matches where it was owned', () => {
    // Owned in five matches without dealing damage, absent from the others: the habit is 0 over 5.
    const earlier = [
      weaponMatch(60),
      ...Array.from({ length: 5 }, () =>
        stored({ damage: { [WEAPON]: 5_000 }, owned: { [EXPRESS_SHOT_ID]: 10_000 } }),
      ),
      weaponMatch(60),
    ];

    const item = rowOf(
      breakdownOf(
        stored({
          damage: { [WEAPON]: 8_000, [EXPRESS_SHOT]: 2_000 },
          owned: { [EXPRESS_SHOT_ID]: 10_000 },
        }),
        earlier,
      ),
      EXPRESS_SHOT,
    );

    expect(item.habit).toEqual({ median: 0, count: 5 });
    expect(item.gap).toBeCloseTo(0.2, 9);
    expect(item.flag).toBe('above');
  });

  it('counts an ability only in the matches where it was unlocked', () => {
    // Bookwyrm was unlocked in six of the nine earlier matches: it dealt 20 % of the damage in three
    // of them and nothing in the three others (a 0 % that counts and pulls the habit down), and it
    // was not unlocked yet in the last three (which do not count). So the habit is the median of
    // three 0.2 and three 0: 0.1, over 6 matches. Counting only the matches where it dealt damage
    // would give 3 matches and no habit; counting all nine would give a median of 0.
    const dealtDamage = stored({
      damage: { [WEAPON]: 8_000, [BOOKWYRM]: 2_000 },
      unlocked: { [BOOKWYRM_ID]: 200 },
    });
    const unlockedUnused = stored({
      damage: { [WEAPON]: 10_000 },
      unlocked: { [BOOKWYRM_ID]: 200 },
    });
    const notUnlocked = stored({ damage: { [WEAPON]: 10_000 } });
    const earlier = [
      dealtDamage,
      unlockedUnused,
      notUnlocked,
      dealtDamage,
      unlockedUnused,
      notUnlocked,
      dealtDamage,
      unlockedUnused,
      notUnlocked,
    ];

    const ability = rowOf(
      breakdownOf(
        stored({
          damage: { [WEAPON]: 6_000, [BOOKWYRM]: 4_000 },
          unlocked: { [BOOKWYRM_ID]: 200 },
        }),
        earlier,
      ),
      BOOKWYRM,
    );

    expect(ability.habit?.count).toBe(6);
    expect(ability.habit?.median).toBeCloseTo(0.1, 9);
    // This match: 4 000 of 10 000.
    expect(ability.gap).toBeCloseTo(0.3, 9);
  });

  it('counts the weapon in every earlier match, at 0 % when it dealt nothing', () => {
    // Only the melee dealt damage in the five earlier matches: the weapon was there all the same.
    const earlier = Array.from({ length: 5 }, () => stored({ damage: { [MELEE]: 10_000 } }));

    const weapon = rowOf(breakdownOf(weaponMatch(30), earlier), WEAPON);

    expect(weapon.habit).toEqual({ median: 0, count: 5 });
    expect(weapon.gap).toBeCloseTo(0.3, 9);
    expect(weapon.flag).toBe('above');
  });

  it('compares any other source only in the matches where it dealt damage', () => {
    // The zipline knocked off enemies in five of the eight earlier matches, for 10 % of the damage.
    const knockOff = stored({ damage: { [WEAPON]: 9_000, [ZIP_LINE]: 1_000 } });
    const earlier = [
      knockOff,
      weaponMatch(50),
      knockOff,
      knockOff,
      weaponMatch(50),
      knockOff,
      weaponMatch(50),
      knockOff,
    ];

    const zipLine = rowOf(
      breakdownOf(stored({ damage: { [WEAPON]: 9_500, [ZIP_LINE]: 500 } }), earlier),
      ZIP_LINE,
    );

    expect(zipLine.habit?.count).toBe(5);
    expect(zipLine.habit?.median).toBeCloseTo(0.1, 9);
    expect(zipLine.gap).toBeCloseTo(-0.05, 9);
  });

  it('needs 5 matches for a habit', () => {
    // A match without any damage (no key) has no share, so it is not one of the five.
    const empty = stored();
    const fourMatches = [30, 30, 30, 30].map((percent) => weaponMatch(percent));

    expect(rowOf(breakdownOf(weaponMatch(30), fourMatches), WEAPON).habit).toBeNull();
    expect(rowOf(breakdownOf(weaponMatch(30), [...fourMatches, empty]), WEAPON).habit).toBeNull();

    const row = rowOf(breakdownOf(weaponMatch(30), [...fourMatches, weaponMatch(30)]), WEAPON);
    expect(row.habit).toEqual({ median: 0.3, count: 5 });
    expect(row.gap).toBeCloseTo(0, 9);
  });

  it('flags below and above with the robust deviation', () => {
    // The weapon dealt 28 to 32 % of the damage: a median of 0.30 and a median absolute deviation
    // of 0.01, so one robust deviation is 0.0148.
    const steady = [28, 29, 30, 30, 30, 31, 32];
    expect(weaponRowOf(40, steady).flag).toBe('above'); // 0.10 above: 6.7 deviations
    expect(weaponRowOf(20, steady).flag).toBe('below'); // 0.10 below: 6.7 deviations
    expect(weaponRowOf(31, steady).flag).toBeNull(); // 0.01 above: 0.7 deviation

    // It dealt 10 to 50 % of the damage: a median of 0.30 and a deviation of 0.10, so one robust
    // deviation is 0.148. A gap of 0.10 is more than the 5 points of a flat habit, but less than
    // the spread of this one: the spread decides when there is one.
    const erratic = [10, 20, 30, 40, 50];
    expect(weaponRowOf(40, erratic).flag).toBeNull();
    expect(weaponRowOf(60, erratic).flag).toBe('above'); // 0.30 above: 2 deviations
    expect(weaponRowOf(40, erratic).gap).toBeCloseTo(0.1, 9);
  });

  it('does not flag a gap under 5 points, however steady the habit is', () => {
    // The melee dealt 2.9 to 3.1 % of the damage: a median of 0.030 and a deviation of 0.0005, so
    // one robust deviation is 0.00074. 3.5 % is 6.7 deviations away, but only half a point.
    const meleeHabit = [290, 295, 300, 300, 300, 305, 310].map((damage) => meleeMatch(damage));
    const halfPoint = rowOf(breakdownOf(meleeMatch(350), meleeHabit), MELEE);
    expect(halfPoint.gap).toBeCloseTo(0.005, 9);
    expect(halfPoint.flag).toBeNull();
    // 8.5 % is 5.5 points away (and as many deviations as it takes): flagged.
    const fivePoints = rowOf(breakdownOf(meleeMatch(850), meleeHabit), MELEE);
    expect(fivePoints.gap).toBeCloseTo(0.055, 9);
    expect(fivePoints.flag).toBe('above');

    // The weapon's habit of 28 to 32 % has a deviation of 0.0148: 2 points below is 1.35 deviations
    // away, which is not enough as it is under 5 points; 6 points below is flagged.
    const steady = [28, 29, 30, 30, 30, 31, 32];
    expect(weaponRowOf(28, steady).flag).toBeNull();
    expect(weaponRowOf(24, steady).flag).toBe('below');
  });

  it('flags by 5 points when the spread is 0', () => {
    // The weapon dealt 30 % in each of the five earlier matches: no spread to measure a distance
    // with, so the gap decides, from 5 points either way.
    const flat = [30, 30, 30, 30, 30];
    expect(weaponRowOf(35, flat).flag).toBe('above');
    expect(weaponRowOf(25, flat).flag).toBe('below');
    expect(weaponRowOf(34, flat).flag).toBeNull();
    expect(weaponRowOf(26, flat).flag).toBeNull();
    expect(weaponRowOf(30, flat).flag).toBeNull();
    expect(weaponRowOf(35, flat).gap).toBeCloseTo(0.05, 9);
  });

  it('names an unknown source from its class name', () => {
    const result = breakdownOf(
      stored({
        damage: { [WEAPON]: 600, [ZIP_LINE]: 100, [OTHER_HERO_ABILITY]: 200, [SLOW_FADE]: 100 },
        owned: { [SLOW_FADE_ID]: 1_000 },
      }),
    );

    // Not in the catalogue: a readable class name, no id and no image.
    expect(rowOf(result, ZIP_LINE)).toMatchObject({
      name: 'zip line',
      kind: 'other',
      itemId: null,
      imageUrl: null,
    });
    // In the catalogue with a name: that name, whatever the kind of the source.
    expect(rowOf(result, OTHER_HERO_ABILITY)).toMatchObject({
      name: 'Bloodletting',
      kind: 'other',
      itemId: OTHER_HERO_ABILITY_ID,
    });
    // In the catalogue without a name: a readable class name, with the image and the id.
    expect(rowOf(result, SLOW_FADE)).toMatchObject({
      name: 'slow fade',
      kind: 'item',
      itemId: SLOW_FADE_ID,
    });
    expect(rowOf(result, SLOW_FADE).imageUrl).toBe(
      `https://assets-bucket.deadlock-api.com/${SLOW_FADE}.webp`,
    );
  });

  it('handles a match with no damage to heroes', () => {
    // The source is stored with 0 damage: the match has a breakdown, with nothing to share. The
    // weapon and the melee are there at 0 %, with no comparison (their share is not defined), and
    // the item that dealt nothing is not listed.
    const earlier = Array.from({ length: 6 }, () => weaponMatch(30));
    const result = breakdownOf(stored({ damage: { [WEAPON]: 0, [EXPRESS_SHOT]: 0 } }), earlier);

    expect(result.totalDamage).toBe(0);
    expect(namesOf(result)).toEqual([MELEE, WEAPON]);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        damage: 0,
        share: 0,
        comparedShare: null,
        habit: null,
        gap: null,
        flag: null,
        unlocked: true,
      });
    }
  });

  it('treats a null stored value like an absent one', () => {
    // A null damage is not counted and does not list the source; a null owned damage means the item
    // was not owned; a null unlock means the ability was not unlocked.
    const earlier = [
      stored({
        damage: { [WEAPON]: 9_000, [BOOKWYRM]: 1_000 },
        unlocked: { [BOOKWYRM_ID]: 200 },
      }),
    ];
    const result = breakdownOf(
      stored({
        damage: { [WEAPON]: 1_000, [EXPRESS_SHOT]: null, [SPIRIT_BURN]: 400, [BOOKWYRM]: null },
        owned: { [EXPRESS_SHOT_ID]: 5_000, [SPIRIT_BURN_ID]: null },
        unlocked: { [BOOKWYRM_ID]: null },
      }),
      earlier,
    );

    expect(result.totalDamage).toBe(1_400);
    expect(namesOf(result)).toEqual([WEAPON, SPIRIT_BURN, MELEE, BOOKWYRM]);
    expect(rowOf(result, SPIRIT_BURN).comparedShare).toBeNull();
    expect(rowOf(result, BOOKWYRM)).toMatchObject({ unlocked: false, comparedShare: null });
  });

  it('answers null for a match without damage keys', () => {
    expect(run(stored(), [weaponMatch(30)])).toBeNull();
    // Keys of the other families are not damage by source.
    expect(
      run(stored({ owned: { [EXPRESS_SHOT_ID]: 100 }, unlocked: ALL_UNLOCKED }), []),
    ).toBeNull();
    // A key that only starts like the damage keys is not one (the prefix ends with a dot).
    expect(run(new Map<string, number | null>([['damage_source_total', 500]]), [])).toBeNull();
    expect(run(new Map<string, number | null>([['damage_sources.x', 500]]), [])).toBeNull();
    // A damage that is not known counts as no damage.
    expect(run(stored({ damage: { [WEAPON]: null } }), [])).toBeNull();
  });
});

describe('readableSourceName', () => {
  it('strips one known prefix and turns the underscores into spaces', () => {
    expect(readableSourceName('citadel_ability_zip_line')).toBe('zip line');
    expect(readableSourceName('citadel_weapon_bookworm_set2')).toBe('bookworm set2');
    expect(readableSourceName('ability_bookworm_dragonfire')).toBe('bookworm dragonfire');
    expect(readableSourceName('upgrade_express_shot')).toBe('express shot');
    expect(readableSourceName('citadel_something_else')).toBe('something else');
  });

  it('strips one prefix only, and leaves a name without a known prefix whole', () => {
    expect(readableSourceName('citadel_ability_upgrade_boost')).toBe('upgrade boost');
    expect(readableSourceName('ability_ability_boost')).toBe('ability boost');
    expect(readableSourceName('modifier_invis_bush')).toBe('modifier invis bush');
    // The prefix is the start of the name, not a part of it.
    expect(readableSourceName('hero_upgrade_boost')).toBe('hero upgrade boost');
  });

  it('keeps the class name when the prefix is all there is', () => {
    expect(readableSourceName('citadel_')).toBe('citadel_');
  });
});

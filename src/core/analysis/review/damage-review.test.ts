/**
 * Tests of the damage shares of the review: the share of each damage source over a window of
 * matches, and over the window before it.
 *
 * The values of a match are built by hand, the way the projection stores them (one number per key),
 * and so is the catalogue. Every figure the tests expect is worked out in a comment from the values,
 * so that a reader can check it without running anything. Nothing here comes from a real match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { CatalogueItem } from '../../deadlock-api/assets.schema';
import { parseMatchMetadata } from '../../deadlock-api/match-metadata.schema';
import { PAIGE_HERO_ID } from '../../domain/hero';
import type { HeroLoadout } from '../../domain/hero';
import { createArchiveEnvelope } from '../../match-detail/archive-envelope';
import type { ArchiveEnvelope } from '../../match-detail/archive-envelope';
import { testAccountId } from '../../../test/test-data';
import { buildDamageBreakdown } from '../damage-breakdown';
import { CRIT_SUFFIX, DAMAGE_STAT_TYPE, readDamageMatrix } from '../damage-matrix';
import { damageSourceKey, itemOwnedDamageKey, projectDamageSources } from '../damage-sources';
import { MIN_PERSONAL_MATCHES } from '../insights/thresholds';
import { damageShares } from './damage-review';
import type { DamageShareRow } from './damage-review';

/** The values stored for one match, as the metrics repository hands them over. */
type Stored = ReadonlyMap<string, number | null>;

/** The class names of the hero's loadout, then of the other sources the tests use. */
const WEAPON = 'citadel_weapon_bookworm_set2';
const MELEE = 'ability_melee_bookworm';
const BOOKWYRM = 'ability_bookworm_dragonfire';
const EXPRESS_SHOT = 'upgrade_express_shot';
/** A shop item the catalogue does not name. */
const SLOW_FADE = 'upgrade_slow_fade';
/** An ability of another hero, which the catalogue knows. */
const OTHER_HERO_ABILITY = 'citadel_ability_shiv_defer_damage';
/** A source the catalogue does not know at all. */
const ZIP_LINE = 'citadel_ability_zip_line';

/** The loadout of the hero. */
const LOADOUT: HeroLoadout = {
  weapon: WEAPON,
  melee: MELEE,
  abilities: [BOOKWYRM],
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

/** The catalogue of the tests, by class name: the loadout, two shop items and a foreign ability. */
const ITEMS_BY_CLASS_NAME: ReadonlyMap<string, CatalogueItem> = new Map(
  [
    entry(8_001, WEAPON, "Chapter's End", 'weapon'),
    entry(8_002, MELEE, 'Melee', 'ability'),
    entry(8_003, BOOKWYRM, 'Bookwyrm', 'ability'),
    entry(9_001, EXPRESS_SHOT, 'Express Shot', 'upgrade'),
    entry(9_003, SLOW_FADE, null, 'upgrade'),
    entry(8_101, OTHER_HERO_ABILITY, 'Bloodletting', 'ability'),
  ].map((item): [string, CatalogueItem] => [item.className, item]),
);

/**
 * The values of a match that dealt damage.
 *
 * @param damage - The damage by class name (`null` for a damage that is not known).
 * @returns The values, one `damage_source.` key per source.
 */
function matchOf(damage: Readonly<Record<string, number | null>>): Stored {
  return new Map(
    Object.entries(damage).map(([className, value]): [string, number | null] => [
      damageSourceKey(className),
      value,
    ]),
  );
}

/**
 * A window of matches before, filled up with matches that dealt no damage by source to the fewest
 * that give a share before ({@link MIN_PERSONAL_MATCHES}). Such a match adds nothing to the damage of
 * the window, so the shares are those of the matches given.
 *
 * @param matches - The matches that dealt damage.
 * @returns The window.
 */
function enoughBefore(matches: readonly Stored[]): readonly Stored[] {
  const filler = Array.from({ length: MIN_PERSONAL_MATCHES - matches.length }, () => matchOf({}));
  return [...matches, ...filler];
}

/**
 * Pool two windows of matches.
 *
 * @param now - The values of the matches of the window.
 * @param before - The values of the matches before it.
 * @returns The rows.
 */
function run(now: readonly Stored[], before: readonly Stored[]): readonly DamageShareRow[] {
  return damageShares({
    now,
    before,
    loadout: LOADOUT,
    itemsByClassName: ITEMS_BY_CLASS_NAME,
  });
}

/**
 * The class names of the rows, in order.
 *
 * @param rows - The rows.
 * @returns The class names.
 */
function namesOf(rows: readonly DamageShareRow[]): string[] {
  return rows.map((row) => row.className);
}

/** The slot of the tracked player (their team is 1), and that of the enemy they hit. */
const TRACKED_SLOT = 1;
const ENEMY_SLOT = 2;

/**
 * An archive of a match where the player hit an enemy with their weapon, the weapon's critical hits
 * and their melee. The damage matrix has two samples; the series are cumulative.
 *
 * @returns The envelope, which has a damage matrix.
 */
function archiveWithCritRow(): ArchiveEnvelope {
  const hit = (sourceIndex: number, damage: readonly number[]) => ({
    source_details_index: sourceIndex,
    damage_to_players: [{ target_player_slot: ENEMY_SLOT, damage }],
  });
  const payload = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: 360,
      game_mode: 1,
      match_mode: 4,
      players: [
        { account_id: 1_000_001, player_slot: TRACKED_SLOT, team: 1, hero_id: PAIGE_HERO_ID },
        { account_id: 2_000_002, player_slot: ENEMY_SLOT, team: 0, hero_id: 101 },
      ],
      damage_matrix: {
        sample_time_s: [180, 360],
        source_details: {
          stat_type: [DAMAGE_STAT_TYPE, DAMAGE_STAT_TYPE, DAMAGE_STAT_TYPE],
          source_name: [WEAPON, `${WEAPON}${CRIT_SUFFIX}`, MELEE],
        },
        damage_dealers: [
          {
            dealer_player_slot: TRACKED_SLOT,
            damage_sources: [hit(0, [100, 300]), hit(1, [50, 100]), hit(2, [0, 100])],
          },
        ],
      },
    },
  });
  return createArchiveEnvelope(payload, testAccountId(1_000_001), 1_760_000_123_456);
}

/**
 * The damage values the projection stores for {@link archiveWithCritRow}.
 *
 * @returns The values, as stored.
 */
function projectedValuesWithCritRow(): ReadonlyMap<string, number> {
  const read = readDamageMatrix(archiveWithCritRow());
  if (read === null) {
    return expect.unreachable('the archive has a damage matrix');
  }
  return projectDamageSources(read);
}

describe('damageShares', () => {
  it('pools the damage of a window into shares that add up to 1', () => {
    // First match 4 000 (weapon 3 000, melee 1 000), second 6 000 (weapon 1 000, Bookwyrm 5 000):
    // 10 000 in all, so the weapon has 4 000 (0.4), the melee 1 000 (0.1) and Bookwyrm 5 000 (0.5).
    // The mean of the weapon's shares in the two matches (0.75 and about 0.17) would not be 0.4.
    const now = [
      matchOf({ [WEAPON]: 3_000, [MELEE]: 1_000 }),
      matchOf({ [WEAPON]: 1_000, [BOOKWYRM]: 5_000 }),
    ];
    // Before: one match of 4 000, half weapon and half melee, among matches with no damage.
    const before = enoughBefore([matchOf({ [WEAPON]: 2_000, [MELEE]: 2_000 })]);

    const rows = run(now, before);

    expect(
      rows.map((row) => [
        row.className,
        row.shareNow,
        row.shareBefore,
        row.appearsNow,
        row.appearsBefore,
      ]),
    ).toEqual([
      [BOOKWYRM, 0.5, 0, 1, 0],
      [WEAPON, 0.4, 0.5, 2, 1],
      [MELEE, 0.1, 0.5, 1, 1],
    ]);
    const sum = (shares: readonly number[]) => shares.reduce((total, share) => total + share, 0);
    expect(sum(rows.map((row) => row.shareNow ?? 0))).toBeCloseTo(1, 12);
    expect(sum(rows.map((row) => row.shareBefore ?? 0))).toBeCloseTo(1, 12);
  });

  it('merges crits into their source', () => {
    // The projection merges a weapon's crit row into the weapon before it stores the damage: the
    // weapon holds 100 + 50 at the first sample and 300 + 100 at the last, so 400 in all, and the
    // melee 100. The shares come from the values the projection really stores, not from a copy.
    const rows = run([projectedValuesWithCritRow()], []);

    // 400 + 100 = 500 in all: the weapon has 0.8 and the melee 0.2, and no row is a crit row.
    expect(rows.map((row) => [row.className, row.shareNow])).toEqual([
      [WEAPON, 0.8],
      [MELEE, 0.2],
    ]);
  });

  it('classifies weapon, melee, abilities, items and other as the match tab does', () => {
    const damage = {
      [WEAPON]: 1_000,
      [MELEE]: 900,
      [BOOKWYRM]: 800,
      [EXPRESS_SHOT]: 700,
      [SLOW_FADE]: 600,
      [OTHER_HERO_ABILITY]: 500,
      [ZIP_LINE]: 400,
    };

    const rows = run([matchOf(damage)], []);

    expect(
      rows.map((row) => [row.className, row.kind, row.name, row.itemId, row.imageUrl !== null]),
    ).toEqual([
      [WEAPON, 'weapon', "Chapter's End", 8_001, true],
      [MELEE, 'melee', 'Melee', 8_002, true],
      [BOOKWYRM, 'ability', 'Bookwyrm', 8_003, true],
      [EXPRESS_SHOT, 'item', 'Express Shot', 9_001, true],
      // A shop item the catalogue does not name is read from its class name.
      [SLOW_FADE, 'item', 'slow fade', 9_003, true],
      // An ability that is not the hero's is not one of its abilities: it is an other source.
      [OTHER_HERO_ABILITY, 'other', 'Bloodletting', 8_101, true],
      // A source the catalogue does not know has no id and no image.
      [ZIP_LINE, 'other', 'zip line', null, false],
    ]);
    // The match tab describes the same sources the same way.
    const breakdown = buildDamageBreakdown({
      current: matchOf(damage),
      previous: [],
      loadout: LOADOUT,
      itemsByClassName: ITEMS_BY_CLASS_NAME,
    });
    for (const row of rows) {
      const tabRow = breakdown?.rows.find((candidate) => candidate.className === row.className);
      expect(tabRow).toMatchObject({
        kind: row.kind,
        itemId: row.itemId,
        name: row.name,
        imageUrl: row.imageUrl,
      });
    }
  });

  it('keeps a source seen only in the matches before', () => {
    // Now: the weapon alone. Before: the weapon and Express Shot, 500 each.
    const rows = run(
      [matchOf({ [WEAPON]: 2_000 })],
      enoughBefore([matchOf({ [WEAPON]: 500, [EXPRESS_SHOT]: 500 })]),
    );

    expect(
      rows.map((row) => [
        row.className,
        row.shareNow,
        row.shareBefore,
        row.appearsNow,
        row.appearsBefore,
      ]),
    ).toEqual([
      [WEAPON, 1, 0.5, 1, 1],
      [EXPRESS_SHOT, 0, 0.5, 0, 1],
    ]);
  });

  it('answers no share before when the earlier matches dealt no damage', () => {
    const now = [matchOf({ [WEAPON]: 750, [MELEE]: 250 })];
    // No earlier match at all, then earlier matches without any damage by source: only damage
    // dealt while an item was owned, and a damage that is not known.
    const withoutDamage = enoughBefore([
      new Map<string, number | null>([[itemOwnedDamageKey(9_001), 4_000]]),
      matchOf({ [WEAPON]: null }),
    ]);

    for (const before of [[], withoutDamage]) {
      const rows = run(now, before);

      expect(rows.map((row) => [row.className, row.shareNow, row.shareBefore])).toEqual([
        [WEAPON, 0.75, null],
        [MELEE, 0.25, null],
      ]);
      expect(rows.map((row) => row.appearsBefore)).toEqual([0, 0]);
    }
  });

  it('answers no share before under five earlier matches', () => {
    const now = [matchOf({ [WEAPON]: 750, [MELEE]: 250 })];
    const damage = matchOf({ [WEAPON]: 100, [MELEE]: 300 });

    // Four earlier matches, all of them with damage, are one too few: a share of so few says little.
    const four = Array.from({ length: MIN_PERSONAL_MATCHES - 1 }, () => damage);
    expect(
      run(now, four).map((row) => [row.className, row.shareBefore, row.appearsBefore]),
    ).toEqual([
      [WEAPON, null, MIN_PERSONAL_MATCHES - 1],
      [MELEE, null, MIN_PERSONAL_MATCHES - 1],
    ]);
    // Five are enough.
    const five = Array.from({ length: MIN_PERSONAL_MATCHES }, () => damage);
    expect(run(now, five).map((row) => [row.className, row.shareBefore])).toEqual([
      [WEAPON, 0.25],
      [MELEE, 0.75],
    ]);
  });

  it('answers no share now when the last matches dealt no damage', () => {
    // There is nothing to share, so no share to show: never a 0.
    const rows = run([matchOf({})], enoughBefore([matchOf({ [WEAPON]: 100, [MELEE]: 300 })]));

    expect(rows.map((row) => [row.className, row.shareNow, row.shareBefore])).toEqual([
      [MELEE, null, 0.75],
      [WEAPON, null, 0.25],
    ]);
  });

  it('gives a share of 0 now to a source the last matches did not use', () => {
    const rows = run(
      [matchOf({ [WEAPON]: 100 })],
      enoughBefore([matchOf({ [WEAPON]: 100, [MELEE]: 300 })]),
    );

    expect(rows.map((row) => [row.className, row.shareNow, row.shareBefore])).toEqual([
      [WEAPON, 1, 0.25],
      [MELEE, 0, 0.75],
    ]);
  });

  it('answers no row when neither window dealt damage', () => {
    expect(run([], [])).toEqual([]);
    expect(run([matchOf({})], [matchOf({ [WEAPON]: 0 })])).toEqual([]);
  });

  it('counts a source in a match only when it dealt damage there', () => {
    // The weapon dealt damage in two of the three matches; a damage that is not known (null) and a
    // damage of 0 are not a source that appeared.
    const now = [
      matchOf({ [WEAPON]: 100, [BOOKWYRM]: null }),
      matchOf({ [WEAPON]: 0, [BOOKWYRM]: 0, [MELEE]: 100 }),
      matchOf({ [WEAPON]: 300 }),
    ];

    const rows = run(now, []);

    expect(rows.map((row) => [row.className, row.shareNow, row.appearsNow])).toEqual([
      [WEAPON, 0.8, 2],
      [MELEE, 0.2, 1],
    ]);
  });

  it('sorts by share now, then by share before, then by class name', () => {
    // Now (10 000): the weapon and the melee 3 000 each, Bookwyrm and Express Shot 2 000 each.
    const now = [
      matchOf({ [WEAPON]: 3_000, [MELEE]: 3_000, [BOOKWYRM]: 2_000, [EXPRESS_SHOT]: 2_000 }),
    ];
    // Before (10 000): the weapon 5 000, the melee and Express Shot 2 000 each, Bookwyrm 1 000.
    const before = enoughBefore([
      matchOf({ [WEAPON]: 5_000, [MELEE]: 2_000, [EXPRESS_SHOT]: 2_000, [BOOKWYRM]: 1_000 }),
    ]);

    // The weapon and the melee tie now, and the weapon had the larger share before, although its
    // class name comes after the melee's. The same goes for Express Shot and Bookwyrm.
    expect(namesOf(run(now, before))).toEqual([WEAPON, MELEE, EXPRESS_SHOT, BOOKWYRM]);
    // With nothing before, the class name decides every tie.
    expect(namesOf(run(now, []))).toEqual([MELEE, WEAPON, BOOKWYRM, EXPRESS_SHOT]);
  });
});

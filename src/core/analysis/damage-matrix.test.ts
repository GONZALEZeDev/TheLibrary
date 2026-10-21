/**
 * Tests of the damage matrix reader.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players, a source table
 * indexed by `source_details_index`, cumulative series that are right-aligned on a sample grid,
 * aggregate rows that duplicate the others, a pruned matrix where only the tracked player's dealer
 * is whole) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PAIGE_HERO_ID } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import { createArchiveEnvelope } from '../match-detail/archive-envelope';
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import { readTrackedItems } from '../match-detail/tracked-items';
import { testAccountId } from '../../test/test-data';
import {
  AGGREGATE_SOURCE_NAMES,
  CRIT_SUFFIX,
  DAMAGE_STAT_TYPE,
  readDamageMatrix,
} from './damage-matrix';

/** The slot of the tracked player (their team is 1: slots 7 to 12). */
const TRACKED_SLOT = 9;

/** The account of the tracked player. */
const TRACKED_ACCOUNT = testAccountId(1_000_001);

/** When the detail was fetched (Unix milliseconds). */
const FETCHED_AT = 1_760_000_123_456;

/** Two enemies (team 0), a teammate (team 1) and the non-player target of the damage matrix. */
const ENEMY = 1;
const OTHER_ENEMY = 2;
const TEAMMATE = 8;
const NON_PLAYER = 0;

/** The stat types of the game data that the tests use. */
const HEALING_STAT_TYPE = 1;
const MITIGATED_STAT_TYPE = 3;

/** The source table of the matrix: the stat type and the name of each `source_details_index`. */
const SOURCE_ROWS = [
  [DAMAGE_STAT_TYPE, 'citadel_weapon_bookworm_set2'],
  [DAMAGE_STAT_TYPE, `citadel_weapon_bookworm_set2${CRIT_SUFFIX}`],
  [DAMAGE_STAT_TYPE, 'ability_bookworm_dragonfire'],
  [DAMAGE_STAT_TYPE, 'upgrade_express_shot'],
  [DAMAGE_STAT_TYPE, 'ability_melee_bookworm'],
  // The same ability under other stat types: not damage.
  [MITIGATED_STAT_TYPE, 'ability_bookworm_dragonfire'],
  [HEALING_STAT_TYPE, 'ability_bookworm_aoemagic'],
  // The category rows that duplicate the others, one index each.
  ...AGGREGATE_SOURCE_NAMES.map((name) => [DAMAGE_STAT_TYPE, name] as const),
  // The critical hits of a category row (the real data has none; the reader must not make a
  // source of the category out of them).
  [DAMAGE_STAT_TYPE, `${AGGREGATE_SOURCE_NAMES[0]}${CRIT_SUFFIX}`],
] as const;

/** The `source_details_index` of each source of {@link SOURCE_ROWS}. */
const WEAPON = 0;
const WEAPON_CRIT = 1;
const DRAGONFIRE = 2;
const EXPRESS_SHOT = 3;
const MELEE = 4;
const DRAGONFIRE_MITIGATED = 5;
const AOEMAGIC_HEALING = 6;
/** The index of the first aggregate row (`Bullet`), the next ones follow in the order of the names. */
const FIRST_AGGREGATE = 7;
/** The index of the crit row of the first category row (`Bullet_crit`), after the category rows. */
const AGGREGATE_CRIT = FIRST_AGGREGATE + AGGREGATE_SOURCE_NAMES.length;

/** The time of each sample of the matrix, in seconds (the matrix grid, not the snapshot grid). */
const SAMPLES = [180, 360, 540, 720];

/**
 * The damage of a source to one target: a cumulative series, right-aligned on the samples.
 *
 * @param target - The slot of the target, `0` being a non-player.
 * @param damage - The series (shorter than the samples when its leading zeros were trimmed).
 * @returns The raw `damage_to_players` entry.
 */
function rawDamageTo(target: number, damage: unknown) {
  return { target_player_slot: target, damage };
}

/**
 * One damage source of a dealer.
 *
 * @param sourceIndex - The index in the source table.
 * @param targets - The damage to each target.
 * @returns The raw damage source.
 */
function rawSource(sourceIndex: unknown, targets: readonly unknown[]) {
  return { source_details_index: sourceIndex, damage_to_players: targets };
}

/**
 * One dealer.
 *
 * @param dealerSlot - The slot of the dealer, `0` being a non-player.
 * @param sources - Its damage sources.
 * @returns The raw damage dealer.
 */
function rawDealer(dealerSlot: number, sources: readonly unknown[]) {
  return { dealer_player_slot: dealerSlot, damage_sources: sources };
}

/**
 * The damage matrix of a match.
 *
 * @param dealers - The damage dealers.
 * @param overrides - Fields of the matrix to change (a key set to `undefined` is left out).
 * @returns The raw damage matrix.
 */
function rawMatrix(dealers: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    sample_time_s: SAMPLES,
    source_details: {
      stat_type: SOURCE_ROWS.map(([statType]) => statType),
      source_name: SOURCE_ROWS.map(([, name]) => name),
    },
    damage_dealers: dealers,
    ...overrides,
  };
}

/**
 * One player in the shape of the API (fields the app ignores included).
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param team - Their team.
 * @param overrides - Fields to change.
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, team: number, overrides: Record<string, unknown> = {}) {
  return {
    account_id: 2_000_000 + playerSlot,
    player_slot: playerSlot,
    team,
    hero_id: playerSlot === TRACKED_SLOT ? PAIGE_HERO_ID : 100 + playerSlot,
    items: [{ item_id: 9_000 + playerSlot, game_time_s: 100, upgrade_id: 1 }],
    ...overrides,
  };
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads. The tracked player (slot 9) is in team 1 with slots 7 to 12 unless `teamOf` says
 * otherwise.
 *
 * @param matrix - The damage matrix, or `undefined` for a match that has none.
 * @param options - What to change: the team of each slot, the items of the tracked player.
 * @returns The envelope.
 */
function archive(
  matrix: unknown,
  options: {
    readonly teamOf?: (slot: number) => number;
    readonly items?: readonly unknown[];
  } = {},
): ArchiveEnvelope {
  const { teamOf = (slot: number) => (slot <= 6 ? 0 : 1), items } = options;
  const slots = Array.from({ length: 12 }, (_, index) => 12 - index);
  const payload = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: 2_070,
      game_mode: 1,
      match_mode: 4,
      players: slots.map((slot) =>
        slot === TRACKED_SLOT
          ? rawPlayer(slot, teamOf(slot), {
              account_id: 1_000_001,
              ...(items === undefined ? {} : { items }),
            })
          : rawPlayer(slot, teamOf(slot)),
      ),
      ...(matrix === undefined ? {} : { damage_matrix: matrix }),
    },
  });
  return createArchiveEnvelope(payload, TRACKED_ACCOUNT, FETCHED_AT);
}

/**
 * Read the damage matrix of an archive that must have one.
 *
 * @param dealers - The damage dealers of the matrix.
 * @param overrides - Fields of the matrix to change.
 * @returns The read matrix.
 */
function readDealers(dealers: readonly unknown[], overrides: Record<string, unknown> = {}) {
  const read = readDamageMatrix(archive(rawMatrix(dealers, overrides)));
  if (read === null) {
    return expect.unreachable('the archive has a damage matrix');
  }
  return read;
}

/**
 * Run a call that must fail with an {@link AppError} and return that error.
 *
 * @param action - The call under test.
 * @returns The error it threw.
 */
function catchAppError(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  return expect.unreachable('the call should have thrown');
}

describe('readDamageMatrix', () => {
  it("sums the tracked player's damage to enemy heroes by source", () => {
    const read = readDealers([
      // An enemy's damage to the tracked player: another dealer, whatever it hits.
      rawDealer(OTHER_ENEMY, [
        rawSource(WEAPON, [rawDamageTo(TRACKED_SLOT, [7_000, 7_000, 7_000, 7_000])]),
      ]),
      // A teammate's damage to an enemy: another dealer as well.
      rawDealer(TEAMMATE, [rawSource(WEAPON, [rawDamageTo(ENEMY, [900, 900, 900, 900])])]),
      rawDealer(TRACKED_SLOT, [
        rawSource(WEAPON, [
          rawDamageTo(ENEMY, [10, 20, 30, 40]),
          rawDamageTo(OTHER_ENEMY, [1, 2, 3, 4]),
          // Not enemy heroes: a teammate, a non-player and the tracked player themselves.
          rawDamageTo(TEAMMATE, [100, 200, 300, 400]),
          rawDamageTo(NON_PLAYER, [500, 500, 500, 500]),
          rawDamageTo(TRACKED_SLOT, [600, 600, 600, 600]),
        ]),
        rawSource(DRAGONFIRE, [rawDamageTo(OTHER_ENEMY, [0, 5, 5, 15])]),
      ]),
    ]);

    expect([...read.sources.keys()]).toEqual([
      'citadel_weapon_bookworm_set2',
      'ability_bookworm_dragonfire',
    ]);
    expect(read.sources.get('citadel_weapon_bookworm_set2')).toEqual([11, 22, 33, 44]);
    expect(read.sources.get('ability_bookworm_dragonfire')).toEqual([0, 5, 5, 15]);
  });

  it('reads the enemies from the teams, not from the slots', () => {
    // Teams by parity: the tracked player (slot 9) is in team 1 with the odd slots.
    const envelope = archive(
      rawMatrix([
        rawDealer(TRACKED_SLOT, [
          rawSource(WEAPON, [
            // Slot 2 is an enemy here, slot 1 a teammate.
            rawDamageTo(2, [1, 2, 3, 4]),
            rawDamageTo(1, [100, 200, 300, 400]),
          ]),
        ]),
      ]),
      { teamOf: (slot) => slot % 2 },
    );

    expect(readDamageMatrix(envelope)?.sources.get('citadel_weapon_bookworm_set2')).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('leaves out the aggregate rows and the other stat types', () => {
    const aggregateSources = AGGREGATE_SOURCE_NAMES.map((_name, offset) =>
      rawSource(FIRST_AGGREGATE + offset, [rawDamageTo(ENEMY, [50, 50, 50, 50])]),
    );

    const read = readDealers([
      rawDealer(TRACKED_SLOT, [
        ...aggregateSources,
        rawSource(WEAPON, [rawDamageTo(ENEMY, [10, 20, 30, 40])]),
        // The same ability as mitigated damage, and a healing source: not damage.
        rawSource(DRAGONFIRE_MITIGATED, [rawDamageTo(ENEMY, [8, 8, 8, 8])]),
        rawSource(AOEMAGIC_HEALING, [rawDamageTo(ENEMY, [9, 9, 9, 9])]),
      ]),
    ]);

    expect([...read.sources.keys()]).toEqual(['citadel_weapon_bookworm_set2']);
    expect(read.total).toEqual([10, 20, 30, 40]);
  });

  it('does not make a source of the critical hits of a category row', () => {
    const read = readDealers([
      rawDealer(TRACKED_SLOT, [
        rawSource(AGGREGATE_CRIT, [rawDamageTo(ENEMY, [50, 50, 50, 50])]),
        rawSource(WEAPON, [rawDamageTo(ENEMY, [10, 20, 30, 40])]),
      ]),
    ]);

    // Neither a `Bullet_crit` source nor a `Bullet` one: it would double count the weapon's damage.
    expect([...read.sources.keys()]).toEqual(['citadel_weapon_bookworm_set2']);
    expect(read.total).toEqual([10, 20, 30, 40]);
  });

  it.each([
    ['a row of another stat type', rawSource(DRAGONFIRE_MITIGATED, [rawDamageTo(ENEMY, 'S3CR3T')])],
    ['a healing row', rawSource(AOEMAGIC_HEALING, [rawDamageTo(ENEMY, [1, 2, 3, 4, 5, 6, 7, 8])])],
    ['a category row', rawSource(FIRST_AGGREGATE, [rawDamageTo(ENEMY, [1, -1, 'S3CR3T'])])],
    [
      'the critical hits of a category row',
      rawSource(AGGREGATE_CRIT, [rawDamageTo(ENEMY, [1, 2, 3, 4, 5])]),
    ],
    ['a teammate', rawSource(DRAGONFIRE, [rawDamageTo(TEAMMATE, [-1, 'S3CR3T'])])],
    ['a non-player target', rawSource(DRAGONFIRE, [rawDamageTo(NON_PLAYER, 'S3CR3T')])],
    ['the tracked player themselves', rawSource(DRAGONFIRE, [rawDamageTo(TRACKED_SLOT, null)])],
  ])('does not check the series of %s, which it leaves out', (_name, leftOutSource) => {
    const read = readDealers([
      rawDealer(TRACKED_SLOT, [
        leftOutSource,
        rawSource(WEAPON, [rawDamageTo(ENEMY, [10, 20, 30, 40])]),
      ]),
    ]);

    expect([...read.sources.keys()]).toEqual(['citadel_weapon_bookworm_set2']);
    expect(read.total).toEqual([10, 20, 30, 40]);
  });

  it('right-aligns a short series', () => {
    const read = readDealers([
      rawDealer(TRACKED_SLOT, [
        // Two values over four samples: the leading zeros were trimmed.
        rawSource(WEAPON, [rawDamageTo(ENEMY, [30, 50])]),
        rawSource(EXPRESS_SHOT, [rawDamageTo(ENEMY, [8])]),
        rawSource(DRAGONFIRE, [rawDamageTo(ENEMY, [1, 2, 3, 4])]),
        // A source that never dealt damage has an empty series.
        rawSource(MELEE, [rawDamageTo(ENEMY, [])]),
      ]),
    ]);

    expect(read.sources.get('citadel_weapon_bookworm_set2')).toEqual([0, 0, 30, 50]);
    expect(read.sources.get('upgrade_express_shot')).toEqual([0, 0, 0, 8]);
    expect(read.sources.get('ability_bookworm_dragonfire')).toEqual([1, 2, 3, 4]);
    expect(read.sources.get('ability_melee_bookworm')).toEqual([0, 0, 0, 0]);
  });

  it('adds the series of several targets on the same samples', () => {
    const read = readDealers([
      rawDealer(TRACKED_SLOT, [
        rawSource(WEAPON, [
          rawDamageTo(ENEMY, [10, 20, 30, 40]),
          // Shorter: it starts at the third sample.
          rawDamageTo(OTHER_ENEMY, [5, 9]),
        ]),
      ]),
    ]);

    expect(read.sources.get('citadel_weapon_bookworm_set2')).toEqual([10, 20, 35, 49]);
  });

  it('merges a weapon crit row into the weapon', () => {
    const read = readDealers([
      rawDealer(TRACKED_SLOT, [
        rawSource(WEAPON, [rawDamageTo(ENEMY, [0, 10, 20, 30])]),
        rawSource(WEAPON_CRIT, [
          rawDamageTo(ENEMY, [4, 10]),
          rawDamageTo(OTHER_ENEMY, [1, 1, 1, 1]),
        ]),
      ]),
    ]);

    expect([...read.sources.keys()]).toEqual(['citadel_weapon_bookworm_set2']);
    // The crit series is right-aligned like any other before it is added.
    expect(read.sources.get('citadel_weapon_bookworm_set2')).toEqual([1, 11, 25, 41]);
  });

  it('names a source after its crit row when it has no other row', () => {
    const read = readDealers([
      rawDealer(TRACKED_SLOT, [rawSource(WEAPON_CRIT, [rawDamageTo(ENEMY, [3, 6, 9, 12])])]),
    ]);

    expect([...read.sources.keys()]).toEqual(['citadel_weapon_bookworm_set2']);
    expect(read.sources.get('citadel_weapon_bookworm_set2')).toEqual([3, 6, 9, 12]);
  });

  it('makes the total the sum of the sources at every sample', () => {
    const read = readDealers([
      rawDealer(TRACKED_SLOT, [
        rawSource(WEAPON, [
          rawDamageTo(ENEMY, [10, 20, 30, 40]),
          rawDamageTo(OTHER_ENEMY, [1, 2, 3, 4]),
        ]),
        rawSource(WEAPON_CRIT, [rawDamageTo(ENEMY, [0, 0, 5, 7])]),
        rawSource(DRAGONFIRE, [rawDamageTo(OTHER_ENEMY, [0, 5, 5, 15])]),
        rawSource(EXPRESS_SHOT, [rawDamageTo(ENEMY, [8])]),
      ]),
    ]);

    // Weapon [11, 22, 38, 51], dragonfire [0, 5, 5, 15], express shot [0, 0, 0, 8].
    expect(read.total).toEqual([11, 27, 43, 74]);
    const summed = SAMPLES.map((_time, sample) =>
      [...read.sources.values()].reduce((sum, series) => sum + (series[sample] ?? Number.NaN), 0),
    );
    expect(read.total).toEqual(summed);
  });

  it('reads the sample grid as the matrix gives it, an irregular one included', () => {
    const read = readDealers(
      [rawDealer(TRACKED_SLOT, [rawSource(WEAPON, [rawDamageTo(ENEMY, [1, 2, 3, 4, 5])])])],
      { sample_time_s: [180, 360, 540, 900, 1_080] },
    );

    expect(read.sampleTimesS).toEqual([180, 360, 540, 900, 1_080]);
    expect(read.total).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads a grid whose last sample repeats the one before it', () => {
    // The match end can fall on the last regular sample: two samples at the same time are fine.
    const read = readDealers(
      [rawDealer(TRACKED_SLOT, [rawSource(WEAPON, [rawDamageTo(ENEMY, [1, 2, 3, 4, 5])])])],
      { sample_time_s: [180, 360, 540, 720, 720] },
    );

    expect(read.sampleTimesS).toEqual([180, 360, 540, 720, 720]);
    expect(read.total).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives no damage to a tracked player who has no dealer', () => {
    const read = readDealers([
      rawDealer(OTHER_ENEMY, [rawSource(WEAPON, [rawDamageTo(TRACKED_SLOT, [1, 2, 3, 4])])]),
    ]);

    expect(read.sources.size).toBe(0);
    expect(read.total).toEqual([0, 0, 0, 0]);
  });

  it("brings the tracked player's items with the damage", () => {
    const items = [
      { item_id: 1_002, game_time_s: 500, upgrade_id: 1, sold_time_s: 0 },
      {
        item_id: 1_001,
        game_time_s: 300,
        upgrade_id: 1,
        sold_time_s: 900,
        imbued_ability_id: 5_001,
      },
    ];
    const envelope = archive(rawMatrix([rawDealer(TRACKED_SLOT, [])]), { items });

    const read = readDamageMatrix(envelope);

    expect(read?.items).toEqual(readTrackedItems(envelope));
    expect(read?.items.map((item) => item.itemId)).toEqual([1_001, 1_002]);
  });

  it('answers null without a damage matrix', () => {
    expect(readDamageMatrix(archive(undefined))).toBeNull();
  });

  it('does not modify the envelope', () => {
    const envelope = archive(
      rawMatrix([rawDealer(TRACKED_SLOT, [rawSource(WEAPON, [rawDamageTo(ENEMY, [30, 50])])])]),
    );
    const before = structuredClone(envelope);

    readDamageMatrix(envelope);

    expect(envelope).toEqual(before);
  });

  it('refuses an archive without the tracked player', () => {
    const envelope = createArchiveEnvelope(
      archive(rawMatrix([])).payload,
      testAccountId(987_654_321),
      FETCHED_AT,
    );

    const error = catchAppError(() => readDamageMatrix(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });

  /** Where a problem is reported: the tracked dealer is the second of the list, the broken source its second one. */
  const BROKEN_SOURCE = 'damage_matrix.damage_dealers.1.damage_sources.1';

  it.each([
    [
      'an index past the source table',
      rawSource(SOURCE_ROWS.length, [rawDamageTo(ENEMY, [1, 2])]),
      `${BROKEN_SOURCE}.source_details_index: too_big`,
    ],
    [
      'a negative index',
      rawSource(-1, [rawDamageTo(ENEMY, [1, 2])]),
      `${BROKEN_SOURCE}.source_details_index: too_small`,
    ],
    [
      'an index that is no number',
      rawSource('S3CR3T', [rawDamageTo(ENEMY, [1, 2])]),
      `${BROKEN_SOURCE}.source_details_index: invalid_type`,
    ],
    [
      'a series longer than the samples',
      rawSource(DRAGONFIRE, [rawDamageTo(ENEMY, [1, 2, 3, 4, 5])]),
      `${BROKEN_SOURCE}.damage_to_players.0.damage: too_big`,
    ],
    [
      'a series that is no list',
      rawSource(DRAGONFIRE, [rawDamageTo(ENEMY, 'S3CR3T')]),
      `${BROKEN_SOURCE}.damage_to_players.0.damage: invalid_type`,
    ],
    [
      'a series that is missing',
      rawSource(DRAGONFIRE, [rawDamageTo(ENEMY, undefined)]),
      `${BROKEN_SOURCE}.damage_to_players.0.damage: invalid_type`,
    ],
    [
      'a damage that is no number',
      rawSource(DRAGONFIRE, [rawDamageTo(ENEMY, [1, 'S3CR3T'])]),
      `${BROKEN_SOURCE}.damage_to_players.0.damage.1: invalid_type`,
    ],
    [
      'a negative damage',
      rawSource(DRAGONFIRE, [rawDamageTo(ENEMY, [-1, 2])]),
      `${BROKEN_SOURCE}.damage_to_players.0.damage.0: too_small`,
    ],
  ])('reports %s by path and code only', (_name, brokenSource, issue) => {
    const envelope = archive(
      rawMatrix([
        rawDealer(OTHER_ENEMY, [rawSource(WEAPON, [rawDamageTo(TRACKED_SLOT, [1, 2])])]),
        rawDealer(TRACKED_SLOT, [rawSource(WEAPON, [rawDamageTo(ENEMY, [1, 2])]), brokenSource]),
      ]),
    );

    const error = catchAppError(() => readDamageMatrix(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe(issue);
    // The path and the code of the problem, never the value.
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });

  it.each([
    ['sample times', { sample_time_s: undefined }, 'damage_matrix.sample_time_s: invalid_type'],
    [
      'a sample time that is no number',
      { sample_time_s: [180, 'S3CR3T'] },
      'damage_matrix.sample_time_s.1: invalid_type',
    ],
    [
      'a sample grid that goes back',
      { sample_time_s: [180, 720, 360, 900] },
      'damage_matrix.sample_time_s: custom',
    ],
    [
      'a sample grid whose last sample goes back',
      { sample_time_s: [180, 360, 540, 539] },
      'damage_matrix.sample_time_s: custom',
    ],
    [
      'the source table',
      { source_details: undefined },
      'damage_matrix.source_details: invalid_type',
    ],
    [
      'a source name that is no text',
      { source_details: { stat_type: [0, 0], source_name: ['a', 7] } },
      'damage_matrix.source_details.source_name.1: invalid_type',
    ],
    [
      'a source table whose lists differ in length',
      { source_details: { stat_type: [0], source_name: ['a', 'b'] } },
      'damage_matrix.source_details: custom',
    ],
  ])('reports %s that is broken by path and code only', (_name, overrides, issue) => {
    const envelope = archive(
      rawMatrix(
        [rawDealer(TRACKED_SLOT, [rawSource(WEAPON, [rawDamageTo(ENEMY, [1, 2])])])],
        overrides,
      ),
    );

    const error = catchAppError(() => readDamageMatrix(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe(issue);
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });

  it('only checks the dealer of the tracked player', () => {
    // A broken source of another dealer is not read: the pruning keeps only a part of them.
    const read = readDealers([
      rawDealer(OTHER_ENEMY, [rawSource('S3CR3T', [rawDamageTo(TRACKED_SLOT, 'S3CR3T')])]),
      rawDealer(TRACKED_SLOT, [rawSource(WEAPON, [rawDamageTo(ENEMY, [1, 2, 3, 4])])]),
    ]);

    expect(read.total).toEqual([1, 2, 3, 4]);
  });
});

/**
 * Tests of the synthetic match details: they must read like a payload of deadlock-api, pass the same
 * validation and pruning as a real one, and always come out the same for the same match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readDamageMatrix } from '../../../core/analysis/damage-matrix';
import {
  abilityUnlockKey,
  damageSourceKey,
  itemOwnedDamageKey,
  projectDamageSources,
} from '../../../core/analysis/damage-sources';
import { buildMatchContext, statAt } from '../../../core/analysis/match-context';
import type { MatchContext, SnapshotStat } from '../../../core/analysis/match-context';
import { parseMatchMetadata } from '../../../core/deadlock-api/match-metadata.schema';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { createArchiveEnvelope } from '../../../core/match-detail/archive-envelope';
import type { ArchiveEnvelope } from '../../../core/match-detail/archive-envelope';
import { findTrackedPlayer, pruneForPlayer } from '../../../core/match-detail/pruning';
import { testAccountId, testMatchId } from '../../../test/test-data';
import {
  FIXTURE_EXPRESS_SHOT_ID,
  FIXTURE_PAIGE_ABILITY_IDS,
  FIXTURE_SHOP_ITEM_IDS,
} from './assets.fixture';
import { FIXTURE_HERO_CATALOGUE, FIXTURE_PAIGE_ITEMS } from './heroes.fixture';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
  type RawMatchHistoryRow,
} from './match-history.fixture';
import {
  createMatchMetadataFixture,
  fixtureTrackedBadge,
  isMetadataMissing,
} from './match-metadata.fixture';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** The match mode code of a ranked match; the other modes (1 = unranked) have no rank data. */
const RANKED_MATCH_MODE = 4;

/** Every valid badge: `tier × 10 + subrank`, tier 1 to 11, subrank 1 to 6. */
const VALID_BADGES = new Set(
  Array.from({ length: 11 }, (_, tier) =>
    Array.from({ length: 6 }, (_, subrank) => (tier + 1) * 10 + subrank + 1),
  ).flat(),
);

/** The counters of a snapshot that the analysis reads, besides the souls. */
const ANALYSIS_STATS = [
  'player_damage',
  'player_damage_taken',
  'boss_damage',
  'shots_hit',
  'shots_missed',
  'teammate_healing',
  'teammate_barriering',
] as const satisfies readonly SnapshotStat[];

/** The `stat_type` of the damage rows of the matrix, and of its one regeneration row. */
const DAMAGE_STAT_TYPE = 0;
const REGEN_STAT_TYPE = 5;

/**
 * The category rows of the damage matrix: each one repeats the per-source rows of its category.
 * Written out here (not read from the core) so that the readers are tested against the payload.
 */
const AGGREGATE_NAMES: ReadonlySet<string> = new Set([
  'Bullet',
  'Ability',
  'Melee',
  'UnknownAbility',
  'Misc',
]);

/** The seconds between two samples of the damage matrix; the last sample is the end of the match. */
const MATRIX_STEP_S = 180;

/** The most shop items a player owns at the end of a match: the inventory has 12 slots. */
const MAX_KEPT_ITEMS = 12;

/** `upgrade_id` of an ability unlock, and of a shop item (any other value is an ability upgrade). */
const ABILITY_UNLOCK_ID = 0;
const SHOP_ITEM_ID = 1;

/** `upgrade_info` is the mask of the ability's level shifted left by this many bits. */
const UPGRADE_INFO_SHIFT = 16;

/**
 * The part of a detail these tests look at, typed so that a field the fixture forgets or misnames
 * fails the parse. The objects are loose: the fixture may carry any other field.
 */
const detailSchema = z.looseObject({
  match_info: z.looseObject({
    match_id: z.int(),
    start_time: z.int(),
    duration_s: z.int(),
    game_mode: z.int(),
    match_mode: z.int(),
    winning_team: z.int(),
    players: z.array(
      z.looseObject({
        account_id: z.int(),
        player_slot: z.int(),
        team: z.int(),
        hero_id: z.int(),
        level: z.int(),
        kills: z.int(),
        deaths: z.int(),
        assists: z.int(),
        net_worth: z.int(),
        last_hits: z.int(),
        denies: z.int(),
        assigned_lane: z.int(),
        abandon_match_time_s: z.int(),
        player_rank_data: z.looseObject({ initial_display_rank: z.int() }).nullable(),
        stats: z.array(
          z.looseObject({
            time_stamp_s: z.int(),
            net_worth: z.int(),
            kills: z.int(),
            deaths: z.int(),
            assists: z.int(),
            player_damage: z.int(),
            player_damage_taken: z.int(),
            boss_damage: z.int(),
            shots_hit: z.int(),
            shots_missed: z.int(),
            teammate_healing: z.int(),
            teammate_barriering: z.int(),
          }),
        ),
        // Valve's top three of the match (1 to 3); `null` for the nine other players.
        mvp_rank: z.int().nullable(),
        // The seven fields every entry of a real payload has.
        items: z.array(
          z.looseObject({
            item_id: z.int(),
            game_time_s: z.int(),
            upgrade_id: z.int(),
            sold_time_s: z.int(),
            flags: z.int(),
            imbued_ability_id: z.int(),
            upgrade_info: z.int(),
          }),
        ),
        death_details: z.array(
          z.looseObject({
            game_time_s: z.int(),
            killer_player_slot: z.int(),
            death_duration_s: z.int(),
            death_pos: z.looseObject({ x: z.int(), y: z.int(), z: z.int() }),
            killer_pos: z.looseObject({ x: z.int(), y: z.int(), z: z.int() }),
          }),
        ),
      }),
    ),
    match_paths: z.looseObject({
      paths: z.array(
        z.looseObject({
          player_slot: z.int(),
          x_pos: z.array(z.int()),
          y_pos: z.array(z.int()),
        }),
      ),
    }),
    damage_matrix: z.looseObject({
      sample_time_s: z.array(z.int()),
      source_details: z.looseObject({
        stat_type: z.array(z.int()),
        source_name: z.array(z.string()),
      }),
      damage_dealers: z.array(
        z.looseObject({
          dealer_player_slot: z.int(),
          damage_sources: z.array(
            z.looseObject({
              source_details_index: z.int(),
              damage_to_players: z.array(
                z.looseObject({ target_player_slot: z.int(), damage: z.array(z.int()) }),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
});

/** A match detail, as the tests read it. */
type MatchInfo = z.infer<typeof detailSchema>['match_info'];

/** A player of a match detail, as the tests read it. */
type Player = MatchInfo['players'][number];

const HISTORY = createMatchHistoryFixture({ now: NOW });
const PAIGE_ROWS = HISTORY.filter((row) => row.hero_id === PAIGE_HERO_ID);
const PAIGE_ROW = PAIGE_ROWS[0] ?? expect.unreachable('the history holds Paige matches');

/**
 * A Paige row of the history with some fields changed.
 *
 * @param overrides - Fields to change.
 * @returns The row.
 */
function rowWith(overrides: Partial<RawMatchHistoryRow>): RawMatchHistoryRow {
  return { ...PAIGE_ROW, ...overrides };
}

/**
 * The detail of a match, validated and typed for the tests.
 *
 * @param row - The history row of the match.
 * @returns Its `match_info`.
 */
function detailOf(row: RawMatchHistoryRow): MatchInfo {
  return detailSchema.parse(createMatchMetadataFixture(row, FIXTURE_ACCOUNT_ID)).match_info;
}

/**
 * The tracked player of a detail.
 *
 * @param info - The `match_info` of the detail.
 * @returns The player of {@link FIXTURE_ACCOUNT_ID}.
 */
function trackedOf(info: MatchInfo): Player {
  return (
    info.players.find((player) => player.account_id === FIXTURE_ACCOUNT_ID) ??
    expect.unreachable('the tracked player is in the match')
  );
}

/**
 * The archive of a fixture match: the detail goes through the JSON wire, the schema, the pruning and
 * the archive envelope, as in the app.
 *
 * @param row - The history row of the match.
 * @returns The envelope the app would archive for the match.
 */
function envelopeOf(row: RawMatchHistoryRow): ArchiveEnvelope {
  const metadata = parseMatchMetadata(
    JSON.parse(JSON.stringify(createMatchMetadataFixture(row, FIXTURE_ACCOUNT_ID))),
    testMatchId(row.match_id),
  );
  const tracked = findTrackedPlayer(metadata, FIXTURE_ACCOUNT_ID);
  return createArchiveEnvelope(
    pruneForPlayer(metadata, tracked.playerSlot),
    FIXTURE_ACCOUNT_ID,
    NOW,
  );
}

/**
 * The match context the analysis builds from the archive of a fixture match.
 *
 * @param row - The history row of the match.
 * @returns The context of the match.
 */
function contextOf(row: RawMatchHistoryRow): MatchContext {
  return buildMatchContext(envelopeOf(row));
}

/** One row of the damage matrix, with its source named: what a source of a dealer did to a target. */
interface MatrixRow {
  readonly dealer: number;
  readonly name: string;
  readonly statType: number;
  readonly target: number;
  /** The series as the payload has it: right-aligned on the grid, the leading zeros trimmed. */
  readonly series: readonly number[];
}

/**
 * Flatten the damage matrix into rows, each with the name and the stat type of its source.
 *
 * @param matrix - The `damage_matrix` of a detail.
 * @returns Every row of every dealer.
 */
function matrixRows(matrix: MatchInfo['damage_matrix']): MatrixRow[] {
  const { stat_type: statTypes, source_name: names } = matrix.source_details;
  return matrix.damage_dealers.flatMap((dealer) =>
    dealer.damage_sources.flatMap((source) => {
      const name =
        names[source.source_details_index] ?? expect.unreachable('the source is in the table');
      const statType =
        statTypes[source.source_details_index] ?? expect.unreachable('the source is in the table');
      return source.damage_to_players.map((target): MatrixRow => ({
        dealer: dealer.dealer_player_slot,
        name,
        statType,
        target: target.target_player_slot,
        series: target.damage,
      }));
    }),
  );
}

/**
 * Put a right-aligned series back on the whole grid: the trimmed leading zeros are written again.
 *
 * @param series - The series of a row.
 * @param sampleCount - The number of samples of the grid.
 * @returns One value per sample.
 */
function onGrid(series: readonly number[], sampleCount: number): number[] {
  return [...Array.from({ length: sampleCount - series.length }, () => 0), ...series];
}

/**
 * The rows that make up a player's damage to enemy heroes: their own dealer, the damage rows of the
 * sources (not the category rows that repeat them), aimed at the players of the other team.
 *
 * @param info - The `match_info` of the detail.
 * @param player - The player.
 * @returns The rows, whose sum is `stats.player_damage`.
 */
function heroDamageRows(info: MatchInfo, player: Player): MatrixRow[] {
  const enemySlots = new Set(
    info.players.filter((other) => other.team !== player.team).map((other) => other.player_slot),
  );
  return matrixRows(info.damage_matrix).filter(
    (row) =>
      row.dealer === player.player_slot &&
      row.statType === DAMAGE_STAT_TYPE &&
      !AGGREGATE_NAMES.has(row.name) &&
      enemySlots.has(row.target),
  );
}

/**
 * The times of the damage matrix's samples for a match: every 180 s, then the end.
 *
 * @param durationS - Length of the match, in seconds.
 * @returns The times in ascending order; the last one is `durationS`.
 */
function expectedMatrixGrid(durationS: number): number[] {
  const times: number[] = [];
  for (let timeS = MATRIX_STEP_S; timeS < durationS; timeS += MATRIX_STEP_S) {
    times.push(timeS);
  }
  return [...times, durationS];
}

describe('createMatchMetadataFixture', () => {
  it("puts the tracked player at a known slot with the history row's numbers", () => {
    // 108_600_005 % 12 = 5: slot 6.
    const row = rowWith({
      match_id: 108_600_005,
      player_team: 1,
      hero_level: 31,
      player_kills: 7,
      player_deaths: 4,
      player_assists: 19,
      net_worth: 41_250,
      last_hits: 150,
      denies: 12,
      match_result: 0,
    });

    const info = detailOf(row);

    expect(trackedOf(info)).toMatchObject({
      player_slot: 6,
      team: 1,
      hero_id: PAIGE_HERO_ID,
      level: 31,
      kills: 7,
      deaths: 4,
      assists: 19,
      net_worth: 41_250,
      last_hits: 150,
      denies: 12,
    });
    expect(info).toMatchObject({
      match_id: row.match_id,
      start_time: row.start_time,
      duration_s: row.match_duration_s,
      game_mode: row.game_mode,
      match_mode: row.match_mode,
      winning_team: 0,
    });
  });

  it('uses every slot once and puts six players in each team, whichever team the row says', () => {
    // The slot only depends on the match id and the team on the row, so one row per slot of the
    // tracked player and per team covers every case of the history without building all of its
    // details (a few seconds on a busy runner). The two rows below sit in the same slot, in
    // opposite teams, and the other slots must still split six and six.
    const cases = new Map<string, RawMatchHistoryRow>();
    for (const row of HISTORY) {
      const key = `${String(row.match_id % 12)} ${String(row.player_team)}`;
      if (!cases.has(key)) {
        cases.set(key, row);
      }
    }
    // The history puts the tracked player in every slot, in both teams.
    expect(cases.size).toBe(12 * 2);
    for (const row of [
      ...cases.values(),
      rowWith({ player_team: 0 }),
      rowWith({ player_team: 1 }),
    ]) {
      const info = detailOf(row);
      const slots = info.players.map((player) => player.player_slot).toSorted((a, b) => a - b);
      const teamSizes = [0, 1].map(
        (team) => info.players.filter((player) => player.team === team).length,
      );

      expect(slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(teamSizes).toEqual([6, 6]);
      expect(trackedOf(info).player_slot).toBe((row.match_id % 12) + 1);
      expect(trackedOf(info).team).toBe(row.player_team);
    }
  });

  it('keeps each team in a block of slots, so a slot says which team it is in', () => {
    for (const row of HISTORY.slice(0, 40)) {
      const info = detailOf(row);
      const teamOfLowSlots = new Set(
        info.players.filter((player) => player.player_slot <= 6).map((player) => player.team),
      );
      const teamOfHighSlots = new Set(
        info.players.filter((player) => player.player_slot > 6).map((player) => player.team),
      );

      expect(teamOfLowSlots.size).toBe(1);
      expect(teamOfHighSlots.size).toBe(1);
      expect(teamOfLowSlots).not.toEqual(teamOfHighSlots);
    }
  });

  it('lists the players in no particular order, like the API', () => {
    const slots = detailOf(PAIGE_ROW).players.map((player) => player.player_slot);

    expect(slots).not.toEqual(slots.toSorted((a, b) => a - b));
  });

  it('fills the other slots with synthetic accounts, from 2,000,001 upward, and other heroes', () => {
    const playable = new Set(
      FIXTURE_HERO_CATALOGUE.filter(
        (hero) => hero.player_selectable && !hero.disabled && !hero.in_development,
      ).map((hero) => hero.id),
    );

    for (const row of PAIGE_ROWS) {
      // One detail per row: building one is the cost of this test.
      const info = detailOf(row);
      const { players } = info;
      const others = players.filter((player) => player.account_id !== FIXTURE_ACCOUNT_ID);
      const tracked = trackedOf(info);

      expect(others.map((player) => player.account_id).toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 11 }, (_, index) => 2_000_001 + index),
      );
      for (const player of others) {
        expect(playable.has(player.hero_id)).toBe(true);
      }
      // A hero is played once per team: no second Paige next to the tracked player.
      for (const team of [0, 1]) {
        const heroes = players.filter((player) => player.team === team).map((p) => p.hero_id);
        expect(new Set(heroes).size).toBe(heroes.length);
      }
      expect(
        others.filter(
          (player) => player.team === tracked.team && player.hero_id === tracked.hero_id,
        ),
      ).toEqual([]);
    }
  });

  it('generates a long match with thirteen snapshots', () => {
    const { players } = detailOf(rowWith({ match_duration_s: 3_235 }));

    for (const player of players) {
      expect(player.stats.map((snapshot) => snapshot.time_stamp_s)).toEqual([
        180, 360, 540, 720, 900, 1_200, 1_500, 1_800, 2_100, 2_400, 2_700, 3_000, 3_235,
      ]);
    }
  });

  it('snapshots a short match at the same times and ends on the match end', () => {
    const times = (durationS: number) =>
      detailOf(rowWith({ match_duration_s: durationS })).players[0]?.stats.map(
        (snapshot) => snapshot.time_stamp_s,
      );

    expect(times(600)).toEqual([180, 360, 540, 600]);
    // A match ending on a snapshot time has no second snapshot at the same second.
    expect(times(900)).toEqual([180, 360, 540, 720, 900]);
    expect(times(1_200)).toEqual([180, 360, 540, 720, 900, 1_200]);
  });

  it('ends the snapshots of every player on their final numbers, and never goes back', () => {
    const { players } = detailOf(PAIGE_ROW);

    for (const player of players) {
      const last = player.stats.at(-1);

      expect(last).toMatchObject({
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        net_worth: player.net_worth,
      });
      for (const field of ['net_worth', 'kills', 'deaths', 'assists'] as const) {
        const values = player.stats.map((snapshot) => snapshot[field]);
        expect(values).toEqual(values.toSorted((a, b) => a - b));
      }
    }
  });

  it('gives every player a lane, two per team per lane', () => {
    // The lane number is the same lane on both teams: each team holds the same three pairs.
    for (const row of HISTORY.slice(0, 40)) {
      const { players } = detailOf(row);

      for (const team of [0, 1]) {
        const lanes = players
          .filter((player) => player.team === team)
          .map((player) => player.assigned_lane)
          .toSorted((a, b) => a - b);

        expect(lanes).toEqual([1, 1, 4, 4, 6, 6]);
      }
    }
  });

  it('changes the lane of the tracked player from one match to another', () => {
    const lanes = new Set(
      HISTORY.slice(0, 60).map((row) => trackedOf(detailOf(row)).assigned_lane),
    );

    expect([...lanes].toSorted((a, b) => a - b)).toEqual([1, 4, 6]);
  });

  it('gives a badge to every player of a ranked match only', () => {
    const ranked = [
      rowWith({ match_mode: RANKED_MATCH_MODE }),
      ...HISTORY.filter((row) => row.match_mode === RANKED_MATCH_MODE).slice(0, 20),
    ];
    const unranked = [
      rowWith({ match_mode: 1 }),
      ...HISTORY.filter((row) => row.match_mode !== RANKED_MATCH_MODE).slice(0, 20),
    ];

    for (const row of ranked) {
      for (const player of detailOf(row).players) {
        expect(VALID_BADGES.has(player.player_rank_data?.initial_display_rank ?? 0)).toBe(true);
      }
    }
    for (const row of unranked) {
      for (const player of detailOf(row).players) {
        expect(player.player_rank_data).toBeNull();
      }
    }
  });

  it('snapshots carry the analysis stats and never decrease', () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      for (const player of detailOf(row).players) {
        const first = player.stats.at(0) ?? expect.unreachable('a match has snapshots');
        const last = player.stats.at(-1) ?? expect.unreachable('a match has snapshots');

        for (const field of ANALYSIS_STATS) {
          const values = player.stats.map((snapshot) => snapshot[field]);

          expect(values.every((value) => value >= 0)).toBe(true);
          expect(values).toEqual(values.toSorted((a, b) => a - b));
        }
        // These counters always grow over a whole match; healing and barriers may stay at zero.
        for (const field of ['boss_damage', 'shots_hit', 'shots_missed'] as const) {
          expect(last[field]).toBeGreaterThan(first[field]);
        }
      }
    }
  });

  it('ends the snapshots on plausible figures: about half of the shots hit', () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      for (const player of detailOf(row).players) {
        const last = player.stats.at(-1) ?? expect.unreachable('a match has snapshots');
        const accuracy = last.shots_hit / (last.shots_hit + last.shots_missed);

        expect(accuracy).toBeGreaterThan(0.3);
        expect(accuracy).toBeLessThan(0.7);
      }
    }
  });

  it('records every death with a killer of the other team, and every kill as a death', () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      const info = detailOf(row);
      const teamOfSlot = new Map(info.players.map((player) => [player.player_slot, player.team]));
      const allDeaths = info.players.flatMap((player) => player.death_details);

      for (const player of info.players) {
        expect(player.death_details).toHaveLength(player.deaths);
        // They cannot die again before they have respawned, and die inside the match.
        let respawnedAt = 0;
        for (const death of player.death_details) {
          expect(death.game_time_s).toBeGreaterThan(respawnedAt);
          expect(death.game_time_s).toBeLessThan(info.duration_s);
          expect(teamOfSlot.get(death.killer_player_slot)).toBe(1 - player.team);
          respawnedAt = death.game_time_s + death.death_duration_s;
        }
        // Their kills are the deaths that name them as the killer.
        const kills = allDeaths.filter(
          (death) => death.killer_player_slot === player.player_slot,
        ).length;
        expect(kills).toBe(player.kills);
      }
    }
  });

  it('lists the items in the order they happened, all inside the match', () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      const info = detailOf(row);
      for (const player of info.players) {
        const times = player.items.map((item) => item.game_time_s);

        expect(times).toEqual(times.toSorted((a, b) => a - b));
        expect(times.every((time) => time >= 0 && time <= info.duration_s)).toBe(true);
      }
    }
  });

  it('gives every player unlocks, upgrades and at most 12 kept shop items', () => {
    let consumed = 0;
    let soldForSouls = 0;
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      const info = detailOf(row);
      for (const player of info.players) {
        const unlocks = player.items.filter((item) => item.upgrade_id === ABILITY_UNLOCK_ID);
        const upgrades = player.items.filter((item) => item.upgrade_id > SHOP_ITEM_ID);
        const shopItems = player.items.filter((item) => item.upgrade_id === SHOP_ITEM_ID);
        const abilityIds = unlocks.map((item) => item.item_id);

        // Four abilities are unlocked, each once, with the first level of the mask.
        expect(unlocks).toHaveLength(4);
        expect(new Set(abilityIds).size).toBe(4);
        for (const unlock of unlocks) {
          expect(unlock).toMatchObject({ sold_time_s: 0, flags: 0, imbued_ability_id: 0 });
          expect(unlock.upgrade_info).toBe(1 << UPGRADE_INFO_SHIFT);
        }
        // The tracked player's abilities are Paige's, with the ids of the item catalogue.
        if (player.account_id === FIXTURE_ACCOUNT_ID) {
          expect(abilityIds.toSorted((a, b) => a - b)).toEqual(
            FIXTURE_PAIGE_ABILITY_IDS.toSorted((a, b) => a - b),
          );
        }

        // An upgrade is of an unlocked ability, comes after its unlock, and carries a level mask
        // of 2, 3 or 4 levels (the masks 3, 7 and 15).
        expect(upgrades.length).toBeGreaterThan(0);
        for (const upgrade of upgrades) {
          const unlock = unlocks.find((item) => item.item_id === upgrade.item_id);
          expect(unlock?.game_time_s).toBeLessThanOrEqual(upgrade.game_time_s);
          expect([3, 7, 15].map((mask) => mask << UPGRADE_INFO_SHIFT)).toContain(
            upgrade.upgrade_info,
          );
          expect(upgrade).toMatchObject({ sold_time_s: 0, flags: 0, imbued_ability_id: 0 });
        }

        // A shop item is of the catalogue and is bought once; the first level of the mask.
        expect(new Set(shopItems.map((item) => item.item_id)).size).toBe(shopItems.length);
        for (const item of shopItems) {
          expect(FIXTURE_SHOP_ITEM_IDS).toContain(item.item_id);
          expect(item.upgrade_info).toBe(1 << UPGRADE_INFO_SHIFT);
          // An item imbued into an ability is imbued into one of the player's own.
          if (item.imbued_ability_id !== 0) {
            expect(abilityIds).toContain(item.imbued_ability_id);
          }
          if (item.sold_time_s > 0) {
            expect(item.sold_time_s).toBeGreaterThanOrEqual(item.game_time_s);
            expect(item.sold_time_s).toBeLessThanOrEqual(info.duration_s);
          } else {
            // Kept to the end: it was not consumed by an upgrade.
            expect(item.flags).toBe(0);
          }
        }
        const consumedItems = shopItems.filter((item) => item.flags === 1);
        // A consumed component is sold in the second an upgrade was bought.
        for (const item of consumedItems) {
          expect(shopItems.some((other) => other.game_time_s === item.sold_time_s)).toBe(true);
        }
        consumed += consumedItems.length;
        soldForSouls += shopItems.filter((item) => item.flags === 0 && item.sold_time_s > 0).length;

        const kept = shopItems.filter((item) => item.sold_time_s === 0);
        expect(kept.length).toBeGreaterThanOrEqual(5);
        expect(kept.length).toBeLessThanOrEqual(MAX_KEPT_ITEMS);
      }
    }
    // Both ways to leave the inventory are among the items, or half of the rules above go unseen.
    expect(consumed).toBeGreaterThan(0);
    expect(soldForSouls).toBeGreaterThan(0);
  });

  it('buys Express Shot between 5:00 and 12:00 in about half the matches', () => {
    const rows = PAIGE_ROWS.slice(0, 60);

    const boughtAt = rows.flatMap((row) => {
      const item = trackedOf(detailOf(row)).items.find(
        (entry) => entry.item_id === FIXTURE_EXPRESS_SHOT_ID,
      );
      return item === undefined ? [] : [item.game_time_s];
    });

    expect(boughtAt.every((timeS) => timeS >= 300 && timeS <= 720)).toBe(true);
    expect(boughtAt.length / rows.length).toBeGreaterThan(0.3);
    expect(boughtAt.length / rows.length).toBeLessThan(0.7);
  });

  it('gives the top three to three players', () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      const { players } = detailOf(row);

      const ranks = players.flatMap((player) =>
        player.mvp_rank === null ? [] : [player.mvp_rank],
      );

      // Exactly one first, one second and one third place, whichever team they are in.
      expect(ranks.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
      expect(players.filter((player) => player.mvp_rank === null)).toHaveLength(9);
    }
  });

  it('gives each player a movement path with a position every second', () => {
    const info = detailOf(rowWith({ match_duration_s: 1_500 }));
    const { paths } = info.match_paths;

    expect(paths.map((path) => path.player_slot).toSorted((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const path of paths) {
      expect(path.x_pos).toHaveLength(1_501);
      expect(path.y_pos).toHaveLength(1_501);
      // Small whole numbers, like the grid of the real paths.
      expect([...path.x_pos, ...path.y_pos].every((position) => position >= 0)).toBe(true);
    }
  });

  it('has one damage dealer per player plus the non-player slot 0, with at most one value per sample', () => {
    const { damage_matrix: matrix } = detailOf(PAIGE_ROW);
    const dealerSlots = matrix.damage_dealers.map((dealer) => dealer.dealer_player_slot);
    const sourceCount = matrix.source_details.source_name.length;

    expect(dealerSlots.toSorted((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(matrix.source_details.stat_type).toHaveLength(sourceCount);
    for (const dealer of matrix.damage_dealers) {
      for (const source of dealer.damage_sources) {
        expect(source.source_details_index).toBeLessThan(sourceCount);
        for (const target of source.damage_to_players) {
          // The series is right-aligned on the grid, its leading zeros trimmed: never longer.
          expect(target.damage.length).toBeLessThanOrEqual(matrix.sample_time_s.length);
          // Cumulative damage: it never decreases.
          expect(target.damage).toEqual(target.damage.toSorted((a, b) => a - b));
        }
      }
    }
  });

  it('has players hit the other team and the non-player slot 0, never their own team', () => {
    const info = detailOf(PAIGE_ROW);
    const teamOfSlot = new Map(info.players.map((player) => [player.player_slot, player.team]));

    // Only the damage rows: the regeneration row of a player is aimed at themselves.
    for (const row of matrixRows(info.damage_matrix)) {
      const dealerTeam = teamOfSlot.get(row.dealer);
      if (row.statType === DAMAGE_STAT_TYPE && dealerTeam !== undefined && row.target !== 0) {
        expect(teamOfSlot.get(row.target)).toBe(1 - dealerTeam);
      }
    }
  });

  it("sums the tracked player's damage by source to player_damage at every sample", () => {
    let compared = 0;
    let betweenSamples = 0;
    // The long match has snapshots (1,200 s, 1,500 s…) that fall between two samples of the matrix.
    for (const row of [...PAIGE_ROWS.slice(0, 20), rowWith({ match_duration_s: 3_235 })]) {
      const info = detailOf(row);
      const grid = info.damage_matrix.sample_time_s;
      for (const player of info.players) {
        const aligned = heroDamageRows(info, player).map((source) =>
          onGrid(source.series, grid.length),
        );
        // The player's damage to enemy heroes at each sample: their sources, added.
        const total = grid.map((_, position) =>
          aligned.reduce((sum, series) => sum + (series[position] ?? 0), 0),
        );

        for (const snapshot of player.stats) {
          const position = grid.indexOf(snapshot.time_stamp_s);
          if (position === -1) {
            betweenSamples += 1;
          } else {
            expect(snapshot.player_damage).toBe(total[position]);
            compared += 1;
          }
        }
        // The match ends on both grids and the player dealt damage.
        expect(total.at(-1)).toBeGreaterThan(0);
        expect(player.stats.at(-1)?.player_damage).toBe(total.at(-1));
      }
    }
    // Both grids are among the checks: the shared times, and the snapshots that only one has.
    expect(compared).toBeGreaterThan(500);
    expect(betweenSamples).toBeGreaterThan(0);
  });

  it('right-aligns the series and duplicates the sources in the aggregate rows', () => {
    let shorterThanGrid = 0;
    for (const row of PAIGE_ROWS.slice(0, 20)) {
      const info = detailOf(row);
      const { damage_matrix: matrix } = info;
      const grid = matrix.sample_time_s;
      const rows = matrixRows(matrix);

      expect(grid).toEqual(expectedMatrixGrid(row.match_duration_s));
      for (const { series } of rows) {
        // Leading zeros trimmed: a series that is not empty starts with its first positive value.
        expect(series.length).toBeLessThanOrEqual(grid.length);
        expect(series.length === 0 || (series[0] ?? 0) > 0).toBe(true);
        shorterThanGrid += series.length < grid.length ? 1 : 0;
      }

      for (const player of info.players) {
        const own = rows.filter(
          (candidate) =>
            candidate.dealer === player.player_slot && candidate.statType === DAMAGE_STAT_TYPE,
        );
        const aggregates = own.filter((candidate) => AGGREGATE_NAMES.has(candidate.name));
        const sources = own.filter((candidate) => !AGGREGATE_NAMES.has(candidate.name));
        // Each target, the five category rows add up to what the sources dealt to it: at each
        // sample, their series (back on the whole grid) are the same.
        const sumOn = (list: readonly MatrixRow[], target: number) =>
          grid.map((_, position) =>
            list
              .filter((candidate) => candidate.target === target)
              .reduce((sum, { series }) => sum + (onGrid(series, grid.length)[position] ?? 0), 0),
          );

        expect(new Set(aggregates.map((aggregate) => aggregate.name))).toEqual(AGGREGATE_NAMES);
        for (const target of new Set(own.map((candidate) => candidate.target))) {
          expect(sumOn(aggregates, target)).toEqual(sumOn(sources, target));
        }
        // One regeneration row, aimed at the dealer: regeneration is not damage.
        expect(
          rows.filter(
            (candidate) =>
              candidate.dealer === player.player_slot && candidate.statType === REGEN_STAT_TYPE,
          ),
        ).toEqual([
          expect.objectContaining({ name: 'base_stat_regen', target: player.player_slot }),
        ]);
      }
    }
    // Some sources start after the first sample (an ability unlocked at 4:00…): the trimming is seen.
    expect(shorterThanGrid).toBeGreaterThan(0);
  });

  it("deals an item's damage only while its player owns it", () => {
    let kept = 0;
    let sold = 0;
    for (const row of PAIGE_ROWS.slice(0, 60)) {
      const info = detailOf(row);
      const grid = info.damage_matrix.sample_time_s;
      for (const player of info.players) {
        const bought = player.items.find((item) => item.item_id === FIXTURE_EXPRESS_SHOT_ID);
        const expressShotRows = matrixRows(info.damage_matrix).filter(
          (candidate) =>
            candidate.dealer === player.player_slot &&
            candidate.statType === DAMAGE_STAT_TYPE &&
            candidate.name === 'upgrade_express_shot',
        );
        if (bought === undefined) {
          // Not owned, no damage: the source is not in the matrix.
          expect(expressShotRows).toEqual([]);
          continue;
        }
        expect(expressShotRows.length).toBeGreaterThan(0);
        const ownedUntilS = bought.sold_time_s === 0 ? info.duration_s : bought.sold_time_s;
        kept += bought.sold_time_s === 0 ? 1 : 0;
        sold += bought.sold_time_s === 0 ? 0 : 1;
        for (const { series } of expressShotRows) {
          const aligned = onGrid(series, grid.length);
          for (const [position, timeS] of grid.entries()) {
            // Nothing before the purchase; nothing more once it has left the inventory.
            if (timeS <= bought.game_time_s) {
              expect(aligned[position]).toBe(0);
            }
            if (timeS >= ownedUntilS) {
              expect(aligned[position]).toBe(aligned.at(-1));
            }
          }
        }
      }
    }
    // Both an item that was kept and one that was sold again are among the cases.
    expect(kept).toBeGreaterThan(0);
    expect(sold).toBeGreaterThan(0);
  });

  it("names Paige's sources after her loadout, and Plot Armor deals no damage", () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      const info = detailOf(row);
      const tracked = trackedOf(info);
      const boughtExpressShot = tracked.items.some(
        (item) => item.item_id === FIXTURE_EXPRESS_SHOT_ID,
      );

      const names = new Set(heroDamageRows(info, tracked).map((source) => source.name));

      expect([...names].toSorted()).toEqual(
        [
          FIXTURE_PAIGE_ITEMS.weapon_primary,
          FIXTURE_PAIGE_ITEMS.weapon_melee,
          FIXTURE_PAIGE_ITEMS.signature1,
          FIXTURE_PAIGE_ITEMS.signature3,
          FIXTURE_PAIGE_ITEMS.signature4,
          ...(boughtExpressShot ? ['upgrade_express_shot'] : []),
        ].toSorted(),
      );
    }
  });

  it('passes the metadata schema and the pruning', () => {
    for (const row of PAIGE_ROWS) {
      const matchId = testMatchId(row.match_id);
      // The detail travels as JSON: validate what comes out of the wire, not the object.
      const metadata = parseMatchMetadata(
        JSON.parse(JSON.stringify(createMatchMetadataFixture(row, FIXTURE_ACCOUNT_ID))),
        matchId,
      );

      const tracked = findTrackedPlayer(metadata, FIXTURE_ACCOUNT_ID);
      const pruned = pruneForPlayer(metadata, tracked.playerSlot);

      expect(tracked).toEqual({ playerSlot: (row.match_id % 12) + 1, team: row.player_team });
      expect(pruned.match_info.match_paths?.paths.map((path) => path.player_slot)).toEqual([
        tracked.playerSlot,
      ]);
      // Every damage entry left involves the tracked player as the dealer or as the target.
      for (const dealer of pruned.match_info.damage_matrix?.damage_dealers ?? []) {
        for (const source of dealer.damage_sources) {
          for (const target of source.damage_to_players) {
            expect(
              dealer.dealer_player_slot === tracked.playerSlot ||
                target.target_player_slot === tracked.playerSlot,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('does not pass the tracked-player check of the pruning for another hero than Paige', () => {
    const row = rowWith({ hero_id: PAIGE_HERO_ID + 1 });
    const metadata = parseMatchMetadata(createMatchMetadataFixture(row, FIXTURE_ACCOUNT_ID));

    expect(() => findTrackedPlayer(metadata, FIXTURE_ACCOUNT_ID)).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });

  it('gives the tracked player the account it was asked for', () => {
    const other = testAccountId(42);

    const players = detailSchema.parse(createMatchMetadataFixture(PAIGE_ROW, other)).match_info
      .players;

    expect(players.filter((player) => player.account_id === other)).toHaveLength(1);
    expect(players.some((player) => player.account_id === FIXTURE_ACCOUNT_ID)).toBe(false);
  });

  it('is deterministic', () => {
    const first = JSON.stringify(createMatchMetadataFixture(PAIGE_ROW, FIXTURE_ACCOUNT_ID));
    const second = JSON.stringify(createMatchMetadataFixture(PAIGE_ROW, FIXTURE_ACCOUNT_ID));
    const otherMatch = JSON.stringify(
      createMatchMetadataFixture(rowWith({ match_id: PAIGE_ROW.match_id + 1 }), FIXTURE_ACCOUNT_ID),
    );

    expect(second).toBe(first);
    expect(otherMatch).not.toBe(first);
  });

  it('does not modify the history row', () => {
    const before = structuredClone(PAIGE_ROW);

    createMatchMetadataFixture(PAIGE_ROW, FIXTURE_ACCOUNT_ID);

    expect(PAIGE_ROW).toEqual(before);
  });

  it('stays smaller than a real detail (about 1 MB) for the longest match of the history', () => {
    const size = JSON.stringify(
      createMatchMetadataFixture(rowWith({ match_duration_s: 3_235 }), FIXTURE_ACCOUNT_ID),
    ).length;

    expect(size).toBeLessThan(1_000_000);
  });
});

describe('fixtureTrackedBadge', () => {
  it('is the badge of the tracked player in a ranked match, so that a test can know it', () => {
    const rankedRows = [
      rowWith({ match_mode: RANKED_MATCH_MODE }),
      ...PAIGE_ROWS.filter((row) => row.match_mode === RANKED_MATCH_MODE).slice(0, 20),
    ];

    for (const row of rankedRows) {
      const badge = trackedOf(detailOf(row)).player_rank_data?.initial_display_rank;

      expect(badge).toBe(fixtureTrackedBadge(testMatchId(row.match_id)));
    }
  });

  it('is a valid badge that depends on the match id only and differs between matches', () => {
    const badges = PAIGE_ROWS.map((row) => fixtureTrackedBadge(testMatchId(row.match_id)));

    expect(badges.every((badge) => VALID_BADGES.has(badge))).toBe(true);
    expect(new Set(badges).size).toBeGreaterThan(10);
    expect(fixtureTrackedBadge(testMatchId(PAIGE_ROW.match_id))).toBe(badges[0]);
  });
});

describe('the match context of a fixture match', () => {
  it('has the two lane opponents, the badge of a ranked match and every stat the analysis reads', () => {
    const rows = PAIGE_ROWS.slice(0, 30);
    const badges = rows.map((row) => contextOf(row).trackedBadge);

    for (const row of rows) {
      const context = contextOf(row);

      expect(context.matchMode).toBe(row.match_mode);
      expect(context.tracked.lane).not.toBeNull();
      expect(context.teammates).toHaveLength(5);
      expect(context.enemies).toHaveLength(6);
      expect(context.laneOpponents).toHaveLength(2);
      expect(context.laneOpponents.map((player) => player.lane)).toEqual([
        context.tracked.lane,
        context.tracked.lane,
      ]);
      expect(context.hasLeaver).toBe(false);
      expect(context.trackedBadge).toBe(
        row.match_mode === RANKED_MATCH_MODE
          ? fixtureTrackedBadge(testMatchId(row.match_id))
          : null,
      );
      for (const player of [context.tracked, ...context.teammates, ...context.enemies]) {
        for (const stat of ['net_worth', ...ANALYSIS_STATS] as const) {
          // The last snapshot is at the end of the match: the counter is read there, never null.
          expect(statAt(player, stat, context.durationS)).not.toBeNull();
        }
      }
    }
    // Both kinds of match are among the rows, or the test above would prove half of what it says.
    expect(badges.some((badge) => badge === null)).toBe(true);
    expect(badges.some((badge) => badge !== null)).toBe(true);
  });
});

describe('the damage and the items of a fixture match, read by the core', () => {
  it('reads back through readDamageMatrix and projectDamageSources without error', () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      const info = detailOf(row);
      const tracked = trackedOf(info);
      const envelope = envelopeOf(row);

      const read =
        readDamageMatrix(envelope) ?? expect.unreachable('the match has a damage matrix');
      const values = projectDamageSources(read);

      // The reader keeps the matrix's own grid, and the sources of the damage rows only: the
      // category rows and the regeneration row are not sources. The total is the player's damage.
      expect(read.sampleTimesS).toEqual(info.damage_matrix.sample_time_s);
      expect([...read.sources.keys()].toSorted()).toEqual(
        [...new Set(heroDamageRows(info, tracked).map((source) => source.name))].toSorted(),
      );
      expect(read.total.at(-1)).toBe(tracked.stats.at(-1)?.player_damage);
      // A source that dealt damage is a value; Plot Armor, which never does, is none.
      for (const className of read.sources.keys()) {
        expect(values.get(damageSourceKey(className))).toBeGreaterThan(0);
      }
      expect(values.has(damageSourceKey(FIXTURE_PAIGE_ITEMS.signature2))).toBe(false);
      // An ability is unlocked when its first entry says so.
      for (const abilityId of FIXTURE_PAIGE_ABILITY_IDS) {
        const unlockedAtS = tracked.items.find((item) => item.item_id === abilityId)?.game_time_s;
        expect(unlockedAtS).toBeDefined();
        expect(values.get(abilityUnlockKey(abilityId))).toBe(unlockedAtS);
      }
      // Every shop item the player had is a value: the damage they dealt while they owned it.
      for (const item of read.items.filter((entry) => entry.isShopItem)) {
        expect(values.get(itemOwnedDamageKey(item.itemId))).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('isMetadataMissing', () => {
  it('flags the match ids that are multiples of seven', () => {
    expect(isMetadataMissing(testMatchId(14))).toBe(true);
    expect(isMetadataMissing(testMatchId(108_600_002))).toBe(true);
    expect(isMetadataMissing(testMatchId(15))).toBe(false);
    expect(isMetadataMissing(testMatchId(108_600_000))).toBe(false);
  });

  it('flags about one match in seven of the history', () => {
    const missing = HISTORY.filter((row) => isMetadataMissing(testMatchId(row.match_id)));

    expect(missing.length / HISTORY.length).toBeGreaterThan(0.08);
    expect(missing.length / HISTORY.length).toBeLessThan(0.22);
  });
});

/**
 * Tests of the synthetic match details: they must read like a payload of deadlock-api, pass the same
 * validation and pruning as a real one, and always come out the same for the same match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseMatchMetadata } from '../../../core/deadlock-api/match-metadata.schema';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { findTrackedPlayer, pruneForPlayer } from '../../../core/match-detail/pruning';
import { testAccountId, testMatchId } from '../../../test/test-data';
import { FIXTURE_HERO_CATALOGUE } from './heroes.fixture';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
  type RawMatchHistoryRow,
} from './match-history.fixture';
import { createMatchMetadataFixture, isMetadataMissing } from './match-metadata.fixture';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

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
        stats: z.array(
          z.looseObject({
            time_stamp_s: z.int(),
            net_worth: z.int(),
            kills: z.int(),
            deaths: z.int(),
            assists: z.int(),
          }),
        ),
        items: z.array(
          z.looseObject({ game_time_s: z.int(), item_id: z.int(), upgrade_id: z.int().optional() }),
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
    // The slot only depends on the match id and the team on the row: both rows below sit in the
    // same slot, in opposite teams, and the other slots must still split six and six.
    for (const row of [...HISTORY, rowWith({ player_team: 0 }), rowWith({ player_team: 1 })]) {
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
      const { players } = detailOf(row);
      const others = players.filter((player) => player.account_id !== FIXTURE_ACCOUNT_ID);
      const tracked = trackedOf(detailOf(row));

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

  it('lists items, some of them ability upgrades, in the order they were bought', () => {
    for (const row of PAIGE_ROWS.slice(0, 30)) {
      const info = detailOf(row);
      for (const player of info.players) {
        const times = player.items.map((item) => item.game_time_s);
        const upgrades = player.items.filter((item) => (item.upgrade_id ?? 0) > 0);
        const purchases = player.items.filter((item) => item.upgrade_id === undefined);

        expect(times).toEqual(times.toSorted((a, b) => a - b));
        expect(upgrades.length).toBeGreaterThan(0);
        expect(purchases.length).toBeGreaterThan(0);
        expect(times.every((time) => time >= 0 && time <= info.duration_s)).toBe(true);
      }
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

  it('has one damage dealer per player plus the non-player slot 0, with one value per sample', () => {
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
          expect(target.damage).toHaveLength(matrix.sample_time_s.length);
          // Cumulative damage: it never decreases.
          expect(target.damage).toEqual(target.damage.toSorted((a, b) => a - b));
        }
      }
    }
  });

  it('has players hit the other team and the non-player slot 0, never their own team', () => {
    const info = detailOf(PAIGE_ROW);
    const teamOfSlot = new Map(info.players.map((player) => [player.player_slot, player.team]));

    for (const dealer of info.damage_matrix.damage_dealers) {
      const dealerTeam = teamOfSlot.get(dealer.dealer_player_slot);
      for (const source of dealer.damage_sources) {
        for (const target of source.damage_to_players) {
          if (dealerTeam !== undefined && target.target_player_slot !== 0) {
            expect(teamOfSlot.get(target.target_player_slot)).toBe(1 - dealerTeam);
          }
        }
      }
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

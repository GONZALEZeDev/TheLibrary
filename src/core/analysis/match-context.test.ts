/**
 * Tests of the match context: the players of an archived match split into the tracked player, their
 * teammates, their enemies and their lane opponents, the kills of the match, and the readings of a
 * player's statistic snapshots over time.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, three lanes of two players per team) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import { PAIGE_HERO_ID } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { createArchiveEnvelope } from '../match-detail/archive-envelope';
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import { testAccountId, testMatchId } from '../../test/test-data';
import { buildMatchContext, killsIn, matchMinutes, statAt } from './match-context';
import type { MatchContext, PlayerContext } from './match-context';

/** The slot of the tracked player: team 0 (slots 1 to 6), in the second lane of their team. */
const TRACKED_SLOT = 3;

/** The account of the tracked player (the other players have 2000001 and above). */
const TRACKED_ACCOUNT = testAccountId(1_000_001);

/** The match played. */
const MATCH_ID = testMatchId(100_000_001);

/** The length of the match, in seconds. */
const DURATION_S = 1_605;

/** When the detail was fetched (Unix milliseconds). */
const FETCHED_AT = 1_760_000_123_456;

/**
 * The lane of the players of a team, by position in the team: two players per lane, and the same
 * lane number on both teams (the lane the players of both teams fight in).
 */
const LANES = [1, 1, 4, 4, 6, 6];

/** The fields of a raw player or of the raw `match_info` that a test changes. */
type Overrides = Readonly<Record<string, unknown>>;

/**
 * One player in the shape of the API (fields the analysis ignores included).
 *
 * Each player has figures of their own, so that a mix-up of players shows in the context. A player
 * has no snapshots and no deaths unless a test gives them.
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param overrides - Fields to change (an `undefined` value removes the field).
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, overrides: Overrides = {}) {
  const tracked = playerSlot === TRACKED_SLOT;
  return {
    account_id: tracked ? 1_000_001 : 2_000_000 + playerSlot,
    player_slot: playerSlot,
    team: playerSlot <= 6 ? 0 : 1,
    hero_id: tracked ? PAIGE_HERO_ID : 100 + playerSlot,
    kills: playerSlot,
    deaths: playerSlot + 1,
    assists: playerSlot + 2,
    net_worth: 10_000 + playerSlot * 1_000,
    last_hits: 100 + playerSlot,
    denies: playerSlot,
    assigned_lane: LANES[(playerSlot - 1) % 6],
    abandon_match_time_s: 0,
    player_rank_data: null,
    ...overrides,
  };
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads: the player at index 3 of the list is the one of slot 9.
 *
 * @param options - What to change: fields of some players (by slot), or fields of `match_info`.
 * @returns The envelope of an unranked match.
 */
function archive(
  options: {
    readonly players?: Readonly<Record<number, Overrides>>;
    readonly matchInfo?: Overrides;
  } = {},
): ArchiveEnvelope {
  const slots = Array.from({ length: 12 }, (_, index) => 12 - index);
  const detail = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: DURATION_S,
      game_mode: 1,
      match_mode: 1,
      players: slots.map((slot) => rawPlayer(slot, options.players?.[slot])),
      ...options.matchInfo,
    },
  });
  return createArchiveEnvelope(detail, TRACKED_ACCOUNT, FETCHED_AT);
}

/**
 * Build the context of a synthetic match.
 *
 * @param options - What to change, see {@link archive}.
 * @returns The match context.
 */
function context(options: Parameters<typeof archive>[0] = {}): MatchContext {
  return buildMatchContext(archive(options));
}

/**
 * Build the tracked player of a match whose tracked player has the given snapshots.
 *
 * @param stats - The raw `stats` array of the tracked player.
 * @returns Their context.
 */
function trackedWithStats(stats: readonly unknown[]): PlayerContext {
  return context({ players: { [TRACKED_SLOT]: { stats } } }).tracked;
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

/**
 * The slots of a list of players.
 *
 * @param players - The players.
 * @returns Their slots, in the order of the list.
 */
function slotsOf(players: readonly PlayerContext[]): number[] {
  return players.map((player) => player.slot);
}

describe('buildMatchContext', () => {
  it('finds the tracked player, teammates, enemies and lane opponents', () => {
    const match = context();

    expect(match.matchId).toBe(MATCH_ID);
    expect(match.durationS).toBe(DURATION_S);
    expect(match.matchMode).toBe(1);
    expect(match.tracked).toEqual({
      slot: 3,
      team: 0,
      lane: 4,
      // The end-of-game figures of the player of slot 3, not of another one.
      kills: 3,
      deaths: 4,
      assists: 5,
      netWorth: 13_000,
      lastHits: 103,
      denies: 3,
      snapshots: [],
    });
    // The teammates exclude the tracked player; every list is ordered by slot, whatever the order
    // of the payload.
    expect(slotsOf(match.teammates)).toEqual([1, 2, 4, 5, 6]);
    expect(slotsOf(match.enemies)).toEqual([7, 8, 9, 10, 11, 12]);
    // Lane 4 on the other team: the third and fourth players of team 1.
    expect(slotsOf(match.laneOpponents)).toEqual([9, 10]);
    expect(match.laneOpponents.every((player) => player.lane === match.tracked.lane)).toBe(true);
  });

  it('has no lane opponent when the tracked player has no lane', () => {
    const match = context({ players: { [TRACKED_SLOT]: { assigned_lane: undefined } } });

    expect(match.tracked.lane).toBeNull();
    expect(match.laneOpponents).toEqual([]);
    // The enemies still have their lane.
    expect(match.enemies.map((player) => player.lane)).toEqual([1, 1, 4, 4, 6, 6]);
  });

  it('reads an absent or null lane as no lane', () => {
    const match = context({
      players: { 9: { assigned_lane: null }, 10: { assigned_lane: undefined } },
    });

    expect(match.enemies.map((player) => player.lane)).toEqual([1, 1, null, null, 6, 6]);
    // A player without a lane is nobody's lane opponent.
    expect(match.laneOpponents).toEqual([]);
  });

  it('reads the badge of a ranked match only', () => {
    const ranked = { match_mode: 4 };
    const rank = (badge: unknown) => ({
      [TRACKED_SLOT]: { player_rank_data: { initial_display_rank: badge, other: 'ignored' } },
    });

    // A ranked match: the badge the tracked player had in it.
    expect(context({ matchInfo: ranked, players: rank(43) }).trackedBadge).toBe(43);
    // An unranked match has no rank data in a real payload; with some, it still has no badge.
    expect(context({ players: rank(43) }).trackedBadge).toBeNull();
    expect(context().trackedBadge).toBeNull();
    // A placement match shows rank 0: no badge yet.
    expect(context({ matchInfo: ranked, players: rank(0) }).trackedBadge).toBeNull();
    // Rank data without a badge, empty or absent rank data.
    expect(context({ matchInfo: ranked, players: rank(undefined) }).trackedBadge).toBeNull();
    expect(context({ matchInfo: ranked, players: rank(null) }).trackedBadge).toBeNull();
    expect(
      context({ matchInfo: ranked, players: { [TRACKED_SLOT]: { player_rank_data: null } } })
        .trackedBadge,
    ).toBeNull();
    expect(
      context({ matchInfo: ranked, players: { [TRACKED_SLOT]: { player_rank_data: undefined } } })
        .trackedBadge,
    ).toBeNull();
  });

  it('reads the badge of the tracked player, not of another one', () => {
    const match = context({
      matchInfo: { match_mode: 4 },
      players: {
        [TRACKED_SLOT]: { player_rank_data: { initial_display_rank: 43 } },
        9: { player_rank_data: { initial_display_rank: 91 } },
      },
    });

    expect(match.matchMode).toBe(4);
    expect(match.trackedBadge).toBe(43);
  });

  it('flags a leaver', () => {
    expect(context().hasLeaver).toBe(false);
    expect(context({ players: { 9: { abandon_match_time_s: 1_200 } } }).hasLeaver).toBe(true);
    // The tracked player counts like any other, and the field may be absent.
    expect(context({ players: { [TRACKED_SLOT]: { abandon_match_time_s: 30 } } }).hasLeaver).toBe(
      true,
    );
    expect(
      context({
        players: { 9: { abandon_match_time_s: undefined }, 10: { abandon_match_time_s: null } },
      }).hasLeaver,
    ).toBe(false);
  });

  it('reads one kill per death with a hero killer, in time order', () => {
    const match = context({
      players: {
        9: {
          death_details: [
            { game_time_s: 1_298, killer_player_slot: 6, ignored: true },
            { game_time_s: 312, killer_player_slot: 6 },
          ],
        },
        // Killed by the environment (killer slot 0): not a kill of anyone.
        10: {
          death_details: [
            { game_time_s: 900, killer_player_slot: 0 },
            { game_time_s: 600, killer_player_slot: 6 },
          ],
        },
        8: { death_details: [{ game_time_s: 450, killer_player_slot: TRACKED_SLOT }] },
        // A player without death details, and one with an empty list, have no death.
        11: { death_details: [] },
      },
    });

    expect(match.kills).toEqual([
      { timeS: 312, killerSlot: 6, victimSlot: 9 },
      { timeS: 450, killerSlot: 3, victimSlot: 8 },
      { timeS: 600, killerSlot: 6, victimSlot: 10 },
      { timeS: 1_298, killerSlot: 6, victimSlot: 9 },
    ]);
  });

  it('sorts the snapshots of a player by time', () => {
    const player = trackedWithStats([
      { time_stamp_s: 720, net_worth: 9_000 },
      { time_stamp_s: 180, net_worth: 1_800 },
      { time_stamp_s: 540, net_worth: 6_000 },
    ]);

    expect(player.snapshots).toEqual([
      { timeS: 180, stats: { net_worth: 1_800 } },
      { timeS: 540, stats: { net_worth: 6_000 } },
      { timeS: 720, stats: { net_worth: 9_000 } },
    ]);
  });

  it('keeps of a snapshot only the statistics that are finite numbers from 0', () => {
    const player = trackedWithStats([
      {
        time_stamp_s: 180,
        net_worth: 1_800,
        player_damage: 0,
        player_damage_taken: 250.5,
        boss_damage: -5,
        shots_hit: '40',
        shots_missed: null,
        teammate_healing: Number.NaN,
        // A counter the analysis does not read is not kept.
        souls_denied: 3,
      },
    ]);

    expect(player.snapshots).toEqual([
      { timeS: 180, stats: { net_worth: 1_800, player_damage: 0, player_damage_taken: 250.5 } },
    ]);
  });

  it('reads a player without snapshots, deaths or rank data', () => {
    const match = context({
      players: {
        [TRACKED_SLOT]: {
          stats: undefined,
          death_details: undefined,
          player_rank_data: undefined,
        },
      },
    });

    expect(match.tracked.snapshots).toEqual([]);
    expect(statAt(match.tracked, 'net_worth', 600)).toBeNull();
    expect(match.kills).toEqual([]);
  });

  it('does not modify the envelope', () => {
    const envelope = archive({
      players: { 9: { stats: [{ time_stamp_s: 360 }, { time_stamp_s: 180 }] } },
    });
    const before = structuredClone(envelope);

    buildMatchContext(envelope);

    expect(envelope).toEqual(before);
  });

  it('refuses an archive without the tracked player', () => {
    const detail = archive().payload;
    const envelope = createArchiveEnvelope(detail, testAccountId(987_654_321), FETCHED_AT);

    const error = catchAppError(() => buildMatchContext(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });

  it('refuses a player without end-of-game counts, naming the path only', () => {
    // The player at index 3 of the list is the one of slot 9.
    const error = catchAppError(() => context({ players: { 9: { kills: undefined } } }));

    expect(error.kind).toBe('invalid_payload');
    expect(error.message).toBe('The archive is unreadable');
    expect(error.context.issue).toBe('players.3.kills: invalid_type');
  });

  it.each([
    ['a kill count that is not a number', { kills: 'S3CR3T' }, 'players.3.kills: invalid_type'],
    ['a negative death count', { deaths: -1 }, 'players.3.deaths: too_small'],
    ['a fractional assist count', { assists: 1.5 }, 'players.3.assists: invalid_type'],
    ['no net worth', { net_worth: undefined }, 'players.3.net_worth: invalid_type'],
    ['no last hit count', { last_hits: undefined }, 'players.3.last_hits: invalid_type'],
    ['no deny count', { denies: undefined }, 'players.3.denies: invalid_type'],
    [
      'a lane that is not a number',
      { assigned_lane: 'S3CR3T' },
      'players.3.assigned_lane: invalid_type',
    ],
    [
      'an abandon time that is not a number',
      { abandon_match_time_s: 'S3CR3T' },
      'players.3.abandon_match_time_s: invalid_type',
    ],
    ['snapshots that are not a list', { stats: 'S3CR3T' }, 'players.3.stats: invalid_type'],
    [
      'a snapshot without a time',
      { stats: [{ time_stamp_s: 180 }, { net_worth: 1_800 }] },
      'players.3.stats.1.time_stamp_s: invalid_type',
    ],
    [
      'a snapshot at a negative time',
      { stats: [{ time_stamp_s: -1 }] },
      'players.3.stats.0.time_stamp_s: too_small',
    ],
    [
      'a death without a time',
      { death_details: [{ killer_player_slot: 4 }] },
      'players.3.death_details.0.game_time_s: invalid_type',
    ],
    [
      'a death with a killer that is not a slot',
      { death_details: [{ game_time_s: 300, killer_player_slot: 'S3CR3T' }] },
      'players.3.death_details.0.killer_player_slot: invalid_type',
    ],
    [
      'a badge that is not a number',
      { player_rank_data: { initial_display_rank: 'S3CR3T' } },
      'players.3.player_rank_data.initial_display_rank: invalid_type',
    ],
  ])('refuses a player with %s', (_name, overrides, issue) => {
    const error = catchAppError(() => context({ players: { 9: overrides } }));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe(issue);
    // The path and the code of the problem, never the value.
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });

  it('refuses a match whose own fields are malformed', () => {
    const detail = archive().payload;
    const withMatchInfo = (matchInfo: Overrides) =>
      createArchiveEnvelope(
        { ...detail, match_info: { ...detail.match_info, ...matchInfo } },
        TRACKED_ACCOUNT,
        FETCHED_AT,
      );

    // The shared schema already checks these fields; the context does not rely on it.
    expect(
      catchAppError(() => buildMatchContext(withMatchInfo({ match_id: 0 }))).context.issue,
    ).toBe('match_info.match_id: custom');
    expect(
      catchAppError(() => buildMatchContext(withMatchInfo({ duration_s: -1 }))).context.issue,
    ).toBe('match_info.duration_s: too_small');
    expect(
      catchAppError(() => buildMatchContext(withMatchInfo({ match_mode: 'S3CR3T' }))).context.issue,
    ).toBe('match_info.match_mode: invalid_type');
  });
});

describe('statAt', () => {
  const netWorth = [
    { time_stamp_s: 540, net_worth: 6_000 },
    { time_stamp_s: 720, net_worth: 9_000 },
  ];

  it('interpolates a stat at 600 s', () => {
    expect(statAt(trackedWithStats(netWorth), 'net_worth', 600)).toBe(7_000);
  });

  it('returns the value of a snapshot at its own time', () => {
    const player = trackedWithStats(netWorth);

    expect(statAt(player, 'net_worth', 540)).toBe(6_000);
    // The last snapshot is still inside the range.
    expect(statAt(player, 'net_worth', 720)).toBe(9_000);
  });

  it('grows from 0 before the first snapshot', () => {
    const player = trackedWithStats([{ time_stamp_s: 180, net_worth: 1_800 }]);

    expect(statAt(player, 'net_worth', 90)).toBe(900);
    // Every counter starts at 0 when the match starts.
    expect(statAt(player, 'net_worth', 0)).toBe(0);
  });

  it('is null past the last snapshot and for a stat no snapshot has', () => {
    const player = trackedWithStats(netWorth);

    expect(statAt(player, 'net_worth', 721)).toBeNull();
    expect(statAt(player, 'player_damage', 600)).toBeNull();
    // Not even the start of the match is known for a stat that no snapshot holds.
    expect(statAt(player, 'player_damage', 0)).toBeNull();
    // Before the start of the match.
    expect(statAt(player, 'net_worth', -1)).toBeNull();
  });

  it('reads a player whose snapshots lack a stat', () => {
    // No boss_damage anywhere: the stat is unknown, the others are not affected.
    const player = trackedWithStats([
      { time_stamp_s: 540, net_worth: 6_000, player_damage: 3_000 },
      { time_stamp_s: 720, net_worth: 9_000, player_damage: 4_500 },
    ]);

    expect(statAt(player, 'boss_damage', 600)).toBeNull();
    expect(statAt(player, 'net_worth', 600)).toBe(7_000);
    expect(statAt(player, 'player_damage', 600)).toBe(3_500);
  });

  it('skips a snapshot that lacks the stat', () => {
    // The middle snapshot has no player_damage: it is read between the two that have it.
    const player = trackedWithStats([
      { time_stamp_s: 180, net_worth: 1_800, player_damage: 500 },
      { time_stamp_s: 360, net_worth: 3_600 },
      { time_stamp_s: 540, net_worth: 5_400, player_damage: 1_500 },
    ]);

    expect(statAt(player, 'player_damage', 360)).toBe(1_000);
    expect(statAt(player, 'net_worth', 360)).toBe(3_600);
  });

  it('does not depend on the order of the snapshots in the payload', () => {
    const player = trackedWithStats([...netWorth].reverse());

    expect(statAt(player, 'net_worth', 600)).toBe(7_000);
  });
});

describe('killsIn', () => {
  /** Slot 6 kills at 312, 600, 1298 and 1605 (the end of the match); slot 3 kills once. */
  const match = context({
    players: {
      9: {
        death_details: [
          { game_time_s: 312, killer_player_slot: 6 },
          { game_time_s: 1_298, killer_player_slot: 6 },
        ],
      },
      10: {
        death_details: [
          { game_time_s: 600, killer_player_slot: 6 },
          { game_time_s: 1_605, killer_player_slot: 6 },
          { game_time_s: 700, killer_player_slot: TRACKED_SLOT },
        ],
      },
    },
  });

  it('counts kills in a window, the match end included', () => {
    expect(killsIn(match, 6, 0, 600)).toBe(1);
    expect(killsIn(match, 6, 600, 1_500)).toBe(2);
    expect(killsIn(match, 6, 1_500, 1_605)).toBe(1);
  });

  it('counts the start of a window and not its end', () => {
    expect(killsIn(match, 6, 312, 313)).toBe(1);
    expect(killsIn(match, 6, 313, 600)).toBe(0);
    expect(killsIn(match, 6, 600, 601)).toBe(1);
  });

  it('counts the kills of the match end only when the window ends with the match', () => {
    expect(killsIn(match, 6, 1_500, 1_604)).toBe(0);
    expect(killsIn(match, 6, 1_500, 1_605)).toBe(1);
    // A window that goes beyond the match is not "ending with it".
    expect(killsIn(match, 6, 1_500, 1_606)).toBe(1);
  });

  it('counts the kills of one player only', () => {
    expect(killsIn(match, TRACKED_SLOT, 0, 1_605)).toBe(1);
    expect(killsIn(match, 5, 0, 1_605)).toBe(0);
    expect(killsIn(match, 6, 0, 1_605)).toBe(4);
  });
});

describe('matchMinutes', () => {
  it('converts the length of the match to minutes', () => {
    expect(matchMinutes(context())).toBe(26.75);
  });

  it('counts at least one second', () => {
    expect(matchMinutes(context({ matchInfo: { duration_s: 0 } }))).toBe(1 / 60);
  });
});

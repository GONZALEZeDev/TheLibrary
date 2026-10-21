/**
 * Tests of the scoreboard read from an archive, and of the places of the tracked player in it.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, a snapshot list per player, many fields the app ignores) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PAIGE_HERO_ID } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import { testAccountId } from '../../test/test-data';
import { createArchiveEnvelope } from './archive-envelope';
import type { ArchiveEnvelope } from './archive-envelope';
import { RANKED_MATCH_MODE, UNRANKED_MATCH_MODE } from './detail-status';
import { SCOREBOARD_PLACE_STATS, placesOf, readScoreboard } from './scoreboard';
import type { PlaceStat, ScoreboardPlayer, ScoreboardRead, StatPlace } from './scoreboard';

/** The slot of the tracked player (their team is 1: slots 7 to 12). */
const TRACKED_SLOT = 9;

/** The account of the tracked player. */
const TRACKED_ACCOUNT = testAccountId(1_000_001);

/** When the detail was fetched (Unix milliseconds). */
const FETCHED_AT = 1_760_000_123_456;

/** The length of the match, in seconds (the time of the last snapshot of every player). */
const DURATION_S = 2_070;

/** The account id of a player who is not the tracked one (2000001 and above). */
function otherAccount(playerSlot: number): number {
  return 2_000_000 + playerSlot;
}

/**
 * One statistic snapshot in the shape of the API.
 *
 * @param timeStampS - The time of the snapshot, in seconds.
 * @param counters - The cumulative counters it holds.
 * @returns The raw snapshot.
 */
function rawSnapshot(timeStampS: number, counters: Record<string, unknown>) {
  return { time_stamp_s: timeStampS, ...counters };
}

/**
 * One player in the shape of the API (fields the app ignores included).
 *
 * Every figure depends on the slot, so that a mix-up of players shows in the result. The snapshots
 * hold small counters early in the match and the figures of the slot at its end: only the last
 * counts for the scoreboard.
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param overrides - Fields to change.
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, overrides: Record<string, unknown> = {}) {
  return {
    account_id: playerSlot === TRACKED_SLOT ? 1_000_001 : otherAccount(playerSlot),
    player_slot: playerSlot,
    team: playerSlot <= 6 ? 0 : 1,
    hero_id: playerSlot === TRACKED_SLOT ? PAIGE_HERO_ID : 100 + playerSlot,
    kills: playerSlot,
    deaths: 20 + playerSlot,
    assists: 30 + playerSlot,
    net_worth: 10_000 + 1_000 * playerSlot,
    last_hits: 100 + playerSlot,
    denies: 10 + playerSlot,
    mvp_rank: null,
    // Badges 47 to 50 are accepted too (`isBadge`); naming one is `rankName`'s job (sub-ranks 1 to 6).
    player_rank_data: { initial_display_rank: 40 + playerSlot, initial_calibration_games: 0 },
    stats: [
      rawSnapshot(600, {
        player_damage: 1,
        boss_damage: 2,
        teammate_healing: 3,
        teammate_barriering: 4,
      }),
      rawSnapshot(DURATION_S, {
        player_damage: 5_000 + 100 * playerSlot,
        boss_damage: 1_000 + 10 * playerSlot,
        teammate_healing: 5 * playerSlot,
        teammate_barriering: 3 * playerSlot,
      }),
    ],
    // Fields of a real player that the scoreboard never reads.
    items: [{ item_id: 1, game_time_s: 60, upgrade_id: 1 }],
    abandon_match_time_s: 0,
    ...overrides,
  };
}

/**
 * Build an archive envelope of a match, validated like the app does.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads: the player of slot `s` is at index `12 - s`. The match is ranked, and team 1 (the
 * tracked player's) wins, unless told otherwise.
 *
 * @param options - What to change: fields of `match_info`, fields of the players by slot, or the
 *   slots present.
 * @returns The envelope.
 */
function archive(
  options: {
    readonly matchInfo?: Record<string, unknown>;
    readonly playerFields?: Readonly<Record<number, Record<string, unknown>>>;
    readonly slots?: readonly number[];
  } = {},
): ArchiveEnvelope {
  const slots = options.slots ?? Array.from({ length: 12 }, (_, index) => 12 - index);
  const detail = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: DURATION_S,
      game_mode: 1,
      match_mode: RANKED_MATCH_MODE,
      winning_team: 1,
      players: slots.map((slot) => rawPlayer(slot, options.playerFields?.[slot])),
      ...options.matchInfo,
    },
  });
  return createArchiveEnvelope(detail, TRACKED_ACCOUNT, FETCHED_AT);
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
 * Read the player of one slot of a scoreboard.
 *
 * @param read - The scoreboard.
 * @param slot - The slot to look for.
 * @returns The player.
 */
function playerOf(read: ScoreboardRead, slot: number): ScoreboardPlayer {
  const player = read.players.find((candidate) => candidate.slot === slot);
  return player ?? expect.unreachable(`no player in slot ${String(slot)}`);
}

describe('readScoreboard', () => {
  it('reads the 12 players with their heroes and end-of-game figures', () => {
    const read = readScoreboard(archive());

    expect(read.trackedSlot).toBe(TRACKED_SLOT);
    expect(read.winningTeam).toBe(1);
    expect(read.ranked).toBe(true);
    // The payload lists the players by descending slot: the read lists them by slot.
    expect(read.players.map((player) => player.slot)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(playerOf(read, 3)).toEqual({
      slot: 3,
      team: 0,
      heroId: 103,
      kills: 3,
      deaths: 23,
      assists: 33,
      netWorth: 13_000,
      lastHits: 103,
      denies: 13,
      heroDamage: 5_300,
      objectiveDamage: 1_030,
      support: 24,
      mvpRank: null,
      badge: 43,
    });
    // The tracked player is read like the others, as Paige.
    expect(playerOf(read, TRACKED_SLOT)).toMatchObject({
      team: 1,
      heroId: PAIGE_HERO_ID,
      netWorth: 19_000,
    });
  });

  it('reads a hero id of 0', () => {
    const read = readScoreboard(archive({ playerFields: { 2: { hero_id: 0 } } }));

    expect(playerOf(read, 2).heroId).toBe(0);
  });

  it('reads a defeat and an unranked match', () => {
    const read = readScoreboard(
      archive({ matchInfo: { winning_team: 0, match_mode: UNRANKED_MATCH_MODE } }),
    );

    expect(read.winningTeam).toBe(0);
    expect(read.ranked).toBe(false);
  });

  it('reads the players present when the list is not complete', () => {
    const read = readScoreboard(archive({ slots: [12, 11, 10, 9, 7, 6, 4, 3, 2, 1] }));

    expect(read.players.map((player) => player.slot)).toEqual([1, 2, 3, 4, 6, 7, 9, 10, 11, 12]);
  });

  describe('the counters of the last snapshot', () => {
    it('reads the damage to heroes and to objectives from the last snapshot', () => {
      const read = readScoreboard(archive());

      // The first snapshot (1 and 2) is ignored.
      expect(playerOf(read, 5).heroDamage).toBe(5_500);
      expect(playerOf(read, 5).objectiveDamage).toBe(1_050);
    });

    it('adds healing and barrier into support', () => {
      const read = readScoreboard(
        archive({
          playerFields: {
            1: {
              stats: [rawSnapshot(DURATION_S, { teammate_healing: 400, teammate_barriering: 90 })],
            },
            // One of the two is enough: the other counts as 0.
            2: { stats: [rawSnapshot(DURATION_S, { teammate_healing: 400 })] },
            3: { stats: [rawSnapshot(DURATION_S, { teammate_barriering: 90 })] },
            // Present and 0 is a figure (most players heal nothing), not a gap.
            4: {
              stats: [rawSnapshot(DURATION_S, { teammate_healing: 0, teammate_barriering: 0 })],
            },
            // Neither is present: nothing is known.
            5: { stats: [rawSnapshot(DURATION_S, {})] },
          },
        }),
      );

      expect([1, 2, 3, 4, 5].map((slot) => playerOf(read, slot).support)).toEqual([
        490,
        400,
        90,
        0,
        null,
      ]);
    });

    it.each([
      ['no snapshot', { stats: [] }],
      ['no list of snapshots', { stats: undefined }],
      ['a null list of snapshots', { stats: null }],
      ['snapshots that are not a list', { stats: 'S3CR3T' }],
      ['a last snapshot that is not an object', { stats: [rawSnapshot(60, {}), 'S3CR3T'] }],
      [
        'counters that are not counts',
        {
          stats: [
            rawSnapshot(DURATION_S, {
              player_damage: 'S3CR3T',
              boss_damage: -1,
              teammate_healing: 1.5,
              teammate_barriering: null,
            }),
          ],
        },
      ],
    ])('gives no damage and no support for %s', (_name, fields) => {
      const read = readScoreboard(archive({ playerFields: { 4: fields } }));

      expect(playerOf(read, 4)).toMatchObject({
        heroDamage: null,
        objectiveDamage: null,
        support: null,
        // The end-of-game figures do not depend on the snapshots.
        kills: 4,
        netWorth: 14_000,
      });
    });

    it('reads the counters that are fine next to one that is not', () => {
      const read = readScoreboard(
        archive({
          playerFields: {
            4: {
              stats: [
                rawSnapshot(DURATION_S, {
                  player_damage: 'S3CR3T',
                  boss_damage: 700,
                  teammate_healing: 'S3CR3T',
                  teammate_barriering: 60,
                }),
              ],
            },
          },
        }),
      );

      expect(playerOf(read, 4)).toMatchObject({
        heroDamage: null,
        objectiveDamage: 700,
        support: 60,
      });
    });

    it('takes the last snapshot of the list, whatever the times it holds', () => {
      const read = readScoreboard(
        archive({
          playerFields: {
            4: {
              stats: [
                rawSnapshot(300, { player_damage: 10 }),
                rawSnapshot(900, { player_damage: 30 }),
                rawSnapshot(600, { player_damage: 20 }),
              ],
            },
          },
        }),
      );

      expect(playerOf(read, 4).heroDamage).toBe(20);
    });
  });

  describe("Valve's top three", () => {
    it("reads Valve's top three and nothing else", () => {
      const read = readScoreboard(
        archive({
          playerFields: {
            // Any team, as in the real payloads.
            9: { mvp_rank: 1 },
            2: { mvp_rank: 2 },
            11: { mvp_rank: 3 },
            // The values that are no place of the top three.
            4: { mvp_rank: 0 },
            5: { mvp_rank: 4 },
            6: { mvp_rank: null },
            7: { mvp_rank: undefined },
          },
        }),
      );

      expect(read.players.map((player) => [player.slot, player.mvpRank])).toEqual([
        [1, null],
        [2, 2],
        [3, null],
        [4, null],
        [5, null],
        [6, null],
        [7, null],
        [8, null],
        [9, 1],
        [10, null],
        [11, 3],
        [12, null],
      ]);
    });

    it.each([['S3CR3T'], [1.5], [-1], [[1]], [{ rank: 1 }], [true], [Number.MAX_SAFE_INTEGER]])(
      'reads the rank %j, which is not a place, as none without refusing the archive',
      (value) => {
        const read = readScoreboard(archive({ playerFields: { 3: { mvp_rank: value } } }));

        expect(playerOf(read, 3).mvpRank).toBeNull();
      },
    );
  });

  describe('badges', () => {
    it('reads badges in a ranked match only', () => {
      const ranked = readScoreboard(archive());
      const unranked = readScoreboard(archive({ matchInfo: { match_mode: UNRANKED_MATCH_MODE } }));

      expect(ranked.players.map((player) => player.badge)).toEqual([
        41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
      ]);
      // The same ranks in a match that is not ranked mean nothing.
      expect(unranked.players.map((player) => player.badge)).toEqual(Array<null>(12).fill(null));
    });

    it('reads a placement rank as no badge', () => {
      // `0` is a player who has no rank yet; `player_rank_data` has other keys the app ignores.
      const read = readScoreboard(
        archive({
          playerFields: { 4: { player_rank_data: { initial_display_rank: 0, calibration: 6 } } },
        }),
      );

      expect(playerOf(read, 4).badge).toBeNull();
      expect(playerOf(read, 5).badge).toBe(45);
    });

    it.each([
      ['no rank data', { player_rank_data: undefined }],
      ['null rank data', { player_rank_data: null }],
      ['rank data that is not an object', { player_rank_data: 'S3CR3T' }],
      ['rank data without a rank', { player_rank_data: {} }],
      ['a null rank', { player_rank_data: { initial_display_rank: null } }],
      ['a rank that is not a number', { player_rank_data: { initial_display_rank: 'S3CR3T' } }],
      ['a rank that is not whole', { player_rank_data: { initial_display_rank: 43.5 } }],
      ['a negative rank', { player_rank_data: { initial_display_rank: -43 } }],
      ['a rank past the last badge', { player_rank_data: { initial_display_rank: 117 } }],
    ])('reads %s as no badge, without refusing the archive', (_name, fields) => {
      const read = readScoreboard(archive({ playerFields: { 4: fields } }));

      expect(playerOf(read, 4).badge).toBeNull();
      // The rest of the player, and the other players, are read.
      expect(playerOf(read, 4).kills).toBe(4);
      expect(playerOf(read, 5).badge).toBe(45);
    });
  });

  describe('what it keeps of the payload', () => {
    it('ignores every field it does not need, whatever it holds', () => {
      const read = readScoreboard(
        archive({
          playerFields: {
            4: {
              items: 'S3CR3T',
              level: { nested: true },
              accolades: -1.5,
              ability_stats: null,
              stats_type_stat: [1, 2],
              hero_data: 'S3CR3T',
              assigned_lane: 'S3CR3T',
              abandon_match_time_s: 'S3CR3T',
            },
          },
        }),
      );

      expect(playerOf(read, 4).kills).toBe(4);
    });

    it('never holds an account id', () => {
      const read = readScoreboard(archive());

      const text = JSON.stringify(read);
      expect(text).not.toContain('account');
      expect(text).not.toContain('1000001');
      for (let slot = 1; slot <= 12; slot += 1) {
        expect(text).not.toContain(String(otherAccount(slot)));
      }
    });

    it('does not modify the envelope', () => {
      const envelope = archive();
      const before = structuredClone(envelope);

      readScoreboard(envelope);

      expect(envelope).toEqual(before);
    });
  });

  describe('an archive that cannot be read', () => {
    it('refuses an archive without the tracked player', () => {
      const envelope = createArchiveEnvelope(
        archive().payload,
        testAccountId(987_654_321),
        FETCHED_AT,
      );

      const error = catchAppError(() => readScoreboard(envelope));

      expect(error.kind).toBe('invalid_payload');
      expect(error.context.issue).toBe('tracked_player_missing');
    });

    it('refuses an archive whose match has no winning team', () => {
      const error = catchAppError(() =>
        readScoreboard(archive({ matchInfo: { winning_team: undefined } })),
      );

      expect(error.kind).toBe('invalid_payload');
      expect(error.context.issue).toBe('match_info.winning_team: invalid_type');
    });

    // The slot, the team and the hero of a player are checked by the match detail schema already
    // (an archive that lacks one is refused when it is built), so only the figures are tested here.
    it.each([
      ['kills', 3, { kills: 'S3CR3T' }, 'kills: invalid_type'],
      ['deaths', 3, { deaths: undefined }, 'deaths: invalid_type'],
      ['assists', 3, { assists: -1 }, 'assists: too_small'],
      ['souls', 3, { net_worth: 1.5 }, 'net_worth: invalid_type'],
      ['last hits', 3, { last_hits: null }, 'last_hits: invalid_type'],
      ['denies', 3, { denies: undefined }, 'denies: invalid_type'],
      // The tracked player is the fourth of the list (index 3).
      ['kills of the tracked player', TRACKED_SLOT, { kills: 'S3CR3T' }, 'kills: invalid_type'],
    ])('refuses a player whose %s is malformed', (_name, slot, fields, problem) => {
      const error = catchAppError(() =>
        readScoreboard(archive({ playerFields: { [slot]: fields } })),
      );

      // The players are listed by descending slot: slot 3 is at index 9, slot 9 at index 3.
      expect(error.kind).toBe('invalid_payload');
      expect(error.context.issue).toBe(`players.${String(12 - slot)}.${problem}`);
      // The path and the code of the problem, never the value.
      expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
        'S3CR3T',
      );
    });

    it('never puts an account id in the error', () => {
      const error = catchAppError(() =>
        readScoreboard(archive({ playerFields: { 3: { kills: 'S3CR3T' } } })),
      );

      const text = JSON.stringify({ message: error.message, context: error.context });
      expect(text).not.toContain('1000001');
      for (let slot = 1; slot <= 12; slot += 1) {
        expect(text).not.toContain(String(otherAccount(slot)));
      }
    });
  });
});

/**
 * A player of a scoreboard whose five compared figures are the same unless told otherwise.
 *
 * @param slot - The slot of the player.
 * @param stats - The compared figures to change.
 * @returns The player.
 */
function scoreboardPlayer(
  slot: number,
  stats: Partial<Pick<ScoreboardPlayer, PlaceStat>> = {},
): ScoreboardPlayer {
  return {
    slot,
    team: slot <= 6 ? 0 : 1,
    heroId: 100 + slot,
    kills: 0,
    deaths: 0,
    assists: 0,
    netWorth: 1_000,
    lastHits: 50,
    denies: 0,
    heroDamage: 1_000,
    objectiveDamage: 100,
    support: 10,
    mvpRank: null,
    badge: null,
    ...stats,
  };
}

/**
 * A scoreboard of the given players, the tracked player being the first.
 *
 * @param players - The players, the first being the tracked one.
 * @returns The scoreboard.
 */
function scoreboardOf(players: readonly ScoreboardPlayer[]): ScoreboardRead {
  return { trackedSlot: players[0]?.slot ?? 0, winningTeam: 0, ranked: true, players };
}

/**
 * Find the place of one figure.
 *
 * @param places - The places of the tracked player.
 * @param stat - The figure.
 * @returns Its place, or `undefined` when there is none.
 */
function placeIn(places: readonly StatPlace[], stat: PlaceStat): StatPlace | undefined {
  return places.find((place) => place.stat === stat);
}

describe('SCOREBOARD_PLACE_STATS', () => {
  it('lists the compared figures, in the order they are shown', () => {
    expect(SCOREBOARD_PLACE_STATS).toEqual([
      'netWorth',
      'heroDamage',
      'objectiveDamage',
      'support',
      'lastHits',
    ]);
  });
});

describe('placesOf', () => {
  it('gives the place and the gap to the mean of every figure, higher being better', () => {
    const places = placesOf(
      scoreboardOf([
        scoreboardPlayer(1, {
          netWorth: 300,
          heroDamage: 100,
          objectiveDamage: 200,
          support: 0,
          lastHits: 30,
        }),
        scoreboardPlayer(2, {
          netWorth: 100,
          heroDamage: 300,
          objectiveDamage: 100,
          support: 30,
          lastHits: 30,
        }),
        scoreboardPlayer(3, {
          netWorth: 200,
          heroDamage: 200,
          objectiveDamage: 300,
          support: 60,
          lastHits: 120,
        }),
      ]),
    );

    // The figures are listed in the order of SCOREBOARD_PLACE_STATS.
    expect(places).toEqual([
      { stat: 'netWorth', place: 1, of: 3, gapToMean: 0.5 },
      { stat: 'heroDamage', place: 3, of: 3, gapToMean: -0.5 },
      { stat: 'objectiveDamage', place: 2, of: 3, gapToMean: 0 },
      { stat: 'support', place: 3, of: 3, gapToMean: -1 },
      { stat: 'lastHits', place: 2, of: 3, gapToMean: -0.5 },
    ]);
  });

  it('places the tracked player with ties sharing the best place', () => {
    const behind = placesOf(
      scoreboardOf([
        scoreboardPlayer(1, { netWorth: 20_000 }),
        scoreboardPlayer(2, { netWorth: 30_000 }),
        // Ties with the tracked player: both are second, there is no third.
        scoreboardPlayer(3, { netWorth: 20_000 }),
        scoreboardPlayer(4, { netWorth: 10_000 }),
      ]),
    );
    const sharedFirst = placesOf(
      scoreboardOf([
        scoreboardPlayer(1, { netWorth: 30_000 }),
        scoreboardPlayer(2, { netWorth: 30_000 }),
        scoreboardPlayer(3, { netWorth: 20_000 }),
      ]),
    );
    const belowTheTie = placesOf(
      scoreboardOf([
        scoreboardPlayer(1, { netWorth: 20_000 }),
        scoreboardPlayer(2, { netWorth: 30_000 }),
        scoreboardPlayer(3, { netWorth: 30_000 }),
      ]),
    );

    expect(placeIn(behind, 'netWorth')).toEqual({
      stat: 'netWorth',
      place: 2,
      of: 4,
      gapToMean: 0,
    });
    // A tie for the best is the best place.
    expect(placeIn(sharedFirst, 'netWorth')?.place).toBe(1);
    // Two players above, so third, not second.
    expect(placeIn(belowTheTie, 'netWorth')?.place).toBe(3);
  });

  it('places among the players present', () => {
    // Slot 5 is missing: the tracked player (slot 9, 19 000 souls) is compared with 11 players.
    const places = placesOf(
      readScoreboard(archive({ slots: [12, 11, 10, 9, 8, 7, 6, 4, 3, 2, 1] })),
    );

    const mean = 183_000 / 11;
    expect(placeIn(places, 'netWorth')).toEqual({
      stat: 'netWorth',
      // The players of slots 10, 11 and 12 have more souls.
      place: 4,
      of: 11,
      gapToMean: (19_000 - mean) / mean,
    });
  });

  it('places among the players that have a value', () => {
    const places = placesOf(
      scoreboardOf([
        scoreboardPlayer(1, { support: 10 }),
        scoreboardPlayer(2, { support: null }),
        scoreboardPlayer(3, { support: 30 }),
        scoreboardPlayer(4, { support: null }),
      ]),
    );

    // The two players without a figure are neither compared with nor counted in the mean (20).
    expect(placeIn(places, 'support')).toEqual({
      stat: 'support',
      place: 2,
      of: 2,
      gapToMean: -0.5,
    });
  });

  it('gives no gap when the mean is 0', () => {
    const places = placesOf(
      scoreboardOf([
        scoreboardPlayer(1, { support: 0 }),
        scoreboardPlayer(2, { support: 0 }),
        scoreboardPlayer(3, { support: 0 }),
      ]),
    );

    // Everyone ties on 0: first place for all, and no gap since there is no mean to compare with.
    expect(placeIn(places, 'support')).toEqual({
      stat: 'support',
      place: 1,
      of: 3,
      gapToMean: null,
    });
  });

  it('gives no place for a figure the tracked player has no value for', () => {
    const places = placesOf(
      scoreboardOf([
        scoreboardPlayer(1, { heroDamage: null }),
        scoreboardPlayer(2, { heroDamage: 500 }),
      ]),
    );

    expect(places.map((place) => place.stat)).toEqual([
      'netWorth',
      'objectiveDamage',
      'support',
      'lastHits',
    ]);
  });

  it('gives no place when the tracked player is not among the players', () => {
    const read = { ...scoreboardOf([scoreboardPlayer(1), scoreboardPlayer(2)]), trackedSlot: 7 };

    expect(placesOf(read)).toEqual([]);
  });

  it('places the tracked player wherever they are in the list', () => {
    const players = [
      scoreboardPlayer(1, { lastHits: 40 }),
      scoreboardPlayer(2, { lastHits: 90 }),
      scoreboardPlayer(3, { lastHits: 60 }),
    ];

    const places = placesOf({ ...scoreboardOf(players), trackedSlot: 3 });

    expect(placeIn(places, 'lastHits')).toMatchObject({ place: 2, of: 3 });
  });

  it('does not modify the scoreboard', () => {
    const read = scoreboardOf([scoreboardPlayer(1), scoreboardPlayer(2, { netWorth: 2_000 })]);
    const before = structuredClone(read);

    placesOf(read);

    expect(read).toEqual(before);
  });
});

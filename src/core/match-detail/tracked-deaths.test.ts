/**
 * Tests of the death times of the tracked player.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, each with deaths of their own) but none of its data.
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
import { readTrackedDeaths, readTrackedDeathTimes } from './tracked-deaths';

/** The slot of the tracked player (their team is 1: slots 7 to 12). */
const TRACKED_SLOT = 9;

/** The account of the tracked player. */
const TRACKED_ACCOUNT = testAccountId(1_000_001);

/** When the detail was fetched (Unix milliseconds). */
const FETCHED_AT = 1_760_000_123_456;

/** A fields override of a raw player. */
type Overrides = Readonly<Record<string, unknown>>;

/**
 * One death detail in the shape of the API (fields the app ignores included).
 *
 * @param gameTimeS - When the player died, in seconds since the start of the match.
 * @param killerPlayerSlot - The slot of the hero who killed them, `0` for no hero killer.
 * @returns The raw death detail.
 */
function rawDeath(gameTimeS: number, killerPlayerSlot = 1) {
  return { game_time_s: gameTimeS, killer_player_slot: killerPlayerSlot, death_duration_s: 20 };
}

/**
 * One death detail with everything the detailed reading needs, in the shape of the API.
 *
 * @param gameTimeS - When the player died, in seconds since the start of the match.
 * @param fields - Fields to change (an `undefined` value removes the field).
 * @returns The raw death detail.
 */
function rawPlacedDeath(gameTimeS: number, fields: Overrides = {}) {
  return {
    game_time_s: gameTimeS,
    killer_player_slot: 4,
    time_to_kill_s: 7.5,
    death_duration_s: 20,
    death_pos: { x: 1_200.5, y: -3_400.25, z: 255.9 },
    killer_pos: { x: 1_300, y: -3_300, z: 250 },
    ...fields,
  };
}

/**
 * The deaths of a player as a complete payload holds them: their count, and one detail each.
 *
 * @param timesS - When the player died, in seconds, in the order the payload lists them.
 * @returns The fields of the raw player to override.
 */
function died(timesS: readonly number[]): Overrides {
  return { deaths: timesS.length, death_details: timesS.map((timeS) => rawDeath(timeS)) };
}

/**
 * One player in the shape of the API (fields the app ignores included).
 *
 * The other players die at times of their own, so that a mix-up of players shows in the result.
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param overrides - Fields to change (an `undefined` value removes the field).
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, overrides: Overrides = {}) {
  return {
    account_id: 2_000_000 + playerSlot,
    player_slot: playerSlot,
    team: playerSlot <= 6 ? 0 : 1,
    hero_id: playerSlot === TRACKED_SLOT ? PAIGE_HERO_ID : 100 + playerSlot,
    ...died([40 * playerSlot, 90 * playerSlot]),
    ...overrides,
  };
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads, so the tracked player (slot 9) is the fourth one of the list (index 3).
 *
 * @param trackedFields - Fields of the tracked player to change (their deaths mostly).
 * @returns The envelope.
 */
function archive(trackedFields: Overrides = {}): ArchiveEnvelope {
  const slots = Array.from({ length: 12 }, (_, index) => 12 - index);
  const payload = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: 2_070,
      game_mode: 1,
      match_mode: 4,
      players: slots.map((slot) =>
        rawPlayer(slot, slot === TRACKED_SLOT ? { account_id: 1_000_001, ...trackedFields } : {}),
      ),
    },
  });
  return createArchiveEnvelope(payload, TRACKED_ACCOUNT, FETCHED_AT);
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

describe('readTrackedDeathTimes', () => {
  it("reads the tracked player's death times, sorted", () => {
    // Listed out of order, and the other players' deaths (at 40 × slot and 90 × slot) are not theirs.
    const times = readTrackedDeathTimes(archive(died([900, 120, 1_500, 300])));

    expect(times).toEqual([120, 300, 900, 1_500]);
  });

  it('keeps a death with no hero killer', () => {
    // Killer slot 0 is a death by the environment or a trooper: it is a death all the same.
    const times = readTrackedDeathTimes(
      archive({ deaths: 2, death_details: [rawDeath(200, 0), rawDeath(100, 4)] }),
    );

    expect(times).toEqual([100, 200]);
  });

  it('answers an empty list for a player who never died', () => {
    // An empty list is often left out of a payload (or sent as null): there is no death to detail.
    for (const deathDetails of [undefined, null, []]) {
      const times = readTrackedDeathTimes(archive({ deaths: 0, death_details: deathDetails }));

      expect(times, String(deathDetails)).toEqual([]);
    }
  });

  it('answers null when the death details are incomplete', () => {
    // Fewer or more details than deaths: some may be missing, so none is trusted.
    expect(
      readTrackedDeathTimes(archive({ deaths: 3, death_details: [rawDeath(100), rawDeath(200)] })),
    ).toBeNull();
    expect(
      readTrackedDeathTimes(archive({ deaths: 1, death_details: [rawDeath(100), rawDeath(200)] })),
    ).toBeNull();
    expect(readTrackedDeathTimes(archive({ deaths: 2, death_details: [] }))).toBeNull();
  });

  it('answers null when the death details are missing', () => {
    for (const deathDetails of [undefined, null]) {
      const times = readTrackedDeathTimes(archive({ deaths: 3, death_details: deathDetails }));

      expect(times, String(deathDetails)).toBeNull();
    }
  });

  it('does not modify the envelope', () => {
    const envelope = archive(died([500, 100]));
    const before = structuredClone(envelope);

    readTrackedDeathTimes(envelope);

    expect(envelope).toEqual(before);
  });

  it('refuses an archive without the tracked player', () => {
    const envelope = createArchiveEnvelope(
      archive().payload,
      testAccountId(987_654_321),
      FETCHED_AT,
    );

    const error = catchAppError(() => readTrackedDeathTimes(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });

  it('refuses a negative time with the field path only', () => {
    // The tracked player is the fourth of the list (index 3), the broken death the second (index 1).
    const error = catchAppError(() => readTrackedDeathTimes(archive(died([100, -4_242]))));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('players.3.death_details.1.game_time_s: too_small');
    // The path and the code of the problem, never the value.
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      '4242',
    );
  });

  it.each([
    ['a death count', { deaths: 'S3CR3T' }, 'players.3.deaths: invalid_type'],
    [
      'a time that is no number',
      { deaths: 2, death_details: [rawDeath(100), rawDeath('S3CR3T' as unknown as number)] },
      'players.3.death_details.1.game_time_s: invalid_type',
    ],
    [
      'death details that are not a list',
      { death_details: 'S3CR3T' },
      'players.3.death_details: invalid_type',
    ],
  ])('reports %s that is malformed by path and code only', (_name, fields, issue) => {
    const error = catchAppError(() => readTrackedDeathTimes(archive(fields)));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe(issue);
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });
});

describe('readTrackedDeaths', () => {
  it("reads the tracked player's deaths with killer, time to kill and position", () => {
    // Listed out of order: the result is sorted, and carries the fields of each death.
    const deaths = readTrackedDeaths(
      archive({
        deaths: 2,
        death_details: [
          rawPlacedDeath(900, {
            killer_player_slot: 2,
            time_to_kill_s: 3.25,
            death_duration_s: 31,
            death_pos: { x: -50.5, y: 80, z: 12 },
          }),
          rawPlacedDeath(120),
        ],
      }),
    );

    expect(deaths).toEqual([
      {
        timeS: 120,
        killerSlot: 4,
        timeToKillS: 7.5,
        respawnS: 20,
        position: { x: 1_200.5, y: -3_400.25 },
      },
      {
        timeS: 900,
        killerSlot: 2,
        timeToKillS: 3.25,
        respawnS: 31,
        position: { x: -50.5, y: 80 },
      },
    ]);
  });

  it('answers null for time to kill and respawn when absent', () => {
    // Left out or sent as null: unknown, which is not zero.
    const deaths = readTrackedDeaths(
      archive({
        deaths: 2,
        death_details: [
          rawPlacedDeath(100, { time_to_kill_s: undefined, death_duration_s: undefined }),
          rawPlacedDeath(200, { time_to_kill_s: null, death_duration_s: null }),
        ],
      }),
    );

    expect(deaths).toEqual([
      expect.objectContaining({ timeS: 100, timeToKillS: null, respawnS: null }),
      expect.objectContaining({ timeS: 200, timeToKillS: null, respawnS: null }),
    ]);
  });

  it('reads an unknown time to kill (-1) as null', () => {
    // The API writes -1 when it does not know the time to kill: unknown, never a negative time.
    const deaths = readTrackedDeaths(
      archive({
        deaths: 2,
        death_details: [rawPlacedDeath(100, { time_to_kill_s: -1 }), rawPlacedDeath(200)],
      }),
    );

    expect(deaths).toEqual([
      expect.objectContaining({ timeS: 100, timeToKillS: null }),
      expect.objectContaining({ timeS: 200, timeToKillS: 7.5 }),
    ]);
  });

  it('reads an unknown respawn wait (-1) as null', () => {
    const deaths = readTrackedDeaths(
      archive({
        deaths: 2,
        death_details: [rawPlacedDeath(100, { death_duration_s: -1 }), rawPlacedDeath(200)],
      }),
    );

    expect(deaths).toEqual([
      expect.objectContaining({ timeS: 100, respawnS: null }),
      expect.objectContaining({ timeS: 200, respawnS: 20 }),
    ]);
  });

  it('refuses a time to kill that is no number with the field path only', () => {
    const error = catchAppError(() =>
      readTrackedDeaths(
        archive({
          deaths: 2,
          death_details: [rawPlacedDeath(100), rawPlacedDeath(200, { time_to_kill_s: 'S3CR3T' })],
        }),
      ),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('players.3.death_details.1.time_to_kill_s: invalid_type');
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });

  it('keeps a death to troopers with killer slot 0', () => {
    const deaths = readTrackedDeaths(
      archive({ deaths: 1, death_details: [rawPlacedDeath(100, { killer_player_slot: 0 })] }),
    );

    expect(deaths).toEqual([expect.objectContaining({ timeS: 100, killerSlot: 0 })]);
  });

  it('answers an empty list for a player who never died', () => {
    for (const deathDetails of [undefined, null, []]) {
      const deaths = readTrackedDeaths(archive({ deaths: 0, death_details: deathDetails }));

      expect(deaths, String(deathDetails)).toEqual([]);
    }
  });

  it('answers null when the death details are incomplete', () => {
    // Fewer or more details than deaths, or none at all: some may be missing, so none is trusted.
    expect(
      readTrackedDeaths(
        archive({ deaths: 3, death_details: [rawPlacedDeath(100), rawPlacedDeath(200)] }),
      ),
    ).toBeNull();
    expect(
      readTrackedDeaths(
        archive({ deaths: 1, death_details: [rawPlacedDeath(100), rawPlacedDeath(200)] }),
      ),
    ).toBeNull();
    expect(readTrackedDeaths(archive({ deaths: 2, death_details: [] }))).toBeNull();
    for (const deathDetails of [undefined, null]) {
      expect(
        readTrackedDeaths(archive({ deaths: 3, death_details: deathDetails })),
        String(deathDetails),
      ).toBeNull();
    }
  });

  it('refuses a death position without coordinates with the field path only', () => {
    const error = catchAppError(() =>
      readTrackedDeaths(
        archive({
          deaths: 2,
          death_details: [
            rawPlacedDeath(100),
            rawPlacedDeath(200, { death_pos: { x: 'S3CR3T', z: 5 } }),
          ],
        }),
      ),
    );

    expect(error.kind).toBe('invalid_payload');
    // The tracked player is the fourth of the list (index 3), the broken death the second (index 1).
    expect(error.context.issue).toBe('players.3.death_details.1.death_pos.x: invalid_type');
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });

  it('refuses a death without a position', () => {
    const error = catchAppError(() =>
      readTrackedDeaths(
        archive({
          deaths: 1,
          death_details: [rawPlacedDeath(100, { death_pos: undefined })],
        }),
      ),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('players.3.death_details.0.death_pos: invalid_type');
  });

  it('refuses a death without a killer slot', () => {
    const error = catchAppError(() =>
      readTrackedDeaths(
        archive({
          deaths: 1,
          death_details: [rawPlacedDeath(100, { killer_player_slot: undefined })],
        }),
      ),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('players.3.death_details.0.killer_player_slot: invalid_type');
  });

  it('does not modify the envelope', () => {
    const envelope = archive({
      deaths: 2,
      death_details: [rawPlacedDeath(500), rawPlacedDeath(100)],
    });
    const before = structuredClone(envelope);

    readTrackedDeaths(envelope);

    expect(envelope).toEqual(before);
  });

  it('refuses an archive without the tracked player', () => {
    const envelope = createArchiveEnvelope(
      archive().payload,
      testAccountId(987_654_321),
      FETCHED_AT,
    );

    const error = catchAppError(() => readTrackedDeaths(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });
});

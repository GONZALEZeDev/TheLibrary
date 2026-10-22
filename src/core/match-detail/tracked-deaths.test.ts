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
import { readTrackedDeathTimes } from './tracked-deaths';

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

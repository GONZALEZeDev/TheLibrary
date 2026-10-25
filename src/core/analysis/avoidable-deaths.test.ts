/**
 * Tests of the judgement of the tracked player's deaths: who was near when they died, and whether
 * the death was avoidable.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players and twelve paths,
 * neither ordered by slot) but none of its data. Each path holds its player at one place for the
 * whole match, aligned with the match clock. The resolution and the bounds are both 16384 wide, a
 * power of two, so that a coordinate decodes to exactly itself and a distance is exact.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PAIGE_HERO_ID } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import { testAccountId } from '../../test/test-data';
import { createArchiveEnvelope } from '../match-detail/archive-envelope';
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import type { MapPoint } from '../match-detail/player-paths';
import { avoidableDeathCount, judgeDeaths } from './avoidable-deaths';
import { NEARBY_DISTANCE } from './insights/thresholds';

/** How long the match lasts, in seconds. */
const DURATION_S = 600;

/** The resolution of a path's coordinates, and the width of its bounds: a coordinate is exact. */
const RESOLUTION = 16_384;

/** The slot of the tracked player (their team is 1: slots 7 to 12, the enemies are 1 to 6). */
const TRACKED_SLOT = 9;

/** When the tracked player dies in most tests, in seconds. */
const DEATH_S = 300;

/**
 * Where the tracked player dies in most tests: near the corner of the bounds, so that a dead
 * sample, which decodes to the corner `(0, 0)`, would be near too if it were ever counted.
 */
const DEATH_AT: MapPoint = { x: 500, y: 500 };

/** Where a player stands when a test does not place them: far from {@link DEATH_AT}. */
const FAR: MapPoint = { x: 15_000, y: 15_000 };

/** The slots of a match, by descending slot: real payloads order neither players nor paths. */
const SLOTS = Array.from({ length: 12 }, (_, index) => 12 - index);

/** Where a player is at the death second: a place, or dead. */
type Placement = MapPoint | 'dead';

/**
 * A point at some distance east of {@link DEATH_AT}.
 *
 * @param distance - The distance, in world units.
 * @returns The point.
 */
function east(distance: number): MapPoint {
  return { x: DEATH_AT.x + distance, y: DEATH_AT.y };
}

/**
 * One path in the shape of the API, holding its player at one place the whole match.
 *
 * A dead player is at `(0, 0)` with no health from a few seconds before {@link DEATH_S} to a few
 * seconds after, as the API records a dead player.
 *
 * @param playerSlot - The slot of the player.
 * @param placement - Where the player is, or that they are dead around {@link DEATH_S}.
 * @returns The raw path.
 */
function rawPath(playerSlot: number, placement: Placement) {
  const indexes = Array.from({ length: DURATION_S + 1 }, (_, index) => index);
  const dead = (index: number) =>
    placement === 'dead' && index >= DEATH_S - 2 && index < DEATH_S + 8;
  const at = placement === 'dead' ? FAR : placement;
  return {
    player_slot: playerSlot,
    x_min: 0,
    x_max: RESOLUTION,
    y_min: 0,
    y_max: RESOLUTION,
    x_pos: indexes.map((index) => (dead(index) ? 0 : at.x)),
    y_pos: indexes.map((index) => (dead(index) ? 0 : at.y)),
    health: indexes.map((index) => (dead(index) ? 0 : 100)),
    combat_type: indexes.map(() => 0),
  };
}

/** One death of the tracked player, as a test describes it. */
interface DeathSpec {
  /** When they died, in seconds; {@link DEATH_S} by default. */
  readonly timeS?: number;
  /** The slot of the hero who killed them, `0` for no hero. */
  readonly killerSlot: number;
}

/** How to build an archive. */
interface ArchiveOptions {
  /** The tracked player's deaths, all at {@link DEATH_AT}; none by default. */
  readonly deaths?: readonly DeathSpec[];
  /** The count of deaths the payload announces; the length of `deaths` by default. */
  readonly deathCount?: number;
  /** Where each player is, by slot; a slot not listed is {@link FAR}. */
  readonly placements?: ReadonlyMap<number, Placement>;
  /** The slots that have a path; all twelve by default. */
  readonly pathSlots?: readonly number[];
  /** Whether the payload has `match_paths` at all. */
  readonly withPaths?: boolean;
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * Only the tracked player dies; the others never do.
 *
 * @param options - The deaths, where the players are, and which paths there are.
 * @returns The envelope.
 */
function archive(options: ArchiveOptions = {}): ArchiveEnvelope {
  const {
    deaths = [],
    deathCount = deaths.length,
    placements = new Map<number, Placement>(),
    pathSlots = SLOTS,
    withPaths = true,
  } = options;
  const trackedDeaths = deaths.map(({ timeS = DEATH_S, killerSlot }) => ({
    game_time_s: timeS,
    killer_player_slot: killerSlot,
    time_to_kill_s: 4,
    death_duration_s: 20,
    death_pos: { ...DEATH_AT, z: 100 },
  }));
  const payload = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: DURATION_S,
      game_mode: 1,
      match_mode: 4,
      players: SLOTS.map((slot) => ({
        account_id: 2_000_000 + slot,
        player_slot: slot,
        team: slot <= 6 ? 0 : 1,
        hero_id: slot === TRACKED_SLOT ? PAIGE_HERO_ID : 100 + slot,
        ...(slot === TRACKED_SLOT
          ? { deaths: deathCount, death_details: trackedDeaths }
          : { deaths: 0 }),
      })),
      ...(withPaths
        ? {
            match_paths: {
              version: 1,
              interval_s: 1,
              x_resolution: RESOLUTION,
              y_resolution: RESOLUTION,
              paths: pathSlots.map((slot) => rawPath(slot, placements.get(slot) ?? FAR)),
            },
          }
        : {}),
    },
  });
  return createArchiveEnvelope(payload, testAccountId(2_000_000 + TRACKED_SLOT), 1_760_000_123_456);
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

describe('judgeDeaths and avoidableDeathCount', () => {
  it('labels a death avoidable when alone against two enemies', () => {
    // The killer (slot 2) is near, and counted once, with another enemy; no ally is near.
    const judged = judgeDeaths(
      archive({
        deaths: [{ killerSlot: 2 }],
        placements: new Map([
          [2, east(300)],
          [3, east(1_000)],
        ]),
      }),
    );

    expect(judged.positionsKnown).toBe(true);
    expect(judged.deaths).toEqual([
      {
        timeS: DEATH_S,
        killerSlot: 2,
        timeToKillS: 4,
        respawnS: 20,
        position: DEATH_AT,
        nearby: { enemies: 2, allies: 0 },
        verdict: 'avoidable',
      },
    ]);
    expect(avoidableDeathCount(judged)).toBe(1);
  });

  it('labels a death balanced with an ally near', () => {
    const judged = judgeDeaths(
      archive({
        deaths: [{ killerSlot: 2 }],
        placements: new Map([
          [2, east(300)],
          [3, east(1_000)],
          [10, east(800)],
        ]),
      }),
    );

    expect(judged.deaths).toEqual([
      expect.objectContaining({ nearby: { enemies: 2, allies: 1 }, verdict: 'balanced' }),
    ]);
    expect(avoidableDeathCount(judged)).toBe(0);
  });

  it('labels a death balanced against one enemy', () => {
    const judged = judgeDeaths(
      archive({ deaths: [{ killerSlot: 2 }], placements: new Map([[2, east(300)]]) }),
    );

    expect(judged.deaths).toEqual([
      expect.objectContaining({ nearby: { enemies: 1, allies: 0 }, verdict: 'balanced' }),
    ]);
    expect(avoidableDeathCount(judged)).toBe(0);
  });

  it('counts a far killer among the enemies near', () => {
    // The killer (slot 2) stands far away (a long-range kill): they count all the same.
    const judged = judgeDeaths(
      archive({ deaths: [{ killerSlot: 2 }], placements: new Map([[3, east(1_000)]]) }),
    );

    expect(judged.deaths).toEqual([
      expect.objectContaining({ nearby: { enemies: 2, allies: 0 }, verdict: 'avoidable' }),
    ]);
  });

  it('leaves a death to troopers without a label', () => {
    // Two enemies are near, but no hero killed the player: the death is not judged.
    const judged = judgeDeaths(
      archive({
        deaths: [{ killerSlot: 0 }],
        placements: new Map([
          [3, east(500)],
          [4, east(1_000)],
        ]),
      }),
    );

    expect(judged.deaths).toEqual([
      expect.objectContaining({ nearby: { enemies: 2, allies: 0 }, verdict: null }),
    ]);
    expect(avoidableDeathCount(judged)).toBe(0);
  });

  it('never counts a dead player as near', () => {
    // A dead sample decodes to the corner (0, 0), within the distance of the death: still not near.
    const judged = judgeDeaths(
      archive({
        deaths: [{ killerSlot: 2 }],
        placements: new Map<number, Placement>([
          [3, 'dead'],
          [10, 'dead'],
        ]),
      }),
    );

    expect(judged.deaths).toEqual([
      expect.objectContaining({ nearby: { enemies: 1, allies: 0 }, verdict: 'balanced' }),
    ]);
  });

  it('counts a player exactly at the distance as near', () => {
    // Slot 3 stands exactly at the distance, slot 4 one unit past it.
    const judged = judgeDeaths(
      archive({
        deaths: [{ killerSlot: 2 }],
        placements: new Map([
          [3, east(NEARBY_DISTANCE)],
          [4, east(NEARBY_DISTANCE + 1)],
        ]),
      }),
    );

    expect(judged.deaths).toEqual([
      expect.objectContaining({ nearby: { enemies: 2, allies: 0 }, verdict: 'avoidable' }),
    ]);
  });

  it('knows no positions when a path is missing', () => {
    // Eleven paths: the player without one may have been near, so no death is judged.
    const judged = judgeDeaths(
      archive({
        deaths: [{ killerSlot: 2 }, { timeS: 450, killerSlot: 3 }],
        placements: new Map([
          [2, east(300)],
          [3, east(1_000)],
        ]),
        pathSlots: SLOTS.filter((slot) => slot !== 5),
      }),
    );

    expect(judged.positionsKnown).toBe(false);
    expect(judged.deaths).toEqual([
      expect.objectContaining({ timeS: DEATH_S, nearby: null, verdict: null }),
      expect.objectContaining({ timeS: 450, nearby: null, verdict: null }),
    ]);
    expect(avoidableDeathCount(judged)).toBeNull();
  });

  it('knows no positions in a format-1 archive', () => {
    // A format-1 archive holds the tracked player's path alone.
    const judged = judgeDeaths(archive({ deaths: [{ killerSlot: 2 }], pathSlots: [TRACKED_SLOT] }));

    expect(judged.positionsKnown).toBe(false);
    expect(judged.deaths).toEqual([expect.objectContaining({ nearby: null, verdict: null })]);
    expect(avoidableDeathCount(judged)).toBeNull();
  });

  it('knows no positions without match paths', () => {
    const judged = judgeDeaths(archive({ deaths: [{ killerSlot: 2 }], withPaths: false }));

    expect(judged.positionsKnown).toBe(false);
    expect(judged.deaths).toEqual([expect.objectContaining({ nearby: null, verdict: null })]);
    expect(avoidableDeathCount(judged)).toBeNull();
  });

  it('counts no avoidable death for a player who never died', () => {
    const judged = judgeDeaths(archive());

    expect(judged).toEqual({ deaths: [], positionsKnown: true });
    expect(avoidableDeathCount(judged)).toBe(0);
  });

  it('answers a null count when the death details are incomplete', () => {
    // Two deaths announced, one detailed: the deaths are unknown, though the positions are known.
    const judged = judgeDeaths(archive({ deaths: [{ killerSlot: 2 }], deathCount: 2 }));

    expect(judged).toEqual({ deaths: null, positionsKnown: true });
    expect(avoidableDeathCount(judged)).toBeNull();
  });

  it('counts each avoidable death of a match', () => {
    // Two deaths alone against the far killer and slot 3, one to troopers; sorted by time.
    const judged = judgeDeaths(
      archive({
        deaths: [
          { timeS: 100, killerSlot: 2 },
          { timeS: 450, killerSlot: 2 },
          { timeS: 200, killerSlot: 0 },
        ],
        placements: new Map([[3, east(1_000)]]),
      }),
    );

    expect(judged.deaths?.map((death) => death.verdict)).toEqual(['avoidable', null, 'avoidable']);
    expect(avoidableDeathCount(judged)).toBe(2);
  });

  it('lets an invalid payload error of a reader through', () => {
    const envelope = createArchiveEnvelope(
      archive().payload,
      testAccountId(987_654_321),
      1_760_000_123_456,
    );

    const error = catchAppError(() => judgeDeaths(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });

  it('does not modify the envelope', () => {
    const envelope = archive({ deaths: [{ killerSlot: 2 }], placements: new Map([[2, east(1)]]) });
    const before = structuredClone(envelope);

    judgeDeaths(envelope);

    expect(envelope).toEqual(before);
  });
});

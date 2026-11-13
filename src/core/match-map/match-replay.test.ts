/**
 * Tests of the replay read out of an archive.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players, one aligned
 * path each) but none of its data. An alive sample `i` of a built path holds `x_pos = i`, so with
 * the unit bounds below a position tells which sample it was read from.
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
import { isDeadAt, readMatchReplay } from './match-replay';
import type { MatchReplay, ReplayPlayerTrack } from './match-replay';

/** How long the match lasts, in seconds. */
const DURATION_S = 600;

/** The resolution of a path's coordinates, as the API sends it. */
const RESOLUTION = 16_383;

/** The slot of the tracked player (their team is 1: slots 7 to 12). */
const SLOT = 9;

/** The y every alive sample of a built path holds (any value but 0 would do). */
const ALIVE_Y = 8_000;

/** The slots of a match, by descending slot: real payloads order neither players nor paths. */
const SLOTS = Array.from({ length: 12 }, (_, index) => 12 - index);

/**
 * One path in the shape of the API: an alive sample `i` is at `(i, ALIVE_Y)` with a full health,
 * a dead one is at `(0, 0)` with no health. The bounds are as wide as the resolution, so a
 * coordinate decodes to itself.
 *
 * @param playerSlot - The slot of the player.
 * @param length - The count of samples.
 * @param deadRuns - The dead samples, as `[first index, count]` runs.
 * @returns The raw path.
 */
function rawPath(
  playerSlot: number,
  length: number,
  deadRuns: readonly (readonly [number, number])[] = [],
) {
  const dead = (index: number) =>
    deadRuns.some(([first, count]) => index >= first && index < first + count);
  const indexes = Array.from({ length }, (_, index) => index);
  return {
    player_slot: playerSlot,
    x_min: 0,
    x_max: RESOLUTION,
    y_min: 0,
    y_max: RESOLUTION,
    x_pos: indexes.map((index) => (dead(index) ? 0 : index)),
    y_pos: indexes.map((index) => (dead(index) ? 0 : ALIVE_Y)),
    health: indexes.map((index) => (dead(index) ? 0 : 100)),
  };
}

/** A death of a built player: when, and how long the wait to respawn (left out when `undefined`). */
interface RawDeath {
  readonly timeS: number;
  readonly durationS?: number;
  /** The `killer_player_slot` of the death: 1 when the key is missing, the field is left out when
   * it is `undefined`. */
  readonly killer?: unknown;
}

/** How to build an archive. */
interface ArchiveOptions {
  /** The paths; by default, one aligned path with no death for each of the twelve slots. */
  readonly paths?: readonly unknown[];
  /** The deaths of the players, by slot; a slot not listed never died. */
  readonly deathsBySlot?: ReadonlyMap<number, readonly RawDeath[]>;
  /** Fields that replace those of the `match_paths` header (to make it malformed). */
  readonly pathsHeader?: Readonly<Record<string, unknown>>;
  /** Whether the payload has `match_paths` at all. */
  readonly withPaths?: boolean;
  /** Extra fields of `match_info` (`objectives`, `mid_boss`…). */
  readonly matchInfoFields?: Readonly<Record<string, unknown>>;
  /** The archive format. */
  readonly archiveFormat?: 1 | 2;
  /** The account the archive is pruned for. */
  readonly trackedSlot?: number;
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * @param options - What to change from a match of aligned players who never die.
 * @returns The envelope.
 */
function archive(options: ArchiveOptions = {}): ArchiveEnvelope {
  const {
    paths = SLOTS.map((slot) => rawPath(slot, DURATION_S + 1)),
    deathsBySlot = new Map<number, readonly RawDeath[]>(),
    withPaths = true,
    pathsHeader = {},
    matchInfoFields = {},
    archiveFormat = 2,
    trackedSlot = SLOT,
  } = options;
  const payload = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: DURATION_S,
      game_mode: 1,
      match_mode: 4,
      players: SLOTS.map((slot) => {
        const deaths = deathsBySlot.get(slot) ?? [];
        return {
          account_id: 2_000_000 + slot,
          player_slot: slot,
          team: slot <= 6 ? 0 : 1,
          hero_id: slot === trackedSlot ? PAIGE_HERO_ID : 100 + slot,
          deaths: deaths.length,
          death_details: deaths.map((death) => ({
            game_time_s: death.timeS,
            // Slot 1 unless the test gives a killer; an `undefined` one leaves the field out.
            ...(death.killer === undefined && 'killer' in death
              ? {}
              : { killer_player_slot: 'killer' in death ? death.killer : 1 }),
            ...(death.durationS === undefined ? {} : { death_duration_s: death.durationS }),
          })),
        };
      }),
      ...(withPaths
        ? {
            match_paths: {
              version: 1,
              interval_s: 1,
              x_resolution: RESOLUTION,
              y_resolution: RESOLUTION,
              paths,
              ...pathsHeader,
            },
          }
        : {}),
      ...matchInfoFields,
    },
  });
  const envelope = createArchiveEnvelope(
    payload,
    testAccountId(2_000_000 + trackedSlot),
    1_760_000_123_456,
  );
  return { ...envelope, archiveFormat };
}

/**
 * The track of a player of a replay.
 *
 * @param replay - The replay.
 * @param slot - The slot of the player.
 * @returns Their track.
 */
function trackOf(replay: MatchReplay, slot: number): ReplayPlayerTrack {
  const track = replay.players.find((player) => player.slot === slot);
  if (track === undefined) {
    return expect.unreachable('the player should have a track');
  }
  return track;
}

/**
 * Run a call that must fail with an {@link AppError} and return that error.
 *
 * @param action - The call under test.
 * @returns The error it threw.
 */
function failureOf(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  return expect.unreachable('the call should have failed');
}

describe('readMatchReplay', () => {
  it('positions has durationS + 1 entries whatever the path length', () => {
    // The path of the tracked player is shorter than the match, the others are longer.
    const paths = SLOTS.map((slot) => rawPath(slot, slot === SLOT ? 100 : DURATION_S + 50));
    const replay = readMatchReplay(archive({ paths }));
    expect(replay.durationS).toBe(DURATION_S);
    for (const player of replay.players) {
      expect(player.positions).toHaveLength(DURATION_S + 1);
    }
    // The player with the short path still has positions: the clock stretches it over the match.
    expect(trackOf(replay, SLOT).positions[99]).not.toBeNull();
  });

  it('hides a player during death_duration_s even when the path sample is alive', () => {
    // The path never shows the death (all samples alive) but the payload says they were dead.
    const deathsBySlot = new Map([[SLOT, [{ timeS: 100, durationS: 10 }]]]);
    const replay = readMatchReplay(archive({ deathsBySlot }));
    const { positions } = trackOf(replay, SLOT);
    expect(positions[99]).not.toBeNull();
    expect(positions[100]).toBeNull();
    expect(positions[109]).toBeNull();
    expect(positions[110]).not.toBeNull();
  });

  it('coverage is all / tracked_only for a format-1 archive / none without match_paths', () => {
    expect(readMatchReplay(archive()).coverage).toBe('all');
    expect(readMatchReplay(archive({ archiveFormat: 1 })).coverage).toBe('tracked_only');
    expect(readMatchReplay(archive({ withPaths: false })).coverage).toBe('none');
    // Paths that exist but none readable: nothing to show either.
    expect(readMatchReplay(archive({ paths: [] })).coverage).toBe('none');
  });

  it('a player without a path has hasPath false and only null positions', () => {
    const paths = SLOTS.filter((slot) => slot !== 3).map((slot) => rawPath(slot, DURATION_S + 1));
    const replay = readMatchReplay(archive({ paths }));
    const track = trackOf(replay, 3);
    expect(track.hasPath).toBe(false);
    expect(track.positions.every((position) => position === null)).toBe(true);
    expect(trackOf(replay, SLOT).hasPath).toBe(true);
  });

  it('objective destroyed_time_s 0 is read as surviving (null)', () => {
    const objectives = [
      { team: 1, team_objective_id: 3, destroyed_time_s: 0 },
      { team: 0, team_objective_id: 4, destroyed_time_s: 321 },
      { team: 0, team_objective_id: 1, destroyed_time_s: 200 },
      // Lane 2 and unknown ids are left out.
      { team: 0, team_objective_id: 2, destroyed_time_s: 50 },
      { team: 0, team_objective_id: 99, destroyed_time_s: 50 },
    ];
    const replay = readMatchReplay(archive({ matchInfoFields: { objectives } }));
    expect(replay.objectives).toEqual([
      { team: 0, teamObjectiveId: 1, destroyedAtS: 200 },
      { team: 0, teamObjectiveId: 4, destroyedAtS: 321 },
      { team: 1, teamObjectiveId: 3, destroyedAtS: null },
    ]);
  });

  it('reads mid boss kills, and [] when the key is absent', () => {
    const midBoss = [
      { team_killed: 1, team_claimed: 0, destroyed_time_s: 900 },
      { team_killed: 0, team_claimed: 1, destroyed_time_s: 500 },
    ];
    const replay = readMatchReplay(archive({ matchInfoFields: { mid_boss: midBoss } }));
    expect(replay.midBossKills).toEqual([
      { timeS: 500, teamKilled: 0, teamClaimed: 1 },
      { timeS: 900, teamKilled: 1, teamClaimed: 0 },
    ]);
    const bare = readMatchReplay(archive());
    expect(bare.midBossKills).toEqual([]);
    expect(bare.objectives).toEqual([]);
  });

  it('the tracked player is the one of prunedForAccountId', () => {
    const replay = readMatchReplay(archive({ trackedSlot: 4 }));
    expect(
      replay.players.filter((player) => player.isTracked).map((player) => player.slot),
    ).toEqual([4]);
    // Slot 4 is on team 0.
    expect(replay.trackedTeam).toBe(0);
    // Players are sorted by slot.
    expect(replay.players.map((player) => player.slot)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('sorts the deaths and reads respawnS as null without death_duration_s (no path)', () => {
    // The player has no path, so nothing extends the API's own wait.
    const paths = SLOTS.filter((slot) => slot !== SLOT).map((slot) =>
      rawPath(slot, DURATION_S + 1),
    );
    const deathsBySlot = new Map([[SLOT, [{ timeS: 300, durationS: 20 }, { timeS: 100 }]]]);
    const { deaths } = trackOf(readMatchReplay(archive({ paths, deathsBySlot })), SLOT);
    expect(deaths).toEqual([
      { timeS: 100, respawnS: null, killerSlot: 1 },
      { timeS: 300, respawnS: 320, killerSlot: 1 },
    ]);
  });

  it('reads a negative death_duration_s as absent', () => {
    const paths = SLOTS.filter((slot) => slot !== SLOT).map((slot) =>
      rawPath(slot, DURATION_S + 1),
    );
    const deathsBySlot = new Map([[SLOT, [{ timeS: 100, durationS: -5 }]]]);
    const { deaths } = trackOf(readMatchReplay(archive({ paths, deathsBySlot })), SLOT);
    expect(deaths).toEqual([{ timeS: 100, respawnS: null, killerSlot: 1 }]);
  });

  it('treats a malformed match_paths header as no paths', () => {
    const replay = readMatchReplay(archive({ pathsHeader: { interval_s: 'secret-value' } }));
    expect(replay.coverage).toBe('none');
    expect(replay.players.every((player) => !player.hasPath)).toBe(true);
    expect(replay.players).toHaveLength(12);
  });

  describe('health', () => {
    it('has durationS + 1 entries and is null while the player is dead', () => {
      const paths = SLOTS.map((slot) =>
        rawPath(slot, DURATION_S + 1, slot === SLOT ? [[101, 12]] : []),
      );
      const deathsBySlot = new Map([[SLOT, [{ timeS: 100, durationS: 10 }]]]);
      const track = trackOf(readMatchReplay(archive({ paths, deathsBySlot })), SLOT);
      expect(track.health).toHaveLength(DURATION_S + 1);
      expect(track.health[99]).toBe(100);
      // Null exactly where the position is null (the extended respawn included).
      expect(track.health[100]).toBeNull();
      expect(track.health[112]).toBeNull();
      expect(track.health[113]).toBe(100);
      expect(track.health.map((value) => value === null)).toEqual(
        track.positions.map((position) => position === null),
      );
    });

    it('is all null without a path', () => {
      const paths = SLOTS.filter((slot) => slot !== 3).map((slot) => rawPath(slot, DURATION_S + 1));
      const { health } = trackOf(readMatchReplay(archive({ paths })), 3);
      expect(health).toHaveLength(DURATION_S + 1);
      expect(health.every((value) => value === null)).toBe(true);
    });

    it('is null for a path without a health array', () => {
      // `health: undefined` is a path with no health at all (the key is dropped on parsing).
      const paths = SLOTS.map((slot) => ({ ...rawPath(slot, DURATION_S + 1), health: undefined }));
      const track = trackOf(readMatchReplay(archive({ paths })), SLOT);
      expect(track.positions[10]).not.toBeNull();
      expect(track.health.every((value) => value === null)).toBe(true);
    });

    it('a format-1 archive gives health for the tracked player only', () => {
      // A format-1 archive only holds the tracked player's path.
      const paths = [rawPath(SLOT, DURATION_S + 1)];
      const replay = readMatchReplay(archive({ paths, archiveFormat: 1 }));
      expect(trackOf(replay, SLOT).health[10]).toBe(100);
      for (const player of replay.players.filter((other) => other.slot !== SLOT)) {
        expect(player.health).toHaveLength(DURATION_S + 1);
        expect(player.health.every((value) => value === null)).toBe(true);
      }
    });
  });

  describe('killerSlot', () => {
    /** The killer slots of the deaths of the tracked player, in time order. */
    function killersOf(killers: readonly unknown[]): readonly (number | null)[] {
      const deaths = killers.map((killer, index) => ({ timeS: 100 + index * 50, killer }));
      const replay = readMatchReplay(archive({ deathsBySlot: new Map([[SLOT, deaths]]) }));
      return trackOf(replay, SLOT).deaths.map((death) => death.killerSlot);
    }

    it('is the killer slot, null for 0 and for a slot not in the match', () => {
      expect(killersOf([4, 0, 13, 99, 12])).toEqual([4, null, null, null, 12]);
    });

    it('is null when the killer is absent or null', () => {
      expect(killersOf([undefined, null])).toEqual([null, null]);
    });

    it('reads an unreadable killer as null instead of failing the replay', () => {
      expect(killersOf(['secret-value', -3, 2.5])).toEqual([null, null, null]);
    });
  });

  describe('respawn read from the path', () => {
    it('extends the respawn when the path stays dead longer than death_duration_s', () => {
      // The payload: dead 100..109. The path: dead 101..112 (one second later, and longer).
      const paths = SLOTS.map((slot) =>
        rawPath(slot, DURATION_S + 1, slot === SLOT ? [[101, 12]] : []),
      );
      const deathsBySlot = new Map([[SLOT, [{ timeS: 100, durationS: 10 }]]]);
      const track = trackOf(readMatchReplay(archive({ paths, deathsBySlot })), SLOT);
      expect(track.deaths).toEqual([{ timeS: 100, respawnS: 113, killerSlot: 1 }]);
      // Dead (panel and map) at the API's respawn second, alive at the extended one.
      expect(isDeadAt(track.deaths, 110)).toBe(true);
      expect(track.positions[110]).toBeNull();
      expect(isDeadAt(track.deaths, 113)).toBe(false);
      expect(track.positions[113]).not.toBeNull();
    });

    it('gives a death with no duration its respawn from the path', () => {
      const paths = SLOTS.map((slot) =>
        rawPath(slot, DURATION_S + 1, slot === SLOT ? [[101, 7]] : []),
      );
      const deathsBySlot = new Map([[SLOT, [{ timeS: 100 }]]]);
      const { deaths } = trackOf(readMatchReplay(archive({ paths, deathsBySlot })), SLOT);
      expect(deaths).toEqual([{ timeS: 100, respawnS: 108, killerSlot: 1 }]);
    });

    it('keeps the API duration for a player without a path', () => {
      const paths = SLOTS.filter((slot) => slot !== SLOT).map((slot) =>
        rawPath(slot, DURATION_S + 1),
      );
      const deathsBySlot = new Map([[SLOT, [{ timeS: 100, durationS: 10 }]]]);
      const { deaths } = trackOf(readMatchReplay(archive({ paths, deathsBySlot })), SLOT);
      expect(deaths).toEqual([{ timeS: 100, respawnS: 110, killerSlot: 1 }]);
    });

    it('caps the search at 180 s after the death, or at the end of the match', () => {
      // The path stays dead from 101 to the end of the match.
      const deadToEnd = SLOTS.map((slot) =>
        rawPath(slot, DURATION_S + 1, slot === SLOT ? [[101, DURATION_S]] : []),
      );
      const early = new Map([[SLOT, [{ timeS: 100, durationS: 10 }]]]);
      expect(
        trackOf(readMatchReplay(archive({ paths: deadToEnd, deathsBySlot: early })), SLOT).deaths,
      ).toEqual([{ timeS: 100, respawnS: 280, killerSlot: 1 }]);
      const late = new Map([[SLOT, [{ timeS: 550, durationS: 10 }]]]);
      expect(
        trackOf(readMatchReplay(archive({ paths: deadToEnd, deathsBySlot: late })), SLOT).deaths,
      ).toEqual([{ timeS: 550, respawnS: DURATION_S + 1, killerSlot: 1 }]);
    });
  });

  it('throws invalid_payload for a malformed objectives, without any value', () => {
    const objectives = [{ team: 1, team_objective_id: 'secret-value', destroyed_time_s: 0 }];
    const error = failureOf(() => readMatchReplay(archive({ matchInfoFields: { objectives } })));
    expect(error.kind).toBe('invalid_payload');
    const issue = String((error.context as { issue?: unknown } | undefined)?.issue);
    expect(issue).toContain('match_info.objectives');
    expect(issue).not.toContain('secret-value');
  });
});

describe('isDeadAt', () => {
  const deaths = [
    { timeS: 100, respawnS: 110, killerSlot: 1 },
    { timeS: 200, respawnS: null, killerSlot: 1 },
  ];

  it('is dead at timeS and alive again at respawnS', () => {
    expect(isDeadAt(deaths, 99)).toBe(false);
    expect(isDeadAt(deaths, 100)).toBe(true);
    expect(isDeadAt(deaths, 109)).toBe(true);
    expect(isDeadAt(deaths, 110)).toBe(false);
  });

  it('counts a death without respawnS as dead at that instant only', () => {
    expect(isDeadAt(deaths, 200)).toBe(true);
    expect(isDeadAt(deaths, 201)).toBe(false);
  });
});

/**
 * Tests of the players' paths and of their clock.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players and twelve paths,
 * neither ordered by slot) but none of its data. Most paths are built so that a position tells
 * which sample it was read from: an alive sample `i` holds `x_pos = i` and, with the unit bounds
 * below, decodes to the world x `i`.
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
import { positionAt, readPlayerPaths } from './player-paths';
import type { PlayerPaths } from './player-paths';

/** How long the match lasts, in seconds. */
const DURATION_S = 600;

/** The resolution of a path's coordinates, as the API sends it. */
const RESOLUTION = 16_383;

/** The slot of the player most tests look at (their team is 1: slots 7 to 12). */
const SLOT = 9;

/** The y every alive sample of a built path holds (any value but 0 would do). */
const ALIVE_Y = 8_000;

/** The world bounds of a path. */
interface Bounds {
  readonly x_min: number;
  readonly x_max: number;
  readonly y_min: number;
  readonly y_max: number;
}

/** Bounds as wide as the resolution, starting at 0: a coordinate decodes to itself. */
const UNIT_BOUNDS: Bounds = { x_min: 0, x_max: RESOLUTION, y_min: 0, y_max: RESOLUTION };

/** One path in the shape of the API, its arrays left mutable so that a test can edit a sample. */
interface RawPath extends Bounds {
  readonly player_slot: number;
  readonly x_pos: number[];
  readonly y_pos: number[];
  readonly health?: number[];
  readonly combat_type: number[];
}

/** How to build a path. */
interface PathOptions {
  /** The samples where the player is dead, as `[first index, count]` runs. */
  readonly deadRuns?: readonly (readonly [number, number])[];
  /** The world bounds of the path. */
  readonly bounds?: Bounds;
  /** Whether the path has a `health` array (it does in real payloads). */
  readonly withHealth?: boolean;
}

/**
 * One path in the shape of the API (a field the app ignores included).
 *
 * An alive sample `i` is at `(i, ALIVE_Y)` with a full health; a dead one is at `(0, 0)` with no
 * health, as the API records a dead player.
 *
 * @param playerSlot - The slot of the player.
 * @param length - The count of samples.
 * @param options - The dead runs, the bounds, and whether there is a health array.
 * @returns The raw path.
 */
function rawPath(playerSlot: number, length: number, options: PathOptions = {}): RawPath {
  const { deadRuns = [], bounds = UNIT_BOUNDS, withHealth = true } = options;
  const dead = (index: number) =>
    deadRuns.some(([first, count]) => index >= first && index < first + count);
  const indexes = Array.from({ length }, (_, index) => index);
  const health = indexes.map((index) => (dead(index) ? 0 : 100));
  return {
    player_slot: playerSlot,
    ...bounds,
    x_pos: indexes.map((index) => (dead(index) ? 0 : index)),
    y_pos: indexes.map((index) => (dead(index) ? 0 : ALIVE_Y)),
    ...(withHealth ? { health } : {}),
    combat_type: indexes.map(() => 0),
  };
}

/**
 * One player in the shape of the API (fields the app ignores included).
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param deathTimesS - When they died, in seconds, in the order the payload lists them.
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, deathTimesS: readonly number[]) {
  return {
    account_id: 2_000_000 + playerSlot,
    player_slot: playerSlot,
    team: playerSlot <= 6 ? 0 : 1,
    hero_id: playerSlot === SLOT ? PAIGE_HERO_ID : 100 + playerSlot,
    deaths: deathTimesS.length,
    death_details: deathTimesS.map((gameTimeS) => ({
      game_time_s: gameTimeS,
      killer_player_slot: 1,
      death_duration_s: 10,
    })),
  };
}

/** The slots of a match, by descending slot: real payloads order neither players nor paths. */
const SLOTS = Array.from({ length: 12 }, (_, index) => 12 - index);

/** How to build an archive. */
interface ArchiveOptions {
  /** The paths; by default, one aligned path with no death for each of the twelve slots. */
  readonly paths?: readonly unknown[];
  /** The death times of a player, by slot; a slot not listed never died. */
  readonly deathsBySlot?: ReadonlyMap<number, readonly number[]>;
  /** Fields of `match_paths` to change (an `undefined` value removes the field). */
  readonly matchPathsFields?: Readonly<Record<string, unknown>>;
  /** Fields of the player at slot {@link SLOT} to change. */
  readonly playerFields?: Readonly<Record<string, unknown>>;
  /** Whether the payload has `match_paths` at all. */
  readonly withPaths?: boolean;
}

/**
 * The paths of a match where each of the twelve players is aligned and never dies, but the one at
 * slot {@link SLOT}, whose path is given.
 *
 * @param path - The path of the player at slot {@link SLOT}.
 * @returns The twelve paths, by descending slot (that of slot 9 is the fourth one, index 3).
 */
function pathsWith(path: RawPath): readonly RawPath[] {
  return SLOTS.map((slot) => (slot === SLOT ? path : rawPath(slot, DURATION_S + 1)));
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * The players are listed by descending slot, so the player at slot 9 is the fourth one (index 3).
 *
 * @param options - What to change from a match of aligned players who never die.
 * @returns The envelope.
 */
function archive(options: ArchiveOptions = {}): ArchiveEnvelope {
  const {
    paths = SLOTS.map((slot) => rawPath(slot, DURATION_S + 1)),
    deathsBySlot = new Map<number, readonly number[]>(),
    matchPathsFields = {},
    playerFields = {},
    withPaths = true,
  } = options;
  const matchPaths = {
    version: 1,
    interval_s: 1,
    x_resolution: RESOLUTION,
    y_resolution: RESOLUTION,
    paths,
    ...matchPathsFields,
  };
  const payload = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: DURATION_S,
      game_mode: 1,
      match_mode: 4,
      players: SLOTS.map((slot) => ({
        ...rawPlayer(slot, deathsBySlot.get(slot) ?? []),
        ...(slot === SLOT ? playerFields : {}),
      })),
      ...(withPaths ? { match_paths: matchPaths } : {}),
    },
  });
  return createArchiveEnvelope(payload, testAccountId(2_000_000 + SLOT), 1_760_000_123_456);
}

/**
 * Read the paths of an archive that must have them.
 *
 * @param envelope - The archive.
 * @returns Its paths.
 */
function readPaths(envelope: ArchiveEnvelope): PlayerPaths {
  const paths = readPlayerPaths(envelope);
  if (paths === null) {
    return expect.unreachable('the archive should have paths');
  }
  return paths;
}

/**
 * The world x of the player at slot {@link SLOT} at a second, which is the index of the sample read
 * on the paths built with the unit bounds.
 *
 * @param envelope - The archive.
 * @param timeS - The game second.
 * @returns The world x, or `null` when there is no position.
 */
function xAt(envelope: ArchiveEnvelope, timeS: number): number | null {
  const path = readPaths(envelope).bySlot.get(SLOT);
  if (path === undefined) {
    return expect.unreachable('the player should have a path');
  }
  const position = positionAt(path, timeS);
  // Rounded: the decoding divides then multiplies by the resolution, which is exact to a hair only.
  return position === null ? null : Math.round(position.x * 1_000) / 1_000;
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

describe('readPlayerPaths and positionAt', () => {
  it("decodes a sample into world units with the path's own bounds", () => {
    // Two players at the same coordinates of their own paths, whose bounds differ.
    const wide = {
      x_min: -1_000,
      x_max: -1_000 + RESOLUTION,
      y_min: 500,
      y_max: 500 + 2 * RESOLUTION,
    };
    const paths = SLOTS.map((slot) => {
      const path = rawPath(slot, DURATION_S + 1, slot === SLOT ? { bounds: wide } : {});
      path.x_pos[100] = 3_000;
      path.y_pos[100] = 100;
      return path;
    });

    const read = readPaths(archive({ paths }));
    const own = read.bySlot.get(SLOT);
    const other = read.bySlot.get(2);

    // x: −1000 + 3000 / 16383 × 16383; y: 500 + 100 / 16383 × 32766.
    expect(own === undefined ? null : positionAt(own, 100)).toEqual({
      x: expect.closeTo(2_000, 6) as number,
      y: expect.closeTo(700, 6) as number,
    });
    expect(other === undefined ? null : positionAt(other, 100)).toEqual({
      x: expect.closeTo(3_000, 6) as number,
      y: expect.closeTo(100, 6) as number,
    });
  });

  it('reads every path with the team of its player', () => {
    const read = readPaths(archive());

    expect([...read.bySlot.keys()].toSorted((first, second) => first - second)).toEqual(
      SLOTS.toSorted((first, second) => first - second),
    );
    expect(read.bySlot.get(SLOT)).toMatchObject({ slot: SLOT, team: 1 });
    expect(read.bySlot.get(2)).toMatchObject({ slot: 2, team: 0 });
  });

  it('places an aligned player at the second of the match', () => {
    // One sample per second, the dead run starting right after the death: no shift at all.
    const envelope = archive({
      paths: pathsWith(rawPath(SLOT, DURATION_S + 1, { deadRuns: [[201, 10]] })),
      deathsBySlot: new Map([[SLOT, [200]]]),
    });

    expect(xAt(envelope, 0)).toBe(0);
    expect(xAt(envelope, 150)).toBe(150);
    // At their death second the player is at their last alive sample.
    expect(xAt(envelope, 200)).toBe(200);
    expect(xAt(envelope, 450)).toBe(450);
    expect(xAt(envelope, DURATION_S)).toBe(DURATION_S);
    // A time between two samples is read at the nearest one.
    expect(xAt(envelope, 450.4)).toBe(450);
    expect(xAt(envelope, 450.6)).toBe(451);
  });

  it('places a player of a drifted path through its own deaths', () => {
    // 41 samples too many: the path is 20 s late when the player dies at 200 s (last alive sample
    // 220), 40 s late when they die at 400 s (last alive sample 440), and still 40 s at the end.
    // The payload lists the deaths out of order.
    const envelope = archive({
      paths: pathsWith(
        rawPath(SLOT, DURATION_S + 41, {
          deadRuns: [
            [221, 10],
            [441, 10],
          ],
        }),
      ),
      deathsBySlot: new Map([[SLOT, [400, 200]]]),
    });

    // Halfway between the two deaths, halfway between 20 s and 40 s late.
    expect(xAt(envelope, 300)).toBe(330);
    // Halfway from the start to the first death, 10 s late.
    expect(xAt(envelope, 100)).toBe(110);
    // At each death, the last alive sample.
    expect(xAt(envelope, 200)).toBe(220);
    expect(xAt(envelope, 400)).toBe(440);
    // From the second death to the end, 40 s late all along.
    expect(xAt(envelope, 500)).toBe(540);
    expect(xAt(envelope, DURATION_S)).toBe(DURATION_S + 40);
  });

  it('places a drifted player with no death on the straight shift', () => {
    // 41 samples too many, no death to anchor on: the shift grows evenly from 0 to 40.
    const envelope = archive({ paths: pathsWith(rawPath(SLOT, DURATION_S + 41)) });

    expect(xAt(envelope, 0)).toBe(0);
    expect(xAt(envelope, 150)).toBe(160);
    expect(xAt(envelope, 450)).toBe(480);
    expect(xAt(envelope, DURATION_S)).toBe(DURATION_S + 40);
  });

  it('uses only the ends when the dead runs and the deaths do not match in number', () => {
    // Two dead runs (20 s and 40 s late) but a single death detail: which run is which death is
    // not known, so the shift is the straight line from 0 to 40.
    const drifted = rawPath(SLOT, DURATION_S + 41, {
      deadRuns: [
        [221, 10],
        [441, 10],
      ],
    });
    const oneDeath = archive({ paths: pathsWith(drifted), deathsBySlot: new Map([[SLOT, [200]]]) });
    const noDetail = archive({
      paths: pathsWith(drifted),
      playerFields: { deaths: 2, death_details: undefined },
    });

    // 300 s is halfway through the match: 20 s late (and not the 25 s of the single death anchor).
    expect(xAt(oneDeath, 300)).toBe(320);
    // Without death details there is no death anchor either.
    expect(xAt(noDetail, 300)).toBe(320);
  });

  it('answers no position while the player is dead', () => {
    const envelope = archive({
      paths: pathsWith(rawPath(SLOT, DURATION_S + 1, { deadRuns: [[201, 10]] })),
      deathsBySlot: new Map([[SLOT, [200]]]),
    });

    expect(xAt(envelope, 201)).toBeNull();
    expect(xAt(envelope, 205)).toBeNull();
    expect(xAt(envelope, 210)).toBeNull();
    expect(xAt(envelope, 211)).toBe(211);
  });

  it('tells a dead sample by (0, 0) alone on a path without health', () => {
    const envelope = archive({
      paths: pathsWith(rawPath(SLOT, DURATION_S + 1, { deadRuns: [[201, 10]], withHealth: false })),
      deathsBySlot: new Map([[SLOT, [200]]]),
    });

    expect(xAt(envelope, 205)).toBeNull();
    expect(xAt(envelope, 211)).toBe(211);
  });

  it('places a player alive at (0, 0) in the corner of their path', () => {
    // With some health left, (0, 0) is a real position: the corner of the path's bounds.
    const path = rawPath(SLOT, DURATION_S + 1, {
      bounds: { x_min: -500, x_max: 700, y_min: -900, y_max: 1_100 },
    });
    path.x_pos[300] = 0;
    path.y_pos[300] = 0;
    const read = readPaths(archive({ paths: pathsWith(path) }));
    const own = read.bySlot.get(SLOT);

    expect(own === undefined ? null : positionAt(own, 300)).toEqual({ x: -500, y: -900 });
  });

  it('answers no position before the start or past the end of the path', () => {
    const envelope = archive();

    expect(xAt(envelope, -5)).toBeNull();
    expect(xAt(envelope, DURATION_S + 1)).toBeNull();
    expect(xAt(envelope, Number.NaN)).toBeNull();
  });

  it('answers null without match paths', () => {
    expect(readPlayerPaths(archive({ withPaths: false }))).toBeNull();
  });

  it('leaves out a path whose arrays differ in length', () => {
    const longerX = rawPath(SLOT, DURATION_S + 1);
    longerX.x_pos.push(1);
    const shorterHealth = rawPath(SLOT, DURATION_S + 1);
    shorterHealth.health?.pop();

    for (const path of [longerX, shorterHealth]) {
      const read = readPaths(archive({ paths: pathsWith(path) }));

      expect(read.bySlot.has(SLOT)).toBe(false);
      // The other paths are kept.
      expect(read.bySlot.size).toBe(11);
    }
  });

  it('leaves out an empty path', () => {
    const read = readPaths(archive({ paths: pathsWith(rawPath(SLOT, 0)) }));

    expect(read.bySlot.has(SLOT)).toBe(false);
    expect(read.bySlot.size).toBe(11);
  });

  it('leaves out a path whose slot has no player', () => {
    const paths = [
      ...SLOTS.map((slot) => rawPath(slot, DURATION_S + 1)),
      rawPath(13, DURATION_S + 1),
    ];

    const read = readPaths(archive({ paths }));

    expect(read.bySlot.has(13)).toBe(false);
    expect(read.bySlot.size).toBe(12);
  });

  it('leaves out the paths of a slot that has several', () => {
    // Which of the two is the player's is not known.
    const paths = [...SLOTS.map((slot) => rawPath(slot, DURATION_S + 1)), rawPath(SLOT, 10)];

    const read = readPaths(archive({ paths }));

    expect(read.bySlot.has(SLOT)).toBe(false);
    expect(read.bySlot.size).toBe(11);
  });

  it('does not modify the envelope', () => {
    const envelope = archive({ deathsBySlot: new Map([[SLOT, [200]]]) });
    const before = structuredClone(envelope);

    readPlayerPaths(envelope);

    expect(envelope).toEqual(before);
  });

  it.each([
    [
      'a sample that is no number',
      {
        paths: pathsWith({
          ...rawPath(SLOT, DURATION_S + 1),
          x_pos: [1, 'S3CR3T', ...rawPath(SLOT, DURATION_S + 1).x_pos.slice(2)],
        } as unknown as RawPath),
      },
    ],
    [
      'bounds that are not numbers',
      {
        paths: pathsWith({
          ...rawPath(SLOT, DURATION_S + 1),
          y_max: 'S3CR3T',
        } as unknown as RawPath),
      },
    ],
    [
      'a death time that is no number',
      { playerFields: { deaths: 1, death_details: [{ game_time_s: 'S3CR3T' }] } },
    ],
  ] satisfies [string, ArchiveOptions][])(
    'leaves out a path with a field of the wrong type: %s',
    (_name, options) => {
      // One badly typed path is that path unreadable, not the paths of the whole match.
      const read = readPaths(archive(options));

      expect(read.bySlot.has(SLOT)).toBe(false);
      expect(read.bySlot.size).toBe(11);
    },
  );

  it.each([
    [
      'an interval that is not positive',
      { matchPathsFields: { interval_s: 0 } },
      'match_paths.interval_s: too_small',
    ],
    [
      'a missing resolution',
      { matchPathsFields: { y_resolution: undefined } },
      'match_paths.y_resolution: invalid_type',
    ],
    [
      'a resolution that is no integer',
      { matchPathsFields: { x_resolution: 16_383.5 } },
      'match_paths.x_resolution: invalid_type',
    ],
  ] satisfies [string, ArchiveOptions, string][])(
    'reports %s by path and code only',
    (_name, options, issue) => {
      const error = catchAppError(() => readPlayerPaths(archive(options)));

      expect(error.kind).toBe('invalid_payload');
      expect(error.context.issue).toBe(issue);
      expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
        'S3CR3T',
      );
    },
  );
});

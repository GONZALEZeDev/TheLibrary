/**
 * Where each player was during an archived match: their movement paths, and the clock that tells
 * which sample of a path is a given second of the match.
 *
 * `match_info.match_paths` holds one path per player: one sample every `interval_s` seconds, each
 * sample a pair of coordinates from 0 to the resolution, within the path's own world bounds (every
 * path has its own four, the player's extremes, so one box for everybody would be wrong). A dead
 * player keeps one sample per second, at `(0, 0)` with no health.
 *
 * The sample index is the game second only for a path that is aligned with the match. Some paths
 * run ahead of the game clock (by up to about a minute at the end of a match): samples were added
 * during the match, at times nothing in the payload tells. The player's own deaths do tell: they
 * died at a known second, and their path shows where their dead runs begin. So the shift between
 * the clock of the path and that of the match is measured at each death, and drawn as a straight
 * line between two deaths, from the start of the match (no shift) to its end (the shift that the
 * extra samples make).
 *
 * Like every reader of an archive, it never puts a value of the payload in an error: the payload
 * belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { ArchiveEnvelope } from './archive-envelope';
import { archiveCount, readArchiveFields } from './archive-fields';

/** A position on the map, in world units: the frame of the death positions of the payload. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The key of a path's private part. It is not exported: only this module reads the samples and
 * the clock of a path, through {@link positionAt}.
 */
const TRACK = Symbol('player path track');

/**
 * The samples of a path as the payload holds them: the arrays are the payload's own (not copies),
 * and are only read. They all have the same length.
 */
interface PathSamples {
  /** The coordinates of each sample, from 0 to the resolution. */
  readonly xPos: readonly number[];
  readonly yPos: readonly number[];
  /** The health of each sample, in percent; `null` when the path has none. */
  readonly health: readonly number[] | null;
}

/** A point of the clock of a path: how many samples the path is ahead of the match at a second. */
interface ShiftAnchor {
  /** The second of the match. */
  readonly timeS: number;
  /** How many samples the path is ahead of the match then (negative when behind). */
  readonly shift: number;
}

/** The private part of a path: its samples, what is needed to decode them, and its clock. */
interface PathTrack {
  /** Seconds between two samples. */
  readonly intervalS: number;
  /** The coordinate that stands for the maximum of each bound. */
  readonly resolution: { readonly x: number; readonly y: number };
  /** The world bounds of the path. */
  readonly bounds: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  };
  /** The samples. */
  readonly samples: PathSamples;
  /** The clock of the path, ordered by time, from the start of the match to its end. */
  readonly anchors: readonly ShiftAnchor[];
}

/**
 * The movement path of one player.
 *
 * Only the slot and the team are public; the samples and the clock are read through
 * {@link positionAt}. A path is only made by {@link readPlayerPaths}.
 */
export interface PlayerPath {
  /** The slot of the player, the join key with `match_info.players`. */
  readonly slot: number;
  /** The team of the player. */
  readonly team: number;
  /** The samples and the clock, private to this module. */
  readonly [TRACK]: PathTrack;
}

/** The movement paths of a match. */
export interface PlayerPaths {
  /**
   * The readable paths, by slot. A player whose path is unreadable (its arrays differ in length or
   * are empty, another path has the same slot) has none, and neither has a path with no player.
   */
  readonly bySlot: ReadonlyMap<number, PlayerPath>;
}

/**
 * The fields of a path that are needed. The object is loose: every other field is ignored, such as
 * the combat and movement types of each sample.
 *
 * The health may be absent (the dead samples are then told by their position alone), and the API
 * sends `null` for what does not apply.
 */
const pathSchema = z.looseObject({
  player_slot: archiveCount,
  x_min: z.number(),
  x_max: z.number(),
  y_min: z.number(),
  y_max: z.number(),
  x_pos: z.array(z.number()),
  y_pos: z.array(z.number()),
  health: z.array(z.number()).nullish(),
});

/** The fields of `match_info.match_paths` that are needed (loose, like the path). */
const matchPathsSchema = z.looseObject({
  interval_s: z.number().positive(),
  x_resolution: z.int().positive(),
  y_resolution: z.int().positive(),
  paths: z.array(pathSchema),
});

/**
 * The fields of a player's entry that the paths need: the team, and when they died, for the clock.
 * The list of deaths may be absent (a payload may leave out an empty list) or `null`.
 */
const playerSchema = z.looseObject({
  player_slot: archiveCount,
  team: z.int(),
  death_details: z.array(z.looseObject({ game_time_s: z.number().nonnegative() })).nullish(),
});

/**
 * Read the movement paths of the players of an archived match.
 *
 * Every player is read, the tracked one included, whatever the format of the archive: a format-1
 * archive only holds the tracked player's path, so the others have none. The clock of each path is
 * computed here, once.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The paths, or `null` when the match has no `match_paths`.
 * @throws AppError of kind `invalid_payload` when a field is not what is expected. The context
 *   `issue` is `match_paths.<path>: <code>` (`<path>` for instance `paths.<position>.x_pos.<index>`)
 *   or `players.<index>.<path>: <code>` (`<index>` being the position of the player in
 *   `match_info.players`); never a value of the payload.
 */
export function readPlayerPaths(envelope: ArchiveEnvelope): PlayerPaths | null {
  const matchInfo = envelope.payload.match_info;
  if (matchInfo.match_paths === undefined) {
    return null;
  }
  const matchPaths = readArchiveFields(matchPathsSchema, matchInfo.match_paths, 'match_paths');
  const players = matchInfo.players.map((entry, index) =>
    readArchiveFields(playerSchema, entry, `players.${String(index)}`),
  );
  const playersBySlot = uniqueBySlot(players);

  const bySlot = new Map<number, PlayerPath>();
  for (const [slot, path] of uniqueBySlot(matchPaths.paths)) {
    const player = playersBySlot.get(slot);
    const samples: PathSamples = {
      xPos: path.x_pos,
      yPos: path.y_pos,
      health: path.health ?? null,
    };
    // A path with no player, or whose samples cannot be read, is left out.
    if (player === undefined || !isWhole(samples)) {
      continue;
    }
    const deathTimesS = (player.death_details ?? []).map((death) => death.game_time_s);
    const track: PathTrack = {
      intervalS: matchPaths.interval_s,
      resolution: { x: matchPaths.x_resolution, y: matchPaths.y_resolution },
      bounds: { xMin: path.x_min, xMax: path.x_max, yMin: path.y_min, yMax: path.y_max },
      samples,
      anchors: clockAnchors(samples, matchPaths.interval_s, deathTimesS, matchInfo.duration_s),
    };
    bySlot.set(slot, { slot, team: player.team, [TRACK]: track });
  }
  return { bySlot };
}

/**
 * Where a player was at a second of the match.
 *
 * The second is turned into a sample index through the path's clock, then rounded to the nearest
 * sample, whose coordinates are decoded within the path's own bounds.
 *
 * @param path - The player's path.
 * @param timeS - The second of the match (a fraction of a second is read at the nearest sample).
 * @returns The world position, or `null` when the player was dead then, or when the second falls
 *   outside the path (before its start, past its end, or not a number).
 */
export function positionAt(path: PlayerPath, timeS: number): MapPoint | null {
  const { intervalS, resolution, bounds, samples, anchors } = path[TRACK];
  const index = Math.round(timeS / intervalS + shiftAt(anchors, timeS));
  const x = samples.xPos[index];
  const y = samples.yPos[index];
  // An index out of the path (NaN included) reads no sample.
  if (x === undefined || y === undefined || isDead(samples, index)) {
    return null;
  }
  return {
    x: bounds.xMin + (x / resolution.x) * (bounds.xMax - bounds.xMin),
    y: bounds.yMin + (y / resolution.y) * (bounds.yMax - bounds.yMin),
  };
}

/**
 * Index entries by their slot, leaving out a slot that several entries share: which of them is
 * the player's is not known.
 *
 * @param entries - Players or paths.
 * @returns The entries whose slot is theirs alone, by slot.
 */
function uniqueBySlot<Entry extends { readonly player_slot: number }>(
  entries: readonly Entry[],
): Map<number, Entry> {
  const bySlot = new Map<number, Entry>();
  const shared = new Set<number>();
  for (const entry of entries) {
    if (bySlot.has(entry.player_slot)) {
      shared.add(entry.player_slot);
    } else {
      bySlot.set(entry.player_slot, entry);
    }
  }
  for (const slot of shared) {
    bySlot.delete(slot);
  }
  return bySlot;
}

/**
 * Tell whether the samples of a path can be read: one at least, and as many in each array.
 *
 * @param samples - The samples of a path.
 * @returns `true` when every array has the same length, and it is not 0.
 */
function isWhole(samples: PathSamples): boolean {
  const length = samples.xPos.length;
  return (
    length > 0 &&
    samples.yPos.length === length &&
    (samples.health === null || samples.health.length === length)
  );
}

/**
 * Tell whether a player is dead at a sample.
 *
 * A dead player is recorded at `(0, 0)` with no health; without a health array, `(0, 0)` alone
 * tells it. An alive player can stand at `(0, 0)` (the corner of their bounds) with health left.
 *
 * @param samples - The samples of a path.
 * @param index - The index of a sample of the path.
 * @returns `true` when the player is dead at that sample.
 */
function isDead(samples: PathSamples, index: number): boolean {
  if (samples.xPos[index] !== 0 || samples.yPos[index] !== 0) {
    return false;
  }
  return samples.health === null || samples.health[index] === 0;
}

/**
 * Compute the clock of a path: how many samples it is ahead of the match, at a few seconds.
 *
 * The anchors are:
 * - the start of the match, where every path is aligned;
 * - each death of the player, where the path's last alive sample before a dead run is the second
 *   the player died. The dead runs are matched in order to the deaths, sorted by time; when there
 *   are not as many of them as deaths (a death detail missing, a tail of dead samples after the
 *   player left…), which run is which death is not known, and no death is used;
 * - the end of the match, where the path's last sample is its last second.
 *
 * @param samples - The samples of the path.
 * @param intervalS - Seconds between two samples.
 * @param deathTimesS - When the player died, in seconds, in any order; none when unknown.
 * @param durationS - How long the match lasted, in seconds.
 * @returns The anchors, ordered by time.
 */
function clockAnchors(
  samples: PathSamples,
  intervalS: number,
  deathTimesS: readonly number[],
  durationS: number,
): readonly ShiftAnchor[] {
  // The sample a second would be on an aligned path.
  const alignedSample = (timeS: number) => timeS / intervalS;
  const start: ShiftAnchor = { timeS: 0, shift: 0 };
  const end: ShiftAnchor = {
    timeS: durationS,
    shift: samples.xPos.length - 1 - alignedSample(durationS),
  };
  const deathTimes = deathTimesS.toSorted((first, second) => first - second);
  const runStarts = deadRunStarts(samples);
  if (deathTimes.length !== runStarts.length) {
    return [start, end];
  }
  const deaths = deathTimes.map((timeS, position) => ({
    timeS,
    // The run's first dead sample follows the last alive one, the sample of the death second.
    shift: (runStarts[position] ?? 0) - 1 - alignedSample(timeS),
  }));
  // Sorted again with the ends: a death time past the end of the match must not break the order.
  return [start, ...deaths, end].toSorted((first, second) => first.timeS - second.timeS);
}

/**
 * Find where each dead run of a path starts: a run being as many dead samples in a row as there
 * are.
 *
 * @param samples - The samples of the path.
 * @returns The index of the first sample of each dead run, in order.
 */
function deadRunStarts(samples: PathSamples): readonly number[] {
  const starts: number[] = [];
  for (let index = 0; index < samples.xPos.length; index += 1) {
    if (isDead(samples, index) && (index === 0 || !isDead(samples, index - 1))) {
      starts.push(index);
    }
  }
  return starts;
}

/**
 * Read the clock of a path at a second: the straight line between the anchors around it.
 *
 * Before the first anchor and past the last one the shift stays that of the nearest anchor. Two
 * anchors at the same second give the later one's shift.
 *
 * @param anchors - The clock, ordered by time.
 * @param timeS - The second of the match.
 * @returns How many samples the path is ahead of the match then.
 */
function shiftAt(anchors: readonly ShiftAnchor[], timeS: number): number {
  let previous = anchors[0];
  if (previous === undefined || timeS <= previous.timeS) {
    return previous?.shift ?? 0;
  }
  for (const next of anchors.slice(1)) {
    if (timeS <= next.timeS) {
      const span = next.timeS - previous.timeS;
      return span === 0
        ? next.shift
        : previous.shift + ((timeS - previous.timeS) / span) * (next.shift - previous.shift);
    }
    previous = next;
  }
  return previous.shift;
}

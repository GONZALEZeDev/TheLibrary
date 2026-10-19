/**
 * Test builders for the analysis: the match context, the players and the snapshots that the metrics
 * and the phases read.
 *
 * A test of a metric needs a match in which only a few things matter (the tracked player's snapshots,
 * the length of the match, the lane opponents…). These builders give every other field a neutral
 * default, so a test spells out only what it exercises and its numbers stay in plain sight. The
 * contexts are plain objects built from synthetic numbers, never a whole archive.
 *
 * @packageDocumentation
 */
import type {
  MatchContext,
  PlayerContext,
  Snapshot,
  SnapshotStat,
} from '../core/analysis/match-context';
import { testMatchId } from './test-data';

/** The match id of the hand-built contexts: the first synthetic match id of the tests. */
const DEFAULT_MATCH_ID = 100_000_001;

/** The length of the hand-built contexts, in seconds: 32 minutes and 14 seconds. */
const DEFAULT_DURATION_S = 1_934;

/** The match mode code of the hand-built contexts: a ranked match. */
const DEFAULT_MATCH_MODE = 4;

/**
 * Build a statistic snapshot.
 *
 * @param timeS - When it was taken, in seconds since the start of the match.
 * @param stats - Its counters; a counter left out is absent from the snapshot (never `0`).
 * @returns The snapshot.
 */
export function testSnapshot(
  timeS: number,
  stats: Partial<Record<SnapshotStat, number>> = {},
): Snapshot {
  return { timeS, stats };
}

/**
 * Build a player of a hand-built match: slot 1 of team 0, with no lane, no snapshot and every
 * end-of-game count at 0, unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The player.
 */
export function testPlayer(overrides: Partial<PlayerContext> = {}): PlayerContext {
  return {
    slot: 1,
    team: 0,
    lane: null,
    kills: 0,
    deaths: 0,
    assists: 0,
    netWorth: 0,
    lastHits: 0,
    denies: 0,
    snapshots: [],
    ...overrides,
  };
}

/**
 * Build the context of a hand-built match: a ranked match of 1934 seconds in which the tracked
 * player ({@link testPlayer}) is alone, with no kill, no badge and no leaver, unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The match context.
 */
export function testMatchContext(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    matchId: testMatchId(DEFAULT_MATCH_ID),
    durationS: DEFAULT_DURATION_S,
    matchMode: DEFAULT_MATCH_MODE,
    tracked: testPlayer(),
    teammates: [],
    enemies: [],
    laneOpponents: [],
    kills: [],
    trackedBadge: null,
    hasLeaver: false,
    ...overrides,
  };
}

/**
 * Take a value that a test knows is there.
 *
 * @param value - The value, or `null` or `undefined`.
 * @returns The value.
 * @throws Error when the value is missing (a mistake in the test).
 */
export function present<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) {
    throw new Error('The test expected a value');
  }
  return value;
}

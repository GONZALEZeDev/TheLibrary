/**
 * Tests of the phase metrics: the rate of a figure (souls, damage to heroes, damage to objectives,
 * kills) over the early, the mid or the late game, per minute of that phase, and the same rate over
 * the part of the phase the community's curve covers.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metrics only read
 * the tracked player's snapshots and kills, and the length of the match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  present,
  testMatchContext,
  testPlayer,
  testSnapshot,
} from '../../../test/analysis-context';
import { AppError } from '../../errors/app-error';
import type { KillEvent, MatchContext, Snapshot } from '../match-context';
import type { MetricDefinition, MetricKey, PhaseMetricKey } from '../metric';
import { PHASE_STATS, PHASES } from '../phases';
import type { Phase, PhaseStat } from '../phases';
import { PHASE_METRICS, phaseMetricKey } from './phase.metric';

/** The slot of the tracked player in the hand-built matches. */
const TRACKED_SLOT = 3;

/** The slot of another player, whose kills must not count for the tracked player. */
const OTHER_SLOT = 8;

/**
 * Build a kill of the tracked player.
 *
 * @param timeS - When the victim died, in seconds.
 * @returns The kill.
 */
function trackedKill(timeS: number): KillEvent {
  return { timeS, killerSlot: TRACKED_SLOT, victimSlot: 9 };
}

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param durationS - The length of the match, in seconds.
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @param kills - The kills of the match, ordered by time.
 * @returns The match context (no teammate, no enemy: the metrics read neither).
 */
function matchContext(
  durationS: number,
  snapshots: readonly Snapshot[],
  kills: readonly KillEvent[] = [],
): MatchContext {
  return testMatchContext({
    durationS,
    // The slot matters here: the kills of the tracked player are found by it.
    tracked: testPlayer({ slot: TRACKED_SLOT, snapshots }),
    kills,
  });
}

/**
 * Find a phase metric.
 *
 * @param key - The key of the metric.
 * @returns The metric; the test fails when there is none with that key.
 */
function metric(key: PhaseMetricKey): MetricDefinition {
  return PHASE_METRICS.find((candidate) => candidate.key === key) ?? expect.unreachable(key);
}

/**
 * The function that gives the player's rate over the span the community's curve is compared on.
 *
 * @param definition - A metric whose community reference is a curve.
 * @returns Its `community.rate`; the test fails for a metric with another kind of reference.
 */
function rateOf(definition: MetricDefinition): (context: MatchContext) => number | null {
  const { community } = definition;
  return community.kind === 'curve'
    ? community.rate
    : expect.unreachable('the community reference of this metric is a curve');
}

/** A 22-minute match: its mid game is 12 minutes long, and the late game is not reached. */
const DURATION_22_MIN_S = 1_320;

/** The damage to heroes of the 22-minute match: 4000 at 10:00, 10000 at 20:00, 12400 at the end. */
const HERO_DAMAGE_22_MIN = [
  testSnapshot(600, { player_damage: 4_000 }),
  testSnapshot(1_200, { player_damage: 10_000 }),
  testSnapshot(DURATION_22_MIN_S, { player_damage: 12_400 }),
];

describe('PHASE_METRICS', () => {
  it('builds the 11 phase metrics', () => {
    expect(PHASE_METRICS.map((definition) => definition.key)).toEqual([
      'souls_per_min_mid',
      'souls_per_min_late',
      'hero_damage_per_min_early',
      'hero_damage_per_min_mid',
      'hero_damage_per_min_late',
      'objective_damage_per_min_early',
      'objective_damage_per_min_mid',
      'objective_damage_per_min_late',
      'kills_per_min_early',
      'kills_per_min_mid',
      'kills_per_min_late',
    ]);
  });

  // The columns come in the order of the three `%s` of the title: the key, the group, the curve stat.
  it.each([
    ['souls_per_min_mid', 'souls', 'net_worth', 'relative', 'mid'],
    ['souls_per_min_late', 'souls', 'net_worth', 'relative', 'late'],
    ['hero_damage_per_min_early', 'hero_damage', 'player_damage', 'relative', 'early'],
    ['hero_damage_per_min_mid', 'hero_damage', 'player_damage', 'relative', 'mid'],
    ['hero_damage_per_min_late', 'hero_damage', 'player_damage', 'relative', 'late'],
    ['objective_damage_per_min_early', 'objective_damage', 'boss_damage', 'relative', 'early'],
    ['objective_damage_per_min_mid', 'objective_damage', 'boss_damage', 'relative', 'mid'],
    ['objective_damage_per_min_late', 'objective_damage', 'boss_damage', 'relative', 'late'],
    ['kills_per_min_early', 'kills', 'kills', 'absolute', 'early'],
    ['kills_per_min_mid', 'kills', 'kills', 'absolute', 'mid'],
    ['kills_per_min_late', 'kills', 'kills', 'absolute', 'late'],
  ] as const)(
    '%s is a per-minute rate of the %s, compared with the community %s curve',
    (key, group, stat, display, phase) => {
      expect(metric(key)).toMatchObject({
        key,
        // A phase metric is shown in the phase table, not in a family.
        family: null,
        unit: 'per_min',
        better: 'higher',
        group,
        display,
        personal: 'as_is',
        integer: false,
        community: { kind: 'curve', stat, phase },
      });
    },
  );
});

describe('phaseMetricKey', () => {
  it.each<[PhaseStat, Phase, MetricKey]>([
    ['souls', 'early', 'souls_at_10min'],
    ['souls', 'mid', 'souls_per_min_mid'],
    ['souls', 'late', 'souls_per_min_late'],
    ['hero_damage', 'early', 'hero_damage_per_min_early'],
    ['hero_damage', 'mid', 'hero_damage_per_min_mid'],
    ['hero_damage', 'late', 'hero_damage_per_min_late'],
    ['objective_damage', 'early', 'objective_damage_per_min_early'],
    ['objective_damage', 'mid', 'objective_damage_per_min_mid'],
    ['objective_damage', 'late', 'objective_damage_per_min_late'],
    ['kills', 'early', 'kills_per_min_early'],
    ['kills', 'mid', 'kills_per_min_mid'],
    ['kills', 'late', 'kills_per_min_late'],
  ])('reads the %s of the %s game from %s', (stat, phase, key) => {
    expect(phaseMetricKey(stat, phase)).toBe(key);
  });

  it('names a metric of PHASE_METRICS for every cell but the early souls', () => {
    // The early souls are the match metric `souls_at_10min`, which PHASE_METRICS does not hold.
    expect(PHASE_METRICS.some((definition) => definition.key === 'souls_at_10min')).toBe(false);
    for (const stat of PHASE_STATS) {
      for (const phase of PHASES) {
        const key = phaseMetricKey(stat, phase);
        if (stat === 'souls' && phase === 'early') {
          expect(key).toBe('souls_at_10min');
          continue;
        }
        // The metric of the cell rates the stat of the cell, against the curve of the phase of the cell.
        const definition = present(PHASE_METRICS.find((candidate) => candidate.key === key));
        expect(definition.group).toBe(stat);
        expect(definition.community).toMatchObject({ kind: 'curve', phase });
      }
    }
  });

  it('throws instead of guessing a key for a cell the table does not hold', () => {
    // The types forbid such a cell: it could only come from a mistake in the table, which must
    // show instead of falling back to the key of another metric.
    // @ts-expect-error `assists` is not a figure of the phase table
    expect(() => phaseMetricKey('assists', 'mid')).toThrow(AppError);
  });
});

describe('the phase metrics of a match', () => {
  it('computes the whole-phase rate and the community-span rate', () => {
    // 22-minute match (1320 s): the mid game runs from 600 s to the end of the match, and the
    // community's span from 600 s to 1200 s, the time every match of the 20-25 minute window reaches.
    const context = matchContext(DURATION_22_MIN_S, HERO_DAMAGE_22_MIN);
    const heroDamageMid = metric('hero_damage_per_min_mid');
    // 12400 - 4000 over 12 minutes.
    expect(heroDamageMid.compute(context)).toBeCloseTo(700, 6);
    // 10000 - 4000 over 10 minutes.
    expect(rateOf(heroDamageMid)(context)).toBeCloseTo(600, 6);
  });

  it('reads each figure from its own counter', () => {
    const context = matchContext(DURATION_22_MIN_S, [
      testSnapshot(600, { net_worth: 10_000, player_damage: 4_000, boss_damage: 500 }),
      testSnapshot(DURATION_22_MIN_S, {
        net_worth: 31_000,
        player_damage: 12_400,
        boss_damage: 2_900,
      }),
    ]);
    expect(metric('souls_per_min_mid').compute(context)).toBeCloseTo(1_750, 6);
    expect(metric('hero_damage_per_min_mid').compute(context)).toBeCloseTo(700, 6);
    expect(metric('objective_damage_per_min_mid').compute(context)).toBeCloseTo(200, 6);
  });

  it('starts the early game from the origin of every counter', () => {
    // Every counter is 0 when the match starts: 7200 at 12:00 is 6000 at 10:00 on that line.
    const context = matchContext(DURATION_22_MIN_S, [testSnapshot(720, { player_damage: 7_200 })]);
    const heroDamageEarly = metric('hero_damage_per_min_early');
    expect(heroDamageEarly.compute(context)).toBeCloseTo(600, 6);
    expect(rateOf(heroDamageEarly)(context)).toBeCloseTo(600, 6);
  });

  it('rates an early game that ends with a short match', () => {
    // A 9-minute match has an early game of 9 minutes, all of it covered by the community's curve.
    const context = matchContext(540, [
      testSnapshot(300, { player_damage: 1_500 }),
      testSnapshot(540, { player_damage: 4_500 }),
    ]);
    const heroDamageEarly = metric('hero_damage_per_min_early');
    expect(heroDamageEarly.compute(context)).toBeCloseTo(500, 6);
    expect(rateOf(heroDamageEarly)(context)).toBeCloseTo(500, 6);
    // The mid game is not reached.
    expect(metric('hero_damage_per_min_mid').compute(context)).toBeNull();
  });

  it('rates the whole late game, and the community span only up to the time of the window', () => {
    // 70-minute match (4200 s): the late game is 45 minutes long, but the community's curve of the
    // longest window is only a fair reference up to 2700 s, the shortest match of that window.
    const context = matchContext(4_200, [
      testSnapshot(600, { net_worth: 9_000 }),
      testSnapshot(1_500, { net_worth: 30_000 }),
      testSnapshot(2_700, { net_worth: 70_000 }),
      testSnapshot(4_200, { net_worth: 130_000 }),
    ]);
    const soulsLate = metric('souls_per_min_late');
    // 130000 - 30000 over 45 minutes.
    expect(soulsLate.compute(context)).toBeCloseTo(2_222.2222, 4);
    // 70000 - 30000 over the 20 minutes from 1500 s to 2700 s.
    expect(rateOf(soulsLate)(context)).toBeCloseTo(2_000, 6);
  });

  it('rates the whole mid game of a long match, which the community covers entirely', () => {
    const context = matchContext(4_200, [
      testSnapshot(600, { net_worth: 9_000 }),
      testSnapshot(1_500, { net_worth: 30_000 }),
      testSnapshot(4_200, { net_worth: 130_000 }),
    ]);
    const soulsMid = metric('souls_per_min_mid');
    // 30000 - 9000 over the 15 minutes of the mid game: the community's span is the same.
    expect(soulsMid.compute(context)).toBeCloseTo(1_400, 6);
    expect(rateOf(soulsMid)(context)).toBeCloseTo(1_400, 6);
  });

  it('is null for a phase shorter than 3 minutes', () => {
    // 25:30 match: the late game lasts 30 seconds. Every counter is known to the end, so it is the
    // length of the phase that makes the metrics null.
    const context = matchContext(
      1_530,
      [
        testSnapshot(600, { net_worth: 9_000, player_damage: 4_000, boss_damage: 500 }),
        testSnapshot(1_500, { net_worth: 30_000, player_damage: 14_000, boss_damage: 1_500 }),
        testSnapshot(1_530, { net_worth: 31_000, player_damage: 14_500, boss_damage: 1_600 }),
      ],
      [trackedKill(1_510)],
    );
    for (const key of [
      'souls_per_min_late',
      'hero_damage_per_min_late',
      'objective_damage_per_min_late',
      'kills_per_min_late',
    ] as const) {
      expect(metric(key).compute(context)).toBeNull();
      expect(rateOf(metric(key))(context)).toBeNull();
    }
    // The mid game is 15 minutes long: it is rated.
    expect(metric('hero_damage_per_min_mid').compute(context)).toBeCloseTo(666.6667, 4);
  });

  it('is null for an early game shorter than 3 minutes', () => {
    // A 150-second match has only 2.5 minutes of early game.
    const context = matchContext(
      150,
      [testSnapshot(150, { player_damage: 600 })],
      [trackedKill(100)],
    );
    expect(metric('hero_damage_per_min_early').compute(context)).toBeNull();
    expect(metric('kills_per_min_early').compute(context)).toBeNull();
    expect(rateOf(metric('hero_damage_per_min_early'))(context)).toBeNull();
  });

  it('is null for a phase the match does not reach', () => {
    // The 22-minute match ends before the late game, whose counters hold nothing to read anyway.
    const context = matchContext(DURATION_22_MIN_S, [
      testSnapshot(600, { net_worth: 9_000, player_damage: 4_000, boss_damage: 500 }),
      testSnapshot(1_500, { net_worth: 30_000, player_damage: 14_000, boss_damage: 1_500 }),
    ]);
    expect(metric('hero_damage_per_min_late').compute(context)).toBeNull();
    expect(rateOf(metric('hero_damage_per_min_late'))(context)).toBeNull();
    expect(metric('kills_per_min_late').compute(context)).toBeNull();
    expect(rateOf(metric('kills_per_min_late'))(context)).toBeNull();
  });

  it('has a rate for the whole phase but not for the community span when that is too short', () => {
    // A 1000-second match is in the window of the matches under 20 minutes, read up to 720 s: the
    // 2 minutes the mid game shares with it are too few to compare, though the mid game lasts almost
    // 7 minutes.
    const context = matchContext(1_000, [
      testSnapshot(600, { player_damage: 4_000 }),
      testSnapshot(1_000, { player_damage: 9_000 }),
    ]);
    const heroDamageMid = metric('hero_damage_per_min_mid');
    // 5000 over 400 seconds.
    expect(heroDamageMid.compute(context)).toBeCloseTo(750, 6);
    expect(rateOf(heroDamageMid)(context)).toBeNull();
  });

  it('is null when no snapshot holds the counter', () => {
    // Souls are known, the damage to heroes is not: it is unknown, not 0.
    const context = matchContext(DURATION_22_MIN_S, [
      testSnapshot(600, { net_worth: 9_000 }),
      testSnapshot(DURATION_22_MIN_S, { net_worth: 31_000 }),
    ]);
    const heroDamageMid = metric('hero_damage_per_min_mid');
    expect(heroDamageMid.compute(context)).toBeNull();
    expect(rateOf(heroDamageMid)(context)).toBeNull();
    expect(metric('souls_per_min_mid').compute(context)).not.toBeNull();
  });

  it('is null when the counter stops before the end of the phase', () => {
    // The archive stops counting the damage at 16:40: neither the whole mid game nor the span to
    // 20:00 can be read.
    const context = matchContext(DURATION_22_MIN_S, [
      testSnapshot(600, { player_damage: 4_000 }),
      testSnapshot(1_000, { player_damage: 8_000 }),
    ]);
    const heroDamageMid = metric('hero_damage_per_min_mid');
    expect(heroDamageMid.compute(context)).toBeNull();
    expect(rateOf(heroDamageMid)(context)).toBeNull();
  });

  it('keeps the community-span rate when the counter stops after the span', () => {
    // The counter is known to 20:00, the end of the community's span, but not to the end of the match.
    const context = matchContext(DURATION_22_MIN_S, [
      testSnapshot(600, { player_damage: 4_000 }),
      testSnapshot(1_200, { player_damage: 10_000 }),
    ]);
    const heroDamageMid = metric('hero_damage_per_min_mid');
    expect(heroDamageMid.compute(context)).toBeNull();
    expect(rateOf(heroDamageMid)(context)).toBeCloseTo(600, 6);
  });
});

describe('the kills per minute of a phase', () => {
  /**
   * The kills of the 22-minute match: the tracked player's at 9:50, 10:00, 10:50, 15:00, 19:50 and
   * at the last second of the match, and another player's at 11:40.
   */
  const KILLS = [
    trackedKill(590),
    trackedKill(600),
    trackedKill(650),
    { timeS: 700, killerSlot: OTHER_SLOT, victimSlot: 9 },
    trackedKill(900),
    trackedKill(1_190),
    trackedKill(DURATION_22_MIN_S),
  ];

  it('counts the kills made by the tracked player in the phase, per minute of the phase', () => {
    const context = matchContext(DURATION_22_MIN_S, [], KILLS);
    // The early game is [0 s, 600 s): the kill at 10:00 is the mid game's.
    expect(metric('kills_per_min_early').compute(context)).toBeCloseTo(0.1, 6);
    // The mid game holds the kills at 10:00, 10:50, 15:00, 19:50 and at the end of the match, which
    // the last phase counts: 5 kills over 12 minutes.
    expect(metric('kills_per_min_mid').compute(context)).toBeCloseTo(5 / 12, 6);
  });

  it('counts the kills of the community span only', () => {
    const context = matchContext(DURATION_22_MIN_S, [], KILLS);
    expect(rateOf(metric('kills_per_min_early'))(context)).toBeCloseTo(0.1, 6);
    // The span stops at 20:00, before the last kill: 4 kills over 10 minutes.
    expect(rateOf(metric('kills_per_min_mid'))(context)).toBeCloseTo(0.4, 6);
  });

  it('is zero, not unknown, for a player without a kill', () => {
    const context = matchContext(DURATION_22_MIN_S, [], []);
    expect(metric('kills_per_min_mid').compute(context)).toBe(0);
    expect(rateOf(metric('kills_per_min_mid'))(context)).toBe(0);
  });

  it('needs no snapshot', () => {
    // The kills come from the deaths of the other players, not from the statistic snapshots.
    const context = matchContext(DURATION_22_MIN_S, [], [trackedKill(650)]);
    expect(metric('kills_per_min_mid').compute(context)).toBeCloseTo(1 / 12, 6);
  });
});

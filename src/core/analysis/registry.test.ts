/**
 * Tests of the metric registry: which metrics the analysis knows and in what order, the projection of
 * a match into the values that are stored (every metric, plus the community window of each curve
 * metric), and how a metric that fails or gives an odd number is kept out of the stored values.
 *
 * The match is built by hand, as a plain object, from synthetic numbers: the registry only runs the
 * metrics on it. The failures are provoked by replacing the `compute` or the `rate` of one metric
 * with a function that throws or gives a bad number; each test puts the metric back.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../test/analysis-context';
import { AppError } from '../errors/app-error';
import type { MatchContext } from './match-context';
import type { CommunitySource, MetricDefinition, MetricKey } from './metric';
import { kdaMetric } from './metrics/kda.metric';
import { soulsAt10MinMetric } from './metrics/souls-at-10min.metric';
import {
  communityWindowKey,
  MATCH_METRICS,
  metricByKey,
  METRICS,
  PROJECTION_VERSION,
  projectMetrics,
} from './registry';

/** The keys of the thirteen match metrics, in the order of their families. */
const MATCH_METRIC_KEYS: readonly MetricKey[] = [
  // Combat.
  'kda',
  'player_damage_per_min',
  'accuracy',
  // Survival.
  'deaths',
  'damage_taken_per_min',
  // Farm.
  'souls_per_min',
  'last_hits',
  'denies',
  // Support.
  'teammate_healing',
  'teammate_barriering',
  // Objectives.
  'boss_damage_per_min',
  // Laning.
  'souls_at_10min',
  'lane_souls_diff_at_10min',
];

/** The keys of the eleven phase metrics, in the order they are listed. */
const PHASE_METRIC_KEYS: readonly MetricKey[] = [
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
];

/**
 * The keys of a projection, in order: every metric, and right after each curve metric its community
 * window. They are the names the values are stored under, so they are written out here and never
 * derived from the registry: a renamed key would orphan what has been stored.
 */
const PROJECTED_KEYS: readonly string[] = [
  'kda',
  'player_damage_per_min',
  'accuracy',
  'deaths',
  'damage_taken_per_min',
  'souls_per_min',
  'last_hits',
  'denies',
  'teammate_healing',
  'teammate_barriering',
  'boss_damage_per_min',
  'souls_at_10min',
  'souls_at_10min.community_window',
  'lane_souls_diff_at_10min',
  'souls_per_min_mid',
  'souls_per_min_mid.community_window',
  'souls_per_min_late',
  'souls_per_min_late.community_window',
  'hero_damage_per_min_early',
  'hero_damage_per_min_early.community_window',
  'hero_damage_per_min_mid',
  'hero_damage_per_min_mid.community_window',
  'hero_damage_per_min_late',
  'hero_damage_per_min_late.community_window',
  'objective_damage_per_min_early',
  'objective_damage_per_min_early.community_window',
  'objective_damage_per_min_mid',
  'objective_damage_per_min_mid.community_window',
  'objective_damage_per_min_late',
  'objective_damage_per_min_late.community_window',
  'kills_per_min_early',
  'kills_per_min_early.community_window',
  'kills_per_min_mid',
  'kills_per_min_mid.community_window',
  'kills_per_min_late',
  'kills_per_min_late.community_window',
];

/** The slot of the tracked player in the hand-built match. */
const TRACKED_SLOT = 1;

/**
 * Build a match in which the tracked player has farmed, fought and hit objectives, so that most of
 * the metrics have a value: 6 kills (two of them in the first ten minutes), 4 deaths, 14 assists, and
 * counters that grow at a steady pace between the snapshots at 10:00, 25:00 and the end of the match.
 * No healing, no shots and no lane opponent are given: those metrics have no value here.
 *
 * @returns The match context (1934 seconds long, so the community window starts at 1800).
 */
function matchContext(): MatchContext {
  return testMatchContext({
    tracked: testPlayer({
      slot: TRACKED_SLOT,
      kills: 6,
      deaths: 4,
      assists: 14,
      netWorth: 24_000,
      snapshots: [
        testSnapshot(600, { net_worth: 6_000, player_damage: 6_000, boss_damage: 1_200 }),
        testSnapshot(1_500, { net_worth: 18_000, player_damage: 24_000, boss_damage: 3_000 }),
        testSnapshot(1_934, { net_worth: 24_000, player_damage: 36_000, boss_damage: 4_000 }),
      ],
    }),
    kills: [
      { timeS: 100, killerSlot: TRACKED_SLOT, victimSlot: 7 },
      { timeS: 300, killerSlot: TRACKED_SLOT, victimSlot: 8 },
    ],
  });
}

/**
 * The curve source of a metric.
 *
 * @param metric - A metric compared with the community's curve.
 * @returns Its community source, narrowed to the curve kind.
 * @throws Error when the metric has another kind of source (a mistake in the test).
 */
function curveOf(metric: MetricDefinition): Extract<CommunitySource, { kind: 'curve' }> {
  const { community } = metric;
  if (community.kind !== 'curve') {
    throw new Error(`${metric.key} is not a curve metric`);
  }
  return community;
}

afterEach(() => {
  // Put back the `compute` and the `rate` that a test replaced.
  vi.restoreAllMocks();
});

describe('MATCH_METRICS', () => {
  it('lists 13 match metrics in family order', () => {
    expect(MATCH_METRICS.map((metric) => metric.key)).toEqual(MATCH_METRIC_KEYS);
    expect(MATCH_METRICS.map((metric) => metric.family)).toEqual([
      'combat',
      'combat',
      'combat',
      'survival',
      'survival',
      'farm',
      'farm',
      'farm',
      'support',
      'support',
      'objectives',
      'laning',
      'laning',
    ]);
  });
});

describe('METRICS', () => {
  it('lists the 13 match metrics, then the 11 phase metrics', () => {
    expect(METRICS).toHaveLength(24);
    expect(METRICS.map((metric) => metric.key)).toEqual([
      ...MATCH_METRIC_KEYS,
      ...PHASE_METRIC_KEYS,
    ]);
  });

  it('keys are unique', () => {
    const keys = METRICS.map((metric) => metric.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the match metrics in a family and the phase metrics out of every family', () => {
    expect(MATCH_METRICS.every((metric) => metric.family !== null)).toBe(true);
    expect(
      METRICS.filter((metric) => !MATCH_METRICS.includes(metric)).every(
        (metric) => metric.family === null,
      ),
    ).toBe(true);
  });

  it('puts a phase metric in the group of the match metrics that say the same thing', () => {
    const groupOf = (key: MetricKey): string => metricByKey(key).group;
    // The group is the figure itself, so the summary shows at most one of its metrics per side.
    for (const key of [
      'souls_per_min',
      'souls_at_10min',
      'souls_per_min_mid',
      'souls_per_min_late',
    ] as const) {
      expect(groupOf(key)).toBe('souls');
    }
    for (const key of [
      'player_damage_per_min',
      'hero_damage_per_min_early',
      'hero_damage_per_min_mid',
      'hero_damage_per_min_late',
    ] as const) {
      expect(groupOf(key)).toBe('hero_damage');
    }
    for (const key of [
      'boss_damage_per_min',
      'objective_damage_per_min_early',
      'objective_damage_per_min_mid',
      'objective_damage_per_min_late',
    ] as const) {
      expect(groupOf(key)).toBe('objective_damage');
    }
    for (const key of ['kills_per_min_early', 'kills_per_min_mid', 'kills_per_min_late'] as const) {
      expect(groupOf(key)).toBe('kills');
    }
  });

  it('compares 12 metrics with the community curve: the 11 phase metrics and souls_at_10min', () => {
    const curveKeys = METRICS.filter((metric) => metric.community.kind === 'curve').map(
      (metric) => metric.key,
    );
    expect(curveKeys).toHaveLength(12);
    expect(curveKeys).toEqual(['souls_at_10min', ...PHASE_METRIC_KEYS]);
  });
});

describe('PROJECTION_VERSION', () => {
  it('is 1', () => {
    expect(PROJECTION_VERSION).toBe(1);
  });
});

describe('communityWindowKey', () => {
  it('names the community window of a metric after its key', () => {
    expect(communityWindowKey('souls_at_10min')).toBe('souls_at_10min.community_window');
    expect(communityWindowKey('kills_per_min_late')).toBe('kills_per_min_late.community_window');
  });
});

describe('metricByKey', () => {
  it('gives the definition of every metric', () => {
    for (const metric of METRICS) {
      expect(metricByKey(metric.key)).toBe(metric);
    }
  });

  it('throws an unexpected error for a key no metric has', () => {
    // Impossible by type: a key read back from storage can still be anything.
    const unknown = 'no_such_metric' as MetricKey;
    expect.assertions(3);
    try {
      metricByKey(unknown);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ kind: 'unexpected' });
      // A metric key is not personal data: it is the one detail that helps find a stale record.
      expect(error).toMatchObject({ context: { key: 'no_such_metric' } });
    }
  });
});

describe('projectMetrics', () => {
  it('projects 36 values: every metric, and the community window of each curve metric', () => {
    const projection = projectMetrics(matchContext());
    expect(projection.size).toBe(36);
    // The order is the registry's, each community window right after its metric.
    expect([...projection.keys()]).toEqual(PROJECTED_KEYS);
  });

  it('projects the value of each metric', () => {
    const projection = projectMetrics(matchContext());
    // (6 kills + 14 assists) / 4 deaths.
    expect(projection.get('kda')).toBe(5);
    expect(projection.get('deaths')).toBe(4);
    expect(projection.get('souls_at_10min')).toBe(6_000);
    // 6000 damage to heroes over the first 10 minutes, then 18000 over the next 15.
    expect(projection.get('hero_damage_per_min_early')).toBe(600);
    expect(projection.get('hero_damage_per_min_mid')).toBe(1_200);
    // 1200 damage to objectives over the first 10 minutes.
    expect(projection.get('objective_damage_per_min_early')).toBe(120);
    // 2 kills in the first 10 minutes.
    expect(projection.get('kills_per_min_early')).toBeCloseTo(0.2, 10);
  });

  it('projects the rate over the span the community covers, next to a curve metric', () => {
    const projection = projectMetrics(matchContext());
    // 6000 souls over the first 10 minutes, the span the community's curve is read on.
    expect(projection.get('souls_at_10min.community_window')).toBe(600);
    expect(projection.get('hero_damage_per_min_early.community_window')).toBe(600);
    expect(projection.get('hero_damage_per_min_mid.community_window')).toBe(1_200);
  });

  it('projects a value that is not known as null, never as 0', () => {
    const projection = projectMetrics(matchContext());
    // The archive holds no shots, no healing and no lane opponent.
    expect(projection.get('accuracy')).toBeNull();
    expect(projection.get('teammate_healing')).toBeNull();
    expect(projection.get('lane_souls_diff_at_10min')).toBeNull();
    // A match with no snapshot at all knows no counter, whatever the end-of-game fields say.
    const bare = projectMetrics(testMatchContext());
    expect(bare.size).toBe(36);
    expect(bare.get('souls_at_10min')).toBeNull();
    expect(bare.get('souls_at_10min.community_window')).toBeNull();
  });

  it('does not report a value that is only unknown', () => {
    const onError = vi.fn<(key: MetricKey, error: unknown) => void>();
    projectMetrics(testMatchContext(), onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a throwing metric gives null and is reported', () => {
    const failure = new Error('synthetic failure');
    vi.spyOn(kdaMetric, 'compute').mockImplementation(() => {
      throw failure;
    });
    const onError = vi.fn<(key: MetricKey, error: unknown) => void>();

    const projection = projectMetrics(matchContext(), onError);

    expect(projection.get('kda')).toBeNull();
    // The other metrics are projected all the same.
    expect(projection.size).toBe(36);
    expect(projection.get('deaths')).toBe(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('kda', failure);
  });

  it('a throwing metric is projected as null when nobody listens for the errors', () => {
    vi.spyOn(kdaMetric, 'compute').mockImplementation(() => {
      throw new Error('synthetic failure');
    });
    expect(projectMetrics(matchContext()).get('kda')).toBeNull();
  });

  it('a throwing community rate gives a null window and is reported under the metric key', () => {
    const failure = new Error('synthetic failure');
    vi.spyOn(curveOf(soulsAt10MinMetric), 'rate').mockImplementation(() => {
      throw failure;
    });
    const onError = vi.fn<(key: MetricKey, error: unknown) => void>();

    const projection = projectMetrics(matchContext(), onError);

    // The metric keeps its value, and only its auxiliary value is lost.
    expect(projection.get('souls_at_10min')).toBe(6_000);
    expect(projection.get('souls_at_10min.community_window')).toBeNull();
    expect(projection.size).toBe(36);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('souls_at_10min', failure);
  });

  it('a metric whose value fails still has its community window', () => {
    vi.spyOn(soulsAt10MinMetric, 'compute').mockImplementation(() => {
      throw new Error('synthetic failure');
    });
    const projection = projectMetrics(matchContext());
    expect(projection.get('souls_at_10min')).toBeNull();
    expect(projection.get('souls_at_10min.community_window')).toBe(600);
  });

  it('NaN becomes null', () => {
    vi.spyOn(kdaMetric, 'compute').mockReturnValue(Number.NaN);
    vi.spyOn(curveOf(soulsAt10MinMetric), 'rate').mockReturnValue(Number.NaN);
    const onError = vi.fn<(key: MetricKey, error: unknown) => void>();

    const projection = projectMetrics(matchContext(), onError);

    expect(projection.get('kda')).toBeNull();
    expect(projection.get('souls_at_10min.community_window')).toBeNull();
    // A number that is not finite is not a failure: the metric ran, its result is just unusable.
    expect(onError).not.toHaveBeenCalled();
  });

  it('an infinite number becomes null', () => {
    vi.spyOn(kdaMetric, 'compute').mockReturnValue(Number.POSITIVE_INFINITY);
    vi.spyOn(curveOf(soulsAt10MinMetric), 'rate').mockReturnValue(Number.NEGATIVE_INFINITY);
    const projection = projectMetrics(matchContext());
    expect(projection.get('kda')).toBeNull();
    expect(projection.get('souls_at_10min.community_window')).toBeNull();
  });

  it('keeps a value of 0, which is a known value', () => {
    vi.spyOn(kdaMetric, 'compute').mockReturnValue(0);
    expect(projectMetrics(matchContext()).get('kda')).toBe(0);
  });
});

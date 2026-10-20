/**
 * Tests of the match analysis (`AnalysisService`), end to end on the development adapters: the
 * archives, the projections and the rank come from a synchronisation of the synthetic history, the
 * community data from the fixture API, and everything is stored in an in-memory database with the
 * real migrations.
 *
 * The synthetic history holds nine archived Paige matches of every length from 20 to 49 minutes,
 * ranked and unranked ones, and the player's current rank is Sentinel (badge 44). A test that needs
 * a match the fixtures do not hold (a different length, other values for the habits, an archive that
 * lacks something) edits what the synchronisation stored, which keeps the match archived and
 * projected, exactly like data written by another version of the app would be.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import {
  createPerformanceCurveFixture,
  createPlayerRankFixture,
} from '../adapters/dev/fixtures/analytics.fixture';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
  type RawMatchHistoryRow,
} from '../adapters/dev/fixtures/match-history.fixture';
import { fixtureTrackedBadge } from '../adapters/dev/fixtures/match-metadata.fixture';
import { durationWindowOf } from '../core/analysis/cohort';
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import { buildMatchContext } from '../core/analysis/match-context';
import type { MetricKey } from '../core/analysis/metric';
import { phaseBreakdown, PHASE_STATS } from '../core/analysis/phases';
import { curveRate, placeOnCurve } from '../core/analysis/references';
import { MATCH_METRICS, metricByKey, PROJECTION_VERSION } from '../core/analysis/registry';
import { median } from '../core/analysis/statistics';
import { parsePerformanceCurve } from '../core/deadlock-api/performance-curve.schema';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { matchIdSchema, type MatchId } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import { accountFolderName, archivePath } from '../core/match-detail/archive-layout';
import { createTestServices } from '../test/create-test-services';
import { DirectCompressor } from '../test/direct-compressor';
import { matchSummary, testMatchId } from '../test/test-data';
import type { MatchAnalysis, MatchAnalysisView, MetricRowView } from './analysis-view';
import { ArchiveReaderService } from './archive-reader.service';
import { BenchmarkService } from './benchmark.service';
import { LinkedAccountRepository } from './linked-account.repository';
import { MatchDetailRepository } from './match-detail.repository';
import { MatchesRepository } from './matches.repository';
import { MetricsRepository } from './metrics.repository';

/** The time of the synchronisation that archives the matches (Unix ms); the history ends before. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/** A minute, in milliseconds. */
const MINUTE_MS = 60_000;

/** A day, in milliseconds. */
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The tracked account: the one of the synthetic history. */
const ACCOUNT = FIXTURE_ACCOUNT_ID;

/** The match mode of a ranked match, the only one in which the player has a badge. */
const RANKED_MODE = 4;

/** The synthetic history the synchronisation saves: 30 matches, most recent first. */
const HISTORY = createMatchHistoryFixture({ now: START, count: 30 });

/** The tier of the current rank of the player (badge 44, Sentinel): the rank of an unranked match. */
const CURRENT_TIER = Math.floor(createPlayerRankFixture().badge / 10);

/** The paths of the three community requests of a cohort. */
const HERO_STATS_PATH = '/v1/analytics/hero-stats';
const BENCHMARK_PATH = '/v1/analytics/player-stats/metrics';
const CURVE_PATH = '/v1/analytics/player-performance-curve';

/** The start of the path of every community request. */
const ANALYTICS_PREFIX = '/v1/analytics/';

/** The scope of the log lines of the analysis. */
const LOG_SCOPE = 'analysis';

/** The families in the order the page shows them. */
const FAMILIES = ['combat', 'survival', 'farm', 'support', 'objectives', 'laning'];

/** The part of an archive that the tests edit. */
interface EditableEnvelope {
  payload: {
    match_info: { duration_s: number; players: { account_id: number; net_worth?: number }[] };
  };
}

/**
 * Answer the hero statistics with a given number of matches of Paige: one number for the requests
 * with a badge range (a tier), another for the ones without (every rank). The other requests are
 * answered like the fixture API.
 *
 * @param sizes - The number of matches of a tier cohort, and of an all-ranks cohort.
 * @returns The handler.
 */
function withSampleSizes(sizes: { readonly tier: number; readonly all: number }): FixtureHandler {
  const fixtureApi = createFixtureApi({ now: START, matchCount: 30 });
  return (request) => {
    const url = new URL(request.url);
    if (url.pathname !== HERO_STATS_PATH) {
      return fixtureApi(request);
    }
    const ranked = url.searchParams.has('min_average_badge');
    return jsonResponse([{ hero_id: PAIGE_HERO_ID, matches: ranked ? sizes.tier : sizes.all }]);
  };
}

/**
 * Archive the matches of the synthetic history and build the services like the app does, on the
 * development adapters. The synchronisation downloads and archives the details, projects them and
 * fetches the rank of the player, so every archived match can be analysed. The clock is the test's.
 *
 * @param handler - Answers the requests to deadlock-api; the fixture API by default.
 * @returns The services, the adapters under them and the matches that are archived.
 */
async function setUp(handler: FixtureHandler = createFixtureApi({ now: START, matchCount: 30 })) {
  const clock = { now: START };
  const compressor = new DirectCompressor();
  const test = createTestServices({ handler, now: () => clock.now, compressor });
  await test.services.sync.syncNow('startup');
  const rows = await test.database.select(
    `SELECT match_id FROM matches WHERE detail_status = 'ready' ORDER BY start_time DESC, match_id DESC`,
  );
  // Most recent first.
  const archived = rows.map((row) => matchIdSchema.parse(row.match_id));
  expect(archived.length, 'the history holds several archived matches').toBeGreaterThanOrEqual(8);
  return {
    ...test,
    clock,
    compressor,
    analysis: test.services.analysis,
    metrics: new MetricsRepository(test.database),
    details: new MatchDetailRepository(test.database),
    reader: new ArchiveReaderService({
      archive: test.archiveStore,
      compressor,
      logger: test.logger,
    }),
    archived,
  };
}

/** Everything {@link setUp} builds. */
type TestContext = Awaited<ReturnType<typeof setUp>>;

/**
 * The history row of a match.
 *
 * @param matchId - The match.
 * @returns The row.
 */
function historyRow(matchId: MatchId): RawMatchHistoryRow {
  return (
    HISTORY.find((row) => row.match_id === matchId) ??
    expect.unreachable('the match is in the history')
  );
}

/**
 * The length of a match of the synthetic history.
 *
 * @param matchId - The match.
 * @returns Its length in seconds.
 */
function durationOf(matchId: MatchId): number {
  return historyRow(matchId).match_duration_s;
}

/**
 * The badge the tracked player had in a match of the synthetic history.
 *
 * @param matchId - The match.
 * @returns The badge of a ranked match, `null` for an unranked one.
 */
function ownBadgeOf(matchId: MatchId): number | null {
  return historyRow(matchId).match_mode === RANKED_MODE ? fixtureTrackedBadge(matchId) : null;
}

/**
 * The tier a match is compared with: the one of the badge the player had in it, or of their current
 * rank for an unranked match.
 *
 * @param matchId - The match.
 * @returns The tier.
 */
function expectedTierOf(matchId: MatchId): number {
  const badge = ownBadgeOf(matchId);
  return badge === null ? CURRENT_TIER : Math.floor(badge / 10);
}

/**
 * Find the archived match that meets a condition.
 *
 * @param context - What {@link setUp} built.
 * @param condition - Tells whether a match is the one.
 * @param what - What the match is, for the failure.
 * @returns The match.
 */
function pick(context: TestContext, condition: (matchId: MatchId) => boolean, what: string) {
  return context.archived.find(condition) ?? expect.unreachable(`the history holds ${what}`);
}

/**
 * Unwrap the analysis of a match.
 *
 * @param view - What the service answered.
 * @returns The analysis, or a failure of the test when the match is not `ready`.
 */
function ready(view: MatchAnalysisView): MatchAnalysis {
  if (view.kind !== 'ready') {
    expect.unreachable(`the analysis is ${view.kind}, not ready`);
  }
  return view.analysis;
}

/**
 * Analyse a match with the community data in the cache that it is compared with: download it first.
 * Every download gets its own minute on the clock of the test, so that the budget of the community
 * requests (20 a minute) never runs out across the several matches a test goes through.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The analysis.
 */
async function analyseWithCommunity(context: TestContext, matchId: MatchId) {
  context.clock.now += MINUTE_MS;
  await context.analysis.refreshCommunity(matchId);
  return ready(await context.analysis.getMatchAnalysis(matchId));
}

/**
 * Every row of an analysis: the ones of the families, then the ones of the phase table (the early
 * souls are in both, `souls_at_10min` being a metric of the whole match as well).
 *
 * @param analysis - The analysis.
 * @returns The rows.
 */
function rowsOf(analysis: MatchAnalysis): MetricRowView[] {
  return [
    ...analysis.families.flatMap((family) => family.rows),
    ...analysis.phases.flatMap((column) =>
      PHASE_STATS.flatMap((stat) => column.cells[stat].row ?? []),
    ),
  ];
}

/**
 * One row of an analysis.
 *
 * @param analysis - The analysis.
 * @param key - The metric.
 * @returns Its row.
 */
function rowOf(analysis: MatchAnalysis, key: MetricKey): MetricRowView {
  return rowsOf(analysis).find((row) => row.key === key) ?? expect.unreachable(`no row for ${key}`);
}

/**
 * The community requests received, in order.
 *
 * @param context - What {@link setUp} built.
 * @returns The requests.
 */
function communityRequests(context: TestContext) {
  return context.http.requests.filter((request) =>
    new URL(request.url).pathname.startsWith(ANALYTICS_PREFIX),
  );
}

/**
 * The paths of the community requests received, in order.
 *
 * @param context - What {@link setUp} built.
 * @returns The paths.
 */
function communityPaths(context: TestContext): string[] {
  return communityRequests(context).map((request) => new URL(request.url).pathname);
}

/**
 * Replace some of the stored values of a match, keeping its projection otherwise as it is.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param changes - The new values by metric key.
 */
async function overrideValues(
  context: TestContext,
  matchId: MatchId,
  changes: Readonly<Record<string, number>>,
): Promise<void> {
  const projection =
    (await context.metrics.getProjection(ACCOUNT, matchId)) ??
    expect.unreachable('the match is projected');
  const values = new Map(await context.metrics.getValues(ACCOUNT, matchId));
  for (const [key, value] of Object.entries(changes)) {
    values.set(key, value);
  }
  await context.metrics.saveProjection(ACCOUNT, matchId, projection, values);
}

/**
 * Change the length of a match in the match history, the one `getProjection` and `listPrevious` read.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param durationS - The new length in seconds.
 */
async function setHistoryDuration(
  context: TestContext,
  matchId: MatchId,
  durationS: number,
): Promise<void> {
  await context.database.execute(
    'UPDATE matches SET duration_s = $1 WHERE account_id = $2 AND match_id = $3',
    [durationS, ACCOUNT, matchId],
  );
}

/**
 * Edit the archive the synchronisation wrote for a match, and write the file again. The match stays
 * recorded as archived and projected.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param edit - Edits the match info of the archive and its tracked player.
 */
async function editArchive(
  context: TestContext,
  matchId: MatchId,
  edit: (
    matchInfo: EditableEnvelope['payload']['match_info'],
    tracked: EditableEnvelope['payload']['match_info']['players'][number],
  ) => void,
): Promise<void> {
  const read = await context.reader.readArchive(ACCOUNT, matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  const envelope = JSON.parse(JSON.stringify(read.envelope)) as EditableEnvelope;
  const matchInfo = envelope.payload.match_info;
  edit(
    matchInfo,
    matchInfo.players.find((player) => player.account_id === ACCOUNT) ??
      expect.unreachable('the tracked player is in the match'),
  );
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await context.archiveStore.write(ACCOUNT, matchId, await context.compressor.compress(bytes));
}

/**
 * Collect every number of a value, going through its objects and arrays.
 *
 * @param value - Any value of a view.
 * @param found - Where the numbers are collected.
 * @returns The numbers.
 */
function numbersIn(value: unknown, found: number[] = []): number[] {
  if (typeof value === 'number') {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      numbersIn(item, found);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      numbersIn(item, found);
    }
  }
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnalysisService.getMatchAnalysis', () => {
  it('is pending before the projection', async () => {
    const context = await setUp();
    const newest = context.archived[0] ?? expect.unreachable();
    await context.metrics.deleteAccount(ACCOUNT);

    await expect(context.analysis.getMatchAnalysis(newest)).resolves.toEqual({ kind: 'pending' });
  });

  it('is pending when the projection is of another version of the metrics', async () => {
    const context = await setUp();
    const newest = context.archived[0] ?? expect.unreachable();
    const projection =
      (await context.metrics.getProjection(ACCOUNT, newest)) ?? expect.unreachable();
    // Even a failed verdict of an older version is not the verdict of the current one.
    await context.metrics.saveProjection(
      ACCOUNT,
      newest,
      { ...projection, version: PROJECTION_VERSION - 1, failed: true },
      new Map(),
    );

    await expect(context.analysis.getMatchAnalysis(newest)).resolves.toEqual({ kind: 'pending' });
  });

  it('is failed when the projection could not read the match', async () => {
    const context = await setUp();
    const newest = context.archived[0] ?? expect.unreachable();
    const projection =
      (await context.metrics.getProjection(ACCOUNT, newest)) ?? expect.unreachable();
    await context.metrics.saveProjection(
      ACCOUNT,
      newest,
      { ...projection, failed: true },
      new Map(),
    );

    await expect(context.analysis.getMatchAnalysis(newest)).resolves.toEqual({ kind: 'failed' });
  });

  it('is ready with 13 rows in 6 families and 3 phase columns for a 30-minute match', async () => {
    const context = await setUp();
    const matchId = pick(
      context,
      (candidate) => Math.abs(durationOf(candidate) - 1_800) <= 100,
      'a match of about 30 minutes',
    );

    const analysis = await analyseWithCommunity(context, matchId);

    expect(analysis.durationS).toBe(durationOf(matchId));
    expect(analysis.community).toMatchObject({ kind: 'available', fallback: false, stale: false });
    // The 13 metrics of the match, in the six families and in the order of the registry.
    expect(analysis.families.map((family) => family.family)).toEqual(FAMILIES);
    const familyRows = analysis.families.flatMap((family) => family.rows);
    expect(familyRows.map((row) => row.key)).toEqual(MATCH_METRICS.map((metric) => metric.key));
    expect(familyRows).toHaveLength(13);
    const values = await context.metrics.getValues(ACCOUNT, matchId);
    for (const row of familyRows) {
      const definition = metricByKey(row.key);
      expect(row, row.key).toMatchObject({ unit: definition.unit, better: definition.better });
      expect(row.value, row.key).toBe(values.get(row.key) ?? null);
    }
    // The three kinds of community reference: a benchmark, the curve, and none.
    expect(rowOf(analysis, 'kda').community.kind).toBe('percentile');
    expect(rowOf(analysis, 'souls_at_10min').community.kind).toBe('curve');
    expect(rowOf(analysis, 'lane_souls_diff_at_10min').community).toEqual({ kind: 'none' });
    // The three phases, each scored: the metric of every cell, with the early souls on the
    // souls at 10:00.
    expect(analysis.phases.map((column) => column.span.phase)).toEqual(['early', 'mid', 'late']);
    expect(
      analysis.phases.map((column) => PHASE_STATS.map((stat) => column.cells[stat].row?.key)),
    ).toEqual([
      [
        'souls_at_10min',
        'hero_damage_per_min_early',
        'objective_damage_per_min_early',
        'kills_per_min_early',
      ],
      [
        'souls_per_min_mid',
        'hero_damage_per_min_mid',
        'objective_damage_per_min_mid',
        'kills_per_min_mid',
      ],
      [
        'souls_per_min_late',
        'hero_damage_per_min_late',
        'objective_damage_per_min_late',
        'kills_per_min_late',
      ],
    ]);
    // The totals and the shares are the ones of the archive.
    const read = await context.reader.readArchive(ACCOUNT, matchId);
    if (read.kind !== 'read') {
      expect.unreachable('the archive of the match is readable');
    }
    expect(
      analysis.phases.map((column) => ({
        span: column.span,
        figures: PHASE_STATS.map((stat) => [
          column.cells[stat].total,
          column.cells[stat].teamShare,
        ]),
      })),
    ).toEqual(
      phaseBreakdown(buildMatchContext(read.envelope)).map((phase) => ({
        span: phase.span,
        figures: PHASE_STATS.map((stat) => [phase.cells[stat].total, phase.cells[stat].teamShare]),
      })),
    );
  });

  it('gives each strength and weakness of the summary to the row of its metric', async () => {
    const context = await setUp();
    // The most recent match has the most habits to be compared with.
    const analysis = await analyseWithCommunity(
      context,
      context.archived[0] ?? expect.unreachable(),
    );

    const insights = [...analysis.strengths, ...analysis.weaknesses];
    expect(insights.length, 'the match stands out somewhere').toBeGreaterThan(0);
    expect(analysis.strengths.length).toBeLessThanOrEqual(3);
    expect(analysis.weaknesses.length).toBeLessThanOrEqual(3);
    expect(analysis.strengths.every((insight) => insight.side === 'strength')).toBe(true);
    expect(analysis.weaknesses.every((insight) => insight.side === 'weakness')).toBe(true);
    // A row has an insight exactly when the summary holds one for its metric.
    for (const row of rowsOf(analysis)) {
      expect(row.insight, row.key).toEqual(
        insights.find((insight) => insight.key === row.key) ?? null,
      );
    }
    // Each summary metric is a row of the page.
    for (const insight of insights) {
      expect(rowsOf(analysis).map((row) => row.key)).toContain(insight.key);
    }
  });

  it('compares a ranked match with its own badge and an unranked one with the current rank', async () => {
    const context = await setUp();
    const ranked = pick(context, (candidate) => ownBadgeOf(candidate) !== null, 'a ranked match');
    const unranked = pick(
      context,
      (candidate) => ownBadgeOf(candidate) === null,
      'an unranked match',
    );

    for (const matchId of [ranked, unranked]) {
      const { community } = await analyseWithCommunity(context, matchId);

      expect(community, String(matchId)).toMatchObject({
        kind: 'available',
        used: {
          rank: { kind: 'tier', tier: expectedTierOf(matchId) },
          window: durationWindowOf(durationOf(matchId)),
        },
      });
    }
    // The badge of the ranked match is not the current rank, or the test would prove nothing.
    expect(expectedTierOf(ranked)).not.toBe(CURRENT_TIER);
  });

  it('shows not enough data for the oldest match', async () => {
    const context = await setUp();
    // The matches from the oldest: the number of earlier matches is the position.
    const fromOldest = context.archived.toReversed();

    for (const [earlier, matchId] of fromOldest.entries()) {
      const analysis = await analyseWithCommunity(context, matchId);

      // Five earlier matches make habits; fewer say nothing about the player.
      const { personal } = rowOf(analysis, 'kda');
      if (earlier < 5) {
        expect(personal, `${String(earlier)} earlier matches`).toBeNull();
      } else {
        expect(personal?.count, `${String(earlier)} earlier matches`).toBe(earlier);
      }
    }
    // The oldest match has nothing to be compared with but the community, so each of its
    // comparisons rests on one reference only.
    const oldest = ready(
      await context.analysis.getMatchAnalysis(fromOldest[0] ?? expect.unreachable()),
    );
    const compared = rowsOf(oldest).filter(
      (row) => row.community.kind !== 'missing' && row.value !== null,
    );
    expect(compared.length).toBeGreaterThan(0);
    for (const row of rowsOf(oldest)) {
      expect(row.personal, row.key).toBeNull();
    }
    for (const row of compared.filter((candidate) => candidate.community.kind !== 'none')) {
      expect(row.confidence, row.key).toBe('medium');
    }
  });

  it('compares totals per minute with the habits', async () => {
    const context = await setUp();
    const [newest = expect.unreachable(), ...earlier] = context.archived;
    // The habits: matches of 22 minutes in which the player healed about 100 a minute (2,000 to
    // 2,400 over the match, so that the habits vary).
    const healingOf = (index: number): number => 2_000 + ((index * 7) % 5) * 100;
    for (const [index, matchId] of earlier.entries()) {
      await setHistoryDuration(context, matchId, 22 * 60);
      await overrideValues(context, matchId, { teammate_healing: healingOf(index) });
    }
    // This match lasts twice as long and the player healed twice as much: the same rate.
    await setHistoryDuration(context, newest, 45 * 60);
    await overrideValues(context, newest, { teammate_healing: 4_400 });

    const analysis = ready(await context.analysis.getMatchAnalysis(newest));

    const row = rowOf(analysis, 'teammate_healing');
    const personal = row.personal ?? expect.unreachable('the habits are enough');
    expect(personal.count).toBe(earlier.length);
    // Per minute, the match is an ordinary one: compared as it is, 4,400 would be far above the
    // 2,200 of the habits.
    expect(Math.abs(personal.z ?? expect.unreachable('the habits vary'))).toBeLessThan(1);
    expect(row.insight).toBeNull();
    expect(analysis.strengths.map((insight) => insight.key)).not.toContain('teammate_healing');
    // The usual value is shown back as a total over the length of this match.
    const usualRate = median(earlier.map((_, index) => healingOf(index) / 22));
    expect(personal.median).toBeCloseTo(usualRate * 45, 6);
    expect(personal.difference.kind).toBe('relative');
    expect(
      personal.difference.kind === 'relative' ? personal.difference.ratio : Number.NaN,
    ).toBeCloseTo(4_400 / 45 / usualRate - 1, 6);
    // A metric that is already a rate is compared as it is.
    expect(rowOf(analysis, 'kda').personal?.count).toBe(earlier.length);
  });

  it('reads the habits of a metric past the matches where it is unknown', async () => {
    const context = await setUp();
    const newest = context.archived[0] ?? expect.unreachable();
    // Thirty-five earlier matches, played just before the most recent one. The late game of the
    // ten most recent is unknown (they ended too soon to have one), the 25 before them know it.
    const unknownCount = 10;
    const knownCount = 25;
    const lateKillsOf = (index: number): number => 0.2 + (index % 7) * 0.05;
    const startTime = historyRow(newest).start_time;
    const synthetic = Array.from({ length: unknownCount + knownCount }, (_, index) =>
      testMatchId(100_000_001 + index),
    );
    await new MatchesRepository(context.database, () => START).upsertMany(
      synthetic.map((matchId, index) =>
        matchSummary({
          accountId: ACCOUNT,
          matchId,
          startTime: startTime - 60 * (index + 1),
          durationS: 1_800,
        }),
      ),
    );
    for (const [index, matchId] of synthetic.entries()) {
      await context.metrics.saveProjection(
        ACCOUNT,
        matchId,
        {
          version: PROJECTION_VERSION,
          playerBadge: null,
          hasLeaver: false,
          failed: false,
          projectedAt: 1,
        },
        new Map([['kills_per_min_late', index < unknownCount ? null : lateKillsOf(index)]]),
      );
    }

    const analysis = ready(await context.analysis.getMatchAnalysis(newest));

    // The habits are the 20 most recent known values, found past the ten unknown ones.
    const late = rowOf(analysis, 'kills_per_min_late').personal;
    expect(late?.count).toBe(PERSONAL_WINDOW);
    const habits = synthetic
      .slice(unknownCount)
      .map((_, index) => lateKillsOf(unknownCount + index));
    const lateMinutes = (durationOf(newest) - 1_500) / 60;
    expect(late?.median).toBeCloseTo(median(habits.slice(0, PERSONAL_WINDOW)) * lateMinutes, 6);
    // A metric the synthetic matches do not hold at all is compared with the real earlier matches.
    expect(rowOf(analysis, 'kda').personal?.count).toBe(context.archived.length - 1);
  });

  it('uses the community-window rate for a phase', async () => {
    const context = await setUp();
    // A match of about 22 minutes: its window is the one of 20 to 25 minutes, whose curve every
    // match reaches up to 20:00, while its mid game lasts until the end of the match.
    const matchId = pick(
      context,
      (candidate) => durationOf(candidate) >= 1_300 && durationOf(candidate) <= 1_499,
      'a match of about 22 minutes',
    );
    // The rate over the whole mid game is very high and the one over the stretch of it the
    // community covers is very low: only one of them can give the placement.
    await overrideValues(context, matchId, {
      hero_damage_per_min_mid: 5_000,
      'hero_damage_per_min_mid.community_window': 100,
    });

    const analysis = await analyseWithCommunity(context, matchId);

    const curve = parsePerformanceCurve(createPerformanceCurveFixture(1_499));
    const community = curveRate(curve, 'player_damage', 600, 1_200) ?? expect.unreachable();
    const fromWindow = placeOnCurve(100, community) ?? expect.unreachable();
    const fromPhase = placeOnCurve(5_000, community) ?? expect.unreachable();
    expect(fromWindow.percentile).toBeLessThan(50);
    expect(fromPhase.percentile).toBeGreaterThan(50);
    const mid =
      analysis.phases.find((column) => column.span.phase === 'mid') ?? expect.unreachable();
    expect(mid.cells.hero_damage.row?.value).toBe(5_000);
    expect(mid.cells.hero_damage.row?.community).toEqual({
      kind: 'curve',
      percentile: fromWindow.percentile,
      label: fromWindow.label,
    });
  });

  it('shows the totals of a phase that is too short to be scored, without a row', async () => {
    const context = await setUp();
    const matchId = pick(
      context,
      (candidate) => durationOf(candidate) > 1_800,
      'a match of more than 30 minutes',
    );
    // The match ends 100 seconds into the late game, which is less than the three minutes a phase
    // needs to be compared.
    await setHistoryDuration(context, matchId, 1_600);
    await editArchive(context, matchId, (matchInfo) => {
      matchInfo.duration_s = 1_600;
    });

    const analysis = ready(await context.analysis.getMatchAnalysis(matchId));

    expect(analysis.phases.map((column) => column.span.comparable)).toEqual([true, true, false]);
    const [early, mid, late] = analysis.phases;
    for (const stat of PHASE_STATS) {
      expect(early?.cells[stat].row, stat).not.toBeNull();
      expect(mid?.cells[stat].row, stat).not.toBeNull();
      expect(late?.cells[stat].row, stat).toBeNull();
    }
    // The totals are still shown.
    expect(late?.cells.kills.total).not.toBeNull();
  });

  it('reports missing community data without a cache', async () => {
    const context = await setUp();

    const analysis = ready(
      await context.analysis.getMatchAnalysis(context.archived[0] ?? expect.unreachable()),
    );

    expect(analysis.community).toEqual({ kind: 'missing' });
    // Reading the analysis never downloads anything.
    expect(communityPaths(context)).toEqual([]);
    const kinds = new Set(rowsOf(analysis).map((row) => row.community.kind));
    expect(kinds).toEqual(new Set(['missing', 'none']));
    // What is not compared with the community is compared with the habits all the same.
    expect(rowOf(analysis, 'kda').personal).not.toBeNull();
  });

  it('reports the all-ranks fallback', async () => {
    // The tier is too small to compare with, every rank is not.
    const context = await setUp(withSampleSizes({ tier: 50, all: 2_422 }));
    const matchId = pick(context, (candidate) => ownBadgeOf(candidate) !== null, 'a ranked match');

    const analysis = await analyseWithCommunity(context, matchId);

    expect(analysis.community).toEqual({
      kind: 'available',
      used: { rank: { kind: 'all' }, window: durationWindowOf(durationOf(matchId)) },
      fallback: true,
      stale: false,
      sampleMatches: 2_422,
    });
    // The comparison is made all the same, with the cohort that is used.
    expect(rowOf(analysis, 'kda').community.kind).toBe('percentile');
  });

  it('reports a community that is too small even over every rank as unavailable', async () => {
    const context = await setUp(withSampleSizes({ tier: 50, all: 80 }));
    const matchId = context.archived[0] ?? expect.unreachable();

    const analysis = await analyseWithCommunity(context, matchId);

    expect(analysis.community).toEqual({ kind: 'unavailable' });
    expect(new Set(rowsOf(analysis).map((row) => row.community.kind))).toEqual(
      new Set(['missing', 'none']),
    );
  });

  it('marks community data of a day or more as stale', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    await analyseWithCommunity(context, matchId);

    context.clock.now += DAY_MS;
    const analysis = ready(await context.analysis.getMatchAnalysis(matchId));

    // Stale data is still used.
    expect(analysis.community).toMatchObject({ kind: 'available', stale: true });
    expect(rowOf(analysis, 'kda').community.kind).toBe('percentile');
  });

  it('places a count among the community values rounded to whole numbers', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    // The community deaths are 0, 0, 1.01, 1.99, 4.02, 5.99, 7.93, 8.94 and 10.9: rounded, the
    // median is 4, and a player with 4 deaths is exactly at the median.
    await overrideValues(context, matchId, { deaths: 4 });

    const analysis = await analyseWithCommunity(context, matchId);

    expect(rowOf(analysis, 'deaths').community).toEqual({ kind: 'percentile', percentile: 50 });
  });

  it('never returns NaN or Infinity', async () => {
    const context = await setUp();
    const views: MatchAnalysisView[] = [];
    // Without the community data, then with it.
    for (const matchId of context.archived) {
      views.push(await context.analysis.getMatchAnalysis(matchId));
    }
    for (const matchId of context.archived) {
      views.push({ kind: 'ready', analysis: await analyseWithCommunity(context, matchId) });
    }
    // Matches that are said to last no time at all: every figure per minute divides by a length of
    // at least a second.
    for (const matchId of context.archived) {
      await setHistoryDuration(context, matchId, 0);
    }
    for (const matchId of context.archived) {
      views.push(await context.analysis.getMatchAnalysis(matchId));
    }

    expect(views.every((view) => view.kind === 'ready')).toBe(true);
    const numbers = views.flatMap((view) => numbersIn(view));
    // The walk saw the views.
    expect(numbers.length).toBeGreaterThan(1_000);
    expect(numbers.filter((number) => !Number.isFinite(number))).toEqual([]);
  });

  it('is not analysed without an account, and for a match that is not archived', async () => {
    const context = await setUp();
    const newest = context.archived[0] ?? expect.unreachable();
    await context.details.resetToPending(ACCOUNT, newest);

    await expect(context.analysis.getMatchAnalysis(newest)).resolves.toEqual({
      kind: 'not_analysed',
    });
    await expect(context.analysis.getMatchAnalysis(testMatchId(100_000_001))).resolves.toEqual({
      kind: 'not_analysed',
    });
    const { services, http } = createTestServices({ accountId: null });
    await expect(services.analysis.getMatchAnalysis(newest)).resolves.toEqual({
      kind: 'not_analysed',
    });
    expect(http.requests).toEqual([]);
  });

  it('is not analysed when the archive is gone', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    // Delete the file of the archive, as someone emptying the folder would, and keep the others.
    const kept = [...context.archiveStore.files].filter(
      ([path]) => path !== archivePath(ACCOUNT, matchId),
    );
    await context.archiveStore.removeEntry(accountFolderName(ACCOUNT));
    for (const [path, bytes] of kept) {
      context.archiveStore.addFile(path, bytes);
    }

    await expect(context.analysis.getMatchAnalysis(matchId)).resolves.toEqual({
      kind: 'not_analysed',
    });
  });

  it('is failed when the archive no longer holds what the analysis needs, and says so once', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    // The tracked player has lost their souls: the analysis cannot read the match.
    await editArchive(context, matchId, (_, tracked) => {
      delete tracked.net_worth;
    });

    await expect(context.analysis.getMatchAnalysis(matchId)).resolves.toEqual({ kind: 'failed' });
    await expect(context.analysis.getMatchAnalysis(matchId)).resolves.toEqual({ kind: 'failed' });

    // One warning with the match and the place and the kind of the problem, never a value.
    expect(context.logger.entries.filter((entry) => entry.scope === LOG_SCOPE)).toEqual([
      {
        level: 'warn',
        scope: LOG_SCOPE,
        message: 'Match could not be analysed',
        context: {
          matchId,
          issue: expect.stringMatching(/^players\.\d+\.net_worth: \w+$/) as unknown,
        },
      },
    ]);
    expect(JSON.stringify(context.logger.entries)).not.toContain(String(ACCOUNT));
  });

  it('rejects with the error of the disk when the archive cannot be read', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    vi.spyOn(context.archiveStore, 'read').mockRejectedValue(new Error('Access is denied'));

    await expect(context.analysis.getMatchAnalysis(matchId)).rejects.toMatchObject({
      kind: 'storage',
    });
  });

  it('rejects with the error of the database when the community cache cannot be read', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    vi.spyOn(BenchmarkService.prototype, 'read').mockRejectedValue(
      new AppError('storage', 'Could not read the community data'),
    );

    await expect(context.analysis.getMatchAnalysis(matchId)).rejects.toMatchObject({
      kind: 'storage',
    });
  });

  it('rejects with the error of the database when the rank cannot be read', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    vi.spyOn(LinkedAccountRepository.prototype, 'getRank').mockRejectedValue(
      new AppError('storage', 'Could not read the rank'),
    );

    await expect(context.analysis.getMatchAnalysis(matchId)).rejects.toMatchObject({
      kind: 'storage',
    });
  });
});

describe('AnalysisService.refreshCommunity', () => {
  it('refreshCommunity downloads once', async () => {
    const context = await setUp();
    const matchId = pick(context, (candidate) => ownBadgeOf(candidate) !== null, 'a ranked match');

    await expect(context.analysis.refreshCommunity(matchId)).resolves.toBe('updated');

    expect(communityPaths(context)).toEqual([HERO_STATS_PATH, BENCHMARK_PATH, CURVE_PATH]);
    // The request asks for the badge range of the tier the match is compared with, and its window.
    const tier = expectedTierOf(matchId);
    const window = durationWindowOf(durationOf(matchId));
    const [sizeRequest = expect.unreachable('the cohort is sized first')] =
      communityRequests(context);
    expect(Object.fromEntries(new URL(sizeRequest.url).searchParams)).toMatchObject({
      min_average_badge: String(tier * 10 + 1),
      max_average_badge: String(tier * 10 + 6),
      min_duration_s: String(window.minS),
      max_duration_s: String(window.maxS),
    });
    // The second call, and the analysis, find the data in the cache.
    await expect(context.analysis.refreshCommunity(matchId)).resolves.toBe('fresh');
    ready(await context.analysis.getMatchAnalysis(matchId));
    expect(communityPaths(context)).toHaveLength(3);
    // The community requests carry the hero, the period, the window and the badge range, and no
    // account id.
    expect(
      communityRequests(context)
        .map((candidate) => candidate.url)
        .join(),
    ).not.toContain(String(ACCOUNT));
  });

  it('asks for nothing when there is no projection to compare', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    const projection =
      (await context.metrics.getProjection(ACCOUNT, matchId)) ?? expect.unreachable();

    // Not projected, projected by another version, failed: the page has nothing to show yet.
    await context.metrics.deleteAccount(ACCOUNT);
    await expect(context.analysis.refreshCommunity(matchId)).resolves.toBe('fresh');
    await context.metrics.saveProjection(
      ACCOUNT,
      matchId,
      { ...projection, version: PROJECTION_VERSION - 1 },
      new Map(),
    );
    await expect(context.analysis.refreshCommunity(matchId)).resolves.toBe('fresh');
    await context.metrics.saveProjection(
      ACCOUNT,
      matchId,
      { ...projection, failed: true },
      new Map(),
    );
    await expect(context.analysis.refreshCommunity(matchId)).resolves.toBe('fresh');
    const { services, http } = createTestServices({ accountId: null });
    await expect(services.analysis.refreshCommunity(matchId)).resolves.toBe('fresh');

    expect(communityPaths(context)).toEqual([]);
    expect(http.requests).toEqual([]);
  });

  it('asks for nothing for a match whose detail is not archived', async () => {
    const context = await setUp();
    const matchId = context.archived[0] ?? expect.unreachable();
    // The match keeps its projection, but its detail goes back to the queue: it cannot be analysed,
    // so nothing is downloaded for it.
    await context.details.resetToPending(ACCOUNT, matchId);

    await expect(context.analysis.refreshCommunity(matchId)).resolves.toBe('fresh');
    await expect(context.analysis.refreshCommunity(testMatchId(100_000_001))).resolves.toBe(
      'fresh',
    );

    expect(communityPaths(context)).toEqual([]);
  });
});

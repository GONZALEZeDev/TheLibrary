/**
 * Tests of the projection (`ProjectionService.catchUp` and `ProjectionService.projectMatch`, and the
 * order they run in), end to end on the development adapters: the archives are written by the real
 * detail queue, during a synchronisation of the synthetic history, and the metrics are stored in an
 * in-memory database with the real migrations. The synchronisation projects what it archives; the
 * tests forget those projections and start from archived matches that are not projected.
 *
 * The synthetic history holds Paige matches the API has a detail for, ranked and unranked ones. A
 * test that needs an archive the projection cannot analyse (or one that lacks some statistics)
 * edits the archive the queue wrote, which keeps the match recorded as archived, exactly like a
 * file the app wrote with an older version would be.
 *
 * What a projection stores is the metrics of the registry, the damage sources of the match (the
 * damage of each source, of each item owned, the unlock time of each ability) and its review values
 * (the deaths of each phase, the first purchase of each shop item, the places on the scoreboard).
 * The synthetic matches hold a damage matrix, items, death details and a scoreboard, so every
 * archived match stores keys of each family: the tests derive how many from the archive itself,
 * they do not hard-code it.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi } from '../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
} from '../adapters/dev/fixtures/match-history.fixture';
import { fixtureTrackedBadge } from '../adapters/dev/fixtures/match-metadata.fixture';
import { MemoryLogger, type LogEntry } from '../adapters/dev/memory-logger.adapter';
import * as damageMatrixReader from '../core/analysis/damage-matrix';
import { DAMAGE_KEY_PREFIXES, projectDamageSources } from '../core/analysis/damage-sources';
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import { buildMatchContext } from '../core/analysis/match-context';
import { accuracyMetric } from '../core/analysis/metrics/accuracy.metric';
import { kdaMetric } from '../core/analysis/metrics/kda.metric';
import { projectMetrics, PROJECTION_VERSION } from '../core/analysis/registry';
import {
  projectReviewValues,
  REVIEW_KEY_PREFIXES,
  VALVE_RANK_KEY,
} from '../core/analysis/review/review-values';
import type { MatchId } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import type { ArchiveEnvelope } from '../core/match-detail/archive-envelope';
import { accountFolderName, archivePath } from '../core/match-detail/archive-layout';
import * as scoreboardReader from '../core/match-detail/scoreboard';
import * as trackedDeathsReader from '../core/match-detail/tracked-deaths';
import * as trackedItemsReader from '../core/match-detail/tracked-items';
import type { LogContext, LogLevel } from '../ports/logger.port';
import { createTestServices } from '../test/create-test-services';
import { DirectCompressor } from '../test/direct-compressor';
import { testMatchId } from '../test/test-data';
import { ArchiveReaderService } from './archive-reader.service';
import { MatchDetailRepository } from './match-detail.repository';
import { MetricsRepository } from './metrics.repository';
import { ProjectionService, type ProjectionReport } from './projection.service';

/** The time of the synchronisation that archives the matches (Unix ms); the history ends before. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/** The time the projection starts at (Unix ms), on the clock the tests control. */
const PROJECTION_START = Date.UTC(2026, 9, 14, 13, 0, 0);

/** How far the clock moves at each yield to the event loop, in milliseconds. */
const YIELD_STEP_MS = 250;

/** The tracked account: the one of the synthetic history. */
const ACCOUNT = FIXTURE_ACCOUNT_ID;

/** The id of the run, as the synchronisation gives it. */
const RUN = 'run-0001';

/** An account id that appears in every synthetic match detail, as one of the other players. */
const FAKE_OTHER_PLAYER = '2000001';

/** How many values the metrics of a projection make: the 24 metrics and the 12 community windows. */
const METRIC_VALUE_COUNT = 36;

/**
 * The last version of the projection that stored no damage source: the projections an older
 * release of the app left on the disk.
 */
const VERSION_BEFORE_DAMAGE_SOURCES = 1;

/**
 * The last version of the projection that stored no review value: the projections the release
 * before them left on the disk, which hold the metrics and the damage sources.
 */
const VERSION_BEFORE_REVIEW_VALUES = 2;

/** The `issue` of a damage matrix whose grid of samples goes back, whatever the code of the check. */
const BROKEN_MATRIX_ISSUE = /^damage_matrix\.sample_time_s: \w+$/;

/** The `issue` of a scoreboard whose match lacks its winning team, whatever the code of the check. */
const BROKEN_SCOREBOARD_ISSUE = /^match_info\.winning_team: \w+$/;

/** The `issue` of a player whose items are not a list, whatever the code of the check. */
const BROKEN_ITEMS_ISSUE = /^players\.\d+\.items: \w+$/;

/** The match mode of a ranked match, the only one in which the player has a badge. */
const RANKED_MODE = 4;

/** How many matches in a row may fail before the run stops. */
const FAILURES_IN_A_ROW = 3;

/** What a run that did nothing reports. */
const NOTHING: ProjectionReport = {
  projected: 0,
  failed: 0,
  reset: 0,
  skipped: 0,
  stoppedBy: null,
};

/** How many matches the synthetic history holds by default; about 40 % of them are Paige matches. */
const MATCH_COUNT = 30;

/**
 * How many matches the synthetic history holds for the tests of the projection on demand, which
 * need more archived matches than the window of the habits: about 40 % of them are Paige matches.
 */
const LONG_MATCH_COUNT = 90;

/**
 * The synthetic history the synchronisation saves, most recent first. The history is generated in
 * order, so the shorter ones are the start of this one.
 */
const HISTORY = createMatchHistoryFixture({ now: START, count: LONG_MATCH_COUNT });

/** The part of a player of an archive that the tests edit. */
interface EditablePlayer {
  account_id: number;
  net_worth?: number;
  deaths: number;
  abandon_match_time_s?: number;
  player_rank_data?: { initial_display_rank?: number } | null;
  stats?: Record<string, unknown>[];
  items?: unknown;
  death_details?: Record<string, unknown>[];
}

/** The part of the damage matrix of an archive that the tests edit. */
interface EditableDamageMatrix {
  sample_time_s: number[];
}

/** The part of the `match_info` of an archive that the tests edit. */
interface EditableMatchInfo {
  winning_team?: number;
  players: EditablePlayer[];
  damage_matrix?: EditableDamageMatrix;
}

/** The part of an archive file that the tests edit. */
interface EditableEnvelope {
  payload: { match_info: EditableMatchInfo };
}

/** What a test may edit in an archive. */
interface EditableMatch {
  /** The tracked player. */
  readonly tracked: EditablePlayer;
  /** Another player of the match. */
  readonly other: EditablePlayer;
  /** The match itself: its players, and its damage matrix when it has one. */
  readonly matchInfo: EditableMatchInfo;
}

/**
 * Archive the matches of the synthetic history and build the projection like the app does, on the
 * development adapters, with no match projected. The projection reads through its own logger and a
 * clock the test controls: every yield to the event loop moves it forward.
 *
 * @param matchCount - How many matches the synthetic history holds.
 * @returns The service, the archives it works on and everything a test may inspect or break.
 */
async function setUp(matchCount = MATCH_COUNT) {
  const compressor = new DirectCompressor();
  const { services, database, archiveStore } = createTestServices({
    handler: createFixtureApi({ now: START, matchCount }),
    now: () => START,
    compressor,
  });
  // The queue archives the details of the Paige matches, as it does in the app.
  await services.sync.syncNow('startup');

  const clock = { now: PROJECTION_START };
  const yieldToEventLoop = vi.fn((): Promise<void> => {
    clock.now += YIELD_STEP_MS;
    return Promise.resolve();
  });
  const logger = new MemoryLogger();
  const reader = new ArchiveReaderService({ archive: archiveStore, compressor, logger });
  const metrics = new MetricsRepository(database);
  const details = new MatchDetailRepository(database);
  const service = new ProjectionService({
    reader,
    metrics,
    details,
    logger,
    now: () => clock.now,
    yieldToEventLoop,
  });
  // The synchronisation analyses the matches it archives: forget its projections, so that every
  // archived match is to project, as after a new version. The matches the projection has to work on
  // are the archived ones, most recent first.
  await metrics.deleteAccount(ACCOUNT);
  const archived = await metrics.listToProject(ACCOUNT, PROJECTION_VERSION);
  expect(archived.length, 'the history holds several archived matches').toBeGreaterThanOrEqual(6);
  return {
    service,
    reader,
    metrics,
    details,
    logger,
    archiveStore,
    compressor,
    yieldToEventLoop,
    archived,
  };
}

/** Everything {@link setUp} builds. */
type TestContext = Awaited<ReturnType<typeof setUp>>;

/**
 * The badge the tracked player had in a match of the synthetic history.
 *
 * @param matchId - The match.
 * @returns The badge of a ranked match, `null` for an unranked one.
 */
function expectedBadge(matchId: MatchId): number | null {
  const row = HISTORY.find((candidate) => candidate.match_id === matchId);
  return row?.match_mode === RANKED_MODE ? fixtureTrackedBadge(matchId) : null;
}

/**
 * Read the archive of a match, as it is on the disk now (edited or not).
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The decoded archive.
 */
async function envelopeOf(context: TestContext, matchId: MatchId): Promise<ArchiveEnvelope> {
  const read = await context.reader.readArchive(ACCOUNT, matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  return read.envelope;
}

/**
 * The values the metrics of the registry give for the archive of a match.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The values by key: {@link METRIC_VALUE_COUNT} of them.
 */
async function metricValuesOf(context: TestContext, matchId: MatchId) {
  return projectMetrics(buildMatchContext(await envelopeOf(context, matchId)));
}

/**
 * The damage-source values the archive of a match gives, which a projection must store next to the
 * metrics.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match; its damage matrix must be readable, or absent.
 * @returns The values by key; none for a match with no damage matrix.
 */
async function damageValuesOf(
  context: TestContext,
  matchId: MatchId,
): Promise<ReadonlyMap<string, number>> {
  const read = damageMatrixReader.readDamageMatrix(await envelopeOf(context, matchId));
  return read === null ? new Map() : projectDamageSources(read);
}

/**
 * The review values the archive of a match gives, which a projection must store next to the
 * metrics.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match; its death details, items and scoreboard must be readable, or absent.
 * @returns The values by key; the deaths are left out when the death details are incomplete.
 */
async function reviewValuesOf(
  context: TestContext,
  matchId: MatchId,
): Promise<ReadonlyMap<string, number>> {
  const envelope = await envelopeOf(context, matchId);
  return projectReviewValues({
    durationS: buildMatchContext(envelope).durationS,
    deathTimesS: trackedDeathsReader.readTrackedDeathTimes(envelope),
    items: trackedItemsReader.readTrackedItems(envelope),
    scoreboard: scoreboardReader.readScoreboard(envelope),
  });
}

/**
 * Whether a key is one of the review values: it starts with the prefix of a family, or is the key
 * of Valve's top three.
 *
 * @param key - A stored key.
 * @returns `true` for a review key.
 */
function isReviewKey(key: string): boolean {
  return key === VALVE_RANK_KEY || REVIEW_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Whether a key is one of the places of the player on the scoreboard, or the key of Valve's top
 * three, which the scoreboard gives.
 *
 * @param key - A stored key.
 * @returns `true` for a key that needs the scoreboard.
 */
function isPlaceKey(key: string): boolean {
  return key.startsWith('scoreboard_place') || key === VALVE_RANK_KEY;
}

/**
 * Whether a key is one of the purchases of the shop items, or of the deaths before them, which the
 * items give.
 *
 * @param key - A stored key.
 * @returns `true` for a key that needs the items.
 */
function isItemKey(key: string): boolean {
  return key.startsWith('item_bought_at.') || key.startsWith('deaths_before_item.');
}

/**
 * The review values a projection stored for a match.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The stored values by key, the review ones only.
 */
async function storedReviewValuesOf(context: TestContext, matchId: MatchId) {
  const values = await context.metrics.getValues(ACCOUNT, matchId);
  return new Map([...values].filter(([key]) => isReviewKey(key)));
}

/**
 * Check that every key stored for a match is a metric of the registry (or its community window), a
 * damage source or a review value, so that a family of keys nobody checks cannot slip in.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param values - What is stored for the match.
 */
async function expectOnlyKnownKeys(
  context: TestContext,
  matchId: MatchId,
  values: ReadonlyMap<string, number | null>,
): Promise<void> {
  const metricKeys = new Set((await metricValuesOf(context, matchId)).keys());
  const unknown = [...values.keys()].filter(
    (key) =>
      !metricKeys.has(key) &&
      !isReviewKey(key) &&
      !DAMAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  expect(unknown, String(matchId)).toEqual([]);
}

/**
 * What a projection must store for the archive of a match when it has no damage matrix: the values
 * of the metrics, then the review values.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The values by key.
 */
async function projectedValuesWithoutDamageOf(context: TestContext, matchId: MatchId) {
  return new Map([
    ...(await metricValuesOf(context, matchId)),
    ...(await reviewValuesOf(context, matchId)),
  ]);
}

/**
 * Everything a projection must store for the archive of a match: the values of the metrics, then
 * the damage sources, then the review values.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The values by key.
 */
async function projectedValuesOf(context: TestContext, matchId: MatchId) {
  return new Map([
    ...(await metricValuesOf(context, matchId)),
    ...(await damageValuesOf(context, matchId)),
    ...(await reviewValuesOf(context, matchId)),
  ]);
}

/**
 * How many values a projection of a match stores: the metrics, and as many damage and review
 * values as the archive gives. Derived from the archive, so that the fixture can change without
 * the tests.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The number of values.
 */
async function expectedValueCount(context: TestContext, matchId: MatchId): Promise<number> {
  return (
    METRIC_VALUE_COUNT +
    (await damageValuesOf(context, matchId)).size +
    (await reviewValuesOf(context, matchId)).size
  );
}

/**
 * Edit the archive the queue wrote for a match: the tracked player, another one and the match
 * itself are edited, and the file is written again. The match stays recorded as archived.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param edit - Edits the archive.
 */
async function editArchive(
  context: TestContext,
  matchId: MatchId,
  edit: (match: EditableMatch) => void,
): Promise<void> {
  const envelope = JSON.parse(
    JSON.stringify(await envelopeOf(context, matchId)),
  ) as EditableEnvelope;
  const matchInfo = envelope.payload.match_info;
  edit({
    tracked:
      matchInfo.players.find((player) => player.account_id === ACCOUNT) ??
      expect.unreachable('the tracked player is in the match'),
    other:
      matchInfo.players.find((player) => player.account_id !== ACCOUNT) ??
      expect.unreachable('another player is in the match'),
    matchInfo,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await context.archiveStore.write(ACCOUNT, matchId, await context.compressor.compress(bytes));
}

/**
 * Break the damage matrix of an archive the way the analysis cannot read: the grid of samples goes
 * back in time. The rest of the archive stays valid, so the match is still analysable.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match, which must have a damage matrix.
 */
async function breakDamageMatrix(context: TestContext, matchId: MatchId): Promise<void> {
  await editArchive(context, matchId, ({ matchInfo }) => {
    const matrix = matchInfo.damage_matrix ?? expect.unreachable('the match has a damage matrix');
    matrix.sample_time_s = [360, 180];
  });
}

/**
 * Break the scoreboard of an archive the way it cannot be read: the match no longer tells which
 * team won. The rest of the archive stays valid, so the match is still analysable, and its deaths
 * and items can still be read.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 */
async function breakScoreboard(context: TestContext, matchId: MatchId): Promise<void> {
  await editArchive(context, matchId, ({ matchInfo }) => {
    delete matchInfo.winning_team;
  });
}

/**
 * Delete the file of an archive, as someone emptying the folder would, and leave the others.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match whose file goes.
 */
async function deleteArchive(context: TestContext, matchId: MatchId): Promise<void> {
  const kept = [...context.archiveStore.files].filter(
    ([path]) => path !== archivePath(ACCOUNT, matchId),
  );
  await context.archiveStore.removeEntry(accountFolderName(ACCOUNT));
  for (const [path, bytes] of kept) {
    context.archiveStore.addFile(path, bytes);
  }
}

/**
 * Make the disk refuse to read the archives of some matches, and read the others as usual.
 *
 * @param context - What {@link setUp} built.
 * @param failing - The matches whose file cannot be read.
 * @returns The spy on the read of the archives, to restore the disk with.
 */
function failReadsOf(context: TestContext, failing: readonly MatchId[]) {
  const read = context.archiveStore.read.bind(context.archiveStore);
  return vi
    .spyOn(context.archiveStore, 'read')
    .mockImplementation((accountId, matchId) =>
      failing.includes(matchId)
        ? Promise.reject(
            new Error(
              `Access is denied to archive/${String(accountId)}/${String(matchId)}.json.zst`,
            ),
          )
        : read(accountId, matchId),
    );
}

/**
 * The lines of a log with a message.
 *
 * @param logger - The logger the projection wrote to.
 * @param message - The message of the lines.
 * @returns The lines, oldest first.
 */
function linesOf(logger: MemoryLogger, message: string): LogEntry[] {
  return logger.entries.filter((entry) => entry.message === message);
}

/**
 * Check that nothing in a log can be traced to the tracked account.
 *
 * @param logger - The logger the projection wrote to.
 */
function expectNoAccountId(logger: MemoryLogger): void {
  expect(JSON.stringify(logger.entries)).not.toContain(String(ACCOUNT));
}

/**
 * A gate: whoever awaits `opened` waits until the test calls `open`.
 *
 * @returns The promise and the function that settles it.
 */
function createGate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * Let the pending work of the other promises run (a macrotask later), so that whatever could start
 * or settle by itself has done so.
 *
 * @returns A promise resolved after a timer of 0 ms.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ProjectionService.catchUp', () => {
  it('projects every ready match once', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([]);
    // The matches are projected most recent first, and each one is stored as the registry projects
    // it, with the damage sources of its archive.
    for (const [index, matchId] of archived.entries()) {
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toMatchObject({
        matchId,
        version: PROJECTION_VERSION,
        playerBadge: expectedBadge(matchId),
        hasLeaver: false,
        failed: false,
        projectedAt: PROJECTION_START + index * YIELD_STEP_MS,
      });
      const values = await metrics.getValues(ACCOUNT, matchId);
      expect(values.size).toBe(await expectedValueCount(context, matchId));
      expect(values).toEqual(await projectedValuesOf(context, matchId));
    }
    // The synthetic history has ranked and unranked matches: both ways to get a badge are covered.
    expect(archived.map(expectedBadge)).toContain(null);
    expect(archived.map(expectedBadge).some((badge) => badge !== null)).toBe(true);
    // A clean run says what it did in one line, and nothing else but the reader's silence.
    expect(logger.entries).toEqual([
      {
        level: 'info',
        scope: 'projection',
        message: 'Projection done',
        context: {
          syncRunId: RUN,
          projected: archived.length,
          failed: 0,
          reset: 0,
          skipped: 0,
          // One yield between two matches, and each one moved the clock.
          durationMs: (archived.length - 1) * YIELD_STEP_MS,
        },
      },
    ]);
    expectNoAccountId(logger);
  });

  it('projects nothing the second time, and says so at the debug level', async () => {
    const { service, metrics, logger, archived } = await setUp();
    await service.catchUp(ACCOUNT, RUN);
    const stored = await metrics.getProjection(ACCOUNT, archived[0] ?? expect.unreachable());
    logger.entries.length = 0;

    const report = await service.catchUp(ACCOUNT, 'run-0002');

    expect(report).toEqual(NOTHING);
    // The projections of the first run are untouched.
    await expect(
      metrics.getProjection(ACCOUNT, archived[0] ?? expect.unreachable()),
    ).resolves.toEqual(stored);
    expect(logger.entries).toEqual([
      {
        level: 'debug',
        scope: 'projection',
        message: 'Projection done',
        context: {
          syncRunId: 'run-0002',
          projected: 0,
          failed: 0,
          reset: 0,
          skipped: 0,
          durationMs: 0,
        },
      },
    ]);
  });

  it('a version bump re-projects every match', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    // The state an older version of the app left: a projection of version 0, with one stale value.
    for (const matchId of archived) {
      await metrics.saveProjection(
        ACCOUNT,
        matchId,
        {
          version: PROJECTION_VERSION - 1,
          playerBadge: null,
          hasLeaver: true,
          failed: false,
          projectedAt: 1,
        },
        new Map([['stale_metric', 1]]),
      );
    }
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual(archived);

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([]);
    for (const matchId of archived) {
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toMatchObject({
        version: PROJECTION_VERSION,
        // Nothing of the old projection is kept: not its flags, not its values.
        hasLeaver: false,
        playerBadge: expectedBadge(matchId),
      });
      const values = await metrics.getValues(ACCOUNT, matchId);
      expect(values.has('stale_metric')).toBe(false);
      expect(values).toEqual(await projectedValuesOf(context, matchId));
    }
    expect(linesOf(logger, 'Projection done')).toHaveLength(1);
  });

  it.each([
    {
      bump: 'the version 2 bump, which added the damage sources',
      // The state the release before it left: the metrics of each match and no damage source.
      version: VERSION_BEFORE_DAMAGE_SOURCES,
      stored: (
        context: TestContext,
        matchId: MatchId,
      ): Promise<ReadonlyMap<string, number | null>> => metricValuesOf(context, matchId),
    },
    {
      bump: 'the version 3 bump, which added the review values',
      // The state the release before it left: the metrics and the damage sources of each match.
      version: VERSION_BEFORE_REVIEW_VALUES,
      stored: async (
        context: TestContext,
        matchId: MatchId,
      ): Promise<ReadonlyMap<string, number | null>> =>
        new Map([
          ...(await metricValuesOf(context, matchId)),
          ...(await damageValuesOf(context, matchId)),
        ]),
    },
  ])('projects every archived match again after $bump', async ({ version, stored }) => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    // Each match is stored with the version of the release before the bump.
    for (const matchId of archived) {
      await metrics.saveProjection(
        ACCOUNT,
        matchId,
        {
          version,
          playerBadge: expectedBadge(matchId),
          hasLeaver: false,
          failed: false,
          projectedAt: 1,
        },
        await stored(context, matchId),
      );
    }
    // The bump is what makes them to project: those projections are not of the current version.
    expect(PROJECTION_VERSION).toBeGreaterThan(version);
    await expect(metrics.listToProject(ACCOUNT, version)).resolves.toEqual([]);
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual(archived);

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([]);
    for (const matchId of archived) {
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toMatchObject({
        version: PROJECTION_VERSION,
        failed: false,
      });
      // The values of the old version are gone with it; the ones it lacked, the review values among
      // them, are there.
      const values = await metrics.getValues(ACCOUNT, matchId);
      expect(values.size).toBeGreaterThan((await stored(context, matchId)).size);
      expect((await reviewValuesOf(context, matchId)).size, String(matchId)).toBeGreaterThan(0);
      expect(values).toEqual(await projectedValuesOf(context, matchId));
    }
    // The archives were on the disk already: the bump costs no download, only one line of the run.
    expect(linesOf(logger, 'Projection done')).toHaveLength(1);
  });

  it('stores the damage sources with the metrics', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;

    await service.catchUp(ACCOUNT, RUN);

    const damageKeys: string[] = [];
    for (const matchId of archived) {
      const values = await metrics.getValues(ACCOUNT, matchId);
      const damage = await damageValuesOf(context, matchId);
      // The synthetic matches hold a damage matrix and items: each one gives damage values.
      expect(damage.size, String(matchId)).toBeGreaterThan(0);
      expect(values.size, String(matchId)).toBe(await expectedValueCount(context, matchId));
      // The metrics are what they were, key by key (the unknown ones stay unknown)…
      for (const [key, value] of await metricValuesOf(context, matchId)) {
        expect(values.get(key), key).toEqual(value);
      }
      // …and the damage sources are stored as the archive gives them, next to them.
      for (const [key, value] of damage) {
        expect(values.get(key), key).toBe(value);
        damageKeys.push(key);
      }
      // No other key: whatever is not a metric is a damage value or a review value.
      const stored = [...values.keys()].filter((key) =>
        DAMAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
      );
      expect(new Set(stored)).toEqual(new Set(damage.keys()));
      await expectOnlyKnownKeys(context, matchId, values);
    }
    // The three families of keys are stored: the damage of the sources, of the items, the unlocks.
    for (const prefix of DAMAGE_KEY_PREFIXES) {
      expect(
        damageKeys.some((key) => key.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    // A damage matrix that is read is no news: nothing is logged about it.
    expect(linesOf(logger, 'Damage sources not read')).toEqual([]);
    expect(linesOf(logger, 'Metric not computed')).toEqual([]);
  });

  it('stores the review values with the metrics', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;

    await service.catchUp(ACCOUNT, RUN);

    const reviewKeys: string[] = [];
    for (const matchId of archived) {
      const values = await metrics.getValues(ACCOUNT, matchId);
      const review = await reviewValuesOf(context, matchId);
      // The synthetic matches hold death details, items and a scoreboard: each one gives review
      // values.
      expect(review.size, String(matchId)).toBeGreaterThan(0);
      expect(values.size, String(matchId)).toBe(await expectedValueCount(context, matchId));
      // The metrics are what they were, key by key…
      for (const [key, value] of await metricValuesOf(context, matchId)) {
        expect(values.get(key), key).toEqual(value);
      }
      // …and the review values are stored as the archive gives them, next to them.
      for (const [key, value] of review) {
        expect(values.get(key), key).toBe(value);
        reviewKeys.push(key);
      }
      // No other review key, and no other key at all.
      const stored = [...values.keys()].filter(isReviewKey);
      expect(new Set(stored)).toEqual(new Set(review.keys()));
      await expectOnlyKnownKeys(context, matchId, values);
    }
    // Every family of keys is stored by some match: the five prefixes, and Valve's top three.
    for (const prefix of REVIEW_KEY_PREFIXES) {
      expect(
        reviewKeys.some((key) => key.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    expect(reviewKeys).toContain(VALVE_RANK_KEY);
    // Values that are read are no news: nothing is logged about them.
    expect(linesOf(logger, 'Review values not read')).toEqual([]);
    expect(linesOf(logger, 'Metric not computed')).toEqual([]);
  });

  it('projects a match without a damage matrix', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const bare = archived[1] ?? expect.unreachable('the history holds several archived matches');
    // The detail of some matches comes without a damage matrix.
    await editArchive(context, bare, ({ matchInfo }) => {
      delete matchInfo.damage_matrix;
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    // The match is projected like any other, with its metrics and its review values and no damage
    // key at all: its items alone say nothing about the damage.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.getProjection(ACCOUNT, bare)).resolves.toMatchObject({
      failed: false,
      version: PROJECTION_VERSION,
    });
    const values = await metrics.getValues(ACCOUNT, bare);
    expect(values.size).toBe(METRIC_VALUE_COUNT + (await reviewValuesOf(context, bare)).size);
    expect(values).toEqual(await projectedValuesWithoutDamageOf(context, bare));
    // The others keep their damage sources.
    const other = archived[0] ?? expect.unreachable();
    expect((await metrics.getValues(ACCOUNT, other)).size).toBe(
      await expectedValueCount(context, other),
    );
    expect((await metrics.getValues(ACCOUNT, other)).size).toBeGreaterThan(METRIC_VALUE_COUNT);
    // A match with no matrix is not a problem: nothing is logged about it.
    expect(linesOf(logger, 'Damage sources not read')).toEqual([]);
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([]);
  });

  it('keeps the metrics of a match whose damage matrix cannot be read', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const broken = archived[1] ?? expect.unreachable('the history holds several archived matches');
    await breakDamageMatrix(context, broken);

    const report = await service.catchUp(ACCOUNT, RUN);

    // The match is projected, not failed and not skipped: its metrics do not depend on the matrix.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.getProjection(ACCOUNT, broken)).resolves.toMatchObject({
      version: PROJECTION_VERSION,
      failed: false,
      playerBadge: expectedBadge(broken),
    });
    const values = await metrics.getValues(ACCOUNT, broken);
    expect(values.size).toBe(METRIC_VALUE_COUNT + (await reviewValuesOf(context, broken)).size);
    expect(values).toEqual(await projectedValuesWithoutDamageOf(context, broken));
    // The matches around it are not affected.
    const other = archived[0] ?? expect.unreachable();
    expect(await metrics.getValues(ACCOUNT, other)).toEqual(
      await projectedValuesOf(context, other),
    );
    // One line at the info level, with the match and the place and the code of the problem, never a
    // value of the archive.
    expect(linesOf(logger, 'Damage sources not read')).toEqual([
      {
        level: 'info',
        scope: 'projection',
        message: 'Damage sources not read',
        context: {
          syncRunId: RUN,
          matchId: broken,
          issue: expect.stringMatching(BROKEN_MATRIX_ISSUE) as unknown,
        },
      },
    ]);
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([]);
    expect(linesOf(logger, 'Match not projected')).toEqual([]);
    expect(JSON.stringify(logger.entries)).not.toContain(FAKE_OTHER_PLAYER);
    expectNoAccountId(logger);
    // The verdict is on the damage sources only: the match is not tried again.
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([]);
  });

  it('tells a damage matrix that cannot be read once per run', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const [, first, second] = archived;
    await breakDamageMatrix(context, first ?? expect.unreachable());
    await breakDamageMatrix(context, second ?? expect.unreachable());

    const report = await service.catchUp(ACCOUNT, RUN);

    // Both matches are projected, and the run tells about the first one only: a matrix that cannot
    // be read is a change of the payload, which hits most matches, so a line for each would flood.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    expect(linesOf(logger, 'Damage sources not read')).toMatchObject([
      { level: 'info', context: { syncRunId: RUN, matchId: first } },
    ]);
    for (const matchId of [first, second]) {
      const stored = matchId ?? expect.unreachable();
      expect((await metrics.getValues(ACCOUNT, stored)).size).toBe(
        METRIC_VALUE_COUNT + (await reviewValuesOf(context, stored)).size,
      );
    }

    // The next run tells again: it does not know what an earlier run said.
    logger.entries.length = 0;
    await metrics.deleteAccount(ACCOUNT);
    await service.catchUp(ACCOUNT, 'run-0002');
    expect(linesOf(logger, 'Damage sources not read')).toMatchObject([
      { context: { syncRunId: 'run-0002', matchId: first } },
    ]);
  });

  it('does not let the line about a damage matrix that cannot be read stop the projection', async () => {
    const context = await setUp();
    const { reader, metrics, details, archived } = context;
    /** A logger that breaks the contract of the port: it throws on the line about the damage. */
    class FussyLogger extends MemoryLogger {
      override log(level: LogLevel, scope: string, message: string, logContext?: LogContext): void {
        if (message === 'Damage sources not read') {
          throw new Error('The log is full');
        }
        super.log(level, scope, message, logContext);
      }
    }
    const logger = new FussyLogger();
    const service = new ProjectionService({ reader, metrics, details, logger });
    const broken = archived[1] ?? expect.unreachable('the history holds several archived matches');
    await breakDamageMatrix(context, broken);

    const report = await service.catchUp(ACCOUNT, RUN);

    // The metrics of the match are not lost for a line of the log.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    expect((await metrics.getValues(ACCOUNT, broken)).size).toBe(
      METRIC_VALUE_COUNT + (await reviewValuesOf(context, broken)).size,
    );
    expect(linesOf(logger, 'Match not projected')).toEqual([]);
  });

  it.each([
    { label: 'a bug', error: new TypeError('Cannot read properties of undefined') },
    { label: 'a failure of the app', error: new AppError('storage', 'The disk failed') },
  ])('skips a match whose damage matrix fails on $label', async ({ error }) => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const failing = archived[0] ?? expect.unreachable('the history holds archived matches');
    // Only a matrix that is not what is expected is a verdict on the damage sources: any other error
    // says nothing about the match, so it is not told as one and nothing is recorded.
    vi.spyOn(damageMatrixReader, 'readDamageMatrix').mockImplementationOnce(() => {
      throw error;
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length - 1, skipped: 1 });
    await expect(metrics.getProjection(ACCOUNT, failing)).resolves.toBeNull();
    expect(linesOf(logger, 'Match not projected')).toMatchObject([
      { level: 'warn', context: { matchId: failing } },
    ]);
    expect(linesOf(logger, 'Damage sources not read')).toEqual([]);
    // The next run tries it again, and projects it.
    await expect(service.catchUp(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      projected: 1,
    });
  });

  it('projects a match whose death details are incomplete', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const incomplete =
      archived[1] ?? expect.unreachable('the history holds several archived matches');
    const before = await reviewValuesOf(context, incomplete);
    // The tracked player died, and the archive no longer details their deaths.
    await editArchive(context, incomplete, ({ tracked }) => {
      expect(tracked.deaths, 'the tracked player died in this match').toBeGreaterThan(0);
      delete tracked.death_details;
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    // The match is projected, not failed and not skipped: the deaths are unknown, which is no failure.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.getProjection(ACCOUNT, incomplete)).resolves.toMatchObject({
      version: PROJECTION_VERSION,
      failed: false,
    });
    // The deaths, and the deaths before each purchase, are not stored (never as 0)…
    const values = await metrics.getValues(ACCOUNT, incomplete);
    const lost = [...before.keys()].filter((key) => !values.has(key));
    expect(lost.length).toBeGreaterThan(0);
    for (const key of lost) {
      expect(key.startsWith('phase_deaths.') || key.startsWith('deaths_before_item.'), key).toBe(
        true,
      );
    }
    // …and the items and the places still are, as the archive gives them.
    for (const prefix of ['item_bought_at.', 'scoreboard_place.', 'scoreboard_place_of.']) {
      const kept = [...before].filter(([key]) => key.startsWith(prefix));
      expect(kept.length, prefix).toBeGreaterThan(0);
      for (const [key, value] of kept) {
        expect(values.get(key), key).toBe(value);
      }
    }
    expect(values).toEqual(await projectedValuesOf(context, incomplete));
    // Incomplete details are not a payload that cannot be read: nothing is told, and the match is
    // not tried again.
    expect(linesOf(logger, 'Review values not read')).toEqual([]);
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([]);
    expect(linesOf(logger, 'Match not projected')).toEqual([]);
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([]);
  });

  it('projects a match whose scoreboard cannot be read', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const unreadable =
      archived[1] ?? expect.unreachable('the history holds several archived matches');
    const before = await reviewValuesOf(context, unreadable);
    // The match no longer tells which team won: the scoreboard cannot be read, and nothing else does.
    await breakScoreboard(context, unreadable);

    const report = await service.catchUp(ACCOUNT, RUN);

    // The match is projected, not failed and not skipped: its metrics, damage, deaths and items do
    // not depend on the scoreboard.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.getProjection(ACCOUNT, unreadable)).resolves.toMatchObject({
      version: PROJECTION_VERSION,
      failed: false,
      playerBadge: expectedBadge(unreadable),
    });
    const values = await metrics.getValues(ACCOUNT, unreadable);
    // No place at all, and no top three…
    expect([...values.keys()].filter(isPlaceKey)).toEqual([]);
    expect([...before.keys()].filter(isPlaceKey).length).toBeGreaterThan(0);
    // …and every other value is stored as the archive gives it.
    expect(values).toEqual(
      new Map([
        ...(await metricValuesOf(context, unreadable)),
        ...(await damageValuesOf(context, unreadable)),
        ...[...before].filter(([key]) => !isPlaceKey(key)),
      ]),
    );
    // The matches around it are not affected.
    const other = archived[0] ?? expect.unreachable();
    expect(await metrics.getValues(ACCOUNT, other)).toEqual(
      await projectedValuesOf(context, other),
    );
    // One line at the info level, with the match and the place and the code of the problem, never a
    // value of the archive.
    expect(linesOf(logger, 'Review values not read')).toEqual([
      {
        level: 'info',
        scope: 'projection',
        message: 'Review values not read',
        context: {
          syncRunId: RUN,
          matchId: unreadable,
          issue: expect.stringMatching(BROKEN_SCOREBOARD_ISSUE) as unknown,
        },
      },
    ]);
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([]);
    expect(linesOf(logger, 'Match not projected')).toEqual([]);
    expect(JSON.stringify(logger.entries)).not.toContain(FAKE_OTHER_PLAYER);
    expectNoAccountId(logger);
    // The verdict is on the review values only: the match is not tried again.
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([]);
  });

  it('tells review values that cannot be read once per run, whichever part fails first', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const [, itemsLost, placesLost] = archived;
    const itemsBefore = await reviewValuesOf(context, itemsLost ?? expect.unreachable());
    const placesBefore = await reviewValuesOf(context, placesLost ?? expect.unreachable());
    // The items of the first match are not a list, and the scoreboard of the second cannot be read.
    await editArchive(context, itemsLost ?? expect.unreachable(), ({ tracked }) => {
      tracked.items = 'none';
    });
    await breakScoreboard(context, placesLost ?? expect.unreachable());

    const report = await service.catchUp(ACCOUNT, RUN);

    // Both matches are projected, and the run tells about the first one only, whichever part of the
    // review it was: a change of the payload hits most matches, so a line for each would flood.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    expect(linesOf(logger, 'Review values not read')).toMatchObject([
      {
        level: 'info',
        context: {
          syncRunId: RUN,
          matchId: itemsLost,
          issue: expect.stringMatching(BROKEN_ITEMS_ISSUE) as unknown,
        },
      },
    ]);
    // Each part is guarded on its own: the first match lost its items, the second its places, and
    // neither lost the rest.
    expect(await storedReviewValuesOf(context, itemsLost ?? expect.unreachable())).toEqual(
      new Map([...itemsBefore].filter(([key]) => !isItemKey(key))),
    );
    expect(await storedReviewValuesOf(context, placesLost ?? expect.unreachable())).toEqual(
      new Map([...placesBefore].filter(([key]) => !isPlaceKey(key))),
    );

    // The next run tells again: it does not know what an earlier run said.
    logger.entries.length = 0;
    await metrics.deleteAccount(ACCOUNT);
    await service.catchUp(ACCOUNT, 'run-0002');
    expect(linesOf(logger, 'Review values not read')).toMatchObject([
      { context: { syncRunId: 'run-0002', matchId: itemsLost } },
    ]);
  });

  it('does not let the line about review values that cannot be read stop the projection', async () => {
    const context = await setUp();
    const { reader, metrics, details, archived } = context;
    /** A logger that breaks the contract of the port: it throws on the line about the review. */
    class FussyLogger extends MemoryLogger {
      override log(level: LogLevel, scope: string, message: string, logContext?: LogContext): void {
        if (message === 'Review values not read') {
          throw new Error('The log is full');
        }
        super.log(level, scope, message, logContext);
      }
    }
    const logger = new FussyLogger();
    const service = new ProjectionService({ reader, metrics, details, logger });
    const broken = archived[1] ?? expect.unreachable('the history holds several archived matches');
    const before = await reviewValuesOf(context, broken);
    await breakScoreboard(context, broken);

    const report = await service.catchUp(ACCOUNT, RUN);

    // The values of the match are not lost for a line of the log: all of them are stored but the
    // places, which the scoreboard gives.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    expect([...before.keys()].filter(isPlaceKey).length).toBeGreaterThan(0);
    expect(await metrics.getValues(ACCOUNT, broken)).toEqual(
      new Map([
        ...(await metricValuesOf(context, broken)),
        ...(await damageValuesOf(context, broken)),
        ...[...before].filter(([key]) => !isPlaceKey(key)),
      ]),
    );
    expect(linesOf(logger, 'Match not projected')).toEqual([]);
  });

  it.each(
    [
      {
        part: 'death details',
        fail: (error: Error) =>
          vi.spyOn(trackedDeathsReader, 'readTrackedDeathTimes').mockImplementationOnce(() => {
            throw error;
          }),
      },
      {
        part: 'items',
        fail: (error: Error) =>
          vi.spyOn(trackedItemsReader, 'readTrackedItems').mockImplementationOnce(() => {
            throw error;
          }),
      },
      {
        part: 'scoreboard',
        fail: (error: Error) =>
          vi.spyOn(scoreboardReader, 'readScoreboard').mockImplementationOnce(() => {
            throw error;
          }),
      },
    ].flatMap((reader) =>
      [
        { label: 'a bug', error: new TypeError('Cannot read properties of undefined') },
        { label: 'a failure of the app', error: new AppError('storage', 'The disk failed') },
      ].map((failure) => ({ ...reader, ...failure })),
    ),
  )('skips a match when reading its $part fails on $label', async ({ fail, error }) => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const failing = archived[0] ?? expect.unreachable('the history holds archived matches');
    // Without a damage matrix, which reads the items before the review does: the failure is the
    // review's.
    await editArchive(context, failing, ({ matchInfo }) => {
      delete matchInfo.damage_matrix;
    });
    // Only a part that is not what is expected is a verdict on the review values: any other error
    // says nothing about the match, so it is not told as one and nothing is recorded.
    fail(error);

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length - 1, skipped: 1 });
    await expect(metrics.getProjection(ACCOUNT, failing)).resolves.toBeNull();
    expect(linesOf(logger, 'Match not projected')).toMatchObject([
      { level: 'warn', context: { matchId: failing } },
    ]);
    expect(linesOf(logger, 'Review values not read')).toEqual([]);
    // The next run tries it again, and projects it.
    await expect(service.catchUp(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      projected: 1,
    });
  });

  it('projects an archive that lacks some stats', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const lacking = archived[1] ?? expect.unreachable('the history holds several archived matches');
    // The counters of the shots and of the damage to objectives are gone from every snapshot.
    await editArchive(context, lacking, ({ tracked }) => {
      for (const snapshot of tracked.stats ?? []) {
        delete snapshot.shots_hit;
        delete snapshot.shots_missed;
        delete snapshot.boss_damage;
      }
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    // The match is analysed, not failed: what the archive does not hold is an unknown value.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.getProjection(ACCOUNT, lacking)).resolves.toMatchObject({
      failed: false,
      version: PROJECTION_VERSION,
    });
    const values = await metrics.getValues(ACCOUNT, lacking);
    expect(values.size).toBe(await expectedValueCount(context, lacking));
    for (const key of [
      'accuracy',
      'boss_damage_per_min',
      'objective_damage_per_min_early',
      'objective_damage_per_min_mid',
      'objective_damage_per_min_late',
    ]) {
      expect(values.get(key), key).toBeNull();
    }
    // What the archive still holds is projected as usual.
    for (const key of ['kda', 'last_hits', 'souls_per_min', 'hero_damage_per_min_mid']) {
      expect(values.get(key), key).not.toBeNull();
    }
    // An unknown value is not an error: nothing is logged about it.
    expect(linesOf(logger, 'Metric not computed')).toEqual([]);
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([]);
  });

  it('stores that somebody left the match', async () => {
    const context = await setUp();
    const { service, metrics, archived } = context;
    const [, otherLeft, trackedLeft] = archived;
    // Another player leaves one match, and the tracked player leaves another one.
    await editArchive(context, otherLeft ?? expect.unreachable(), ({ other }) => {
      other.abandon_match_time_s = 900;
    });
    await editArchive(context, trackedLeft ?? expect.unreachable(), ({ tracked }) => {
      tracked.abandon_match_time_s = 1_200;
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    for (const matchId of archived) {
      await expect(metrics.getProjection(ACCOUNT, matchId), String(matchId)).resolves.toMatchObject(
        {
          hasLeaver: matchId === otherLeft || matchId === trackedLeft,
          failed: false,
          playerBadge: expectedBadge(matchId),
        },
      );
    }
  });

  it('projects a ranked match whose rank is not a badge, with no badge', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const ranked =
      archived.find((matchId) => expectedBadge(matchId) !== null) ??
      expect.unreachable('the history holds a ranked archived match');
    // A rank past the highest badge: the rest of the archive is fine.
    await editArchive(context, ranked, ({ tracked }) => {
      tracked.player_rank_data = { initial_display_rank: 200 };
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    // The projection is not refused by the database, and it does not stop the run.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    await expect(metrics.getProjection(ACCOUNT, ranked)).resolves.toMatchObject({
      playerBadge: null,
      failed: false,
      version: PROJECTION_VERSION,
    });
    expect((await metrics.getValues(ACCOUNT, ranked)).size).toBe(
      await expectedValueCount(context, ranked),
    );
    expect(linesOf(logger, 'Projection stopped')).toEqual([]);
    expect(linesOf(logger, 'Match not projected')).toEqual([]);
  });

  it('marks a match it cannot read as failed and never retries it', async () => {
    const context = await setUp();
    const { service, metrics, logger, archived } = context;
    const broken = archived[1] ?? expect.unreachable('the history holds several archived matches');
    // The archive is valid as a match detail, but the tracked player has lost their souls: the
    // analysis cannot read the match.
    await editArchive(context, broken, ({ tracked }) => {
      delete tracked.net_worth;
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length - 1, failed: 1 });
    // The verdict is stored: the current version, the flag, and not a single value.
    await expect(metrics.getProjection(ACCOUNT, broken)).resolves.toMatchObject({
      version: PROJECTION_VERSION,
      failed: true,
      playerBadge: null,
      hasLeaver: false,
      projectedAt: PROJECTION_START + YIELD_STEP_MS,
    });
    expect((await metrics.getValues(ACCOUNT, broken)).size).toBe(0);
    // One warning, with the place and the kind of the problem, never a value of the archive.
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match could not be analysed',
        context: {
          syncRunId: RUN,
          matchId: broken,
          issue: expect.stringMatching(/^players\.\d+\.net_worth: \w+$/) as unknown,
        },
      },
    ]);
    expect(linesOf(logger, 'Projection done')).toMatchObject([
      { level: 'info', context: { projected: archived.length - 1, failed: 1, reset: 0 } },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(FAKE_OTHER_PLAYER);
    expectNoAccountId(logger);

    // The archive is not downloaded again and the match is not tried again: the verdict stands.
    logger.entries.length = 0;
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([]);
    await expect(service.catchUp(ACCOUNT, 'run-0002')).resolves.toEqual(NOTHING);
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([]);
  });

  it.each([
    {
      label: 'a file that is gone',
      damage: (context: TestContext, matchId: MatchId) => deleteArchive(context, matchId),
    },
    {
      label: 'a file that is not an archive',
      damage: (context: TestContext, matchId: MatchId) =>
        context.archiveStore.write(ACCOUNT, matchId, Uint8Array.of(1, 2, 3, 4)),
    },
  ])('puts a missing archive back to pending: $label', async ({ damage }) => {
    const context = await setUp();
    const { service, metrics, details, logger, archived } = context;
    const lost = archived[1] ?? expect.unreachable('the history holds several archived matches');
    await damage(context, lost);

    const report = await service.catchUp(ACCOUNT, RUN);

    // The other matches are projected; this one goes back in the queue, to be downloaded again.
    expect(report).toEqual({ ...NOTHING, projected: archived.length - 1, reset: 1 });
    await expect(details.getDetail(ACCOUNT, lost)).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      archivedBytes: null,
    });
    await expect(metrics.getProjection(ACCOUNT, lost)).resolves.toBeNull();
    expect(linesOf(logger, 'Projection done')).toMatchObject([
      { level: 'info', context: { projected: archived.length - 1, failed: 0, reset: 1 } },
    ]);
    // It is not ready any more: the next catch-up has nothing to do for it, so it cannot loop.
    await expect(service.catchUp(ACCOUNT, 'run-0002')).resolves.toEqual(NOTHING);
    expectNoAccountId(logger);
  });

  it('skips a match whose file cannot be read, and projects the others', async () => {
    const context = await setUp();
    const { service, metrics, details, logger, archived } = context;
    const unreadable =
      archived[1] ?? expect.unreachable('the history holds several archived matches');
    const brokenDisk = failReadsOf(context, [unreadable]);

    const report = await service.catchUp(ACCOUNT, RUN);

    // The run goes through every match, and is not stopped by one that fails.
    expect(report).toEqual({ ...NOTHING, projected: archived.length - 1, skipped: 1 });
    // The match is left as it was: still archived, still to project.
    await expect(details.getDetail(ACCOUNT, unreadable)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(metrics.getProjection(ACCOUNT, unreadable)).resolves.toBeNull();
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([unreadable]);
    // It is told once, with the match, the kind of the failure and where it happened.
    expect(linesOf(logger, 'Match not projected')).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match not projected',
        context: {
          kind: 'storage',
          step: 'read',
          cause: `Access is denied to archive/{account_id}/${String(unreadable)}.json.zst`,
          syncRunId: RUN,
          matchId: unreadable,
        },
      },
    ]);
    expect(linesOf(logger, 'Projection stopped')).toEqual([]);
    expect(linesOf(logger, 'Projection done')).toMatchObject([
      { level: 'info', context: { projected: archived.length - 1, skipped: 1 } },
    ]);
    expectNoAccountId(logger);

    // Once the disk works again, the next run projects it.
    brokenDisk.mockRestore();
    await expect(service.catchUp(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      projected: 1,
    });
  });

  it.each([
    {
      label: 'failures that a match in between breaks up',
      failing: [0, 1, 3, 4],
      // Every other match is tried, whatever the number of failures.
      tried: Infinity,
      stoppedBy: null,
    },
    {
      label: 'three failures in a row at the start',
      failing: [0, 1, 2],
      tried: 3,
      stoppedBy: 'storage',
    },
    {
      label: 'three failures in a row after a match that got through',
      failing: [1, 2, 3],
      tried: 4,
      stoppedBy: 'storage',
    },
    {
      label: 'two failures in a row, twice',
      failing: [1, 2, 4, 5],
      tried: Infinity,
      stoppedBy: null,
    },
  ] as const)('with $label', async ({ failing, tried, stoppedBy }) => {
    const context = await setUp();
    const { service, metrics, logger, yieldToEventLoop, archived } = context;
    const failingIds = failing.map((index) => archived[index] ?? expect.unreachable());
    failReadsOf(context, failingIds);

    const report = await service.catchUp(ACCOUNT, RUN);

    // The failures that were met are the ones of the matches the run reached.
    const reached = archived.slice(0, tried);
    const skipped = reached.filter((matchId) => failingIds.includes(matchId));
    expect(report).toEqual({
      ...NOTHING,
      projected: reached.length - skipped.length,
      skipped: skipped.length,
      stoppedBy,
    });
    // What was not reached is still to project, with the matches that failed.
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual(
      archived.filter((matchId, index) => failingIds.includes(matchId) || index >= tried),
    );
    expect(yieldToEventLoop).toHaveBeenCalledTimes(reached.length - 1);
    // Each failure is told once; the one that stops the run is told as the stop.
    const stopped = stoppedBy === null ? 0 : 1;
    expect(linesOf(logger, 'Match not projected').map((entry) => entry.context.matchId)).toEqual(
      skipped.slice(0, skipped.length - stopped),
    );
    expect(linesOf(logger, 'Projection stopped').map((entry) => entry.context.matchId)).toEqual(
      stopped === 1 ? skipped.slice(-1) : [],
    );
  });

  it('stops on a broken compressor without throwing, after three matches', async () => {
    const context = await setUp();
    const { service, metrics, details, logger, yieldToEventLoop, compressor, archived } = context;
    // The compressor is broken (its worker crashed, say): that says nothing about the archives.
    vi.spyOn(compressor, 'decompress').mockRejectedValue(
      new AppError('storage', 'The compressor failed'),
    );

    const report = await service.catchUp(ACCOUNT, RUN);

    // The first two matches are skipped, since one archive may be the problem; the third in a row
    // says it is not.
    expect(report).toEqual({ ...NOTHING, skipped: FAILURES_IN_A_ROW, stoppedBy: 'storage' });
    expect(yieldToEventLoop).toHaveBeenCalledTimes(FAILURES_IN_A_ROW - 1);
    // Nothing was touched: no projection, no match put back to pending.
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual(archived);
    await expect(
      details.getDetail(ACCOUNT, archived[0] ?? expect.unreachable()),
    ).resolves.toMatchObject({
      status: 'ready',
    });
    // The reader said nothing: the compressor failed, which is not about an archive.
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match not projected',
        context: { kind: 'storage', syncRunId: RUN, matchId: archived[0] },
      },
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match not projected',
        context: { kind: 'storage', syncRunId: RUN, matchId: archived[1] },
      },
      {
        level: 'warn',
        scope: 'projection',
        message: 'Projection stopped',
        context: { kind: 'storage', syncRunId: RUN, matchId: archived[2] },
      },
      {
        level: 'info',
        scope: 'projection',
        message: 'Projection done',
        context: {
          syncRunId: RUN,
          projected: 0,
          failed: 0,
          reset: 0,
          skipped: FAILURES_IN_A_ROW,
          durationMs: (FAILURES_IN_A_ROW - 1) * YIELD_STEP_MS,
        },
      },
    ]);
    expectNoAccountId(logger);
  });

  it('keeps what it projected before a stop, and goes on from there at the next run', async () => {
    const context = await setUp();
    const { service, metrics, logger, compressor, archived } = context;
    const decompress = compressor.decompress.bind(compressor);
    const spy = vi.spyOn(compressor, 'decompress').mockImplementationOnce(decompress);
    for (let failure = 0; failure < FAILURES_IN_A_ROW; failure += 1) {
      spy.mockRejectedValueOnce(new AppError('storage', 'The compressor failed'));
    }

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({
      ...NOTHING,
      projected: 1,
      skipped: FAILURES_IN_A_ROW,
      stoppedBy: 'storage',
    });
    // The first match is done, the next three are where it failed, and the others were not tried.
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual(
      archived.slice(1),
    );
    expect(linesOf(logger, 'Projection stopped')).toMatchObject([
      { context: { matchId: archived[FAILURES_IN_A_ROW] } },
    ]);
    // What was done is told, as for any run.
    expect(linesOf(logger, 'Projection done')).toMatchObject([
      { level: 'info', context: { projected: 1, failed: 0, reset: 0, skipped: FAILURES_IN_A_ROW } },
    ]);

    // The compressor works again.
    await expect(service.catchUp(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      projected: archived.length - 1,
    });
  });

  it.each([
    {
      label: 'a file the disk cannot read',
      breakIt: ({ archiveStore }: TestContext) =>
        vi
          .spyOn(archiveStore, 'read')
          .mockRejectedValue(
            new Error(`Access is denied to archive/${String(ACCOUNT)}/1.json.zst`),
          ),
      logged: {
        kind: 'storage',
        step: 'read',
        cause: 'Access is denied to archive/{account_id}/1.json.zst',
      },
      stack: false,
    },
    {
      label: 'a database that fails',
      breakIt: ({ metrics }: TestContext) =>
        vi.spyOn(metrics, 'saveProjection').mockRejectedValue(
          new AppError('storage', 'Could not save the projection of a match', {
            cause: new Error(`disk full for ${String(ACCOUNT)}`),
          }),
        ),
      logged: { kind: 'storage', cause: 'disk full for {account_id}' },
      stack: false,
    },
    {
      label: 'a bug',
      breakIt: ({ metrics }: TestContext) =>
        vi
          .spyOn(metrics, 'saveProjection')
          .mockRejectedValue(
            new TypeError(`Cannot read properties of undefined (${String(ACCOUNT)})`),
          ),
      logged: { kind: 'storage', cause: 'Cannot read properties of undefined ({account_id})' },
      // What is not an error of the app is logged with its stack: it tells where the bug is.
      stack: true,
    },
  ])('skips, then stops after three matches, on $label', async ({ breakIt, logged, stack }) => {
    const context = await setUp();
    const { service, metrics, details, logger, archived } = context;
    breakIt(context);

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, skipped: FAILURES_IN_A_ROW, stoppedBy: 'storage' });
    // The three matches are left as they were.
    const tried = archived.slice(0, FAILURES_IN_A_ROW);
    for (const matchId of tried) {
      await expect(details.getDetail(ACCOUNT, matchId)).resolves.toMatchObject({
        status: 'ready',
      });
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toBeNull();
    }
    const failures = logger.entries.filter(
      (entry) => entry.message === 'Match not projected' || entry.message === 'Projection stopped',
    );
    expect(failures.map((entry) => entry.message)).toEqual([
      'Match not projected',
      'Match not projected',
      'Projection stopped',
    ]);
    for (const [index, failure] of failures.entries()) {
      expect(failure).toMatchObject({
        level: 'warn',
        scope: 'projection',
        context: { ...logged, syncRunId: RUN, matchId: tried[index] },
      });
      expect(typeof failure.context.stack === 'string').toBe(stack);
    }
    expectNoAccountId(logger);
  });

  it('stops when it cannot list the matches, with the kind of the failure only', async () => {
    const { service, metrics, logger } = await setUp();
    vi.spyOn(metrics, 'listToProject').mockRejectedValueOnce(
      new AppError('storage', 'Could not list the matches to project', {
        cause: new Error(`database is locked (${String(ACCOUNT)})`),
      }),
    );

    const report = await service.catchUp(ACCOUNT, RUN);

    // At once: no match is known, so there is nothing to skip.
    expect(report).toEqual({ ...NOTHING, stoppedBy: 'storage' });
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Projection stopped',
        context: { kind: 'storage', cause: 'database is locked ({account_id})', syncRunId: RUN },
      },
    ]);
  });

  it('yields between matches', async () => {
    const { service, metrics, yieldToEventLoop, archived } = await setUp();
    const events: string[] = [];
    const save = metrics.saveProjection.bind(metrics);
    vi.spyOn(metrics, 'saveProjection').mockImplementation(async (...args) => {
      events.push('save');
      await save(...args);
    });
    yieldToEventLoop.mockImplementation(() => {
      events.push('yield');
      return Promise.resolve();
    });

    await service.catchUp(ACCOUNT, RUN);

    // A yield between two matches: never before the first one, nor after the last one.
    expect(events).toEqual(['save', ...archived.slice(1).flatMap(() => ['yield', 'save'])]);
    expect(yieldToEventLoop).toHaveBeenCalledTimes(archived.length - 1);
  });

  it('gives the event loop a turn between matches by default, with a message', async () => {
    const { reader, metrics, details, logger, archived } = await setUp();
    // Every channel the projection opens, and how many of its ports were closed.
    const channels: MessageChannel[] = [];
    let closed = 0;
    class RecordingChannel extends MessageChannel {
      constructor() {
        super();
        const close = this.port1.close.bind(this.port1);
        this.port1.close = () => {
          closed += 1;
          close();
        };
        channels.push(this);
      }
    }
    vi.stubGlobal('MessageChannel', RecordingChannel);
    const service = new ProjectionService({ reader, metrics, details, logger });

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    // One channel for each yield. The projection only goes on once the message is received, which
    // is when it closes the channel: none is left open.
    expect(channels).toHaveLength(archived.length - 1);
    expect(closed).toBe(archived.length - 1);
  });

  it('tells a metric that cannot be computed once per run, and never the message of its error', async () => {
    const { service, metrics, logger, archived } = await setUp();
    vi.spyOn(accuracyMetric, 'compute').mockImplementation(() => {
      throw new Error(`secret ${FAKE_OTHER_PLAYER}`);
    });
    vi.spyOn(kdaMetric, 'compute').mockImplementation(() => {
      throw new AppError('invalid_payload', `secret ${FAKE_OTHER_PLAYER}`);
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    // A metric that fails costs the match nothing but that metric.
    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    for (const matchId of archived) {
      const values = await metrics.getValues(ACCOUNT, matchId);
      expect(values.get('kda')).toBeNull();
      expect(values.get('accuracy')).toBeNull();
      expect(values.get('last_hits')).not.toBeNull();
    }
    // Every match failed on both metrics, and the run says it once for each, at the first match.
    expect(linesOf(logger, 'Metric not computed')).toEqual([
      {
        level: 'info',
        scope: 'projection',
        message: 'Metric not computed',
        context: { syncRunId: RUN, matchId: archived[0], key: 'kda', kind: 'invalid_payload' },
      },
      {
        level: 'info',
        scope: 'projection',
        message: 'Metric not computed',
        context: { syncRunId: RUN, matchId: archived[0], key: 'accuracy', kind: 'unexpected' },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain('secret');
    expect(JSON.stringify(logger.entries)).not.toContain(FAKE_OTHER_PLAYER);
  });

  it('does not let a log line that fails stop the projection', async () => {
    const context = await setUp();
    const { reader, metrics, details, archived } = context;
    /** A logger that breaks the contract of the port: it throws on the line about a metric. */
    class FussyLogger extends MemoryLogger {
      override log(level: LogLevel, scope: string, message: string, logContext?: LogContext): void {
        if (message === 'Metric not computed') {
          throw new Error('The log is full');
        }
        super.log(level, scope, message, logContext);
      }
    }
    const logger = new FussyLogger();
    const service = new ProjectionService({ reader, metrics, details, logger });
    vi.spyOn(accuracyMetric, 'compute').mockImplementation(() => {
      throw new Error('boom');
    });

    const report = await service.catchUp(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, projected: archived.length });
    expect(linesOf(logger, 'Projection stopped')).toEqual([]);
    expect(linesOf(logger, 'Match not projected')).toEqual([]);
  });
});

describe('ProjectionService.projectMatch', () => {
  /**
   * Set up a history long enough for a match to have more archived matches before it than the
   * window of the habits, and one after it.
   *
   * @returns What {@link setUp} builds, and the matches by their place: the match under analysis,
   *   the one that is more recent, the ones of its window, and the older ones.
   */
  async function setUpLongHistory() {
    const context = await setUp(LONG_MATCH_COUNT);
    const { archived } = context;
    const later = archived[0] ?? expect.unreachable('the history holds archived matches');
    const target = archived[1] ?? expect.unreachable('the history holds several archived matches');
    const earlier = archived.slice(2, 2 + PERSONAL_WINDOW);
    const older = archived.slice(2 + PERSONAL_WINDOW);
    expect(earlier, 'the match has a full window of archived matches before it').toHaveLength(
      PERSONAL_WINDOW,
    );
    expect(older.length, 'archived matches are left beyond the window').toBeGreaterThan(0);
    return { ...context, later, target, earlier, older };
  }

  it('projects the match and the 20 matches before it, and leaves the others alone', async () => {
    const context = await setUpLongHistory();
    const { service, metrics, logger, yieldToEventLoop, later, target, earlier, older } = context;
    const listing = vi.spyOn(metrics, 'listToProjectUpTo');

    const report = await service.projectMatch(ACCOUNT, target);

    expect(report).toEqual({ ...NOTHING, projected: 1 + PERSONAL_WINDOW });
    // It asks for the window of the habits.
    expect(listing).toHaveBeenCalledWith(ACCOUNT, target, PROJECTION_VERSION, PERSONAL_WINDOW);
    // The match first, then the earlier ones from the most recent, each stored as the registry
    // projects it.
    for (const [index, matchId] of [target, ...earlier].entries()) {
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toMatchObject({
        matchId,
        version: PROJECTION_VERSION,
        playerBadge: expectedBadge(matchId),
        hasLeaver: false,
        failed: false,
        projectedAt: PROJECTION_START + index * YIELD_STEP_MS,
      });
      await expect(metrics.getValues(ACCOUNT, matchId)).resolves.toEqual(
        await projectedValuesOf(context, matchId),
      );
    }
    // What was projected is exactly the habits of the match: the analysis reads these same matches.
    const previous = await metrics.listPrevious(
      ACCOUNT,
      target,
      PROJECTION_VERSION,
      PERSONAL_WINDOW,
    );
    expect(previous.map((match) => match.matchId)).toEqual(earlier);
    // The match that is more recent, and the ones before the window, are left as they were.
    for (const matchId of [later, ...older]) {
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toBeNull();
    }
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([
      later,
      ...older,
    ]);
    expect(yieldToEventLoop).toHaveBeenCalledTimes(PERSONAL_WINDOW);
    // It says what it did in one line, with the match it was asked for and no run id.
    expect(logger.entries).toEqual([
      {
        level: 'info',
        scope: 'projection',
        message: 'Projection done',
        context: {
          matchId: target,
          projected: 1 + PERSONAL_WINDOW,
          failed: 0,
          reset: 0,
          skipped: 0,
          durationMs: PERSONAL_WINDOW * YIELD_STEP_MS,
        },
      },
    ]);
    expectNoAccountId(logger);
  });

  it('projects nothing the second time, instead of going further back, and says so at the debug level', async () => {
    const { service, metrics, logger, target, earlier } = await setUpLongHistory();
    await service.projectMatch(ACCOUNT, target);
    const first = earlier[0] ?? expect.unreachable();
    const stored = await metrics.getProjection(ACCOUNT, first);
    logger.entries.length = 0;

    // The matches before the window still lack a projection: they are not the match's habits.
    await expect(service.projectMatch(ACCOUNT, target)).resolves.toEqual(NOTHING);

    await expect(metrics.getProjection(ACCOUNT, first)).resolves.toEqual(stored);
    expect(logger.entries).toEqual([
      {
        level: 'debug',
        scope: 'projection',
        message: 'Projection done',
        context: {
          matchId: target,
          projected: 0,
          failed: 0,
          reset: 0,
          skipped: 0,
          durationMs: 0,
        },
      },
    ]);
  });

  it('projects the match alone when no archived match is before it', async () => {
    const { service, metrics, yieldToEventLoop, archived } = await setUp();
    const oldest = archived[archived.length - 1] ?? expect.unreachable();

    const report = await service.projectMatch(ACCOUNT, oldest);

    expect(report).toEqual({ ...NOTHING, projected: 1 });
    expect(yieldToEventLoop).not.toHaveBeenCalled();
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual(
      archived.slice(0, -1),
    );
  });

  it('projects nothing for a match that is not stored', async () => {
    const { service, metrics, logger, archived } = await setUp();

    const report = await service.projectMatch(ACCOUNT, testMatchId(100_000_001));

    expect(report).toEqual(NOTHING);
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual(archived);
    expect(linesOf(logger, 'Projection done')).toMatchObject([
      { level: 'debug', context: { projected: 0 } },
    ]);
  });

  it('re-projects the match and its window after a version bump, and only them', async () => {
    const { service, metrics, archived, later, target, earlier, older } = await setUpLongHistory();
    // The state an older version of the app left: every match projected with version 0.
    for (const matchId of archived) {
      await metrics.saveProjection(
        ACCOUNT,
        matchId,
        {
          version: PROJECTION_VERSION - 1,
          playerBadge: null,
          hasLeaver: true,
          failed: false,
          projectedAt: 1,
        },
        new Map([['stale_metric', 1]]),
      );
    }

    const report = await service.projectMatch(ACCOUNT, target);

    expect(report).toEqual({ ...NOTHING, projected: 1 + PERSONAL_WINDOW });
    for (const matchId of [target, ...earlier]) {
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toMatchObject({
        version: PROJECTION_VERSION,
        hasLeaver: false,
      });
      expect((await metrics.getValues(ACCOUNT, matchId)).has('stale_metric')).toBe(false);
    }
    // The others wait for the page of their own match.
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([
      later,
      ...older,
    ]);
    await expect(metrics.getProjection(ACCOUNT, later)).resolves.toMatchObject({
      version: PROJECTION_VERSION - 1,
    });
  });

  it('puts a match with no archive back to pending, and goes on with the others', async () => {
    const context = await setUpLongHistory();
    const { service, metrics, details, logger, target, earlier, older } = context;
    const lost = earlier[3] ?? expect.unreachable();
    await deleteArchive(context, lost);

    const report = await service.projectMatch(ACCOUNT, target);

    expect(report).toEqual({ ...NOTHING, projected: PERSONAL_WINDOW, reset: 1 });
    await expect(details.getDetail(ACCOUNT, lost)).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      archivedBytes: null,
    });
    await expect(metrics.getProjection(ACCOUNT, lost)).resolves.toBeNull();
    expect(linesOf(logger, 'Projection done')).toMatchObject([
      {
        level: 'info',
        context: { matchId: target, projected: PERSONAL_WINDOW, failed: 0, reset: 1 },
      },
    ]);
    expectNoAccountId(logger);

    // The match is not archived any more, so it left the window: the next older one took its place.
    await expect(service.projectMatch(ACCOUNT, target)).resolves.toEqual({
      ...NOTHING,
      projected: 1,
    });
    await expect(
      metrics.getProjection(ACCOUNT, older[0] ?? expect.unreachable()),
    ).resolves.not.toBe(null);
  });

  it('stores a match it cannot read as failed, with no run id in the line about it', async () => {
    const context = await setUpLongHistory();
    const { service, metrics, logger, target, earlier } = context;
    const broken = earlier[0] ?? expect.unreachable();
    // The tracked player has lost their souls in this archive: the analysis cannot read the match.
    await editArchive(context, broken, ({ tracked }) => {
      delete tracked.net_worth;
    });

    const report = await service.projectMatch(ACCOUNT, target);

    expect(report).toEqual({ ...NOTHING, projected: PERSONAL_WINDOW, failed: 1 });
    await expect(metrics.getProjection(ACCOUNT, broken)).resolves.toMatchObject({
      version: PROJECTION_VERSION,
      failed: true,
    });
    expect(linesOf(logger, 'Match could not be analysed')).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match could not be analysed',
        context: {
          matchId: broken,
          issue: expect.stringMatching(/^players\.\d+\.net_worth: \w+$/) as unknown,
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(FAKE_OTHER_PLAYER);
    expectNoAccountId(logger);
    // The habits of the match hold what could be read: the analysis counts 19 of the 20.
    const habits = async () =>
      (await metrics.listPrevious(ACCOUNT, target, PROJECTION_VERSION, PERSONAL_WINDOW)).map(
        (match) => match.matchId,
      );
    await expect(habits()).resolves.toEqual(earlier.slice(1));

    // The verdict stands: the match is not tried again. It is out of the window now, as it is out
    // of the habits, so the next older match takes its place and is projected, and then it is done.
    const next = context.older[0] ?? expect.unreachable();
    await expect(service.projectMatch(ACCOUNT, target)).resolves.toEqual({
      ...NOTHING,
      projected: 1,
    });
    await expect(metrics.getProjection(ACCOUNT, broken)).resolves.toMatchObject({ failed: true });
    await expect(habits()).resolves.toEqual([...earlier.slice(1), next]);
    await expect(service.projectMatch(ACCOUNT, target)).resolves.toEqual(NOTHING);
  });

  it('projects nothing for a match whose detail is not archived', async () => {
    const context = await setUpLongHistory();
    const { service, metrics, details, logger, target, earlier } = context;
    await details.resetToPending(ACCOUNT, target);

    const report = await service.projectMatch(ACCOUNT, target);

    // Neither the match nor its earlier ones: the page of such a match shows no analysis.
    expect(report).toEqual(NOTHING);
    for (const matchId of [target, ...earlier]) {
      await expect(metrics.getProjection(ACCOUNT, matchId)).resolves.toBeNull();
    }
    expect(linesOf(logger, 'Projection done')).toMatchObject([
      { level: 'debug', context: { matchId: target, projected: 0 } },
    ]);
  });

  it('stops after three matches in a row that cannot be projected, without throwing', async () => {
    const { service, metrics, details, logger, yieldToEventLoop, compressor, target, earlier } =
      await setUpLongHistory();
    // The compressor is broken: that says nothing about the archives.
    vi.spyOn(compressor, 'decompress').mockRejectedValue(
      new AppError('storage', 'The compressor failed'),
    );

    const report = await service.projectMatch(ACCOUNT, target);

    expect(report).toEqual({ ...NOTHING, skipped: FAILURES_IN_A_ROW, stoppedBy: 'storage' });
    expect(yieldToEventLoop).toHaveBeenCalledTimes(FAILURES_IN_A_ROW - 1);
    // Nothing was touched: no projection, no match put back to pending.
    await expect(metrics.getProjection(ACCOUNT, target)).resolves.toBeNull();
    await expect(details.getDetail(ACCOUNT, target)).resolves.toMatchObject({ status: 'ready' });
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match not projected',
        context: { kind: 'storage', matchId: target },
      },
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match not projected',
        context: { kind: 'storage', matchId: earlier[0] },
      },
      {
        level: 'warn',
        scope: 'projection',
        message: 'Projection stopped',
        context: { kind: 'storage', matchId: earlier[1] },
      },
      {
        level: 'info',
        scope: 'projection',
        message: 'Projection done',
        context: {
          matchId: target,
          projected: 0,
          failed: 0,
          reset: 0,
          skipped: FAILURES_IN_A_ROW,
          durationMs: (FAILURES_IN_A_ROW - 1) * YIELD_STEP_MS,
        },
      },
    ]);
    expectNoAccountId(logger);
  });

  it('skips a match whose file cannot be read, and projects the others', async () => {
    const context = await setUpLongHistory();
    const { service, metrics, logger, target, earlier } = context;
    const unreadable = earlier[5] ?? expect.unreachable();
    failReadsOf(context, [unreadable]);

    const report = await service.projectMatch(ACCOUNT, target);

    expect(report).toEqual({ ...NOTHING, projected: PERSONAL_WINDOW, skipped: 1 });
    // The match is left as it was, and is still in the window, so it is the next call's to retry.
    await expect(metrics.getProjection(ACCOUNT, unreadable)).resolves.toBeNull();
    expect(linesOf(logger, 'Match not projected')).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Match not projected',
        context: {
          kind: 'storage',
          step: 'read',
          cause: `Access is denied to archive/{account_id}/${String(unreadable)}.json.zst`,
          matchId: unreadable,
        },
      },
    ]);
    expectNoAccountId(logger);
  });

  it('stops when it cannot list the matches, with the kind of the failure only', async () => {
    const { service, metrics, logger, target } = await setUpLongHistory();
    vi.spyOn(metrics, 'listToProjectUpTo').mockRejectedValueOnce(
      new AppError('storage', 'Could not list the match to project', {
        cause: new Error(`database is locked (${String(ACCOUNT)})`),
      }),
    );

    const report = await service.projectMatch(ACCOUNT, target);

    // At once: no match is known, so there is nothing to skip.
    expect(report).toEqual({ ...NOTHING, stoppedBy: 'storage' });
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        scope: 'projection',
        message: 'Projection stopped',
        context: { kind: 'storage', cause: 'database is locked ({account_id})', matchId: target },
      },
    ]);
  });
});

describe('ProjectionService, one projection at a time', () => {
  /** What a test asks the projection for: a catch-up, or the projection of a match. */
  type Ask = 'catch-up' | 'match';

  /**
   * Record, in the order it happens, what the projections do: the start of a run (the listing of
   * its matches, named after what was asked), the save of each match (`save`) and the end of a run
   * (the line that closes it, `done`). The first listing waits for `held`, which keeps the first run
   * going while the test asks for the next one.
   *
   * @param context - What {@link setUp} built.
   * @param held - What the first listing waits for.
   * @returns The events, oldest first; the array fills as the projections run.
   */
  function recordRuns(context: TestContext, held: Promise<void>): string[] {
    const { metrics, logger } = context;
    const events: string[] = [];
    let isFirst = true;
    /**
     * Record the start of a run, and hold it if it is the first one.
     *
     * @param ask - What the run was asked for.
     */
    const start = async (ask: Ask): Promise<void> => {
      events.push(ask);
      if (isFirst) {
        isFirst = false;
        await held;
      }
    };
    const listToProject = metrics.listToProject.bind(metrics);
    vi.spyOn(metrics, 'listToProject').mockImplementation(async (...args) => {
      await start('catch-up');
      return listToProject(...args);
    });
    const listToProjectUpTo = metrics.listToProjectUpTo.bind(metrics);
    vi.spyOn(metrics, 'listToProjectUpTo').mockImplementation(async (...args) => {
      await start('match');
      return listToProjectUpTo(...args);
    });
    const save = metrics.saveProjection.bind(metrics);
    vi.spyOn(metrics, 'saveProjection').mockImplementation(async (...args) => {
      events.push('save');
      await save(...args);
    });
    const log = logger.log.bind(logger);
    vi.spyOn(logger, 'log').mockImplementation((level, scope, message, logContext) => {
      if (message === 'Projection done') {
        events.push('done');
      }
      log(level, scope, message, logContext);
    });
    return events;
  }

  it.each([
    {
      first: 'catch-up',
      second: 'match',
      // The catch-up projects every archived match: the match then finds its window done.
      projectedFirst: (archivedCount: number) => archivedCount,
      projectedSecond: () => 0,
    },
    {
      first: 'match',
      second: 'catch-up',
      // The oldest match has no earlier one: it is projected alone, and the catch-up does the rest.
      projectedFirst: () => 1,
      projectedSecond: (archivedCount: number) => archivedCount - 1,
    },
  ] as const)(
    'never runs two projections side by side: a $second asked during a $first waits for it',
    async ({ first, second, projectedFirst, projectedSecond }) => {
      const context = await setUp();
      const { service, archived } = context;
      const oldest = archived.at(-1) ?? expect.unreachable('the history holds archived matches');
      const gate = createGate();
      const events = recordRuns(context, gate.opened);
      const ask = (what: Ask): Promise<ProjectionReport> =>
        what === 'catch-up' ? service.catchUp(ACCOUNT, RUN) : service.projectMatch(ACCOUNT, oldest);

      const firstRun = ask(first);
      const secondRun = ask(second);
      await settle();

      // The first run is held as it starts, and the second one has not started: it waits its turn.
      expect(events).toEqual([first]);
      gate.open();
      const [firstReport, secondReport] = await Promise.all([firstRun, secondRun]);

      // The second run started once the first had ended, and projected what the first one left:
      // every archived match was projected once.
      const saves = (count: number) => Array.from({ length: count }, () => 'save');
      expect(events).toEqual([
        first,
        ...saves(projectedFirst(archived.length)),
        'done',
        second,
        ...saves(projectedSecond(archived.length)),
        'done',
      ]);
      expect(firstReport).toEqual({ ...NOTHING, projected: projectedFirst(archived.length) });
      expect(secondReport).toEqual({ ...NOTHING, projected: projectedSecond(archived.length) });
    },
  );

  it('lets the next projection run after one that stopped', async () => {
    const { service, compressor, archived } = await setUp();
    const oldest = archived.at(-1) ?? expect.unreachable('the history holds archived matches');
    // The compressor fails three times in a row, which stops the run that meets it, then works.
    const spy = vi.spyOn(compressor, 'decompress');
    for (let failure = 0; failure < FAILURES_IN_A_ROW; failure += 1) {
      spy.mockRejectedValueOnce(new AppError('storage', 'The compressor failed'));
    }

    // Asked together: the projection of the match waits for the catch-up, which stops.
    const stopping = service.catchUp(ACCOUNT, RUN);
    const next = service.projectMatch(ACCOUNT, oldest);

    await expect(stopping).resolves.toEqual({
      ...NOTHING,
      skipped: FAILURES_IN_A_ROW,
      stoppedBy: 'storage',
    });
    // The oldest match is not one the catch-up reached: the next run projects it.
    await expect(next).resolves.toEqual({ ...NOTHING, projected: 1 });
  });

  it('lets the next projection run after one that rejected', async () => {
    const { reader, metrics, details, yieldToEventLoop, archived } = await setUp();
    const oldest = archived.at(-1) ?? expect.unreachable('the history holds archived matches');
    /** A logger that breaks the contract of its port once: it throws on the first line of an end. */
    class BrokenOnceLogger extends MemoryLogger {
      #broken = false;

      override log(level: LogLevel, scope: string, message: string, logContext?: LogContext): void {
        if (message === 'Projection done' && !this.#broken) {
          this.#broken = true;
          throw new Error('The log is full');
        }
        super.log(level, scope, message, logContext);
      }
    }
    const service = new ProjectionService({
      reader,
      metrics,
      details,
      logger: new BrokenOnceLogger(),
      yieldToEventLoop,
    });

    // Asked together: the catch-up waits for the projection of the match, which rejects once it has
    // projected the match.
    const rejecting = service.projectMatch(ACCOUNT, oldest);
    const next = service.catchUp(ACCOUNT, RUN);

    await expect(rejecting).rejects.toThrow('The log is full');
    // The catch-up ran all the same, on what the run that rejected left, and so does the next one.
    await expect(next).resolves.toEqual({ ...NOTHING, projected: archived.length - 1 });
    await expect(service.catchUp(ACCOUNT, 'run-0002')).resolves.toEqual(NOTHING);
  });
});

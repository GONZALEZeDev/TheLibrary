/**
 * Tests of the projection (`ProjectionService.catchUp`), end to end on the development adapters: the
 * archives are written by the real detail queue, during a synchronisation of the synthetic history,
 * and the metrics are stored in an in-memory database with the real migrations.
 *
 * The synthetic history holds Paige matches the API has a detail for, ranked and unranked ones. A
 * test that needs an archive the projection cannot analyse (or one that lacks some statistics)
 * edits the archive the queue wrote, which keeps the match recorded as archived, exactly like a
 * file the app wrote with an older version would be.
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
import { buildMatchContext } from '../core/analysis/match-context';
import { accuracyMetric } from '../core/analysis/metrics/accuracy.metric';
import { kdaMetric } from '../core/analysis/metrics/kda.metric';
import { projectMetrics, PROJECTION_VERSION } from '../core/analysis/registry';
import type { MatchId } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import { accountFolderName, archivePath } from '../core/match-detail/archive-layout';
import type { LogContext, LogLevel } from '../ports/logger.port';
import { createTestServices } from '../test/create-test-services';
import { DirectCompressor } from '../test/direct-compressor';
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

/** How many values a projection stores: the 24 metrics and the 12 community windows. */
const VALUE_COUNT = 36;

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

/** The synthetic history the synchronisation saves: 30 matches, most recent first. */
const HISTORY = createMatchHistoryFixture({ now: START, count: 30 });

/** The part of a player of an archive that the tests edit. */
interface EditablePlayer {
  account_id: number;
  net_worth?: number;
  abandon_match_time_s?: number;
  player_rank_data?: { initial_display_rank?: number } | null;
  stats?: Record<string, unknown>[];
}

/** The part of an archive file that the tests edit. */
interface EditableEnvelope {
  payload: { match_info: { players: EditablePlayer[] } };
}

/** The players of an archive that a test may edit. */
interface EditablePlayers {
  /** The tracked player. */
  readonly tracked: EditablePlayer;
  /** Another player of the match. */
  readonly other: EditablePlayer;
}

/**
 * Archive the matches of the synthetic history and build the projection like the app does, on the
 * development adapters. The projection reads through its own logger and a clock the test controls:
 * every yield to the event loop moves it forward.
 *
 * @returns The service, the archives it works on and everything a test may inspect or break.
 */
async function setUp() {
  const compressor = new DirectCompressor();
  const { services, database, archiveStore } = createTestServices({
    handler: createFixtureApi({ now: START, matchCount: 30 }),
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
  // The synchronisation that archived them projected them too: forget it, to start unprojected.
  await metrics.deleteAccount(ACCOUNT);
  // The matches the projection has to work on: the archived ones, most recent first.
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
 * The values the registry gives for the archive of a match, which a projection must store.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The values by key.
 */
async function registryValues(context: TestContext, matchId: MatchId) {
  const read = await context.reader.readArchive(ACCOUNT, matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  return projectMetrics(buildMatchContext(read.envelope));
}

/**
 * Edit the archive the queue wrote for a match: the tracked player and another one are edited, and
 * the file is written again. The match stays recorded as archived.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param edit - Edits the players of the archive.
 */
async function editArchive(
  context: TestContext,
  matchId: MatchId,
  edit: (players: EditablePlayers) => void,
): Promise<void> {
  const read = await context.reader.readArchive(ACCOUNT, matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  const envelope = JSON.parse(JSON.stringify(read.envelope)) as EditableEnvelope;
  const { players } = envelope.payload.match_info;
  edit({
    tracked:
      players.find((player) => player.account_id === ACCOUNT) ??
      expect.unreachable('the tracked player is in the match'),
    other:
      players.find((player) => player.account_id !== ACCOUNT) ??
      expect.unreachable('another player is in the match'),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await context.archiveStore.write(ACCOUNT, matchId, await context.compressor.compress(bytes));
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
    // The matches are projected most recent first, and each one is stored as the registry projects it.
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
      expect(values.size).toBe(VALUE_COUNT);
      expect(values).toEqual(await registryValues(context, matchId));
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
      expect(values).toEqual(await registryValues(context, matchId));
    }
    expect(linesOf(logger, 'Projection done')).toHaveLength(1);
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
    expect(values.size).toBe(VALUE_COUNT);
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
    expect((await metrics.getValues(ACCOUNT, ranked)).size).toBe(VALUE_COUNT);
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

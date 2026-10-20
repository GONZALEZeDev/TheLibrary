/**
 * Tests of the synchronisation, end to end on the development adapters: synthetic deadlock-api,
 * in-memory database and archive, memory logger. The services are wired by `createAppServices`,
 * like in the app, through `createTestServices`: the match details are downloaded and archived by
 * the real queue, after the history, and the archived matches are projected by the real projection
 * at the end of the run.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import type { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import {
  AUTOMATIC_HISTORY_RATE_LIMIT,
  HISTORY_RATE_LIMIT,
  METADATA_RATE_LIMIT,
} from '../core/deadlock-api/budgets';
import { AppError, type AppErrorKind } from '../core/errors/app-error';
import type { Database } from '../ports/database.port';
import type { HttpRequest } from '../ports/http-client.port';
import { createTestServices, type TestServicesOptions } from '../test/create-test-services';
import { createTestDatabase, testMatchId } from '../test/test-data';
import { LinkedAccountRepository } from './linked-account.repository';
import { MatchDetailService } from './match-detail.service';
import { MetricsRepository } from './metrics.repository';
import { PlayerRankService, RANK_MAX_AGE_MS } from './player-rank.service';
import { ProjectionService, type ProjectionReport } from './projection.service';
import { isSuspensionRefusal, SYNC_INTERVAL_MS, type SyncService } from './sync.service';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/** The debug line of a synchronisation (or a retry) refused while the account changes. */
const REFUSED_MESSAGE = 'Synchronisation refused while the account changes';

/**
 * Size of the synthetic history of the tests that run the detail queue for real. About a third of
 * the matches are Paige matches to archive (six of these twenty, plus one the API does not hold):
 * enough for the queue to have several matches to hold, give up on or retry, and quick to run, since
 * each archive is compressed for real.
 */
const SMALL_HISTORY = 20;

/** The URL of a match detail request, with the match id captured. */
const METADATA_URL = /\/v1\/matches\/(\d+)\/metadata/;

/**
 * Tell whether a request asks for the match history.
 *
 * @param request - The request.
 * @returns `true` for a match history request.
 */
function isHistoryRequest(request: HttpRequest): boolean {
  return request.url.endsWith('/match-history');
}

/**
 * Tell whether a request asks for the detail of a match.
 *
 * @param request - The request.
 * @returns `true` for a match detail request.
 */
function isMetadataRequest(request: HttpRequest): boolean {
  return METADATA_URL.test(request.url);
}

/**
 * Tell whether a request asks for the rank of a player.
 *
 * @param request - The request.
 * @returns `true` for a player rank request.
 */
function isRankRequest(request: HttpRequest): boolean {
  return request.url.endsWith('/rank');
}

/** What a catch-up that found nothing to do reports. */
const NOTHING_PROJECTED: ProjectionReport = {
  projected: 0,
  failed: 0,
  reset: 0,
  skipped: 0,
  stoppedBy: null,
};

/** What a catch-up that stored the metrics of five matches reports. */
const FIVE_PROJECTED: ProjectionReport = { ...NOTHING_PROJECTED, projected: 5 };

/**
 * Replace the catch-up of the projection, for every service built afterwards, by a fake that
 * reports `report` at once and records its calls. Restored after each test.
 *
 * @param report - What the fake reports.
 * @returns The spy, to read its calls or to change its report.
 */
function fakeCatchUp(report: ProjectionReport = NOTHING_PROJECTED) {
  return vi.spyOn(ProjectionService.prototype, 'catchUp').mockResolvedValue(report);
}

/**
 * Replace the refresh of the rank by a fake that does nothing and records its calls: no rank
 * request is sent. Restored after each test.
 *
 * @returns The spy.
 */
function fakeRankRefresh() {
  return vi.spyOn(PlayerRankService.prototype, 'refreshIfDue').mockResolvedValue(undefined);
}

/**
 * Read the match a detail request asks for.
 *
 * @param url - The URL of a match detail request.
 * @returns The match id.
 */
function matchIdOf(url: string) {
  return testMatchId(Number(METADATA_URL.exec(url)?.[1]));
}

/**
 * Serve the fixtures, except that the network fails for the match details: the history is saved
 * and the details stay `pending`, the queue stopping at its first request without counting it.
 *
 * @param fixtures - The synthetic deadlock-api.
 * @returns The handler.
 */
function detailsUnreachable(fixtures: FixtureHandler): FixtureHandler {
  return (request) => {
    if (isMetadataRequest(request)) {
      throw new AppError('network', 'The network is down');
    }
    return fixtures(request);
  };
}

/**
 * The synthetic deadlock-api with its whole history (240 matches) and no way to the details. For
 * the tests about the history: they do not pay for the archiving of about a hundred details (two
 * seconds), and nothing waits for the rate limit of the details, so the clock of the services stays
 * exactly where the test put it.
 *
 * @returns The handler.
 */
function historyOnlyApi(): FixtureHandler {
  return detailsUnreachable(createFixtureApi({ now: START }));
}

/**
 * The synthetic deadlock-api with a short history ({@link SMALL_HISTORY} matches), details included.
 *
 * @returns The handler.
 */
function smallHistoryApi(): FixtureHandler {
  return createFixtureApi({ now: START, matchCount: SMALL_HISTORY });
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
 * The lines logged when the synchronisations ended, oldest first.
 *
 * @param logger - The logger of the services.
 * @returns The 'Synchronisation ended' lines.
 */
function endedLines(logger: MemoryLogger) {
  return logger.entries.filter((entry) => entry.message === 'Synchronisation ended');
}

/** How {@link createScriptedApi} answers the details it breaks. */
type BrokenAnswer = 'unusable' | 'server_error' | 'healed';

/**
 * A synthetic API that the test scripts, to put matches in the state it needs and to stop the run
 * at the place it needs. It serves the fixtures, except that:
 * - the first `brokenCount` matches whose detail is asked for (the broken ones) are answered as
 *   `control.brokenAnswer` says: `unusable` (a payload the app refuses, so the match becomes
 *   `invalid`), `server_error` (a 500, a counted failure to retry later), or `healed` (the fixture);
 * - the history answers once `control.holdHistory` is settled, the broken details once
 *   `control.holdHealed` is, and the other details once `control.holdOtherDetails` is. The handler
 *   tells the test how many details wait (`whenHeld`), so no test polls the clock.
 *
 * @param fixtures - The synthetic deadlock-api.
 * @param brokenCount - How many matches are broken.
 * @returns The handler, the controls and the helpers of the test.
 */
function createScriptedApi(fixtures: FixtureHandler, brokenCount = 1) {
  const control = {
    brokenUrls: [] as string[],
    brokenAnswer: 'unusable' as BrokenAnswer,
    holdHistory: undefined as Promise<void> | undefined,
    holdHealed: undefined as Promise<void> | undefined,
    holdOtherDetails: undefined as Promise<void> | undefined,
  };
  let held = 0;
  const waiting: { count: number; resolve: () => void }[] = [];
  /**
   * Make a detail request wait for a gate, and tell the tests that wait for a number of held requests.
   *
   * @param gate - The gate, or `undefined` for no waiting.
   */
  const hold = async (gate: Promise<void> | undefined): Promise<void> => {
    if (gate === undefined) {
      return;
    }
    held += 1;
    for (const waiter of waiting) {
      if (held >= waiter.count) {
        waiter.resolve();
      }
    }
    await gate;
  };
  const handler: FixtureHandler = async (request) => {
    if (isHistoryRequest(request)) {
      await control.holdHistory;
      return fixtures(request);
    }
    if (!isMetadataRequest(request)) {
      return fixtures(request);
    }
    if (!control.brokenUrls.includes(request.url) && control.brokenUrls.length < brokenCount) {
      control.brokenUrls.push(request.url);
    }
    if (control.brokenUrls.includes(request.url)) {
      switch (control.brokenAnswer) {
        case 'unusable':
          return jsonResponse({ not: 'a match' });
        case 'server_error':
          return jsonResponse({}, 500);
        case 'healed':
          await hold(control.holdHealed);
          return fixtures(request);
      }
    }
    await hold(control.holdOtherDetails);
    return fixtures(request);
  };
  return {
    handler,
    control,
    /**
     * The broken matches, in the order their details were asked for.
     *
     * @returns Their ids; there are none before the details were asked for.
     */
    brokenMatchIds: () => control.brokenUrls.map(matchIdOf),
    /**
     * The first broken match.
     *
     * @returns Its id.
     * @throws Error when no detail was asked for yet (a mistake in the test).
     */
    brokenMatchId: () => {
      const [url] = control.brokenUrls;
      if (url === undefined) {
        throw new Error('No detail was asked for yet');
      }
      return matchIdOf(url);
    },
    /**
     * Wait until that many details are held (see the controls). Told by the handler, it does not poll.
     *
     * @param count - How many held details to wait for.
     * @returns A promise settled once that many are held.
     */
    whenHeld: (count: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (held >= count) {
          resolve();
        } else {
          waiting.push({ count, resolve });
        }
      }),
  };
}

/**
 * Watch the calls to `syncNow` without changing what it does. A retry calls it once it has reset its
 * match, so a test that waits for the call knows the retry has joined the run going (or started
 * one): it needs no clock.
 *
 * @param sync - The service to watch.
 * @returns `whenCalled`, which resolves once `syncNow` was called that many times since now.
 */
function watchSyncNow(sync: SyncService): { whenCalled: (count: number) => Promise<void> } {
  let calls = 0;
  const waiting: { count: number; resolve: () => void }[] = [];
  const syncNow = sync.syncNow.bind(sync);
  vi.spyOn(sync, 'syncNow').mockImplementation((trigger) => {
    const running = syncNow(trigger);
    calls += 1;
    for (const waiter of waiting) {
      if (calls >= waiter.count) {
        waiter.resolve();
      }
    }
    return running;
  });
  return {
    whenCalled: (count) =>
      new Promise<void>((resolve) => {
        if (calls >= count) {
          resolve();
        } else {
          waiting.push({ count, resolve });
        }
      }),
  };
}

/**
 * The synthetic deadlock-api (the whole history, no way to the details) whose history answer waits
 * for the test, and that tells the test when the history was asked for: a synchronisation is then
 * known to be running, held in its first step, and no test polls the clock to find out.
 *
 * @returns The handler, a promise settled once the history was asked for, and the function that
 *   lets the answer go.
 */
function heldHistoryApi() {
  const asked = createGate();
  const released = createGate();
  const scripted = createScriptedApi(historyOnlyApi(), 0);
  scripted.control.holdHistory = released.opened;
  const handler: FixtureHandler = (request) => {
    if (isHistoryRequest(request)) {
      asked.open();
    }
    return scripted.handler(request);
  };
  return { handler, historyAsked: asked.opened, release: released.open };
}

/**
 * Wait for the end of the next synchronisation, as the service itself tells it: no timer is read,
 * so it works under fake timers and moves no fake clock. Call it before the run starts.
 *
 * @param sync - The service to watch.
 * @returns A promise resolved once a synchronisation has ended.
 */
function whenNextRunEnds(sync: SyncService): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = sync.subscribe(() => {
      if (!sync.isRunning()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Let the pending work of the other promises run (a macrotask later), so that whatever could
 * settle by itself has settled. Real timers only.
 *
 * @returns A promise resolved after a timer of 0 ms.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Options of {@link setUp}: those of `createTestServices`, except the settings, which the
 * synchronisation does not use. `handler` gives the first answers of the returned
 * `answer.handler` (the fixture API of 240 matches by default);
 * `now`, when given, replaces the controllable `clock` for every service, which then has no effect.
 * Either way it is the base clock of the services: the time they wait for the rate limit of the
 * match details is added to it (see `TestServices.skippedMs`).
 */
type SetUpOptions = Omit<TestServicesOptions, 'settingsStore'>;

/**
 * Build the synchronisation exactly like the app (through `createTestServices`), with a
 * controllable clock and handler.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The service and everything a test may inspect or change.
 */
function setUp(options: SetUpOptions = {}) {
  const clock = { now: START };
  const answer = { handler: options.handler ?? createFixtureApi({ now: START }) };
  const { services, http, logger, archiveStore, skippedMs } = createTestServices({
    ...options,
    handler: (request) => answer.handler(request),
    now: options.now ?? (() => clock.now),
  });
  /**
   * Number of matches stored for the linked account. Read through the matches service, whose total
   * counts them whatever the limit, so no repository is built by hand; no clock is read.
   */
  const countMatches = async () => (await services.matches.listRecent(0)).total;
  /** The requests for the match history, among all the requests received so far. */
  const historyRequests = () => http.requests.filter(isHistoryRequest);
  /** The requests for the detail of a match, among all the requests received so far. */
  const metadataRequests = () => http.requests.filter(isMetadataRequest);
  return {
    sync: services.sync,
    services,
    http,
    logger,
    archiveStore,
    clock,
    answer,
    countMatches,
    historyRequests,
    metadataRequests,
    skippedMs,
  };
}

/**
 * A clock for fake timers that is a few milliseconds late, like the time a service reads after a
 * database round trip. The delay is not cumulative: it depends on the current fake minute, so it
 * differs from one synchronisation to the next, and the startup reading (minute 0) is the slowest,
 * as a cold database access is. So the startup request is dated 8 ms after its schedule, more than
 * a tick made exactly one hour later (with an interval that divides the hour) is after its own, and
 * it stays inside that tick's window: the failure to reproduce.
 *
 * @returns A function reading the fake `Date.now()`, 1 to 8 ms late.
 */
function createLateClock(): () => number {
  return () => {
    const fakeNow = Date.now();
    const minute = Math.floor((fakeNow - START) / 60_000);
    return fakeNow + (minute === 0 ? 8 : 1 + (minute % 7));
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SyncService', () => {
  it('saves the whole history at the first synchronisation, then only adds new matches', async () => {
    const { sync, countMatches, clock } = setUp({ handler: historyOnlyApi() });

    await sync.syncNow('startup');
    const first = await sync.getStatus();
    clock.now += SYNC_INTERVAL_MS;
    await sync.syncNow('schedule');

    expect(first.lastSync).toEqual({
      finishedAt: START,
      outcome: 'synced',
      errorKind: null,
      newMatches: 240,
      historyFetchedAt: START,
      historyFromSteam: true,
    });
    await expect(countMatches()).resolves.toBe(240);
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'synced', newMatches: 0, historyFetchedAt: START + SYNC_INTERVAL_MS },
    });
  });

  it('runs one synchronisation at a time: a trigger during a running one joins it', async () => {
    const { sync, historyRequests } = setUp({ handler: historyOnlyApi() });

    const first = sync.syncNow('startup');
    const second = sync.syncNow('manual');

    expect(sync.isRunning()).toBe(true);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(sync.isRunning()).toBe(false);
    expect(historyRequests()).toHaveLength(1);
  });

  it('logs a join, with the id of the run joined and the trigger of the caller', async () => {
    const { sync, logger } = setUp({ handler: historyOnlyApi() });

    const first = sync.syncNow('startup');
    const second = sync.syncNow('manual');
    await Promise.all([first, second]);

    // The run logged its own start and end; the joiner left nothing until now.
    const started = logger.entries.find((entry) => entry.message === 'Synchronisation started');
    expect(started?.context.trigger).toBe('startup');
    expect(logger.entries.filter((entry) => entry.message === 'Synchronisation joined')).toEqual([
      {
        level: 'debug',
        scope: 'sync',
        message: 'Synchronisation joined',
        context: { syncRunId: started?.context.syncRunId, trigger: 'manual' },
      },
    ]);
    expect(endedLines(logger)).toHaveLength(1);
  });

  it('tells its listeners when a synchronisation starts and ends, and when its history is saved', async () => {
    // No way to the details: nothing is archived, and no other notification comes.
    const { sync } = setUp({ handler: historyOnlyApi() });
    const states: boolean[] = [];
    const unsubscribe = sync.subscribe(() => states.push(sync.isRunning()));

    await sync.syncNow('manual');
    unsubscribe();
    await sync.syncNow('manual');

    // The start, the history saved (before the details are downloaded), the end.
    expect(states).toEqual([true, true, false]);
  });

  it('keeps synchronising and informing the other listeners when a listener fails', async () => {
    const { sync, logger } = setUp({ handler: historyOnlyApi() });
    const states: boolean[] = [];
    sync.subscribe(() => {
      throw new Error('broken listener');
    });
    sync.subscribe(() => states.push(sync.isRunning()));

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();

    expect(states).toEqual([true, true, false]);
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'A listener of the synchronisation failed',
      }),
    );
  });

  it('does nothing without a linked account and logs nothing above debug', async () => {
    const { sync, http, logger } = setUp({ accountId: null });

    await sync.syncNow('manual');

    expect(http.requests).toHaveLength(0);
    expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
    await expect(sync.getStatus()).resolves.toEqual({
      accountLinked: false,
      lastSync: null,
      pausedUntil: null,
      protectedAccount: false,
    });
  });

  it('records a stored history (429 with data) as possibly incomplete', async () => {
    const { sync } = setUp({ handler: () => jsonResponse([], 429, { 'called-steam': 'false' }) });

    await sync.syncNow('manual');

    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'synced', historyFromSteam: false },
    });
  });

  it('stops when the budget is exhausted, without an error, and keeps the last download time', async () => {
    const { sync, clock, historyRequests } = setUp({ handler: historyOnlyApi() });
    for (let index = 0; index < 7; index += 1) {
      clock.now = START + index * 60_000;
      await sync.syncNow('schedule');
    }

    expect(historyRequests()).toHaveLength(6);
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: {
        outcome: 'budget_exhausted',
        errorKind: null,
        historyFetchedAt: START + 5 * 60_000,
      },
    });
  });

  it('respects the pause deadlock-api asks for, across a restart, and shows it', async () => {
    const database = createTestDatabase();
    const first = setUp({
      database,
      handler: () => jsonResponse({ status: 429 }, 429, { 'retry-after': '600' }),
    });
    await first.sync.syncNow('manual');

    const restarted = setUp({ database });
    restarted.clock.now = START + 60_000;
    await restarted.sync.syncNow('startup');

    expect(restarted.http.requests).toHaveLength(0);
    await expect(restarted.sync.getStatus()).resolves.toMatchObject({
      pausedUntil: START + 600_000,
      lastSync: { outcome: 'paused' },
    });
  });

  it('stops the automatic synchronisations of a protected account until the user retries', async () => {
    const { sync, historyRequests, answer } = setUp({ handler: () => jsonResponse({}, 403) });

    await sync.syncNow('startup');
    await sync.syncNow('schedule');
    expect(historyRequests()).toHaveLength(1);
    await expect(sync.getStatus()).resolves.toMatchObject({
      protectedAccount: true,
      lastSync: { outcome: 'failed', errorKind: 'forbidden' },
    });

    answer.handler = historyOnlyApi();
    await sync.syncNow('manual');

    expect(historyRequests()).toHaveLength(2);
    await expect(sync.getStatus()).resolves.toMatchObject({
      protectedAccount: false,
      lastSync: { outcome: 'synced' },
    });
  });

  it('runs a link synchronisation like a request of the user: a protected account still gets its history', async () => {
    const { sync, historyRequests, answer, logger } = setUp({
      handler: () => jsonResponse({}, 403),
    });
    await sync.syncNow('startup');
    await expect(sync.getStatus()).resolves.toMatchObject({ protectedAccount: true });
    answer.handler = historyOnlyApi();

    // The timer stays quiet on a protected account; the first synchronisation after a link does not.
    await sync.syncNow('schedule');
    expect(historyRequests()).toHaveLength(1);
    await sync.syncNow('link');

    expect(historyRequests()).toHaveLength(2);
    await expect(sync.getStatus()).resolves.toMatchObject({
      protectedAccount: false,
      lastSync: { outcome: 'synced', newMatches: 240 },
    });
    expect(endedLines(logger).at(-1)?.context).toMatchObject({
      trigger: 'link',
      outcome: 'synced',
    });
  });

  it('does not hold a link synchronisation to the automatic part of the history budget', async () => {
    const { sync, clock, historyRequests } = setUp({ handler: historyOnlyApi() });
    for (let index = 0; index <= AUTOMATIC_HISTORY_RATE_LIMIT.limit; index += 1) {
      clock.now = START + index * 60_000;
      await sync.syncNow('schedule');
    }
    expect(historyRequests()).toHaveLength(AUTOMATIC_HISTORY_RATE_LIMIT.limit);
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'budget_exhausted' },
    });

    clock.now = START + (AUTOMATIC_HISTORY_RATE_LIMIT.limit + 1) * 60_000;
    await sync.syncNow('link');

    expect(historyRequests()).toHaveLength(AUTOMATIC_HISTORY_RATE_LIMIT.limit + 1);
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
  });

  it('records a failure, logs it once with the id of the synchronisation, and keeps the data', async () => {
    const api = historyOnlyApi();
    const { sync, logger, countMatches, clock, answer } = setUp({ handler: api });
    await sync.syncNow('startup');
    answer.handler = (request) =>
      isHistoryRequest(request) ? jsonResponse({}, 500) : api(request);
    clock.now += SYNC_INTERVAL_MS;

    await sync.syncNow('schedule');

    const failures = logger.entries.filter((entry) => entry.level === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      scope: 'sync',
      message: 'Synchronisation failed',
      context: { kind: 'service_unavailable', syncRunId: expect.any(String) as unknown },
    });
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'failed', errorKind: 'service_unavailable', historyFetchedAt: START },
    });
    await expect(countMatches()).resolves.toBe(240);
  });

  it('never writes the account id in the logs, even when the network error quotes the URL', async () => {
    const { sync, logger } = setUp({
      handler: () => {
        throw new AppError('network', 'The request failed', {
          cause: `error sending request for url (https://api.deadlock-api.com/v1/players/${String(FIXTURE_ACCOUNT_ID)}/match-history)`,
        });
      },
    });

    await sync.syncNow('manual');

    expect(logger.entries.some((entry) => entry.level === 'error')).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('never rejects, even when the database fails', async () => {
    const broken: Database = {
      execute: () => Promise.reject(new Error('disk I/O error')),
      select: () => Promise.reject(new Error('disk I/O error')),
    };
    const { sync, logger } = setUp({ database: broken });

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Synchronisation failed',
        context: expect.objectContaining({ kind: 'storage' }) as unknown,
      }),
    );
  });

  it('synchronises at start, then on its timer until stopped', async () => {
    vi.useFakeTimers();
    const { sync, historyRequests, clock } = setUp({ handler: historyOnlyApi() });

    sync.start();
    sync.start();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });
    clock.now += SYNC_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(historyRequests()).toHaveLength(2);
    });
    sync.stop();
    await vi.advanceTimersByTimeAsync(3 * SYNC_INTERVAL_MS);

    expect(historyRequests()).toHaveLength(2);
  });

  it('leaves room in the automatic budget for its timer and one manual synchronisation', () => {
    // The floor counts the earlier automatic synchronisations a tick finds in its window, including
    // one that timing noise may keep at the edge of the window; the + 1 is one manual
    // synchronisation, which the automatic budget counts too.
    const earlierAutomaticInWindow = Math.floor(
      AUTOMATIC_HISTORY_RATE_LIMIT.windowMs / SYNC_INTERVAL_MS,
    );

    expect(earlierAutomaticInWindow + 1).toBeLessThan(AUTOMATIC_HISTORY_RATE_LIMIT.limit);
  });

  it('never refuses an automatic synchronisation over a day, with timing noise and one manual synchronisation per hour', async () => {
    const hours = 24;
    const { sync, historyRequests, logger, countMatches } = setUp({
      now: createLateClock(),
      // A one-match history: the budget does not depend on its size, and a day of synchronisations
      // of the default 240 matches would take seconds. Its detail, if the match has one, is asked
      // for by the queue too: the requests of the history are the ones counted.
      handler: createFixtureApi({ now: START, matchCount: 1 }),
    });
    // Open the database before faking the timers: sql.js loads its WebAssembly file with real I/O,
    // which fake timers do not wait for, so the first ticks would join a startup synchronisation
    // still waiting for it. `countMatches` does not read the clock.
    await countMatches();
    vi.useFakeTimers({ now: START });

    const startupEnded = whenNextRunEnds(sync);
    sync.start();
    // The startup synchronisation ended at START, before the first tick. It is waited for through
    // the service, not through the fake timers: its archives are compressed and read back by a
    // codec that needs real time to start, which a fake timer does not wait for, and a wait that
    // moved the fake clock would move the dates of the requests too.
    await startupEnded;
    expect(sync.isRunning()).toBe(false);
    for (let hour = 0; hour < hours; hour += 1) {
      // The manual synchronisation falls half a minute after the half hour: whole-minute ticks
      // never coincide with it, so it always falls between two ticks.
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 30_000);
      await sync.syncNow('manual');
      await vi.advanceTimersByTimeAsync(29 * 60_000 + 30_000);
    }
    sync.stop();

    // Every synchronisation logs how it ended; a refusal by the budget is one of the outcomes.
    const outcomes = logger.entries
      .filter((entry) => entry.message === 'Synchronisation ended')
      .map((entry) => entry.context.outcome);
    expect(outcomes.filter((outcome) => outcome === 'budget_exhausted')).toHaveLength(0);
    // And each of them sent its request: the startup one, one manual one per hour and every tick.
    expect(historyRequests()).toHaveLength(
      1 + hours + Math.floor((hours * 60 * 60_000) / SYNC_INTERVAL_MS),
    );
  });
});

describe('SyncService and the detail queue', () => {
  it('archives the match details after the history', async () => {
    const { sync, services, http, logger, archiveStore, historyRequests, metadataRequests } = setUp(
      {
        handler: smallHistoryApi(),
      },
    );

    await sync.syncNow('manual');

    const summary = await services.details.getSummary();
    expect(summary?.archived).toBeGreaterThan(0);
    // The files are there: one per archived match, and the quarantine holds nothing.
    expect(
      [...archiveStore.files.keys()].filter((path) => path.endsWith('.json.zst')),
    ).toHaveLength(summary?.archived ?? -1);
    // The history comes first, then the rank (once), then nothing but details.
    const rankRequests = http.requests.filter(isRankRequest);
    expect(rankRequests).toHaveLength(1);
    expect(http.requests.slice(0, 2)).toEqual([...historyRequests(), ...rankRequests]);
    expect(http.requests.slice(2)).toEqual(metadataRequests());
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
    // One line says how the whole synchronisation went, and carries the same id as the queue's.
    // The matches it archived were analysed at its end.
    const [ended, ...others] = endedLines(logger);
    expect(others).toEqual([]);
    expect(ended?.context).toEqual({
      syncRunId: expect.any(String) as unknown,
      trigger: 'manual',
      outcome: 'synced',
      durationMs: expect.any(Number) as unknown,
      archived: summary?.archived,
      detailStoppedBy: null,
      projected: summary?.archived,
    });
    const queueEnded = logger.entries.find((entry) => entry.message === 'Detail queue ended');
    expect(queueEnded?.context.syncRunId).toBe(ended?.context.syncRunId);
  });

  it('tells its listeners that the history is saved while the queue is still going', async () => {
    const gate = createGate();
    const { handler, control, whenHeld } = createScriptedApi(smallHistoryApi(), 0);
    // Every detail waits for the test: the run is held in its queue.
    control.holdOtherDetails = gate.opened;
    const { sync, services } = setUp({ handler });
    const states: boolean[] = [];
    const totals: Promise<number>[] = [];
    sync.subscribe(() => {
      states.push(sync.isRunning());
      // What the interface does: read the matches again.
      totals.push(services.matches.listRecent(0).then((recent) => recent.total));
    });

    const run = sync.syncNow('manual');
    await whenHeld(1);

    // The queue has asked for its first detail, so the history step is over, and the second
    // notification came before it: the matches are there to be read while the details download.
    expect(sync.isRunning()).toBe(true);
    expect(states).toEqual([true, true]);
    expect((await Promise.all(totals)).at(-1)).toBe(SMALL_HISTORY);
    gate.open();
    await run;
    // Then the matches the queue archived are analysed, which is told, and the run ends.
    expect(states).toEqual([true, true, true, false]);
  });

  it('runs the queue when the history budget is exhausted', async () => {
    const fixtures = smallHistoryApi();
    // The network fails for the details: each synchronisation uses one history request and leaves
    // the matches pending. The clock is fixed, so they all fall in the same hour.
    const { sync, services, answer, logger, historyRequests } = setUp({
      handler: detailsUnreachable(fixtures),
    });
    for (let attempt = 0; attempt < HISTORY_RATE_LIMIT.limit; attempt += 1) {
      await sync.syncNow('manual');
    }
    await expect(services.details.getSummary()).resolves.toMatchObject({ archived: 0 });
    answer.handler = fixtures;

    await sync.syncNow('manual');

    // The last synchronisation could not ask for the history, but it archived the details.
    expect(historyRequests()).toHaveLength(HISTORY_RATE_LIMIT.limit);
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'budget_exhausted' },
    });
    const summary = await services.details.getSummary();
    expect(summary?.archived).toBeGreaterThan(0);
    expect(endedLines(logger).at(-1)?.context).toMatchObject({
      outcome: 'budget_exhausted',
      archived: summary?.archived,
      detailStoppedBy: null,
    });
  });

  it('does not run the queue when the network is down', async () => {
    const fixtures = smallHistoryApi();
    // Some details are pending, so a queue that ran would have something to ask for.
    const { sync, answer, http, logger } = setUp({ handler: detailsUnreachable(fixtures) });
    await sync.syncNow('manual');
    const requestsBefore = http.requests.length;
    answer.handler = () => {
      throw new AppError('network', 'The network is down');
    };
    const states: boolean[] = [];
    sync.subscribe(() => states.push(sync.isRunning()));

    await sync.syncNow('manual');

    // The history request is the only one tried: the queue would have sent a second one.
    expect(http.requests).toHaveLength(requestsBefore + 1);
    // Nothing was saved but the failure, which the end of the run shows: no notification between.
    expect(states).toEqual([true, false]);
    expect(logger.entries.filter((entry) => entry.message === 'Detail queue ended')).toHaveLength(
      1,
    );
    // The line says nothing of the queue, which did not run, and the failure is the history's.
    expect(endedLines(logger).at(-1)?.context).toEqual({
      syncRunId: expect.any(String) as unknown,
      trigger: 'manual',
      outcome: 'failed',
      durationMs: expect.any(Number) as unknown,
    });
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'failed', errorKind: 'network' },
    });
  });

  it('does not run the queue when the history request times out', async () => {
    const fixtures = smallHistoryApi();
    const { sync, answer, http } = setUp({ handler: detailsUnreachable(fixtures) });
    await sync.syncNow('manual');
    const requestsBefore = http.requests.length;
    answer.handler = () => {
      throw new AppError('timeout', 'The request timed out');
    };

    await sync.syncNow('manual');

    expect(http.requests).toHaveLength(requestsBefore + 1);
  });

  it('runs the queue after a history that failed for another reason', async () => {
    const fixtures = smallHistoryApi();
    // The history is saved and the details are pending; then the history fails (a 500), the
    // details do not: the failure says nothing of the network the details go through.
    const { sync, services, answer, logger } = setUp({ handler: detailsUnreachable(fixtures) });
    await sync.syncNow('manual');
    answer.handler = (request) =>
      isHistoryRequest(request) ? jsonResponse({}, 500) : fixtures(request);

    await sync.syncNow('manual');

    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'failed', errorKind: 'service_unavailable' },
    });
    const summary = await services.details.getSummary();
    expect(summary?.archived).toBeGreaterThan(0);
    expect(endedLines(logger).at(-1)?.context).toMatchObject({
      outcome: 'failed',
      archived: summary?.archived,
    });
  });

  it('does not request the history on a detail run', async () => {
    const fixtures = smallHistoryApi();
    const { sync, services, answer, http, logger, historyRequests } = setUp({
      handler: detailsUnreachable(fixtures),
    });
    await sync.syncNow('manual');
    const statusBefore = await sync.getStatus();
    answer.handler = fixtures;
    const requestsBefore = http.requests.length;
    const states: boolean[] = [];
    sync.subscribe(() => states.push(sync.isRunning()));

    await sync.syncNow('detail');

    // Not a single history request, and nothing the history banner reads has changed.
    expect(historyRequests()).toHaveLength(1);
    await expect(sync.getStatus()).resolves.toEqual(statusBefore);
    // The run sent details and nothing else: at least one request per match it archived.
    const summary = await services.details.getSummary();
    expect(summary?.archived).toBeGreaterThan(0);
    const requestsOfTheRun = http.requests.slice(requestsBefore);
    expect(requestsOfTheRun.every(isMetadataRequest)).toBe(true);
    expect(requestsOfTheRun.length).toBeGreaterThanOrEqual(summary?.archived ?? Infinity);
    // No history step, so nothing to show before the queue: the start, the matches it archived
    // analysed, and the end.
    expect(states).toEqual([true, true, false]);
    // The line names the run for what it is: no history outcome to report.
    expect(endedLines(logger).at(-1)?.context).toEqual({
      syncRunId: expect.any(String) as unknown,
      trigger: 'detail',
      outcome: 'detail_only',
      durationMs: expect.any(Number) as unknown,
      archived: summary?.archived,
      detailStoppedBy: null,
      projected: summary?.archived,
    });
  });

  it('treats a detail run as the request of the user: a protected account still runs it', async () => {
    const fixtures = smallHistoryApi();
    const unreachable = detailsUnreachable(fixtures);
    const { sync, services, answer, clock, logger, historyRequests } = setUp({
      handler: unreachable,
    });
    await sync.syncNow('manual');
    // The history is now private: the account becomes protected, which only 'manual' can undo.
    answer.handler = (request) =>
      isHistoryRequest(request) ? jsonResponse({}, 403) : unreachable(request);
    clock.now += SYNC_INTERVAL_MS;
    await sync.syncNow('manual');
    const protectedStatus = await sync.getStatus();
    expect(protectedStatus.protectedAccount).toBe(true);
    answer.handler = fixtures;
    clock.now += SYNC_INTERVAL_MS;

    // The automatic synchronisations of a protected account do nothing at all, details included.
    await sync.syncNow('startup');
    await sync.syncNow('schedule');
    await expect(services.details.getSummary()).resolves.toMatchObject({ archived: 0 });
    await sync.syncNow('detail');

    expect((await services.details.getSummary())?.archived).toBeGreaterThan(0);
    // The history state is as the failed manual synchronisation left it, and no history was asked.
    await expect(sync.getStatus()).resolves.toEqual(protectedStatus);
    expect(historyRequests()).toHaveLength(2);
    expect(endedLines(logger).map((entry) => entry.level)).toEqual([
      'info', // The first manual synchronisation.
      'info', // The manual one that found the account protected.
      'debug', // 'startup' and 'schedule': no request sent.
      'debug',
      'info', // The detail run.
    ]);
  });

  it('does nothing on a detail run without a linked account', async () => {
    const { sync, http, logger } = setUp({ accountId: null });

    await sync.syncNow('detail');

    expect(http.requests).toHaveLength(0);
    expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
  });

  it('gives a trigger that joins a detail run no history step, and logs the join', async () => {
    const gate = createGate();
    const scripted = createScriptedApi(smallHistoryApi(), 0);
    const { sync, answer, logger, historyRequests } = setUp({
      handler: detailsUnreachable(smallHistoryApi()),
    });
    await sync.syncNow('manual');
    // The next run is held in its queue by the details of the matches that are pending.
    answer.handler = scripted.handler;
    scripted.control.holdOtherDetails = gate.opened;
    const detailRun = sync.syncNow('detail');
    await scripted.whenHeld(1);

    const joiner = sync.syncNow('schedule');
    gate.open();
    await Promise.all([detailRun, joiner]);

    // The joiner is that run: one more synchronisation ended, and no history was asked for.
    expect(joiner).toBe(detailRun);
    expect(historyRequests()).toHaveLength(1);
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual', 'detail']);
    const started = logger.entries.findLast((entry) => entry.message === 'Synchronisation started');
    expect(logger.entries.filter((entry) => entry.message === 'Synchronisation joined')).toEqual([
      {
        level: 'debug',
        scope: 'sync',
        message: 'Synchronisation joined',
        context: { syncRunId: started?.context.syncRunId, trigger: 'schedule' },
      },
    ]);
  });

  it('never rejects when the queue fails', async () => {
    const { sync, archiveStore, logger, countMatches } = setUp({
      handler: smallHistoryApi(),
    });
    // The disk fails when the first archive is written: the queue stops, it does not throw.
    archiveStore.failNextWrite(new Error('disk full'));

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();

    // The history it saved is kept, and the line tells why the queue stopped.
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
    await expect(countMatches()).resolves.toBe(SMALL_HISTORY);
    expect(endedLines(logger).at(-1)?.context).toMatchObject({
      outcome: 'synced',
      detailStoppedBy: 'storage',
    });
  });

  it('never rejects when the queue itself throws, and still reports the history', async () => {
    vi.spyOn(MatchDetailService.prototype, 'runQueue').mockRejectedValue(new Error('a bug'));
    const { sync, logger } = setUp({
      handler: smallHistoryApi(),
    });

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();

    // The history is not blamed for it: it was saved and the line says so.
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
    expect(endedLines(logger).at(-1)?.context).toEqual({
      syncRunId: expect.any(String) as unknown,
      trigger: 'manual',
      outcome: 'synced',
      durationMs: expect.any(Number) as unknown,
    });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        scope: 'sync',
        message: 'The detail queue failed',
      }),
    );
  });

  it('stops the queue on the pause the history step saved, sending no detail request', async () => {
    const fixtures = smallHistoryApi();
    const { sync, answer, http, logger } = setUp({ handler: detailsUnreachable(fixtures) });
    await sync.syncNow('manual');
    const requestsBefore = http.requests.length;
    answer.handler = (request) =>
      isHistoryRequest(request)
        ? jsonResponse({}, 429, { 'retry-after': '600' })
        : fixtures(request);

    await sync.syncNow('manual');

    // The queue goes through the same API service as the history: it saw the pause the history
    // asked for, and gave up before its first request, which the fixtures would have answered.
    expect(http.requests).toHaveLength(requestsBefore + 1);
    expect(endedLines(logger).at(-1)?.context).toMatchObject({
      outcome: 'paused',
      archived: 0,
      detailStoppedBy: 'paused',
    });
  });

  it('shares the pause a detail answer asked for with the history', async () => {
    const fixtures = smallHistoryApi();
    const { sync, answer, clock, historyRequests } = setUp({
      handler: (request) =>
        isMetadataRequest(request)
          ? jsonResponse({}, 429, { 'retry-after': '600' })
          : fixtures(request),
    });
    await sync.syncNow('manual');
    answer.handler = fixtures;
    clock.now += 60_000;

    await sync.syncNow('manual');

    // The queue was asked to pause, so the next synchronisation did not even ask for the history.
    expect(historyRequests()).toHaveLength(1);
    await expect(sync.getStatus()).resolves.toMatchObject({
      pausedUntil: START + 600_000,
      lastSync: { outcome: 'paused' },
    });
  });

  it('keeps the rate limit of the match details, in virtual time rather than by waiting', async () => {
    const { sync, metadataRequests, skippedMs } = setUp({
      handler: smallHistoryApi(),
    });

    await sync.syncNow('manual');

    // Five requests fit in each second of the clock the services read: the others waited for it,
    // and the test clock jumped over the wait.
    const requests = metadataRequests().length;
    expect(requests).toBeGreaterThan(METADATA_RATE_LIMIT.limit);
    expect(skippedMs()).toBeGreaterThanOrEqual(
      Math.floor((requests - 1) / METADATA_RATE_LIMIT.limit) * METADATA_RATE_LIMIT.windowMs,
    );
  });
});

describe('SyncService and the analysis', () => {
  it('projects the archived matches after the queue, and tells its listeners', async () => {
    const database = createTestDatabase();
    const { sync, services, logger } = setUp({ database, handler: smallHistoryApi() });
    const states: boolean[] = [];
    sync.subscribe(() => states.push(sync.isRunning()));

    await sync.syncNow('manual');

    const archived = (await services.details.getSummary())?.archived ?? 0;
    expect(archived).toBeGreaterThan(0);
    // Every archived match is analysed by the end of the run that archived it.
    const metrics = new MetricsRepository(database);
    await expect(metrics.listToProject(FIXTURE_ACCOUNT_ID, PROJECTION_VERSION)).resolves.toEqual(
      [],
    );
    await expect(metrics.countAccount(FIXTURE_ACCOUNT_ID)).resolves.toBeGreaterThan(0);
    // The projection came after the queue, as part of the run: its line carries the id of the run.
    const lineIndex = (message: string) =>
      logger.entries.findIndex((entry) => entry.message === message);
    expect(lineIndex('Projection done')).toBeGreaterThan(lineIndex('Detail queue ended'));
    const started = logger.entries.find((entry) => entry.message === 'Synchronisation started');
    expect(logger.entries[lineIndex('Projection done')]?.context.syncRunId).toBe(
      started?.context.syncRunId,
    );
    expect(endedLines(logger).at(-1)?.context).toMatchObject({ archived, projected: archived });
    // The start, the history saved, the matches analysed, the end.
    expect(states).toEqual([true, true, true, false]);
  });

  it('refreshes the rank after the history and before the queue, and projects after the queue', async () => {
    const order: string[] = [];
    // Several requests of the queue in a row make one step.
    const record = (step: string): void => {
      if (order.at(-1) !== step) {
        order.push(step);
      }
    };
    vi.spyOn(ProjectionService.prototype, 'catchUp').mockImplementation(() => {
      record('catch-up');
      return Promise.resolve(NOTHING_PROJECTED);
    });
    vi.spyOn(PlayerRankService.prototype, 'refreshIfDue').mockImplementation(() => {
      record('rank');
      return Promise.resolve();
    });
    const fixtures = smallHistoryApi();
    const { sync } = setUp({
      handler: (request) => {
        if (isHistoryRequest(request)) {
          record('history');
        } else if (isMetadataRequest(request)) {
          record('details');
        }
        return fixtures(request);
      },
    });

    await sync.syncNow('manual');

    // The projection is the last step of the run, once.
    expect(order).toEqual(['history', 'rank', 'details', 'catch-up']);
  });

  it('projects in a detail run too, after its queue', async () => {
    const database = createTestDatabase();
    const fixtures = smallHistoryApi();
    const { sync, answer, services, logger } = setUp({
      database,
      handler: detailsUnreachable(fixtures),
    });
    await sync.syncNow('manual');
    answer.handler = fixtures;

    // A detail run archives the matches the history left pending.
    await sync.syncNow('detail');

    const archived = (await services.details.getSummary())?.archived ?? 0;
    expect(archived).toBeGreaterThan(0);
    const metrics = new MetricsRepository(database);
    await expect(metrics.listToProject(FIXTURE_ACCOUNT_ID, PROJECTION_VERSION)).resolves.toEqual(
      [],
    );
    expect(endedLines(logger).at(-1)?.context).toMatchObject({
      trigger: 'detail',
      archived,
      projected: archived,
    });
  });

  it('projects nothing the second time: the matches of the first run are analysed already', async () => {
    const { sync, clock, logger } = setUp({ handler: smallHistoryApi() });
    await sync.syncNow('manual');
    const catchUp = vi.spyOn(ProjectionService.prototype, 'catchUp');
    const states: boolean[] = [];
    sync.subscribe(() => states.push(sync.isRunning()));
    clock.now += SYNC_INTERVAL_MS;

    await sync.syncNow('schedule');

    // The run asked for the projection, which found nothing to do...
    expect(catchUp).toHaveBeenCalledTimes(1);
    await expect(catchUp.mock.results[0]?.value).resolves.toEqual(NOTHING_PROJECTED);
    // ...so there is nothing more to tell than the history saved, and no count in the line.
    expect(states).toEqual([true, true, false]);
    expect(endedLines(logger).at(-1)?.context).not.toHaveProperty('projected');
  });

  it('projects offline: the matches already archived are analysed whatever the network does', async () => {
    const database = createTestDatabase();
    const { sync, answer, http, logger } = setUp({ database, handler: smallHistoryApi() });
    await sync.syncNow('manual');
    // Forget the projections but keep the archives, as after a new version of the projection: the
    // matches are archived and not projected.
    const metrics = new MetricsRepository(database);
    await metrics.deleteAccount(FIXTURE_ACCOUNT_ID);
    const toProject = await metrics.listToProject(FIXTURE_ACCOUNT_ID, PROJECTION_VERSION);
    expect(toProject.length).toBeGreaterThan(0);
    answer.handler = () => {
      throw new AppError('network', 'The network is down');
    };
    const requestsBefore = http.requests.length;
    const rank = vi.spyOn(PlayerRankService.prototype, 'refreshIfDue');

    await sync.syncNow('manual');

    // The history is the only request tried, and neither the rank nor the queue followed it...
    expect(http.requests).toHaveLength(requestsBefore + 1);
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'failed', errorKind: 'network' },
    });
    expect(rank).not.toHaveBeenCalled();
    // ...but the run still projected, from the files only.
    await expect(metrics.listToProject(FIXTURE_ACCOUNT_ID, PROJECTION_VERSION)).resolves.toEqual(
      [],
    );
    expect(endedLines(logger).at(-1)?.context).toEqual({
      syncRunId: expect.any(String) as unknown,
      trigger: 'manual',
      outcome: 'failed',
      durationMs: expect.any(Number) as unknown,
      projected: toProject.length,
    });
  });

  it.each([
    {
      label: 'the automatic run of a protected account',
      handler: () => jsonResponse({}, 403),
      // The first run finds the account protected; the automatic one after it sends nothing.
      triggers: ['startup', 'schedule'],
      outcome: 'protected_account',
    },
    {
      label: 'a history that does not reach deadlock-api (network)',
      handler: () => {
        throw new AppError('network', 'The request failed');
      },
      triggers: ['manual'],
      outcome: 'failed',
    },
    {
      label: 'a history that does not reach deadlock-api (timeout)',
      handler: () => {
        throw new AppError('timeout', 'The request timed out');
      },
      triggers: ['manual'],
      outcome: 'failed',
    },
    {
      label: 'a history deadlock-api asks to pause',
      handler: () => jsonResponse({}, 429, { 'retry-after': '600' }),
      triggers: ['manual'],
      outcome: 'paused',
    },
    {
      label: 'a history its budget refuses',
      handler: historyOnlyApi(),
      // Every automatic history request the budget allows, then one more.
      triggers: Array.from(
        { length: AUTOMATIC_HISTORY_RATE_LIMIT.limit + 1 },
        () => 'schedule' as const,
      ),
      outcome: 'budget_exhausted',
    },
  ] as const)('projects at the end of a run that ends early: $label', async (scenario) => {
    const catchUp = fakeCatchUp(FIVE_PROJECTED);
    fakeRankRefresh();
    const { sync, logger } = setUp({ handler: scenario.handler });

    for (const trigger of scenario.triggers) {
      await sync.syncNow(trigger);
    }

    // Every run projected once, for the account and tied to the run; the last one ended early.
    expect(catchUp).toHaveBeenCalledTimes(scenario.triggers.length);
    const started = logger.entries.findLast((entry) => entry.message === 'Synchronisation started');
    expect(catchUp.mock.calls.at(-1)).toEqual([FIXTURE_ACCOUNT_ID, started?.context.syncRunId]);
    expect(endedLines(logger).at(-1)?.context).toMatchObject({
      syncRunId: started?.context.syncRunId,
      outcome: scenario.outcome,
      projected: FIVE_PROJECTED.projected,
    });
  });

  it.each([
    ['projected', { ...NOTHING_PROJECTED, projected: 1 }],
    ['failed', { ...NOTHING_PROJECTED, failed: 1 }],
    ['reset', { ...NOTHING_PROJECTED, reset: 1 }],
    ['skipped', { ...NOTHING_PROJECTED, skipped: 1 }],
  ] as const)(
    'tells its listeners when the projection did something, even if it only %s a match',
    async (_name, report) => {
      fakeCatchUp(report);
      const { sync } = setUp({ handler: detailsUnreachable(smallHistoryApi()) });
      const states: boolean[] = [];
      sync.subscribe(() => states.push(sync.isRunning()));

      // A detail run has no history step, and this queue has nothing to download: the notification
      // between the start and the end can only come from the projection.
      await sync.syncNow('detail');

      expect(states).toEqual([true, true, false]);
    },
  );

  it('does not count what the projection only failed or skipped as projected in the ended line', async () => {
    fakeCatchUp({ ...NOTHING_PROJECTED, failed: 2, skipped: 1 });
    const { sync, logger } = setUp({ handler: historyOnlyApi() });

    await sync.syncNow('manual');

    expect(endedLines(logger).at(-1)?.context).not.toHaveProperty('projected');
  });

  it('projects nothing without a linked account', async () => {
    const catchUp = fakeCatchUp(FIVE_PROJECTED);
    const { sync, logger } = setUp({ accountId: null });

    await sync.syncNow('manual');
    await sync.syncNow('detail');

    expect(catchUp).not.toHaveBeenCalled();
    expect(endedLines(logger).map((entry) => entry.context.projected)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('sends no request and refreshes no rank in the automatic run of a protected account', async () => {
    const rank = fakeRankRefresh();
    const { sync, historyRequests, logger } = setUp({ handler: () => jsonResponse({}, 403) });
    await sync.syncNow('startup');
    await expect(sync.getStatus()).resolves.toMatchObject({ protectedAccount: true });
    rank.mockClear();
    const states: boolean[] = [];
    sync.subscribe(() => states.push(sync.isRunning()));

    await sync.syncNow('schedule');

    // Nothing to show: the listeners are told of the start and of the end, and nothing else was done.
    expect(states).toEqual([true, false]);
    expect(historyRequests()).toHaveLength(1);
    expect(rank).not.toHaveBeenCalled();
    const started = logger.entries.findLast((entry) => entry.message === 'Synchronisation started');
    const ended = endedLines(logger).at(-1);
    expect(ended?.level).toBe('debug');
    expect(ended?.context).toEqual({
      syncRunId: started?.context.syncRunId,
      trigger: 'schedule',
      outcome: 'protected_account',
      durationMs: expect.any(Number) as unknown,
    });
  });

  it('refreshes no rank in a detail run, which has no history step', async () => {
    const rank = fakeRankRefresh();
    const fixtures = smallHistoryApi();
    const { sync, services, answer, historyRequests } = setUp({
      handler: detailsUnreachable(fixtures),
    });
    await sync.syncNow('manual');
    answer.handler = fixtures;
    rank.mockClear();

    await sync.syncNow('detail');

    expect((await services.details.getSummary())?.archived).toBeGreaterThan(0);
    expect(rank).not.toHaveBeenCalled();
    expect(historyRequests()).toHaveLength(1);
  });

  it('refreshes the rank after a history that was saved', async () => {
    const rank = fakeRankRefresh();
    const { sync, logger } = setUp({ handler: historyOnlyApi() });

    await sync.syncNow('manual');

    const started = logger.entries.find((entry) => entry.message === 'Synchronisation started');
    expect(rank.mock.calls).toEqual([[FIXTURE_ACCOUNT_ID, started?.context.syncRunId]]);
  });

  it.each([
    ['failed with an error of the service', () => jsonResponse({}, 500)],
    ['asked to pause', () => jsonResponse({}, 429, { 'retry-after': '600' })],
  ] as const)(
    'refreshes the rank after a history that reached deadlock-api and %s',
    async (_name, answer) => {
      const rank = fakeRankRefresh();
      const { sync } = setUp({ handler: answer });

      await sync.syncNow('manual');

      expect(rank).toHaveBeenCalledTimes(1);
    },
  );

  it('refreshes the rank after a history that was not requested', async () => {
    const rank = fakeRankRefresh();
    const { sync, clock } = setUp({
      handler: () => jsonResponse({}, 429, { 'retry-after': '600' }),
    });
    await sync.syncNow('manual');
    clock.now += 60_000;

    // The pause is still on: the history is not requested, but the rank has its own checks.
    await sync.syncNow('manual');

    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'paused' } });
    expect(rank).toHaveBeenCalledTimes(2);
  });

  it.each<AppErrorKind>(['network', 'timeout'])(
    'does not refresh the rank when the history does not reach deadlock-api (%s)',
    async (kind) => {
      const rank = fakeRankRefresh();
      const { sync } = setUp({
        handler: () => {
          throw new AppError(kind, 'The request failed');
        },
      });

      await sync.syncNow('manual');

      expect(rank).not.toHaveBeenCalled();
    },
  );

  it('asks for the rank once a day: the synchronisations in between find it fresh', async () => {
    const database = createTestDatabase();
    const { sync, http, clock, logger } = setUp({ database, handler: historyOnlyApi() });
    const accounts = new LinkedAccountRepository(database, logger);

    await sync.syncNow('manual');
    clock.now += SYNC_INTERVAL_MS;
    await sync.syncNow('schedule');

    expect(http.requests.filter(isRankRequest)).toHaveLength(1);
    await expect(accounts.getRank(FIXTURE_ACCOUNT_ID)).resolves.toEqual({
      badge: 44,
      fetchedAt: START,
    });
    clock.now = START + RANK_MAX_AGE_MS;
    await sync.syncNow('manual');

    expect(http.requests.filter(isRankRequest)).toHaveLength(2);
  });

  it('never rejects when the refresh of the rank itself throws, and still runs the queue', async () => {
    vi.spyOn(PlayerRankService.prototype, 'refreshIfDue').mockRejectedValue(new Error('a bug'));
    const { sync, services, logger } = setUp({ handler: smallHistoryApi() });

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();

    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
    expect((await services.details.getSummary())?.archived).toBeGreaterThan(0);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        scope: 'sync',
        message: 'The refresh of the rank failed',
      }),
    );
  });

  it('never rejects when the projection itself throws, and still reports the history and the queue', async () => {
    vi.spyOn(ProjectionService.prototype, 'catchUp').mockRejectedValue(new Error('a bug'));
    fakeRankRefresh();
    const { sync, services, logger } = setUp({ handler: smallHistoryApi() });
    const states: boolean[] = [];
    sync.subscribe(() => states.push(sync.isRunning()));

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();

    // The analysis is not the synchronisation's business: the history is saved, the queue ran, and
    // the line that ends the run says so, with nothing projected.
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
    const archived = (await services.details.getSummary())?.archived ?? 0;
    expect(archived).toBeGreaterThan(0);
    const started = logger.entries.find((entry) => entry.message === 'Synchronisation started');
    const ended = endedLines(logger).at(-1);
    expect(ended?.level).toBe('info');
    expect(ended?.context).toMatchObject({ outcome: 'synced', archived });
    expect(ended?.context).not.toHaveProperty('projected');
    // The bug is logged once, as an error, with its kind and the id of the run.
    expect(logger.entries.filter((entry) => entry.message === 'The projection failed')).toEqual([
      {
        level: 'error',
        scope: 'sync',
        message: 'The projection failed',
        context: expect.objectContaining({
          kind: 'unexpected',
          syncRunId: started?.context.syncRunId,
        }) as unknown,
      },
    ]);
    expect(logger.entries.filter((entry) => entry.message === 'Synchronisation failed')).toEqual(
      [],
    );
    // Nothing was projected, so nothing more is told than the history saved.
    expect(states).toEqual([true, true, false]);
  });
});

describe('SyncService.suspend and resume', () => {
  /**
   * The lines logged when a synchronisation (or a retry) was refused, oldest first.
   *
   * @param logger - The logger of the services.
   * @returns The refusal lines.
   */
  function refusals(logger: MemoryLogger) {
    return logger.entries.filter((entry) => entry.message === REFUSED_MESSAGE);
  }

  /**
   * Tell whether a promise settles on its own: it has by the time the other promises' pending work
   * has run (a macrotask later), or it is still waiting for something the test holds.
   *
   * @param promise - The promise to watch.
   * @returns `'settled'` or `'pending'`.
   */
  function stateOf(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
    return Promise.race([
      promise.then(() => 'settled' as const),
      settle().then(() => 'pending' as const),
    ]);
  }

  it('waits for the running synchronisation when suspended', async () => {
    const { handler, historyAsked, release } = heldHistoryApi();
    const { sync } = setUp({ handler });
    const order: string[] = [];
    const run = sync.syncNow('manual').then(() => {
      order.push('run ended');
    });
    await historyAsked;

    const suspension = sync.suspend().then(() => {
      order.push('suspended');
    });
    await settle();

    // The history answer is held, so the run goes on, and the suspension waits for it.
    expect(sync.isRunning()).toBe(true);
    expect(order).toEqual([]);
    release();
    await Promise.all([run, suspension]);
    expect(order).toEqual(['run ended', 'suspended']);
    expect(sync.isRunning()).toBe(false);
    // The run was not cut short: it saved its history.
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
  });

  it('lets a run that a joiner waits for end normally, and starts no other', async () => {
    const { handler, historyAsked, release } = heldHistoryApi();
    const { sync, logger, historyRequests } = setUp({ handler });
    const run = sync.syncNow('manual');
    await historyAsked;
    const joiner = sync.syncNow('schedule');

    const suspension = sync.suspend();
    release();
    await Promise.all([run, joiner, suspension]);
    // Once suspended, nothing starts again.
    await sync.syncNow('manual');

    expect(joiner).toBe(run);
    expect(historyRequests()).toHaveLength(1);
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual']);
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
  });

  it('refuses a synchronisation that arrives while the suspension waits, instead of joining the run', async () => {
    const { handler, historyAsked, release } = heldHistoryApi();
    const { sync, logger, historyRequests } = setUp({ handler });
    const run = sync.syncNow('manual');
    await historyAsked;
    const suspension = sync.suspend();

    const late = sync.syncNow('manual');

    // The refusal is at once, though the run is still held: the late call did not wait for it.
    await expect(stateOf(late)).resolves.toBe('settled');
    expect(late).not.toBe(run);
    expect(sync.isRunning()).toBe(true);
    expect(refusals(logger)).toEqual([
      { level: 'debug', scope: 'sync', message: REFUSED_MESSAGE, context: { trigger: 'manual' } },
    ]);
    expect(logger.entries.some((entry) => entry.message === 'Synchronisation joined')).toBe(false);
    release();
    await Promise.all([run, suspension]);
    expect(historyRequests()).toHaveLength(1);
  });

  it('waits for the detail queue, which writes nothing once the suspension has resolved', async () => {
    const gate = createGate();
    const { handler, control, whenHeld } = createScriptedApi(smallHistoryApi(), 0);
    // Every detail waits for the test: the run is held in its queue, after its history.
    control.holdOtherDetails = gate.opened;
    const database = createTestDatabase();
    const { sync, http, logger, archiveStore } = setUp({ handler, database });
    const databaseWrites = vi.spyOn(database, 'execute');
    const archiveWrites = vi.spyOn(archiveStore, 'write');
    /** Everything that says whether the queue ended and whether anything was written since. */
    const snapshot = () => ({
      queueEnded: logger.entries.some((entry) => entry.message === 'Detail queue ended'),
      runEnded: endedLines(logger).length === 1,
      requests: http.requests.length,
      databaseWrites: databaseWrites.mock.calls.length,
      archiveWrites: archiveWrites.mock.calls.length,
    });
    const run = sync.syncNow('manual');
    await whenHeld(1);

    const suspended = sync.suspend().then(snapshot);

    // The queue is held, so the suspension waits for it.
    await expect(stateOf(suspended)).resolves.toBe('pending');
    gate.open();
    const [, atResolve] = await Promise.all([run, suspended]);
    // The queue ended (and wrote its archives) before the suspension resolved...
    expect(atResolve.queueEnded).toBe(true);
    expect(atResolve.runEnded).toBe(true);
    expect(atResolve.archiveWrites).toBeGreaterThan(0);
    // ...and nothing is written after it, not even by the calls that come then.
    await settle();
    await sync.syncNow('manual');
    await sync.retryDetail(testMatchId(100_000_001));
    await settle();
    expect(snapshot()).toEqual(atResolve);
  });

  it('refuses to synchronise while suspended', async () => {
    const { sync, http, logger } = setUp({ handler: historyOnlyApi() });
    const states: boolean[] = [];
    sync.subscribe(() => states.push(sync.isRunning()));
    await sync.suspend();

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();
    await expect(sync.syncNow('schedule')).resolves.toBeUndefined();

    // No request, no run (the listeners were not told of one), and a debug line for each refusal.
    expect(http.requests).toHaveLength(0);
    expect(sync.isRunning()).toBe(false);
    expect(states).toEqual([]);
    expect(refusals(logger)).toEqual([
      { level: 'debug', scope: 'sync', message: REFUSED_MESSAGE, context: { trigger: 'manual' } },
      { level: 'debug', scope: 'sync', message: REFUSED_MESSAGE, context: { trigger: 'schedule' } },
    ]);
    expect(logger.entries.some((entry) => entry.message === 'Synchronisation started')).toBe(false);
  });

  it('does not project nor refresh the rank while suspended', async () => {
    const catchUp = fakeCatchUp(FIVE_PROJECTED);
    const rank = fakeRankRefresh();
    const { sync, http } = setUp({ handler: smallHistoryApi() });
    await sync.suspend();

    await sync.syncNow('manual');
    await sync.syncNow('detail');
    await sync.retryDetail(testMatchId(100_000_001));

    expect(catchUp).not.toHaveBeenCalled();
    expect(rank).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
  });

  it('waits for the projection when suspended: it projects inside its run, not after it', async () => {
    const entered = createGate();
    const release = createGate();
    const catchUp = vi
      .spyOn(ProjectionService.prototype, 'catchUp')
      .mockImplementation(async () => {
        entered.open();
        await release.opened;
        return FIVE_PROJECTED;
      });
    fakeRankRefresh();
    const { sync, logger, historyRequests } = setUp({ handler: historyOnlyApi() });
    const order: string[] = [];
    const run = sync.syncNow('manual').then(() => {
      order.push('run ended');
    });
    await entered.opened;
    // The projection is the last step: the history was asked for before it.
    expect(historyRequests()).toHaveLength(1);

    const suspension = sync.suspend().then(() => {
      order.push('suspended');
    });

    // The projection is held, so the run goes on and the suspension waits for it.
    await expect(stateOf(suspension)).resolves.toBe('pending');
    expect(sync.isRunning()).toBe(true);
    release.open();
    await Promise.all([run, suspension]);
    expect(order).toEqual(['run ended', 'suspended']);
    // The run was not cut short: its line counts what it projected...
    expect(endedLines(logger).at(-1)?.context).toMatchObject({ outcome: 'synced', projected: 5 });
    // ...and nothing projects once the suspension has resolved.
    await sync.syncNow('manual');
    await settle();
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  describe('exclusive tasks', () => {
    it('runs a task at once and gives its result', async () => {
      const { sync } = setUp({ handler: historyOnlyApi() });
      const calls: string[] = [];

      const result = sync.runExclusive(() => {
        calls.push('task');
        return Promise.resolve(42);
      });

      // The call itself started the task: nothing waited for a turn of the event loop.
      expect(calls).toEqual(['task']);
      await expect(result).resolves.toBe(42);
    });

    it('rejects with the error of a task that fails, and accepts the next task', async () => {
      const { sync } = setUp({ handler: historyOnlyApi() });
      const failure = new Error('a bug');

      await expect(sync.runExclusive(() => Promise.reject(failure))).rejects.toBe(failure);

      await expect(sync.runExclusive(() => Promise.resolve('next'))).resolves.toBe('next');
    });

    it('runs alongside a synchronisation run that is going: the task does not wait for it', async () => {
      const { handler, historyAsked, release } = heldHistoryApi();
      const { sync } = setUp({ handler });
      const run = sync.syncNow('manual');
      await historyAsked;

      // The run is held in its first step.
      await expect(sync.runExclusive(() => Promise.resolve('done'))).resolves.toBe('done');

      expect(sync.isRunning()).toBe(true);
      release();
      await run;
    });

    it('does not hold a synchronisation back: a whole run ends while a task is going', async () => {
      const gate = createGate();
      const { sync } = setUp({ handler: historyOnlyApi() });
      const task = sync.runExclusive(() => gate.opened);

      await sync.syncNow('manual');

      await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
      await expect(stateOf(task)).resolves.toBe('pending');
      gate.open();
      await task;
    });

    it('suspend waits for an exclusive task', async () => {
      const gate = createGate();
      const { sync } = setUp({ handler: historyOnlyApi() });
      const order: string[] = [];
      const task = sync.runExclusive(async () => {
        await gate.opened;
        order.push('task ended');
      });

      const suspension = sync.suspend().then(() => {
        order.push('suspended');
      });

      // The task is held, so the suspension waits for it.
      await expect(stateOf(suspension)).resolves.toBe('pending');
      gate.open();
      await Promise.all([task, suspension]);
      expect(order).toEqual(['task ended', 'suspended']);
    });

    it('suspend waits for the running synchronisation and for every running task', async () => {
      const { handler, historyAsked, release } = heldHistoryApi();
      const { sync } = setUp({ handler });
      const first = createGate();
      const second = createGate();
      const run = sync.syncNow('manual');
      await historyAsked;
      const firstTask = sync.runExclusive(() => first.opened);
      const secondTask = sync.runExclusive(() => second.opened);

      const suspension = sync.suspend();

      // Whichever of the three ends, the suspension waits for the other two.
      release();
      await run;
      await expect(stateOf(suspension)).resolves.toBe('pending');
      first.open();
      await firstTask;
      await expect(stateOf(suspension)).resolves.toBe('pending');
      second.open();
      await Promise.all([secondTask, suspension]);
    });

    it('an exclusive task is refused while suspended, before it runs', async () => {
      const { sync, logger } = setUp({ handler: historyOnlyApi() });
      const task = vi.fn(() => Promise.resolve('never'));
      await sync.suspend();

      const refusal: unknown = await sync.runExclusive(task).catch((error: unknown) => error);

      expect(task).not.toHaveBeenCalled();
      expect(refusal).toBeInstanceOf(AppError);
      expect(refusal).toMatchObject({ kind: 'unexpected', context: { reason: 'suspended' } });
      // The caller can tell this refusal from a failure.
      expect(isSuspensionRefusal(refusal)).toBe(true);
      // The same debug line as the refusal of a synchronisation or of a retry.
      expect(refusals(logger)).toEqual([
        {
          level: 'debug',
          scope: 'sync',
          message: REFUSED_MESSAGE,
          context: { trigger: 'exclusive' },
        },
      ]);
    });

    it('does not take a failure for the refusal of a suspension', async () => {
      const { sync } = setUp({ handler: historyOnlyApi() });
      const unplanned = new AppError('unexpected', 'A bug');

      // An ordinary error of the same kind, a plain error, and the rejection of a task that fails.
      expect(isSuspensionRefusal(unplanned)).toBe(false);
      expect(isSuspensionRefusal(new Error('The task was refused while the account changes'))).toBe(
        false,
      );
      // The reason alone is not enough: the kind has to be the one of the refusal.
      expect(
        isSuspensionRefusal(new AppError('storage', 'x', { context: { reason: 'suspended' } })),
      ).toBe(false);
      expect(
        isSuspensionRefusal(new AppError('unexpected', 'x', { context: { reason: 'other' } })),
      ).toBe(false);
      expect(isSuspensionRefusal('suspended')).toBe(false);
      expect(isSuspensionRefusal(undefined)).toBe(false);
      const failure: unknown = await sync
        .runExclusive(() => Promise.reject(unplanned))
        .catch((error: unknown) => error);
      expect(failure).toBe(unplanned);
      expect(isSuspensionRefusal(failure)).toBe(false);
    });

    it('refuses a task that arrives while the suspension still waits for a run', async () => {
      const { handler, historyAsked, release } = heldHistoryApi();
      const { sync } = setUp({ handler });
      const run = sync.syncNow('manual');
      await historyAsked;
      const suspension = sync.suspend();
      const task = vi.fn(() => Promise.resolve('never'));

      const late = sync.runExclusive(task).then(
        () => 'ran',
        (error: unknown) => (isSuspensionRefusal(error) ? 'refused' : 'failed'),
      );

      // The refusal is at once, though the run is still held: the late call did not wait for it.
      await expect(stateOf(late)).resolves.toBe('settled');
      await expect(late).resolves.toBe('refused');
      expect(task).not.toHaveBeenCalled();
      expect(sync.isRunning()).toBe(true);
      release();
      await Promise.all([run, suspension]);
    });

    it('accepts a task again once resumed', async () => {
      const { sync, logger } = setUp({ handler: historyOnlyApi() });
      await sync.suspend();
      sync.resume();

      await expect(sync.runExclusive(() => Promise.resolve('ran'))).resolves.toBe('ran');

      expect(refusals(logger)).toEqual([]);
    });

    it('an exclusive task that throws does not block the suspension', async () => {
      const gate = createGate();
      const { sync } = setUp({ handler: historyOnlyApi() });
      const failure = new Error('a bug');
      const task = sync.runExclusive(async () => {
        await gate.opened;
        throw failure;
      });
      const suspension = sync.suspend();
      await expect(stateOf(suspension)).resolves.toBe('pending');

      gate.open();

      // The caller of the task gets the error; the suspension only waits for the task to end.
      await expect(task).rejects.toBe(failure);
      await expect(stateOf(suspension)).resolves.toBe('settled');
    });

    it('an exclusive task that throws before it returns a promise does not block the suspension', async () => {
      const { sync } = setUp({ handler: historyOnlyApi() });
      const failure = new Error('a bug');

      await expect(
        sync.runExclusive((): Promise<void> => {
          throw failure;
        }),
      ).rejects.toBe(failure);

      await expect(stateOf(sync.suspend())).resolves.toBe('settled');
    });
  });

  it('accepts synchronisations again once resumed', async () => {
    const { sync, historyRequests, logger } = setUp({ handler: historyOnlyApi() });
    await sync.suspend();
    await sync.syncNow('manual');

    sync.resume();
    await sync.syncNow('manual');

    // The first one was refused; the second one ran.
    expect(refusals(logger)).toHaveLength(1);
    expect(historyRequests()).toHaveLength(1);
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
  });

  it('restarts the timer on resume, without synchronising at once', async () => {
    const { sync, clock, countMatches, historyRequests, logger } = setUp({
      handler: historyOnlyApi(),
    });
    // Open the database before faking the timers: sql.js loads its WebAssembly file with real I/O,
    // which fake timers do not wait for. `countMatches` does not read the clock.
    await countMatches();
    vi.useFakeTimers();
    sync.start();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });
    expect(historyRequests()).toHaveLength(1);

    await sync.suspend();
    // The timer is gone: the ticks that would have fallen meanwhile do not happen.
    clock.now += 3 * SYNC_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(3 * SYNC_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(historyRequests()).toHaveLength(1);

    sync.resume();
    await vi.advanceTimersByTimeAsync(0);
    // The timer is back, and nothing ran when it came back.
    expect(vi.getTimerCount()).toBe(1);
    expect(sync.isRunning()).toBe(false);
    expect(historyRequests()).toHaveLength(1);
    clock.now += SYNC_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(historyRequests()).toHaveLength(2);
    });
    sync.stop();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });

    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual([
      'startup',
      'schedule',
    ]);
  });

  it('resumes without a timer when it was never started', async () => {
    vi.useFakeTimers();
    const { sync, http } = setUp({ handler: historyOnlyApi() });
    await sync.suspend();

    sync.resume();
    await vi.advanceTimersByTimeAsync(3 * SYNC_INTERVAL_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(http.requests).toHaveLength(0);
  });

  it('does not start a second timer when resumed without being suspended', async () => {
    const { sync, countMatches } = setUp({ handler: historyOnlyApi() });
    await countMatches();
    vi.useFakeTimers();
    sync.start();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });

    sync.resume();

    expect(vi.getTimerCount()).toBe(1);
    sync.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps that the timer was started when it is suspended twice', async () => {
    const { sync, clock, countMatches, historyRequests } = setUp({ handler: historyOnlyApi() });
    await countMatches();
    vi.useFakeTimers();
    sync.start();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });

    await sync.suspend();
    await sync.suspend();
    sync.resume();

    // The second suspension did not overwrite "the timer was started" with "it was not".
    expect(vi.getTimerCount()).toBe(1);
    clock.now += SYNC_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(historyRequests()).toHaveLength(2);
    });
    sync.stop();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });
  });

  it('resolves a second suspension once the running synchronisation has ended', async () => {
    const { handler, historyAsked, release } = heldHistoryApi();
    const { sync } = setUp({ handler });
    const order: string[] = [];
    const run = sync.syncNow('manual').then(() => {
      order.push('run ended');
    });
    await historyAsked;

    const first = sync.suspend().then(() => {
      order.push('first suspension');
    });
    const second = sync.suspend().then(() => {
      order.push('second suspension');
    });
    await settle();

    expect(order).toEqual([]);
    release();
    await Promise.all([run, first, second]);
    // Neither suspension resolved before the run ended.
    expect(order[0]).toBe('run ended');
    expect(order).toHaveLength(3);
  });

  it('only records that the timer is wanted when it starts while suspended', async () => {
    const { sync, clock, countMatches, http, historyRequests, logger } = setUp({
      handler: historyOnlyApi(),
    });
    await countMatches();
    vi.useFakeTimers();
    await sync.suspend();

    sync.start();
    clock.now += 3 * SYNC_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(3 * SYNC_INTERVAL_MS);

    // No startup run, no interval; and `start` did not even ask for a run to be refused.
    expect(sync.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(http.requests).toHaveLength(0);
    expect(refusals(logger)).toEqual([]);

    sync.resume();
    await vi.advanceTimersByTimeAsync(0);
    // The timer starts on resume, with no immediate run.
    expect(vi.getTimerCount()).toBe(1);
    expect(http.requests).toHaveLength(0);
    clock.now += SYNC_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(historyRequests()).toHaveLength(1);
    });
    sync.stop();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['schedule']);
  });

  it('forgets that the timer was wanted when it is stopped while suspended', async () => {
    vi.useFakeTimers();
    const { sync, http } = setUp({ handler: historyOnlyApi() });
    await sync.suspend();
    sync.start();

    sync.stop();
    sync.resume();
    await vi.advanceTimersByTimeAsync(3 * SYNC_INTERVAL_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses the retry of a match detail while suspended, before it resets the match', async () => {
    const { sync, services, http, logger } = setUp({ handler: smallHistoryApi() });
    const resetForRetry = vi.spyOn(services.details, 'resetForRetry');
    await sync.suspend();

    await expect(sync.retryDetail(testMatchId(100_000_001))).resolves.toBeUndefined();

    // A retry writes the row of its match: it must not write the row of an account being erased.
    expect(resetForRetry).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
    expect(refusals(logger)).toEqual([
      { level: 'debug', scope: 'sync', message: REFUSED_MESSAGE, context: { trigger: 'detail' } },
    ]);
    expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
  });

  it('accepts the retry of a match detail again once resumed', async () => {
    const { sync, services, logger } = setUp({ handler: smallHistoryApi() });
    const resetForRetry = vi.spyOn(services.details, 'resetForRetry');
    await sync.suspend();
    sync.resume();

    await sync.retryDetail(testMatchId(100_000_001));

    expect(resetForRetry).toHaveBeenCalledTimes(1);
    expect(refusals(logger)).toEqual([]);
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['detail']);
  });
});

describe('SyncService.retryDetail', () => {
  it('retries a match on demand, even while a run is going', async () => {
    const gate = createGate();
    const { handler, control, brokenMatchId, whenHeld } = createScriptedApi(smallHistoryApi());
    // The details of the other matches wait for the test: the run is held in its queue.
    control.holdOtherDetails = gate.opened;
    const { sync, services, logger, metadataRequests } = setUp({ handler });
    const run = sync.syncNow('manual');
    // Two details are held, one per puller of the queue. The puller that got the first match
    // (answered at once, unusable) held its next one only after it recorded that match `invalid`.
    await whenHeld(2);
    expect((await services.details.getMatchDetail(brokenMatchId())).kind).toBe('invalid');
    control.brokenAnswer = 'healed';
    const syncNow = watchSyncNow(sync);

    const retry = sync.retryDetail(brokenMatchId());
    // The retry has reset its match and called `syncNow`: the run is held, so it joined that run.
    await syncNow.whenCalled(1);
    expect(sync.isRunning()).toBe(true);
    gate.open();
    await Promise.all([run, retry]);

    // The run did not offer the match again (it had tried it): a second run, started by the
    // retry, downloaded it.
    expect((await services.details.getMatchDetail(brokenMatchId())).kind).toBe('ready');
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual', 'detail']);
    expect(endedLines(logger).at(-1)?.context).toMatchObject({ archived: 1 });
    expect(
      metadataRequests().filter((request) => request.url === control.brokenUrls[0]),
    ).toHaveLength(2);
  });

  it('retries a match on demand when no run is going', async () => {
    const { handler, control, brokenMatchId } = createScriptedApi(smallHistoryApi());
    const { sync, services, logger, historyRequests } = setUp({ handler });
    await sync.syncNow('manual');
    expect((await services.details.getMatchDetail(brokenMatchId())).kind).toBe('invalid');
    control.brokenAnswer = 'healed';

    await sync.retryDetail(brokenMatchId());

    expect((await services.details.getMatchDetail(brokenMatchId())).kind).toBe('ready');
    // One detail run, which did not ask for the history again.
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual', 'detail']);
    expect(historyRequests()).toHaveLength(1);
  });

  it('does not start another run when the run it joined took the match', async () => {
    const gate = createGate();
    const { handler, control, brokenMatchId } = createScriptedApi(smallHistoryApi());
    const { sync, services, logger } = setUp({ handler });
    await sync.syncNow('manual');
    control.brokenAnswer = 'healed';
    // The next run is held at its history: the queue has not started when the retry arrives.
    control.holdHistory = gate.opened;
    const run = sync.syncNow('manual');
    const syncNow = watchSyncNow(sync);

    const retry = sync.retryDetail(brokenMatchId());
    await syncNow.whenCalled(1);
    gate.open();
    await Promise.all([run, retry]);

    expect((await services.details.getMatchDetail(brokenMatchId())).kind).toBe('ready');
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual', 'manual']);
  });

  it('does not start another run when the match waits for its retry date', async () => {
    const gate = createGate();
    const { handler, control, brokenMatchId } = createScriptedApi(smallHistoryApi());
    const { sync, services, logger } = setUp({ handler });
    await sync.syncNow('manual');
    // The joined run takes the match back and the API fails again (a 500): a counted failure, the
    // match is tried again in five minutes or so, not by another run now.
    control.brokenAnswer = 'server_error';
    control.holdHistory = gate.opened;
    const run = sync.syncNow('manual');
    const syncNow = watchSyncNow(sync);

    const retry = sync.retryDetail(brokenMatchId());
    await syncNow.whenCalled(1);
    gate.open();
    await Promise.all([run, retry]);

    await expect(services.details.getMatchDetail(brokenMatchId())).resolves.toMatchObject({
      kind: 'waiting',
      nextAttemptAt: expect.any(Number) as unknown,
    });
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual', 'manual']);
  });

  it('runs the queue only once when no run was going, even if the match stays waiting', async () => {
    const { handler, control, brokenMatchId } = createScriptedApi(smallHistoryApi());
    const { sync, services, answer, logger } = setUp({ handler });
    await sync.syncNow('manual');
    control.brokenAnswer = 'healed';
    // deadlock-api asks to pause: the queue stops before it takes the match back.
    answer.handler = (request) =>
      isMetadataRequest(request)
        ? jsonResponse({}, 429, { 'retry-after': '600' })
        : handler(request);

    await sync.retryDetail(brokenMatchId());

    // The match waits for the next run, which the pause will let go through; the retry made its
    // run and did not insist: the second run is only for a run that was going already.
    expect((await services.details.getMatchDetail(brokenMatchId())).kind).toBe('waiting');
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual', 'detail']);
    expect(endedLines(logger).at(-1)?.context).toMatchObject({ detailStoppedBy: 'paused' });
  });

  it('never runs two queues at once when a second retry comes while the first one runs', async () => {
    const detailsHeld = createGate();
    const queueMayStart = createGate();
    const queueEntered = createGate();
    const scripted = createScriptedApi(smallHistoryApi(), 2);
    const { sync, services, archiveStore, answer, logger } = setUp({ handler: scripted.handler });
    // Two matches are `invalid`.
    await sync.syncNow('manual');
    const [first, second] = scripted.brokenMatchIds();
    if (first === undefined || second === undefined) {
      throw new Error('Two details were asked for');
    }
    // From now on they are answered, but each answer waits for the test.
    scripted.control.brokenAnswer = 'healed';
    scripted.control.holdHealed = detailsHeld.opened;
    // What the services do from here, counted: requests in flight, and queues running.
    let inFlight = 0;
    let mostInFlight = 0;
    answer.handler = async (request) => {
      if (!isMetadataRequest(request)) {
        return scripted.handler(request);
      }
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        return await scripted.handler(request);
      } finally {
        inFlight -= 1;
      }
    };
    let queueRuns = 0;
    let queuesRunning = 0;
    let mostQueuesRunning = 0;
    const runQueue = services.details.runQueue.bind(services.details);
    vi.spyOn(services.details, 'runQueue').mockImplementation(async (accountId, syncRunId) => {
      queueRuns += 1;
      queuesRunning += 1;
      mostQueuesRunning = Math.max(mostQueuesRunning, queuesRunning);
      try {
        return await runQueue(accountId, syncRunId);
      } finally {
        queuesRunning -= 1;
      }
    });
    // A queue stops at its first step until the test lets it go.
    const removeTemporaryFiles = archiveStore.removeTemporaryFiles.bind(archiveStore);
    vi.spyOn(archiveStore, 'removeTemporaryFiles').mockImplementation(async (accountId) => {
      queueEntered.open();
      await queueMayStart.opened;
      await removeTemporaryFiles(accountId);
    });
    const syncNow = watchSyncNow(sync);

    // The first retry starts a run, which stops at the start of its queue. The second retry comes
    // then: it resets its match and joins that run.
    const firstRetry = sync.retryDetail(first);
    await queueEntered.opened;
    const secondRetry = sync.retryDetail(second);
    await syncNow.whenCalled(2);
    // The queue goes on and finds both matches pending: each of its two pullers holds one.
    queueMayStart.open();
    await scripted.whenHeld(2);
    detailsHeld.open();
    await Promise.all([firstRetry, secondRetry]);

    // One queue took both matches, two requests at a time, and no run was needed for the second.
    expect((await services.details.getMatchDetail(first)).kind).toBe('ready');
    expect((await services.details.getMatchDetail(second)).kind).toBe('ready');
    expect(queueRuns).toBe(1);
    expect(mostQueuesRunning).toBe(1);
    expect(mostInFlight).toBe(2);
    expect(endedLines(logger).map((entry) => entry.context.trigger)).toEqual(['manual', 'detail']);
  });

  it('never rejects, and logs the failure', async () => {
    const { sync, services, logger } = setUp({ handler: smallHistoryApi() });
    vi.spyOn(services.details, 'resetForRetry').mockRejectedValue(
      new AppError('storage', 'The database failed'),
    );

    await expect(sync.retryDetail(testMatchId(108_600_000))).resolves.toBeUndefined();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        scope: 'sync',
        message: 'The retry of a match detail failed',
        context: expect.objectContaining({ kind: 'storage' }) as unknown,
      }),
    );
    // Nothing was started: the failure came before the run.
    expect(endedLines(logger)).toEqual([]);
  });
});

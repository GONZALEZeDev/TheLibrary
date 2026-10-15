/**
 * Tests of the synchronisation, end to end on the development adapters: synthetic deadlock-api,
 * in-memory database, memory logger.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { AUTOMATIC_HISTORY_RATE_LIMIT } from '../core/deadlock-api/budgets';
import type { AccountId } from '../core/domain/account';
import { AppError } from '../core/errors/app-error';
import type { Database } from '../ports/database.port';
import { createTestDatabase } from '../test/test-data';
import { DeadlockApiService } from './deadlock-api.service';
import { MatchesRepository } from './matches.repository';
import { SYNC_INTERVAL_MS, SyncService } from './sync.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Options of {@link setUp}. */
interface SetUpOptions {
  /** Answers the requests; the fixture API (240 matches) by default. */
  readonly handler?: FixtureHandler;
  /** The database; a fresh one by default. Pass the same one to simulate a restart. */
  readonly database?: Database;
  /** The linked account; the fixture account by default. */
  readonly accountId?: AccountId | null;
  /**
   * Current time (Unix ms) read by every service; the controllable `clock` by default. When given,
   * the returned `clock` has no effect.
   */
  readonly now?: () => number;
}

/**
 * Build the synchronisation on the development adapters, with a controllable clock and handler.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The service and everything a test may inspect or change.
 */
function setUp(options: SetUpOptions = {}) {
  const clock = { now: START };
  const now = options.now ?? (() => clock.now);
  const answer = { handler: options.handler ?? createFixtureApi({ now: START }) };
  const http = new FixtureHttpClient((request) => answer.handler(request));
  const logger = new MemoryLogger();
  const database = options.database ?? createTestDatabase();
  const syncState = new SyncStateRepository(database, logger, now);
  const matches = new MatchesRepository(database, now);
  const accountId = options.accountId === undefined ? FIXTURE_ACCOUNT_ID : options.accountId;
  const sync = new SyncService({
    accountSource: {
      currentAccountId: () => Promise.resolve(accountId),
      missingAccountHint: accountId === null ? 'Set the development account' : null,
    },
    api: new DeadlockApiService(http, syncState, logger, { appVersion: '0.1.0', now }),
    matches,
    syncState,
    logger,
    now,
  });
  return { sync, http, logger, clock, answer, matches, database };
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
});

describe('SyncService', () => {
  it('saves the whole history at the first synchronisation, then only adds new matches', async () => {
    const { sync, matches, clock } = setUp();

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
    await expect(matches.count(FIXTURE_ACCOUNT_ID)).resolves.toBe(240);
    await expect(sync.getStatus()).resolves.toMatchObject({
      lastSync: { outcome: 'synced', newMatches: 0, historyFetchedAt: START + SYNC_INTERVAL_MS },
    });
  });

  it('runs one synchronisation at a time: a trigger during a running one joins it', async () => {
    const { sync, http } = setUp();

    const first = sync.syncNow('startup');
    const second = sync.syncNow('manual');

    expect(sync.isRunning()).toBe(true);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(sync.isRunning()).toBe(false);
    expect(http.requests).toHaveLength(1);
  });

  it('tells its listeners when a synchronisation starts and ends', async () => {
    const { sync } = setUp();
    const states: boolean[] = [];
    const unsubscribe = sync.subscribe(() => states.push(sync.isRunning()));

    await sync.syncNow('manual');
    unsubscribe();
    await sync.syncNow('manual');

    expect(states).toEqual([true, false]);
  });

  it('keeps synchronising and informing the other listeners when a listener fails', async () => {
    const { sync, logger } = setUp();
    const states: boolean[] = [];
    sync.subscribe(() => {
      throw new Error('broken listener');
    });
    sync.subscribe(() => states.push(sync.isRunning()));

    await expect(sync.syncNow('manual')).resolves.toBeUndefined();

    expect(states).toEqual([true, false]);
    await expect(sync.getStatus()).resolves.toMatchObject({ lastSync: { outcome: 'synced' } });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'A listener of the synchronisation failed',
      }),
    );
  });

  it('does nothing without a linked account, logs nothing above debug and shows the hint', async () => {
    const { sync, http, logger } = setUp({ accountId: null });

    await sync.syncNow('manual');

    expect(http.requests).toHaveLength(0);
    expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
    await expect(sync.getStatus()).resolves.toEqual({
      running: false,
      accountLinked: false,
      missingAccountHint: 'Set the development account',
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
    const { sync, clock, http } = setUp();
    for (let index = 0; index < 7; index += 1) {
      clock.now = START + index * 60_000;
      await sync.syncNow('schedule');
    }

    expect(http.requests).toHaveLength(6);
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
    const { sync, http, answer } = setUp({ handler: () => jsonResponse({}, 403) });

    await sync.syncNow('startup');
    await sync.syncNow('schedule');
    expect(http.requests).toHaveLength(1);
    await expect(sync.getStatus()).resolves.toMatchObject({
      protectedAccount: true,
      lastSync: { outcome: 'failed', errorKind: 'forbidden' },
    });

    answer.handler = createFixtureApi({ now: START });
    await sync.syncNow('manual');

    expect(http.requests).toHaveLength(2);
    await expect(sync.getStatus()).resolves.toMatchObject({
      protectedAccount: false,
      lastSync: { outcome: 'synced' },
    });
  });

  it('records a failure, logs it once with the id of the synchronisation, and keeps the data', async () => {
    const { sync, logger, matches, clock, answer } = setUp();
    await sync.syncNow('startup');
    answer.handler = () => jsonResponse({}, 500);
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
    await expect(matches.count(FIXTURE_ACCOUNT_ID)).resolves.toBe(240);
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
    const { sync, http, clock } = setUp();

    sync.start();
    sync.start();
    await vi.waitFor(() => {
      expect(sync.isRunning()).toBe(false);
    });
    clock.now += SYNC_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });
    sync.stop();
    await vi.advanceTimersByTimeAsync(3 * SYNC_INTERVAL_MS);

    expect(http.requests).toHaveLength(2);
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
    const { sync, http, logger, matches } = setUp({
      now: createLateClock(),
      // A one-match history: the budget does not depend on its size, and a day of synchronisations
      // of the default 240 matches would take seconds.
      handler: createFixtureApi({ now: START, matchCount: 1 }),
    });
    // Open the database before faking the timers: sql.js loads its WebAssembly file with real I/O,
    // which fake timers do not wait for, so the first ticks would join a startup synchronisation
    // still waiting for it. `count` does not read the clock.
    await matches.count(FIXTURE_ACCOUNT_ID);
    vi.useFakeTimers({ now: START });

    sync.start();
    // The startup synchronisation ended at START, before the first tick.
    await vi.advanceTimersByTimeAsync(0);
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
    expect(http.requests).toHaveLength(
      1 + hours + Math.floor((hours * 60 * 60_000) / SYNC_INTERVAL_MS),
    );
  });
});

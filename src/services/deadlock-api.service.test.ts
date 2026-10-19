/**
 * Tests of the deadlock-api service, with the development HTTP client and an in-memory database.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
} from '../adapters/dev/fixtures/match-history.fixture';
import { isMetadataMissing } from '../adapters/dev/fixtures/match-metadata.fixture';
import { FIXTURE_AVATAR_HASH, FIXTURE_PERSONA_NAME } from '../adapters/dev/fixtures/steam.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { DEFAULT_PAUSE_MS } from '../core/deadlock-api/api-response';
import { MAX_RESPONSE_BYTES, matchMetadataRequest } from '../core/deadlock-api/endpoints';
import { AppError, errorLogContext, isAppError } from '../core/errors/app-error';
import type { Database } from '../ports/database.port';
import type { HttpRequest, HttpResponse } from '../ports/http-client.port';
import { createTestDatabase, testAccountId, testMatchId } from '../test/test-data';
import { DeadlockApiService, type MetadataFetch } from './deadlock-api.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MINUTE = 60_000;

/**
 * Build the service on the given handler, with a controllable clock.
 *
 * The service does not really sleep: its `sleep` records the wait it was asked for, lets the test
 * act "meanwhile" (`sleeper.during`), then moves the clock forward by that wait.
 *
 * @param handler - Answers the requests; the fixture API by default.
 * @param database - The database; a fresh one by default.
 * @returns The service, its HTTP client, logger, clock and sleeper.
 */
function setUp(
  handler: FixtureHandler = createFixtureApi({ now: START, matchCount: 5 }),
  database: Database = createTestDatabase(),
) {
  const clock = { now: START };
  const sleeper = {
    /** The wait of each call of `sleep`, in milliseconds, oldest first. */
    calls: [] as number[],
    /** How many requests had been sent when each call of `sleep` was made and time went by. */
    sentWhileSleeping: [] as number[],
    /** Runs while the service sleeps, before the clock moves: what happens meanwhile. */
    during: undefined as (() => Promise<void> | void) | undefined,
  };
  const http = new FixtureHttpClient(handler);
  const logger = new MemoryLogger();
  const syncState = new SyncStateRepository(database, logger, () => clock.now);
  const api = new DeadlockApiService(http, syncState, logger, {
    appVersion: '0.1.0',
    now: () => clock.now,
    sleep: async (ms) => {
      sleeper.calls.push(ms);
      // Time goes by while the service sleeps: the other calls do all they can without waiting.
      await settle();
      sleeper.sentWhileSleeping.push(http.requests.length);
      await sleeper.during?.();
      clock.now += ms;
    },
  });
  return { api, http, logger, clock, syncState, sleeper };
}

describe('DeadlockApiService.fetchMatchHistory', () => {
  it('downloads and validates the history, with the User-Agent, timeout and size limit of the app', async () => {
    const { api, http } = setUp();

    const result = await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });

    expect(result).toMatchObject({ kind: 'fetched', fromSteam: true });
    expect(result.kind === 'fetched' ? result.matches : []).toHaveLength(5);
    expect(http.requests).toEqual([
      {
        method: 'GET',
        url: 'https://api.deadlock-api.com/v1/players/1000001/match-history',
        headers: {
          'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
          Accept: 'application/json',
        },
        timeoutMs: 15_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
    ]);
  });

  it('lets automatic requests use 6 requests per hour and keeps the last 2 for the user', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 6; index += 1) {
      clock.now = START + index * MINUTE;
      await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }
    clock.now = START + 6 * MINUTE;

    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + 60 * MINUTE,
    });
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'budget_exhausted' });
    expect(http.requests).toHaveLength(8);
  });

  it('keeps counting the budget after a restart', async () => {
    const database = createTestDatabase();
    const first = setUp(undefined, database);
    for (let index = 0; index < 6; index += 1) {
      await first.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }

    const restarted = setUp(undefined, database);

    await expect(
      restarted.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'budget_exhausted' });
    expect(restarted.http.requests).toHaveLength(0);
  });

  it('lets the budget recover within the hour when the system clock moved backwards', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 6; index += 1) {
      clock.now = START + index * MINUTE;
      await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }

    clock.now = START - 48 * 60 * MINUTE;
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'budget_exhausted' });
    clock.now += 61 * MINUTE;
    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    expect(http.requests).toHaveLength(7);
  });

  it('never lets overlapping calls exceed the budget', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 5; index += 1) {
      clock.now = START + index * MINUTE;
      await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });
    }

    const results = await Promise.all([
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ]);

    expect(results.map((result) => result.kind).toSorted()).toEqual([
      'budget_exhausted',
      'fetched',
    ]);
    expect(http.requests).toHaveLength(6);
  });

  it('counts a request that failed', async () => {
    const { api, syncState } = setUp(() => {
      throw new AppError('network', 'The request failed');
    });

    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })).rejects.toThrow(
      AppError,
    );
    await expect(syncState.getHistoryRequests()).resolves.toEqual([START]);
  });

  it('uses the stored history that a 429 still returns, as not refreshed from Steam', async () => {
    const { api } = setUp(() => jsonResponse([], 429, { 'called-steam': 'false' }));

    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })).resolves.toEqual({
      kind: 'fetched',
      matches: [],
      fromSteam: false,
    });
  });

  it('saves the pause deadlock-api asks for and sends nothing until it ends, even after a restart', async () => {
    const database = createTestDatabase();
    const first = setUp(
      () => jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
      database,
    );

    await expect(
      first.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toEqual({ kind: 'paused', until: START + 120_000 });

    const restarted = setUp(undefined, database);
    restarted.clock.now = START + 60_000;
    await expect(
      restarted.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toEqual({ kind: 'paused', until: START + 120_000 });
    expect(restarted.http.requests).toHaveLength(0);

    restarted.clock.now = START + 120_001;
    await expect(
      restarted.api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false }),
    ).resolves.toMatchObject({ kind: 'fetched' });
  });

  it('logs the pause without the account id', async () => {
    const { api, logger } = setUp(() => jsonResponse('', 503, { 'retry-after': '5' }));

    await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'deadlock-api asked to pause the requests',
        context: expect.objectContaining({
          endpoint: '/v1/players/{account_id}/match-history',
          status: 503,
        }) as unknown,
      }),
    );
    expect(JSON.stringify(logger.entries)).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'service_unavailable'],
  ] as const)('reports a %s as %s', async (status, kind) => {
    const { api } = setUp(() => jsonResponse({}, status));

    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).rejects.toMatchObject({ kind });
  });

  it('removes the account id that a transport error quotes', async () => {
    const { api } = setUp(() => {
      throw new AppError('network', 'The request failed', {
        cause:
          'error sending request for url (https://api.deadlock-api.com/v1/players/1000001/match-history)',
      });
    });

    const error = await api
      .fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: 'network',
      context: { endpoint: '/v1/players/{account_id}/match-history' },
      cause:
        'error sending request for url (https://api.deadlock-api.com/v1/players/{account_id}/match-history)',
    });
  });

  it('logs the rows it had to drop', async () => {
    const valid = JSON.parse(
      (
        await new FixtureHttpClient(createFixtureApi({ now: START, matchCount: 1 })).get({
          url: 'https://api.deadlock-api.com/v1/players/1000001/match-history',
          headers: {},
          timeoutMs: 1,
          maxBodyBytes: 1_000_000,
        })
      ).body,
    ) as unknown[];
    const { api, logger } = setUp(() => jsonResponse([...valid, { match_id: 'broken' }]));

    await expect(
      api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true }),
    ).resolves.toMatchObject({ kind: 'fetched' });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'Ignored invalid rows of the match history',
        context: expect.objectContaining({ invalidRows: 1 }) as unknown,
      }),
    );
  });
});

describe('DeadlockApiService.fetchHeroes', () => {
  it('downloads the playable heroes', async () => {
    const { api } = setUp();

    await expect(api.fetchHeroes()).resolves.toContainEqual({ id: 67, name: 'Paige' });
  });

  it('allows 2 requests per second', async () => {
    const { api, clock } = setUp();

    await api.fetchHeroes();
    await api.fetchHeroes();
    await expect(api.fetchHeroes()).rejects.toMatchObject({ kind: 'rate_limited' });
    clock.now += 1_000;
    await expect(api.fetchHeroes()).resolves.not.toHaveLength(0);
  });

  it('respects a pause asked for on another endpoint', async () => {
    const { api, syncState } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    await expect(api.fetchHeroes()).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

/** Answers every request with a small valid JSON: for the tests that ignore the detail itself. */
const ANSWER_OK: FixtureHandler = () => jsonResponse({ match_info: {} });

/** What a successful call answers, whatever the match. */
const FETCHED = expect.objectContaining({ kind: 'fetched' }) as unknown;

/**
 * Let every promise that can settle without a timer settle, so that a test can check that
 * something did not happen (a request that stayed unsent).
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A handler that keeps every response until the test releases it. */
interface HeldResponses {
  readonly handler: FixtureHandler;
  /** Answer the oldest request still waiting. */
  readonly releaseNext: () => void;
  /** The most requests that were waiting at the same time. */
  readonly peak: () => number;
}

/**
 * Build a handler whose responses wait for the test, to observe requests that overlap.
 *
 * @param answer - The response of the n-th request received (0 for the first one).
 * @returns The handler, and the controls of the test.
 */
function holdResponses(
  answer: (request: HttpRequest, index: number) => HttpResponse = () => jsonResponse({}),
): HeldResponses {
  const waiting: (() => void)[] = [];
  let received = 0;
  let peak = 0;
  return {
    handler: async (request) => {
      const index = received;
      received += 1;
      const released = new Promise<void>((resolve) => waiting.push(resolve));
      peak = Math.max(peak, waiting.length);
      await released;
      return answer(request, index);
    },
    releaseNext: () => waiting.shift()?.(),
    peak: () => peak,
  };
}

/**
 * Narrow the result of a download to the one that carries the detail.
 *
 * @param result - The result.
 * @returns The same result, known to be `fetched`.
 */
function expectFetched(result: MetadataFetch): Extract<MetadataFetch, { kind: 'fetched' }> {
  if (result.kind !== 'fetched') {
    expect.unreachable(`expected a fetched detail, got ${result.kind}`);
  }
  return result;
}

describe('DeadlockApiService.fetchMatchMetadata', () => {
  /** A match of the fixture history that the fixture API serves. */
  const servedMatch =
    createMatchHistoryFixture({ now: START, count: 5 })
      .map((row) => testMatchId(row.match_id))
      .find((matchId) => !isMetadataMissing(matchId)) ??
    expect.unreachable('the fixture history holds a served match');

  it('fetches a match detail with disable_steam=true', async () => {
    const { api, http } = setUp();

    const fetched = expectFetched(await api.fetchMatchMetadata(servedMatch));

    expect(JSON.parse(fetched.body)).toEqual(fetched.json);
    expect(fetched.json).toMatchObject({ match_info: { match_id: servedMatch } });
    expect(http.requests).toEqual([
      {
        method: 'GET',
        url: `https://api.deadlock-api.com/v1/matches/${String(servedMatch)}/metadata?disable_steam=true`,
        headers: {
          'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
          Accept: 'application/json',
        },
        timeoutMs: 15_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
    ]);
    expect(http.requests[0]?.url).toBe(matchMetadataRequest(servedMatch).url);
  });

  it('reports a match the API does not have', async () => {
    const { api, syncState } = setUp();

    // 42 is not in the fixture history: the API answers 404, and no pause follows.
    await expect(api.fetchMatchMetadata(testMatchId(42))).resolves.toEqual({ kind: 'not_found' });
    await expect(syncState.getPausedUntil()).resolves.toBeNull();
  });

  it('reports a body that is not JSON with the body', async () => {
    const body = '<html>Bad gateway</html>';
    const { api, syncState } = setUp(() => ({ status: 200, headers: {}, body }));

    await expect(api.fetchMatchMetadata(testMatchId(1))).resolves.toEqual({
      kind: 'invalid',
      issue: 'not_json',
      body,
    });
    await expect(syncState.getPausedUntil()).resolves.toBeNull();
  });

  it('pauses on a 429 and answers paused', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
    );

    await expect(api.fetchMatchMetadata(testMatchId(1))).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 120_000);

    // The pause is respected: the next call sends nothing.
    await expect(api.fetchMatchMetadata(testMatchId(2))).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    expect(http.requests).toHaveLength(1);
  });

  it('pauses on a 503 without Retry-After for the default delay', async () => {
    const { api, syncState } = setUp(() => jsonResponse({ status: 503 }, 503));

    await expect(api.fetchMatchMetadata(testMatchId(1))).resolves.toEqual({
      kind: 'paused',
      until: START + DEFAULT_PAUSE_MS,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + DEFAULT_PAUSE_MS);
  });

  it('answers paused without sending while a pause is running', async () => {
    const { api, http, syncState, sleeper } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    await expect(api.fetchMatchMetadata(servedMatch)).resolves.toEqual({
      kind: 'paused',
      until: START + 5_000,
    });
    expect(http.requests).toHaveLength(0);
    expect(sleeper.calls).toEqual([]);
  });

  it('keeps the latest pause when two responses ask for one', async () => {
    // Two requests are in flight and both answer in the same moment, in either order: the pause
    // that ends last must win, whichever answer is saved first.
    for (const retryAfters of [
      [300, 60],
      [60, 300],
    ] as const) {
      const held = holdResponses((_request, index) =>
        jsonResponse({ status: 429 }, 429, { 'retry-after': String(retryAfters[index]) }),
      );
      const { api, http, syncState } = setUp(held.handler);
      const first = api.fetchMatchMetadata(testMatchId(1));
      const second = api.fetchMatchMetadata(testMatchId(2));
      await vi.waitFor(() => {
        expect(http.requests).toHaveLength(2);
      });

      held.releaseNext();
      held.releaseNext();
      const results = await Promise.all([first, second]);

      await expect(syncState.getPausedUntil()).resolves.toBe(START + 300_000);
      // A call reports the pause that is really running once its own is saved.
      expect(results[1]).toEqual({ kind: 'paused', until: START + 300_000 });
      expect(results[0]).toEqual({ kind: 'paused', until: START + retryAfters[0] * 1000 });
    }
  });

  it('keeps the latest pause across the families of requests', async () => {
    // The pause the history request asks for must not shorten the one the detail asked for.
    const held = holdResponses((request) =>
      jsonResponse({ status: 429 }, 429, {
        'retry-after': request.url.includes('/metadata') ? '300' : '60',
      }),
    );
    const { api, http, syncState } = setUp(held.handler);
    const detail = api.fetchMatchMetadata(testMatchId(1));
    const history = api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false });
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });

    held.releaseNext();
    held.releaseNext();
    const results = await Promise.all([detail, history]);

    await expect(syncState.getPausedUntil()).resolves.toBe(START + 300_000);
    expect(results).toEqual([
      { kind: 'paused', until: START + 300_000 },
      { kind: 'paused', until: START + 300_000 },
    ]);
  });

  it('keeps saving the pauses after a write failed', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '60' }),
    );
    vi.spyOn(syncState, 'setPausedUntil').mockRejectedValueOnce(
      new AppError('storage', 'Could not save the synchronisation state'),
    );

    // The first pause cannot be saved, so the call fails and no pause is running...
    await expect(api.fetchMatchMetadata(testMatchId(1))).rejects.toMatchObject({ kind: 'storage' });
    // ...but the failure does not jam the saving of the next pauses.
    await expect(api.fetchMatchMetadata(testMatchId(2))).resolves.toEqual({
      kind: 'paused',
      until: START + 60_000,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 60_000);
    expect(http.requests).toHaveLength(2);
  });

  it('answers paused to a call that starts while a pause is being saved', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '60' }),
    );
    const save = syncState.setPausedUntil.bind(syncState);
    let secondCall: Promise<MetadataFetch> | undefined;
    vi.spyOn(syncState, 'setPausedUntil').mockImplementation(async (until) => {
      // The write is under way, not done: another call starts now and runs as far as it can.
      secondCall = api.fetchMatchMetadata(testMatchId(2));
      await settle();
      await save(until);
    });

    await api.fetchMatchMetadata(testMatchId(1));

    // The second call waited for the write instead of reading the database as it was before.
    await expect(secondCall).resolves.toEqual({ kind: 'paused', until: START + 60_000 });
    expect(http.requests).toHaveLength(1);
  });

  it('waits for the next slot instead of exceeding 5 requests per second', async () => {
    const { api, http, sleeper } = setUp(ANSWER_OK);

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((id) => api.fetchMatchMetadata(testMatchId(id))),
    );

    // Exactly 5 requests went out right away; the 6th slept for the whole second, then went out.
    expect(sleeper.calls).toEqual([1_000]);
    expect(sleeper.sentWhileSleeping).toEqual([5]);
    expect(http.requests).toHaveLength(6);
    expect(results).toEqual(Array.from({ length: 6 }, () => FETCHED));
  });

  it('waits only until the oldest requests have left the window', async () => {
    const { api, clock, sleeper } = setUp(ANSWER_OK);
    for (const id of [1, 2, 3]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }
    clock.now = START + 400;
    for (const id of [4, 5]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }

    await api.fetchMatchMetadata(testMatchId(6));

    // The 3 oldest requests (at START) leave the window at START + 1,000: 600 ms from now.
    expect(sleeper.calls).toEqual([600]);
    expect(clock.now).toBe(START + 1_000);
  });

  it('never lets overlapping calls take the last slot twice', async () => {
    const { api, http, sleeper } = setUp(ANSWER_OK);
    for (const id of [1, 2, 3, 4]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }

    await Promise.all([
      api.fetchMatchMetadata(testMatchId(5)),
      api.fetchMatchMetadata(testMatchId(6)),
    ]);

    // One of the two took the 5th slot; the other one slept until a slot was free.
    expect(sleeper.calls).toEqual([1_000]);
    expect(sleeper.sentWhileSleeping).toEqual([5]);
    expect(http.requests).toHaveLength(6);
  });

  it('sleeps with a timer when no sleep function is given', async () => {
    const database = createTestDatabase();
    // Open the database before the timers are faked: opening it may need real timers.
    await database.select('SELECT 1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(START);
      const logger = new MemoryLogger();
      const http = new FixtureHttpClient(ANSWER_OK);
      const api = new DeadlockApiService(http, new SyncStateRepository(database, logger), logger, {
        appVersion: '0.1.0',
      });

      const calls = [1, 2, 3, 4, 5, 6].map((id) => api.fetchMatchMetadata(testMatchId(id)));
      await vi.advanceTimersByTimeAsync(0);
      expect(http.requests).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(999);
      expect(http.requests).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(http.requests).toHaveLength(6);
      await expect(Promise.all(calls)).resolves.toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a call that slept when a pause was saved in the meantime', async () => {
    const { api, http, syncState, sleeper } = setUp(ANSWER_OK);
    for (const id of [1, 2, 3, 4, 5]) {
      await api.fetchMatchMetadata(testMatchId(id));
    }
    // While the 6th call waits for its slot, another request is told to pause.
    sleeper.during = () => syncState.setPausedUntil(START + 31_000);

    await expect(api.fetchMatchMetadata(testMatchId(6))).resolves.toEqual({
      kind: 'paused',
      until: START + 31_000,
    });
    expect(http.requests).toHaveLength(5);
  });

  it('sends at most 2 requests at a time', async () => {
    const held = holdResponses();
    const { api, http, sleeper } = setUp(held.handler);

    const calls = [1, 2, 3, 4].map((id) => api.fetchMatchMetadata(testMatchId(id)));
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });
    await settle();
    expect(http.requests).toHaveLength(2);

    // Each answer frees a slot for exactly one more request.
    for (const sent of [3, 4]) {
      held.releaseNext();
      await vi.waitFor(() => {
        expect(http.requests).toHaveLength(sent);
      });
      await settle();
      expect(http.requests).toHaveLength(sent);
    }
    held.releaseNext();
    held.releaseNext();
    await Promise.all(calls);

    expect(held.peak()).toBe(2);
    expect(sleeper.calls).toEqual([]);
  });

  it('answers paused at once to a call that would wait for a slot', async () => {
    const held = holdResponses();
    const { api, http, syncState } = setUp(held.handler);
    const inFlight = [1, 2].map((id) => api.fetchMatchMetadata(testMatchId(id)));
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });
    await syncState.setPausedUntil(START + 30_000);

    // Both slots are taken, but the call does not queue for one just to learn about the pause.
    await expect(api.fetchMatchMetadata(testMatchId(3))).resolves.toEqual({
      kind: 'paused',
      until: START + 30_000,
    });

    held.releaseNext();
    held.releaseNext();
    await Promise.all(inFlight);
    expect(http.requests).toHaveLength(2);
  });

  it('answers paused to the calls waiting for a slot when a response asks for a pause', async () => {
    const held = holdResponses((_request, index) =>
      index === 0 ? jsonResponse({ status: 429 }, 429, { 'retry-after': '60' }) : jsonResponse({}),
    );
    const { api, http, clock } = setUp(held.handler);
    const [first, second, third, fourth] = [1, 2, 3, 4].map((id) =>
      api.fetchMatchMetadata(testMatchId(id)),
    );
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(2);
    });

    held.releaseNext();

    // The third and fourth calls get a slot one after the other, see the pause and send nothing.
    const paused = { kind: 'paused', until: START + 60_000 };
    await expect(Promise.all([first, third, fourth])).resolves.toEqual([paused, paused, paused]);
    expect(http.requests).toHaveLength(2);
    held.releaseNext();
    await expect(second).resolves.toEqual(FETCHED);

    // No slot was lost on the way: once the pause is over, two more requests go out together.
    clock.now = START + 61_000;
    const later = [5, 6].map((id) => api.fetchMatchMetadata(testMatchId(id)));
    await vi.waitFor(() => {
      expect(http.requests).toHaveLength(4);
    });
    held.releaseNext();
    held.releaseNext();
    await expect(Promise.all(later)).resolves.toEqual([FETCHED, FETCHED]);
  });

  const failures: readonly (readonly [string, FixtureHandler])[] = [
    [
      'a network error',
      () => {
        throw new AppError('network', 'The request failed');
      },
    ],
    [
      'a timeout',
      () => {
        throw new AppError('timeout', 'The request timed out');
      },
    ],
    ['a server error', () => jsonResponse({}, 500)],
    ['a refusal', () => jsonResponse({}, 403)],
    ['a missing match', () => jsonResponse({}, 404)],
    ['a body that is not JSON', () => ({ status: 200, headers: {}, body: 'nope' })],
    ['a 429', () => jsonResponse({}, 429, { 'retry-after': '1' })],
  ];

  it.each(failures)('frees its slot after %s', async (_name, fail) => {
    let received = 0;
    const { api, http, clock } = setUp((request) => {
      received += 1;
      return received <= 2 ? fail(request) : jsonResponse({});
    });

    // Two calls that end badly would keep both slots for good if either of them were not freed.
    for (const id of [1, 2]) {
      await api.fetchMatchMetadata(testMatchId(id)).catch(() => undefined);
      clock.now += 2 * MINUTE;
    }

    await expect(api.fetchMatchMetadata(testMatchId(3))).resolves.toEqual(FETCHED);
    expect(http.requests).toHaveLength(3);
  });

  it.each([
    [403, 'forbidden'],
    [500, 'service_unavailable'],
    [418, 'unexpected'],
  ] as const)('throws a %s as %s', async (status, kind) => {
    const { api } = setUp(() => jsonResponse({}, status));

    await expect(api.fetchMatchMetadata(testMatchId(1))).rejects.toMatchObject({
      kind,
      context: { endpoint: '/v1/matches/{match_id}/metadata', status },
    });
  });

  it('throws a body over 10 MB as an invalid payload', async () => {
    const { api } = setUp(() => ({
      status: 200,
      headers: {},
      body: 'x'.repeat(MAX_RESPONSE_BYTES + 1),
    }));

    await expect(api.fetchMatchMetadata(testMatchId(1))).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('throws a network error as an AppError without the account id', async () => {
    const { api, logger } = setUp(() => {
      throw new AppError('network', 'The request failed', {
        // The network layer quotes the URL it failed on: an account id in it must not survive.
        cause: `error sending request for url (https://api.deadlock-api.com/v1/players/${String(FIXTURE_ACCOUNT_ID)}/match-history)`,
      });
    });

    const error = await api.fetchMatchMetadata(testMatchId(1)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: 'network',
      context: { endpoint: '/v1/matches/{match_id}/metadata' },
      cause:
        'error sending request for url (https://api.deadlock-api.com/v1/players/{account_id}/match-history)',
    });
    expect(
      JSON.stringify([isAppError(error) ? errorLogContext(error) : null, logger.entries]),
    ).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('never logs a response body', async () => {
    const marker = 'BODY-MARKER-4f2a';
    const answers: readonly HttpResponse[] = [
      jsonResponse({ note: marker }),
      { status: 200, headers: {}, body: `<html>${marker}</html>` },
      jsonResponse({ error: marker }, 404),
      jsonResponse({ error: marker }, 429, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 503, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 403),
      jsonResponse({ error: marker }, 500),
    ];

    for (const answer of answers) {
      const { api, logger } = setUp(() => answer);

      const result = await api.fetchMatchMetadata(testMatchId(1)).catch((error: unknown) => error);

      // What a caller logs for a failure is the log context of its error: no body there either.
      const loggedByCaller = isAppError(result) ? errorLogContext(result) : null;
      expect(JSON.stringify([logger.entries, loggedByCaller])).not.toContain(marker);
      // The check means something only if the request itself was logged.
      expect(logger.entries.length).toBeGreaterThan(0);
    }
  });
});

describe('DeadlockApiService.fetchSteamProfile', () => {
  /** An account the fixture API knows nothing about: deadlock-api answers it an empty list. */
  const unknownAccountId = testAccountId(2_000_001);

  const PROFILE_URL = 'https://api.deadlock-api.com/v1/players/steam?account_ids=1000001';

  /** The two ways to ask: from the cache of deadlock-api, or with a refresh from Steam. */
  const plain = { refresh: false };
  const refreshed = { refresh: true };

  it('asks deadlock-api for the Steam profile of an account', async () => {
    const { api, http, logger } = setUp();

    const result = await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);

    expect(result).toEqual({
      kind: 'fetched',
      profile: { personaName: FIXTURE_PERSONA_NAME, avatarHash: FIXTURE_AVATAR_HASH },
    });
    expect(http.requests).toEqual([
      {
        method: 'GET',
        url: PROFILE_URL,
        headers: {
          'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
          Accept: 'application/json',
        },
        timeoutMs: 15_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
    ]);
    // The request is logged by the template of its endpoint, never by its URL.
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        message: 'Request answered',
        context: expect.objectContaining({
          endpoint: '/v1/players/steam',
          status: 200,
        }) as unknown,
      }),
    );
    expect(JSON.stringify(logger.entries)).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('asks Steam to refresh only when told', async () => {
    const { api, http } = setUp();

    await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);

    expect(http.requests.map((request) => request.url)).toEqual([
      PROFILE_URL,
      `${PROFILE_URL}&refresh=true`,
    ]);
  });

  it('reports an unknown player as no profile', async () => {
    const { api, syncState } = setUp();

    await expect(api.fetchSteamProfile(unknownAccountId, plain)).resolves.toEqual({
      kind: 'fetched',
      profile: null,
    });
    // An empty list is an answer, not a failure: no pause follows.
    await expect(syncState.getPausedUntil()).resolves.toBeNull();
  });

  it('keeps to 10 profile requests a minute and 3 refreshes an hour', async () => {
    const { api, http, clock } = setUp();

    // The minute: 10 requests go out, the 11th waits until the first one leaves the window.
    for (let index = 0; index < 10; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + MINUTE,
    });
    expect(http.requests).toHaveLength(10);
    clock.now = START + MINUTE;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);

    // The hour: 3 refreshes, a minute apart so that the minute is never what stops them.
    for (const minutes of [2, 3, 4]) {
      clock.now = START + minutes * MINUTE;
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
    }
    clock.now = START + 5 * MINUTE;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + 62 * MINUTE,
    });
    // The budget of the refreshes does not stop the requests that do not refresh.
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    expect(http.requests).toHaveLength(15);

    clock.now = START + 62 * MINUTE;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
  });

  it('counts a refresh in the minute as well as in the hour', async () => {
    const { api } = setUp();
    for (let index = 0; index < 3; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }

    // The 3 refreshes used 3 of the 10 requests of the minute: 7 more fit, not 8.
    for (let index = 0; index < 7; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toMatchObject({
      kind: 'budget_exhausted',
    });
  });

  it('counts a refresh that the hour refuses in no window', async () => {
    const { api, http } = setUp();
    for (let index = 0; index < 3; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toMatchObject({
      kind: 'budget_exhausted',
    });

    // Had the refused refresh been counted in the minute, only 6 more requests would fit.
    for (let index = 0; index < 7; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual(FETCHED);
    }
    expect(http.requests).toHaveLength(10);
  });

  it('counts a refresh that the minute refuses in no window', async () => {
    const { api, http, clock } = setUp();
    for (let index = 0; index < 10; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + MINUTE,
    });

    // Had the refused refresh been counted in the hour, only 2 refreshes would be left.
    clock.now = START + MINUTE;
    for (let index = 0; index < 3; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
    }
    expect(http.requests).toHaveLength(13);
  });

  it('answers the later date when both budgets refuse', async () => {
    // The hour is the later one: 3 refreshes and 7 other requests at the same moment.
    const sameMoment = setUp();
    for (let index = 0; index < 3; index += 1) {
      await sameMoment.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }
    for (let index = 0; index < 7; index += 1) {
      await sameMoment.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }
    await expect(sameMoment.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'budget_exhausted',
      nextAllowedAt: START + 60 * MINUTE,
    });

    // The minute is the later one: the oldest refresh leaves the hour half a minute before the
    // oldest request leaves the minute.
    const lateInTheHour = setUp();
    for (const minutes of [0, 1, 2]) {
      lateInTheHour.clock.now = START + minutes * MINUTE;
      await lateInTheHour.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed);
    }
    lateInTheHour.clock.now = START + 59.5 * MINUTE;
    for (let index = 0; index < 10; index += 1) {
      await lateInTheHour.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }
    await expect(
      lateInTheHour.api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed),
    ).resolves.toEqual({ kind: 'budget_exhausted', nextAllowedAt: START + 60.5 * MINUTE });
  });

  it('never lets overlapping calls exceed the budget', async () => {
    const { api, http } = setUp();
    for (let index = 0; index < 9; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain);
    }

    const results = await Promise.all([
      api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain),
      api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain),
    ]);

    expect(results.map((result) => result.kind).toSorted()).toEqual([
      'budget_exhausted',
      'fetched',
    ]);
    expect(http.requests).toHaveLength(10);
  });

  it('pauses on a 429 and answers paused', async () => {
    const { api, http, syncState } = setUp(() =>
      jsonResponse({ status: 429 }, 429, { 'retry-after': '120' }),
    );

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 120_000);

    // The pause is shared by every family of requests: the next calls send nothing.
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    await expect(api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: false })).resolves.toEqual({
      kind: 'paused',
      until: START + 120_000,
    });
    expect(http.requests).toHaveLength(1);
  });

  it('pauses on a 503 without Retry-After for the default delay', async () => {
    const { api, syncState } = setUp(() => jsonResponse({ status: 503 }, 503));

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).resolves.toEqual({
      kind: 'paused',
      until: START + DEFAULT_PAUSE_MS,
    });
    await expect(syncState.getPausedUntil()).resolves.toBe(START + DEFAULT_PAUSE_MS);
  });

  it('answers a pause that another request asked for, without sending or counting anything', async () => {
    const { api, http, syncState, clock } = setUp();
    await syncState.setPausedUntil(START + 5_000);

    for (let index = 0; index < 12; index += 1) {
      await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual({
        kind: 'paused',
        until: START + 5_000,
      });
    }
    expect(http.requests).toHaveLength(0);

    // The pause is over, and the calls it stopped used none of the budgets.
    clock.now = START + 5_000;
    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)).resolves.toEqual(FETCHED);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'service_unavailable'],
    [418, 'unexpected'],
  ] as const)('throws a %s as %s', async (status, kind) => {
    const { api } = setUp(() => jsonResponse({}, status));

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).rejects.toMatchObject({
      kind,
      context: { endpoint: '/v1/players/steam', status },
    });
  });

  it('throws an answer that is not a list as an invalid payload', async () => {
    const { api } = setUp(() => jsonResponse({ account_id: FIXTURE_ACCOUNT_ID }));

    await expect(api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('removes the account id that a transport error quotes', async () => {
    const { api, logger } = setUp(() => {
      throw new AppError('network', 'The request failed', {
        cause: `error sending request for url (${PROFILE_URL}&refresh=true)`,
      });
    });

    const error = await api
      .fetchSteamProfile(FIXTURE_ACCOUNT_ID, refreshed)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: 'network',
      context: { endpoint: '/v1/players/steam' },
      cause:
        'error sending request for url (https://api.deadlock-api.com/v1/players/steam?account_ids={account_id}&refresh=true)',
    });
    expect(
      JSON.stringify([isAppError(error) ? errorLogContext(error) : null, logger.entries]),
    ).not.toContain(String(FIXTURE_ACCOUNT_ID));
  });

  it('never logs the persona name', async () => {
    const marker = 'NAME-MARKER-7d3b';
    const answers: readonly HttpResponse[] = [
      jsonResponse([{ account_id: FIXTURE_ACCOUNT_ID, personaname: marker }]),
      jsonResponse({ personaname: marker }),
      jsonResponse([{ personaname: marker }]),
      { status: 200, headers: {}, body: `<html>${marker}</html>` },
      jsonResponse({ error: marker }, 404),
      jsonResponse({ error: marker }, 429, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 503, { 'retry-after': '5' }),
      jsonResponse({ error: marker }, 403),
      jsonResponse({ error: marker }, 500),
    ];

    for (const answer of answers) {
      const { api, logger } = setUp(() => answer);

      const result = await api
        .fetchSteamProfile(FIXTURE_ACCOUNT_ID, plain)
        .catch((error: unknown) => error);

      // What a caller logs for a failure is the log context of its error: no name there either.
      const loggedByCaller = isAppError(result) ? errorLogContext(result) : null;
      expect(JSON.stringify([logger.entries, loggedByCaller])).not.toContain(marker);
      // The check means something only if the request itself was logged.
      expect(logger.entries.length).toBeGreaterThan(0);
    }
  });
});

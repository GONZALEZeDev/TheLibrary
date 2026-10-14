/**
 * Tests of the deadlock-api service, with the development HTTP client and an in-memory database.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { AppError } from '../core/errors/app-error';
import type { Database } from '../ports/database.port';
import { createTestDatabase } from '../test/test-data';
import { DeadlockApiService } from './deadlock-api.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MINUTE = 60_000;

/**
 * Build the service on the given handler, with a controllable clock.
 *
 * @param handler - Answers the requests; the fixture API by default.
 * @param database - The database; a fresh one by default.
 * @returns The service, its HTTP client, logger and clock.
 */
function setUp(
  handler: FixtureHandler = createFixtureApi({ now: START, matchCount: 5 }),
  database: Database = createTestDatabase(),
) {
  const clock = { now: START };
  const http = new FixtureHttpClient(handler);
  const logger = new MemoryLogger();
  const syncState = new SyncStateRepository(database, logger, () => clock.now);
  const api = new DeadlockApiService(http, syncState, logger, {
    appVersion: '0.1.0',
    now: () => clock.now,
  });
  return { api, http, logger, clock, syncState };
}

describe('DeadlockApiService.fetchMatchHistory', () => {
  it('downloads and validates the history, with the User-Agent, timeout and size limit of the app', async () => {
    const { api, http } = setUp();

    const result = await api.fetchMatchHistory(FIXTURE_ACCOUNT_ID, { automatic: true });

    expect(result).toMatchObject({ kind: 'fetched', fromSteam: true });
    expect(result.kind === 'fetched' ? result.matches : []).toHaveLength(5);
    expect(http.requests).toEqual([
      {
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

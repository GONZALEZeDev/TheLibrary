/**
 * Tests of the player rank service, with the fixture API, a fake clock and an in-memory database
 * that holds the linked account (so the rank is read and written by the real repository).
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
  type FixtureRequest,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { MemoryLogger, type LogEntry } from '../adapters/dev/memory-logger.adapter';
import { AppError } from '../core/errors/app-error';
import { createTestDatabase, testAccountId, testLinkedAccount } from '../test/test-data';
import { DeadlockApiService } from './deadlock-api.service';
import { LinkedAccountRepository } from './linked-account.repository';
import { PlayerRankService, RANK_MAX_AGE_MS } from './player-rank.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The id of the synchronisation that asks for the refresh. */
const RUN = 'run-0001';

/** The badge the fixture API gives the tracked account (Sentinel 4). */
const FIXTURE_BADGE = 44;

/** A badge stored earlier, which the fixture API does not give: a refresh shows as a change. */
const STORED_BADGE = 61;

/** The message of every line about a rank that was not refreshed, at `debug` and at `warn`. */
const NOT_REFRESHED = 'Player rank not refreshed';

/**
 * Build the service on the given handler, with a controllable clock and the fixture account linked.
 *
 * @param handler - Answers the requests of deadlock-api; the fixture API by default.
 * @returns The service, the deadlock-api service under it, the repository that holds the rank, the
 *   HTTP client, the logger, the clock and the synchronisation state (where the pause is kept).
 */
async function setUp(handler: FixtureHandler = createFixtureApi({ now: START, matchCount: 1 })) {
  const clock = { now: START };
  const now = (): number => clock.now;
  const http = new FixtureHttpClient(handler);
  const logger = new MemoryLogger();
  const database = createTestDatabase();
  const accounts = new LinkedAccountRepository(database, logger);
  await accounts.setLinkedAccount(testLinkedAccount(FIXTURE_ACCOUNT_ID));
  const syncState = new SyncStateRepository(database, logger, now);
  const api = new DeadlockApiService(http, syncState, logger, { appVersion: '0.1.0', now });
  const service = new PlayerRankService({ api, accounts, logger, now });
  return { service, api, accounts, http, logger, clock, syncState };
}

/** What {@link setUp} builds. */
type TestContext = Awaited<ReturnType<typeof setUp>>;

/** Tell whether a request asks deadlock-api for the rank of a player. */
function isRankRequest(request: FixtureRequest): boolean {
  return request.url.endsWith('/rank');
}

/**
 * The lines this service wrote. The deadlock-api service writes its own lines (about the request,
 * with the endpoint as a template) in the same logger; they are not the subject of these tests.
 */
function rankLines(logger: MemoryLogger): readonly LogEntry[] {
  return logger.entries.filter((entry) => entry.scope === 'rank');
}

/**
 * Build a handler that answers every request for a rank with the given answer, and the other
 * requests like the fixture API.
 *
 * @param answer - Answers a request for a rank, or throws.
 * @returns The handler.
 */
function withRankAnswer(
  answer: (request: FixtureRequest) => ReturnType<FixtureHandler>,
): FixtureHandler {
  const fixtureApi = createFixtureApi({ now: START, matchCount: 1 });
  return (request) => (isRankRequest(request) ? answer(request) : fixtureApi(request));
}

describe('RANK_MAX_AGE_MS', () => {
  it('is a day', () => {
    expect(RANK_MAX_AGE_MS).toBe(DAY);
  });
});

describe('PlayerRankService.refreshIfDue', () => {
  it('fetches when never fetched', async () => {
    const { service, accounts, http } = await setUp();

    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);

    expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
      badge: FIXTURE_BADGE,
      fetchedAt: START,
    });
    expect(http.requests.filter(isRankRequest)).toHaveLength(1);
  });

  it('stores the badge 0 of an unranked player', async () => {
    // The tracked account of the fixture API is another one: it has no rank for ours.
    const { service, accounts } = await setUp(
      createFixtureApi({ now: START, matchCount: 1, accountId: testAccountId(2_000_001) }),
    );

    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);

    // 0 is a rank to keep (the player is unranked), not a missing one.
    expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({ badge: 0, fetchedAt: START });
  });

  it('skips a fresh rank', async () => {
    const { service, accounts, http, logger } = await setUp();
    await accounts.setRank(FIXTURE_ACCOUNT_ID, STORED_BADGE, START - HOUR);

    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);

    expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
      badge: STORED_BADGE,
      fetchedAt: START - HOUR,
    });
    expect(http.requests).toHaveLength(0);
    expect(logger.entries).toHaveLength(0);
  });

  it.each([
    ['a minute ago is kept', MINUTE, false],
    ['a day less a millisecond ago is kept', DAY - 1, false],
    ['exactly a day ago is refetched', DAY, true],
    ['a day and a millisecond ago is refetched', DAY + 1, true],
    ['a week ago is refetched', 7 * DAY, true],
  ] as const)('a rank fetched %s', async (_name, age, due) => {
    const { service, accounts, http } = await setUp();
    await accounts.setRank(FIXTURE_ACCOUNT_ID, STORED_BADGE, START - age);

    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);

    expect(http.requests.filter(isRankRequest)).toHaveLength(due ? 1 : 0);
    expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual(
      due
        ? { badge: FIXTURE_BADGE, fetchedAt: START }
        : { badge: STORED_BADGE, fetchedAt: START - age },
    );
  });

  it('refetches a rank dated in the future', async () => {
    const { service, accounts, http } = await setUp();
    // The clock moved backwards since the rank was stored: its age would be negative, and never
    // reach a day, so it would be kept for good if a future date counted as fresh.
    await accounts.setRank(FIXTURE_ACCOUNT_ID, STORED_BADGE, START + HOUR);

    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);

    expect(http.requests.filter(isRankRequest)).toHaveLength(1);
    expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
      badge: FIXTURE_BADGE,
      fetchedAt: START,
    });
  });

  it('asks once a day', async () => {
    const { service, accounts, http, clock } = await setUp();

    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);
    clock.now = START + DAY - 1;
    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);
    expect(http.requests.filter(isRankRequest)).toHaveLength(1);

    clock.now = START + DAY;
    await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);
    expect(http.requests.filter(isRankRequest)).toHaveLength(2);
    expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
      badge: FIXTURE_BADGE,
      fetchedAt: START + DAY,
    });
  });

  it.each([
    ['a network error', 'network', () => Promise.reject(new AppError('network', 'It failed'))],
    ['a timeout', 'timeout', () => Promise.reject(new AppError('timeout', 'It timed out'))],
    ['a server error', 'service_unavailable', () => jsonResponse({}, 500)],
    ['a refusal', 'forbidden', () => jsonResponse({}, 403)],
    ['an unknown player', 'not_found', () => jsonResponse({}, 404)],
    ['an answer without a badge', 'invalid_payload', () => jsonResponse({ badge: 'gold' })],
  ] as const)(
    'keeps the old rank on failure: deadlock-api answers %s',
    async (_name, kind, answer) => {
      const { service, accounts, logger } = await setUp(withRankAnswer(answer));
      await accounts.setRank(FIXTURE_ACCOUNT_ID, STORED_BADGE, START - 2 * DAY);

      // The synchronisation goes on whatever happens to the rank: the call never rejects.
      await expect(service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN)).resolves.toBeUndefined();

      expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
        badge: STORED_BADGE,
        fetchedAt: START - 2 * DAY,
      });
      expect(logger.entries).toContainEqual({
        level: 'warn',
        scope: 'rank',
        message: NOT_REFRESHED,
        context: { syncRunId: RUN, kind },
      });
    },
  );

  it('keeps the old rank when the rank cannot be read or stored', async () => {
    const unreadable = await setUp();
    vi.spyOn(unreadable.accounts, 'getRank').mockRejectedValueOnce(
      new AppError('storage', 'Could not read the linked account'),
    );
    const unwritable = await setUp();
    await unwritable.accounts.setRank(FIXTURE_ACCOUNT_ID, STORED_BADGE, START - 2 * DAY);
    vi.spyOn(unwritable.accounts, 'setRank').mockRejectedValueOnce(
      new AppError('storage', 'Could not save the rank'),
    );

    await expect(unreadable.service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN)).resolves.toBeUndefined();
    await expect(unwritable.service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN)).resolves.toBeUndefined();

    // A rank that cannot be read is not asked for: nothing says it is due.
    expect(unreadable.http.requests).toHaveLength(0);
    expect(unwritable.http.requests.filter(isRankRequest)).toHaveLength(1);
    expect(await unwritable.accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
      badge: STORED_BADGE,
      fetchedAt: START - 2 * DAY,
    });
    for (const { logger } of [unreadable, unwritable]) {
      expect(rankLines(logger)).toEqual([
        {
          level: 'warn',
          scope: 'rank',
          message: NOT_REFRESHED,
          context: { syncRunId: RUN, kind: 'storage' },
        },
      ]);
    }
  });

  it('names an error that is not an AppError as unexpected', async () => {
    const { service, accounts, logger } = await setUp();
    vi.spyOn(accounts, 'getRank').mockRejectedValueOnce(new Error('Something broke'));

    await expect(service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN)).resolves.toBeUndefined();

    expect(rankLines(logger)).toEqual([
      {
        level: 'warn',
        scope: 'rank',
        message: NOT_REFRESHED,
        context: { syncRunId: RUN, kind: 'unexpected' },
      },
    ]);
  });

  it('keeps the old rank while deadlock-api is paused', async () => {
    const pausedBeforehand = await setUp();
    await pausedBeforehand.syncState.setPausedUntil(START + 5 * MINUTE);
    const pausedByTheAnswer = await setUp(
      withRankAnswer(() => jsonResponse({}, 429, { 'retry-after': '120' })),
    );

    for (const [{ service, accounts, http, logger }, requestsSent] of [
      [pausedBeforehand, 0],
      [pausedByTheAnswer, 1],
    ] as const) {
      await accounts.setRank(FIXTURE_ACCOUNT_ID, STORED_BADGE, START - 2 * DAY);

      await expect(service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN)).resolves.toBeUndefined();

      expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
        badge: STORED_BADGE,
        fetchedAt: START - 2 * DAY,
      });
      // A pause is expected, not a fault: it is told at `debug`, and the rank is due again at the
      // next synchronisation.
      expect(rankLines(logger)).toEqual([
        {
          level: 'debug',
          scope: 'rank',
          message: NOT_REFRESHED,
          context: { syncRunId: RUN, kind: 'paused' },
        },
      ]);
      // A pause that is already running stops the request; one the answer asks for comes after it.
      expect(http.requests.filter(isRankRequest)).toHaveLength(requestsSent);
    }
  });

  it('keeps the old rank when the budget of the hour is spent', async () => {
    const { service, api, accounts, http, logger } = await setUp();
    await accounts.setRank(FIXTURE_ACCOUNT_ID, STORED_BADGE, START - 2 * DAY);
    // The 3 rank requests of the hour are spent before the service asks for its own.
    for (let index = 0; index < 3; index += 1) {
      await api.fetchPlayerRank(FIXTURE_ACCOUNT_ID);
    }

    await expect(service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN)).resolves.toBeUndefined();

    // A request over the budget is not even sent.
    expect(http.requests).toHaveLength(3);
    expect(await accounts.getRank(FIXTURE_ACCOUNT_ID)).toEqual({
      badge: STORED_BADGE,
      fetchedAt: START - 2 * DAY,
    });
    expect(rankLines(logger)).toEqual([
      {
        level: 'debug',
        scope: 'rank',
        message: NOT_REFRESHED,
        context: { syncRunId: RUN, kind: 'budget_exhausted' },
      },
    ]);
  });

  it('never logs the account id or the URL of a request', async () => {
    const accountText = String(FIXTURE_ACCOUNT_ID);
    const quotingTheAccount = (message: string): AppError =>
      new AppError('network', message, {
        context: { path: `/v1/players/${accountText}/rank` },
        cause: `error sending request for url (https://api.example.test/v1/players/${accountText}/rank)`,
      });
    const scenarios: readonly (readonly [string, () => Promise<TestContext>])[] = [
      [
        'a transport error that quotes the URL',
        () =>
          setUp(
            withRankAnswer((request) => {
              throw quotingTheAccount(`The request to ${request.url} failed`);
            }),
          ),
      ],
      [
        'an answer that holds the account id',
        () => setUp(withRankAnswer(() => jsonResponse({ account_id: FIXTURE_ACCOUNT_ID }))),
      ],
      [
        'a database error that quotes the account id',
        async () => {
          const context = await setUp();
          vi.spyOn(context.accounts, 'getRank').mockRejectedValueOnce(
            quotingTheAccount(`No rank for account ${accountText}`),
          );
          return context;
        },
      ],
      [
        'a database error on the write',
        async () => {
          const context = await setUp();
          vi.spyOn(context.accounts, 'setRank').mockRejectedValueOnce(
            new AppError('storage', `Could not save the rank of ${accountText}`),
          );
          return context;
        },
      ],
      [
        'a pause',
        async () => {
          const context = await setUp();
          await context.syncState.setPausedUntil(START + MINUTE);
          return context;
        },
      ],
    ];

    for (const [, build] of scenarios) {
      const { service, logger } = await build();

      await service.refreshIfDue(FIXTURE_ACCOUNT_ID, RUN);

      // The whole log: the lines of the deadlock-api service under this one name the endpoint as a
      // template, and must not hold the id either.
      expect(JSON.stringify(logger.entries)).not.toContain(accountText);
      // The lines of this service name no URL at all.
      expect(JSON.stringify(rankLines(logger))).not.toContain('/v1/players');
      // The check means something only if the service wrote its own line.
      expect(rankLines(logger).length).toBeGreaterThan(0);
    }
  });
});

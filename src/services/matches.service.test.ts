/**
 * Tests of the match history use cases.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { AppError } from '../core/errors/app-error';
import type { DetailStatus } from '../core/match-detail/detail-status';
import type { AccountSource } from '../ports/account-source.port';
import type { Database } from '../ports/database.port';
import {
  createTestDatabase,
  matchSummary,
  TEST_ACCOUNT_ID,
  testAccountId,
  testMatchId,
} from '../test/test-data';
import { MatchesRepository } from './matches.repository';
import { MatchesService, type HistoryFilter, type MatchListItem } from './matches.service';

/** Time of the tests (Unix ms): the clock the service reads to judge the 90-day window. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** One day, in milliseconds. */
const DAY_MS = 24 * 60 * 60_000;

/**
 * An account source returning a fixed account.
 *
 * @param accountId - The account, or `null` for none.
 * @returns The account source.
 */
function accountSource(accountId: AccountId | null): AccountSource {
  return { currentAccountId: () => Promise.resolve(accountId) };
}

/**
 * The start time of a match that began some days before {@link NOW}.
 *
 * @param days - How many days before {@link NOW}.
 * @returns The start time, in Unix seconds (a match start time is in seconds, not milliseconds).
 */
function startedDaysAgo(days: number): number {
  return (NOW - days * DAY_MS) / 1000;
}

/**
 * Set where the detail of a stored match stands, as the detail queue does.
 *
 * @param database - The database holding the match.
 * @param matchId - The match.
 * @param status - Its new detail status.
 */
async function setDetailStatus(
  database: Database,
  matchId: number,
  status: DetailStatus,
): Promise<void> {
  await database.execute('UPDATE matches SET detail_status = $1 WHERE match_id = $2', [
    status,
    matchId,
  ]);
}

/**
 * Every match of the linked account, as the history lists them.
 *
 * @param service - The service to list from.
 * @returns The matches, most recent first; the test fails when no account is linked.
 */
async function listAll(service: MatchesService): Promise<readonly MatchListItem[]> {
  const history = await service.listHistory({ hero: 'all', result: 'all' });
  expect(history.kind).toBe('ready');
  return history.kind === 'ready' ? history.matches : [];
}

/**
 * The detail status of each listed match, by match id.
 *
 * @param service - The service to list from.
 * @returns A record from match id to the detail status the list gives it.
 */
async function detailStatusesOf(service: MatchesService): Promise<Record<number, unknown>> {
  const listed = await listAll(service);
  return Object.fromEntries(listed.map((match) => [match.matchId, match.detailStatus]));
}

describe('MatchesService', () => {
  it('gives the detail status of eligible matches', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    // Five normal-mode Paige matches of the last 90 days, one for each status of the queue.
    const statuses = ['pending', 'retry', 'ready', 'unavailable', 'invalid'] as const;
    await repository.upsertMany(
      statuses.map((_, index) =>
        matchSummary({ matchId: index + 1, startTime: startedDaysAgo(index + 1) }),
      ),
    );
    for (const [index, status] of statuses.entries()) {
      await setDetailStatus(database, index + 1, status);
    }

    const service = new MatchesService(accountSource(TEST_ACCOUNT_ID), repository, () => NOW);

    await expect(detailStatusesOf(service)).resolves.toEqual({
      1: 'pending',
      2: 'retry',
      3: 'ready',
      4: 'unavailable',
      5: 'invalid',
    });
  });

  it('gives no detail status to other matches', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    const recent = startedDaysAgo(1);
    await repository.upsertMany([
      // Eligible, for contrast.
      matchSummary({ matchId: 1, startTime: recent }),
      // Another hero than Paige.
      matchSummary({ matchId: 2, startTime: recent, heroId: PAIGE_HERO_ID + 1 }),
      // Street Brawl.
      matchSummary({ matchId: 3, startTime: recent, gameMode: 4 }),
      // A private lobby.
      matchSummary({ matchId: 4, startTime: recent, matchMode: 2 }),
      // Older than 90 days.
      matchSummary({ matchId: 5, startTime: startedDaysAgo(91) }),
    ]);
    // None of them was archived, whatever the queue made of them: it is the rule, not the stored
    // status, that tells the list a match has no detail.
    await setDetailStatus(database, 4, 'retry');
    await setDetailStatus(database, 5, 'unavailable');

    const service = new MatchesService(accountSource(TEST_ACCOUNT_ID), repository, () => NOW);

    await expect(detailStatusesOf(service)).resolves.toEqual({
      1: 'pending',
      2: null,
      3: null,
      4: null,
      5: null,
    });
  });

  it('keeps the ready status of a match that left the 90-day window', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    await repository.upsertMany([
      // Archived while it was recent.
      matchSummary({ matchId: 1, startTime: startedDaysAgo(120) }),
      // Of the same age, but never archived.
      matchSummary({ matchId: 2, startTime: startedDaysAgo(120) }),
    ]);
    await setDetailStatus(database, 1, 'ready');

    const service = new MatchesService(accountSource(TEST_ACCOUNT_ID), repository, () => NOW);

    // The archive is still on disk and the detail page still shows it.
    await expect(detailStatusesOf(service)).resolves.toEqual({ 1: 'ready', 2: null });
  });

  it('judges the 90-day window with its own clock', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([matchSummary({ matchId: 1, startTime: startedDaysAgo(89) })]);

    const early = new MatchesService(accountSource(TEST_ACCOUNT_ID), repository, () => NOW);
    // Two days later the same match is 91 days old.
    const late = new MatchesService(
      accountSource(TEST_ACCOUNT_ID),
      repository,
      () => NOW + 2 * DAY_MS,
    );

    await expect(detailStatusesOf(early)).resolves.toEqual({ 1: 'pending' });
    await expect(detailStatusesOf(late)).resolves.toEqual({ 1: null });
  });

  it('getMatch reads one match of the linked account', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const wanted = matchSummary({ matchId: 2, startTime: startedDaysAgo(2), kills: 11 });
    await repository.upsertMany([
      matchSummary({ matchId: 1, startTime: startedDaysAgo(1) }),
      wanted,
      matchSummary({ matchId: 3, startTime: startedDaysAgo(3) }),
    ]);
    const service = new MatchesService(accountSource(TEST_ACCOUNT_ID), repository, () => NOW);

    // The match as the list gives it: its summary, and where its detail stands.
    await expect(service.getMatch(testMatchId(2))).resolves.toEqual({
      ...wanted,
      detailStatus: 'pending',
    });
  });

  it('getMatch answers null without an account', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    // The match is stored, but no account is linked to own it.
    await repository.upsertMany([matchSummary({ matchId: 1 })]);

    await expect(
      new MatchesService(accountSource(null), repository).getMatch(testMatchId(1)),
    ).resolves.toBeNull();
  });

  it("getMatch answers null for an unknown match or another account's match", async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      matchSummary({ matchId: 1 }),
      matchSummary({ matchId: 2, accountId: testAccountId(42) }),
    ]);
    const service = new MatchesService(accountSource(TEST_ACCOUNT_ID), repository, () => NOW);

    await expect(service.getMatch(testMatchId(9))).resolves.toBeNull();
    await expect(service.getMatch(testMatchId(2))).resolves.toBeNull();
  });

  it('getMatch gives the detail status the list gives', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    const recent = startedDaysAgo(1);
    await repository.upsertMany([
      // Eligible, with each status of the queue but `pending`, which is the default.
      matchSummary({ matchId: 1, startTime: recent }),
      matchSummary({ matchId: 2, startTime: recent }),
      matchSummary({ matchId: 3, startTime: recent }),
      matchSummary({ matchId: 4, startTime: recent }),
      matchSummary({ matchId: 5, startTime: recent }),
      // Without detail: another hero, Street Brawl, a private lobby, older than 90 days.
      matchSummary({ matchId: 6, startTime: recent, heroId: PAIGE_HERO_ID + 1 }),
      matchSummary({ matchId: 7, startTime: recent, gameMode: 4 }),
      matchSummary({ matchId: 8, startTime: recent, matchMode: 2 }),
      matchSummary({ matchId: 9, startTime: startedDaysAgo(91) }),
      // Archived while recent, and since out of the 90-day window.
      matchSummary({ matchId: 10, startTime: startedDaysAgo(120) }),
    ]);
    await setDetailStatus(database, 2, 'retry');
    await setDetailStatus(database, 3, 'ready');
    await setDetailStatus(database, 4, 'unavailable');
    await setDetailStatus(database, 5, 'invalid');
    await setDetailStatus(database, 8, 'retry');
    await setDetailStatus(database, 10, 'ready');
    const service = new MatchesService(accountSource(TEST_ACCOUNT_ID), repository, () => NOW);

    const listed = await listAll(service);

    // Every case of the list, so the one rule is shared: a match is the same item read either way.
    expect(listed).toHaveLength(10);
    for (const item of listed) {
      await expect(service.getMatch(item.matchId)).resolves.toEqual(item);
    }
    // Guard against a vacuous comparison: the cases do differ.
    expect(new Set(listed.map((item) => item.detailStatus))).toEqual(
      new Set(['pending', 'retry', 'ready', 'unavailable', 'invalid', null]),
    );
  });

  it('getMatch does not take an unreadable linked account for no account', async () => {
    const unreadable: AccountSource = {
      currentAccountId: () =>
        Promise.reject(new AppError('storage', 'The linked account is invalid')),
    };
    const service = new MatchesService(
      unreadable,
      new MatchesRepository(createTestDatabase()),
      () => NOW,
    );

    await expect(service.getMatch(testMatchId(1))).rejects.toMatchObject({ kind: 'storage' });
  });
});

describe('MatchesService.listLatest', () => {
  const ACCOUNT_ID = testAccountId(1000001);
  const OTHER_ACCOUNT_ID = testAccountId(2000001);

  /**
   * A normal-mode Paige match of the account that started some days before {@link NOW}.
   *
   * @param matchId - The match id.
   * @param days - How many days before {@link NOW} it started.
   * @param overrides - Other fields to change.
   * @returns The match.
   */
  function paigeMatch(
    matchId: number,
    days: number,
    overrides: Parameters<typeof matchSummary>[0] = {},
  ): ReturnType<typeof matchSummary> {
    return matchSummary({
      matchId,
      accountId: ACCOUNT_ID,
      startTime: startedDaysAgo(days),
      ...overrides,
    });
  }

  it('lists the latest Paige matches of the normal modes, newest first', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    await repository.upsertMany([
      paigeMatch(100000001, 3),
      paigeMatch(100000002, 1, { matchMode: 4 }),
      paigeMatch(100000003, 2),
      // Never listed: another hero, Street Brawl, a private lobby, another account.
      paigeMatch(100000004, 0, { heroId: PAIGE_HERO_ID + 1 }),
      paigeMatch(100000005, 0, { gameMode: 4 }),
      paigeMatch(100000006, 0, { matchMode: 2 }),
      paigeMatch(100000007, 0, { accountId: OTHER_ACCOUNT_ID }),
    ]);
    await setDetailStatus(database, 100000002, 'ready');
    const service = new MatchesService(accountSource(ACCOUNT_ID), repository, () => NOW);

    const latest = await service.listLatest(PAIGE_HERO_ID, 10);

    expect(latest.kind).toBe('ready');
    if (latest.kind !== 'ready') {
      return;
    }
    expect(latest.matches.map((match) => [match.matchId, match.detailStatus])).toEqual([
      [100000002, 'ready'],
      [100000003, 'pending'],
      [100000001, 'pending'],
    ]);
  });

  it('keeps the limit of matches, the newest ones', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      paigeMatch(100000001, 3),
      paigeMatch(100000002, 2),
      paigeMatch(100000003, 1),
    ]);
    const service = new MatchesService(accountSource(ACCOUNT_ID), repository, () => NOW);

    const latest = await service.listLatest(PAIGE_HERO_ID, 2);

    expect(latest.kind === 'ready' && latest.matches.map((match) => match.matchId)).toEqual([
      100000003, 100000002,
    ]);
  });

  it('sums the results of the latest matches', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      paigeMatch(100000001, 1, { won: true, kills: 8, deaths: 2, assists: 10 }),
      paigeMatch(100000002, 2, { won: false, kills: 4, deaths: 6, assists: 20 }),
      // Older than the two latest matches: out of the sums when the limit is 2.
      paigeMatch(100000003, 3, { won: true, kills: 12, deaths: 1, assists: 3 }),
    ]);
    const service = new MatchesService(accountSource(ACCOUNT_ID), repository, () => NOW);

    await expect(service.listLatest(PAIGE_HERO_ID, 2)).resolves.toMatchObject({
      kind: 'ready',
      stats: {
        matches: 2,
        wins: 1,
        winRate: 0.5,
        averageKills: 6,
        averageDeaths: 4,
        averageAssists: 15,
      },
    });
  });

  it('has no figures when there is no match', async () => {
    const service = new MatchesService(
      accountSource(ACCOUNT_ID),
      new MatchesRepository(createTestDatabase()),
      () => NOW,
    );

    await expect(service.listLatest(PAIGE_HERO_ID, 10)).resolves.toEqual({
      kind: 'ready',
      matches: [],
      stats: null,
    });
  });

  it('answers no account when no account is linked', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    // Matches are stored, but none belongs to an account that is not linked.
    await repository.upsertMany([paigeMatch(100000001, 1)]);
    const service = new MatchesService(accountSource(null), repository, () => NOW);

    await expect(service.listLatest(PAIGE_HERO_ID, 10)).resolves.toEqual({ kind: 'no_account' });
  });

  it('does not take an unreadable linked account for no account', async () => {
    const unreadable: AccountSource = {
      currentAccountId: () =>
        Promise.reject(new AppError('storage', 'The linked account is invalid')),
    };
    const service = new MatchesService(
      unreadable,
      new MatchesRepository(createTestDatabase()),
      () => NOW,
    );

    await expect(service.listLatest(PAIGE_HERO_ID, 10)).rejects.toMatchObject({
      kind: 'storage',
    });
  });
});

describe('MatchesService.listHistory', () => {
  const ACCOUNT_ID = testAccountId(1000001);
  const OTHER_ACCOUNT_ID = testAccountId(2000001);
  const OTHER_HERO_ID = PAIGE_HERO_ID + 1;

  /**
   * A match of the account that started some days before {@link NOW}.
   *
   * @param matchId - The match id.
   * @param days - How many days before {@link NOW} it started.
   * @param overrides - Other fields to change.
   * @returns The match.
   */
  function match(
    matchId: number,
    days: number,
    overrides: Parameters<typeof matchSummary>[0] = {},
  ): ReturnType<typeof matchSummary> {
    return matchSummary({
      matchId,
      accountId: ACCOUNT_ID,
      startTime: startedDaysAgo(days),
      ...overrides,
    });
  }

  /**
   * The ids of the history under a filter, as the service lists them.
   *
   * @param service - The service.
   * @param filter - The filter.
   * @returns The ids, newest first; an empty list when the history is not ready.
   */
  async function idsOf(service: MatchesService, filter: HistoryFilter): Promise<number[]> {
    const history = await service.listHistory(filter);
    return history.kind === 'ready' ? history.matches.map((item) => item.matchId) : [];
  }

  it('lists the whole history newest first', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    await repository.upsertMany([
      match(100000001, 5),
      match(100000002, 1, { matchMode: 4 }),
      match(100000003, 3, { heroId: OTHER_HERO_ID }),
      // Modes the dashboard leaves out are part of the history, and an old match too.
      match(100000004, 2, { gameMode: 4 }),
      match(100000005, 4, { matchMode: 2 }),
      match(100000006, 200),
      // Never listed: the match of another account.
      match(100000007, 0, { accountId: OTHER_ACCOUNT_ID }),
    ]);
    await setDetailStatus(database, 100000002, 'ready');
    const service = new MatchesService(accountSource(ACCOUNT_ID), repository, () => NOW);

    const history = await service.listHistory({ hero: 'all', result: 'all' });

    expect(history.kind).toBe('ready');
    if (history.kind !== 'ready') {
      return;
    }
    // The total counts every stored match of the account: with no filter it is the list's length.
    expect(history.total).toBe(6);
    expect(history.matches.map((listed) => [listed.matchId, listed.detailStatus])).toEqual([
      [100000002, 'ready'],
      [100000004, null],
      [100000003, null],
      [100000005, null],
      [100000001, 'pending'],
      [100000006, null],
    ]);
  });

  it('filters by hero and by result, and keeps the total unfiltered', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      match(100000001, 4, { won: true }),
      match(100000002, 3, { won: false }),
      match(100000003, 2, { won: true, heroId: OTHER_HERO_ID }),
      match(100000004, 1, { won: false, heroId: OTHER_HERO_ID }),
    ]);
    const service = new MatchesService(accountSource(ACCOUNT_ID), repository, () => NOW);

    await expect(idsOf(service, { hero: PAIGE_HERO_ID, result: 'all' })).resolves.toEqual([
      100000002, 100000001,
    ]);
    await expect(idsOf(service, { hero: 'all', result: 'win' })).resolves.toEqual([
      100000003, 100000001,
    ]);
    await expect(idsOf(service, { hero: 'all', result: 'loss' })).resolves.toEqual([
      100000004, 100000002,
    ]);
    await expect(idsOf(service, { hero: OTHER_HERO_ID, result: 'loss' })).resolves.toEqual([
      100000004,
    ]);
    // A hero with no match gives an empty list, and the total still counts the whole history.
    await expect(service.listHistory({ hero: 999, result: 'win' })).resolves.toEqual({
      kind: 'ready',
      total: 4,
      matches: [],
    });
  });

  it('answers no account when no account is linked', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([match(100000001, 1)]);
    const service = new MatchesService(accountSource(null), repository, () => NOW);

    await expect(service.listHistory({ hero: 'all', result: 'all' })).resolves.toEqual({
      kind: 'no_account',
    });
  });

  it('does not take an unreadable linked account for no account', async () => {
    const unreadable: AccountSource = {
      currentAccountId: () =>
        Promise.reject(new AppError('storage', 'The linked account is invalid')),
    };
    const service = new MatchesService(
      unreadable,
      new MatchesRepository(createTestDatabase()),
      () => NOW,
    );

    await expect(service.listHistory({ hero: 'all', result: 'all' })).rejects.toMatchObject({
      kind: 'storage',
    });
  });
});

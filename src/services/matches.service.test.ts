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
import { MatchesService } from './matches.service';

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
 * The detail status of each listed match, by match id.
 *
 * @param service - The service to list from.
 * @returns A record from match id to the detail status the list gives it.
 */
async function detailStatusesOf(service: MatchesService): Promise<Record<number, unknown>> {
  const recent = await service.listRecent(100);
  return Object.fromEntries(recent.matches.map((match) => [match.matchId, match.detailStatus]));
}

describe('MatchesService', () => {
  it('lists the most recent matches of the linked account and counts them all', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      matchSummary({ matchId: 1, startTime: 100 }),
      matchSummary({ matchId: 2, startTime: 200 }),
      matchSummary({ matchId: 3, startTime: 300 }),
      matchSummary({ matchId: 4, accountId: testAccountId(42) }),
    ]);

    const recent = await new MatchesService(accountSource(TEST_ACCOUNT_ID), repository).listRecent(
      2,
    );

    expect(recent.accountLinked).toBe(true);
    expect(recent.total).toBe(3);
    expect(recent.matches.map((match) => match.matchId)).toEqual([3, 2]);
  });

  it('lists nothing when no account is linked', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([matchSummary()]);

    await expect(
      new MatchesService(accountSource(null), repository).listRecent(10),
    ).resolves.toEqual({ accountLinked: false, total: 0, matches: [] });
  });

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

    const listed = (await service.listRecent(100)).matches;

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

describe('MatchesService.getPeriodSummary', () => {
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

  it('summarises the period of the linked account', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      // Inside the 7 days; the second one began exactly 7 days ago, the limit of the period.
      paigeMatch(100000001, 1, { won: true, kills: 8, deaths: 2, assists: 10 }),
      paigeMatch(100000002, 7, { won: false, kills: 4, deaths: 6, assists: 20 }),
      // Outside the 7 days, inside the 30.
      paigeMatch(100000003, 8, { won: true, kills: 12, deaths: 1, assists: 3 }),
      // Never counted, whatever the period: another hero, Street Brawl, another account.
      paigeMatch(100000004, 1, { heroId: PAIGE_HERO_ID + 1, kills: 100 }),
      paigeMatch(100000005, 1, { gameMode: 4, kills: 100 }),
      paigeMatch(100000006, 1, { accountId: OTHER_ACCOUNT_ID, kills: 100 }),
    ]);
    const service = new MatchesService(accountSource(ACCOUNT_ID), repository, () => NOW);

    await expect(service.getPeriodSummary('7d', PAIGE_HERO_ID)).resolves.toEqual({
      kind: 'stats',
      stats: {
        matches: 2,
        wins: 1,
        winRate: 0.5,
        averageKills: 6,
        averageDeaths: 4,
        averageAssists: 15,
      },
    });
    // The period decides which matches count: the wider one takes the third match in.
    await expect(service.getPeriodSummary('30d', PAIGE_HERO_ID)).resolves.toMatchObject({
      kind: 'stats',
      stats: { matches: 3, wins: 2 },
    });
  });

  it('says when the period has no match', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    // The only match is older than the period.
    await repository.upsertMany([paigeMatch(100000001, 20)]);
    const service = new MatchesService(accountSource(ACCOUNT_ID), repository, () => NOW);

    await expect(service.getPeriodSummary('7d', PAIGE_HERO_ID)).resolves.toEqual({
      kind: 'empty',
    });
  });

  it('needs a linked account', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    // Matches are stored, but none is the numbers of an account that is not linked.
    await repository.upsertMany([paigeMatch(100000001, 1)]);
    const service = new MatchesService(accountSource(null), repository, () => NOW);

    await expect(service.getPeriodSummary('7d', PAIGE_HERO_ID)).resolves.toEqual({
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

    await expect(service.getPeriodSummary('7d', PAIGE_HERO_ID)).rejects.toMatchObject({
      kind: 'storage',
    });
  });
});

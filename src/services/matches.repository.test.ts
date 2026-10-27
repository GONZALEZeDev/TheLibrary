/**
 * Tests of the storage of the match history, on an in-memory database with the real migrations.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import type { Database } from '../ports/database.port';
import {
  createTestDatabase,
  matchSummary,
  TEST_ACCOUNT_ID,
  testAccountId,
  testMatchId,
} from '../test/test-data';
import { MatchesRepository } from './matches.repository';

/** The account of the tests of the account methods and of the latest matches. */
const ACCOUNT_ID = testAccountId(1000001);

/** Another account, whose matches the methods of {@link ACCOUNT_ID} must never reach. */
const OTHER_ACCOUNT_ID = testAccountId(2000001);

/** The history with no filter: every match of a player, of every hero and result. */
const EVERY_MATCH = { heroId: null, won: null } as const;

/**
 * Insert a match row with any account id, as a damaged database could hold it. `upsertMany` cannot
 * write one: its matches carry an account id that went through `parseAccountId`.
 *
 * @param database - The database to write to.
 * @param accountId - The account id of the row, valid or not.
 * @param matchId - The match id of the row.
 */
async function insertRawMatch(
  database: Database,
  accountId: number,
  matchId: number,
): Promise<void> {
  await database.execute(
    `INSERT INTO matches (account_id, match_id, hero_id, start_time, duration_s, game_mode,
                         match_mode, won, kills, deaths, assists, net_worth, last_hits, denies,
                         rank_delta, synced_at)
     VALUES ($1, $2, 67, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, NULL, 0)`,
    [accountId, matchId],
  );
}

describe('MatchesRepository', () => {
  it('saves matches and reads them back, most recent first', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const older = matchSummary({ matchId: 1, startTime: 1_000, won: false, rankDelta: null });
    const newer = matchSummary({ matchId: 2, startTime: 2_000 });

    await repository.upsertMany([older, newer]);

    // A saved match starts as `pending` in the detail queue: the rows carry that status too.
    await expect(repository.listHistory(TEST_ACCOUNT_ID, EVERY_MATCH)).resolves.toEqual([
      { ...newer, detailStatus: 'pending' },
      { ...older, detailStatus: 'pending' },
    ]);
    await expect(repository.count(TEST_ACCOUNT_ID)).resolves.toBe(2);
  });

  it('reads where the detail of each match stands, in the same query as the match', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    await repository.upsertMany([
      matchSummary({ matchId: 1, startTime: 1_000 }),
      matchSummary({ matchId: 2, startTime: 2_000 }),
      matchSummary({ matchId: 3, startTime: 3_000 }),
    ]);
    // The detail queue writes these statuses; the history never does.
    await database.execute(`UPDATE matches SET detail_status = 'ready' WHERE match_id = $1`, [3]);
    await database.execute(`UPDATE matches SET detail_status = 'retry' WHERE match_id = $1`, [2]);
    // Count the queries the listing sends: the status must come with the rows, not from one more
    // query per match.
    const selects: string[] = [];
    const spied: Database = {
      execute: (sql, params) => database.execute(sql, params),
      select: (sql, params) => {
        selects.push(sql);
        return database.select(sql, params);
      },
    };

    const matches = await new MatchesRepository(spied).listHistory(TEST_ACCOUNT_ID, EVERY_MATCH);

    expect(matches.map((match) => [match.matchId, match.detailStatus])).toEqual([
      [3, 'ready'],
      [2, 'retry'],
      [1, 'pending'],
    ]);
    expect(selects).toHaveLength(1);
  });

  it('updates a match saved twice instead of duplicating it', async () => {
    const repository = new MatchesRepository(createTestDatabase());

    await repository.upsertMany([matchSummary({ kills: 1 })]);
    await repository.upsertMany([matchSummary({ kills: 9 })]);

    await expect(repository.count(TEST_ACCOUNT_ID)).resolves.toBe(1);
    await expect(repository.listHistory(TEST_ACCOUNT_ID, EVERY_MATCH)).resolves.toMatchObject([
      { kills: 9 },
    ]);
  });

  it('saves a history larger than one batch', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const matches = Array.from({ length: 123 }, (_, index) =>
      matchSummary({ matchId: index + 1, startTime: index }),
    );

    await repository.upsertMany(matches);

    await expect(repository.count(TEST_ACCOUNT_ID)).resolves.toBe(123);
    // The newest two, so the last batch (the newest rows) was written too.
    const history = await repository.listHistory(TEST_ACCOUNT_ID, EVERY_MATCH);
    expect(history).toHaveLength(123);
    expect(history.slice(0, 2)).toMatchObject([{ matchId: 123 }, { matchId: 122 }]);
  });

  it('keeps the matches of each player apart', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const otherPlayer = testAccountId(42);

    await repository.upsertMany([matchSummary(), matchSummary({ accountId: otherPlayer })]);

    await expect(repository.count(otherPlayer)).resolves.toBe(1);
    await expect(repository.listHistory(otherPlayer, EVERY_MATCH)).resolves.toMatchObject([
      { accountId: otherPlayer },
    ]);
  });

  it('writes the time of the synchronisation on every row', async () => {
    const database = createTestDatabase();

    await new MatchesRepository(database, () => 42).upsertMany([matchSummary()]);

    await expect(database.select('SELECT synced_at FROM matches')).resolves.toEqual([
      { synced_at: 42 },
    ]);
  });

  it('reports a database failure as a storage error', async () => {
    const broken: Database = {
      execute: () => Promise.reject(new Error('disk I/O error')),
      select: () => Promise.reject(new Error('disk I/O error')),
    };
    const repository = new MatchesRepository(broken);

    await expect(repository.upsertMany([matchSummary()])).rejects.toMatchObject({
      kind: 'storage',
      cause: new Error('disk I/O error'),
    });
    await expect(repository.count(TEST_ACCOUNT_ID)).rejects.toMatchObject({ kind: 'storage' });
  });

  it('reports an invalid stored row as a storage error', async () => {
    const database = createTestDatabase();
    // The columns are named: a later migration adds columns to `matches`, and a positional insert
    // would then have to list them all.
    await database.execute(
      `INSERT INTO matches (account_id, match_id, hero_id, start_time, duration_s, game_mode,
                           match_mode, won, kills, deaths, assists, net_worth, last_hits, denies,
                           rank_delta, synced_at)
       VALUES ($1, 1, 67, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, NULL, 0)`,
      [TEST_ACCOUNT_ID],
    );
    // A value the app cannot read: SQLite integers go beyond the safe integers of JavaScript.
    await database.execute(`UPDATE matches SET kills = 9007199254740993`);

    await expect(
      new MatchesRepository(database).listHistory(TEST_ACCOUNT_ID, EVERY_MATCH),
    ).rejects.toMatchObject({ kind: 'storage' });
  });

  it('reports a stored match id that is not a match id as a storage error', async () => {
    const database = createTestDatabase();
    await new MatchesRepository(database).upsertMany([matchSummary({ matchId: 1 })]);
    // The column is a plain INTEGER, so SQLite accepts 0, which is no match id (the first is 1).
    await database.execute(`UPDATE matches SET match_id = $1`, [0]);

    await expect(
      new MatchesRepository(database).listHistory(TEST_ACCOUNT_ID, EVERY_MATCH),
    ).rejects.toMatchObject({ kind: 'storage', message: 'A stored match is invalid' });
  });

  it('reports a corrupt detail status as a storage error, without the value', async () => {
    const database = createTestDatabase();
    await new MatchesRepository(database).upsertMany([matchSummary()]);
    // The migration refuses any status but the five known ones (a CHECK). Switching the check off
    // for the statement stands for a database damaged or edited by hand, the case the validation of
    // the rows is there for.
    await database.execute('PRAGMA ignore_check_constraints = ON');
    await database.execute(`UPDATE matches SET detail_status = $1`, ['corrupt-status']);

    await expect(
      new MatchesRepository(database).listHistory(TEST_ACCOUNT_ID, EVERY_MATCH),
    ).rejects.toMatchObject({
      kind: 'storage',
      message: 'A stored match is invalid',
      // The error names the problem; the stored value stays out of the logs.
      context: { issue: expect.not.stringContaining('corrupt-status') as unknown },
    });
  });

  it('reads one stored match', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    // A match with nothing in common with its neighbours, so that a wrong row would show.
    const wanted = matchSummary({
      accountId: ACCOUNT_ID,
      matchId: 100000002,
      startTime: 2_000,
      won: false,
      kills: 9,
      rankDelta: null,
    });
    await repository.upsertMany([
      matchSummary({ accountId: ACCOUNT_ID, matchId: 100000001, startTime: 1_000 }),
      wanted,
      matchSummary({ accountId: ACCOUNT_ID, matchId: 100000003, startTime: 3_000 }),
    ]);
    // The detail queue writes the status; the history never does.
    await database.execute(`UPDATE matches SET detail_status = 'ready' WHERE match_id = $1`, [
      wanted.matchId,
    ]);

    await expect(repository.get(ACCOUNT_ID, wanted.matchId)).resolves.toEqual({
      ...wanted,
      detailStatus: 'ready',
    });
  });

  it("answers null for another account's match or an unknown one", async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      // Only the other account has this match.
      matchSummary({ accountId: OTHER_ACCOUNT_ID, matchId: 100000001 }),
      // Both accounts have this one (the key of a match is the pair), with different numbers.
      matchSummary({ accountId: ACCOUNT_ID, matchId: 100000002, kills: 1 }),
      matchSummary({ accountId: OTHER_ACCOUNT_ID, matchId: 100000002, kills: 2 }),
    ]);

    await expect(repository.get(ACCOUNT_ID, testMatchId(100000001))).resolves.toBeNull();
    await expect(repository.get(ACCOUNT_ID, testMatchId(100000009))).resolves.toBeNull();
    // The match two accounts have is read for the account asked, never the other's.
    await expect(repository.get(ACCOUNT_ID, testMatchId(100000002))).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      kills: 1,
    });
    await expect(repository.get(OTHER_ACCOUNT_ID, testMatchId(100000001))).resolves.not.toBeNull();
  });

  it('reports an invalid stored match as a storage error when it reads one', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    await repository.upsertMany([matchSummary({ accountId: ACCOUNT_ID, matchId: 100000001 })]);
    // A value the app cannot read: SQLite integers go beyond the safe integers of JavaScript.
    await database.execute(`UPDATE matches SET kills = 9007199254740993`);

    await expect(repository.get(ACCOUNT_ID, testMatchId(100000001))).rejects.toMatchObject({
      kind: 'storage',
      message: 'A stored match is invalid',
    });
  });

  it('reports a failure of the database as a storage error when it reads one match', async () => {
    const broken: Database = {
      execute: () => Promise.reject(new Error('disk I/O error')),
      select: () => Promise.reject(new Error('disk I/O error')),
    };

    await expect(
      new MatchesRepository(broken).get(ACCOUNT_ID, testMatchId(100000001)),
    ).rejects.toMatchObject({ kind: 'storage', cause: new Error('disk I/O error') });
  });

  it('deletes every match of an account and only those', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      matchSummary({ accountId: ACCOUNT_ID, matchId: 100000001 }),
      matchSummary({ accountId: ACCOUNT_ID, matchId: 100000002 }),
      matchSummary({ accountId: OTHER_ACCOUNT_ID, matchId: 100000003 }),
    ]);

    await expect(repository.deleteAccount(ACCOUNT_ID)).resolves.toBe(2);

    await expect(repository.count(ACCOUNT_ID)).resolves.toBe(0);
    await expect(repository.listHistory(OTHER_ACCOUNT_ID, EVERY_MATCH)).resolves.toMatchObject([
      { matchId: 100000003 },
    ]);
    // Deleting an account that has no match left (an unlink retried) is not an error.
    await expect(repository.deleteAccount(ACCOUNT_ID)).resolves.toBe(0);
  });

  it('lists the accounts that have matches', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      matchSummary({ accountId: OTHER_ACCOUNT_ID, matchId: 100000001 }),
      matchSummary({ accountId: ACCOUNT_ID, matchId: 100000002 }),
      matchSummary({ accountId: ACCOUNT_ID, matchId: 100000003 }),
    ]);

    // Each account once, however many matches it has, in a stable order.
    await expect(repository.listAccountIds()).resolves.toEqual([ACCOUNT_ID, OTHER_ACCOUNT_ID]);
  });

  it('lists no account when there is no match', async () => {
    await expect(new MatchesRepository(createTestDatabase()).listAccountIds()).resolves.toEqual([]);
  });

  it('skips the stored account ids that are not valid', async () => {
    const database = createTestDatabase();
    const repository = new MatchesRepository(database);
    await repository.upsertMany([matchSummary({ accountId: ACCOUNT_ID, matchId: 100000001 })]);
    // The table does not check the account id: a damaged or hand-edited database can hold ids
    // that are no Steam account (zero, negative, beyond 32 bits). One of them must not make the
    // whole list fail, and must not be handed out as an account to delete.
    await insertRawMatch(database, 0, 100000002);
    await insertRawMatch(database, -5, 100000003);
    await insertRawMatch(database, 4_294_967_296, 100000004);

    await expect(repository.listAccountIds()).resolves.toEqual([ACCOUNT_ID]);
  });

  it('lists the latest matches of a hero in the normal modes, newest first', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      // Kept: ranked, unranked, and two matches that started the same second (the higher id first).
      matchSummary({ matchId: 100000001, accountId: ACCOUNT_ID, startTime: 1_000, matchMode: 4 }),
      matchSummary({ matchId: 100000002, accountId: ACCOUNT_ID, startTime: 3_000, matchMode: 1 }),
      matchSummary({ matchId: 100000003, accountId: ACCOUNT_ID, startTime: 3_000, matchMode: 1 }),
      // Left out: Street Brawl, a private lobby, another hero, another account.
      matchSummary({ matchId: 100000004, accountId: ACCOUNT_ID, startTime: 4_000, gameMode: 4 }),
      matchSummary({ matchId: 100000005, accountId: ACCOUNT_ID, startTime: 4_000, matchMode: 2 }),
      matchSummary({
        matchId: 100000006,
        accountId: ACCOUNT_ID,
        startTime: 4_000,
        heroId: PAIGE_HERO_ID + 1,
      }),
      matchSummary({ matchId: 100000007, accountId: OTHER_ACCOUNT_ID, startTime: 4_000 }),
    ]);

    const latest = await repository.listLatest(ACCOUNT_ID, PAIGE_HERO_ID, 10);

    expect(latest.map((match) => match.matchId)).toEqual([100000003, 100000002, 100000001]);
    // Each match comes with where its detail stands, like the rows of the other lists.
    expect(latest.every((match) => match.detailStatus === 'pending')).toBe(true);
  });

  it('stops the latest matches at the limit, keeping the newest', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      matchSummary({ matchId: 100000001, accountId: ACCOUNT_ID, startTime: 1_000 }),
      matchSummary({ matchId: 100000002, accountId: ACCOUNT_ID, startTime: 2_000 }),
      matchSummary({ matchId: 100000003, accountId: ACCOUNT_ID, startTime: 3_000 }),
    ]);

    const latest = await repository.listLatest(ACCOUNT_ID, PAIGE_HERO_ID, 2);

    expect(latest.map((match) => match.matchId)).toEqual([100000003, 100000002]);
  });

  it('lists no latest match for a player or a hero without one', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      matchSummary({ matchId: 100000001, accountId: ACCOUNT_ID, startTime: 1_000 }),
    ]);

    await expect(repository.listLatest(OTHER_ACCOUNT_ID, PAIGE_HERO_ID, 10)).resolves.toEqual([]);
    await expect(repository.listLatest(ACCOUNT_ID, PAIGE_HERO_ID + 1, 10)).resolves.toEqual([]);
  });

  it('lists the whole history of a player newest first, whatever the hero and the mode', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    await repository.upsertMany([
      matchSummary({ matchId: 100000001, accountId: ACCOUNT_ID, startTime: 1_000, matchMode: 4 }),
      // Two matches that started the same second: the higher id first, so the order never shuffles.
      matchSummary({ matchId: 100000002, accountId: ACCOUNT_ID, startTime: 3_000 }),
      matchSummary({ matchId: 100000003, accountId: ACCOUNT_ID, startTime: 3_000 }),
      // Matches the latest-match list leaves out are part of the history: Street Brawl, a private
      // lobby and another hero.
      matchSummary({ matchId: 100000004, accountId: ACCOUNT_ID, startTime: 4_000, gameMode: 4 }),
      matchSummary({ matchId: 100000005, accountId: ACCOUNT_ID, startTime: 5_000, matchMode: 2 }),
      matchSummary({
        matchId: 100000006,
        accountId: ACCOUNT_ID,
        startTime: 6_000,
        heroId: PAIGE_HERO_ID + 1,
      }),
      // Never listed: the match of another account.
      matchSummary({ matchId: 100000007, accountId: OTHER_ACCOUNT_ID, startTime: 7_000 }),
    ]);

    const history = await repository.listHistory(ACCOUNT_ID, { heroId: null, won: null });

    expect(history.map((match) => match.matchId)).toEqual([
      100000006, 100000005, 100000004, 100000003, 100000002, 100000001,
    ]);
    // Each match comes with where its detail stands, like the rows of the other lists.
    expect(history.every((match) => match.detailStatus === 'pending')).toBe(true);
  });

  it('filters the history by hero and by result', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const otherHero = PAIGE_HERO_ID + 1;
    await repository.upsertMany([
      matchSummary({ matchId: 100000001, accountId: ACCOUNT_ID, startTime: 1_000, won: true }),
      matchSummary({ matchId: 100000002, accountId: ACCOUNT_ID, startTime: 2_000, won: false }),
      matchSummary({
        matchId: 100000003,
        accountId: ACCOUNT_ID,
        startTime: 3_000,
        won: true,
        heroId: otherHero,
      }),
      matchSummary({
        matchId: 100000004,
        accountId: ACCOUNT_ID,
        startTime: 4_000,
        won: false,
        heroId: otherHero,
      }),
      // Another account, whose matches no filter reaches.
      matchSummary({ matchId: 100000005, accountId: OTHER_ACCOUNT_ID, startTime: 5_000 }),
    ]);

    /** The ids of the history under a filter. */
    const idsOf = async (heroId: number | null, won: boolean | null) =>
      (await repository.listHistory(ACCOUNT_ID, { heroId, won })).map((match) => match.matchId);

    await expect(idsOf(PAIGE_HERO_ID, null)).resolves.toEqual([100000002, 100000001]);
    await expect(idsOf(null, true)).resolves.toEqual([100000003, 100000001]);
    await expect(idsOf(null, false)).resolves.toEqual([100000004, 100000002]);
    await expect(idsOf(otherHero, true)).resolves.toEqual([100000003]);
    await expect(idsOf(PAIGE_HERO_ID, false)).resolves.toEqual([100000002]);
    // A hero with no match gives an empty list, not an error.
    await expect(idsOf(PAIGE_HERO_ID + 2, null)).resolves.toEqual([]);
    await expect(
      repository.listHistory(OTHER_ACCOUNT_ID, { heroId: PAIGE_HERO_ID, won: true }),
    ).resolves.toHaveLength(1);
  });

  it('reports a failure of the account and latest-match methods as a storage error', async () => {
    const broken: Database = {
      execute: () => Promise.reject(new Error('disk I/O error')),
      select: () => Promise.reject(new Error('disk I/O error')),
    };
    const repository = new MatchesRepository(broken);

    await expect(repository.deleteAccount(ACCOUNT_ID)).rejects.toMatchObject({
      kind: 'storage',
      cause: new Error('disk I/O error'),
    });
    await expect(repository.listAccountIds()).rejects.toMatchObject({ kind: 'storage' });
    await expect(repository.listLatest(ACCOUNT_ID, PAIGE_HERO_ID, 10)).rejects.toMatchObject({
      kind: 'storage',
    });
    await expect(
      repository.listHistory(ACCOUNT_ID, { heroId: null, won: null }),
    ).rejects.toMatchObject({ kind: 'storage' });
  });

  it('reports an invalid stored match among the latest as a storage error', async () => {
    const database: Database = {
      execute: () => Promise.resolve(0),
      select: () => Promise.resolve([{ match_id: 'many' }]),
    };

    await expect(
      new MatchesRepository(database).listLatest(ACCOUNT_ID, PAIGE_HERO_ID, 10),
    ).rejects.toMatchObject({ kind: 'storage' });
    await expect(
      new MatchesRepository(database).listHistory(ACCOUNT_ID, { heroId: null, won: null }),
    ).rejects.toMatchObject({ kind: 'storage' });
  });
});

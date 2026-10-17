/**
 * Tests of the storage of the match history, on an in-memory database with the real migrations.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { Database } from '../ports/database.port';
import {
  createTestDatabase,
  matchSummary,
  TEST_ACCOUNT_ID,
  testAccountId,
} from '../test/test-data';
import { MatchesRepository } from './matches.repository';

describe('MatchesRepository', () => {
  it('saves matches and reads them back, most recent first', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const older = matchSummary({ matchId: 1, startTime: 1_000, won: false, rankDelta: null });
    const newer = matchSummary({ matchId: 2, startTime: 2_000 });

    await repository.upsertMany([older, newer]);

    // A saved match starts as `pending` in the detail queue: the rows carry that status too.
    await expect(repository.listRecent(TEST_ACCOUNT_ID, 10)).resolves.toEqual([
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

    const matches = await new MatchesRepository(spied).listRecent(TEST_ACCOUNT_ID, 10);

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
    await expect(repository.listRecent(TEST_ACCOUNT_ID, 1)).resolves.toMatchObject([{ kills: 9 }]);
  });

  it('saves a history larger than one batch', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const matches = Array.from({ length: 123 }, (_, index) =>
      matchSummary({ matchId: index + 1, startTime: index }),
    );

    await repository.upsertMany(matches);

    await expect(repository.count(TEST_ACCOUNT_ID)).resolves.toBe(123);
    await expect(repository.listRecent(TEST_ACCOUNT_ID, 2)).resolves.toMatchObject([
      { matchId: 123 },
      { matchId: 122 },
    ]);
  });

  it('keeps the matches of each player apart', async () => {
    const repository = new MatchesRepository(createTestDatabase());
    const otherPlayer = testAccountId(42);

    await repository.upsertMany([matchSummary(), matchSummary({ accountId: otherPlayer })]);

    await expect(repository.count(otherPlayer)).resolves.toBe(1);
    await expect(repository.listRecent(otherPlayer, 10)).resolves.toMatchObject([
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
      new MatchesRepository(database).listRecent(TEST_ACCOUNT_ID, 10),
    ).rejects.toMatchObject({ kind: 'storage' });
  });

  it('reports a stored match id that is not a match id as a storage error', async () => {
    const database = createTestDatabase();
    await new MatchesRepository(database).upsertMany([matchSummary({ matchId: 1 })]);
    // The column is a plain INTEGER, so SQLite accepts 0, which is no match id (the first is 1).
    await database.execute(`UPDATE matches SET match_id = $1`, [0]);

    await expect(
      new MatchesRepository(database).listRecent(TEST_ACCOUNT_ID, 10),
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
      new MatchesRepository(database).listRecent(TEST_ACCOUNT_ID, 10),
    ).rejects.toMatchObject({
      kind: 'storage',
      message: 'A stored match is invalid',
      // The error names the problem; the stored value stays out of the logs.
      context: { issue: expect.not.stringContaining('corrupt-status') as unknown },
    });
  });
});

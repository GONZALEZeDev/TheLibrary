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

    await expect(repository.listRecent(TEST_ACCOUNT_ID, 10)).resolves.toEqual([newer, older]);
    await expect(repository.count(TEST_ACCOUNT_ID)).resolves.toBe(2);
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
    await database.execute(
      `INSERT INTO matches VALUES ($1, 1, 67, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, NULL, 0)`,
      [TEST_ACCOUNT_ID],
    );
    // A value the app cannot read: SQLite integers go beyond the safe integers of JavaScript.
    await database.execute(`UPDATE matches SET kills = 9007199254740993`);

    await expect(
      new MatchesRepository(database).listRecent(TEST_ACCOUNT_ID, 10),
    ).rejects.toMatchObject({ kind: 'storage' });
  });
});

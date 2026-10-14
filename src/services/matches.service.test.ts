/**
 * Tests of the match history use cases.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { AccountId } from '../core/domain/account';
import type { AccountSource } from '../ports/account-source.port';
import {
  createTestDatabase,
  matchSummary,
  TEST_ACCOUNT_ID,
  testAccountId,
} from '../test/test-data';
import { MatchesRepository } from './matches.repository';
import { MatchesService } from './matches.service';

/**
 * An account source returning a fixed account.
 *
 * @param accountId - The account, or `null` for none.
 * @returns The account source.
 */
function accountSource(accountId: AccountId | null): AccountSource {
  return { currentAccountId: () => Promise.resolve(accountId), missingAccountHint: null };
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
});

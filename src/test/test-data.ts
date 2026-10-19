/**
 * Test helpers for the data layer: an in-memory database on the real migrations, account ids and
 * match summaries.
 *
 * @packageDocumentation
 */
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { SqlJsDatabase } from '../adapters/dev/sql-js-database.adapter';
import type { LinkedAccount } from '../core/account/linked-account';
import { parseAccountId, type AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { parseMatchId, type MatchId, type MatchSummary } from '../core/domain/match';

/** sql.js, loaded once for the whole test file: compiling its WebAssembly module takes a while. */
let sqlJs: Promise<SqlJsStatic> | undefined;

/**
 * Create an empty database with every migration applied. Under Node, sql.js finds its
 * WebAssembly file by itself.
 *
 * @returns A new in-memory database.
 */
export function createTestDatabase(): SqlJsDatabase {
  return new SqlJsDatabase(() => (sqlJs ??= initSqlJs()));
}

/**
 * Make an account id for a test.
 *
 * @param value - A positive 32-bit integer.
 * @returns The account id.
 * @throws Error when `value` is not a valid account id (a mistake in the test).
 */
export function testAccountId(value: number): AccountId {
  const accountId = parseAccountId(value);
  if (accountId === null) {
    throw new Error(`${String(value)} is not a valid account id`);
  }
  return accountId;
}

/** The account of the tests that do not care which one. */
export const TEST_ACCOUNT_ID = testAccountId(123456789);

/**
 * Build the linked account of a test: a player named "Fixture Player" with no avatar, linked at the
 * start of the epoch and whose profile was never fetched, unless overridden.
 *
 * @param accountId - The linked account's id.
 * @param overrides - Fields to change.
 * @returns The linked account.
 */
export function testLinkedAccount(
  accountId: AccountId,
  overrides: Partial<LinkedAccount> = {},
): LinkedAccount {
  return {
    accountId,
    personaName: 'Fixture Player',
    avatarBase64: null,
    avatarHash: null,
    linkedAt: 0,
    profileFetchedAt: null,
    ...overrides,
  };
}

/**
 * Make a match id for a test.
 *
 * @param value - A positive safe integer.
 * @returns The match id.
 * @throws Error when `value` is not a valid match id (a mistake in the test).
 */
export function testMatchId(value: number): MatchId {
  const matchId = parseMatchId(value);
  if (matchId === null) {
    throw new Error(`${String(value)} is not a valid match id`);
  }
  return matchId;
}

/**
 * The fields of a match summary a test may override: the match id is given as a plain number,
 * which {@link matchSummary} turns into a {@link MatchId}.
 */
type MatchSummaryOverrides = Partial<Omit<MatchSummary, 'matchId'>> & { readonly matchId?: number };

/**
 * Build a match summary: a ranked Paige win of {@link TEST_ACCOUNT_ID} unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The match summary.
 * @throws Error when the overriding `matchId` is not a valid match id (a mistake in the test).
 */
export function matchSummary(overrides: MatchSummaryOverrides = {}): MatchSummary {
  // The match id is split off the other overrides: it is the only one that needs converting.
  const { matchId = 108501737, ...otherOverrides } = overrides;
  return {
    accountId: TEST_ACCOUNT_ID,
    matchId: testMatchId(matchId),
    heroId: PAIGE_HERO_ID,
    startTime: 1_760_000_000,
    durationS: 2_070,
    gameMode: 1,
    matchMode: 4,
    won: true,
    kills: 7,
    deaths: 3,
    assists: 18,
    netWorth: 41_250,
    lastHits: 160,
    denies: 12,
    rankDelta: 12,
    ...otherOverrides,
  };
}

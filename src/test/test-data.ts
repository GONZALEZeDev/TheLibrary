/**
 * Test helpers for the data layer: an in-memory database on the real migrations, account ids and
 * match summaries.
 *
 * @packageDocumentation
 */
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { SqlJsDatabase } from '../adapters/dev/sql-js-database.adapter';
import { parseAccountId, type AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import type { MatchSummary } from '../core/domain/match';

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
 * Build a match summary: a ranked Paige win of {@link TEST_ACCOUNT_ID} unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The match summary.
 */
export function matchSummary(overrides: Partial<MatchSummary> = {}): MatchSummary {
  return {
    accountId: TEST_ACCOUNT_ID,
    matchId: 108501737,
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
    ...overrides,
  };
}

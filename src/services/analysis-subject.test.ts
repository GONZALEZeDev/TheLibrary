/**
 * Tests of the shared analysis subject, on an in-memory database with the real migrations: each
 * outcome of {@link analysisSubjectOf} is reached through the real repositories, with synthetic
 * accounts and matches only.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import type { AccountSource } from '../ports/account-source.port';
import { createTestDatabase, matchSummary, testAccountId, testMatchId } from '../test/test-data';
import {
  analysisSubjectOf,
  archivedAccountOf,
  type AnalysisSubjectDependencies,
} from './analysis-subject';
import { MatchDetailRepository } from './match-detail.repository';
import { MatchesRepository } from './matches.repository';
import { MetricsRepository, type ProjectionRecord } from './metrics.repository';

/** The account of the tests. */
const ACCOUNT_ID = testAccountId(1000001);

/** Match ids of the tests: the nth match is `FIRST_MATCH_ID + n`. */
const FIRST_MATCH_ID = 100000001;

/** The length of the seeded matches, in seconds. */
const DURATION_S = 1_800;

/**
 * The id of the nth match of a test.
 *
 * @param n - The position, from 0.
 * @returns The match id.
 */
function matchId(n: number): MatchId {
  return testMatchId(FIRST_MATCH_ID + n);
}

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
 * Make the projection of a match: the current version of a clean match, unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The projection.
 */
function projection(overrides: Partial<ProjectionRecord> = {}): ProjectionRecord {
  return {
    version: PROJECTION_VERSION,
    playerBadge: 65,
    hasLeaver: false,
    failed: false,
    projectedAt: 1_760_000_000_000,
    ...overrides,
  };
}

/** What a test works with: the subject's dependencies, and the repository it saves projections in. */
interface Fixture {
  readonly deps: AnalysisSubjectDependencies;
  readonly metrics: MetricsRepository;
}

/** A match of the linked account to store. */
interface SeededMatch {
  /** The position of the match, from 0: its id is `FIRST_MATCH_ID + n`. */
  readonly n: number;
  /** When the match started, in Unix seconds. */
  readonly startTime: number;
  /** Whether the detail of the match is archived: marked ready the way the detail queue does it. */
  readonly archived: boolean;
}

/**
 * Open a database with the real migrations, store matches in it the way the history does, and wire
 * the dependencies of the subject on it, so that a test saves projections and reads the subject
 * through the same database. A match that is not `archived` stays as stored, which is not ready.
 *
 * @param matches - The matches of the linked account.
 * @param accountId - The linked account the source answers; `null` for none.
 * @returns The dependencies, and the metrics repository the tests save projections through.
 */
async function createSeededFixture(
  matches: readonly SeededMatch[],
  accountId: AccountId | null = ACCOUNT_ID,
): Promise<Fixture> {
  const database = createTestDatabase();
  await new MatchesRepository(database).upsertMany(
    matches.map((match) =>
      matchSummary({
        accountId: ACCOUNT_ID,
        matchId: FIRST_MATCH_ID + match.n,
        startTime: match.startTime,
        durationS: DURATION_S,
      }),
    ),
  );
  const details = new MatchDetailRepository(database);
  for (const match of matches) {
    if (match.archived) {
      await details.markReady(ACCOUNT_ID, matchId(match.n), 1_024);
    }
  }
  const metrics = new MetricsRepository(database);
  return {
    metrics,
    deps: { accountSource: accountSource(accountId), details, metrics },
  };
}

describe('analysisSubjectOf', () => {
  it('is not analysed when no account is linked', async () => {
    const { deps, metrics } = await createSeededFixture(
      [{ n: 1, startTime: 1_000, archived: true }],
      null,
    );
    await metrics.saveProjection(ACCOUNT_ID, matchId(1), projection(), new Map());

    // Even a projected, archived match has nobody to be analysed for.
    await expect(analysisSubjectOf(deps, matchId(1), 'window')).resolves.toEqual({
      kind: 'not_analysed',
    });
    await expect(analysisSubjectOf(deps, matchId(1), 'match')).resolves.toEqual({
      kind: 'not_analysed',
    });
  });

  it('is not analysed when the detail of the match is not archived, or the match is not stored', async () => {
    const { deps, metrics } = await createSeededFixture([
      { n: 1, startTime: 1_000, archived: false },
    ]);
    // A projection cannot make an unarchived match analysable: the archive is the first gate.
    await metrics.saveProjection(ACCOUNT_ID, matchId(1), projection(), new Map());

    await expect(analysisSubjectOf(deps, matchId(1), 'window')).resolves.toEqual({
      kind: 'not_analysed',
    });
    await expect(analysisSubjectOf(deps, matchId(9), 'window')).resolves.toEqual({
      kind: 'not_analysed',
    });
  });

  it('is pending, for the account, when the match has no projection or one of an older version', async () => {
    const { deps, metrics } = await createSeededFixture([
      { n: 1, startTime: 1_000, archived: true },
      { n: 2, startTime: 2_000, archived: true },
    ]);
    await metrics.saveProjection(
      ACCOUNT_ID,
      matchId(2),
      projection({ version: PROJECTION_VERSION - 1 }),
      new Map(),
    );

    // Never projected.
    await expect(analysisSubjectOf(deps, matchId(1), 'match')).resolves.toEqual({
      kind: 'pending',
      accountId: ACCOUNT_ID,
    });
    // Projected with the version before the current one: as if it was not.
    await expect(analysisSubjectOf(deps, matchId(2), 'match')).resolves.toEqual({
      kind: 'pending',
      accountId: ACCOUNT_ID,
    });
  });

  it('has failed when the projection could not read the match, whatever its window', async () => {
    const { deps, metrics } = await createSeededFixture([
      { n: 1, startTime: 1_000, archived: true }, // never projected: the window is incomplete
      { n: 2, startTime: 2_000, archived: true },
    ]);
    await metrics.saveProjection(ACCOUNT_ID, matchId(2), projection({ failed: true }), new Map());

    // A failed match has no analysis for habits to complete: the window is not looked at.
    await expect(analysisSubjectOf(deps, matchId(2), 'window')).resolves.toEqual({
      kind: 'failed',
    });
    await expect(analysisSubjectOf(deps, matchId(2), 'match')).resolves.toEqual({
      kind: 'failed',
    });
  });

  it('is pending when an earlier match of the window has no projection, unless only the match is required', async () => {
    const { deps, metrics } = await createSeededFixture([
      { n: 1, startTime: 1_000, archived: true }, // in the window of #2, never projected
      { n: 2, startTime: 2_000, archived: true },
    ]);
    await metrics.saveProjection(ACCOUNT_ID, matchId(2), projection(), new Map());

    await expect(analysisSubjectOf(deps, matchId(2), 'window')).resolves.toEqual({
      kind: 'pending',
      accountId: ACCOUNT_ID,
    });
    // The match itself is projected, which is all `match` asks for.
    await expect(analysisSubjectOf(deps, matchId(2), 'match')).resolves.toMatchObject({
      kind: 'projected',
      accountId: ACCOUNT_ID,
    });
  });

  it('is projected, with the account and the projection, once the match and its window are', async () => {
    const { deps, metrics } = await createSeededFixture([
      { n: 1, startTime: 1_000, archived: true },
      { n: 2, startTime: 2_000, archived: true },
    ]);
    await metrics.saveProjection(ACCOUNT_ID, matchId(1), projection(), new Map());
    await metrics.saveProjection(
      ACCOUNT_ID,
      matchId(2),
      projection({ playerBadge: 47, projectedAt: 1_760_000_100_000 }),
      new Map(),
    );

    const subject = await analysisSubjectOf(deps, matchId(2), 'window');

    expect(subject).toEqual({
      kind: 'projected',
      accountId: ACCOUNT_ID,
      // The stored projection: what was saved, with the length and the start of the match.
      projection: {
        matchId: matchId(2),
        version: PROJECTION_VERSION,
        playerBadge: 47,
        hasLeaver: false,
        failed: false,
        projectedAt: 1_760_000_100_000,
        durationS: DURATION_S,
        startTime: 2_000,
      },
    });
  });
});

describe('archivedAccountOf', () => {
  it('is the linked account when the detail of the match is archived, projected or not', async () => {
    const { deps, metrics } = await createSeededFixture([
      { n: 1, startTime: 1_000, archived: true },
      { n: 2, startTime: 2_000, archived: true },
    ]);
    // The first match has no projection at all: the archive is all this gate asks for.
    await metrics.saveProjection(ACCOUNT_ID, matchId(2), projection({ failed: true }), new Map());

    await expect(archivedAccountOf(deps, matchId(1))).resolves.toBe(ACCOUNT_ID);
    await expect(archivedAccountOf(deps, matchId(2))).resolves.toBe(ACCOUNT_ID);
  });

  it('is null when no account is linked', async () => {
    const { deps } = await createSeededFixture([{ n: 1, startTime: 1_000, archived: true }], null);

    await expect(archivedAccountOf(deps, matchId(1))).resolves.toBeNull();
  });

  it('is null when the detail of the match is not archived, or the match is not stored', async () => {
    const { deps } = await createSeededFixture([{ n: 1, startTime: 1_000, archived: false }]);

    await expect(archivedAccountOf(deps, matchId(1))).resolves.toBeNull();
    await expect(archivedAccountOf(deps, matchId(9))).resolves.toBeNull();
  });
});

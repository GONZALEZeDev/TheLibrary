/**
 * Tests of the storage of the detail status of the matches, on an in-memory database with the real
 * migrations (so the migration `0002` is tested too).
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import type { MatchId, MatchSummary } from '../core/domain/match';
import { ARCHIVE_FORMAT } from '../core/match-detail/archive-envelope';
import {
  DETAIL_WINDOW_MS,
  isDetailEligible,
  isRetryDue,
  MAX_RETRY_DELAY_MS,
  type DetailState,
} from '../core/match-detail/detail-status';
import type { Database } from '../ports/database.port';
import {
  createTestDatabase,
  matchSummary,
  TEST_ACCOUNT_ID,
  testAccountId,
  testMatchId,
} from '../test/test-data';
import { MatchDetailRepository, type StoredDetail } from './match-detail.repository';
import { MatchesRepository } from './matches.repository';

/** The current time of the tests (Unix milliseconds, a whole number of seconds). */
const NOW = 1_792_154_119_000;

/** One second, in milliseconds. */
const SECOND_MS = 1_000;

/** One day, in milliseconds. */
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

/** No match is being processed. */
const NONE: ReadonlySet<MatchId> = new Set();

/**
 * The start time of a match played some days before {@link NOW}.
 *
 * @param days - How many days before {@link NOW}.
 * @returns The start time, in Unix seconds (the unit of the `matches` table).
 */
function daysAgo(days: number): number {
  return (NOW - days * DAY_MS) / SECOND_MS;
}

/**
 * The fields of a match that `getDetail` hands back next to the detail state, for the rule of
 * eligibility.
 *
 * @param match - A match summary, as it was saved.
 * @returns The same four fields, as the stored detail carries them.
 */
function eligibilityFieldsOf(match: MatchSummary): StoredDetail['match'] {
  const { heroId, gameMode, matchMode, startTime } = match;
  return { heroId, gameMode, matchMode, startTime };
}

/**
 * A database holding the given matches, with the repository under test on it.
 *
 * @param matches - The matches of the history, saved like a synchronisation does.
 * @returns The database, the repository of the history and the repository under test.
 */
async function createRepositories(matches: readonly MatchSummary[]) {
  const database = createTestDatabase();
  const history = new MatchesRepository(database);
  await history.upsertMany(matches);
  return { database, history, repository: new MatchDetailRepository(database) };
}

/**
 * The state of a detail waiting for a new attempt.
 *
 * @param attempts - How many failures were counted.
 * @param nextAttemptAt - When the next attempt is due, in Unix milliseconds.
 * @returns The state.
 */
function retryState(attempts: number, nextAttemptAt: number | null): DetailState {
  return { status: 'retry', attempts, nextAttemptAt, lastError: 'http_404' };
}

/**
 * Take the due matches one after the other, as the queue does, until none is left.
 *
 * @param repository - The repository under test.
 * @param now - The current time, in Unix milliseconds.
 * @returns The ids of the due matches, in the order they were taken.
 * @throws Error when a match comes back after it was skipped: the loop would never end.
 */
async function takeAllDue(repository: MatchDetailRepository, now: number): Promise<MatchId[]> {
  const taken = new Set<MatchId>();
  let due = await repository.nextDue(TEST_ACCOUNT_ID, now, taken);
  while (due !== null) {
    if (taken.has(due.matchId)) {
      throw new Error(`Match ${String(due.matchId)} was selected although it was skipped`);
    }
    taken.add(due.matchId);
    due = await repository.nextDue(TEST_ACCOUNT_ID, now, taken);
  }
  return [...taken];
}

describe('MatchDetailRepository', () => {
  it('starts every match as pending', async () => {
    const match = matchSummary({ matchId: 1 });
    const { repository } = await createRepositories([match]);

    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toEqual({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      archivedBytes: null,
      archiveFormat: null,
      match: eligibilityFieldsOf(match),
    });
    // A match that was never synchronised has no detail state, and neither has another player's.
    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(2))).resolves.toBeNull();
    await expect(repository.getDetail(testAccountId(42), testMatchId(1))).resolves.toBeNull();
  });

  it('hands back the fields of the match that the rule of eligibility reads', async () => {
    // Four different values, so that two fields read the wrong way round cannot pass unnoticed.
    const { repository } = await createRepositories([
      matchSummary({
        matchId: 1,
        heroId: 12,
        gameMode: 4,
        matchMode: 2,
        startTime: 1_700_000_123,
      }),
    ]);

    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toMatchObject({
      match: { heroId: 12, gameMode: 4, matchMode: 2, startTime: 1_700_000_123 },
    });
  });

  it('selects the most recent due eligible match', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: daysAgo(5) }),
      matchSummary({ matchId: 2, startTime: daysAgo(1) }),
      matchSummary({ matchId: 3, startTime: daysAgo(3) }),
    ]);

    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE)).resolves.toEqual({
      matchId: testMatchId(2),
      attempts: 0,
    });
  });

  it('selects the match with the highest id when two started at the same second', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 7, startTime: daysAgo(1) }),
      matchSummary({ matchId: 9, startTime: daysAgo(1) }),
      matchSummary({ matchId: 8, startTime: daysAgo(1) }),
    ]);

    await expect(takeAllDue(repository, NOW)).resolves.toEqual([9, 8, 7].map(testMatchId));
  });

  it('never selects Street Brawl, private lobbies, other heroes or matches older than 90 days', async () => {
    const { repository } = await createRepositories([
      // The only eligible match is also the oldest, so any filter that lets another one through
      // makes it win the "most recent first" order.
      matchSummary({ matchId: 1, startTime: daysAgo(80) }),
      matchSummary({ matchId: 2, startTime: daysAgo(1), gameMode: 4 }),
      matchSummary({ matchId: 3, startTime: daysAgo(1), matchMode: 2 }),
      matchSummary({ matchId: 4, startTime: daysAgo(1), matchMode: 3 }),
      matchSummary({ matchId: 5, startTime: daysAgo(1), heroId: PAIGE_HERO_ID + 1 }),
      matchSummary({ matchId: 6, startTime: daysAgo(91) }),
      matchSummary({ matchId: 7, startTime: daysAgo(1), accountId: testAccountId(42) }),
    ]);

    await expect(takeAllDue(repository, NOW)).resolves.toEqual([testMatchId(1)]);
  });

  it('keeps a match that started exactly 90 days ago and drops the one a second older', async () => {
    const boundary = (NOW - DETAIL_WINDOW_MS) / SECOND_MS;
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: boundary }),
      matchSummary({ matchId: 2, startTime: boundary - 1 }),
    ]);

    await expect(takeAllDue(repository, NOW)).resolves.toEqual([testMatchId(1)]);
  });

  it('compares the 90 days limit to the millisecond, not to the second', async () => {
    const boundary = (NOW - DETAIL_WINDOW_MS) / SECOND_MS;
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: boundary }),
      matchSummary({ matchId: 2, startTime: boundary + 1 }),
    ]);

    // Half a second later, the limit falls between the two seconds: the first match is out.
    await expect(takeAllDue(repository, NOW + 500)).resolves.toEqual([testMatchId(2)]);
  });

  it('waits for the retry date', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: daysAgo(1) }),
    ]);
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(1), retryState(2, NOW + 60_000));

    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE)).resolves.toBeNull();
    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW + 59_999, NONE)).resolves.toBeNull();
    // The date itself is due, and the attempts counted so far come with the match.
    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW + 60_000, NONE)).resolves.toEqual({
      matchId: testMatchId(1),
      attempts: 2,
    });
  });

  it('selects a retry whose date is too far in the future', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: daysAgo(1) }),
    ]);

    // The longest wait the schedule can produce is still a wait...
    await repository.saveState(
      TEST_ACCOUNT_ID,
      testMatchId(1),
      retryState(5, NOW + MAX_RETRY_DELAY_MS),
    );
    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE)).resolves.toBeNull();

    // ...a date beyond it was written by a clock that has since been set back.
    await repository.saveState(
      TEST_ACCOUNT_ID,
      testMatchId(1),
      retryState(5, NOW + MAX_RETRY_DELAY_MS + 1),
    );
    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE)).resolves.toEqual({
      matchId: testMatchId(1),
      attempts: 5,
    });
  });

  it('never selects a match that is ready, unavailable or invalid', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: daysAgo(1) }),
      matchSummary({ matchId: 2, startTime: daysAgo(2) }),
      matchSummary({ matchId: 3, startTime: daysAgo(3) }),
    ]);
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(1), 1_024, ARCHIVE_FORMAT);
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(2), {
      status: 'unavailable',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'http_404',
    });
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(3), {
      status: 'invalid',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'invalid_payload',
    });

    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE)).resolves.toBeNull();
  });

  it('skips the matches being processed', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: daysAgo(3) }),
      matchSummary({ matchId: 2, startTime: daysAgo(2) }),
      matchSummary({ matchId: 3, startTime: daysAgo(1) }),
    ]);

    await expect(
      repository.nextDue(TEST_ACCOUNT_ID, NOW, new Set([testMatchId(3)])),
    ).resolves.toMatchObject({ matchId: testMatchId(2) });
    await expect(
      repository.nextDue(TEST_ACCOUNT_ID, NOW, new Set([testMatchId(3), testMatchId(2)])),
    ).resolves.toMatchObject({ matchId: testMatchId(1) });
    await expect(
      repository.nextDue(TEST_ACCOUNT_ID, NOW, new Set([1, 2, 3].map(testMatchId))),
    ).resolves.toBeNull();
    // An empty set skips nothing (and is still valid SQL).
    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE)).resolves.toMatchObject({
      matchId: testMatchId(3),
    });
  });

  it('records an archived match', async () => {
    const match = matchSummary({ matchId: 1, startTime: daysAgo(1) });
    const { repository } = await createRepositories([match]);
    // The match failed twice before: archiving it forgets the failures.
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(1), retryState(2, NOW + 60_000));

    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(1), 52_431, ARCHIVE_FORMAT);

    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toEqual({
      status: 'ready',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      archivedBytes: 52_431,
      archiveFormat: ARCHIVE_FORMAT,
      match: eligibilityFieldsOf(match),
    });
    await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW + DAY_MS, NONE)).resolves.toBeNull();
  });

  it('saves the state of a failed attempt', async () => {
    const match = matchSummary({ matchId: 1 });
    const { repository } = await createRepositories([match]);

    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(1), retryState(3, NOW + 7_200_000));
    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toEqual({
      status: 'retry',
      attempts: 3,
      nextAttemptAt: NOW + 7_200_000,
      lastError: 'http_404',
      archivedBytes: null,
      archiveFormat: null,
      match: eligibilityFieldsOf(match),
    });

    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(1), {
      status: 'unavailable',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'http_404',
    });
    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toMatchObject({
      status: 'unavailable',
      attempts: 6,
      nextAttemptAt: null,
    });
  });

  it('resets a match to pending', async () => {
    const first = matchSummary({ matchId: 1, startTime: daysAgo(1) });
    const second = matchSummary({ matchId: 2, startTime: daysAgo(2) });
    const { repository } = await createRepositories([first, second]);
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(1), 52_431, ARCHIVE_FORMAT);
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(2), retryState(4, NOW + 60_000));

    await repository.resetToPending(TEST_ACCOUNT_ID, testMatchId(1));
    await repository.resetToPending(TEST_ACCOUNT_ID, testMatchId(2));

    const pending = {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      archivedBytes: null,
      archiveFormat: null,
    };
    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toEqual({
      ...pending,
      match: eligibilityFieldsOf(first),
    });
    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(2))).resolves.toEqual({
      ...pending,
      match: eligibilityFieldsOf(second),
    });
    // Both are due again.
    await expect(takeAllDue(repository, NOW)).resolves.toEqual([1, 2].map(testMatchId));
  });

  it('records the archive format with a ready match', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: daysAgo(1) }),
      matchSummary({ matchId: 2, startTime: daysAgo(2) }),
    ]);

    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(1), 100, 1);
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(2), 200, ARCHIVE_FORMAT);

    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toMatchObject({
      status: 'ready',
      archivedBytes: 100,
      archiveFormat: 1,
    });
    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(2))).resolves.toMatchObject({
      status: 'ready',
      archivedBytes: 200,
      archiveFormat: ARCHIVE_FORMAT,
    });
  });

  it('forgets the format when a match goes back to pending', async () => {
    const { repository } = await createRepositories([
      matchSummary({ matchId: 1, startTime: daysAgo(1) }),
    ]);
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(1), 100, ARCHIVE_FORMAT);

    await repository.resetToPending(TEST_ACCOUNT_ID, testMatchId(1));

    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toMatchObject({
      status: 'pending',
      archiveFormat: null,
    });
  });

  describe('matches to refresh', () => {
    /**
     * Archive the given matches the way an older version did: ready, with no format recorded.
     *
     * @param database - The database.
     * @param repository - The repository under test.
     * @param ids - The ids of the matches (of the tracked player).
     */
    async function archiveWithoutFormat(
      database: Database,
      repository: MatchDetailRepository,
      ids: readonly number[],
    ): Promise<void> {
      for (const id of ids) {
        await repository.markReady(TEST_ACCOUNT_ID, testMatchId(id), 100, ARCHIVE_FORMAT);
      }
      // A file written before the column existed has a NULL format.
      await database.execute('UPDATE matches SET archive_format = NULL');
    }

    /**
     * Take the matches to refresh one after the other, as the queue does, until none is left.
     *
     * @param repository - The repository under test.
     * @returns The ids of the matches, in the order they were taken.
     */
    async function takeAllStale(repository: MatchDetailRepository): Promise<MatchId[]> {
      const taken = new Set<MatchId>();
      let stale = await repository.nextStale(TEST_ACCOUNT_ID, NOW, taken);
      while (stale !== null) {
        // No attempt is counted for a refresh.
        expect(stale.attempts).toBe(0);
        taken.add(stale.matchId);
        stale = await repository.nextStale(TEST_ACCOUNT_ID, NOW, taken);
      }
      return [...taken];
    }

    it('lists the ready matches of an unknown format, most recent first, within 90 days', async () => {
      const { database, repository } = await createRepositories([
        matchSummary({ matchId: 1, startTime: daysAgo(5) }),
        matchSummary({ matchId: 2, startTime: daysAgo(1) }),
        // Two matches that started at the same second: the highest id comes first.
        matchSummary({ matchId: 3, startTime: daysAgo(3) }),
        matchSummary({ matchId: 4, startTime: daysAgo(3) }),
        // Ready and of an unknown format, but older than 90 days, of another hero or of another
        // player: none is listed.
        matchSummary({ matchId: 5, startTime: daysAgo(91) }),
        matchSummary({ matchId: 6, startTime: daysAgo(1), heroId: PAIGE_HERO_ID + 1 }),
        matchSummary({ matchId: 7, startTime: daysAgo(1), accountId: testAccountId(42) }),
        // Not archived yet: the pending pass's, not this one's.
        matchSummary({ matchId: 8, startTime: daysAgo(1) }),
      ]);
      await archiveWithoutFormat(database, repository, [1, 2, 3, 4, 5, 6]);
      await repository.markReady(testAccountId(42), testMatchId(7), 100, ARCHIVE_FORMAT);
      await database.execute('UPDATE matches SET archive_format = NULL');

      await expect(takeAllStale(repository)).resolves.toEqual([2, 4, 3, 1].map(testMatchId));
    });

    it('skips the matches being processed', async () => {
      const { database, repository } = await createRepositories([
        matchSummary({ matchId: 1, startTime: daysAgo(2) }),
        matchSummary({ matchId: 2, startTime: daysAgo(1) }),
      ]);
      await archiveWithoutFormat(database, repository, [1, 2]);

      await expect(
        repository.nextStale(TEST_ACCOUNT_ID, NOW, new Set([testMatchId(2)])),
      ).resolves.toMatchObject({ matchId: testMatchId(1) });
      // An empty set skips nothing (and is still valid SQL).
      await expect(repository.nextStale(TEST_ACCOUNT_ID, NOW, NONE)).resolves.toMatchObject({
        matchId: testMatchId(2),
      });
      await expect(
        repository.nextStale(TEST_ACCOUNT_ID, NOW, new Set([1, 2].map(testMatchId))),
      ).resolves.toBeNull();
    });

    it('never lists a match marked final or of format 2', async () => {
      const { database, repository } = await createRepositories([
        matchSummary({ matchId: 1, startTime: daysAgo(1) }),
        matchSummary({ matchId: 2, startTime: daysAgo(2) }),
        matchSummary({ matchId: 3, startTime: daysAgo(3) }),
      ]);
      await archiveWithoutFormat(database, repository, [1, 2, 3]);
      await repository.markRefreshFinal(TEST_ACCOUNT_ID, testMatchId(1));
      await repository.markReady(TEST_ACCOUNT_ID, testMatchId(2), 100, ARCHIVE_FORMAT);

      // Only the match that was never judged is left.
      await expect(takeAllStale(repository)).resolves.toEqual([testMatchId(3)]);

      await repository.markRefreshFinal(TEST_ACCOUNT_ID, testMatchId(3));

      await expect(takeAllStale(repository)).resolves.toEqual([]);
    });

    it('keeps the status and the size when a refresh is marked final', async () => {
      const { database, repository } = await createRepositories([
        matchSummary({ matchId: 1, startTime: daysAgo(1) }),
      ]);
      await archiveWithoutFormat(database, repository, [1]);
      const before = await repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1));
      expect(before).toMatchObject({ status: 'ready', archivedBytes: 100, archiveFormat: null });

      await repository.markRefreshFinal(TEST_ACCOUNT_ID, testMatchId(1));

      // Only the format changed.
      await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toEqual({
        ...before,
        archiveFormat: 1,
      });
    });

    it('does not mark final a match reset to pending in the meantime', async () => {
      const { database, repository } = await createRepositories([
        matchSummary({ matchId: 1, startTime: daysAgo(1) }),
      ]);
      await archiveWithoutFormat(database, repository, [1]);
      // The match is reset while its refresh runs: it is no longer archived.
      await repository.resetToPending(TEST_ACCOUNT_ID, testMatchId(1));

      await repository.markRefreshFinal(TEST_ACCOUNT_ID, testMatchId(1));

      // No format is recorded for an archive the match no longer has.
      await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toMatchObject({
        status: 'pending',
        archiveFormat: null,
      });
    });
  });

  it('counts the eligible matches by status', async () => {
    const { repository } = await createRepositories([
      // Eligible: 2 pending, 1 retry, 2 ready, 1 unavailable, 1 invalid.
      matchSummary({ matchId: 1, startTime: daysAgo(1) }),
      matchSummary({ matchId: 2, startTime: daysAgo(2) }),
      matchSummary({ matchId: 3, startTime: daysAgo(3) }),
      matchSummary({ matchId: 4, startTime: daysAgo(4) }),
      matchSummary({ matchId: 5, startTime: daysAgo(5) }),
      matchSummary({ matchId: 6, startTime: daysAgo(6) }),
      matchSummary({ matchId: 7, startTime: daysAgo(7) }),
      // Not counted, whatever their status: Street Brawl, another hero, another player; and a
      // match older than 90 days that was never archived.
      matchSummary({ matchId: 8, startTime: daysAgo(1), gameMode: 4 }),
      matchSummary({ matchId: 9, startTime: daysAgo(1), heroId: PAIGE_HERO_ID + 1 }),
      matchSummary({ matchId: 10, startTime: daysAgo(91) }),
      matchSummary({ matchId: 11, startTime: daysAgo(1), accountId: testAccountId(42) }),
    ]);
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(3), retryState(1, NOW + 60_000));
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(4), 100, ARCHIVE_FORMAT);
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(5), 100, ARCHIVE_FORMAT);
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(6), {
      status: 'unavailable',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'http_404',
    });
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(7), {
      status: 'invalid',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'invalid_payload',
    });
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(8), 100, ARCHIVE_FORMAT);
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(9), 100, ARCHIVE_FORMAT);

    await expect(repository.summary(TEST_ACCOUNT_ID, NOW)).resolves.toEqual({
      archived: 2,
      waiting: 3,
      unavailable: 1,
      invalid: 1,
    });
  });

  it('keeps counting an archived match once it is older than 90 days', async () => {
    const { repository } = await createRepositories([
      // Archived, and 91 and 200 days old: the archive is still on disk and still shown.
      matchSummary({ matchId: 1, startTime: daysAgo(91) }),
      matchSummary({ matchId: 2, startTime: daysAgo(200) }),
      matchSummary({ matchId: 3, startTime: daysAgo(1) }),
      // Older than 90 days and in every other state: out of the window, so not counted.
      matchSummary({ matchId: 4, startTime: daysAgo(91) }),
      matchSummary({ matchId: 5, startTime: daysAgo(91) }),
      matchSummary({ matchId: 6, startTime: daysAgo(91) }),
      matchSummary({ matchId: 7, startTime: daysAgo(91) }),
      // Archived and old, but not a match the queue ever archives: Street Brawl, another hero,
      // a private lobby, another player.
      matchSummary({ matchId: 8, startTime: daysAgo(91), gameMode: 4 }),
      matchSummary({ matchId: 9, startTime: daysAgo(91), heroId: PAIGE_HERO_ID + 1 }),
      matchSummary({ matchId: 10, startTime: daysAgo(91), matchMode: 2 }),
      matchSummary({ matchId: 11, startTime: daysAgo(91), accountId: testAccountId(42) }),
    ]);
    for (const matchId of [1, 2, 3]) {
      await repository.markReady(TEST_ACCOUNT_ID, testMatchId(matchId), 100, ARCHIVE_FORMAT);
    }
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(5), retryState(1, NOW + 60_000));
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(6), {
      status: 'unavailable',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'http_404',
    });
    await repository.saveState(TEST_ACCOUNT_ID, testMatchId(7), {
      status: 'invalid',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'invalid_payload',
    });
    for (const matchId of [8, 9, 10]) {
      await repository.markReady(TEST_ACCOUNT_ID, testMatchId(matchId), 100, ARCHIVE_FORMAT);
    }
    await repository.markReady(testAccountId(42), testMatchId(11), 100, ARCHIVE_FORMAT);

    await expect(repository.summary(TEST_ACCOUNT_ID, NOW)).resolves.toEqual({
      archived: 3,
      waiting: 0,
      unavailable: 0,
      invalid: 0,
    });
  });

  it('counts nothing for a player without matches', async () => {
    const { repository } = await createRepositories([]);

    await expect(repository.summary(TEST_ACCOUNT_ID, NOW)).resolves.toEqual({
      archived: 0,
      waiting: 0,
      unavailable: 0,
      invalid: 0,
    });
  });

  it('keeps the detail state when the history is synchronised again', async () => {
    const { history, repository } = await createRepositories([
      matchSummary({ matchId: 1, kills: 1 }),
    ]);
    await repository.markReady(TEST_ACCOUNT_ID, testMatchId(1), 52_431, ARCHIVE_FORMAT);

    const resynchronised = matchSummary({ matchId: 1, kills: 9 });
    await history.upsertMany([resynchronised]);

    // The history columns follow the new synchronisation, the detail columns are left alone.
    await expect(history.listRecent(TEST_ACCOUNT_ID, 1)).resolves.toMatchObject([{ kills: 9 }]);
    await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).resolves.toEqual({
      status: 'ready',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      archivedBytes: 52_431,
      archiveFormat: ARCHIVE_FORMAT,
      match: eligibilityFieldsOf(resynchronised),
    });
  });

  describe('against the rules of the core', () => {
    it.each([NOW, NOW + 500])('selects what isDetailEligible accepts, at %i', async (now) => {
      // Every combination of the fields the rule reads, around the 90 days limit.
      const boundary = Math.floor((now - DETAIL_WINDOW_MS) / SECOND_MS);
      const matches: MatchSummary[] = [];
      for (const heroId of [PAIGE_HERO_ID, PAIGE_HERO_ID + 1]) {
        for (const gameMode of [1, 2, 4]) {
          for (const matchMode of [1, 2, 3, 4]) {
            for (const startTime of [boundary - 1, boundary, boundary + 1]) {
              matches.push(
                matchSummary({
                  matchId: matches.length + 1,
                  heroId,
                  gameMode,
                  matchMode,
                  startTime,
                }),
              );
            }
          }
        }
      }
      const { repository } = await createRepositories(matches);

      const expected = matches
        .filter((match) => isDetailEligible(match, now))
        .map((match) => match.matchId);
      const taken = await takeAllDue(repository, now);

      // Some combinations must be in and others out, or the comparison would prove nothing.
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(matches.length);
      expect(taken.toSorted((first, second) => first - second)).toEqual(expected);
      // The summary counts the same matches: all of them are waiting.
      await expect(repository.summary(TEST_ACCOUNT_ID, now)).resolves.toMatchObject({
        waiting: expected.length,
      });
    });

    it('selects what isRetryDue accepts', async () => {
      const dates = [
        null,
        NOW - 1,
        NOW,
        NOW + 1,
        NOW + MAX_RETRY_DELAY_MS,
        NOW + MAX_RETRY_DELAY_MS + 1,
      ];
      const { repository } = await createRepositories(
        dates.map((_, index) => matchSummary({ matchId: index + 1, startTime: daysAgo(1) })),
      );
      for (const [index, date] of dates.entries()) {
        await repository.saveState(TEST_ACCOUNT_ID, testMatchId(index + 1), retryState(1, date));
      }

      const expected = dates
        .map((date, index) => (isRetryDue(date, NOW) ? testMatchId(index + 1) : null))
        .filter((matchId) => matchId !== null);
      const taken = await takeAllDue(repository, NOW);

      expect(expected).toHaveLength(4);
      expect(taken.toSorted((first, second) => first - second)).toEqual(expected);
    });
  });

  describe('failures', () => {
    it('reports a database failure as a storage error', async () => {
      const broken: Database = {
        execute: () => Promise.reject(new Error('disk I/O error')),
        select: () => Promise.reject(new Error('disk I/O error')),
      };
      const repository = new MatchDetailRepository(broken);
      const matchId = testMatchId(1);
      const state = retryState(1, NOW);

      const calls = [
        repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE),
        repository.getDetail(TEST_ACCOUNT_ID, matchId),
        repository.markReady(TEST_ACCOUNT_ID, matchId, 1, ARCHIVE_FORMAT),
        repository.nextStale(TEST_ACCOUNT_ID, NOW, NONE),
        repository.markRefreshFinal(TEST_ACCOUNT_ID, matchId),
        repository.saveState(TEST_ACCOUNT_ID, matchId, state),
        repository.resetToPending(TEST_ACCOUNT_ID, matchId),
        repository.summary(TEST_ACCOUNT_ID, NOW),
      ];
      for (const call of calls) {
        await expect(call).rejects.toMatchObject({
          kind: 'storage',
          cause: new Error('disk I/O error'),
        });
      }
    });

    it('reports an invalid stored row as a storage error', async () => {
      const { database, repository } = await createRepositories([
        matchSummary({ matchId: 1, startTime: daysAgo(1) }),
      ]);
      // A value the app cannot read: no constraint of the table refuses a negative count.
      await database.execute('UPDATE matches SET detail_attempts = -1');

      await expect(repository.nextDue(TEST_ACCOUNT_ID, NOW, NONE)).rejects.toMatchObject({
        kind: 'storage',
      });
      await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).rejects.toMatchObject({
        kind: 'storage',
      });
    });

    it.each(['hero_id', 'game_mode', 'match_mode', 'start_time'])(
      'reports a %s the app cannot read as a storage error',
      async (column) => {
        const { database, repository } = await createRepositories([matchSummary({ matchId: 1 })]);
        // The table stores any 64-bit integer, but one past 2^53 cannot be told apart from its
        // neighbours once it is a number: the app refuses it instead of reading a wrong value.
        await database.execute(`UPDATE matches SET ${column} = 9007199254740993`);

        await expect(repository.getDetail(TEST_ACCOUNT_ID, testMatchId(1))).rejects.toMatchObject({
          kind: 'storage',
          // The error names the column, never the stored value.
          context: { field: column },
        });
      },
    );

    it('refuses a status the table does not know', async () => {
      const { database } = await createRepositories([matchSummary({ matchId: 1 })]);

      // The CHECK constraint of the migration is the last guard against a mistyped status.
      await expect(database.execute("UPDATE matches SET detail_status = 'done'")).rejects.toThrow();
    });
  });

  it('binds every value instead of writing it in the SQL text', async () => {
    const database = createTestDatabase();
    const statements: string[] = [];
    // A database that remembers the SQL it was given.
    const recording: Database = {
      execute: (sql, params) => {
        statements.push(sql);
        return database.execute(sql, params);
      },
      select: (sql, params) => {
        statements.push(sql);
        return database.select(sql, params);
      },
    };
    const repository = new MatchDetailRepository(recording);
    const matchId = testMatchId(987_654_321);
    await new MatchesRepository(database).upsertMany([
      matchSummary({ matchId: 987_654_321, startTime: daysAgo(1) }),
    ]);

    await repository.nextDue(TEST_ACCOUNT_ID, NOW, new Set([testMatchId(987_654_322)]));
    await repository.getDetail(TEST_ACCOUNT_ID, matchId);
    await repository.markReady(TEST_ACCOUNT_ID, matchId, 4_242_424, ARCHIVE_FORMAT);
    await repository.saveState(TEST_ACCOUNT_ID, matchId, retryState(1, NOW + 5_555_555));
    await repository.resetToPending(TEST_ACCOUNT_ID, matchId);
    await repository.summary(TEST_ACCOUNT_ID, NOW);
    await repository.nextStale(TEST_ACCOUNT_ID, NOW, new Set([testMatchId(987_654_322)]));
    await repository.markRefreshFinal(TEST_ACCOUNT_ID, matchId);

    expect(statements).toHaveLength(8);
    for (const sql of statements) {
      for (const value of [TEST_ACCOUNT_ID, 987_654_321, 987_654_322, NOW, 4_242_424, 5_555_555]) {
        expect(sql).not.toContain(String(value));
      }
    }
  });
});

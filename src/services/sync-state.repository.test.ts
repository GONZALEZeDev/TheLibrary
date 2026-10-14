/**
 * Tests of the storage of the synchronisation state, on an in-memory database.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { INITIAL_ACCOUNT_SYNC_STATE, type AccountSyncState } from '../core/sync/sync-status';
import { createTestDatabase, TEST_ACCOUNT_ID, testAccountId } from '../test/test-data';
import { SyncStateRepository } from './sync-state.repository';

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

/** A synchronisation state with every field set. */
const SYNCED: AccountSyncState = {
  lastSync: {
    finishedAt: 5_000,
    outcome: 'synced',
    errorKind: null,
    newMatches: 3,
    historyFetchedAt: 4_000,
    historyFromSteam: false,
  },
  protectedAccount: false,
};

describe('SyncStateRepository', () => {
  it('returns the defaults when nothing is saved', async () => {
    const repository = new SyncStateRepository(createTestDatabase(), new MemoryLogger());

    await expect(repository.getHistoryRequests()).resolves.toEqual([]);
    await expect(repository.getPausedUntil()).resolves.toBeNull();
    await expect(repository.getAccountState(TEST_ACCOUNT_ID)).resolves.toEqual(
      INITIAL_ACCOUNT_SYNC_STATE,
    );
  });

  it('saves and reads back every value', async () => {
    const repository = new SyncStateRepository(createTestDatabase(), new MemoryLogger());

    await repository.setHistoryRequests([1, 2, 3]);
    await repository.setPausedUntil(9_000);
    await repository.setAccountState(TEST_ACCOUNT_ID, SYNCED);

    await expect(repository.getHistoryRequests()).resolves.toEqual([1, 2, 3]);
    await expect(repository.getPausedUntil()).resolves.toBe(9_000);
    await expect(repository.getAccountState(TEST_ACCOUNT_ID)).resolves.toEqual(SYNCED);
  });

  it('limits to an hour a pause saved before the system clock moved backwards', async () => {
    const clock = { now: 10 * HOUR };
    const repository = new SyncStateRepository(
      createTestDatabase(),
      new MemoryLogger(),
      () => clock.now,
    );
    await repository.setPausedUntil(clock.now + HOUR);

    clock.now -= 2 * HOUR;
    await expect(repository.getPausedUntil()).resolves.toBe(9 * HOUR);
    // The bound is saved: it does not move forward with the clock.
    clock.now += HOUR / 2;
    await expect(repository.getPausedUntil()).resolves.toBe(9 * HOUR);
  });

  it('replaces a saved value and keeps the accounts apart', async () => {
    const repository = new SyncStateRepository(createTestDatabase(), new MemoryLogger());
    const protectedState = { ...SYNCED, protectedAccount: true };

    await repository.setAccountState(TEST_ACCOUNT_ID, SYNCED);
    await repository.setAccountState(TEST_ACCOUNT_ID, protectedState);
    await repository.setPausedUntil(9_000);
    await repository.setPausedUntil(null);

    await expect(repository.getAccountState(TEST_ACCOUNT_ID)).resolves.toEqual(protectedState);
    await expect(repository.getAccountState(testAccountId(42))).resolves.toEqual(
      INITIAL_ACCOUNT_SYNC_STATE,
    );
    await expect(repository.getPausedUntil()).resolves.toBeNull();
  });

  it('survives a restart: a new repository on the same database reads the same values', async () => {
    const database = createTestDatabase();
    await new SyncStateRepository(database, new MemoryLogger()).setHistoryRequests([7]);

    await expect(
      new SyncStateRepository(database, new MemoryLogger()).getHistoryRequests(),
    ).resolves.toEqual([7]);
  });

  it('replaces an unreadable value by its default and logs it without the account id', async () => {
    const database = createTestDatabase();
    const logger = new MemoryLogger();
    const repository = new SyncStateRepository(database, logger);
    await repository.setAccountState(TEST_ACCOUNT_ID, SYNCED);
    await repository.setHistoryRequests([1]);
    await database.execute(`UPDATE sync_state SET value_json = '{"lastSync":"yesterday"}'`);

    await expect(repository.getAccountState(TEST_ACCOUNT_ID)).resolves.toEqual(
      INITIAL_ACCOUNT_SYNC_STATE,
    );
    await expect(repository.getHistoryRequests()).resolves.toEqual([]);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      scope: 'sync.state',
      message: 'Ignored an unreadable synchronisation state value',
      context: { key: 'account.{account_id}.sync' },
    });
    expect(JSON.stringify(logger.entries)).not.toContain(String(TEST_ACCOUNT_ID));
  });

  it('reads a value that is not JSON as unreadable', async () => {
    const database = createTestDatabase();
    const repository = new SyncStateRepository(database, new MemoryLogger());
    await repository.setPausedUntil(5);
    await database.execute(`UPDATE sync_state SET value_json = 'not json'`);

    await expect(repository.getPausedUntil()).resolves.toBeNull();
  });

  it('writes the time of each change', async () => {
    const database = createTestDatabase();

    await new SyncStateRepository(database, new MemoryLogger(), () => 77).setPausedUntil(1);

    await expect(database.select('SELECT updated_at FROM sync_state')).resolves.toEqual([
      { updated_at: 77 },
    ]);
  });
});

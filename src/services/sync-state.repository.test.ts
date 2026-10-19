/**
 * Tests of the storage of the synchronisation state, on an in-memory database.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { INITIAL_ACCOUNT_SYNC_STATE, type AccountSyncState } from '../core/sync/sync-status';
import type { Database } from '../ports/database.port';
import { createTestDatabase, TEST_ACCOUNT_ID, testAccountId } from '../test/test-data';
import { SyncStateRepository } from './sync-state.repository';

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

/** Two synthetic accounts, for the tests that keep one account's state apart from another's. */
const FIRST_ACCOUNT = testAccountId(1000001);
const SECOND_ACCOUNT = testAccountId(2000001);

/** A database whose every statement fails, as a locked or damaged file would. */
const BROKEN_DATABASE: Database = {
  execute: () => Promise.reject(new Error('disk I/O error')),
  select: () => Promise.reject(new Error('disk I/O error')),
};

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

  it('deletes the state of one account only', async () => {
    const repository = new SyncStateRepository(createTestDatabase(), new MemoryLogger());
    await repository.setAccountState(FIRST_ACCOUNT, SYNCED);
    await repository.setAccountState(SECOND_ACCOUNT, SYNCED);
    await repository.setHistoryRequests([1, 2]);
    await repository.setPausedUntil(9_000);
    await repository.setVacuumPending(true);

    await repository.deleteAccountState(FIRST_ACCOUNT);

    await expect(repository.hasAccountState(FIRST_ACCOUNT)).resolves.toBe(false);
    await expect(repository.getAccountState(FIRST_ACCOUNT)).resolves.toEqual(
      INITIAL_ACCOUNT_SYNC_STATE,
    );
    // The other account and the values that belong to no account stay.
    await expect(repository.hasAccountState(SECOND_ACCOUNT)).resolves.toBe(true);
    await expect(repository.getHistoryRequests()).resolves.toEqual([1, 2]);
    await expect(repository.getPausedUntil()).resolves.toBe(9_000);
    await expect(repository.isVacuumPending()).resolves.toBe(true);
    // An unlink that is retried deletes what is already gone: not an error.
    await expect(repository.deleteAccountState(FIRST_ACCOUNT)).resolves.toBeUndefined();
  });

  it('tells whether an account has a saved state', async () => {
    const repository = new SyncStateRepository(createTestDatabase(), new MemoryLogger());
    await expect(repository.hasAccountState(FIRST_ACCOUNT)).resolves.toBe(false);

    await repository.setAccountState(FIRST_ACCOUNT, INITIAL_ACCOUNT_SYNC_STATE);

    await expect(repository.hasAccountState(FIRST_ACCOUNT)).resolves.toBe(true);
    await expect(repository.hasAccountState(SECOND_ACCOUNT)).resolves.toBe(false);
  });

  it('lists the accounts with a saved state', async () => {
    const database = createTestDatabase();
    const repository = new SyncStateRepository(database, new MemoryLogger());
    await expect(repository.listAccountIds()).resolves.toEqual([]);
    await repository.setAccountState(SECOND_ACCOUNT, SYNCED);
    await repository.setAccountState(FIRST_ACCOUNT, SYNCED);
    await repository.setAccountState(testAccountId(300), SYNCED);
    // The largest account id, 2^32 - 1: ten digits, and still an account.
    await repository.setAccountState(testAccountId(4_294_967_295), SYNCED);
    await repository.setHistoryRequests([1]);
    await repository.setPausedUntil(9_000);
    await repository.setVacuumPending(true);
    // Keys that look like an account's but are not one `deleteAccountState` could ever delete.
    for (const key of [
      'account.abc.sync',
      'account.0.sync',
      // Ten digits, so it fits the pattern of a key; only the account id check refuses it (2^32).
      'account.4294967296.sync',
      'account.99999999999.sync',
      'account.0000300.sync',
      'account.4000001.sync.old',
      'ACCOUNT.4000002.SYNC',
      'x.account.4000003.sync',
    ]) {
      await database.execute(
        "INSERT INTO sync_state (key, value_json, updated_at) VALUES ($1, '{}', 0)",
        [key],
      );
    }

    // In numeric order, not in the order of the keys as text.
    await expect(repository.listAccountIds()).resolves.toEqual([
      testAccountId(300),
      FIRST_ACCOUNT,
      SECOND_ACCOUNT,
      testAccountId(4_294_967_295),
    ]);
  });

  it('remembers a pending compaction', async () => {
    const database = createTestDatabase();
    const repository = new SyncStateRepository(database, new MemoryLogger());
    await expect(repository.isVacuumPending()).resolves.toBe(false);

    await repository.setVacuumPending(true);

    // A new repository on the same database is the app after a restart.
    const afterRestart = new SyncStateRepository(database, new MemoryLogger());
    await expect(afterRestart.isVacuumPending()).resolves.toBe(true);
    await afterRestart.setVacuumPending(false);
    await expect(repository.isVacuumPending()).resolves.toBe(false);
    await expect(
      database.select("SELECT value_json FROM sync_state WHERE key = 'maintenance.vacuum_pending'"),
    ).resolves.toEqual([{ value_json: 'false' }]);
  });

  it('reads an unreadable pending compaction as not pending, and logs the key', async () => {
    const database = createTestDatabase();
    const logger = new MemoryLogger();
    const repository = new SyncStateRepository(database, logger);
    await repository.setVacuumPending(true);
    await database.execute(`UPDATE sync_state SET value_json = '"yes"'`);

    await expect(repository.isVacuumPending()).resolves.toBe(false);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      scope: 'sync.state',
      message: 'Ignored an unreadable synchronisation state value',
      context: { key: 'maintenance.vacuum_pending' },
    });
  });

  it.each([
    [
      'deleting the state of an account',
      (repository: SyncStateRepository) => repository.deleteAccountState(FIRST_ACCOUNT),
    ],
    [
      'asking whether an account has a state',
      (repository: SyncStateRepository) => repository.hasAccountState(FIRST_ACCOUNT),
    ],
    ['listing the accounts', (repository: SyncStateRepository) => repository.listAccountIds()],
    [
      'reading the pending compaction',
      (repository: SyncStateRepository) => repository.isVacuumPending(),
    ],
    [
      'saving the pending compaction',
      (repository: SyncStateRepository) => repository.setVacuumPending(true),
    ],
  ])('fails with a storage error when the database fails while %s', async (_name, run) => {
    const repository = new SyncStateRepository(BROKEN_DATABASE, new MemoryLogger());

    await expect(run(repository)).rejects.toMatchObject({ name: 'AppError', kind: 'storage' });
  });
});

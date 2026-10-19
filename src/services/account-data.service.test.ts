/**
 * Tests of the deletion of an account's local data and of the startup sweep, end to end on the
 * development adapters: two accounts are synchronised for real (history, details and archives) into
 * the same in-memory database and archive, then the service deletes what it must and keeps the rest.
 * The tests of the maintenance repository are here too: it is two statements, the `VACUUM` and the
 * checkpoint of the log that follows it.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import { createFixtureApi } from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { MemoryArchiveStore } from '../adapters/dev/memory-archive-store.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { accountFolderName } from '../core/match-detail/archive-layout';
import { INITIAL_ACCOUNT_SYNC_STATE } from '../core/sync/sync-status';
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Database, SqlRow, SqlValue } from '../ports/database.port';
import { createTestServices } from '../test/create-test-services';
import { createTestDatabase, matchSummary, testAccountId } from '../test/test-data';
import { AccountDataService } from './account-data.service';
import { DatabaseMaintenanceRepository } from './database-maintenance.repository';
import { MatchesRepository } from './matches.repository';
import { SyncStateRepository } from './sync-state.repository';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Size of the synthetic history of each account. Every test synchronises two accounts for real, and
 * each archive is compressed for real, so the history is kept short: just long enough for each
 * account to have a Paige match archived, hence an archive folder (the tests check that they do).
 */
const SMALL_HISTORY = 8;

/** The account of the fixtures, the one that is linked in most tests. */
const LINKED = FIXTURE_ACCOUNT_ID;

/** Another account with a full history and archives; the old account of a switch. */
const OTHER = testAccountId(2000001);

/** An account that only has a synchronisation state (its rows are gone). */
const STATE_ONLY = testAccountId(2000002);

/** An account that only has matches (its synchronisation state is gone). */
const MATCHES_ONLY = testAccountId(2000003);

/** What every failed step of the service logs. */
const FAILURE_MESSAGE = 'Could not delete account data';

/** The keys of `sync_state` that belong to no account, as they are after a synchronisation. */
const GLOBAL_KEYS = ['api.history_requests', 'api.paused_until', 'maintenance.vacuum_pending'];

/** The statement of a compaction, and the one that follows it (the checkpoint of the log). */
const VACUUM_STATEMENT = 'VACUUM';
const CHECKPOINT_STATEMENT = 'PRAGMA wal_checkpoint(TRUNCATE)';

/**
 * A database that records every statement it runs, and fails or answers the ones a test asks it to.
 * It wraps the database of the services, so that the statements of all of them are seen.
 */
class SpyDatabase implements Database {
  /** Every statement asked so far, in order, failed ones included. */
  readonly statements: string[] = [];

  readonly #inner: Database;
  readonly #queuedFailures: RegExp[] = [];
  readonly #queuedAnswers: { readonly statement: RegExp; readonly rows: readonly SqlRow[] }[] = [];

  /**
   * @param inner - The database that does the work.
   */
  constructor(inner: Database) {
    this.#inner = inner;
  }

  /**
   * How many `VACUUM` statements were asked, the failed ones included.
   *
   * @returns The count.
   */
  vacuumCount(): number {
    return this.statements.filter((sql) => sql.trim() === VACUUM_STATEMENT).length;
  }

  /**
   * The statements of the compactions asked so far, in order: each `VACUUM` and each checkpoint, and
   * nothing else.
   *
   * @returns The statements.
   */
  compactionStatements(): string[] {
    return this.statements.filter(
      (sql) => sql.trim() === VACUUM_STATEMENT || sql.trim() === CHECKPOINT_STATEMENT,
    );
  }

  /**
   * Make the next statement that matches fail, once, as a locked or damaged file would.
   *
   * @param statement - What the statement to fail looks like.
   */
  failNext(statement: RegExp): void {
    this.#queuedFailures.push(statement);
  }

  /**
   * Make the next query that matches answer these rows instead of running, once.
   *
   * @param statement - What the query to answer looks like.
   * @param rows - The rows it answers.
   */
  answerNext(statement: RegExp, rows: readonly SqlRow[]): void {
    this.#queuedAnswers.push({ statement, rows });
  }

  execute(sql: string, params?: readonly SqlValue[]): Promise<number> {
    return this.#run(sql, () => this.#inner.execute(sql, params));
  }

  select(sql: string, params?: readonly SqlValue[]): Promise<readonly SqlRow[]> {
    const answer = this.#queuedAnswers.find(({ statement }) => statement.test(sql));
    if (answer === undefined) {
      return this.#run(sql, () => this.#inner.select(sql, params));
    }
    this.#queuedAnswers.splice(this.#queuedAnswers.indexOf(answer), 1);
    this.statements.push(sql);
    return Promise.resolve(answer.rows);
  }

  /**
   * Record a statement, then run it unless a test queued a failure for it.
   *
   * @param sql - The statement.
   * @param run - Runs it on the inner database.
   * @returns What the inner database answers.
   */
  #run<T>(sql: string, run: () => Promise<T>): Promise<T> {
    this.statements.push(sql);
    const failure = this.#queuedFailures.findIndex((statement) => statement.test(sql));
    if (failure === -1) {
      return run();
    }
    this.#queuedFailures.splice(failure, 1);
    return Promise.reject(new Error('disk I/O error'));
  }
}

/** An archive store whose next listing can be made to fail, as an unreadable folder would. */
class UnlistableArchiveStore extends MemoryArchiveStore {
  #nextListingError: Error | null = null;

  /**
   * Make the next listing of the archive folder fail with this error, once.
   *
   * @param error - The error the listing rejects with.
   */
  failNextListing(error: Error): void {
    this.#nextListingError = error;
  }

  override listEntries(): Promise<readonly string[]> {
    if (this.#nextListingError === null) {
      return super.listEntries();
    }
    const error = this.#nextListingError;
    this.#nextListingError = null;
    return Promise.reject(error);
  }
}

/**
 * Read one column of a query.
 *
 * @param database - The database.
 * @param sql - A `SELECT`.
 * @param name - The column to keep.
 * @returns The values, in the order of the query.
 */
async function column(database: Database, sql: string, name: string): Promise<unknown[]> {
  return (await database.select(sql)).map((row) => row[name]);
}

/**
 * Everything the service may delete or keep, read back: the accounts that have matches, the keys of
 * the synchronisation state, the keys of the API cache and the entries of the archive folder.
 *
 * @param database - The database.
 * @param archive - The archive store.
 * @returns What is stored, each list in a stable order.
 */
async function stored(database: Database, archive: ArchiveStore) {
  return {
    matchAccounts: await column(
      database,
      'SELECT DISTINCT account_id FROM matches ORDER BY account_id',
      'account_id',
    ),
    stateKeys: await column(database, 'SELECT key FROM sync_state ORDER BY key', 'key'),
    cacheKeys: await column(
      database,
      'SELECT cache_key FROM api_cache ORDER BY cache_key',
      'cache_key',
    ),
    archiveEntries: [...(await archive.listEntries())].sort(),
  };
}

/**
 * The context of every line the service logged for a failed step.
 *
 * @param logger - The logger the service writes to.
 * @returns The contexts, oldest first.
 */
function failures(logger: MemoryLogger) {
  return logger.entries
    .filter((entry) => entry.level === 'warn' && entry.message === FAILURE_MESSAGE)
    .map((entry) => entry.context);
}

/**
 * Build the service on two accounts' services, like the app: both are created by
 * `createTestServices` on the same database and archive store, so that their data lives side by
 * side. Nothing is synchronised until the test calls `populate`.
 *
 * @param archiveStore - The archive store; a fresh one by default.
 * @returns The service, what it works on, and the means to fill and inspect it.
 */
function setUp(archiveStore: MemoryArchiveStore = new MemoryArchiveStore()) {
  const database = new SpyDatabase(createTestDatabase());
  const logger = new MemoryLogger();
  const linkedServices = createTestServices({
    database,
    archiveStore,
    now: () => START,
    handler: createFixtureApi({ now: START, matchCount: SMALL_HISTORY }),
  });
  const otherServices = createTestServices({
    database,
    archiveStore,
    accountId: OTHER,
    now: () => START,
    handler: createFixtureApi({ now: START, accountId: OTHER, matchCount: SMALL_HISTORY }),
  });
  const matches = new MatchesRepository(database);
  const syncState = new SyncStateRepository(database, logger);
  const details = linkedServices.services.details;
  const service = new AccountDataService({
    matches,
    syncState,
    archive: archiveStore,
    maintenance: new DatabaseMaintenanceRepository(database),
    details,
    logger,
  });

  /**
   * Synchronise the accounts for real, then add what no synchronisation writes: a cached API
   * response and a pause requested by deadlock-api.
   *
   * @param accounts - `both` (the default), or `linked` alone.
   */
  async function populate(accounts: 'both' | 'linked' = 'both'): Promise<void> {
    await linkedServices.services.sync.syncNow('manual');
    if (accounts === 'both') {
      await otherServices.services.sync.syncNow('manual');
    }
    await database.execute(
      "INSERT INTO api_cache (cache_key, payload_json, fetched_at, expires_at) VALUES ('heroes', '[]', 0, 1)",
    );
    await syncState.setPausedUntil(START + 60_000);
  }

  return {
    service,
    database,
    archiveStore,
    logger,
    matches,
    syncState,
    details,
    populate,
    snapshot: () => stored(database, archiveStore),
  };
}

describe('AccountDataService.eraseAccount', () => {
  it('deletes the matches, the synchronisation state and the archive folder of an account', async () => {
    const { service, populate, snapshot, database, syncState } = setUp();
    await populate();
    // Both accounts have everything before the deletion.
    await expect(snapshot()).resolves.toEqual({
      matchAccounts: [LINKED, OTHER],
      stateKeys: [
        'account.1000001.sync',
        'account.2000001.sync',
        'api.history_requests',
        'api.paused_until',
      ],
      cacheKeys: ['heroes'],
      archiveEntries: [accountFolderName(LINKED), accountFolderName(OTHER)],
    });

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: true });

    // The other account, the global keys and the API cache are untouched.
    await expect(snapshot()).resolves.toEqual({
      matchAccounts: [OTHER],
      stateKeys: [
        'account.2000001.sync',
        'api.history_requests',
        'api.paused_until',
        'maintenance.vacuum_pending',
      ],
      cacheKeys: ['heroes'],
      archiveEntries: [accountFolderName(OTHER)],
    });
    await expect(syncState.getHistoryRequests()).resolves.toHaveLength(2);
    await expect(
      database.select("SELECT value_json FROM sync_state WHERE key = 'api.paused_until'"),
    ).resolves.toEqual([{ value_json: String(START + 60_000) }]);
  });

  it('forgets what the detail queue remembers of the account', async () => {
    const { service, populate, details, archiveStore } = setUp();
    // The first archive written is the linked account's: the queue stops there, and remembers why.
    archiveStore.failNextWrite(new Error('There is not enough space on the disk'));
    await populate('linked');
    await expect(details.getSummary()).resolves.toMatchObject({ lastStop: 'storage' });

    await service.eraseAccount(LINKED);

    await expect(details.getSummary()).resolves.toMatchObject({ lastStop: null, waiting: 0 });
  });

  it('compacts the database once after deleting: the VACUUM, then the checkpoint of its log', async () => {
    const { service, populate, database, syncState } = setUp();
    await populate();
    expect(database.compactionStatements()).toEqual([]);

    await service.eraseAccount(LINKED);

    // The checkpoint is what moves the compacted pages from the log into the main file.
    expect(database.compactionStatements()).toEqual([VACUUM_STATEMENT, CHECKPOINT_STATEMENT]);
    // The compaction is done: nothing is left to do at the next start.
    await expect(syncState.isVacuumPending()).resolves.toBe(false);
  });

  it('marks the compaction as pending before it deletes anything', async () => {
    const { service, populate, database } = setUp();
    await populate();
    const first = database.statements.length;

    await service.eraseAccount(LINKED);

    // A crash at any point after the first write leaves the flag set, and the next start compacts.
    const statements = database.statements.slice(first);
    const position = (prefix: string) =>
      statements.findIndex((sql) => sql.trim().startsWith(prefix));
    expect(position('INSERT INTO sync_state')).toBe(0);
    expect(position('DELETE FROM matches')).toBeGreaterThan(position('INSERT INTO sync_state'));
    expect(position('DELETE FROM sync_state')).toBeGreaterThan(position('DELETE FROM matches'));
    expect(position('VACUUM')).toBeGreaterThan(position('DELETE FROM sync_state'));
  });

  it('reports an incomplete deletion when a file cannot be removed, and keeps going', async () => {
    const { service, populate, snapshot, database, logger, archiveStore } = setUp();
    await populate();
    // A message that quotes the path, as a plugin error does.
    archiveStore.failNextRemove(new Error(`Access is denied: archive/${String(LINKED)}`));

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: false });

    // The rows, the state and the compaction went through; the folder is left for the next start.
    await expect(snapshot()).resolves.toMatchObject({
      matchAccounts: [OTHER],
      archiveEntries: [accountFolderName(LINKED), accountFolderName(OTHER)],
    });
    expect(database.vacuumCount()).toBe(1);
    // Only the step and the kind: the message of an archive error can quote the folder.
    expect(failures(logger)).toEqual([
      { step: 'archive', kind: 'unexpected' },
      { step: 'check', part: 'archive' },
    ]);
  });

  it.each([
    {
      step: 'matches',
      statement: /^DELETE FROM matches/,
      matchAccounts: [LINKED, OTHER],
      keyLeft: false,
    },
    {
      step: 'sync_state',
      statement: /^DELETE FROM sync_state/,
      matchAccounts: [OTHER],
      keyLeft: true,
    },
  ])(
    'reports an incomplete deletion when the $step cannot be deleted, and keeps going',
    async ({ step, statement, matchAccounts, keyLeft }) => {
      const { service, populate, snapshot, database, logger } = setUp();
      await populate();
      database.failNext(statement);

      await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: false });

      const left = await snapshot();
      expect(left.matchAccounts).toEqual(matchAccounts);
      expect(left.stateKeys.includes('account.1000001.sync')).toBe(keyLeft);
      // The step after the failed one ran: the folder is gone, and the database was compacted.
      expect(left.archiveEntries).toEqual([accountFolderName(OTHER)]);
      expect(database.vacuumCount()).toBe(1);
      expect(failures(logger)).toEqual([
        expect.objectContaining({ step, kind: 'storage' }),
        { step: 'check', part: step },
      ]);
    },
  );

  it('keeps the deletion when the compaction fails, and compacts at the next sweep', async () => {
    const { service, populate, snapshot, database, logger, syncState } = setUp();
    await populate();
    database.failNext(/^VACUUM$/);

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: false });

    await expect(snapshot()).resolves.toMatchObject({
      matchAccounts: [OTHER],
      archiveEntries: [accountFolderName(OTHER)],
    });
    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'vacuum', kind: 'storage' }),
    ]);
    // The flag stays set: the compaction is owed. The checkpoint was not tried after the failure.
    await expect(syncState.isVacuumPending()).resolves.toBe(true);
    expect(database.compactionStatements()).toEqual([VACUUM_STATEMENT]);

    // The other account is now the linked one: the next start has no data to delete, only the debt.
    await expect(service.sweep(OTHER)).resolves.toEqual({
      accounts: 0,
      entries: 0,
      vacuumed: true,
    });
    expect(database.compactionStatements()).toEqual([
      VACUUM_STATEMENT,
      VACUUM_STATEMENT,
      CHECKPOINT_STATEMENT,
    ]);
    await expect(syncState.isVacuumPending()).resolves.toBe(false);
  });

  it('leaves the flag set and the erasure incomplete when the checkpoint is busy, and compacts at the next sweep', async () => {
    const { service, populate, snapshot, database, logger, syncState } = setUp();
    await populate();
    // Another connection blocks the checkpoint: it copied nothing, or only part of the log.
    database.answerNext(/^PRAGMA wal_checkpoint/, [{ busy: 1, log: 12, checkpointed: 7 }]);

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: false });

    // The data is deleted, but the main file may still hold it.
    await expect(snapshot()).resolves.toMatchObject({
      matchAccounts: [OTHER],
      archiveEntries: [accountFolderName(OTHER)],
    });
    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'vacuum', kind: 'storage', busy: 1 }),
    ]);
    await expect(syncState.isVacuumPending()).resolves.toBe(true);
    expect(database.compactionStatements()).toEqual([VACUUM_STATEMENT, CHECKPOINT_STATEMENT]);

    await expect(service.sweep(OTHER)).resolves.toEqual({
      accounts: 0,
      entries: 0,
      vacuumed: true,
    });
    expect(database.compactionStatements()).toEqual([
      VACUUM_STATEMENT,
      CHECKPOINT_STATEMENT,
      VACUUM_STATEMENT,
      CHECKPOINT_STATEMENT,
    ]);
    await expect(syncState.isVacuumPending()).resolves.toBe(false);
  });

  it('is complete, with a warning, when only the pending flag cannot be saved', async () => {
    const { service, populate, snapshot, database, logger } = setUp();
    await populate();
    // The first write to the synchronisation state is the flag.
    database.failNext(/^INSERT INTO sync_state/);

    // The data is gone and the database compacted: the flag only guards against a crash.
    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: true });

    await expect(snapshot()).resolves.toMatchObject({
      matchAccounts: [OTHER],
      archiveEntries: [accountFolderName(OTHER)],
    });
    expect(database.vacuumCount()).toBe(1);
    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'vacuum', kind: 'storage' }),
    ]);
  });

  it('is complete, with a warning for each, when the pending flag can be neither saved nor cleared', async () => {
    const { service, populate, database, logger, syncState } = setUp();
    await populate();
    database.failNext(/^INSERT INTO sync_state/);
    database.failNext(/^INSERT INTO sync_state/);

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: true });

    expect(database.vacuumCount()).toBe(1);
    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'vacuum', kind: 'storage' }),
      expect.objectContaining({ step: 'vacuum', kind: 'storage' }),
    ]);
    // Nothing was ever saved: no debt is recorded, and none is owed.
    await expect(syncState.isVacuumPending()).resolves.toBe(false);
  });

  it('is incomplete when the compaction fails, whether or not the flag could be saved', async () => {
    const { service, populate, database, logger } = setUp();
    await populate();
    database.failNext(/^INSERT INTO sync_state/);
    database.failNext(/^VACUUM$/);

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: false });

    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'vacuum', kind: 'storage' }),
      expect.objectContaining({ step: 'vacuum', kind: 'storage' }),
    ]);
  });

  it('reports an incomplete deletion when the check cannot read the database', async () => {
    const { service, populate, database, logger } = setUp();
    await populate();
    database.failNext(/SELECT COUNT\(\*\) AS total FROM matches/);

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: false });

    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'check', part: 'matches', kind: 'storage' }),
    ]);
  });

  it('reports an incomplete deletion when the check cannot list the archive folder', async () => {
    const archiveStore = new UnlistableArchiveStore();
    const { service, populate, logger } = setUp(archiveStore);
    await populate();
    archiveStore.failNextListing(new Error('The folder is locked'));

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: false });

    expect(failures(logger)).toEqual([{ step: 'check', part: 'archive', kind: 'unexpected' }]);
  });

  it('deletes what is already gone without a complaint: an unlink that is retried', async () => {
    const { service, populate, snapshot, logger } = setUp();
    await populate();
    await service.eraseAccount(LINKED);
    const afterFirst = await snapshot();

    await expect(service.eraseAccount(LINKED)).resolves.toEqual({ complete: true });

    await expect(snapshot()).resolves.toEqual(afterFirst);
    expect(failures(logger)).toEqual([]);
  });
});

describe('AccountDataService.sweep', () => {
  it('compacts at the next start after an interrupted deletion', async () => {
    const { service, populate, snapshot, database, logger, matches, syncState, archiveStore } =
      setUp();
    await populate();
    // The app was killed after the deletion of the old account and before the compaction: nothing
    // is left to delete, and the flag is set.
    await matches.deleteAccount(OTHER);
    await syncState.deleteAccountState(OTHER);
    await archiveStore.removeEntry(accountFolderName(OTHER));
    await syncState.setVacuumPending(true);
    const before = await snapshot();

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 0,
      entries: 0,
      vacuumed: true,
    });

    // One compaction, and it ends with the checkpoint.
    expect(database.compactionStatements()).toEqual([VACUUM_STATEMENT, CHECKPOINT_STATEMENT]);
    await expect(syncState.isVacuumPending()).resolves.toBe(false);
    // Only the flag moved.
    await expect(snapshot()).resolves.toEqual(before);
    expect(logger.entries).toContainEqual({
      level: 'info',
      scope: 'account.data',
      message: 'Startup cleanup',
      context: { accounts: 0, entries: 0, vacuumed: true },
    });
  });

  it('removes everything that is not the linked account at start', async () => {
    const { service, populate, snapshot, database, logger, matches, syncState, archiveStore } =
      setUp();
    await populate();
    // Leftovers of every kind: an account with a state and no rows, one with rows and no state,
    // the quarantine folder of the first layout, a temporary file and a folder the app never made.
    await syncState.setAccountState(STATE_ONLY, INITIAL_ACCOUNT_SYNC_STATE);
    await matches.upsertMany([matchSummary({ accountId: MATCHES_ONLY, matchId: 100000001 })]);
    archiveStore.addFile('archive/quarantine/001792154119000-100000001.json.zst');
    archiveStore.addFile('archive/100000001.json.zst.tmp');
    archiveStore.addFile('archive/unknown/notes.txt');

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 3,
      entries: 4,
      vacuumed: true,
    });

    // The linked account stays, with the global keys and the API cache.
    await expect(snapshot()).resolves.toEqual({
      matchAccounts: [LINKED],
      stateKeys: [
        'account.1000001.sync',
        'api.history_requests',
        'api.paused_until',
        'maintenance.vacuum_pending',
      ],
      cacheKeys: ['heroes'],
      archiveEntries: [accountFolderName(LINKED)],
    });
    expect(database.vacuumCount()).toBe(1);
    await expect(syncState.isVacuumPending()).resolves.toBe(false);
    expect(logger.entries).toContainEqual({
      level: 'info',
      scope: 'account.data',
      message: 'Startup cleanup',
      context: { accounts: 3, entries: 4, vacuumed: true },
    });
  });

  it('forgets in the detail queue the accounts it deletes, and only them', async () => {
    const { service, populate, details } = setUp();
    await populate();
    const forget = vi.spyOn(details, 'forgetAccount');

    await service.sweep(LINKED);

    expect(forget.mock.calls).toEqual([[OTHER]]);
  });

  it('removes everything when no account is linked', async () => {
    const { service, populate, snapshot, database } = setUp();
    await populate();

    await expect(service.sweep(null)).resolves.toEqual({ accounts: 2, entries: 2, vacuumed: true });

    await expect(snapshot()).resolves.toEqual({
      matchAccounts: [],
      stateKeys: GLOBAL_KEYS,
      cacheKeys: ['heroes'],
      archiveEntries: [],
    });
    expect(database.vacuumCount()).toBe(1);
  });

  it('does not compact when the sweep deleted nothing', async () => {
    const { service, populate, snapshot, database, logger } = setUp();
    await populate('linked');
    const before = await snapshot();

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 0,
      entries: 0,
      vacuumed: false,
    });

    expect(database.compactionStatements()).toEqual([]);
    await expect(snapshot()).resolves.toEqual(before);
    // Nothing was done: the line is for a developer looking for it, not for the log of every launch.
    expect(logger.entries).toContainEqual({
      level: 'debug',
      scope: 'account.data',
      message: 'Startup cleanup',
      context: { accounts: 0, entries: 0, vacuumed: false },
    });
    expect(failures(logger)).toEqual([]);
  });

  it('does not compact when it only removed files', async () => {
    const { service, populate, database, archiveStore } = setUp();
    await populate('linked');
    archiveStore.addFile('archive/unknown/notes.txt');

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 0,
      entries: 1,
      vacuumed: false,
    });

    // The files are not in the database: there is no free page to give back.
    expect(database.compactionStatements()).toEqual([]);
  });

  it('does not report the database as compacted when the checkpoint is busy, and keeps the debt', async () => {
    const { service, populate, snapshot, database, logger, syncState } = setUp();
    await populate();
    database.answerNext(/^PRAGMA wal_checkpoint/, [{ busy: 1, log: 12, checkpointed: 7 }]);

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 1,
      entries: 1,
      vacuumed: false,
    });

    // The data is deleted; the compaction is owed again at the next start.
    await expect(snapshot()).resolves.toMatchObject({ matchAccounts: [LINKED] });
    await expect(syncState.isVacuumPending()).resolves.toBe(true);
    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'vacuum', kind: 'storage', busy: 1 }),
    ]);
    expect(logger.entries).toContainEqual({
      level: 'info',
      scope: 'account.data',
      message: 'Startup cleanup',
      context: { accounts: 1, entries: 1, vacuumed: false },
    });
  });

  it('does not touch an archive entry whose name could reach outside the folder, and does not log it', async () => {
    const { service, populate, snapshot, logger, archiveStore } = setUp();
    await populate();
    archiveStore.addFile('archive/2000009:stray');
    const removeEntry = vi.spyOn(archiveStore, 'removeEntry');

    // The store refuses such a name: asking for it would make the sweep fail at every launch.
    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 1,
      entries: 1,
      vacuumed: true,
    });

    expect(removeEntry.mock.calls).toEqual([[accountFolderName(OTHER)]]);
    await expect(snapshot()).resolves.toMatchObject({
      archiveEntries: ['2000009:stray', accountFolderName(LINKED)].sort(),
    });
    expect(failures(logger)).toEqual([{ step: 'archive' }]);
  });

  it('reports the files it could not remove, tries the others, and finishes at the next start', async () => {
    const { service, populate, snapshot, logger, archiveStore } = setUp();
    await populate();
    archiveStore.addFile('archive/unknown/notes.txt');
    // The first entry listed after the linked account's is the other account's folder.
    archiveStore.failNextRemove(new Error(`Access is denied: archive/${String(OTHER)}`));

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 1,
      entries: 1,
      vacuumed: true,
    });

    expect(failures(logger)).toEqual([{ step: 'archive', kind: 'unexpected' }]);
    await expect(snapshot()).resolves.toMatchObject({
      archiveEntries: [accountFolderName(LINKED), accountFolderName(OTHER)],
    });

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 0,
      entries: 1,
      vacuumed: false,
    });
    await expect(snapshot()).resolves.toMatchObject({
      archiveEntries: [accountFolderName(LINKED)],
    });
  });

  it('counts every other account it attempted, logs the one that failed, and retries it at the next start', async () => {
    const { service, populate, snapshot, database, logger, syncState } = setUp();
    await populate();
    await syncState.setAccountState(STATE_ONLY, INITIAL_ACCOUNT_SYNC_STATE);
    // The accounts go in order: the rows of the other account are the first to be deleted.
    database.failNext(/^DELETE FROM matches/);

    // Two other accounts were attempted, whether or not their deletion went through.
    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 2,
      entries: 1,
      vacuumed: true,
    });

    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'matches', kind: 'storage' }),
    ]);
    await expect(snapshot()).resolves.toMatchObject({ matchAccounts: [LINKED, OTHER] });

    // The account that failed is found again by its rows: only it is attempted this time.
    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 1,
      entries: 0,
      vacuumed: true,
    });
    await expect(snapshot()).resolves.toMatchObject({ matchAccounts: [LINKED] });
  });

  it('still reports a startup cleanup at info when every deletion it attempted failed', async () => {
    const { service, populate, snapshot, database, logger, archiveStore } = setUp();
    await populate();
    database.failNext(/^DELETE FROM matches/);
    database.failNext(/^DELETE FROM sync_state/);
    archiveStore.failNextRemove(new Error(`Access is denied: archive/${String(OTHER)}`));
    database.failNext(/^VACUUM$/);

    // Nothing was deleted, but the sweep did try: it is not the quiet sweep of a clean start.
    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 1,
      entries: 0,
      vacuumed: false,
    });

    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'matches', kind: 'storage' }),
      expect.objectContaining({ step: 'sync_state', kind: 'storage' }),
      { step: 'archive', kind: 'unexpected' },
      expect.objectContaining({ step: 'vacuum', kind: 'storage' }),
    ]);
    expect(logger.entries).toContainEqual({
      level: 'info',
      scope: 'account.data',
      message: 'Startup cleanup',
      context: { accounts: 1, entries: 0, vacuumed: false },
    });
    // Everything is still there for the next start.
    await expect(snapshot()).resolves.toMatchObject({
      matchAccounts: [LINKED, OTHER],
      archiveEntries: [accountFolderName(LINKED), accountFolderName(OTHER)],
    });
  });

  it('logs a failed listing with its step and skips that part, then finishes at the next start', async () => {
    const archiveStore = new UnlistableArchiveStore();
    const { service, populate, snapshot, database, logger, matches } = setUp(archiveStore);
    await populate();
    await matches.upsertMany([matchSummary({ accountId: MATCHES_ONLY, matchId: 100000001 })]);
    database.failNext(/SELECT DISTINCT account_id FROM matches/);
    archiveStore.failNextListing(new Error(`Cannot read archive/${String(OTHER)}`));

    // The other account is still found through its state. The account that only has matches is
    // not, since the listing of the matches failed, and no archive entry is listed.
    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 1,
      entries: 0,
      vacuumed: true,
    });

    expect(failures(logger)).toEqual([
      expect.objectContaining({ step: 'matches', kind: 'storage' }),
      { step: 'archive', kind: 'unexpected' },
    ]);
    await expect(snapshot()).resolves.toMatchObject({
      matchAccounts: [LINKED, MATCHES_ONLY],
      archiveEntries: [accountFolderName(LINKED), accountFolderName(OTHER)],
    });

    await expect(service.sweep(LINKED)).resolves.toEqual({
      accounts: 1,
      entries: 1,
      vacuumed: true,
    });
    await expect(snapshot()).resolves.toMatchObject({
      matchAccounts: [LINKED],
      archiveEntries: [accountFolderName(LINKED)],
    });
  });

  it('never logs an account id or a name of the archive folder', async () => {
    const { service, populate, database, logger, archiveStore } = setUp();
    await populate();
    archiveStore.addFile('archive/2000009:stray');
    archiveStore.failNextRemove(new Error(`Access is denied: archive/${String(LINKED)}`));

    // A deletion that fails on a file, then a sweep that meets a stray name and a failing database.
    await service.eraseAccount(LINKED);
    database.failNext(/^DELETE FROM sync_state/);
    await service.sweep(null);

    // The failure paths did run, and left lines.
    expect(failures(logger).length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(logger.entries);
    for (const secret of [LINKED, OTHER, 2000009]) {
      expect(text).not.toContain(String(secret));
    }
  });
});

describe('DatabaseMaintenanceRepository', () => {
  it('compacts the database, then checkpoints its log, in that order, once each', async () => {
    const database = new SpyDatabase(createTestDatabase());

    await new DatabaseMaintenanceRepository(database).vacuum();

    expect(database.statements).toEqual([VACUUM_STATEMENT, CHECKPOINT_STATEMENT]);
  });

  it('accepts the answer of a database that has no log: sql.js is not in WAL mode', async () => {
    const database = createTestDatabase();

    // The real answer of sql.js, which the tests above run on: the checkpoint is done, nothing busy.
    await expect(database.select(CHECKPOINT_STATEMENT)).resolves.toEqual([
      { busy: 0, log: -1, checkpointed: -1 },
    ]);
    await expect(new DatabaseMaintenanceRepository(database).vacuum()).resolves.toBeUndefined();
  });

  it('fails with a storage error when the database cannot be compacted, and does not checkpoint', async () => {
    const database = new SpyDatabase(createTestDatabase());
    database.failNext(/^VACUUM$/);

    await expect(new DatabaseMaintenanceRepository(database).vacuum()).rejects.toMatchObject({
      name: 'AppError',
      kind: 'storage',
      message: 'Could not compact the database',
    });
    expect(database.statements).toEqual([VACUUM_STATEMENT]);
  });

  it('fails with a storage error when the checkpoint is busy, as it did not complete', async () => {
    const database = new SpyDatabase(createTestDatabase());
    database.answerNext(/^PRAGMA wal_checkpoint/, [{ busy: 1, log: 12, checkpointed: 7 }]);

    await expect(new DatabaseMaintenanceRepository(database).vacuum()).rejects.toMatchObject({
      name: 'AppError',
      kind: 'storage',
      message: 'The checkpoint of the compacted database did not complete',
      context: { busy: 1 },
    });
  });

  it('fails with a storage error when the checkpoint cannot run', async () => {
    const database = new SpyDatabase(createTestDatabase());
    database.failNext(/^PRAGMA wal_checkpoint/);

    await expect(new DatabaseMaintenanceRepository(database).vacuum()).rejects.toMatchObject({
      name: 'AppError',
      kind: 'storage',
      message: 'Could not checkpoint the database after compacting it',
    });
  });

  it.each([
    ['no row', []],
    ['a row without the busy column', [{ log: 0, checkpointed: 0 }]],
    ['a busy column that is not a number', [{ busy: 'no', log: 0, checkpointed: 0 }]],
  ])('fails with a storage error when the checkpoint answers %s', async (_name, rows) => {
    const database = new SpyDatabase(createTestDatabase());
    database.answerNext(/^PRAGMA wal_checkpoint/, rows);

    await expect(new DatabaseMaintenanceRepository(database).vacuum()).rejects.toMatchObject({
      name: 'AppError',
      kind: 'storage',
      message: 'Unexpected answer while checkpointing the database',
    });
  });
});

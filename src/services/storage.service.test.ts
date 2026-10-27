/**
 * Tests of the size limit of the archive folder: the eviction of the oldest archives, the archives
 * of the last 90 days, the 40 newest and the ones whose metrics are not stored kept whatever the
 * limit, the preview of an eviction, and the usage the settings page shows. They run on an
 * in-memory database with the real migrations, the in-memory archive store and the settings saved
 * in jsdom's `localStorage`.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalStorageSettingsStore } from '../adapters/dev/local-storage-settings-store.adapter';
import { MemoryArchiveStore } from '../adapters/dev/memory-archive-store.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import { ARCHIVE_FORMAT } from '../core/match-detail/archive-envelope';
import { archivePath } from '../core/match-detail/archive-layout';
import { DETAIL_WINDOW_MS } from '../core/match-detail/detail-status';
import {
  PROTECTED_RECENT_ARCHIVES,
  TYPICAL_ARCHIVE_BYTES,
  type StorageCapMb,
} from '../core/storage/storage-rules';
import { createTestDatabase, matchSummary, TEST_ACCOUNT_ID, testMatchId } from '../test/test-data';
import { MatchDetailRepository } from './match-detail.repository';
import { MatchesRepository } from './matches.repository';
import { MetricsRepository } from './metrics.repository';
import { SettingsService } from './settings.service';
import { StorageService } from './storage.service';

/** One megabyte, as the limit counts it. */
const MB = 1_000_000;

/** The start time of the oldest match of a test, in Unix seconds; each next match is a minute later. */
const FIRST_START_TIME = 1_790_000_000;

/**
 * An archive store whose removal of some matches fails, as a file held open by another program, and
 * that lets a test look at the database at the moment a removal is asked for.
 */
class FailingRemovalStore extends MemoryArchiveStore {
  /** The matches whose removal fails. */
  readonly failing = new Set<MatchId>();
  /** Called with the match before each removal, failed or not; nothing by default. */
  beforeRemove: (matchId: MatchId) => Promise<void> = () => Promise.resolve();

  override async remove(accountId: AccountId, matchId: MatchId): Promise<void> {
    await this.beforeRemove(matchId);
    if (this.failing.has(matchId)) {
      // The error of the file system quotes the path, which holds the account id.
      return Promise.reject(
        new Error(`failed to remove C:\\Users\\player\\${archivePath(accountId, matchId)}`),
      );
    }
    return super.remove(accountId, matchId);
  }
}

/** Options of {@link setUp}. */
interface SetUpOptions {
  /** How many Paige archives the player has, numbered 1 (the oldest) to `count`. */
  readonly count: number;
  /** The size every archive is recorded with, in bytes. */
  readonly bytesEach: number;
  /**
   * How many of the newest archives started within the last 90 days, when the service reads its
   * clock; none by default, so that every archive may be evicted.
   */
  readonly recentCount?: number;
  /** The matches whose metrics are not stored; every match has them by default. */
  readonly unprojected?: readonly number[];
  /** The limit saved in the settings; nothing saved (the default) when absent. */
  readonly capMb?: StorageCapMb;
  /** The archive store; a fresh in-memory one by default. */
  readonly archive?: MemoryArchiveStore;
  /** The exclusive section of the synchronisation; one that runs the task at once by default. */
  readonly runExclusive?: <T>(task: () => Promise<T>) => Promise<T>;
  /** The linked account; the test account by default, `null` for none. */
  readonly accountId?: AccountId | null;
}

/**
 * A player with `count` archived Paige matches, each one a minute after the one before, their files
 * on the in-memory disk, their sizes and their metrics of the current version in the database, and
 * the storage service over them, with a clock that puts the `recentCount` newest in the window of
 * the last 90 days.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The service and what a test inspects.
 */
async function setUp(options: SetUpOptions) {
  const database = createTestDatabase();
  const ids = Array.from({ length: options.count }, (_, index) => testMatchId(index + 1));
  await new MatchesRepository(database).upsertMany(
    ids.map((matchId, index) =>
      matchSummary({ matchId, startTime: FIRST_START_TIME + index * 60 }),
    ),
  );
  const details = new MatchDetailRepository(database);
  const metrics = new MetricsRepository(database);
  const archive = options.archive ?? new MemoryArchiveStore();
  // The current time: the window of the last 90 days starts on the start of the first of the
  // `recentCount` newest matches (after the last one, when there are none).
  const now =
    (FIRST_START_TIME + (options.count - (options.recentCount ?? 0)) * 60) * 1000 +
    DETAIL_WINDOW_MS;
  const unprojected = new Set((options.unprojected ?? []).map(testMatchId));
  for (const matchId of ids) {
    await details.markReady(TEST_ACCOUNT_ID, matchId, options.bytesEach, ARCHIVE_FORMAT);
    await archive.write(TEST_ACCOUNT_ID, matchId, Uint8Array.of(1));
    if (!unprojected.has(matchId)) {
      await metrics.saveProjection(
        TEST_ACCOUNT_ID,
        matchId,
        {
          version: PROJECTION_VERSION,
          playerBadge: null,
          hasLeaver: false,
          failed: false,
          projectedAt: now,
        },
        new Map(),
      );
    }
  }
  const logger = new MemoryLogger();
  const settings = new SettingsService(new LocalStorageSettingsStore(localStorage), logger);
  if (options.capMb !== undefined) {
    await settings.update({ storageCapMb: options.capMb });
  }
  // The line of the settings saved above is not what the tests look at.
  logger.entries.length = 0;
  const accountId = options.accountId === undefined ? TEST_ACCOUNT_ID : options.accountId;
  const storage = new StorageService({
    accountSource: { currentAccountId: () => Promise.resolve(accountId) },
    details,
    archive,
    settings,
    runExclusive: options.runExclusive ?? ((task) => task()),
    logger,
    now: () => now,
  });
  /** The status of a match in the database. */
  const statusOf = async (id: number) =>
    (await details.getDetail(TEST_ACCOUNT_ID, testMatchId(id)))?.status;
  /** Whether a match still has its file on the disk. */
  const hasFile = (id: number) => archive.files.has(archivePath(TEST_ACCOUNT_ID, testMatchId(id)));
  return { storage, details, archive, settings, logger, statusOf, hasFile };
}

/** The ids 1 to `count`, the oldest first, as {@link setUp} numbers the matches. */
function idsUpTo(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

describe('StorageService.enforceCap', () => {
  it('never evicts the 40 newest archives', async () => {
    // 60 archives of 5 MB: 300 MB, three times the limit. Only the 20 oldest may go.
    const { storage, statusOf, hasFile, details } = await setUp({
      count: 60,
      bytesEach: 5 * MB,
      capMb: 100,
    });

    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 20 });

    for (const id of idsUpTo(60)) {
      const isProtected = id > 60 - PROTECTED_RECENT_ARCHIVES;
      expect(await statusOf(id)).toBe(isProtected ? 'ready' : 'evicted');
      expect(hasFile(id)).toBe(isProtected);
    }
    // Still over the limit, which the 40 newest alone overrun: they stay all the same.
    await expect(details.sumArchivedBytes(TEST_ACCOUNT_ID)).resolves.toBe(40 * 5 * MB);
  });

  it('never evicts the archives of the last 90 days, nor one whose metrics are not stored', async () => {
    // 60 archives of 5 MB: 300 MB, three times the limit. The 50 newest (11 to 60) are of the last
    // 90 days, and take 250 MB on their own: only 1 to 10 may go, but 4, whose metrics are not
    // stored yet.
    const { storage, statusOf, hasFile, logger, details } = await setUp({
      count: 60,
      bytesEach: 5 * MB,
      capMb: 100,
      recentCount: 50,
      unprojected: [4],
    });

    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 9 });

    for (const id of idsUpTo(60)) {
      const isEvicted = id <= 10 && id !== 4;
      expect(await statusOf(id)).toBe(isEvicted ? 'evicted' : 'ready');
      expect(hasFile(id)).toBe(!isEvicted);
    }
    // Still over the limit, which the archives kept overrun on their own.
    await expect(details.sumArchivedBytes(TEST_ACCOUNT_ID)).resolves.toBe(51 * 5 * MB);

    // Right after, nothing is left to evict: a match of the window downloaded again stays.
    logger.entries.length = 0;
    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 0 });
    expect(logger.entries).toEqual([]);
  });

  it('evicts oldest first until the archives fit', async () => {
    // 50 archives of 2.4 MB: 120 MB for a limit of 100. Eight removed leave 100.8 MB, nine 98.4.
    const { storage, statusOf, hasFile, logger, details } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      capMb: 100,
    });

    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 9 });

    for (const id of idsUpTo(50)) {
      expect(await statusOf(id)).toBe(id <= 9 ? 'evicted' : 'ready');
      expect(hasFile(id)).toBe(id > 9);
    }
    await expect(details.sumArchivedBytes(TEST_ACCOUNT_ID)).resolves.toBe(41 * 2_400_000);
    // One line for the whole eviction: counts and bytes, never a match or an account id.
    expect(logger.entries).toEqual([
      {
        level: 'info',
        scope: 'storage',
        message: 'Archives evicted',
        context: { evicted: 9, freedBytes: 9 * 2_400_000 },
      },
    ]);
  });

  it('stops when only protected archives are left', async () => {
    // 45 archives of 3 MB: the 40 newest alone (120 MB) are over the limit of 100 MB.
    const { storage, statusOf, logger } = await setUp({
      count: 45,
      bytesEach: 3 * MB,
      capMb: 100,
    });

    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 5 });
    expect(await statusOf(5)).toBe('evicted');
    expect(await statusOf(6)).toBe('ready');

    // Nothing is left to evict: a second pass does nothing, and writes nothing.
    logger.entries.length = 0;
    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 0 });
    expect(logger.entries).toEqual([]);
  });

  it('does nothing, and writes nothing, when the archives fit', async () => {
    // 60 archives of 1 MB under the default limit of 500 MB.
    const { storage, statusOf, logger } = await setUp({ count: 60, bytesEach: MB });

    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 0 });

    expect(await statusOf(1)).toBe('ready');
    expect(logger.entries).toEqual([]);
  });

  it('leaves an orphan file to the reconciliation when a removal fails', async () => {
    const archive = new FailingRemovalStore();
    archive.failing.add(testMatchId(2));
    // 50 archives of 2.4 MB, as above: nine to evict, the second of which cannot be removed.
    const { storage, statusOf, hasFile, logger } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      capMb: 100,
      archive,
    });
    // The status of each match at the moment its file is removed.
    const statusesAtRemoval: (string | undefined)[] = [];
    archive.beforeRemove = async (matchId) => {
      statusesAtRemoval.push(await statusOf(matchId));
    };

    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 9 });

    // Every row was evicted before its file was removed, the one that failed too.
    expect(statusesAtRemoval).toEqual(Array.from({ length: 9 }, () => 'evicted'));

    // The row is evicted first, so its bytes no longer count: the loop went on as if it was gone.
    expect(await statusOf(2)).toBe('evicted');
    expect(hasFile(2)).toBe(true);
    for (const id of idsUpTo(50).filter((id) => id !== 2)) {
      expect(hasFile(id)).toBe(id > 9);
    }
    // One error line with the kind of the failure only: no path, no account id.
    const failures = logger.entries.filter((entry) => entry.level === 'error');
    expect(failures).toEqual([
      {
        level: 'error',
        scope: 'storage',
        message: 'An evicted archive could not be removed',
        context: { kind: 'storage' },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(String(TEST_ACCOUNT_ID));
    expect(logger.entries.at(-1)).toMatchObject({
      level: 'info',
      message: 'Archives evicted',
      context: { evicted: 9 },
    });
  });

  it('leaves alone a candidate whose row is no longer ready when its turn comes', async () => {
    // 50 archives of 2.4 MB, as above: nine to evict.
    const { storage, details, statusOf, hasFile, logger } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      capMb: 100,
    });
    // Once the candidates are listed, the detail queue puts match 3 back in the queue (its file was
    // unreadable, say), as it can while a change of the limit runs alongside a synchronisation.
    const listCandidates = details.listEvictionCandidates.bind(details);
    vi.spyOn(details, 'listEvictionCandidates').mockImplementation(async (...args) => {
      const candidates = await listCandidates(...args);
      await details.resetToPending(TEST_ACCOUNT_ID, testMatchId(3));
      return candidates;
    });

    await expect(storage.enforceCap(TEST_ACCOUNT_ID)).resolves.toEqual({ evicted: 9 });

    // Match 3 was not evicted: its row is the queue's, its file stays, and it is not counted, so
    // the next candidate went instead.
    expect(await statusOf(3)).toBe('pending');
    expect(hasFile(3)).toBe(true);
    expect(await statusOf(10)).toBe('evicted');
    expect(hasFile(10)).toBe(false);
    expect(await statusOf(11)).toBe('ready');
    expect(logger.entries).toEqual([
      {
        level: 'info',
        scope: 'storage',
        message: 'Archives evicted',
        context: { evicted: 9, freedBytes: 9 * 2_400_000 },
      },
    ]);
  });

  it('runs one enforcement at a time, the next one reading the sizes afresh', async () => {
    // 50 archives of 2.4 MB, as above: nine to evict, whoever asks.
    const { storage, statusOf, logger } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      capMb: 100,
    });

    // A change of the limit and a synchronisation can ask at the same time.
    const results = await Promise.all([
      storage.enforceCap(TEST_ACCOUNT_ID),
      storage.enforceCap(TEST_ACCOUNT_ID),
    ]);

    // The second one waited for the first, and found the archives fitting: nothing more went.
    expect(results).toEqual([{ evicted: 9 }, { evicted: 0 }]);
    expect(await statusOf(9)).toBe('evicted');
    expect(await statusOf(10)).toBe('ready');
    expect(logger.entries.filter((entry) => entry.message === 'Archives evicted')).toHaveLength(1);
  });

  it('does not let a failed enforcement block the next one', async () => {
    const { storage, details, statusOf } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      capMb: 100,
    });
    vi.spyOn(details, 'sumArchivedBytes').mockRejectedValueOnce(
      new AppError('storage', 'Could not sum the archive sizes'),
    );

    const [first, second] = await Promise.allSettled([
      storage.enforceCap(TEST_ACCOUNT_ID),
      storage.enforceCap(TEST_ACCOUNT_ID),
    ]);

    // The first one failed for its caller; the one that waited for it ran all the same.
    expect(first).toMatchObject({ status: 'rejected', reason: { kind: 'storage' } });
    expect(second).toEqual({ status: 'fulfilled', value: { evicted: 9 } });
    expect(await statusOf(9)).toBe('evicted');
  });
});

describe('StorageService.previewEviction', () => {
  it('tells what an enforcement of the cap would evict, without writing', async () => {
    // As in the test of the window above, under the default limit of 500 MB: nothing goes yet.
    const { storage, settings, statusOf, hasFile, logger } = await setUp({
      count: 60,
      bytesEach: 5 * MB,
      recentCount: 50,
      unprojected: [4],
    });

    await expect(storage.previewEviction(100)).resolves.toEqual({
      evicted: 9,
      freedBytes: 9 * 5 * MB,
    });
    await expect(storage.previewEviction(5000)).resolves.toEqual({ evicted: 0, freedBytes: 0 });

    // Nothing was written: no row, no file, no setting, no log line.
    for (const id of idsUpTo(60)) {
      expect(await statusOf(id)).toBe('ready');
      expect(hasFile(id)).toBe(true);
    }
    await expect(settings.get()).resolves.toMatchObject({ storageCapMb: 500 });
    expect(logger.entries).toEqual([]);

    // The enforcement under that cap then evicts exactly what the preview told.
    await storage.setCap(100);
    expect(logger.entries.filter((entry) => entry.message === 'Archives evicted')).toEqual([
      {
        level: 'info',
        scope: 'storage',
        message: 'Archives evicted',
        context: { evicted: 9, freedBytes: 9 * 5 * MB },
      },
    ]);
    for (const id of idsUpTo(60)) {
      expect(await statusOf(id)).toBe(id <= 10 && id !== 4 ? 'evicted' : 'ready');
    }
  });

  it('waits for an enforcement that runs, so it never counts archives already removed', async () => {
    // 50 archives of 2.4 MB under 100 MB: an enforcement evicts nine and leaves 98.4 MB.
    const archive = new FailingRemovalStore();
    const { storage, statusOf } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      capMb: 100,
      archive,
    });
    // Hold the enforcement at its first removal: its row is `evicted` already, the others are not.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    archive.beforeRemove = () => gate;
    const enforcing = storage.enforceCap(TEST_ACCOUNT_ID);
    await vi.waitFor(async () => {
      expect(await statusOf(1)).toBe('evicted');
    });

    // Asked while the enforcement is held: the preview waits and settles after it.
    let previewed = false;
    const preview = storage.previewEviction(100).then((result) => {
      previewed = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previewed).toBe(false);

    release();
    await enforcing;
    // The enforcement left the archives fitting: nothing more would go.
    await expect(preview).resolves.toEqual({ evicted: 0, freedBytes: 0 });
  });

  it('has no preview without a linked account', async () => {
    const { storage } = await setUp({ count: 50, bytesEach: 2_400_000, accountId: null });

    await expect(storage.previewEviction(100)).resolves.toBeNull();
  });
});

describe('StorageService.setCap', () => {
  it("runs a cap change inside the sync's exclusive turn", async () => {
    // The exclusive section holds the task until the test lets it run.
    const held: (() => void)[] = [];
    const runExclusive = <T>(task: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        held.push(() => {
          task().then(resolve, reject);
        });
      });
    const { storage, settings, statusOf } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      runExclusive,
    });

    const changing = storage.setCap(100);

    // The setting is saved first, then the eviction waits for its turn.
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    await expect(settings.get()).resolves.toMatchObject({ storageCapMb: 100 });
    expect(await statusOf(1)).toBe('ready');

    held[0]?.();
    await expect(changing).resolves.toBeUndefined();
    expect(await statusOf(9)).toBe('evicted');
    expect(await statusOf(10)).toBe('ready');
  });

  it('keeps the new cap for the next synchronisation when the account changes meanwhile', async () => {
    const refusal = new AppError('unexpected', 'The task was refused while the account changes', {
      context: { reason: 'suspended' },
    });
    const { storage, settings, statusOf } = await setUp({
      count: 50,
      bytesEach: 2_400_000,
      runExclusive: () => Promise.reject(refusal),
    });

    // Not a failure: the cap is saved, and the next synchronisation enforces it.
    await expect(storage.setCap(100)).resolves.toBeUndefined();
    await expect(settings.get()).resolves.toMatchObject({ storageCapMb: 100 });
    expect(await statusOf(1)).toBe('ready');
  });
});

describe('StorageService.getUsage', () => {
  it('estimates the capacity from the measured average, else the typical size', async () => {
    const measured = await setUp({ count: 3, bytesEach: 250_000, capMb: 500 });
    await expect(measured.storage.getUsage()).resolves.toEqual({
      usedBytes: 750_000,
      capMb: 500,
      estimatedMatches: 2000,
      protectedCount: PROTECTED_RECENT_ARCHIVES,
    });

    // No archive yet: nothing used, and the typical size of an archive for the estimate.
    const empty = await setUp({ count: 0, bytesEach: 0, capMb: 100 });
    await expect(empty.storage.getUsage()).resolves.toEqual({
      usedBytes: 0,
      capMb: 100,
      estimatedMatches: Math.floor((100 * MB) / TYPICAL_ARCHIVE_BYTES),
      protectedCount: PROTECTED_RECENT_ARCHIVES,
    });
  });

  it('has no usage without a linked account', async () => {
    const { storage } = await setUp({ count: 3, bytesEach: MB, accountId: null });

    await expect(storage.getUsage()).resolves.toBeNull();
  });
});

/**
 * Tests of the archive reader (`ArchiveReaderService`), on the development adapters: an in-memory
 * archive, a memory logger and the zstd codec on the calling thread.
 *
 * The reader turns the file of a match into its envelope, or tells that the archive cannot be used.
 * What a caller does with that answer (the view of the match page, which puts the match back to
 * `pending`) is tested with the service that does it, in `match-detail.service.test.ts`.
 *
 * Bytes are compared by content and never with `instanceof Uint8Array`: under jsdom a typed array
 * made by a Node API is not an instance of the one of the test realm.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
} from '../adapters/dev/fixtures/match-history.fixture';
import {
  createMatchMetadataFixture,
  isMetadataMissing,
} from '../adapters/dev/fixtures/match-metadata.fixture';
import { MemoryArchiveStore } from '../adapters/dev/memory-archive-store.adapter';
import { MemoryLogger, type LogEntry } from '../adapters/dev/memory-logger.adapter';
import { parseMatchMetadata } from '../core/deadlock-api/match-metadata.schema';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { AppError, errorLogContext } from '../core/errors/app-error';
import {
  createArchiveEnvelope,
  encodeArchiveEnvelope,
  type ArchiveEnvelope,
} from '../core/match-detail/archive-envelope';
import { archivePath } from '../core/match-detail/archive-layout';
import { findTrackedPlayer, pruneForPlayer } from '../core/match-detail/pruning';
import { DirectCompressor } from '../test/direct-compressor';
import { testMatchId } from '../test/test-data';
import { ArchiveReaderService } from './archive-reader.service';

/** The current time of the tests (Unix milliseconds); the fixture history ends about 2 h before. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/** The tracked account: the one of the synthetic history. */
const ACCOUNT = FIXTURE_ACCOUNT_ID;

/** A fake account id that appears in every synthetic match detail, as one of the other players. */
const FAKE_OTHER_PLAYER = '2000001';

/** A Paige match of the synthetic history that deadlock-api has a detail for. */
const SERVED =
  createMatchHistoryFixture({ now: START, count: 30 }).find(
    (row) => row.hero_id === PAIGE_HERO_ID && !isMetadataMissing(testMatchId(row.match_id)),
  ) ?? expect.unreachable('the history holds a served match');

/** The match the tests read. */
const MATCH = testMatchId(SERVED.match_id);

/**
 * The envelope the queue would have archived for the match: its synthetic detail, pruned for the
 * tracked player.
 *
 * @returns The envelope.
 */
function archivedEnvelope(): ArchiveEnvelope {
  const metadata = parseMatchMetadata(createMatchMetadataFixture(SERVED, ACCOUNT), MATCH);
  const { playerSlot } = findTrackedPlayer(metadata, ACCOUNT);
  return createArchiveEnvelope(pruneForPlayer(metadata, playerSlot), ACCOUNT, START);
}

/**
 * Build the reader like the app does, on the development adapters.
 *
 * @returns The reader and the adapters it reads through, which a test may fill, inspect or break.
 */
function setUp() {
  const archive = new MemoryArchiveStore();
  const compressor = new DirectCompressor();
  const logger = new MemoryLogger();
  const reader = new ArchiveReaderService({ archive, compressor, logger });
  return { reader, archive, compressor, logger };
}

/** Everything {@link setUp} builds. */
type TestContext = ReturnType<typeof setUp>;

/**
 * Leave a file in the archive for the match, as the queue does once it has written it. The file may
 * hold anything, so that a test can damage it.
 *
 * @param context - What {@link setUp} built.
 * @param bytes - What the file holds.
 */
async function plantArchive(context: TestContext, bytes: Uint8Array): Promise<void> {
  await context.archive.write(ACCOUNT, MATCH, bytes);
}

/**
 * The lines the reader wrote at a level.
 *
 * @param logger - The logger the reader wrote to.
 * @param level - The level to keep.
 * @returns The lines of that level, oldest first.
 */
function linesAt(logger: MemoryLogger, level: LogEntry['level']): LogEntry[] {
  return logger.entries.filter((entry) => entry.level === level);
}

/**
 * What a call to the reader ended in, whichever way it ended.
 *
 * @param call - The call to the reader.
 * @returns The error it rejected with, or `null` when it resolved.
 */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => null,
    (reason: unknown) => reason,
  );
}

/** An archive that cannot be read back because of what it holds, and how the reading fails on it. */
interface DamagedArchive {
  /** What is wrong with the archive. */
  readonly label: string;
  /** The step of the reading that fails. */
  readonly step: string;
  /** What the warning holds about the failure: codes, never a value of the file. */
  readonly expectedInLog: Readonly<Record<string, string>>;
  /** Leaves the archive of the match in that state. */
  readonly plant: (context: TestContext) => Promise<void>;
}

/**
 * The ways an archive can be damaged: one for each step of the reader that can find a problem in the
 * data. A failure of the disk or of the compressor is not one of them: it says nothing about the
 * archive, and the reader lets it through.
 */
const DAMAGED_ARCHIVES: readonly DamagedArchive[] = [
  {
    label: 'a file that is not a zstd frame',
    step: 'decompress',
    expectedInLog: { kind: 'storage' },
    plant: (context) => plantArchive(context, Uint8Array.of(1, 2, 3, 4)),
  },
  {
    label: 'a frame the compressor rejects as invalid data',
    step: 'decompress',
    expectedInLog: { kind: 'invalid_payload', cause: 'Unknown frame descriptor' },
    plant: async (context) => {
      await plantArchive(context, Uint8Array.of(1));
      // The error the worker adapter gives when the codec reports a bad frame.
      vi.spyOn(context.compressor, 'decompress').mockRejectedValueOnce(
        new AppError('invalid_payload', 'The compressor could not read the data', {
          cause: new Error('Unknown frame descriptor'),
        }),
      );
    },
  },
  {
    label: 'a frame that holds no JSON',
    step: 'decode',
    expectedInLog: { kind: 'invalid_payload', issue: 'archive_json' },
    plant: async (context) =>
      plantArchive(
        context,
        await context.compressor.compress(new TextEncoder().encode('not json')),
      ),
  },
];

describe('ArchiveReaderService.readArchive', () => {
  it('reads back the envelope of an archive, and logs nothing', async () => {
    const context = setUp();
    const envelope = archivedEnvelope();
    await plantArchive(context, await context.compressor.compress(encodeArchiveEnvelope(envelope)));

    const read = await context.reader.readArchive(ACCOUNT, MATCH);

    // The envelope is the one that was archived: the account it was pruned for, the time it was
    // fetched, and the pruned detail.
    expect(read).toEqual({ kind: 'read', envelope });
    // Reading an archive is routine: it adds no line to the log.
    expect(context.logger.entries).toEqual([]);
  });

  it('says a file that is absent is unreadable, with an info line and no warning', async () => {
    const { reader, archive, logger } = setUp();

    await expect(reader.readArchive(ACCOUNT, MATCH)).resolves.toEqual({ kind: 'unreadable' });

    expect(archive.files.size).toBe(0);
    // A file that is gone is not a failure of the app (the folder may have been emptied): `info`.
    expect(linesAt(logger, 'warn')).toEqual([]);
    expect(linesAt(logger, 'info')).toEqual([
      {
        level: 'info',
        scope: 'detail',
        message: 'Detail archive is missing',
        context: { matchId: MATCH },
      },
    ]);
  });

  it.each(DAMAGED_ARCHIVES)(
    'says $label is unreadable, with one warning that names the step',
    async ({ label, step, expectedInLog, plant }) => {
      const context = setUp();
      await plant(context);

      await expect(context.reader.readArchive(ACCOUNT, MATCH), label).resolves.toEqual({
        kind: 'unreadable',
      });

      // The file is left alone: the next archive written replaces it.
      expect(context.archive.files.has(archivePath(ACCOUNT, MATCH)), label).toBe(true);
      // One warning, with the step that failed and the codes of the failure.
      expect(linesAt(context.logger, 'warn'), label).toMatchObject([
        {
          scope: 'detail',
          message: 'Detail archive is unreadable',
          context: { matchId: MATCH, step, ...expectedInLog },
        },
      ]);
      expect(linesAt(context.logger, 'info'), label).toEqual([]);
      // Neither a value of the file (the ids of the other players) nor an account id is logged.
      const logged = JSON.stringify(context.logger.entries);
      expect(logged, label).not.toContain(FAKE_OTHER_PLAYER);
      expect(logged, label).not.toContain(String(ACCOUNT));
    },
  );

  it('lets a file that cannot be read reach the caller as a storage error, and logs nothing', async () => {
    const { reader, archive, logger } = setUp();
    vi.spyOn(archive, 'read').mockRejectedValueOnce(new Error('Access is denied'));

    const failure = await failureOf(reader.readArchive(ACCOUNT, MATCH));

    // Nothing says the archive is damaged, so the reader does not call it unreadable: it fails.
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      kind: 'storage',
      message: 'The archive of a match could not be read',
      context: { step: 'read', matchId: MATCH, kind: 'storage', cause: 'Access is denied' },
    });
    expect(logger.entries).toEqual([]);
  });

  it('keeps the account id out of the error and the log when the disk fails on a path', async () => {
    const { reader, archive, logger } = setUp();
    await archive.write(ACCOUNT, MATCH, Uint8Array.of(1));
    const matchText = String(MATCH);
    vi.spyOn(archive, 'read').mockRejectedValueOnce(
      new Error(`Access is denied to archive/${String(ACCOUNT)}/${matchText}.json.zst`),
    );

    const failure = await failureOf(reader.readArchive(ACCOUNT, MATCH));

    if (!(failure instanceof AppError)) {
      expect.unreachable('the reader rejects with an AppError');
    }
    // The raw error of the disk is not kept as the cause: it quotes the path. The description of the
    // failure is in the context instead, with the account id replaced, and the interface logs what
    // it holds with `errorLogContext`.
    expect(failure.cause).toBeUndefined();
    const logged = errorLogContext(failure);
    expect(logged).toMatchObject({
      kind: 'storage',
      step: 'read',
      matchId: MATCH,
      cause: `Access is denied to archive/{account_id}/${matchText}.json.zst`,
    });
    expect(JSON.stringify(logged)).not.toContain(String(ACCOUNT));
    expect(failure.message).not.toContain(String(ACCOUNT));
    expect(JSON.stringify(logger.entries)).not.toContain(String(ACCOUNT));
  });

  it('lets the failure of a broken compressor reach the caller as it is, and logs nothing', async () => {
    const { reader, archive, compressor, logger } = setUp();
    await archive.write(ACCOUNT, MATCH, Uint8Array.of(1));
    // The failure of the worker adapter when the compressor itself is broken (its worker crashed, or
    // could not load its codec), which is not a problem of the data.
    const compressorFailure = new AppError('storage', 'The compressor failed');
    vi.spyOn(compressor, 'decompress').mockRejectedValueOnce(compressorFailure);

    const failure = await failureOf(reader.readArchive(ACCOUNT, MATCH));

    expect(failure).toBe(compressorFailure);
    expect(logger.entries).toEqual([]);
  });
});

describe('ArchiveReaderService.reportUnreadable', () => {
  it('logs a warning with the step and the codes of an error of the app, without its stack', () => {
    const { reader, logger } = setUp();

    reader.reportUnreadable(
      ACCOUNT,
      MATCH,
      'record',
      new AppError('storage', 'A ready match has no archive size', {
        context: { issue: 'archived_bytes_missing' },
      }),
    );

    // The exact line: `toEqual` also tells that no stack and no account id came with it.
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        scope: 'detail',
        message: 'Detail archive is unreadable',
        context: {
          kind: 'storage',
          issue: 'archived_bytes_missing',
          matchId: MATCH,
          step: 'record',
        },
      },
    ]);
  });

  it('keeps the stack of what is not an error of the app, and the account id out of the line', () => {
    const { reader, logger } = setUp();

    // The library of the compressor, or a bug: the stack is what tells where it came from.
    reader.reportUnreadable(
      ACCOUNT,
      MATCH,
      'summarize',
      new TypeError(`Cannot read archive/${String(ACCOUNT)}/${String(MATCH)}.json.zst`),
    );

    expect(logger.entries).toMatchObject([
      {
        level: 'warn',
        scope: 'detail',
        message: 'Detail archive is unreadable',
        context: {
          kind: 'storage',
          cause: `Cannot read archive/{account_id}/${String(MATCH)}.json.zst`,
          matchId: MATCH,
          step: 'summarize',
          stack: expect.stringContaining('TypeError') as unknown,
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(String(ACCOUNT));
  });
});

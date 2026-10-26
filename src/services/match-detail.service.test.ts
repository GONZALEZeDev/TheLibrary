/**
 * Tests of the detail queue (`MatchDetailService.runQueue`), end to end on the development
 * adapters: the synthetic deadlock-api, an in-memory database holding the synthetic history, an
 * in-memory archive and the zstd codec on the calling thread.
 *
 * The fixture history of 30 matches holds Paige matches, which the queue must archive (every match
 * of it is a normal-mode game), some of them being matches deadlock-api "never received" (it
 * answers 404). The matches of the other heroes must never be requested.
 *
 * Bytes are compared by content and never with `instanceof Uint8Array`: under jsdom a typed array
 * made by a Node API is not an instance of the one of the test realm.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
  type RawMatchHistoryRow,
} from '../adapters/dev/fixtures/match-history.fixture';
import {
  createMatchMetadataFixture,
  isMetadataMissing,
} from '../adapters/dev/fixtures/match-metadata.fixture';
import { MemoryArchiveStore } from '../adapters/dev/memory-archive-store.adapter';
import { MemoryLogger, type LogEntry } from '../adapters/dev/memory-logger.adapter';
import { StaticAccountSource } from '../adapters/dev/static-account-source.adapter';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import { MAX_RESPONSE_BYTES } from '../core/deadlock-api/endpoints';
import { parseMatchHistory } from '../core/deadlock-api/match-history.schema';
import { parseMatchMetadata } from '../core/deadlock-api/match-metadata.schema';
import type { AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import type { MatchId, MatchSummary } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import {
  ARCHIVE_FORMAT,
  createArchiveEnvelope,
  decodeArchiveEnvelope,
  encodeArchiveEnvelope,
  type ArchiveEnvelope,
} from '../core/match-detail/archive-envelope';
import { summarizeArchive } from '../core/match-detail/archive-facts';
import {
  archiveFolder,
  archivePath,
  isTemporaryArchiveName,
  quarantineFolder,
  quarantinePath,
  QUARANTINE_LIMIT,
} from '../core/match-detail/archive-layout';
import {
  DETAIL_WINDOW_MS,
  RETRY_DELAYS_MS,
  type DetailState,
} from '../core/match-detail/detail-status';
import type { Database } from '../ports/database.port';
import type { LogContext } from '../ports/logger.port';
import type { HttpRequest, HttpResponse } from '../ports/http-client.port';
import { DirectCompressor } from '../test/direct-compressor';
import { createTestDatabase, matchSummary, testAccountId, testMatchId } from '../test/test-data';
import { ArchiveReaderService } from './archive-reader.service';
import { DeadlockApiService } from './deadlock-api.service';
import { MatchDetailRepository, type StoredDetail } from './match-detail.repository';
import { MatchDetailService, type DetailRunReport } from './match-detail.service';
import { MatchesRepository } from './matches.repository';
import { MetricsRepository, type ProjectionRecord } from './metrics.repository';
import { ProjectionService } from './projection.service';
import { SyncStateRepository } from './sync-state.repository';

/** The current time of the tests (Unix milliseconds); the fixture history ends about 2 h before. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

const MINUTE = 60_000;

/** One day, in milliseconds. */
const DAY = 24 * 60 * MINUTE;

/** The window of the archive in seconds, the unit of the start time of a match. */
const WINDOW_S = DETAIL_WINDOW_MS / 1000;

/** The tracked account: the one of the synthetic history. */
const ACCOUNT = FIXTURE_ACCOUNT_ID;

/** The id of the run, as the synchronisation gives it. */
const RUN = 'run-0001';

/** A fake account id that appears in every synthetic match detail, as one of the other players. */
const FAKE_OTHER_PLAYER = '2000001';

/** What a run that did nothing reports. */
const NOTHING: DetailRunReport = {
  archived: 0,
  retried: 0,
  unavailable: 0,
  invalid: 0,
  refreshed: 0,
  stoppedBy: null,
};

/**
 * What the queue records about the detail of a match: the columns it writes, without the fields of
 * the match that the stored detail also carries (the queue never writes those) and without the
 * format of the archive, which these tests do not look at.
 */
type RecordedDetail = Omit<StoredDetail, 'match' | 'archiveFormat'>;

/** The detail state of a match nobody tried yet. */
const UNTOUCHED: RecordedDetail = {
  status: 'pending',
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  archivedBytes: null,
};

/** The state of a match the queue gave up on. */
const UNAVAILABLE: DetailState = {
  status: 'unavailable',
  attempts: 6,
  nextAttemptAt: null,
  lastError: 'not_found (404)',
};

/** The state of a match whose detail the app cannot use. */
const INVALID: DetailState = {
  status: 'invalid',
  attempts: 1,
  nextAttemptAt: null,
  lastError: 'invalid_payload (match_id)',
};

/**
 * The state of a match waiting for its next attempt.
 *
 * @param nextAttemptAt - When the attempt is due, in Unix milliseconds.
 * @returns The state, after two counted failures.
 */
function retrying(nextAttemptAt: number): DetailState {
  return { status: 'retry', attempts: 2, nextAttemptAt, lastError: 'not_found (404)' };
}

/** The synthetic history the queue works on: 30 matches, most recent first. */
const HISTORY = createMatchHistoryFixture({ now: START, count: 30 });

/** The Paige matches of the history: the ones the queue downloads. */
const ELIGIBLE_ROWS = HISTORY.filter((row) => row.hero_id === PAIGE_HERO_ID);

/** The eligible matches deadlock-api has a detail for. */
const SERVED_ROWS = ELIGIBLE_ROWS.filter((row) => !isMetadataMissing(testMatchId(row.match_id)));

/** The eligible matches deadlock-api answers 404 for. */
const MISSING_ROWS = ELIGIBLE_ROWS.filter((row) => isMetadataMissing(testMatchId(row.match_id)));

/**
 * Matches picked once for the tests: two that have a detail, one that has none, and the two oldest
 * ones that have a detail (a run that stops early never reaches those).
 */
const SERVED = SERVED_ROWS[0] ?? expect.unreachable('the history holds a served match');
const OTHER_SERVED = SERVED_ROWS[1] ?? expect.unreachable('the history holds two served matches');
const MISSING = MISSING_ROWS[0] ?? expect.unreachable('the history holds a missing match');
const OLDEST_SERVED = SERVED_ROWS.at(-1) ?? expect.unreachable('the history holds served matches');
const NEXT_OLDEST_SERVED =
  SERVED_ROWS.at(-2) ?? expect.unreachable('the history holds served matches');

/**
 * The match id of a history row.
 *
 * @param row - The row.
 * @returns Its match id.
 */
function matchOf(row: RawMatchHistoryRow): MatchId {
  return testMatchId(row.match_id);
}

/**
 * The match summaries the app would store for some rows of the history.
 *
 * @param rows - Rows of the synthetic history.
 * @returns Their summaries, as the synchronisation saves them.
 */
function summariesOf(rows: readonly RawMatchHistoryRow[]): readonly MatchSummary[] {
  return parseMatchHistory(rows, ACCOUNT).matches;
}

/**
 * The match a request asks the detail of.
 *
 * @param request - A request to the detail endpoint.
 * @returns The match id of its URL.
 */
function matchIdOfRequest(request: HttpRequest): MatchId {
  const text = /\/matches\/(\d+)\/metadata/.exec(request.url)?.[1];
  return testMatchId(Number(text));
}

/** Options of {@link setUp}. */
interface SetUpOptions {
  /** The matches stored before the run; the whole synthetic history by default. */
  readonly matches?: readonly MatchSummary[];
  /** Answers the requests; the synthetic deadlock-api by default (it can be replaced later). */
  readonly handler?: FixtureHandler;
  /** The random source of the retry delays; `0.5` by default, which gives the exact delay. */
  readonly random?: () => number;
  /** How far every reading of the clock moves it, in milliseconds; none by default. */
  readonly clockStepMs?: number;
  /**
   * The database of an earlier call, to simulate a restart of the app: nothing is stored again
   * unless `matches` is given. A fresh one by default.
   */
  readonly database?: Database;
  /** The archive of an earlier call (the folder survives a restart); a fresh one by default. */
  readonly archive?: MemoryArchiveStore;
  /** The linked account; the tracked one by default, `null` for none (the matches stay stored). */
  readonly accountId?: AccountId | null;
}

/**
 * Build the queue like the app does, on the development adapters and a clock the test controls.
 *
 * The API service never really waits for a free request slot: its `sleep` moves the clock.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The service and everything a test may inspect or change.
 */
async function setUp(options: SetUpOptions = {}) {
  const clock = { now: START };
  const now = (): number => {
    const reading = clock.now;
    clock.now += options.clockStepMs ?? 0;
    return reading;
  };
  const answer = { handler: options.handler ?? createFixtureApi({ now: START, matchCount: 30 }) };
  const logger = new MemoryLogger();
  const http = new FixtureHttpClient((request) => answer.handler(request));
  const database = options.database ?? createTestDatabase();
  const syncState = new SyncStateRepository(database, logger, now);
  if (options.matches !== undefined || options.database === undefined) {
    await new MatchesRepository(database, now).upsertMany(options.matches ?? summariesOf(HISTORY));
  }
  const api = new DeadlockApiService(http, syncState, logger, {
    appVersion: '0.0.0-test',
    now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const repository = new MatchDetailRepository(database);
  const archive = options.archive ?? new MemoryArchiveStore();
  const compressor = new DirectCompressor();
  // The real reader, on the same archive, compressor and logger: the page is tested through it.
  const reader = new ArchiveReaderService({ archive, compressor, logger });
  // The real analysis, on the same database and archive: a refreshed match forgets its projection
  // through it, in turn with its projections, as in the app.
  const metrics = new MetricsRepository(database);
  const projection = new ProjectionService({
    reader,
    metrics,
    details: repository,
    logger,
    now,
    yieldToEventLoop: () => Promise.resolve(),
  });
  const service = new MatchDetailService({
    accountSource: new StaticAccountSource(
      options.accountId === undefined ? ACCOUNT : options.accountId,
    ),
    api,
    repository,
    archive,
    compressor,
    reader,
    projections: projection,
    logger,
    now,
    random: options.random ?? (() => 0.5),
  });
  return {
    service,
    api,
    repository,
    metrics,
    projection,
    archive,
    compressor,
    reader,
    logger,
    http,
    syncState,
    clock,
    answer,
    database,
  };
}

/** Everything {@link setUp} builds. */
type TestContext = Awaited<ReturnType<typeof setUp>>;

/**
 * A match of the tracked account that the queue would archive: a ranked Paige game, played an hour
 * before the current time of the tests. Override a field to make it one the queue never archives.
 *
 * @param matchId - The match id, which is not one of the synthetic history.
 * @param overrides - Fields of the match summary to change.
 * @returns The match summary.
 */
function eligibleMatch(
  matchId: number,
  overrides: Parameters<typeof matchSummary>[0] = {},
): MatchSummary {
  return matchSummary({
    accountId: ACCOUNT,
    matchId,
    startTime: START / 1000 - 3_600,
    ...overrides,
  });
}

/**
 * Leave a file in the archive and record the match as archived, as the queue does once it has
 * written the file. The file may hold anything, so that a test can damage it.
 *
 * @param context - What {@link setUp} built; the match must be stored.
 * @param row - The row of the match.
 * @param bytes - What the file holds.
 */
async function plantArchive(
  context: TestContext,
  row: RawMatchHistoryRow,
  bytes: Uint8Array,
): Promise<void> {
  await context.archive.write(ACCOUNT, matchOf(row), bytes);
  await context.repository.markReady(ACCOUNT, matchOf(row), bytes.length, ARCHIVE_FORMAT);
}

/**
 * What the queue recorded about the detail of a match.
 *
 * @param repository - The repository the queue writes to.
 * @param row - The row of the match.
 * @returns Its detail state, without the fields of the match.
 */
async function storedDetail(
  repository: MatchDetailRepository,
  row: RawMatchHistoryRow,
): Promise<RecordedDetail> {
  const detail = await repository.getDetail(ACCOUNT, matchOf(row));
  const { status, attempts, nextAttemptAt, lastError, archivedBytes } =
    detail ?? expect.unreachable('the match is stored');
  return { status, attempts, nextAttemptAt, lastError, archivedBytes };
}

/**
 * The files of the quarantine folder of the tracked account.
 *
 * @param archive - The archive store.
 * @returns Their paths, sorted.
 */
function quarantinedPaths(archive: MemoryArchiveStore): string[] {
  return [...archive.files.keys()]
    .filter((path) => path.startsWith(`${quarantineFolder(ACCOUNT)}/`))
    .sort();
}

/**
 * Read a quarantined response back.
 *
 * @param archive - The archive store.
 * @param compressor - The compressor the queue used.
 * @param matchId - The match the response was fetched for.
 * @param at - When it was quarantined (Unix ms).
 * @returns The text of the response.
 */
async function readQuarantined(
  archive: MemoryArchiveStore,
  compressor: DirectCompressor,
  matchId: MatchId,
  at: number,
): Promise<string> {
  const bytes = archive.files.get(quarantinePath(ACCOUNT, matchId, at));
  return new TextDecoder().decode(
    await compressor.decompress(bytes ?? expect.unreachable('the response is quarantined')),
  );
}

/**
 * Let the pending work of the other promises run (a macrotask later).
 *
 * @returns A promise resolved after a timer of 0 ms.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A request the test keeps unanswered, with the two ways to answer it. */
interface HeldRequest {
  readonly request: HttpRequest;
  readonly answer: (response: HttpResponse) => void;
  readonly fail: (error: Error) => void;
}

/**
 * A handler that keeps every request unanswered until the test answers it.
 *
 * @returns The handler, the requests it holds (oldest first), and `whenHeld`, which resolves once
 *   that many requests are held: it is told by the handler, it does not poll.
 */
function holdRequests(): {
  handler: FixtureHandler;
  held: HeldRequest[];
  whenHeld: (count: number) => Promise<void>;
} {
  const held: HeldRequest[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];
  return {
    held,
    handler: (request) =>
      new Promise<HttpResponse>((resolve, reject) => {
        held.push({ request, answer: resolve, fail: reject });
        for (const waiter of waiting) {
          if (held.length >= waiter.count) {
            waiter.resolve();
          }
        }
      }),
    whenHeld: (count) =>
      new Promise<void>((resolve) => {
        if (held.length >= count) {
          resolve();
        } else {
          waiting.push({ count, resolve });
        }
      }),
  };
}

/**
 * What a fixture handler answers to a request a test held, to pass on as the answer of that request.
 * The handler sees a GET (the detail endpoint is one), and its body is JSON text, which is what a
 * held request is answered with.
 *
 * @param handler - The fixture handler.
 * @param request - The held request.
 * @returns The handler's response, with its body as text.
 */
async function answerLike(handler: FixtureHandler, request: HttpRequest): Promise<HttpResponse> {
  const response = await handler({ ...request, method: 'GET' });
  const body =
    typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body);
  return { ...response, body };
}

/**
 * The context of the lines that end a run, oldest first.
 *
 * @param logger - The logger the queue wrote to.
 * @returns The contexts of the `info` lines `Detail queue ended`.
 */
function runEnds(logger: MemoryLogger): LogContext[] {
  return logger.entries
    .filter((entry) => entry.message === 'Detail queue ended')
    .map((entry) => entry.context);
}

/**
 * The lines that report that a run was stopped, oldest first.
 *
 * @param logger - The logger the queue wrote to.
 * @returns The log entries `Detail queue stopped`.
 */
function stopLines(logger: MemoryLogger): LogEntry[] {
  return logger.entries.filter((entry) => entry.message === 'Detail queue stopped');
}

/** A response that is not a match detail at all. */
const NOT_JSON: HttpResponse = {
  status: 200,
  headers: {},
  body: '<html>The service is down for maintenance</html>',
};

/**
 * A handler answering every request with the detail of another match.
 *
 * @returns The handler.
 */
function answerWithAnotherMatch(): FixtureHandler {
  return () => jsonResponse(createMatchMetadataFixture(OTHER_SERVED, ACCOUNT));
}

/** The part of a match detail that {@link metadataWithoutNetWorth} edits. */
interface EditableDetail {
  match_info: { players: { account_id: number; net_worth?: number }[] };
}

/**
 * The synthetic detail of a match, except that the tracked player has lost their `net_worth`: it
 * passes the validation of a download, but the facts of the match page cannot be read from it.
 *
 * @param row - The row of the match.
 * @returns The detail, in the raw shape of the API.
 */
function metadataWithoutNetWorth(row: RawMatchHistoryRow): EditableDetail {
  const detail = createMatchMetadataFixture(row, ACCOUNT) as EditableDetail;
  const tracked = detail.match_info.players.find((player) => player.account_id === ACCOUNT);
  delete (tracked ?? expect.unreachable('the tracked player is in the match')).net_worth;
  return detail;
}

/**
 * The archive a version of the app that did not read its facts back could have written for a
 * detail without the `net_worth` of the tracked player.
 *
 * @param row - The row of the match.
 * @returns The envelope: valid as an archive, but its facts cannot be read.
 */
function envelopeWithoutNetWorth(row: RawMatchHistoryRow): ArchiveEnvelope {
  return createArchiveEnvelope(parseMatchMetadata(metadataWithoutNetWorth(row)), ACCOUNT, START);
}

describe('MatchDetailService.runQueue', () => {
  it('archives every eligible match and only those', async () => {
    const { service, archive, compressor, repository, http, logger } = await setUp();

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({
      ...NOTHING,
      archived: SERVED_ROWS.length,
      retried: MISSING_ROWS.length,
    });
    // The files are exactly those of the Paige matches the API has a detail for.
    expect([...archive.files.keys()].sort()).toEqual(
      SERVED_ROWS.map((row) => archivePath(ACCOUNT, matchOf(row))).sort(),
    );
    // Only the Paige matches were requested; the other heroes' were never asked for.
    expect(http.requests.map((request) => matchIdOfRequest(request)).sort()).toEqual(
      ELIGIBLE_ROWS.map((row) => matchOf(row)).sort(),
    );
    for (const row of SERVED_ROWS) {
      const bytes =
        archive.files.get(archivePath(ACCOUNT, matchOf(row))) ??
        expect.unreachable('the archive exists');
      const envelope = decodeArchiveEnvelope(await compressor.decompress(bytes));
      // The archive holds the pruned detail: all the players, and the paths of all twelve of them.
      expect(envelope.prunedForAccountId).toBe(ACCOUNT);
      expect(envelope.payload.match_info.match_id).toBe(row.match_id);
      expect(envelope.payload.match_info.players).toHaveLength(12);
      const pathSlots = envelope.payload.match_info.match_paths?.paths.map(
        (path) => path.player_slot,
      );
      expect(pathSlots?.toSorted((a, b) => a - b)).toEqual(
        envelope.payload.match_info.players
          .map((player) => player.player_slot)
          .toSorted((a, b) => a - b),
      );
      expect(pathSlots).toHaveLength(12);
      await expect(storedDetail(repository, row)).resolves.toEqual({
        status: 'ready',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        archivedBytes: bytes.length,
      });
      // The file and the database agree on the format: the current one, so it is never refreshed.
      expect(envelope.archiveFormat).toBe(ARCHIVE_FORMAT);
      await expect(repository.getDetail(ACCOUNT, matchOf(row))).resolves.toMatchObject({
        archiveFormat: ARCHIVE_FORMAT,
      });
    }
    // The database agrees: the archived matches are ready, the two the API lacks wait for a retry.
    await expect(repository.summary(ACCOUNT, START)).resolves.toEqual({
      archived: SERVED_ROWS.length,
      waiting: MISSING_ROWS.length,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
    });
    // One line at the info level, the one the log file keeps, and it holds only counters.
    expect(logger.entries.filter((entry) => entry.level === 'info')).toEqual([
      {
        level: 'info',
        scope: 'detail',
        message: 'Detail queue ended',
        context: {
          syncRunId: RUN,
          archived: SERVED_ROWS.length,
          retried: MISSING_ROWS.length,
          unavailable: 0,
          invalid: 0,
          refreshed: 0,
          quarantined: 0,
          stoppedBy: null,
        },
      },
    ]);
  }, 60_000);

  it('records a retry for a match the API does not have', async () => {
    const { service, repository, archive } = await setUp({ matches: summariesOf([MISSING]) });

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, retried: 1 });
    await expect(storedDetail(repository, MISSING)).resolves.toEqual({
      status: 'retry',
      attempts: 1,
      nextAttemptAt: START + 5 * MINUTE,
      lastError: 'not_found (404)',
      archivedBytes: null,
    });
    expect(archive.files.size).toBe(0);
  });

  it('spreads the retry dates with its random source', async () => {
    const { service, repository } = await setUp({
      matches: summariesOf([MISSING]),
      // The lowest value of the source shortens the delay by the whole jitter (10 %).
      random: () => 0,
    });

    await service.runQueue(ACCOUNT, RUN);

    await expect(storedDetail(repository, MISSING)).resolves.toMatchObject({
      status: 'retry',
      nextAttemptAt: START + 5 * MINUTE * 0.9,
    });
  });

  it('makes a match unavailable after six counted failures', async () => {
    const { service, repository, clock, http, logger } = await setUp({
      matches: summariesOf([MISSING]),
    });

    for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
      await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, retried: 1 });
      const detail = await storedDetail(repository, MISSING);
      // The n-th failure waits the n-th delay of the schedule, from the moment it was recorded.
      expect(detail).toEqual({
        status: 'retry',
        attempts: index + 1,
        nextAttemptAt: clock.now + delay,
        lastError: 'not_found (404)',
        archivedBytes: null,
      });
      const dueAt = detail.nextAttemptAt ?? expect.unreachable('a retry has a date');
      // One millisecond early, the match is not due: nothing is requested.
      clock.now = dueAt - 1;
      await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual(NOTHING);
      clock.now = dueAt;
    }
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, unavailable: 1 });

    await expect(storedDetail(repository, MISSING)).resolves.toEqual({
      status: 'unavailable',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'not_found (404)',
      archivedBytes: null,
    });
    // The queue gave up: even a year later, nothing is requested again.
    clock.now += 365 * 24 * 60 * MINUTE;
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual(NOTHING);
    expect(http.requests).toHaveLength(6);
    // A routine retry is a debug line; the match given up is a warning.
    expect(
      logger.entries
        .filter((entry) => entry.message === 'Detail attempt failed')
        .map((entry) => [entry.level, entry.context.status]),
    ).toEqual([
      ['debug', 'retry'],
      ['debug', 'retry'],
      ['debug', 'retry'],
      ['debug', 'retry'],
      ['debug', 'retry'],
      ['warn', 'unavailable'],
    ]);
  });

  it.each([
    [500, 'service_unavailable (500)'],
    [403, 'forbidden (403)'],
    [400, 'unexpected (400)'],
  ])('records a retry when the API answers %i', async (status, lastError) => {
    const { service, repository } = await setUp({
      matches: summariesOf([SERVED]),
      handler: () => jsonResponse({ error: 'no' }, status),
    });

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, retried: 1 });

    await expect(storedDetail(repository, SERVED)).resolves.toEqual({
      status: 'retry',
      attempts: 1,
      nextAttemptAt: START + 5 * MINUTE,
      lastError,
      archivedBytes: null,
    });
  });

  it('records a retry, and quarantines nothing, for an answer without a body', async () => {
    const { service, repository, archive } = await setUp({
      matches: summariesOf([SERVED]),
      handler: () => ({ status: 204, headers: {}, body: '' }),
    });

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, retried: 1 });

    // An empty answer is a hiccup of the API, not a verdict on the match: it is tried again.
    await expect(storedDetail(repository, SERVED)).resolves.toEqual({
      status: 'retry',
      attempts: 1,
      nextAttemptAt: START + 5 * MINUTE,
      lastError: 'empty_body',
      archivedBytes: null,
    });
    expect(archive.files.size).toBe(0);
  });

  it('marks invalid and quarantines a response for another match', async () => {
    const { service, repository, archive, compressor, http, logger } = await setUp({
      matches: summariesOf([SERVED]),
      handler: answerWithAnotherMatch(),
    });

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, invalid: 1 });
    await expect(storedDetail(repository, SERVED)).resolves.toEqual({
      status: 'invalid',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'invalid_payload (match_id)',
      archivedBytes: null,
    });
    // Nothing was archived for the match; the response is kept, as it came, for a look.
    expect(archive.files.has(archivePath(ACCOUNT, matchOf(SERVED)))).toBe(false);
    expect(quarantinedPaths(archive)).toEqual([quarantinePath(ACCOUNT, matchOf(SERVED), START)]);
    // It is kept in the folder of the account, so that it goes away with the account's data.
    expect(quarantinedPaths(archive)[0]?.startsWith(`${archiveFolder(ACCOUNT)}/quarantine/`)).toBe(
      true,
    );
    const kept = await readQuarantined(archive, compressor, matchOf(SERVED), START);
    expect(kept).toBe(JSON.stringify(createMatchMetadataFixture(OTHER_SERVED, ACCOUNT)));
    // The verdict is final: the next run does not ask again.
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual(NOTHING);
    expect(http.requests).toHaveLength(1);
    // A final verdict is a warning, with the field and the code of the problem only.
    expect(logger.entries).toContainEqual({
      level: 'warn',
      scope: 'detail',
      message: 'Detail attempt failed',
      context: {
        syncRunId: RUN,
        matchId: matchOf(SERVED),
        status: 'invalid',
        attempts: 1,
        lastError: 'invalid_payload (match_id)',
      },
    });
    expect(runEnds(logger)[0]).toMatchObject({ invalid: 1, quarantined: 1 });
  });

  it('marks invalid a response without the tracked player', async () => {
    const { service, repository, archive } = await setUp({
      matches: summariesOf([SERVED]),
      // The detail of the right match, played by nobody of the tracked account.
      handler: () => jsonResponse(createMatchMetadataFixture(SERVED, testAccountId(3_000_001))),
    });

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, invalid: 1 });

    await expect(storedDetail(repository, SERVED)).resolves.toEqual({
      status: 'invalid',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'invalid_payload (tracked_player_missing)',
      archivedBytes: null,
    });
    expect(quarantinedPaths(archive)).toHaveLength(1);
    expect(archive.files.has(archivePath(ACCOUNT, matchOf(SERVED)))).toBe(false);
  });

  it('marks invalid a response whose facts cannot be read', async () => {
    const { service, repository, archive, compressor, http, logger } = await setUp({
      matches: summariesOf([SERVED]),
      // A detail the validation accepts, whose tracked player has no `net_worth`.
      handler: () => jsonResponse(metadataWithoutNetWorth(SERVED)),
    });

    const report = await service.runQueue(ACCOUNT, RUN);

    // The door check: an archive is only kept if the page can read its facts back.
    expect(report).toEqual({ ...NOTHING, invalid: 1 });
    await expect(storedDetail(repository, SERVED)).resolves.toEqual({
      status: 'invalid',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'invalid_payload (tracked_player.net_worth: invalid_type)',
      archivedBytes: null,
    });
    expect(archive.files.has(archivePath(ACCOUNT, matchOf(SERVED)))).toBe(false);
    // The response is kept as it came, like any other detail the app cannot use.
    expect(quarantinedPaths(archive)).toHaveLength(1);
    await expect(readQuarantined(archive, compressor, matchOf(SERVED), START)).resolves.toBe(
      JSON.stringify(metadataWithoutNetWorth(SERVED)),
    );
    // The verdict is final: the next run does not ask again, which ends the loop of downloads.
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual(NOTHING);
    expect(http.requests).toHaveLength(1);
    // The log holds the field and the code of the problem, as for any invalid detail.
    expect(logger.entries).toContainEqual({
      level: 'warn',
      scope: 'detail',
      message: 'Detail attempt failed',
      context: {
        syncRunId: RUN,
        matchId: matchOf(SERVED),
        status: 'invalid',
        attempts: 1,
        lastError: 'invalid_payload (tracked_player.net_worth: invalid_type)',
      },
    });
  });

  it('records a retry, quarantines the body and stops the run on an answer that is not JSON', async () => {
    const { service, repository, archive, compressor, logger } = await setUp({
      matches: summariesOf([SERVED]),
      handler: () => NOT_JSON,
    });

    const report = await service.runQueue(ACCOUNT, RUN);

    // A page of a proxy is not a verdict on the match: it is counted once and tried again later.
    expect(report).toEqual({ ...NOTHING, retried: 1, stoppedBy: 'network' });
    await expect(storedDetail(repository, SERVED)).resolves.toEqual({
      status: 'retry',
      attempts: 1,
      nextAttemptAt: START + 5 * MINUTE,
      lastError: 'not_json',
      archivedBytes: null,
    });
    // The body is kept as it came, like the one of an invalid answer.
    await expect(readQuarantined(archive, compressor, matchOf(SERVED), START)).resolves.toBe(
      NOT_JSON.body,
    );
    // The run is stopped as a network failure: a warning, without a stack.
    const [stop] = stopLines(logger);
    expect(stop).toMatchObject({ level: 'warn', context: { stoppedBy: 'network' } });
    expect(stop?.context).not.toHaveProperty('stack');
    expect(runEnds(logger)).toEqual([
      {
        syncRunId: RUN,
        archived: 0,
        retried: 1,
        unavailable: 0,
        invalid: 0,
        refreshed: 0,
        quarantined: 1,
        stoppedBy: 'network',
      },
    ]);
  });

  it('stops the run after one counted failure when an answer is not JSON, and leaves the other matches untouched', async () => {
    const { handler, held, whenHeld } = holdRequests();
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    const { service, repository, http } = await setUp({ handler });

    const run = service.runQueue(ACCOUNT, RUN);
    await whenHeld(2);
    const unreadable = held[0] ?? expect.unreachable('two requests are held');
    const sibling = held[1] ?? expect.unreachable('two requests are held');
    // One download gets a page that is not JSON, while the other one is still waiting...
    unreadable.answer(NOT_JSON);
    await settle();
    // ... and gets a real answer after the run was stopped: it is archived, like any match in flight.
    sibling.answer(await answerLike(fixtures, sibling.request));
    const report = await run;

    expect(report).toEqual({ ...NOTHING, archived: 1, retried: 1, stoppedBy: 'network' });
    expect(http.requests).toHaveLength(2);
    // One match is retried, one is ready; every other due match was never requested.
    const statuses = await Promise.all(
      ELIGIBLE_ROWS.map(async (row) => (await storedDetail(repository, row)).status),
    );
    expect(statuses.filter((status) => status === 'retry')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'ready')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'pending')).toHaveLength(
      ELIGIBLE_ROWS.length - 2,
    );
  });

  it('starts no other match while the body of an answer that is not JSON is being kept', async () => {
    const { handler, held, whenHeld } = holdRequests();
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    let received = 0;
    const { service, compressor, http } = await setUp({
      // The first two requests wait for the test. A third one is answered at once, so that a match
      // started against the stop shows in the count of requests instead of hanging the run.
      handler: (request) => {
        received += 1;
        return received <= 2 ? handler(request) : fixtures(request);
      },
    });
    // The first compression is the one of the body to keep: it waits for the test, as the
    // compression of a large body in the worker takes a while.
    const compress = compressor.compress.bind(compressor);
    let keepingStarted: () => void = () => undefined;
    const keepingHasStarted = new Promise<void>((resolve) => {
      keepingStarted = resolve;
    });
    let finishKeeping: () => void = () => undefined;
    const keepingCanFinish = new Promise<void>((resolve) => {
      finishKeeping = resolve;
    });
    vi.spyOn(compressor, 'compress').mockImplementationOnce(async (bytes) => {
      keepingStarted();
      await keepingCanFinish;
      return compress(bytes);
    });

    const run = service.runQueue(ACCOUNT, RUN);
    await whenHeld(2);
    const unreadable = held[0] ?? expect.unreachable('two requests are held');
    const sibling = held[1] ?? expect.unreachable('two requests are held');
    unreadable.answer(NOT_JSON);
    await keepingHasStarted;
    // The other download ends while the body is still being kept, and looks for another match.
    sibling.answer(await answerLike(fixtures, sibling.request));
    await settle();
    // The run was stopped as soon as the page was seen: that match was not started.
    expect(http.requests).toHaveLength(2);
    finishKeeping();
    const report = await run;

    expect(report).toEqual({ ...NOTHING, archived: 1, retried: 1, stoppedBy: 'network' });
    expect(http.requests).toHaveLength(2);
  });

  it('marks invalid, and quarantines nothing, a body over 10 MB', async () => {
    const { service, repository, archive, logger } = await setUp({
      matches: summariesOf([SERVED]),
      handler: () => ({ status: 200, headers: {}, body: 'x'.repeat(MAX_RESPONSE_BYTES + 1) }),
    });

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, invalid: 1 });

    // The client stops reading at the limit, so there is no body to keep.
    await expect(storedDetail(repository, SERVED)).resolves.toMatchObject({
      status: 'invalid',
      attempts: 1,
      lastError: 'invalid_payload (body_too_large)',
    });
    expect(archive.files.size).toBe(0);
    expect(runEnds(logger)[0]).toMatchObject({ invalid: 1, quarantined: 0 });
  });

  it.each(['network', 'timeout'] as const)(
    'stops the run without counting an attempt on a %s failure',
    async (kind) => {
      const { service, repository, http, archive, logger } = await setUp({
        handler: () => {
          throw new AppError(kind, 'The server cannot be reached');
        },
      });

      const report = await service.runQueue(ACCOUNT, RUN);

      expect(report).toEqual({ ...NOTHING, stoppedBy: 'network' });
      // Every eligible match is still waiting for its first attempt.
      await expect(repository.summary(ACCOUNT, START)).resolves.toEqual({
        archived: 0,
        waiting: ELIGIBLE_ROWS.length,
        unavailable: 0,
        invalid: 0,
        evicted: 0,
      });
      await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
      await expect(storedDetail(repository, MISSING)).resolves.toEqual(UNTOUCHED);
      expect(archive.files.size).toBe(0);
      // Once the run is stopped, no puller takes another match: at most the two first requests.
      expect(http.requests.length).toBeGreaterThan(0);
      expect(http.requests.length).toBeLessThanOrEqual(2);
      // The network is down: a warning, without a stack (it would only say where the kind was set).
      const [stop] = stopLines(logger);
      expect(stop).toMatchObject({ level: 'warn', context: { stoppedBy: 'network' } });
      expect(stop?.context).not.toHaveProperty('stack');
    },
  );

  it.each([
    ['a plain error', () => new Error('The socket hung up')],
    ['an unexpected error', () => new AppError('unexpected', 'Something unexpected happened')],
    ['a refusal', () => new AppError('forbidden', 'The request was refused')],
    ['a server error', () => new AppError('service_unavailable', 'The server failed')],
    ['a missing match', () => new AppError('not_found', 'The match is not known')],
  ])(
    'stops the run without counting an attempt on %s that carries no HTTP status',
    async (_name, makeError) => {
      const { service, repository, http, archive } = await setUp({
        matches: summariesOf([SERVED]),
        handler: () => {
          throw makeError();
        },
      });

      // Only an answer of the server, with its status, can condemn a match.
      await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
        ...NOTHING,
        stoppedBy: 'network',
      });

      await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
      expect(http.requests).toHaveLength(1);
      expect(archive.files.size).toBe(0);
    },
  );

  it('keeps what the run did before a network failure', async () => {
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    let received = 0;
    const { service, repository, archive } = await setUp({
      matches: summariesOf(ELIGIBLE_ROWS.slice(0, 5)),
      handler: (request) => {
        received += 1;
        // The network goes away after the second request.
        if (received > 2) {
          throw new AppError('network', 'The server cannot be reached');
        }
        return fixtures(request);
      },
    });

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, archived: 2, stoppedBy: 'network' });
    expect(archive.files.size).toBe(2);
    // The three matches that met the failure were not counted as failed.
    await expect(repository.summary(ACCOUNT, START)).resolves.toEqual({
      archived: 2,
      waiting: 3,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
    });
  }, 30_000);

  it('stops the run on a pause and leaves the matches untouched', async () => {
    const { service, repository, syncState, http, archive, logger } = await setUp();
    await syncState.setPausedUntil(START + 10 * MINUTE);

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, stoppedBy: 'paused' });
    await expect(repository.summary(ACCOUNT, START)).resolves.toEqual({
      archived: 0,
      waiting: ELIGIBLE_ROWS.length,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
    });
    await expect(storedDetail(repository, MISSING)).resolves.toEqual(UNTOUCHED);
    // The pause is respected before any request is sent.
    expect(http.requests).toHaveLength(0);
    expect(archive.files.size).toBe(0);
    // A pause is routine: an `info` line, without a stack.
    const [stop] = stopLines(logger);
    expect(stop).toMatchObject({
      level: 'info',
      context: { stoppedBy: 'paused', pausedUntil: START + 10 * MINUTE },
    });
    expect(stop?.context).not.toHaveProperty('stack');
  });

  it('stops the run when an answer asks for a pause, and goes on once it is over', async () => {
    const { service, repository, syncState, answer, clock, http } = await setUp({
      matches: summariesOf([SERVED]),
      handler: () => jsonResponse({ status: 429 }, 429, { 'retry-after': '600' }),
    });

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'paused',
    });

    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
    await expect(syncState.getPausedUntil()).resolves.toBe(START + 600_000);
    // Once the pause is over the same match is downloaded, as if nothing happened.
    answer.handler = createFixtureApi({ now: START, matchCount: 30 });
    clock.now = START + 601_000;
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, archived: 1 });
    expect(http.requests).toHaveLength(2);
  });

  it('stops the run without counting an attempt when the archive cannot be written', async () => {
    const { service, repository, archive, logger } = await setUp({
      matches: summariesOf([SERVED]),
    });
    archive.failNextWrite(new Error('There is not enough space on the disk'));

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, stoppedBy: 'storage' });
    // A local failure is a warning with its cause and its stack, and the match it met.
    const [stop] = stopLines(logger);
    expect(stop).toMatchObject({
      level: 'warn',
      context: {
        kind: 'storage',
        stoppedBy: 'storage',
        matchId: matchOf(SERVED),
        cause: 'There is not enough space on the disk',
      },
    });
    expect(stop?.context).toHaveProperty('stack');
    // The match is not recorded as archived, nor as a failed attempt: it stays to do.
    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
    expect(archive.files.size).toBe(0);
    // The disk works again: the next run archives it.
    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      archived: 1,
    });
    await expect(storedDetail(repository, SERVED)).resolves.toMatchObject({ status: 'ready' });
  });

  it('records nothing for the matches it did not finish when the archive cannot be written', async () => {
    const { service, repository, archive } = await setUp();
    archive.failNextWrite(new Error('There is not enough space on the disk'));

    const report = await service.runQueue(ACCOUNT, RUN);

    // The other download in flight may have been archived; no other match was started.
    expect(report.stoppedBy).toBe('storage');
    expect(report.archived).toBeLessThanOrEqual(1);
    const summary = await repository.summary(ACCOUNT, START);
    expect(summary).toEqual({
      archived: report.archived,
      waiting: ELIGIBLE_ROWS.length - report.archived,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
    });
    expect(archive.files.size).toBe(report.archived);
  });

  it.each([
    ['a library error', new Error('The wasm module trapped')],
    ['an error of the worker', new AppError('storage', 'The compression worker failed')],
    // The worker reports a failure of the codec on the data: it is still not the match's fault.
    [
      'a codec error of the worker',
      new AppError('invalid_payload', 'The compressor could not read the data'),
    ],
  ])('stops the run without counting an attempt on %s of the compressor', async (_name, error) => {
    const { service, repository, archive, compressor } = await setUp({
      matches: summariesOf([SERVED]),
    });
    vi.spyOn(compressor, 'compress').mockRejectedValue(error);

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'storage',
    });

    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
    expect(archive.files.size).toBe(0);
  });

  it('stops the run, and does not blame the match, when the code itself fails', async () => {
    const { service, api, repository, archive } = await setUp({ matches: summariesOf([SERVED]) });
    // A detail the schema accepts (it keeps the keys it does not know) that JSON cannot encode.
    const json = { ...(createMatchMetadataFixture(SERVED, ACCOUNT) as object), unencodable: 1n };
    vi.spyOn(api, 'fetchMatchMetadata').mockResolvedValue({ kind: 'fetched', json, body: '{}' });

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'storage',
    });

    // A bug is not a verdict on the match: it is not marked, nothing is quarantined.
    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
    expect(archive.files.size).toBe(0);
  });

  it('fetches again a match whose archive was written but not recorded', async () => {
    const { service, repository, archive, http } = await setUp({ matches: summariesOf([SERVED]) });
    vi.spyOn(repository, 'markReady').mockRejectedValueOnce(
      new AppError('storage', 'Could not record an archived match'),
    );

    const first = await service.runQueue(ACCOUNT, RUN);

    // The file is there, but the database does not know: the match is still to do.
    expect(first).toEqual({ ...NOTHING, stoppedBy: 'storage' });
    expect(archive.files.has(archivePath(ACCOUNT, matchOf(SERVED)))).toBe(true);
    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);

    const second = await service.runQueue(ACCOUNT, 'run-0002');

    expect(second).toEqual({ ...NOTHING, archived: 1 });
    expect(http.requests).toHaveLength(2);
    const archived = archive.files.get(archivePath(ACCOUNT, matchOf(SERVED)));
    await expect(storedDetail(repository, SERVED)).resolves.toEqual({
      status: 'ready',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      archivedBytes: archived?.length ?? expect.unreachable('the archive exists'),
    });
  });

  it('stops the run when the outcome of a failed attempt cannot be saved', async () => {
    const { service, repository } = await setUp({ matches: summariesOf([MISSING]) });
    vi.spyOn(repository, 'saveState').mockRejectedValueOnce(
      new AppError('storage', 'Could not save the detail state of a match'),
    );

    // The failure is not counted in the report either: it was not recorded.
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'storage',
    });

    await expect(storedDetail(repository, MISSING)).resolves.toEqual(UNTOUCHED);
  });

  it('stops the run when the next match cannot be read', async () => {
    const { service, repository, http } = await setUp();
    vi.spyOn(repository, 'nextDue').mockRejectedValue(
      new AppError('storage', 'Could not read the next match to download'),
    );

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'storage',
    });

    expect(http.requests).toHaveLength(0);
  });

  it('keeps the verdict, then stops the run, when the response cannot be quarantined', async () => {
    const { service, repository, archive } = await setUp({
      matches: summariesOf([SERVED]),
      handler: answerWithAnotherMatch(),
    });
    vi.spyOn(archive, 'quarantine').mockRejectedValue(new Error('Access is denied'));

    const report = await service.runQueue(ACCOUNT, RUN);

    // The verdict is the important record: it is saved first and counted.
    expect(report).toEqual({ ...NOTHING, invalid: 1, stoppedBy: 'storage' });
    await expect(storedDetail(repository, SERVED)).resolves.toMatchObject({
      status: 'invalid',
      attempts: 1,
    });
  });

  it('removes leftover temporary files at the start of a run', async () => {
    const { service, archive, answer } = await setUp({ matches: summariesOf([SERVED]) });
    archive.addTemporaryFile(ACCOUNT, matchOf(OTHER_SERVED));
    archive.addTemporaryFile(testAccountId(42), matchOf(OTHER_SERVED));
    const fixtures = answer.handler;
    // What the folder held when the first request was sent.
    const seenAtFirstRequest: string[][] = [];
    answer.handler = (request) => {
      seenAtFirstRequest.push([...archive.files.keys()].filter(isTemporaryArchiveName));
      return fixtures(request);
    };

    await service.runQueue(ACCOUNT, RUN);

    // The leftover of the account was gone before anything was downloaded; the other account's stays.
    expect(seenAtFirstRequest).toEqual([
      [`archive/42/${String(OTHER_SERVED.match_id)}.json.zst.tmp`],
    ]);
    expect([...archive.files.keys()].filter(isTemporaryArchiveName)).toEqual([
      `archive/42/${String(OTHER_SERVED.match_id)}.json.zst.tmp`,
    ]);
  });

  it('carries on, with a warning, when the leftovers cannot be removed', async () => {
    const { service, repository, archive, logger } = await setUp({
      matches: summariesOf([SERVED]),
    });
    const removal = vi
      .spyOn(archive, 'removeTemporaryFiles')
      .mockRejectedValue(
        new Error(`Access is denied to archive/${String(ACCOUNT)}/108600000.json.zst.tmp`),
      );

    const report = await service.runQueue(ACCOUNT, RUN);

    // A leftover is harmless (the next write of its match replaces it): the run is not stopped, and
    // the due match is archived as usual.
    expect(removal).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ ...NOTHING, archived: 1 });
    expect(archive.files.has(archivePath(ACCOUNT, matchOf(SERVED)))).toBe(true);
    await expect(storedDetail(repository, SERVED)).resolves.toMatchObject({ status: 'ready' });
    expect(stopLines(logger)).toEqual([]);
    // One warning, with the cause (the account id replaced) and the stack of a failure of the disk.
    const warnings = linesAt(logger, 'warn');
    expect(warnings).toMatchObject([
      {
        scope: 'detail',
        message: 'Leftover temporary files could not be removed',
        context: {
          syncRunId: RUN,
          kind: 'storage',
          cause: 'Access is denied to archive/{account_id}/108600000.json.zst.tmp',
        },
      },
    ]);
    expect(warnings[0]?.context).toHaveProperty('stack');
    expect(JSON.stringify(logger.entries)).not.toContain(String(ACCOUNT));
  });

  it('keeps the quarantine to the 20 most recent responses', async () => {
    const count = QUARANTINE_LIMIT + 5;
    // Matches of the tracked account that are not in the synthetic history: any answer will do.
    const matches = Array.from({ length: count }, (_, index) =>
      matchSummary({
        accountId: ACCOUNT,
        matchId: 5_000 + index,
        startTime: START / 1000 - 3_600 * (index + 1),
      }),
    );
    // Every reading of the clock moves it, so that each response has its own time.
    const { service, archive, repository, logger } = await setUp({
      matches,
      // Valid JSON that is not a match detail: a final verdict for each match, and a small body.
      handler: () => jsonResponse({ not: 'a match detail' }),
      clockStepMs: 1_000,
    });
    const quarantine = vi.spyOn(archive, 'quarantine');

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, invalid: count });
    await expect(repository.summary(ACCOUNT, START)).resolves.toMatchObject({ invalid: count });
    // The 5 oldest responses were deleted, whatever the order the two downloads ended in.
    const latest = quarantine.mock.calls
      .slice(-QUARANTINE_LIMIT)
      .map(([accountId, matchId, at]) => quarantinePath(accountId, matchId, at))
      .sort();
    expect(quarantine).toHaveBeenCalledTimes(count);
    expect(quarantinedPaths(archive)).toEqual(latest);
    expect(quarantinedPaths(archive)).toHaveLength(QUARANTINE_LIMIT);
    // The run counted every response it kept, whatever the folder holds after the trimming.
    expect(runEnds(logger)[0]).toMatchObject({ invalid: count, quarantined: count });
  });

  it('tells its listeners after each match, even when one listener fails', async () => {
    const { service, logger } = await setUp({ matches: summariesOf([SERVED, MISSING]) });
    let told = 0;
    service.subscribe(() => {
      throw new Error('broken listener');
    });
    service.subscribe(() => {
      told += 1;
    });
    const unsubscribed = vi.fn();
    service.subscribe(unsubscribed)();

    const report = await service.runQueue(ACCOUNT, RUN);

    // The run went on, and the working listener heard of both matches.
    expect(report).toEqual({ ...NOTHING, archived: 1, retried: 1 });
    expect(told).toBe(2);
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(
      logger.entries.filter((entry) => entry.message === 'A listener of the detail queue failed'),
    ).toEqual([
      expect.objectContaining({ level: 'warn', scope: 'detail' }),
      expect.objectContaining({ level: 'warn', scope: 'detail' }),
    ]);
  });

  it('never downloads the same match twice, even with two downloads at a time', async () => {
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    let inFlight = 0;
    let peak = 0;
    const { service, http } = await setUp({
      // A slow API: the two downloads overlap for the whole run.
      handler: async (request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await settle();
        inFlight -= 1;
        return fixtures(request);
      },
    });

    const report = await service.runQueue(ACCOUNT, RUN);

    const requested = http.requests.map((request) => matchIdOfRequest(request));
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested).toHaveLength(ELIGIBLE_ROWS.length);
    expect(peak).toBe(2);
    expect(report).toEqual({
      ...NOTHING,
      archived: SERVED_ROWS.length,
      retried: MISSING_ROWS.length,
    });
  }, 60_000);

  it('finishes the match in flight, and starts no other, once the other download stops the run', async () => {
    const { handler, held, whenHeld } = holdRequests();
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    const { service, repository, http, archive } = await setUp({ handler });

    const run = service.runQueue(ACCOUNT, RUN);
    await whenHeld(2);
    const failing = held[0] ?? expect.unreachable('two requests are held');
    const finishing = held[1] ?? expect.unreachable('two requests are held');
    // The network fails for one download while the other one is still waiting for its answer.
    failing.fail(new AppError('network', 'The server cannot be reached'));
    await settle();
    finishing.answer(await answerLike(fixtures, finishing.request));
    const report = await run;

    // The match in flight was archived; the one that met the failure is still to do; nothing else started.
    expect(report).toEqual({ ...NOTHING, archived: 1, stoppedBy: 'network' });
    expect(http.requests).toHaveLength(2);
    const failedRow = ELIGIBLE_ROWS.find(
      (row) => matchOf(row) === matchIdOfRequest(failing.request),
    );
    await expect(
      storedDetail(repository, failedRow ?? expect.unreachable('an eligible match')),
    ).resolves.toEqual(UNTOUCHED);
    expect(archive.files.size).toBe(1);
  });

  it('takes no new match when the run was stopped while it was looking for one', async () => {
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    const { handler, held, whenHeld } = holdRequests();
    let received = 0;
    const { service, repository, http } = await setUp({
      // The first two requests wait for the test. A third one is answered at once, so that a match
      // taken against the stop shows in the report instead of hanging the run.
      handler: (request) => {
        received += 1;
        return received <= 2 ? handler(request) : fixtures(request);
      },
    });
    // The look-ups made once both downloads hold a match are the ones made after one of them
    // finished: they wait for the test, to be answered after the run was stopped.
    const nextDue = repository.nextDue.bind(repository);
    let lookupIsWaiting: () => void = () => undefined;
    const lookupHasStarted = new Promise<void>((resolve) => {
      lookupIsWaiting = resolve;
    });
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    vi.spyOn(repository, 'nextDue').mockImplementation(async (accountId, at, excluding) => {
      if (excluding.size >= 2) {
        lookupIsWaiting();
        await gate;
      }
      return nextDue(accountId, at, excluding);
    });

    const run = service.runQueue(ACCOUNT, RUN);
    await whenHeld(2);
    const finishing = held[0] ?? expect.unreachable('two requests are held');
    const failing = held[1] ?? expect.unreachable('two requests are held');
    // One download ends and looks for another match; the database is slow to answer...
    finishing.answer(await answerLike(fixtures, finishing.request));
    await lookupHasStarted;
    // ... and meanwhile the other download meets a network failure, which stops the run.
    failing.fail(new AppError('network', 'The server cannot be reached'));
    await settle();
    openGate();
    const report = await run;

    // The match the look-up found is not taken: it was offered after the stop.
    expect(report).toEqual({ ...NOTHING, archived: 1, stoppedBy: 'network' });
    expect(http.requests).toHaveLength(2);
    await expect(repository.summary(ACCOUNT, START)).resolves.toMatchObject({
      archived: 1,
      waiting: ELIGIBLE_ROWS.length - 1,
    });
  });

  it('reports the first reason when both downloads stop the run', async () => {
    const { handler, held, whenHeld } = holdRequests();
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    const { service, archive, logger } = await setUp({ handler });
    archive.failNextWrite(new Error('There is not enough space on the disk'));

    const run = service.runQueue(ACCOUNT, RUN);
    await whenHeld(2);
    const failing = held[0] ?? expect.unreachable('two requests are held');
    const finishing = held[1] ?? expect.unreachable('two requests are held');
    // The network fails first; then the other download ends, and its archive cannot be written.
    failing.fail(new AppError('network', 'The server cannot be reached'));
    await settle();
    finishing.answer(await answerLike(fixtures, finishing.request));
    const report = await run;

    expect(report).toEqual({ ...NOTHING, stoppedBy: 'network' });
    // Both reasons are in the log, in the order they happened.
    expect(
      logger.entries
        .filter((entry) => entry.message === 'Detail queue stopped')
        .map((entry) => entry.context.stoppedBy),
    ).toEqual(['network', 'storage']);
  });

  it('never writes a payload value in the logs', async () => {
    const { service, logger, archive, answer, clock, syncState } = await setUp();
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    // First run: the disk fails and its error quotes a path, which holds the tracked account id.
    archive.failNextWrite(
      new Error(`There is not enough space for archive/${String(ACCOUNT)}/108600000.json.zst.tmp`),
    );
    const first = await service.runQueue(ACCOUNT, 'run-0001');
    // Second run: an invalid detail, then a page that is not JSON, both holding the id of another
    // player. The page stops the run as a network failure.
    answer.handler = (request) => {
      const matchId = matchIdOfRequest(request);
      if (matchId === matchOf(OLDEST_SERVED)) {
        return { status: 200, headers: {}, body: `<html>Player ${FAKE_OTHER_PLAYER}</html>` };
      }
      if (matchId === matchOf(NEXT_OLDEST_SERVED)) {
        return jsonResponse(createMatchMetadataFixture(SERVED, ACCOUNT));
      }
      return fixtures(request);
    };
    const second = await service.runQueue(ACCOUNT, 'run-0002');
    // Third run: the page's match is due again, and deadlock-api asks to pause.
    clock.now = START + 6 * MINUTE;
    await syncState.setPausedUntil(clock.now + 10 * MINUTE);
    await service.runQueue(ACCOUNT, 'run-0003');

    // The end of each run is pinned, down to the counters and their order.
    expect(runEnds(logger)).toEqual([
      {
        syncRunId: 'run-0001',
        archived: first.archived,
        retried: 0,
        unavailable: 0,
        invalid: 0,
        refreshed: 0,
        quarantined: 0,
        stoppedBy: 'storage',
      },
      {
        syncRunId: 'run-0002',
        archived: second.archived,
        retried: second.retried,
        unavailable: 0,
        invalid: 1,
        refreshed: 0,
        quarantined: 2,
        stoppedBy: 'network',
      },
      {
        syncRunId: 'run-0003',
        archived: 0,
        retried: 0,
        unavailable: 0,
        invalid: 0,
        refreshed: 0,
        quarantined: 0,
        stoppedBy: 'paused',
      },
    ]);
    expect(Object.keys(runEnds(logger)[0] ?? {})).toEqual([
      'syncRunId',
      'archived',
      'retried',
      'unavailable',
      'invalid',
      'refreshed',
      'quarantined',
      'stoppedBy',
    ]);
    // The first stop of each run, with the level and the details of its kind: the local failure has
    // its cause (the account id replaced) and its stack; the page and the pause have no stack.
    const firstStop = (syncRunId: string) =>
      stopLines(logger).find((entry) => entry.context.syncRunId === syncRunId);
    expect(firstStop('run-0001')).toMatchObject({
      level: 'warn',
      context: {
        stoppedBy: 'storage',
        cause: expect.stringContaining('{account_id}') as unknown,
      },
    });
    expect(firstStop('run-0001')?.context).toHaveProperty('stack');
    expect(firstStop('run-0002')).toMatchObject({
      level: 'warn',
      context: { stoppedBy: 'network' },
    });
    expect(firstStop('run-0002')?.context).not.toHaveProperty('stack');
    expect(firstStop('run-0003')).toMatchObject({
      level: 'info',
      context: { stoppedBy: 'paused' },
    });
    expect(firstStop('run-0003')?.context).not.toHaveProperty('stack');
    // The verdicts of the second run went through the log too, as codes: the final one as a warning,
    // the retry of the page as a debug line.
    const attempts = logger.entries
      .filter((entry) => entry.message === 'Detail attempt failed')
      .map((entry) => [entry.level, entry.context.lastError]);
    expect(attempts).toContainEqual(['warn', 'invalid_payload (match_id)']);
    expect(attempts).toContainEqual(['debug', 'not_json']);
    // Neither the other players' account ids, nor the tracked one, nor a body is in any line.
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(FAKE_OTHER_PLAYER);
    expect(logged).not.toContain(String(ACCOUNT));
    expect(logged).not.toContain('<html>');
  }, 60_000);

  it('finishes the queue after a restart in the middle', async () => {
    const before = await setUp();
    // The app writes every archive once: the failed write does not count, the others are listed.
    const written: MatchId[] = [];
    const write = before.archive.write.bind(before.archive);
    vi.spyOn(before.archive, 'write').mockImplementation(async (accountId, matchId, bytes) => {
      await write(accountId, matchId, bytes);
      written.push(matchId);
    });
    before.archive.failNextWrite(new Error('There is not enough space on the disk'));

    const interrupted = await before.service.runQueue(ACCOUNT, 'run-0001');

    // The run stopped partway: some matches are archived, most are still to do.
    expect(interrupted.stoppedBy).toBe('storage');
    expect(interrupted.archived).toBeLessThan(SERVED_ROWS.length);
    // The app restarts: new services on the same database and the same archive folder.
    const after = await setUp({ database: before.database, archive: before.archive });

    const resumed = await after.service.runQueue(ACCOUNT, 'run-0002');

    expect(resumed).toEqual({
      ...NOTHING,
      archived: SERVED_ROWS.length - interrupted.archived,
      retried: MISSING_ROWS.length,
    });
    // Every match the API has is archived exactly once, with no file missing and none too many.
    expect([...written].sort()).toEqual(SERVED_ROWS.map((row) => matchOf(row)).sort());
    expect([...after.archive.files.keys()].sort()).toEqual(
      SERVED_ROWS.map((row) => archivePath(ACCOUNT, matchOf(row))).sort(),
    );
    for (const row of SERVED_ROWS) {
      await expect(storedDetail(after.repository, row)).resolves.toMatchObject({ status: 'ready' });
    }
    await expect(after.repository.summary(ACCOUNT, START)).resolves.toEqual({
      archived: SERVED_ROWS.length,
      waiting: MISSING_ROWS.length,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
    });
  }, 60_000);
});

/**
 * What the archive file of a format-1 match holds in these tests. The refresh never reads the old
 * file, it only replaces it, so any bytes do; these ones show whether it was replaced.
 */
const OLD_ARCHIVE = new Uint8Array([1, 2, 3, 4, 5]);

/** The projection the analysis stored for a match, before its archive is refreshed. */
const PROJECTED: ProjectionRecord = {
  version: PROJECTION_VERSION,
  playerBadge: null,
  hasLeaver: false,
  failed: false,
  projectedAt: START,
};

/**
 * Leave a format-1 archive for a match, as a version of the app that kept only the tracked player's
 * path did: a file, a `ready` match, and no format in the database (it was not recorded then).
 *
 * @param context - What {@link setUp} built; the match must be stored.
 * @param row - The row of the match.
 */
async function plantFormatOneArchive(context: TestContext, row: RawMatchHistoryRow): Promise<void> {
  await plantArchive(context, row, OLD_ARCHIVE);
  await context.database.execute(
    'UPDATE matches SET archive_format = NULL WHERE account_id = $1 AND match_id = $2',
    [ACCOUNT, matchOf(row)],
  );
}

/**
 * The lines that report a failed refresh, oldest first.
 *
 * @param logger - The logger the queue wrote to.
 * @returns The log entries `Match archive refresh failed`.
 */
function refreshFailures(logger: MemoryLogger): LogEntry[] {
  return logger.entries.filter((entry) => entry.message === 'Match archive refresh failed');
}

/**
 * The archive file of a match, as it is in the archive store.
 *
 * @param archive - The archive store.
 * @param row - The row of the match.
 * @returns Its bytes, or `undefined` when there is no file.
 */
function archiveFileOf(
  archive: MemoryArchiveStore,
  row: RawMatchHistoryRow,
): Uint8Array | undefined {
  return archive.files.get(archivePath(ACCOUNT, matchOf(row)));
}

describe('MatchDetailService.runQueue, refresh of the format-1 archives', () => {
  it('downloads again a ready match of format 1 within 90 days and forgets its projection', async () => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    const { service, repository, metrics, archive, compressor, http, logger } = context;
    await plantFormatOneArchive(context, SERVED);
    await metrics.saveProjection(ACCOUNT, matchOf(SERVED), PROJECTED, new Map([['kda', 2]]));
    const listener = vi.fn();
    service.subscribe(listener);

    const report = await service.runQueue(ACCOUNT, RUN);

    expect(report).toEqual({ ...NOTHING, refreshed: 1 });
    expect(http.requests.map((request) => matchIdOfRequest(request))).toEqual([matchOf(SERVED)]);
    // The file is replaced in place by an archive of the current format, with all twelve paths.
    const bytes = archiveFileOf(archive, SERVED) ?? expect.unreachable('the archive exists');
    const envelope = decodeArchiveEnvelope(await compressor.decompress(bytes));
    expect(envelope.archiveFormat).toBe(ARCHIVE_FORMAT);
    expect(envelope.payload.match_info.match_paths?.paths).toHaveLength(12);
    // The match stays archived all along; only its size and its format change.
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'ready',
      attempts: 0,
      archivedBytes: bytes.length,
      archiveFormat: ARCHIVE_FORMAT,
    });
    // The projection made from the old file is forgotten: the catch-up of the same sync makes it again.
    await expect(metrics.getProjection(ACCOUNT, matchOf(SERVED))).resolves.toBeNull();
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([
      matchOf(SERVED),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runEnds(logger)[0]).toMatchObject({ archived: 0, refreshed: 1, stoppedBy: null });
    // Once refreshed, a match is never downloaded again.
    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual(NOTHING);
    expect(http.requests).toHaveLength(1);
  });

  it('refreshes only after the due matches', async () => {
    const { handler, held, whenHeld } = holdRequests();
    const fixtures = createFixtureApi({ now: START, matchCount: 30 });
    let received = 0;
    const context = await setUp({
      matches: summariesOf([SERVED, OTHER_SERVED]),
      // The first request waits for the test; the others are answered at once.
      handler: (request) => {
        received += 1;
        return received === 1 ? handler(request) : fixtures(request);
      },
    });
    // The match to refresh is the most recent one, so the order cannot come from the start times.
    await plantFormatOneArchive(context, SERVED);

    const run = context.service.runQueue(ACCOUNT, RUN);
    await whenHeld(1);
    await settle();
    // The due match is downloading. The other puller has nothing due, and still does not refresh.
    expect(context.http.requests.map((request) => matchIdOfRequest(request))).toEqual([
      matchOf(OTHER_SERVED),
    ]);
    const due = held[0] ?? expect.unreachable('a request is held');
    due.answer(await answerLike(fixtures, due.request));

    await expect(run).resolves.toEqual({ ...NOTHING, archived: 1, refreshed: 1 });
    expect(context.http.requests.map((request) => matchIdOfRequest(request))).toEqual([
      matchOf(OTHER_SERVED),
      matchOf(SERVED),
    ]);
  });

  it('does not refresh once the due matches stopped the run', async () => {
    const context = await setUp({
      matches: summariesOf([SERVED, OTHER_SERVED]),
      handler: () => {
        throw new AppError('network', 'The server cannot be reached');
      },
    });
    await plantFormatOneArchive(context, SERVED);

    await expect(context.service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'network',
    });

    // Only the due match was tried: the refresh waits for a run that goes through them.
    expect(context.http.requests.map((request) => matchIdOfRequest(request))).toEqual([
      matchOf(OTHER_SERVED),
    ]);
    expect(archiveFileOf(context.archive, SERVED)).toEqual(OLD_ARCHIVE);
  });

  it.each([
    {
      label: 'the API fails',
      handler: (): HttpResponse => jsonResponse({ error: 'no' }, 500),
      kind: 'service_unavailable (500)',
      stoppedBy: null,
    },
    {
      label: 'the answer has no body',
      handler: (): HttpResponse => ({ status: 204, headers: {}, body: '' }),
      kind: 'empty_body',
      stoppedBy: null,
    },
    {
      // A page of a proxy would be the same for every match: the run stops, as for a download.
      label: 'the answer is not JSON',
      handler: (): HttpResponse => NOT_JSON,
      kind: 'not_json',
      stoppedBy: 'network',
    },
  ] as const)(
    'keeps a match ready with its old archive when the refresh fails: $label',
    async ({ handler, kind, stoppedBy }) => {
      const context = await setUp({ matches: summariesOf([SERVED]), handler });
      const { service, repository, metrics, archive, logger } = context;
      await plantFormatOneArchive(context, SERVED);
      await metrics.saveProjection(ACCOUNT, matchOf(SERVED), PROJECTED, new Map([['kda', 2]]));
      const saveState = vi.spyOn(repository, 'saveState');

      const report = await service.runQueue(ACCOUNT, RUN);

      expect(report).toEqual({ ...NOTHING, stoppedBy });
      // Nothing is lost: the old file, the ready match and its projection are all still there.
      expect(archiveFileOf(archive, SERVED)).toEqual(OLD_ARCHIVE);
      await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
        status: 'ready',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        archivedBytes: OLD_ARCHIVE.length,
        archiveFormat: null,
      });
      await expect(metrics.getProjection(ACCOUNT, matchOf(SERVED))).resolves.toEqual(
        expect.objectContaining({ version: PROJECTION_VERSION }),
      );
      // No attempt is counted for a refresh, and the banner still counts the match as archived.
      expect(saveState).not.toHaveBeenCalled();
      await expect(repository.summary(ACCOUNT, START)).resolves.toEqual({
        archived: 1,
        waiting: 0,
        unavailable: 0,
        invalid: 0,
        evicted: 0,
      });
      // One line, with the match and the code of the failure only.
      expect(refreshFailures(logger)).toEqual([
        {
          level: 'info',
          scope: 'detail',
          message: 'Match archive refresh failed',
          context: { syncRunId: RUN, matchId: matchOf(SERVED), kind },
        },
      ]);
      expect(logger.entries.filter((entry) => entry.message === 'Detail attempt failed')).toEqual(
        [],
      );
    },
  );

  it('keeps the old archive when the new one cannot be written', async () => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    const { service, repository, archive, logger } = context;
    await plantFormatOneArchive(context, SERVED);
    archive.failNextWrite(new Error('There is not enough space on the disk'));

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'storage',
    });

    // A local failure says nothing about the match: the run stops and the match is left as it was.
    expect(archiveFileOf(archive, SERVED)).toEqual(OLD_ARCHIVE);
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'ready',
      archivedBytes: OLD_ARCHIVE.length,
      archiveFormat: null,
    });
    expect(refreshFailures(logger)).toEqual([]);
    expect(stopLines(logger)[0]).toMatchObject({
      context: { stoppedBy: 'storage', matchId: matchOf(SERVED) },
    });
  });

  it.each([
    {
      label: 'the projection cannot be forgotten',
      fail: (context: TestContext) =>
        vi
          .spyOn(context.projection, 'forgetProjection')
          .mockRejectedValueOnce(
            new AppError('storage', 'Could not forget the projection of a match'),
          ),
      // The forgetting failed: the projection of the old file is still there, for now.
      projectionKept: true,
    },
    {
      label: 'the refreshed match cannot be recorded',
      fail: (context: TestContext) =>
        vi
          .spyOn(context.repository, 'markReady')
          .mockRejectedValueOnce(new AppError('storage', 'Could not record an archived match')),
      projectionKept: false,
    },
  ])('refreshes the match again at the next run when $label', async ({ fail, projectionKept }) => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    const { service, repository, metrics, archive, compressor, http } = context;
    await plantFormatOneArchive(context, SERVED);
    await metrics.saveProjection(ACCOUNT, matchOf(SERVED), PROJECTED, new Map([['kda', 2]]));
    fail(context);

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'storage',
    });

    // The new file is in place, but the database still records no format: the match is still
    // to refresh, and stays ready with the size of the old file until it is recorded.
    const written = archiveFileOf(archive, SERVED) ?? expect.unreachable('the archive exists');
    expect(decodeArchiveEnvelope(await compressor.decompress(written)).archiveFormat).toBe(
      ARCHIVE_FORMAT,
    );
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'ready',
      archivedBytes: OLD_ARCHIVE.length,
      archiveFormat: null,
    });
    const kept = await metrics.getProjection(ACCOUNT, matchOf(SERVED));
    expect(kept !== null).toBe(projectionKept);

    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      refreshed: 1,
    });

    expect(http.requests).toHaveLength(2);
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'ready',
      archiveFormat: ARCHIVE_FORMAT,
    });
    await expect(metrics.getProjection(ACCOUNT, matchOf(SERVED))).resolves.toBeNull();
  });

  it('forgets the projection that the analysis made from the old archive during the refresh', async () => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    const { service, repository, projection, metrics, reader, archive, database } = context;
    // An archive the analysis can read, of which the database records no format, as a format-1
    // archive: its content does not matter here, only the order of the reads and the writes.
    await service.runQueue(ACCOUNT, RUN);
    await database.execute(
      'UPDATE matches SET archive_format = NULL WHERE account_id = $1 AND match_id = $2',
      [ACCOUNT, matchOf(SERVED)],
    );
    // The page of the match asks for its analysis: the projection reads the old file, then waits.
    let oldFileRead = (): void => undefined;
    const oldFileWasRead = new Promise<void>((resolve) => {
      oldFileRead = resolve;
    });
    let finishProjection = (): void => undefined;
    const projectionMayFinish = new Promise<void>((resolve) => {
      finishProjection = resolve;
    });
    const read = reader.readArchive.bind(reader);
    vi.spyOn(reader, 'readArchive').mockImplementationOnce(async (accountId, matchId) => {
      const result = await read(accountId, matchId);
      oldFileRead();
      await projectionMayFinish;
      return result;
    });
    let newFileWritten = (): void => undefined;
    const newFileWasWritten = new Promise<void>((resolve) => {
      newFileWritten = resolve;
    });
    const write = archive.write.bind(archive);
    vi.spyOn(archive, 'write').mockImplementation(async (...args) => {
      await write(...args);
      newFileWritten();
    });
    const forget = vi.spyOn(metrics, 'forgetProjection');

    const projecting = projection.projectMatch(ACCOUNT, matchOf(SERVED));
    await oldFileWasRead;
    const refreshing = service.runQueue(ACCOUNT, 'run-0002');
    await newFileWasWritten;
    await settle();

    // The new file is written, and the forgetting waits for the projection of the old one.
    expect(forget).not.toHaveBeenCalled();
    finishProjection();
    await expect(projecting).resolves.toMatchObject({ projected: 1 });
    await expect(refreshing).resolves.toEqual({ ...NOTHING, refreshed: 1 });

    // What was made from the old file was saved, then forgotten: the catch-up makes it again.
    expect(forget).toHaveBeenCalledTimes(1);
    await expect(metrics.getProjection(ACCOUNT, matchOf(SERVED))).resolves.toBeNull();
    await expect(metrics.listToProject(ACCOUNT, PROJECTION_VERSION)).resolves.toEqual([
      matchOf(SERVED),
    ]);
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'ready',
      archiveFormat: ARCHIVE_FORMAT,
    });
  });

  it.each([
    {
      label: 'the API does not have the match any more',
      handler: (): HttpResponse => jsonResponse({ error: 'not found' }, 404),
      kind: 'not_found (404)',
    },
    {
      label: 'the answer is the detail of another match',
      handler: answerWithAnotherMatch(),
      kind: 'invalid_payload (match_id)',
    },
    {
      label: 'the facts of the answer cannot be read',
      handler: (): HttpResponse => jsonResponse(metadataWithoutNetWorth(SERVED)),
      kind: 'invalid_payload (tracked_player.net_worth: invalid_type)',
    },
  ])(
    'marks a refresh that failed for good and never tries it again: $label',
    async ({ handler, kind }) => {
      const context = await setUp({ matches: summariesOf([SERVED]), handler });
      const { service, repository, metrics, archive, http, clock, logger } = context;
      await plantFormatOneArchive(context, SERVED);
      await metrics.saveProjection(ACCOUNT, matchOf(SERVED), PROJECTED, new Map([['kda', 2]]));

      await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual(NOTHING);

      // The match keeps its format-1 archive, now marked as such for good.
      expect(archiveFileOf(archive, SERVED)).toEqual(OLD_ARCHIVE);
      await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
        status: 'ready',
        attempts: 0,
        lastError: null,
        archivedBytes: OLD_ARCHIVE.length,
        archiveFormat: 1,
      });
      await expect(metrics.getProjection(ACCOUNT, matchOf(SERVED))).resolves.not.toBeNull();
      expect(refreshFailures(logger)).toEqual([
        {
          level: 'info',
          scope: 'detail',
          message: 'Match archive refresh failed',
          context: { syncRunId: RUN, matchId: matchOf(SERVED), kind },
        },
      ]);
      // A refresh keeps nothing in the quarantine: the match already has a usable archive.
      expect(quarantinedPaths(archive)).toEqual([]);
      // It is never asked again, the next run or a day later.
      await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual(NOTHING);
      clock.now += DAY;
      await expect(service.runQueue(ACCOUNT, 'run-0003')).resolves.toEqual(NOTHING);
      expect(http.requests).toHaveLength(1);
    },
  );

  it('tries a retryable refresh again at the next run', async () => {
    const context = await setUp({
      matches: summariesOf([SERVED]),
      handler: () => jsonResponse({ error: 'no' }, 500),
    });
    const { service, repository, answer, http } = context;
    await plantFormatOneArchive(context, SERVED);
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual(NOTHING);

    // No retry date either: the next run, whenever it comes, tries again.
    answer.handler = createFixtureApi({ now: START, matchCount: 30 });
    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      refreshed: 1,
    });

    expect(http.requests).toHaveLength(2);
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'ready',
      archiveFormat: ARCHIVE_FORMAT,
    });
  });

  it('stops refreshing on a pause', async () => {
    const context = await setUp({
      matches: summariesOf([SERVED, OTHER_SERVED]),
      handler: () => jsonResponse({ status: 429 }, 429, { 'retry-after': '600' }),
    });
    const { service, repository, archive, answer, clock, http, logger } = context;
    await plantFormatOneArchive(context, SERVED);
    await plantFormatOneArchive(context, OTHER_SERVED);

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({
      ...NOTHING,
      stoppedBy: 'paused',
    });

    // Both matches are left as they were: a pause is no failure of a refresh.
    for (const row of [SERVED, OTHER_SERVED]) {
      expect(archiveFileOf(archive, row)).toEqual(OLD_ARCHIVE);
      await expect(repository.getDetail(ACCOUNT, matchOf(row))).resolves.toMatchObject({
        status: 'ready',
        archiveFormat: null,
      });
    }
    // At most the two requests already on their way when the pause came.
    expect(http.requests.length).toBeGreaterThan(0);
    expect(http.requests.length).toBeLessThanOrEqual(2);
    expect(refreshFailures(logger)).toEqual([]);
    expect(stopLines(logger)[0]).toMatchObject({
      level: 'info',
      context: { stoppedBy: 'paused' },
    });
    // Once the pause is over, both are refreshed.
    answer.handler = createFixtureApi({ now: START, matchCount: 30 });
    clock.now = START + 601_000;
    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      refreshed: 2,
    });
  });

  it('never refreshes a match older than 90 days', async () => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    const { service, repository, archive, clock, http } = context;
    await plantFormatOneArchive(context, SERVED);
    // The first instant past the window.
    clock.now = SERVED.start_time * 1000 + DETAIL_WINDOW_MS + 1;

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual(NOTHING);

    expect(http.requests).toHaveLength(0);
    expect(archiveFileOf(archive, SERVED)).toEqual(OLD_ARCHIVE);
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'ready',
      archiveFormat: null,
    });
    // At the very last instant inside the window, it was still refreshed.
    clock.now = SERVED.start_time * 1000 + DETAIL_WINDOW_MS;
    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      refreshed: 1,
    });
  });
});

/**
 * The lines the service wrote at a level.
 *
 * @param logger - The logger the service wrote to.
 * @param level - The level to keep.
 * @returns The lines of that level, oldest first.
 */
function linesAt(logger: MemoryLogger, level: LogEntry['level']): LogEntry[] {
  return logger.entries.filter((entry) => entry.level === level);
}

describe('MatchDetailService.getSummary', () => {
  it('summarises the Paige matches of the linked account', async () => {
    const otherAccount = testAccountId(42);
    const { service, repository, clock } = await setUp({
      matches: [
        eligibleMatch(1),
        eligibleMatch(2),
        eligibleMatch(3),
        eligibleMatch(4),
        eligibleMatch(5),
        eligibleMatch(6),
        // Counted by nobody, whatever their status: Street Brawl, another hero, another player.
        eligibleMatch(7, { gameMode: 4 }),
        eligibleMatch(8, { heroId: PAIGE_HERO_ID + 1 }),
        eligibleMatch(9, { accountId: otherAccount }),
      ],
    });
    // 1 is pending, 2 waits for a retry, 3 and 4 are archived, 5 is given up, 6 is unusable.
    await repository.saveState(ACCOUNT, testMatchId(2), retrying(START + MINUTE));
    await repository.markReady(ACCOUNT, testMatchId(3), 100, ARCHIVE_FORMAT);
    await repository.markReady(ACCOUNT, testMatchId(4), 100, ARCHIVE_FORMAT);
    await repository.saveState(ACCOUNT, testMatchId(5), UNAVAILABLE);
    await repository.saveState(ACCOUNT, testMatchId(6), INVALID);
    await repository.markReady(ACCOUNT, testMatchId(7), 100, ARCHIVE_FORMAT);
    await repository.markReady(ACCOUNT, testMatchId(8), 100, ARCHIVE_FORMAT);
    await repository.markReady(otherAccount, testMatchId(9), 100, ARCHIVE_FORMAT);

    await expect(service.getSummary()).resolves.toEqual({
      archived: 2,
      waiting: 2,
      unavailable: 1,
      invalid: 1,
      evicted: 0,
      lastStop: null,
    });

    // The window is read from the clock of the service: 91 days later, no match is in it any more.
    // The archives are still on disk and still shown, so the two archived matches still count.
    clock.now = START + 91 * DAY;
    await expect(service.getSummary()).resolves.toEqual({
      archived: 2,
      waiting: 0,
      unavailable: 0,
      invalid: 0,
      evicted: 0,
      lastStop: null,
    });
  });

  it('tells why the last run of the queue stopped, until a run goes through', async () => {
    const { service, archive } = await setUp({ matches: summariesOf([SERVED]) });
    // No run has finished yet: there is nothing to say.
    await expect(service.getSummary()).resolves.toMatchObject({ lastStop: null });

    // A run that stops on a local failure.
    archive.failNextWrite(new Error('There is not enough space on the disk'));
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toMatchObject({ stoppedBy: 'storage' });
    await expect(service.getSummary()).resolves.toMatchObject({ waiting: 1, lastStop: 'storage' });

    // A run of another account says nothing about this one.
    await service.runQueue(testAccountId(42), 'run-0002');
    await expect(service.getSummary()).resolves.toMatchObject({ lastStop: 'storage' });

    // The next run of this account goes through: the stop is forgotten.
    await expect(service.runQueue(ACCOUNT, 'run-0003')).resolves.toMatchObject({ stoppedBy: null });
    await expect(service.getSummary()).resolves.toMatchObject({ archived: 1, lastStop: null });
  });

  it('forgets why the last run of an account stopped', async () => {
    const { service, archive } = await setUp({ matches: summariesOf([SERVED]) });
    archive.failNextWrite(new Error('There is not enough space on the disk'));
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toMatchObject({ stoppedBy: 'storage' });
    await expect(service.getSummary()).resolves.toMatchObject({ lastStop: 'storage' });

    // Forgetting another account changes nothing for this one.
    service.forgetAccount(testAccountId(42));
    await expect(service.getSummary()).resolves.toMatchObject({ lastStop: 'storage' });

    // Once the data of the account is deleted, what stopped its last run is not its to tell.
    service.forgetAccount(ACCOUNT);
    await expect(service.getSummary()).resolves.toMatchObject({ lastStop: null });
  });

  it.each([
    ['a pause', 'paused'],
    ['a network failure', 'network'],
  ] as const)('tells that the last run stopped on %s', async (_name, stop) => {
    const { service, answer } = await setUp({ matches: summariesOf([SERVED]) });
    answer.handler = () => {
      if (stop === 'network') {
        throw new AppError('network', 'The server cannot be reached');
      }
      return jsonResponse({ status: 429 }, 429, { 'retry-after': '600' });
    };

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toMatchObject({ stoppedBy: stop });

    await expect(service.getSummary()).resolves.toMatchObject({ lastStop: stop });
  });

  it('returns null without an account', async () => {
    const { service } = await setUp({ matches: [eligibleMatch(1)], accountId: null });

    await expect(service.getSummary()).resolves.toBeNull();
  });
});

/** An archive recorded as ready that cannot be read back, and how the reading fails on it. */
interface UnreadableArchive {
  /** What is wrong with the archive. */
  readonly label: string;
  /** The step of the reading that fails. */
  readonly step: string;
  /** What the warning holds about the failure: codes, never a value of the file. */
  readonly expectedInLog: Readonly<Record<string, string>>;
  /** Leaves the match recorded as ready with that archive. */
  readonly plant: (context: TestContext) => Promise<void>;
}

/**
 * The ways an archive can be unreadable, that is, damaged: one for each step of the reading that
 * can find a problem in the data. A failure of the disk or of the compressor is not one of them:
 * it says nothing about the archive (see the tests of `getMatchDetail`).
 *
 * The first three are found by the archive reader, whose own tests (`archive-reader.service.test.ts`)
 * check what it answers and logs for each; here they show that the page treats each as a missing
 * archive, through the real reader. The last is found by the page itself.
 */
const UNREADABLE_ARCHIVES: readonly UnreadableArchive[] = [
  {
    label: 'a file that is not a zstd frame',
    step: 'decompress',
    expectedInLog: { kind: 'storage' },
    plant: (context) => plantArchive(context, SERVED, Uint8Array.of(1, 2, 3, 4)),
  },
  {
    label: 'a frame the compressor rejects as invalid data',
    step: 'decompress',
    expectedInLog: { kind: 'invalid_payload', cause: 'Unknown frame descriptor' },
    plant: async (context) => {
      await plantArchive(context, SERVED, Uint8Array.of(1));
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
        SERVED,
        await context.compressor.compress(new TextEncoder().encode('not json')),
      ),
  },
  {
    label: 'an archive whose facts cannot be read',
    step: 'summarize',
    expectedInLog: { kind: 'invalid_payload', issue: 'tracked_player.net_worth: invalid_type' },
    plant: async (context) =>
      plantArchive(
        context,
        SERVED,
        await context.compressor.compress(encodeArchiveEnvelope(envelopeWithoutNetWorth(SERVED))),
      ),
  },
];

describe('MatchDetailService.getMatchDetail', () => {
  it('shows the facts of an archived match', async () => {
    const { service, archive, compressor, logger } = await setUp({
      matches: summariesOf([SERVED]),
    });
    await service.runQueue(ACCOUNT, RUN);
    const bytes =
      archive.files.get(archivePath(ACCOUNT, matchOf(SERVED))) ??
      expect.unreachable('the archive exists');

    const view = await service.getMatchDetail(matchOf(SERVED));

    // The facts are those of the archive, with its size as the database recorded it...
    const envelope = decodeArchiveEnvelope(await compressor.decompress(bytes));
    expect(view).toEqual({
      kind: 'ready',
      facts: summarizeArchive(envelope),
      archivedBytes: bytes.length,
    });
    // ...and the archive was fetched by the run.
    expect(view).toMatchObject({ facts: { fetchedAt: START } });
    // Reading an archive is routine: it adds no line to the log (only the end of the run is there).
    expect(linesAt(logger, 'warn')).toEqual([]);
    expect(linesAt(logger, 'info')).toHaveLength(1);
  });

  it('puts a match whose archive is missing back to pending', async () => {
    const { service, repository, archive, logger } = await setUp({
      matches: summariesOf([SERVED]),
    });
    // The database says the detail is archived, but the folder holds no file for it.
    await repository.markReady(ACCOUNT, matchOf(SERVED), 52_431, ARCHIVE_FORMAT);

    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({ kind: 'missing' });

    // The match is to do again, as if it had never been tried: the next run downloads it.
    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
    expect(archive.files.size).toBe(0);
    // A file that is gone is not a failure of the app (the folder may have been emptied): `info`.
    expect(linesAt(logger, 'warn')).toEqual([]);
    expect(linesAt(logger, 'info')).toEqual([
      {
        level: 'info',
        scope: 'detail',
        message: 'Detail archive is missing',
        context: { matchId: matchOf(SERVED) },
      },
    ]);
  });

  it('downloads again, then shows, a match whose archive was missing', async () => {
    const { service, repository, http } = await setUp({ matches: summariesOf([SERVED]) });
    await repository.markReady(ACCOUNT, matchOf(SERVED), 52_431, ARCHIVE_FORMAT);
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({ kind: 'missing' });

    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, archived: 1 });

    expect(http.requests).toHaveLength(1);
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toMatchObject({
      kind: 'ready',
    });
  });

  it('treats an unreadable archive like a missing one', async () => {
    for (const { label, step, expectedInLog, plant } of UNREADABLE_ARCHIVES) {
      const context = await setUp({ matches: summariesOf([SERVED]) });
      await plant(context);

      const view = await context.service.getMatchDetail(matchOf(SERVED));

      expect(view, label).toEqual({ kind: 'missing' });
      await expect(storedDetail(context.repository, SERVED), label).resolves.toEqual(UNTOUCHED);
      // The file is not deleted: the next archive written replaces it.
      expect(context.archive.files.has(archivePath(ACCOUNT, matchOf(SERVED))), label).toBe(true);
      // One warning, with the step that failed and the codes of the failure.
      expect(linesAt(context.logger, 'warn'), label).toMatchObject([
        {
          scope: 'detail',
          message: 'Detail archive is unreadable',
          context: { matchId: matchOf(SERVED), step, ...expectedInLog },
        },
      ]);
      // Neither a value of the file (the ids of the other players) nor an account id is logged.
      const logged = JSON.stringify(context.logger.entries);
      expect(logged, label).not.toContain(FAKE_OTHER_PLAYER);
      expect(logged, label).not.toContain(String(ACCOUNT));
    }
  });

  it('treats a ready match without an archive size like an unreadable archive', async () => {
    const { service, repository, archive, database, logger } = await setUp({
      matches: summariesOf([SERVED]),
    });
    await service.runQueue(ACCOUNT, RUN);
    // A damaged row: no archive is recorded as ready without its size.
    await database.execute('UPDATE matches SET archived_bytes = NULL');
    const read = vi.spyOn(archive, 'read');

    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({ kind: 'missing' });

    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
    // The row is refused before the file is opened.
    expect(read).not.toHaveBeenCalled();
    expect(linesAt(logger, 'warn')).toMatchObject([
      {
        message: 'Detail archive is unreadable',
        context: { matchId: matchOf(SERVED), step: 'record', issue: 'archived_bytes_missing' },
      },
    ]);
  });

  it('says the archive is lost, not missing, once the match is past the 90 days', async () => {
    /** The ways the archive of a ready match can be unusable: the damaged files, and the others. */
    const unusable: readonly Pick<UnreadableArchive, 'label' | 'plant'>[] = [
      ...UNREADABLE_ARCHIVES,
      {
        label: 'a file that is gone',
        plant: (context) =>
          context.repository.markReady(ACCOUNT, matchOf(SERVED), 52_431, ARCHIVE_FORMAT),
      },
      {
        label: 'a ready match without an archive size',
        plant: async (context) => {
          await plantArchive(context, SERVED, Uint8Array.of(1));
          await context.database.execute('UPDATE matches SET archived_bytes = NULL');
        },
      },
    ];
    for (const { label, plant } of unusable) {
      const context = await setUp({ matches: summariesOf([SERVED]) });
      await plant(context);
      // The match aged past the window while its archive was unusable: it is not downloaded again.
      context.clock.now = START + 91 * DAY;

      const view = await context.service.getMatchDetail(matchOf(SERVED));

      expect(view, label).toEqual({ kind: 'lost' });
      // The row no longer claims an archive that is not there.
      await expect(storedDetail(context.repository, SERVED), label).resolves.toEqual(UNTOUCHED);
      // The page said it once; from now on the match is one the app does not archive.
      await expect(context.service.getMatchDetail(matchOf(SERVED)), label).resolves.toEqual({
        kind: 'not_eligible',
      });
    }
  });

  it('answers missing, not lost, until the match leaves the window', async () => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    await context.repository.markReady(ACCOUNT, matchOf(SERVED), 52_431, ARCHIVE_FORMAT);
    // The very last instant at which the match is still inside the window.
    context.clock.now = SERVED.start_time * 1000 + DETAIL_WINDOW_MS;

    await expect(context.service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({
      kind: 'missing',
    });
  });

  it.each([
    ['the file cannot be read', 'read'],
    ['the compressor is broken', 'decompress'],
  ] as const)(
    'lets the failure reach the caller, and keeps the match archived, when %s',
    async (_name, step) => {
      const context = await setUp({ matches: summariesOf([SERVED]) });
      await context.service.runQueue(ACCOUNT, RUN);
      const archivedBefore = await storedDetail(context.repository, SERVED);
      expect(archivedBefore).toMatchObject({ status: 'ready' });
      const resetToPending = vi.spyOn(context.repository, 'resetToPending');
      // The failure of the worker adapter when the compressor itself is broken.
      const compressorFailure = new AppError('storage', 'The compressor failed');
      if (step === 'read') {
        vi.spyOn(context.archive, 'read').mockRejectedValueOnce(new Error('Access is denied'));
      } else {
        vi.spyOn(context.compressor, 'decompress').mockRejectedValueOnce(compressorFailure);
      }

      const failure = await context.service.getMatchDetail(matchOf(SERVED)).then(
        () => null,
        (reason: unknown) => reason,
      );

      // The interface shows a storage error, and the next view tries again.
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ kind: 'storage' });
      if (step === 'decompress') {
        expect(failure).toBe(compressorFailure);
      }
      // Nothing says the archive is damaged: the match is still archived, and its file still there.
      expect(resetToPending).not.toHaveBeenCalled();
      await expect(storedDetail(context.repository, SERVED)).resolves.toEqual(archivedBefore);
      expect(context.archive.files.has(archivePath(ACCOUNT, matchOf(SERVED)))).toBe(true);
      await expect(context.service.getMatchDetail(matchOf(SERVED))).resolves.toMatchObject({
        kind: 'ready',
      });
    },
  );

  it('lets a bug in the reading of the facts reach the caller, and keeps the match archived', async () => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    await context.service.runQueue(ACCOUNT, RUN);
    const archivedBefore = await storedDetail(context.repository, SERVED);
    const resetToPending = vi.spyOn(context.repository, 'resetToPending');
    // An envelope no archive could decode to: reading its facts fails with a `TypeError`, which is
    // not a problem of the data (those are `invalid_payload` errors).
    const brokenEnvelope = {
      ...envelopeWithoutNetWorth(SERVED),
      payload: null,
    } as unknown as ArchiveEnvelope;
    vi.spyOn(context.reader, 'readArchive').mockResolvedValueOnce({
      kind: 'read',
      envelope: brokenEnvelope,
    });

    const failure = await context.service.getMatchDetail(matchOf(SERVED)).then(
      () => null,
      (reason: unknown) => reason,
    );

    // The bug is the page's error, and not a verdict on the archive: nothing is logged about the
    // archive, and the match is not put back to `pending`.
    expect(failure).toMatchObject({ name: 'TypeError' });
    expect(failure).not.toBeInstanceOf(AppError);
    expect(linesAt(context.logger, 'warn')).toEqual([]);
    expect(resetToPending).not.toHaveBeenCalled();
    await expect(storedDetail(context.repository, SERVED)).resolves.toEqual(archivedBefore);
    await expect(context.service.getMatchDetail(matchOf(SERVED))).resolves.toMatchObject({
      kind: 'ready',
    });
  });

  it('does not reset a match past the 90 days when the archive cannot be read', async () => {
    const context = await setUp({ matches: summariesOf([SERVED]) });
    await context.service.runQueue(ACCOUNT, RUN);
    context.clock.now = START + 91 * DAY;
    vi.spyOn(context.archive, 'read').mockRejectedValueOnce(new Error('Access is denied'));

    await expect(context.service.getMatchDetail(matchOf(SERVED))).rejects.toMatchObject({
      kind: 'storage',
    });

    // A momentary lock on the file must not detach an archive that can never be downloaded again.
    await expect(storedDetail(context.repository, SERVED)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(context.service.getMatchDetail(matchOf(SERVED))).resolves.toMatchObject({
      kind: 'ready',
    });
  });

  it('lets a failure to put the match back to pending reach the caller', async () => {
    const { service, repository } = await setUp({ matches: summariesOf([SERVED]) });
    await repository.markReady(ACCOUNT, matchOf(SERVED), 52_431, ARCHIVE_FORMAT);
    vi.spyOn(repository, 'resetToPending').mockRejectedValueOnce(
      new AppError('storage', 'Could not reset the detail state of a match'),
    );

    // Answering `missing` while the database still says `ready` would be a lie, and the match would
    // never be downloaded. The failure is for the interface to show; the next read tries again.
    await expect(service.getMatchDetail(matchOf(SERVED))).rejects.toMatchObject({
      kind: 'storage',
    });
    await expect(storedDetail(repository, SERVED)).resolves.toMatchObject({ status: 'ready' });
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({ kind: 'missing' });
    await expect(storedDetail(repository, SERVED)).resolves.toEqual(UNTOUCHED);
  });

  it('does not loop on a detail whose facts cannot be read', async () => {
    const context = await setUp({
      matches: summariesOf([SERVED]),
      handler: () => jsonResponse(metadataWithoutNetWorth(SERVED)),
    });
    const { service, http } = context;
    // An archive of the kind an earlier version of the app could write: valid, but with no facts.
    await plantArchive(
      context,
      SERVED,
      await context.compressor.compress(encodeArchiveEnvelope(envelopeWithoutNetWorth(SERVED))),
    );
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({ kind: 'missing' });

    // The match is downloaded again, and the door check refuses what the page could not read.
    await expect(service.runQueue(ACCOUNT, RUN)).resolves.toEqual({ ...NOTHING, invalid: 1 });

    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({
      kind: 'invalid',
      lastError: 'invalid_payload (tracked_player.net_worth: invalid_type)',
    });
    // Nothing asks for it again: the loop of downloads is over.
    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual(NOTHING);
    expect(http.requests).toHaveLength(1);
  });

  it('still shows the facts of an archived match that aged past the 90 days', async () => {
    const { service, database, clock } = await setUp({ matches: summariesOf([SERVED]) });
    await service.runQueue(ACCOUNT, RUN);
    // A match of the same age that was never archived, to compare with.
    await new MatchesRepository(database).upsertMany([eligibleMatch(7_001)]);
    await expect(service.getMatchDetail(testMatchId(7_001))).resolves.toEqual({
      kind: 'waiting',
      nextAttemptAt: null,
    });

    clock.now = START + 91 * DAY;

    // The archive is there, so the page shows it; only a match with no archive is "not eligible".
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toMatchObject({
      kind: 'ready',
    });
    await expect(service.getMatchDetail(testMatchId(7_001))).resolves.toEqual({
      kind: 'not_eligible',
    });
  });

  it('tells when the next attempt is due', async () => {
    const missing = await setUp({ matches: summariesOf([MISSING]) });
    await missing.service.runQueue(ACCOUNT, RUN);
    // The first failure waits 5 minutes from the moment it was recorded.
    await expect(missing.service.getMatchDetail(matchOf(MISSING))).resolves.toEqual({
      kind: 'waiting',
      nextAttemptAt: START + 5 * MINUTE,
    });

    const { service, repository } = await setUp({
      matches: [eligibleMatch(1), eligibleMatch(2)],
    });
    await repository.saveState(ACCOUNT, testMatchId(2), retrying(START + 30 * MINUTE));
    // A match nobody tried has no date: it is for the next run. One that waits for a retry has one.
    await expect(service.getMatchDetail(testMatchId(1))).resolves.toEqual({
      kind: 'waiting',
      nextAttemptAt: null,
    });
    await expect(service.getMatchDetail(testMatchId(2))).resolves.toEqual({
      kind: 'waiting',
      nextAttemptAt: START + 30 * MINUTE,
    });
  });

  it('tells why a match is unavailable or invalid', async () => {
    const { service, repository } = await setUp({
      matches: [eligibleMatch(1), eligibleMatch(2), eligibleMatch(3)],
    });
    await repository.saveState(ACCOUNT, testMatchId(1), UNAVAILABLE);
    await repository.saveState(ACCOUNT, testMatchId(2), INVALID);
    await repository.saveState(ACCOUNT, testMatchId(3), { ...UNAVAILABLE, lastError: null });

    await expect(service.getMatchDetail(testMatchId(1))).resolves.toEqual({
      kind: 'unavailable',
      lastError: 'not_found (404)',
    });
    await expect(service.getMatchDetail(testMatchId(2))).resolves.toEqual({
      kind: 'invalid',
      lastError: 'invalid_payload (match_id)',
    });
    await expect(service.getMatchDetail(testMatchId(3))).resolves.toEqual({
      kind: 'unavailable',
      lastError: null,
    });
  });

  it('downloads an evicted match again when its page opens within 90 days', async () => {
    const { service, repository } = await setUp({ matches: summariesOf([SERVED]) });
    await service.runQueue(ACCOUNT, RUN);
    await repository.markEvicted(ACCOUNT, matchOf(SERVED));

    // The page says the archive is being downloaded again, and the match is back in the queue.
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({ kind: 'evicted' });
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      archivedBytes: null,
    });
    // From then on it is a match like any other that waits for its download.
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({
      kind: 'waiting',
      nextAttemptAt: null,
    });

    // The next run of the queue takes it and archives it again.
    await expect(service.runQueue(ACCOUNT, 'run-0002')).resolves.toEqual({
      ...NOTHING,
      archived: 1,
    });
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toMatchObject({ kind: 'ready' });
  });

  it('says an evicted match older than 90 days is gone', async () => {
    const { service, repository, clock } = await setUp({ matches: summariesOf([SERVED]) });
    await service.runQueue(ACCOUNT, RUN);
    await repository.markEvicted(ACCOUNT, matchOf(SERVED));
    const before = await repository.getDetail(ACCOUNT, matchOf(SERVED));
    clock.now = START + 91 * DAY;

    // Not `not_eligible`: the match did have an archive, which was removed and will not come back.
    await expect(service.getMatchDetail(matchOf(SERVED))).resolves.toEqual({
      kind: 'evicted_lost',
    });
    // The row is left as it is: the match keeps its status and the size of the file it lost.
    await expect(repository.getDetail(ACCOUNT, matchOf(SERVED))).resolves.toEqual(before);
    expect(before).toMatchObject({ status: 'evicted' });
  });

  it('says a match is not archived when it is not eligible', async () => {
    // What makes a match one the queue never archives; each is tried in every status but `ready`.
    const reasons: readonly [string, Parameters<typeof matchSummary>[0]][] = [
      ['Street Brawl', { gameMode: 4 }],
      ['a private lobby', { matchMode: 2 }],
      ['another hero', { heroId: PAIGE_HERO_ID + 1 }],
      ['a match older than 90 days', { startTime: START / 1000 - WINDOW_S - DAY / 1000 }],
      ['a match one second past the window', { startTime: START / 1000 - WINDOW_S - 1 }],
    ];
    const states: readonly DetailState[] = [retrying(START + MINUTE), UNAVAILABLE, INVALID];
    const cases = reasons.flatMap(([reason, overrides], reasonIndex) => [
      // Pending is the state a match starts in, which needs no state to be saved.
      { label: `${reason}, pending`, matchId: 100 + reasonIndex * 10, overrides, state: null },
      ...states.map((state, stateIndex) => ({
        label: `${reason}, ${state.status}`,
        matchId: 101 + reasonIndex * 10 + stateIndex,
        overrides,
        state,
      })),
    ]);
    const { service, repository } = await setUp({
      matches: [
        ...cases.map(({ matchId, overrides }) => eligibleMatch(matchId, overrides)),
        // The edge of the window: a match that started exactly 90 days ago is still eligible.
        eligibleMatch(1, { startTime: START / 1000 - WINDOW_S }),
        eligibleMatch(2),
      ],
    });
    for (const { matchId, state } of cases) {
      if (state !== null) {
        await repository.saveState(ACCOUNT, testMatchId(matchId), state);
      }
    }

    for (const { label, matchId } of cases) {
      const view = await service.getMatchDetail(testMatchId(matchId));
      expect(view, label).toEqual({ kind: 'not_eligible' });
    }
    // A match the app never stored is not one either.
    await expect(service.getMatchDetail(testMatchId(9_999))).resolves.toEqual({
      kind: 'not_eligible',
    });
    // The eligible ones next to them are not refused.
    await expect(service.getMatchDetail(testMatchId(1))).resolves.toMatchObject({
      kind: 'waiting',
    });
    await expect(service.getMatchDetail(testMatchId(2))).resolves.toMatchObject({
      kind: 'waiting',
    });
  });

  it('says there is no account when none is linked', async () => {
    const { service, repository, archive } = await setUp({
      matches: [eligibleMatch(1)],
      accountId: null,
    });
    const read = vi.spyOn(archive, 'read');
    const getDetail = vi.spyOn(repository, 'getDetail');

    await expect(service.getMatchDetail(testMatchId(1))).resolves.toEqual({ kind: 'no_account' });

    expect(getDetail).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('MatchDetailService.resetForRetry', () => {
  it('resets only unavailable and invalid matches', async () => {
    const { service, repository } = await setUp({
      matches: [
        eligibleMatch(1),
        eligibleMatch(2),
        eligibleMatch(3),
        eligibleMatch(4),
        eligibleMatch(5),
      ],
    });
    // 1 is pending, 2 waits for a retry, 3 is archived, 4 is given up, 5 is unusable.
    await repository.saveState(ACCOUNT, testMatchId(2), retrying(START + MINUTE));
    await repository.markReady(ACCOUNT, testMatchId(3), 52_431, ARCHIVE_FORMAT);
    await repository.saveState(ACCOUNT, testMatchId(4), UNAVAILABLE);
    await repository.saveState(ACCOUNT, testMatchId(5), INVALID);
    const detailOf = async (matchId: number) => repository.getDetail(ACCOUNT, testMatchId(matchId));
    const before = await Promise.all([1, 2, 3].map(detailOf));

    for (const matchId of [1, 2, 3, 4, 5, 9_999]) {
      await service.resetForRetry(testMatchId(matchId));
    }

    // The three matches that did not fail stay exactly as they were, the archived one included.
    await expect(Promise.all([1, 2, 3].map(detailOf))).resolves.toEqual(before);
    // The two failed ones are back to the start: the queue takes them at its next run.
    for (const matchId of [4, 5]) {
      await expect(detailOf(matchId)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        archivedBytes: null,
      });
    }
    // A match the app never stored is not created by the call.
    await expect(detailOf(9_999)).resolves.toBeNull();
  });

  it('puts an evicted match back to pending', async () => {
    const { service, repository } = await setUp({ matches: [eligibleMatch(1)] });
    await repository.markReady(ACCOUNT, testMatchId(1), 52_431, ARCHIVE_FORMAT);
    await repository.markEvicted(ACCOUNT, testMatchId(1));

    await service.resetForRetry(testMatchId(1));

    // The file is gone: the match starts again, with the size and the format of the lost file
    // forgotten.
    await expect(repository.getDetail(ACCOUNT, testMatchId(1))).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      archivedBytes: null,
    });
  });

  it('does nothing without a linked account', async () => {
    const { service, repository } = await setUp({ matches: [eligibleMatch(1)], accountId: null });
    await repository.saveState(ACCOUNT, testMatchId(1), UNAVAILABLE);
    const resetToPending = vi.spyOn(repository, 'resetToPending');

    await service.resetForRetry(testMatchId(1));

    expect(resetToPending).not.toHaveBeenCalled();
    await expect(repository.getDetail(ACCOUNT, testMatchId(1))).resolves.toMatchObject({
      status: 'unavailable',
    });
  });
});

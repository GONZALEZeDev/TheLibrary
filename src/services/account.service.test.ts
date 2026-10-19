/**
 * Tests of the account service, end to end on the development adapters: the services are built by
 * `createTestServices` exactly as the app builds them, with the fixture gateway playing the loopback
 * listener and the browser, the fixture API playing deadlock-api and Steam, and an in-memory database
 * and archive store. Accounts are synthetic: 1000001 is the account of the fixtures, 2000001 the one
 * a player switches to.
 *
 * The service deletes user data, so most tests look at what is *left*: the rows, the synchronisation
 * state and the archive folder of the account that must go, or must stay.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
  type FixtureRequest,
} from '../adapters/dev/fixture-http-client.adapter';
import { FixtureSignInGateway } from '../adapters/dev/fixture-sign-in-gateway.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import {
  createSteamCallbackUrl,
  FIXTURE_AVATAR_HASH,
  FIXTURE_AVATAR_JPEG,
  FIXTURE_STEAM_ID64,
} from '../adapters/dev/fixtures/steam.fixture';
import { MemoryArchiveStore } from '../adapters/dev/memory-archive-store.adapter';
import type { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { bytesToBase64 } from '../core/account/linked-account';
import type { AccountId } from '../core/domain/account';
import { AppError } from '../core/errors/app-error';
import { accountFolderName } from '../core/match-detail/archive-layout';
import { accountIdToSteamId64 } from '../core/steam/steam-id';
import { SIGN_IN_TIMEOUT_MS, STEAM_OPENID_ENDPOINT } from '../core/steam/steam-openid';
import { INITIAL_ACCOUNT_SYNC_STATE } from '../core/sync/sync-status';
import type { Database, SqlRow, SqlValue } from '../ports/database.port';
import { createTestServices } from '../test/create-test-services';
import { createTestDatabase, matchSummary, testAccountId, testMatchId } from '../test/test-data';
import type { AccountService, LinkResult } from './account.service';
import { MatchesRepository } from './matches.repository';
import { SyncStateRepository } from './sync-state.repository';
import type { SyncService } from './sync.service';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const START = Date.UTC(2026, 9, 19, 12, 0, 0);

const DAY_MS = 24 * 60 * 60_000;

/**
 * Size of the synthetic history. Every test that fills an account synchronises it for real, and each
 * archive is compressed for real, so the history is kept short: just long enough to have a Paige
 * match archived, hence an archive folder.
 */
const SMALL_HISTORY = 8;

/** The account of the fixtures: linked in most tests, and the old account of a switch. */
const OLD = FIXTURE_ACCOUNT_ID;

/** The account a player switches to. Deadlock-api knows no profile for it. */
const NEW = testAccountId(2000001);

/** The SteamID64 Steam sends when {@link NEW} signs in. */
const NEW_STEAM_ID64 = accountIdToSteamId64(NEW);

/** The account linked by the fixture sign-in, as the service stores it. */
const FIXTURE_LINK = {
  accountId: OLD,
  personaName: 'Fixture Player',
  avatarBase64: bytesToBase64(FIXTURE_AVATAR_JPEG),
  avatarHash: FIXTURE_AVATAR_HASH,
  linkedAt: START,
  profileFetchedAt: START,
} as const;

/** What the synchronisation logs when it turns a request down because the account is changing. */
const SYNC_REFUSED = 'Synchronisation refused while the account changes';

/** The line logged when the startup cleanup is skipped. */
const UNREADABLE_LINK = 'The linked account cannot be read: nothing is deleted';

/**
 * Tell whether a request asks deadlock-api for the match history.
 *
 * @param request - The request.
 * @returns `true` for a history request.
 */
function isHistoryRequest(request: FixtureRequest): boolean {
  return request.url.endsWith('/match-history');
}

/**
 * Tell whether a request asks deadlock-api for the detail of a match.
 *
 * @param request - The request.
 * @returns `true` for a match detail request.
 */
function isMetadataRequest(request: FixtureRequest): boolean {
  return /\/v1\/matches\/\d+\/metadata/.test(request.url);
}

/**
 * Tell whether a request asks deadlock-api for a Steam profile, with or without `refresh`.
 *
 * @param request - The request.
 * @returns `true` for a profile request.
 */
function isProfileRequest(request: FixtureRequest): boolean {
  return request.url.includes('/v1/players/steam');
}

/**
 * Tell whether a request asks deadlock-api to read the profile from Steam.
 *
 * @param request - The request.
 * @returns `true` for a profile request with `refresh=true`.
 */
function isRefreshRequest(request: FixtureRequest): boolean {
  return isProfileRequest(request) && request.url.endsWith('&refresh=true');
}

/**
 * The synthetic deadlock-api and Steam, except that every profile request is answered by `answer`.
 *
 * @param answer - Answers the profile requests (or throws, to simulate a failure of the transport).
 * @returns The handler.
 */
function withProfileAnswer(answer: FixtureHandler): FixtureHandler {
  const fixtures = createFixtureApi({ now: START, matchCount: SMALL_HISTORY });
  return (request) => (isProfileRequest(request) ? answer(request) : fixtures(request));
}

/**
 * The synthetic deadlock-api and Steam, except that Steam answers every confirmation of a sign-in
 * with an HTTP status and no body.
 *
 * @param status - The status of Steam's answer.
 * @returns The handler.
 */
function steamAnswering(status: number): FixtureHandler {
  const fixtures = createFixtureApi({ now: START, matchCount: SMALL_HISTORY });
  return (request) =>
    request.method === 'POST' && request.url === STEAM_OPENID_ENDPOINT
      ? { status, headers: {}, body: '' }
      : fixtures(request);
}

/** A gate: whoever awaits `opened` waits until the test calls `open`. */
interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

/**
 * Create a gate.
 *
 * @returns The promise and the function that settles it.
 */
function createGate(): Gate {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * An archive store whose removal of an entry waits for the test, so that a cleanup can be caught
 * half-way.
 */
class GatedArchiveStore extends MemoryArchiveStore {
  /** Opens as soon as a removal has started. */
  readonly removalStarted = createGate();
  /** Lets the removals go. */
  readonly releaseRemoval = createGate();

  override async removeEntry(name: string): Promise<void> {
    this.removalStarted.open();
    await this.releaseRemoval.opened;
    return super.removeEntry(name);
  }
}

/**
 * A database that records every statement it runs, and fails the ones a test asks it to. It wraps the
 * database of the services, so the statements of all of them are seen.
 */
class FailableDatabase implements Database {
  /** Every statement asked so far, in order, failed ones included. */
  readonly statements: string[] = [];

  readonly #inner: Database;
  readonly #queuedFailures: RegExp[] = [];

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
    return this.statements.filter((sql) => sql.trim() === 'VACUUM').length;
  }

  /**
   * Make the next statement that matches fail, once, as a locked or damaged file would.
   *
   * @param statement - What the statement to fail looks like.
   */
  failNext(statement: RegExp): void {
    this.#queuedFailures.push(statement);
  }

  execute(sql: string, params?: readonly SqlValue[]): Promise<number> {
    return this.#run(sql, () => this.#inner.execute(sql, params));
  }

  select(sql: string, params?: readonly SqlValue[]): Promise<readonly SqlRow[]> {
    return this.#run(sql, () => this.#inner.select(sql, params));
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

/** What {@link setUp} can change. */
interface SetUpOptions {
  /** Answers the requests to deadlock-api and Steam; the fixtures (a short history) by default. */
  readonly handler?: FixtureHandler;
  /**
   * The account linked before the test starts; the fixture account by default. `null` leaves the
   * database as it is: a first launch, or the database of an earlier set-up passed in.
   */
  readonly accountId?: AccountId | null;
  /** The player Steam signs in; the fixture account's by default. */
  readonly steamId64?: string;
  /**
   * Whether the browser comes back by itself once opened; `true` by default. A test that delivers
   * its own callback, or none, turns it off.
   */
  readonly autoAnswer?: boolean;
  /** The database, to keep the data of an earlier set-up (a restart of the app). */
  readonly database?: FailableDatabase;
  /** The archive store, to keep the files of an earlier set-up (a restart of the app). */
  readonly archiveStore?: MemoryArchiveStore;
}

/** The synchronisations of the services built so far: stopped after each test. */
const builtSyncs: SyncService[] = [];

/**
 * Build the services like the app, with a clock the test can move.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The services and everything a test may inspect: `account` is the service under test,
 *   `spy` the database that records and fails statements (`database`, the one tests run SQL on, is
 *   the same once the link is seeded), `clock` the time the test controls and `servicesNow` the time
 *   the services read, which is ahead of it by the waits they skipped.
 */
function setUp(options: SetUpOptions = {}) {
  const clock = { now: START };
  const now = (): number => clock.now;
  const spy = options.database ?? new FailableDatabase(createTestDatabase());
  const signInGateway = new FixtureSignInGateway({
    now,
    ...(options.autoAnswer === undefined ? {} : { autoAnswer: options.autoAnswer }),
    ...(options.steamId64 === undefined ? {} : { steamId64: options.steamId64 }),
  });
  const test = createTestServices({
    now,
    database: spy,
    signInGateway,
    handler: options.handler ?? createFixtureApi({ now: START, matchCount: SMALL_HISTORY }),
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    ...(options.archiveStore === undefined ? {} : { archiveStore: options.archiveStore }),
  });
  builtSyncs.push(test.services.sync);
  return {
    ...test,
    account: test.services.account,
    spy,
    clock,
    servicesNow: () => clock.now + test.skippedMs(),
  };
}

/** What {@link setUp} gives. */
type SetUp = ReturnType<typeof setUp>;

afterEach(() => {
  // `start()` sets the interval of the automatic synchronisations: none must outlive its test.
  for (const sync of builtSyncs.splice(0)) {
    sync.stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Wait until the synchronisation is idle.
 *
 * @param sync - The synchronisation.
 * @returns A promise settled once no run is going (at once when none is).
 */
function whenIdle(sync: SyncService): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!sync.isRunning()) {
      resolve();
      return;
    }
    const unsubscribe = sync.subscribe(() => {
      if (!sync.isRunning()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Let the pending work of the other promises run (a macrotask later), so that whatever could settle
 * by itself has settled. Real timers only.
 *
 * @returns A promise resolved after a timer of 0 ms.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the system browser to be opened on Steam's login page, i.e. for the sign-in to be up.
 *
 * @param gateway - The fixture gateway.
 * @returns The login URL.
 */
async function loginUrlOf(gateway: FixtureSignInGateway): Promise<string> {
  await vi.waitFor(
    () => {
      expect(gateway.openedUrls).toHaveLength(1);
    },
    { timeout: 5_000 },
  );
  const [url] = gateway.openedUrls;
  if (url === undefined) {
    throw new Error('The browser was not opened');
  }
  return url;
}

/**
 * Play the browser coming back from Steam with the callback of a player, changed as the test needs.
 *
 * @param gateway - The fixture gateway.
 * @param overrides - Query parameters to replace or remove in the genuine callback.
 */
async function deliverCallback(
  gateway: FixtureSignInGateway,
  overrides: Readonly<Record<string, string | null>> = {},
): Promise<void> {
  gateway.deliver(
    createSteamCallbackUrl(await loginUrlOf(gateway), {
      steamId64: FIXTURE_STEAM_ID64,
      now: START,
      overrides,
    }),
  );
}

/**
 * The nonce of a login URL, which only the app and Steam's page are meant to know.
 *
 * @param loginUrl - The URL the browser was opened on.
 * @returns The nonce.
 */
function nonceOf(loginUrl: string): string {
  const returnTo = new URL(loginUrl).searchParams.get('openid.return_to') ?? '';
  return new URL(returnTo).searchParams.get('nonce') ?? '';
}

/**
 * The triggers of the synchronisations that started, oldest first.
 *
 * @param logger - The logger of the services.
 * @returns The triggers.
 */
function startedRuns(logger: MemoryLogger): unknown[] {
  return logger.entries
    .filter((entry) => entry.message === 'Synchronisation started')
    .map((entry) => entry.context.trigger);
}

/**
 * How many times a message was logged.
 *
 * @param logger - The logger of the services.
 * @param message - The message.
 * @returns The count.
 */
function countLogged(logger: MemoryLogger, message: string): number {
  return logger.entries.filter((entry) => entry.message === message).length;
}

/**
 * Where a message was first logged.
 *
 * @param logger - The logger of the services.
 * @param message - The message.
 * @returns The index among the lines logged, or -1.
 */
function firstLoggedAt(logger: MemoryLogger, message: string): number {
  return logger.entries.findIndex((entry) => entry.message === message);
}

/**
 * Everything the service may delete or keep of an account, read back.
 *
 * @param test - The services of the test.
 * @param accountId - The account.
 * @returns How many matches it has, and whether its synchronisation state and archive folder exist.
 */
async function storedDataOf(test: SetUp, accountId: AccountId) {
  return {
    matches: await new MatchesRepository(test.database).count(accountId),
    syncState: await new SyncStateRepository(test.database, test.logger).hasAccountState(accountId),
    archiveFolder: (await test.archiveStore.listEntries()).includes(accountFolderName(accountId)),
  };
}

/** What {@link storedDataOf} gives for an account of which nothing is left. */
const NOTHING_LEFT = { matches: 0, syncState: false, archiveFolder: false };

/**
 * Synchronise the linked account for real: its matches, its synchronisation state and its archive
 * folder (a Paige match is archived).
 *
 * @param test - The services of the test.
 * @param accountId - The account that is linked, to check that it has data now.
 */
async function populate(test: SetUp, accountId: AccountId = OLD): Promise<void> {
  await test.services.sync.syncNow('manual');
  const data = await storedDataOf(test, accountId);
  expect(data.matches).toBeGreaterThan(0);
  expect(data).toMatchObject({ syncState: true, archiveFolder: true });
}

/**
 * Check that a switch that did not happen left the old account as it was: its data, its link, and a
 * synchronisation that takes runs again.
 *
 * @param test - The services of the test.
 * @param before - What {@link storedDataOf} gave for the old account before the switch.
 */
async function expectOldAccountKept(
  test: SetUp,
  before: Awaited<ReturnType<typeof storedDataOf>>,
): Promise<void> {
  await expect(storedDataOf(test, OLD)).resolves.toEqual(before);
  await expect(test.account.getLinkedAccount()).resolves.toMatchObject({ accountId: OLD });
  // The synchronisation is not left suspended: it takes a new run.
  await test.services.sync.syncNow('manual');
  expect(startedRuns(test.logger)).toEqual(['manual', 'manual']);
  expect(countLogged(test.logger, SYNC_REFUSED)).toBe(0);
}

/**
 * Write the data of an account by hand, as an earlier session left it: a match, its synchronisation
 * state and an archive file.
 *
 * @param test - The services of the test.
 * @param accountId - The account.
 */
async function leaveDataOf(test: SetUp, accountId: AccountId): Promise<void> {
  await new MatchesRepository(test.database).upsertMany([matchSummary({ accountId })]);
  await new SyncStateRepository(test.database, test.logger).setAccountState(
    accountId,
    INITIAL_ACCOUNT_SYNC_STATE,
  );
  await test.archiveStore.write(accountId, testMatchId(100000001), new Uint8Array([1, 2, 3]));
}

/**
 * Insert a link whose profile is damaged but whose account id is fine, as another version of the app
 * could have left it: the table accepts any 40 characters as an avatar hash, only the repository
 * knows it must be hexadecimal.
 *
 * @param database - The database.
 * @param accountId - The linked account.
 */
async function insertDamagedProfile(database: Database, accountId: AccountId): Promise<void> {
  await database.execute(
    `INSERT INTO linked_account
       (id, account_id, persona_name, avatar_base64, avatar_hash, linked_at, profile_fetched_at)
     VALUES (1, $1, 'Test Player', 'AAAA', $2, 0, NULL)`,
    [accountId, 'z'.repeat(40)],
  );
}

/**
 * Watch the profile refreshes the service starts by itself after a synchronisation, so that a test
 * can wait for them.
 *
 * @param account - The service.
 * @returns `settled`, which resolves once every refresh started so far has ended.
 */
function watchRefreshes(account: AccountService): { settled: () => Promise<void> } {
  const started: Promise<void>[] = [];
  const refresh = account.refreshProfileIfDue.bind(account);
  vi.spyOn(account, 'refreshProfileIfDue').mockImplementation(() => {
    const running = refresh();
    started.push(running);
    return running;
  });
  return {
    settled: async () => {
      await Promise.all(started);
    },
  };
}

/** How a sign-in can fail, and how the test plays it. */
interface FailureCase {
  readonly name: string;
  /** The result of the link. */
  readonly kind: Exclude<LinkResult['kind'], 'linked' | 'already_linked'>;
  readonly options?: SetUpOptions;
  /** Plays the sign-in up to its end, and gives the result of `link()`. */
  readonly play: (test: SetUp) => Promise<LinkResult>;
}

const FAILURES: readonly FailureCase[] = [
  {
    name: 'the player cancels in the app',
    kind: 'cancelled',
    options: { autoAnswer: false },
    play: async ({ account, signInGateway }) => {
      const pending = account.link();
      await loginUrlOf(signInGateway);
      account.cancelLink();
      return pending;
    },
  },
  {
    name: 'Steam sends nobody back in time',
    kind: 'timed_out',
    options: { autoAnswer: false },
    play: async ({ account, signInGateway }) => {
      // Only the timers: the clock of the services is the test's own.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = account.link();
      await loginUrlOf(signInGateway);
      await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
      return pending;
    },
  },
  {
    name: 'the player cancels on Steam',
    kind: 'cancelled_on_steam',
    options: { autoAnswer: false },
    play: async ({ account, signInGateway }) => {
      const pending = account.link();
      await deliverCallback(signInGateway, { 'openid.mode': 'cancel' });
      return pending;
    },
  },
  {
    name: 'the callback carries another nonce than the one of the sign-in',
    kind: 'refused',
    options: { autoAnswer: false },
    play: async ({ account, signInGateway }) => {
      const pending = account.link();
      await deliverCallback(signInGateway, { nonce: 'f'.repeat(32) });
      return pending;
    },
  },
  {
    name: 'Steam answers 503 to the confirmation',
    kind: 'steam_unavailable',
    options: { handler: steamAnswering(503) },
    play: ({ account }) => account.link(),
  },
  {
    name: 'the listener cannot start',
    kind: 'start_failed',
    play: ({ account, signInGateway }) => {
      signInGateway.failNextStart(new Error('The port is in use'));
      return account.link();
    },
  },
];

describe('AccountService.link', () => {
  it('links the account after Steam confirms the sign-in', async () => {
    const test = setUp({ accountId: null });
    const { account, http, logger, services } = test;
    const listener = vi.fn();
    account.subscribe(listener);

    const result = await account.link();

    expect(result).toEqual({ kind: 'linked', replaced: false, account: FIXTURE_LINK });
    await expect(account.getLinkedAccount()).resolves.toEqual(FIXTURE_LINK);
    expect(listener).toHaveBeenCalledTimes(1);
    // The first synchronisation after a link is a `link` run, which asks for the history.
    await whenIdle(services.sync);
    expect(startedRuns(logger)).toEqual(['link']);
    expect(http.requests.filter(isHistoryRequest)).toHaveLength(1);
    expect((await services.matches.listRecent(1)).total).toBeGreaterThan(0);
    expect(logger.entries).toContainEqual({
      level: 'info',
      scope: 'account',
      message: 'Steam account linked',
      context: { replaced: false, profile: 'found' },
    });
  });

  it.each(FAILURES)('stores nothing when $name', async ({ kind, options, play }) => {
    const test = setUp({ accountId: null, ...options });

    const result = await play(test);

    expect(result).toEqual({ kind });
    await expect(test.account.getLinkedAccount()).resolves.toBeNull();
    await expect(test.services.matches.listRecent(1)).resolves.toMatchObject({
      accountLinked: false,
      total: 0,
    });
    // No account, so no synchronisation: the first one belongs to a link that succeeded.
    expect(startedRuns(test.logger)).toEqual([]);
  });

  it('links with the placeholder when no profile is found', async () => {
    const { account, http, services, logger } = setUp({
      accountId: null,
      handler: withProfileAnswer(() => jsonResponse([])),
    });

    const result = await account.link();

    // Deadlock-api answered with no profile: the answer is recorded, and the profile retried daily.
    expect(result).toEqual({
      kind: 'linked',
      replaced: false,
      account: {
        accountId: OLD,
        personaName: null,
        avatarBase64: null,
        avatarHash: null,
        linkedAt: START,
        profileFetchedAt: START,
      },
    });
    // One request for the cache, then exactly one asking deadlock-api to read Steam.
    expect(http.requests.filter(isProfileRequest)).toHaveLength(2);
    expect(http.requests.filter(isRefreshRequest)).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'Steam account linked',
        context: { replaced: false, profile: 'placeholder' },
      }),
    );
    await whenIdle(services.sync);
  });

  it('links even when deadlock-api cannot be reached for the profile', async () => {
    const { account, services } = setUp({
      accountId: null,
      handler: withProfileAnswer(() => {
        throw new AppError('network', 'The network is down');
      }),
    });

    const result = await account.link();

    // The profile only dresses the interface: it never makes the sign-in fail.
    expect(result).toMatchObject({
      kind: 'linked',
      account: { accountId: OLD, personaName: null, profileFetchedAt: null },
    });
    await whenIdle(services.sync);
  });

  it('replaces the account and deletes the old data only after a successful sign-in', async () => {
    const test = setUp({ steamId64: NEW_STEAM_ID64 });
    const { account, services, logger, archiveStore } = test;
    await populate(test);
    const listener = vi.fn();
    account.subscribe(listener);

    const result = await account.link();

    expect(result).toEqual({
      kind: 'linked',
      replaced: true,
      account: {
        accountId: NEW,
        personaName: null,
        avatarBase64: null,
        avatarHash: null,
        linkedAt: test.servicesNow(),
        profileFetchedAt: test.servicesNow(),
      },
    });
    // The old account's rows, synchronisation state and archive folder are gone…
    await expect(storedDataOf(test, OLD)).resolves.toEqual(NOTHING_LEFT);
    await expect(archiveStore.listEntries()).resolves.toEqual([]);
    // …the new account is linked, and told once…
    await expect(account.getLinkedAccount()).resolves.toMatchObject({ accountId: NEW });
    expect(listener).toHaveBeenCalledTimes(1);
    // …and a `link` run starts, after the synchronisation was resumed.
    await whenIdle(services.sync);
    expect(startedRuns(logger)).toEqual(['manual', 'link']);
    expect(countLogged(logger, SYNC_REFUSED)).toBe(0);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'Steam account linked',
        context: { replaced: true, profile: 'placeholder' },
      }),
    );
  });

  it.each([
    {
      name: 'the sign-in is cancelled',
      kind: 'cancelled',
      play: async ({ account, signInGateway }: SetUp) => {
        const pending = account.link();
        await loginUrlOf(signInGateway);
        account.cancelLink();
        return pending;
      },
    },
    {
      name: 'Steam does not confirm the sign-in',
      kind: 'refused',
      play: async ({ account, signInGateway }: SetUp) => {
        const pending = account.link();
        await deliverCallback(signInGateway, { nonce: 'f'.repeat(32) });
        return pending;
      },
    },
  ])('deletes nothing when the switch fails: $name', async ({ kind, play }) => {
    const test = setUp({ steamId64: NEW_STEAM_ID64, autoAnswer: false });
    await populate(test);
    const before = await storedDataOf(test, OLD);

    await expect(play(test)).resolves.toEqual({ kind });

    await expectOldAccountKept(test, before);
  });

  it('deletes nothing when the new link cannot be saved', async () => {
    const test = setUp({ steamId64: NEW_STEAM_ID64 });
    await populate(test);
    const before = await storedDataOf(test, OLD);
    // The sign-in succeeds and the synchronisation is suspended: the failure comes at the very step
    // before the deletion.
    test.spy.failNext(/^INSERT INTO linked_account/);

    await expect(test.account.link()).rejects.toMatchObject({ kind: 'storage' });

    await expectOldAccountKept(test, before);
  });

  it('only refreshes the profile when the same account signs in again', async () => {
    // Deadlock-api has no profile: a refresh request would be tempting, but it is not allowed here.
    const test = setUp({ handler: withProfileAnswer(() => jsonResponse([])) });
    const { account, services, http, logger, clock } = test;
    await populate(test);
    const before = await storedDataOf(test, OLD);
    const listener = vi.fn();
    account.subscribe(listener);
    clock.now += 5_000;
    const fetchedAt = test.servicesNow();

    const result = await account.link();

    // The name the link already had is kept; the profile is only marked as fetched again.
    const refreshed = {
      accountId: OLD,
      personaName: 'Fixture Player',
      avatarBase64: null,
      avatarHash: null,
      linkedAt: 0,
      profileFetchedAt: fetchedAt,
    };
    expect(result).toEqual({ kind: 'already_linked', account: refreshed });
    await expect(account.getLinkedAccount()).resolves.toEqual(refreshed);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(http.requests.filter(isRefreshRequest)).toHaveLength(0);
    // Nothing is deleted, and no new synchronisation starts.
    await expect(storedDataOf(test, OLD)).resolves.toEqual(before);
    expect(startedRuns(logger)).toEqual(['manual']);
    expect(services.sync.isRunning()).toBe(false);
  });

  it('fetches the avatar of the same account when it signs in again', async () => {
    const { account } = setUp();

    const result = await account.link();

    // The seeded link has a name and no avatar: deadlock-api gives the avatar, and `linkedAt` stays.
    expect(result).toEqual({
      kind: 'already_linked',
      account: { ...FIXTURE_LINK, linkedAt: 0 },
    });
  });

  it('returns the pending link to a second call, and opens one browser', async () => {
    const { account, signInGateway, services } = setUp({ accountId: null });

    const first = account.link();
    const second = account.link();

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ kind: 'linked' });
    expect(signInGateway.openedUrls).toHaveLength(1);
    await whenIdle(services.sync);
    // The link is over: the next call starts a new one.
    expect(account.link()).not.toBe(first);
    await whenIdle(services.sync);
  });

  it('can link again after a sign-in that failed', async () => {
    const { account, signInGateway, services } = setUp({ accountId: null });
    signInGateway.failNextStart(new Error('The port is in use'));

    await expect(account.link()).resolves.toEqual({ kind: 'start_failed' });
    await expect(account.link()).resolves.toMatchObject({ kind: 'linked' });

    await whenIdle(services.sync);
  });

  it('does nothing when the link is cancelled and none is pending', () => {
    const { account, signInGateway, logger } = setUp({ accountId: null });

    account.cancelLink();

    expect(signInGateway.openedUrls).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  it('ends a link cancelled while it waits for its turn, before any browser opens', async () => {
    // A run is held in its detail queue, so the unlink in front of the link is waiting for it.
    const asked = createGate();
    const release = createGate();
    const fixtures = createFixtureApi({ now: START, matchCount: SMALL_HISTORY });
    const test = setUp({
      handler: async (request) => {
        if (isMetadataRequest(request)) {
          asked.open();
          await release.opened;
        }
        return fixtures(request);
      },
    });
    const { account, services, signInGateway } = test;
    const run = services.sync.syncNow('manual');
    await asked.opened;
    const unlink = account.unlink();
    const link = account.link();

    account.cancelLink();
    release.open();

    // The player gave up before the link had its turn: Steam's page is never opened for them.
    await expect(link).resolves.toEqual({ kind: 'cancelled' });
    await expect(unlink).resolves.toEqual({ complete: true });
    await run;
    expect(signInGateway.openedUrls).toEqual([]);
  });

  it('refuses to link over a link it cannot read, and opens no browser', async () => {
    const test = setUp({ accountId: null });
    await insertDamagedProfile(test.database, OLD);

    await expect(test.account.link()).rejects.toMatchObject({ kind: 'storage' });

    expect(test.signInGateway.openedUrls).toEqual([]);
  });
});

describe('AccountService.unlink', () => {
  it('unlinks and deletes every data of the account', async () => {
    const test = setUp();
    const { account, services, logger, archiveStore } = test;
    await populate(test);
    const listener = vi.fn();
    account.subscribe(listener);

    await expect(account.unlink()).resolves.toEqual({ complete: true });

    await expect(services.matches.listRecent(10)).resolves.toEqual({
      accountLinked: false,
      total: 0,
      matches: [],
    });
    await expect(account.getLinkedAccount()).resolves.toBeNull();
    await expect(storedDataOf(test, OLD)).resolves.toEqual(NOTHING_LEFT);
    await expect(archiveStore.listEntries()).resolves.toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(logger.entries).toContainEqual({
      level: 'info',
      scope: 'account',
      message: 'Steam account unlinked',
      context: { complete: true },
    });
    // The synchronisation is resumed: it takes a run again (which finds no account).
    await services.sync.syncNow('manual');
    expect(countLogged(logger, SYNC_REFUSED)).toBe(0);
  });

  it('does nothing when no account is linked', async () => {
    const { account, services, logger } = setUp({ accountId: null });
    const suspend = vi.spyOn(services.sync, 'suspend');

    await expect(account.unlink()).resolves.toEqual({ complete: true });

    expect(suspend).not.toHaveBeenCalled();
    expect(countLogged(logger, 'Steam account unlinked')).toBe(0);
  });

  it('unlinks a link whose profile cannot be read', async () => {
    const test = setUp({ accountId: null });
    await insertDamagedProfile(test.database, OLD);
    await leaveDataOf(test, OLD);

    // Only the account id is read: a damaged persona name or avatar never locks the player in.
    await expect(test.account.unlink()).resolves.toEqual({ complete: true });

    await expect(storedDataOf(test, OLD)).resolves.toEqual(NOTHING_LEFT);
    await expect(test.account.getLinkedAccount()).resolves.toBeNull();
  });

  it.each(['unlink', 'switch'] as const)(
    'waits for the running synchronisation before deleting: %s',
    async (operation) => {
      // The detail queue is held at its first request, so a run is going when the operation starts.
      const asked = createGate();
      const release = createGate();
      const fixtures = createFixtureApi({ now: START, matchCount: SMALL_HISTORY });
      const test = setUp({
        steamId64: NEW_STEAM_ID64,
        handler: async (request) => {
          if (isMetadataRequest(request)) {
            asked.open();
            await release.opened;
          }
          return fixtures(request);
        },
      });
      const { account, services, logger, archiveStore } = test;
      const run = services.sync.syncNow('manual');
      await asked.opened;

      const pending = operation === 'unlink' ? account.unlink() : account.link();
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // A request is turned down only once the operation holds the synchronisation suspended.
      await vi.waitFor(
        () => {
          void services.sync.syncNow('schedule');
          expect(countLogged(logger, SYNC_REFUSED)).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );

      // The run is going on, so nothing is deleted yet, and the link is where it was.
      expect(settled).toBe(false);
      expect(services.sync.isRunning()).toBe(true);
      await expect(account.getLinkedAccount()).resolves.toMatchObject({ accountId: OLD });

      release.open();
      await pending;
      await run;
      await whenIdle(services.sync);

      // The run ended the way it always does, then the account was erased: no file is left under
      // `archive/<id>/`, and the run did not bring any back.
      await expect(storedDataOf(test, OLD)).resolves.toEqual(NOTHING_LEFT);
      await expect(archiveStore.listEntries()).resolves.toEqual([]);
    },
  );

  it('waits for the link in front of it', async () => {
    const test = setUp({ autoAnswer: false });
    const { account, signInGateway } = test;
    await populate(test);
    const link = account.link();
    await loginUrlOf(signInGateway);

    const unlink = account.unlink();
    let unlinked = false;
    void unlink.then(() => {
      unlinked = true;
    });
    await settle();

    // The player is signing in: the unlink is queued, and the account is still linked.
    expect(unlinked).toBe(false);
    await expect(account.getLinkedAccount()).resolves.toMatchObject({ accountId: OLD });

    account.cancelLink();
    await expect(link).resolves.toEqual({ kind: 'cancelled' });
    await expect(unlink).resolves.toEqual({ complete: true });
    await expect(storedDataOf(test, OLD)).resolves.toEqual(NOTHING_LEFT);
  });

  it('deletes nothing when the link cannot be cleared', async () => {
    const test = setUp();
    const { account, services, spy, logger } = test;
    await populate(test);
    const before = await storedDataOf(test, OLD);
    spy.failNext(/^DELETE FROM linked_account/);

    await expect(account.unlink()).rejects.toMatchObject({ kind: 'storage' });

    await expect(storedDataOf(test, OLD)).resolves.toEqual(before);
    await expect(account.getLinkedAccount()).resolves.toMatchObject({ accountId: OLD });
    expect(spy.vacuumCount()).toBe(0);
    // The synchronisation is not left suspended.
    await services.sync.syncNow('manual');
    expect(startedRuns(logger)).toEqual(['manual', 'manual']);
    expect(countLogged(logger, SYNC_REFUSED)).toBe(0);
    expect(countLogged(logger, 'Steam account unlinked')).toBe(0);

    // The failure did not break the chain: the player tries again, and this time it goes through.
    await expect(account.unlink()).resolves.toEqual({ complete: true });
    await expect(storedDataOf(test, OLD)).resolves.toEqual(NOTHING_LEFT);
    await expect(account.getLinkedAccount()).resolves.toBeNull();
  });

  it.each([
    { operation: 'unlink', failing: /^DELETE FROM linked_account/ },
    { operation: 'switch', failing: /^INSERT INTO linked_account/ },
  ] as const)(
    'owes a compaction before the link changes, and pays it once at the next start: $operation',
    async ({ operation, failing }) => {
      const test = setUp({ steamId64: NEW_STEAM_ID64 });
      await populate(test);
      const before = await storedDataOf(test, OLD);
      test.spy.failNext(failing);

      await expect(
        operation === 'unlink' ? test.account.unlink() : test.account.link(),
      ).rejects.toMatchObject({ kind: 'storage' });

      // The link did not change, so nothing was deleted and nothing compacted. The debt is saved all
      // the same, as it must be when the app is killed at this very point instead of failing.
      await expect(storedDataOf(test, OLD)).resolves.toEqual(before);
      expect(test.spy.vacuumCount()).toBe(0);
      await expect(
        new SyncStateRepository(test.database, test.logger).isVacuumPending(),
      ).resolves.toBe(true);

      // The next start pays it once, and leaves the data of the account that is still linked.
      const restarted = setUp({
        accountId: null,
        database: test.spy,
        archiveStore: test.archiveStore,
      });
      await restarted.account.start();
      await whenIdle(restarted.services.sync);

      expect(test.spy.vacuumCount()).toBe(1);
      await expect(
        new SyncStateRepository(restarted.database, restarted.logger).isVacuumPending(),
      ).resolves.toBe(false);
      await expect(storedDataOf(restarted, OLD)).resolves.toEqual(before);
    },
  );

  it('owes nothing when there is no account to unlink', async () => {
    const test = setUp({ accountId: null });

    await test.account.unlink();

    await expect(
      new SyncStateRepository(test.database, test.logger).isVacuumPending(),
    ).resolves.toBe(false);
    expect(test.spy.statements.some((sql) => sql.trim().startsWith('INSERT INTO sync_state'))).toBe(
      false,
    );
  });

  it('says the unlink is incomplete when a file cannot be removed, and finishes at the next start', async () => {
    const test = setUp();
    const { account, services, archiveStore, logger } = test;
    await populate(test);
    archiveStore.failNextRemove(new Error('Access is denied'));

    await expect(account.unlink()).resolves.toEqual({ complete: false });

    // The link is gone, the database is clean, and the folder is left for the next start.
    await expect(services.matches.listRecent(1)).resolves.toMatchObject({ accountLinked: false });
    await expect(archiveStore.listEntries()).resolves.toEqual([accountFolderName(OLD)]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ message: 'Steam account unlinked', context: { complete: false } }),
    );

    const restarted = setUp({
      accountId: null,
      database: test.spy,
      archiveStore,
    });
    await restarted.account.start();
    // The startup run of the restarted app is over before the test is.
    await whenIdle(restarted.services.sync);
    await expect(archiveStore.listEntries()).resolves.toEqual([]);
  });
});

describe('AccountService.start', () => {
  /**
   * What a crash can leave of an unlink, in the order of its steps: the link is cleared first, then
   * the rows and the synchronisation state go (the compaction is owed from the first deletion), then
   * the folder, and the compaction comes last.
   */
  const CRASHES: readonly {
    readonly name: string;
    readonly left: (test: SetUp) => Promise<void>;
  }[] = [
    {
      name: 'the link is cleared and nothing else is done',
      left: () => Promise.resolve(),
    },
    {
      name: 'the rows are deleted but the folder is left',
      left: async ({ database, logger }) => {
        await new MatchesRepository(database).deleteAccount(OLD);
        const syncState = new SyncStateRepository(database, logger);
        await syncState.deleteAccountState(OLD);
        await syncState.setVacuumPending(true);
      },
    },
    {
      name: 'everything is deleted but the database is not compacted',
      left: async ({ database, logger, archiveStore }) => {
        await new MatchesRepository(database).deleteAccount(OLD);
        const syncState = new SyncStateRepository(database, logger);
        await syncState.deleteAccountState(OLD);
        await archiveStore.removeEntry(accountFolderName(OLD));
        await syncState.setVacuumPending(true);
      },
    },
  ];

  it.each(CRASHES)('finishes an interrupted unlink at the next start: $name', async ({ left }) => {
    // The app that was killed: it had a first launch, so no link, and the data of the account.
    const killed = setUp({ accountId: null });
    await leaveDataOf(killed, OLD);
    await left(killed);

    // The next start: same database, same archive, still no link.
    const restarted = setUp({
      accountId: null,
      database: killed.spy,
      archiveStore: killed.archiveStore,
    });
    await restarted.account.start();
    // The startup run of the restarted app is over before the test is.
    await whenIdle(restarted.services.sync);

    // No row, no key, no folder of the account, and the database was compacted once.
    await expect(storedDataOf(restarted, OLD)).resolves.toEqual(NOTHING_LEFT);
    await expect(restarted.archiveStore.listEntries()).resolves.toEqual([]);
    expect(killed.spy.vacuumCount()).toBe(1);
    await expect(
      new SyncStateRepository(restarted.database, restarted.logger).isVacuumPending(),
    ).resolves.toBe(false);
  });

  it.each([
    { operation: 'an unlink', linked: null },
    { operation: 'a switch', linked: NEW },
  ])(
    'compacts once at the next start after $operation killed just after the link changed',
    async ({ linked }) => {
      // The app that was killed: the link row changed (cleared, or now the new account's) and
      // nothing else was done. The account that left had no match and no saved synchronisation
      // state, so there is no data to delete: the flag, saved before the link changed, is all
      // that tells the next start that the old persona name and avatar are still in the file.
      const killed = setUp({ accountId: linked });
      await new SyncStateRepository(killed.database, killed.logger).setVacuumPending(true);

      // The next start: same database, same archive, the link as the crash left it.
      const restarted = setUp({
        accountId: null,
        database: killed.spy,
        archiveStore: killed.archiveStore,
        handler: createFixtureApi({
          now: START,
          accountId: linked ?? OLD,
          matchCount: SMALL_HISTORY,
        }),
      });
      await restarted.account.start();
      await whenIdle(restarted.services.sync);

      expect(killed.spy.vacuumCount()).toBe(1);
      await expect(
        new SyncStateRepository(restarted.database, restarted.logger).isVacuumPending(),
      ).resolves.toBe(false);
    },
  );

  it('cleans up before the first synchronisation starts', async () => {
    const test = setUp();
    const { account, logger } = test;
    await leaveDataOf(test, NEW);

    await account.start();

    // The leftovers of another account are gone, the linked account's data is not touched.
    await expect(storedDataOf(test, NEW)).resolves.toEqual(NOTHING_LEFT);
    const cleanup = firstLoggedAt(logger, 'Startup cleanup');
    const firstRun = firstLoggedAt(logger, 'Synchronisation started');
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(firstRun).toBeGreaterThan(cleanup);
    expect(startedRuns(logger)).toEqual(['startup']);
    await whenIdle(test.services.sync);
  });

  it('suspends the synchronisation while it cleans up', async () => {
    const archiveStore = new GatedArchiveStore();
    const test = setUp({ archiveStore });
    const { account, services, logger } = test;
    await leaveDataOf(test, NEW);

    const started = account.start();
    // The cleanup is half-way: it is removing the folder of the other account.
    await archiveStore.removalStarted.opened;
    // The interface does not wait for the app: it asks for a run and for the retry of a match detail.
    await services.sync.syncNow('manual');
    await services.sync.retryDetail(testMatchId(100000001));

    // Both are refused, so nothing writes beside the cleanup, and no run has started.
    expect(countLogged(logger, SYNC_REFUSED)).toBe(2);
    expect(startedRuns(logger)).toEqual([]);
    expect(services.sync.isRunning()).toBe(false);

    archiveStore.releaseRemoval.open();
    await started;

    // The synchronisation was resumed, and the app's own first run comes after the cleanup.
    expect(startedRuns(logger)).toEqual(['startup']);
    expect(firstLoggedAt(logger, 'Synchronisation started')).toBeGreaterThan(
      firstLoggedAt(logger, 'Startup cleanup'),
    );
    await whenIdle(services.sync);
  });

  it('skips the startup cleanup when the link cannot be read, and still starts synchronising', async () => {
    const test = setUp({ accountId: null });
    const { account, logger, database } = test;
    await leaveDataOf(test, NEW);
    // A row the table would refuse: only the constraint is switched off, to write it by hand.
    await database.execute('PRAGMA ignore_check_constraints = ON');
    await database.execute(
      `INSERT INTO linked_account (id, account_id, linked_at) VALUES (1, 0, 0)`,
    );
    await database.execute('PRAGMA ignore_check_constraints = OFF');
    const before = await storedDataOf(test, NEW);

    await expect(account.start()).resolves.toBeUndefined();

    // A link that cannot be read is not "no account": nothing is deleted.
    await expect(storedDataOf(test, NEW)).resolves.toEqual(before);
    expect(logger.entries.find((entry) => entry.message === UNREADABLE_LINK)).toMatchObject({
      level: 'error',
      scope: 'account',
      context: { kind: 'storage', field: 'account_id' },
    });
    expect(countLogged(logger, 'Startup cleanup')).toBe(0);
    expect(startedRuns(logger)).toEqual(['startup']);
    await whenIdle(test.services.sync);
  });

  it('starts only once', async () => {
    const { account, services } = setUp();
    const start = vi.spyOn(services.sync, 'start');

    const first = account.start();
    const second = account.start();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);
    await whenIdle(services.sync);
  });
});

describe('AccountService.refreshProfileIfDue', () => {
  it('refreshes the profile once a day after a synchronisation', async () => {
    // The link was seeded with a profile fetched now, without an avatar.
    const test = setUp();
    const { account, services, http, clock } = test;
    const refreshes = watchRefreshes(account);
    await account.start();
    await whenIdle(services.sync);
    await refreshes.settled();
    // Fresh: the first synchronisation asked nothing about the profile.
    expect(http.requests.filter(isProfileRequest)).toHaveLength(0);

    clock.now += DAY_MS;
    await services.sync.syncNow('manual');
    await refreshes.settled();

    expect(http.requests.filter(isProfileRequest)).toHaveLength(1);
    await expect(account.getLinkedAccount()).resolves.toEqual({
      ...FIXTURE_LINK,
      linkedAt: 0,
      profileFetchedAt: test.servicesNow(),
    });

    // The profile is fresh again: the next synchronisation leaves it be.
    await services.sync.syncNow('manual');
    await refreshes.settled();
    expect(http.requests.filter(isProfileRequest)).toHaveLength(1);
  });

  it('keeps the profile when the refresh fails, and tries again after the next synchronisation', async () => {
    const test = setUp({
      handler: withProfileAnswer(() => {
        throw new AppError('network', 'The network is down');
      }),
    });
    const { account, services, http, clock, logger } = test;
    const refreshes = watchRefreshes(account);
    await account.start();
    await whenIdle(services.sync);
    const before = await account.getLinkedAccount();
    clock.now += DAY_MS;

    await services.sync.syncNow('manual');
    await refreshes.settled();

    // Nothing changed, nothing was written (the seed is the one write of the link), and nothing is
    // reported as a failure of the account.
    await expect(account.getLinkedAccount()).resolves.toEqual(before);
    expect(
      test.spy.statements.filter((sql) => sql.includes('INSERT INTO linked_account')),
    ).toHaveLength(1);
    expect(http.requests.filter(isProfileRequest)).toHaveLength(1);
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);

    // The profile is still due: the next synchronisation tries again.
    await services.sync.syncNow('manual');
    await refreshes.settled();
    expect(http.requests.filter(isProfileRequest)).toHaveLength(2);
  });

  it('does nothing while another operation runs', async () => {
    const { account, signInGateway, http, clock } = setUp({ autoAnswer: false });
    // The link is seeded at the first statement, with a profile fetched at this very moment.
    await account.getLinkedAccount();
    clock.now += DAY_MS;
    const link = account.link();
    await loginUrlOf(signInGateway);

    // The profile is due, but the player is signing in: the refresh leaves the link alone.
    await expect(account.refreshProfileIfDue()).resolves.toBeUndefined();
    expect(http.requests.filter(isProfileRequest)).toHaveLength(0);

    account.cancelLink();
    await expect(link).resolves.toEqual({ kind: 'cancelled' });
    await account.refreshProfileIfDue();
    expect(http.requests.filter(isProfileRequest)).toHaveLength(1);
  });

  it('does nothing when no account is linked', async () => {
    const { account, http } = setUp({ accountId: null });

    await expect(account.refreshProfileIfDue()).resolves.toBeUndefined();

    expect(http.requests).toEqual([]);
  });

  it('never rejects, and says so in the log, when the link cannot be read', async () => {
    const test = setUp({ accountId: null });
    await insertDamagedProfile(test.database, OLD);

    await expect(test.account.refreshProfileIfDue()).resolves.toBeUndefined();

    expect(test.logger.entries.filter((entry) => entry.level === 'warn')).toMatchObject([
      { scope: 'account', context: { kind: 'storage' } },
    ]);
  });
});

describe('AccountService privacy', () => {
  it('never logs the SteamID64, the nonce, the persona name or a URL', async () => {
    const test = setUp({ steamId64: NEW_STEAM_ID64 });
    const { account, services, spy, logger, signInGateway } = test;
    await populate(test);
    // A link that fails to save, a switch that succeeds, a refresh that fails to save and an unlink:
    // the lines of the failure paths are the ones that could quote what they must not.
    spy.failNext(/^INSERT INTO linked_account/);
    await expect(account.link()).rejects.toMatchObject({ kind: 'storage' });
    await account.link();
    await whenIdle(services.sync);
    test.clock.now += DAY_MS;
    spy.failNext(/^INSERT INTO linked_account/);
    await account.refreshProfileIfDue();
    await account.unlink();

    const nonces = signInGateway.openedUrls.map(nonceOf);
    expect(nonces).toHaveLength(2);
    const text = JSON.stringify(logger.entries);
    // The lines are there to be read: the paths above did log.
    expect(countLogged(logger, 'Steam account linked')).toBe(1);
    expect(countLogged(logger, 'Steam account unlinked')).toBe(1);
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    for (const secret of [
      FIXTURE_STEAM_ID64,
      NEW_STEAM_ID64,
      ...nonces,
      FIXTURE_LINK.personaName,
      String(OLD),
      String(NEW),
      'http',
      '127.0.0.1',
      'steamcommunity',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

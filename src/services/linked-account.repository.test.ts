/**
 * Tests of the storage of the linked Steam account, on an in-memory database with the real
 * migrations.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import {
  MAX_AVATAR_BASE64_LENGTH,
  MAX_PERSONA_NAME_LENGTH,
  type LinkedAccount,
} from '../core/account/linked-account';
import type { AccountId } from '../core/domain/account';
import { isAppError, type AppError } from '../core/errors/app-error';
import type { Database, SqlRow, SqlValue } from '../ports/database.port';
import { createTestDatabase, testAccountId } from '../test/test-data';
import { LinkedAccountRepository } from './linked-account.repository';

/** The account the tests link. */
const ACCOUNT_ID = testAccountId(1000001);

/** Another account, to replace the first one. */
const OTHER_ACCOUNT_ID = testAccountId(2000001);

/** A valid avatar hash: 40 lowercase hexadecimal characters. */
const AVATAR_HASH = '0123456789abcdef0123456789abcdef01234567';

/** Another valid avatar hash. */
const OTHER_AVATAR_HASH = 'fedcba9876543210fedcba9876543210fedcba98';

/** A rank badge: tier 5, sub-rank 3. */
const RANK_BADGE = 53;

/** When the rank above was fetched, in Unix milliseconds. */
const RANK_FETCHED_AT = 1_700_000_200_000;

/** The statement that inserts a row by hand, as a test that bypasses the repository does. */
const RAW_INSERT = `INSERT INTO linked_account
  (id, account_id, persona_name, avatar_base64, avatar_hash, linked_at, profile_fetched_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;

/**
 * Make a linked account with a full profile.
 *
 * @param overrides - Fields to change.
 * @returns The account.
 */
function linkedAccount(overrides: Partial<LinkedAccount> = {}): LinkedAccount {
  return {
    accountId: ACCOUNT_ID,
    personaName: 'Test Player',
    avatarBase64: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==',
    avatarHash: AVATAR_HASH,
    linkedAt: 1_700_000_000_000,
    profileFetchedAt: 1_700_000_100_000,
    ...overrides,
  };
}

/**
 * Insert a row without going through the repository.
 *
 * @param database - The database.
 * @param values - The seven columns of the row, in the order of {@link RAW_INSERT}.
 * @returns The number of rows inserted.
 */
function insertRaw(database: Database, values: readonly SqlValue[]): Promise<number> {
  return database.execute(RAW_INSERT, values);
}

/**
 * Wrap a database so that the statements it executes are recorded.
 *
 * @param database - The database to wrap.
 * @returns The wrapper, and the statements executed through it so far.
 */
function spyOnExecute(database: Database): { readonly database: Database; readonly sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    database: {
      execute: (statement, params) => {
        sql.push(statement);
        return database.execute(statement, params);
      },
      select: (statement, params) => database.select(statement, params),
    },
  };
}

/**
 * A database that answers every query with the given rows, to read rows the real table would
 * never hold (its own constraints refuse them).
 *
 * @param rows - The rows every query returns.
 * @returns The database.
 */
function databaseReturning(rows: readonly SqlRow[]): Database {
  return {
    execute: () => Promise.resolve(0),
    select: () => Promise.resolve(rows),
  };
}

/**
 * Run a call that must fail with an {@link AppError}.
 *
 * @param call - The call.
 * @returns The error it failed with.
 */
async function failureOf(call: () => Promise<unknown>): Promise<AppError> {
  const failure: unknown = await call().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!isAppError(failure)) {
    throw new Error('The call was expected to fail with an AppError');
  }
  return failure;
}

/**
 * Everything an error says to the logs and to the user, as one text: a test looks in it for values
 * that must never be there.
 *
 * @param error - The error.
 * @returns Its message and its context.
 */
function textOf(error: AppError): string {
  return JSON.stringify([error.message, error.context]);
}

/** A database whose every call fails. */
const BROKEN_DATABASE: Database = {
  execute: () => Promise.reject(new Error('disk I/O error')),
  select: () => Promise.reject(new Error('disk I/O error')),
};

/**
 * A row of the table, with a full profile.
 *
 * @param overrides - Columns to change.
 * @returns The row, as the database returns it.
 */
function storedRow(overrides: SqlRow = {}): SqlRow {
  return {
    account_id: ACCOUNT_ID,
    persona_name: 'Test Player',
    avatar_base64: 'AAAA',
    avatar_hash: AVATAR_HASH,
    linked_at: 1_700_000_000_000,
    profile_fetched_at: null,
    ...overrides,
  };
}

/**
 * A row of the table as the rank reader selects it: the account id and the two rank columns.
 *
 * @param overrides - Columns to change.
 * @returns The row, as the database returns it.
 */
function rankRow(overrides: SqlRow = {}): SqlRow {
  return {
    account_id: ACCOUNT_ID,
    rank_badge: RANK_BADGE,
    rank_fetched_at: RANK_FETCHED_AT,
    ...overrides,
  };
}

/**
 * Read the two rank columns of the row as they are stored, without going through the repository.
 *
 * @param database - The database.
 * @returns The columns of the row, or `undefined` when there is no row.
 */
async function storedRank(database: Database): Promise<SqlRow | undefined> {
  const rows = await database.select(
    'SELECT rank_badge, rank_fetched_at FROM linked_account WHERE id = $1',
    [1],
  );
  return rows[0];
}

/**
 * Create a repository on a fresh database.
 *
 * @returns The repository, its database and its logger.
 */
function createRepository(): {
  readonly repository: LinkedAccountRepository;
  readonly database: Database;
  readonly logger: MemoryLogger;
} {
  const database = createTestDatabase();
  const logger = new MemoryLogger();
  return { repository: new LinkedAccountRepository(database, logger), database, logger };
}

describe('LinkedAccountRepository', () => {
  it('has no linked account on a first launch', async () => {
    const { repository } = createRepository();

    await expect(repository.getLinkedAccount()).resolves.toBeNull();
    await expect(repository.currentAccountId()).resolves.toBeNull();
  });

  it('saves and reads back the linked account, avatar included', async () => {
    const { repository } = createRepository();
    const account = linkedAccount({ personaName: 'Zoé 🎮' });

    await repository.setLinkedAccount(account);

    await expect(repository.getLinkedAccount()).resolves.toEqual(account);
    await expect(repository.currentAccountId()).resolves.toBe(ACCOUNT_ID);
  });

  it('saves and reads back an account with no profile', async () => {
    const { repository } = createRepository();
    const account = linkedAccount({
      personaName: null,
      avatarBase64: null,
      avatarHash: null,
      profileFetchedAt: null,
    });

    await repository.setLinkedAccount(account);

    await expect(repository.getLinkedAccount()).resolves.toEqual(account);
  });

  it('replaces the linked account in one statement', async () => {
    const { repository, database } = createRepository();
    await repository.setLinkedAccount(linkedAccount());
    const spy = spyOnExecute(database);
    const replacement = linkedAccount({
      accountId: OTHER_ACCOUNT_ID,
      personaName: null,
      avatarBase64: 'BBBB',
      avatarHash: OTHER_AVATAR_HASH,
      linkedAt: 1_800_000_000_000,
    });

    await new LinkedAccountRepository(spy.database, new MemoryLogger()).setLinkedAccount(
      replacement,
    );

    expect(spy.sql).toHaveLength(1);
    await expect(repository.getLinkedAccount()).resolves.toEqual(replacement);
    // The replacement is an update of the one row, never a second row.
    await expect(database.select('SELECT COUNT(*) AS total FROM linked_account')).resolves.toEqual([
      { total: 1 },
    ]);
  });

  it('clears the linked account in one statement', async () => {
    const { repository, database } = createRepository();
    await repository.setLinkedAccount(linkedAccount());
    const spy = spyOnExecute(database);

    await new LinkedAccountRepository(spy.database, new MemoryLogger()).clearLinkedAccount();

    expect(spy.sql).toHaveLength(1);
    await expect(repository.getLinkedAccount()).resolves.toBeNull();
    await expect(repository.currentAccountId()).resolves.toBeNull();
  });

  it('clears an account that is not linked without failing', async () => {
    const { repository } = createRepository();

    await expect(repository.clearLinkedAccount()).resolves.toBeUndefined();
    await expect(repository.getLinkedAccount()).resolves.toBeNull();
  });

  it('reads a row it cannot validate as a storage error', async () => {
    const { repository, database } = createRepository();
    // The table accepts any 40 characters as a hash; only the repository knows it is hexadecimal.
    await insertRaw(database, [1, ACCOUNT_ID, 'Test Player', 'AAAA', 'z'.repeat(40), 5, null]);

    const failure = await failureOf(() => repository.getLinkedAccount());

    expect(failure).toMatchObject({
      kind: 'storage',
      // Only where the row is wrong and why, never the value.
      context: { field: 'avatar_hash', code: 'invalid_format' },
    });
    expect(textOf(failure)).not.toContain('z'.repeat(40));
  });

  it('gives the account id even when the profile is damaged', async () => {
    const { repository, database } = createRepository();
    // A valid id with a hash the repository refuses: the profile is damaged, the link is not.
    await insertRaw(database, [1, ACCOUNT_ID, 'Test Player', 'AAAA', 'z'.repeat(40), 5, null]);

    // The synchronisation, the startup sweep and an unlink need the id only: they go on.
    await expect(repository.currentAccountId()).resolves.toBe(ACCOUNT_ID);
    await expect(repository.getLinkedAccount()).rejects.toMatchObject({ kind: 'storage' });
  });

  it('reads nothing but the account id to give it', async () => {
    const repository = new LinkedAccountRepository(
      databaseReturning([{ account_id: ACCOUNT_ID }]),
      new MemoryLogger(),
    );

    await expect(repository.currentAccountId()).resolves.toBe(ACCOUNT_ID);
  });

  it.each([
    { name: 'an account id beyond 32 bits', accountId: 4_294_967_296, code: 'custom' },
    { name: 'an account id of 0', accountId: 0, code: 'custom' },
    { name: 'an account id that is a text', accountId: 'abc', code: 'invalid_type' },
    { name: 'a missing account id', accountId: null, code: 'invalid_type' },
  ])('reports $name as a storage error, never as no account', async ({ accountId, code }) => {
    const repository = new LinkedAccountRepository(
      databaseReturning([storedRow({ account_id: accountId })]),
      new MemoryLogger(),
    );

    const failure = await failureOf(() => repository.currentAccountId());

    expect(failure).toMatchObject({ kind: 'storage', context: { field: 'account_id', code } });
    expect(textOf(failure)).not.toContain('abc');
    expect(textOf(failure)).not.toContain('4294967296');
  });

  it.each([
    {
      name: 'an empty persona name',
      row: storedRow({ persona_name: '' }),
      field: 'persona_name',
      code: 'too_small',
    },
    {
      name: 'a persona name that is too long',
      row: storedRow({ persona_name: 'x'.repeat(MAX_PERSONA_NAME_LENGTH + 1) }),
      field: 'persona_name',
      code: 'too_big',
    },
    {
      name: 'an avatar that is too long',
      row: storedRow({ avatar_base64: 'A'.repeat(MAX_AVATAR_BASE64_LENGTH + 1) }),
      field: 'avatar_base64',
      code: 'too_big',
    },
    {
      name: 'an avatar hash that is not lowercase',
      row: storedRow({ avatar_hash: AVATAR_HASH.toUpperCase() }),
      field: 'avatar_hash',
      code: 'invalid_format',
    },
    {
      name: 'an avatar without its hash',
      row: storedRow({ avatar_hash: null }),
      field: 'avatar_hash',
      code: 'custom',
    },
    {
      name: 'a hash without its avatar',
      row: storedRow({ avatar_base64: null }),
      field: 'avatar_hash',
      code: 'custom',
    },
    {
      name: 'an account id out of range',
      row: storedRow({ account_id: 4_294_967_296 }),
      field: 'account_id',
      code: 'custom',
    },
    {
      name: 'a time that is not an integer',
      row: storedRow({ linked_at: 'yesterday' }),
      field: 'linked_at',
      code: 'invalid_type',
    },
  ])('reports $name as a storage error that names no value', async ({ row, field, code }) => {
    const repository = new LinkedAccountRepository(databaseReturning([row]), new MemoryLogger());

    const failure = await failureOf(() => repository.getLinkedAccount());

    expect(failure).toMatchObject({ kind: 'storage', context: { field, code } });
    // Neither the persona name nor the avatar nor the hash may travel in the error.
    const text = textOf(failure);
    expect(text).not.toContain('Test Player');
    expect(text).not.toContain(AVATAR_HASH);
    expect(text).not.toContain('yesterday');
  });

  it('keeps at most one row', async () => {
    const { repository, database } = createRepository();
    await repository.setLinkedAccount(linkedAccount());

    await expect(
      insertRaw(database, [2, OTHER_ACCOUNT_ID, null, null, null, 5, null]),
    ).rejects.toThrow(/CHECK constraint failed/);

    await expect(repository.currentAccountId()).resolves.toBe(ACCOUNT_ID);
  });

  it('refuses an avatar without its hash, and a hash without its avatar', async () => {
    const { repository, database } = createRepository();

    // The repository refuses both before it writes...
    await expect(
      repository.setLinkedAccount(linkedAccount({ avatarHash: null })),
    ).rejects.toMatchObject({ kind: 'storage' });
    await expect(
      repository.setLinkedAccount(linkedAccount({ avatarBase64: null })),
    ).rejects.toMatchObject({ kind: 'storage' });
    // ...and the table refuses them too, whoever writes.
    await expect(insertRaw(database, [1, ACCOUNT_ID, null, 'AAAA', null, 5, null])).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      insertRaw(database, [1, ACCOUNT_ID, null, null, AVATAR_HASH, 5, null]),
    ).rejects.toThrow(/CHECK constraint failed/);

    await expect(repository.getLinkedAccount()).resolves.toBeNull();
  });

  it.each([
    {
      name: 'an uppercase avatar hash',
      account: linkedAccount({ avatarHash: AVATAR_HASH.toUpperCase() }),
      field: 'avatar_hash',
      code: 'invalid_format',
    },
    {
      name: 'a persona name that is too long',
      account: linkedAccount({ personaName: 'x'.repeat(MAX_PERSONA_NAME_LENGTH + 1) }),
      field: 'persona_name',
      code: 'too_big',
    },
    {
      name: 'an empty persona name',
      account: linkedAccount({ personaName: '' }),
      field: 'persona_name',
      code: 'too_small',
    },
    {
      name: 'an avatar that is too long',
      account: linkedAccount({ avatarBase64: 'A'.repeat(MAX_AVATAR_BASE64_LENGTH + 1) }),
      field: 'avatar_base64',
      code: 'too_big',
    },
    {
      name: 'an avatar without its hash',
      account: linkedAccount({ avatarHash: null }),
      field: 'avatar_hash',
      code: 'custom',
    },
    {
      name: 'a link time that is not an integer',
      account: linkedAccount({ linkedAt: 1.5 }),
      field: 'linked_at',
      code: 'invalid_type',
    },
  ])('refuses to save $name, writes nothing and tells nobody', async ({ account, field, code }) => {
    const { repository, database } = createRepository();
    const saved = linkedAccount({ accountId: OTHER_ACCOUNT_ID, personaName: 'Saved Player' });
    await repository.setLinkedAccount(saved);
    const spy = spyOnExecute(database);
    const guarded = new LinkedAccountRepository(spy.database, new MemoryLogger());
    let calls = 0;
    guarded.subscribe(() => {
      calls += 1;
    });

    const failure = await failureOf(() => guarded.setLinkedAccount(account));

    expect(failure).toMatchObject({
      kind: 'storage',
      message: 'The linked account is invalid',
      // Only where the account is wrong and why, never the value.
      context: { field, code },
    });
    expect(textOf(failure)).not.toContain('Test Player');
    expect(textOf(failure)).not.toContain(AVATAR_HASH.toUpperCase());
    expect(textOf(failure)).not.toContain('xxxxxxxx');
    // Nothing reached the database, the row is the one saved before, and nobody was told.
    expect(spy.sql).toEqual([]);
    await expect(repository.getLinkedAccount()).resolves.toEqual(saved);
    expect(calls).toBe(0);
  });

  it.each([
    { name: 'an account id of 0', values: [1, 0, null, null, null, 5, null] },
    { name: 'an account id beyond 32 bits', values: [1, 4_294_967_296, null, null, null, 5, null] },
    { name: 'a hash of 39 characters', values: [1, 5, null, 'AAAA', 'a'.repeat(39), 5, null] },
    {
      name: 'an avatar beyond the limit',
      values: [1, 5, null, 'A'.repeat(MAX_AVATAR_BASE64_LENGTH + 1), AVATAR_HASH, 5, null],
    },
    { name: 'a missing link time', values: [1, 5, null, null, null, null, null] },
    { name: 'a link time that is a text', values: [1, 5, null, null, null, 'yesterday', null] },
  ])('has the table refuse $name', async ({ values }) => {
    const { database } = createRepository();

    await expect(insertRaw(database, values)).rejects.toThrow();

    await expect(database.select('SELECT id FROM linked_account')).resolves.toEqual([]);
  });

  it('stores an avatar of the largest accepted size', async () => {
    const { repository } = createRepository();
    const account = linkedAccount({ avatarBase64: 'A'.repeat(MAX_AVATAR_BASE64_LENGTH) });

    await repository.setLinkedAccount(account);

    await expect(repository.getLinkedAccount()).resolves.toEqual(account);
  });

  it('tells its listeners when the account changes, even when one listener fails', async () => {
    const { repository, logger } = createRepository();
    let calls = 0;
    repository.subscribe(() => {
      throw new Error('listener failure');
    });
    const unsubscribe = repository.subscribe(() => {
      calls += 1;
    });

    await repository.setLinkedAccount(linkedAccount());
    await repository.clearLinkedAccount();

    // The failing listener comes first and does not keep the second one uninformed.
    expect(calls).toBe(2);
    expect(logger.entries).toHaveLength(2);
    expect(logger.entries[0]).toMatchObject({
      level: 'warn',
      scope: 'account',
      context: { kind: 'unexpected', cause: 'listener failure' },
    });

    unsubscribe();
    await repository.setLinkedAccount(linkedAccount());

    expect(calls).toBe(2);
  });

  it('tells its listeners after the change is stored, not before', async () => {
    const { repository } = createRepository();
    const reads: Promise<AccountId | null>[] = [];
    repository.subscribe(() => {
      // The listeners of the interface read the account again as soon as they are told.
      reads.push(repository.currentAccountId());
    });

    await repository.setLinkedAccount(linkedAccount());
    await expect(Promise.all(reads)).resolves.toEqual([ACCOUNT_ID]);

    await repository.clearLinkedAccount();
    await expect(Promise.all(reads)).resolves.toEqual([ACCOUNT_ID, null]);
  });

  it('reports a database failure as a storage error and tells nobody', async () => {
    const logger = new MemoryLogger();
    const repository = new LinkedAccountRepository(BROKEN_DATABASE, logger);
    let calls = 0;
    repository.subscribe(() => {
      calls += 1;
    });

    for (const attempt of [
      () => repository.getLinkedAccount(),
      () => repository.currentAccountId(),
      () => repository.setLinkedAccount(linkedAccount()),
      () => repository.clearLinkedAccount(),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        kind: 'storage',
        cause: new Error('disk I/O error'),
      });
    }

    expect(calls).toBe(0);
    expect(logger.entries).toEqual([]);
  });

  describe('rank', () => {
    it('has no rank before one is fetched', async () => {
      const { repository, database } = createRepository();

      // No account linked at all.
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();

      // An account just linked: the first insert leaves both columns empty.
      await repository.setLinkedAccount(linkedAccount());

      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();
      await expect(storedRank(database)).resolves.toEqual({
        rank_badge: null,
        rank_fetched_at: null,
      });
    });

    it('reads back the rank', async () => {
      const { repository, database } = createRepository();
      const account = linkedAccount();
      await repository.setLinkedAccount(account);

      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);

      await expect(repository.getRank(ACCOUNT_ID)).resolves.toEqual({
        badge: RANK_BADGE,
        fetchedAt: RANK_FETCHED_AT,
      });
      await expect(storedRank(database)).resolves.toEqual({
        rank_badge: RANK_BADGE,
        rank_fetched_at: RANK_FETCHED_AT,
      });
      // The rank is not part of the profile that the link reads back.
      await expect(repository.getLinkedAccount()).resolves.toEqual(account);
    });

    it('reads back an unranked player, whose badge is 0', async () => {
      const { repository } = createRepository();
      await repository.setLinkedAccount(linkedAccount());

      await repository.setRank(ACCOUNT_ID, 0, RANK_FETCHED_AT);

      // An unranked player is a known rank, not a missing one.
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toEqual({
        badge: 0,
        fetchedAt: RANK_FETCHED_AT,
      });
    });

    it('replaces the rank in one statement', async () => {
      const { repository, database } = createRepository();
      await repository.setLinkedAccount(linkedAccount());
      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);
      const spy = spyOnExecute(database);

      await new LinkedAccountRepository(spy.database, new MemoryLogger()).setRank(
        ACCOUNT_ID,
        116,
        RANK_FETCHED_AT + 86_400_000,
      );

      expect(spy.sql).toHaveLength(1);
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toEqual({
        badge: 116,
        fetchedAt: RANK_FETCHED_AT + 86_400_000,
      });
    });

    it('keeps the rank when the same account is saved again', async () => {
      const { repository } = createRepository();
      await repository.setLinkedAccount(linkedAccount());
      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);

      // The daily refresh of the profile saves the same account with a new name and a new date.
      const refreshed = linkedAccount({
        personaName: 'Renamed Player',
        profileFetchedAt: 1_700_086_500_000,
      });
      await repository.setLinkedAccount(refreshed);

      await expect(repository.getLinkedAccount()).resolves.toEqual(refreshed);
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toEqual({
        badge: RANK_BADGE,
        fetchedAt: RANK_FETCHED_AT,
      });
    });

    it('clears the rank when another account is linked', async () => {
      const { repository, database } = createRepository();
      await repository.setLinkedAccount(linkedAccount());
      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);

      await repository.setLinkedAccount(linkedAccount({ accountId: OTHER_ACCOUNT_ID }));

      // The rank of the first account must not be taken for the rank of the second one.
      await expect(repository.getRank(OTHER_ACCOUNT_ID)).resolves.toBeNull();
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();
      await expect(storedRank(database)).resolves.toEqual({
        rank_badge: null,
        rank_fetched_at: null,
      });

      // The second account can have its own rank, and the first one is still out.
      await repository.setRank(OTHER_ACCOUNT_ID, 21, RANK_FETCHED_AT);

      await expect(repository.getRank(OTHER_ACCOUNT_ID)).resolves.toEqual({
        badge: 21,
        fetchedAt: RANK_FETCHED_AT,
      });
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();
    });

    it('clears the rank of the link that is saved again after an unlink', async () => {
      const { repository } = createRepository();
      await repository.setLinkedAccount(linkedAccount());
      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);

      // The row is deleted: linking the same account again is a first insert, with no rank.
      await repository.clearLinkedAccount();
      await repository.setLinkedAccount(linkedAccount());

      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();
    });

    it('answers null for an account that is not the linked one', async () => {
      const { repository } = createRepository();
      await repository.setLinkedAccount(linkedAccount());
      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);

      await expect(repository.getRank(OTHER_ACCOUNT_ID)).resolves.toBeNull();
    });

    it('writes nothing for another account', async () => {
      const { repository, database } = createRepository();

      // No account linked: there is no row to update.
      await expect(
        repository.setRank(OTHER_ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT),
      ).resolves.toBeUndefined();
      await expect(database.select('SELECT id FROM linked_account')).resolves.toEqual([]);

      // Another account linked: its row is left as it is.
      await repository.setLinkedAccount(linkedAccount());
      await expect(
        repository.setRank(OTHER_ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT),
      ).resolves.toBeUndefined();

      await expect(storedRank(database)).resolves.toEqual({
        rank_badge: null,
        rank_fetched_at: null,
      });
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();
      await expect(repository.getRank(OTHER_ACCOUNT_ID)).resolves.toBeNull();
    });

    it('does not notify', async () => {
      const { repository } = createRepository();
      await repository.setLinkedAccount(linkedAccount());
      let calls = 0;
      repository.subscribe(() => {
        calls += 1;
      });

      // Neither a rank that is written nor a write for another account tells the listeners: the
      // rank is not part of what they read again.
      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);
      await repository.setRank(OTHER_ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);

      expect(calls).toBe(0);
    });

    it('reads the rank even when the profile is damaged', async () => {
      const { repository, database } = createRepository();
      await insertRaw(database, [1, ACCOUNT_ID, 'Test Player', 'AAAA', 'z'.repeat(40), 5, null]);
      await repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT);

      // The rank reader needs the account id and the rank only.
      await expect(repository.getRank(ACCOUNT_ID)).resolves.toEqual({
        badge: RANK_BADGE,
        fetchedAt: RANK_FETCHED_AT,
      });
    });

    it.each([
      { name: 'a badge without a fetch time', badge: RANK_BADGE, fetchedAt: null },
      { name: 'a fetch time without a badge', badge: null, fetchedAt: RANK_FETCHED_AT },
    ])('answers null for $name', async ({ badge, fetchedAt }) => {
      const { repository, database } = createRepository();
      await repository.setLinkedAccount(linkedAccount());
      // The table accepts both columns apart; only a complete pair is a rank that was fetched.
      await database.execute(
        'UPDATE linked_account SET rank_badge = $1, rank_fetched_at = $2 WHERE id = $3',
        [badge, fetchedAt, 1],
      );

      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();
    });

    it.each([
      {
        name: 'a badge above the highest one',
        row: rankRow({ rank_badge: 117 }),
        field: 'rank_badge',
        code: 'too_big',
        value: '117',
      },
      {
        name: 'a negative badge',
        row: rankRow({ rank_badge: -1 }),
        field: 'rank_badge',
        code: 'too_small',
        value: '-1',
      },
      {
        name: 'a badge that is a text',
        row: rankRow({ rank_badge: 'diamond' }),
        field: 'rank_badge',
        code: 'invalid_type',
        value: 'diamond',
      },
      {
        name: 'a badge that is not an integer',
        row: rankRow({ rank_badge: 53.5 }),
        field: 'rank_badge',
        code: 'invalid_type',
        value: '53.5',
      },
      {
        name: 'a fetch time that is a text',
        row: rankRow({ rank_fetched_at: 'yesterday' }),
        field: 'rank_fetched_at',
        code: 'invalid_type',
        value: 'yesterday',
      },
      {
        name: 'a fetch time that is not an integer',
        row: rankRow({ rank_fetched_at: 1_700_000_200_000.5 }),
        field: 'rank_fetched_at',
        code: 'invalid_type',
        value: '1700000200000.5',
      },
      {
        name: 'an account id out of range',
        row: rankRow({ account_id: 4_294_967_296 }),
        field: 'account_id',
        code: 'custom',
        value: '4294967296',
      },
    ])(
      'reports $name as a storage error that names no value',
      async ({ row, field, code, value }) => {
        const repository = new LinkedAccountRepository(
          databaseReturning([row]),
          new MemoryLogger(),
        );

        const failure = await failureOf(() => repository.getRank(ACCOUNT_ID));

        expect(failure).toMatchObject({
          kind: 'storage',
          message: 'The stored rank is invalid',
          // Only where the row is wrong and why, never the value.
          context: { field, code },
        });
        expect(textOf(failure)).not.toContain(value);
        expect(textOf(failure)).not.toContain(String(ACCOUNT_ID));
      },
    );

    it.each([
      {
        name: 'a badge above the highest one',
        badge: 117,
        fetchedAt: RANK_FETCHED_AT,
        field: 'rank_badge',
        code: 'too_big',
        value: '117',
      },
      {
        name: 'a negative badge',
        badge: -1,
        fetchedAt: RANK_FETCHED_AT,
        field: 'rank_badge',
        code: 'too_small',
        value: '-1',
      },
      {
        name: 'a badge that is not an integer',
        badge: 53.5,
        fetchedAt: RANK_FETCHED_AT,
        field: 'rank_badge',
        code: 'invalid_type',
        value: '53.5',
      },
      {
        name: 'a badge that is not a number',
        badge: Number.NaN,
        fetchedAt: RANK_FETCHED_AT,
        field: 'rank_badge',
        code: 'invalid_type',
        value: 'NaN',
      },
      {
        name: 'a fetch time that is not an integer',
        badge: RANK_BADGE,
        fetchedAt: 1_700_000_200_000.5,
        field: 'rank_fetched_at',
        code: 'invalid_type',
        value: '1700000200000.5',
      },
      {
        name: 'a fetch time that is infinite',
        badge: RANK_BADGE,
        fetchedAt: Number.POSITIVE_INFINITY,
        field: 'rank_fetched_at',
        code: 'invalid_type',
        value: 'Infinity',
      },
    ])(
      'refuses to save $name, writes nothing and tells nobody',
      async ({ badge, fetchedAt, field, code, value }) => {
        const { repository, database } = createRepository();
        await repository.setLinkedAccount(linkedAccount());
        await repository.setRank(ACCOUNT_ID, 21, RANK_FETCHED_AT);
        const spy = spyOnExecute(database);
        const guarded = new LinkedAccountRepository(spy.database, new MemoryLogger());
        let calls = 0;
        guarded.subscribe(() => {
          calls += 1;
        });

        const failure = await failureOf(() => guarded.setRank(ACCOUNT_ID, badge, fetchedAt));

        expect(failure).toMatchObject({
          kind: 'storage',
          message: 'The rank is invalid',
          // Only where the rank is wrong and why, never the value.
          context: { field, code },
        });
        expect(textOf(failure)).not.toContain(value);
        // Nothing reached the database, the rank is the one saved before, and nobody was told.
        expect(spy.sql).toEqual([]);
        await expect(repository.getRank(ACCOUNT_ID)).resolves.toEqual({
          badge: 21,
          fetchedAt: RANK_FETCHED_AT,
        });
        expect(calls).toBe(0);
      },
    );

    it('stores the lowest and the highest badge', async () => {
      const { repository } = createRepository();
      await repository.setLinkedAccount(linkedAccount());

      for (const badge of [0, 116]) {
        await repository.setRank(ACCOUNT_ID, badge, RANK_FETCHED_AT);

        await expect(repository.getRank(ACCOUNT_ID)).resolves.toEqual({
          badge,
          fetchedAt: RANK_FETCHED_AT,
        });
      }
    });

    it('has the table refuse a badge out of range, whoever writes', async () => {
      const { repository, database } = createRepository();
      await repository.setLinkedAccount(linkedAccount());

      for (const badge of [-1, 117]) {
        await expect(
          database.execute('UPDATE linked_account SET rank_badge = $1 WHERE id = $2', [badge, 1]),
        ).rejects.toThrow(/CHECK constraint failed/);
      }

      await expect(repository.getRank(ACCOUNT_ID)).resolves.toBeNull();
    });

    it('reports a database failure as a storage error and tells nobody', async () => {
      const logger = new MemoryLogger();
      const repository = new LinkedAccountRepository(BROKEN_DATABASE, logger);
      let calls = 0;
      repository.subscribe(() => {
        calls += 1;
      });

      for (const attempt of [
        () => repository.getRank(ACCOUNT_ID),
        () => repository.setRank(ACCOUNT_ID, RANK_BADGE, RANK_FETCHED_AT),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          kind: 'storage',
          cause: new Error('disk I/O error'),
        });
      }

      expect(calls).toBe(0);
      expect(logger.entries).toEqual([]);
    });
  });
});

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
});

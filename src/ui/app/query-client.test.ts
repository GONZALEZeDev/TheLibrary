/**
 * Tests of the TanStack Query client of the application: its defaults, its retry rule and the log
 * line written for every failed query and mutation.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../adapters/dev/memory-logger.adapter';
import { AppError } from '../../core/errors/app-error';
import { createQueryClient, keyName, shouldRetry } from './query-client';

describe('shouldRetry', () => {
  it.each(['network', 'timeout', 'rate_limited', 'service_unavailable'] as const)(
    'retries a %s error twice, then gives up',
    (kind) => {
      const error = new AppError(kind, 'transient failure');

      expect(shouldRetry(0, error)).toBe(true);
      expect(shouldRetry(1, error)).toBe(true);
      expect(shouldRetry(2, error)).toBe(false);
      expect(shouldRetry(3, error)).toBe(false);
    },
  );

  it.each(['storage', 'unexpected', 'not_found', 'forbidden', 'invalid_payload'] as const)(
    'never retries a %s error, which a new attempt would not fix',
    (kind) => {
      expect(shouldRetry(0, new AppError(kind, 'permanent failure'))).toBe(false);
    },
  );

  it('counts a value that is not an AppError as unexpected', () => {
    expect(shouldRetry(0, new TypeError('x is undefined'))).toBe(false);
    expect(shouldRetry(0, 'plugin string rejection')).toBe(false);
  });
});

describe('keyName', () => {
  it('keeps the leading string segments of a key and drops its parameters', () => {
    expect(keyName(['settings'])).toBe('settings');
    expect(keyName(['matches', 'recent'])).toBe('matches.recent');
    expect(keyName(['matches', { hero: 67 }, 'page'])).toBe('matches');
    expect(keyName(['match', 108501737])).toBe('match');
    expect(keyName([])).toBe('');
  });
});

describe('createQueryClient defaults', () => {
  it('runs queries and mutations offline and does not refetch when the window regains focus', () => {
    const defaults = createQueryClient({ logger: new MemoryLogger() }).getDefaultOptions();

    expect(defaults.queries).toMatchObject({ networkMode: 'always', refetchOnWindowFocus: false });
    expect(defaults.mutations).toMatchObject({ networkMode: 'always' });
  });

  it('retries queries with the retry rule of the application', () => {
    const defaults = createQueryClient({ logger: new MemoryLogger() }).getDefaultOptions();

    expect(defaults.queries?.retry).toBe(shouldRetry);
  });
});

describe('createQueryClient failure logging', () => {
  it('logs a failed query once, with its kind, cause and key', async () => {
    const logger = new MemoryLogger();
    const queryClient = createQueryClient({ logger });
    const failure = new AppError('storage', 'Could not read the settings', {
      cause: 'store is locked',
    });

    await expect(
      queryClient.query({
        queryKey: ['settings'],
        queryFn: () => Promise.reject(failure),
        retry: false,
      }),
    ).rejects.toBe(failure);

    expect(logger.entries).toEqual([
      {
        level: 'error',
        scope: 'query',
        message: 'Could not read the settings',
        context: {
          kind: 'storage',
          cause: 'store is locked',
          stack: expect.stringContaining('Could not read the settings') as unknown,
          query: 'settings',
        },
      },
    ]);
  });

  it('logs a query once however many attempts it took, not at every retry', async () => {
    const logger = new MemoryLogger();
    const queryClient = createQueryClient({ logger });
    let attempts = 0;

    await expect(
      queryClient.query({
        queryKey: ['matches', { hero: 67 }],
        queryFn: () => {
          attempts += 1;
          return Promise.reject(new AppError('network', 'GET /v1/matches failed'));
        },
        // The retry rule of the application, without its waiting time.
        retry: shouldRetry,
        retryDelay: 0,
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(attempts).toBe(3);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      scope: 'query',
      context: { kind: 'network', query: 'matches' },
    });
  });

  it('logs a failed mutation once, with its kind and key', async () => {
    const logger = new MemoryLogger();
    const queryClient = createQueryClient({ logger });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: ['settings', 'language'],
      mutationFn: () => Promise.reject(new AppError('storage', 'Could not save the settings')),
    });

    await expect(mutation.execute('fr')).rejects.toBeInstanceOf(AppError);

    expect(logger.entries).toEqual([
      {
        level: 'error',
        scope: 'mutation',
        message: 'Could not save the settings',
        context: {
          kind: 'storage',
          stack: expect.stringContaining('Could not save the settings') as unknown,
          mutation: 'settings.language',
        },
      },
    ]);
  });

  it('logs a mutation without a key, and a failure that is not an AppError, as unexpected', async () => {
    const logger = new MemoryLogger();
    const queryClient = createQueryClient({ logger });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => Promise.reject(new Error('disk full')),
    });

    await expect(mutation.execute(undefined)).rejects.toThrow('disk full');

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      scope: 'mutation',
      message: 'disk full',
      context: { kind: 'unexpected', cause: 'disk full' },
    });
    expect(logger.entries[0]?.context).not.toHaveProperty('mutation');
  });
});

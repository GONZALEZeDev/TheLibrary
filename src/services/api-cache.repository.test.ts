/**
 * Tests of the storage of cached API responses, on an in-memory database.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { Database } from '../ports/database.port';
import { createTestDatabase } from '../test/test-data';
import { ApiCacheRepository } from './api-cache.repository';

describe('ApiCacheRepository', () => {
  it('returns null when nothing is cached', async () => {
    await expect(new ApiCacheRepository(createTestDatabase()).get('heroes')).resolves.toBeNull();
  });

  it('saves an entry, reads it back and replaces it', async () => {
    const repository = new ApiCacheRepository(createTestDatabase());

    await repository.put('heroes', { payloadJson: '[1]', fetchedAt: 1, expiresAt: 2 });
    await repository.put('heroes', { payloadJson: '[2]', fetchedAt: 3, expiresAt: 4 });

    await expect(repository.get('heroes')).resolves.toEqual({
      payloadJson: '[2]',
      fetchedAt: 3,
      expiresAt: 4,
    });
  });

  it('reports a database failure as a storage error', async () => {
    const broken: Database = {
      execute: () => Promise.reject(new Error('database is locked')),
      select: () => Promise.reject(new Error('database is locked')),
    };
    const repository = new ApiCacheRepository(broken);

    await expect(repository.get('heroes')).rejects.toMatchObject({ kind: 'storage' });
    await expect(
      repository.put('heroes', { payloadJson: '[]', fetchedAt: 1, expiresAt: 2 }),
    ).rejects.toMatchObject({ kind: 'storage' });
    await expect(repository.deleteOlderThan('analytics.', 1)).rejects.toMatchObject({
      kind: 'storage',
    });
  });

  describe('deleteOlderThan', () => {
    /**
     * Save entries under the given keys, all fetched at the given time.
     *
     * @param repository - Where to save them.
     * @param keys - The keys of the entries.
     * @param fetchedAt - When they were fetched.
     */
    async function putAll(
      repository: ApiCacheRepository,
      keys: readonly string[],
      fetchedAt: number,
    ): Promise<void> {
      for (const key of keys) {
        await repository.put(key, { payloadJson: '[]', fetchedAt, expiresAt: fetchedAt + 1 });
      }
    }

    /**
     * The keys, among the given ones, that still hold an entry.
     *
     * @param repository - Where to look.
     * @param keys - The keys to check.
     * @returns The keys that are still cached, in the order given.
     */
    async function stillCached(
      repository: ApiCacheRepository,
      keys: readonly string[],
    ): Promise<string[]> {
      const cached: string[] = [];
      for (const key of keys) {
        if ((await repository.get(key)) !== null) {
          cached.push(key);
        }
      }
      return cached;
    }

    it('deletes the entries of a prefix fetched before the limit, and nothing else', async () => {
      const repository = new ApiCacheRepository(createTestDatabase());
      await repository.put('analytics.a', { payloadJson: '[]', fetchedAt: 10, expiresAt: 11 });
      await repository.put('analytics.b', { payloadJson: '[]', fetchedAt: 20, expiresAt: 21 });
      await repository.put('analytics.c', { payloadJson: '[]', fetchedAt: 30, expiresAt: 31 });
      // Another prefix: kept, however old.
      await repository.put('heroes.english', { payloadJson: '[]', fetchedAt: 1, expiresAt: 2 });

      await repository.deleteOlderThan('analytics.', 20);

      // The limit itself stays: only an entry fetched strictly before it goes.
      await expect(
        stillCached(repository, ['analytics.a', 'analytics.b', 'analytics.c', 'heroes.english']),
      ).resolves.toEqual(['analytics.b', 'analytics.c', 'heroes.english']);
    });

    it('does nothing when no entry is old enough', async () => {
      const repository = new ApiCacheRepository(createTestDatabase());
      await putAll(repository, ['analytics.a'], 10);

      await expect(repository.deleteOlderThan('analytics.', 10)).resolves.toBeUndefined();

      await expect(stillCached(repository, ['analytics.a'])).resolves.toEqual(['analytics.a']);
    });

    it.each([
      // `_` stands for any one character in a pattern, `%` for any run, and `\` escapes them.
      { wildcard: '_', prefix: 'a_b.', matching: 'a_b.x', decoy: 'aXb.x' },
      { wildcard: '%', prefix: '100%.', matching: '100%.x', decoy: '1000.x' },
      { wildcard: '\\', prefix: 'a\\b.', matching: 'a\\b.x', decoy: 'ab.x' },
    ])(
      'reads the prefix literally when it holds a $wildcard',
      async ({ prefix, matching, decoy }) => {
        const repository = new ApiCacheRepository(createTestDatabase());
        await putAll(repository, [matching, decoy], 1);

        await repository.deleteOlderThan(prefix, 2);

        await expect(stillCached(repository, [matching, decoy])).resolves.toEqual([decoy]);
      },
    );
  });
});

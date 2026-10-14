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
  });
});

/**
 * Tests of the hero catalogue: cache freshness, refresh and offline fallback.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { AppError } from '../core/errors/app-error';
import { createTestDatabase } from '../test/test-data';
import { ApiCacheRepository } from './api-cache.repository';
import { DeadlockApiService } from './deadlock-api.service';
import { HeroCatalogService } from './hero-catalog.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 24 * 60 * 60_000;

/**
 * Build the catalogue service on a shared database, with a controllable clock and handler.
 *
 * @returns The service, its HTTP client and logger, the clock, and a way to change the handler.
 */
function setUp() {
  const clock = { now: START };
  const answer: { handler: FixtureHandler } = { handler: createFixtureApi({ now: START }) };
  const http = new FixtureHttpClient((request) => answer.handler(request));
  const logger = new MemoryLogger();
  const database = createTestDatabase();
  const now = () => clock.now;
  const api = new DeadlockApiService(http, new SyncStateRepository(database, logger, now), logger, {
    appVersion: '0.1.0',
    now,
  });
  const catalog = new HeroCatalogService(api, new ApiCacheRepository(database), logger, now);
  return { catalog, http, logger, clock, answer };
}

describe('HeroCatalogService', () => {
  it('downloads the catalogue once, then serves it from the cache for a week', async () => {
    const { catalog, http, clock } = setUp();

    const heroes = await catalog.getHeroes();
    clock.now += 6 * DAY;
    await catalog.getHeroes();

    expect(heroes).toContainEqual({ id: 67, name: 'Paige' });
    expect(http.requests).toHaveLength(1);
  });

  it('downloads it again after a week', async () => {
    const { catalog, http, clock } = setUp();

    await catalog.getHeroes();
    clock.now += 7 * DAY + 1;
    await catalog.getHeroes();

    expect(http.requests).toHaveLength(2);
  });

  it('keeps using the old catalogue when it cannot be refreshed, and logs it', async () => {
    const { catalog, clock, logger, answer } = setUp();
    const heroes = await catalog.getHeroes();
    clock.now += 30 * DAY;
    answer.handler = () => {
      throw new AppError('network', 'The request failed');
    };

    await expect(catalog.getHeroes()).resolves.toEqual(heroes);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Could not refresh the hero catalogue, using the cached one',
      }),
    );
  });

  it('fails when there is no catalogue at all', async () => {
    const { catalog, answer } = setUp();
    answer.handler = () => jsonResponse({}, 500);

    await expect(catalog.getHeroes()).rejects.toMatchObject({ kind: 'service_unavailable' });
  });
});

/**
 * Tests of the hero catalogue: cache freshness, refresh and offline fallback, and the guard that
 * keeps the app silent while no account is linked.
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
import type { AccountId } from '../core/domain/account';
import { AppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import { createTestDatabase, testAccountId } from '../test/test-data';
import { ApiCacheRepository } from './api-cache.repository';
import { DeadlockApiService } from './deadlock-api.service';
import { HeroCatalogService } from './hero-catalog.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 24 * 60 * 60_000;
const ACCOUNT_ID = testAccountId(1000001);

/**
 * Build the catalogue service on a shared database, with a controllable clock, handler and linked
 * account. An account is linked unless a test unlinks it.
 *
 * @returns The service, its HTTP client and logger, the clock, a way to change the handler, and the
 *   linked account: set `link.accountId` to `null` to unlink it, or `link.failure` to make the
 *   link unreadable.
 */
function setUp() {
  const clock = { now: START };
  const answer: { handler: FixtureHandler } = { handler: createFixtureApi({ now: START }) };
  const link: { accountId: AccountId | null; failure: AppError | null } = {
    accountId: ACCOUNT_ID,
    failure: null,
  };
  const accountSource: AccountSource = {
    currentAccountId: () =>
      link.failure === null ? Promise.resolve(link.accountId) : Promise.reject(link.failure),
  };
  const http = new FixtureHttpClient((request) => answer.handler(request));
  const logger = new MemoryLogger();
  const database = createTestDatabase();
  const now = () => clock.now;
  const api = new DeadlockApiService(http, new SyncStateRepository(database, logger, now), logger, {
    appVersion: '0.1.0',
    now,
  });
  const catalog = new HeroCatalogService(
    accountSource,
    api,
    new ApiCacheRepository(database),
    logger,
    now,
  );
  return { catalog, http, logger, clock, answer, link };
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

  it('still serves a catalogue downloaded at this very moment from the cache', async () => {
    const { catalog, http } = setUp();

    await catalog.getHeroes();
    await catalog.getHeroes();

    expect(http.requests).toHaveLength(1);
  });

  it('downloads it again when the system clock moved backwards since it was cached', async () => {
    const { catalog, http, clock, answer } = setUp();
    await catalog.getHeroes();
    clock.now -= 60 * 60_000;
    answer.handler = () => jsonResponse([{ id: 99, name: 'Newcomer' }]);

    const heroes = await catalog.getHeroes();

    expect(http.requests).toHaveLength(2);
    expect(heroes).toEqual([{ id: 99, name: 'Newcomer' }]);
  });

  it('uses a catalogue dated in the future when it cannot be downloaded again', async () => {
    const { catalog, clock, answer } = setUp();
    const heroes = await catalog.getHeroes();
    clock.now -= 60 * 60_000;
    answer.handler = () => {
      throw new AppError('network', 'The request failed');
    };

    await expect(catalog.getHeroes()).resolves.toEqual(heroes);
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

  describe('without a linked account', () => {
    it('sends no request without a linked account', async () => {
      const { catalog, http, link } = setUp();
      link.accountId = null;

      await expect(catalog.getHeroes()).resolves.toEqual([]);

      expect(http.requests).toHaveLength(0);
    });

    it('gives the cached catalogue without a linked account', async () => {
      const { catalog, http, clock, link } = setUp();
      const heroes = await catalog.getHeroes();
      // Long past its week of freshness: with an account, it would be downloaded again.
      clock.now += 30 * DAY;
      link.accountId = null;

      await expect(catalog.getHeroes()).resolves.toEqual(heroes);

      expect(http.requests).toHaveLength(1);
    });

    it('downloads the catalogue once an account is linked', async () => {
      const { catalog, http, link } = setUp();
      link.accountId = null;
      // Without an account, nothing is downloaded: this call would fill the cache if it did.
      await expect(catalog.getHeroes()).resolves.toEqual([]);
      expect(http.requests).toHaveLength(0);

      link.accountId = ACCOUNT_ID;
      const heroes = await catalog.getHeroes();

      expect(http.requests).toHaveLength(1);
      expect(heroes).toContainEqual({ id: 67, name: 'Paige' });
    });

    it('does not take an unreadable linked account for no account', async () => {
      const { catalog, http, logger, link } = setUp();
      await catalog.getHeroes();
      const logged = logger.entries.length;
      link.failure = new AppError('storage', 'The linked account is invalid');

      // Like any other failure of the catalogue, it is the caller's to handle (the screen retries).
      await expect(catalog.getHeroes()).rejects.toBe(link.failure);

      expect(http.requests).toHaveLength(1);
      expect(logger.entries).toHaveLength(logged);
    });
  });
});

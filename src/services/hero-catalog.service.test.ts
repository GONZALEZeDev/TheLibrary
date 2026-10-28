/**
 * Tests of the hero catalogue: cache freshness, refresh and offline fallback, the portraits and
 * loadouts it keeps, and the guard that keeps the app silent while no account is linked.
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
import { ASSET_IMAGE_ORIGIN } from '../core/deadlock-api/assets.schema';
import type { AccountId } from '../core/domain/account';
import { PAIGE_HERO_ID } from '../core/domain/hero';
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
 * @returns The service, its HTTP client and logger, the cache it keeps the catalogue in, the clock,
 *   a way to change the handler, and the linked account: set `link.accountId` to `null` to unlink
 *   it, or `link.failure` to make the link unreadable.
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
  const cache = new ApiCacheRepository(database);
  const catalog = new HeroCatalogService({ accountSource, api, cache, logger, now });
  return { catalog, http, logger, cache, clock, answer, link };
}

/** Cache key of the catalogue (the service's own, which is not exported). */
const CACHE_KEY = 'heroes.english.v2';

/** Paige as the fixture catalogue describes her: her portrait and her real loadout. */
const PAIGE_ASSET = {
  id: PAIGE_HERO_ID,
  name: 'Paige',
  imageUrl: `${ASSET_IMAGE_ORIGIN}assets-api-res/images/heroes/bookworm_sm.webp`,
  loadout: {
    weapon: 'citadel_weapon_bookworm_set2',
    melee: 'ability_melee_bookworm',
    abilities: [
      'ability_bookworm_dragonfire',
      'ability_bookworm_knightbarrier',
      'ability_bookworm_aoemagic',
      'ability_bookworm_knightcharge',
    ],
  },
};

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

  describe('portraits and loadouts', () => {
    it('keeps images and loadouts in the cache', async () => {
      const { catalog, http, clock } = setUp();
      const downloaded = await catalog.getHeroAssets();
      clock.now += DAY;

      const cached = await catalog.getHeroAssets();

      // The second read comes from the cache, so the portrait and the loadout went through it.
      expect(http.requests).toHaveLength(1);
      expect(cached).toEqual(downloaded);
      expect(cached.find((hero) => hero.id === PAIGE_HERO_ID)).toEqual(PAIGE_ASSET);
    });

    it('keeps a hero without portrait or loadout as it is', async () => {
      const { catalog, http, answer } = setUp();
      answer.handler = () => jsonResponse([{ id: 99, name: 'Newcomer' }]);
      await catalog.getHeroAssets();

      const cached = await catalog.getHeroAssets();

      expect(http.requests).toHaveLength(1);
      expect(cached).toEqual([{ id: 99, name: 'Newcomer', imageUrl: null, loadout: null }]);
    });

    it('uses the cached images and loadouts when the catalogue cannot be refreshed', async () => {
      const { catalog, clock, answer } = setUp();
      await catalog.getHeroAssets();
      clock.now += 30 * DAY;
      answer.handler = () => {
        throw new AppError('network', 'The request failed');
      };

      const heroes = await catalog.getHeroAssets();

      expect(heroes.find((hero) => hero.id === PAIGE_HERO_ID)).toEqual(PAIGE_ASSET);
    });

    it('downloads again over an entry written before M4b', async () => {
      const { catalog, http, logger, cache } = setUp();
      // Before M4b, the cache held names only; the entry is fresh, so it would be served if it fit.
      await cache.put(CACHE_KEY, {
        payloadJson: JSON.stringify([{ id: PAIGE_HERO_ID, name: 'Paige' }]),
        fetchedAt: START,
        expiresAt: START + 7 * DAY,
      });

      const heroes = await catalog.getHeroAssets();

      expect(http.requests).toHaveLength(1);
      expect(heroes.find((hero) => hero.id === PAIGE_HERO_ID)).toEqual(PAIGE_ASSET);
      // An old entry is no problem to report: it is replaced without a warning (the download itself
      // only logs at debug level).
      expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
    });

    it('replaces an entry written before M4b with one that fits', async () => {
      const { catalog, http, cache } = setUp();
      await cache.put(CACHE_KEY, {
        payloadJson: JSON.stringify([{ id: PAIGE_HERO_ID, name: 'Paige' }]),
        fetchedAt: START,
        expiresAt: START + 7 * DAY,
      });
      await catalog.getHeroAssets();

      await expect(catalog.getHeroAssets()).resolves.toContainEqual(PAIGE_ASSET);

      expect(http.requests).toHaveLength(1);
    });

    it('fails over an entry written before M4b when the catalogue cannot be downloaded', async () => {
      const { catalog, http, logger, cache, answer } = setUp();
      await cache.put(CACHE_KEY, {
        payloadJson: JSON.stringify([{ id: PAIGE_HERO_ID, name: 'Paige' }]),
        fetchedAt: START,
        expiresAt: START + 7 * DAY,
      });
      const failure = new AppError('network', 'The request failed');
      answer.handler = () => {
        throw failure;
      };

      // The old entry is nothing cached: there is no stale catalogue to fall back on, so the failed
      // download is the answer, for the bare heroes too.
      await expect(catalog.getHeroAssets()).rejects.toMatchObject({ kind: 'network' });
      await expect(catalog.getHeroes()).rejects.toMatchObject({ kind: 'network' });

      expect(http.requests).toHaveLength(2);
      // Nothing is logged: the failure is the caller's to handle, and the old entry no problem.
      expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
      // The old entry is left as it was, for the next download to replace.
      await expect(cache.get(CACHE_KEY)).resolves.toMatchObject({
        payloadJson: JSON.stringify([{ id: PAIGE_HERO_ID, name: 'Paige' }]),
      });
    });

    it.each([
      [
        'a portrait off the asset bucket',
        { ...PAIGE_ASSET, imageUrl: 'https://example.net/bookworm_sm.webp' },
      ],
      [
        'a portrait on a look-alike host',
        { ...PAIGE_ASSET, imageUrl: 'https://assets-bucket.deadlock-api.com.example.net/x.webp' },
      ],
      [
        'three signature abilities',
        {
          ...PAIGE_ASSET,
          loadout: { ...PAIGE_ASSET.loadout, abilities: PAIGE_ASSET.loadout.abilities.slice(0, 3) },
        },
      ],
      [
        'five signature abilities',
        {
          ...PAIGE_ASSET,
          loadout: {
            ...PAIGE_ASSET.loadout,
            abilities: [...PAIGE_ASSET.loadout.abilities, 'ability_bookworm_extra'],
          },
        },
      ],
    ])('downloads again over a cached hero with %s, quietly', async (_name, hero) => {
      const { catalog, http, logger, cache } = setUp();
      // The entry is fresh, so it would be served if it fit. The release only loads images from the
      // asset bucket, and a loadout is four signature abilities, whatever the cache holds.
      await cache.put(CACHE_KEY, {
        payloadJson: JSON.stringify([hero]),
        fetchedAt: START,
        expiresAt: START + 7 * DAY,
      });

      const heroes = await catalog.getHeroAssets();

      expect(http.requests).toHaveLength(1);
      expect(heroes.find((entry) => entry.id === PAIGE_HERO_ID)).toEqual(PAIGE_ASSET);
      expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
    });

    it('gives bare heroes from getHeroes, downloaded or cached', async () => {
      const { catalog } = setUp();

      const downloaded = await catalog.getHeroes();
      const cached = await catalog.getHeroes();

      for (const heroes of [downloaded, cached]) {
        expect(heroes).toContainEqual({ id: PAIGE_HERO_ID, name: 'Paige' });
        // Neither a portrait nor a loadout reaches the callers that only name heroes.
        expect(heroes.every((hero) => Object.keys(hero).length === 2)).toBe(true);
      }
    });
  });

  describe('concurrent calls', () => {
    it('send one request and all get the catalogue', async () => {
      const { catalog, http } = setUp();

      // The match page asks twice for the heroes at once (its header and its damage tab), and a
      // screen that only names heroes asks too: the two methods share their download.
      const [first, second, named] = await Promise.all([
        catalog.getHeroAssets(),
        catalog.getHeroAssets(),
        catalog.getHeroes(),
      ]);

      expect(http.requests).toHaveLength(1);
      expect(first.find((hero) => hero.id === PAIGE_HERO_ID)).toEqual(PAIGE_ASSET);
      expect(second).toEqual(first);
      expect(named).toContainEqual({ id: PAIGE_HERO_ID, name: 'Paige' });
      // The catalogue was cached once, by the one download: a later call is served from it.
      await catalog.getHeroAssets();
      expect(http.requests).toHaveLength(1);
    });

    it('all fail with the one failed download, and the next call tries again', async () => {
      const { catalog, http, answer } = setUp();
      answer.handler = () => jsonResponse({}, 500);

      const outcomes = await Promise.allSettled([catalog.getHeroAssets(), catalog.getHeroes()]);

      expect(outcomes).toMatchObject([
        { status: 'rejected', reason: { kind: 'service_unavailable' } },
        { status: 'rejected', reason: { kind: 'service_unavailable' } },
      ]);
      // One download for both calls: a failure does not stay registered, so nothing is cached.
      const sent = http.requests.length;
      expect(sent).toBe(1);
      answer.handler = createFixtureApi({ now: START });
      const heroes = await catalog.getHeroAssets();
      expect(heroes.find((hero) => hero.id === PAIGE_HERO_ID)).toEqual(PAIGE_ASSET);
      expect(http.requests).toHaveLength(sent + 1);
    });

    it('refresh a stale catalogue once, and say once that they could not', async () => {
      const { catalog, http, logger, clock, answer } = setUp();
      const heroes = await catalog.getHeroAssets();
      clock.now += 30 * DAY;
      answer.handler = () => {
        throw new AppError('network', 'The request failed');
      };

      const results = await Promise.all([catalog.getHeroAssets(), catalog.getHeroAssets()]);

      expect(results).toEqual([heroes, heroes]);
      expect(http.requests).toHaveLength(2);
      expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    });

    it('share nothing once the download is over', async () => {
      const { catalog, http, clock } = setUp();
      await Promise.all([catalog.getHeroAssets(), catalog.getHeroAssets()]);
      clock.now += 7 * DAY;

      await Promise.all([catalog.getHeroAssets(), catalog.getHeroAssets()]);

      // One download for each pair, the second a week after the first.
      expect(http.requests).toHaveLength(2);
    });
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

    it('gives the cached images and loadouts without a linked account', async () => {
      const { catalog, http, clock, link } = setUp();
      const heroes = await catalog.getHeroAssets();
      clock.now += 30 * DAY;
      link.accountId = null;

      await expect(catalog.getHeroAssets()).resolves.toEqual(heroes);

      expect(http.requests).toHaveLength(1);
    });

    it('sends no request for the images and loadouts without a linked account', async () => {
      const { catalog, http, link } = setUp();
      link.accountId = null;

      await expect(catalog.getHeroAssets()).resolves.toEqual([]);

      expect(http.requests).toHaveLength(0);
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

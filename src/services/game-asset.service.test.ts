/**
 * Tests of the game asset service: the item and rank catalogues, their indexes, the cache
 * freshness, the offline fallback, and the guard that keeps the app silent while no account is
 * linked.
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
  FIXTURE_EXPRESS_SHOT_ID,
  FIXTURE_ITEM_CATALOGUE,
  FIXTURE_PAIGE_ABILITY_IDS,
  FIXTURE_RANK_CATALOGUE,
} from '../adapters/dev/fixtures/assets.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import {
  ASSET_IMAGE_ORIGIN,
  ITEM_KINDS,
  ITEM_SLOTS,
  MAX_ITEM_TIER,
  MIN_ITEM_TIER,
  parseItemCatalogue,
  parseRankCatalogue,
  type CatalogueItem,
} from '../core/deadlock-api/assets.schema';
import { itemsRequest, ranksRequest } from '../core/deadlock-api/endpoints';
import type { AccountId } from '../core/domain/account';
import { RANK_TIER_NAMES } from '../core/domain/rank';
import { AppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import { createTestDatabase, testAccountId } from '../test/test-data';
import { ApiCacheRepository } from './api-cache.repository';
import { DeadlockApiService } from './deadlock-api.service';
import { GameAssetService } from './game-asset.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 24 * 60 * 60_000;
const ACCOUNT_ID = testAccountId(1000001);

/**
 * Build the service on a shared database, with a controllable clock, handler and linked account.
 * An account is linked unless a test unlinks it.
 *
 * @returns The service, its HTTP client, logger and API service, the cache it keeps the catalogues
 *   in, the clock, a way to change the handler, and the linked account: set `link.accountId` to
 *   `null` to unlink it, or `link.failure` to make the link unreadable.
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
  const assets = new GameAssetService({ accountSource, api, cache, logger, now });
  return { assets, api, http, logger, cache, clock, answer, link };
}

/** A catalogue of the service, as the tests that both catalogues obey describe it. */
interface CatalogueCase {
  /** What the catalogue is called in the log lines: `item` or `rank`. */
  readonly name: 'item' | 'rank';
  /** Cache key of the catalogue (the service's own, which is not exported). */
  readonly cacheKey: string;
  /** The request that downloads it. */
  readonly url: string;
  /** Read the catalogue. */
  readonly read: (assets: GameAssetService) => Promise<unknown>;
  /** What the service gives when it has nothing to give. */
  readonly empty: unknown;
  /** The list the cache holds: the catalogue of the fixtures, reduced to what the app keeps. */
  readonly reduced: () => unknown;
  /** Cached payloads that are not a catalogue this service wrote. */
  readonly unreadable: readonly string[];
}

const CATALOGUES: readonly CatalogueCase[] = [
  {
    name: 'item',
    cacheKey: 'items.english',
    url: itemsRequest().url,
    read: (assets) => assets.getItemCatalogue(),
    empty: { byId: new Map(), byClassName: new Map() },
    reduced: () => parseItemCatalogue(FIXTURE_ITEM_CATALOGUE),
    unreadable: [
      // Not JSON at all.
      'not json',
      // An empty catalogue: the download refuses it, so it never was written by this service.
      '[]',
      // Not a list.
      '{"id":1}',
      // An entry without the image link.
      JSON.stringify([
        { id: 1, className: 'ability_a', name: 'A', kind: 'ability', slot: null, tier: null },
      ]),
      // An image link outside the asset bucket, the only host the app may load images from.
      JSON.stringify([
        {
          id: 1,
          className: 'ability_a',
          name: 'A',
          kind: 'ability',
          slot: null,
          tier: null,
          imageUrl: 'https://images.example.net/a.webp',
        },
      ]),
      // A tier above the highest the game data has.
      JSON.stringify([
        {
          id: 1,
          className: 'upgrade_a',
          name: 'A',
          kind: 'upgrade',
          slot: 'spirit',
          tier: MAX_ITEM_TIER + 1,
          imageUrl: null,
        },
      ]),
      // An entry of a kind the game data does not have, among entries that fit.
      JSON.stringify([
        {
          id: 1,
          className: 'ability_a',
          name: 'A',
          kind: 'ability',
          slot: null,
          tier: null,
          imageUrl: null,
        },
        {
          id: 2,
          className: 'hero_b',
          name: 'B',
          kind: 'hero',
          slot: null,
          tier: null,
          imageUrl: null,
        },
      ]),
    ],
  },
  {
    name: 'rank',
    cacheKey: 'ranks.english',
    url: ranksRequest().url,
    read: (assets) => assets.getRankCatalogue(),
    empty: new Map(),
    reduced: () => parseRankCatalogue(FIXTURE_RANK_CATALOGUE),
    unreadable: [
      'not json',
      '[]',
      '{"tier":1}',
      // A tier without the badge link.
      JSON.stringify([{ tier: 1, name: 'Initiate' }]),
      // A badge outside the asset bucket.
      JSON.stringify([
        { tier: 1, name: 'Initiate', imageUrl: 'https://images.example.net/1.webp' },
      ]),
      // A tier the game does not have.
      JSON.stringify([{ tier: -1, name: 'Nowhere', imageUrl: null }]),
    ],
  },
];

describe('GameAssetService', () => {
  describe('item catalogue', () => {
    it('downloads the item catalogue once and serves it from the cache', async () => {
      const { assets, http, clock } = setUp();

      const downloaded = await assets.getItemCatalogue();
      clock.now += 6 * DAY;
      const cached = await assets.getItemCatalogue();

      expect(http.requests.map((request) => request.url)).toEqual([itemsRequest().url]);
      // The cached copy went through the cache and came back whole, an image link included.
      expect(cached).toEqual(downloaded);
      expect(cached.byId.get(FIXTURE_EXPRESS_SHOT_ID)).toEqual({
        id: FIXTURE_EXPRESS_SHOT_ID,
        className: 'upgrade_express_shot',
        name: 'Express Shot',
        kind: 'upgrade',
        slot: 'weapon',
        tier: 3,
        imageUrl: `${ASSET_IMAGE_ORIGIN}assets-api-res/images/items/weapon/express_shot.webp`,
      });
    });

    it('indexes items by id and class name', async () => {
      const { assets } = setUp();
      const downloaded = await assets.getItemCatalogue();
      const cached = await assets.getItemCatalogue();

      // Whether it was downloaded or read back from the cache.
      for (const { byId, byClassName } of [downloaded, cached]) {
        expect(byId.size).toBe(FIXTURE_ITEM_CATALOGUE.length);
        expect(byClassName.size).toBe(FIXTURE_ITEM_CATALOGUE.length);
        // Both indexes hold the very same entries.
        for (const item of byId.values()) {
          expect(byClassName.get(item.className)).toBe(item);
        }
        // The `item_id` of a match's items reaches the class name of a damage row's `source_name`…
        expect(byId.get(FIXTURE_EXPRESS_SHOT_ID)?.className).toBe('upgrade_express_shot');
        expect(byClassName.get('upgrade_express_shot')?.id).toBe(FIXTURE_EXPRESS_SHOT_ID);
        // … and the ability ids of Paige's loadout reach her abilities.
        expect(FIXTURE_PAIGE_ABILITY_IDS.map((id) => byId.get(id)?.name)).toEqual([
          'Bookwyrm',
          'Plot Armor',
          'Captivating Read',
          'Rallying Charge',
        ]);
        // An entry without a name or an image stays in the catalogue: the caller names it itself.
        expect(byClassName.get('citadel_ability_sprint')).toMatchObject({
          kind: 'ability',
          name: null,
          imageUrl: null,
        });
        // An id or a class name the game data does not have is simply absent.
        expect(byId.get(1)).toBeUndefined();
        expect(byClassName.get('upgrade_unknown')).toBeUndefined();
      }
    });

    it('reads back from the cache every kind, slot and tier the parser reads', async () => {
      const { assets, http, cache } = setUp();
      /** An entry with nothing but what it is given, so that each case below tests one field. */
      const entry = (
        id: number,
        className: string,
        fields: Partial<CatalogueItem>,
      ): CatalogueItem => ({
        id,
        className,
        name: null,
        kind: 'ability',
        slot: null,
        tier: null,
        imageUrl: null,
        ...fields,
      });
      // The lists are the parser's own: a kind, a slot or a tier it learns to read is tried here, and
      // fails this test should the cache not follow.
      const tiers = Array.from(
        { length: MAX_ITEM_TIER - MIN_ITEM_TIER + 1 },
        (_, index) => MIN_ITEM_TIER + index,
      );
      const items = [
        ...ITEM_KINDS.map((kind, index) => entry(1 + index, `kind_${kind}`, { kind })),
        ...ITEM_SLOTS.map((slot, index) =>
          entry(100 + index, `slot_${slot}`, { kind: 'upgrade', slot }),
        ),
        ...tiers.map((tier) =>
          entry(200 + tier, `tier_${String(tier)}`, { kind: 'upgrade', tier }),
        ),
      ];
      await cache.put('items.english', {
        payloadJson: JSON.stringify(items),
        fetchedAt: START,
        expiresAt: START + 7 * DAY,
      });

      const { byId } = await assets.getItemCatalogue();

      // Fresh and readable: served from the cache, nothing downloaded.
      expect(http.requests).toHaveLength(0);
      expect([...byId.values()]).toEqual(items);
    });

    it('keeps the later entry when two share an id or a class name', async () => {
      const { assets, answer } = setUp();
      answer.handler = () =>
        jsonResponse([
          { id: 7, class_name: 'ability_first', type: 'ability', name: 'First' },
          { id: 7, class_name: 'ability_second', type: 'ability', name: 'Second' },
          { id: 8, class_name: 'ability_second', type: 'ability', name: 'Third' },
        ]);

      const { byId, byClassName } = await assets.getItemCatalogue();

      expect(byId.get(7)?.name).toBe('Second');
      expect(byClassName.get('ability_first')?.name).toBe('First');
      expect(byClassName.get('ability_second')?.name).toBe('Third');
    });
  });

  describe('rank catalogue', () => {
    it('reads the rank images by tier', async () => {
      const { assets, http, clock } = setUp();

      const downloaded = await assets.getRankCatalogue();
      clock.now += DAY;
      const cached = await assets.getRankCatalogue();

      expect(http.requests.map((request) => request.url)).toEqual([ranksRequest().url]);
      expect(cached).toEqual(downloaded);
      // Whether it was downloaded or read back from the cache.
      for (const ranks of [downloaded, cached]) {
        expect([...ranks.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect(ranks.get(4)).toEqual({
          tier: 4,
          name: 'Sentinel',
          imageUrl: `${ASSET_IMAGE_ORIGIN}assets-api-res/images/ranks/rank04_lg.webp`,
        });
        for (const [tier, rank] of ranks) {
          expect(rank.tier).toBe(tier);
          expect(rank.name).toBe(RANK_TIER_NAMES[tier]);
          // The badge of every tier is on the asset bucket: the only host the app may load from.
          expect(rank.imageUrl?.startsWith(ASSET_IMAGE_ORIGIN)).toBe(true);
        }
        // A tier the game does not have is simply absent.
        expect(ranks.get(12)).toBeUndefined();
      }
    });
  });

  describe.each(CATALOGUES)('$name catalogue rules', (catalogue) => {
    it('keeps the reduced list in the cache for a week', async () => {
      const { assets, cache } = setUp();
      await catalogue.read(assets);

      const entry = await cache.get(catalogue.cacheKey);

      expect(entry).not.toBeNull();
      expect(entry?.fetchedAt).toBe(START);
      expect(entry?.expiresAt).toBe(START + 7 * DAY);
      expect(JSON.parse(entry?.payloadJson ?? 'null')).toEqual(catalogue.reduced());
    });

    it('downloads it again from the moment its week ends', async () => {
      const { assets, http, clock } = setUp();
      await catalogue.read(assets);

      clock.now += 7 * DAY - 1;
      await catalogue.read(assets);
      expect(http.requests).toHaveLength(1);

      clock.now += 1;
      await catalogue.read(assets);
      expect(http.requests).toHaveLength(2);
      expect(http.requests.every((request) => request.url === catalogue.url)).toBe(true);
    });

    it('downloads it again when the system clock moved backwards since it was cached', async () => {
      const { assets, http, clock } = setUp();
      await catalogue.read(assets);
      clock.now -= 60 * 60_000;

      await catalogue.read(assets);

      expect(http.requests).toHaveLength(2);
    });

    it('serves a stale catalogue when the download fails', async () => {
      const { assets, logger, clock, answer } = setUp();
      const downloaded = await catalogue.read(assets);
      clock.now += 30 * DAY;
      answer.handler = () => {
        throw new AppError('network', 'The request failed');
      };

      await expect(catalogue.read(assets)).resolves.toEqual(downloaded);

      // The only line above debug level: what went wrong, by kind only.
      expect(logger.entries.filter((entry) => entry.level !== 'debug')).toMatchObject([
        {
          level: 'warn',
          scope: 'assets',
          message: `Could not refresh the ${catalogue.name} catalogue, using the cached one`,
          context: { kind: 'network' },
        },
      ]);
    });

    it('serves a catalogue dated in the future when it cannot be downloaded again', async () => {
      const { assets, clock, answer } = setUp();
      const downloaded = await catalogue.read(assets);
      clock.now -= 60 * 60_000;
      answer.handler = () => {
        throw new AppError('network', 'The request failed');
      };

      await expect(catalogue.read(assets)).resolves.toEqual(downloaded);
    });

    it('serves a stale catalogue when the budget of asset requests is exhausted', async () => {
      const { assets, api, http, logger, clock } = setUp();
      const downloaded = await catalogue.read(assets);
      clock.now += 30 * DAY;
      // The two asset requests of the second are spent on the hero catalogue.
      await api.fetchHeroes();
      await api.fetchHeroes();

      await expect(catalogue.read(assets)).resolves.toEqual(downloaded);

      // Refused before it was sent: the catalogue was asked for once, the heroes twice.
      expect(http.requests).toHaveLength(3);
      expect(logger.entries.filter((entry) => entry.level !== 'debug')).toMatchObject([
        { level: 'warn', scope: 'assets', context: { kind: 'rate_limited' } },
      ]);
    });

    it('fails when there is no catalogue at all', async () => {
      const { assets, answer } = setUp();
      answer.handler = () => jsonResponse({}, 500);

      await expect(catalogue.read(assets)).rejects.toMatchObject({ kind: 'service_unavailable' });
    });

    it('fails when there is no catalogue and no budget left to download one', async () => {
      const { assets, api, http } = setUp();
      await api.fetchHeroes();
      await api.fetchHeroes();

      await expect(catalogue.read(assets)).rejects.toMatchObject({ kind: 'rate_limited' });

      expect(http.requests).toHaveLength(2);
    });

    it('fails on an empty download rather than caching it', async () => {
      const { assets, cache, answer } = setUp();
      answer.handler = () => jsonResponse([]);

      await expect(catalogue.read(assets)).rejects.toMatchObject({ kind: 'invalid_payload' });

      await expect(cache.get(catalogue.cacheKey)).resolves.toBeNull();
    });

    it('still gives the catalogue it downloaded when it cannot be cached', async () => {
      const { assets, http, cache, logger } = setUp();
      vi.spyOn(cache, 'put').mockRejectedValueOnce(
        new AppError('storage', 'Could not save the API cache'),
      );

      const downloaded = await catalogue.read(assets);

      expect(downloaded).not.toEqual(catalogue.empty);
      expect(logger.entries.filter((entry) => entry.level !== 'debug')).toMatchObject([
        {
          level: 'warn',
          scope: 'assets',
          message: `Could not cache the ${catalogue.name} catalogue`,
          context: { kind: 'storage' },
        },
      ]);
      // Nothing was kept, so it is downloaded again once, and cached this time.
      await expect(catalogue.read(assets)).resolves.toEqual(downloaded);
      await expect(catalogue.read(assets)).resolves.toEqual(downloaded);
      expect(http.requests).toHaveLength(2);
    });

    it.each(catalogue.unreadable)(
      'reads an unreadable cached entry (%#) as nothing cached, quietly',
      async (payloadJson) => {
        const { assets, http, logger, cache } = setUp();
        await cache.put(catalogue.cacheKey, {
          payloadJson,
          fetchedAt: START,
          expiresAt: START + 7 * DAY,
        });

        const downloaded = await catalogue.read(assets);

        // The entry is fresh, so it would have been served had it fit.
        expect(http.requests).toHaveLength(1);
        expect(downloaded).not.toEqual(catalogue.empty);
        // It is no problem to report (the download itself only logs at debug level).
        expect(logger.entries.filter((entry) => entry.level !== 'debug')).toEqual([]);
        // It was replaced by one that fits.
        await expect(catalogue.read(assets)).resolves.toEqual(downloaded);
        expect(http.requests).toHaveLength(1);
      },
    );

    it('contacts nobody without a linked account', async () => {
      const { assets, http, cache, link } = setUp();
      link.accountId = null;

      await expect(catalogue.read(assets)).resolves.toEqual(catalogue.empty);

      expect(http.requests).toHaveLength(0);
      await expect(cache.get(catalogue.cacheKey)).resolves.toBeNull();
    });

    it('gives the cached catalogue without a linked account, whatever its age', async () => {
      const { assets, http, clock, link } = setUp();
      const downloaded = await catalogue.read(assets);
      // Long past its week of freshness: with an account, it would be downloaded again.
      clock.now += 30 * DAY;
      link.accountId = null;

      await expect(catalogue.read(assets)).resolves.toEqual(downloaded);

      expect(http.requests).toHaveLength(1);
    });

    it('downloads the catalogue once an account is linked', async () => {
      const { assets, http, link } = setUp();
      link.accountId = null;
      // Without an account, nothing is downloaded: this call would fill the cache if it did.
      await expect(catalogue.read(assets)).resolves.toEqual(catalogue.empty);
      expect(http.requests).toHaveLength(0);

      link.accountId = ACCOUNT_ID;
      const downloaded = await catalogue.read(assets);

      expect(http.requests).toHaveLength(1);
      expect(downloaded).not.toEqual(catalogue.empty);
    });

    it('does not take an unreadable linked account for no account', async () => {
      const { assets, http, logger, link } = setUp();
      await catalogue.read(assets);
      const logged = logger.entries.length;
      link.failure = new AppError('storage', 'The linked account is invalid');

      // Like any other failure of the catalogue, it is the caller's to handle.
      await expect(catalogue.read(assets)).rejects.toBe(link.failure);

      expect(http.requests).toHaveLength(1);
      expect(logger.entries).toHaveLength(logged);
    });

    describe('concurrent calls', () => {
      it('send one request and all get the catalogue', async () => {
        const { assets, http } = setUp();

        const [first, second, third] = await Promise.all([
          catalogue.read(assets),
          catalogue.read(assets),
          catalogue.read(assets),
        ]);

        expect(http.requests).toHaveLength(1);
        expect(first).not.toEqual(catalogue.empty);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        // The catalogue was cached once, by the one download: a later call is served from it.
        await expect(catalogue.read(assets)).resolves.toEqual(first);
        expect(http.requests).toHaveLength(1);
      });

      it('all fail with the one failed download, and the next call tries again', async () => {
        const { assets, http, answer } = setUp();
        answer.handler = () => jsonResponse({}, 500);

        const outcomes = await Promise.allSettled([catalogue.read(assets), catalogue.read(assets)]);

        expect(outcomes).toMatchObject([
          { status: 'rejected', reason: { kind: 'service_unavailable' } },
          { status: 'rejected', reason: { kind: 'service_unavailable' } },
        ]);
        // One download for both calls: a failure does not stay registered, so nothing is cached.
        const sent = http.requests.length;
        answer.handler = createFixtureApi({ now: START });
        const downloaded = await catalogue.read(assets);
        expect(downloaded).not.toEqual(catalogue.empty);
        expect(http.requests).toHaveLength(sent + 1);
        // A second concurrent pair would have sent as many requests as the first did.
        expect(sent).toBe(1);
      });

      it('refresh a stale catalogue once, and say once that they could not', async () => {
        const { assets, http, logger, clock, answer } = setUp();
        const downloaded = await catalogue.read(assets);
        clock.now += 30 * DAY;
        answer.handler = () => {
          throw new AppError('network', 'The request failed');
        };

        const results = await Promise.all([catalogue.read(assets), catalogue.read(assets)]);

        expect(results).toEqual([downloaded, downloaded]);
        expect(http.requests).toHaveLength(2);
        expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
      });

      it('share nothing once the download is over', async () => {
        const { assets, http, clock } = setUp();
        await Promise.all([catalogue.read(assets), catalogue.read(assets)]);
        clock.now += 7 * DAY;

        await Promise.all([catalogue.read(assets), catalogue.read(assets)]);

        // One download for each pair, the second a week after the first.
        expect(http.requests).toHaveLength(2);
      });
    });
  });

  it('downloads the two catalogues side by side, each with its own request', async () => {
    const { assets, http } = setUp();

    const [items, ranks] = await Promise.all([
      assets.getItemCatalogue(),
      assets.getRankCatalogue(),
    ]);

    expect(items.byId.size).toBeGreaterThan(0);
    expect(ranks.size).toBe(12);
    expect(http.requests.map((request) => request.url).toSorted()).toEqual(
      [itemsRequest().url, ranksRequest().url].toSorted(),
    );
  });
});

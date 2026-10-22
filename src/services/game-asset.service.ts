/**
 * The game assets: the item catalogue (names, kinds, slots, tiers and images of every ability,
 * weapon and shop item) and the rank catalogue (names and badges of the tiers), with which the match
 * page names and shows damage sources, builds and ranks.
 *
 * Each catalogue is kept by the rules of `cached-catalogue.ts`, like the hero catalogue:
 * downloaded at most once a week, reduced to the few fields the app shows, the last one downloaded
 * used when it cannot be refreshed, nothing downloaded until an account is linked, and one run
 * shared by the callers that overlap. This module says what is kept of each catalogue and how the
 * app looks into it.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import {
  ITEM_KINDS,
  ITEM_SLOTS,
  MAX_ITEM_TIER,
  MIN_ITEM_TIER,
  type CatalogueItem,
  type CatalogueRank,
} from '../core/deadlock-api/assets.schema';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import { cachedCatalogue, cachedImageUrlSchema } from './cached-catalogue';
import type { DeadlockApiService } from './deadlock-api.service';

/** Scope of the log lines of this service. */
const LOG_SCOPE = 'assets';

/**
 * Schema of the cached item catalogue: never empty, as the download refuses an empty one.
 *
 * It checks the shape of the entries {@link CatalogueItem} describes (every key is required, the
 * ones that may be absent being `null`) and that the images are on the asset bucket, nothing more:
 * whether an entry is a game item is the download's business. An entry that does not fit makes the
 * whole entry of the cache count as absent, so the catalogue is downloaded again rather than
 * half-read. The annotation makes the compiler check that what the schema gives is a list of
 * catalogue items.
 *
 * The kinds, the slots and the bounds of the tier are the very ones the parser reads, not copies of
 * them: a kind the parser learns to read can never make the cache unreadable.
 */
const cachedItemsSchema: z.ZodType<CatalogueItem[]> = z
  .array(
    z.object({
      id: z.int().positive(),
      className: z.string().min(1),
      name: z.string().min(1).nullable(),
      kind: z.enum(ITEM_KINDS),
      slot: z.enum(ITEM_SLOTS).nullable(),
      tier: z.int().min(MIN_ITEM_TIER).max(MAX_ITEM_TIER).nullable(),
      imageUrl: cachedImageUrlSchema,
    }),
  )
  .min(1);

/** Schema of the cached rank catalogue: never empty either (see {@link cachedItemsSchema}). */
const cachedRanksSchema: z.ZodType<CatalogueRank[]> = z
  .array(
    z.object({
      tier: z.int().nonnegative(),
      name: z.string().min(1),
      imageUrl: cachedImageUrlSchema,
    }),
  )
  .min(1);

/**
 * The item catalogue, indexed the two ways the app looks an item up.
 *
 * Both indexes hold the very same entries. Ids and class names are unique in the game data; should
 * two entries repeat one, the later entry of the catalogue wins that key.
 */
export interface ItemCatalogue {
  /** Items by numeric id: the `item_id` of a match's items and the `ability_id` of a stat. */
  readonly byId: ReadonlyMap<number, CatalogueItem>;
  /** Items by class name: the `source_name` of a damage row and the keys of a hero's loadout. */
  readonly byClassName: ReadonlyMap<string, CatalogueItem>;
}

/** What {@link GameAssetService} needs. */
export interface GameAssetServiceDependencies {
  /** The linked account: without one, nothing is downloaded. */
  readonly accountSource: AccountSource;
  /** Downloads the catalogues, within the asset budget of deadlock-api. */
  readonly api: DeadlockApiService;
  /** Keeps the catalogues between sessions. */
  readonly cache: ApiCacheRepository;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * Provides the item and rank catalogues.
 *
 * A call made while another one is running for the same catalogue gets the answer of that run: the
 * account, the cache and the download are read once, and a failed refresh is logged once. The item
 * and the rank catalogues are independent, each downloaded by its own request.
 */
export class GameAssetService {
  /** Reads the item catalogue, sharing the run among the calls that overlap. */
  readonly #readItems: () => Promise<readonly CatalogueItem[]>;
  /** Reads the rank catalogue, sharing the run among the calls that overlap. */
  readonly #readRanks: () => Promise<readonly CatalogueRank[]>;

  /**
   * @param dependencies - See {@link GameAssetServiceDependencies}.
   */
  constructor(dependencies: GameAssetServiceDependencies) {
    const { accountSource, api, cache, logger, now = Date.now } = dependencies;
    const shared = { accountSource, cache, logger, now };
    // One reader per catalogue, each with its own pending run: a run is typed by the entries of its
    // catalogue, which a single map of pending runs could not say.
    this.#readItems = cachedCatalogue(shared, {
      cacheKey: 'items.english',
      label: 'item catalogue',
      logScope: LOG_SCOPE,
      schema: cachedItemsSchema,
      download: () => api.fetchItemCatalogue(),
    });
    this.#readRanks = cachedCatalogue(shared, {
      cacheKey: 'ranks.english',
      label: 'rank catalogue',
      logScope: LOG_SCOPE,
      schema: cachedRanksSchema,
      download: () => api.fetchRankCatalogue(),
    });
  }

  /**
   * The abilities, weapons and shop items of the game, with their English names, slots, tiers and
   * images.
   *
   * @returns The catalogue, indexed by id and by class name: cached when fresh, downloaded
   *   otherwise, or the stale cached one when it cannot be downloaded. Without a linked account,
   *   nothing is downloaded: the cached catalogue whatever its age, or an empty one when nothing
   *   is cached.
   * @throws AppError when the catalogue can be neither read from the cache nor downloaded (any
   *   failure of the download, a pause or a spent budget included), or when the linked account
   *   cannot be read: an unreadable link is not "no account", and the caller handles it like any
   *   other failure of the catalogue. Concurrent calls share one run, so they all get the same
   *   answer or fail with the same error.
   */
  async getItemCatalogue(): Promise<ItemCatalogue> {
    const items = await this.#readItems();
    return {
      byId: new Map(items.map((item) => [item.id, item])),
      byClassName: new Map(items.map((item) => [item.className, item])),
    };
  }

  /**
   * The tiers of the ranking, with their English names and badge images.
   *
   * @returns The catalogue by tier (0, Obscurus, to 11, Eternus), under the same rules as
   *   {@link GameAssetService.getItemCatalogue}: an empty one without a linked account and without
   *   a cached catalogue. Should two entries repeat a tier, the later one wins.
   * @throws AppError under the same conditions as {@link GameAssetService.getItemCatalogue}.
   */
  async getRankCatalogue(): Promise<ReadonlyMap<number, CatalogueRank>> {
    const ranks = await this.#readRanks();
    return new Map(ranks.map((rank) => [rank.tier, rank]));
  }
}

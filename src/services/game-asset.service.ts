/**
 * The game assets: the item catalogue (names, kinds, slots, tiers and images of every ability,
 * weapon and shop item) and the rank catalogue (names and badges of the tiers), with which the match
 * page names and shows damage sources, builds and ranks.
 *
 * The catalogues change with game patches only, so each is downloaded at most once a week and kept
 * in the database, reduced to the few fields the app shows. When one cannot be refreshed (offline,
 * deadlock-api unavailable or asked to pause, asset budget spent), the last catalogue downloaded is
 * used, however old.
 *
 * Until an account is linked, the app contacts nobody: the catalogues are then only read from the
 * cache, whatever its age. The service enforces it itself, like the hero catalogue does, so no
 * caller can break it by forgetting to check the account first.
 *
 * Callers that ask for the same catalogue at the same moment share one run, so that it is
 * downloaded once: the asset budget of deadlock-api is two requests a second for all the catalogues
 * together.
 *
 * The lines written here hold the name of the catalogue and the log context of an error (its kind,
 * cause and stack). None carries an account id or a value of a catalogue.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import {
  ASSET_IMAGE_ORIGIN,
  ITEM_KINDS,
  ITEM_SLOTS,
  MAX_ITEM_TIER,
  MIN_ITEM_TIER,
  type CatalogueItem,
  type CatalogueRank,
} from '../core/deadlock-api/assets.schema';
import { errorLogContext, toAppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import type { DeadlockApiService } from './deadlock-api.service';

/** Time after which a cached catalogue is refreshed: one week. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Scope of the log lines of this service. */
const LOG_SCOPE = 'assets';

/**
 * Schema of the image link of a cached entry: a link on the asset bucket, or none.
 *
 * The cache is written by this service from a download that was already validated, but the links are
 * checked again against the bucket: the release Content Security Policy only lets the app load
 * images from there, so nothing this service returns may point anywhere else, whatever the cache
 * holds.
 */
const cachedImageUrlSchema = z.string().startsWith(ASSET_IMAGE_ORIGIN).nullable();

/**
 * Schema of the cached item catalogue: never empty, as the download refuses an empty one.
 *
 * It checks the shape of the entries {@link CatalogueItem} describes (every key is required, the
 * ones that may be absent being `null`), nothing more: whether an entry is a game item is the
 * download's business. An entry that does not fit makes the whole entry of the cache count as
 * absent, so the catalogue is downloaded again rather than half-read. The annotation makes the
 * compiler check that what the schema gives is a list of catalogue items.
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

/** What differs between the catalogues the service keeps: the rest is shared. */
interface CatalogueSource<Entry> {
  /** Cache key of the catalogue. The language is part of it, should other languages ever be kept. */
  readonly cacheKey: string;
  /** What the catalogue is called in the log lines. */
  readonly label: string;
  /** Validates the cached list. */
  readonly schema: z.ZodType<Entry[]>;
}

/** The item catalogue, as the cache keeps it. */
const ITEM_SOURCE: CatalogueSource<CatalogueItem> = {
  cacheKey: 'items.english',
  label: 'item catalogue',
  schema: cachedItemsSchema,
};

/** The rank catalogue, as the cache keeps it. */
const RANK_SOURCE: CatalogueSource<CatalogueRank> = {
  cacheKey: 'ranks.english',
  label: 'rank catalogue',
  schema: cachedRanksSchema,
};

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

/** The cached catalogue, with the times of its download and of the end of its freshness. */
interface CachedCatalogue<Entry> {
  readonly entries: Entry[];
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

/**
 * Share the run of an operation among the calls that overlap.
 *
 * The match page asks for the same catalogue from several places at once (and the three catalogues
 * share a budget of two requests a second), so a catalogue must not be downloaded once per caller.
 *
 * @param run - Starts the operation.
 * @returns A function that starts `run`, or, while a run is pending, gives the pending one: its
 *   callers get one answer, or all fail with one error. Once a run has settled, however it ended,
 *   the next call starts a new one.
 */
function shareRun<Result>(run: () => Promise<Result>): () => Promise<Result> {
  let pending: Promise<Result> | null = null;
  return () => {
    if (pending !== null) {
      return pending;
    }
    // The run is registered in the very turn it starts in, so that no call can slip in between.
    const current = run().finally(() => {
      pending = null;
    });
    pending = current;
    return current;
  };
}

/**
 * Provides the item and rank catalogues.
 *
 * A call made while another one is running for the same catalogue gets the answer of that run: the
 * account, the cache and the download are read once, and a failed refresh is logged once. The item
 * and the rank catalogues are independent, each downloaded by its own request.
 */
export class GameAssetService {
  readonly #accountSource: AccountSource;
  readonly #api: DeadlockApiService;
  readonly #cache: ApiCacheRepository;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** Reads the item catalogue, sharing the run among the calls that overlap. */
  readonly #readItems: () => Promise<readonly CatalogueItem[]>;
  /** Reads the rank catalogue, sharing the run among the calls that overlap. */
  readonly #readRanks: () => Promise<readonly CatalogueRank[]>;

  /**
   * @param dependencies - See {@link GameAssetServiceDependencies}.
   */
  constructor(dependencies: GameAssetServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#api = dependencies.api;
    this.#cache = dependencies.cache;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
    // One pending run per catalogue, kept by the closure that shares it: a run is typed by the
    // entries of its catalogue, which a single map of pending runs could not say.
    this.#readItems = shareRun(() =>
      this.#readCatalogue(ITEM_SOURCE, () => this.#api.fetchItemCatalogue()),
    );
    this.#readRanks = shareRun(() =>
      this.#readCatalogue(RANK_SOURCE, () => this.#api.fetchRankCatalogue()),
    );
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

  /**
   * Serve a catalogue under the rules every catalogue of the service follows.
   *
   * @param source - The catalogue: where it is kept and how it is called.
   * @param download - Downloads it.
   * @returns The catalogue: the cached one when fresh, the downloaded one otherwise (and cached),
   *   the stale cached one when the download fails. Without a linked account, the cached one
   *   whatever its age, or an empty list.
   * @throws AppError when the linked account cannot be read, or when the download fails and nothing
   *   valid is cached.
   */
  async #readCatalogue<Entry>(
    source: CatalogueSource<Entry>,
    download: () => Promise<Entry[]>,
  ): Promise<readonly Entry[]> {
    const accountId = await this.#accountSource.currentAccountId();
    const cached = await this.#readCache(source);
    if (accountId === null) {
      return cached?.entries ?? [];
    }
    const now = this.#now();
    // A catalogue downloaded after `now` means that the system clock moved backwards since: it
    // would stay fresh until the clock catches up, so it is downloaded again instead.
    if (cached !== null && cached.fetchedAt <= now && cached.expiresAt > now) {
      return cached.entries;
    }
    let entries: Entry[];
    try {
      entries = await download();
    } catch (error) {
      // Any failure is a download that did not happen: the offline app, a pause asked by
      // deadlock-api, a spent budget or an unreadable answer all leave the catalogue as it was.
      if (cached === null) {
        throw error;
      }
      this.#logger.log(
        'warn',
        LOG_SCOPE,
        `Could not refresh the ${source.label}, using the cached one`,
        errorLogContext(toAppError(error)),
      );
      return cached.entries;
    }
    try {
      await this.#cache.put(source.cacheKey, {
        payloadJson: JSON.stringify(entries),
        fetchedAt: now,
        expiresAt: now + CACHE_TTL_MS,
      });
    } catch (error) {
      // The fresh catalogue is still good to show; it will simply be downloaded again next time.
      this.#logger.log(
        'warn',
        LOG_SCOPE,
        `Could not cache the ${source.label}`,
        errorLogContext(toAppError(error)),
      );
    }
    return entries;
  }

  /**
   * Read a cached catalogue.
   *
   * @param source - The catalogue.
   * @returns The entries and the times of their download and of the end of their freshness, or
   *   `null` when nothing valid is cached. An entry that is not JSON, or does not fit the schema
   *   (written by an older version of the app, say), reads as absent, quietly, because it is no
   *   fault to report: the catalogue is downloaded again and replaces it.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #readCache<Entry>(source: CatalogueSource<Entry>): Promise<CachedCatalogue<Entry> | null> {
    const entry = await this.#cache.get(source.cacheKey);
    if (entry === null) {
      return null;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(entry.payloadJson);
    } catch {
      return null;
    }
    const entries = source.schema.safeParse(payload);
    return entries.success
      ? { entries: entries.data, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt }
      : null;
  }
}

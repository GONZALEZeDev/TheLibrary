/**
 * The hero catalogue: the English names of the playable heroes, with their portraits and loadouts.
 *
 * The catalogue changes with game patches only, so it is downloaded at most once a week and kept
 * in the database. When it cannot be refreshed (offline, deadlock-api unavailable), the last
 * catalogue downloaded is used, however old.
 *
 * Until an account is linked, the app contacts nobody: the catalogue is then only read from the
 * cache, whatever its age. The service enforces it itself, so no caller can break it by forgetting
 * to check the account first.
 *
 * Callers that ask for the catalogue at the same moment share one run, so that it is downloaded
 * once: the asset budget of deadlock-api is two requests a second for all the catalogues together.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { Hero, HeroAsset } from '../core/domain/hero';
import { errorLogContext, toAppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import type { DeadlockApiService } from './deadlock-api.service';

/** Cache key of the catalogue. The language is part of it, should other languages ever be kept. */
const CACHE_KEY = 'heroes.english';

/** Time after which the cached catalogue is refreshed: one week. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Schema of the loadout of a cached hero: the class names of its weapon, its melee attack and its
 * signature abilities. The cache is written by this service from a download that was already
 * validated, so it only checks the shape, not the number of abilities (which is the download's
 * business).
 */
const cachedLoadoutSchema = z.object({
  weapon: z.string().min(1),
  melee: z.string().min(1),
  abilities: z.array(z.string().min(1)),
});

/**
 * Schema of the cached catalogue: never empty, as the download refuses an empty one.
 *
 * The portrait and the loadout are required keys that may be `null`. That is what tells an entry
 * written since M4b from an older one, which held `{ id, name }` heroes only: the older entry does
 * not fit, so it counts as absent and the catalogue is downloaded again.
 */
const cachedHeroesSchema = z
  .array(
    z.object({
      id: z.int().positive(),
      name: z.string().min(1),
      imageUrl: z.string().min(1).nullable(),
      loadout: cachedLoadoutSchema.nullable(),
    }),
  )
  .min(1);

/** Provides the hero catalogue. */
export class HeroCatalogService {
  readonly #accountSource: AccountSource;
  readonly #api: DeadlockApiService;
  readonly #cache: ApiCacheRepository;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** The run that is reading the catalogue, if any: the calls that overlap it share its answer. */
  #running: Promise<readonly HeroAsset[]> | null = null;

  /**
   * @param accountSource - The linked account: without one, nothing is downloaded.
   * @param api - Downloads the catalogue.
   * @param cache - Keeps it between sessions.
   * @param logger - Structured logger.
   * @param now - Current time (Unix ms).
   */
  constructor(
    accountSource: AccountSource,
    api: DeadlockApiService,
    cache: ApiCacheRepository,
    logger: Logger,
    now: () => number = Date.now,
  ) {
    this.#accountSource = accountSource;
    this.#api = api;
    this.#cache = cache;
    this.#logger = logger;
    this.#now = now;
  }

  /**
   * The playable heroes, with their English names only.
   *
   * It is {@link HeroCatalogService.getHeroAssets} reduced to the bare {@link Hero}: what only
   * needs to name a hero never sees the portrait or the loadout.
   *
   * @returns The catalogue, under the same rules as {@link HeroCatalogService.getHeroAssets}.
   * @throws AppError under the same conditions as {@link HeroCatalogService.getHeroAssets}.
   */
  async getHeroes(): Promise<readonly Hero[]> {
    const heroes = await this.getHeroAssets();
    return heroes.map(({ id, name }) => ({ id, name }));
  }

  /**
   * The playable heroes, with their English names, their portraits and their loadouts.
   *
   * @returns The catalogue: cached when fresh, downloaded otherwise, or the stale cached one when
   *   it cannot be downloaded. Without a linked account, nothing is downloaded: the cached
   *   catalogue whatever its age, or an empty one when nothing is cached. A catalogue cached
   *   before M4b (names only) counts as nothing cached.
   * @throws AppError when the catalogue can be neither read from the cache nor downloaded, or when
   *   the linked account cannot be read: an unreadable link is not "no account", and the caller
   *   handles it like any other failure of the catalogue.
   *
   * One run reads the catalogue at a time: a call made while another one is running (the match page
   * asks twice for the heroes at once, and {@link HeroCatalogService.getHeroes} comes through here
   * too) gets the answer of that run, so the catalogue is downloaded once, not once per caller. The
   * account, the cache and the download are then read once, and a failed refresh is logged once.
   * Once the run has settled, however it ended, the next call starts a new one.
   */
  getHeroAssets(): Promise<readonly HeroAsset[]> {
    if (this.#running !== null) {
      return this.#running;
    }
    // The run is registered in the very turn it starts in, so that no call can slip in between.
    const run = this.#readHeroAssets().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  /**
   * Read the catalogue: the cache, or the download when the cache is not fresh (see
   * {@link HeroCatalogService.getHeroAssets}, which shares the run among the calls).
   *
   * @returns The catalogue.
   * @throws AppError under the same conditions as {@link HeroCatalogService.getHeroAssets}.
   */
  async #readHeroAssets(): Promise<readonly HeroAsset[]> {
    const accountId = await this.#accountSource.currentAccountId();
    const cached = await this.#readCache();
    if (accountId === null) {
      return cached?.heroes ?? [];
    }
    const now = this.#now();
    // A catalogue downloaded after `now` means that the system clock moved backwards since: it
    // would stay fresh until the clock catches up, so it is downloaded again instead.
    if (cached !== null && cached.fetchedAt <= now && cached.expiresAt > now) {
      return cached.heroes;
    }
    let heroes: HeroAsset[];
    try {
      heroes = await this.#api.fetchHeroes();
    } catch (error) {
      if (cached === null) {
        throw error;
      }
      this.#logger.log(
        'warn',
        'heroes',
        'Could not refresh the hero catalogue, using the cached one',
        errorLogContext(toAppError(error)),
      );
      return cached.heroes;
    }
    try {
      await this.#cache.put(CACHE_KEY, {
        payloadJson: JSON.stringify(heroes),
        fetchedAt: now,
        expiresAt: now + CACHE_TTL_MS,
      });
    } catch (error) {
      // The fresh catalogue is still good to show; it will simply be downloaded again next time.
      this.#logger.log(
        'warn',
        'heroes',
        'Could not cache the hero catalogue',
        errorLogContext(toAppError(error)),
      );
    }
    return heroes;
  }

  /**
   * Read the cached catalogue.
   *
   * @returns The heroes and the times of their download and of the end of their freshness, or
   *   `null` when nothing valid is cached. An entry written before M4b (heroes without the portrait
   *   and loadout keys) is not valid: it reads as absent, quietly, because it is no fault to report.
   */
  async #readCache(): Promise<{
    heroes: HeroAsset[];
    fetchedAt: number;
    expiresAt: number;
  } | null> {
    const entry = await this.#cache.get(CACHE_KEY);
    if (entry === null) {
      return null;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(entry.payloadJson);
    } catch {
      return null;
    }
    const heroes = cachedHeroesSchema.safeParse(payload);
    return heroes.success
      ? { heroes: heroes.data, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt }
      : null;
  }
}

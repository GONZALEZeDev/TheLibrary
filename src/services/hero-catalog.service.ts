/**
 * The hero catalogue: the English names of the playable heroes, with their portraits and loadouts.
 *
 * The catalogue is kept by the rules of `cached-catalogue.ts`, like the item and rank catalogues:
 * downloaded at most once a week, the last one downloaded used when it cannot be refreshed, nothing
 * downloaded until an account is linked, and one run shared by the callers that overlap. This
 * module says what is kept of each hero.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { SIGNATURE_ABILITY_COUNT } from '../core/deadlock-api/heroes.schema';
import type { Hero, HeroAsset } from '../core/domain/hero';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import { cachedCatalogue, cachedImageUrlSchema } from './cached-catalogue';
import type { DeadlockApiService } from './deadlock-api.service';

/**
 * Schema of the loadout of a cached hero: the class names of its weapon, its melee attack and its
 * signature abilities. The cache is written from a download that was already validated, but the
 * number of abilities is checked again: the damage view classifies the sources by a loadout of
 * exactly four signature abilities, whatever the cache holds.
 */
const cachedLoadoutSchema = z.object({
  weapon: z.string().min(1),
  melee: z.string().min(1),
  abilities: z.array(z.string().min(1)).length(SIGNATURE_ABILITY_COUNT),
});

/**
 * Schema of the cached catalogue: never empty, as the download refuses an empty one.
 *
 * The portrait and the loadout are required keys that may be `null`. That is what tells an entry
 * written since M4b from an older one, which held `{ id, name }` heroes only: the older entry does
 * not fit, so it counts as absent and the catalogue is downloaded again. The portrait must be on
 * the asset bucket, like every image a catalogue gives. The annotation makes the compiler check
 * that what the schema gives is a list of heroes with their assets.
 */
const cachedHeroesSchema: z.ZodType<HeroAsset[]> = z
  .array(
    z.object({
      id: z.int().positive(),
      name: z.string().min(1),
      imageUrl: cachedImageUrlSchema,
      loadout: cachedLoadoutSchema.nullable(),
    }),
  )
  .min(1);

/** What {@link HeroCatalogService} needs. */
export interface HeroCatalogServiceDependencies {
  /** The linked account: without one, nothing is downloaded. */
  readonly accountSource: AccountSource;
  /** Downloads the catalogue, within the asset budget of deadlock-api. */
  readonly api: DeadlockApiService;
  /** Keeps the catalogue between sessions. */
  readonly cache: ApiCacheRepository;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * Provides the hero catalogue.
 *
 * A call made while another one is running gets the answer of that run (the match page asks twice
 * for the heroes at once, and {@link HeroCatalogService.getHeroes} comes through the same reader):
 * the catalogue is downloaded once, not once per caller, and a failed refresh is logged once.
 */
export class HeroCatalogService {
  /** Reads the catalogue, sharing the run among the calls that overlap. */
  readonly #readHeroes: () => Promise<readonly HeroAsset[]>;

  /**
   * @param dependencies - See {@link HeroCatalogServiceDependencies}.
   */
  constructor(dependencies: HeroCatalogServiceDependencies) {
    const { accountSource, api, cache, logger, now = Date.now } = dependencies;
    this.#readHeroes = cachedCatalogue(
      { accountSource, cache, logger, now },
      {
        // `v2`: the catalogue cached under `heroes.english` left out the heroes still flagged in
        // development, though players could pick them; a new key downloads it again at once.
        cacheKey: 'heroes.english.v2',
        label: 'hero catalogue',
        logScope: 'heroes',
        schema: cachedHeroesSchema,
        download: () => api.fetchHeroes(),
      },
    );
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
   *   handles it like any other failure of the catalogue. Concurrent calls share one run, so they
   *   all get the same answer or fail with the same error.
   */
  getHeroAssets(): Promise<readonly HeroAsset[]> {
    return this.#readHeroes();
  }
}

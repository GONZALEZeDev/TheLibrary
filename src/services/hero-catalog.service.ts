/**
 * The hero catalogue: the English names of the playable heroes.
 *
 * The catalogue changes with game patches only, so it is downloaded at most once a week and kept
 * in the database. When it cannot be refreshed (offline, deadlock-api unavailable), the last
 * catalogue downloaded is used, however old.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { Hero } from '../core/domain/hero';
import { errorLogContext, toAppError } from '../core/errors/app-error';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import type { DeadlockApiService } from './deadlock-api.service';

/** Cache key of the catalogue. The language is part of it, should other languages ever be kept. */
const CACHE_KEY = 'heroes.english';

/** Time after which the cached catalogue is refreshed: one week. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Schema of the cached catalogue: never empty, as the download refuses an empty one. */
const cachedHeroesSchema = z
  .array(z.object({ id: z.int().positive(), name: z.string().min(1) }))
  .min(1);

/** Provides the hero catalogue. */
export class HeroCatalogService {
  readonly #api: DeadlockApiService;
  readonly #cache: ApiCacheRepository;
  readonly #logger: Logger;
  readonly #now: () => number;

  /**
   * @param api - Downloads the catalogue.
   * @param cache - Keeps it between sessions.
   * @param logger - Structured logger.
   * @param now - Current time (Unix ms).
   */
  constructor(
    api: DeadlockApiService,
    cache: ApiCacheRepository,
    logger: Logger,
    now: () => number = Date.now,
  ) {
    this.#api = api;
    this.#cache = cache;
    this.#logger = logger;
    this.#now = now;
  }

  /**
   * The playable heroes, with their English names.
   *
   * @returns The catalogue: cached when fresh, downloaded otherwise, or the stale cached one when
   *   it cannot be downloaded.
   * @throws AppError when the catalogue can be neither read from the cache nor downloaded.
   */
  async getHeroes(): Promise<readonly Hero[]> {
    const now = this.#now();
    const cached = await this.#readCache();
    // A catalogue downloaded after `now` means that the system clock moved backwards since: it
    // would stay fresh until the clock catches up, so it is downloaded again instead.
    if (cached !== null && cached.fetchedAt <= now && cached.expiresAt > now) {
      return cached.heroes;
    }
    let heroes: Hero[];
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
   *   `null` when nothing valid is cached.
   */
  async #readCache(): Promise<{ heroes: Hero[]; fetchedAt: number; expiresAt: number } | null> {
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

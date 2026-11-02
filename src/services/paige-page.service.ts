/**
 * The Paige page: her hero entry, her weapon and her four abilities, as deadlock-api describes
 * them, with the stat panels built from them.
 *
 * The page is kept by the rules of `cached-catalogue.ts`, like the hero, item and rank catalogues:
 * downloaded at most once a week, the last one downloaded used when it cannot be refreshed, and one
 * run shared by the callers that overlap. Unlike them, it does not wait for a linked account: it
 * shows the game, not a player, and the tab works before any account is linked.
 *
 * The page is one cache entry per language, downloaded as a whole: the hero in the UI language, the
 * weapon in English, and each ability in English (its name is always shown in English) and, for
 * French, in French too (its texts). An entry that fails to download fails the whole run, and the
 * previous page of that language is kept: a page is never half-cached, nor shown in the other
 * language. Downloading per entry keeps the download small (a few kilobytes an entry, where the
 * item catalogue is about 6.5 MB per language).
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { apiLanguage } from '../core/deadlock-api/endpoints';
import { heroDetailSchema, type HeroDetail } from '../core/deadlock-api/hero-detail.schema';
import {
  abilityDetailSchema,
  weaponDetailSchema,
  type AbilityDetail,
  type WeaponDetail,
} from '../core/deadlock-api/item-detail.schema';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { buildStatPanels, type StatPanels } from '../core/hero-page/stat-panels';
import type { Language } from '../core/settings/language';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';
import { cachedCatalogue } from './cached-catalogue';
import type { DeadlockApiService } from './deadlock-api.service';

/** An ability in English (for its name) and in the UI language (for its texts and values). */
export interface AbilityPair {
  readonly english: AbilityDetail;
  /** The entry of the UI language: the English one itself in English. */
  readonly localised: AbilityDetail;
}

/** What the page downloads and keeps, for one language. */
export interface PaigeData {
  readonly hero: HeroDetail;
  readonly weapon: WeaponDetail;
  /** The four signature abilities, in slot order (the ultimate last). */
  readonly abilities: readonly AbilityPair[];
}

/** What the page shows. */
export interface PaigePageView {
  readonly hero: HeroDetail;
  readonly stats: StatPanels;
  readonly abilities: readonly AbilityPair[];
}

/**
 * Schema of the cached page: one page, with the hero, the weapon and four abilities. A cached
 * entry of another shape counts as nothing cached, and the page is downloaded again.
 */
const cachedPageSchema: z.ZodType<PaigeData[]> = z
  .array(
    z.object({
      hero: heroDetailSchema,
      weapon: weaponDetailSchema,
      abilities: z
        .array(z.object({ english: abilityDetailSchema, localised: abilityDetailSchema }))
        .length(4),
    }),
  )
  .length(1);

/** What {@link PaigePageService} needs. */
export interface PaigePageServiceDependencies {
  /** The linked account: without one, nothing is downloaded. */
  readonly accountSource: AccountSource;
  /** Downloads the entries, within the asset budget of deadlock-api. */
  readonly api: DeadlockApiService;
  /** Keeps the page between sessions. */
  readonly cache: ApiCacheRepository;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** Provides the Paige page, in the UI language. */
export class PaigePageService {
  readonly #dependencies: Required<PaigePageServiceDependencies>;

  /** The reader of each language, made at its first use: each language is its own cache entry. */
  readonly #readers = new Map<Language, () => Promise<readonly PaigeData[]>>();

  /**
   * @param dependencies - See {@link PaigePageServiceDependencies}.
   */
  constructor(dependencies: PaigePageServiceDependencies) {
    this.#dependencies = { now: Date.now, ...dependencies };
  }

  /**
   * The Paige page in a language.
   *
   * @param language - The UI language.
   * @returns The page: cached when fresh, downloaded otherwise, or the stale cached one when it
   *   cannot be downloaded, whether an account is linked or not. `null` only if the cache rules
   *   ever gave no page without an error, which the page treats as a failure.
   * @throws AppError when the page can be neither read from the cache nor downloaded. Concurrent
   *   calls in one language share one run.
   */
  async getPaigePage(language: Language): Promise<PaigePageView | null> {
    const [data] = await this.#readerOf(language)();
    if (data === undefined) {
      return null;
    }
    return {
      hero: data.hero,
      stats: buildStatPanels(data.hero, data.weapon),
      abilities: data.abilities,
    };
  }

  /**
   * The reader of a language, made at its first use.
   *
   * @param language - The UI language.
   * @returns The function that reads the page of that language, sharing its run among the calls
   *   that overlap.
   */
  #readerOf(language: Language): () => Promise<readonly PaigeData[]> {
    const known = this.#readers.get(language);
    if (known !== undefined) {
      return known;
    }
    const { accountSource, cache, logger, now } = this.#dependencies;
    const reader = cachedCatalogue(
      { accountSource, cache, logger, now },
      {
        cacheKey: `paige.${apiLanguage(language)}.v1`,
        label: 'Paige page',
        logScope: 'paige',
        schema: cachedPageSchema,
        download: async () => [await this.#download(language)],
        // The page shows the game, not a player: it does not wait for a linked account.
        requiresAccount: false,
      },
    );
    this.#readers.set(language, reader);
    return reader;
  }

  /**
   * Download the page of a language, entry after entry (the API paces them within its budget).
   *
   * @param language - The UI language.
   * @returns The page.
   * @throws AppError when any entry fails to download or to validate.
   */
  async #download(language: Language): Promise<PaigeData> {
    const { api } = this.#dependencies;
    const texts = apiLanguage(language);
    const hero = await api.fetchHeroDetail(PAIGE_HERO_ID, texts);
    const weapon = await api.fetchWeaponDetail(hero.weaponClass);
    const abilities: AbilityPair[] = [];
    for (const className of hero.abilityClasses) {
      const english = await api.fetchAbilityDetail(className, 'english');
      const localised =
        texts === 'english' ? english : await api.fetchAbilityDetail(className, texts);
      abilities.push({ english, localised });
    }
    return { hero, weapon, abilities };
  }
}

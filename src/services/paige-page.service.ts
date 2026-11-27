/**
 * The Paige page: her hero entry, her weapon and her four abilities, as deadlock-api describes
 * them, with the stat panels built from them.
 *
 * The page is kept by the rules of `cached-catalogue.ts`, like the hero, item and rank catalogues:
 * the last one downloaded used when it cannot be refreshed, and one run shared by the callers that
 * overlap. Unlike them, it does not wait for a linked account (it shows the game, not a player, and
 * the tab works before any account is linked), and it is not kept for a week: a game patch changes
 * the values the page shows, and the player must see them without updating the app.
 *
 * So the page is read in two steps, which the tab chains (`usePaigePage`):
 * - {@link PaigePageService.getPaigePage} gives the page kept in the cache at once, however old, so
 *   that the tab never waits for the network; it downloads only when nothing is kept yet;
 * - {@link PaigePageService.refreshPaigePage} downloads it again once per launch of the app: only
 *   when the page kept was downloaded before this launch. The tab then shows the new values.
 *
 * That is one download per launch and language at most (six to ten small requests, within the asset
 * budget), and none in a launch where the tab is not opened.
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
import { cachedCatalogue, type CacheTimes } from './cached-catalogue';
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

/**
 * How a read of the page treats the page kept in the cache:
 * - `kept`: served whatever its age (the page shows at once);
 * - `launch`: served only when downloaded during this launch of the app, downloaded again otherwise.
 */
type ReadMode = 'kept' | 'launch';

/** Provides the Paige page, in the UI language. */
export class PaigePageService {
  readonly #dependencies: Required<PaigePageServiceDependencies>;

  /** When this launch of the app began: the services are made once per launch. */
  readonly #launchedAt: number;

  /**
   * The reader of each language and mode, made at its first use: each language is its own cache
   * entry, which both modes read.
   */
  readonly #readers = new Map<`${Language}:${ReadMode}`, () => Promise<readonly PaigeData[]>>();

  /**
   * @param dependencies - See {@link PaigePageServiceDependencies}.
   */
  constructor(dependencies: PaigePageServiceDependencies) {
    this.#dependencies = { now: Date.now, ...dependencies };
    this.#launchedAt = this.#dependencies.now();
  }

  /**
   * The Paige page in a language, as kept in the cache: at once, however old.
   *
   * @param language - The UI language.
   * @returns The page kept in the cache, or the downloaded one when none is kept yet, whether an
   *   account is linked or not. `null` only if the cache rules ever gave no page without an error,
   *   which the page treats as a failure.
   * @throws AppError when no page is kept and none can be downloaded. Concurrent calls in one
   *   language share one run.
   */
  async getPaigePage(language: Language): Promise<PaigePageView | null> {
    return viewOf(await this.#readerOf(language, 'kept')());
  }

  /**
   * The Paige page in a language, downloaded during this launch of the app: downloaded now when the
   * page kept in the cache comes from an earlier launch, read from the cache otherwise.
   *
   * @param language - The UI language.
   * @returns The page of this launch, or the page kept in the cache when it cannot be downloaded (a
   *   warning is logged then, and the next call tries again). `null` as for
   *   {@link PaigePageService.getPaigePage}.
   * @throws AppError when no page is kept and none can be downloaded. Concurrent calls in one
   *   language share one run.
   */
  async refreshPaigePage(language: Language): Promise<PaigePageView | null> {
    return viewOf(await this.#readerOf(language, 'launch')());
  }

  /**
   * The reader of a language and a mode, made at its first use.
   *
   * @param language - The UI language.
   * @param mode - How the read treats the page kept in the cache.
   * @returns The function that reads the page, sharing its run among the calls that overlap.
   */
  #readerOf(language: Language, mode: ReadMode): () => Promise<readonly PaigeData[]> {
    const known = this.#readers.get(`${language}:${mode}`);
    if (known !== undefined) {
      return known;
    }
    const { accountSource, cache, logger, now } = this.#dependencies;
    const launchedAt = this.#launchedAt;
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
        isFresh:
          mode === 'kept' ? () => true : (cached: CacheTimes) => cached.fetchedAt >= launchedAt,
      },
    );
    this.#readers.set(`${language}:${mode}`, reader);
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

/**
 * What the tab shows of a page read from the cache or downloaded.
 *
 * @param pages - The page, alone in its list (the cache keeps it as a list of one).
 * @returns The page with its stat panels, or `null` when the list is empty.
 */
function viewOf(pages: readonly PaigeData[]): PaigePageView | null {
  const [data] = pages;
  if (data === undefined) {
    return null;
  }
  return {
    hero: data.hero,
    stats: buildStatPanels(data.hero, data.weapon),
    abilities: data.abilities,
  };
}

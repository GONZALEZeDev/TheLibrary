/**
 * The rules every catalogue of deadlock-api is kept by: the heroes, the items and the ranks.
 *
 * A catalogue changes with game patches only, so it is downloaded at most once a week and kept in
 * the database. When it cannot be refreshed (offline, deadlock-api unavailable or asked to pause,
 * asset budget spent), the last catalogue downloaded is used, however old.
 *
 * Until an account is linked, the app contacts nobody: a catalogue is then only read from the
 * cache, whatever its age. The reader enforces it itself, so no caller can break it by forgetting
 * to check the account first.
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
import { ASSET_IMAGE_ORIGIN } from '../core/deadlock-api/assets.schema';
import { errorLogContext, toAppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { ApiCacheRepository } from './api-cache.repository';

/** Time after which a cached catalogue is refreshed: one week. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Schema of the image link of a cached entry: a link on the asset bucket, or none.
 *
 * The cache is written from a download that was already validated, but the links are checked again
 * against the bucket: the release Content Security Policy only lets the app load images from there,
 * so nothing a catalogue gives may point anywhere else, whatever the cache holds.
 */
export const cachedImageUrlSchema = z.string().startsWith(ASSET_IMAGE_ORIGIN).nullable();

/** What a catalogue reader needs, shared by all the catalogues of a service. */
export interface CachedCatalogueDependencies {
  /** The linked account: without one, nothing is downloaded. */
  readonly accountSource: AccountSource;
  /** Keeps the catalogues between sessions. */
  readonly cache: ApiCacheRepository;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms). */
  readonly now: () => number;
}

/** What differs between the catalogues: where each is kept, how it is called and downloaded. */
export interface CatalogueSource<Entry> {
  /** Cache key of the catalogue. The language is part of it, should other languages ever be kept. */
  readonly cacheKey: string;
  /** What the catalogue is called in the log lines, e.g. `item catalogue`. */
  readonly label: string;
  /** Scope of the log lines: the one of the service that owns the catalogue. */
  readonly logScope: string;
  /**
   * Validates the cached list. An entry that does not fit (written by an older version of the app,
   * say) makes the whole entry of the cache count as absent, so the catalogue is downloaded again
   * rather than half-read.
   */
  readonly schema: z.ZodType<Entry[]>;
  /** Downloads the catalogue, already validated and reduced to what the cache keeps. */
  readonly download: () => Promise<Entry[]>;
}

/** The cached catalogue, with the times of its download and of the end of its freshness. */
interface CachedEntries<Entry> {
  readonly entries: Entry[];
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

/**
 * Make the reader of one catalogue.
 *
 * @param dependencies - The account, the cache, the logger and the clock.
 * @param source - The catalogue: where it is kept, how it is called and downloaded.
 * @returns A function that gives the catalogue: the cached one when fresh, the downloaded one
 *   otherwise (and cached), the stale cached one when the download fails. Without a linked account,
 *   nothing is downloaded: the cached one whatever its age, or an empty list. It throws AppError
 *   when the linked account cannot be read (an unreadable link is not "no account"), or when the
 *   download fails (a pause or a spent budget included) and nothing valid is cached. A call made
 *   while another one is running gets the answer of that run: the account, the cache and the
 *   download are read once, and a failed refresh is logged once. Once a run has settled, however it
 *   ended, the next call starts a new one.
 */
export function cachedCatalogue<Entry>(
  dependencies: CachedCatalogueDependencies,
  source: CatalogueSource<Entry>,
): () => Promise<readonly Entry[]> {
  return shareRun(() => readCatalogue(dependencies, source));
}

/**
 * Share the run of an operation among the calls that overlap.
 *
 * The match page asks for the same catalogue from several places at once (and the catalogues share
 * a budget of two requests a second), so a catalogue must not be downloaded once per caller.
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
 * Serve a catalogue under the rules every catalogue follows (see {@link cachedCatalogue}).
 *
 * @param dependencies - The account, the cache, the logger and the clock.
 * @param source - The catalogue.
 * @returns The catalogue.
 * @throws AppError when the linked account cannot be read, or when the download fails and nothing
 *   valid is cached.
 */
async function readCatalogue<Entry>(
  dependencies: CachedCatalogueDependencies,
  source: CatalogueSource<Entry>,
): Promise<readonly Entry[]> {
  const { accountSource, cache, logger } = dependencies;
  const accountId = await accountSource.currentAccountId();
  const cached = await readCache(cache, source);
  if (accountId === null) {
    return cached?.entries ?? [];
  }
  const now = dependencies.now();
  // A catalogue downloaded after `now` means that the system clock moved backwards since: it would
  // stay fresh until the clock catches up, so it is downloaded again instead.
  if (cached !== null && cached.fetchedAt <= now && cached.expiresAt > now) {
    return cached.entries;
  }
  let entries: Entry[];
  try {
    entries = await source.download();
  } catch (error) {
    // Any failure is a download that did not happen: the offline app, a pause asked by
    // deadlock-api, a spent budget or an unreadable answer all leave the catalogue as it was.
    if (cached === null) {
      throw error;
    }
    logger.log(
      'warn',
      source.logScope,
      `Could not refresh the ${source.label}, using the cached one`,
      errorLogContext(toAppError(error)),
    );
    return cached.entries;
  }
  try {
    await cache.put(source.cacheKey, {
      payloadJson: JSON.stringify(entries),
      fetchedAt: now,
      expiresAt: now + CACHE_TTL_MS,
    });
  } catch (error) {
    // The fresh catalogue is still good to show; it will simply be downloaded again next time.
    logger.log(
      'warn',
      source.logScope,
      `Could not cache the ${source.label}`,
      errorLogContext(toAppError(error)),
    );
  }
  return entries;
}

/**
 * Read a cached catalogue.
 *
 * @param cache - Where the catalogues are kept.
 * @param source - The catalogue.
 * @returns The entries and the times of their download and of the end of their freshness, or `null`
 *   when nothing valid is cached. An entry that is not JSON, or does not fit the schema (written by
 *   an older version of the app, say), reads as absent, quietly, because it is no fault to report:
 *   the catalogue is downloaded again and replaces it.
 * @throws AppError of kind `storage` when the database fails.
 */
async function readCache<Entry>(
  cache: ApiCacheRepository,
  source: CatalogueSource<Entry>,
): Promise<CachedEntries<Entry> | null> {
  const entry = await cache.get(source.cacheKey);
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

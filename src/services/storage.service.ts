/**
 * The size limit of the archive folder: how much the archives take, and the removal of the oldest
 * ones once they take more than the limit the player chose.
 *
 * The limit is a setting. It is enforced in two places: by the synchronisation, after the detail
 * downloads of every run (inside the run), and right after the player changes it (inside the
 * synchronisation's exclusive section, which an account change waits for). The settings page can
 * also ask, before it changes the limit, what an enforcement would remove under a new one: the
 * preview walks the same candidates the same way, without writing.
 *
 * Two kinds of archives are never removed, so the archive folder can stay over a limit they overrun
 * on their own: those of the matches of the last 90 days, which the detail queue would download
 * again as soon as their page opens, and those of the {@link PROTECTED_RECENT_ARCHIVES} newest Paige
 * matches, which the review reads.
 *
 * An evicted match keeps its stored metrics: only its file goes, and only once its metrics of the
 * current version are stored. Its row is marked `evicted` before its file is removed, so a crash or a
 * failed removal leaves a file no `ready` row points to, never a `ready` row without its file. That
 * orphan file is deleted by the start-up cleanup.
 *
 * The errors of the disk are logged with their kind only: the file system's message quotes the path
 * of the file, which holds the account id.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import { isAppError } from '../core/errors/app-error';
import {
  capBytes,
  estimatedCapacity,
  PROTECTED_RECENT_ARCHIVES,
  type StorageCapMb,
} from '../core/storage/storage-rules';
import type { AccountSource } from '../ports/account-source.port';
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Logger } from '../ports/logger.port';
import type { EvictionCandidate, MatchDetailRepository } from './match-detail.repository';
import type { SettingsService } from './settings.service';
import { isSuspensionRefusal } from './sync.service';

/** The scope of the log lines of the storage. */
const LOG_SCOPE = 'storage';

/** What the settings page shows of the archive folder. */
export interface StorageUsage {
  /** How many bytes the archive files take: the sizes of the `ready` matches. */
  readonly usedBytes: number;
  /** The limit the player chose, in megabytes. */
  readonly capMb: StorageCapMb;
  /** About how many archives the limit holds, from the mean size of the player's archives. */
  readonly estimatedMatches: number;
  /** How many of the newest archives are never removed. */
  readonly protectedCount: number;
}

/** What one enforcement of the limit came to. */
export interface EnforcementReport {
  /** How many archives were evicted. */
  readonly evicted: number;
}

/** What an enforcement of a limit would evict, as {@link StorageService.previewEviction} tells it. */
export interface EvictionPreview {
  /** How many archives would be evicted. */
  readonly evicted: number;
  /** How many bytes their files take. */
  readonly freedBytes: number;
}

/**
 * The walk of the candidates that the enforcement and its preview share, so that the two cannot
 * disagree: the candidates are taken in their order while the archives take more than the limit,
 * and each is handed to `evict`. One that `evict` answers `false` for is skipped: it is neither
 * counted nor subtracted, and the next one is taken instead. When the list runs out, only archives
 * that are never candidates are left.
 *
 * The walk itself reads and writes nothing: whatever is done to a candidate is done by `evict`.
 *
 * @param usedBytes - How many bytes the archives take before the walk.
 * @param limitBytes - The limit, in bytes.
 * @param candidates - The candidates, in the order they go.
 * @param evict - Evicts one candidate, or pretends to; answers whether it counts as evicted.
 * @returns How many candidates were evicted, and the bytes their files took.
 */
async function walkEvictionCandidates(
  usedBytes: number,
  limitBytes: number,
  candidates: readonly EvictionCandidate[],
  evict: (candidate: EvictionCandidate) => Promise<boolean>,
): Promise<EvictionPreview> {
  let used = usedBytes;
  let evicted = 0;
  let freedBytes = 0;
  for (const candidate of candidates) {
    if (used <= limitBytes) {
      break;
    }
    if (!(await evict(candidate))) {
      continue;
    }
    used -= candidate.archivedBytes;
    freedBytes += candidate.archivedBytes;
    evicted += 1;
  }
  return { evicted, freedBytes };
}

/** What {@link StorageService} needs. */
export interface StorageServiceDependencies {
  /** The linked account, read for the usage and for a change of the limit. */
  readonly accountSource: AccountSource;
  /** The detail state of the matches: the sizes of the archives, and the `evicted` status. */
  readonly details: MatchDetailRepository;
  /** The archive files. */
  readonly archive: ArchiveStore;
  /** Where the limit is saved. */
  readonly settings: SettingsService;
  /**
   * Run a task in the synchronisation's exclusive section (`SyncService.runExclusive`), which an
   * account change waits for and refuses while it is going. A function rather than the
   * synchronisation itself, which runs this service's enforcement inside its own runs.
   */
  readonly runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
  readonly logger: Logger;
  /** Current time (Unix ms), which tells the matches of the last 90 days; `Date.now` by default. */
  readonly now?: () => number;
}

/** Keeps the archive folder under the size limit the player chose. */
export class StorageService {
  readonly #accountSource: AccountSource;
  readonly #details: MatchDetailRepository;
  readonly #archive: ArchiveStore;
  readonly #settings: SettingsService;
  readonly #runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #logger: Logger;
  readonly #now: () => number;
  /**
   * The end of the last enforcement asked for, failed or not: the next one starts after it.
   *
   * Why: each enforcement reads the total size once and evicts from that reading, and a change of
   * the limit can ask while a synchronisation's enforcement runs (the exclusive section does not
   * keep them apart). Two loops started from the same reading would each evict as much, so the
   * second would remove archives that no longer needed to go. One at a time, the second reads the
   * sizes the first one left.
   */
  #lastEnforcement: Promise<void> = Promise.resolve();

  /**
   * @param dependencies - See {@link StorageServiceDependencies}.
   */
  constructor(dependencies: StorageServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#details = dependencies.details;
    this.#archive = dependencies.archive;
    this.#settings = dependencies.settings;
    this.#runExclusive = dependencies.runExclusive;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * What the archives of the linked account take, against the limit.
   *
   * @returns The usage, or `null` when no account is linked.
   * @throws AppError of kind `storage` when the database or the settings cannot be read, or the
   *   error of the account source.
   */
  async getUsage(): Promise<StorageUsage | null> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return null;
    }
    const [{ storageCapMb: capMb }, usedBytes, averageBytes] = await Promise.all([
      this.#settings.get(),
      this.#details.sumArchivedBytes(accountId),
      this.#details.averageArchiveBytes(accountId),
    ]);
    return {
      usedBytes,
      capMb,
      estimatedMatches: estimatedCapacity(capMb, averageBytes),
      protectedCount: PROTECTED_RECENT_ARCHIVES,
    };
  }

  /**
   * What {@link StorageService.enforceCap} would evict under a limit, for the linked account, now:
   * the same candidates, walked the same way, without writing anything (no row, no file, no setting,
   * no log line). The settings page asks it before a lower limit removes archives.
   *
   * It waits for an enforcement that runs, so that it reads the sizes that one leaves. A candidate
   * the detail queue takes back before the enforcement reaches it is counted here but skipped there,
   * where a later candidate can go instead.
   *
   * @param capMb - The limit to try, one of the presets.
   * @returns How many archives would be evicted and the bytes their files take, or `null` when no
   *   account is linked.
   * @throws AppError of kind `storage` when the database cannot be read, or the error of the account
   *   source.
   */
  async previewEviction(capMb: StorageCapMb): Promise<EvictionPreview | null> {
    await this.#lastEnforcement;
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return null;
    }
    const limit = capBytes(capMb);
    const used = await this.#details.sumArchivedBytes(accountId);
    if (used <= limit) {
      return { evicted: 0, freedBytes: 0 };
    }
    // Every candidate counts as evicted: nothing can take one back, since nothing is written.
    return walkEvictionCandidates(used, limit, await this.#listCandidates(accountId), () =>
      Promise.resolve(true),
    );
  }

  /**
   * Evict archives of an account, the oldest first, until its archives fit in the limit, or until
   * only the ones that are never evicted are left: those of the matches of the last 90 days, those
   * of the {@link PROTECTED_RECENT_ARCHIVES} newest Paige matches, and those whose metrics of the
   * current version are not stored yet. Nothing is written when they fit already; otherwise one
   * `info` line counts the archives evicted and the bytes freed.
   *
   * Each archive is marked `evicted` first, then its file is removed. A removal that fails leaves the
   * row `evicted` and the file on the disk, for the start-up cleanup: it is logged as an `error` with
   * its kind only, and the loop goes on, since the row no longer counts as used. So the bytes freed
   * that the line counts include those orphans: they no longer count toward the limit, and the
   * start-up cleanup removes their files. A candidate whose row is no longer `ready` when its turn
   * comes (the detail queue changed it meanwhile) is left alone: neither evicted nor counted.
   *
   * One enforcement runs at a time: a call made while one runs waits for it to end, whatever way,
   * then reads the sizes afresh.
   *
   * @param accountId - The account whose archives are trimmed.
   * @returns How many archives were evicted.
   * @throws AppError of kind `storage` when the database or the settings cannot be read or written:
   *   the archives evicted before the failure stay evicted.
   */
  enforceCap(accountId: AccountId): Promise<EnforcementReport> {
    const enforcement = this.#lastEnforcement.then(() => this.#evictOverCap(accountId));
    // What the next one waits for never rejects: a failure goes to its own caller, and must not keep
    // the next enforcement from running.
    this.#lastEnforcement = enforcement.then(
      () => undefined,
      () => undefined,
    );
    return enforcement;
  }

  /**
   * The work of {@link StorageService.enforceCap}, run one at a time by it.
   *
   * @param accountId - The account whose archives are trimmed.
   * @returns How many archives were evicted.
   * @throws AppError of kind `storage` when the database or the settings fail.
   */
  async #evictOverCap(accountId: AccountId): Promise<EnforcementReport> {
    const { storageCapMb } = await this.#settings.get();
    const limit = capBytes(storageCapMb);
    const used = await this.#details.sumArchivedBytes(accountId);
    if (used <= limit) {
      return { evicted: 0 };
    }
    const { evicted, freedBytes } = await walkEvictionCandidates(
      used,
      limit,
      await this.#listCandidates(accountId),
      async (candidate) => {
        // Only a row that is still `ready` is evicted. The detail queue can change a row between
        // the listing and its turn (a change of the limit runs alongside a synchronisation): its
        // file is then the queue's, so it is neither removed nor counted.
        if (!(await this.#details.markEvicted(accountId, candidate.matchId))) {
          return false;
        }
        try {
          await this.#archive.remove(accountId, candidate.matchId);
        } catch (error) {
          // The adapters do not wrap their failures: anything that is not an `AppError` yet is a
          // failure of the disk. Its message is never logged, since it quotes the path of the file.
          this.#logger.log('error', LOG_SCOPE, 'An evicted archive could not be removed', {
            kind: isAppError(error) ? error.kind : 'storage',
          });
        }
        // Counted either way: the row is `evicted`, so its bytes no longer count as used.
        return true;
      },
    );
    if (evicted > 0) {
      this.#logger.log('info', LOG_SCOPE, 'Archives evicted', { evicted, freedBytes });
    }
    return { evicted };
  }

  /**
   * The archives of an account that may be evicted now, oldest first: none of the matches of the
   * last 90 days (by this service's clock), of the protected newest Paige matches, or of the
   * matches whose metrics of the current version are not stored. When the list runs out, only
   * those are left.
   *
   * @param accountId - The account.
   * @returns The candidates, in the order they go.
   * @throws AppError of kind `storage` when the database fails.
   */
  #listCandidates(accountId: AccountId): Promise<readonly EvictionCandidate[]> {
    return this.#details.listEvictionCandidates(accountId, PROTECTED_RECENT_ARCHIVES, this.#now());
  }

  /**
   * Save a new limit, then enforce it at once for the linked account, inside the synchronisation's
   * exclusive section.
   *
   * The account is read inside the section: one read before an account change would be the account
   * being erased. When the section is refused (an account is being switched or erased), the limit
   * is saved all the same, and the next synchronisation enforces it.
   *
   * @param capMb - The new limit, one of the presets.
   * @returns A promise resolved once the limit is saved and enforced.
   * @throws AppError of kind `storage` when the settings cannot be saved, or when the enforcement
   *   fails (see {@link StorageService.enforceCap}); the error of the account source.
   */
  async setCap(capMb: StorageCapMb): Promise<void> {
    await this.#settings.update({ storageCapMb: capMb });
    try {
      await this.#runExclusive(async () => {
        const accountId = await this.#accountSource.currentAccountId();
        if (accountId !== null) {
          await this.enforceCap(accountId);
        }
      });
    } catch (error) {
      if (!isSuspensionRefusal(error)) {
        throw error;
      }
    }
  }
}

/**
 * Deletion of the local data of an account, and the cleanup at startup of everything that does not
 * belong to the linked account.
 *
 * An account's data is its matches (the state of their detail queue lives in the same rows), its
 * synchronisation state, its archive folder, and what the detail queue remembers of it in memory.
 * Unlinking or switching accounts deletes it ({@link AccountDataService.eraseAccount}); the sweep
 * ({@link AccountDataService.sweep}) runs at every start and deletes whatever is left of other
 * accounts, which is how a deletion that failed or was interrupted is finished: the account service
 * makes the link change first, and the sweep retries until the data is gone.
 *
 * The values that belong to no account stay: the request budget and the pause of deadlock-api in the
 * synchronisation state, the API cache, and the logs (the owner's decision D9).
 *
 * Deleted rows stay readable in the database file until it is compacted, so a deletion ends with a
 * compaction: a `VACUUM`, then a checkpoint of the write-ahead log (the desktop database is in WAL
 * mode, where `VACUUM` alone leaves the old pages in the main file; see
 * {@link DatabaseMaintenanceRepository.vacuum}). A compaction counts as done only when both went
 * through. It is owed from the moment the first row is deleted: a flag is saved first and cleared
 * only after the compaction, so a crash anywhere in between, or a checkpoint that was blocked, makes
 * the next start compact. If saving the flag fails, the deletion goes on anyway: a deletion that is
 * not crash-safe is better than data that is not deleted, and the compaction is still attempted.
 *
 * The compaction is owed even earlier than that: the link row holds the persona name and the avatar,
 * and they are overwritten or deleted when the link changes, which the account service does *before*
 * it asks for the erasure. {@link AccountDataService.prepareErasure} lets it save the flag ahead of
 * the link change, so that no crash window is left between the two.
 *
 * None of the methods rejects. Every step is tried even when an earlier one failed, a failure is
 * logged with the step that failed, and the caller learns from the report whether anything is left.
 *
 * Privacy: an account id and the name of an archive folder (which is the id) are never logged. A
 * database error is logged with its context, as everywhere; the message of an archive error can
 * quote the path of a folder, so only its kind is logged.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import { errorLogContext, toAppError, type AppErrorContext } from '../core/errors/app-error';
import { accountFolderName, isArchiveEntryName } from '../core/match-detail/archive-layout';
import type { ArchiveStore } from '../ports/archive-store.port';
import type { Logger } from '../ports/logger.port';
import type { DatabaseMaintenanceRepository } from './database-maintenance.repository';
import type { MatchDetailService } from './match-detail.service';
import type { MatchesRepository } from './matches.repository';
import type { SyncStateRepository } from './sync-state.repository';

/** Scope of every log line of this service. */
const LOG_SCOPE = 'account.data';

/** The message of the line logged for a step that failed. */
const FAILURE_MESSAGE = 'Could not delete account data';

/**
 * The step that failed, as logged: the `matches` or the synchronisation state (`sync_state`) of an
 * account, the files of the `archive`, the compaction (`vacuum`, its flag included), or the `check`
 * after a deletion.
 */
type Step = 'matches' | 'sync_state' | 'archive' | 'vacuum' | 'check';

/** The part of an account's data the `check` looked at. */
type CheckedPart = 'matches' | 'sync_state' | 'archive';

/**
 * Where a failure came from, which decides how much of it may be logged: a database error is
 * logged with its context, an archive error by its kind only.
 */
type Source = 'database' | 'archive';

/** What an attempt came to: the value it returned, or the fact that it failed (already logged). */
type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** What {@link AccountDataService} needs. */
export interface AccountDataServiceDependencies {
  /** The matches of every account. */
  readonly matches: MatchesRepository;
  /** The synchronisation state, and the flag of the owed compaction. */
  readonly syncState: SyncStateRepository;
  /** The archive folder. */
  readonly archive: ArchiveStore;
  /** Compacts the database. */
  readonly maintenance: DatabaseMaintenanceRepository;
  /** The detail queue, which remembers in memory why its last run stopped. */
  readonly details: MatchDetailService;
  /** Structured logger. */
  readonly logger: Logger;
}

/** How a deletion went. */
export interface ErasureReport {
  /**
   * `true` when the data of the account is gone and the database is compacted: every deletion and
   * the compaction succeeded, and the check found nothing of the account. `false` when something
   * may be left, or the compaction is owed: the next start's sweep retries it. The flag of the owed
   * compaction is not part of it: failing to save or to clear it is logged, and only costs a
   * compaction that could be missed after a crash, or done twice.
   */
  readonly complete: boolean;
}

/** What a startup sweep did. */
export interface SweepReport {
  /**
   * The other accounts whose rows and synchronisation state the sweep tried to delete, each once. A
   * deletion that failed is logged with its step, not counted out: the next sweep finds the account
   * again.
   */
  readonly accounts: number;
  /** The entries of the archive folder that were removed. */
  readonly entries: number;
  /** Whether the database was compacted: the `VACUUM` and the checkpoint of its log went through. */
  readonly vacuumed: boolean;
}

/** Deletes the local data of accounts. */
export class AccountDataService {
  readonly #matches: MatchesRepository;
  readonly #syncState: SyncStateRepository;
  readonly #archive: ArchiveStore;
  readonly #maintenance: DatabaseMaintenanceRepository;
  readonly #details: MatchDetailService;
  readonly #logger: Logger;

  /**
   * @param dependencies - See {@link AccountDataServiceDependencies}.
   */
  constructor(dependencies: AccountDataServiceDependencies) {
    this.#matches = dependencies.matches;
    this.#syncState = dependencies.syncState;
    this.#archive = dependencies.archive;
    this.#maintenance = dependencies.maintenance;
    this.#details = dependencies.details;
    this.#logger = dependencies.logger;
  }

  /**
   * Save that a compaction is owed, ahead of an erasure whose first step is not a deletion of this
   * service: the account service changes the link (a switch saves the new one, an unlink clears it),
   * and only then asks for {@link AccountDataService.eraseAccount}.
   *
   * Without it, an app killed between the link change and the erasure would leave the old persona
   * name and avatar in the free pages of the database for good, when the account had no match and
   * no saved synchronisation state yet: the next start's sweep would find nothing to delete, owe no
   * compaction, and not compact. With the flag saved first, that start compacts. If the link change
   * then fails, nothing is deleted and the flag only costs one compaction at the next start.
   *
   * Call it with the synchronisation suspended, right before the link changes. It deletes nothing
   * and compacts nothing. {@link AccountDataService.eraseAccount} saves the flag too, which is
   * harmless and keeps that method correct on its own.
   *
   * @returns A promise resolved once the flag is saved; it never rejects. A flag that cannot be saved
   *   is logged with the step `vacuum`, and the caller goes on: a link change that is not crash-safe
   *   is better than one that is refused.
   */
  async prepareErasure(): Promise<void> {
    await this.#markVacuumPending();
  }

  /**
   * Delete every local data of an account: its matches, its synchronisation state, its archive
   * folder and what the detail queue remembers of it. Then compact the database and check that
   * nothing of the account is left.
   *
   * The synchronisation must be suspended around the call: a run in progress would write for the
   * account again. Deleting an account that has no data succeeds (an unlink that is retried).
   *
   * @param accountId - The account.
   * @returns Whether everything was deleted. It never rejects.
   */
  async eraseAccount(accountId: AccountId): Promise<ErasureReport> {
    // Whether the flag could be saved does not enter the report: it only protects against a crash
    // between the deletion and the compaction, and the compaction below does not depend on it. The
    // account service has usually saved it already (see `prepareErasure`); saving it again costs
    // one write and keeps this method correct when it is called on its own.
    await this.#markVacuumPending();
    const rowsDeleted = await this.#deleteRows(accountId);
    const folderRemoved = (
      await this.#attempt('archive', 'archive', () =>
        this.#archive.removeEntry(accountFolderName(accountId)),
      )
    ).ok;
    const compacted = await this.#compact();
    const checked = await this.#check(accountId);
    return { complete: rowsDeleted && folderRemoved && compacted && checked };
  }

  /**
   * Delete everything that does not belong to the linked account: the matches and the
   * synchronisation state of every other account, and every entry of the archive folder but the
   * folder of the linked account (the folders of other accounts, the quarantine folder of the first
   * layout, leftover temporary files, anything unknown). Then compact the database if a compaction
   * is owed, which is also how a deletion interrupted before its compaction is finished.
   *
   * A listing that fails is logged with its step, and that part is skipped. An archive entry whose
   * name the store would refuse (it is not a single plain name) is skipped and logged without its
   * name: asking for its removal would fail at every launch.
   *
   * @param linked - The linked account, or `null` when there is none: then nothing is kept.
   * @returns What was done. It never rejects.
   */
  async sweep(linked: AccountId | null): Promise<SweepReport> {
    let compactionOwed = await this.#readVacuumPending();
    const others = await this.#otherAccounts(linked);
    // Every other account is attempted once; one that fails is logged by its step, and found again
    // by the next sweep.
    const accounts = others.length;
    if (accounts > 0) {
      // Owed from here on, even when the flag could not be saved.
      await this.#markVacuumPending();
      compactionOwed = true;
      for (const accountId of others) {
        await this.#deleteRows(accountId);
      }
    }
    const entries = await this.#removeEntriesExcept(linked);
    const vacuumed = compactionOwed && (await this.#compact());
    this.#logger.log(
      accounts > 0 || entries > 0 || vacuumed ? 'info' : 'debug',
      LOG_SCOPE,
      'Startup cleanup',
      { accounts, entries, vacuumed },
    );
    return { accounts, entries, vacuumed };
  }

  /**
   * Delete the rows and the synchronisation state of an account, and forget it in the detail queue.
   * Both deletions are tried even when the first fails: whichever stays is found again by the next
   * sweep.
   *
   * @param accountId - The account.
   * @returns `true` when both deletions succeeded.
   */
  async #deleteRows(accountId: AccountId): Promise<boolean> {
    // In memory and trivial, so it has no step of its own to fail.
    this.#details.forgetAccount(accountId);
    const matchesDeleted = await this.#attempt('matches', 'database', () =>
      this.#matches.deleteAccount(accountId),
    );
    const stateDeleted = await this.#attempt('sync_state', 'database', () =>
      this.#syncState.deleteAccountState(accountId),
    );
    return matchesDeleted.ok && stateDeleted.ok;
  }

  /**
   * The accounts that have data and are not the linked one: those with matches and those with a
   * synchronisation state, each listed on its own so that one listing failing leaves the other.
   *
   * @param linked - The linked account, or `null`.
   * @returns Each account once, lowest id first.
   */
  async #otherAccounts(linked: AccountId | null): Promise<AccountId[]> {
    const withMatches = await this.#attempt('matches', 'database', () =>
      this.#matches.listAccountIds(),
    );
    const withState = await this.#attempt('sync_state', 'database', () =>
      this.#syncState.listAccountIds(),
    );
    const others = new Set([
      ...(withMatches.ok ? withMatches.value : []),
      ...(withState.ok ? withState.value : []),
    ]);
    if (linked !== null) {
      others.delete(linked);
    }
    return [...others].sort((first, second) => first - second);
  }

  /**
   * Remove the entries of the archive folder, except the folder of one account.
   *
   * @param kept - The account whose folder stays, or `null` to keep nothing.
   * @returns How many entries were removed.
   */
  async #removeEntriesExcept(kept: AccountId | null): Promise<number> {
    const listing = await this.#attempt('archive', 'archive', () => this.#archive.listEntries());
    if (!listing.ok) {
      return 0;
    }
    const keptName = kept === null ? null : accountFolderName(kept);
    let removed = 0;
    for (const name of listing.value) {
      if (name === keptName) {
        continue;
      }
      if (!isArchiveEntryName(name)) {
        // Without the name: it can be anything a program put there, even the digits of an account.
        this.#logFailure({ step: 'archive' });
        continue;
      }
      if ((await this.#attempt('archive', 'archive', () => this.#archive.removeEntry(name))).ok) {
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Save that a compaction is owed. A failure is logged, and the caller goes on as if it was saved:
   * see the header of the file.
   */
  async #markVacuumPending(): Promise<void> {
    await this.#attempt('vacuum', 'database', () => this.#syncState.setVacuumPending(true));
  }

  /**
   * Read whether a compaction is owed.
   *
   * @returns The flag; `false` when it cannot be read (logged), so that the compaction waits for a
   *   start that can read it rather than guessing.
   */
  async #readVacuumPending(): Promise<boolean> {
    const pending = await this.#attempt('vacuum', 'database', () =>
      this.#syncState.isVacuumPending(),
    );
    return pending.ok && pending.value;
  }

  /**
   * Compact the database (the `VACUUM` and the checkpoint of the log, see
   * {@link DatabaseMaintenanceRepository.vacuum}), then clear the flag. The flag is cleared only
   * after a compaction that succeeded: a failure, a blocked checkpoint included, leaves it set, and
   * the next start compacts again. A flag that cannot be cleared is logged but does not undo the
   * compaction: the next start compacts once more, for nothing.
   *
   * @returns `true` when the database was compacted and checkpointed.
   */
  async #compact(): Promise<boolean> {
    const vacuumed = (await this.#attempt('vacuum', 'database', () => this.#maintenance.vacuum()))
      .ok;
    if (vacuumed) {
      await this.#attempt('vacuum', 'database', () => this.#syncState.setVacuumPending(false));
    }
    return vacuumed;
  }

  /**
   * Check that nothing of an account is left: no match, no synchronisation state, no archive folder.
   * Each part is looked at, and logged, on its own.
   *
   * @param accountId - The account.
   * @returns `true` when nothing is left and every part could be read.
   */
  async #check(accountId: AccountId): Promise<boolean> {
    const folder = accountFolderName(accountId);
    const matchesGone = await this.#verify(
      'matches',
      'database',
      async () => (await this.#matches.count(accountId)) === 0,
    );
    const stateGone = await this.#verify(
      'sync_state',
      'database',
      async () => !(await this.#syncState.hasAccountState(accountId)),
    );
    const folderGone = await this.#verify(
      'archive',
      'archive',
      async () => !(await this.#archive.listEntries()).includes(folder),
    );
    return matchesGone && stateGone && folderGone;
  }

  /**
   * Look at one part of an account's data after its deletion.
   *
   * @param part - The part.
   * @param source - Where reading it fails from.
   * @param isGone - Tells whether nothing of the part is left.
   * @returns `true` when nothing is left. A part that is left, or that cannot be read, is logged.
   */
  async #verify(
    part: CheckedPart,
    source: Source,
    isGone: () => Promise<boolean>,
  ): Promise<boolean> {
    const gone = await this.#attempt('check', source, isGone, part);
    if (gone.ok && !gone.value) {
      this.#logFailure({ step: 'check', part });
    }
    return gone.ok && gone.value;
  }

  /**
   * Run a step that may fail: a failure is logged, and the caller carries on.
   *
   * @param step - What the step is, for the log.
   * @param source - Where a failure of the step comes from.
   * @param action - The step.
   * @param part - The part of the data a `check` is looking at.
   * @returns The value the step returned, or that it failed.
   */
  async #attempt<T>(
    step: Step,
    source: Source,
    action: () => Promise<T>,
    part?: CheckedPart,
  ): Promise<Attempt<T>> {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      // An archive error can quote the path of a folder, which holds the account id: only its kind
      // is kept. A database error is logged in full, as everywhere else.
      const details =
        source === 'archive'
          ? { kind: toAppError(error).kind }
          : errorLogContext(toAppError(error));
      this.#logFailure({ ...details, step, ...(part === undefined ? {} : { part }) });
      return { ok: false };
    }
  }

  /**
   * Log a step that failed.
   *
   * @param context - The step, and what is known of the failure.
   */
  #logFailure(context: AppErrorContext): void {
    this.#logger.log('warn', LOG_SCOPE, FAILURE_MESSAGE, context);
  }
}

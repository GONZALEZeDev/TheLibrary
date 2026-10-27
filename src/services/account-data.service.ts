/**
 * Deletion of the local data of an account, the cleanup at startup of everything that does not
 * belong to the linked account, and the reconciliation at startup of the linked account's archive
 * files with its rows.
 *
 * An account's data is its matches (the state of their detail queue lives in the same rows), the
 * projections and metrics of their analysis, its synchronisation state, its archive folder, and what
 * the detail queue remembers of it in memory. The rank of the player is not listed apart: it lives in
 * the row of the link, which the account service deletes or overwrites itself. Unlinking or
 * switching accounts deletes it ({@link AccountDataService.eraseAccount}); the sweep
 * ({@link AccountDataService.sweep}) runs at every start and deletes whatever is left of other
 * accounts, which is how a deletion that failed or was interrupted is finished: the account service
 * makes the link change first, and the sweep retries until the data is gone.
 *
 * The sweep also brings the archive files of the linked account back in line with its rows, so that
 * the size of the archive folder is what the rows say: a `ready` match whose file is gone goes back
 * to `pending` while it is in the window of the last 90 days (the queue downloads it again), and is
 * marked `evicted` past it (it keeps its stored metrics); and a file that no `ready` match stands for
 * (an eviction whose removal failed, or a write that crashed before its row was marked) is deleted.
 * It runs only when both listings could be read: a listing that failed is not an empty one, and
 * taking it for one would take every archive for gone, or delete every file. An empty list of files
 * while the account has `ready` matches is not trusted either, since a missing or unreachable folder
 * reads the same: the archives are left as they are, with a warning.
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
 * The reconciliation is the exception: it changes nothing at all after one of its listings failed,
 * or when the files came back empty while the account has `ready` matches (see above).
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
import type { MatchDetailRepository } from './match-detail.repository';
import type { MatchDetailService } from './match-detail.service';
import type { MatchesRepository } from './matches.repository';
import type { MetricsRepository } from './metrics.repository';
import type { SyncStateRepository } from './sync-state.repository';

/** Scope of every log line of this service. */
const LOG_SCOPE = 'account.data';

/** The message of the line logged for a step of a deletion, or of its check, that failed. */
const FAILURE_MESSAGE = 'Could not delete account data';

/** The message of the line logged for a step of the reconciliation of the archives that failed. */
const RECONCILE_FAILURE_MESSAGE = 'Could not reconcile the archives';

/**
 * The message of the warning logged when the linked account has archived matches and no archive
 * file is listed, so that the reconciliation leaves everything as it is.
 */
const NO_ARCHIVE_FILES_MESSAGE =
  'No archive file found for the archived matches: the archives are left as they are';

/**
 * The step that failed, as logged: the `matches`, the projections and metric values of their
 * analysis (`metrics`) or the synchronisation state (`sync_state`) of an account, the files of the
 * `archive`, the compaction (`vacuum`, its flag included), the `check` after a deletion, or the
 * reconciliation of the linked account's archives, on the side of its rows (`reconcile_rows`:
 * listing the `ready` matches, marking one whose file is missing) or of its files
 * (`reconcile_files`: listing them, removing one).
 */
type Step =
  | 'matches'
  | 'metrics'
  | 'sync_state'
  | 'archive'
  | 'vacuum'
  | 'check'
  | 'reconcile_rows'
  | 'reconcile_files';

/**
 * The message logged for each step that failed: the log is read to understand a problem, so a
 * reconciliation that failed does not say that a deletion did. Every step is listed, so a new one
 * cannot be added without choosing its message.
 */
const FAILURE_MESSAGES: Readonly<Record<Step, string>> = {
  matches: FAILURE_MESSAGE,
  metrics: FAILURE_MESSAGE,
  sync_state: FAILURE_MESSAGE,
  archive: FAILURE_MESSAGE,
  vacuum: FAILURE_MESSAGE,
  check: FAILURE_MESSAGE,
  reconcile_rows: RECONCILE_FAILURE_MESSAGE,
  reconcile_files: RECONCILE_FAILURE_MESSAGE,
};

/** The part of an account's data the `check` looked at. */
type CheckedPart = 'matches' | 'metrics' | 'sync_state' | 'archive';

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
  /** The projections and the metric values of the analysis of every account. */
  readonly metrics: MetricsRepository;
  /** The synchronisation state, and the flag of the owed compaction. */
  readonly syncState: SyncStateRepository;
  /** The archive folder. */
  readonly archive: ArchiveStore;
  /** The detail status of the matches: which are archived, and the mark of a missing archive. */
  readonly detailRepository: Pick<
    MatchDetailRepository,
    'listReadyMatchIds' | 'markArchiveMissing'
  >;
  /** Compacts the database. */
  readonly maintenance: DatabaseMaintenanceRepository;
  /** The detail queue, which remembers in memory why its last run stopped. */
  readonly details: MatchDetailService;
  /** Structured logger. */
  readonly logger: Logger;
  /**
   * Current time (Unix ms), which tells the matches of the last 90 days; `Date.now` by default.
   */
  readonly now?: () => number;
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
  readonly #metrics: MetricsRepository;
  readonly #syncState: SyncStateRepository;
  readonly #archive: ArchiveStore;
  readonly #detailRepository: Pick<
    MatchDetailRepository,
    'listReadyMatchIds' | 'markArchiveMissing'
  >;
  readonly #maintenance: DatabaseMaintenanceRepository;
  readonly #details: MatchDetailService;
  readonly #logger: Logger;
  readonly #now: () => number;

  /**
   * @param dependencies - See {@link AccountDataServiceDependencies}.
   */
  constructor(dependencies: AccountDataServiceDependencies) {
    this.#matches = dependencies.matches;
    this.#metrics = dependencies.metrics;
    this.#syncState = dependencies.syncState;
    this.#archive = dependencies.archive;
    this.#detailRepository = dependencies.detailRepository;
    this.#maintenance = dependencies.maintenance;
    this.#details = dependencies.details;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
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
   * Delete every local data of an account: its matches, the projections and metrics of their
   * analysis, its synchronisation state, its archive folder and what the detail queue remembers of
   * it. Then compact the database and check that nothing of the account is left.
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
   * Delete everything that does not belong to the linked account: the matches, the analysis rows
   * and the synchronisation state of every other account, and every entry of the archive folder but
   * the folder of the linked account (the folders of other accounts, the quarantine folder of the
   * first layout, leftover temporary files, anything unknown). Then reconcile the archive files of
   * the linked account with its rows (see the header of the file): a `ready` match without a file
   * goes back to `pending` in the window of the last 90 days and is marked evicted past it, a file
   * without a `ready` match is deleted, and one "Archives reconciled" line says how many of each
   * when there were any. Then compact the database if a compaction is owed, which is also how a
   * deletion interrupted before its compaction is finished.
   *
   * A listing that fails is logged with its step, and that part is skipped; for the
   * reconciliation, a failure of either of its listings skips all of it, and so does a listing
   * without any file while the account has `ready` matches (logged as a warning). An archive entry
   * whose name the store would refuse (it is not a single plain name) is skipped and logged without
   * its name: asking for its removal would fail at every launch.
   *
   * Call it with the synchronisation suspended, as the start-up does: a detail download running
   * meanwhile would write a file before its row is `ready`, which the reconciliation would delete.
   *
   * @param linked - The linked account, or `null` when there is none: then nothing is kept, and
   *   nothing is reconciled.
   * @returns What was done (the reconciliation is told by its log line, not in the report). It
   *   never rejects.
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
    if (linked !== null) {
      await this.#reconcileArchives(linked);
    }
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
   * Delete the matches, the analysis rows and the synchronisation state of an account, and forget it
   * in the detail queue. The three deletions are tried even when one fails: whichever stays is found
   * again by the next sweep.
   *
   * @param accountId - The account.
   * @returns `true` when the three deletions succeeded.
   */
  async #deleteRows(accountId: AccountId): Promise<boolean> {
    // In memory and trivial, so it has no step of its own to fail.
    this.#details.forgetAccount(accountId);
    const matchesDeleted = await this.#attempt('matches', 'database', () =>
      this.#matches.deleteAccount(accountId),
    );
    // No foreign key ties these tables to the matches: the order of the deletions is free.
    const metricsDeleted = await this.#attempt('metrics', 'database', () =>
      this.#metrics.deleteAccount(accountId),
    );
    const stateDeleted = await this.#attempt('sync_state', 'database', () =>
      this.#syncState.deleteAccountState(accountId),
    );
    return matchesDeleted.ok && metricsDeleted.ok && stateDeleted.ok;
  }

  /**
   * The accounts that have data and are not the linked one: those with matches, those with analysis
   * rows and those with a synchronisation state, each listed on its own so that one listing failing
   * leaves the others.
   *
   * @param linked - The linked account, or `null`.
   * @returns Each account once, lowest id first.
   */
  async #otherAccounts(linked: AccountId | null): Promise<AccountId[]> {
    const withMatches = await this.#attempt('matches', 'database', () =>
      this.#matches.listAccountIds(),
    );
    const withMetrics = await this.#attempt('metrics', 'database', () =>
      this.#metrics.listAccountIds(),
    );
    const withState = await this.#attempt('sync_state', 'database', () =>
      this.#syncState.listAccountIds(),
    );
    const others = new Set([
      ...(withMatches.ok ? withMatches.value : []),
      ...(withMetrics.ok ? withMetrics.value : []),
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
   * Bring the archive files of an account back in line with its rows: each `ready` match whose file
   * is gone goes back to `pending` in the window of the last 90 days, or is marked evicted past it
   * (`MatchDetailRepository.markArchiveMissing`, the one rule of the app for a missing archive),
   * then each file that no `ready` match stands for is deleted. One failure is logged with its step
   * and the others are still tried; whatever is left is found again by the next start. When there
   * was anything to do, one line says how much was done: the matches marked evicted, those put back
   * to `pending`, and the files removed.
   *
   * Nothing changes when either listing fails, nor when the account has `ready` matches and no
   * archive file at all (logged as a warning with the number of `ready` matches): its folder may
   * only be out of reach.
   *
   * @param accountId - The linked account.
   */
  async #reconcileArchives(accountId: AccountId): Promise<void> {
    // Both listings must be read before anything changes: a listing that failed would read as an
    // empty one, and then every row would look like a lost archive, or every file like an orphan.
    const files = await this.#attempt('reconcile_files', 'archive', () =>
      this.#archive.list(accountId),
    );
    if (!files.ok) {
      return;
    }
    const ready = await this.#attempt('reconcile_rows', 'database', () =>
      this.#detailRepository.listReadyMatchIds(accountId),
    );
    if (!ready.ok) {
      return;
    }
    if (files.value.length === 0 && ready.value.size > 0) {
      // The store answers an empty list both for an empty folder and for an account folder that is
      // missing or out of reach (a folder moved or deleted by hand, a drive that is not there).
      // Taken at its word, it would take every archive for gone; and if the folder is back at the
      // next start, every file there would then have no `ready` row, and be deleted. So nothing
      // changes this start. A match whose file really is gone is still caught when its page is
      // read, or when the analysis reads it: the same rule applies to a missing archive there.
      this.#logger.log('warn', LOG_SCOPE, NO_ARCHIVE_FILES_MESSAGE, { ready: ready.value.size });
      return;
    }
    const archived = new Set(files.value);
    // One clock for the whole pass, so that every row is judged against the same window.
    const now = this.#now();
    let evicted = 0;
    let pending = 0;
    for (const matchId of ready.value) {
      if (archived.has(matchId)) {
        continue;
      }
      const marked = await this.#attempt('reconcile_rows', 'database', () =>
        this.#detailRepository.markArchiveMissing(accountId, matchId, now),
      );
      // Counted only when the row was still `ready` and changed (`unchanged` counts nothing).
      if (marked.ok && marked.value === 'evicted') {
        evicted += 1;
      } else if (marked.ok && marked.value === 'pending') {
        pending += 1;
      }
    }
    let removed = 0;
    for (const matchId of files.value) {
      if (ready.value.has(matchId)) {
        continue;
      }
      // The store does not fail on a file that is already gone: a success means the file is gone.
      const removal = await this.#attempt('reconcile_files', 'archive', () =>
        this.#archive.remove(accountId, matchId),
      );
      if (removal.ok) {
        removed += 1;
      }
    }
    if (evicted > 0 || pending > 0 || removed > 0) {
      this.#logger.log('info', LOG_SCOPE, 'Archives reconciled', { evicted, pending, removed });
    }
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
   * Check that nothing of an account is left: no match, no analysis row, no synchronisation state,
   * no archive folder. Each part is looked at, and logged, on its own.
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
    const metricsGone = await this.#verify(
      'metrics',
      'database',
      async () => (await this.#metrics.countAccount(accountId)) === 0,
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
    return matchesGone && metricsGone && stateGone && folderGone;
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
   * Log a step that failed, with the message of its step (see {@link FAILURE_MESSAGES}).
   *
   * @param context - The step, and what is known of the failure.
   */
  #logFailure(context: AppErrorContext & { readonly step: Step }): void {
    this.#logger.log('warn', LOG_SCOPE, FAILURE_MESSAGES[context.step], context);
  }
}

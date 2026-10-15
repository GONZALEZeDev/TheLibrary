/**
 * Synchronisation of the match history: downloads the history of the linked account from
 * deadlock-api and saves it, at startup, every 13 minutes and when the user asks for it.
 *
 * Only one synchronisation runs at a time: a trigger arriving while one runs joins it. A
 * synchronisation never throws: its outcome is saved per account (shown by the interface) and
 * every failure is logged exactly once, here.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import { errorLogContext, toAppError, type AppError } from '../core/errors/app-error';
import {
  INITIAL_ACCOUNT_SYNC_STATE,
  type AccountSyncState,
  type LastSync,
  type SyncStatus,
} from '../core/sync/sync-status';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { DeadlockApiService } from './deadlock-api.service';
import type { MatchesRepository } from './matches.repository';
import type { SyncStateRepository } from './sync-state.repository';

/** What started a synchronisation. Only `manual` is the user's own request. */
export type SyncTrigger = 'startup' | 'schedule' | 'manual';

/**
 * Time between two automatic synchronisations: 13 minutes. 13 does not divide the hour, so a
 * synchronisation finds at most 4 earlier ones in the hour before it (the budget window), none at
 * its very edge where milliseconds decide: the timer plus one manual synchronisation stay below
 * `AUTOMATIC_HISTORY_RATE_LIMIT`. Timers never fire early, so two ticks are never closer than this.
 */
export const SYNC_INTERVAL_MS = 13 * 60_000;

/** How a synchronisation ended, as logged. */
type RunOutcome = LastSync['outcome'] | 'no_account' | 'protected_account';

/** What {@link SyncService} needs. */
export interface SyncServiceDependencies {
  readonly accountSource: AccountSource;
  readonly api: DeadlockApiService;
  readonly matches: MatchesRepository;
  readonly syncState: SyncStateRepository;
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** Synchronises the match history of the linked account. */
export class SyncService {
  readonly #accountSource: AccountSource;
  readonly #api: DeadlockApiService;
  readonly #matches: MatchesRepository;
  readonly #syncState: SyncStateRepository;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** The running synchronisation, shared by every trigger that arrives meanwhile. */
  #running: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #listeners = new Set<() => void>();

  /**
   * @param dependencies - See {@link SyncServiceDependencies}.
   */
  constructor(dependencies: SyncServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#api = dependencies.api;
    this.#matches = dependencies.matches;
    this.#syncState = dependencies.syncState;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * Synchronise now, or join the synchronisation already running: a call made while one runs gets
   * the outcome of that one, whatever its own trigger.
   *
   * @param trigger - What started it.
   * @returns A promise resolved when the synchronisation has ended; it never rejects.
   */
  syncNow(trigger: SyncTrigger): Promise<void> {
    if (this.#running === null) {
      this.#running = this.#run(trigger).finally(() => {
        this.#running = null;
        this.#notify();
      });
      this.#notify();
    }
    return this.#running;
  }

  /**
   * Start the automatic synchronisations: one right away, then one every
   * {@link SYNC_INTERVAL_MS}. Calling it again has no effect.
   */
  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    void this.syncNow('startup');
    this.#timer = setInterval(() => {
      void this.syncNow('schedule');
    }, SYNC_INTERVAL_MS);
  }

  /** Stop the automatic synchronisations (a running one ends normally). */
  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Tell whether a synchronisation is running. An arrow function, so that it can be passed as is
   * to React's `useSyncExternalStore`.
   *
   * @returns `true` while a synchronisation runs.
   */
  readonly isRunning = (): boolean => this.#running !== null;

  /**
   * Be told when a synchronisation starts or ends. An arrow function, for `useSyncExternalStore`.
   *
   * @param listener - Called at every start and end.
   * @returns A function that unsubscribes the listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Everything the interface shows about the synchronisation.
   *
   * @returns The status.
   * @throws AppError of kind `storage` when the saved state cannot be read, or the error of the
   *   account source.
   */
  async getStatus(): Promise<SyncStatus> {
    const accountId = await this.#accountSource.currentAccountId();
    const [pausedUntil, state] = await Promise.all([
      this.#syncState.getPausedUntil(),
      accountId === null
        ? Promise.resolve(INITIAL_ACCOUNT_SYNC_STATE)
        : this.#syncState.getAccountState(accountId),
    ]);
    return {
      running: this.isRunning(),
      accountLinked: accountId !== null,
      missingAccountHint: accountId === null ? this.#accountSource.missingAccountHint : null,
      lastSync: state.lastSync,
      pausedUntil: pausedUntil !== null && pausedUntil > this.#now() ? pausedUntil : null,
      protectedAccount: state.protectedAccount,
    };
  }

  /**
   * Run one synchronisation and log how it went.
   *
   * @param trigger - What started it.
   */
  async #run(trigger: SyncTrigger): Promise<void> {
    // A short id ties together the lines of one synchronisation in the log file.
    const syncRunId = crypto.randomUUID().slice(0, 8);
    const startedAt = this.#now();
    this.#logger.log('debug', 'sync', 'Synchronisation started', { syncRunId, trigger });
    let outcome: RunOutcome = 'failed';
    try {
      outcome = await this.#synchronise(trigger, syncRunId);
    } catch (error) {
      this.#logger.log('error', 'sync', 'Synchronisation failed', {
        ...errorLogContext(toAppError(error)),
        syncRunId,
      });
    } finally {
      // Without an account, or with a protected one, no request was sent: kept out of the log
      // files (the desktop app writes `info` and above), which would otherwise get a line at every
      // automatic synchronisation.
      this.#logger.log(
        outcome === 'no_account' || outcome === 'protected_account' ? 'debug' : 'info',
        'sync',
        'Synchronisation ended',
        {
          syncRunId,
          trigger,
          outcome,
          // Never negative, even when the system clock moved backwards meanwhile.
          durationMs: Math.max(0, this.#now() - startedAt),
        },
      );
    }
  }

  /**
   * Synchronise the linked account and save the outcome.
   *
   * @param trigger - What started it.
   * @param syncRunId - Id of this synchronisation in the logs.
   * @returns How it ended.
   * @throws AppError when it failed (its outcome is saved first, when possible).
   */
  async #synchronise(trigger: SyncTrigger, syncRunId: string): Promise<RunOutcome> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return 'no_account';
    }
    const state = await this.#syncState.getAccountState(accountId);
    // A protected account answers 403 to every request: only the user may try again.
    if (state.protectedAccount && trigger !== 'manual') {
      return 'protected_account';
    }
    try {
      const lastSync = await this.#fetchAndSave(accountId, state, trigger, syncRunId);
      return lastSync.outcome;
    } catch (error) {
      const appError = toAppError(error);
      await this.#saveFailure(accountId, state, appError, syncRunId);
      throw appError;
    }
  }

  /**
   * Download the history, save it and save the outcome.
   *
   * @param accountId - The account.
   * @param state - Its saved state before this synchronisation.
   * @param trigger - What started it.
   * @param syncRunId - Id of this synchronisation in the logs.
   * @returns The saved outcome.
   */
  async #fetchAndSave(
    accountId: AccountId,
    state: AccountSyncState,
    trigger: SyncTrigger,
    syncRunId: string,
  ): Promise<LastSync> {
    const result = await this.#api.fetchMatchHistory(accountId, {
      automatic: trigger !== 'manual',
    });
    if (result.kind !== 'fetched') {
      // Not an error: the history was not requested. What was downloaded before stays valid.
      const lastSync: LastSync = {
        finishedAt: this.#now(),
        outcome: result.kind,
        errorKind: null,
        newMatches: 0,
        historyFetchedAt: state.lastSync?.historyFetchedAt ?? null,
        historyFromSteam: state.lastSync?.historyFromSteam ?? null,
      };
      await this.#syncState.setAccountState(accountId, { ...state, lastSync });
      return lastSync;
    }
    // Counting before and after tells how many matches are new, whatever the upsert updated.
    const before = await this.#matches.count(accountId);
    await this.#matches.upsertMany(result.matches);
    const after = await this.#matches.count(accountId);
    const now = this.#now();
    const lastSync: LastSync = {
      finishedAt: now,
      outcome: 'synced',
      errorKind: null,
      newMatches: after - before,
      historyFetchedAt: now,
      historyFromSteam: result.fromSteam,
    };
    // A successful synchronisation proves the account is no longer protected.
    await this.#syncState.setAccountState(accountId, { lastSync, protectedAccount: false });
    this.#logger.log('info', 'sync', 'Match history saved', {
      syncRunId,
      received: result.matches.length,
      newMatches: lastSync.newMatches,
      fromSteam: result.fromSteam,
    });
    return lastSync;
  }

  /**
   * Save the outcome of a failed synchronisation. A failure to save it is logged and otherwise
   * ignored: the original failure is the one worth reporting.
   *
   * @param accountId - The account.
   * @param state - Its saved state before this synchronisation.
   * @param error - Why the synchronisation failed.
   * @param syncRunId - Id of this synchronisation in the logs.
   */
  async #saveFailure(
    accountId: AccountId,
    state: AccountSyncState,
    error: AppError,
    syncRunId: string,
  ): Promise<void> {
    try {
      await this.#syncState.setAccountState(accountId, {
        lastSync: {
          finishedAt: this.#now(),
          outcome: 'failed',
          errorKind: error.kind,
          newMatches: 0,
          historyFetchedAt: state.lastSync?.historyFetchedAt ?? null,
          historyFromSteam: state.lastSync?.historyFromSteam ?? null,
        },
        protectedAccount: error.kind === 'forbidden' || state.protectedAccount,
      });
    } catch (saveError) {
      this.#logger.log('warn', 'sync', 'Could not save the outcome of the synchronisation', {
        ...errorLogContext(toAppError(saveError)),
        syncRunId,
      });
    }
  }

  /**
   * Tell every listener that the running state changed. A failing listener is logged and skipped:
   * it must neither break the synchronisation nor keep the other listeners uninformed.
   */
  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.log(
          'warn',
          'sync',
          'A listener of the synchronisation failed',
          errorLogContext(toAppError(error)),
        );
      }
    }
  }
}

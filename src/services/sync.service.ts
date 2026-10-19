/**
 * Synchronisation of the match history and of the match details: downloads the history of the
 * linked account from deadlock-api and saves it, then runs the detail queue, which downloads and
 * archives the detail of the Paige matches that are due. It runs at startup, every 13 minutes, when
 * the user asks for it and right after an account was linked.
 *
 * Only one synchronisation runs at a time: a trigger arriving while one runs joins it. That is also
 * what keeps the detail queue (which is not safe to run twice at once) alone. A synchronisation
 * never throws: its outcome is saved per account (shown by the interface) and every failure is
 * logged exactly once, here.
 *
 * The queue runs after the history, whatever the history came to: a history that was not requested
 * (budget, pause) or that failed (a refusal, an error of the service) says nothing of the match
 * details, which have their own budget and their own pause handling. The one exception is a history
 * request that did not reach deadlock-api (`network`, `timeout`): the details would fail the same
 * way, so the run ends there. A `detail` run is the queue alone (see {@link SyncTrigger}).
 *
 * The listeners are told when a run starts and ends, and once more when its history step has saved
 * its outcome, before the queue starts: the queue can take many seconds, and the interface must not
 * wait for it to show the matches and the state of the history.
 *
 * The synchronisation can be suspended around a change of account (see {@link SyncService.suspend}).
 * A running detail queue captured the id of the account it was started for: left alone while the
 * account is erased, it would go on writing for that account, and could create the archive folder
 * of the old account again after its deletion. So the account service suspends the synchronisation
 * before it erases or switches an account: that waits for the run going to end, then refuses every
 * new run (the timer included, and the retry of a match detail) until it is resumed.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import type { MatchId } from '../core/domain/match';
import {
  errorLogContext,
  toAppError,
  type AppError,
  type AppErrorKind,
} from '../core/errors/app-error';
import {
  INITIAL_ACCOUNT_SYNC_STATE,
  type AccountSyncState,
  type LastSync,
  type SyncStatus,
} from '../core/sync/sync-status';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import type { DeadlockApiService } from './deadlock-api.service';
import type { DetailRunReport, MatchDetailService } from './match-detail.service';
import type { MatchesRepository } from './matches.repository';
import type { SyncStateRepository } from './sync-state.repository';

/**
 * What started a synchronisation:
 * - `startup` and `schedule` are automatic;
 * - `manual` is the user's own request, history and details;
 * - `detail` is the user's own request too (the "Retry" of a match detail), but for the details
 *   only: the history step is left out, so it sends no history request and changes nothing of what
 *   the history banner shows;
 * - `link` is the first synchronisation after an account was linked: the user's own request too,
 *   with the history and the details, so it is not held to the automatic part of the history budget
 *   and it is not stopped by a protected account.
 */
export type SyncTrigger = 'startup' | 'schedule' | 'manual' | 'detail' | 'link';

/**
 * Time between two automatic synchronisations: 13 minutes. 13 does not divide the hour, so a
 * synchronisation finds at most 4 earlier ones in the hour before it (the budget window), none at
 * its very edge where milliseconds decide: the timer plus one manual synchronisation stay below
 * `AUTOMATIC_HISTORY_RATE_LIMIT`. Timers never fire early, so two ticks are never closer than this.
 */
export const SYNC_INTERVAL_MS = 13 * 60_000;

/**
 * How a synchronisation ended, as logged: the outcome of its history step, or why there was none.
 * `detail_only` is a `detail` run, which has no history step and so no history outcome to report.
 */
type RunOutcome = LastSync['outcome'] | 'no_account' | 'protected_account' | 'detail_only';

/**
 * The errors of a request that never reached deadlock-api. When the history fails with one, the
 * match details would fail the same way: the run does not try them.
 */
const UNREACHABLE_KINDS: readonly AppErrorKind[] = ['network', 'timeout'];

/** The synchronisation that is running: its id in the logs, and the promise every trigger shares. */
interface RunningSync {
  readonly syncRunId: string;
  /** Settles when the run has ended; never rejects. */
  readonly done: Promise<void>;
}

/** What one run came to, for the log line that ends it. */
interface RunResult {
  readonly outcome: RunOutcome;
  /** How the detail queue went, or `null` when it did not run (or failed to report). */
  readonly detail: DetailRunReport | null;
}

/**
 * Tell whether nobody asked for a synchronisation: the start of the app and its timer. The others
 * are the user's own requests.
 *
 * @param trigger - What started the synchronisation.
 * @returns `true` for `startup` and `schedule`; `false` for `manual`, `detail` and `link`.
 */
function isAutomatic(trigger: SyncTrigger): boolean {
  return trigger === 'startup' || trigger === 'schedule';
}

/** What {@link SyncService} needs. */
export interface SyncServiceDependencies {
  readonly accountSource: AccountSource;
  readonly api: DeadlockApiService;
  /** The detail queue the synchronisation runs after the history, and the retry of one match. */
  readonly details: MatchDetailService;
  readonly matches: MatchesRepository;
  readonly syncState: SyncStateRepository;
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** Synchronises the match history and the match details of the linked account. */
export class SyncService {
  readonly #accountSource: AccountSource;
  readonly #api: DeadlockApiService;
  readonly #details: MatchDetailService;
  readonly #matches: MatchesRepository;
  readonly #syncState: SyncStateRepository;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** The running synchronisation, shared by every trigger that arrives meanwhile. */
  #running: RunningSync | null = null;
  /** The interval of the automatic synchronisations; `undefined` while it is not ticking. */
  #timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Whether the automatic synchronisations were started ({@link SyncService.start}) and not stopped
   * since. It outlives a suspension, which only stops the interval: that is how the interval comes
   * back on {@link SyncService.resume}, and how a second suspension leaves it be.
   */
  #timerWanted = false;
  /** Whether the synchronisation is suspended around a change of account. */
  #suspended = false;
  readonly #listeners = new Set<() => void>();

  /**
   * @param dependencies - See {@link SyncServiceDependencies}.
   */
  constructor(dependencies: SyncServiceDependencies) {
    this.#accountSource = dependencies.accountSource;
    this.#api = dependencies.api;
    this.#details = dependencies.details;
    this.#matches = dependencies.matches;
    this.#syncState = dependencies.syncState;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * Synchronise now, or join the synchronisation already running: a call made while one runs gets
   * the outcome of that one, whatever its own trigger, and does none of its own steps. So a
   * `schedule` or a `manual` call that joins a `detail` run gets no history step: the next
   * scheduled synchronisation is {@link SYNC_INTERVAL_MS} away, and the interface disables its Sync
   * button while a run is going, so the history waits for it. A join is logged at `debug`
   * ("Synchronisation joined", with the id of the run joined and the trigger of the caller): the
   * started run logs its own start, which a joiner would otherwise leave no trace of.
   *
   * While the synchronisation is suspended (see {@link SyncService.suspend}) nothing is started and
   * nothing is joined: the call is refused, at once, and logged at `debug`.
   *
   * @param trigger - What started it.
   * @returns A promise resolved when the synchronisation has ended (at once when it was refused); it
   *   never rejects.
   */
  syncNow(trigger: SyncTrigger): Promise<void> {
    if (this.#suspended) {
      this.#logRefusal(trigger);
      return Promise.resolve();
    }
    if (this.#running !== null) {
      this.#logger.log('debug', 'sync', 'Synchronisation joined', {
        syncRunId: this.#running.syncRunId,
        trigger,
      });
      return this.#running.done;
    }
    // A short id ties together the lines of one synchronisation in the log file.
    const syncRunId = crypto.randomUUID().slice(0, 8);
    const done = this.#run(trigger, syncRunId).finally(() => {
      this.#running = null;
      this.#notify();
    });
    this.#running = { syncRunId, done };
    this.#notify();
    return done;
  }

  /**
   * Try the detail of a match again, for the "Retry" action: put the match back in the queue
   * (only an `unavailable` or an `invalid` match goes back, see `MatchDetailService.resetForRetry`)
   * and run the detail queue, without the history.
   *
   * A synchronisation may be going already, in which case the run joins it. The queue of that run
   * may have tried the match already (the user saw it fail while the run went on), or have asked
   * for its last match already: it does not offer the match again. So when a run was going and
   * the match is still `pending` once it ends, one more `detail` run is made, and only one: if that
   * one cannot take the match either (a pause, say), the match stays in the queue for the next run.
   * A match that waits for a retry date (the joined run took it and it failed again) is not
   * `pending`: another run would not take it before that date.
   *
   * While the synchronisation is suspended the retry is refused before it touches the match, and
   * logged at `debug`: putting a match back in the queue writes its row, which must not happen to an
   * account that is being erased.
   *
   * @param matchId - The match.
   * @returns A promise resolved when the run is over (at once when the retry was refused); it never
   *   rejects. A failure is logged.
   */
  async retryDetail(matchId: MatchId): Promise<void> {
    if (this.#suspended) {
      this.#logRefusal('detail');
      return;
    }
    try {
      await this.#details.resetForRetry(matchId);
      // Whether the call below joins a run that was going, read in the same turn as that call.
      const joinsARun = this.#running !== null;
      await this.syncNow('detail');
      if (joinsARun && (await this.#isPending(matchId))) {
        await this.syncNow('detail');
      }
    } catch (error) {
      this.#logger.log('error', 'sync', 'The retry of a match detail failed', {
        ...errorLogContext(toAppError(error)),
        matchId,
      });
    }
  }

  /**
   * Start the automatic synchronisations: one right away, then one every
   * {@link SYNC_INTERVAL_MS}. Calling it again has no effect.
   *
   * While the synchronisation is suspended it only records that the timer is wanted: no run starts
   * and no interval is set until {@link SyncService.resume}, which then starts the interval alone.
   */
  start(): void {
    if (this.#timerWanted) {
      return;
    }
    this.#timerWanted = true;
    if (this.#suspended) {
      return;
    }
    void this.syncNow('startup');
    this.#startTimer();
  }

  /**
   * Stop the automatic synchronisations (a running one ends normally), and forget that they were
   * started: a suspended synchronisation that is resumed afterwards does not bring the timer back.
   */
  stop(): void {
    this.#timerWanted = false;
    this.#stopTimer();
  }

  /**
   * Suspend the synchronisation around a change of account, so that nothing writes for an account
   * while it is erased or switched. It stops the timer (remembering that it was started), then
   * waits for the run going, if any, to end: the run, and the joiners that wait for it, end
   * normally. From then on {@link SyncService.syncNow} and {@link SyncService.retryDetail} refuse,
   * and once the returned promise has resolved no run is going and none can start until
   * {@link SyncService.resume}.
   *
   * Why this is needed: a running detail queue captured the id of its account when it started, and
   * would go on writing for that account (it could even create the archive folder again after its
   * deletion). The run is waited for rather than cancelled, so it ends the way it always does and
   * saves its outcome.
   *
   * Calling it again is harmless: the remembered state of the timer is kept, and the promise
   * resolves once the running run has ended.
   *
   * @returns A promise resolved once no run is going; it never rejects.
   */
  suspend(): Promise<void> {
    this.#suspended = true;
    this.#stopTimer();
    return this.#running?.done ?? Promise.resolve();
  }

  /**
   * Accept the synchronisations again after {@link SyncService.suspend}, and restart the timer if it
   * was started. It does not synchronise at once: the caller that resumes decides whether a run is
   * needed (after a link it runs a `link` synchronisation itself). Without a suspension it does
   * nothing.
   */
  resume(): void {
    if (!this.#suspended) {
      return;
    }
    this.#suspended = false;
    if (this.#timerWanted) {
      this.#startTimer();
    }
  }

  /**
   * Tell whether a synchronisation is running. An arrow function, so that it can be passed as is
   * to React's `useSyncExternalStore`.
   *
   * @returns `true` while a synchronisation runs.
   */
  readonly isRunning = (): boolean => this.#running !== null;

  /**
   * Be told when a synchronisation starts or ends, and when its history step has saved its outcome
   * (before the detail queue starts, which can take many seconds). An arrow function, for
   * `useSyncExternalStore`.
   *
   * @param listener - Called at every start and end, and after a history step.
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
      accountLinked: accountId !== null,
      lastSync: state.lastSync,
      pausedUntil: pausedUntil !== null && pausedUntil > this.#now() ? pausedUntil : null,
      protectedAccount: state.protectedAccount,
    };
  }

  /**
   * Set the interval of the automatic synchronisations: each tick is a `schedule` run. Never a
   * second one: it would double every tick, so the guarantee holds here and not only in the callers.
   */
  #startTimer(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.syncNow('schedule');
    }, SYNC_INTERVAL_MS);
  }

  /** Clear the interval of the automatic synchronisations, whether or not it ticks. */
  #stopTimer(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Log that a synchronisation (or the retry of a match detail) was refused because the
   * synchronisation is suspended. At `debug`: the account service that suspended it knows, and a
   * refusal is not a failure.
   *
   * @param trigger - What would have started it.
   */
  #logRefusal(trigger: SyncTrigger): void {
    this.#logger.log('debug', 'sync', 'Synchronisation refused while the account changes', {
      trigger,
    });
  }

  /**
   * Run one synchronisation and log how it went.
   *
   * @param trigger - What started it.
   * @param syncRunId - Id of this synchronisation in the logs.
   */
  async #run(trigger: SyncTrigger, syncRunId: string): Promise<void> {
    const startedAt = this.#now();
    this.#logger.log('debug', 'sync', 'Synchronisation started', { syncRunId, trigger });
    // What is known of the run if it fails before it can say more.
    let result: RunResult = { outcome: 'failed', detail: null };
    try {
      result = await this.#synchronise(trigger, syncRunId);
    } catch (error) {
      this.#logFailure(error, syncRunId);
    } finally {
      const { outcome, detail } = result;
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
          // What the detail queue came to; left out when it did not run, so that a missing line
          // is not read as "archived nothing". Counts and a stop reason only: never a match id,
          // an account id or a body.
          ...(detail === null
            ? {}
            : { archived: detail.archived, detailStoppedBy: detail.stoppedBy }),
        },
      );
    }
  }

  /**
   * Synchronise the linked account and save the outcome of the history step: the history, then the
   * detail queue.
   *
   * A `detail` run skips the history step altogether: it requests no history and saves nothing of
   * the history state (`lastSync`, the protected flag), so the history banner is left as it was.
   * The queue then runs for any trigger but one whose history failed to reach deadlock-api.
   *
   * @param trigger - What started it.
   * @param syncRunId - Id of this synchronisation in the logs.
   * @returns How it ended.
   * @throws AppError when the account or its saved state cannot be read. A failure of the history
   *   is not thrown: it is saved and logged here, and the run goes on to the queue.
   */
  async #synchronise(trigger: SyncTrigger, syncRunId: string): Promise<RunResult> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { outcome: 'no_account', detail: null };
    }
    const state = await this.#syncState.getAccountState(accountId);
    // A protected account answers 403 to every request: only the user may try again. The timer and
    // the start of the app stay quiet; the user's own requests, the details' included, go through.
    if (state.protectedAccount && isAutomatic(trigger)) {
      return { outcome: 'protected_account', detail: null };
    }
    let outcome: RunOutcome = 'detail_only';
    let unreachable = false;
    if (trigger !== 'detail') {
      try {
        outcome = (await this.#fetchAndSave(accountId, state, trigger, syncRunId)).outcome;
      } catch (error) {
        const appError = toAppError(error);
        outcome = 'failed';
        await this.#saveFailure(accountId, state, appError, syncRunId);
        this.#logFailure(appError, syncRunId);
        unreachable = UNREACHABLE_KINDS.includes(appError.kind);
      }
    }
    // The queue is not tried when the network is down: its first request would fail the same way.
    if (unreachable) {
      return { outcome, detail: null };
    }
    if (trigger !== 'detail') {
      // The history step has saved its matches and its outcome: tell the listeners now, so that the
      // interface shows them at once instead of after the queue, which can take many seconds. A
      // `detail` run has no history step, so it has nothing new to show before its end.
      this.#notify();
    }
    const detail = await this.#runQueue(accountId, syncRunId);
    return { outcome, detail };
  }

  /**
   * Tell whether a match waits to be downloaded, with no date to wait for: a `pending` match, which
   * the next run of the queue takes. A match that waits for its retry date is not.
   *
   * @param matchId - The match.
   * @returns `true` when the match is `pending`.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #isPending(matchId: MatchId): Promise<boolean> {
    const view = await this.#details.getMatchDetail(matchId);
    return view.kind === 'waiting' && view.nextAttemptAt === null;
  }

  /**
   * Run the detail queue. It reports its failures instead of throwing, so an error here is a bug:
   * it is logged, and it does not turn a history that was saved into a failed synchronisation.
   *
   * @param accountId - The account.
   * @param syncRunId - Id of this synchronisation in the logs.
   * @returns How the queue went, or `null` when it failed to say.
   */
  async #runQueue(accountId: AccountId, syncRunId: string): Promise<DetailRunReport | null> {
    try {
      return await this.#details.runQueue(accountId, syncRunId);
    } catch (error) {
      this.#logger.log('error', 'sync', 'The detail queue failed', {
        ...errorLogContext(toAppError(error)),
        syncRunId,
      });
      return null;
    }
  }

  /**
   * Log the failure of a synchronisation: the one place it is logged, once.
   *
   * @param error - Why the synchronisation failed.
   * @param syncRunId - Id of this synchronisation in the logs.
   */
  #logFailure(error: unknown, syncRunId: string): void {
    this.#logger.log('error', 'sync', 'Synchronisation failed', {
      ...errorLogContext(toAppError(error)),
      syncRunId,
    });
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
      automatic: isAutomatic(trigger),
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

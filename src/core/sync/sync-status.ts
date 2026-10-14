/**
 * State of the match history synchronisation, as it is saved between sessions and shown in the
 * interface.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { AppErrorKind } from '../errors/app-error';
import { APP_ERROR_KINDS } from '../errors/app-error';

/**
 * How a synchronisation ended:
 * - `synced`: the history was downloaded and saved;
 * - `budget_exhausted`: the history was not requested, to stay within the politeness budget;
 * - `paused`: deadlock-api asked to slow down, nothing was requested;
 * - `failed`: an error stopped it (see `errorKind`).
 */
export const SYNC_OUTCOMES = ['synced', 'budget_exhausted', 'paused', 'failed'] as const;

/** How a synchronisation ended, see {@link SYNC_OUTCOMES}. */
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

/** The last synchronisation of an account. Times are Unix milliseconds. */
export interface LastSync {
  readonly finishedAt: number;
  readonly outcome: SyncOutcome;
  /** Kind of the error of a `failed` synchronisation, `null` otherwise. */
  readonly errorKind: AppErrorKind | null;
  /** Matches added by this synchronisation. */
  readonly newMatches: number;
  /** When the history was last downloaded, by this synchronisation or an earlier one. */
  readonly historyFetchedAt: number | null;
  /**
   * Whether deadlock-api refreshed that history from Steam (`true`: up to date), or only returned
   * the matches it had collected by itself (`false`: possibly incomplete). `null` before the first
   * download.
   */
  readonly historyFromSteam: boolean | null;
}

/** What is saved about the synchronisation of one account. */
export interface AccountSyncState {
  readonly lastSync: LastSync | null;
  /**
   * The player made their data private on deadlock-api (HTTP 403): automatic synchronisations are
   * stopped until a synchronisation started by the user succeeds.
   */
  readonly protectedAccount: boolean;
}

/** State of an account that was never synchronised. */
export const INITIAL_ACCOUNT_SYNC_STATE: AccountSyncState = {
  lastSync: null,
  protectedAccount: false,
};

/** Schema of {@link AccountSyncState}, to validate the saved JSON when it is read back. */
export const accountSyncStateSchema = z.object({
  lastSync: z
    .object({
      finishedAt: z.number(),
      outcome: z.enum(SYNC_OUTCOMES),
      errorKind: z.enum(APP_ERROR_KINDS).nullable(),
      newMatches: z.int().nonnegative(),
      historyFetchedAt: z.number().nullable(),
      historyFromSteam: z.boolean().nullable(),
    })
    .nullable(),
  protectedAccount: z.boolean(),
});

/** Everything the interface shows about the synchronisation. */
export interface SyncStatus {
  /** A synchronisation is running right now. */
  readonly running: boolean;
  /** An account is available to synchronise. */
  readonly accountLinked: boolean;
  /**
   * Development builds only: how to provide an account when none is linked. Always `null` in a
   * release build.
   */
  readonly missingAccountHint: string | null;
  /** The last synchronisation of the linked account, or `null` when it was never synchronised. */
  readonly lastSync: LastSync | null;
  /** End of the pause requested by deadlock-api (Unix ms), or `null` when no pause is running. */
  readonly pausedUntil: number | null;
  /** The linked account keeps its match history private on deadlock-api (HTTP 403). */
  readonly protectedAccount: boolean;
}

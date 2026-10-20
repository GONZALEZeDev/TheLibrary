/**
 * The current rank of the linked account, refreshed once a day.
 *
 * The analysis compares an unranked match with the rank the player has now (a ranked match is
 * compared with the badge the player had in it, which its archive holds), so the app keeps that
 * rank with the account (`LinkedAccountRepository.getRank`) and the synchronisation refreshes it
 * through {@link PlayerRankService.refreshIfDue}.
 *
 * The rank only feeds the comparisons, so nothing here ever stops the synchronisation:
 * {@link PlayerRankService.refreshIfDue} never throws. Whatever cannot be fetched leaves the stored
 * rank as it was (or none), and the rank stays due, so that the next synchronisation tries again. The
 * rank request has a budget of its own in `DeadlockApiService`, so a rank that keeps failing cannot
 * use more of deadlock-api than three requests an hour.
 *
 * The URL of the rank request holds the account id, and an error can quote that URL: the lines
 * written here only carry the id of the synchronisation and an outcome word (`paused`,
 * `budget_exhausted`, or the kind of an error), never an account id or the message of an error.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import { toAppError } from '../core/errors/app-error';
import type { Logger } from '../ports/logger.port';
import type { DeadlockApiService } from './deadlock-api.service';
import type { LinkedAccountRepository } from './linked-account.repository';

/** How long a fetched rank is kept before it is fetched again: a day, in milliseconds. */
export const RANK_MAX_AGE_MS = 24 * 60 * 60_000;

/** Scope of the log lines of this service. */
const LOG_SCOPE = 'rank';

/** The message of every line about a rank that was not refreshed, at `debug` and at `warn`. */
const NOT_REFRESHED = 'Player rank not refreshed';

/** What {@link PlayerRankService} needs. */
export interface PlayerRankServiceDependencies {
  /** Gives the rank of a player, within the budgets of deadlock-api. */
  readonly api: DeadlockApiService;
  /** Where the rank of the linked account is kept. */
  readonly accounts: LinkedAccountRepository;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * Tell whether a stored rank is still good.
 *
 * A rank dated in the future is not: the clock moved backwards since it was stored, so its age
 * cannot be told, and it would otherwise stay "fresh" until the clock caught up.
 *
 * @param fetchedAt - When the rank was fetched (Unix ms).
 * @param now - The current time (Unix ms).
 * @returns `true` when the rank is at most a day old (a day exactly is old) and not dated in the future.
 */
function isFresh(fetchedAt: number, now: number): boolean {
  const age = now - fetchedAt;
  return age >= 0 && age < RANK_MAX_AGE_MS;
}

/** Keeps the rank of the linked account up to date. */
export class PlayerRankService {
  readonly #api: DeadlockApiService;
  readonly #accounts: LinkedAccountRepository;
  readonly #logger: Logger;
  readonly #now: () => number;

  /**
   * @param dependencies - See {@link PlayerRankServiceDependencies}.
   */
  constructor(dependencies: PlayerRankServiceDependencies) {
    this.#api = dependencies.api;
    this.#accounts = dependencies.accounts;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * Fetch the rank of an account and store it, unless the stored one is still fresh.
   *
   * - The stored rank is fresh when it is less than a day old and not dated in the future: nothing
   *   is requested.
   * - Otherwise (never fetched, a day old or more, or dated in the future) the rank is requested,
   *   and the badge is stored with the time of the answer. A badge of 0 is a rank too (the player
   *   is unranked).
   * - When deadlock-api is paused or the budget of the rank requests is spent, nothing is stored and
   *   the line is written at `debug`: it is expected, and the rank is still due.
   * - When anything fails (the read of the stored rank, the request, the write), the stored rank
   *   stays and a `warn` line tells the kind of the error.
   *
   * @param accountId - The account whose rank is wanted.
   * @param syncRunId - Id of the synchronisation that asks, to tie the log lines to it.
   * @returns A promise that never rejects.
   */
  async refreshIfDue(accountId: AccountId, syncRunId: string): Promise<void> {
    try {
      await this.#refresh(accountId, syncRunId);
    } catch (error) {
      // The kind of the error is the outcome: its message may quote the URL it failed on, and the
      // URL holds the account id.
      this.#logger.log('warn', LOG_SCOPE, NOT_REFRESHED, {
        syncRunId,
        kind: toAppError(error).kind,
      });
    }
  }

  /**
   * Do the refresh, and let anything that fails reach {@link PlayerRankService.refreshIfDue}.
   *
   * @param accountId - The account whose rank is wanted.
   * @param syncRunId - Id of the synchronisation that asks.
   * @throws AppError when the stored rank cannot be read or written, or when deadlock-api cannot be
   *   reached or answers an error.
   */
  async #refresh(accountId: AccountId, syncRunId: string): Promise<void> {
    const stored = await this.#accounts.getRank(accountId);
    if (stored !== null && isFresh(stored.fetchedAt, this.#now())) {
      return;
    }
    const answer = await this.#api.fetchPlayerRank(accountId);
    if (answer.kind !== 'fetched') {
      // deadlock-api is paused or the budget of the hour is spent: the rank stays due.
      this.#logger.log('debug', LOG_SCOPE, NOT_REFRESHED, { syncRunId, kind: answer.kind });
      return;
    }
    await this.#accounts.setRank(accountId, answer.value, this.#now());
  }
}

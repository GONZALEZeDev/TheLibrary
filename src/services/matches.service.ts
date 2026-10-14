/**
 * Match history use cases: list the matches of the linked account.
 *
 * The account is resolved here, not by the caller, so the interface never passes account ids
 * around (and never puts them in query keys, which are logged when a query fails).
 *
 * @packageDocumentation
 */
import type { MatchSummary } from '../core/domain/match';
import type { AccountSource } from '../ports/account-source.port';
import type { MatchesRepository } from './matches.repository';

/** The most recent matches of the linked account. */
export interface RecentMatches {
  /** An account is linked; when `false`, the lists below are empty. */
  readonly accountLinked: boolean;
  /** Number of stored matches of the account. */
  readonly total: number;
  /** The most recent matches, most recent first. */
  readonly matches: readonly MatchSummary[];
}

/** Reads the match history of the linked account. */
export class MatchesService {
  readonly #accountSource: AccountSource;
  readonly #repository: MatchesRepository;

  /**
   * @param accountSource - The linked account.
   * @param repository - The stored matches.
   */
  constructor(accountSource: AccountSource, repository: MatchesRepository) {
    this.#accountSource = accountSource;
    this.#repository = repository;
  }

  /**
   * The most recent matches of the linked account.
   *
   * @param limit - Maximum number of matches.
   * @returns The matches and the total count.
   * @throws AppError of kind `storage` when the database fails.
   */
  async listRecent(limit: number): Promise<RecentMatches> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { accountLinked: false, total: 0, matches: [] };
    }
    const [total, matches] = await Promise.all([
      this.#repository.count(accountId),
      this.#repository.listRecent(accountId, limit),
    ]);
    return { accountLinked: true, total, matches };
  }
}

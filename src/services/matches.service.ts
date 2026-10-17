/**
 * Match history use cases: list the matches of the linked account.
 *
 * The account is resolved here, not by the caller, so the interface never passes account ids
 * around (and never puts them in query keys, which are logged when a query fails).
 *
 * @packageDocumentation
 */
import type { MatchSummary } from '../core/domain/match';
import { isDetailEligible, type DetailStatus } from '../core/match-detail/detail-status';
import type { AccountSource } from '../ports/account-source.port';
import type { MatchesRepository, StoredMatch } from './matches.repository';

/** A match of the list: its summary, and where its detail stands. */
export interface MatchListItem extends MatchSummary {
  /**
   * Where the detail of the match stands in the detail queue; `null` when the match has no detail
   * (it is not one the app archives, or it is too old to be).
   */
  readonly detailStatus: DetailStatus | null;
}

/** The most recent matches of the linked account. */
export interface RecentMatches {
  /** An account is linked; when `false`, the lists below are empty. */
  readonly accountLinked: boolean;
  /** Number of stored matches of the account. */
  readonly total: number;
  /** The most recent matches, most recent first. */
  readonly matches: readonly MatchListItem[];
}

/** Reads the match history of the linked account. */
export class MatchesService {
  readonly #accountSource: AccountSource;
  readonly #repository: MatchesRepository;
  readonly #now: () => number;

  /**
   * @param accountSource - The linked account.
   * @param repository - The stored matches.
   * @param now - Current time (Unix ms), read to tell which matches are still in the 90-day window
   *   of the archive; `Date.now` by default, controlled by tests.
   */
  constructor(
    accountSource: AccountSource,
    repository: MatchesRepository,
    now: () => number = Date.now,
  ) {
    this.#accountSource = accountSource;
    this.#repository = repository;
    this.#now = now;
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
    // The clock is read once for the whole list, so that every match is judged at the same instant.
    const now = this.#now();
    return { accountLinked: true, total, matches: matches.map((match) => toListItem(match, now)) };
  }
}

/**
 * Give a stored match the detail status the list shows.
 *
 * A match the app does not archive (another hero, Street Brawl, a private lobby, or older than 90
 * days) has no detail, whatever its stored status says. A `ready` match is the exception: its
 * archive is on disk and the detail page still shows it, even after the match has left the 90-day
 * window. (The queue only archives eligible matches, so a `ready` match was eligible when it was
 * archived.)
 *
 * @param match - The stored match.
 * @param now - The current time, in Unix milliseconds.
 * @returns The match with its detail status, or `null` instead when it has none.
 */
function toListItem(match: StoredMatch, now: number): MatchListItem {
  const hasDetail = match.detailStatus === 'ready' || isDetailEligible(match, now);
  return { ...match, detailStatus: hasDetail ? match.detailStatus : null };
}

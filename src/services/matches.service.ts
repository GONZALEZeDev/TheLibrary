/**
 * Match history use cases: read one match of the linked account, list the latest ones of a hero
 * with their figures, and list the whole history under a filter.
 *
 * The account is resolved here, not by the caller, so the interface never passes account ids
 * around (and never puts them in query keys, which are logged when a query fails).
 *
 * @packageDocumentation
 */
import type { HeroId } from '../core/domain/hero';
import type { MatchId, MatchSummary } from '../core/domain/match';
import { periodStats, type PeriodStats, type PeriodTotals } from '../core/domain/period-stats';
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

/**
 * The latest normal-mode matches of a hero, for the dashboard. The kind tells which of the two
 * states to show: the invitation to link an account, or the matches (maybe none).
 */
export type LatestMatches =
  | { readonly kind: 'no_account' }
  | {
      readonly kind: 'ready';
      /** The latest matches, most recent first. */
      readonly matches: readonly MatchListItem[];
      /** The figures of those matches; `null` when there is none (no averages of nothing). */
      readonly stats: PeriodStats | null;
    };

/** What the history list keeps: the matches of one hero or of every hero, and one result or both. */
export interface HistoryFilter {
  /** The hero whose matches are kept, or `all` for every hero. */
  readonly hero: HeroId | 'all';
  /** Only the wins, only the losses, or both. */
  readonly result: 'all' | 'win' | 'loss';
}

/**
 * The match history of the linked account under a filter. The kind tells which of the two states to
 * show: the invitation to link an account, or the matches (maybe none).
 */
export type HistoryView =
  | { readonly kind: 'no_account' }
  | {
      readonly kind: 'ready';
      /**
       * Number of stored matches of the account, whatever the hero, the result and the mode: the
       * size of the history before the filter. With the filter at `all`/`all` it is the length of
       * `matches`.
       */
      readonly total: number;
      /** The matches that fit the filter, of every mode, most recent first. */
      readonly matches: readonly MatchListItem[];
    };

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
   * One match of the linked account, as the list gives it.
   *
   * @param matchId - The match.
   * @returns The match with its detail status (the one {@link MatchesService.listHistory} computes),
   *   or `null` when no account is linked or the account has no such match: an unknown id and the
   *   match of another account are the same answer.
   * @throws AppError of kind `storage` when the database fails, or when the linked account cannot be
   *   read: an unreadable account is never reported as "no match".
   */
  async getMatch(matchId: MatchId): Promise<MatchListItem | null> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return null;
    }
    const match = await this.#repository.get(accountId, matchId);
    return match === null ? null : toListItem(match, this.#now());
  }

  /**
   * The latest normal-mode matches of a hero for the linked account, with their figures.
   *
   * The figures (matches, wins, win rate, average kills, deaths and assists) are over the matches
   * returned, not over a period: a hero who played little recently has a short list and its figures.
   *
   * @param heroId - The hero.
   * @param limit - Maximum number of matches.
   * @returns `no_account` when no account is linked; otherwise the matches, most recent first, and
   *   their figures (`null` when the hero has no normal-mode match).
   * @throws AppError of kind `storage` when the database fails, or when the linked account cannot be
   *   read: an unreadable account is never reported as `no_account`, which would invite the user to
   *   link an account over the data of the one the app lost.
   */
  async listLatest(heroId: HeroId, limit: number): Promise<LatestMatches> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { kind: 'no_account' };
    }
    const stored = await this.#repository.listLatest(accountId, heroId, limit);
    // The clock is read once for the whole list, so that every match is judged at the same instant.
    const now = this.#now();
    return {
      kind: 'ready',
      matches: stored.map((match) => toListItem(match, now)),
      stats: periodStats(totalsOf(stored)),
    };
  }

  /**
   * The whole history of the linked account under a filter, for the match list.
   *
   * Every match of every mode counts (the list shows what the player played, not only the games the
   * app analyses), and the rows are not limited: the screen windows what it draws.
   *
   * @param filter - The hero and the result to keep.
   * @returns `no_account` when no account is linked; otherwise the matches that fit the filter, most
   *   recent first, and the unfiltered number of matches of the account.
   * @throws AppError of kind `storage` when the database fails, or when the linked account cannot be
   *   read: an unreadable account is never reported as `no_account`, which would invite the user to
   *   link an account over the data of the one the app lost.
   */
  async listHistory(filter: HistoryFilter): Promise<HistoryView> {
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { kind: 'no_account' };
    }
    const [total, stored] = await Promise.all([
      this.#repository.count(accountId),
      this.#repository.listHistory(accountId, {
        heroId: filter.hero === 'all' ? null : filter.hero,
        won: filter.result === 'all' ? null : filter.result === 'win',
      }),
    ]);
    // The clock is read once for the whole list, so that every match is judged at the same instant.
    const now = this.#now();
    return { kind: 'ready', total, matches: stored.map((match) => toListItem(match, now)) };
  }
}

/**
 * Sum the results of matches.
 *
 * @param matches - The matches.
 * @returns Their count, wins, kills, deaths and assists; all zeros for no match.
 */
function totalsOf(matches: readonly StoredMatch[]): PeriodTotals {
  return {
    matches: matches.length,
    wins: matches.filter((match) => match.won).length,
    kills: matches.reduce((sum, match) => sum + match.kills, 0),
    deaths: matches.reduce((sum, match) => sum + match.deaths, 0),
    assists: matches.reduce((sum, match) => sum + match.assists, 0),
  };
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

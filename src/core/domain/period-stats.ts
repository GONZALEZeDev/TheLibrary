/**
 * The numbers behind the dashboard tiles for the matches considered (the latest ones of a hero): how
 * many matches were played, how many were won, and the average kills, deaths and assists.
 *
 * Only the totals are computed over the matches (by the caller); turning them into averages and a
 * rate is this module's job, so the rule (and the empty case) lives in the pure core and is tested
 * without a database.
 *
 * @packageDocumentation
 */

/** Sums over the matches considered. */
export interface PeriodTotals {
  /** Number of matches considered. */
  readonly matches: number;
  /** Number of those matches the player's team won. */
  readonly wins: number;
  /** Kills over all the matches. */
  readonly kills: number;
  /** Deaths over all the matches. */
  readonly deaths: number;
  /** Assists over all the matches. */
  readonly assists: number;
}

/** What the dashboard tiles show for matches that number at least one. */
export interface PeriodStats {
  /** Number of matches considered. */
  readonly matches: number;
  /** Number of those matches the player's team won. */
  readonly wins: number;
  /** Share of matches won, from 0 to 1 (not a percentage). */
  readonly winRate: number;
  /** Kills per match. */
  readonly averageKills: number;
  /** Deaths per match. */
  readonly averageDeaths: number;
  /** Assists per match. */
  readonly averageAssists: number;
}

/**
 * Turn the totals of the matches considered into the numbers of the dashboard tiles.
 *
 * @param totals - The sums over the matches considered.
 * @returns The win rate and the averages, or `null` when there is no match: the averages of
 *   nothing are undefined, and the dashboard shows an empty state instead of a row of zeros.
 */
export function periodStats(totals: PeriodTotals): PeriodStats | null {
  const { matches } = totals;
  if (matches === 0) {
    return null;
  }
  return {
    matches,
    wins: totals.wins,
    winRate: totals.wins / matches,
    averageKills: totals.kills / matches,
    averageDeaths: totals.deaths / matches,
    averageAssists: totals.assists / matches,
  };
}

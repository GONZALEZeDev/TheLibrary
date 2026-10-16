/**
 * Matches of a player's history.
 *
 * A {@link MatchSummary} is what the match history of deadlock-api tells about one match of one
 * player: enough to list matches and compare them, not the detail of the match (which arrives with
 * the match archive in a later milestone).
 *
 * @packageDocumentation
 */
import type { AccountId } from './account';
import type { HeroId } from './hero';

/**
 * A validated Deadlock match id: a positive safe integer (around 10^8 today, far below
 * `Number.MAX_SAFE_INTEGER`).
 *
 * The brand makes the type checker reject a plain number where a match id is expected. Above all it
 * keeps an {@link AccountId} and a match id from being swapped: both are numbers at run time, and
 * they travel side by side in archive paths and SQL keys. Every match id of the app went through
 * {@link parseMatchId}.
 */
export type MatchId = number & { readonly __brand: 'MatchId' };

/** Decimal form of a match id: digits only, without leading zero. */
const MATCH_ID_TEXT = /^[1-9]\d{0,15}$/;

/**
 * Validate a match id, typically read from a URL.
 *
 * @param value - The candidate match id, as a number or as decimal text.
 * @returns The match id, or `null` when `value` is not a positive safe integer.
 */
export function parseMatchId(value: unknown): MatchId | null {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && MATCH_ID_TEXT.test(value)
        ? Number(value)
        : Number.NaN;
  // The cast adds the brand: this is the one place that makes a `MatchId`, once it is validated.
  return Number.isSafeInteger(candidate) && candidate >= 1 ? (candidate as MatchId) : null;
}

/** One match of a player's history, as the app stores and shows it. */
export interface MatchSummary {
  /** The player this summary describes. */
  readonly accountId: AccountId;
  readonly matchId: MatchId;
  /** Hero the player played. */
  readonly heroId: HeroId;
  /** Start of the match, in Unix seconds. */
  readonly startTime: number;
  /** Duration of the match, in seconds. */
  readonly durationS: number;
  /** Game mode code of the game data (1 = normal, 4 = street brawl…). */
  readonly gameMode: number;
  /** Match mode code of the game data (1 = unranked, 4 = ranked…). */
  readonly matchMode: number;
  /** Whether the player's team won. */
  readonly won: boolean;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  /** Souls collected by the player over the match. */
  readonly netWorth: number;
  readonly lastHits: number;
  readonly denies: number;
  /** Rank change caused by the match, or `null` when it changed no rank. */
  readonly rankDelta: number | null;
}

/**
 * The type of a match, as the match list and the players table show it.
 *
 * The game data describes a match with two codes, the game mode and the match mode, which only make
 * sense together: this module reads the pair as one label. It is a pure rule, kept apart from the
 * match summary so that every screen labels a match the same way.
 *
 * @packageDocumentation
 */
import {
  ARCHIVED_GAME_MODE,
  RANKED_MATCH_MODE,
  UNRANKED_MATCH_MODE,
} from '../match-detail/detail-status';
import type { MatchSummary } from './match';

/** The game mode code of Street Brawl, the mode that is not the normal game. */
export const STREET_BRAWL_GAME_MODE = 4;

/** The match mode code of a private lobby, a custom game. */
export const PRIVATE_LOBBY_MATCH_MODE = 2;

/**
 * The types a match can have, in the order a filter would list them: a normal (unranked) match, a
 * ranked match, a Street Brawl match and a custom (private lobby) match.
 */
export const MATCH_TYPES = ['normal', 'ranked', 'street_brawl', 'custom'] as const;

/** One of the {@link MATCH_TYPES}. */
export type MatchType = (typeof MATCH_TYPES)[number];

/**
 * Read the type of a match from its two mode codes.
 *
 * The rules are applied in this order, the first that fits decides:
 * - Street Brawl game mode: `street_brawl`, whatever the match mode;
 * - private lobby match mode: `custom`;
 * - normal game mode with the ranked match mode: `ranked`;
 * - normal game mode with the unranked match mode: `normal`.
 *
 * @param match - The two mode codes of the match summary.
 * @returns The type of the match, or `null` for a pair of codes the app does not know (a new mode of
 *   the game): the caller shows nothing rather than a wrong label.
 */
export function matchTypeOf(match: Pick<MatchSummary, 'gameMode' | 'matchMode'>): MatchType | null {
  if (match.gameMode === STREET_BRAWL_GAME_MODE) {
    return 'street_brawl';
  }
  if (match.matchMode === PRIVATE_LOBBY_MATCH_MODE) {
    return 'custom';
  }
  // Only the normal game has a ranked or an unranked match; any other game mode is unknown.
  if (match.gameMode === ARCHIVED_GAME_MODE) {
    if (match.matchMode === RANKED_MATCH_MODE) {
      return 'ranked';
    }
    if (match.matchMode === UNRANKED_MATCH_MODE) {
      return 'normal';
    }
  }
  return null;
}

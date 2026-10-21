/**
 * Tests of the match type: how the two mode codes of the game data are read as one label.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  MATCH_TYPES,
  PRIVATE_LOBBY_MATCH_MODE,
  STREET_BRAWL_GAME_MODE,
  matchTypeOf,
} from './match-type';

describe('match type constants', () => {
  it('holds the codes of the game data', () => {
    expect(STREET_BRAWL_GAME_MODE).toBe(4);
    expect(PRIVATE_LOBBY_MATCH_MODE).toBe(2);
  });

  it('lists the four types', () => {
    expect(MATCH_TYPES).toEqual(['normal', 'ranked', 'street_brawl', 'custom']);
  });
});

describe('matchTypeOf', () => {
  it('labels every mode pair', () => {
    // Each row is [gameMode, matchMode, expected type]. Street Brawl wins over the match mode (a
    // Street Brawl match has been seen with both 1 and 4), and a private lobby is `custom`. The two
    // last rows pin the order of the first two rules: the game mode comes before the private lobby
    // (4/2 is `street_brawl`), and the private lobby applies to a game mode the app does not know
    // (3/2 is `custom`).
    const pairs = [
      [1, 1, 'normal'],
      [1, 4, 'ranked'],
      [4, 1, 'street_brawl'],
      [4, 4, 'street_brawl'],
      [1, 2, 'custom'],
      [4, 2, 'street_brawl'],
      [3, 2, 'custom'],
    ] as const;
    for (const [gameMode, matchMode, expected] of pairs) {
      expect(matchTypeOf({ gameMode, matchMode }), `${String(gameMode)}/${String(matchMode)}`).toBe(
        expected,
      );
    }
  });

  it('answers null for unknown codes', () => {
    // A game mode the app does not know (3), and a match mode the app does not know (6) in the
    // normal game: neither is guessed.
    expect(matchTypeOf({ gameMode: 3, matchMode: 1 })).toBeNull();
    expect(matchTypeOf({ gameMode: 1, matchMode: 6 })).toBeNull();
  });
});

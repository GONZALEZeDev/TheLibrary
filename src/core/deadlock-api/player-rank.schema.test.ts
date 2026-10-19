/**
 * Tests of the reading of a player's rank (`GET /v1/players/{account_id}/rank`).
 *
 * Every payload here is synthetic: it has the shape of a real answer (a badge, a tier, a sub-rank
 * and the last ranked match) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parsePlayerRank } from './player-rank.schema';

/**
 * The answer for a player of tier 4, sub-rank 3, in the exact shape of the API.
 *
 * @param overrides - Fields to change.
 * @returns The raw answer.
 */
function rawRank(overrides: Record<string, unknown> = {}) {
  return {
    badge: 43,
    rank: 4,
    subrank: 3,
    last_match: {
      match_id: 100000001,
      start_time: 1_760_000_000,
      player_rank_initial_display_rank: 42,
      player_rank_initial_flat_progress: null,
    },
    ...overrides,
  };
}

/**
 * Check that a body cannot give a badge: the parser must refuse it with an `invalid_payload` error
 * whose message and context are exactly those below, so they hold the path and the code of the
 * first issue and nothing else (no value of the body).
 *
 * @param body - The body to parse.
 * @param issue - The `<path>: <code>` of the first problem of the body.
 */
function expectInvalidRank(body: unknown, issue: string): void {
  expect(() => parsePlayerRank(body)).toThrow(
    expect.objectContaining({
      kind: 'invalid_payload',
      message: 'The player rank is invalid',
      context: { issue },
    }),
  );
}

describe('parsePlayerRank', () => {
  it('reads the badge', () => {
    expect(parsePlayerRank(rawRank())).toBe(43);
  });

  it('reads a badge from 0, the player with no rank, to 116, the top of the ladder', () => {
    expect(parsePlayerRank(rawRank({ badge: 0, rank: 0, subrank: 0, last_match: null }))).toBe(0);
    expect(parsePlayerRank(rawRank({ badge: 116 }))).toBe(116);
  });

  it('reads the badge only, whatever the other fields hold', () => {
    const body = { badge: 43, rank: 'four', subrank: null, last_match: 7 };

    expect(parsePlayerRank(body)).toBe(43);
  });

  it('refuses a badge of 117', () => {
    expectInvalidRank(rawRank({ badge: 117 }), 'badge: too_big');
  });

  it('refuses a badge below 0', () => {
    expectInvalidRank(rawRank({ badge: -1 }), 'badge: too_small');
  });

  it('refuses a badge that is not a whole number', () => {
    for (const badge of [43.5, '43', null, true, [43], NaN, Infinity]) {
      expectInvalidRank(rawRank({ badge }), 'badge: invalid_type');
    }
  });

  it('refuses an answer without a badge', () => {
    expectInvalidRank({ rank: 4, subrank: 3, last_match: null }, 'badge: invalid_type');
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'text', 43, true, [], [rawRank()]]) {
      expectInvalidRank(body, '(root): invalid_type');
    }
  });

  it('never quotes the body in the error', () => {
    // The planted text and number, like any value of the body, must stay out of the error: it is
    // compared whole by `expectInvalidRank`.
    expectInvalidRank(rawRank({ badge: 'Planted 987654321' }), 'badge: invalid_type');
    expectInvalidRank(rawRank({ badge: 987654321 }), 'badge: too_big');
  });
});

/**
 * Tests of the match id validation.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseMatchId, type MatchId } from './match';

describe('parseMatchId', () => {
  it('accepts a positive safe integer, as a number or as decimal text', () => {
    expect(parseMatchId(108501737)).toBe(108501737);
    expect(parseMatchId('108501737')).toBe(108501737);
    expect(parseMatchId('1')).toBe(1);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects the number %s',
    (value) => {
      expect(parseMatchId(value)).toBeNull();
    },
  );

  it.each(['', '0', '0123', '-5', '1.5', '1e3', 'abc', ' 12', '99999999999999999'])(
    'rejects the text "%s"',
    (value) => {
      expect(parseMatchId(value)).toBeNull();
    },
  );

  it('rejects anything else', () => {
    expect(parseMatchId(undefined)).toBeNull();
    expect(parseMatchId(null)).toBeNull();
    expect(parseMatchId({})).toBeNull();
  });

  it('returns a value usable where a MatchId is expected', () => {
    const parsed = parseMatchId(108501737);
    if (parsed === null) {
      throw new Error('108501737 should be a valid match id');
    }

    // Compiles only when the narrowed result is assignable to the branded type.
    const matchId: MatchId = parsed;

    expect(matchId).toBe(108501737);
  });

  it('does not let a plain number pass for a MatchId', () => {
    // The brand is a compile-time guarantee: this line must be a type error, which is what keeps a
    // match id from being swapped with an account id (both are numbers at run time).
    // @ts-expect-error a plain number is not a MatchId, only `parseMatchId` makes one
    const matchId: MatchId = 108501737;

    expect(matchId).toBe(108501737);
  });
});

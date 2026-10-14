/**
 * Tests of the match id validation.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseMatchId } from './match';

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
});

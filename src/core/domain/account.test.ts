/**
 * Tests of the account id validation.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseAccountId } from './account';

describe('parseAccountId', () => {
  it('accepts a positive 32-bit integer, as a number or as decimal text', () => {
    expect(parseAccountId(123456789)).toBe(123456789);
    expect(parseAccountId('123456789')).toBe(123456789);
    expect(parseAccountId(1)).toBe(1);
    expect(parseAccountId('4294967295')).toBe(4294967295);
  });

  it.each([0, -5, 1.5, 4294967296, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the number %s',
    (value) => {
      expect(parseAccountId(value)).toBeNull();
    },
  );

  it.each(['', ' 12', '12 ', '+12', '-12', '12.0', '1e3', '0x10', 'abc', '99999999999'])(
    'rejects the text "%s" instead of guessing',
    (value) => {
      expect(parseAccountId(value)).toBeNull();
    },
  );

  it('rejects anything else', () => {
    expect(parseAccountId(undefined)).toBeNull();
    expect(parseAccountId(null)).toBeNull();
    expect(parseAccountId({})).toBeNull();
    expect(parseAccountId(12n)).toBeNull();
  });
});

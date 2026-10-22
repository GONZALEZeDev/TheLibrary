/**
 * Tests of the duration format: `minutes:seconds`, the seconds on two digits, the minutes never
 * rolling over into hours.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [2070, '34:30'],
    [3600, '60:00'],
  ])('writes %i seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

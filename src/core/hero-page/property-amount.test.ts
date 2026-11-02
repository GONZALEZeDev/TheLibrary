/**
 * Tests of the reading and adding of the amounts of ability properties.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { addAmounts, parseAmount } from './property-amount';

describe('parseAmount', () => {
  it('reads a distance in metres', () => {
    expect(parseAmount('4m')).toEqual({ value: 4, unit: 'm' });
    expect(parseAmount('8.5m')).toEqual({ value: 8.5, unit: 'm' });
  });

  it('reads a signed or decimal number without unit', () => {
    expect(parseAmount('-12')).toEqual({ value: -12, unit: null });
    expect(parseAmount('+1.0')).toEqual({ value: 1, unit: null });
    expect(parseAmount('3.0')).toEqual({ value: 3, unit: null });
  });

  it('reads a number the API gives as a number', () => {
    expect(parseAmount(1)).toEqual({ value: 1, unit: null });
    expect(parseAmount(0.16)).toEqual({ value: 0.16, unit: null });
  });

  it('refuses what is not an amount', () => {
    expect(parseAmount('{s:sign}')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('12 apples')).toBeNull();
    expect(parseAmount(Number.NaN)).toBeNull();
  });
});

describe('addAmounts', () => {
  it('adds a bonus to a base and keeps the unit of the base', () => {
    expect(addAmounts({ value: 4, unit: 'm' }, { value: 1, unit: 'm' })).toEqual({
      value: 5,
      unit: 'm',
    });
    expect(addAmounts({ value: 20, unit: 'm' }, { value: 12, unit: null })).toEqual({
      value: 32,
      unit: 'm',
    });
  });

  it('does not leave a floating-point tail', () => {
    expect(addAmounts({ value: 0.1, unit: null }, { value: 0.2, unit: null }).value).toBe(0.3);
  });
});

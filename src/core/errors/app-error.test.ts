/**
 * Tests of the typed application errors.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { APP_ERROR_KINDS, AppError, isAppError, toAppError } from './app-error';

describe('AppError', () => {
  it('keeps its kind, message, cause and context', () => {
    const cause = new Error('socket hang up');
    const error = new AppError('network', 'GET /v1/info failed', { cause, context: { status: 0 } });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.kind).toBe('network');
    expect(error.message).toBe('GET /v1/info failed');
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ status: 0 });
  });

  it('defaults its context to an empty object and has no cause', () => {
    const error = new AppError('storage', 'disk full');

    expect(error.context).toEqual({});
    expect('cause' in error).toBe(false);
  });
});

describe('toAppError', () => {
  it('returns an AppError unchanged', () => {
    const original = new AppError('timeout', 'too slow');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error as unexpected and keeps it as cause', () => {
    const original = new TypeError('x is undefined');
    const wrapped = toAppError(original);

    expect(isAppError(original)).toBe(false);
    expect(wrapped.kind).toBe('unexpected');
    expect(wrapped.message).toBe('x is undefined');
    expect(wrapped.cause).toBe(original);
  });

  it('wraps values that are not errors', () => {
    const wrapped = toAppError('boom');

    expect(wrapped.kind).toBe('unexpected');
    expect(wrapped.message).toBe('boom');
    expect(wrapped.cause).toBe('boom');
    expect(isAppError(toAppError(42))).toBe(true);
    // String() throws on an object without a prototype: the normaliser must not.
    expect(toAppError(Object.create(null)).message).toBe('[object Object]');
  });
});

describe('APP_ERROR_KINDS', () => {
  it('lists every kind exactly once', () => {
    expect(new Set(APP_ERROR_KINDS).size).toBe(APP_ERROR_KINDS.length);
  });
});

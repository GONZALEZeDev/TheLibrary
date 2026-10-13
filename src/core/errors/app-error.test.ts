/**
 * Tests of the typed application errors.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { APP_ERROR_KINDS, AppError, errorLogContext, isAppError, toAppError } from './app-error';

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
    // So does a failing toString(): the object is described instead of the normaliser throwing.
    const hostile = {
      toString: () => {
        throw new Error('no string for you');
      },
    };
    expect(toAppError(hostile).message).toBe('[object Object]');
  });

  it('describes an Error without a message by its name', () => {
    expect(toAppError(new Error('')).message).toBe('Error');
    expect(toAppError(new TypeError('')).message).toBe('TypeError');
  });
});

describe('errorLogContext', () => {
  it('keeps a string cause, as the Tauri plugins reject with strings, and the own stack', () => {
    const error = new AppError('storage', 'Could not read the settings', {
      cause: 'store is locked',
    });

    expect(errorLogContext(error)).toEqual({
      kind: 'storage',
      cause: 'store is locked',
      stack: error.stack,
    });
  });

  it('describes an Error cause by its message and logs the stack of that cause', () => {
    const cause = new TypeError('x is undefined');
    const error = new AppError('unexpected', 'Render failed', { cause });
    const context = errorLogContext(error);

    expect(context).toEqual({
      kind: 'unexpected',
      cause: 'x is undefined',
      stack: cause.stack,
    });
    expect(cause.stack).toContain('TypeError: x is undefined');
    expect(context.stack).not.toBe(error.stack);
  });

  it('falls back to the own stack when the Error cause has none', () => {
    const cause = new Error('no trace');
    delete cause.stack;
    const error = new AppError('unexpected', 'Render failed', { cause });

    expect(errorLogContext(error)).toEqual({
      kind: 'unexpected',
      cause: 'no trace',
      stack: error.stack,
    });
  });

  it('keeps the context, which can never override the kind', () => {
    const error = new AppError('network', 'GET /v1/info failed', {
      context: { status: 0, kind: 'forbidden' },
    });

    expect(errorLogContext(error)).toMatchObject({ kind: 'network', status: 0 });
  });

  it('has no cause key and logs the own stack when there is no cause', () => {
    const error = new AppError('timeout', 'too slow');
    const context = errorLogContext(error);

    expect(context).not.toHaveProperty('cause');
    expect(context).toEqual({ kind: 'timeout', stack: error.stack });
  });

  it('keeps a null cause, which is a value thrown like any other', () => {
    expect(errorLogContext(toAppError(null))).toMatchObject({ kind: 'unexpected', cause: 'null' });
  });
});

describe('APP_ERROR_KINDS', () => {
  it('lists every kind exactly once', () => {
    expect(new Set(APP_ERROR_KINDS).size).toBe(APP_ERROR_KINDS.length);
  });
});

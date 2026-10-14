/**
 * Tests of the throttled logging of unhandled errors.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../adapters/dev/memory-logger.adapter';
import { createUnhandledErrorReporter } from './unhandled-errors';

describe('createUnhandledErrorReporter', () => {
  it('logs an unhandled error with its kind, cause and stack', () => {
    const logger = new MemoryLogger();
    const report = createUnhandledErrorReporter({ logger }, () => 0);

    report('app.promise', 'plugin rejected');

    expect(logger.entries).toEqual([
      {
        level: 'error',
        scope: 'app.promise',
        message: 'plugin rejected',
        context: expect.objectContaining({
          kind: 'unexpected',
          cause: 'plugin rejected',
        }) as unknown,
      },
    ]);
  });

  it('logs at most 20 errors per minute, then counts the others in the next line', () => {
    const logger = new MemoryLogger();
    const clock = { now: 0 };
    const report = createUnhandledErrorReporter({ logger }, () => clock.now);

    for (let index = 0; index < 50; index += 1) {
      report('app.window', new Error(`failure ${String(index)}`));
    }
    clock.now = 60_000;
    report('app.window', new Error('after the loop'));

    expect(logger.entries).toHaveLength(21);
    expect(logger.entries[20]).toMatchObject({
      message: 'after the loop',
      context: { errorsLeftOutBefore: 30 },
    });
  });
});

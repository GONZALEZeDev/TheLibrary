/**
 * Tests of the development environment module. Only its construction is checked here: the adapters
 * it creates are used by running `pnpm dev`, since under Node sql.js cannot load its WebAssembly
 * file from a URL.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserDevAdapters, DEV_ONLY_MARKER } from './dev-environment';
import { MemoryLogger } from './memory-logger.adapter';

afterEach(() => {
  // Puts the console back, even when an assertion failed before the end of the test.
  vi.restoreAllMocks();
});

describe('createBrowserDevAdapters', () => {
  it('marks the browser adapters as development-only code', () => {
    // The logger mirrors its lines to the console, which a developer reads in the browser: the
    // `info` line of the marker is silenced so that the test output stays clean.
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const { logger } = createBrowserDevAdapters();

    // `scripts/check-dev-code.ts` looks for the marker in the build, so it must stay in a log line.
    expect(logger).toBeInstanceOf(MemoryLogger);
    const messages =
      logger instanceof MemoryLogger ? logger.entries.map(({ message }) => message) : [];
    expect(messages.join('\n')).toContain(DEV_ONLY_MARKER);
  });
});

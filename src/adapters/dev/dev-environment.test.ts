/**
 * Tests of the development account of the desktop development build. The browser adapters are
 * checked by running `pnpm dev`: under Node, sql.js cannot load its WebAssembly file from a URL.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopDevAccountSource, DEV_ONLY_MARKER } from './dev-environment';
import { MemoryLogger } from './memory-logger.adapter';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createDesktopDevAccountSource', () => {
  it('uses the account of VITE_DEV_ACCOUNT_ID, without logging it', async () => {
    vi.stubEnv('VITE_DEV_ACCOUNT_ID', '123456789');
    const logger = new MemoryLogger();

    const source = createDesktopDevAccountSource(logger);

    await expect(source.currentAccountId()).resolves.toBe(123456789);
    expect(source.missingAccountHint).toBeNull();
    expect(JSON.stringify(logger.entries)).not.toContain('123456789');
  });

  it('has no account and explains how to set one when the variable is missing or empty', async () => {
    for (const value of [undefined, '']) {
      vi.stubEnv('VITE_DEV_ACCOUNT_ID', value);

      const source = createDesktopDevAccountSource(new MemoryLogger());

      await expect(source.currentAccountId()).resolves.toBeNull();
      expect(source.missingAccountHint).toMatch(/^Development build: put VITE_DEV_ACCOUNT_ID=/);
      expect(source.missingAccountHint).toContain('.env.development.local');
    }
  });

  it('refuses an invalid account id instead of guessing, and says so', async () => {
    vi.stubEnv('VITE_DEV_ACCOUNT_ID', '76561198000000000');
    const logger = new MemoryLogger();

    const source = createDesktopDevAccountSource(logger);

    await expect(source.currentAccountId()).resolves.toBeNull();
    expect(source.missingAccountHint).toMatch(/^VITE_DEV_ACCOUNT_ID is not a valid account id/);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'warn' }));
    // The rejected value is echoed neither in the logs nor in the hint.
    expect(JSON.stringify(logger.entries)).not.toContain('76561198000000000');
    expect(source.missingAccountHint).not.toContain('76561198000000000');
  });

  it('marks its log lines as development-only', () => {
    vi.stubEnv('VITE_DEV_ACCOUNT_ID', '');
    const logger = new MemoryLogger();

    createDesktopDevAccountSource(logger);

    expect(logger.entries[0]?.message).toContain(DEV_ONLY_MARKER);
  });
});

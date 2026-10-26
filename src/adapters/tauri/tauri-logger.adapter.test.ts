/**
 * Tests of the Tauri logger: the format of its lines, and the `debug` lines it drops while the
 * detailed log is off. `@tauri-apps/plugin-log` is replaced by spies, so no IPC call is made.
 *
 * @packageDocumentation
 */
import { debug, error, info, warn } from '@tauri-apps/plugin-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLogLine, TauriLogger } from './tauri-logger.adapter';

vi.mock('@tauri-apps/plugin-log', () => ({
  debug: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  error: vi.fn(() => Promise.resolve()),
}));

describe('formatLogLine', () => {
  it('prefixes the message with its scope', () => {
    expect(formatLogLine('app', 'TheLibrary started', {})).toBe('[app] TheLibrary started');
  });

  it('appends the context as JSON so it reaches the log file', () => {
    expect(formatLogLine('sync.history', 'Fetched', { matches: 12, fresh: true })).toBe(
      '[sync.history] Fetched {"matches":12,"fresh":true}',
    );
  });
});

describe('TauriLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops debug lines until the detailed log is on', () => {
    const logger = new TauriLogger();

    // Off by default: the debug line never reaches the plugin, the other levels always do.
    logger.log('debug', 'sync', 'Dropped');
    logger.log('info', 'sync', 'Kept');
    logger.log('warn', 'sync', 'Kept');
    logger.log('error', 'sync', 'Kept');
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('[sync] Kept');
    expect(warn).toHaveBeenCalledWith('[sync] Kept');
    expect(error).toHaveBeenCalledWith('[sync] Kept');

    logger.setDebugEnabled(true);
    logger.log('debug', 'sync', 'Written', { matches: 3 });
    expect(debug).toHaveBeenCalledExactlyOnceWith('[sync] Written {"matches":3}');

    logger.setDebugEnabled(false);
    logger.log('debug', 'sync', 'Dropped again');
    expect(debug).toHaveBeenCalledOnce();
  });
});

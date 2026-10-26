/**
 * Tests of the Tauri diagnostics against a fake `invoke`, and a logger whose plugin is replaced by
 * spies: no IPC call is made and no folder is opened.
 *
 * @packageDocumentation
 */
import { debug } from '@tauri-apps/plugin-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { TauriDiagnostics, type InvokeFunction } from './tauri-diagnostics.adapter';
import { TauriLogger } from './tauri-logger.adapter';

vi.mock('@tauri-apps/plugin-log', () => ({
  debug: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  error: vi.fn(() => Promise.resolve()),
}));

/**
 * Build a fake `invoke` whose commands succeed, as a command returning `Ok(())` does.
 *
 * @returns The fake, a spy to inspect its calls.
 */
function succeedingInvoke() {
  return vi.fn<InvokeFunction>().mockResolvedValue(null);
}

describe('TauriDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('can open the log folder in the desktop app', () => {
    expect(new TauriDiagnostics(new TauriLogger(), succeedingInvoke()).canOpenLogFolder).toBe(true);
  });

  it('opens the log folder through the app command', async () => {
    const invoke = succeedingInvoke();

    await expect(new TauriDiagnostics(new TauriLogger(), invoke).openLogFolder()).resolves.toBe(
      undefined,
    );
    // The command takes no argument: the Rust side finds the folder itself.
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_log_folder');
  });

  it('rejects with a storage error when the folder cannot be opened', async () => {
    // The command rejects with the string of its `Err`, as every Tauri command does.
    const invoke = vi.fn<InvokeFunction>().mockRejectedValue('The log folder could not be opened');

    const failure: unknown = await new TauriDiagnostics(new TauriLogger(), invoke)
      .openLogFolder()
      .catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      kind: 'storage',
      message: 'The log folder could not be opened',
      cause: 'The log folder could not be opened',
    });
  });

  it('turns the debug lines of the logger on and off', () => {
    const logger = new TauriLogger();
    const diagnostics = new TauriDiagnostics(logger, succeedingInvoke());

    diagnostics.setDebugLogging(true);
    logger.log('debug', 'sync', 'Written');
    diagnostics.setDebugLogging(false);
    logger.log('debug', 'sync', 'Dropped');

    expect(debug).toHaveBeenCalledExactlyOnceWith('[sync] Written');
  });
});

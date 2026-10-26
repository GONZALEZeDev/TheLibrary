/**
 * {@link Diagnostics} of the desktop app.
 *
 * The detailed log is a switch of the {@link TauriLogger} itself, which drops the `debug` lines
 * while it is off. The log folder is opened by the `open_log_folder` command of the Rust shell
 * (`src-tauri/src/lib.rs`): the shell finds the folder and asks the system to open it, so the
 * webview is granted no path of the opener plugin and never learns where the folder is. The command
 * rejects with a fixed English string, which this adapter turns into an `AppError` (see the port).
 *
 * @packageDocumentation
 */
import { invoke } from '@tauri-apps/api/core';
import { AppError } from '../../core/errors/app-error';
import type { Diagnostics } from '../../ports/diagnostics.port';
import type { TauriLogger } from './tauri-logger.adapter';

/**
 * Name of the Rust command that opens the log folder. Must stay equal to the function registered in
 * the invoke handler of `src-tauri/src/lib.rs` (checked by a test there).
 */
const OPEN_LOG_FOLDER_COMMAND = 'open_log_folder';

/** The part of `invoke` from `@tauri-apps/api/core` this adapter uses; tests pass a fake. */
export type InvokeFunction = (command: string) => Promise<unknown>;

/** {@link Diagnostics} switching the {@link TauriLogger} and calling the Rust shell. */
export class TauriDiagnostics implements Diagnostics {
  /** The desktop app always has a log folder. */
  readonly canOpenLogFolder = true;

  readonly #logger: TauriLogger;
  readonly #invoke: InvokeFunction;

  /**
   * @param logger - The logger of the app, whose `debug` lines the detailed log lets through.
   * @param invokeFunction - Tauri's `invoke`; replaced by a fake in tests.
   */
  constructor(logger: TauriLogger, invokeFunction: InvokeFunction = invoke) {
    this.#logger = logger;
    this.#invoke = invokeFunction;
  }

  /**
   * Let the `debug` lines through the logger, or drop them again.
   *
   * @param enabled - `true` to write them, `false` to drop them.
   */
  setDebugLogging(enabled: boolean): void {
    this.#logger.setDebugEnabled(enabled);
  }

  /**
   * Have the Rust shell open the log folder in the file explorer.
   *
   * @throws AppError of kind `storage` when the shell could not find or open the folder; the
   *   string the command rejected with is kept as its cause, for the logs.
   */
  async openLogFolder(): Promise<void> {
    try {
      await this.#invoke(OPEN_LOG_FOLDER_COMMAND);
    } catch (cause) {
      throw new AppError('storage', 'The log folder could not be opened', { cause });
    }
  }
}

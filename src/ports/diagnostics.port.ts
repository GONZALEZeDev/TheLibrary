/**
 * Diagnostics port: what the player can do with the log of the app.
 *
 * The log helps understand a problem. The player can let the `debug` lines into it (the detailed
 * log, off by default) and open the folder that holds its files, to send them along with a report.
 * In the browser dev mode there is no log file: the lines go to the console, and there is no folder
 * to open.
 *
 * Unlike most ports, {@link Diagnostics.openLogFolder} reports its failures as an `AppError`:
 * the desktop app opens the folder in a command of the Rust shell, whose error is a fixed plain
 * string with no kind the caller could act on, so the adapter gives every failure the kind
 * `storage`.
 *
 * @packageDocumentation
 */

/** The detailed log switch and the log folder. */
export interface Diagnostics {
  /** Whether {@link Diagnostics.openLogFolder} can work here: `false` in the browser dev mode. */
  readonly canOpenLogFolder: boolean;

  /**
   * Let the `debug` lines reach the log, or drop them again. Takes effect at once, for the lines
   * written from then on; saving the choice is the job of the settings.
   *
   * @param enabled - `true` to write the `debug` lines, `false` to drop them.
   */
  setDebugLogging(enabled: boolean): void;

  /**
   * Open the folder of the log files in the file explorer of the system.
   *
   * @returns A promise resolved once the explorer was asked to open the folder.
   * @throws AppError of kind `storage` when the folder cannot be opened (or there is none).
   */
  openLogFolder(): Promise<void>;
}

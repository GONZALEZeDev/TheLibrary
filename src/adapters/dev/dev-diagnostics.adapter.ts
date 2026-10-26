/**
 * {@link Diagnostics} of the browser dev mode and the tests.
 *
 * There is no log file here: the `MemoryLogger` of this mode keeps every line, `debug`
 * included, and mirrors it to the console. The detailed log switch therefore changes nothing, and
 * there is no folder to open: the settings page leaves that action out
 * ({@link DevDiagnostics.canOpenLogFolder} is `false`).
 *
 * @packageDocumentation
 */
import { AppError } from '../../core/errors/app-error';
import type { Diagnostics } from '../../ports/diagnostics.port';

/** {@link Diagnostics} with no log file and no log folder. */
export class DevDiagnostics implements Diagnostics {
  /** The browser dev mode has no log folder. */
  readonly canOpenLogFolder = false;

  /**
   * Nothing to do: the logger of this mode keeps the `debug` lines whatever the switch says, so the
   * choice of the player is not even read.
   */
  setDebugLogging(): void {
    // Deliberately empty, see above.
  }

  /**
   * Fail: there is no log folder in the browser dev mode.
   *
   * @returns A promise that always rejects.
   * @throws AppError of kind `storage`, always.
   */
  openLogFolder(): Promise<void> {
    return Promise.reject(
      new AppError('storage', 'There is no log folder in the browser dev mode'),
    );
  }
}

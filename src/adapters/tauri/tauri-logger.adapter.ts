/**
 * {@link Logger} backed by the Tauri log plugin (desktop app).
 *
 * Lines go to the terminal under `tauri dev` and to rotating files in
 * `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary\logs\`. The `debug` lines are dropped here,
 * before any IPC call, unless the detailed log is on ({@link TauriLogger.setDebugEnabled}); the
 * Rust side lets the `debug` lines of the webview through, and keeps `info` and above for the rest.
 *
 * @packageDocumentation
 */
import { debug, error, info, warn } from '@tauri-apps/plugin-log';
import type { LogContext, LogLevel, Logger } from '../../ports/logger.port';

/** Plugin function writing a line, per level. */
const WRITERS: Readonly<Record<LogLevel, (message: string) => Promise<void>>> = {
  debug,
  info,
  warn,
  error,
};

/**
 * Build the text of a log line: `[scope] message {"key":"value"}`.
 *
 * The plugin's default formatter ignores structured key/values, so the context is serialised into
 * the message to keep it in the log files.
 *
 * @param scope - Area of the app emitting the line.
 * @param message - Short description.
 * @param context - Structured details; omitted from the line when empty.
 * @returns The formatted line.
 */
export function formatLogLine(scope: string, message: string, context: LogContext): string {
  const details = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  return `[${scope}] ${message}${details}`;
}

/** {@link Logger} writing through `@tauri-apps/plugin-log`. */
export class TauriLogger implements Logger {
  /** Whether the `debug` lines are written; off until the saved settings say otherwise. */
  #debugEnabled = false;

  /**
   * Write the `debug` lines from now on, or drop them again.
   *
   * @param enabled - `true` to write them, `false` to drop them.
   */
  setDebugEnabled(enabled: boolean): void {
    this.#debugEnabled = enabled;
  }

  /**
   * Send the line to the log plugin, unless it is a `debug` line while the detailed log is off.
   *
   * @param level - Severity.
   * @param scope - Area of the app emitting the line.
   * @param message - Short description.
   * @param context - Structured details.
   */
  log(level: LogLevel, scope: string, message: string, context: LogContext = {}): void {
    // Dropped here rather than in Rust: a line nobody keeps costs no IPC call.
    if (level === 'debug' && !this.#debugEnabled) {
      return;
    }
    WRITERS[level](formatLogLine(scope, message, context)).catch(() => {
      // Logging must never break the app. If the logging channel itself fails there is nowhere
      // left to report it, so the failure is deliberately ignored.
    });
  }
}

/**
 * {@link Logger} backed by the Tauri log plugin (desktop app).
 *
 * Lines go to the terminal under `tauri dev` and to rotating files in
 * `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary\logs\`. The Rust side keeps
 * `info` and above, so `debug` lines are dropped until the debug toggle arrives (milestone M5).
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
  /**
   * Send the line to the log plugin.
   *
   * @param level - Severity.
   * @param scope - Area of the app emitting the line.
   * @param message - Short description.
   * @param context - Structured details.
   */
  log(level: LogLevel, scope: string, message: string, context: LogContext = {}): void {
    WRITERS[level](formatLogLine(scope, message, context)).catch(() => {
      // Logging must never break the app. If the logging channel itself fails there is nowhere
      // left to report it, so the failure is deliberately ignored.
    });
  }
}

/**
 * Logging port.
 *
 * The application logs through this interface only; adapters decide where lines go: the Tauri log
 * plugin (terminal and rotating files) in the desktop app, memory and the browser console in the
 * browser dev mode and in tests.
 *
 * @packageDocumentation
 */
import type { AppErrorContext } from '../core/errors/app-error';

/** Severity of a log line, from the most to the least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured details attached to a log line (ids, HTTP status, durations…). Never secrets.
 * Same shape as an error context, so `logger.log('error', scope, error.message, error.context)` works.
 */
export type LogContext = AppErrorContext;

/** Destination-agnostic structured logger. */
export interface Logger {
  /**
   * Write one log line.
   *
   * @param level - Severity.
   * @param scope - Dotted area of the app emitting the line, e.g. `settings` or `sync.history`.
   * @param message - Short English description.
   * @param context - Optional structured details.
   */
  log(level: LogLevel, scope: string, message: string, context?: LogContext): void;
}

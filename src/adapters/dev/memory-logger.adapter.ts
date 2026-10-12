/**
 * In-memory {@link Logger} for tests and the browser dev mode.
 *
 * Lines are kept in an array that tests can inspect. In the browser dev mode they are also
 * mirrored to the console, the only place a developer can see them without Tauri.
 *
 * @packageDocumentation
 */
import type { LogContext, LogLevel, Logger } from '../../ports/logger.port';

/** One captured log line. */
export interface LogEntry {
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly context: LogContext;
}

/** Options of {@link MemoryLogger}. */
export interface MemoryLoggerOptions {
  /** Also print every line to the console (browser dev mode). Defaults to `false` (tests). */
  readonly mirrorToConsole?: boolean;
}

/** {@link Logger} that records every line in memory. */
export class MemoryLogger implements Logger {
  /** Every line written so far, oldest first. */
  readonly entries: LogEntry[] = [];

  readonly #mirrorToConsole: boolean;

  /**
   * @param options - See {@link MemoryLoggerOptions}.
   */
  constructor(options: MemoryLoggerOptions = {}) {
    this.#mirrorToConsole = options.mirrorToConsole ?? false;
  }

  /**
   * Record the line and optionally print it to the console.
   *
   * @param level - Severity.
   * @param scope - Area of the app emitting the line.
   * @param message - Short description.
   * @param context - Structured details.
   */
  log(level: LogLevel, scope: string, message: string, context: LogContext = {}): void {
    this.entries.push({ level, scope, message, context });
    if (this.#mirrorToConsole) {
      // `console.debug/info/warn/error` match the log levels one to one.
      console[level](`[${scope}] ${message}`, context);
    }
  }
}

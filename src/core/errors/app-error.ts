/**
 * Typed application errors.
 *
 * Every failure that crosses a layer boundary (API, storage, services) is normalised into an
 * {@link AppError} carrying a machine-readable {@link AppErrorKind}. The UI maps each kind to a
 * translated message (`errors.kind.<kind>` in the i18n catalogues) instead of showing raw
 * messages, while the logs keep the technical details (`message`, `cause`, `context`).
 *
 * @packageDocumentation
 */

/** Every category of failure the application knows how to explain to the user. */
export const APP_ERROR_KINDS = [
  'network',
  'timeout',
  'rate_limited',
  'not_found',
  'forbidden',
  'invalid_payload',
  'storage',
  'unexpected',
] as const;

/** Machine-readable category of an {@link AppError}. */
export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

/** Structured, JSON-serialisable details attached to an error for the logs. Never secrets. */
export type AppErrorContext = Readonly<Record<string, string | number | boolean | null>>;

/** Options of the {@link AppError} constructor. */
export interface AppErrorOptions {
  /** The underlying error, kept for the logs and for debugging. */
  readonly cause?: unknown;
  /** Extra structured details (ids, HTTP status…). */
  readonly context?: AppErrorContext;
}

/**
 * Error type used across the application.
 *
 * @example
 * ```ts
 * throw new AppError('not_found', 'Match 42 is not available yet', { context: { matchId: 42 } });
 * ```
 */
export class AppError extends Error {
  /** Category used to pick the user-facing message and the recovery strategy. */
  readonly kind: AppErrorKind;
  /** Structured details for the logs. */
  readonly context: AppErrorContext;

  /**
   * @param kind - Category of the failure.
   * @param message - Technical English description, for the logs (never shown to users).
   * @param options - Optional cause and structured context.
   */
  constructor(kind: AppErrorKind, message: string, options: AppErrorOptions = {}) {
    // `cause` goes through the standard ES2022 option so devtools display the whole chain. It is
    // only passed when present: an own `cause: undefined` would clutter logs and devtools.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.kind = kind;
    this.context = options.context ?? {};
  }
}

/**
 * Tell whether a value is an {@link AppError}.
 *
 * @param value - Anything, typically caught in a `catch` clause.
 * @returns `true` when `value` is an {@link AppError}.
 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Normalise anything thrown into an {@link AppError}.
 *
 * An {@link AppError} passes through untouched. Any other value becomes an `unexpected` error that
 * keeps the original value as `cause`, so no information is lost for debugging. Objects without a
 * prototype or with a throwing `toString()`, which `String()` cannot convert, are described too.
 *
 * @param value - Anything, typically caught in a `catch` clause.
 * @returns An {@link AppError}.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }
  return new AppError('unexpected', describeThrownValue(value), { cause: value });
}

/**
 * Message for a thrown value that is not an {@link AppError}.
 *
 * `String()` throws on an object without a prototype (`Object.create(null)`) or with a throwing
 * `toString()`; `Object.prototype.toString` works on such objects, so it is the fallback.
 *
 * @param value - Anything thrown.
 * @returns The error's own message, or a textual description of the value.
 */
function describeThrownValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

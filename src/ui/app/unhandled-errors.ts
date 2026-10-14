/**
 * Logging of the errors that nothing handled (window `error` and `unhandledrejection` events).
 *
 * Such errors can come in a loop (a failing timer, a render retried forever): at most 20 lines
 * per minute are written, so a loop cannot fill the log files and push the useful lines out of
 * rotation. The errors left out are not forgotten: their number is written with the next line.
 *
 * @packageDocumentation
 */
import { errorLogContext, toAppError } from '../../core/errors/app-error';
import { checkRateLimit, type RateLimit } from '../../core/rate-limit/sliding-window';
import type { AppServices } from '../../services/app-services';

/** At most 20 unhandled errors are logged per minute. */
export const UNHANDLED_ERRORS_LOG_LIMIT: RateLimit = { limit: 20, windowMs: 60_000 };

/** Logs one unhandled error, under the given log scope. */
export type UnhandledErrorReporter = (scope: string, error: unknown) => void;

/**
 * Create the function that logs unhandled errors, within {@link UNHANDLED_ERRORS_LOG_LIMIT}.
 *
 * @param services - The services the errors are reported to (only the logger is used).
 * @param now - Current time (Unix ms); `Date.now` by default.
 * @returns The reporter.
 */
export function createUnhandledErrorReporter(
  services: Pick<AppServices, 'logger'>,
  now: () => number = Date.now,
): UnhandledErrorReporter {
  let recent: readonly number[] = [];
  let leftOut = 0;
  return (scope, error) => {
    const time = now();
    const check = checkRateLimit(recent, time, UNHANDLED_ERRORS_LOG_LIMIT);
    if (!check.allowed) {
      recent = check.recent;
      leftOut += 1;
      return;
    }
    recent = [...check.recent, time];
    const appError = toAppError(error);
    services.logger.log('error', scope, appError.message, {
      ...errorLogContext(appError),
      ...(leftOut > 0 ? { errorsLeftOutBefore: leftOut } : {}),
    });
    leftOut = 0;
  };
}

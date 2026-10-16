/**
 * The verdicts of the detail queue: what each outcome of an attempt means for the match, and for the
 * run that made it.
 *
 * Everything here is pure. `MatchDetailService` does the work (download, archive, record) and asks
 * this module what an outcome costs:
 * - a failure that is about the match comes back as a {@link Failed} value, which the service
 *   records as a counted attempt (retried later, or final);
 * - a failure that says nothing about the match is thrown, and {@link stopOf} tells why it stops the
 *   run. No attempt is counted for it, so the match is tried again at the next run.
 *
 * Only an answer from deadlock-api, with its HTTP status, can condemn a match: a failure without
 * one (the connection, a bug, whatever stands between the app and the API) is never the match's.
 *
 * Nothing here logs a value of a payload: the codes are error kinds, HTTP statuses and the `issue`
 * of a validation (a field path and an issue code).
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';
import {
  AppError,
  errorLogContext,
  isAppError,
  type AppErrorContext,
} from '../core/errors/app-error';

/** Why a run of the queue ended before every due match was processed. */
export type DetailRunStop =
  /** deadlock-api asked to pause the requests (or a pause was already running). */
  | 'paused'
  /** The network failed, a request timed out, or the answers cannot be trusted (see `unreadableAnswer`). */
  | 'network'
  /** A local failure: the disk, the database, the compressor, or a bug. */
  | 'storage';

/** An attempt that archived the detail of its match. */
export interface Archived {
  readonly outcome: 'archived';
  /** Size of the archive file, in bytes. */
  readonly archivedBytes: number;
}

/** An attempt that failed for a reason that is about the match: it is counted. */
export interface Failed {
  readonly outcome: 'failed';
  /** Whether trying again may help (`retryable`) or the verdict is final (`invalid`). */
  readonly failure: 'retryable' | 'invalid';
  /** Why it failed: an error code, never a value of a payload. */
  readonly lastError: string;
  /** The response text to quarantine; absent when there is none to keep. */
  readonly body?: string;
  /** The error that also stops the run, once the failure is recorded; absent when it goes on. */
  readonly stopRun?: AppError;
}

/** What one attempt on one match came to. */
export type Attempt = Archived | Failed;

/**
 * A failure that may go away: the match is tried again later.
 *
 * @param lastError - Why it failed (an error code).
 * @returns The failed attempt.
 */
export function retryable(lastError: string): Failed {
  return { outcome: 'failed', failure: 'retryable', lastError };
}

/**
 * A failure that is final: trying again would get the same answer.
 *
 * @param lastError - Why it failed (an error code).
 * @param body - The response text to quarantine, when there is one.
 * @returns The failed attempt.
 */
export function invalid(lastError: string, body?: string): Failed {
  return {
    outcome: 'failed',
    failure: 'invalid',
    lastError,
    ...(body === undefined ? {} : { body }),
  };
}

/**
 * A success status whose body is not what deadlock-api sends (not JSON): the page of a proxy that
 * inspects TLS, of a security product, of a maintenance. It is not a verdict on the match, since the
 * next attempt may get the real answer, but it is not the API's doing either, and it would be the
 * same for every other match: the failure is counted once, the body is kept for a look, and the run
 * stops, instead of condemning every due match in one run.
 *
 * @param issue - Why the answer cannot be used (`not_json`).
 * @param body - The text received, which is not empty (an empty answer is a plain retry).
 * @returns The failed attempt, which stops the run as a `network` failure.
 */
export function unreadableAnswer(issue: string, body: string): Failed {
  return {
    ...retryable(issue),
    body,
    stopRun: new AppError('network', 'The answer of deadlock-api cannot be used', {
      context: { issue },
    }),
  };
}

/**
 * What the problem of an invalid detail was, as a code.
 *
 * @param error - The `invalid_payload` error of the validation or of the search of the player.
 * @returns Its `issue` (a field path and a code, or a name such as `tracked_player_missing`).
 */
export function describeInvalidPayload(error: AppError): string {
  const { issue } = error.context;
  return `invalid_payload (${typeof issue === 'string' ? issue : 'unknown'})`;
}

/**
 * Decide what a failed download means for the match.
 *
 * Only an answer of deadlock-api can be about the match, and every one carries its HTTP status: a
 * server error, a refusal, a status the app does not expect, or a match the API does not have. The
 * same kinds of error without a status did not come from an answer (the HTTP client failed in a way
 * it did not report, or the service has a bug), so they say nothing about the match and stop the
 * run as `network` failures.
 *
 * @param error - What the download threw.
 * @returns The failed attempt when the error is the API's answer about the match.
 * @throws The error that stops the run when it says nothing about the match: the original one, or a
 *   `network` error that wraps it when it is an `AppError` of the kinds above without a status.
 */
export function judgeDownloadError(error: unknown): Failed {
  if (!isAppError(error)) {
    // Not an error of the API but a bug: it stops the run (see `stopOf`).
    throw error;
  }
  switch (error.kind) {
    case 'service_unavailable':
    case 'forbidden':
    case 'unexpected':
    case 'not_found': {
      const { status } = error.context;
      if (typeof status !== 'number') {
        throw new AppError('network', 'The request failed without an answer from deadlock-api', {
          cause: error,
          context: { ...error.context, failure: error.kind },
        });
      }
      // The API failed or refused this match: maybe it will not next time.
      return retryable(`${error.kind} (${String(status)})`);
    }
    case 'invalid_payload':
      // Only a body over the size limit is thrown with this kind: the client stopped reading it, so
      // there is nothing to quarantine, and it will be as large next time.
      return invalid('invalid_payload (body_too_large)');
    case 'network':
    case 'timeout':
    case 'rate_limited':
    case 'storage':
      throw error;
  }
}

/**
 * Tell why an error ends a run.
 *
 * @param error - What a puller caught.
 * @returns `network` for a failed or timed out request, `paused` for a pause, `storage` for anything
 *   else: every failure that is not the API's answer about a match is a local one.
 */
export function stopOf(error: unknown): DetailRunStop {
  if (isAppError(error)) {
    switch (error.kind) {
      case 'network':
      case 'timeout':
        return 'network';
      case 'rate_limited':
        return 'paused';
      default:
        return 'storage';
    }
  }
  return 'storage';
}

/**
 * Describe an error that stopped a run for the log, without the account id: the error of a file or
 * of the database may quote a path or a query, which holds it.
 *
 * @param error - What was caught.
 * @param accountId - The tracked account.
 * @param withStack - Whether to keep the stack: a local failure is worth one, a pause or a network
 *   failure is expected and its stack says nothing more than its kind.
 * @returns The kind, context and cause of the error (and its stack), with the account id replaced.
 */
export function describeErrorForLog(
  error: unknown,
  accountId: AccountId,
  withStack: boolean,
): AppErrorContext {
  // What is not an `AppError` yet comes from a local step (the archive, the compressor, or the code
  // itself): the adapters do not wrap their failures, so it is wrapped here, as the ports say.
  const appError = isAppError(error)
    ? error
    : new AppError('storage', 'A local step of the detail queue failed', { cause: error });
  const redacted = Object.entries(errorLogContext(appError))
    .filter(([key]) => withStack || key !== 'stack')
    .map(([key, value]): [string, string | number | boolean | null] => [
      key,
      typeof value === 'string' ? value.replaceAll(String(accountId), '{account_id}') : value,
    ]);
  return Object.fromEntries(redacted);
}

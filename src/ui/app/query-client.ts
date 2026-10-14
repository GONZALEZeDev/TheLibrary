/**
 * TanStack Query client of the application.
 *
 * It is created here, and not in the composition root, so that the app and the tests share the same
 * defaults, the same retry rule and the same failure logging.
 *
 * @packageDocumentation
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { errorLogContext, toAppError, type AppErrorKind } from '../../core/errors/app-error';
import type { AppServices } from '../../services/app-services';

/** Error kinds worth retrying: a new attempt may succeed. */
const TRANSIENT_KINDS = new Set<AppErrorKind>([
  'network',
  'timeout',
  'rate_limited',
  'service_unavailable',
]);

/** Retries after the first attempt of a query that fails with a transient error. */
const MAX_RETRIES = 2;

/**
 * Tell whether a failed query is worth another attempt: only transient errors are, and only a
 * limited number of times. Anything that is not an `AppError` counts as `unexpected`, which a new
 * attempt would not fix.
 *
 * @param failureCount - Number of retries already made: 0 right after the first failure.
 * @param error - The error of the attempt that just failed.
 * @returns `true` to try again.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_RETRIES && TRANSIENT_KINDS.has(toAppError(error).kind);
}

/**
 * Name of a query or mutation key, for the logs: its leading string segments, joined with dots
 * (`['matches', 'recent']` → `matches.recent`). The first segment that is not a string, and
 * everything after it, is a parameter and is left out: parameters can identify a player.
 *
 * @param key - A query or mutation key.
 * @returns The name of the key.
 */
export function keyName(key: readonly unknown[]): string {
  const firstParameter = key.findIndex((segment) => typeof segment !== 'string');
  return (firstParameter === -1 ? key : key.slice(0, firstParameter)).join('.');
}

/**
 * Create the TanStack Query client of the application.
 *
 * Every query goes through a service: the settings, the matches the synchronisation saved, and the
 * hero names, read from their weekly cache and downloaded only when it is stale (the services
 * apply the budgets and pauses of deadlock-api and handle being offline). So queries and mutations
 * run whatever the network state, are not refetched when the window regains focus, and are
 * retried only when a new attempt may succeed.
 *
 * Every query and mutation that fails is logged, once, by the caches below: the UI only shows the
 * translated message of the error kind, and the log file is the only place where the technical
 * details of a release build can be read. Doing it here covers every data hook, present and
 * future, without each of them having to remember it.
 *
 * @param services - The services the client reports failures to (only the logger is used).
 * @returns A new query client.
 */
export function createQueryClient(services: Pick<AppServices, 'logger'>): QueryClient {
  const { logger } = services;
  return new QueryClient({
    // Called once per failed query, after its retries are exhausted (not at every attempt).
    queryCache: new QueryCache({
      onError: (error, query) => {
        const appError = toAppError(error);
        logger.log('error', 'query', appError.message, {
          ...errorLogContext(appError),
          // The name of the key only: its parameters stay out of the logs.
          query: keyName(query.queryKey),
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _onMutateResult, mutation) => {
        const appError = toAppError(error);
        const { mutationKey } = mutation.options;
        logger.log('error', 'mutation', appError.message, {
          ...errorLogContext(appError),
          // Unlike a query, a mutation does not have to be given a key.
          ...(mutationKey === undefined ? {} : { mutation: keyName(mutationKey) }),
        });
      },
    }),
    defaultOptions: {
      queries: {
        networkMode: 'always',
        refetchOnWindowFocus: false,
        retry: shouldRetry,
      },
      mutations: { networkMode: 'always' },
    },
  });
}

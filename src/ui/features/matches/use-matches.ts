/**
 * TanStack Query hooks of the match history screen: the stored matches, the hero names and the
 * state of the synchronisation.
 *
 * Every query goes through a service and reads local data, except the hero names, downloaded only
 * when their weekly cache is stale: they work offline. Query keys never contain an account id: the
 * services resolve the account themselves, and keys are logged when a query fails.
 *
 * @packageDocumentation
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import type { Hero, HeroId } from '../../../core/domain/hero';
import { useServices } from '../../app/ServicesContext';

/** Number of matches shown in the list. */
export const RECENT_MATCHES_LIMIT = 100;

/** Prefix of every query about stored matches. */
export const MATCHES_QUERY_KEY = ['matches'] as const;

/**
 * Prefix of every query about the match details: their summary ({@link DETAILS_SUMMARY_QUERY_KEY})
 * and the detail of one match (read by the match detail page, under `['details', 'match', matchId]`).
 */
export const DETAILS_QUERY_KEY = ['details'] as const;

/** Key of the query that counts the match details by status, shown by the synchronisation banner. */
export const DETAILS_SUMMARY_QUERY_KEY = [...DETAILS_QUERY_KEY, 'summary'] as const;

/** Prefix of every query about the synchronisation. */
const SYNC_QUERY_KEY = ['sync'] as const;

/**
 * Shortest time between two refreshes caused by the progress of the detail queue. The queue
 * reports each match it records, and it can record several in a second: refreshing the list of
 * matches and the counts at every one would read the database far more often than a person can
 * see the change.
 */
const DETAIL_REFRESH_INTERVAL_MS = 1000;

/**
 * The most recent matches of the linked account.
 *
 * @returns The TanStack Query result holding the matches and their total count.
 */
export function useRecentMatches() {
  const { matches } = useServices();
  return useQuery({
    queryKey: [...MATCHES_QUERY_KEY, 'recent'],
    queryFn: () => matches.listRecent(RECENT_MATCHES_LIMIT),
  });
}

/**
 * Index the hero catalogue by hero id. A module-level function, so that TanStack Query runs it
 * again only when the catalogue changes, and the map keeps its identity between renders.
 *
 * @param heroes - The hero catalogue.
 * @returns The English name of each hero, by id.
 */
function namesById(heroes: readonly Hero[]): ReadonlyMap<HeroId, string> {
  return new Map(heroes.map((hero) => [hero.id, hero.name]));
}

/**
 * The English names of the heroes, by hero id.
 *
 * @param enabled - Whether the names are needed now. The catalogue may have to be downloaded, so
 *   it is only asked for when there are matches to name: without an account, the app contacts
 *   nobody.
 * @returns The TanStack Query result holding a map from hero id to name.
 */
export function useHeroNames(enabled: boolean) {
  const { heroes } = useServices();
  return useQuery({
    queryKey: ['heroes'],
    queryFn: () => heroes.getHeroes(),
    enabled,
    select: namesById,
    // The service caches the catalogue for a week: asking it again within the hour is pointless.
    staleTime: 60 * 60_000,
  });
}

/**
 * What the interface shows about the synchronisation (last outcome, pause…).
 *
 * @returns The TanStack Query result holding the synchronisation status.
 */
export function useSyncStatus() {
  const { sync } = useServices();
  return useQuery({ queryKey: [...SYNC_QUERY_KEY, 'status'], queryFn: () => sync.getStatus() });
}

/**
 * How many match details are archived, waiting, unavailable or invalid. Kept up to date by
 * {@link useRefreshOnSync}.
 *
 * @returns The TanStack Query result holding the counts, or `null` when no account is linked.
 */
export function useDetailSummary() {
  const { details } = useServices();
  return useQuery({
    queryKey: DETAILS_SUMMARY_QUERY_KEY,
    queryFn: () => details.getSummary(),
  });
}

/**
 * Whether a synchronisation is running, updated as soon as one starts or ends.
 *
 * @returns `true` while a synchronisation runs.
 */
export function useSyncRunning(): boolean {
  const { sync } = useServices();
  return useSyncExternalStore(sync.subscribe, sync.isRunning);
}

/**
 * Start a synchronisation requested by the user (or join the one running).
 *
 * @returns The TanStack Query mutation; call `mutate()`. It never fails: the outcome of the
 *   synchronisation is part of its status.
 */
export function useSyncNow() {
  const { sync } = useServices();
  return useMutation({
    mutationKey: [...SYNC_QUERY_KEY, 'now'],
    mutationFn: () => sync.syncNow('manual'),
  });
}

/** A function that runs an action at most once per interval, see {@link createThrottle}. */
export interface Throttle {
  /** Ask for the action: it runs at once, or when the current interval ends. */
  readonly trigger: () => void;
  /** Forget the call that waits, and stop the interval. The next `trigger` runs at once. */
  readonly cancel: () => void;
}

/**
 * Make an action run at most once per interval, without losing the last call of a burst.
 *
 * The first call runs at once (the leading call), so the screen reacts to the first change without
 * delay. The calls that come while the interval runs are merged into one that runs when it ends
 * (the trailing call): the last change of a burst is always applied, even if the burst stops
 * between two ticks and nothing else follows. A call that ends the interval starts the next one.
 * The interval is a timer, not a comparison of clocks, so it follows the (fake) timers of a test.
 *
 * Exported for its tests; the hooks of this file are its only users.
 *
 * @param action - What to run.
 * @param intervalMs - The shortest time between two runs, in milliseconds.
 * @returns The throttle. Call `cancel` when the action is no longer wanted (an unmounted
 *   component): a trailing call left behind would run an action nobody waits for.
 */
export function createThrottle(action: () => void, intervalMs: number): Throttle {
  // Set while an interval runs: a call that comes now has to wait for its end.
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Whether a call came while the interval ran.
  let waiting = false;

  /** Run the action, and keep the next runs at a distance for one interval. */
  const run = (): void => {
    action();
    timer = setTimeout(() => {
      timer = undefined;
      if (waiting) {
        waiting = false;
        run();
      }
    }, intervalMs);
  };

  return {
    trigger: () => {
      if (timer === undefined) {
        run();
      } else {
        waiting = true;
      }
    },
    cancel: () => {
      clearTimeout(timer);
      timer = undefined;
      waiting = false;
    },
  };
}

/**
 * Keep the screen up to date with what happens in the background, while the component that calls
 * it is shown:
 * - whenever a synchronisation starts or ends, whatever started it (the schedule, another
 *   screen…), the synchronisation status, the matches and the details are read again;
 * - while the detail queue runs, each match it records changes the counts of the details and the
 *   detail column of the list, so those are read again too, at most once a second
 *   ({@link DETAIL_REFRESH_INTERVAL_MS}). The last match of a burst is always taken into account.
 */
export function useRefreshOnSync(): void {
  const { sync, details } = useServices();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      sync.subscribe(() => {
        void queryClient.invalidateQueries({ queryKey: SYNC_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: MATCHES_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
      }),
    [sync, queryClient],
  );
  useEffect(() => {
    const refresh = createThrottle(() => {
      void queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MATCHES_QUERY_KEY });
    }, DETAIL_REFRESH_INTERVAL_MS);
    const unsubscribe = details.subscribe(refresh.trigger);
    return () => {
      unsubscribe();
      // A refresh that waits for the end of the interval has no one left to refresh.
      refresh.cancel();
    };
  }, [details, queryClient]);
}

/**
 * TanStack Query hooks of the match history screen, the dashboard and the header of the match page:
 * the stored matches, one match of the history, the numbers of a period, the hero names and assets
 * and the state of the synchronisation.
 *
 * Every query goes through a service and reads local data, except the hero names and assets,
 * downloaded only when their weekly cache is stale: they work offline. Query keys never contain an
 * account id: the services resolve the account themselves, and keys are logged when a query fails.
 *
 * @packageDocumentation
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import type { Hero, HeroId } from '../../../core/domain/hero';
import type { MatchId } from '../../../core/domain/match';
import type { Period } from '../../../core/domain/period';
import { useServices } from '../../app/ServicesContext';

/** Number of matches shown in the list. */
export const RECENT_MATCHES_LIMIT = 100;

/** Prefix of every query about stored matches. */
export const MATCHES_QUERY_KEY = ['matches'] as const;

/**
 * Prefix of every query about the match details: their summary ({@link DETAILS_SUMMARY_QUERY_KEY}),
 * the detail of one match (read by the match detail page, under `['details', 'match', matchId]`),
 * its analysis (under `[...DETAILS_QUERY_KEY, 'analysis', matchId]`, see `useMatchAnalysis`) and the
 * damage and players tabs (under `[...DETAILS_QUERY_KEY, 'breakdown', matchId]`, see
 * `useDamageTab`).
 */
export const DETAILS_QUERY_KEY = ['details'] as const;

/** Key of the query that counts the match details by status, shown by the synchronisation banner. */
export const DETAILS_SUMMARY_QUERY_KEY = [...DETAILS_QUERY_KEY, 'summary'] as const;

/** Prefix of every query about the synchronisation. */
export const SYNC_QUERY_KEY = ['sync'] as const;

/**
 * Key of the query that reads the hero catalogue, and prefix of the queries about it: the names
 * ({@link useHeroNames}, under this very key) and the assets ({@link useHeroAssets}, under
 * `[...HEROES_QUERY_KEY, 'assets']`). Without an account the catalogue is empty (the app contacts
 * nobody), so an account change must read it again: see `resetAccountData`, which resets every
 * query under this prefix.
 */
export const HEROES_QUERY_KEY = ['heroes'] as const;

/**
 * How long a read of the hero catalogue is kept before a screen asks again: an hour. The service
 * caches the catalogue for a week, so asking it again within the hour is pointless. Shared by the
 * names and the assets, which read the same catalogue.
 */
const HERO_CATALOGUE_STALE_TIME_MS = 60 * 60_000;

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
 * One match of the linked account, as the history lists it: what the header of the match page shows
 * (the hero, the result, the type and the date of the match) and where its detail stands.
 *
 * The key sits under {@link MATCHES_QUERY_KEY}, so whatever refreshes the matches (a
 * synchronisation, the detail queue, an account change) refreshes the header too.
 *
 * @param matchId - The match.
 * @returns The TanStack Query result holding the match, or `null` when no account is linked or the
 *   account has no such match.
 */
export function useMatchSummary(matchId: MatchId) {
  const { matches } = useServices();
  return useQuery({
    queryKey: [...MATCHES_QUERY_KEY, 'one', matchId],
    queryFn: () => matches.getMatch(matchId),
  });
}

/**
 * The numbers of a hero over a period, for the dashboard tiles.
 *
 * The key sits under {@link MATCHES_QUERY_KEY}, so whatever refreshes the matches (a
 * synchronisation, the detail queue, an account change) refreshes the tiles too.
 *
 * @param period - The period to sum up.
 * @param heroId - The hero.
 * @returns The TanStack Query result holding the summary: `no_account`, `empty` or the `stats`.
 */
export function usePeriodSummary(period: Period, heroId: HeroId) {
  const { matches } = useServices();
  return useQuery({
    queryKey: [...MATCHES_QUERY_KEY, 'period', period, heroId],
    queryFn: () => matches.getPeriodSummary(period, heroId),
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
    queryKey: HEROES_QUERY_KEY,
    queryFn: () => heroes.getHeroes(),
    enabled,
    select: namesById,
    staleTime: HERO_CATALOGUE_STALE_TIME_MS,
  });
}

/**
 * The heroes of the catalogue with their English names, their portraits and their loadouts, for the
 * screens that show a hero's image (the header of the match page).
 *
 * It is a query of its own, under `[...HEROES_QUERY_KEY, 'assets']`, and not the one of
 * {@link useHeroNames}: the two read the same catalogue but keep different shapes (the names are the
 * bare heroes, indexed by a `select`), and two shapes must never share one cache entry. The key sits
 * under {@link HEROES_QUERY_KEY}, so an account change resets both together.
 *
 * @param enabled - Whether the assets are needed now. The catalogue may have to be downloaded, so it
 *   is only asked for when a screen shows heroes: without an account, the app contacts nobody.
 * @returns The TanStack Query result holding the heroes with their assets.
 */
export function useHeroAssets(enabled: boolean) {
  const { heroes } = useServices();
  return useQuery({
    queryKey: [...HEROES_QUERY_KEY, 'assets'],
    queryFn: () => heroes.getHeroAssets(),
    enabled,
    staleTime: HERO_CATALOGUE_STALE_TIME_MS,
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

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
const MATCHES_QUERY_KEY = ['matches'] as const;

/** Prefix of every query about the synchronisation. */
const SYNC_QUERY_KEY = ['sync'] as const;

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

/**
 * Refresh the matches and the synchronisation status whenever a synchronisation starts or ends,
 * whatever started it (the schedule, another screen…).
 */
export function useRefreshOnSync(): void {
  const { sync } = useServices();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      sync.subscribe(() => {
        void queryClient.invalidateQueries({ queryKey: SYNC_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: MATCHES_QUERY_KEY });
      }),
    [sync, queryClient],
  );
}

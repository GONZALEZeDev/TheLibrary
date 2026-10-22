/**
 * Tests of the hooks that feed the tabs of the match page: the damage and build tab, the players tab,
 * the match as the history lists it (for the header) and the hero assets (portraits), rendered with
 * the services of the app on the development adapters.
 *
 * The fixture API plays deadlock-api (the history, the details and the catalogues), the database and
 * the archive are in memory, and the account is the synthetic one of the fixtures. Every test first
 * synchronises a small synthetic history, like the app does at its start, which archives and
 * projects its Paige matches, so the most recent of them can be read at once. No catalogue is in the
 * cache yet: the services download them when a view asks, from the fixture API.
 *
 * @packageDocumentation
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi } from '../../../adapters/dev/fixture-http-client.adapter';
import { matchIdSchema } from '../../../core/domain/match';
import type { AppServices } from '../../../services/app-services';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { testMatchId } from '../../../test/test-data';
import { ServicesProvider } from '../../app/ServicesContext';
import { resetAccountData } from '../account/use-account';
import {
  DETAILS_QUERY_KEY,
  HEROES_QUERY_KEY,
  MATCHES_QUERY_KEY,
  useHeroAssets,
  useHeroNames,
  useMatchSummary,
  useRefreshOnSync,
} from '../matches/use-matches';
import { BREAKDOWN_QUERY_KEY_OF, useDamageTab, usePlayersTab } from './use-match-breakdown';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Size of the synthetic history. It is archived before every test, so it is kept short: just long
 * enough to hold an archived Paige match.
 */
const HISTORY_SIZE = 14;

/** How many matches the recent list asks for: more than the synthetic history holds. */
const LIST_LIMIT = 100;

/** How far above the ids of the history an id that no match of the account has is. */
const UNKNOWN_ID_OFFSET = 1_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Synchronise a small synthetic history, so that its Paige matches are archived and projected, and
 * pick the most recent archived match.
 *
 * @returns The services and their adapters, and the id of an archived match.
 */
async function setUp() {
  const test = createTestServices({
    now: () => START,
    handler: createFixtureApi({ now: START, matchCount: HISTORY_SIZE }),
  });
  await test.services.sync.syncNow('startup');
  const rows = await test.database.select(
    `SELECT match_id FROM matches WHERE detail_status = 'ready' ORDER BY start_time DESC, match_id DESC LIMIT 1`,
  );
  const matchId = matchIdSchema.parse(
    rows[0]?.match_id ?? expect.unreachable('the history holds an archived match'),
  );
  return { ...test, matchId };
}

/**
 * Render hooks inside the providers of the app that they need: the services and the query client.
 *
 * @param services - The services the hooks read through.
 * @param useHooks - Calls the hooks under test and returns what the test looks at.
 * @returns The latest value of `useHooks`, the query client (to inspect the cache) and the function
 *   that unmounts the hooks.
 */
function renderWithServices<T>(services: AppServices, useHooks: () => T) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesProvider services={services}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ServicesProvider>
  );
  const { result, unmount } = renderHook(useHooks, { wrapper });
  return { result, queryClient, unmount };
}

describe('useDamageTab', () => {
  it('reads the damage tab view', async () => {
    const { services, matchId } = await setUp();
    const { result, queryClient } = renderWithServices(services, () => useDamageTab(matchId));

    await waitFor(() => {
      expect(result.current.data).toMatchObject({ kind: 'ready' });
    });

    expect(result.current.data).toEqual(await services.breakdown.getDamageTab(matchId));
    // The key sits under the match details, in the breakdown of the match.
    expect(queryClient.getQueryData([...DETAILS_QUERY_KEY, 'breakdown', matchId, 'damage'])).toBe(
      result.current.data,
    );
  });
});

describe('usePlayersTab', () => {
  it('reads the players tab view', async () => {
    const { services, matchId } = await setUp();
    const { result, queryClient } = renderWithServices(services, () => usePlayersTab(matchId));

    await waitFor(() => {
      expect(result.current.data).toMatchObject({ kind: 'ready' });
    });

    expect(result.current.data).toEqual(await services.breakdown.getPlayersTab(matchId));
    expect(queryClient.getQueryData([...DETAILS_QUERY_KEY, 'breakdown', matchId, 'players'])).toBe(
      result.current.data,
    );
  });
});

describe('BREAKDOWN_QUERY_KEY_OF', () => {
  it('is the prefix of the two tabs of one match, and of no other match', async () => {
    const { services, matchId } = await setUp();
    const otherMatchId = testMatchId(matchId + 1);
    const { result, queryClient } = renderWithServices(services, () => ({
      damage: useDamageTab(matchId),
      players: usePlayersTab(matchId),
      otherDamage: useDamageTab(otherMatchId),
    }));
    await waitFor(() => {
      expect(result.current.damage.isSuccess).toBe(true);
      expect(result.current.players.isSuccess).toBe(true);
      expect(result.current.otherDamage.isSuccess).toBe(true);
    });

    const prefix = BREAKDOWN_QUERY_KEY_OF(matchId);

    expect(prefix).toEqual([...DETAILS_QUERY_KEY, 'breakdown', matchId]);
    // The analysis run of the match page refreshes the two tabs of a match through this prefix,
    // and only them.
    const matched = queryClient.getQueryCache().findAll({ queryKey: prefix });
    expect(matched.map((query) => query.queryKey)).toEqual([
      [...prefix, 'damage'],
      [...prefix, 'players'],
    ]);
  });
});

describe('useMatchSummary', () => {
  it('reads one match of the history', async () => {
    const { services, matchId } = await setUp();
    const { result, queryClient } = renderWithServices(services, () => useMatchSummary(matchId));

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // The very row the history lists for the match.
    const { matches } = await services.matches.listRecent(LIST_LIMIT);
    expect(result.current.data).toEqual(matches.find((match) => match.matchId === matchId));
    expect(result.current.data).toMatchObject({ matchId, detailStatus: 'ready' });
    // The key sits under the matches: what refreshes the history refreshes the match too.
    expect(queryClient.getQueryData([...MATCHES_QUERY_KEY, 'one', matchId])).toBe(
      result.current.data,
    );
  });

  it('answers null for a match the account does not have', async () => {
    const { services, matchId } = await setUp();
    const unknownId = testMatchId(matchId + UNKNOWN_ID_OFFSET);
    const { result } = renderWithServices(services, () => useMatchSummary(unknownId));

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // `null` is an answer (the page says the match is unknown), not a loading state.
    expect(result.current.data).toBeNull();
  });
});

describe('useHeroAssets', () => {
  it('reads the hero assets, apart from the hero names', async () => {
    const { services } = await setUp();
    const { result, queryClient } = renderWithServices(services, () => ({
      assets: useHeroAssets(true),
      names: useHeroNames(true),
    }));

    await waitFor(() => {
      expect(result.current.assets.isSuccess).toBe(true);
      expect(result.current.names.isSuccess).toBe(true);
    });

    const assets = result.current.assets.data ?? expect.unreachable('the assets are read');
    expect(assets).toEqual(await services.heroes.getHeroAssets());
    expect(assets.length).toBeGreaterThan(0);
    // Two queries, two cache entries: the names stay the bare heroes, the assets keep the portraits
    // and the loadouts. Sharing one entry would hand the shape of one to the reader of the other.
    expect(queryClient.getQueryData([...HEROES_QUERY_KEY, 'assets'])).toBe(assets);
    expect(queryClient.getQueryData(HEROES_QUERY_KEY)).toEqual(await services.heroes.getHeroes());
    expect(queryClient.getQueryData(HEROES_QUERY_KEY)).not.toBe(assets);
  });

  it('asks for nothing while it is disabled', async () => {
    const { services } = await setUp();
    const read = vi.spyOn(services.heroes, 'getHeroAssets');
    const { result } = renderWithServices(services, () => useHeroAssets(false));

    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
    expect(result.current.data).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('the refresh of the breakdown', () => {
  it('refreshes the breakdown on a synchronisation', async () => {
    const { services, matchId } = await setUp();
    const damage = vi.spyOn(services.breakdown, 'getDamageTab');
    const players = vi.spyOn(services.breakdown, 'getPlayersTab');
    const { result } = renderWithServices(services, () => {
      useRefreshOnSync();
      return { damage: useDamageTab(matchId), players: usePlayersTab(matchId) };
    });
    await waitFor(() => {
      expect(result.current.damage.isSuccess).toBe(true);
      expect(result.current.players.isSuccess).toBe(true);
    });
    expect(damage).toHaveBeenCalledTimes(1);
    expect(players).toHaveBeenCalledTimes(1);

    // A synchronisation starts and ends: both tabs are read again, since the projection of the match
    // (and so what the tabs say of it) may have changed.
    await services.sync.syncNow('manual');

    await waitFor(() => {
      expect(damage.mock.calls.length).toBeGreaterThan(1);
      expect(players.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('is forgotten with the other data of the account, even when no screen shows it', async () => {
    const { services, matchId } = await setUp();
    const { result, queryClient, unmount } = renderWithServices(services, () => ({
      damage: useDamageTab(matchId),
      players: usePlayersTab(matchId),
      match: useMatchSummary(matchId),
      assets: useHeroAssets(true),
    }));
    await waitFor(() => {
      expect(result.current.damage.isSuccess).toBe(true);
      expect(result.current.players.isSuccess).toBe(true);
      expect(result.current.match.isSuccess).toBe(true);
      expect(result.current.assets.isSuccess).toBe(true);
    });
    // The page is gone: the queries stay in the cache, with the data of the account.
    unmount();
    expect(queryClient.getQueryData([...BREAKDOWN_QUERY_KEY_OF(matchId), 'damage'])).toBeDefined();

    await resetAccountData(queryClient);

    // An account change leaves nothing of the previous account behind.
    for (const queryKey of [
      [...BREAKDOWN_QUERY_KEY_OF(matchId), 'damage'],
      [...BREAKDOWN_QUERY_KEY_OF(matchId), 'players'],
      [...MATCHES_QUERY_KEY, 'one', matchId],
      [...HEROES_QUERY_KEY, 'assets'],
    ]) {
      expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    }
  });
});

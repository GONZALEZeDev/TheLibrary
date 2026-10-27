/**
 * Tests of the hook of the match history, rendered with the services of the app on the development
 * adapters (in-memory database, synthetic account).
 *
 * @packageDocumentation
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { MatchesRepository } from '../../../services/matches.repository';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { matchSummary } from '../../../test/test-data';
import { ServicesProvider } from '../../app/ServicesContext';
import { MATCHES_QUERY_KEY, useHistory } from './use-matches';

describe('useHistory', () => {
  it('reads the history under the filter, and keeps one cache entry for each filter', async () => {
    const test = createTestServices();
    await new MatchesRepository(test.database).upsertMany([
      matchSummary({ matchId: 100000001, accountId: FIXTURE_ACCOUNT_ID, startTime: 1_000 }),
      matchSummary({
        matchId: 100000002,
        accountId: FIXTURE_ACCOUNT_ID,
        startTime: 2_000,
        won: false,
        heroId: PAIGE_HERO_ID + 1,
      }),
    ]);
    const queryClient = createTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ServicesProvider services={test.services}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ServicesProvider>
    );

    const all = renderHook(() => useHistory({ hero: 'all', result: 'all' }), { wrapper });
    const losses = renderHook(() => useHistory({ hero: PAIGE_HERO_ID + 1, result: 'loss' }), {
      wrapper,
    });

    await waitFor(() => {
      expect(all.result.current.data?.kind).toBe('ready');
      expect(losses.result.current.data?.kind).toBe('ready');
    });
    expect(all.result.current.data).toMatchObject({ total: 2 });
    expect(losses.result.current.data).toMatchObject({
      total: 2,
      matches: [{ matchId: 100000002 }],
    });
    // The key holds the filter and sits under the matches prefix, so a sync refreshes both.
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: MATCHES_QUERY_KEY })
        .map((query) => query.queryKey),
    ).toEqual(
      expect.arrayContaining([
        [...MATCHES_QUERY_KEY, 'history', 'all', 'all'],
        [...MATCHES_QUERY_KEY, 'history', PAIGE_HERO_ID + 1, 'loss'],
      ]),
    );
  });

  describe('when the list is left', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the history in the cache for longer than a visit to a match', async () => {
      const test = createTestServices();
      await new MatchesRepository(test.database).upsertMany([
        matchSummary({ matchId: 100000001, accountId: FIXTURE_ACCOUNT_ID, startTime: 1_000 }),
      ]);
      const queryClient = createTestQueryClient();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ServicesProvider services={test.services}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </ServicesProvider>
      );
      const filter = { hero: 'all', result: 'all' } as const;
      const list = renderHook(() => useHistory(filter), { wrapper });
      await waitFor(() => {
        expect(list.result.current.data?.kind).toBe('ready');
      });

      // The player opens a match (the list unmounts) and reads it for ten minutes, twice the
      // default time a query is kept once nothing shows it.
      vi.useFakeTimers();
      list.unmount();
      vi.advanceTimersByTime(10 * 60_000);

      // Back on the list: its data is there at once, for the first render to be at full height.
      const back = renderHook(() => useHistory(filter), { wrapper });
      expect(back.result.current.data).toMatchObject({ kind: 'ready', total: 1 });
    });
  });
});

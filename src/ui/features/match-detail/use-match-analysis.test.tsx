/**
 * Tests of the hooks of the match analysis, rendered with the services of the app on the development
 * adapters: the fixture API plays deadlock-api (the history, the details and the community data), the
 * database and the archive are in memory, and the account is the synthetic one of the fixtures.
 *
 * Every test first synchronises a small synthetic history, like the app does at its start, which
 * archives and projects its Paige matches, so the first of them can be read at once (a test about
 * the analysis of a match that is not projected yet deletes those projections). Its community data
 * is not in the cache yet, which is what the page asks `useCommunityRefresh` for.
 *
 * @packageDocumentation
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi } from '../../../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import { matchIdSchema } from '../../../core/domain/match';
import { AppError } from '../../../core/errors/app-error';
import type { AppServices } from '../../../services/app-services';
import { MetricsRepository } from '../../../services/metrics.repository';
import {
  createTestQueryClient,
  createTestServices,
  projectArchivedMatches,
} from '../../../test/create-test-services';
import { createQueryClient } from '../../app/query-client';
import { ServicesProvider } from '../../app/ServicesContext';
import { resetAccountData, useUnlinkAccount } from '../account/use-account';
import {
  DETAILS_QUERY_KEY,
  DETAILS_SUMMARY_QUERY_KEY,
  useRefreshOnSync,
} from '../matches/use-matches';
import {
  ANALYSIS_COMMUNITY_QUERY_KEY,
  useAnalyseMatch,
  useCommunityRefresh,
  useMatchAnalysis,
} from './use-match-analysis';
import { BREAKDOWN_QUERY_KEY_OF } from './use-match-breakdown';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Size of the synthetic history. It is archived and projected before every test, so it is kept
 * short: just long enough to hold an archived Paige match.
 */
const HISTORY_SIZE = 14;

/** The start of the path of every community request of the fixture API. */
const ANALYTICS_PREFIX = '/v1/analytics/';

/** How long the slowed-down read of an analysis takes in the test that pins the order of answers. */
const SLOW_READ_MS = 20;

/** How long a test waits to see that nothing more happens: well over a few turns of the event loop. */
const SETTLE_MS = 50;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Options of {@link setUp}. */
interface SetUpOptions {
  /**
   * Whether the archived matches are projected, as the synchronisation leaves them. Not projected
   * (as a page opened before the end of the synchronisation finds them), the most recent archived
   * match is `pending`: it is the one `useAnalyseMatch` analyses. Projected by default.
   */
  readonly projected?: boolean;
}

/**
 * Synchronise a small synthetic history, so that its Paige matches are archived and projected,
 * delete those projections when the test is about a match that is not projected yet, and pick the
 * most recent archived match.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The services and their adapters, and the id of an archived match.
 */
async function setUp({ projected = true }: SetUpOptions = {}) {
  const test = createTestServices({
    now: () => START,
    handler: createFixtureApi({ now: START, matchCount: HISTORY_SIZE }),
  });
  await test.services.sync.syncNow('startup');
  if (projected) {
    await projectArchivedMatches(test, { now: () => START });
  } else {
    await new MetricsRepository(test.database).deleteAccount(FIXTURE_ACCOUNT_ID);
  }
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
 * @param queryClient - The query client; the one of the tests (no query retries) by default.
 * @returns The latest value of `useHooks`, and the query client (to inspect the cache).
 */
function renderWithServices<T>(
  services: AppServices,
  useHooks: () => T,
  queryClient = createTestQueryClient(),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesProvider services={services}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ServicesProvider>
  );
  const { result } = renderHook(useHooks, { wrapper });
  return { result, queryClient };
}

describe('useMatchAnalysis', () => {
  it('reads the analysis', async () => {
    const { services, matchId } = await setUp();
    const { result, queryClient } = renderWithServices(services, () => useMatchAnalysis(matchId));

    await waitFor(() => {
      expect(result.current.data).toMatchObject({ kind: 'ready' });
    });

    // Without community data in the cache, the match is compared with the habits only.
    expect(result.current.data).toMatchObject({ analysis: { community: { kind: 'missing' } } });
    expect(result.current.data).toEqual(await services.analysis.getMatchAnalysis(matchId));
    // The key sits under the match details: what refreshes them refreshes the analysis too.
    expect(queryClient.getQueryData([...DETAILS_QUERY_KEY, 'analysis', matchId])).toBe(
      result.current.data,
    );
  });
});

describe('useAnalyseMatch', () => {
  it('analyses the match, writes the view into the analysis query and refreshes the counts and the tabs', async () => {
    const test = await setUp({ projected: false });
    const { services, matchId } = test;
    const queryClient = createTestQueryClient(test.logger);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const read = vi.spyOn(services.analysis, 'getMatchAnalysis');
    const { result } = renderWithServices(
      services,
      () => ({ analysis: useMatchAnalysis(matchId), analyse: useAnalyseMatch(matchId) }),
      queryClient,
    );
    // The match is archived, not projected: the page reads it `pending` and asks for the analysis.
    await waitFor(() => {
      expect(result.current.analysis.data).toEqual({ kind: 'pending' });
    });

    act(() => {
      result.current.analyse.mutate();
    });
    await waitFor(() => {
      expect(result.current.analyse.isSuccess).toBe(true);
    });

    // The query shows the analysis the service answered, without having read it again.
    expect(result.current.analyse.data).toMatchObject({ kind: 'ready' });
    expect(result.current.analysis.data).toEqual(result.current.analyse.data);
    expect(result.current.analysis.data).toEqual(await services.analysis.getMatchAnalysis(matchId));
    // The counts of the banner and the tabs of the match are read again: the success does not make
    // the analysis query read itself again, which would never end for a view that stays `pending`.
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: DETAILS_SUMMARY_QUERY_KEY },
      { queryKey: BREAKDOWN_QUERY_KEY_OF(matchId) },
    ]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });
    // One read before the analysis, and the one of this test just above.
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the view it wrote when a read that began before it ends after it', async () => {
    const test = await setUp({ projected: false });
    const { services, matchId } = test;
    const queryClient = createTestQueryClient(test.logger);
    const { result } = renderWithServices(
      services,
      () => ({ analysis: useMatchAnalysis(matchId), analyse: useAnalyseMatch(matchId) }),
      queryClient,
    );
    await waitFor(() => {
      expect(result.current.analysis.data).toEqual({ kind: 'pending' });
    });
    // A read of the analysis starts (a synchronisation refreshes the page) and is slow: it has seen
    // the match pending, and it says so when it ends.
    let endRead = (): void => undefined;
    const readEnds = new Promise<void>((resolve) => {
      endRead = resolve;
    });
    const read = vi.spyOn(services.analysis, 'getMatchAnalysis').mockImplementation(async () => {
      await readEnds;
      return { kind: 'pending' };
    });
    act(() => {
      void queryClient.invalidateQueries({ queryKey: [...DETAILS_QUERY_KEY, 'analysis', matchId] });
    });
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });

    // The analysis runs and ends while that read is still going.
    act(() => {
      result.current.analyse.mutate();
    });
    await waitFor(() => {
      expect(result.current.analyse.isSuccess).toBe(true);
    });
    endRead();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });

    // The late answer is the older one: it does not take the analysis away from the page.
    expect(result.current.analysis.data).toMatchObject({ kind: 'ready' });
  });

  it('is not a failure when the account is changing, and can be asked again', async () => {
    const test = await setUp({ projected: false });
    const { services, matchId } = test;
    // An account change is under way: the exclusive section refuses new work.
    await services.sync.suspend();
    const analyse = vi.spyOn(services.analysis, 'analyseMatch');
    const queryClient = createTestQueryClient(test.logger);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderWithServices(
      services,
      () => ({ analysis: useMatchAnalysis(matchId), analyse: useAnalyseMatch(matchId) }),
      queryClient,
    );
    await waitFor(() => {
      expect(result.current.analysis.data).toEqual({ kind: 'pending' });
    });

    act(() => {
      result.current.analyse.mutate();
    });
    await waitFor(() => {
      expect(result.current.analyse.isSuccess).toBe(true);
    });

    // Nothing was analysed, and nothing is reported: `null` says "not now".
    expect(result.current.analyse.data).toBeNull();
    expect(result.current.analyse.isError).toBe(false);
    expect(test.logger.entries.filter((entry) => entry.scope === 'mutation')).toEqual([]);
    expect(result.current.analysis.data).toEqual({ kind: 'pending' });
    expect(invalidate).not.toHaveBeenCalled();

    // The account change is over: the same mutation analyses the match.
    services.sync.resume();
    act(() => {
      result.current.analyse.mutate();
    });
    await waitFor(() => {
      expect(result.current.analyse.data).toMatchObject({ kind: 'ready' });
    });
    expect(result.current.analysis.data).toMatchObject({ kind: 'ready' });
    expect(analyse).toHaveBeenCalledTimes(2);
  });

  it('fails with the error of the service, logs it once and writes nothing', async () => {
    const test = await setUp({ projected: false });
    const { services, matchId } = test;
    const analyse = vi
      .spyOn(services.analysis, 'analyseMatch')
      .mockRejectedValue(new AppError('storage', 'The match could not be analysed'));
    const queryClient = createTestQueryClient(test.logger);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderWithServices(
      services,
      () => ({ analysis: useMatchAnalysis(matchId), analyse: useAnalyseMatch(matchId) }),
      queryClient,
    );
    await waitFor(() => {
      expect(result.current.analysis.data).toEqual({ kind: 'pending' });
    });

    act(() => {
      result.current.analyse.mutate();
    });
    await waitFor(() => {
      expect(result.current.analyse.isError).toBe(true);
    });

    expect(result.current.analyse.error).toMatchObject({ kind: 'storage' });
    // The query keeps what it showed, and the counts are not read again for nothing.
    expect(result.current.analysis.data).toEqual({ kind: 'pending' });
    expect(invalidate).not.toHaveBeenCalled();
    // The failure is logged by the query client, with the name of the mutation and not its match.
    expect(test.logger.entries.filter((entry) => entry.scope === 'mutation')).toMatchObject([
      { level: 'error', context: { kind: 'storage', mutation: 'details.analyse' } },
    ]);
    expect(analyse).toHaveBeenCalledTimes(1);
  });

  it('never retries, whatever the defaults of the client say', async () => {
    const test = await setUp({ projected: false });
    const { services, matchId } = test;
    const analyse = vi
      .spyOn(services.analysis, 'analyseMatch')
      .mockRejectedValue(new AppError('network', 'The archive cannot be reached'));
    const queryClient = createTestQueryClient(test.logger);
    // A client that retries every mutation: the hook opts out.
    queryClient.setDefaultOptions({
      ...queryClient.getDefaultOptions(),
      mutations: { retry: 3, retryDelay: 0 },
    });
    const { result } = renderWithServices(services, () => useAnalyseMatch(matchId), queryClient);

    act(() => {
      result.current.mutate();
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(analyse).toHaveBeenCalledTimes(1);
  });
});

describe('useCommunityRefresh', () => {
  it('refreshes the community once and reads the analysis again', async () => {
    const { services, http, matchId } = await setUp();
    const refresh = vi.spyOn(services.analysis, 'refreshCommunity');
    const read = vi.spyOn(services.analysis, 'getMatchAnalysis');
    const communityRequests = () =>
      http.requests.filter((request) => new URL(request.url).pathname.startsWith(ANALYTICS_PREFIX));
    const requestsBefore = communityRequests().length;
    const { result } = renderWithServices(services, () => ({
      analysis: useMatchAnalysis(matchId),
      community: useCommunityRefresh(matchId, true),
    }));

    // The analysis is read before the download, then again once the data is in the cache.
    await waitFor(() => {
      expect(result.current.community.data).toBe('updated');
      expect(result.current.analysis.data).toMatchObject({
        kind: 'ready',
        analysis: { community: { kind: 'available' } },
      });
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(matchId);
    expect(read).toHaveBeenCalledTimes(2);
    // One download: the sizes of the cohort, its benchmarks and its curve.
    expect(communityRequests().length - requestsBefore).toBe(3);
  });

  it('answers only once the analysis shows the new data', async () => {
    const { services, matchId } = await setUp();
    // On the in-memory adapters the whole chain (reading, downloading, reading again) runs without
    // ever yielding to the event loop, so React would render the end state only and the order of
    // the two answers could not be seen. A read that takes a moment, like the one of a real archive,
    // gives each answer its own render.
    const readAnalysis = services.analysis.getMatchAnalysis.bind(services.analysis);
    vi.spyOn(services.analysis, 'getMatchAnalysis').mockImplementation(async (id) => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_READ_MS));
      return readAnalysis(id);
    });
    // What each render of the hooks showed: the answer of the community query, and whether the
    // analysis was compared with the community by then.
    const renders: { answer: string | undefined; compared: boolean }[] = [];
    const { result } = renderWithServices(services, () => {
      const analysis = useMatchAnalysis(matchId);
      const community = useCommunityRefresh(matchId, true);
      renders.push({
        answer: community.data,
        compared:
          analysis.data?.kind === 'ready' && analysis.data.analysis.community.kind === 'available',
      });
      return { analysis, community };
    });

    await waitFor(() => {
      expect(result.current.community.data).toBe('updated');
    });

    // The page stops saying that the comparison is loading when the answer comes: no render may
    // show the answer next to an analysis that does not have the data yet.
    expect(renders.some((render) => render.answer === 'updated')).toBe(true);
    expect(renders.filter((render) => render.answer === 'updated' && !render.compared)).toEqual([]);
  });

  it('does not ask for anything while it is disabled', async () => {
    const { services, matchId } = await setUp();
    const refresh = vi.spyOn(services.analysis, 'refreshCommunity');
    const { result } = renderWithServices(services, () => useCommunityRefresh(matchId, false));

    // Nothing is fetched for a match the page does not show an analysis of.
    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
    expect(result.current.data).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('leaves the analysis alone when the data could not be downloaded', async () => {
    const { services, matchId } = await setUp();
    vi.spyOn(services.analysis, 'refreshCommunity').mockResolvedValue('unavailable');
    const read = vi.spyOn(services.analysis, 'getMatchAnalysis');
    const { result } = renderWithServices(services, () => ({
      analysis: useMatchAnalysis(matchId),
      community: useCommunityRefresh(matchId, true),
    }));

    await waitFor(() => {
      expect(result.current.community.data).toBe('unavailable');
      expect(result.current.analysis.data).toMatchObject({ kind: 'ready' });
    });

    // Nothing new is in the cache, so there is nothing to read again.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads the analysis again, once, when the answer is fresh', async () => {
    const { services, matchId } = await setUp();
    // Another refresh of the same cohort (the page opened before this one) may have stored the data
    // between the read of this page and its ask: the analysis it shows is behind the cache. The mock
    // plays that answer and stores nothing, so the analysis read again is still not compared with
    // the community: the worst case for a loop, since the page still wants the data.
    const refresh = vi.spyOn(services.analysis, 'refreshCommunity').mockResolvedValue('fresh');
    const read = vi.spyOn(services.analysis, 'getMatchAnalysis');
    const { result } = renderWithServices(services, () => {
      const analysis = useMatchAnalysis(matchId);
      // Like the page: the data is asked for once the analysis has been read and lacks it.
      const lacksData =
        analysis.data?.kind === 'ready' && analysis.data.analysis.community.kind !== 'available';
      return { analysis, community: useCommunityRefresh(matchId, lacksData) };
    });

    await waitFor(() => {
      expect(result.current.community.data).toBe('fresh');
      expect(read).toHaveBeenCalledTimes(2);
    });
    // Time for a loop to show itself: a second ask, or a third read.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.analysis.data).toMatchObject({
      kind: 'ready',
      analysis: { community: { kind: 'missing' } },
    });
  });

  it.each(['storage', 'network'] as const)(
    'stays a query error, without retrying, when the refresh fails with a %s error',
    async (kind) => {
      const { services, matchId } = await setUp();
      const refresh = vi
        .spyOn(services.analysis, 'refreshCommunity')
        .mockRejectedValue(new AppError(kind, 'The community data cannot be refreshed'));
      // The client of the app, not the one of the tests (which never retries): it retries a
      // transient error (`network`) after a second, unless the query opts out. The service only
      // rejects with `storage`, but the hook must not depend on it.
      const { result } = renderWithServices(
        services,
        () => ({
          analysis: useMatchAnalysis(matchId),
          community: useCommunityRefresh(matchId, true),
        }),
        createQueryClient(services),
      );

      // Well before the first retry would run.
      await waitFor(() => {
        expect(result.current.community.isError).toBe(true);
      });

      // The page shows "no comparison with your rank for now": the analysis itself is still there.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(result.current.analysis.data).toMatchObject({ kind: 'ready' });
    },
  );

  it('the community query is reset on account change and not refreshed by a sync', async () => {
    const { services, matchId } = await setUp();
    const refresh = vi.spyOn(services.analysis, 'refreshCommunity');
    const read = vi.spyOn(services.analysis, 'getMatchAnalysis');
    const { result } = renderWithServices(services, () => {
      useRefreshOnSync();
      return {
        analysis: useMatchAnalysis(matchId),
        community: useCommunityRefresh(matchId, true),
        unlink: useUnlinkAccount(),
      };
    });
    await waitFor(() => {
      expect(result.current.community.data).toBe('updated');
      expect(result.current.analysis.data).toMatchObject({
        analysis: { community: { kind: 'available' } },
      });
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const readsBeforeSync = read.mock.calls.length;

    // A synchronisation reads the analysis again (the matches may have been projected again)...
    await services.sync.syncNow('manual');
    await waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThan(readsBeforeSync);
    });
    // ... but does not ask for the community data again: the detail queue emits events all the time,
    // and the data is as good as it was.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.community.data).toBe('updated');

    // Unlinking the account resets everything that depended on it, the community query included:
    // it asks again, and the answer is the one of a player with no account.
    act(() => {
      result.current.unlink.mutate();
    });
    await waitFor(() => {
      expect(result.current.unlink.isSuccess).toBe(true);
      expect(result.current.community.data).toBe('fresh');
      expect(result.current.analysis.data).toEqual({ kind: 'not_analysed' });
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('is forgotten with the other data of the account, even when no screen shows it', async () => {
    const { services, matchId } = await setUp();
    const { queryClient } = renderWithServices(services, () => undefined);
    const key = [...ANALYSIS_COMMUNITY_QUERY_KEY, matchId];
    queryClient.setQueryData(key, 'updated');

    await resetAccountData(queryClient);

    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
});

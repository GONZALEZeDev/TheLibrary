/**
 * Tests of the hooks of the review, rendered with the services of the app on the development
 * adapters: the fixture API plays deadlock-api (the history, the catalogues and the community data),
 * the database and the archive are in memory, and the account is the synthetic one of the fixtures.
 *
 * Every test first synchronises a small synthetic history, like the app does at its start, which
 * archives and projects its Paige matches, so the review can be read at once. Its community data is
 * not in the cache yet, which is what the page asks `useReviewCommunityRefresh` for.
 *
 * @packageDocumentation
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi } from '../../../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import { REVIEW_MATCHES } from '../../../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../../../core/analysis/registry';
import { AppError } from '../../../core/errors/app-error';
import type { AppServices } from '../../../services/app-services';
import { MetricsRepository } from '../../../services/metrics.repository';
import { cohortsByCoverage } from '../../../services/review.service';
import {
  createTestQueryClient,
  createTestServices,
  projectArchivedMatches,
} from '../../../test/create-test-services';
import { createQueryClient } from '../../app/query-client';
import { ServicesProvider } from '../../app/ServicesContext';
import { useUnlinkAccount } from '../account/use-account';
import { DETAILS_QUERY_KEY, useRefreshOnSync } from '../matches/use-matches';
import { useReview, useReviewCommunityRefresh } from './use-review';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const START = Date.UTC(2026, 9, 22, 12, 0, 0);

/**
 * Size of the synthetic history. It is archived and projected before every test, so it is kept
 * short: just long enough to hold a few archived Paige matches.
 */
const HISTORY_SIZE = 14;

/** The start of the path of every community request of the fixture API. */
const ANALYTICS_PREFIX = '/v1/analytics/';

/** The requests the download of one cohort makes: its size, its benchmarks and its curve. */
const REQUESTS_PER_COHORT = 3;

/** The requests the download of the item statistics makes. */
const ITEM_STATS_REQUESTS = 2;

/** How long the slowed-down read of the review takes in the test that pins the order of answers. */
const SLOW_READ_MS = 20;

/** How long a test waits to see that nothing more happens: well over a few turns of the event loop. */
const SETTLE_MS = 50;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Synchronise a small synthetic history, so that its Paige matches are archived and projected.
 *
 * @returns The services and their adapters.
 */
async function setUp() {
  const test = createTestServices({
    now: () => START,
    handler: createFixtureApi({ now: START, matchCount: HISTORY_SIZE }),
  });
  await test.services.sync.syncNow('startup');
  // The synchronisation projected the matches already: this only makes sure of it.
  await projectArchivedMatches(test, { now: () => START });
  return test;
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

/**
 * Let the event loop turn for a moment, so that a loop of reads or asks would show itself.
 *
 * @returns A promise settled once the moment has passed.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  });
}

/**
 * Call the hooks like the review page does: the review is read, and the community data is asked for
 * once the review is there and lacks it. (Asked for earlier, the invalidation that follows the
 * download would join the first read, still going, and not start another.)
 *
 * @returns The two queries.
 */
function usePage() {
  const review = useReview();
  const lacksData =
    review.data?.kind === 'ready' && review.data.review.community.kind !== 'available';
  const community = useReviewCommunityRefresh(lacksData);
  return { review, community };
}

/**
 * Call the hooks with the community query kept mounted and enabled once the review has been read,
 * whatever the review says. {@link usePage} stops asking once the review is compared; a test about
 * what the query does while it is mounted (does a synchronisation ask again? an account change?)
 * needs it to stay enabled.
 *
 * @returns The two queries.
 */
function useMountedPage() {
  const review = useReview();
  const community = useReviewCommunityRefresh(review.data !== undefined);
  return { review, community };
}

describe('useReview', () => {
  it('reads the review', async () => {
    const { services } = await setUp();
    const { result, queryClient } = renderWithServices(services, useReview);

    await waitFor(() => {
      expect(result.current.data).toMatchObject({ kind: 'ready' });
    });

    // Without community data in the cache, the matches are not compared with the tier above yet.
    expect(result.current.data).toMatchObject({ review: { community: { kind: 'missing' } } });
    expect(result.current.data).toEqual(await services.review.getReview());
    // The key sits under the match details: what refreshes them (a synchronisation, an account
    // change) reads the review again.
    expect(queryClient.getQueryData([...DETAILS_QUERY_KEY, 'review'])).toBe(result.current.data);
  });
});

describe('useReviewCommunityRefresh', () => {
  it('downloads the comparison, then reads the review again', async () => {
    const { services, http, database } = await setUp();
    const refresh = vi.spyOn(services.review, 'refreshCommunity');
    const read = vi.spyOn(services.review, 'getReview');
    const communityRequests = () =>
      http.requests.filter((request) => new URL(request.url).pathname.startsWith(ANALYTICS_PREFIX));
    const requestsBefore = communityRequests().length;
    // One download: a cohort for each duration window of the last matches, then the item statistics.
    const recent = await new MetricsRepository(database).listRecent(
      FIXTURE_ACCOUNT_ID,
      PROJECTION_VERSION,
      REVIEW_MATCHES,
    );
    const windows = cohortsByCoverage(recent, { kind: 'all' }).length;
    const { result, queryClient } = renderWithServices(services, usePage);

    // The review is read before the download, then again once the data is in the cache.
    await waitFor(() => {
      expect(result.current.community.data).toBe('updated');
      expect(result.current.review.data).toMatchObject({
        kind: 'ready',
        review: { community: { kind: 'available' } },
      });
    });
    // Time for a loop to show itself: a second download, or a third read.
    await settle();

    // The refresh asks once, though the review it invalidates is read twice: its key is not under
    // the review's, so reading the review again never runs the download again.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(['review-community'])).toBe('updated');
    expect(communityRequests().length - requestsBefore).toBe(
      windows * REQUESTS_PER_COHORT + ITEM_STATS_REQUESTS,
    );
  });

  it('answers only once the review shows the new data', async () => {
    const { services } = await setUp();
    // On the in-memory adapters the whole chain (reading, downloading, reading again) runs without
    // ever yielding to the event loop, so React would render the end state only and the order of
    // the two answers could not be seen. A read that takes a moment, like the one of a real archive,
    // gives each answer its own render.
    const readReview = services.review.getReview.bind(services.review);
    vi.spyOn(services.review, 'getReview').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_READ_MS));
      return readReview();
    });
    // What each render of the hooks showed: the answer of the community query, and whether the
    // review was compared with the community by then.
    const renders: { answer: string | undefined; compared: boolean }[] = [];
    const { result } = renderWithServices(services, () => {
      const { review, community } = usePage();
      renders.push({
        answer: community.data,
        compared:
          review.data?.kind === 'ready' && review.data.review.community.kind === 'available',
      });
      return { review, community };
    });

    await waitFor(() => {
      expect(result.current.community.data).toBe('updated');
    });

    // The page stops saying that the comparison is loading when the answer comes: no render may
    // show the answer next to a review that does not have the data yet.
    expect(renders.some((render) => render.answer === 'updated')).toBe(true);
    expect(renders.filter((render) => render.answer === 'updated' && !render.compared)).toEqual([]);
  });

  it('does not read the review again when the comparison is unavailable', async () => {
    const { services } = await setUp();
    vi.spyOn(services.review, 'refreshCommunity').mockResolvedValue('unavailable');
    const read = vi.spyOn(services.review, 'getReview');
    const { result } = renderWithServices(services, usePage);

    await waitFor(() => {
      expect(result.current.community.data).toBe('unavailable');
      expect(result.current.review.data).toMatchObject({ kind: 'ready' });
    });
    await settle();

    // Nothing new is in the cache, so there is nothing to read again.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a synchronisation reads the review again but does not download the comparison again', async () => {
    const { services } = await setUp();
    const refresh = vi.spyOn(services.review, 'refreshCommunity');
    const read = vi.spyOn(services.review, 'getReview');
    const { result } = renderWithServices(services, () => {
      useRefreshOnSync();
      return useMountedPage();
    });
    await waitFor(() => {
      expect(result.current.community.data).toBe('updated');
      expect(result.current.review.data).toMatchObject({
        review: { community: { kind: 'available' } },
      });
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const readsBeforeSync = read.mock.calls.length;

    // A synchronisation reads the review again (the matches may have been analysed again)...
    await services.sync.syncNow('manual');
    await waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThan(readsBeforeSync);
    });
    await settle();

    // ... but does not ask for the community data again: the detail queue emits events all the time,
    // and the data is as good as it was.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.community.data).toBe('updated');
  });

  it('is reset on an account change and asks again for the account it finds', async () => {
    const { services } = await setUp();
    const refresh = vi.spyOn(services.review, 'refreshCommunity');
    const { result } = renderWithServices(services, () => ({
      ...useMountedPage(),
      unlink: useUnlinkAccount(),
    }));
    await waitFor(() => {
      expect(result.current.community.data).toBe('updated');
      expect(result.current.review.data).toMatchObject({
        review: { community: { kind: 'available' } },
      });
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Unlinking the account resets everything that depended on it, the download included: it asks
    // again, and the answer is the one of a player with no account, not the previous one.
    act(() => {
      result.current.unlink.mutate();
    });
    await waitFor(() => {
      expect(result.current.unlink.isSuccess).toBe(true);
      expect(result.current.community.data).toBe('fresh');
      expect(result.current.review.data).toEqual({ kind: 'no_account' });
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(['fresh', 'partial'] as const)(
    'reads the review again, once, when the answer is %s',
    async (outcome) => {
      const { services } = await setUp();
      // `fresh`: another refresh may have stored the data between the read of the page and its ask.
      // `partial`: some of the data was stored. The mock stores nothing, so the review read again is
      // still not compared with the community: the worst case for a loop.
      const refresh = vi.spyOn(services.review, 'refreshCommunity').mockResolvedValue(outcome);
      const read = vi.spyOn(services.review, 'getReview');
      const { result } = renderWithServices(services, usePage);

      await waitFor(() => {
        expect(result.current.community.data).toBe(outcome);
        expect(read).toHaveBeenCalledTimes(2);
      });
      await settle();

      expect(read).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it('does not ask for anything while it is disabled', async () => {
    const { services } = await setUp();
    const refresh = vi.spyOn(services.review, 'refreshCommunity');
    const { result } = renderWithServices(services, () => useReviewCommunityRefresh(false));

    // Nothing is downloaded for a page that shows no review to compare.
    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
    expect(result.current.data).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['storage', 'network'] as const)(
    'stays a query error, without retrying, when the refresh fails with a %s error',
    async (kind) => {
      const { services } = await setUp();
      const refresh = vi
        .spyOn(services.review, 'refreshCommunity')
        .mockRejectedValue(new AppError(kind, 'The community data cannot be refreshed'));
      // The client of the app, not the one of the tests (which never retries): it retries a
      // transient error (`network`) after a second, unless the query opts out. The service only
      // rejects with `storage`, but the hook must not depend on it.
      const { result } = renderWithServices(services, usePage, createQueryClient(services));

      // Well before the first retry would run.
      await waitFor(() => {
        expect(result.current.community.isError).toBe(true);
      });

      // The page shows "comparison unavailable for now": the review itself is still there.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(result.current.review.data).toMatchObject({ kind: 'ready' });
    },
  );
});

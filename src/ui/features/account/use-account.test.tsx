/**
 * Tests of the account hooks, rendered with the services of the app on the development adapters:
 * the fixture gateway plays the loopback listener and the browser, the fixture API plays deadlock-api
 * and Steam, and the database and the archive are in memory. Accounts are synthetic: 1000001 is the
 * account of the fixtures.
 *
 * The hooks share one TanStack Query cache with the match history screen, so most tests look at what
 * that cache holds after the account changed.
 *
 * @packageDocumentation
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi } from '../../../adapters/dev/fixture-http-client.adapter';
import { FixtureSignInGateway } from '../../../adapters/dev/fixture-sign-in-gateway.adapter';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { AppError } from '../../../core/errors/app-error';
import type { AppServices } from '../../../services/app-services';
import type { MatchId } from '../../../core/domain/match';
import { MatchesRepository } from '../../../services/matches.repository';
import type { HistoryFilter, HistoryView } from '../../../services/matches.service';
import type { SyncService } from '../../../services/sync.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { matchSummary, testAccountId, testMatchId } from '../../../test/test-data';
import { ServicesProvider } from '../../app/ServicesContext';
import { ANALYSIS_COMMUNITY_QUERY_KEY } from '../match-detail/use-match-analysis';
import {
  DETAILS_QUERY_KEY,
  DETAILS_SUMMARY_QUERY_KEY,
  HEROES_QUERY_KEY,
  MATCHES_QUERY_KEY,
  SYNC_QUERY_KEY,
  useHeroNames,
  useHistory,
  useLatestMatches,
} from '../matches/use-matches';
import { REVIEW_COMMUNITY_QUERY_KEY, REVIEW_QUERY_KEY } from '../review/use-review';
import { SETTINGS_QUERY_KEY } from '../settings/use-settings';
import {
  ACCOUNT_QUERY_KEY,
  useCancelLink,
  useLinkAccount,
  useLinkedAccount,
  useUnlinkAccount,
} from './use-account';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const START = Date.UTC(2026, 9, 19, 12, 0, 0);

/**
 * Size of the synthetic history. A link starts a real synchronisation of it, and the tests wait for
 * it to end, so it is kept short: just long enough to have a Paige match archived.
 */
const SMALL_HISTORY = 8;

/**
 * How long a test waits for a sign-in and the synchronisation it starts, in milliseconds. A sign-in
 * is a chain of services, not a single read: the default of `waitFor` (one second) is too tight for a
 * busy machine.
 */
const SIGN_IN_TIMEOUT_MS = 5_000;

/** The account a player switches away from; the fixture sign-in gives the account of the fixtures. */
const PREVIOUS_ACCOUNT_ID = testAccountId(2000001);

/** The match of the previous account: its id is far from the ones of the synthetic history. */
const PREVIOUS_MATCH_ID = testMatchId(100000001);

/** The filter of the history the tests read: every hero, every result, so every stored match. */
const EVERY_MATCH: HistoryFilter = { hero: 'all', result: 'all' };

/** The cache key of the history under {@link EVERY_MATCH}, as `useHistory` builds it. */
const HISTORY_KEY = [...MATCHES_QUERY_KEY, 'history', 'all', 'all'];

/**
 * The ids of the matches of a history.
 *
 * @param view - The history, maybe not read yet.
 * @returns The ids of its matches, in order; none while it is not read or without an account.
 */
function historyMatchIds(view: HistoryView | undefined): MatchId[] {
  return view?.kind === 'ready' ? view.matches.map((match) => match.matchId) : [];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Build the services of a test: a clock that does not move and a short synthetic history.
 *
 * @param options - Options of `createTestServices`, which win over the ones set here.
 * @returns The services and their adapters.
 */
function setUp(options: TestServicesOptions = {}): TestServices {
  return createTestServices({
    now: () => START,
    handler: createFixtureApi({ now: START, matchCount: SMALL_HISTORY }),
    ...options,
  });
}

/**
 * Render hooks inside the providers of the app that they need: the services and the query client.
 *
 * @param services - The services the hooks read through.
 * @param useHooks - Calls the hooks under test and returns what the test looks at.
 * @returns The latest value of `useHooks`, the query client (to inspect the cache) and `unmount`.
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

/**
 * Render the link and cancel hooks on services where the browser never comes back from Steam: a
 * link started by `result.current.link.mutate()` waits for the player until it is cancelled.
 *
 * @returns The services, the gateway (to see the browser open), the hooks' result and the cache.
 */
function renderWaitingLink() {
  const signInGateway = new FixtureSignInGateway({ autoAnswer: false, now: () => START });
  const { services } = setUp({ accountId: null, signInGateway });
  const rendered = renderWithServices(services, () => ({
    link: useLinkAccount(),
    cancel: useCancelLink(),
  }));
  return { services, signInGateway, ...rendered };
}

/**
 * Wait until the synchronisation is idle: a link starts the first synchronisation of the account in
 * the background, and a test must not end under it.
 *
 * @param sync - The synchronisation.
 * @returns A promise settled once no run is going (at once when none is).
 */
function whenIdle(sync: SyncService): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!sync.isRunning()) {
      resolve();
      return;
    }
    const unsubscribe = sync.subscribe(() => {
      if (!sync.isRunning()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Store one match, played an hour before the clock of the services: it is in the history, and in the
 * latest matches of the dashboard.
 *
 * @param test - The services of the test.
 * @param accountId - The account that played it; the account of the fixtures by default.
 * @param matchId - Its id; the one of `matchSummary` by default.
 */
async function seedMatch(
  test: TestServices,
  accountId = FIXTURE_ACCOUNT_ID,
  matchId?: number,
): Promise<void> {
  await new MatchesRepository(test.database).upsertMany([
    matchSummary({
      accountId,
      startTime: Math.floor(START / 1000) - 3_600,
      ...(matchId === undefined ? {} : { matchId }),
    }),
  ]);
}

describe('useLinkedAccount', () => {
  it('reads the linked account and follows its changes', async () => {
    const { services } = setUp({ accountId: null });
    const { result } = renderWithServices(services, useLinkedAccount);
    await waitFor(() => {
      expect(result.current.data).toBeNull();
    });

    // The player links outside the hook (not through `useLinkAccount`): only the subscription to the
    // service can tell the hook. The promise is awaited after `waitFor`, which lets the hook update
    // in the meantime without a warning.
    const linking = services.account.link();
    await waitFor(
      () => {
        expect(result.current.data).toMatchObject({
          accountId: FIXTURE_ACCOUNT_ID,
          personaName: 'Fixture Player',
        });
      },
      { timeout: SIGN_IN_TIMEOUT_MS },
    );
    await expect(linking).resolves.toMatchObject({ kind: 'linked' });
    await whenIdle(services.sync);

    const unlinking = services.account.unlink();
    await waitFor(() => {
      expect(result.current.data).toBeNull();
    });
    await expect(unlinking).resolves.toEqual({ complete: true });
  });

  it('stops following the account once the component is gone', async () => {
    const { services } = setUp();
    const { result, queryClient, unmount } = renderWithServices(services, useLinkedAccount);
    await waitFor(() => {
      expect(result.current.data).toMatchObject({ accountId: FIXTURE_ACCOUNT_ID });
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    // While the hook is shown, a change of the link makes it read the account again.
    const unlinking = services.account.unlink();
    await waitFor(() => {
      expect(result.current.data).toBeNull();
    });
    await unlinking;
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ACCOUNT_QUERY_KEY });

    // Once it is gone, the service must not call a listener that belongs to a component that no
    // longer exists.
    unmount();
    invalidate.mockClear();
    await expect(services.account.link()).resolves.toMatchObject({ kind: 'linked' });
    await whenIdle(services.sync);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useLinkAccount', () => {
  it('reads the data of the new account once it is linked', async () => {
    const { services } = setUp({ accountId: null });
    const { result } = renderWithServices(services, () => ({
      history: useHistory(EVERY_MATCH),
      link: useLinkAccount(),
    }));
    await waitFor(() => {
      expect(result.current.history.data).toMatchObject({ kind: 'no_account' });
    });

    act(() => {
      result.current.link.mutate();
    });

    // The mutation ends once the data is read again: the match list never says "no account" on top
    // of a linked account.
    await waitFor(
      () => {
        expect(result.current.link.isSuccess).toBe(true);
        expect(result.current.history.data).toMatchObject({ kind: 'ready' });
      },
      { timeout: SIGN_IN_TIMEOUT_MS },
    );
    expect(result.current.link.data).toMatchObject({ kind: 'linked', replaced: false });
    await whenIdle(services.sync);
  });

  it('clears the data of the previous account when the player switches to another', async () => {
    const test = setUp({ accountId: PREVIOUS_ACCOUNT_ID });
    await seedMatch(test, PREVIOUS_ACCOUNT_ID, PREVIOUS_MATCH_ID);
    const { result, queryClient } = renderWithServices(test.services, () => ({
      account: useLinkedAccount(),
      history: useHistory(EVERY_MATCH),
      link: useLinkAccount(),
    }));
    await waitFor(() => {
      expect(result.current.account.data).toMatchObject({ accountId: PREVIOUS_ACCOUNT_ID });
      expect(historyMatchIds(result.current.history.data)).toEqual([PREVIOUS_MATCH_ID]);
    });
    // The detail page of that match, read before: cached, and observed by no screen.
    const detailKey = [...DETAILS_QUERY_KEY, 'match', PREVIOUS_MATCH_ID];
    queryClient.setQueryData(detailKey, 'old detail');

    // The fixture sign-in gives another account than the linked one: a switch.
    act(() => {
      result.current.link.mutate();
    });

    await waitFor(
      () => {
        expect(result.current.link.isSuccess).toBe(true);
        expect(result.current.account.data).toMatchObject({ accountId: FIXTURE_ACCOUNT_ID });
        expect(result.current.history.data).toMatchObject({ kind: 'ready' });
      },
      { timeout: SIGN_IN_TIMEOUT_MS },
    );
    expect(result.current.link.data).toMatchObject({ kind: 'linked', replaced: true });
    // No row of the previous account is left in the cache, observed or not...
    expect(historyMatchIds(result.current.history.data)).not.toContain(PREVIOUS_MATCH_ID);
    expect(queryClient.getQueryData(detailKey)).toBeUndefined();
    // ... as none is left in the database: the service erased the account once the link had changed.
    await expect(new MatchesRepository(test.database).count(PREVIOUS_ACCOUNT_ID)).resolves.toBe(0);
    await whenIdle(test.services.sync);
  });

  it('reads the hero names again once an account is linked', async () => {
    const { services, http } = setUp({ accountId: null });
    const { result } = renderWithServices(services, () => ({
      names: useHeroNames(true),
      link: useLinkAccount(),
    }));
    // Without an account the app contacts nobody: the catalogue is empty, and stays empty in the
    // cache for an hour (its `staleTime`) unless an account change makes it read again.
    await waitFor(() => {
      expect(result.current.names.data?.size).toBe(0);
    });
    expect(http.requests).toHaveLength(0);

    act(() => {
      result.current.link.mutate();
    });

    await waitFor(
      () => {
        expect(result.current.link.isSuccess).toBe(true);
        expect(result.current.names.data?.get(PAIGE_HERO_ID)).toBe('Paige');
      },
      { timeout: SIGN_IN_TIMEOUT_MS },
    );
    await whenIdle(services.sync);
  });

  it('keeps the data of the account when it signs in again, and updates its profile', async () => {
    const test = setUp();
    await seedMatch(test);
    const { result, queryClient } = renderWithServices(test.services, () => ({
      account: useLinkedAccount(),
      history: useHistory(EVERY_MATCH),
      link: useLinkAccount(),
    }));
    await waitFor(() => {
      expect(result.current.history.data).toMatchObject({ kind: 'ready', total: 1 });
      // The seeded link has a name and no avatar.
      expect(result.current.account.data).toMatchObject({ avatarBase64: null });
    });
    const historyBefore = queryClient.getQueryData(HISTORY_KEY);

    act(() => {
      result.current.link.mutate();
    });

    await waitFor(
      () => {
        expect(result.current.link.data).toMatchObject({ kind: 'already_linked' });
        // Deadlock-api gave the avatar, and the account of the hook follows.
        expect(result.current.account.data?.avatarBase64).toEqual(expect.any(String));
      },
      { timeout: SIGN_IN_TIMEOUT_MS },
    );
    // Same account, same data: nothing was reset (a reset would replace the cached object).
    expect(queryClient.getQueryData(HISTORY_KEY)).toBe(historyBefore);
    await whenIdle(test.services.sync);
  });

  it('leaves the cached data as it is when the sign-in ends without a link', async () => {
    const { result, queryClient, signInGateway } = renderWaitingLink();
    const cached: HistoryView = { kind: 'no_account' };
    queryClient.setQueryData(HISTORY_KEY, cached);

    act(() => {
      result.current.link.mutate();
    });
    await waitFor(() => {
      expect(signInGateway.openedUrls).toHaveLength(1);
    });
    act(() => {
      result.current.cancel();
    });
    await waitFor(() => {
      expect(result.current.link.data).toEqual({ kind: 'cancelled' });
    });

    // Nothing changed, so nothing is read again: a reset would have replaced the cached object.
    expect(queryClient.getQueryData(HISTORY_KEY)).toBe(cached);
  });
});

describe('useCancelLink', () => {
  it('cancels the sign-in in progress', async () => {
    const { result, services, signInGateway } = renderWaitingLink();

    act(() => {
      result.current.link.mutate();
    });
    // The browser is open on Steam: the sign-in waits for the player, who never comes back.
    await waitFor(() => {
      expect(signInGateway.openedUrls).toHaveLength(1);
    });
    act(() => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.link.data).toEqual({ kind: 'cancelled' });
    });
    expect(signInGateway.cancelledPorts.length).toBeGreaterThan(0);
    await expect(services.account.getLinkedAccount()).resolves.toBeNull();
  });
});

describe('useUnlinkAccount', () => {
  it('clears the data of the account after an unlink', async () => {
    const test = setUp();
    await seedMatch(test);
    const { result } = renderWithServices(test.services, () => ({
      account: useLinkedAccount(),
      history: useHistory(EVERY_MATCH),
      latest: useLatestMatches(PAIGE_HERO_ID, 10),
      unlink: useUnlinkAccount(),
    }));
    await waitFor(() => {
      expect(result.current.account.data).toMatchObject({ accountId: FIXTURE_ACCOUNT_ID });
      expect(result.current.history.data).toMatchObject({ kind: 'ready', total: 1 });
      expect(result.current.latest.data).toMatchObject({ kind: 'ready', stats: { matches: 1 } });
    });

    act(() => {
      result.current.unlink.mutate();
    });

    // The queries the screens show are read again, and none of them still holds the old rows.
    await waitFor(() => {
      expect(result.current.unlink.isSuccess).toBe(true);
      expect(result.current.account.data).toBeNull();
      expect(result.current.history.data).toEqual({ kind: 'no_account' });
      expect(result.current.latest.data).toEqual({ kind: 'no_account' });
    });
    expect(result.current.unlink.data).toEqual({ complete: true });
  });

  it('forgets everything cached about the account, and only that', async () => {
    const { services } = setUp();
    const { result, queryClient } = renderWithServices(services, useUnlinkAccount);
    // No screen is mounted: these queries are cached, and nothing observes them, so the unlink can
    // only clear them. The match page and the settings are not about the account's data. The review
    // sits under the details, like the analysis of a match; the community downloads of a match and of
    // the review are under keys of their own, which the account change has to list.
    const accountKeys = [
      ACCOUNT_QUERY_KEY,
      HISTORY_KEY,
      [...MATCHES_QUERY_KEY, 'latest', PAIGE_HERO_ID, 10],
      [...SYNC_QUERY_KEY, 'status'],
      DETAILS_SUMMARY_QUERY_KEY,
      [...DETAILS_QUERY_KEY, 'match', 100000001],
      [...DETAILS_QUERY_KEY, 'analysis', 100000001],
      REVIEW_QUERY_KEY,
      [...ANALYSIS_COMMUNITY_QUERY_KEY, 100000001],
      REVIEW_COMMUNITY_QUERY_KEY,
      HEROES_QUERY_KEY,
    ];
    for (const key of accountKeys) {
      queryClient.setQueryData(key, 'old data');
    }
    queryClient.setQueryData(SETTINGS_QUERY_KEY, 'settings');

    act(() => {
      result.current.mutate();
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(accountKeys.map((key) => queryClient.getQueryData(key))).toEqual(
      accountKeys.map(() => undefined),
    );
    expect(queryClient.getQueryData(SETTINGS_QUERY_KEY)).toBe('settings');
  });

  it('clears the data even when the unlink fails: it may have gone half-way', async () => {
    const { services } = setUp();
    vi.spyOn(services.account, 'unlink').mockRejectedValue(
      new AppError('storage', 'The link cannot be cleared'),
    );
    const { result, queryClient } = renderWithServices(services, useUnlinkAccount);
    queryClient.setQueryData(HISTORY_KEY, 'old data');

    act(() => {
      result.current.mutate();
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(queryClient.getQueryData(HISTORY_KEY)).toBeUndefined();
  });
});

describe('useLatestMatches', () => {
  it('lists the latest matches of the linked account, under a key of its own', async () => {
    const test = setUp();
    await seedMatch(test);
    const { result, queryClient } = renderWithServices(test.services, () =>
      useLatestMatches(PAIGE_HERO_ID, 10),
    );

    await waitFor(() => {
      expect(result.current.data).toMatchObject({ kind: 'ready', stats: { matches: 1 } });
    });
    // Another hero or limit is another entry, and the key is under the matches': a synchronisation
    // that invalidates the matches refreshes the dashboard too.
    expect(queryClient.getQueryData([...MATCHES_QUERY_KEY, 'latest', PAIGE_HERO_ID, 10])).toBe(
      result.current.data,
    );
  });
});

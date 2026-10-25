/**
 * Tests of the review service (`ReviewService`), end to end on the development adapters: a
 * synchronisation of the synthetic history archives the matches, their projection gives the values
 * the review is made of, the community data and the catalogues come from the fixture API, and
 * everything is stored in an in-memory database with the real migrations.
 *
 * The synthetic history holds 127 matches, of which more than 40 are archived Paige matches of
 * every length from 20 to 49 minutes, and the player's current rank is Sentinel (badge 44): the
 * review compares them with the tier above, whose badges run from 51 to 56. A test that needs a
 * request to fail wraps the fixture API in a handler of its own.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
  type FixtureResponse,
} from '../adapters/dev/fixture-http-client.adapter';
import { createUnrankedPlayerRankFixture } from '../adapters/dev/fixtures/analytics.fixture';
import { FIXTURE_ITEM_CATALOGUE } from '../adapters/dev/fixtures/assets.fixture';
import { FIXTURE_HERO_CATALOGUE } from '../adapters/dev/fixtures/heroes.fixture';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { durationWindowOf, type CohortRank } from '../core/analysis/cohort';
import { REVIEW_MATCHES } from '../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import { RESISTANCE_ITEMS } from '../core/analysis/review/resistance-items';
import { ANALYTICS_RATE_LIMIT } from '../core/deadlock-api/budgets';
import { heroesRequest, itemsRequest } from '../core/deadlock-api/endpoints';
import { PAIGE_HERO_ID } from '../core/domain/hero';
import { AppError } from '../core/errors/app-error';
import { HERO_STATS_PATH } from '../test/community-test-kit';
import { createTestServices, projectArchivedMatches } from '../test/create-test-services';
import { testAccountId, testLinkedAccount, testMatchId } from '../test/test-data';
import { ApiCacheRepository } from './api-cache.repository';
import { BenchmarkService } from './benchmark.service';
import { GameAssetService } from './game-asset.service';
import { ItemBenchmarkService } from './item-benchmark.service';
import { LinkedAccountRepository } from './linked-account.repository';
import { MetricsRepository, type RecentMatch } from './metrics.repository';
import { cohortsByCoverage, refreshOutcomeOf, type ReviewCommunityRefresh } from './review.service';
import type { Review, ReviewView } from './review-view';

/** The time of the synchronisation that archives the matches (Unix ms); the history ends before. */
const START = Date.UTC(2026, 9, 22, 12, 0, 0);

/** A second, in milliseconds. */
const SECOND_MS = 1_000;

/**
 * The time a test that archives and projects the history may take, in milliseconds. It takes about
 * 2.5 s alone, and passes the 5 s of the default when the whole suite runs in parallel.
 */
const SLOW_TEST_MS = 30_000;

/** The size of the synthetic history: enough archived matches for the last 20 and the 20 before. */
const HISTORY_COUNT = 127;

/** The tracked account: the one of the synthetic history. */
const ACCOUNT = FIXTURE_ACCOUNT_ID;

/** The scope of the log lines of the review. */
const LOG_SCOPE = 'review';

/** The start of the path of every community request. */
const ANALYTICS_PREFIX = '/v1/analytics/';

/** The path of the request for the purchases of the items. */
const ITEM_STATS_PATH = '/v1/analytics/item-stats';

/**
 * The tier above the current rank of the player (Sentinel 4, badge 44, tier 4) is tier 5, whose
 * badges run from 51 to 56: the badge range every community request of the review carries.
 */
const TIER_ABOVE_BADGES = { min_average_badge: '51', max_average_badge: '56' };

/** The tier above, as the review names it. */
const TIER_ABOVE: CohortRank = { kind: 'tier', tier: 5 };

/** The cache key of the item statistics of {@link TIER_ABOVE}. */
const ITEMS_KEY = 'analytics.items.tier5';

/** The window the item statistics are asked for: matches of any length. */
const ANY_LENGTH_WINDOW_KEY = '0-7000';

/**
 * The length of the matches the test of the windows gives to the 20 matches before the last ones, in
 * seconds: 10 minutes, a match shorter than any the synthetic history holds.
 */
const SHORT_MATCH_DURATION_S = 600;

/** The window of {@link SHORT_MATCH_DURATION_S}, as `<min>-<max>`: none of the last 20 is in it. */
const SHORT_MATCH_WINDOW_KEY = '0-1199';

/** Another account, to which the link is moved in the tests of an account change. */
const OTHER_ACCOUNT = testAccountId(2_000_001);

/**
 * The fixture API: the history, the details, the catalogues, the rank and the community data.
 *
 * @returns The handler.
 */
function createApi(): FixtureHandler {
  return createFixtureApi({ now: START, matchCount: HISTORY_COUNT });
}

/**
 * Archive the matches of the synthetic history, project them, and build the services like the app
 * does, on the development adapters. No catalogue and no community data is downloaded yet: only
 * the review asks for them.
 *
 * @param handler - Answers the requests to deadlock-api; the fixture API by default.
 * @returns The services, the adapters under them, a reader of the cache, and the matches the review
 *   is made of (the last 20 and the 20 before, most recent first).
 */
async function setUp(handler: FixtureHandler = createApi()) {
  const clock = { now: START };
  const test = createTestServices({ handler, now: () => clock.now });
  await test.services.sync.syncNow('startup');
  // The synchronisation projected the matches already: this only makes sure of it.
  await projectArchivedMatches(test, { now: () => clock.now });
  const recent = await new MetricsRepository(test.database).listRecent(
    ACCOUNT,
    PROJECTION_VERSION,
    2 * REVIEW_MATCHES,
  );
  expect(recent, 'the history holds the last 20 matches and the 20 before').toHaveLength(
    2 * REVIEW_MATCHES,
  );
  return {
    ...test,
    clock,
    review: test.services.review,
    cache: new ApiCacheRepository(test.database),
    recent,
  };
}

/** Everything {@link setUp} builds. */
type TestContext = Awaited<ReturnType<typeof setUp>>;

/**
 * Unwrap the review.
 *
 * @param view - What the service answered.
 * @returns The review, or a failure of the test when the view is not `ready`.
 */
function ready(view: ReviewView): Review {
  if (view.kind !== 'ready') {
    expect.unreachable(`the review is ${view.kind}, not ready`);
  }
  return view.review;
}

/**
 * The community requests received, in order.
 *
 * @param context - What {@link setUp} built.
 * @returns The requests.
 */
function communityRequests(context: TestContext) {
  return context.http.requests.filter((request) =>
    new URL(request.url).pathname.startsWith(ANALYTICS_PREFIX),
  );
}

/**
 * The duration window a community request asks for.
 *
 * @param url - The URL of the request.
 * @returns The window as `<min>-<max>`, in seconds.
 */
function windowKeyOf(url: string): string {
  const query = new URL(url).searchParams;
  return `${query.get('min_duration_s') ?? ''}-${query.get('max_duration_s') ?? ''}`;
}

/**
 * The duration windows the sizes of the cohorts were asked for, in the order of the requests: the
 * first request of each cohort download.
 *
 * @param context - What {@link setUp} built.
 * @returns The windows.
 */
function sizedWindows(context: TestContext): string[] {
  return communityRequests(context)
    .filter((request) => new URL(request.url).pathname === HERO_STATS_PATH)
    .map((request) => windowKeyOf(request.url));
}

/**
 * The windows of the last 20 matches in the order the review should refresh them, worked out the
 * plain way: the windows that hold the most of the last matches first, the one of the more recent
 * match first between two that hold as many.
 *
 * @param recent - The matches of the review, most recent first.
 * @returns The windows as `<min>-<max>`.
 */
function expectedWindowOrder(recent: readonly RecentMatch[]): string[] {
  const counts = new Map<string, number>();
  for (const { durationS } of recent.slice(0, REVIEW_MATCHES)) {
    const { minS, maxS } = durationWindowOf(durationS);
    const key = `${String(minS)}-${String(maxS)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].toSorted(([, first], [, second]) => second - first).map(([key]) => key);
}

/**
 * The cache key of the community data of a window of the tier above.
 *
 * @param windowKey - The window as `<min>-<max>`.
 * @returns The key.
 */
function cohortKeyOf(windowKey: string): string {
  return `analytics.cohort.v2.tier5.${windowKey}`;
}

/**
 * Wrap a handler so that the requests to some urls fail as an offline app's would.
 *
 * @param down - The urls that fail. The set is read at every request, so that a test brings the
 *   network back by emptying it.
 * @param base - Answers the other requests; the fixture API by default.
 * @returns The handler.
 */
function withUrlsDown(
  down: ReadonlySet<string>,
  base: FixtureHandler = createApi(),
): FixtureHandler {
  return (request) => {
    if (down.has(request.url)) {
      throw new AppError('network', 'The request failed');
    }
    return base(request);
  };
}

/**
 * Build the services on an API whose request for the size of one window is answered with something
 * else. The window is the one at a place of the order the review refreshes them in, which is only
 * known once the matches are read: the answer is switched on afterwards, and the synchronisation
 * that archives the matches is not touched.
 *
 * @param place - The place of the window in the order of the refreshes, from 0.
 * @param answer - What answers the request for the size of that window.
 * @param base - Answers every other request; the fixture API by default.
 * @returns What {@link setUp} builds, the windows in the order of the refreshes, and the window that
 *   fails.
 */
async function setUpWithWindowAnswering(
  place: number,
  answer: () => FixtureResponse,
  base: FixtureHandler = createApi(),
) {
  const failing: { window: string | null } = { window: null };
  const context = await setUp((request) =>
    failing.window !== null &&
    new URL(request.url).pathname === HERO_STATS_PATH &&
    windowKeyOf(request.url) === failing.window
      ? answer()
      : base(request),
  );
  const windows = expectedWindowOrder(context.recent);
  failing.window = windows[place] ?? expect.unreachable('the last matches are of several lengths');
  return { ...context, windows, failing: failing.window };
}

/**
 * The lines the review wrote.
 *
 * @param context - What {@link setUp} built.
 * @returns The lines, oldest first.
 */
function reviewLines(context: TestContext) {
  return context.logger.entries.filter((entry) => entry.scope === LOG_SCOPE);
}

/**
 * Link another account, as the owner does when they switch accounts in the middle of a download.
 *
 * @param context - What {@link setUp} built.
 */
async function switchAccount(context: TestContext): Promise<void> {
  await new LinkedAccountRepository(context.database, context.logger).setLinkedAccount(
    testLinkedAccount(OTHER_ACCOUNT, { profileFetchedAt: START }),
  );
}

/**
 * A match of the last ones, reduced to what the grouping of the cohorts reads.
 *
 * @param id - The number of the match.
 * @param durationS - Its length in seconds.
 * @returns The match.
 */
function matchOf(id: number, durationS: number): RecentMatch {
  return { matchId: testMatchId(id), startTime: 1_760_000_000 - id, durationS, values: new Map() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cohortsByCoverage', () => {
  it('puts the windows that hold the most matches first', () => {
    // From the most recent match: two matches of 20 minutes, three of 25 minutes, one of 30.
    const matches = [1_300, 1_600, 1_650, 1_310, 1_660, 1_900].map((durationS, index) =>
      matchOf(index + 1, durationS),
    );

    expect(cohortsByCoverage(matches, TIER_ABOVE)).toEqual([
      { rank: TIER_ABOVE, window: { minS: 1_500, maxS: 1_799 } },
      { rank: TIER_ABOVE, window: { minS: 1_200, maxS: 1_499 } },
      { rank: TIER_ABOVE, window: { minS: 1_800, maxS: 2_099 } },
    ]);
  });

  it('puts the window of the more recent match first between two that hold as many', () => {
    // Two matches in each window; the most recent match is in the window of 25 minutes.
    const matches = [1_600, 1_300, 1_900, 1_650, 1_310, 1_910].map((durationS, index) =>
      matchOf(index + 1, durationS),
    );

    expect(cohortsByCoverage(matches, TIER_ABOVE).map(({ window }) => window.minS)).toEqual([
      1_500, 1_200, 1_800,
    ]);
  });

  it('lists a window once however many matches it holds, with the rank it was given', () => {
    const matches = [1_300, 1_310, 1_320].map((durationS, index) => matchOf(index + 1, durationS));

    expect(cohortsByCoverage(matches, { kind: 'all' })).toEqual([
      { rank: { kind: 'all' }, window: { minS: 1_200, maxS: 1_499 } },
    ]);
  });

  it('lists nothing for no match', () => {
    expect(cohortsByCoverage([], TIER_ABOVE)).toEqual([]);
  });
});

describe('refreshOutcomeOf', () => {
  it.each<{ label: string; outcomes: Parameters<typeof refreshOutcomeOf>[0]; expected: string }>([
    { label: 'nothing to refresh', outcomes: [], expected: 'fresh' },
    { label: 'everything fresh', outcomes: ['fresh', 'fresh', 'fresh'], expected: 'fresh' },
    { label: 'everything updated', outcomes: ['updated', 'updated'], expected: 'updated' },
    { label: 'some fresh and some updated', outcomes: ['fresh', 'updated'], expected: 'updated' },
    {
      label: 'everything unavailable',
      outcomes: ['unavailable', 'unavailable'],
      expected: 'unavailable',
    },
    {
      label: 'one unavailable',
      outcomes: ['updated', 'unavailable', 'updated'],
      expected: 'partial',
    },
    {
      label: 'one fresh, the others unavailable',
      outcomes: ['fresh', 'unavailable'],
      expected: 'partial',
    },
  ])('is $expected for $label', ({ outcomes, expected }) => {
    expect(refreshOutcomeOf(outcomes)).toBe(expected);
  });
});

describe('ReviewService.getReview', { timeout: SLOW_TEST_MS }, () => {
  it('answers no_account without a linked account', async () => {
    const { services, http } = createTestServices({ accountId: null });

    await expect(services.review.getReview()).resolves.toEqual({ kind: 'no_account' });

    // Nobody is linked: the app contacts nobody.
    expect(http.requests).toEqual([]);
  });

  it('answers empty before any match is analysed, and requests nothing', async () => {
    const { services, http } = createTestServices();

    await expect(services.review.getReview()).resolves.toEqual({ kind: 'empty' });

    expect(http.requests).toEqual([]);
  });

  it('answers empty before the first projection of version 3', async () => {
    const context = await setUp();
    // The projections of the synchronisation are of the version before.
    await context.database.execute(
      'UPDATE match_projections SET projection_version = $1 WHERE account_id = $2',
      [PROJECTION_VERSION - 1, ACCOUNT],
    );
    const requestsBefore = context.http.requests.length;

    await expect(context.review.getReview()).resolves.toEqual({ kind: 'empty' });

    // Nothing to review: no catalogue is downloaded either.
    expect(context.http.requests).toHaveLength(requestsBefore);
  });

  it('builds the review of the last 20 matches against the 20 before', async () => {
    const context = await setUp();
    await context.review.refreshCommunity();

    const review = ready(await context.review.getReview());

    // The windows are the first 20 matches, and the 20 after them.
    const starts = context.recent.map(({ startTime }) => startTime);
    expect(review.recent).toEqual({
      count: REVIEW_MATCHES,
      firstStartTime: Math.min(...starts.slice(0, REVIEW_MATCHES)),
      lastStartTime: Math.max(...starts.slice(0, REVIEW_MATCHES)),
    });
    expect(review.before).toEqual({
      count: REVIEW_MATCHES,
      firstStartTime: Math.min(...starts.slice(REVIEW_MATCHES)),
      lastStartTime: Math.max(...starts.slice(REVIEW_MATCHES)),
    });
    // Every one of the last matches is compared with the tier above, downloaded just before.
    expect(review.community).toMatchObject({
      kind: 'available',
      rank: TIER_ABOVE,
      comparedWith: 'tier_above',
      // The refresh stored the item statistics last: they are fresh, and nothing is due.
      itemStats: { kind: 'fresh' },
      fallbackMatches: 0,
      missingMatches: 0,
      stale: false,
    });
    // The catalogues are there: the resistance items and the damage by source are built.
    expect(review.deaths.resistance.kind).toBe('ready');
    expect(review.damage.kind).toBe('ready');
    expect(review.stats.families.length).toBeGreaterThan(0);
    expect(review.deaths.phases.length).toBeGreaterThan(0);
  });

  it('reads what is cached and sends no analytics request', async () => {
    const context = await setUp();

    const review = ready(await context.review.getReview());

    // No community data was downloaded yet (the catalogues were, as they are not cached either):
    // the review is there, with no comparison with the tier above.
    expect(review.community).toEqual({
      kind: 'missing',
      rank: TIER_ABOVE,
      comparedWith: 'tier_above',
      // The item catalogue was just downloaded and names the resistance items, whose statistics are
      // not cached either.
      itemStats: { kind: 'missing' },
    });
    expect(review.recent.count).toBe(REVIEW_MATCHES);
    expect(communityRequests(context)).toEqual([]);
  });

  it('compares with every rank when the account has none', async () => {
    const fixtureApi = createApi();
    const context = await setUp((request) =>
      /\/v1\/players\/\d+\/rank$/.test(request.url)
        ? jsonResponse(createUnrankedPlayerRankFixture())
        : fixtureApi(request),
    );

    await expect(context.review.refreshCommunity()).resolves.toBe('updated');
    const review = ready(await context.review.getReview());

    expect(review.community).toMatchObject({
      kind: 'available',
      rank: { kind: 'all' },
      comparedWith: 'every_rank',
    });
    // No badge range: every rank is asked for.
    for (const request of communityRequests(context)) {
      expect(new URL(request.url).searchParams.has('min_average_badge'), request.url).toBe(false);
    }
    await expect(context.cache.get('analytics.items.all')).resolves.not.toBeNull();
  });

  it('compares a player of the highest tier with their own tier, and says so', async () => {
    const fixtureApi = createApi();
    // Eternus 6: the highest badge, in the highest tier (11), which has no tier above.
    const context = await setUp((request) =>
      /\/v1\/players\/\d+\/rank$/.test(request.url)
        ? jsonResponse({ badge: 116, rank: 11, subrank: 6, last_match: null })
        : fixtureApi(request),
    );

    // Before any download, and once the data of the tier is in the cache: the relation is the same.
    expect(ready(await context.review.getReview()).community).toEqual({
      kind: 'missing',
      rank: { kind: 'tier', tier: 11 },
      comparedWith: 'own_tier',
      itemStats: { kind: 'missing' },
    });
    await expect(context.review.refreshCommunity()).resolves.toBe('updated');
    const review = ready(await context.review.getReview());

    expect(review.community).toMatchObject({
      kind: 'available',
      rank: { kind: 'tier', tier: 11 },
      comparedWith: 'own_tier',
    });
    // The whole tier is asked for: badges 111 to 116.
    for (const request of communityRequests(context)) {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      expect(query, request.url).toMatchObject({
        min_average_badge: '111',
        max_average_badge: '116',
      });
    }
  });

  it('answers the catalogue sections unavailable when the item catalogue is unavailable', async () => {
    const down = new Set([itemsRequest().url]);
    const context = await setUp(withUrlsDown(down));

    const review = ready(await context.review.getReview());

    // The review is built all the same: only what needs the catalogue says so.
    expect(review.deaths.resistance).toEqual({ kind: 'catalogue_unavailable' });
    expect(review.damage).toEqual({ kind: 'catalogue_unavailable' });
    expect(review.stats.families.length).toBeGreaterThan(0);
    expect(review.players.places.length).toBeGreaterThan(0);
    // One line for the call, at `info`: a catalogue that is out of reach is no fault of the app.
    expect(reviewLines(context)).toEqual([
      {
        level: 'info',
        scope: LOG_SCOPE,
        message: 'Review catalogues unavailable',
        context: expect.objectContaining({
          kind: 'network',
          itemsUnavailable: true,
          loadoutUnavailable: false,
        }) as unknown,
      },
    ]);
    expect(JSON.stringify(context.logger.entries)).not.toContain(String(ACCOUNT));

    // The state is not kept: once the catalogue can be read again, so are the sections. The budget
    // of the catalogue requests (two a second) was spent by the first call.
    down.clear();
    context.clock.now += SECOND_MS;
    expect(ready(await context.review.getReview()).deaths.resistance.kind).toBe('ready');
  });

  it('answers the damage section unavailable when the hero catalogue cannot be read', async () => {
    const context = await setUp(withUrlsDown(new Set([heroesRequest().url])));

    const review = ready(await context.review.getReview());

    // The loadout classifies the damage; the resistance items only need the item catalogue.
    expect(review.damage).toEqual({ kind: 'catalogue_unavailable' });
    expect(review.deaths.resistance.kind).toBe('ready');
    expect(reviewLines(context)).toEqual([
      {
        level: 'info',
        scope: LOG_SCOPE,
        message: 'Review catalogues unavailable',
        context: expect.objectContaining({
          kind: 'network',
          itemsUnavailable: false,
          loadoutUnavailable: true,
        }) as unknown,
      },
    ]);
  });

  it('answers the damage section unavailable when the hero catalogue gives Paige no loadout', async () => {
    const fixtureApi = createApi();
    // Paige's ultimate is missing: a partial loadout would classify the sources wrongly.
    const heroes = FIXTURE_HERO_CATALOGUE.map((hero) =>
      hero.id === PAIGE_HERO_ID ? { ...hero, items: { ...hero.items, signature4: null } } : hero,
    );
    const context = await setUp((request) =>
      request.url === heroesRequest().url ? jsonResponse(heroes) : fixtureApi(request),
    );

    const review = ready(await context.review.getReview());

    expect(review.damage).toEqual({ kind: 'catalogue_unavailable' });
    expect(review.deaths.resistance.kind).toBe('ready');
    expect(reviewLines(context)).toEqual([
      {
        level: 'info',
        scope: LOG_SCOPE,
        message: 'Review catalogues unavailable',
        context: { itemsUnavailable: false, loadoutUnavailable: true },
      },
    ]);
  });
});

describe('ReviewService.refreshCommunity', { timeout: SLOW_TEST_MS }, () => {
  it('answers fresh without a linked account, and requests nothing', async () => {
    const { services, http } = createTestServices({ accountId: null });

    await expect(services.review.refreshCommunity()).resolves.toBe('fresh');

    expect(http.requests).toEqual([]);
  });

  it('answers fresh before any match is analysed, and requests nothing', async () => {
    const { services, http } = createTestServices();

    await expect(services.review.refreshCommunity()).resolves.toBe('fresh');

    expect(http.requests).toEqual([]);
  });

  it('asks the tier above for each window of the last 20', async () => {
    const context = await setUp();
    // The 20 matches before the last ones are all short, in a window none of the last 20 is in: a
    // review that took its cohorts from all 40 matches would ask for it.
    const earlier = context.recent.slice(REVIEW_MATCHES);
    await context.database.execute(
      `UPDATE matches SET duration_s = $1 WHERE account_id = $2 AND match_id IN (${earlier
        .map((_, place) => `$${String(place + 3)}`)
        .join(', ')})`,
      [SHORT_MATCH_DURATION_S, ACCOUNT, ...earlier.map(({ matchId }) => matchId)],
    );
    expect(durationWindowOf(SHORT_MATCH_DURATION_S)).toEqual({ minS: 0, maxS: 1_199 });

    await expect(context.review.refreshCommunity()).resolves.toBe('updated');

    const requests = communityRequests(context);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      expect(query, request.url).toMatchObject(TIER_ABOVE_BADGES);
      // Community requests carry no account (the id is never printed: only whether it is there).
      expect(request.url.includes(String(ACCOUNT)), 'a community request carries the account').toBe(
        false,
      );
    }
    // The window of each of the last 20 matches is asked for, and no other: the sizes of the
    // cohorts are the first request of each, then comes the one of the item statistics.
    const windows = expectedWindowOrder(context.recent);
    expect(windows.length, 'the last matches are of several lengths').toBeGreaterThan(1);
    expect(windows, 'the last matches are not in the short window').not.toContain(
      SHORT_MATCH_WINDOW_KEY,
    );
    expect(sizedWindows(context)).toEqual([...windows, ANY_LENGTH_WINDOW_KEY]);
    // The 20 matches before are not asked for: not a request for their window, not an entry.
    expect(requests.map(({ url }) => windowKeyOf(url))).not.toContain(SHORT_MATCH_WINDOW_KEY);
    for (const window of windows) {
      await expect(context.cache.get(cohortKeyOf(window)), window).resolves.not.toBeNull();
    }
    await expect(context.cache.get(cohortKeyOf(SHORT_MATCH_WINDOW_KEY))).resolves.toBeNull();
  });

  it('refreshes the windows one after the other, then the item stats, within the budget', async () => {
    const context = await setUp();

    await context.review.refreshCommunity();

    // Three requests for each window, in order (the size, the benchmark, the curve), then the two
    // of the item statistics (the size of the tier, the purchases).
    const windows = expectedWindowOrder(context.recent);
    const paths = communityRequests(context).map((request) => new URL(request.url).pathname);
    expect(paths).toEqual([
      ...windows.flatMap(() => [
        HERO_STATS_PATH,
        '/v1/analytics/player-stats/metrics',
        '/v1/analytics/player-performance-curve',
      ]),
      HERO_STATS_PATH,
      ITEM_STATS_PATH,
    ]);
    // One opening of the review fits the budget of a minute.
    expect(paths.length).toBeLessThanOrEqual(ANALYTICS_RATE_LIMIT.limit);
  });

  it('downloads the item stats once', async () => {
    const context = await setUp();

    await expect(context.review.refreshCommunity()).resolves.toBe('updated');
    const requestsAfterFirst = communityRequests(context).length;
    await expect(context.review.refreshCommunity()).resolves.toBe('fresh');

    const itemRequests = communityRequests(context).filter(
      (request) => new URL(request.url).pathname === ITEM_STATS_PATH,
    );
    expect(itemRequests).toHaveLength(1);
    // The twelve resistance items of the catalogue are asked for in one request, and stored.
    await expect(context.cache.get(ITEMS_KEY)).resolves.not.toBeNull();
    // Everything is cached for a day: the second refresh sends nothing.
    expect(communityRequests(context)).toHaveLength(requestsAfterFirst);
  });

  it('answers partial when one window could not be downloaded', async () => {
    // The second window to be refreshed answers an error; the others are not touched.
    const context = await setUpWithWindowAnswering(1, () => jsonResponse({}, 500));

    await expect(context.review.refreshCommunity()).resolves.toBe('partial');

    // Only that window is missing: the others and the item statistics were downloaded.
    for (const window of context.windows) {
      const cached = await context.cache.get(cohortKeyOf(window));
      expect(cached === null, window).toBe(window === context.failing);
    }
    await expect(context.cache.get(ITEMS_KEY)).resolves.not.toBeNull();
    // The review is built from what could be downloaded, and counts the matches left out.
    const { community } = ready(await context.review.getReview());
    if (community.kind !== 'available') {
      expect.unreachable('some of the windows were downloaded');
    }
    expect(community.missingMatches).toBeGreaterThan(0);
    expect(community.missingMatches).toBeLessThan(REVIEW_MATCHES);
  });

  it('answers partial when deadlock-api asks for a pause after some windows', async () => {
    // The second window to be refreshed answers 503: deadlock-api asks every request to wait.
    const context = await setUpWithWindowAnswering(1, () =>
      jsonResponse({}, 503, { 'retry-after': '120' }),
    );

    await expect(context.review.refreshCommunity()).resolves.toBe('partial');

    // The windows are refreshed in order: the first was downloaded, the pause stopped the others
    // and the item statistics.
    const cached = await Promise.all(
      context.windows.map((window) => context.cache.get(cohortKeyOf(window))),
    );
    expect(cached.map((entry) => entry !== null)).toEqual(
      context.windows.map((_, place) => place === 0),
    );
    await expect(context.cache.get(ITEMS_KEY)).resolves.toBeNull();
  });

  it('answers unavailable when nothing could be downloaded', async () => {
    const fixtureApi = createApi();
    const context = await setUp((request) =>
      new URL(request.url).pathname.startsWith(ANALYTICS_PREFIX)
        ? jsonResponse({}, 500)
        : fixtureApi(request),
    );

    const outcome: ReviewCommunityRefresh = await context.review.refreshCommunity();

    expect(outcome).toBe('unavailable');
    // The review is still there, with no comparison with the tier above.
    expect(ready(await context.review.getReview()).community.kind).toBe('missing');
  });

  it('skips the item stats without the item catalogue', async () => {
    const context = await setUp(withUrlsDown(new Set([itemsRequest().url])));

    // The windows are downloaded, and nothing is said of the items that could not be asked for.
    await expect(context.review.refreshCommunity()).resolves.toBe('updated');

    expect(
      communityRequests(context).some(
        (request) => new URL(request.url).pathname === ITEM_STATS_PATH,
      ),
    ).toBe(false);
    await expect(context.cache.get(ITEMS_KEY)).resolves.toBeNull();
    // One line for the call, as for the view.
    expect(reviewLines(context)).toHaveLength(1);
  });

  it('does not read the hero catalogue, so its failure is not logged by a refresh', async () => {
    const context = await setUp(withUrlsDown(new Set([heroesRequest().url])));

    // Only the item catalogue is needed to ask for the item statistics.
    await expect(context.review.refreshCommunity()).resolves.toBe('updated');

    expect(context.http.requests.some(({ url }) => url === heroesRequest().url)).toBe(false);
    expect(reviewLines(context)).toEqual([]);
    await expect(context.cache.get(ITEMS_KEY)).resolves.not.toBeNull();
  });

  it('leaves the item stats out when the item catalogue knows none of the resistance items', async () => {
    const fixtureApi = createApi();
    // A catalogue that reads fine, but a game patch renamed all twelve items.
    const resistanceClassNames = new Set(RESISTANCE_ITEMS.map(({ className }) => className));
    const catalogue = FIXTURE_ITEM_CATALOGUE.filter(
      ({ class_name: className }) => !resistanceClassNames.has(className),
    );
    expect(catalogue.length).toBeLessThan(FIXTURE_ITEM_CATALOGUE.length);
    const context = await setUp((request) =>
      request.url === itemsRequest().url ? jsonResponse(catalogue) : fixtureApi(request),
    );
    const read = vi.spyOn(ItemBenchmarkService.prototype, 'read');
    const refresh = vi.spyOn(ItemBenchmarkService.prototype, 'refresh');

    // The outcome counts the cohorts only: updated, then fresh, as if the items were not there.
    await expect(context.review.refreshCommunity()).resolves.toBe('updated');
    await expect(context.review.refreshCommunity()).resolves.toBe('fresh');
    const review = ready(await context.review.getReview());

    // Nothing is asked for, read or stored for items nobody can name.
    expect(refresh).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(sizedWindows(context)).toEqual(expectedWindowOrder(context.recent));
    await expect(context.cache.get(ITEMS_KEY)).resolves.toBeNull();
    // A catalogue that reads is not unavailable: the rows of the twelve items are there, unnamed.
    expect(reviewLines(context)).toEqual([]);
    if (review.deaths.resistance.kind !== 'ready') {
      expect.unreachable('the item catalogue was read');
    }
    const { items } = review.deaths.resistance.value;
    expect(items).toHaveLength(RESISTANCE_ITEMS.length);
    expect(items.every(({ item }) => item.itemId === null)).toBe(true);
  });

  it('stops after the cohort in progress when the account changes', async () => {
    const context = await setUp();
    const windows = expectedWindowOrder(context.recent);
    // The owner switches account as soon as the first cohort is downloaded and stored.
    const original = Reflect.get(BenchmarkService.prototype, 'refresh');
    const cohortRefresh = vi
      .spyOn(BenchmarkService.prototype, 'refresh')
      .mockImplementation(async function (this: BenchmarkService, accountId, cohort) {
        const outcome = await original.call(this, accountId, cohort);
        await switchAccount(context);
        return outcome;
      });
    const itemRefresh = vi.spyOn(ItemBenchmarkService.prototype, 'refresh');

    // The first cohort was refreshed, the rest was not: the outcome is partial.
    await expect(context.review.refreshCommunity()).resolves.toBe('partial');

    // The budget of the minute is not spent for an account that is gone: three requests, the ones
    // of the first cohort, and nothing for the other cohorts or the item statistics.
    expect(cohortRefresh).toHaveBeenCalledTimes(1);
    expect(itemRefresh).not.toHaveBeenCalled();
    expect(communityRequests(context)).toHaveLength(3);
    expect(sizedWindows(context)).toEqual(windows.slice(0, 1));
    // What was downloaded for the linked account stays: it is data of the community.
    const cached = await Promise.all(
      windows.map((window) => context.cache.get(cohortKeyOf(window))),
    );
    expect(cached.map((entry) => entry !== null)).toEqual(windows.map((_, place) => place === 0));
  });

  it('downloads nothing when the account changes before the first download', async () => {
    const context = await setUp();
    // The owner switches account while the item catalogue is read, before any download.
    const original = Reflect.get(GameAssetService.prototype, 'getItemCatalogue');
    vi.spyOn(GameAssetService.prototype, 'getItemCatalogue').mockImplementation(async function (
      this: GameAssetService,
    ) {
      const catalogue = await original.call(this);
      await switchAccount(context);
      return catalogue;
    });

    // Nothing was refreshed, and what was left to do could not be: unavailable.
    await expect(context.review.refreshCommunity()).resolves.toBe('unavailable');

    expect(communityRequests(context)).toEqual([]);
  });
});

describe('ReviewService', { timeout: SLOW_TEST_MS }, () => {
  it('never logs an account id', async () => {
    // Everything that can go wrong at once: a catalogue that is out of reach, and a window that
    // fails (the first one to be refreshed).
    const context = await setUpWithWindowAnswering(
      0,
      () => jsonResponse({}, 500),
      withUrlsDown(new Set([itemsRequest().url])),
    );

    await context.review.refreshCommunity();
    await context.review.getReview();

    // The run wrote lines of the review, of the community data and of deadlock-api, and none holds
    // the account.
    const scopes = new Set(context.logger.entries.map((entry) => entry.scope));
    expect([...scopes]).toEqual(expect.arrayContaining([LOG_SCOPE, 'community', 'api']));
    expect(JSON.stringify(context.logger.entries)).not.toContain(String(ACCOUNT));
  });
});

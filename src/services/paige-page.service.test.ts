/**
 * Tests of the service of the Paige page: the download of her entries, the cache by language and
 * the account rule.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_PAIGE_HERO } from '../adapters/dev/fixtures/paige.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import type { AccountId } from '../core/domain/account';
import { AppError } from '../core/errors/app-error';
import type { AccountSource } from '../ports/account-source.port';
import { createTestDatabase, testAccountId } from '../test/test-data';
import { ApiCacheRepository } from './api-cache.repository';
import { DeadlockApiService } from './deadlock-api.service';
import { PaigePageService } from './paige-page.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 10, 2, 12, 0, 0);
const DAY = 24 * 60 * 60_000;
const ACCOUNT_ID = testAccountId(1000001);

/**
 * A Paige page service on the fixture API, with a clock that moves while the API waits for its
 * budget, an account link the test sets, and an answer the test may replace.
 */
function setUp() {
  const clock = { now: START };
  const fixtures = createFixtureApi({ now: START });
  const answer: { handler: FixtureHandler } = { handler: fixtures };
  const link: { accountId: AccountId | null } = { accountId: ACCOUNT_ID };
  const accountSource: AccountSource = {
    currentAccountId: () => Promise.resolve(link.accountId),
  };
  const http = new FixtureHttpClient((request) => answer.handler(request));
  const logger = new MemoryLogger();
  const database = createTestDatabase();
  const now = () => clock.now;
  const api = new DeadlockApiService(http, new SyncStateRepository(database, logger, now), logger, {
    appVersion: '0.1.0',
    now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const cache = new ApiCacheRepository(database);
  const paige = new PaigePageService({ accountSource, api, cache, logger, now });
  /** The service of a new launch of the app, on the same database: the app makes it at startup. */
  const relaunch = () => new PaigePageService({ accountSource, api, cache, logger, now });
  return { paige, relaunch, http, clock, answer, fixtures, link, logger };
}

describe('PaigePageService.getPaigePage', () => {
  it('downloads the page even while no account is linked: it does not depend on the account', async () => {
    const { paige, http, link } = setUp();
    link.accountId = null;

    const page = await paige.getPaigePage('en');

    expect(page?.hero.tags[0]).toBe('Helpful');
    expect(http.requests).toHaveLength(6);
  });

  it('downloads the English page: the hero, the weapon and the four abilities once', async () => {
    const { paige, http } = setUp();

    const page = await paige.getPaigePage('en');

    expect(http.requests).toHaveLength(6);
    expect(page?.hero.tags).toEqual(['Helpful', 'Protector', 'Booksmart']);
    expect(page?.stats.vitality[0]).toMatchObject({ key: 'health', value: 625, perLevel: 33 });
    expect(page?.abilities.map((ability) => ability.english.name)).toEqual([
      'Bookwyrm',
      'Plot Armor',
      'Captivating Read',
      'Rallying Charge',
    ]);
    // In English, the localised entry is the English one: nothing is downloaded twice.
    expect(page?.abilities[0]?.localised).toEqual(page?.abilities[0]?.english);
  });

  it('downloads the French page with the abilities in both languages', async () => {
    const { paige, http } = setUp();

    const page = await paige.getPaigePage('fr');

    expect(http.requests).toHaveLength(10);
    expect(page?.hero.tags[0]).toBe('Utile');
    expect(page?.abilities[0]?.english.name).toBe('Bookwyrm');
    expect(page?.abilities[0]?.localised.properties.Damage?.label).toBe('Dégâts');
  });

  it('gives the page kept in the cache at once, however old', async () => {
    const { paige, relaunch, http, clock } = setUp();
    await paige.getPaigePage('en');
    clock.now += 30 * DAY;

    await paige.getPaigePage('en');
    await relaunch().getPaigePage('en');

    expect(http.requests).toHaveLength(6);
  });

  it('fails when one entry cannot be downloaded and nothing is cached', async () => {
    const { paige, answer, fixtures } = setUp();
    answer.handler = (request) =>
      request.url.includes('ability_bookworm_aoemagic')
        ? jsonResponse({ error: 'boom' }, 500)
        : fixtures(request);

    await expect(paige.getPaigePage('en')).rejects.toBeInstanceOf(AppError);
  });

  it('keeps the cached page when the download of a launch fails', async () => {
    const { paige, relaunch, answer, clock, logger } = setUp();
    await paige.getPaigePage('en');
    clock.now += DAY;
    answer.handler = () => jsonResponse({ error: 'boom' }, 500);

    const page = await relaunch().refreshPaigePage('en');

    expect(page?.hero.tags[0]).toBe('Helpful');
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toMatchObject([
      { scope: 'paige', message: 'Could not refresh the Paige page, using the cached one' },
    ]);
  });

  it('keeps each language apart: French is downloaded even when English is cached', async () => {
    const { paige, http } = setUp();
    await paige.getPaigePage('en');

    const page = await paige.getPaigePage('fr');

    expect(http.requests).toHaveLength(16);
    expect(page?.hero.tags[0]).toBe('Utile');
  });

  it('downloads the page again once per launch of the app, not more', async () => {
    const { paige, relaunch, http, clock, answer, fixtures } = setUp();
    await paige.getPaigePage('en');
    // The page downloaded because none was kept is of this launch already.
    await paige.refreshPaigePage('en');
    expect(http.requests).toHaveLength(6);

    // A game patch, then a new launch the next day: the kept page shows first, then the new one is
    // downloaded once, however often the page asks.
    const patched = structuredClone(FIXTURE_PAIGE_HERO.english) as {
      starting_stats: { max_health: { value: number } };
    };
    patched.starting_stats.max_health.value = 700;
    answer.handler = (request) =>
      request.url.includes('/v1/assets/heroes/67') ? jsonResponse(patched) : fixtures(request);
    clock.now += DAY;
    const launch = relaunch();
    const kept = await launch.getPaigePage('en');
    const fresh = await launch.refreshPaigePage('en');
    await launch.refreshPaigePage('en');
    await launch.getPaigePage('en');

    expect(kept?.stats.vitality[0]).toMatchObject({ key: 'health', value: 625 });
    expect(fresh?.stats.vitality[0]).toMatchObject({ key: 'health', value: 700 });
    expect(http.requests).toHaveLength(12);
  });

  it('reads the cache without an account once a page was downloaded', async () => {
    const { paige, http, link } = setUp();
    await paige.getPaigePage('fr');
    link.accountId = null;

    const page = await paige.getPaigePage('fr');

    expect(page?.hero.tags[0]).toBe('Utile');
    expect(http.requests).toHaveLength(10);
  });
});

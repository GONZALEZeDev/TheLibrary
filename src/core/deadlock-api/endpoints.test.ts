/**
 * Tests of the deadlock-api endpoint descriptors and request rules.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testAccountId, testMatchId } from '../../test/test-data';
import { parseAccountId } from '../domain/account';
import { PAIGE_HERO_ID } from '../domain/hero';
import {
  heroSampleRequest,
  heroesRequest,
  matchHistoryRequest,
  matchMetadataRequest,
  metricBenchmarkRequest,
  performanceCurveRequest,
  playerRankRequest,
  redactAccountIds,
  steamProfileRequest,
  userAgent,
  type CohortQuery,
} from './endpoints';

/** An account id for the tests. */
const ACCOUNT_ID = parseAccountId(123456789) ?? expect.unreachable();

/**
 * A community cohort query: Paige, since a UTC midnight, matches of 25 to 30 minutes, without a
 * badge range (all ranks).
 */
const ALL_RANKS_COHORT: CohortQuery = {
  heroId: PAIGE_HERO_ID,
  sinceUnixS: 1_789_862_400,
  minDurationS: 1500,
  maxDurationS: 1799,
  badge: null,
};

/** The same cohort restricted to tier 4 (Sentinel): badges 41 to 46. */
const TIER_4_COHORT: CohortQuery = { ...ALL_RANKS_COHORT, badge: { min: 41, max: 46 } };

/** The parameters every cohort URL shares after its hero and curve parameters. */
const WINDOW_PARAMS = 'min_unix_timestamp=1789862400&min_duration_s=1500&max_duration_s=1799';

/** The badge parameters appended to a cohort URL of the tier 4. */
const TIER_4_PARAMS = '&min_average_badge=41&max_average_badge=46';

describe('matchHistoryRequest', () => {
  it('requests the full history without forcing a Steam refresh', () => {
    const request = matchHistoryRequest(ACCOUNT_ID);

    expect(request.url).toBe('https://api.deadlock-api.com/v1/players/123456789/match-history');
    expect(request.url).not.toContain('force_refetch');
    expect(request.family).toBe('history');
  });

  it('describes itself by a template that contains no account id', () => {
    expect(matchHistoryRequest(ACCOUNT_ID).endpoint).toBe('/v1/players/{account_id}/match-history');
  });
});

describe('heroesRequest', () => {
  it('requests the active heroes in English', () => {
    const request = heroesRequest();

    expect(request.url).toBe(
      'https://api.deadlock-api.com/v1/assets/heroes?language=english&only_active=true',
    );
    expect(request.endpoint).toBe('/v1/assets/heroes');
    expect(request.family).toBe('assets');
  });
});

describe('matchMetadataRequest', () => {
  it('asks for a match detail without the Steam fallback', () => {
    const request = matchMetadataRequest(testMatchId(100000001));

    expect(request).toEqual({
      url: 'https://api.deadlock-api.com/v1/matches/100000001/metadata?disable_steam=true',
      endpoint: '/v1/matches/{match_id}/metadata',
      family: 'metadata',
    });
  });
});

describe('steamProfileRequest', () => {
  it('asks for the Steam profile of one account', () => {
    expect(steamProfileRequest(ACCOUNT_ID, false)).toEqual({
      url: 'https://api.deadlock-api.com/v1/players/steam?account_ids=123456789',
      endpoint: '/v1/players/steam',
      family: 'profile',
    });
    expect(steamProfileRequest(ACCOUNT_ID, true)).toEqual({
      url: 'https://api.deadlock-api.com/v1/players/steam?account_ids=123456789&refresh=true',
      endpoint: '/v1/players/steam',
      family: 'profile',
    });
  });

  it('never logs the account id of a profile request', () => {
    // The endpoint template is what the logs carry; the URL only reaches a log through an error
    // message, which goes through `redactAccountIds` first.
    for (const refresh of [false, true]) {
      const request = steamProfileRequest(ACCOUNT_ID, refresh);

      expect(request.endpoint).not.toContain(String(ACCOUNT_ID));
      expect(redactAccountIds(request.url)).not.toContain(String(ACCOUNT_ID));
    }
  });
});

describe('metricBenchmarkRequest', () => {
  it('asks for the metric distribution of a hero over a duration window, all ranks', () => {
    expect(metricBenchmarkRequest(ALL_RANKS_COHORT)).toEqual({
      url: `https://api.deadlock-api.com/v1/analytics/player-stats/metrics?hero_ids=67&game_mode=normal&${WINDOW_PARAMS}`,
      endpoint: '/v1/analytics/player-stats/metrics',
      family: 'analytics',
    });
  });

  it('appends the badge range of a rank tier after the duration window', () => {
    expect(metricBenchmarkRequest(TIER_4_COHORT).url).toBe(
      `https://api.deadlock-api.com/v1/analytics/player-stats/metrics?hero_ids=67&game_mode=normal&${WINDOW_PARAMS}${TIER_4_PARAMS}`,
    );
  });
});

describe('performanceCurveRequest', () => {
  it('asks for the curves in absolute game times, all ranks', () => {
    expect(performanceCurveRequest(ALL_RANKS_COHORT)).toEqual({
      url: `https://api.deadlock-api.com/v1/analytics/player-performance-curve?hero_ids=67&game_mode=normal&resolution=0&${WINDOW_PARAMS}`,
      endpoint: '/v1/analytics/player-performance-curve',
      family: 'analytics',
    });
  });

  it('appends the badge range of a rank tier after the duration window', () => {
    expect(performanceCurveRequest(TIER_4_COHORT).url).toBe(
      `https://api.deadlock-api.com/v1/analytics/player-performance-curve?hero_ids=67&game_mode=normal&resolution=0&${WINDOW_PARAMS}${TIER_4_PARAMS}`,
    );
  });
});

describe('heroSampleRequest', () => {
  it('asks for the per-hero sample without any hero filter, all ranks', () => {
    const request = heroSampleRequest(ALL_RANKS_COHORT);

    expect(request).toEqual({
      url: `https://api.deadlock-api.com/v1/analytics/hero-stats?game_mode=normal&${WINDOW_PARAMS}`,
      endpoint: '/v1/analytics/hero-stats',
      family: 'analytics',
    });
    expect(request.url).not.toContain('hero_id');
  });

  it('appends the badge range of a rank tier after the duration window', () => {
    expect(heroSampleRequest(TIER_4_COHORT).url).toBe(
      `https://api.deadlock-api.com/v1/analytics/hero-stats?game_mode=normal&${WINDOW_PARAMS}${TIER_4_PARAMS}`,
    );
  });
});

describe('cohort requests', () => {
  it('carry a hero, a date, a duration window and a badge range, nothing else', () => {
    // Community requests are anonymous: no account id, no match id, no player data.
    const allowed = new Set([
      'hero_ids',
      'game_mode',
      'resolution',
      'min_unix_timestamp',
      'min_duration_s',
      'max_duration_s',
      'min_average_badge',
      'max_average_badge',
    ]);

    for (const request of [
      metricBenchmarkRequest(TIER_4_COHORT),
      performanceCurveRequest(TIER_4_COHORT),
      heroSampleRequest(TIER_4_COHORT),
    ]) {
      const names = [...new URL(request.url).searchParams.keys()];

      expect(names.filter((name) => !allowed.has(name))).toEqual([]);
      // The path holds no identifier: it is its own logged template.
      expect(new URL(request.url).pathname).toBe(request.endpoint);
    }
  });
});

describe('playerRankRequest', () => {
  it('asks for the rank of one account', () => {
    expect(playerRankRequest(testAccountId(1000001))).toEqual({
      url: 'https://api.deadlock-api.com/v1/players/1000001/rank',
      endpoint: '/v1/players/{account_id}/rank',
      family: 'rank',
    });
  });

  it('never logs the account id of a rank request', () => {
    const accountId = testAccountId(1000001);
    const request = playerRankRequest(accountId);

    expect(request.endpoint).not.toContain(String(accountId));
    expect(redactAccountIds(request.url)).toBe(
      'https://api.deadlock-api.com/v1/players/{account_id}/rank',
    );
  });
});

describe('userAgent', () => {
  it('names the app, its version and its repository', () => {
    expect(userAgent('0.1.0')).toBe(
      'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
    );
  });
});

describe('redactAccountIds', () => {
  it('replaces the account id of a player path', () => {
    expect(
      redactAccountIds(
        'error sending request for url (https://api.deadlock-api.com/v1/players/123456789/match-history)',
      ),
    ).toBe(
      'error sending request for url (https://api.deadlock-api.com/v1/players/{account_id}/match-history)',
    );
  });

  it('replaces account ids passed as query parameters', () => {
    expect(redactAccountIds('/v1/players/steam?account_ids=12,34&x=1')).toBe(
      '/v1/players/steam?account_ids={account_id}&x=1',
    );
    expect(redactAccountIds('?account_id=42')).toBe('?account_id={account_id}');
  });

  it('leaves other numbers alone', () => {
    expect(redactAccountIds('/v1/matches/123/metadata timed out after 15000 ms')).toBe(
      '/v1/matches/123/metadata timed out after 15000 ms',
    );
  });
});

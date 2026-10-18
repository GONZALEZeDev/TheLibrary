/**
 * Tests of the deadlock-api endpoint descriptors and request rules.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchId } from '../../test/test-data';
import { parseAccountId } from '../domain/account';
import {
  heroesRequest,
  matchHistoryRequest,
  matchMetadataRequest,
  redactAccountIds,
  steamProfileRequest,
  userAgent,
} from './endpoints';

/** An account id for the tests. */
const ACCOUNT_ID = parseAccountId(123456789) ?? expect.unreachable();

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

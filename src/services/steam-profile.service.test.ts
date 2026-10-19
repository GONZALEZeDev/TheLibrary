/**
 * Tests of the Steam profile service, with the fixture API (deadlock-api and Steam's avatar CDN), a
 * fake clock and an in-memory database.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureHandler,
  type FixtureRequest,
  type FixtureResponse,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import {
  FIXTURE_AVATAR_HASH,
  FIXTURE_AVATAR_JPEG,
  FIXTURE_PERSONA_NAME,
} from '../adapters/dev/fixtures/steam.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { bytesToBase64, MAX_AVATAR_BYTES } from '../core/account/linked-account';
import { AppError } from '../core/errors/app-error';
import { createTestDatabase, testAccountId } from '../test/test-data';
import { DeadlockApiService } from './deadlock-api.service';
import { SteamProfileService, NO_PROFILE, type ProfileSnapshot } from './steam-profile.service';
import { SyncStateRepository } from './sync-state.repository';

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** An account the fixture API knows nothing about: deadlock-api answers it an empty list. */
const UNKNOWN_ACCOUNT_ID = testAccountId(2_000_001);

const AVATAR_URL = `https://avatars.steamstatic.com/${FIXTURE_AVATAR_HASH}_medium.jpg`;

/** A profile stored earlier, for the tests that must not lose it. */
const STORED_PROFILE: ProfileSnapshot = {
  personaName: 'Stored Player',
  avatarBase64: bytesToBase64(Uint8Array.of(1, 2, 3)),
  avatarHash: 'cd'.repeat(20),
  profileFetchedAt: START - 2 * DAY,
};

/**
 * Build the service on the given handler, with a controllable clock.
 *
 * @param handler - Answers the requests of deadlock-api and of the avatar CDN; the fixture API by
 *   default.
 * @returns The service, the deadlock-api service under it, the HTTP client, the logger, the clock
 *   and the synchronisation state (where the pause of deadlock-api is kept).
 */
function setUp(handler: FixtureHandler = createFixtureApi({ now: START, matchCount: 1 })) {
  const clock = { now: START };
  const now = (): number => clock.now;
  const http = new FixtureHttpClient(handler);
  const logger = new MemoryLogger();
  const syncState = new SyncStateRepository(createTestDatabase(), logger, now);
  const api = new DeadlockApiService(http, syncState, logger, { appVersion: '0.1.0', now });
  const service = new SteamProfileService({ api, http, logger, appVersion: '0.1.0', now });
  return { service, api, http, logger, clock, syncState };
}

/**
 * Build a handler that answers like the fixture API, except for the requests `override` takes.
 *
 * @param override - Answers a request, or returns `undefined` to leave it to the fixture API.
 * @returns The handler.
 */
function withOverride(
  override: (request: FixtureRequest) => FixtureResponse | undefined,
): FixtureHandler {
  const fixtureApi = createFixtureApi({ now: START, matchCount: 1 });
  return (request) => override(request) ?? fixtureApi(request);
}

/** Tell whether a request asks deadlock-api for a Steam profile. */
function isProfileRequest(request: FixtureRequest): boolean {
  return request.url.includes('/v1/players/steam?');
}

/** Tell whether a request goes to Steam's avatar CDN. */
function isAvatarRequest(request: FixtureRequest): boolean {
  return request.url.startsWith('https://avatars.steamstatic.com/');
}

/**
 * Build a handler that serves an avatar answer of the test.
 *
 * @param avatar - The answer to the avatar request.
 * @returns The handler.
 */
function withAvatar(avatar: FixtureResponse | (() => never)): FixtureHandler {
  return withOverride((request) => {
    if (!isAvatarRequest(request)) {
      return undefined;
    }
    return typeof avatar === 'function' ? avatar() : avatar;
  });
}

/** An avatar answer with the given content type. */
function avatarOf(contentType: string, body: Uint8Array = FIXTURE_AVATAR_JPEG): FixtureResponse {
  return { status: 200, headers: { 'Content-Type': contentType }, body };
}

describe('SteamProfileService.fetchProfile', () => {
  it('gives the persona name and the avatar', async () => {
    const { service, http } = setUp();

    const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, {
      allowRefresh: true,
    });

    expect(profile).toEqual({
      personaName: FIXTURE_PERSONA_NAME,
      avatarBase64: bytesToBase64(FIXTURE_AVATAR_JPEG),
      avatarHash: FIXTURE_AVATAR_HASH,
      profileFetchedAt: START,
    });
    expect(http.requests.filter(isAvatarRequest)).toEqual([
      {
        method: 'GET',
        url: AVATAR_URL,
        headers: {
          'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)',
          Accept: 'image/jpeg',
        },
        timeoutMs: 15_000,
        maxBodyBytes: MAX_AVATAR_BYTES,
      },
    ]);
    // deadlock-api knew the player: Steam was not asked to refresh anything.
    expect(http.requests.filter(isProfileRequest)).toHaveLength(1);
  });

  it('asks Steam to refresh once when deadlock-api has no profile', async () => {
    // The cache of deadlock-api is empty; only a refresh from Steam finds the player.
    const { service, http } = setUp(
      withOverride((request) =>
        isProfileRequest(request) && !request.url.includes('refresh=true')
          ? jsonResponse([])
          : undefined,
      ),
    );

    const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, {
      allowRefresh: true,
    });

    expect(profile.personaName).toBe(FIXTURE_PERSONA_NAME);
    expect(
      http.requests.filter(isProfileRequest).map((request) => request.url.endsWith('refresh=true')),
    ).toEqual([false, true]);
  });

  it('does not ask Steam to refresh when it is not allowed to', async () => {
    const { service, http } = setUp(
      withOverride((request) => (isProfileRequest(request) ? jsonResponse([]) : undefined)),
    );

    const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, {
      allowRefresh: false,
    });

    expect(profile).toEqual({ ...NO_PROFILE, profileFetchedAt: START });
    expect(http.requests.filter(isProfileRequest)).toHaveLength(1);
  });

  it('asks for one refresh at most, even when it finds nothing either', async () => {
    const { service, http } = setUp();

    const profile = await service.fetchProfile(UNKNOWN_ACCOUNT_ID, NO_PROFILE, {
      allowRefresh: true,
    });

    expect(profile).toEqual({ ...NO_PROFILE, profileFetchedAt: START });
    expect(http.requests.filter(isProfileRequest)).toHaveLength(2);
    expect(http.requests.filter(isAvatarRequest)).toHaveLength(0);
  });

  it.each([
    ['is paused', 'paused'],
    ['fails', 'network'],
    ['is out of budget', 'budget_exhausted'],
  ] as const)(
    'records the answer without a profile when the refresh %s',
    async (_name, outcome) => {
      // The normal request answers an empty list: deadlock-api did answer about the profile. Then
      // the refresh that was meant to find it cannot be made.
      const { service, api, http, logger } = setUp(
        withOverride((request) => {
          if (!isProfileRequest(request)) {
            return undefined;
          }
          if (!request.url.includes('refresh=true')) {
            return jsonResponse([]);
          }
          if (outcome === 'paused') {
            return jsonResponse({}, 429, { 'retry-after': '60' });
          }
          if (outcome === 'budget_exhausted') {
            return undefined;
          }
          throw new AppError('network', 'The request failed');
        }),
      );
      if (outcome === 'budget_exhausted') {
        // The 3 refreshes of the hour are spent before the service asks for its own.
        for (let index = 0; index < 3; index += 1) {
          await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, { refresh: true });
        }
      }
      const sentBefore = http.requests.filter(isProfileRequest).length;

      const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, {
        allowRefresh: true,
      });

      // The answer is recorded, so that the missing profile is retried at the next daily refresh;
      // the name and the avatar already stored are not touched.
      expect(profile).toEqual({ ...STORED_PROFILE, profileFetchedAt: START });
      // An out-of-budget refresh is not even sent.
      expect(http.requests.filter(isProfileRequest)).toHaveLength(
        sentBefore + (outcome === 'budget_exhausted' ? 1 : 2),
      );
      expect(logger.entries).toContainEqual({
        level: 'debug',
        scope: 'account',
        message: 'Steam profile not refreshed',
        context: { outcome },
      });
    },
  );

  it('gives no profile but records the answer when none is found', async () => {
    const { service, clock } = setUp();
    clock.now = START + DAY;

    const fromNothing = await service.fetchProfile(UNKNOWN_ACCOUNT_ID, NO_PROFILE, {
      allowRefresh: false,
    });
    const fromStored = await service.fetchProfile(UNKNOWN_ACCOUNT_ID, STORED_PROFILE, {
      allowRefresh: false,
    });

    // The account keeps what it had; only the time of the answer moves, so that the app does not
    // ask again before the next refresh is due.
    expect(fromNothing).toEqual({ ...NO_PROFILE, profileFetchedAt: START + DAY });
    expect(fromStored).toEqual({ ...STORED_PROFILE, profileFetchedAt: START + DAY });
  });

  it('links with the placeholder when deadlock-api is paused', async () => {
    const stoppedBeforehand = setUp();
    await stoppedBeforehand.syncState.setPausedUntil(START + 5 * MINUTE);
    const stoppedByTheAnswer = setUp(() => jsonResponse({}, 429, { 'retry-after': '120' }));

    for (const { service, http, logger } of [stoppedBeforehand, stoppedByTheAnswer]) {
      const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, {
        allowRefresh: true,
      });

      // Nothing is stored: the account shows "Steam player", and the profile is still due.
      expect(profile).toEqual(NO_PROFILE);
      expect(profile.profileFetchedAt).toBeNull();
      expect(http.requests.filter(isAvatarRequest)).toHaveLength(0);
      expect(logger.entries).toContainEqual({
        level: 'debug',
        scope: 'account',
        message: 'Steam profile not fetched',
        context: { outcome: 'paused' },
      });
    }
    expect(stoppedBeforehand.http.requests).toHaveLength(0);
  });

  it('keeps the stored profile when the budget of deadlock-api is spent', async () => {
    const { service, api, http, logger } = setUp();
    for (let index = 0; index < 10; index += 1) {
      await api.fetchSteamProfile(FIXTURE_ACCOUNT_ID, { refresh: false });
    }

    const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, {
      allowRefresh: true,
    });

    expect(profile).toEqual(STORED_PROFILE);
    expect(http.requests).toHaveLength(10);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ context: { outcome: 'budget_exhausted' } }),
    );
  });

  it.each([
    [
      'a network error',
      'network',
      () => {
        throw new AppError('network', 'The request failed');
      },
    ],
    [
      'a timeout',
      'timeout',
      () => {
        throw new AppError('timeout', 'The request timed out');
      },
    ],
    ['a server error', 'service_unavailable', () => jsonResponse({}, 500)],
    ['a refusal', 'forbidden', () => jsonResponse({}, 403)],
    ['an answer that is not a list', 'invalid_payload', () => jsonResponse({})],
  ] as const)(
    'keeps the stored profile when deadlock-api answers %s',
    async (_name, kind, fail) => {
      const { service, http, logger } = setUp(fail);

      const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, {
        allowRefresh: true,
      });

      expect(profile).toEqual(STORED_PROFILE);
      expect(http.requests.filter(isAvatarRequest)).toHaveLength(0);
      expect(logger.entries).toContainEqual({
        level: 'debug',
        scope: 'account',
        message: 'Steam profile not fetched',
        context: { outcome: kind },
      });
    },
  );

  it('downloads the avatar again only when its hash changed', async () => {
    const { service, http, clock } = setUp();
    const options = { allowRefresh: false };

    const first = await service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, options);
    expect(http.requests.filter(isAvatarRequest)).toHaveLength(1);

    // A day later the profile is refreshed, but the avatar is the one already stored.
    clock.now = START + DAY;
    const second = await service.fetchProfile(FIXTURE_ACCOUNT_ID, first, options);
    expect(http.requests.filter(isAvatarRequest)).toHaveLength(1);
    expect(second).toEqual({ ...first, profileFetchedAt: START + DAY });

    // The player changed their avatar since the stored one: the new one replaces it.
    const changed = await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, options);
    expect(http.requests.filter(isAvatarRequest)).toHaveLength(2);
    expect(changed).toMatchObject({
      avatarBase64: bytesToBase64(FIXTURE_AVATAR_JPEG),
      avatarHash: FIXTURE_AVATAR_HASH,
    });

    // A stored hash without its avatar is no avatar: it is downloaded.
    await service.fetchProfile(
      FIXTURE_ACCOUNT_ID,
      { ...first, avatarBase64: null, avatarHash: FIXTURE_AVATAR_HASH },
      options,
    );
    expect(http.requests.filter(isAvatarRequest)).toHaveLength(3);
  });

  it('gives no avatar when the profile has none', async () => {
    const { service, http } = setUp(
      withOverride((request) =>
        isProfileRequest(request)
          ? jsonResponse([{ account_id: FIXTURE_ACCOUNT_ID, personaname: FIXTURE_PERSONA_NAME }])
          : undefined,
      ),
    );

    const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, {
      allowRefresh: true,
    });

    expect(profile).toEqual({
      personaName: FIXTURE_PERSONA_NAME,
      avatarBase64: null,
      avatarHash: null,
      profileFetchedAt: START,
    });
    expect(http.requests.filter(isAvatarRequest)).toHaveLength(0);
  });

  it('gives no persona name when the profile has no usable one', async () => {
    const { service } = setUp(
      withOverride((request) =>
        isProfileRequest(request)
          ? jsonResponse([
              { account_id: FIXTURE_ACCOUNT_ID, personaname: '   ', avatarmedium: AVATAR_URL },
            ])
          : undefined,
      ),
    );

    const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, {
      allowRefresh: true,
    });

    // The avatar is still taken: the account is linked with whatever is valid.
    expect(profile).toMatchObject({ personaName: null, avatarHash: FIXTURE_AVATAR_HASH });
  });

  it('refuses an avatar that is not a JPEG or too large', async () => {
    const refusals: readonly (readonly [string, FixtureHandler])[] = [
      ['a PNG', withAvatar(avatarOf('image/png'))],
      [
        'a body without a content type',
        withAvatar({ status: 200, headers: {}, body: new Uint8Array(8) }),
      ],
      [
        'an avatar of 256 KiB and one byte',
        withAvatar(avatarOf('image/jpeg', new Uint8Array(MAX_AVATAR_BYTES + 1))),
      ],
      ['an empty body', withAvatar(avatarOf('image/jpeg', new Uint8Array(0)))],
      [
        'a 404',
        withAvatar({
          status: 404,
          headers: { 'content-type': 'image/jpeg' },
          body: new Uint8Array(8),
        }),
      ],
      [
        'a 304',
        withAvatar({
          status: 304,
          headers: { 'content-type': 'image/jpeg' },
          body: new Uint8Array(8),
        }),
      ],
      [
        'a timeout',
        withAvatar(() => {
          throw new AppError('timeout', 'The request timed out');
        }),
      ],
    ];

    for (const [, handler] of refusals) {
      const { service, logger } = setUp(handler);

      const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, {
        allowRefresh: true,
      });

      // The profile is not lost with its avatar: the name is the one deadlock-api gave, and the
      // stored avatar, which does not belong to this hash, is gone.
      expect(profile).toEqual({
        personaName: FIXTURE_PERSONA_NAME,
        avatarBase64: null,
        avatarHash: null,
        profileFetchedAt: START,
      });
      expect(
        logger.entries.filter((entry) => entry.message === 'Steam avatar not downloaded'),
      ).toHaveLength(1);
    }
  });

  it('names the reason an avatar was not stored', async () => {
    const png = setUp(withAvatar(avatarOf('image/png')));
    const tooLarge = setUp(
      withAvatar(avatarOf('image/jpeg', new Uint8Array(MAX_AVATAR_BYTES + 1))),
    );

    await png.service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, { allowRefresh: false });
    await tooLarge.service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, { allowRefresh: false });

    expect(png.logger.entries).toContainEqual(
      expect.objectContaining({ context: { outcome: 'avatar_refused' } }),
    );
    // The HTTP client stops reading at the limit and reports an invalid payload.
    expect(tooLarge.logger.entries).toContainEqual(
      expect.objectContaining({ context: { outcome: 'invalid_payload' } }),
    );
  });

  it.each([['image/jpeg'], ['image/jpeg; charset=binary'], [' IMAGE/JPEG ;q=1']])(
    'accepts an avatar served as %s',
    async (contentType) => {
      const { service } = setUp(withAvatar(avatarOf(contentType)));

      const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, {
        allowRefresh: false,
      });

      expect(profile.avatarBase64).toBe(bytesToBase64(FIXTURE_AVATAR_JPEG));
    },
  );

  it('accepts an avatar of exactly 256 KiB', async () => {
    const body = new Uint8Array(MAX_AVATAR_BYTES).fill(0xff);
    const { service } = setUp(withAvatar(avatarOf('image/jpeg', body)));

    const profile = await service.fetchProfile(FIXTURE_ACCOUNT_ID, NO_PROFILE, {
      allowRefresh: false,
    });

    expect(profile.avatarBase64).toBe(bytesToBase64(body));
  });

  it('never logs the persona name, the avatar hash or its URL', async () => {
    const scenarios: readonly (readonly [string, FixtureHandler])[] = [
      ['a profile with its avatar', createFixtureApi({ now: START, matchCount: 1 })],
      ['a PNG', withAvatar(avatarOf('image/png'))],
      [
        'an oversized avatar',
        withAvatar(avatarOf('image/jpeg', new Uint8Array(MAX_AVATAR_BYTES + 1))),
      ],
      [
        'a transport error that quotes the avatar URL',
        withAvatar(() => {
          throw new AppError('network', 'The request failed', {
            cause: `error sending request for url (${AVATAR_URL})`,
          });
        }),
      ],
      [
        'a transport error that quotes the profile URL',
        withOverride((request) => {
          if (!isProfileRequest(request)) {
            return undefined;
          }
          throw new AppError('network', `The request to ${request.url} failed`, {
            cause: `error sending request for url (${request.url})`,
          });
        }),
      ],
      [
        'an answer that holds the name',
        withOverride((request) =>
          isProfileRequest(request)
            ? jsonResponse({ personaname: FIXTURE_PERSONA_NAME })
            : undefined,
        ),
      ],
    ];

    for (const [, handler] of scenarios) {
      const { service, logger } = setUp(handler);

      await service.fetchProfile(FIXTURE_ACCOUNT_ID, STORED_PROFILE, { allowRefresh: true });

      const logged = JSON.stringify(logger.entries);
      expect(logged).not.toContain(FIXTURE_PERSONA_NAME);
      expect(logged).not.toContain(STORED_PROFILE.personaName);
      expect(logged).not.toContain(FIXTURE_AVATAR_HASH);
      expect(logged).not.toContain(STORED_PROFILE.avatarHash);
      expect(logged).not.toContain('steamstatic');
      expect(logged).not.toContain(String(FIXTURE_ACCOUNT_ID));
      // The check means something only if the service wrote its own lines.
      expect(logger.entries.length).toBeGreaterThan(0);
    }
  });
});

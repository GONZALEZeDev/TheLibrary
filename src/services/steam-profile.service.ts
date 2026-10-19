/**
 * The Steam profile of the linked account: its persona name and its avatar.
 *
 * The profile only dresses the interface, so nothing here ever stops the sign-in or the account
 * service: {@link SteamProfileService.fetchProfile} never throws. Whatever cannot be fetched leaves
 * the stored profile as it was, or gives an account without an avatar (the interface then shows
 * "Steam player" and a generic avatar).
 *
 * The persona name comes from deadlock-api (`DeadlockApiService.fetchSteamProfile`), which gives the
 * hash of the avatar too. The avatar itself is downloaded from Steam's avatar CDN once per hash and
 * kept as base64, so that the interface can show it offline.
 *
 * A persona name, an avatar hash and an avatar URL identify a player: the debug lines written here
 * only carry outcome words (`paused`, `no_profile`, `avatar_refused`, the kind of an error…).
 *
 * @packageDocumentation
 */
import { avatarUrl, bytesToBase64, MAX_AVATAR_BYTES } from '../core/account/linked-account';
import { REQUEST_TIMEOUT_MS, userAgent } from '../core/deadlock-api/endpoints';
import type { SteamProfile } from '../core/deadlock-api/steam-profile.schema';
import type { AccountId } from '../core/domain/account';
import { toAppError } from '../core/errors/app-error';
import type { HttpClient } from '../ports/http-client.port';
import type { Logger } from '../ports/logger.port';
import type { DeadlockApiService } from './deadlock-api.service';

/** The only media type accepted for an avatar: the app stores it as a JPEG. */
const AVATAR_MEDIA_TYPE = 'image/jpeg';

/** Scope of the debug lines of this service. */
const LOG_SCOPE = 'account';

/**
 * What the app knows of the profile of the linked account: the fields of `LinkedAccount` that come
 * from Steam, as the account service stores them.
 */
export interface ProfileSnapshot {
  /** The persona name; `null` when none is known (the UI shows "Steam player"). */
  readonly personaName: string | null;
  /** The medium avatar (JPEG), base64; `null` when none is stored. */
  readonly avatarBase64: string | null;
  /** 40-hex hash of the stored avatar; `null` exactly when `avatarBase64` is. */
  readonly avatarHash: string | null;
  /** When deadlock-api last answered about the profile (Unix ms); `null` when it never did. */
  readonly profileFetchedAt: number | null;
}

/** A profile that was never fetched: the starting point of an account that was just linked. */
export const NO_PROFILE: ProfileSnapshot = {
  personaName: null,
  avatarBase64: null,
  avatarHash: null,
  profileFetchedAt: null,
};

/** What {@link SteamProfileService} needs. */
export interface SteamProfileServiceDependencies {
  /** Gives the profile (persona name and avatar hash), within the budgets of deadlock-api. */
  readonly api: DeadlockApiService;
  /** Downloads the avatar from Steam's avatar CDN. */
  readonly http: HttpClient;
  /** Structured logger. */
  readonly logger: Logger;
  /** Version of the app, sent in the User-Agent of the avatar request. */
  readonly appVersion: string;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** The avatar fields of a {@link ProfileSnapshot}, which always change together. */
type AvatarFields = Pick<ProfileSnapshot, 'avatarBase64' | 'avatarHash'>;

/** No avatar: what the account keeps when the profile has none, or when it cannot be downloaded. */
const NO_AVATAR: AvatarFields = { avatarBase64: null, avatarHash: null };

/** Fetches the persona name and the avatar of a Steam account. */
export class SteamProfileService {
  readonly #api: DeadlockApiService;
  readonly #http: HttpClient;
  readonly #logger: Logger;
  readonly #userAgent: string;
  readonly #now: () => number;

  /**
   * @param dependencies - See {@link SteamProfileServiceDependencies}.
   */
  constructor(dependencies: SteamProfileServiceDependencies) {
    this.#api = dependencies.api;
    this.#http = dependencies.http;
    this.#logger = dependencies.logger;
    this.#userAgent = userAgent(dependencies.appVersion);
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * Fetch the profile of an account, to store with the account.
   *
   * - A normal request first. If deadlock-api knows nothing of the player and `allowRefresh` is set,
   *   one more request asks it to read the profile from Steam (a path it limits strictly).
   * - When deadlock-api is paused, the budget is spent or the normal request fails, `current` comes
   *   back unchanged: the stored profile stays, and `profileFetchedAt` is not touched, so the
   *   profile is still due for the next attempt.
   * - When deadlock-api answers but has no profile, `current` comes back with `profileFetchedAt`
   *   set to now: the answer is recorded, so that the app does not ask again before the next refresh
   *   is due. It is so too when the refresh that followed was paused, refused by its budget or
   *   failed: deadlock-api did answer the normal request, and the missing profile is retried daily.
   * - Otherwise the persona name of the profile is used, and the avatar is kept when its hash did
   *   not change, or else downloaded. An avatar that is refused or cannot be downloaded gives no
   *   avatar, not a failure: the account keeps what is valid.
   *
   * @param accountId - The account.
   * @param current - The profile stored with the account (`NO_PROFILE` for an account just linked).
   * @param options - The options of the call.
   * @param options.allowRefresh - Whether the account is worth a refresh request to Steam when
   *   deadlock-api has no profile for it.
   * @returns The profile to store. The call never throws.
   */
  async fetchProfile(
    accountId: AccountId,
    current: ProfileSnapshot,
    options: { readonly allowRefresh: boolean },
  ): Promise<ProfileSnapshot> {
    try {
      return await this.#readProfile(accountId, current, options.allowRefresh);
    } catch (error) {
      // The kind of the error is the outcome: its message may quote the URL it failed on.
      this.#logOutcome('Steam profile not fetched', toAppError(error).kind);
      return current;
    }
  }

  /**
   * Ask for the profile, then build the snapshot from the answer.
   *
   * @param accountId - The account.
   * @param current - The stored profile.
   * @param allowRefresh - Whether a refresh request may follow an answer without a profile.
   * @returns The profile to store, which is `current` itself when there is nothing new to store.
   * @throws AppError when deadlock-api cannot be reached or answers an error.
   */
  async #readProfile(
    accountId: AccountId,
    current: ProfileSnapshot,
    allowRefresh: boolean,
  ): Promise<ProfileSnapshot> {
    const answer = await this.#api.fetchSteamProfile(accountId, { refresh: false });
    if (answer.kind !== 'fetched') {
      this.#logOutcome('Steam profile not fetched', answer.kind);
      return current;
    }
    // From here deadlock-api has answered about the profile, with a profile or with an empty list,
    // and that answer is what `profileFetchedAt` records, whatever happens to the refresh below.
    const profile = answer.profile ?? (allowRefresh ? await this.#refreshProfile(accountId) : null);
    const fetchedAt = this.#now();
    if (profile === null) {
      this.#logOutcome('Steam profile not found', 'no_profile');
      return { ...current, profileFetchedAt: fetchedAt };
    }
    return {
      personaName: profile.personaName,
      ...(await this.#avatarOf(profile, current)),
      profileFetchedAt: fetchedAt,
    };
  }

  /**
   * Ask deadlock-api to read the profile from Steam, after its cache had none.
   *
   * The refresh is only a second chance: when it is paused, refused by its budget or fails, the
   * caller still has the answer of the normal request ("no profile"), so nothing is thrown here.
   *
   * @param accountId - The account.
   * @returns The profile Steam gave, or `null` when there is none or the refresh was not made.
   */
  async #refreshProfile(accountId: AccountId): Promise<SteamProfile | null> {
    // The cache of deadlock-api may simply be empty: one request reads the profile from Steam.
    this.#logOutcome('Steam profile not in the cache', 'refresh_requested');
    try {
      const answer = await this.#api.fetchSteamProfile(accountId, { refresh: true });
      if (answer.kind === 'fetched') {
        return answer.profile;
      }
      this.#logOutcome('Steam profile not refreshed', answer.kind);
    } catch (error) {
      // The kind of the error is the outcome: its message may quote the URL it failed on.
      this.#logOutcome('Steam profile not refreshed', toAppError(error).kind);
    }
    return null;
  }

  /**
   * The avatar to store for a profile: the stored one when its hash did not change, otherwise the
   * one downloaded from Steam.
   *
   * @param profile - The profile deadlock-api gave.
   * @param current - The stored profile.
   * @returns The avatar and its hash, or no avatar.
   */
  async #avatarOf(profile: SteamProfile, current: ProfileSnapshot): Promise<AvatarFields> {
    const { avatarHash } = profile;
    if (avatarHash === null) {
      return NO_AVATAR;
    }
    // An avatar without its hash (or the other way round) is not a stored avatar: it is downloaded.
    if (avatarHash === current.avatarHash && current.avatarBase64 !== null) {
      return { avatarBase64: current.avatarBase64, avatarHash };
    }
    return this.#downloadAvatar(avatarHash);
  }

  /**
   * Download an avatar. A refused or failed download is an outcome here, not an error: the profile
   * is still good without its avatar.
   *
   * @param hash - The 40-hex avatar hash.
   * @returns The avatar and its hash, or no avatar when the answer is not a JPEG of the allowed size.
   */
  async #downloadAvatar(hash: string): Promise<AvatarFields> {
    try {
      const response = await this.#http.getBytes({
        url: avatarUrl(hash),
        headers: { 'User-Agent': this.#userAgent, Accept: AVATAR_MEDIA_TYPE },
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBodyBytes: MAX_AVATAR_BYTES,
      });
      // An empty body is no image whatever the headers say, and would be stored as a blank avatar.
      if (
        response.status !== 200 ||
        mediaTypeOf(response.headers['content-type']) !== AVATAR_MEDIA_TYPE ||
        response.body.byteLength === 0
      ) {
        this.#logOutcome('Steam avatar not downloaded', 'avatar_refused');
        return NO_AVATAR;
      }
      return { avatarBase64: bytesToBase64(response.body), avatarHash: hash };
    } catch (error) {
      // An avatar over the size limit is an `invalid_payload` of the HTTP client; the kind is the
      // outcome, as the message may quote the avatar URL.
      this.#logOutcome('Steam avatar not downloaded', toAppError(error).kind);
      return NO_AVATAR;
    }
  }

  /**
   * Write a debug line that tells how a step ended, and nothing about the player.
   *
   * @param message - What was being done.
   * @param outcome - How it ended: a word of this service or the kind of an error.
   */
  #logOutcome(message: string, outcome: string): void {
    this.#logger.log('debug', LOG_SCOPE, message, { outcome });
  }
}

/**
 * Read the media type of a `Content-Type` header: what comes before the parameters, trimmed and in
 * lower case, so `Image/JPEG; charset=binary` is `image/jpeg`.
 *
 * @param contentType - The header value; `undefined` when the response has none.
 * @returns The media type, or an empty text when there is no header.
 */
function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

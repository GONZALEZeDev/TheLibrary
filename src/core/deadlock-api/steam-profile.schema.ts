/**
 * Validation of deadlock-api's Steam profiles (`GET /v1/players/steam?account_ids=<id>`).
 *
 * The answer is a JSON array with one object per known player; a player deadlock-api does not know
 * is simply missing (an empty array, never a 404). The profile only dresses the interface (a
 * persona name and an avatar), so this module is lenient on purpose: it reads the few fields the
 * app uses, skips any element it cannot read, and answers `null` rather than failing when the
 * account has no readable profile. Only a body that is not even a list is an error.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { avatarHashFromUrl, normalisePersonaName } from '../account/linked-account';
import type { AccountId } from '../domain/account';
import { AppError } from '../errors/app-error';

/** The Steam profile of a player, reduced to what the interface shows. */
export interface SteamProfile {
  /** The persona name, cleaned by `normalisePersonaName`; `null` when absent, blank or too long. */
  readonly personaName: string | null;
  /** The 40-hex avatar hash; `null` when the answer has no avatar URL the app can trust. */
  readonly avatarHash: string | null;
}

/**
 * One element of the answer (only the fields the app uses). The object is loose: the many other
 * fields of the profile (real name, country, profile URL…) are none of the app's business and are
 * not read.
 *
 * Every cosmetic field may be absent or `null` (both mean "nothing known"): one odd field must not
 * make the whole profile unreadable, the account is linked with whatever is valid.
 */
const steamProfileRowSchema = z.looseObject({
  account_id: z.int(),
  personaname: z.string().nullish(),
  avatar: z.string().nullish(),
  avatarmedium: z.string().nullish(),
  avatarfull: z.string().nullish(),
});

/** One validated element of the answer. */
type SteamProfileRow = z.infer<typeof steamProfileRowSchema>;

/** The body of the answer: a list of anything, each element being validated on its own. */
const steamProfilesSchema = z.array(z.unknown());

/**
 * Read the profile of one account out of deadlock-api's answer.
 *
 * @param body - The parsed JSON body of the response.
 * @param accountId - The account whose profile was requested.
 * @returns The profile of the account, or `null` when the answer has no readable element for it.
 * @throws AppError of kind `invalid_payload` when the body is not an array (the context `issue` is
 *   `<path>: <code>` of the first problem, never a value of the payload).
 */
export function parseSteamProfiles(body: unknown, accountId: AccountId): SteamProfile | null {
  const profiles = steamProfilesSchema.safeParse(body);
  if (!profiles.success) {
    throw new AppError('invalid_payload', 'The Steam profiles are invalid', {
      context: { issue: describeFirstIssue(profiles.error) },
    });
  }
  for (const element of profiles.data) {
    const row = steamProfileRowSchema.safeParse(element);
    // An element that does not fit the schema is skipped, never reported: one odd profile must not
    // hide the others, and the profile is cosmetic.
    if (row.success && row.data.account_id === accountId) {
      return toSteamProfile(row.data);
    }
  }
  return null;
}

/**
 * Map a validated element to the profile the app keeps.
 *
 * The medium avatar is the one the app stores, so its URL is tried first; the small and the full
 * ones are only fallbacks, as they carry the same hash on Steam's hosts.
 *
 * @param row - A validated element.
 * @returns The profile.
 */
function toSteamProfile(row: SteamProfileRow): SteamProfile {
  const personaName = row.personaname ?? null;
  return {
    personaName: personaName === null ? null : normalisePersonaName(personaName),
    avatarHash: firstAvatarHash([row.avatarmedium, row.avatar, row.avatarfull]),
  };
}

/**
 * Find the first avatar URL that holds a trusted avatar hash.
 *
 * @param urls - The avatar URLs of the profile, in order of preference; missing ones are `undefined`
 *   or `null`.
 * @returns The hash of the first readable URL, or `null` when none is.
 */
function firstAvatarHash(urls: readonly (string | null | undefined)[]): string | null {
  for (const url of urls) {
    const hash = url === undefined || url === null ? null : avatarHashFromUrl(url);
    if (hash !== null) {
      return hash;
    }
  }
  return null;
}

/**
 * Describe the first problem of a failed validation as `<path>: <code>`, e.g. `(root): invalid_type`.
 *
 * Only the path and the issue code are used: Zod's messages can echo parts of the input, and the
 * payload belongs to players (names, avatars), so no value may reach an error or a log.
 *
 * @param error - The validation error.
 * @returns The path and code of its first issue.
 */
function describeFirstIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) {
    return 'invalid payload';
  }
  // An issue on the body itself (not an array) has an empty path.
  const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
  return `${path}: ${issue.code}`;
}

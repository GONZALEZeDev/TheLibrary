/**
 * Conversion between a SteamID64 and an account id.
 *
 * Steam's OpenID sign-in tells the app who the player is with a SteamID64 (17 digits), while
 * deadlock-api identifies a player by the 32-bit account id of their Steam account (see
 * `domain/account`). The two differ by a constant: the SteamID64 of an individual account is the
 * account id plus {@link STEAM_ID64_BASE}.
 *
 * @packageDocumentation
 */
import { type AccountId, parseAccountId } from '../domain/account';
import { AppError } from '../errors/app-error';

/**
 * The SteamID64 of the account 0: `0x0110000100000000`, i.e. the universe "public" (1), the type
 * "individual" (1) and the instance "desktop" (1) in the high bits of a 64-bit id. Adding the
 * 32-bit account id of an individual account to it gives that account's SteamID64.
 *
 * It is a `bigint` because it is above 2^53: a JS `number` cannot hold it exactly.
 */
export const STEAM_ID64_BASE = 76561197960265728n;

/**
 * The text of a SteamID64: exactly 17 digits. Every individual account has 17 digits, since the
 * range of account ids (1 to 2^32 − 1) puts their SteamID64 between 76561197960265729 and
 * 76561202255233023. Anything else (a sign, a space, an exponent, another length) is refused
 * before `BigInt` could read it more leniently than Steam writes it.
 */
const STEAM_ID64_TEXT = /^\d{17}$/;

/**
 * Convert the SteamID64 of an individual account into its account id.
 *
 * The arithmetic is done with `BigInt`: a SteamID64 is above 2^53, so a JS `number` would round its
 * last digits and silently give the id of another player. The subtraction is exact, and the
 * result, being at most 32 bits, can then be turned into a `number` without loss.
 *
 * The refusal carries neither the value nor any context: a SteamID64 identifies a real person and
 * must not reach the logs through an error.
 *
 * @param steamId64 - The SteamID64, as text (17 digits).
 * @returns The account id deadlock-api knows the player by.
 * @throws AppError of kind `invalid_payload` when `steamId64` is not 17 digits, or when it is not
 *   the SteamID64 of an individual account (account id outside 1 to 4294967295).
 */
export function steamId64ToAccountId(steamId64: string): AccountId {
  if (STEAM_ID64_TEXT.test(steamId64)) {
    // `parseAccountId` owns the range of an account id (1 to 4294967295), so the bounds are not
    // written twice. A SteamID64 up to the base gives an offset of zero or less, and one past the
    // highest account gives an offset above 2^32 − 1: both are refused there. Turning such an
    // offset into a `number` may round it, but never into the valid range.
    const accountId = parseAccountId(Number(BigInt(steamId64) - STEAM_ID64_BASE));
    if (accountId !== null) {
      return accountId;
    }
  }
  throw new AppError('invalid_payload', 'The Steam id is not an individual account');
}

/**
 * Convert an account id into the SteamID64 of the individual account, the reverse of
 * {@link steamId64ToAccountId}. The app itself never needs it: it exists for the fixtures and the
 * tests, which build the SteamID64 that Steam would send for a given account.
 *
 * @param accountId - The account id.
 * @returns The SteamID64, as text (17 digits).
 */
export function accountIdToSteamId64(accountId: AccountId): string {
  return (BigInt(accountId) + STEAM_ID64_BASE).toString();
}

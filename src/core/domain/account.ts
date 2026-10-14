/**
 * Steam account identifiers.
 *
 * deadlock-api identifies a player by the "account id" of their Steam account (also called
 * SteamID3): the low 32 bits of the SteamID64, i.e. `SteamID64 − 76561197960265728`. TheLibrary
 * only ever synchronises one account, the user's own; which one is decided by the `AccountSource`
 * port.
 *
 * @packageDocumentation
 */

/**
 * A validated Steam account id: a positive integer of at most 32 bits.
 *
 * The brand makes the type checker reject a plain number where an account id is expected: every
 * account id of the app went through {@link parseAccountId}.
 */
export type AccountId = number & { readonly __brand: 'AccountId' };

/** Largest account id: account ids are unsigned 32-bit integers. */
const MAX_ACCOUNT_ID = 0xffff_ffff;

/** Decimal form of an account id: digits only, at most 10 of them (2^32 has 10 digits). */
const ACCOUNT_ID_TEXT = /^\d{1,10}$/;

/**
 * Validate an account id.
 *
 * Accepts a number, or its decimal form as text (an environment variable, a URL parameter…).
 * Text is strict: no sign, no decimals, no exponent, no surrounding spaces, so that a typo is
 * reported instead of silently becoming another account.
 *
 * @param value - The candidate account id.
 * @returns The account id, or `null` when `value` is not a valid account id.
 */
export function parseAccountId(value: unknown): AccountId | null {
  let candidate: number;
  if (typeof value === 'number') {
    candidate = value;
  } else if (typeof value === 'string' && ACCOUNT_ID_TEXT.test(value)) {
    candidate = Number(value);
  } else {
    return null;
  }
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= MAX_ACCOUNT_ID
    ? (candidate as AccountId)
    : null;
}

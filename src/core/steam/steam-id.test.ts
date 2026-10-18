/**
 * Tests of the SteamID64 conversion.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testAccountId } from '../../test/test-data';
import { type AppError, isAppError } from '../errors/app-error';
import { STEAM_ID64_BASE, accountIdToSteamId64, steamId64ToAccountId } from './steam-id';

/**
 * Convert a SteamID64 that must be refused and return the error it throws.
 *
 * The error is caught and checked with `isAppError` instead of being matched by `toThrow`: the
 * assertions then state plainly that the refusal is an `AppError`, not any other failure.
 *
 * @param steamId64 - A text that is not the SteamID64 of an individual account.
 * @returns The error the conversion threw.
 */
function refusalOf(steamId64: string): AppError {
  try {
    steamId64ToAccountId(steamId64);
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('The conversion did not refuse the value');
}

describe('steamId64ToAccountId', () => {
  it('converts the lowest and the highest individual account', () => {
    expect(steamId64ToAccountId('76561197960265729')).toBe(1);
    expect(steamId64ToAccountId('76561202255233023')).toBe(4294967295);
  });

  it('keeps every digit of a SteamID64 above 2^53', () => {
    // Number('76561198012345679') would round to …680 and give 52079952.
    expect(steamId64ToAccountId('76561198012345679')).toBe(52079951);
  });

  it.each([
    '76561197960265728',
    '76561202255233024',
    '7656119796026572',
    '765611979602657290',
    '7656119796026572a',
    ' 76561197960265729',
  ])('refuses %j', (value) => {
    expect(refusalOf(value).kind).toBe('invalid_payload');
  });

  it('never puts the refused value in the error', () => {
    // Digits that look like a real SteamID64 are the sensitive case: the id of a real player must
    // not reach the logs through an error message or its context.
    const refused = '76561202255233024';
    const error = refusalOf(refused);
    expect(error.message).not.toContain(refused);
    expect(JSON.stringify(error.context)).not.toContain(refused);
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });
});

describe('accountIdToSteamId64', () => {
  it('converts an account id back to its SteamID64', () => {
    expect(accountIdToSteamId64(testAccountId(1000001))).toBe('76561197961265729');
  });

  it('is the reverse of the conversion, at both ends of the range', () => {
    expect(accountIdToSteamId64(testAccountId(1))).toBe('76561197960265729');
    expect(accountIdToSteamId64(testAccountId(4294967295))).toBe('76561202255233023');
    expect(steamId64ToAccountId(accountIdToSteamId64(testAccountId(52079951)))).toBe(52079951);
  });
});

describe('STEAM_ID64_BASE', () => {
  it('is the SteamID64 of the account 0, the first of the individual accounts', () => {
    expect(STEAM_ID64_BASE).toBe(76561197960265728n);
  });
});

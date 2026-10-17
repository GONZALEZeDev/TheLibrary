/**
 * Tests of the validation and mapping of deadlock-api's match history.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseAccountId } from '../domain/account';
import { AppError } from '../errors/app-error';
import { parseMatchHistory } from './match-history.schema';

/** The player of the tests. */
const ACCOUNT_ID = parseAccountId(123456789) ?? expect.unreachable();

/**
 * A history row in the exact shape of the API (fields the app ignores included), describing a
 * ranked Paige win.
 *
 * @param overrides - Fields to change.
 * @returns The raw row.
 */
function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: 123456789,
    match_id: 108501737,
    hero_id: 67,
    hero_level: 31,
    start_time: 1_760_000_000,
    game_mode: 1,
    match_mode: 4,
    player_team: 1,
    player_kills: 7,
    player_deaths: 3,
    player_assists: 18,
    denies: 12,
    net_worth: 41_250,
    last_hits: 160,
    team_abandoned: null,
    abandoned_time_s: null,
    match_duration_s: 2_070,
    match_result: 1,
    objectives_mask_team0: 3,
    objectives_mask_team1: 61_439,
    brawl_score_team0: null,
    brawl_score_team1: null,
    brawl_avg_round_time_s: null,
    ranked_display_badge: 74,
    ranked_delta: 12,
    ranked_calibration_match: false,
    ranked_used_demotion_protection: null,
    player_match_outcome: 1,
    ...overrides,
  };
}

describe('parseMatchHistory', () => {
  it('maps a row to a match summary', () => {
    const { matches, invalidRows, firstIssue } = parseMatchHistory([rawRow()], ACCOUNT_ID);

    expect(matches).toEqual([
      {
        accountId: ACCOUNT_ID,
        matchId: 108501737,
        heroId: 67,
        startTime: 1_760_000_000,
        durationS: 2_070,
        gameMode: 1,
        matchMode: 4,
        won: true,
        kills: 7,
        deaths: 3,
        assists: 18,
        netWorth: 41_250,
        lastHits: 160,
        denies: 12,
        rankDelta: 12,
      },
    ]);
    expect(invalidRows).toBe(0);
    expect(firstIssue).toBeNull();
  });

  it('decides the result by comparing the winning team with the player team', () => {
    const history = parseMatchHistory(
      [
        rawRow({ match_id: 1, player_team: 0, match_result: 0 }),
        rawRow({ match_id: 2, player_team: 0, match_result: 1 }),
        rawRow({ match_id: 3, player_team: 1, match_result: 0 }),
      ],
      ACCOUNT_ID,
    );

    expect(history.matches.map((match) => match.won)).toEqual([true, false, false]);
  });

  it('reads a missing or null rank change as no rank change', () => {
    const withoutDelta = rawRow({ match_id: 1 });
    delete withoutDelta.ranked_delta;
    const history = parseMatchHistory(
      [withoutDelta, rawRow({ match_id: 2, ranked_delta: null })],
      ACCOUNT_ID,
    );

    expect(history.matches.map((match) => match.rankDelta)).toEqual([null, null]);
  });

  it('ignores the fields it does not use, even unknown ones', () => {
    const history = parseMatchHistory([rawRow({ brand_new_field: { nested: true } })], ACCOUNT_ID);

    expect(history.matches).toHaveLength(1);
    expect(history.matches[0]).not.toHaveProperty('brand_new_field');
  });

  it('drops an invalid row, keeps the others and reports the first issue', () => {
    const history = parseMatchHistory(
      [
        rawRow({ match_id: 1 }),
        rawRow({ match_id: 2, hero_id: 'Paige' }),
        rawRow({ match_id: 3, player_kills: -1 }),
        // An integer, but not a match id: the shared rule of the match id refuses it.
        rawRow({ match_id: 0 }),
      ],
      ACCOUNT_ID,
    );

    expect(history.matches.map((match) => match.matchId)).toEqual([1]);
    expect(history.invalidRows).toBe(3);
    expect(history.firstIssue).toMatch(/^\[1\]\.hero_id: /);
  });

  it('drops a row that describes another player', () => {
    const history = parseMatchHistory(
      [rawRow({ match_id: 1 }), rawRow({ match_id: 2, account_id: 42 })],
      ACCOUNT_ID,
    );

    expect(history.matches.map((match) => match.matchId)).toEqual([1]);
    expect(history.firstIssue).toBe('[1].account_id: row of another player');
  });

  it('accepts an empty history', () => {
    expect(parseMatchHistory([], ACCOUNT_ID)).toEqual({
      matches: [],
      invalidRows: 0,
      firstIssue: null,
    });
  });

  it('rejects a body that is not an array', () => {
    expect(() => parseMatchHistory({ matches: [] }, ACCOUNT_ID)).toThrow(AppError);
    expect(() => parseMatchHistory(null, ACCOUNT_ID)).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });

  it('rejects a history in which no row is valid: the format has changed', () => {
    expect(() => parseMatchHistory([rawRow({ match_id: '1' })], ACCOUNT_ID)).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });
});

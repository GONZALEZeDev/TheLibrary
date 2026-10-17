/**
 * Tests of the validation of deadlock-api's match detail (`/v1/matches/{match_id}/metadata`).
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, the movement paths, the damage matrix, many fields the app ignores) but none of
 * its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { testMatchId } from '../../test/test-data';
import { parseMatchMetadata } from './match-metadata.schema';

/** The match of the tests. */
const MATCH_ID = testMatchId(108_501_737);

/** The shape of {@link rawMetadata}: loose on purpose, tests break it on purpose. */
interface RawMetadata {
  match_info: Record<string, unknown>;
  hero_build_ids: unknown[];
  pregame_hero_ids: number[];
  banned_hero_ids: number[];
}

/**
 * One player in the exact shape of the API (fields the app ignores included).
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param overrides - Fields to change.
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, overrides: Record<string, unknown> = {}) {
  return {
    account_id: 1_000_000 + playerSlot,
    player_slot: playerSlot,
    team: playerSlot <= 6 ? 0 : 1,
    hero_id: 60 + playerSlot,
    kills: 5,
    deaths: 4,
    assists: 9,
    net_worth: 30_000,
    items: [{ item_id: 1_234, game_time_s: 120 }],
    ...overrides,
  };
}

/**
 * A valid detail of a twelve-player match, in the shape of the API.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads. The movement paths cover every slot; the damage matrix has the non-player dealer
 * (slot 0) and a player dealer hitting a player and the non-player target (slot 0).
 *
 * @param overrides - Fields of `match_info` to change.
 * @returns The raw detail.
 */
function rawMetadata(overrides: Record<string, unknown> = {}): RawMetadata {
  const slots = Array.from({ length: 12 }, (_, index) => 12 - index);
  return {
    match_info: {
      match_id: 108_501_737,
      start_time: 1_760_000_000,
      duration_s: 2_070,
      game_mode: 1,
      match_mode: 4,
      winning_team: 1,
      players: slots.map((slot) => rawPlayer(slot)),
      match_paths: {
        version: 1,
        interval_s: 3,
        x_resolution: 16_383,
        y_resolution: 16_383,
        paths: slots.map((slot) => ({
          player_slot: slot,
          x_min: -9_000,
          x_max: 9_000,
          x_pos: [100, 200, 300],
          y_pos: [400, 500, 600],
          health: [550, 540, 530],
          combat_type: [0, 1, 1],
          move_type: [0, 0, 1],
        })),
      },
      damage_matrix: {
        sample_time_s: [0, 60, 120],
        source_details: { stat_type: [0, 1], source_name: ['Pistol', 'Burst'] },
        damage_dealers: [
          {
            dealer_player_slot: 0,
            damage_sources: [
              {
                source_details_index: 0,
                damage_to_players: [{ target_player_slot: 1, damage: [3, 4] }],
              },
            ],
          },
          {
            dealer_player_slot: 1,
            damage_sources: [
              {
                source_details_index: 1,
                damage_to_players: [
                  { target_player_slot: 0, damage: [5, 6] },
                  { target_player_slot: 7, damage: [7, 8] },
                ],
              },
            ],
          },
        ],
      },
      ...overrides,
    },
    hero_build_ids: [],
    pregame_hero_ids: [],
    banned_hero_ids: [],
  };
}

/**
 * Run a call that must fail with an {@link AppError} and return that error.
 *
 * @param action - The call under test.
 * @returns The error it threw.
 */
function catchAppError(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  return expect.unreachable('the call should have thrown');
}

describe('parseMatchMetadata', () => {
  it('accepts a valid detail and returns it as is', () => {
    const body = rawMetadata();

    expect(parseMatchMetadata(body, MATCH_ID)).toEqual(body);
  });

  it('keeps the fields it does not know', () => {
    const body = rawMetadata({ extra_info: 'a' });
    const [firstPlayer] = body.match_info.players as Record<string, unknown>[];
    Object.assign(firstPlayer ?? {}, { extra_player: 'b' });
    const matchPaths = body.match_info.match_paths as { paths: Record<string, unknown>[] };
    Object.assign(matchPaths.paths[0] ?? {}, { extra_path: 'c' });

    const parsed = parseMatchMetadata({ ...body, extra_top: 'd' }, MATCH_ID);

    expect(parsed).toHaveProperty('extra_top', 'd');
    expect(parsed).toHaveProperty(['match_info', 'extra_info'], 'a');
    expect(parsed).toHaveProperty(['match_info', 'players', 0, 'extra_player'], 'b');
    expect(parsed).toHaveProperty(['match_info', 'match_paths', 'paths', 0, 'extra_path'], 'c');
    expect(parsed).toHaveProperty(['match_info', 'damage_matrix', 'sample_time_s'], [0, 60, 120]);
  });

  it('keeps the fields it does not know inside a damage dealer, a source and a target', () => {
    const body = rawMetadata();
    const matrix = body.match_info.damage_matrix as {
      damage_dealers: {
        damage_sources: { damage_to_players: Record<string, unknown>[] }[];
      }[];
    };
    const dealer = matrix.damage_dealers[1];
    const source = dealer?.damage_sources[0];
    const target = source?.damage_to_players[0];
    // The loose schemas of these three levels are what keeps the damage samples of a real archive
    // (a stripping object here would silently remove them from every archive written).
    Object.assign(dealer ?? {}, { extra_dealer: 'a' });
    Object.assign(source ?? {}, { extra_source: 'b' });
    Object.assign(target ?? {}, { extra_target: 'c' });

    const parsed = parseMatchMetadata(body, MATCH_ID);

    const base = ['match_info', 'damage_matrix', 'damage_dealers', 1] as const;
    expect(parsed).toHaveProperty([...base, 'extra_dealer'], 'a');
    expect(parsed).toHaveProperty([...base, 'damage_sources', 0, 'extra_source'], 'b');
    expect(parsed).toHaveProperty([...base, 'damage_sources', 0, 'source_details_index'], 1);
    expect(parsed).toHaveProperty(
      [...base, 'damage_sources', 0, 'damage_to_players', 0, 'extra_target'],
      'c',
    );
    expect(parsed).toHaveProperty(
      [...base, 'damage_sources', 0, 'damage_to_players', 0, 'damage'],
      [5, 6],
    );
  });

  it('accepts u32 values above 2^31 in fields it does not validate', () => {
    const body = rawMetadata({ players: [rawPlayer(1, { items: [{ item_id: 4_204_808_176 }] })] });

    const parsed = parseMatchMetadata(body, MATCH_ID);

    expect(parsed).toHaveProperty(
      ['match_info', 'players', 0, 'items'],
      [{ item_id: 4_204_808_176 }],
    );
  });

  it('accepts a u32 account id', () => {
    const body = rawMetadata({ players: [rawPlayer(1, { account_id: 4_294_967_295 })] });

    expect(parseMatchMetadata(body, MATCH_ID)).toHaveProperty(
      ['match_info', 'players', 0, 'account_id'],
      4_294_967_295,
    );
  });

  it('accepts a match without paths or damage matrix', () => {
    const body = rawMetadata();
    delete body.match_info.match_paths;
    delete body.match_info.damage_matrix;

    const parsed = parseMatchMetadata(body, MATCH_ID);

    expect(parsed.match_info.match_paths).toBeUndefined();
    expect(parsed.match_info.damage_matrix).toBeUndefined();
  });

  it('skips the match id check when no id is given', () => {
    const body = rawMetadata({ match_id: 42 });

    expect(parseMatchMetadata(body).match_info.match_id).toBe(42);
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, 'detail', 42, [rawMetadata()]]) {
      const error = catchAppError(() => parseMatchMetadata(body, MATCH_ID));

      expect(error.kind).toBe('invalid_payload');
    }
  });

  it('refuses a player without a slot', () => {
    const body = rawMetadata();
    const [firstPlayer] = body.match_info.players as Record<string, unknown>[];
    delete firstPlayer?.player_slot;

    const error = catchAppError(() => parseMatchMetadata(body, MATCH_ID));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toEqual(
      expect.stringMatching(/^match_info\.players\.0\.player_slot/),
    );
  });

  it('refuses a detail without players', () => {
    const error = catchAppError(() => parseMatchMetadata(rawMetadata({ players: [] }), MATCH_ID));

    expect(error.context.issue).toEqual(expect.stringMatching(/^match_info\.players/));
  });

  it('refuses a validated integer that is fractional or beyond the safe range', () => {
    for (const duration of [1.5, 2 ** 60]) {
      const error = catchAppError(() =>
        parseMatchMetadata(rawMetadata({ duration_s: duration }), MATCH_ID),
      );

      expect(error.context.issue).toEqual(expect.stringMatching(/^match_info\.duration_s/));
    }
  });

  it('refuses a damage dealer without a slot', () => {
    const body = rawMetadata();
    const matrix = body.match_info.damage_matrix as { damage_dealers: Record<string, unknown>[] };
    delete matrix.damage_dealers[0]?.dealer_player_slot;

    const error = catchAppError(() => parseMatchMetadata(body, MATCH_ID));

    expect(error.context.issue).toEqual(
      expect.stringMatching(/^match_info\.damage_matrix\.damage_dealers\.0\.dealer_player_slot/),
    );
  });

  it('refuses the detail of another match', () => {
    const error = catchAppError(() => parseMatchMetadata(rawMetadata(), testMatchId(7)));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('match_id');
  });

  it('never puts a payload value in the error', () => {
    // The invalid field itself holds an account-like number, and so do the players.
    const body = rawMetadata({
      players: [rawPlayer(1, { account_id: 987654321, team: '987654321' })],
    });

    const error = catchAppError(() => parseMatchMetadata(body, MATCH_ID));

    expect(error.context.issue).toEqual(expect.stringMatching(/^match_info\.players\.0\.team/));
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      '987654321',
    );
  });
});

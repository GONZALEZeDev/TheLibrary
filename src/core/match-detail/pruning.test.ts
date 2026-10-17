/**
 * Tests of the tracked player lookup and of the pruning of a match detail.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, the movement paths, the damage matrix, many fields the app ignores) but none of
 * its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PAIGE_HERO_ID } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import type { RawMatchMetadata } from '../deadlock-api/match-metadata.schema';
import { testAccountId, testMatchId } from '../../test/test-data';
import { findTrackedPlayer, pruneForPlayer } from './pruning';

/** The match of the tests. */
const MATCH_ID = testMatchId(108_501_737);

/** The slot of the tracked player (their team is 1: slots 7 to 12). */
const TRACKED_SLOT = 9;

/** The account of the tracked player. */
const TRACKED_ACCOUNT = testAccountId(1_000_009);

/**
 * One player in the shape of the API (fields the app ignores included).
 *
 * The tracked player plays Paige; the other players play other heroes.
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
    hero_id: playerSlot === TRACKED_SLOT ? PAIGE_HERO_ID : 100 + playerSlot,
    kills: 5,
    deaths: 4,
    items: [{ item_id: 1_234, game_time_s: 120 }],
    ...overrides,
  };
}

/**
 * The damage a source did to one target (the samples are kept as they are).
 *
 * @param target - The slot of the target, `0` being a non-player target.
 * @returns The raw `damage_to_players` entry.
 */
function rawDamageTo(target: number) {
  return { target_player_slot: target, damage: [target, target + 1], extra_damage: 'x' };
}

/**
 * One damage source of a dealer.
 *
 * @param sourceIndex - Index in `source_details`, which must stay valid after the pruning.
 * @param targets - The slots of the targets, in order.
 * @returns The raw damage source.
 */
function rawSource(sourceIndex: number, targets: readonly number[]) {
  return {
    source_details_index: sourceIndex,
    extra_source: sourceIndex,
    damage_to_players: targets.map((target) => rawDamageTo(target)),
  };
}

/**
 * One damage dealer.
 *
 * @param dealerSlot - The slot of the dealer, `0` being a non-player (neutrals, objectives…).
 * @param sources - The damage sources of the dealer.
 * @returns The raw damage dealer.
 */
function rawDealer(dealerSlot: number, sources: readonly ReturnType<typeof rawSource>[]) {
  return { dealer_player_slot: dealerSlot, extra_dealer: dealerSlot, damage_sources: sources };
}

/**
 * A twelve-player detail in the shape of the API, validated like the app does.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads. The movement paths cover every slot. The damage matrix holds, in this order:
 * - the non-player dealer (slot 0): a source hitting the tracked player and another one, and a
 *   source hitting nobody that concerns them;
 * - the tracked player (slot 9): hits a player, themselves, a non-player target and a teammate;
 * - a teammate (slot 8): a source hitting the tracked player and another one, and a source that
 *   does not concern them;
 * - an enemy (slot 2): hits only other players;
 * - an enemy without any source.
 *
 * @param overrides - Fields of `match_info` to change.
 * @returns The validated detail.
 */
function metadata(overrides: Record<string, unknown> = {}): RawMatchMetadata {
  const slots = Array.from({ length: 12 }, (_, index) => 12 - index);
  return parseMatchMetadata(
    {
      match_info: {
        match_id: 108_501_737,
        start_time: 1_760_000_000,
        duration_s: 2_070,
        game_mode: 1,
        match_mode: 4,
        extra_info: 'a',
        players: slots.map((slot) => rawPlayer(slot)),
        match_paths: {
          version: 1,
          interval_s: 3,
          paths: slots.map((slot) => ({
            player_slot: slot,
            x_pos: [100, 200, 300],
            y_pos: [400, 500, 600],
            health: [550, 540, 530],
          })),
        },
        damage_matrix: {
          sample_time_s: [0, 60, 120],
          source_details: { stat_type: [0, 1, 2], source_name: ['Pistol', 'Burst', 'Wave'] },
          damage_dealers: [
            rawDealer(0, [rawSource(0, [5, TRACKED_SLOT, 12]), rawSource(1, [5, 12])]),
            rawDealer(TRACKED_SLOT, [rawSource(1, [3, 0, TRACKED_SLOT, 8]), rawSource(2, [12])]),
            rawDealer(8, [
              rawSource(0, [TRACKED_SLOT, 5]),
              rawSource(2, [5]),
              rawSource(1, [11, TRACKED_SLOT]),
            ]),
            rawDealer(2, [rawSource(0, [5, 12]), rawSource(1, [0])]),
            rawDealer(3, []),
          ],
        },
        ...overrides,
      },
      hero_build_ids: [],
      pregame_hero_ids: [1, 2],
      banned_hero_ids: [3],
    },
    MATCH_ID,
  );
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

describe('findTrackedPlayer', () => {
  it('finds the tracked player by account id', () => {
    expect(findTrackedPlayer(metadata(), TRACKED_ACCOUNT)).toEqual({
      playerSlot: TRACKED_SLOT,
      team: 1,
    });
  });

  it('refuses a match without the tracked player', () => {
    const error = catchAppError(() => findTrackedPlayer(metadata(), testAccountId(42)));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });

  it('refuses a match where two players have the tracked account id', () => {
    const detail = metadata({
      players: [rawPlayer(TRACKED_SLOT), rawPlayer(2, { account_id: TRACKED_ACCOUNT })],
    });

    const error = catchAppError(() => findTrackedPlayer(detail, TRACKED_ACCOUNT));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_ambiguous');
  });

  it('refuses a match where the tracked player is not Paige', () => {
    const detail = metadata({
      players: [rawPlayer(TRACKED_SLOT, { hero_id: PAIGE_HERO_ID + 1 }), rawPlayer(2)],
    });

    const error = catchAppError(() => findTrackedPlayer(detail, TRACKED_ACCOUNT));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_not_paige');
  });

  it('never puts an account id in the error', () => {
    const error = catchAppError(() => findTrackedPlayer(metadata(), testAccountId(987_654_321)));

    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      '987654321',
    );
  });
});

describe('pruneForPlayer', () => {
  it('keeps only the path of the tracked player', () => {
    const detail = metadata();
    expect(detail.match_info.match_paths?.paths).toHaveLength(12);

    const pruned = pruneForPlayer(detail, TRACKED_SLOT);

    expect(pruned.match_info.match_paths?.paths).toEqual([
      {
        player_slot: TRACKED_SLOT,
        x_pos: [100, 200, 300],
        y_pos: [400, 500, 600],
        health: [550, 540, 530],
      },
    ]);
  });

  it('keeps the damage the tracked player deals and takes, and nothing else', () => {
    const pruned = pruneForPlayer(metadata(), TRACKED_SLOT);

    expect(pruned.match_info.damage_matrix?.damage_dealers).toEqual([
      // The non-player dealer keeps what hits the tracked player; the source hitting only others
      // is dropped.
      rawDealer(0, [{ ...rawSource(0, []), damage_to_players: [rawDamageTo(TRACKED_SLOT)] }]),
      // The tracked player's own damage stays whole: every target, themselves and the non-player
      // target (slot 0) included.
      rawDealer(TRACKED_SLOT, [rawSource(1, [3, 0, TRACKED_SLOT, 8]), rawSource(2, [12])]),
      // A teammate keeps what hits the tracked player; sources that do not are dropped and the
      // kept ones keep their `source_details_index`.
      rawDealer(8, [
        { ...rawSource(0, []), damage_to_players: [rawDamageTo(TRACKED_SLOT)] },
        { ...rawSource(1, []), damage_to_players: [rawDamageTo(TRACKED_SLOT)] },
      ]),
      // The enemy hitting only other players, and the dealer without any source, are gone.
    ]);
  });

  it.each([
    ['has no source at all', []],
    ['has a source that hits nobody', [rawSource(0, []), rawSource(1, [3])]],
  ])('keeps the dealer of the tracked player as it is when it %s', (_name, sources) => {
    // The tracked dealer is kept whole, whatever it holds: an empty source or no source at all is
    // not dropped as it would be for another dealer.
    const tracked = rawDealer(TRACKED_SLOT, sources);
    const detail = metadata({
      damage_matrix: {
        sample_time_s: [0, 60, 120],
        source_details: { stat_type: [0, 1, 2], source_name: ['Pistol', 'Burst', 'Wave'] },
        damage_dealers: [tracked, rawDealer(3, [])],
      },
    });

    const pruned = pruneForPlayer(detail, TRACKED_SLOT);

    // The dealer without any source who is not the tracked player is gone.
    expect(pruned.match_info.damage_matrix?.damage_dealers).toEqual([tracked]);
  });

  it('keeps the sample times and the source details whole', () => {
    const pruned = pruneForPlayer(metadata(), TRACKED_SLOT);

    expect(pruned.match_info.damage_matrix?.sample_time_s).toEqual([0, 60, 120]);
    expect(pruned.match_info.damage_matrix?.source_details).toEqual({
      stat_type: [0, 1, 2],
      source_name: ['Pistol', 'Burst', 'Wave'],
    });
  });

  it('keeps every player entry and every unknown field', () => {
    const detail = metadata();

    const pruned = pruneForPlayer(detail, TRACKED_SLOT);

    expect(pruned.match_info.players).toEqual(detail.match_info.players);
    expect(pruned.match_info.players).toHaveLength(12);
    expect(pruned).toHaveProperty('pregame_hero_ids', [1, 2]);
    expect(pruned).toHaveProperty('banned_hero_ids', [3]);
    expect(pruned).toHaveProperty('hero_build_ids', []);
    expect(pruned).toHaveProperty(['match_info', 'extra_info'], 'a');
    expect(pruned).toHaveProperty(['match_info', 'match_paths', 'version'], 1);
    expect(pruned).toHaveProperty(['match_info', 'match_paths', 'interval_s'], 3);
    expect(pruned).toHaveProperty([
      'match_info',
      'damage_matrix',
      'damage_dealers',
      0,
      'extra_dealer',
    ]);
  });

  it('does not modify its input', () => {
    const detail = metadata();
    const before = structuredClone(detail);

    const pruned = pruneForPlayer(detail, TRACKED_SLOT);

    expect(detail).toEqual(before);
    expect(pruned).not.toBe(detail);
    expect(pruned.match_info).not.toBe(detail.match_info);
  });

  it('copes with a match without paths or damage matrix', () => {
    const detail = metadata();
    delete detail.match_info.match_paths;
    delete detail.match_info.damage_matrix;

    const pruned = pruneForPlayer(detail, TRACKED_SLOT);

    expect(pruned).toEqual(detail);
    expect(pruned.match_info).not.toHaveProperty('match_paths');
    expect(pruned.match_info).not.toHaveProperty('damage_matrix');
  });
});

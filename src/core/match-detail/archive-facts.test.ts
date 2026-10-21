/**
 * Tests of the facts read back from an archive.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, snapshots and items on every player, many fields the app ignores) but none of
 * its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { PAIGE_HERO_ID } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import { testAccountId } from '../../test/test-data';
import { createArchiveEnvelope } from './archive-envelope';
import type { ArchiveEnvelope } from './archive-envelope';
import { summarizeArchive } from './archive-facts';

/** The slot of the tracked player (their team is 1: slots 7 to 12). */
const TRACKED_SLOT = 9;

/** The account of the tracked player. */
const TRACKED_ACCOUNT = testAccountId(1_000_009);

/** When the detail was fetched (Unix milliseconds). */
const FETCHED_AT = 1_760_000_123_456;

/**
 * The 13 snapshots of the tracked player's match (only their number matters to the facts).
 *
 * @returns The raw `stats` array.
 */
function rawStats() {
  return Array.from({ length: 13 }, (_, index) => ({ time_stamp_s: 180 * (index + 1) }));
}

/**
 * The items of the tracked player: 7 entries in the shape of the API, of which 3 are shop items.
 *
 * `upgrade_id` tells what an entry is: `1` is a shop item (one sold keeps its place in the list, and
 * was bought all the same), `0` the unlock of one of the hero's abilities, and any other number an
 * upgrade of one.
 *
 * @returns The raw `items` array.
 */
function rawItems() {
  return [
    { item_id: 4_204_808_176, game_time_s: 60, upgrade_id: 1 },
    { item_id: 11, game_time_s: 120, upgrade_id: 1, sold_time_s: 900 },
    { item_id: 12, game_time_s: 180, upgrade_id: 7 },
    { item_id: 13, game_time_s: 240, upgrade_id: 1 },
    { item_id: 14, game_time_s: 300, upgrade_id: 0 },
    { item_id: 15, game_time_s: 360, upgrade_id: 0 },
    { item_id: 16, game_time_s: 420, upgrade_id: 3_123_456_789 },
  ];
}

/**
 * Entries of a player's `items` that all share one `upgrade_id`.
 *
 * @param count - How many entries.
 * @param upgradeId - Their `upgrade_id`.
 * @returns The raw entries.
 */
function rawEntries(count: number, upgradeId: number) {
  return Array.from({ length: count }, (_, index) => ({
    item_id: 100 + index,
    game_time_s: 60 * (index + 1),
    upgrade_id: upgradeId,
  }));
}

/**
 * One player in the shape of the API (fields the app ignores included).
 *
 * The other players have figures of their own, so that a mix-up of players shows in the facts.
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param overrides - Fields to change.
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, overrides: Record<string, unknown> = {}) {
  const tracked = playerSlot === TRACKED_SLOT;
  return {
    account_id: 1_000_000 + playerSlot,
    player_slot: playerSlot,
    team: playerSlot <= 6 ? 0 : 1,
    hero_id: tracked ? PAIGE_HERO_ID : 100 + playerSlot,
    kills: tracked ? 11 : 2,
    deaths: tracked ? 3 : 8,
    assists: tracked ? 17 : 5,
    net_worth: tracked ? 41_250 : 20_000,
    stats: tracked ? rawStats() : [{ time_stamp_s: 180 }],
    items: tracked ? rawItems() : [{ item_id: 1, upgrade_id: 9 }],
    abandon_match_time_s: 0,
    ...overrides,
  };
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads. Team 1 (the tracked player's) wins unless told otherwise.
 *
 * @param options - What to change: fields of the tracked player, fields of `match_info`, or the
 *   whole list of players.
 * @returns The envelope.
 */
function archive(
  options: {
    readonly player?: Record<string, unknown>;
    readonly matchInfo?: Record<string, unknown>;
    readonly players?: readonly unknown[];
  } = {},
): ArchiveEnvelope {
  const slots = Array.from({ length: 12 }, (_, index) => 12 - index);
  const detail = parseMatchMetadata({
    match_info: {
      match_id: 108_501_737,
      start_time: 1_760_000_000,
      duration_s: 2_070,
      game_mode: 1,
      match_mode: 4,
      winning_team: 1,
      players:
        options.players ??
        slots.map((slot) => rawPlayer(slot, slot === TRACKED_SLOT ? options.player : undefined)),
      ...options.matchInfo,
    },
  });
  return createArchiveEnvelope(detail, TRACKED_ACCOUNT, FETCHED_AT);
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

describe('summarizeArchive', () => {
  it('summarises the tracked player of an archive', () => {
    expect(summarizeArchive(archive())).toEqual({
      won: true,
      durationS: 2_070,
      kills: 11,
      deaths: 3,
      assists: 17,
      netWorth: 41_250,
      snapshots: 13,
      // 7 entries of which 3 are shop items (`upgrade_id` 1); the rest unlock or upgrade abilities.
      itemsBought: 3,
      fetchedAt: FETCHED_AT,
    });
  });

  it('reads a defeat', () => {
    expect(summarizeArchive(archive({ matchInfo: { winning_team: 0 } })).won).toBe(false);
  });

  it('reads the tracked player by account id, wherever they are in the list', () => {
    const tracked = rawPlayer(TRACKED_SLOT);
    const others = [1, 2, 3].map((slot) => rawPlayer(slot));

    const facts = summarizeArchive(archive({ players: [tracked, ...others] }));
    const lastFacts = summarizeArchive(archive({ players: [...others, tracked] }));

    expect(facts.kills).toBe(11);
    expect(lastFacts).toEqual(facts);
  });

  it('counts absent arrays as zero', () => {
    const facts = summarizeArchive(archive({ player: { stats: undefined, items: undefined } }));

    expect(facts.snapshots).toBe(0);
    expect(facts.itemsBought).toBe(0);
    // The rest of the facts is unaffected.
    expect(facts.kills).toBe(11);
  });

  it('counts empty arrays as zero', () => {
    const facts = summarizeArchive(archive({ player: { stats: [], items: [] } }));

    expect(facts.snapshots).toBe(0);
    expect(facts.itemsBought).toBe(0);
  });

  it('counts shop items, not ability unlocks', () => {
    // The shape of a real match: 4 ability unlocks, 17 shop items and 9 ability upgrades.
    const items = [...rawEntries(4, 0), ...rawEntries(17, 1), ...rawEntries(9, 7)];

    const facts = summarizeArchive(archive({ player: { items } }));

    expect(facts.itemsBought).toBe(17);
  });

  it('counts no item bought when every entry is an ability unlock or upgrade', () => {
    const facts = summarizeArchive(
      archive({ player: { items: [{ upgrade_id: 0 }, { upgrade_id: 4_000_000_000 }] } }),
    );

    expect(facts.itemsBought).toBe(0);
  });

  it('reads an entry without an upgrade id, which is no item bought', () => {
    // The archive stays readable (this check is the door of the archive); the entry says nothing
    // that makes it a shop item.
    const facts = summarizeArchive(
      archive({ player: { items: [{ item_id: 1, game_time_s: 60 }, ...rawEntries(2, 1)] } }),
    );

    expect(facts.itemsBought).toBe(2);
  });

  it('does not modify the envelope', () => {
    const envelope = archive();
    const before = structuredClone(envelope);

    summarizeArchive(envelope);

    expect(envelope).toEqual(before);
  });

  it('refuses an archive without the tracked player', () => {
    const error = catchAppError(() =>
      summarizeArchive(archive({ players: [rawPlayer(1), rawPlayer(2)] })),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });

  it('never puts a payload value in the error', () => {
    // An archive whose payload lacks the tracked player: neither their account id nor any other
    // account id of the payload may reach the error.
    const envelope = createArchiveEnvelope(
      archive({ players: [rawPlayer(1), rawPlayer(2), rawPlayer(3)] }).payload,
      testAccountId(987_654_321),
      FETCHED_AT,
    );

    const error = catchAppError(() => summarizeArchive(envelope));

    const text = JSON.stringify({ message: error.message, context: error.context });
    expect(error.kind).toBe('invalid_payload');
    expect(text).not.toContain('987654321');
    for (const slot of [1, 2, 3]) {
      expect(text).not.toContain(String(1_000_000 + slot));
    }
  });

  it.each([
    ['kills', { kills: 'S3CR3T' }, 'tracked_player.kills: invalid_type'],
    ['deaths', { deaths: undefined }, 'tracked_player.deaths: invalid_type'],
    ['assists', { assists: -1 }, 'tracked_player.assists: too_small'],
    ['net worth', { net_worth: 1.5 }, 'tracked_player.net_worth: invalid_type'],
    ['stats', { stats: 'S3CR3T' }, 'tracked_player.stats: invalid_type'],
    [
      'items',
      { items: [{ upgrade_id: 'S3CR3T' }] },
      'tracked_player.items.0.upgrade_id: invalid_type',
    ],
  ])('refuses a tracked player whose %s is malformed', (_name, player, issue) => {
    const error = catchAppError(() => summarizeArchive(archive({ player })));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe(issue);
    // The path and the code of the problem, never the value.
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });

  it('refuses an archive whose match has no winning team', () => {
    const error = catchAppError(() =>
      summarizeArchive(archive({ matchInfo: { winning_team: undefined } })),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('match_info.winning_team: invalid_type');
  });
});

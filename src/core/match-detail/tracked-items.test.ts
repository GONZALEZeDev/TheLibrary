/**
 * Tests of the tracked player's items and of their final build.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, an `items` list that mixes shop items and ability entries and is not always
 * sorted) but none of its data.
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
import { finalBuildOf, readTrackedItems } from './tracked-items';
import type { ItemEntry } from './tracked-items';

/** The slot of the tracked player (their team is 1: slots 7 to 12). */
const TRACKED_SLOT = 9;

/** The account of the tracked player. */
const TRACKED_ACCOUNT = testAccountId(1_000_001);

/** When the detail was fetched (Unix milliseconds). */
const FETCHED_AT = 1_760_000_123_456;

/** The `upgrade_id` of a shop item: `0` is an ability unlock, any other number an ability upgrade. */
const SHOP_ITEM = 1;

/** The `upgrade_info` of a shop item: the ability level mask `1` in the high 16 bits. */
const SHOP_UPGRADE_INFO = 1 << 16;

/**
 * One entry of a player's `items` in the shape of the API: a shop item bought and kept, unless the
 * overrides say otherwise.
 *
 * @param itemId - The item (or ability) id.
 * @param gameTimeS - When it was bought, unlocked or upgraded, in seconds.
 * @param overrides - Fields to change.
 * @returns The raw item entry.
 */
function rawItem(itemId: number, gameTimeS: number, overrides: Record<string, unknown> = {}) {
  return {
    item_id: itemId,
    game_time_s: gameTimeS,
    upgrade_id: SHOP_ITEM,
    sold_time_s: 0,
    flags: 0,
    imbued_ability_id: 0,
    upgrade_info: SHOP_UPGRADE_INFO,
    ...overrides,
  };
}

/**
 * One player in the shape of the API (fields the app ignores included).
 *
 * The other players hold items of their own, so that a mix-up of players shows in the result.
 *
 * @param playerSlot - The slot of the player, from 1 to 12.
 * @param overrides - Fields to change.
 * @returns The raw player.
 */
function rawPlayer(playerSlot: number, overrides: Record<string, unknown> = {}) {
  return {
    account_id: 2_000_000 + playerSlot,
    player_slot: playerSlot,
    team: playerSlot <= 6 ? 0 : 1,
    hero_id: playerSlot === TRACKED_SLOT ? PAIGE_HERO_ID : 100 + playerSlot,
    items: [rawItem(9_000 + playerSlot, 100)],
    ...overrides,
  };
}

/**
 * Build an archive envelope of a twelve-player match, validated like the app does.
 *
 * The players are listed by descending slot, as `players[]` is not ordered by slot in real
 * payloads, so the tracked player (slot 9) is the fourth one of the list.
 *
 * @param trackedFields - Fields of the tracked player to change (`items` mostly).
 * @returns The envelope.
 */
function archive(trackedFields: Record<string, unknown> = {}): ArchiveEnvelope {
  const slots = Array.from({ length: 12 }, (_, index) => 12 - index);
  const payload = parseMatchMetadata({
    match_info: {
      match_id: 100_000_001,
      start_time: 1_760_000_000,
      duration_s: 2_070,
      game_mode: 1,
      match_mode: 4,
      players: slots.map((slot) =>
        rawPlayer(slot, slot === TRACKED_SLOT ? { account_id: 1_000_001, ...trackedFields } : {}),
      ),
    },
  });
  return createArchiveEnvelope(payload, TRACKED_ACCOUNT, FETCHED_AT);
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

describe('readTrackedItems', () => {
  it('reads every entry of the tracked player, and only theirs', () => {
    const items = readTrackedItems(
      archive({
        items: [
          rawItem(1_001, 300),
          // An ability unlock: not a shop item.
          rawItem(5_001, 60, { upgrade_id: 0, upgrade_info: SHOP_UPGRADE_INFO }),
          rawItem(1_002, 400, { sold_time_s: 900, flags: 1 }),
        ],
      }),
    );

    expect(items).toEqual([
      { itemId: 5_001, timeS: 60, soldAtS: null, isShopItem: false, imbuedAbilityId: null },
      { itemId: 1_001, timeS: 300, soldAtS: null, isShopItem: true, imbuedAbilityId: null },
      { itemId: 1_002, timeS: 400, soldAtS: 900, isShopItem: true, imbuedAbilityId: null },
    ]);
  });

  it('tells a shop item from an ability unlock and an ability upgrade', () => {
    const items = readTrackedItems(
      archive({
        items: [
          rawItem(2_001, 100, { upgrade_id: SHOP_ITEM }),
          rawItem(2_002, 100, { upgrade_id: 0 }),
          // Upgrade ids are neither 0 nor 1 for an ability upgrade, and never an asset id.
          rawItem(2_003, 100, { upgrade_id: 3_123_456_789 }),
        ],
      }),
    );

    expect(items.map((item) => item.isShopItem)).toEqual([true, false, false]);
  });

  it('sorts unsorted items by time, then by item id', () => {
    const items = readTrackedItems(
      archive({
        items: [rawItem(1_003, 500), rawItem(1_002, 100), rawItem(1_001, 500), rawItem(1_004, 20)],
      }),
    );

    expect(items.map((item) => [item.timeS, item.itemId])).toEqual([
      [20, 1_004],
      [100, 1_002],
      [500, 1_001],
      [500, 1_003],
    ]);
  });

  it('reads items without flags or upgrade info', () => {
    // An older archive: the entries only hold the item, the time and the kind.
    const items = readTrackedItems(
      archive({
        items: [
          { item_id: 1_001, game_time_s: 300, upgrade_id: SHOP_ITEM },
          { item_id: 1_002, game_time_s: 400, upgrade_id: SHOP_ITEM, sold_time_s: 800 },
        ],
      }),
    );

    expect(items).toEqual([
      { itemId: 1_001, timeS: 300, soldAtS: null, isShopItem: true, imbuedAbilityId: null },
      { itemId: 1_002, timeS: 400, soldAtS: 800, isShopItem: true, imbuedAbilityId: null },
    ]);
  });

  it('ignores the flags and the upgrade info, whatever they hold', () => {
    // Neither field is read: a value that is not what the API sends must not make the list unreadable.
    const items = readTrackedItems(
      archive({
        items: [
          rawItem(1_001, 300, { flags: 'S3CR3T', upgrade_info: 'S3CR3T' }),
          rawItem(1_002, 400, { flags: -1.5, upgrade_info: null }),
          rawItem(1_003, 500, { flags: { nested: true }, upgrade_info: [1, 2] }),
        ],
      }),
    );

    expect(items.map((item) => item.itemId)).toEqual([1_001, 1_002, 1_003]);
  });

  it('reads a player without items as holding none', () => {
    expect(readTrackedItems(archive({ items: undefined }))).toEqual([]);
    expect(readTrackedItems(archive({ items: null }))).toEqual([]);
    expect(readTrackedItems(archive({ items: [] }))).toEqual([]);
  });

  it('reads the item an ability was imbued with, and none for 0', () => {
    const items = readTrackedItems(
      archive({
        items: [
          rawItem(1_001, 300, { imbued_ability_id: 5_002 }),
          rawItem(1_002, 400, { imbued_ability_id: 0 }),
        ],
      }),
    );

    expect(items.map((item) => item.imbuedAbilityId)).toEqual([5_002, null]);
  });

  it('does not modify the envelope', () => {
    const envelope = archive({ items: [rawItem(1_002, 500), rawItem(1_001, 100)] });
    const before = structuredClone(envelope);

    readTrackedItems(envelope);

    expect(envelope).toEqual(before);
  });

  it('refuses an archive without the tracked player', () => {
    const envelope = createArchiveEnvelope(
      archive().payload,
      testAccountId(987_654_321),
      FETCHED_AT,
    );

    const error = catchAppError(() => readTrackedItems(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player_missing');
  });

  it.each([
    // The tracked player is the fourth of the list (index 3), the broken entry the second (index 1).
    ['an item id', { item_id: 'S3CR3T' }, 'players.3.items.1.item_id: invalid_type'],
    ['a time', { game_time_s: -1 }, 'players.3.items.1.game_time_s: too_small'],
    ['an upgrade id', { upgrade_id: 1.5 }, 'players.3.items.1.upgrade_id: invalid_type'],
    ['a sale time', { sold_time_s: 'S3CR3T' }, 'players.3.items.1.sold_time_s: invalid_type'],
    [
      'an imbued ability',
      { imbued_ability_id: 'S3CR3T' },
      'players.3.items.1.imbued_ability_id: invalid_type',
    ],
  ])('reports %s that is malformed by path and code only', (_name, fields, issue) => {
    const envelope = archive({ items: [rawItem(1_001, 100), rawItem(1_002, 200, fields)] });

    const error = catchAppError(() => readTrackedItems(envelope));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe(issue);
    // The path and the code of the problem, never the value.
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(
      'S3CR3T',
    );
  });

  it('refuses items that are not a list', () => {
    const error = catchAppError(() => readTrackedItems(archive({ items: 'S3CR3T' })));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('players.3.items: invalid_type');
  });
});

describe('finalBuildOf', () => {
  it('keeps the shop items still owned at the end', () => {
    const items = readTrackedItems(
      archive({
        items: [
          rawItem(1_003, 900, { imbued_ability_id: 5_002 }),
          rawItem(1_001, 300),
          rawItem(1_002, 600),
        ],
      }),
    );

    expect(finalBuildOf(items)).toEqual([
      { itemId: 1_001, boughtAtS: 300, imbuedAbilityId: null },
      { itemId: 1_002, boughtAtS: 600, imbuedAbilityId: null },
      { itemId: 1_003, boughtAtS: 900, imbuedAbilityId: 5_002 },
    ]);
  });

  it('leaves out sold and consumed items and ability entries', () => {
    const items = readTrackedItems(
      archive({
        items: [
          // Kept.
          rawItem(1_001, 300),
          // Sold for souls (`flags` 0 with a sale time).
          rawItem(1_002, 400, { sold_time_s: 2_000 }),
          // Consumed as a component of the upgrade bought at 900 s (`flags` 1).
          rawItem(1_003, 500, { sold_time_s: 900, flags: 1 }),
          // The upgrade that consumed it, kept.
          rawItem(1_004, 900),
          // An ability unlock and an ability upgrade.
          rawItem(5_001, 60, { upgrade_id: 0 }),
          rawItem(5_001, 700, { upgrade_id: 3_123_456_789 }),
        ],
      }),
    );

    expect(finalBuildOf(items).map((entry) => entry.itemId)).toEqual([1_001, 1_004]);
  });

  it('keeps the imbued ability', () => {
    const items = readTrackedItems(
      archive({
        items: [rawItem(1_001, 300, { imbued_ability_id: 5_003 }), rawItem(1_002, 400)],
      }),
    );

    expect(finalBuildOf(items)).toEqual([
      { itemId: 1_001, boughtAtS: 300, imbuedAbilityId: 5_003 },
      { itemId: 1_002, boughtAtS: 400, imbuedAbilityId: null },
    ]);
  });

  it('puts the build in time order whatever the order it is given', () => {
    const entry = (itemId: number, timeS: number): ItemEntry => ({
      itemId,
      timeS,
      soldAtS: null,
      isShopItem: true,
      imbuedAbilityId: null,
    });

    const build = finalBuildOf([entry(1_003, 900), entry(1_002, 300), entry(1_001, 300)]);

    expect(build.map((item) => [item.boughtAtS, item.itemId])).toEqual([
      [300, 1_001],
      [300, 1_002],
      [900, 1_003],
    ]);
  });

  it('gives no build for no items', () => {
    expect(finalBuildOf([])).toEqual([]);
  });
});

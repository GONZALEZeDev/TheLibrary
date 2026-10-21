/**
 * The items of the tracked player in an archived match, and the build they ended with.
 *
 * A player's `items[]` lists everything they bought or unlocked: the shop items, the unlocks of
 * their hero's abilities and the upgrades of those abilities, in no guaranteed order. This module
 * reads that list for the tracked player only (the others' items are of no use to the analysis)
 * with a narrow schema that names the few fields it needs, so that an archive stays readable as the
 * API evolves, and an older archive that lacks a field (or the whole list) is still read.
 *
 * Like every reader of an archive, it never puts a value of the payload in an error: the payload
 * belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { ArchiveEnvelope } from './archive-envelope';
import { archiveCount, readArchiveFields } from './archive-fields';
import { findTrackedPlayer } from './pruning';

/**
 * The `upgrade_id` of a shop item. Any other value is an entry for one of the hero's abilities:
 * `0` is the unlock of an ability, anything else an upgrade of it (such a value is never an asset
 * id).
 */
export const SHOP_ITEM_UPGRADE_ID = 1;

/** One entry of the tracked player's `items[]`: a purchase, an ability unlock or an ability upgrade. */
export interface ItemEntry {
  /** The asset id of the item, or of the ability for an unlock or an upgrade. */
  readonly itemId: number;
  /** When it was bought, unlocked or upgraded, in seconds since the start of the match. */
  readonly timeS: number;
  /**
   * When the item left the inventory (sold for souls, or consumed by the upgrade built from it), in
   * seconds since the start of the match; `null` for an entry that was kept to the end.
   */
  readonly soldAtS: number | null;
  /** `true` for a shop item, `false` for an ability unlock or upgrade. */
  readonly isShopItem: boolean;
  /** The id of the ability the item was imbued into, or `null` when it was not imbued. */
  readonly imbuedAbilityId: number | null;
}

/** One item of the build the tracked player ended the match with. */
export interface FinalBuildEntry {
  /** The asset id of the item. */
  readonly itemId: number;
  /** When it was bought, in seconds since the start of the match. */
  readonly boughtAtS: number;
  /** The id of the ability the item was imbued into, or `null` when it was not imbued. */
  readonly imbuedAbilityId: number | null;
}

/**
 * One entry of `items[]`. The object is loose: every other field is ignored, and so is not
 * checked, such as `upgrade_info` (the mask of an ability's level) and `flags` (which tells a sale
 * for souls from a consumption by an upgrade: both end with a sale time, which is all that is read).
 *
 * An older archive may lack the last two fields, and the API sends `null` for what does not apply,
 * so they accept both.
 */
const itemSchema = z.looseObject({
  item_id: archiveCount,
  game_time_s: archiveCount,
  upgrade_id: archiveCount,
  // `0` means the entry was kept to the end of the match.
  sold_time_s: archiveCount.nullish(),
  // `0` means the item was not imbued into an ability.
  imbued_ability_id: archiveCount.nullish(),
});

/**
 * The part of a player's entry that holds their items. `items` may be absent (an older archive, a
 * player who bought nothing): an absent list counts as empty.
 */
const playerItemsSchema = z.looseObject({ items: z.array(itemSchema).nullish() });

/**
 * Order entries by time, then by id, so that the order never depends on the payload's.
 *
 * @param first - An entry.
 * @param second - Another entry.
 * @returns A negative number when `first` comes first, a positive one when `second` does.
 */
function byTimeThenItem(
  first: Pick<ItemEntry, 'itemId' | 'timeS'>,
  second: Pick<ItemEntry, 'itemId' | 'timeS'>,
): number {
  return first.timeS - second.timeS || first.itemId - second.itemId;
}

/**
 * Turn the payload's way of saying "none" into `null`.
 *
 * @param value - A field that is `0` when it does not apply (a sale time, an ability id), or absent.
 * @returns `null` for `0`, `null` and an absent field; the value otherwise.
 */
function nonZeroOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === 0 ? null : value;
}

/**
 * Read the items of the tracked player of an archive.
 *
 * The tracked player is the one the archive was pruned for. They are found by account id exactly
 * like the pruning does, so an archive that would not have been written (no such player, several of
 * them, not playing Paige) is not read either. The list of the payload is not always sorted by
 * time, so the entries are: by time, then by item id.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns Every entry of the tracked player (shop items and ability entries), sorted; none when
 *   the archive holds no `items` for them.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or an entry is not
 *   what is expected. The context `issue` is one of `findTrackedPlayer`'s
 *   (`tracked_player_missing`…), or `players.<index>.items.<position>.<field>: <code>` (`<index>`
 *   being the position of the player in `match_info.players`, `<position>` that of the entry in
 *   their `items`; `players.<index>.items: <code>` when the list itself is not one); never a value
 *   of the payload.
 */
export function readTrackedItems(envelope: ArchiveEnvelope): readonly ItemEntry[] {
  const { payload, prunedForAccountId } = envelope;
  // Lookup and checks first: past this point, exactly one player has the tracked account id.
  findTrackedPlayer(payload, prunedForAccountId);
  const players = payload.match_info.players;
  const index = players.findIndex((player) => player.account_id === prunedForAccountId);
  const player = readArchiveFields(playerItemsSchema, players[index], `players.${String(index)}`);
  return (player.items ?? [])
    .map((item): ItemEntry => ({
      itemId: item.item_id,
      timeS: item.game_time_s,
      // The payload says `0` for an entry that was never sold, and so does an absent time.
      soldAtS: nonZeroOrNull(item.sold_time_s),
      isShopItem: item.upgrade_id === SHOP_ITEM_UPGRADE_ID,
      imbuedAbilityId: nonZeroOrNull(item.imbued_ability_id),
    }))
    .toSorted(byTimeThenItem);
}

/**
 * The build a player ended the match with.
 *
 * It is made of the shop items that were still in the inventory at the end: the ones sold for
 * souls or consumed by an upgrade are left out, and so are the ability unlocks and upgrades. Each
 * purchase is an entry of its own, so an item that was bought, sold and bought again appears once,
 * with the time of the purchase that was kept.
 *
 * @param items - The entries of the player, in any order, see {@link readTrackedItems}.
 * @returns The items owned at the end, in the order they were bought.
 */
export function finalBuildOf(items: readonly ItemEntry[]): readonly FinalBuildEntry[] {
  return items
    .filter((item) => item.isShopItem && item.soldAtS === null)
    .toSorted(byTimeThenItem)
    .map((item) => ({
      itemId: item.itemId,
      boughtAtS: item.timeS,
      imbuedAbilityId: item.imbuedAbilityId,
    }));
}

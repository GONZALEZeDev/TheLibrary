/**
 * The views of the damage and build tab and of the players tab of the match page, and the arithmetic
 * that builds them.
 *
 * `MatchBreakdownService` (`./match-breakdown.service`) reads what the tabs are made of: the stored
 * projections of the match, its archive and the hero, item and rank catalogues. This module is the
 * pure part that turns those into what the pages show: the build a player ended the match with,
 * named and ordered with the item catalogue (`DamageTabView`), and the twelve players of the
 * scoreboard by team, decorated with their hero and their rank (`PlayersTabView`). Nothing here reads
 * a database, a file or the network, and nothing is logged.
 *
 * Each view is a state that says why there is nothing to show, or the thing to show; the
 * documentation of each type tells what its states mean. What a catalogue cannot tell is told in the
 * view as `null` and never replaced by a made-up value, so that the page shows the id of the hero or
 * of the item instead of a wrong name.
 *
 * The two functions that build a view are {@link describeBuild} and {@link describeTeams}, and
 * {@link PlayerCatalogues} is what the service hands the second; the rest is their parts, kept
 * private so that the view types are the one contract with the pages.
 *
 * @packageDocumentation
 */
import { readableSourceName, type DamageBreakdown } from '../core/analysis/damage-breakdown';
import {
  ITEM_SLOTS,
  MAX_ITEM_TIER,
  type CatalogueItem,
  type CatalogueRank,
  type ItemSlot,
} from '../core/deadlock-api/assets.schema';
import type { HeroAsset } from '../core/domain/hero';
import { badgeParts, rankName } from '../core/domain/rank';
import type { ScoreboardPlayer, ScoreboardRead, StatPlace } from '../core/match-detail/scoreboard';
import type { FinalBuildEntry } from '../core/match-detail/tracked-items';
import type { ItemCatalogue } from './game-asset.service';

/**
 * One item of the build a player ended the match with, named and shown by the item catalogue.
 *
 * An item the catalogue does not know (the game added it after the catalogue was cached, say) keeps
 * `null` for everything the catalogue tells, and the page shows it by its id.
 */
export interface BuildItemView {
  /** The asset id of the item. */
  readonly itemId: number;
  /**
   * The English name: the catalogue's, or its class name made readable when the catalogue has the
   * item but no name for it; `null` when the catalogue does not know the item.
   */
  readonly name: string | null;
  /** The image of the item on the asset bucket, or `null` when it has none or is unknown. */
  readonly imageUrl: string | null;
  /** The slot of the item in the shop, or `null` when it is unknown. */
  readonly slot: ItemSlot | null;
  /** The tier of the item, 1 to 5, or `null` when it is unknown. */
  readonly tier: number | null;
  /** When the item was bought, in seconds since the start of the match. */
  readonly boughtAtS: number;
  /**
   * The English name of the ability the item was imbued into, or `null` when it was not imbued or
   * when the catalogue does not know the ability.
   */
  readonly imbuedInto: string | null;
}

/**
 * What the damage and build tab of the match page shows: a state that says there is nothing to show,
 * or the damage breakdown and the final build.
 *
 * What the damage tab can be told about a match:
 * - `not_analysed`: there is nothing to show. No account is linked, or the detail of the match is
 *   not archived;
 * - `pending`: the match is archived but the projection has not run on it yet, or ran with an older
 *   version of the metrics. The analysis of the match projects it (`AnalysisService.analyseMatch`);
 * - `failed`: the projection could not read the match;
 * - `unreadable`: the archive of the match is gone or damaged, or its items cannot be read. The
 *   detail view of the match explains the archive; this view only has nothing to show, and does not
 *   reset the match;
 * - `catalogue_unavailable`: the loadout of Paige or the item catalogue could not be read, and
 *   there is none cached (offline for good, a request refused). Without them the sources cannot be
 *   told apart nor named, and no half-named table is shown instead;
 * - `ready`: the breakdown, which is `null` when the match has no damage to show (no damage matrix
 *   in the archive, or no damage dealt to heroes), and the build.
 */
export type DamageTabView =
  | { readonly kind: 'not_analysed' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'catalogue_unavailable' }
  | {
      readonly kind: 'ready';
      /** The damage by source, or `null` when the match has no damage to show. */
      readonly breakdown: DamageBreakdown | null;
      /** The items the player ended the match with, in the order the page lists them. */
      readonly build: readonly BuildItemView[];
    };

/**
 * One row of the players tab: a player of the scoreboard, with what the catalogues tell about their
 * hero and their rank.
 *
 * The names are the English ones whatever the language of the interface. A hero the hero catalogue
 * does not know (or the whole catalogue, when it cannot be read) leaves `heroName` and
 * `heroImageUrl` `null`: the page shows the hero by its id. The name of the rank comes from the
 * badge alone, so it is there without the rank catalogue; only the image of the tier needs it.
 */
export interface PlayerRowView extends ScoreboardPlayer {
  /** `true` for the player the account is about: the page marks their row. */
  readonly isTracked: boolean;
  /** The English name of their hero, or `null` when the hero catalogue does not give it. */
  readonly heroName: string | null;
  /** The portrait of their hero on the asset bucket, or `null` when the catalogue has none. */
  readonly heroImageUrl: string | null;
  /**
   * Their rank as the game writes it (`Sentinel 4`), or `null` when they have none to show: the
   * match is not ranked, they have no rank yet, or their badge is no real rank.
   */
  readonly rankName: string | null;
  /**
   * The badge of the tier of their rank on the asset bucket, or `null` when they have no rank to
   * show or the rank catalogue does not give the badge.
   */
  readonly rankImageUrl: string | null;
}

/** One team of the players tab. */
export interface TeamView {
  /** The team, as numbered by the API. */
  readonly team: number;
  /** `true` for the team that won the match. */
  readonly won: boolean;
  /** Its players, by slot. */
  readonly players: readonly PlayerRowView[];
}

/**
 * What the players tab of the match page shows: a state that says there is nothing to show, or the
 * scoreboard.
 *
 * What the players tab can be told about a match:
 * - `not_archived`: there is nothing to show. No account is linked, or the detail of the match is
 *   not archived;
 * - `unreadable`: the archive of the match is gone or damaged, or its scoreboard cannot be read.
 *   Like the damage tab, this view only has nothing to show and does not reset the match;
 * - `ready`: the teams (the tracked player's first), the places of the tracked player, and whether
 *   the match has a top three and is ranked.
 */
export type PlayersTabView =
  | { readonly kind: 'not_archived' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'ready';
      /** The teams of the match, the tracked player's first. */
      readonly teams: readonly TeamView[];
      /** The places of the tracked player among the players, see `placesOf`. */
      readonly places: readonly StatPlace[];
      /** `true` when some player is in Valve's top three; an older match has none. */
      readonly hasTopThree: boolean;
      /** `true` for a ranked match: the only one whose players have a rank to show. */
      readonly ranked: boolean;
    };

/**
 * The name to show for an entry of the item catalogue: its English name, or, for the few entries
 * the catalogue has no name for, its class name made readable (as the damage lines do).
 *
 * @param item - The entry.
 * @returns The name.
 */
function nameOf(item: CatalogueItem): string {
  return item.name ?? readableSourceName(item.className);
}

/**
 * The place of a slot in the list of the build: weapon, vitality, spirit, then no slot.
 *
 * @param slot - The slot of an item, `null` when it has none.
 * @returns The rank, from 0.
 */
function slotRank(slot: ItemSlot | null): number {
  return slot === null ? ITEM_SLOTS.length : ITEM_SLOTS.indexOf(slot);
}

/**
 * Order two items of the build: by slot, then by tier (the lowest first, an item without a tier
 * last), then by the time they were bought, then by id so that the order never depends on the
 * input's.
 *
 * @param first - An item.
 * @param second - Another item.
 * @returns A negative number when `first` comes first, a positive one when `second` does.
 */
function byBuildOrder(first: BuildItemView, second: BuildItemView): number {
  // A number past the highest tier, rather than infinity: `Infinity - Infinity` is `NaN`, which
  // would end the comparison instead of passing on to the next criterion.
  const noTier = MAX_ITEM_TIER + 1;
  return (
    slotRank(first.slot) - slotRank(second.slot) ||
    (first.tier ?? noTier) - (second.tier ?? noTier) ||
    first.boughtAtS - second.boughtAtS ||
    first.itemId - second.itemId
  );
}

/**
 * Describe the items of a final build with the item catalogue.
 *
 * @param entries - The items the player ended the match with.
 * @param catalogue - The item catalogue, to look the items and the abilities they were imbued into
 *   up by id.
 * @returns The items in the order the page lists them (see {@link byBuildOrder}).
 */
export function describeBuild(
  entries: readonly FinalBuildEntry[],
  catalogue: ItemCatalogue,
): readonly BuildItemView[] {
  return entries
    .map((entry): BuildItemView => {
      const item = catalogue.byId.get(entry.itemId);
      const ability =
        entry.imbuedAbilityId === null ? undefined : catalogue.byId.get(entry.imbuedAbilityId);
      return {
        itemId: entry.itemId,
        name: item === undefined ? null : nameOf(item),
        imageUrl: item?.imageUrl ?? null,
        slot: item?.slot ?? null,
        tier: item?.tier ?? null,
        boughtAtS: entry.boughtAtS,
        imbuedInto: ability === undefined ? null : nameOf(ability),
      };
    })
    .toSorted(byBuildOrder);
}

/**
 * What the players view takes from the catalogues. Both only decorate the scoreboard, so each is a
 * lookup that may be empty: a catalogue that could not be read has no entry for anybody.
 */
export interface PlayerCatalogues {
  /** The playable heroes by id: their names and portraits. */
  readonly heroes: ReadonlyMap<number, HeroAsset>;
  /** The rank tiers by tier number: the badge of each. */
  readonly ranks: ReadonlyMap<number, CatalogueRank>;
}

/**
 * Describe a player of the scoreboard with the catalogues.
 *
 * @param player - The player.
 * @param trackedSlot - The slot of the tracked player.
 * @param catalogues - The hero and rank catalogues, which may be empty.
 * @returns The row of the player. A badge that is no real rank (a sub-rank the game never gives) has
 *   neither a name nor an image, like a player who has no badge.
 */
function describePlayer(
  player: ScoreboardPlayer,
  trackedSlot: number,
  catalogues: PlayerCatalogues,
): PlayerRowView {
  const hero = catalogues.heroes.get(player.heroId);
  const parts = player.badge === null ? null : badgeParts(player.badge);
  return {
    ...player,
    isTracked: player.slot === trackedSlot,
    heroName: hero?.name ?? null,
    heroImageUrl: hero?.imageUrl ?? null,
    rankName: player.badge === null ? null : rankName(player.badge),
    rankImageUrl: parts === null ? null : (catalogues.ranks.get(parts.tier)?.imageUrl ?? null),
  };
}

/**
 * Split the players of a scoreboard into their teams.
 *
 * @param read - The scoreboard, whose players are sorted by slot.
 * @param catalogues - The hero and rank catalogues, which may be empty.
 * @returns The teams, the tracked player's first and the others by team number; the players of a
 *   team are in the order of their slots.
 */
export function describeTeams(
  read: ScoreboardRead,
  catalogues: PlayerCatalogues,
): readonly TeamView[] {
  const rows = read.players.map((player) => describePlayer(player, read.trackedSlot, catalogues));
  const trackedTeam = rows.find((row) => row.isTracked)?.team;
  const teams = [...new Set(rows.map((row) => row.team))].toSorted(
    // The tracked player's team sorts before the others, which sort by their number.
    (first, second) =>
      Number(second === trackedTeam) - Number(first === trackedTeam) || first - second,
  );
  return teams.map((team) => ({
    team,
    won: team === read.winningTeam,
    players: rows.filter((row) => row.team === team),
  }));
}

/**
 * Synthetic items and damage of the players of a fixture match, in the shape of deadlock-api's
 * `GET /v1/matches/{match_id}/metadata` where the match analysis reads them.
 *
 * What a real payload looks like, and what this generator reproduces (facts checked on real matches,
 * 2026-10-21):
 * - **Items.** `players[].items[]` lists, for each player, four ability unlocks (`upgrade_id` 0),
 *   the upgrades of those abilities (`upgrade_id` 2 and more, with the level mask in
 *   `upgrade_info`) and the shop items they bought (`upgrade_id` 1). A shop item that left the
 *   inventory has a `sold_time_s`: `flags` 1 when an upgrade consumed it, 0 when it was sold for
 *   souls. At most twelve shop items are kept to the end. Express Shot, the one item the fixture
 *   makes deal damage, is bought between 5:00 and 12:00 in about half the matches;
 * - **Damage.** `damage_matrix` samples the cumulative damage of each dealer, source and target
 *   every 180 s, then at the end of the match. A series is right-aligned on that grid, with the
 *   leading zeros trimmed. Besides the rows of the sources, stat type 0 holds five category rows
 *   (`Bullet`, `Ability`, `Melee`, `UnknownAbility`, `Misc`) that repeat them, and a regeneration
 *   row has stat type 5. The sources of Paige are the class names of her loadout (her weapon, her
 *   melee attack and three signature abilities: Plot Armor deals no damage, so it has no row), and
 *   `upgrade_express_shot` when she owns it. The other heroes' sources are the invented class names
 *   of their fixture loadout;
 * - **Consistency.** At every time the damage grid and the statistics snapshots share, the sum of a
 *   player's sources to enemy heroes is their `stats.player_damage`. The snapshots are every 180 s
 *   up to 900 s (all on the matrix's grid), then every 300 s, so past 900 s most of them (two out of
 *   three) fall between two samples of the matrix: here `player_damage` is read from the matrix
 *   total (see {@link MatchDamage.damageAt}), interpolated between two samples, so it is the same
 *   number on both grids;
 * - **Ownership.** A source that is an item deals damage only while it is owned: its series is 0
 *   before the purchase and stays flat after the sale.
 *
 * Everything is drawn from the generator the caller gives, which must be seeded by the match only:
 * the same match always gives the same items and damage.
 *
 * @packageDocumentation
 */
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import {
  FIXTURE_EXPRESS_SHOT_ID,
  FIXTURE_ITEM_CATALOGUE,
  FIXTURE_PAIGE_ABILITY_IDS,
  FIXTURE_SHOP_ITEM_IDS,
} from './assets.fixture';
import type { RawCatalogueItem } from './assets.fixture';
import { between, pick, shuffled } from './fixture-random';
import type { Random } from './fixture-random';
import { FIXTURE_HERO_CATALOGUE, FIXTURE_PAIGE_ITEMS, fixtureHeroItems } from './heroes.fixture';
import type { RawHeroItems } from './heroes.fixture';

/** Who sits in a slot of the match, as far as the items and the damage are concerned. */
export interface DamageSeat {
  /** The slot, from 1 to 12: the key of their dealer in the matrix. */
  readonly slot: number;
  /** The team (0 or 1): a player damages the players of the other team. */
  readonly team: number;
  /** The hero they play, from the hero catalogue of the fixtures. */
  readonly heroId: number;
}

/** One entry of a player's `items`, in the raw shape of the API (the seven fields it always has). */
export interface RawItemEntry {
  /** The asset id of the shop item, or of the ability for an unlock or an upgrade. */
  readonly item_id: number;
  /** When it was bought, unlocked or upgraded, in seconds since the match start. */
  readonly game_time_s: number;
  /** 0 for an ability unlock, 1 for a shop item, 2 and more for an ability upgrade. */
  readonly upgrade_id: number;
  /** When the item left the inventory, in seconds; 0 when it was kept to the end. */
  readonly sold_time_s: number;
  /** For a shop item that left: 1 when an upgrade consumed it, 0 when it was sold for souls. */
  readonly flags: number;
  /** The ability the item was imbued into; 0 when it was not. */
  readonly imbued_ability_id: number;
  /** The mask of the ability's level (1, 3, 7, 15) shifted left by 16 bits; 1 shifted for an item. */
  readonly upgrade_info: number;
}

/** What one dealer's source did to one target: a cumulative series, right-aligned on the grid. */
interface RawDamageToPlayer {
  readonly target_player_slot: number;
  readonly damage: readonly number[];
}

/** One source of a dealer: an index in the table of sources, and its rows. */
interface RawDamageSource {
  readonly source_details_index: number;
  readonly damage_to_players: readonly RawDamageToPlayer[];
}

/** Everything one dealer did; slot 0 is the dealer that is not a player. */
interface RawDamageDealer {
  readonly dealer_player_slot: number;
  readonly damage_sources: readonly RawDamageSource[];
}

/** The `damage_matrix` of a match detail, in the raw shape of the API. */
export interface RawDamageMatrix {
  /** The times of the samples, in seconds: every 180 s, then the end of the match. */
  readonly sample_time_s: readonly number[];
  /** The table of sources: two parallel lists indexed by `source_details_index`. */
  readonly source_details: {
    readonly stat_type: readonly number[];
    readonly source_name: readonly string[];
  };
  readonly damage_dealers: readonly RawDamageDealer[];
}

/** The items and the damage of every player of a match. */
export interface MatchDamage {
  /** The `damage_matrix` of the detail. */
  readonly matrix: RawDamageMatrix;
  /**
   * The `items` of a player.
   *
   * @param slot - The slot of the player.
   * @returns Their entries, in the order they happened.
   */
  itemsOf(slot: number): readonly RawItemEntry[];
  /**
   * The damage a player had dealt to enemy heroes at a time, all their sources together.
   *
   * It is the total of the matrix, linearly interpolated between two samples and from an implicit
   * point (0 s, no damage) before the first one, so that at a sample time it is exactly the sum of
   * the player's sources at that sample. It never decreases with the time.
   *
   * @param slot - The slot of the player.
   * @param timeS - The time, in seconds since the match start.
   * @returns The cumulative damage, a whole number.
   */
  damageAt(slot: number, timeS: number): number;
}

/** A period of the match during which a player owned an item, in seconds since its start. */
interface OwnedPeriod {
  readonly fromS: number;
  readonly toS: number;
}

/** The items of one player, and what the damage depends on in them. */
interface PlayerBuild {
  readonly items: readonly RawItemEntry[];
  /** When each of the four signature abilities was unlocked, in the order of the loadout. */
  readonly unlockedAtS: readonly number[];
  /** When the player owned Express Shot; `null` when they never bought it. */
  readonly expressShot: OwnedPeriod | null;
}

/** The category rows of the damage matrix, which repeat the rows of the sources they gather. */
type Category = 'Bullet' | 'Ability' | 'Melee' | 'UnknownAbility' | 'Misc';

/** The five categories, in the order the matrix lists them. */
const CATEGORIES: readonly Category[] = ['Bullet', 'Ability', 'Melee', 'UnknownAbility', 'Misc'];

/** A source of damage that a player has, before it is spread over the match. */
interface SourcePlan {
  readonly className: string;
  readonly category: Category;
  /** Its share of the player's damage to heroes, relative to the other sources'. */
  readonly weight: number;
  /** When the source can start to deal damage (an ability is unlocked, an item bought). */
  readonly fromS: number;
  /** When it stops (an item is sold). */
  readonly toS: number;
  /** The fewest and the most enemy heroes it hits. */
  readonly victims: readonly [number, number];
  /** Whether it also hits the target that is not a player (creeps, objectives…). */
  readonly hitsNonPlayer: boolean;
}

/** One row of the matrix before the leading zeros of its series are trimmed. */
interface DamageRow {
  readonly target: number;
  /** The cumulative damage at every sample of the grid. */
  readonly series: readonly number[];
}

/** The rows of a source. */
interface PlannedSource {
  readonly plan: SourcePlan;
  readonly rows: readonly DamageRow[];
}

/** The slot of the target and of the dealer that are not players (neutral creeps, objectives…). */
const NON_PLAYER_SLOT = 0;

/** Seconds between two samples of the damage matrix. */
const MATRIX_STEP_S = 180;

/** The `stat_type` of damage in `source_details`, and of regeneration. */
const DAMAGE_STAT_TYPE = 0;
const REGEN_STAT_TYPE = 5;

/** The source of the regeneration row, which every player has. */
const REGEN_SOURCE_NAME = 'base_stat_regen';

/** The source of the non-player dealer. */
const NEUTRAL_SOURCE_NAME = 'neutral_creeps';

/** The `upgrade_id` of an ability unlock and of a shop item; an upgrade's is at least the third. */
const ABILITY_UNLOCK_UPGRADE_ID = 0;
const SHOP_ITEM_UPGRADE_ID = 1;
const FIRST_ABILITY_UPGRADE_ID = 2;

/** The mask of an ability's level is written this many bits up in `upgrade_info`. */
const UPGRADE_INFO_SHIFT = 16;

/** An ability can be upgraded this many times. */
const MAX_ABILITY_UPGRADES = 3;

/** The chance that an ability gets all its upgrades; it stops sooner otherwise. */
const FULL_UPGRADES_RATE = 0.75;

/** The fewest seconds between two upgrades of an ability. */
const MIN_UPGRADE_GAP_S = 20;

/** The first and the last second an ordinary signature ability can be unlocked at. */
const SIGNATURE_UNLOCK_S: readonly [number, number] = [5, 260];

/** The first and the last second the ultimate can be unlocked at. */
const ULTIMATE_UNLOCK_S: readonly [number, number] = [263, 597];

/** Nothing is bought or upgraded this close to the end of the match, in seconds. */
const END_MARGIN_S = 30;

/** The fewest and the most shop items a player owns at the end of the match. */
const KEPT_ITEMS: readonly [number, number] = [6, 12];

/** The fewest and the most items an upgrade consumes, and that are sold for souls. */
const CONSUMED_ITEMS: readonly [number, number] = [2, 5];
const SOLD_ITEMS: readonly [number, number] = [0, 2];

/** The first second a shop item that is kept is bought at. */
const FIRST_PURCHASE_S = 90;

/** The first second a component that an upgrade consumes is bought at. */
const FIRST_COMPONENT_PURCHASE_S = 30;

/** The first second an item that is sold for souls is bought at. */
const FIRST_SOLD_PURCHASE_S = 60;

/** The earliest and the latest second Express Shot is bought at: between 5:00 and 12:00. */
const EXPRESS_SHOT_PURCHASE_S: readonly [number, number] = [300, 720];

/** The chance that a player buys Express Shot, and that they sell it again after having bought it. */
const EXPRESS_SHOT_RATE = 1 / 2;
const SOLD_AGAIN_RATE = 1 / 6;

/** How long after a purchase an item that is sold for souls leaves the inventory, in seconds. */
const SOLD_AFTER_S: readonly [number, number] = [60, 600];

/** How long after a purchase Express Shot is sold, when it is, in seconds. */
const EXPRESS_SHOT_SOLD_AFTER_S: readonly [number, number] = [120, 900];

/** Where the invented ability ids of the heroes other than Paige start (hero id × 10 is added). */
const OTHER_ABILITY_ID_BASE = 9_300_000;

/**
 * The share of a player's damage to heroes that each kind of source deals, as the smallest and the
 * largest weight: a source's damage is its weight over the weights of all the player's sources.
 */
const WEAPON_WEIGHT: readonly [number, number] = [0.45, 0.65];
const MELEE_WEIGHT: readonly [number, number] = [0.02, 0.05];
const ABILITY_WEIGHT: readonly [number, number] = [0.04, 0.2];
const EXPRESS_SHOT_WEIGHT: readonly [number, number] = [0.05, 0.17];

/** The fewest and the most damage a player deals to enemy heroes in a match. */
const HERO_DAMAGE: readonly [number, number] = [15_000, 60_000];

/** The fewest and the most regeneration a player gets in a match. */
const REGEN_TOTAL: readonly [number, number] = [6_000, 16_000];

/** The most enemy heroes a source can hit: all of them. */
const ALL_ENEMIES = Number.POSITIVE_INFINITY;

/** Class names that deal no damage: Plot Armor is a barrier and a fire-rate buff. */
const NO_DAMAGE_CLASS_NAMES: ReadonlySet<string> = new Set([FIXTURE_PAIGE_ITEMS.signature2]);

/**
 * The entry of the fixture item catalogue that matches, for the ids and class names this module
 * needs: a missing one is a mistake of the fixtures, not of the data.
 *
 * @param description - What is looked for, for the error.
 * @param matches - Tells whether an entry is the one.
 * @returns The entry.
 * @throws Error when the catalogue holds no such entry.
 */
function requireCatalogueEntry(
  description: string,
  matches: (entry: RawCatalogueItem) => boolean,
): RawCatalogueItem {
  const entry = FIXTURE_ITEM_CATALOGUE.find(matches);
  if (entry === undefined) {
    throw new Error(`The fixture item catalogue has no ${description}`);
  }
  return entry;
}

/** The class name of Express Shot, the name of its row in the damage matrix. */
const EXPRESS_SHOT_CLASS_NAME = requireCatalogueEntry(
  'Express Shot',
  (entry) => entry.id === FIXTURE_EXPRESS_SHOT_ID,
).class_name;

/** The id of Mystic Expansion, an item that is imbued into one of the player's abilities. */
const MYSTIC_EXPANSION_ID = requireCatalogueEntry(
  'Mystic Expansion',
  (entry) => entry.class_name === 'upgrade_mystic_expansion',
).id;

/**
 * The shop items a build is drawn from: the whole catalogue but Express Shot, which is decided
 * apart. Coupled to `assets.fixture.ts`: it has 20 shop items, so 19 here, which is exactly what the
 * biggest build asks for (12 kept + 5 consumed + 2 sold). A build takes each item at most once, so
 * the catalogue must not lose an item without the three ranges above (`KEPT_ITEMS`,
 * `CONSUMED_ITEMS`, `SOLD_ITEMS`) shrinking with it.
 */
const BUILD_SHOP_ITEM_IDS: readonly number[] = FIXTURE_SHOP_ITEM_IDS.filter(
  (itemId) => itemId !== FIXTURE_EXPRESS_SHOT_ID,
);

// Fail at once, and loudly, when the pool cannot cover the biggest build: a short pool would only
// give smaller builds (a silent change of the data), not an error.
const MOST_SHOP_ITEMS_PER_BUILD = KEPT_ITEMS[1] + CONSUMED_ITEMS[1] + SOLD_ITEMS[1];
if (BUILD_SHOP_ITEM_IDS.length < MOST_SHOP_ITEMS_PER_BUILD) {
  throw new Error(
    `The fixture item catalogue has ${String(BUILD_SHOP_ITEM_IDS.length)} shop items besides Express Shot, ` +
      `fewer than the ${String(MOST_SHOP_ITEMS_PER_BUILD)} the biggest build takes`,
  );
}

/**
 * A pseudo-random whole number from a range given as a pair.
 *
 * @param random - The generator.
 * @param range - The smallest and the largest value (included).
 * @returns A whole number inside the range.
 */
function betweenRange(random: Random, range: readonly [number, number]): number {
  return between(random, range[0], range[1]);
}

/**
 * A pseudo-random second of the match, inside a range that the end of a short match may cut.
 *
 * @param random - The generator.
 * @param minS - Earliest second.
 * @param maxS - Latest second (included).
 * @returns A second from `minS` to `maxS`, or `maxS` when `minS` is past it.
 */
function timeBetween(random: Random, minS: number, maxS: number): number {
  return between(random, Math.min(minS, maxS), maxS);
}

/**
 * A pseudo-random fraction from a range given as a pair.
 *
 * @param random - The generator.
 * @param range - The smallest and the largest value.
 * @returns A number from the smallest to the largest.
 */
function fractionBetween(random: Random, range: readonly [number, number]): number {
  return range[0] + (range[1] - range[0]) * random();
}

/**
 * Invent the items and the damage of the players of a match.
 *
 * @param random - The generator, seeded by the match; it is consumed.
 * @param seats - The twelve players.
 * @param durationS - Length of the match, in seconds.
 * @returns The `damage_matrix` of the detail, the `items` of every player and the damage they had
 *   dealt at any time.
 */
export function createMatchDamage(
  random: Random,
  seats: readonly DamageSeat[],
  durationS: number,
): MatchDamage {
  const builds = new Map(seats.map((seat) => [seat.slot, createItems(random, seat, durationS)]));
  const { matrix, totals } = createDamageMatrix(random, seats, builds, durationS);
  return {
    matrix,
    itemsOf: (slot) => requireSlot(builds, slot).items,
    damageAt: (slot, timeS) => interpolate(matrix.sample_time_s, requireSlot(totals, slot), timeS),
  };
}

/**
 * What is kept for a player, by slot.
 *
 * @param bySlot - What is kept for each player.
 * @param slot - The slot of a player of the match.
 * @returns What is kept for that player.
 * @throws Error when no player sits in that slot: a mistake of the caller, not of the data.
 */
function requireSlot<T>(bySlot: ReadonlyMap<number, T>, slot: number): T {
  const found = bySlot.get(slot);
  if (found === undefined) {
    throw new Error(`No player in slot ${String(slot)}`);
  }
  return found;
}

/**
 * The ids of the four signature abilities of a hero, in the order of its loadout.
 *
 * Paige's are the real ones of the item catalogue; the other heroes' are invented.
 *
 * @param heroId - The hero.
 * @returns The ids of `signature1` to `signature4` (the ultimate).
 */
function abilityIdsOf(heroId: number): readonly number[] {
  return heroId === PAIGE_HERO_ID
    ? FIXTURE_PAIGE_ABILITY_IDS
    : Array.from({ length: 4 }, (_, index) => OTHER_ABILITY_ID_BASE + heroId * 10 + index);
}

/**
 * The weapon, the melee attack and the signature abilities of a hero.
 *
 * @param heroId - The hero.
 * @returns Its loadout in the fixture hero catalogue; a hero that is not in it (a test may seat any
 *   hero id) gets an invented one, like the heroes of the catalogue other than Paige.
 */
function loadoutOf(heroId: number): RawHeroItems {
  const hero = FIXTURE_HERO_CATALOGUE.find((candidate) => candidate.id === heroId);
  return hero?.items ?? fixtureHeroItems(`hero_unlisted_${String(heroId)}`);
}

/**
 * The class names of the four signature abilities of a loadout, the ultimate last.
 *
 * @param loadout - The loadout.
 * @returns `signature1` to `signature4`.
 */
function signaturesOf(loadout: RawHeroItems): readonly string[] {
  return [loadout.signature1, loadout.signature2, loadout.signature3, loadout.signature4];
}

/** What tells the kinds of entry of `items` apart; every field left out is 0. */
interface ItemEntryFields {
  /** 0 for an ability unlock, 1 for a shop item, 2 and more for an ability upgrade. */
  readonly upgradeId: number;
  /** The mask of the ability's level, shifted. */
  readonly upgradeInfo: number;
  /** When the item left the inventory. */
  readonly soldAtS?: number;
  /** Whether an upgrade consumed the item when it left. */
  readonly consumed?: boolean;
  /** The ability the item was imbued into. */
  readonly imbuedAbilityId?: number;
}

/**
 * Write an entry of `items`.
 *
 * @param itemId - The item or the ability.
 * @param timeS - When it happened.
 * @param fields - The fields that tell what kind of entry it is; the others are 0.
 * @returns The entry.
 */
function itemEntry(itemId: number, timeS: number, fields: ItemEntryFields): RawItemEntry {
  return {
    item_id: itemId,
    game_time_s: timeS,
    upgrade_id: fields.upgradeId,
    sold_time_s: fields.soldAtS ?? 0,
    flags: fields.consumed === true ? 1 : 0,
    imbued_ability_id: fields.imbuedAbilityId ?? 0,
    upgrade_info: fields.upgradeInfo,
  };
}

/**
 * The `upgrade_info` of an ability at a level: the mask of the levels it has, shifted.
 *
 * @param level - 0 for the unlock, 1 to 3 for the upgrades.
 * @returns 1, 3, 7 or 15, shifted left by 16 bits.
 */
function levelInfo(level: number): number {
  return ((1 << (level + 1)) - 1) << UPGRADE_INFO_SHIFT;
}

/**
 * Invent the `items` of a player: the unlocks and upgrades of their abilities, and the shop items
 * they bought, sold or kept.
 *
 * @param random - The generator.
 * @param seat - The player.
 * @param durationS - Length of the match, in seconds.
 * @returns The entries in the order they happened, and what the damage depends on.
 */
function createItems(random: Random, seat: DamageSeat, durationS: number): PlayerBuild {
  const lastTimeS = Math.max(END_MARGIN_S, durationS - END_MARGIN_S);
  const abilityIds = abilityIdsOf(seat.heroId);
  // The first three abilities come early, the ultimate a few minutes in.
  const unlockedAtS = abilityIds.map((_, index) =>
    index === abilityIds.length - 1
      ? timeBetween(random, ULTIMATE_UNLOCK_S[0], Math.min(ULTIMATE_UNLOCK_S[1], lastTimeS))
      : timeBetween(random, SIGNATURE_UNLOCK_S[0], Math.min(SIGNATURE_UNLOCK_S[1], lastTimeS)),
  );
  const abilityEntries = abilityIds.flatMap((abilityId, index) =>
    abilityEntriesOf(random, abilityId, index, unlockedAtS[index] ?? 0, lastTimeS),
  );
  const shop = createShopItems(random, durationS, lastTimeS, abilityIds);
  return {
    items: [...abilityEntries, ...shop.entries].toSorted(
      (first, second) => first.game_time_s - second.game_time_s,
    ),
    unlockedAtS,
    expressShot: shop.expressShot,
  };
}

/**
 * The entries of one ability: its unlock, then the upgrades the player bought.
 *
 * @param random - The generator.
 * @param abilityId - The id of the ability.
 * @param abilityIndex - Its position among the hero's four signature abilities.
 * @param unlockS - When it was unlocked.
 * @param lastTimeS - The last second anything is upgraded at.
 * @returns The unlock and the upgrades, each upgrade later than the one before.
 */
function abilityEntriesOf(
  random: Random,
  abilityId: number,
  abilityIndex: number,
  unlockS: number,
  lastTimeS: number,
): RawItemEntry[] {
  const entries = [
    itemEntry(abilityId, unlockS, {
      upgradeId: ABILITY_UNLOCK_UPGRADE_ID,
      upgradeInfo: levelInfo(0),
    }),
  ];
  const upgradeCount =
    random() < FULL_UPGRADES_RATE
      ? MAX_ABILITY_UPGRADES
      : between(random, 0, MAX_ABILITY_UPGRADES - 1);
  let timeS = unlockS;
  for (let level = 1; level <= upgradeCount; level += 1) {
    timeS = timeBetween(random, timeS + MIN_UPGRADE_GAP_S, lastTimeS);
    entries.push(
      itemEntry(abilityId, timeS, {
        // The same upgrade of the same ability has the same id in every match.
        upgradeId: FIRST_ABILITY_UPGRADE_ID + abilityIndex * MAX_ABILITY_UPGRADES + level - 1,
        upgradeInfo: levelInfo(level),
      }),
    );
  }
  return entries;
}

/**
 * The shop items of a player.
 *
 * Express Shot is decided first. The others come from the catalogue, each at most once: those the
 * player keeps (no more than twelve in all), those an upgrade consumed (sold in the second the
 * upgrade was bought, with `flags` 1), and a few they sold for souls (`flags` 0).
 *
 * @param random - The generator.
 * @param durationS - Length of the match, in seconds.
 * @param lastTimeS - The last second anything is bought at.
 * @param abilityIds - The player's four ability ids, one of which Mystic Expansion is imbued into.
 * @returns The entries, and the period Express Shot was owned.
 */
function createShopItems(
  random: Random,
  durationS: number,
  lastTimeS: number,
  abilityIds: readonly number[],
): { entries: RawItemEntry[]; expressShot: OwnedPeriod | null } {
  const buysExpressShot = random() < EXPRESS_SHOT_RATE;
  const sellsExpressShot = buysExpressShot && random() < SOLD_AGAIN_RATE;
  // The inventory has twelve slots, Express Shot's included when it is kept.
  const keptTotal = betweenRange(random, KEPT_ITEMS);
  const keptCount = keptTotal - (buysExpressShot && !sellsExpressShot ? 1 : 0);
  const consumedCount = betweenRange(random, CONSUMED_ITEMS);
  const soldCount = betweenRange(random, SOLD_ITEMS);
  const pool = shuffled(random, BUILD_SHOP_ITEM_IDS);

  const shopEntry = (
    itemId: number,
    boughtS: number,
    leaving: Pick<ItemEntryFields, 'soldAtS' | 'consumed'> = {},
  ) =>
    itemEntry(itemId, boughtS, {
      upgradeId: SHOP_ITEM_UPGRADE_ID,
      upgradeInfo: levelInfo(0),
      ...leaving,
      ...(itemId === MYSTIC_EXPANSION_ID ? { imbuedAbilityId: pick(random, abilityIds) } : {}),
    });

  const kept = pool.slice(0, keptCount).map((itemId) => ({
    itemId,
    boughtS: timeBetween(random, FIRST_PURCHASE_S, lastTimeS),
  }));
  // A component is consumed by an upgrade the player bought later and kept.
  const consumed = pool.slice(keptCount, keptCount + consumedCount).map((itemId) => {
    const upgrade = pick(random, kept);
    const boughtS = timeBetween(random, FIRST_COMPONENT_PURCHASE_S, upgrade.boughtS - 1);
    return shopEntry(itemId, boughtS, { soldAtS: upgrade.boughtS, consumed: true });
  });
  const sold = pool
    .slice(keptCount + consumedCount, keptCount + consumedCount + soldCount)
    .map((itemId) => {
      const boughtS = timeBetween(random, FIRST_SOLD_PURCHASE_S, lastTimeS);
      return shopEntry(itemId, boughtS, {
        soldAtS: Math.min(durationS, boughtS + betweenRange(random, SOLD_AFTER_S)),
      });
    });

  let expressShot: OwnedPeriod | null = null;
  const expressShotEntries: RawItemEntry[] = [];
  if (buysExpressShot) {
    const boughtS = timeBetween(
      random,
      EXPRESS_SHOT_PURCHASE_S[0],
      Math.min(EXPRESS_SHOT_PURCHASE_S[1], lastTimeS),
    );
    const soldAtS = sellsExpressShot
      ? Math.min(durationS, boughtS + betweenRange(random, EXPRESS_SHOT_SOLD_AFTER_S))
      : undefined;
    expressShot = { fromS: boughtS, toS: soldAtS ?? durationS };
    expressShotEntries.push(
      shopEntry(FIXTURE_EXPRESS_SHOT_ID, boughtS, soldAtS === undefined ? {} : { soldAtS }),
    );
  }
  return {
    entries: [
      ...expressShotEntries,
      ...kept.map(({ itemId, boughtS }) => shopEntry(itemId, boughtS)),
      ...consumed,
      ...sold,
    ],
    expressShot,
  };
}

/**
 * The times of the damage matrix's samples: every 180 s, then the end of the match.
 *
 * @param durationS - Length of the match, in seconds.
 * @returns The times in strictly ascending order; the last one is `durationS`.
 */
function sampleTimes(durationS: number): number[] {
  const times: number[] = [];
  for (let timeS = MATRIX_STEP_S; timeS < durationS; timeS += MATRIX_STEP_S) {
    times.push(timeS);
  }
  times.push(durationS);
  return times;
}

/**
 * The table of the sources of a matrix, filled as the dealers use them: the same name with two
 * stat types is two entries.
 *
 * @returns The two parallel lists of the payload, and the index of a source in them.
 */
function createSourceTable() {
  const statTypes: number[] = [];
  const names: string[] = [];
  const indexes = new Map<string, number>();
  return {
    details: { stat_type: statTypes, source_name: names },
    /**
     * The index of a source in the table, which adds the source the first time it is asked for.
     *
     * @param statType - The stat type of the source.
     * @param name - Its name.
     * @returns Its `source_details_index`.
     */
    indexOf(statType: number, name: string): number {
      const key = `${String(statType)}:${name}`;
      const known = indexes.get(key);
      if (known !== undefined) {
        return known;
      }
      statTypes.push(statType);
      names.push(name);
      indexes.set(key, names.length - 1);
      return names.length - 1;
    },
  };
}

/** The table of sources that {@link createSourceTable} makes. */
type SourceTable = ReturnType<typeof createSourceTable>;

/**
 * Invent the damage matrix: who damaged whom, with which source, over time.
 *
 * Every player is a dealer, and the non-player dealer (slot 0) hits everybody. For a player, see
 * {@link createDealer}.
 *
 * @param random - The generator.
 * @param seats - The twelve players.
 * @param builds - The items of each player, by slot.
 * @param durationS - Length of the match, in seconds.
 * @returns The matrix, and the damage of each player to enemy heroes at every sample, by slot.
 */
function createDamageMatrix(
  random: Random,
  seats: readonly DamageSeat[],
  builds: ReadonlyMap<number, PlayerBuild>,
  durationS: number,
): { matrix: RawDamageMatrix; totals: ReadonlyMap<number, readonly number[]> } {
  const times = sampleTimes(durationS);
  const table = createSourceTable();
  const totals = new Map<number, readonly number[]>();
  const playerDealers = seats.map((seat): RawDamageDealer => {
    const build = requireSlot(builds, seat.slot);
    const enemySlots = seats
      .filter((other) => other.team !== seat.team)
      .map((other) => other.slot)
      .toSorted((first, second) => first - second);
    const { dealer, total } = createDealer(random, seat, build, enemySlots, times, table);
    totals.set(seat.slot, total);
    return dealer;
  });
  const neutralDealer: RawDamageDealer = {
    dealer_player_slot: NON_PLAYER_SLOT,
    damage_sources: [
      {
        source_details_index: table.indexOf(DAMAGE_STAT_TYPE, NEUTRAL_SOURCE_NAME),
        // The creeps hit every player, one to eight damage per second of the match.
        damage_to_players: seats
          .map((seat) => seat.slot)
          .toSorted((first, second) => first - second)
          .map((slot) => ({
            target_player_slot: slot,
            damage: trimLeadingZeros(
              cumulativeSeries(random, times, between(random, 1, 8) * durationS, 0, durationS),
            ),
          })),
      },
    ],
  };
  return {
    matrix: {
      sample_time_s: times,
      source_details: table.details,
      damage_dealers: [neutralDealer, ...playerDealers],
    },
    totals,
  };
}

/**
 * Invent everything one player dealt, as a dealer of the matrix.
 *
 * The player has a budget of damage to enemy heroes, which their sources share by weight. A source
 * hits several enemy heroes (a weapon hits all of them, and the non-player target too). Each of its
 * rows is a series on the whole grid, which is then trimmed. The rows are followed by the five
 * category rows, which add up the rows of their category (a category with no source has rows of
 * zeros), and by the regeneration row.
 *
 * @param random - The generator.
 * @param seat - The player.
 * @param build - Their items: when their abilities were unlocked, when they owned Express Shot.
 * @param enemySlots - The slots of the other team.
 * @param times - The times of the samples.
 * @param table - The table of sources, which the dealer's sources are added to.
 * @returns The dealer, and its damage to enemy heroes at every sample (what the sources of the
 *   damage rows add up to).
 */
function createDealer(
  random: Random,
  seat: DamageSeat,
  build: PlayerBuild,
  enemySlots: readonly number[],
  times: readonly number[],
  table: SourceTable,
): { dealer: RawDamageDealer; total: number[] } {
  const durationS = times.at(-1) ?? 0;
  const plans = planSources(random, seat, build, durationS);
  const budget = betweenRange(random, HERO_DAMAGE);
  const weightSum = plans.reduce((sum, plan) => sum + plan.weight, 0);
  const sources = plans
    .map((plan): PlannedSource => ({
      plan,
      rows: createRows(random, plan, (budget * plan.weight) / weightSum, enemySlots, times),
    }))
    // A source that dealt nothing (an item bought at the end) has no row.
    .filter((source) => source.rows.length > 0);

  const toRaw = (rows: readonly DamageRow[]) =>
    rows.map(({ target, series }) => ({
      target_player_slot: target,
      damage: trimLeadingZeros(series),
    }));
  const damageSources: RawDamageSource[] = sources.map(({ plan, rows }) => ({
    source_details_index: table.indexOf(DAMAGE_STAT_TYPE, plan.className),
    damage_to_players: toRaw(rows),
  }));
  const categorySources = CATEGORIES.map((category): RawDamageSource => {
    const rows = sources
      .filter(({ plan }) => plan.category === category)
      .flatMap((source) => source.rows);
    // A category with no source still has its row, aimed at the enemies, with nothing in it.
    const targets =
      rows.length === 0
        ? enemySlots
        : [...new Set(rows.map((row) => row.target))].toSorted((first, second) => first - second);
    return {
      source_details_index: table.indexOf(DAMAGE_STAT_TYPE, category),
      damage_to_players: toRaw(
        targets.map((target) => ({
          target,
          series: sumSeries(
            rows.filter((row) => row.target === target).map((row) => row.series),
            times.length,
          ),
        })),
      ),
    };
  });
  // Regeneration is not damage (stat type 5): it is aimed at the dealer themselves.
  const regenSource: RawDamageSource = {
    source_details_index: table.indexOf(REGEN_STAT_TYPE, REGEN_SOURCE_NAME),
    damage_to_players: [
      {
        target_player_slot: seat.slot,
        damage: trimLeadingZeros(
          cumulativeSeries(random, times, betweenRange(random, REGEN_TOTAL), 0, durationS),
        ),
      },
    ],
  };

  // The damage to enemy heroes is what the sources dealt to them: the non-player target is not one,
  // and the category rows are not sources.
  const total = sumSeries(
    sources.flatMap(({ rows }) =>
      rows.filter((row) => row.target !== NON_PLAYER_SLOT).map((row) => row.series),
    ),
    times.length,
  );
  return {
    dealer: {
      dealer_player_slot: seat.slot,
      damage_sources: [...damageSources, ...categorySources, regenSource],
    },
    total,
  };
}

/**
 * The sources a player deals damage with.
 *
 * Their weapon and their melee attack from the start of the match, each signature ability from its
 * unlock (except those that never deal damage), and Express Shot while they own it.
 *
 * @param random - The generator.
 * @param seat - The player.
 * @param build - Their items.
 * @param durationS - Length of the match, in seconds.
 * @returns The sources, with their relative weights.
 */
function planSources(
  random: Random,
  seat: DamageSeat,
  build: PlayerBuild,
  durationS: number,
): SourcePlan[] {
  const loadout = loadoutOf(seat.heroId);
  const plans: SourcePlan[] = [
    {
      className: loadout.weapon_primary,
      category: 'Bullet',
      weight: fractionBetween(random, WEAPON_WEIGHT),
      fromS: 0,
      toS: durationS,
      victims: [ALL_ENEMIES, ALL_ENEMIES],
      hitsNonPlayer: true,
    },
    {
      className: loadout.weapon_melee,
      category: 'Melee',
      weight: fractionBetween(random, MELEE_WEIGHT),
      fromS: 0,
      toS: durationS,
      // A melee attack lands on at least three of the enemies; an ability, below, on two to five.
      victims: [3, ALL_ENEMIES],
      hitsNonPlayer: false,
    },
  ];
  for (const [index, className] of signaturesOf(loadout).entries()) {
    if (!NO_DAMAGE_CLASS_NAMES.has(className)) {
      plans.push({
        className,
        category: 'Ability',
        weight: fractionBetween(random, ABILITY_WEIGHT),
        fromS: build.unlockedAtS[index] ?? 0,
        toS: durationS,
        victims: [2, 5],
        hitsNonPlayer: false,
      });
    }
  }
  if (build.expressShot !== null) {
    plans.push({
      className: EXPRESS_SHOT_CLASS_NAME,
      // The category of an item is invented: the real one is not known.
      category: 'Misc',
      weight: fractionBetween(random, EXPRESS_SHOT_WEIGHT),
      fromS: build.expressShot.fromS,
      toS: build.expressShot.toS,
      victims: [ALL_ENEMIES, ALL_ENEMIES],
      hitsNonPlayer: false,
    });
  }
  return plans;
}

/**
 * Spread the damage of a source over the enemy heroes it hits, as one row per target.
 *
 * @param random - The generator.
 * @param plan - The source.
 * @param heroDamage - The damage the source deals to enemy heroes in all, over the whole match.
 * @param enemySlots - The slots of the other team.
 * @param times - The times of the samples.
 * @returns The rows, ordered by target. A row that ends with no damage is left out.
 */
function createRows(
  random: Random,
  plan: SourcePlan,
  heroDamage: number,
  enemySlots: readonly number[],
  times: readonly number[],
): DamageRow[] {
  const victimCount = between(
    random,
    Math.min(plan.victims[0], enemySlots.length),
    Math.min(plan.victims[1], enemySlots.length),
  );
  const victims = shuffled(random, enemySlots)
    .slice(0, victimCount)
    .map((slot) => ({ slot, weight: 0.5 + random() }));
  const weightSum = victims.reduce((sum, victim) => sum + victim.weight, 0);
  const finals = victims.map(({ slot, weight }) => ({
    target: slot,
    finalDamage: Math.round((heroDamage * weight) / weightSum),
  }));
  if (plan.hitsNonPlayer) {
    // The non-player target takes a part of the damage that the heroes did not.
    finals.push({
      target: NON_PLAYER_SLOT,
      finalDamage: Math.round(heroDamage * (0.1 + 0.2 * random())),
    });
  }
  return finals
    .map(({ target, finalDamage }) => ({
      target,
      series: cumulativeSeries(random, times, finalDamage, plan.fromS, plan.toS),
    }))
    .filter((row) => (row.series.at(-1) ?? 0) > 0)
    .toSorted((first, second) => first.target - second.target);
}

/**
 * A running total sampled at some times, growing only while the source is active.
 *
 * The total of each interval between two samples is proportional to the time the source was active
 * in it, to a random factor, and to a factor that grows with the match (players deal more damage
 * with more souls). Nothing is added before `fromS` or after `toS`, so the total is 0 before and
 * flat after. The last value is exactly `finalTotal`.
 *
 * @param random - The generator, for the irregularity of each interval.
 * @param times - The sample times, in seconds, in ascending order.
 * @param finalTotal - The total at the last sample; a whole number.
 * @param fromS - When the source starts to deal damage.
 * @param toS - When it stops.
 * @returns One total per time; never decreasing. All zeros when the source was never active.
 */
function cumulativeSeries(
  random: Random,
  times: readonly number[],
  finalTotal: number,
  fromS: number,
  toS: number,
): number[] {
  const endS = times.at(-1) ?? 1;
  // The weight of the source's activity up to each sample.
  const weightUpTo: number[] = [];
  let weight = 0;
  let previousS = 0;
  for (const timeS of times) {
    const activeS = Math.max(0, Math.min(timeS, toS) - Math.max(previousS, fromS));
    weight += activeS * (0.5 + random()) * (1 + timeS / endS);
    weightUpTo.push(weight);
    previousS = timeS;
  }
  // The last weight is the whole of it, so the last value is exactly `finalTotal`.
  return weight === 0
    ? weightUpTo.map(() => 0)
    : weightUpTo.map((weightSoFar) => Math.round((finalTotal * weightSoFar) / weight));
}

/**
 * Drop the leading zeros of a cumulative series: the payload right-aligns a series on the grid.
 *
 * @param series - A series with one value per sample.
 * @returns The series from its first positive value; empty when it never left 0.
 */
function trimLeadingZeros(series: readonly number[]): number[] {
  const first = series.findIndex((value) => value > 0);
  return first === -1 ? [] : series.slice(first);
}

/**
 * Add series of the same length, sample by sample.
 *
 * @param list - The series.
 * @param length - Their length (and the length of the result, when there is no series).
 * @returns Their sum.
 */
function sumSeries(list: readonly (readonly number[])[], length: number): number[] {
  return Array.from({ length }, (_, position) =>
    list.reduce((sum, series) => sum + (series[position] ?? 0), 0),
  );
}

/**
 * The value of a cumulative series at a time, interpolated between its two samples.
 *
 * The series starts from an implicit point (0 s, 0) and ends flat after its last sample. At a
 * sample time the value is exactly the sample.
 *
 * @param times - The sample times, strictly ascending.
 * @param values - One value per sample, never decreasing.
 * @param timeS - The time to read the series at.
 * @returns A whole number; between two samples, the nearest to the straight line.
 */
function interpolate(times: readonly number[], values: readonly number[], timeS: number): number {
  let previousS = 0;
  let previousValue = 0;
  for (const [position, sampleS] of times.entries()) {
    const value = values[position] ?? previousValue;
    if (timeS <= sampleS) {
      const fraction = (timeS - previousS) / (sampleS - previousS);
      return previousValue + Math.round((value - previousValue) * fraction);
    }
    previousS = sampleS;
    previousValue = value;
  }
  return previousValue;
}

/**
 * Item and rank catalogues served by the development HTTP client, in the shape of deadlock-api's
 * `GET /v1/assets/items` and `GET /v1/assets/ranks` (reduced to the fields the app reads and a few
 * more).
 *
 * The real item catalogue holds 781 entries and weighs 6.5 MB; the fixture holds the few dozen the
 * fixtures need, so that the development app and the tests have names and images to show:
 * - Paige's weapon, melee attack and four signature abilities, with the real class names and ids of
 *   the game data (public game data, 2026-10-21);
 * - the signature ability of another hero (Infernus), and an innate ability without a name, as the
 *   real catalogue has (220 of its entries have an empty name or one equal to the class name);
 * - thirty shop items over the three slots and the tiers 1 to 4. Twenty are items Paige players
 *   ended their matches with (names, slots and tiers); ten were added so that the twelve resistance
 *   items of the review are all there. Those twelve and Express Shot have their real ids, and the
 *   twelve their real class names, since the review finds them by class name and the community
 *   statistics by id. The other ids are invented (from 9,100,001), so that no fixture match quotes a
 *   real build.
 *
 * Every image link is on the asset bucket, except the sub-rank images of the rank catalogue, which
 * the real API serves from its own host (the release Content Security Policy does not allow them,
 * and the parser leaves them out).
 *
 * The ids that the fixture matches (`match-metadata.fixture.ts`) buy, unlock and damage with are
 * exported below, so that a match and its catalogue always agree.
 *
 * @packageDocumentation
 */
import { RESISTANCE_ITEMS } from '../../../core/analysis/review/resistance-items';
import { ASSET_IMAGE_ORIGIN } from '../../../core/deadlock-api/assets.schema';
import { DEADLOCK_API_BASE_URL } from '../../../core/deadlock-api/endpoints';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import { FIXTURE_PAIGE_ITEMS, fixtureHeroItems } from './heroes.fixture';

/** Folder of the ability and weapon images on the asset bucket. */
const ABILITY_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/abilities`;

/** Folder of the shop images on the asset bucket; one subfolder per slot. */
const SHOP_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/items`;

/** Folder of the rank images on the asset bucket. */
const RANK_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/ranks`;

/** What every entry of the item catalogue has, whatever its kind. */
interface RawEntry {
  readonly id: number;
  readonly class_name: string;
  /** English name; empty for some entries, like the real catalogue's. */
  readonly name: string;
  /** Image of the ability or weapon (`null` when the entry has none). */
  readonly image: string | null;
  readonly image_webp: string | null;
}

/** An ability of a hero, or an innate ability every hero shares. */
interface RawAbility extends RawEntry {
  readonly type: 'ability';
  readonly ability_type: 'signature' | 'ultimate' | 'melee' | 'innate';
  /** Id of the hero the ability belongs to. */
  readonly hero: number;
}

/** A hero's weapon. */
interface RawWeapon extends RawEntry {
  readonly type: 'weapon';
  readonly hero: number;
}

/** A shop item, the kind of entry a player buys during a match. */
interface RawShopItem extends RawEntry {
  readonly type: 'upgrade';
  readonly item_slot_type: ShopSlot;
  /** Tier of the item, 1 to 5. */
  readonly item_tier: number;
  readonly cost: number;
  readonly shopable: boolean;
  readonly disabled: boolean;
  /** The picture of the item in the shop. */
  readonly shop_image: string;
  readonly shop_image_webp: string;
}

/** An entry of the item catalogue, in the raw shape of the API (subset of the fields). */
export type RawCatalogueItem = RawAbility | RawWeapon | RawShopItem;

/** Slot of a shop item, as the API names it. */
type ShopSlot = 'weapon' | 'vitality' | 'spirit';

/** Real id of Express Shot (`upgrade_express_shot`), a tier 3 weapon item that deals damage. */
export const FIXTURE_EXPRESS_SHOT_ID = 690458959;

/**
 * The real ids of Paige's four signature abilities, in slot order: Bookwyrm, Plot Armor,
 * Captivating Read and the ultimate, Rallying Charge. It is the order of her loadout
 * (`FIXTURE_PAIGE_ITEMS`), so the ability at an index is the one of the loadout at that index.
 */
export const FIXTURE_PAIGE_ABILITY_IDS: readonly [number, number, number, number] = [
  604448162, 3553292912, 3054993162, 1841901343,
];

/** Id of the hero whose signature ability the catalogue holds besides Paige's: Infernus. */
const OTHER_HERO_ID = 1;

/**
 * Build an ability or weapon image link.
 *
 * @param slug - Name of the image file, without its extension.
 * @param extension - `png` or `webp`.
 * @returns The link, on the asset bucket.
 */
function abilityImage(slug: string, extension: 'png' | 'webp'): string {
  return `${ABILITY_IMAGES}/${slug}.${extension}`;
}

/**
 * Build an ability of the catalogue, with its images.
 *
 * @param id - Numeric id of the game data.
 * @param className - Internal name.
 * @param name - English name.
 * @param abilityType - Role of the ability.
 * @param heroId - Hero it belongs to.
 * @param imageSlug - Name of the image files, or `null` for an ability without an image.
 * @returns The raw entry.
 */
function ability(
  id: number,
  className: string,
  name: string,
  abilityType: RawAbility['ability_type'],
  heroId: number,
  imageSlug: string | null,
): RawAbility {
  return {
    id,
    class_name: className,
    name,
    type: 'ability',
    ability_type: abilityType,
    hero: heroId,
    image: imageSlug === null ? null : abilityImage(imageSlug, 'png'),
    image_webp: imageSlug === null ? null : abilityImage(imageSlug, 'webp'),
  };
}

/** What a shop item is, before it becomes an entry of the catalogue. */
interface ShopItemSpec {
  readonly id: number;
  readonly name: string;
  readonly slot: ShopSlot;
  readonly tier: number;
  /**
   * The class name of the item, for an item whose class name is not `upgrade_` and its name in
   * snake case: the game named many items after an earlier version of them (Spirit Resilience is
   * `upgrade_tech_purge`). Left out, the item follows the pattern.
   */
  readonly className?: string;
}

/**
 * The shop items of the fixtures: twenty that the Paige players of the real matches ended with
 * (their names, slots and tiers), then the ten resistance items that complete the twelve of the
 * review. Express Shot and the twelve resistance items keep their real ids, and the resistance
 * items their real class names.
 */
const SHOP_ITEM_SPECS: readonly ShopItemSpec[] = [
  { id: 9_100_001, name: 'Opening Rounds', slot: 'weapon', tier: 2 },
  { id: FIXTURE_EXPRESS_SHOT_ID, name: 'Express Shot', slot: 'weapon', tier: 3 },
  { id: 9_100_002, name: 'Heroic Aura', slot: 'weapon', tier: 3 },
  { id: 9_100_003, name: 'Trophy Collector', slot: 'vitality', tier: 2 },
  { id: 9_100_004, name: 'Guardian Ward', slot: 'vitality', tier: 2 },
  { id: 9_100_005, name: 'Reactive Barrier', slot: 'vitality', tier: 2 },
  {
    id: 112198670,
    name: 'Spirit Shielding',
    slot: 'vitality',
    tier: 2,
    className: 'upgrade_spirit_bubble',
  },
  { id: 9_100_007, name: 'Rescue Beam', slot: 'vitality', tier: 3 },
  { id: 9_100_008, name: 'Divine Barrier', slot: 'vitality', tier: 4 },
  {
    id: 951866250,
    name: 'Indomitable',
    slot: 'vitality',
    tier: 4,
    className: 'upgrade_auto_cleanse',
  },
  { id: 9_100_010, name: 'Extra Charge', slot: 'spirit', tier: 1 },
  { id: 9_100_011, name: 'Mystic Expansion', slot: 'spirit', tier: 1 },
  { id: 9_100_012, name: 'Arcane Surge', slot: 'spirit', tier: 2 },
  { id: 9_100_013, name: 'Improved Spirit', slot: 'spirit', tier: 2 },
  { id: 9_100_014, name: 'Superior Duration', slot: 'spirit', tier: 3 },
  { id: 9_100_015, name: 'Greater Expansion', slot: 'spirit', tier: 3 },
  { id: 9_100_016, name: 'Knockdown', slot: 'spirit', tier: 3 },
  { id: 9_100_017, name: 'Vortex Web', slot: 'spirit', tier: 4 },
  { id: 9_100_018, name: 'Transcendent Cooldown', slot: 'spirit', tier: 4 },
  { id: 9_100_019, name: 'Spirit Burn', slot: 'spirit', tier: 4 },
  // The ten other resistance items of the review, which all sit in the vitality slot.
  {
    id: 1235347618,
    name: 'Battle Vest',
    slot: 'vitality',
    tier: 2,
    className: 'upgrade_regenerating_bullet_shield',
  },
  {
    id: 805079544,
    name: 'Weapon Shielding',
    slot: 'vitality',
    tier: 2,
    className: 'upgrade_weapon_shielding',
  },
  {
    id: 3970837787,
    name: "Enchanter's Emblem",
    slot: 'vitality',
    tier: 2,
    className: 'upgrade_magic_shield',
  },
  {
    id: 3140772621,
    name: 'Bullet Resilience',
    slot: 'vitality',
    tier: 3,
    className: 'upgrade_improved_bullet_armor',
  },
  {
    id: 1378931225,
    name: 'Metal Skin',
    slot: 'vitality',
    tier: 3,
    className: 'upgrade_metal_skin',
  },
  {
    id: 2163598980,
    name: 'Spirit Resilience',
    slot: 'vitality',
    tier: 3,
    className: 'upgrade_tech_purge',
  },
  {
    id: 3731635960,
    name: 'Dispel Magic',
    slot: 'vitality',
    tier: 3,
    className: 'upgrade_reduce_debuff_duration',
  },
  {
    id: 1955841979,
    name: 'Spellbreaker',
    slot: 'vitality',
    tier: 4,
    className: 'upgrade_spellbreaker',
  },
  {
    id: 3028234315,
    name: 'Witchmail',
    slot: 'vitality',
    tier: 4,
    className: 'upgrade_absorbing_armor',
  },
  {
    id: 2407781327,
    name: 'Colossus',
    slot: 'vitality',
    tier: 4,
    className: 'upgrade_colossus',
  },
];

/** What a shop item of each tier costs, in souls (index 0 is tier 1). */
const TIER_COSTS: readonly number[] = [500, 1_250, 3_000, 6_400];

/**
 * Build a shop item of the catalogue.
 *
 * Its class name and the name of its images follow the game's pattern: `upgrade_` and the English
 * name in snake case, apostrophes dropped (`Express Shot` is `upgrade_express_shot`, its shop image
 * `express_shot`; the image of Enchanter's Emblem is `enchanters_emblem`). An item with a
 * `className` keeps it instead of the pattern's, and its images still follow its name.
 *
 * @param spec - The item.
 * @returns The raw entry.
 */
function shopItem(spec: ShopItemSpec): RawShopItem {
  const slug = spec.name.toLowerCase().replaceAll(' ', '_').replaceAll("'", '');
  const folder = `${SHOP_IMAGES}/${spec.slot}`;
  return {
    id: spec.id,
    class_name: spec.className ?? `upgrade_${slug}`,
    name: spec.name,
    type: 'upgrade',
    item_slot_type: spec.slot,
    item_tier: spec.tier,
    cost: TIER_COSTS[spec.tier - 1] ?? 0,
    shopable: true,
    disabled: false,
    // A shop item is shown by its shop image: the image of the mod it applies is not needed.
    image: null,
    image_webp: null,
    shop_image: `${folder}/${slug}.png`,
    shop_image_webp: `${folder}/${slug}.webp`,
  };
}

/** The item catalogue of the fixtures. */
export const FIXTURE_ITEM_CATALOGUE: readonly RawCatalogueItem[] = [
  // Paige's weapon, melee attack and signature abilities, as her hero catalogue entry lists them.
  {
    id: 4260448939,
    class_name: FIXTURE_PAIGE_ITEMS.weapon_primary,
    name: "Chapter's End",
    type: 'weapon',
    hero: PAIGE_HERO_ID,
    image: abilityImage('chapters_end', 'png'),
    image_webp: abilityImage('chapters_end', 'webp'),
  },
  ability(3850113264, FIXTURE_PAIGE_ITEMS.weapon_melee, 'Melee', 'melee', PAIGE_HERO_ID, 'melee'),
  ability(
    FIXTURE_PAIGE_ABILITY_IDS[0],
    FIXTURE_PAIGE_ITEMS.signature1,
    'Bookwyrm',
    'signature',
    PAIGE_HERO_ID,
    'bookwyrm',
  ),
  ability(
    FIXTURE_PAIGE_ABILITY_IDS[1],
    FIXTURE_PAIGE_ITEMS.signature2,
    'Plot Armor',
    'signature',
    PAIGE_HERO_ID,
    'plot_armor',
  ),
  ability(
    FIXTURE_PAIGE_ABILITY_IDS[2],
    FIXTURE_PAIGE_ITEMS.signature3,
    'Captivating Read',
    'signature',
    PAIGE_HERO_ID,
    'captivating_read',
  ),
  ability(
    FIXTURE_PAIGE_ABILITY_IDS[3],
    FIXTURE_PAIGE_ITEMS.signature4,
    'Rallying Charge',
    'ultimate',
    PAIGE_HERO_ID,
    'rallying_charge',
  ),
  // The signature ability of another hero: it must not be taken for one of Paige's.
  ability(
    9_200_001,
    fixtureHeroItems('hero_inferno').signature1,
    'Flame Wave',
    'signature',
    OTHER_HERO_ID,
    'flame_wave',
  ),
  // An innate ability without a name or an image, like 220 entries of the real catalogue have no
  // name. As on the real data, its `hero` is 1: the `hero` field cannot tell it from Infernus's own
  // abilities, which is why a hero's loadout is read from the hero catalogue instead.
  ability(9_200_002, 'citadel_ability_sprint', '', 'innate', OTHER_HERO_ID, null),
  ...SHOP_ITEM_SPECS.map(shopItem),
];

/**
 * The ids of the shop items of the catalogue, Express Shot included
 * ({@link FIXTURE_EXPRESS_SHOT_ID}): what a fixture match may buy.
 */
export const FIXTURE_SHOP_ITEM_IDS: readonly number[] = SHOP_ITEM_SPECS.map((spec) => spec.id);

/**
 * The ids of the twelve resistance items of the review, in the order of `RESISTANCE_ITEMS`: the
 * ones a fixture match may buy, and the ones the fixture item statistics describe.
 */
export const FIXTURE_RESISTANCE_ITEM_IDS: readonly number[] = RESISTANCE_ITEMS.map(
  ({ className }) => {
    const spec = SHOP_ITEM_SPECS.find((candidate) => candidate.className === className);
    if (spec === undefined) {
      throw new Error(`The fixture item catalogue has no resistance item ${className}`);
    }
    return spec.id;
  },
);

/** A tier of the rank catalogue, in the raw shape of the API (subset of the fields). */
export interface RawCatalogueRank {
  readonly tier: number;
  readonly name: string;
  /** Colour of the tier, as a CSS hex code. */
  readonly color: string;
  /** The images of the tier by key, as many as the real API's (4 for tier 0, 40 for the others). */
  readonly images: Readonly<Record<string, string>>;
}

/** The names of the twelve tiers, by tier: the real ones. */
const RANK_NAMES: readonly string[] = [
  'Obscurus',
  'Initiate',
  'Seeker',
  'Acolyte',
  'Sentinel',
  'Mystic',
  'Ritualist',
  'Emissary',
  'Oracle',
  'Phantom',
  'Ascendant',
  'Eternus',
];

/** The colours of the twelve tiers, invented, by tier. */
const RANK_COLORS: readonly string[] = [
  '#5C5C5C',
  '#6A3E1E',
  '#7A8A3C',
  '#3C8A6A',
  '#3C6A8A',
  '#5A3C8A',
  '#8A3C6A',
  '#8A3C3C',
  '#8A6A3C',
  '#3C8A8A',
  '#C0A040',
  '#E0E0E0',
];

/** How many sub-ranks a tier has. */
const SUBRANKS = 6;

/**
 * Build the images of a tier like the real API's.
 *
 * Tier 0 has the badge only, under four keys. The other tiers have the badge (`large`) and a chalk
 * variant on the asset bucket, and the 18 sub-rank images (`subrank`, `large_subrank` and
 * `small_subrank`, each with a WebP twin) that the API serves itself: the three keys of a sub-rank
 * hold the same link.
 *
 * @param tier - Tier number.
 * @returns The images by key.
 */
function rankImages(tier: number): Record<string, string> {
  const code = String(tier).padStart(2, '0');
  const badge = `${RANK_IMAGES}/rank${code}_lg`;
  if (tier === 0) {
    return {
      large: `${badge}.png`,
      large_webp: `${badge}.webp`,
      small: `${badge}.png`,
      small_webp: `${badge}.webp`,
    };
  }
  const images: Record<string, string> = {
    large: `${badge}.png`,
    large_webp: `${badge}.webp`,
    chalk: `${RANK_IMAGES}/rank${code}_chalk.png`,
    chalk_webp: `${RANK_IMAGES}/rank${code}_chalk.webp`,
  };
  for (let subrank = 1; subrank <= SUBRANKS; subrank += 1) {
    const sub = String(subrank);
    const link = `${DEADLOCK_API_BASE_URL}/v1/assets/ranks/${String(tier)}/${sub}/image`;
    for (const prefix of ['', 'large_', 'small_']) {
      images[`${prefix}subrank${sub}`] = link;
      images[`${prefix}subrank${sub}_webp`] = `${link}?format=webp`;
    }
  }
  return images;
}

/** The rank catalogue of the fixtures: the twelve tiers, Obscurus to Eternus. */
export const FIXTURE_RANK_CATALOGUE: readonly RawCatalogueRank[] = RANK_NAMES.map(
  (name, tier): RawCatalogueRank => ({
    tier,
    name,
    color: RANK_COLORS[tier] ?? '#FFFFFF',
    images: rankImages(tier),
  }),
);

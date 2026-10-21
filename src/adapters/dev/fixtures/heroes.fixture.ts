/**
 * Hero catalogue served by the development HTTP client, in the shape of deadlock-api's
 * `GET /v1/assets/heroes` (reduced to a few of its many fields).
 *
 * Ids, names and class names of the heroes are those of the game (public game data, 2026-10-14),
 * except the invented "Retired Hero". The last two entries are not playable, like some entries of
 * the real response (Baba was still in development), so that the filter is exercised.
 *
 * Every hero carries what the app reads besides its name: a small portrait on the asset bucket
 * (`images`) and its loadout (`items`: the weapon, the melee attack and the four signature
 * abilities). Paige's loadout is the real one (hero asset 67, see `FIXTURE_PAIGE_ITEMS`); the other
 * heroes' class names are invented by {@link fixtureHeroItems}, so that no real ability is
 * attributed to a hero it may not belong to.
 *
 * @packageDocumentation
 */
import { ASSET_IMAGE_ORIGIN } from '../../../core/deadlock-api/assets.schema';

/** Folder of the hero portraits on the asset bucket. */
const HERO_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/heroes`;

/** The fixed items of a hero, by slot, as class names (the part of `items` the app reads). */
export interface RawHeroItems {
  readonly weapon_primary: string;
  readonly weapon_melee: string;
  readonly signature1: string;
  readonly signature2: string;
  readonly signature3: string;
  /** The ultimate. */
  readonly signature4: string;
}

/** The portraits of a hero, by name (the part of `images` the app reads). */
export interface RawHeroImages {
  readonly icon_image_small: string;
  readonly icon_image_small_webp: string;
}

/** A hero in the raw shape of the API (subset of the fields). */
export interface RawCatalogueHero {
  readonly id: number;
  readonly class_name: string;
  readonly name: string;
  readonly player_selectable: boolean;
  readonly disabled: boolean;
  readonly in_development: boolean;
  readonly development_state: string;
  readonly images: RawHeroImages;
  readonly items: RawHeroItems;
}

/**
 * Paige's weapon, melee attack and signature abilities: the real class names of the game data
 * (hero asset 67). The ultimate, Rallying Charge, is the last one.
 */
export const FIXTURE_PAIGE_ITEMS: RawHeroItems = {
  weapon_primary: 'citadel_weapon_bookworm_set2',
  weapon_melee: 'ability_melee_bookworm',
  signature1: 'ability_bookworm_dragonfire',
  signature2: 'ability_bookworm_knightbarrier',
  signature3: 'ability_bookworm_aoemagic',
  signature4: 'ability_bookworm_knightcharge',
};

/**
 * The name the game data gives to the files of a hero: its class name without the `hero_` prefix
 * (`hero_bookworm` is `bookworm`).
 *
 * @param className - Internal name of the hero.
 * @returns The name of its files.
 */
function slugOf(className: string): string {
  return className.replace(/^hero_/, '');
}

/**
 * Invent the loadout of a hero: class names in the pattern of the game's, but made up (the item
 * catalogue of the fixtures only describes the ones it needs).
 *
 * @param className - Internal name of the hero, e.g. `hero_inferno`.
 * @returns Its weapon, melee attack and four signature abilities.
 */
export function fixtureHeroItems(className: string): RawHeroItems {
  const slug = slugOf(className);
  return {
    weapon_primary: `citadel_weapon_${slug}_set1`,
    weapon_melee: `ability_melee_${slug}`,
    signature1: `ability_${slug}_signature1`,
    signature2: `ability_${slug}_signature2`,
    signature3: `ability_${slug}_signature3`,
    signature4: `ability_${slug}_signature4`,
  };
}

/**
 * Build a playable hero of the catalogue.
 *
 * @param id - Hero id of the game data.
 * @param name - English name.
 * @param className - Internal name of the game data.
 * @param items - Its loadout; invented from the class name when not given.
 * @returns The raw hero.
 */
function playable(
  id: number,
  name: string,
  className: string,
  items: RawHeroItems = fixtureHeroItems(className),
): RawCatalogueHero {
  const slug = slugOf(className);
  return {
    id,
    class_name: className,
    name,
    player_selectable: true,
    disabled: false,
    in_development: false,
    development_state: 'release',
    images: {
      icon_image_small: `${HERO_IMAGES}/${slug}_sm.png`,
      icon_image_small_webp: `${HERO_IMAGES}/${slug}_sm.webp`,
    },
    items,
  };
}

/** The hero catalogue of the fixtures. */
export const FIXTURE_HERO_CATALOGUE: readonly RawCatalogueHero[] = [
  playable(1, 'Infernus', 'hero_inferno'),
  playable(2, 'Seven', 'hero_gigawatt'),
  playable(3, 'Vindicta', 'hero_hornet'),
  playable(4, 'Lady Geist', 'hero_ghost'),
  playable(6, 'Abrams', 'hero_atlas'),
  playable(7, 'Wraith', 'hero_wraith'),
  playable(13, 'Haze', 'hero_haze'),
  playable(15, 'Bebop', 'hero_bebop'),
  playable(20, 'Ivy', 'hero_tengu'),
  playable(35, 'Viscous', 'hero_viscous'),
  playable(67, 'Paige', 'hero_bookworm', FIXTURE_PAIGE_ITEMS),
  { ...playable(88, 'Baba', 'hero_baba'), in_development: true },
  { ...playable(90, 'Retired Hero', 'hero_retired'), disabled: true, player_selectable: false },
];

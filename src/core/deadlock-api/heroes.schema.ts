/**
 * Validation and mapping of deadlock-api's hero catalogue (`GET /v1/assets/heroes`).
 *
 * The response describes each hero in depth (about 1.4 MB for 42 heroes); the app keeps the id and
 * the English name of the heroes a player can pick, their small portrait and their loadout (the
 * weapon, the melee attack and the four signature abilities by class name).
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { HeroAsset, HeroLoadout } from '../domain/hero';
import { AppError } from '../errors/app-error';
import { firstAssetImageUrl } from './assets.schema';

/**
 * A map of the entry the app reads key by key (`images`, `items`). Its values stay `unknown`: each
 * reader checks the one it needs. A value that is not such a map reads as absent, because these
 * fields only decorate a hero and must never cost it its place in the catalogue.
 */
const looseMapSchema = z.record(z.string(), z.unknown()).optional().catch(undefined);

/** One hero of the catalogue, as deadlock-api returns it (only the fields the app uses). */
const catalogueHeroSchema = z.object({
  id: z.int().positive(),
  name: z.string().trim().min(1),
  // Flags of the game data; an absent flag never hides a hero.
  player_selectable: z.boolean().optional(),
  disabled: z.boolean().optional(),
  // Portraits by name (`icon_image_small_webp`, `icon_image_small`…).
  images: looseMapSchema,
  // The hero's fixed items by slot name (`weapon_primary`, `signature1`…), as class names.
  items: looseMapSchema,
});

/** One validated hero of the catalogue. */
type CatalogueHero = z.infer<typeof catalogueHeroSchema>;

/**
 * Tell whether players can pick a hero. `only_active=true` already leaves out most other heroes,
 * and these two flags leave out the rest.
 *
 * The `in_development` flag is not one of them: a new hero keeps it for weeks after players can pick
 * it (on 2026-10-28, Violet and Baba were both `in_development`, selectable and played), and a hero
 * left out of the catalogue would show by its id in every match it was played in.
 *
 * @param hero - A validated hero of the catalogue.
 * @returns `true` for a playable hero.
 */
function isPlayable(hero: CatalogueHero): boolean {
  return hero.player_selectable !== false && hero.disabled !== true;
}

/** The slots of the four signature abilities in the hero's `items`, in order (the ultimate last). */
const SIGNATURE_SLOTS = ['signature1', 'signature2', 'signature3', 'signature4'] as const;

/**
 * The number of signature abilities of a hero's loadout: a loadout this module reads always has
 * exactly this many (see {@link HeroLoadout}), so what keeps a loadout can check it.
 */
export const SIGNATURE_ABILITY_COUNT = SIGNATURE_SLOTS.length;

/**
 * Read a class name out of a slot of the `items` map.
 *
 * @param value - What the map holds in the slot.
 * @returns The class name, or `null` when the slot is empty or holds anything but a non-empty string.
 */
function classNameOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read the loadout of a hero out of its `items` map: the primary weapon, the melee attack and the
 * four signature abilities. The map also holds the innate abilities every hero shares (mantle,
 * jump, slide, zip line, dash, sprint, parry), which are no part of a loadout and are left out.
 *
 * @param items - The `items` map of the hero, if it has a readable one.
 * @returns The loadout, or `null` when any of its six slots is missing or is not a class name: a
 *   partial loadout would classify the damage sources wrongly, so there is none.
 */
function readLoadout(items: CatalogueHero['items']): HeroLoadout | null {
  if (items === undefined) {
    return null;
  }
  const weapon = classNameOf(items.weapon_primary);
  const melee = classNameOf(items.weapon_melee);
  const abilities = SIGNATURE_SLOTS.flatMap((slot) => {
    const className = classNameOf(items[slot]);
    return className === null ? [] : [className];
  });
  if (weapon === null || melee === null || abilities.length !== SIGNATURE_ABILITY_COUNT) {
    return null;
  }
  return { weapon, melee, abilities };
}

/**
 * Validate the hero catalogue and keep its playable heroes with their portrait and loadout.
 *
 * The catalogue only names heroes on screen, so a malformed entry is skipped instead of failing
 * the whole catalogue: its hero is then shown by its id. A hero whose `images` or `items` cannot be
 * read stays, without portrait or loadout.
 *
 * The portrait is the small icon, WebP first (`images.icon_image_small_webp`,
 * `images.icon_image_small`), and only when it points into the asset bucket.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The playable heroes, sorted by id.
 * @throws AppError of kind `invalid_payload` when the body is not an array or holds no valid hero.
 */
export function parseHeroAssets(body: unknown): HeroAsset[] {
  if (!Array.isArray(body)) {
    throw new AppError('invalid_payload', 'The hero catalogue is not an array', {
      context: { endpoint: '/v1/assets/heroes' },
    });
  }
  const heroes = body.flatMap((entry): HeroAsset[] => {
    const parsed = catalogueHeroSchema.safeParse(entry);
    if (!parsed.success || !isPlayable(parsed.data)) {
      return [];
    }
    const { id, name, images, items } = parsed.data;
    return [
      {
        id,
        name,
        imageUrl: firstAssetImageUrl([images?.icon_image_small_webp, images?.icon_image_small]),
        loadout: readLoadout(items),
      },
    ];
  });
  if (heroes.length === 0) {
    throw new AppError('invalid_payload', 'The hero catalogue holds no playable hero', {
      context: { entries: body.length },
    });
  }
  return heroes.toSorted((first, second) => first.id - second.id);
}

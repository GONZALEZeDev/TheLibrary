/**
 * The game icons the match map replay draws, served by deadlock-api's asset bucket.
 *
 * Every URL points into the bucket ({@link ASSET_IMAGE_ORIGIN}), so the app's image allow-list
 * needs no change. The icons are looked up by a stable id, never by a raw path, so the UI names
 * what it wants to show and this table says where it lives.
 *
 * @packageDocumentation
 */

import { ASSET_IMAGE_ORIGIN } from '../deadlock-api/assets.schema';

/** What an icon shows: an objective, a camp, a boss, a death, a pickup, a patron or a power-up. */
export type GameIconId =
  | 'guardian'
  | 'walker'
  | 'mid_boss'
  | 'death'
  | 'soul_urn'
  | 'camp_small'
  | 'camp_medium'
  | 'camp_large'
  | 'patron_hidden_king'
  | 'patron_archmother'
  | 'powerup_weapon';

/** The folder of the bucket that holds the game's own resources. */
const GAME_RESOURCE_ROOT = `${ASSET_IMAGE_ORIGIN}assets-api-res/`;

/**
 * The absolute bucket URL of every game icon.
 *
 * This table is maintained by hand, from the files the asset listings of deadlock-api name
 * (`/v1/assets/icons` and `/v1/assets/images`). If it renames one, that icon fails to load and the
 * UI falls back to a drawn shape until the path is updated here.
 */
export const GAME_ICONS: Readonly<Record<GameIconId, string>> = {
  guardian: `${GAME_RESOURCE_ROOT}icons/minimap/objective_icon_t1.svg`,
  walker: `${GAME_RESOURCE_ROOT}icons/minimap/objective_icon_t2.svg`,
  mid_boss: `${GAME_RESOURCE_ROOT}icons/new_boss_marker.png`,
  death: `${GAME_RESOURCE_ROOT}icons/replay/icon_death.svg`,
  soul_urn: `${GAME_RESOURCE_ROOT}icons/minimap/soul_jar_marker_psd.png`,
  camp_small: `${GAME_RESOURCE_ROOT}icons/neutral_small.png`,
  camp_medium: `${GAME_RESOURCE_ROOT}icons/neutral_medium.png`,
  camp_large: `${GAME_RESOURCE_ROOT}icons/neutral_large.png`,
  patron_hidden_king: `${GAME_RESOURCE_ROOT}images/npcs/patron_hiddenking.png`,
  patron_archmother: `${GAME_RESOURCE_ROOT}images/npcs/patron_archmother.png`,
  powerup_weapon: `${GAME_RESOURCE_ROOT}icons/hud/icons/powerup_gun.svg`,
};

/**
 * The factor by which an icon must be enlarged so that its visible drawing fills its box.
 *
 * Some files carry a wide transparent margin around the drawing (the Mid Boss marker fills only
 * the middle of its picture), so at a small box size the drawing would look tiny. An icon missing
 * from this table needs no enlargement (factor 1). Like {@link GAME_ICONS}, it is maintained by
 * hand, from a look at the file.
 */
export const GAME_ICON_CONTENT_SCALE: Readonly<Partial<Record<GameIconId, number>>> = {
  mid_boss: 1.7,
};

/**
 * The enlargement an icon needs so that its visible drawing fills its box.
 *
 * @param id - The icon.
 * @returns The factor of {@link GAME_ICON_CONTENT_SCALE}, or 1 when the icon has none.
 */
export function gameIconContentScale(id: GameIconId): number {
  return GAME_ICON_CONTENT_SCALE[id] ?? 1;
}

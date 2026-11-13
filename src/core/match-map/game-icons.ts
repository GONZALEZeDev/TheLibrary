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

/** What an icon shows: an objective, a neutral camp, a boss or pickup, a patron or a power-up. */
export type GameIconId =
  | 'guardian'
  | 'walker'
  | 'mid_boss'
  | 'rejuvenator'
  | 'soul_urn'
  | 'camp_small'
  | 'camp_medium'
  | 'camp_large'
  | 'patron_hidden_king'
  | 'patron_archmother'
  | 'powerup_weapon'
  | 'powerup_spirit'
  | 'powerup_movement'
  | 'powerup_survival';

/** The folder of the bucket that holds the game's own resources. */
const GAME_RESOURCE_ROOT = `${ASSET_IMAGE_ORIGIN}assets-api-res/`;

/**
 * The absolute bucket URL of every game icon.
 *
 * This table is maintained by hand: deadlock-api does not list these files anywhere. If it renames
 * one, that icon fails to load and the UI falls back to a drawn shape until the path is updated
 * here.
 */
export const GAME_ICONS: Readonly<Record<GameIconId, string>> = {
  guardian: `${GAME_RESOURCE_ROOT}icons/minimap/objective_icon_t1.svg`,
  walker: `${GAME_RESOURCE_ROOT}icons/minimap/objective_icon_t2.svg`,
  mid_boss: `${GAME_RESOURCE_ROOT}icons/minimap/boss_marker_neutral_psd.png`,
  rejuvenator: `${GAME_RESOURCE_ROOT}icons/hud/icons/rejuvenator.svg`,
  soul_urn: `${GAME_RESOURCE_ROOT}icons/minimap/soul_jar_marker_psd.png`,
  camp_small: `${GAME_RESOURCE_ROOT}icons/neutral_small.png`,
  camp_medium: `${GAME_RESOURCE_ROOT}icons/neutral_medium.png`,
  camp_large: `${GAME_RESOURCE_ROOT}icons/neutral_large.png`,
  patron_hidden_king: `${GAME_RESOURCE_ROOT}images/npcs/patron_hiddenking.png`,
  patron_archmother: `${GAME_RESOURCE_ROOT}images/npcs/patron_archmother.png`,
  powerup_weapon: `${GAME_RESOURCE_ROOT}icons/hud/icons/powerup_gun.svg`,
  powerup_spirit: `${GAME_RESOURCE_ROOT}icons/hud/icons/powerup_spirit.svg`,
  powerup_movement: `${GAME_RESOURCE_ROOT}icons/hud/icons/powerup_movement.svg`,
  powerup_survival: `${GAME_RESOURCE_ROOT}icons/hud/icons/powerup_survival.svg`,
};

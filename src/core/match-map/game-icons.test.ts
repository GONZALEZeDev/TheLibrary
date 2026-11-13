import { describe, expect, it } from 'vitest';

import { ASSET_IMAGE_ORIGIN, firstAssetImageUrl } from '../deadlock-api/assets.schema';
import { GAME_ICONS, type GameIconId } from './game-icons';

/** Every id of {@link GameIconId}, spelled out so a missing table entry fails the test. */
const ALL_ICON_IDS: readonly GameIconId[] = [
  'guardian',
  'walker',
  'mid_boss',
  'rejuvenator',
  'soul_urn',
  'camp_small',
  'camp_medium',
  'camp_large',
  'patron_hidden_king',
  'patron_archmother',
  'powerup_weapon',
  'powerup_spirit',
  'powerup_movement',
  'powerup_survival',
];

describe('GAME_ICONS', () => {
  it('every game icon is on the asset bucket', () => {
    for (const url of Object.values(GAME_ICONS)) {
      expect(url.startsWith(ASSET_IMAGE_ORIGIN)).toBe(true);
      expect(firstAssetImageUrl([url])).toBe(url);
    }
  });

  it('holds exactly the 14 ids of GameIconId', () => {
    expect(Object.keys(GAME_ICONS).sort()).toEqual([...ALL_ICON_IDS].sort());
  });

  it('gives no two ids the same URL', () => {
    const urls = Object.values(GAME_ICONS);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

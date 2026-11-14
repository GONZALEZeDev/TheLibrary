import { describe, expect, it } from 'vitest';

import { ASSET_IMAGE_ORIGIN, firstAssetImageUrl } from '../deadlock-api/assets.schema';
import {
  GAME_ICON_CONTENT_SCALE,
  GAME_ICONS,
  gameIconContentScale,
  type GameIconId,
} from './game-icons';

/** Every id of {@link GameIconId}, spelled out so a missing table entry fails the test. */
const ALL_ICON_IDS: readonly GameIconId[] = [
  'guardian',
  'walker',
  'mid_boss',
  'death',
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

  it('holds exactly the 15 ids of GameIconId', () => {
    expect(Object.keys(GAME_ICONS).sort()).toEqual([...ALL_ICON_IDS].sort());
  });

  it('shows the Mid Boss with the official in-game marker', () => {
    expect(GAME_ICONS.mid_boss.endsWith('/icons/new_boss_marker.png')).toBe(true);
  });

  it('draws a death with the replay death icon of the bucket', () => {
    expect(GAME_ICONS.death.endsWith('/icons/replay/icon_death.svg')).toBe(true);
  });

  it('gives no two ids the same URL', () => {
    const urls = Object.values(GAME_ICONS);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('GAME_ICON_CONTENT_SCALE', () => {
  it('enlarges the Mid Boss marker, whose file carries a transparent margin', () => {
    expect(GAME_ICON_CONTENT_SCALE.mid_boss).toBe(1.7);
    expect(gameIconContentScale('mid_boss')).toBe(1.7);
  });

  it('leaves an icon without an entry at its natural size', () => {
    expect(gameIconContentScale('walker')).toBe(1);
  });
});

/**
 * Tests of the validation and mapping of deadlock-api's item and rank catalogues.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import {
  ASSET_IMAGE_ORIGIN,
  assetImageUrl,
  parseItemCatalogue,
  parseRankCatalogue,
} from './assets.schema';

/** Folder of the ability and weapon images on the asset bucket. */
const ABILITY_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/abilities`;

/** Folder of the shop images on the asset bucket. */
const SHOP_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/items/weapon`;

/** Folder of the rank images on the asset bucket. */
const RANK_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/ranks`;

/**
 * An ability of the item catalogue in the shape of the API, reduced to a few of its many fields
 * (the real entry also carries `properties`, `description`, `tooltip_sections`…).
 *
 * @param overrides - Fields to change.
 * @returns The raw entry.
 */
function rawAbility(overrides: Record<string, unknown> = {}) {
  return {
    id: 604448162,
    class_name: 'ability_bookworm_dragonfire',
    name: 'Bookwyrm',
    type: 'ability',
    ability_type: 'signature',
    hero: 67,
    heroes: [],
    item_slot_type: null,
    item_tier: null,
    image: `${ABILITY_IMAGES}/bookwyrm.png`,
    image_webp: `${ABILITY_IMAGES}/bookwyrm.webp`,
    shop_image: null,
    shop_image_webp: null,
    properties: { Cooldown: { value: '30' } },
    ...overrides,
  };
}

/**
 * A weapon of the item catalogue in the shape of the API.
 *
 * @param overrides - Fields to change.
 * @returns The raw entry.
 */
function rawWeapon(overrides: Record<string, unknown> = {}) {
  return {
    id: 4260448939,
    class_name: 'citadel_weapon_bookworm_set2',
    name: "Chapter's End",
    type: 'weapon',
    hero: 67,
    heroes: [],
    image: `${ABILITY_IMAGES}/chapters_end.png`,
    image_webp: `${ABILITY_IMAGES}/chapters_end.webp`,
    ...overrides,
  };
}

/**
 * A shop item (`upgrade`) of the item catalogue in the shape of the API: its tier, its slot, its
 * shop image and, as on the real data, the image of its mod.
 *
 * @param overrides - Fields to change.
 * @returns The raw entry.
 */
function rawUpgrade(overrides: Record<string, unknown> = {}) {
  return {
    id: 3000000001,
    class_name: 'upgrade_express_shot',
    name: 'Express Shot',
    type: 'upgrade',
    item_slot_type: 'weapon',
    item_tier: 3,
    shopable: true,
    disabled: false,
    hero: null,
    heroes: [],
    image: `${ABILITY_IMAGES}/express_shot_mod.png`,
    image_webp: `${ABILITY_IMAGES}/express_shot_mod.webp`,
    shop_image: `${SHOP_IMAGES}/express_shot.png`,
    shop_image_webp: `${SHOP_IMAGES}/express_shot.webp`,
    ...overrides,
  };
}

/**
 * A tier of the rank catalogue in the shape of the API: the tier badge on the asset bucket and, as
 * on the real data, the sub-rank images served by another host.
 *
 * @param tier - Tier number.
 * @param name - English name of the tier.
 * @param images - The image keys to use instead of the real ones.
 * @returns The raw entry.
 */
function rawRank(tier: number, name: string, images?: Record<string, unknown>) {
  const code = String(tier).padStart(2, '0');
  return {
    tier,
    name,
    color: '#6A3E1E',
    images: images ?? {
      large: `${RANK_IMAGES}/rank${code}_lg.png`,
      large_webp: `${RANK_IMAGES}/rank${code}_lg.webp`,
      chalk: `${RANK_IMAGES}/rank${code}_chalk.png`,
      chalk_webp: `${RANK_IMAGES}/rank${code}_chalk.webp`,
      subrank4: `https://api.deadlock-api.com/v1/assets/ranks/${String(tier)}/4/image`,
      large_subrank4: `https://api.deadlock-api.com/v1/assets/ranks/${String(tier)}/4/image`,
    },
  };
}

describe('assetImageUrl', () => {
  it('keeps a URL of the asset bucket', () => {
    const url = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/heroes/bookworm_sm.webp`;

    expect(assetImageUrl(url)).toBe(url);
  });

  it('drops anything else', () => {
    for (const value of [
      // Another host, another scheme, a host that only starts like the bucket.
      'https://api.deadlock-api.com/v1/assets/ranks/4/4/image',
      'http://assets-bucket.deadlock-api.com/x.webp',
      'https://assets-bucket.deadlock-api.com.example.net/x.webp',
      'https://assets-bucket.deadlock-api.com@example.net/x.webp',
      // Not a URL at all.
      'x.webp',
      '',
      // Not a string.
      null,
      undefined,
      42,
      { url: `${ASSET_IMAGE_ORIGIN}x.webp` },
    ]) {
      expect(assetImageUrl(value)).toBeNull();
    }
  });
});

describe('parseItemCatalogue', () => {
  it('keeps the fields M4b needs', () => {
    const items = parseItemCatalogue([rawAbility(), rawWeapon(), rawUpgrade()]);

    expect(items).toEqual([
      {
        id: 604448162,
        className: 'ability_bookworm_dragonfire',
        name: 'Bookwyrm',
        kind: 'ability',
        slot: null,
        tier: null,
        imageUrl: `${ABILITY_IMAGES}/bookwyrm.webp`,
      },
      {
        id: 4260448939,
        className: 'citadel_weapon_bookworm_set2',
        name: "Chapter's End",
        kind: 'weapon',
        slot: null,
        tier: null,
        imageUrl: `${ABILITY_IMAGES}/chapters_end.webp`,
      },
      {
        id: 3000000001,
        className: 'upgrade_express_shot',
        name: 'Express Shot',
        kind: 'upgrade',
        slot: 'weapon',
        tier: 3,
        imageUrl: `${SHOP_IMAGES}/express_shot.webp`,
      },
    ]);
  });

  it('keeps the three slots of a shop item and drops any other', () => {
    const upgrades = ['weapon', 'vitality', 'spirit', 'flex', 5, null].map((slot, index) =>
      rawUpgrade({ id: 3000000100 + index, item_slot_type: slot }),
    );

    expect(parseItemCatalogue(upgrades).map((item) => item.slot)).toEqual([
      'weapon',
      'vitality',
      'spirit',
      null,
      null,
      null,
    ]);
  });

  it('prefers the shop image of an upgrade', () => {
    const [webp, png, mod, modPng, none] = parseItemCatalogue([
      // The WebP shop image wins over every other image.
      rawUpgrade({ id: 3000000101 }),
      // Without it, the PNG shop image comes next.
      rawUpgrade({ id: 3000000102, shop_image_webp: null }),
      // Without a shop image, the image of the mod is used, WebP first.
      rawUpgrade({ id: 3000000103, shop_image_webp: null, shop_image: undefined }),
      rawUpgrade({
        id: 3000000104,
        shop_image_webp: null,
        shop_image: null,
        image_webp: null,
      }),
      rawUpgrade({
        id: 3000000105,
        shop_image_webp: null,
        shop_image: null,
        image_webp: null,
        image: null,
      }),
    ]);

    expect(webp?.imageUrl).toBe(`${SHOP_IMAGES}/express_shot.webp`);
    expect(png?.imageUrl).toBe(`${SHOP_IMAGES}/express_shot.png`);
    expect(mod?.imageUrl).toBe(`${ABILITY_IMAGES}/express_shot_mod.webp`);
    expect(modPng?.imageUrl).toBe(`${ABILITY_IMAGES}/express_shot_mod.png`);
    expect(none?.imageUrl).toBeNull();
  });

  it('reads the image of an ability or a weapon from its own image, WebP first', () => {
    const [ability, weapon, pngOnly, none] = parseItemCatalogue([
      // A shop image is never read on an ability: the order of the abilities has no such field.
      rawAbility({ shop_image_webp: `${SHOP_IMAGES}/not_this.webp` }),
      rawWeapon({ shop_image: `${SHOP_IMAGES}/not_this.png` }),
      rawAbility({ id: 604448163, image_webp: null }),
      rawAbility({ id: 604448164, image_webp: null, image: null }),
    ]);

    expect(ability?.imageUrl).toBe(`${ABILITY_IMAGES}/bookwyrm.webp`);
    expect(weapon?.imageUrl).toBe(`${ABILITY_IMAGES}/chapters_end.webp`);
    expect(pngOnly?.imageUrl).toBe(`${ABILITY_IMAGES}/bookwyrm.png`);
    expect(none?.imageUrl).toBeNull();
  });

  it('drops an image outside the asset bucket', () => {
    const [foreign, lookalike, fallback] = parseItemCatalogue([
      rawAbility({
        image_webp: 'https://example.net/bookwyrm.webp',
        image: 'https://example.net/bookwyrm.png',
      }),
      rawUpgrade({
        shop_image_webp: 'https://assets-bucket.deadlock-api.com.example.net/x.webp',
        shop_image: 42,
        image_webp: '',
        image: undefined,
      }),
      // A foreign image never hides a usable one that comes later in the order.
      rawUpgrade({ id: 3000000106, shop_image_webp: 'https://example.net/x.webp' }),
    ]);

    expect(foreign?.imageUrl).toBeNull();
    expect(lookalike?.imageUrl).toBeNull();
    expect(fallback?.imageUrl).toBe(`${SHOP_IMAGES}/express_shot.png`);
  });

  it('reads an empty name or the class name as no name', () => {
    const names = parseItemCatalogue([
      // Sprint has no name in the real catalogue.
      rawAbility({ id: 1, class_name: 'citadel_ability_sprint', name: '' }),
      // Some weapons carry their class name as their name.
      rawWeapon({
        id: 2,
        class_name: 'weapon_alternative_rmb_activate',
        name: 'weapon_alternative_rmb_activate',
      }),
      rawAbility({ id: 3, name: '   ' }),
      rawAbility({ id: 4, name: null }),
      rawAbility({ id: 5, name: undefined }),
      // The field may also be absent altogether.
      Object.fromEntries(Object.entries(rawAbility({ id: 8 })).filter(([key]) => key !== 'name')),
      rawAbility({ id: 6, name: 7 }),
      // A real name is trimmed.
      rawAbility({ id: 7, name: ' Bookwyrm ' }),
    ]).map((item) => item.name);

    expect(names).toEqual([null, null, null, null, null, null, null, 'Bookwyrm']);
  });

  it('reads the tier as a number or a numeric string, from 1 to 5', () => {
    const valid = [1, 5, '2', '4', '3'];
    // Out of range, not whole, not numeric, not a number or a string, or absent.
    const invalid = [0, 6, '0', '6', 2.5, '2.5', 'III', '', ' 3', '-1', true, null, undefined];
    const upgrades = [...valid, ...invalid].map((tier, index) =>
      rawUpgrade({ id: 3000000200 + index, item_tier: tier }),
    );

    expect(parseItemCatalogue(upgrades).map((item) => item.tier)).toEqual([
      1,
      5,
      2,
      4,
      3,
      ...invalid.map(() => null),
    ]);
  });

  it('skips an entry of unknown type', () => {
    const items = parseItemCatalogue([
      rawAbility(),
      // The catalogue also holds other kinds of entries: they are none of the app's business.
      rawAbility({ id: 11, class_name: 'misc_thing', type: 'misc' }),
      rawAbility({ id: 12, class_name: 'hero_thing', type: 'hero' }),
      rawAbility({ id: 13, class_name: 'no_type', type: undefined }),
      rawAbility({ id: 14, class_name: 'numeric_type', type: 3 }),
      rawUpgrade(),
    ]);

    expect(items.map((item) => item.kind)).toEqual(['ability', 'upgrade']);
  });

  it('skips an entry without an id or a class name, or that is not an object', () => {
    const items = parseItemCatalogue([
      rawAbility(),
      rawAbility({ id: undefined }),
      rawAbility({ id: '604448162' }),
      rawAbility({ id: 1.5 }),
      rawAbility({ id: 20, class_name: undefined }),
      rawAbility({ id: 21, class_name: '' }),
      rawAbility({ id: 22, class_name: 5 }),
      null,
      'ability',
      42,
      [],
    ]);

    expect(items.map((item) => item.id)).toEqual([604448162]);
  });

  it('refuses a body that is not an array', () => {
    for (const body of [{}, { items: [rawAbility()] }, null, 'items', 42, undefined]) {
      expect(() => parseItemCatalogue(body)).toThrow(
        expect.objectContaining({
          kind: 'invalid_payload',
          context: { issue: '(root): invalid_type' },
        }),
      );
    }
  });

  it('refuses a catalogue with no usable entry, which would be kept for a week', () => {
    expect(() => parseItemCatalogue([])).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
    expect(() => parseItemCatalogue([{ id: 1 }, rawAbility({ type: 'misc' })])).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });

  it('never echoes a payload value in the error', () => {
    const secret = 'secret-payload-value';

    // Both failures: a body that is not a list, and a list with no usable entry.
    for (const body of [{ name: secret }, [{ name: secret }]]) {
      let thrown: unknown;
      try {
        parseItemCatalogue(body);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppError);
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(secret);
    }
  });
});

describe('parseRankCatalogue', () => {
  it('reads the tier badge of each rank', () => {
    const ranks = parseRankCatalogue([
      rawRank(4, 'Sentinel'),
      // Tier 0 only has large images and small ones, all the same file.
      rawRank(0, 'Obscurus', {
        large: `${RANK_IMAGES}/rank00_lg.png`,
        large_webp: `${RANK_IMAGES}/rank00_lg.webp`,
        small: `${RANK_IMAGES}/rank00_lg.png`,
        small_webp: `${RANK_IMAGES}/rank00_lg.webp`,
      }),
      rawRank(11, 'Eternus'),
    ]);

    // Sorted by tier, and the sub-rank images (served by another host) are never read.
    expect(ranks).toEqual([
      { tier: 0, name: 'Obscurus', imageUrl: `${RANK_IMAGES}/rank00_lg.webp` },
      { tier: 4, name: 'Sentinel', imageUrl: `${RANK_IMAGES}/rank04_lg.webp` },
      { tier: 11, name: 'Eternus', imageUrl: `${RANK_IMAGES}/rank11_lg.webp` },
    ]);
  });

  it('falls back to the PNG badge, and drops a badge outside the asset bucket', () => {
    const [pngOnly, foreign, none, fallback] = parseRankCatalogue([
      rawRank(1, 'Initiate', { large: `${RANK_IMAGES}/rank01_lg.png` }),
      rawRank(2, 'Seeker', {
        large_webp: 'https://example.net/rank02.webp',
        large: 'https://example.net/rank02.png',
        subrank4: 'https://api.deadlock-api.com/v1/assets/ranks/2/4/image',
      }),
      rawRank(3, 'Acolyte', {}),
      // A foreign image never hides a usable one that comes later in the order.
      rawRank(4, 'Sentinel', {
        large_webp: 'https://example.net/rank04.webp',
        large: `${RANK_IMAGES}/rank04_lg.png`,
      }),
    ]);

    expect(pngOnly?.imageUrl).toBe(`${RANK_IMAGES}/rank01_lg.png`);
    expect(foreign?.imageUrl).toBeNull();
    expect(none?.imageUrl).toBeNull();
    expect(fallback?.imageUrl).toBe(`${RANK_IMAGES}/rank04_lg.png`);
  });

  it('keeps a rank without images', () => {
    const [bare] = parseRankCatalogue([{ tier: 5, name: 'Mystic' }]);

    expect(bare).toEqual({ tier: 5, name: 'Mystic', imageUrl: null });
  });

  it('skips a rank without a whole tier or a name', () => {
    const ranks = parseRankCatalogue([
      rawRank(6, 'Ritualist'),
      { name: 'No tier' },
      { tier: '7', name: 'Text tier' },
      { tier: -1, name: 'Negative' },
      { tier: 1.5, name: 'Fractional' },
      { tier: 8 },
      { tier: 9, name: '  ' },
      null,
      'rank',
    ]);

    expect(ranks.map((rank) => rank.tier)).toEqual([6]);
  });

  it('refuses a body that is not an array, or with no usable rank', () => {
    expect(() => parseRankCatalogue({})).toThrow(
      expect.objectContaining({
        kind: 'invalid_payload',
        context: { issue: '(root): invalid_type' },
      }),
    );
    expect(() => parseRankCatalogue([])).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
    expect(() => parseRankCatalogue([{ tier: 'x' }])).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });
});

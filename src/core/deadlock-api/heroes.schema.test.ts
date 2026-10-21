/**
 * Tests of the validation and mapping of deadlock-api's hero catalogue.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { ASSET_IMAGE_ORIGIN } from './assets.schema';
import { parseHeroAssets, parseHeroes } from './heroes.schema';

/**
 * A hero of the catalogue in the shape of the API, reduced to a few of its many fields.
 *
 * @param id - Hero id.
 * @param name - English name.
 * @param overrides - Fields to change.
 * @returns The raw hero.
 */
function rawHero(id: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    class_name: `hero_${name.toLowerCase()}`,
    name,
    player_selectable: true,
    disabled: false,
    in_development: false,
    development_state: 'release',
    images: { icon_image_small: 'https://assets-bucket.deadlock-api.com/x.png' },
    ...overrides,
  };
}

/** Folder of the hero images on the asset bucket. */
const HERO_IMAGES = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/heroes`;

/**
 * Paige as the real catalogue describes her, reduced to the fields the app reads: her images and
 * her `items` map (snake_case slots to class names), whose innate abilities the app ignores.
 *
 * @param items - The `items` map to use instead of the real one.
 * @returns The raw hero.
 */
function rawPaige(items?: unknown) {
  return rawHero(67, 'Paige', {
    images: {
      icon_image_small: `${HERO_IMAGES}/bookworm_sm.png`,
      icon_image_small_webp: `${HERO_IMAGES}/bookworm_sm.webp`,
      icon_hero_card_webp: `${HERO_IMAGES}/bookworm_card.webp`,
    },
    items: items ?? {
      weapon_primary: 'citadel_weapon_bookworm_set2',
      weapon_melee: 'ability_melee_bookworm',
      signature1: 'ability_bookworm_dragonfire',
      signature2: 'ability_bookworm_knightbarrier',
      signature3: 'ability_bookworm_aoemagic',
      signature4: 'ability_bookworm_knightcharge',
      ability_mantle: 'citadel_ability_mantle',
      ability_jump: 'citadel_ability_jump',
      ability_zip_line: 'citadel_ability_zip_line',
      ability_innate1: 'citadel_ability_dash',
    },
  });
}

describe('parseHeroes', () => {
  it('keeps the id and the name of each hero, sorted by id', () => {
    expect(parseHeroes([rawHero(67, 'Paige'), rawHero(1, 'Infernus')])).toEqual([
      { id: 1, name: 'Infernus' },
      { id: 67, name: 'Paige' },
    ]);
  });

  it('leaves out the heroes players cannot pick', () => {
    const heroes = parseHeroes([
      rawHero(67, 'Paige'),
      rawHero(88, 'Baba', { in_development: true }),
      rawHero(90, 'Old', { disabled: true }),
      rawHero(91, 'Hidden', { player_selectable: false }),
    ]);

    expect(heroes.map((hero) => hero.name)).toEqual(['Paige']);
  });

  it('keeps a hero whose flags are missing', () => {
    expect(parseHeroes([{ id: 67, name: 'Paige' }])).toEqual([{ id: 67, name: 'Paige' }]);
  });

  it('skips a malformed hero instead of failing the catalogue', () => {
    const heroes = parseHeroes([rawHero(67, 'Paige'), rawHero(1, ''), { id: 'x', name: 'Bad' }]);

    expect(heroes).toEqual([{ id: 67, name: 'Paige' }]);
  });

  it('rejects a body that is not an array, or with no playable hero', () => {
    expect(() => parseHeroes({})).toThrow(expect.objectContaining({ kind: 'invalid_payload' }));
    expect(() => parseHeroes([])).toThrow(expect.objectContaining({ kind: 'invalid_payload' }));
    expect(() => parseHeroes([rawHero(88, 'Baba', { in_development: true })])).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });
});

describe('parseHeroes with assets in the catalogue', () => {
  it('still returns the id and the name only', () => {
    // The hero cache and its callers expect a bare Hero, whatever the entry carries.
    expect(parseHeroes([rawPaige()])).toStrictEqual([{ id: 67, name: 'Paige' }]);
  });
});

describe('parseHeroAssets', () => {
  it("reads Paige's image and loadout", () => {
    expect(parseHeroAssets([rawPaige()])).toStrictEqual([
      {
        id: 67,
        name: 'Paige',
        imageUrl: `${HERO_IMAGES}/bookworm_sm.webp`,
        loadout: {
          weapon: 'citadel_weapon_bookworm_set2',
          melee: 'ability_melee_bookworm',
          // The four signature abilities, in slot order, the ultimate last.
          abilities: [
            'ability_bookworm_dragonfire',
            'ability_bookworm_knightbarrier',
            'ability_bookworm_aoemagic',
            'ability_bookworm_knightcharge',
          ],
        },
      },
    ]);
  });

  it('applies the rules of the playable heroes, sorted by id', () => {
    const heroes = parseHeroAssets([
      rawPaige(),
      rawHero(88, 'Baba', { in_development: true }),
      rawHero(90, 'Old', { disabled: true }),
      rawHero(91, 'Hidden', { player_selectable: false }),
      rawHero(1, ''),
      { id: 'x', name: 'Bad' },
      { id: 2, name: 'Infernus' },
    ]);

    expect(heroes.map((hero) => hero.name)).toEqual(['Infernus', 'Paige']);
  });

  it('leaves the image and the loadout null when the entry has neither', () => {
    expect(parseHeroAssets([{ id: 2, name: 'Infernus' }])).toStrictEqual([
      { id: 2, name: 'Infernus', imageUrl: null, loadout: null },
    ]);
  });

  it('leaves the loadout null when a signature is missing', () => {
    const complete = {
      weapon_primary: 'citadel_weapon_bookworm_set2',
      weapon_melee: 'ability_melee_bookworm',
      signature1: 'ability_bookworm_dragonfire',
      signature2: 'ability_bookworm_knightbarrier',
      signature3: 'ability_bookworm_aoemagic',
      signature4: 'ability_bookworm_knightcharge',
    };
    const incomplete: unknown[] = [
      // A missing slot, in turn.
      ...Object.keys(complete).map((missing) =>
        Object.fromEntries(Object.entries(complete).filter(([slot]) => slot !== missing)),
      ),
      // A slot that does not hold a class name.
      { ...complete, signature3: null },
      { ...complete, signature3: 7 },
      { ...complete, weapon_primary: '' },
      // The map itself is odd, or the slots are in camelCase.
      {},
      [],
      'items',
      { weaponPrimary: 'a', weaponMelee: 'b', signature1: 'c' },
    ];

    for (const items of incomplete) {
      const [paige] = parseHeroAssets([rawPaige(items)]);

      // The hero stays in the catalogue, with its image, only the loadout is unknown.
      expect(paige?.loadout).toBeNull();
      expect(paige?.imageUrl).toBe(`${HERO_IMAGES}/bookworm_sm.webp`);
    }
  });

  it('drops an image outside the asset bucket', () => {
    const [foreign, lookalike, fallback, absent] = parseHeroAssets([
      rawHero(1, 'Infernus', {
        images: {
          icon_image_small_webp: 'https://example.net/infernus.webp',
          icon_image_small: 'https://example.net/infernus.png',
        },
      }),
      rawHero(2, 'Seven', {
        images: {
          icon_image_small_webp: 'https://assets-bucket.deadlock-api.com.example.net/seven.webp',
          icon_image_small: 7,
        },
      }),
      // A foreign link never hides a usable one that comes later in the order.
      rawHero(3, 'Dynamo', {
        images: {
          icon_image_small_webp: 'https://example.net/dynamo.webp',
          icon_image_small: `${HERO_IMAGES}/dynamo_sm.png`,
        },
      }),
      rawHero(4, 'Haze', { images: {} }),
    ]);

    expect(foreign?.imageUrl).toBeNull();
    expect(lookalike?.imageUrl).toBeNull();
    expect(fallback?.imageUrl).toBe(`${HERO_IMAGES}/dynamo_sm.png`);
    expect(absent?.imageUrl).toBeNull();
  });

  it('keeps a hero whose images or items are of an unexpected shape', () => {
    // These fields only decorate a hero: they never cost it its place in the catalogue.
    const heroes = parseHeroAssets([
      rawHero(1, 'Infernus', { images: 'bookworm_sm.webp', items: ['weapon_primary'] }),
      rawHero(2, 'Seven', { images: null, items: null }),
    ]);

    expect(heroes).toStrictEqual([
      { id: 1, name: 'Infernus', imageUrl: null, loadout: null },
      { id: 2, name: 'Seven', imageUrl: null, loadout: null },
    ]);
  });

  it('rejects a body that is not an array, or with no playable hero', () => {
    expect(() => parseHeroAssets({})).toThrow(expect.objectContaining({ kind: 'invalid_payload' }));
    expect(() => parseHeroAssets([])).toThrow(expect.objectContaining({ kind: 'invalid_payload' }));
    expect(() => parseHeroAssets([rawHero(88, 'Baba', { disabled: true })])).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });
});

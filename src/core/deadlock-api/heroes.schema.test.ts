/**
 * Tests of the validation and mapping of deadlock-api's hero catalogue.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseHeroes } from './heroes.schema';

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

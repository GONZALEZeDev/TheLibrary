/**
 * Tests of the seeded randomness the fixtures share. A fixture is what its generator draws, in the
 * order it draws it: these tests pin the sequence of the generator and the number of draws of each
 * function, so that a change that would move every generated figure is caught here.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { between, createRandom, pick, shuffled } from './fixture-random';

/** A seed of the fixtures: the id of a match of the synthetic history. */
const SEED = 108_600_005;

describe('createRandom', () => {
  it('draws the mulberry32 sequence of its seed', () => {
    const random = createRandom(SEED);

    // Values of the generator as the fixtures have always drawn them from this seed.
    expect([random(), random(), random()]).toEqual([
      0.989381269318983, 0.7623393682297319, 0.11852858797647059,
    ]);
  });

  it('gives the same sequence for the same seed and another for another seed', () => {
    const draw = (seed: number) => {
      const random = createRandom(seed);
      return Array.from({ length: 20 }, () => random());
    };

    expect(draw(SEED)).toEqual(draw(SEED));
    expect(draw(SEED + 1)).not.toEqual(draw(SEED));
    expect(draw(SEED).every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('between', () => {
  it('draws once and maps the draw on the range', () => {
    const random = createRandom(SEED);
    const sameSequence = createRandom(SEED);

    const values = [1, 2, 3, 4].map(() => between(random, 1, 6));

    expect(values).toEqual([6, 5, 1, 1]);
    // One draw each: the generator is where four plain draws leave the other one.
    [1, 2, 3, 4].forEach(() => sameSequence());
    expect(random()).toBe(sameSequence());
  });

  it('reaches both ends of the range and never leaves it', () => {
    const random = createRandom(SEED);

    const values = Array.from({ length: 2_000 }, () => between(random, -3, 4));

    expect(Math.min(...values)).toBe(-3);
    expect(Math.max(...values)).toBe(4);
    expect(values.every((value) => Number.isInteger(value))).toBe(true);
  });
});

describe('pick', () => {
  it('draws once, like between, and returns the item at the drawn index', () => {
    const random = createRandom(42);
    const items = ['a', 'b', 'c', 'd'];

    expect([pick(random, items), pick(random, items)]).toEqual(['c', 'b']);
    const sameSequence = createRandom(42);
    expect(items[between(sameSequence, 0, items.length - 1)]).toBe('c');
  });

  it('throws on an empty list, after its draw', () => {
    const random = createRandom(SEED);
    const sameSequence = createRandom(SEED);

    expect(() => pick(random, [])).toThrow('Nothing to pick from a list of 0');
    sameSequence();
    expect(random()).toBe(sameSequence());
  });
});

describe('shuffled', () => {
  it('returns a permutation and leaves the list it was given alone', () => {
    const items = [1, 2, 3, 4, 5];

    const result = shuffled(createRandom(42), items);

    expect(result).toEqual([5, 2, 1, 4, 3]);
    expect(result.toSorted((a, b) => a - b)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  it('draws once per item', () => {
    const random = createRandom(42);
    const sameSequence = createRandom(42);

    shuffled(random, [1, 2, 3, 4, 5]);
    [1, 2, 3, 4, 5].forEach(() => sameSequence());

    // Both generators are where five draws leave them: the next draw is the same.
    expect(random()).toBe(sameSequence());
  });
});

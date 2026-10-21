/**
 * Seeded pseudo-randomness shared by the fixtures that invent a match.
 *
 * A fixture must give the same data at every run, which `Math.random()` cannot: everything is drawn
 * from a generator seeded by the match, and a fixture that needs several independent sequences
 * seeds one generator for each (see `match-metadata.fixture.ts`). The functions below draw from the
 * generator they are given, one draw for `between` and `pick` and one per item for `shuffled`; the
 * order of the draws is part of what a fixture generates, so they must not change.
 *
 * @packageDocumentation
 */

/** A function returning pseudo-random numbers in [0, 1). */
export type Random = () => number;

/**
 * A small deterministic pseudo-random generator (mulberry32). Same algorithm as
 * `match-history.fixture.ts`.
 *
 * @param seed - Any 32-bit integer.
 * @returns A function returning numbers in [0, 1).
 */
export function createRandom(seed: number): Random {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A pseudo-random whole number.
 *
 * @param random - The generator.
 * @param min - Smallest value.
 * @param max - Largest value (included).
 * @returns A whole number from `min` to `max`.
 */
export function between(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * A pseudo-random item of a list.
 *
 * It draws once, like {@link between}, whatever the list: asking for an item of an empty list is a
 * mistake of the fixture, not of the data, and throws.
 *
 * @param random - The generator.
 * @param items - A list that is not empty.
 * @returns One of its items.
 * @throws Error when the list is empty.
 */
export function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[between(random, 0, items.length - 1)];
  if (item === undefined) {
    throw new Error(`Nothing to pick from a list of ${String(items.length)}`);
  }
  return item;
}

/**
 * A shuffled copy of a list.
 *
 * @param random - The generator.
 * @param items - The list; it is not modified.
 * @returns The same items in a pseudo-random order.
 */
export function shuffled<T>(random: Random, items: readonly T[]): T[] {
  // Sorting on a random key per item is a fair shuffle as long as the keys are distinct.
  return items
    .map((item) => ({ item, key: random() }))
    .sort((first, second) => first.key - second.key)
    .map(({ item }) => item);
}

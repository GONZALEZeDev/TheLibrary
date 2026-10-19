/**
 * Tests of the reading of the sample size of a hero in deadlock-api's hero statistics
 * (`GET /v1/analytics/hero-stats`).
 *
 * Every payload here is synthetic: it has the shape of a real answer (a row per hero, with counters
 * the app does not read) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseHeroSample } from './hero-sample.schema';

/** The hero of the tests: Paige. */
const HERO_ID = 67;

/**
 * One row of the answer in the exact shape of the API (counters the app ignores included).
 *
 * @param heroId - The hero of the row.
 * @param matches - How many matches the row counts.
 * @param overrides - Fields to change.
 * @returns The raw row.
 */
function rawRow(heroId: number, matches: number, overrides: Record<string, unknown> = {}) {
  return {
    hero_id: heroId,
    bucket: 0,
    wins: Math.floor(matches / 2),
    losses: matches - Math.floor(matches / 2),
    matches,
    players: matches,
    total_kills: matches * 3,
    total_deaths: matches * 4,
    ...overrides,
  };
}

describe('parseHeroSample', () => {
  it('reads the matches of hero 67', () => {
    const body = [rawRow(1, 500), rawRow(HERO_ID, 1234), rawRow(2, 300)];

    expect(parseHeroSample(body, HERO_ID)).toBe(1234);
  });

  it('reads the matches of the hero it is asked for', () => {
    const body = [rawRow(1, 500), rawRow(HERO_ID, 1234), rawRow(2, 300)];

    expect(parseHeroSample(body, 2)).toBe(300);
  });

  it('answers 0 when hero 67 is absent', () => {
    expect(parseHeroSample([rawRow(1, 500), rawRow(2, 300)], HERO_ID)).toBe(0);
    expect(parseHeroSample([], HERO_ID)).toBe(0);
  });

  it('answers 0 for a hero with no match', () => {
    expect(parseHeroSample([rawRow(HERO_ID, 0)], HERO_ID)).toBe(0);
  });

  it('ignores the rows it cannot read', () => {
    const unreadable: unknown[] = [
      rawRow(HERO_ID, 50, { hero_id: '67' }),
      rawRow(HERO_ID, 50, { hero_id: 67.5 }),
      rawRow(HERO_ID, 50, { hero_id: null }),
      rawRow(HERO_ID, 50, { matches: '50' }),
      rawRow(HERO_ID, 50, { matches: 50.5 }),
      rawRow(HERO_ID, 50, { matches: -1 }),
      rawRow(HERO_ID, 50, { matches: null }),
      rawRow(HERO_ID, 50, { matches: Infinity }),
      { hero_id: HERO_ID },
      { matches: 50 },
      null,
      'text',
      42,
      [rawRow(HERO_ID, 50)],
    ];

    for (const row of unreadable) {
      expect(parseHeroSample([row], HERO_ID)).toBe(0);
      expect(parseHeroSample([row, rawRow(HERO_ID, 1234)], HERO_ID)).toBe(1234);
    }
  });

  it('reads the first readable row of the hero', () => {
    const body = [rawRow(HERO_ID, 10), rawRow(HERO_ID, 20)];

    expect(parseHeroSample(body, HERO_ID)).toBe(10);
  });

  it('refuses a body that is not an array, without quoting it', () => {
    // The planted text, like any value of the body, must stay out of the error.
    const planted = 'Planted 987654321';
    const bodies: unknown[] = [null, undefined, planted, 987654321, {}, rawRow(HERO_ID, 50)];
    for (const body of bodies) {
      expect(() => parseHeroSample(body, HERO_ID)).toThrow(
        expect.objectContaining({
          kind: 'invalid_payload',
          message: 'The hero statistics are invalid',
          context: { issue: '(root): invalid_type' },
        }),
      );
    }
  });
});

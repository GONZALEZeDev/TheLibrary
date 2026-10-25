/**
 * Tests of the resistance rows of the deaths tab of the review: the twelve resistance items, when the
 * player buys each of them, how often, the first one of each match and the deaths before it
 * ({@link resistanceReviewOf}), on matches and purchases written by hand.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { Phase } from '../core/analysis/phases';
import { RESISTANCE_ITEMS } from '../core/analysis/review/resistance-items';
import {
  deathsBeforeItemKey,
  itemBoughtAtKey,
  phaseDeathsKey,
  phaseDeathsWindowKey,
} from '../core/analysis/review/review-values';
import type { MatchId } from '../core/domain/match';
import { testMatchId } from '../test/test-data';
import type { ItemBenchmarkData, ItemBenchmarkRead } from './item-benchmark.service';
import type { RecentMatch } from './metrics.repository';
import { resistanceReviewOf } from './review-resistance';
import type { ResistanceItemView, ReviewMatch } from './review-view';

/** The length of most matches of the tests, in seconds: a match of the 30–35 minute window. */
const DURATION_S = 1_800;

/** The id of the most recent match of the tests; the earlier ones count down from it. */
const LAST_MATCH_ID = 700_000;

/** The start of the most recent match of the tests, in Unix seconds. */
const LAST_START_TIME = 1_790_000_000;

/** The time between the starts of two matches of the tests, in seconds. */
const MATCH_GAP_S = 3_600;

/** The asset id of the first resistance item of the tests; the others follow it, in list order. */
const FIRST_ITEM_ID = 5_000;

/** The asset id of a shop item that is not a resistance item. */
const OTHER_ITEM_ID = 9_999;

/**
 * One of the player's matches, numbered from the most recent (0) back.
 *
 * @param index - Its place from the most recent match: its id and start count down with it.
 * @param values - The values stored for it, by key.
 * @param durationS - Its length, in seconds.
 * @returns The match.
 */
function recentMatch(
  index: number,
  values: Readonly<Record<string, number | null>>,
  durationS: number = DURATION_S,
): RecentMatch {
  return {
    matchId: testMatchId(LAST_MATCH_ID - index),
    startTime: LAST_START_TIME - index * MATCH_GAP_S,
    durationS,
    values: new Map(Object.entries(values)),
  };
}

/**
 * One of the last matches. The resistance rows read no tier data, so the match carries none.
 *
 * @param index - Its place from the most recent match.
 * @param values - The values stored for it, by key.
 * @returns The match.
 */
function reviewMatch(index: number, values: Readonly<Record<string, number | null>>): ReviewMatch {
  return { match: recentMatch(index, values), reference: null };
}

/**
 * The stored deaths of a phase.
 *
 * @param phase - The phase.
 * @param whole - The deaths over the whole phase.
 * @param stretch - The deaths over the stretch of it the tier's data covers.
 * @returns The two values, by key.
 */
function phaseValues(phase: Phase, whole: number, stretch: number): Record<string, number> {
  return { [phaseDeathsKey(phase)]: whole, [phaseDeathsWindowKey(phase)]: stretch };
}

/**
 * The asset id of a resistance item of the tests.
 *
 * @param index - Its place in the list of resistance items.
 * @returns Its asset id.
 */
function idOf(index: number): number {
  return FIRST_ITEM_ID + index;
}

/**
 * The twelve resistance items as the catalogue names them, in list order.
 *
 * @param unknown - The class names of the items the catalogue does not know.
 * @returns The views.
 */
function itemViews(unknown: readonly string[] = []): ResistanceItemView[] {
  return RESISTANCE_ITEMS.map((item, index) => {
    const known = !unknown.includes(item.className);
    return {
      itemId: known ? idOf(index) : null,
      className: item.className,
      name: known ? `Test item ${String(index)}` : null,
      imageUrl: null,
      tier: item.tier,
      protects: item.protects,
    };
  });
}

/**
 * One purchase of the player in a match: the item, when it was first bought and the deaths before.
 */
type Purchase = readonly [itemId: number, boughtAtS: number, deathsBefore: number | null];

/**
 * The stored values of the purchases of a match.
 *
 * @param purchases - The purchases.
 * @param extra - Other values of the match.
 * @returns The values by key.
 */
function purchaseValues(
  purchases: readonly Purchase[],
  extra: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const values: Record<string, number> = { ...extra };
  for (const [itemId, boughtAtS, deathsBefore] of purchases) {
    values[itemBoughtAtKey(itemId)] = boughtAtS;
    if (deathsBefore !== null) {
      values[deathsBeforeItemKey(itemId)] = deathsBefore;
    }
  }
  return values;
}

/**
 * The item statistics of a tier.
 *
 * @param timings - For each item, its purchases by minute of the match.
 * @param overrides - What differs from usable statistics of 200 matches.
 * @returns What the cache read.
 */
function cachedBenchmark(
  timings: readonly (readonly [itemId: number, minutes: Readonly<Record<number, number>>])[],
  overrides: Partial<ItemBenchmarkData> = {},
): ItemBenchmarkRead {
  const items = new Map(
    timings.map(([itemId, minutes]) => {
      const byMinute = new Map(
        Object.entries(minutes).map(([minute, count]) => [Number(minute), count]),
      );
      const purchases = [...byMinute.values()].reduce((sum, count) => sum + count, 0);
      return [itemId, { purchases, minutes: byMinute }] as const;
    }),
  );
  return {
    kind: 'cached',
    stale: false,
    data: {
      wanted: { kind: 'tier', tier: 7 },
      used: { kind: 'tier', tier: 7 },
      sampleMatches: 200,
      items,
      fetchedAt: 1_700_000_000_000,
      ...overrides,
    },
  };
}

/**
 * The id of the match of the tests at a place.
 *
 * @param index - Its place from the most recent match.
 * @returns Its id.
 */
function matchIdAt(index: number): MatchId {
  return testMatchId(LAST_MATCH_ID - index);
}

describe('resistanceReviewOf', () => {
  it('places each resistance purchase in the tier minutes', () => {
    const items = itemViews();
    // The tier buys the first item between 4:00 and 9:59, 7.0 on average: 5 % in minute 4, 15 % in
    // minute 5, 30 % in minutes 6 and 7, 15 % in minute 8 and 5 % in minute 9.
    const benchmark = cachedBenchmark([[idOf(0), { 4: 5, 5: 15, 6: 30, 7: 30, 8: 15, 9: 5 }]]);
    // At 4:30 and 10:00, and four times at 7:00 (a third of the tier bought before, 30 % at the same
    // minute: the 65th percentile, which is neither early nor late).
    const recent = [270, 600, 420, 420, 420, 420].map((boughtAtS, index) =>
      reviewMatch(index, purchaseValues([[idOf(0), boughtAtS, 0]])),
    );
    // A match that did not buy the item is not in its row.
    recent.push(reviewMatch(6, purchaseValues([[idOf(1), 300, 0]])));
    const before = [600, 600, 600, 600, 600].map((boughtAtS, index) =>
      recentMatch(20 + index, purchaseValues([[idOf(0), boughtAtS, 0]])),
    );

    const { items: rows } = resistanceReviewOf(recent, before, items, benchmark);
    const minute = rows[0]?.minute;

    expect(minute).toMatchObject({
      subject: { kind: 'resistance_minute', item: items[0] },
      unit: 'minute',
      better: 'lower',
      value: 42.5 / 6,
      count: 6,
      comparedValue: 42.5 / 6,
      reference: 7,
      weak: 1,
      strong: 1,
      marked: 6,
      side: null,
      // The earlier matches bought it at 10:00: buying at 7:05 on average is earlier, so better.
      progress: { before: 10, direction: 'better' },
    });
    expect(minute?.difference).toEqual({ kind: 'absolute', amount: 42.5 / 6 - 7 });
    expect(minute?.matches.map(({ matchId, value, mark }) => [matchId, value, mark])).toEqual([
      [matchIdAt(0), 4.5, 'strong'],
      [matchIdAt(1), 10, 'weak'],
      [matchIdAt(2), 7, null],
      [matchIdAt(3), 7, null],
      [matchIdAt(4), 7, null],
      [matchIdAt(5), 7, null],
    ]);
  });

  it("gives the tier's pick rate without a mark", () => {
    const items = itemViews();
    // Half of the 200 matches of the tier bought the second item; the third was bought 300 times in
    // them, more than once in some matches: its rate is capped at 1.
    const benchmark = cachedBenchmark([
      [idOf(1), { 6: 100 }],
      [idOf(2), { 5: 300 }],
    ]);
    const recent = [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
      reviewMatch(
        index,
        purchaseValues([
          // Six of the eight matches bought the second item; all of them bought the third.
          ...(index < 6 ? [[idOf(1), 360, 0] as const] : []),
          [idOf(2), 300, 0],
        ]),
      ),
    );
    const before = [0, 1, 2, 3, 4].map((index) =>
      recentMatch(
        20 + index,
        // The others bought an item that is not a resistance item: their items are known.
        purchaseValues([index === 0 ? [idOf(1), 360, 0] : [OTHER_ITEM_ID, 360, 0]]),
      ),
    );

    const { items: rows } = resistanceReviewOf(recent, before, items, benchmark);
    const second = rows[1]?.rate;

    expect(second).toMatchObject({
      subject: { kind: 'resistance_rate', item: items[1] },
      unit: 'rate',
      better: null,
      value: 0.75,
      count: 8,
      comparedValue: 0.75,
      reference: 0.5,
      difference: { kind: 'absolute', amount: 0.25 },
      weak: 0,
      strong: 0,
      marked: 0,
      side: null,
      // One of five earlier matches bought it; a pick rate is neither better nor worse higher.
      progress: { before: 0.2, direction: null },
    });
    expect(second?.matches.map(({ value, mark }) => [value, mark])).toEqual([
      [1, null],
      [1, null],
      [1, null],
      [1, null],
      [1, null],
      [1, null],
      [0, null],
      [0, null],
    ]);
    expect(rows[2]?.rate).toMatchObject({ value: 1, comparedValue: 1, reference: 1 });
  });

  it('finds the first resistance item of each match', () => {
    const items = itemViews();
    const recent = [
      // The second item at 5:00, then the first one at 8:00; the 1:00 purchase of an item that is not a
      // resistance item is not the first.
      purchaseValues([
        [idOf(1), 300, 2],
        [idOf(0), 480, 3],
        [OTHER_ITEM_ID, 60, 0],
      ]),
      purchaseValues([[idOf(0), 600, 0]]),
      purchaseValues([[idOf(4), 450, 1]]),
      purchaseValues([[idOf(0), 450, 1]]),
      purchaseValues([[idOf(1), 450, 1]]),
      // No resistance item at all: no first minute, and every death counts.
      purchaseValues([[OTHER_ITEM_ID, 60, 0]], { deaths: 4 }),
    ].map((values, index) => reviewMatch(index, values));

    const { firstMinute, deathsBefore } = resistanceReviewOf(recent, [], items, {
      kind: 'missing',
    });

    expect(firstMinute).toMatchObject({
      subject: { kind: 'first_resistance_minute' },
      unit: 'minute',
      better: 'lower',
      value: 7.5,
      count: 5,
      comparedValue: null,
      reference: null,
      difference: null,
      marked: 0,
      weak: 0,
      strong: 0,
      side: null,
    });
    expect(firstMinute.matches.map(({ value, mark }) => [value, mark])).toEqual([
      [5, null],
      [10, null],
      [7.5, null],
      [7.5, null],
      [7.5, null],
    ]);
    // The deaths before the first item, not before the others: 2 (the second item), not 3.
    expect(deathsBefore.matches.map(({ matchId, value }) => [matchId, value])).toEqual([
      [matchIdAt(0), 2],
      [matchIdAt(1), 0],
      [matchIdAt(2), 1],
      [matchIdAt(3), 1],
      [matchIdAt(4), 1],
      [matchIdAt(5), 4],
    ]);
  });

  it('measures the progress of the first minute against the matches before', () => {
    const recent = [300, 300, 300, 300, 300].map((boughtAtS, index) =>
      reviewMatch(index, purchaseValues([[idOf(0), boughtAtS, 0]])),
    );
    // The earlier matches bought theirs at 9:00; one has no resistance item and is left out.
    const before = [
      ...[540, 540, 540, 540, 540].map((boughtAtS, index) =>
        recentMatch(20 + index, purchaseValues([[idOf(1), boughtAtS, 0]])),
      ),
      recentMatch(30, {}),
    ];

    const { firstMinute } = resistanceReviewOf(recent, before, itemViews(), { kind: 'missing' });

    expect(firstMinute.progress).toEqual({ before: 9, direction: 'better' });
  });

  it('counts every death of a match with no resistance purchase', () => {
    const recent = [
      // Five matches with no resistance item: their deaths, the `deaths` metric.
      ...[0, 1, 2, 3, 6].map((deaths, index) =>
        reviewMatch(index, purchaseValues([[OTHER_ITEM_ID, 120, deaths]], { deaths })),
      ),
      // A match that bought one but whose death details are incomplete: the deaths before the item are
      // not known, and its other deaths do not stand in for them.
      reviewMatch(5, purchaseValues([[idOf(0), 400, null]], { deaths: 9 })),
      // A match with no resistance item and no deaths stored has no value either.
      reviewMatch(6, purchaseValues([[OTHER_ITEM_ID, 120, 0]])),
    ];
    const before = [1, 1, 1, 1, 1].map((deaths, index) =>
      recentMatch(20 + index, purchaseValues([[OTHER_ITEM_ID, 120, deaths]], { deaths })),
    );

    const { deathsBefore } = resistanceReviewOf(recent, before, itemViews(), { kind: 'missing' });

    expect(deathsBefore).toMatchObject({
      subject: { kind: 'deaths_before_resistance' },
      unit: 'deaths',
      better: 'lower',
      value: 2.4,
      count: 5,
      reference: null,
      comparedValue: null,
      // The earlier matches died once, the last ones 2.4 times: worse, as the spread allows.
      progress: { before: 1, direction: 'worse' },
    });
    expect(deathsBefore.matches.map(({ value }) => value)).toEqual([0, 1, 2, 3, 6]);
  });

  it('leaves out a match whose items are unknown, and counts one that bought no resistance item', () => {
    const resistance = [0, 1, 2, 3, 4].map((index) =>
      reviewMatch(index, purchaseValues([[idOf(0), 420, 1]])),
    );
    const recent = [
      ...resistance,
      // Not a single shop purchase is stored: the item list of the archive was unreadable, and a
      // full match without a purchase does not happen. It did not buy nothing, it is not known.
      reviewMatch(5, { deaths: 7, ...phaseValues('early', 7, 7) }),
      // Shop purchases, none of them a resistance item: it bought none, and died 4 times before.
      reviewMatch(6, purchaseValues([[OTHER_ITEM_ID, 60, 4]], { deaths: 4 })),
    ];
    const before = [
      ...[0, 1, 2, 3, 4].map((index) =>
        recentMatch(20 + index, purchaseValues([[idOf(0), 600, 1]], { deaths: 1 })),
      ),
      recentMatch(30, { deaths: 9 }),
    ];

    const { items, firstMinute, deathsBefore } = resistanceReviewOf(recent, before, itemViews(), {
      kind: 'missing',
    });

    // Pick rates: the five that bought the first item, and the one that bought only another item.
    expect(items[0]?.rate).toMatchObject({ count: 6, value: 5 / 6 });
    expect(items[1]?.rate).toMatchObject({ count: 6, value: 0 });
    // The earlier matches bought the first item five times; the unknown one is not a sixth no.
    expect(items[0]?.rate.progress.before).toBe(1);
    expect(items[0]?.rate.matches.map(({ matchId }) => matchId)).not.toContain(matchIdAt(5));
    // The first minute: the five that bought a resistance item.
    expect(firstMinute.matches.map(({ matchId }) => matchId)).toEqual(
      resistance.map(({ match }) => match.matchId),
    );
    // The deaths before: the five before the item, and every death of the sixth, not the unknown one.
    expect(deathsBefore.matches.map(({ matchId, value }) => [matchId, value])).toEqual([
      ...resistance.map(({ match }) => [match.matchId, 1]),
      [matchIdAt(6), 4],
    ]);
    expect(deathsBefore.progress.before).toBe(1);
  });

  it('counts a purchase at the very start of the match', () => {
    const benchmark = cachedBenchmark([[idOf(0), { 0: 10 }]]);
    const recent = [0, 1, 2, 3, 4].map((index) =>
      reviewMatch(
        index,
        purchaseValues([
          [idOf(1), 300, 2],
          [idOf(0), 0, 0],
        ]),
      ),
    );

    const { items, firstMinute, deathsBefore } = resistanceReviewOf(
      recent,
      [],
      itemViews(),
      benchmark,
    );

    // Bought at 0:00 is bought, and is the first of the two, ahead of the 5:00 one.
    expect(items[0]?.minute).toMatchObject({ value: 0, count: 5, reference: 0.5 });
    expect(items[0]?.rate).toMatchObject({ value: 1, count: 5 });
    expect(firstMinute).toMatchObject({ value: 0, count: 5 });
    expect(deathsBefore).toMatchObject({ value: 0, count: 5 });
  });

  it('takes the first of the list when two resistance items were bought in the same second', () => {
    // The deaths before each item are written to differ, which the same second would not give: they
    // tell which of the two items was taken for the first.
    const recent = [0, 1, 2, 3, 4].map((index) =>
      reviewMatch(
        index,
        purchaseValues([
          [idOf(2), 420, 1],
          [idOf(7), 420, 4],
        ]),
      ),
    );

    const inOrder = resistanceReviewOf(recent, [], itemViews(), { kind: 'missing' });
    const reversed = resistanceReviewOf(recent, [], itemViews().toReversed(), {
      kind: 'missing',
    });

    expect(inOrder.deathsBefore.matches.map(({ value }) => value)).toEqual([1, 1, 1, 1, 1]);
    expect(reversed.deathsBefore.matches.map(({ value }) => value)).toEqual([4, 4, 4, 4, 4]);
    expect(inOrder.firstMinute.value).toBe(7);
  });

  it('gives no pick rate reference from statistics of no match', () => {
    // Statistics that are usable but say they hold no match: a share of nothing is no share.
    const benchmark = cachedBenchmark([[idOf(0), { 7: 10 }]], { sampleMatches: 0 });
    const recent = [0, 1, 2, 3, 4].map((index) =>
      reviewMatch(index, purchaseValues([[idOf(0), 420, 1]])),
    );

    const first = resistanceReviewOf(recent, [], itemViews(), benchmark).items[0];

    expect(first?.rate).toMatchObject({
      value: 1,
      comparedValue: null,
      reference: null,
      difference: null,
    });
    // The minutes of the item are still there to place a purchase on.
    expect(first?.minute).toMatchObject({ value: 7, reference: 7.5 });
  });

  it('marks three deaths before the first resistance item as weak', () => {
    // Three deaths are weak, none at all is strong, one or two are neither.
    const recent = [3, 2, 0, 5, 1].map((deaths, index) =>
      reviewMatch(index, purchaseValues([[idOf(3), 420, deaths]])),
    );

    const { deathsBefore } = resistanceReviewOf(recent, [], itemViews(), { kind: 'missing' });

    expect(deathsBefore.matches.map(({ mark }) => mark)).toEqual([
      'weak',
      null,
      'strong',
      'weak',
      null,
    ]);
    expect(deathsBefore).toMatchObject({ weak: 2, strong: 1, marked: 5, side: 'weakness' });
  });

  it('keeps a row for an item the catalogue does not know', () => {
    // Spellbreaker is not in the catalogue: it has a class name and nothing else.
    const items = itemViews(['upgrade_spellbreaker']);
    const unknown = items[8];
    const benchmark = cachedBenchmark([[idOf(0), { 7: 10 }]]);
    const recent = [0, 1, 2, 3, 4].map((index) =>
      reviewMatch(index, purchaseValues([[idOf(0), 420, 0]])),
    );

    const review = resistanceReviewOf(recent, [], items, benchmark);

    expect(unknown?.itemId).toBeNull();
    expect(review.items).toHaveLength(12);
    expect(review.items[8]).toMatchObject({
      item: unknown,
      minute: {
        subject: { kind: 'resistance_minute', item: unknown },
        value: null,
        count: 0,
        reference: null,
        matches: [],
      },
      rate: {
        subject: { kind: 'resistance_rate', item: unknown },
        value: null,
        count: 0,
        reference: null,
        matches: [],
      },
    });
    // The other items are not affected.
    expect(review.items[0]?.minute).toMatchObject({ value: 7, count: 5, reference: 7.5 });
  });

  it('keeps every item, in the order of the list, when nothing is known', () => {
    const items = itemViews();

    const review = resistanceReviewOf([], [], items, { kind: 'missing' });

    expect(review.items.map(({ item }) => item.className)).toEqual(
      RESISTANCE_ITEMS.map(({ className }) => className),
    );
    for (const { minute, rate } of review.items) {
      expect([minute.count, minute.value, rate.count, rate.value]).toEqual([0, null, 0, null]);
    }
    expect(review.firstMinute).toMatchObject({ value: null, count: 0, matches: [] });
    expect(review.deathsBefore).toMatchObject({ value: null, count: 0, matches: [] });
  });

  it('answers no reference without item statistics', () => {
    const items = itemViews();
    const recent = [0, 1, 2, 3, 4, 5].map((index) =>
      reviewMatch(index, purchaseValues([[idOf(0), 420, 1]])),
    );
    const benchmarks: readonly ItemBenchmarkRead[] = [
      // Nothing cached.
      { kind: 'missing' },
      // Cached, but even every rank holds too few matches: there is nothing to compare with.
      cachedBenchmark([], { used: null }),
      // Cached, but the item is not in them.
      cachedBenchmark([[idOf(5), { 7: 10 }]]),
    ];

    for (const benchmark of benchmarks) {
      const first = resistanceReviewOf(recent, [], items, benchmark).items[0];

      // The player's own figures stay; the tier's figures, the gap and the marks do not.
      expect(first?.minute).toMatchObject({
        value: 7,
        count: 6,
        comparedValue: null,
        reference: null,
        difference: null,
        marked: 0,
        weak: 0,
        strong: 0,
      });
      expect(first?.minute.matches.map(({ mark }) => mark)).toEqual(Array<null>(6).fill(null));
      expect(first?.rate).toMatchObject({
        value: 1,
        count: 6,
        comparedValue: null,
        reference: null,
        difference: null,
      });
    }
  });

  it('gives no minute reference and a rate of 0 for an item the tier did not buy', () => {
    // The statistics hold the item, with no purchase: a tier that never bought it has no minute.
    const benchmark = cachedBenchmark([[idOf(0), {}]]);
    const recent = [0, 1, 2, 3, 4].map((index) =>
      reviewMatch(index, purchaseValues([[idOf(0), 420, 0]])),
    );

    const first = resistanceReviewOf(recent, [], itemViews(), benchmark).items[0];

    expect(first?.minute).toMatchObject({ value: 7, reference: null, marked: 0 });
    expect(first?.rate).toMatchObject({ value: 1, comparedValue: 1, reference: 0 });
  });
});

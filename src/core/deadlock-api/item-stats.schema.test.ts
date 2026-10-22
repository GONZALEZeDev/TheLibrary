/**
 * Tests of the reading of the item purchases by minute in deadlock-api's item statistics
 * (`GET /v1/analytics/item-stats`, bucketed by minute of the game).
 *
 * Every payload here is synthetic: it has the shape of a real answer (a row per item and minute,
 * with counters the app does not read) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseItemStats } from './item-stats.schema';

/** An item of the tests, as the API numbers it. */
const ITEM_A = 2163598980;

/** Another item of the tests. */
const ITEM_B = 3970837787;

/**
 * One row of the answer in the exact shape of the API (counters the app ignores included).
 *
 * @param itemId - The item of the row.
 * @param bucket - The minute of the game the purchases were made in.
 * @param matches - How many purchases the row counts.
 * @param overrides - Fields to change.
 * @returns The raw row.
 */
function rawRow(
  itemId: number,
  bucket: number,
  matches: number,
  overrides: Record<string, unknown> = {},
) {
  const wins = Math.floor(matches / 2);
  return {
    item_id: itemId,
    bucket,
    wins,
    losses: matches - wins,
    matches,
    players: matches,
    avg_buy_time_s: bucket * 60 + 30,
    avg_sell_time_s: 0,
    avg_buy_time_relative: 50,
    avg_sell_time_relative: 0,
    sold: 0,
    ...overrides,
  };
}

describe('parseItemStats', () => {
  it('reads the purchases of each item by minute', () => {
    const body = [rawRow(ITEM_A, 28, 35), rawRow(ITEM_A, 29, 42), rawRow(ITEM_B, 12, 120)];

    expect(parseItemStats(body)).toEqual([
      { itemId: ITEM_A, minute: 28, purchases: 35 },
      { itemId: ITEM_A, minute: 29, purchases: 42 },
      { itemId: ITEM_B, minute: 12, purchases: 120 },
    ]);
  });

  it('lists the rows by item, then by minute, whatever the order of the answer', () => {
    const body = [rawRow(ITEM_B, 20, 1), rawRow(ITEM_A, 30, 2), rawRow(ITEM_B, 5, 3)];

    expect(parseItemStats(body).map((row) => [row.itemId, row.minute])).toEqual([
      [ITEM_A, 30],
      [ITEM_B, 5],
      [ITEM_B, 20],
    ]);
  });

  it('answers an empty list for an empty answer', () => {
    expect(parseItemStats([])).toEqual([]);
  });

  it('keeps minute 0 and a minute without purchases', () => {
    expect(parseItemStats([rawRow(ITEM_A, 0, 0)])).toEqual([
      { itemId: ITEM_A, minute: 0, purchases: 0 },
    ]);
  });

  it('sums the rows of the same item and minute', () => {
    const body = [rawRow(ITEM_A, 28, 35), rawRow(ITEM_B, 28, 4), rawRow(ITEM_A, 28, 5)];

    expect(parseItemStats(body)).toEqual([
      { itemId: ITEM_A, minute: 28, purchases: 40 },
      { itemId: ITEM_B, minute: 28, purchases: 4 },
    ]);
  });

  it('skips a row without an item or a bucket', () => {
    const rows = ['item_id', 'bucket', 'matches'].map((field) =>
      Object.fromEntries(Object.entries(rawRow(ITEM_A, 28, 35)).filter(([name]) => name !== field)),
    );

    expect(parseItemStats([...rows, rawRow(ITEM_B, 12, 7)])).toEqual([
      { itemId: ITEM_B, minute: 12, purchases: 7 },
    ]);
  });

  it('skips the rows it cannot read, and keeps the others', () => {
    const unreadable: unknown[] = [
      rawRow(ITEM_A, 28, 35, { item_id: '2163598980' }),
      rawRow(ITEM_A, 28, 35, { item_id: 2163598980.5 }),
      rawRow(ITEM_A, 28, 35, { item_id: 0 }),
      rawRow(ITEM_A, 28, 35, { item_id: -5 }),
      rawRow(ITEM_A, 28, 35, { item_id: null }),
      rawRow(ITEM_A, 28, 35, { bucket: '28' }),
      rawRow(ITEM_A, 28, 35, { bucket: 28.5 }),
      rawRow(ITEM_A, 28, 35, { bucket: -1 }),
      rawRow(ITEM_A, 28, 35, { bucket: null }),
      rawRow(ITEM_A, 28, 35, { matches: '35' }),
      rawRow(ITEM_A, 28, 35, { matches: 35.5 }),
      rawRow(ITEM_A, 28, 35, { matches: -1 }),
      rawRow(ITEM_A, 28, 35, { matches: null }),
      rawRow(ITEM_A, 28, 35, { matches: Infinity }),
      {},
      null,
      'text',
      42,
      [rawRow(ITEM_A, 28, 35)],
    ];
    const readable = { itemId: ITEM_B, minute: 12, purchases: 7 };

    for (const row of unreadable) {
      expect(parseItemStats([row])).toEqual([]);
      expect(parseItemStats([row, rawRow(ITEM_B, 12, 7)])).toEqual([readable]);
    }
  });

  it('does not let an unreadable row spoil the sum of a minute', () => {
    const body = [
      rawRow(ITEM_A, 28, 35),
      rawRow(ITEM_A, 28, 99, { matches: -1 }),
      rawRow(ITEM_A, 28, 5),
    ];

    expect(parseItemStats(body)).toEqual([{ itemId: ITEM_A, minute: 28, purchases: 40 }]);
  });

  it('refuses a body that is not an array, without quoting it', () => {
    // The planted text, like any value of the body, must stay out of the error.
    const planted = 'Planted 987654321';
    const bodies: unknown[] = [null, undefined, planted, 987654321, {}, rawRow(ITEM_A, 28, 35)];
    for (const body of bodies) {
      expect(() => parseItemStats(body)).toThrow(
        expect.objectContaining({
          kind: 'invalid_payload',
          message: 'The item statistics are invalid',
          context: { issue: '(root): invalid_type' },
        }),
      );
    }
  });
});

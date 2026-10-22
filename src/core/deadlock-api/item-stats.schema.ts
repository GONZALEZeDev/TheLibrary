/**
 * Validation of deadlock-api's item statistics by minute of the game
 * (`GET /v1/analytics/item-stats` with `bucket=game_time_min`).
 *
 * The answer is a JSON array with one row per (item, minute) pair: how many times the players of
 * the cohort bought the item in that minute of the match (`bucket` 14 is 14:00 to 14:59), plus
 * counters the app does not use (wins, distinct buyers, mean buy and sell times, sales). A purchase
 * is counted once per purchase, not once per player or per match, and an item bought and sold is
 * still counted. The app reads the item, the minute and the number of purchases, and nothing else:
 * from them it places the minute a rank tier usually buys an item.
 *
 * This module is lenient on purpose: a row it cannot read is skipped, and the others stay usable.
 * Only a body that is not even a list is an error.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';

/** The purchases of one item in one minute of the game, among the players of a cohort. */
export interface ItemStatsRow {
  /** The item, as deadlock-api numbers it (the `id` of the item catalogue). */
  readonly itemId: number;
  /** The minute of the game the purchases were made in: 14 stands for 14:00 to 14:59. */
  readonly minute: number;
  /** How many times the item was bought in that minute (0 or more). */
  readonly purchases: number;
}

/**
 * One row of the answer (only the fields the app uses). The object is loose: the other counters of
 * the row (wins, losses, distinct buyers, buy and sell times, sales) are none of the app's business
 * and are not read.
 */
const itemStatsRowSchema = z.looseObject({
  item_id: z.int().positive(),
  bucket: z.int().nonnegative(),
  matches: z.int().nonnegative(),
});

/** The body of the answer: a list of anything, each row being validated on its own. */
const itemStatsBodySchema = z.array(z.unknown());

/**
 * Read the purchases of every item by minute out of deadlock-api's item statistics.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The readable rows, sorted by item and then by minute, one per (item, minute) pair: the
 *   purchases of rows that share a pair are added together, so that a pair never has two values.
 *   The list is empty when the answer has no readable row.
 * @throws AppError of kind `invalid_payload` when the body is not an array (the context `issue` is
 *   `<path>: <code>` of the first problem, never a value of the payload).
 */
export function parseItemStats(body: unknown): readonly ItemStatsRow[] {
  const elements = itemStatsBodySchema.safeParse(body);
  if (!elements.success) {
    throw new AppError('invalid_payload', 'The item statistics are invalid', {
      context: { issue: describeFirstIssue(elements.error) },
    });
  }
  // Purchases by item, then by minute.
  const purchasesByItem = new Map<number, Map<number, number>>();
  for (const element of elements.data) {
    const row = itemStatsRowSchema.safeParse(element);
    // A row that does not fit the schema is skipped, never reported: one odd row must not hide the
    // others, and a repeated (item, minute) pair is added up rather than kept once.
    if (!row.success) {
      continue;
    }
    const { item_id: itemId, bucket: minute, matches: purchases } = row.data;
    const purchasesByMinute = purchasesByItem.get(itemId) ?? new Map<number, number>();
    purchasesByMinute.set(minute, (purchasesByMinute.get(minute) ?? 0) + purchases);
    purchasesByItem.set(itemId, purchasesByMinute);
  }
  return [...purchasesByItem]
    .toSorted(([first], [second]) => first - second)
    .flatMap(([itemId, purchasesByMinute]) =>
      [...purchasesByMinute]
        .toSorted(([first], [second]) => first - second)
        .map(([minute, purchases]) => ({ itemId, minute, purchases })),
    );
}

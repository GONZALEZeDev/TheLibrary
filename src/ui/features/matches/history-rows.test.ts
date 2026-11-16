import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { MatchListItem } from '../../../services/matches.service';
import { matchSummary } from '../../../test/test-data';
import { isLocked, toRows } from './history-rows';

/** A translation function that answers the key: "today" and "yesterday" read as their keys. */
const t = ((key: string) => key) as TFunction;

/** Noon of a local day of November 2026, in Unix milliseconds. */
function noonOf(day: number): number {
  return new Date(2026, 10, day, 12).getTime();
}

/** A listed match that started at a time. */
function listed(matchId: number, startTime: number): MatchListItem {
  return { ...matchSummary({ matchId, startTime }), detailStatus: 'ready' };
}

describe('toRows', () => {
  it('puts a day row before the matches of each day, and tints every other match of a day', () => {
    const now = noonOf(16);
    const rows = toRows(
      [
        listed(3, noonOf(16) / 1000 + 60),
        listed(2, noonOf(16) / 1000),
        listed(1, noonOf(15) / 1000),
      ],
      now,
      'en',
      t,
    );

    expect(rows.map((row) => (row.kind === 'day' ? row.label : row.striped))).toEqual([
      'matches.day.today',
      true,
      false,
      'matches.day.yesterday',
      true,
    ]);
    // A match row carries the label of its day, which names its link.
    expect(rows[4]).toMatchObject({ kind: 'match', dayLabel: 'matches.day.yesterday' });
  });
});

describe('isLocked', () => {
  it('locks only a match never tried while a synchronisation runs', () => {
    expect(isLocked('pending', true)).toBe(true);
    expect(isLocked('pending', false)).toBe(false);
    expect(isLocked('retry', true)).toBe(false);
    expect(isLocked(null, true)).toBe(false);
  });
});

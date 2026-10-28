/**
 * Tests of the date formats: the short and medium writings in French and English, the day of a time
 * told in the local time zone, and the "today" and "yesterday" of a time.
 *
 * Every time is built from local date parts (`new Date(year, month, day, hour, minute)`), so that no
 * test depends on the time zone of the machine that runs it.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  MS_PER_SECOND,
  formatMediumDate,
  formatMediumDateRange,
  formatMediumDateTime,
  formatShortDateTime,
  formatShortDateTimeMs,
  formatTime,
  localDayKey,
  relativeDay,
} from './date';

/**
 * A local time as the services give it: Unix seconds.
 *
 * @param year - Year.
 * @param month - Month, from 1 (January) to 12.
 * @param day - Day of the month.
 * @param hour - Hour, from 0 to 23.
 * @param minute - Minute.
 * @returns The Unix time, in seconds.
 */
function localSeconds(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime() / MS_PER_SECOND;
}

/**
 * A local time as the clock of the app gives it: Unix milliseconds.
 *
 * @param year - Year.
 * @param month - Month, from 1 (January) to 12.
 * @param day - Day of the month.
 * @param hour - Hour, from 0 to 23.
 * @param minute - Minute.
 * @returns The Unix time, in milliseconds.
 */
function localMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('date formats', () => {
  const evening = localSeconds(2026, 10, 20, 15, 45);

  it('writes a short date and time in French and English', () => {
    // `\s` stands for the (narrow) no-break space some versions of the locale data put before "PM".
    expect(formatShortDateTime(evening, 'en')).toMatch(/^10\/20\/26, 3:45\sPM$/);
    expect(formatShortDateTime(evening, 'fr')).toMatch(/^20\/10\/2026,? 15:45$/);
  });

  it('writes a short date and time of a time given in milliseconds like the one in seconds', () => {
    const eveningMs = localMs(2026, 10, 20, 15, 45);
    expect(formatShortDateTimeMs(eveningMs, 'en')).toBe(formatShortDateTime(evening, 'en'));
    expect(formatShortDateTimeMs(eveningMs, 'fr')).toBe(formatShortDateTime(evening, 'fr'));
    // The milliseconds of the time are dropped, not rounded up to the next second.
    expect(formatShortDateTimeMs(eveningMs + 999, 'en')).toBe(formatShortDateTime(evening, 'en'));
  });

  it('writes a medium date, a medium date and time, and a time', () => {
    expect(formatMediumDate(evening, 'en')).toBe('Oct 20, 2026');
    expect(formatMediumDate(evening, 'fr')).toBe('20 oct. 2026');
    expect(formatMediumDateTime(evening, 'en')).toMatch(/^Oct 20, 2026,? (at )?3:45\sPM$/);
    expect(formatMediumDateTime(evening, 'fr')).toMatch(/^20 oct. 2026,? (à )?15:45$/);
    expect(formatTime(evening, 'en')).toMatch(/^3:45\sPM$/);
    expect(formatTime(evening, 'fr')).toBe('15:45');
  });

  it('writes a span of days with the parts its two ends share written once', () => {
    const first = localSeconds(2026, 10, 1, 21, 10);
    // `\s*` stands for the thin spaces some versions of the locale data put around the dash.
    expect(formatMediumDateRange(first, evening, 'en')).toMatch(/^Oct 1\s*–\s*20, 2026$/u);
    expect(formatMediumDateRange(first, evening, 'fr')).toMatch(/^1\s*–\s*20 oct\. 2026$/u);
    // Across two months and two years, each end keeps what differs.
    const september = localSeconds(2026, 9, 28);
    expect(formatMediumDateRange(september, evening, 'en')).toMatch(/^Sep 28\s*–\s*Oct 20, 2026$/u);
    const lastYear = localSeconds(2025, 12, 30);
    expect(formatMediumDateRange(lastYear, evening, 'fr')).toMatch(
      /^30 déc\. 2025\s*–\s*20 oct\. 2026$/u,
    );
    // Two times of one day are that day.
    expect(formatMediumDateRange(localSeconds(2026, 10, 20, 9), evening, 'en')).toBe(
      'Oct 20, 2026',
    );
  });

  it('writes the same text on every call, the formatter being cached', () => {
    expect(formatMediumDate(evening, 'en')).toBe(formatMediumDate(evening, 'en'));
    expect(formatMediumDate(evening, 'en')).not.toBe(formatMediumDate(evening, 'fr'));
  });

  it('tells today and yesterday by the local day, across midnight', () => {
    // Just after midnight: the evening before is yesterday, though it is under 24 hours earlier.
    const justAfterMidnight = localMs(2026, 10, 21, 0, 5);
    expect(relativeDay(localSeconds(2026, 10, 20, 23, 55), justAfterMidnight)).toBe('yesterday');
    expect(relativeDay(localSeconds(2026, 10, 21, 0, 1), justAfterMidnight)).toBe('today');
    // Late in the evening: the morning of the same day is today, and the day before, over 24 hours
    // earlier than the morning but still yesterday.
    const lateEvening = localMs(2026, 10, 21, 23, 55);
    expect(relativeDay(localSeconds(2026, 10, 21, 0, 5), lateEvening)).toBe('today');
    expect(relativeDay(localSeconds(2026, 10, 20, 0, 5), lateEvening)).toBe('yesterday');
    // Two days earlier, or a later day, is neither.
    expect(relativeDay(localSeconds(2026, 10, 19, 23, 55), lateEvening)).toBeNull();
    expect(relativeDay(localSeconds(2026, 10, 22, 0, 5), lateEvening)).toBeNull();
  });

  it('tells yesterday across a month and a year', () => {
    expect(relativeDay(localSeconds(2026, 9, 30, 12), localMs(2026, 10, 1, 8))).toBe('yesterday');
    expect(relativeDay(localSeconds(2025, 12, 31, 12), localMs(2026, 1, 1, 8))).toBe('yesterday');
  });

  it('gives the same day key to two times of one local day', () => {
    const morning = localSeconds(2026, 10, 20, 0, 1);
    const night = localSeconds(2026, 10, 20, 23, 59);
    expect(localDayKey(morning)).toBe('2026-10-20');
    expect(localDayKey(night)).toBe(localDayKey(morning));
    expect(localDayKey(localSeconds(2026, 10, 21, 0, 1))).toBe('2026-10-21');
    // Months and days are on two digits, so that the keys sort as the days do.
    expect(localDayKey(localSeconds(2026, 3, 5, 12))).toBe('2026-03-05');
  });
});

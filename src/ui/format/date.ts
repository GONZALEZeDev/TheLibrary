/**
 * The date formatters that several screens of the interface share. Times are Unix seconds, as the
 * services give them for a match, except {@link formatShortDateTimeMs} and the `nowMs` of
 * {@link relativeDay}, which take the milliseconds the app stamps itself. A date is written in the
 * language of the interface and in the local time zone of the player; the day a time falls on (its
 * key, "today", "yesterday") is the local calendar day, not a span of 24 hours.
 *
 * @packageDocumentation
 */

/** Milliseconds in a second: the start of a match is in seconds, a date wants milliseconds. */
export const MS_PER_SECOND = 1_000;

/**
 * The formatters already built, by language and options. Building an `Intl.DateTimeFormat` is slow
 * next to using one, and a list writes a date for each of its rows, so each one is built once.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Get the formatter of a language and options, building it on the first ask.
 *
 * @param language - Language of the interface, e.g. `fr`.
 * @param options - How to write the date.
 * @returns The formatter, shared by every caller that asks for the same language and options.
 */
function formatterFor(language: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // The options are a few fixed styles, so their JSON text is a stable and unique key.
  const key = `${language}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(language, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Write a time as a short date and a short time, e.g. `10/20/26, 3:45 PM`.
 *
 * @param startTimeS - Time, in Unix seconds.
 * @param language - Language of the interface.
 * @returns The date and time in the local time zone.
 */
export function formatShortDateTime(startTimeS: number, language: string): string {
  return formatterFor(language, { dateStyle: 'short', timeStyle: 'short' }).format(
    startTimeS * MS_PER_SECOND,
  );
}

/**
 * Write a time given in milliseconds as a short date and a short time, e.g. `10/20/26, 3:45 PM`:
 * the writing of {@link formatShortDateTime} for the times the app stamps itself (a synchronisation,
 * a pause, a next attempt), which are in milliseconds and not in seconds.
 *
 * @param timeMs - Time, in Unix milliseconds.
 * @param language - Language of the interface.
 * @returns The date and time in the local time zone.
 */
export function formatShortDateTimeMs(timeMs: number, language: string): string {
  return formatShortDateTime(Math.floor(timeMs / MS_PER_SECOND), language);
}

/**
 * Write a time as a medium date, e.g. `Oct 20, 2026`.
 *
 * @param startTimeS - Time, in Unix seconds.
 * @param language - Language of the interface.
 * @returns The date in the local time zone.
 */
export function formatMediumDate(startTimeS: number, language: string): string {
  return formatterFor(language, { dateStyle: 'medium' }).format(startTimeS * MS_PER_SECOND);
}

/**
 * Write a span of days as medium dates, the parts the two ends share written once, e.g.
 * `Oct 1 – 28, 2026` (`1–28 oct. 2026` in French), or `Oct 20, 2026` when both ends fall on one day.
 *
 * @param startS - The first time of the span, in Unix seconds.
 * @param endS - The last time of the span, in Unix seconds, not before `startS`.
 * @param language - Language of the interface.
 * @returns The span in the local time zone.
 */
export function formatMediumDateRange(startS: number, endS: number, language: string): string {
  return formatterFor(language, { dateStyle: 'medium' }).formatRange(
    startS * MS_PER_SECOND,
    endS * MS_PER_SECOND,
  );
}

/**
 * Write a time as a medium date and a short time, e.g. `Oct 20, 2026, 3:45 PM`.
 *
 * @param startTimeS - Time, in Unix seconds.
 * @param language - Language of the interface.
 * @returns The date and time in the local time zone.
 */
export function formatMediumDateTime(startTimeS: number, language: string): string {
  return formatterFor(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    startTimeS * MS_PER_SECOND,
  );
}

/**
 * Write the time of day of a time, e.g. `3:45 PM`.
 *
 * @param startTimeS - Time, in Unix seconds.
 * @param language - Language of the interface.
 * @returns The time of day in the local time zone.
 */
export function formatTime(startTimeS: number, language: string): string {
  return formatterFor(language, { timeStyle: 'short' }).format(startTimeS * MS_PER_SECOND);
}

/**
 * Name the local calendar day of a time, to group times by day.
 *
 * @param startTimeS - Time, in Unix seconds.
 * @returns The local day as `YYYY-MM-DD`: two times of one local day give the same key, and the keys
 *   sort in the order of the days.
 */
export function localDayKey(startTimeS: number): string {
  const date = new Date(startTimeS * MS_PER_SECOND);
  // The local parts of the date, not its UTC ones: a match played at 1 am is of that day for the
  // player, whatever day it is in UTC.
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/**
 * Tell whether a time falls on the local day of now, or on the one before.
 *
 * @param startTimeS - Time, in Unix seconds.
 * @param nowMs - The current time, in Unix milliseconds.
 * @returns `today` or `yesterday` by calendar day (23:55 yesterday is `yesterday` at 00:05, though
 *   ten minutes earlier), and `null` for any other day, a later one included.
 */
export function relativeDay(startTimeS: number, nowMs: number): 'today' | 'yesterday' | null {
  const key = localDayKey(startTimeS);
  if (key === localDayKey(nowMs / MS_PER_SECOND)) {
    return 'today';
  }
  // Midnight of the day before, rebuilt from the local parts of now: a day is not always 24 hours
  // long (the clocks change), so it is not "now minus 24 hours".
  const now = new Date(nowMs);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return key === localDayKey(yesterday.getTime() / MS_PER_SECOND) ? 'yesterday' : null;
}

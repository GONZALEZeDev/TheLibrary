/**
 * The display formatters that several features of the interface share. A duration is written as
 * `minutes:seconds`.
 *
 * @packageDocumentation
 */

/**
 * Format a duration as `minutes:seconds`, e.g. `34:30`. Shared by the match list and the match
 * page, which show durations the same way.
 *
 * @param seconds - Duration in seconds.
 * @returns The formatted duration.
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

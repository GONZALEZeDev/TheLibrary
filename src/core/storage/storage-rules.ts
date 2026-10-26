/**
 * The rules of the size limit of the archive folder: the limits the player can choose, the archives
 * that are never removed, and how many matches a limit holds.
 *
 * The archive folder keeps one compressed file per Paige match. Past the limit, the storage service
 * removes the oldest files (the match keeps its stored metrics), but never the files of the most
 * recent matches, which the review reads.
 *
 * @packageDocumentation
 */
import { REVIEW_MATCHES } from '../analysis/insights/thresholds';

/**
 * How many of the newest Paige archives are never removed, whatever the limit: the review compares
 * the last {@link REVIEW_MATCHES} matches with as many before them, so it reads twice as many.
 */
export const PROTECTED_RECENT_ARCHIVES = 2 * REVIEW_MATCHES;

/** The limits the settings page offers, in megabytes: the only ones the settings keep. */
export const STORAGE_CAP_PRESETS_MB = [100, 250, 500, 1000, 2000, 5000] as const;

/** One of the {@link STORAGE_CAP_PRESETS_MB}. */
export type StorageCapMb = (typeof STORAGE_CAP_PRESETS_MB)[number];

/** The limit of a fresh installation, in megabytes. */
export const DEFAULT_STORAGE_CAP_MB: StorageCapMb = 500;

/**
 * The size of a typical archive, in bytes, measured on the archives of the current format: the
 * estimate of the capacity uses it until the player has an archive of that format to measure.
 */
export const TYPICAL_ARCHIVE_BYTES = 159_000;

/** One megabyte, in bytes: the limits are written in decimal megabytes, as the disks count them. */
const BYTES_PER_MB = 1_000_000;

/**
 * The size of a limit in bytes.
 *
 * @param capMb - The limit, in megabytes.
 * @returns The same limit, in bytes.
 */
export function capBytes(capMb: number): number {
  return capMb * BYTES_PER_MB;
}

/**
 * How many archives fit in a limit, for the "about N matches" of the settings page.
 *
 * @param capMb - The limit, in megabytes.
 * @param averageBytes - The mean size of the player's archives, in bytes, or `null` when there is
 *   none to measure.
 * @returns The number of whole archives of the mean size (or of {@link TYPICAL_ARCHIVE_BYTES} when
 *   no mean is known, or a mean of no bytes, which measures nothing) the limit holds.
 */
export function estimatedCapacity(capMb: number, averageBytes: number | null): number {
  const archiveBytes =
    averageBytes !== null && averageBytes > 0 ? averageBytes : TYPICAL_ARCHIVE_BYTES;
  return Math.floor(capBytes(capMb) / archiveBytes);
}

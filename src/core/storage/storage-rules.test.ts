/**
 * Tests of the rules of the archive folder's size limit.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { REVIEW_MATCHES } from '../analysis/insights/thresholds';
import {
  capBytes,
  DEFAULT_STORAGE_CAP_MB,
  estimatedCapacity,
  PROTECTED_RECENT_ARCHIVES,
  STORAGE_CAP_PRESETS_MB,
  TYPICAL_ARCHIVE_BYTES,
} from './storage-rules';

describe('the storage rules', () => {
  it('protects the archives of twice the matches of the review', () => {
    expect(PROTECTED_RECENT_ARCHIVES).toBe(2 * REVIEW_MATCHES);
    expect(PROTECTED_RECENT_ARCHIVES).toBe(40);
  });

  it('offers the presets, with the default among them', () => {
    expect(STORAGE_CAP_PRESETS_MB).toEqual([100, 250, 500, 1000, 2000, 5000]);
    expect(DEFAULT_STORAGE_CAP_MB).toBe(500);
    expect(STORAGE_CAP_PRESETS_MB).toContain(DEFAULT_STORAGE_CAP_MB);
  });

  it('counts a megabyte as a million bytes', () => {
    expect(capBytes(100)).toBe(100_000_000);
    expect(capBytes(5000)).toBe(5_000_000_000);
  });

  it('estimates the capacity from the measured average, else the typical size', () => {
    // A whole number of archives: the last one that would not fit entirely is not counted.
    expect(estimatedCapacity(500, 250_000)).toBe(2000);
    expect(estimatedCapacity(100, 300_001)).toBe(333);
    // Without a measured average, the typical size of an archive.
    expect(TYPICAL_ARCHIVE_BYTES).toBe(159_000);
    expect(estimatedCapacity(500, null)).toBe(Math.floor(500_000_000 / 159_000));
    // An average of no bytes measures nothing: the typical size again, never a division by zero.
    expect(estimatedCapacity(500, 0)).toBe(Math.floor(500_000_000 / 159_000));
  });
});

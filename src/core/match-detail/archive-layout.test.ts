/**
 * Tests of the layout of the archive folder.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testAccountId, testMatchId } from '../../test/test-data';
import {
  archiveFolder,
  archivePath,
  isTemporaryArchiveName,
  quarantineFileName,
  QUARANTINE_FOLDER,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from './archive-layout';

/** The account and the match of the tests. */
const ACCOUNT = testAccountId(123456789);
const MATCH = testMatchId(117958378);

describe('archive layout', () => {
  it('puts the archive of a match in the folder of its account', () => {
    expect(archiveFolder(ACCOUNT)).toBe('archive/123456789');
    expect(archivePath(ACCOUNT, MATCH)).toBe('archive/123456789/117958378.json.zst');
    expect(temporaryArchivePath(ACCOUNT, MATCH)).toBe('archive/123456789/117958378.json.zst.tmp');
    expect(QUARANTINE_FOLDER).toBe('archive/quarantine');
    expect(QUARANTINE_LIMIT).toBe(20);
  });

  it('recognises a temporary archive file by its name', () => {
    expect(isTemporaryArchiveName('117958378.json.zst.tmp')).toBe(true);
    expect(isTemporaryArchiveName('117958378.json.zst')).toBe(false);
  });

  it('pads the time of a quarantine file name to 15 digits', () => {
    expect(quarantineFileName(MATCH, 1_792_154_119_000)).toBe('001792154119000-117958378.json.zst');
  });

  it('makes quarantine file names sort by time', () => {
    // An older file with a shorter time must not sort after a newer one, as it would unpadded.
    const names = [
      quarantineFileName(MATCH, 1_792_154_119_000),
      quarantineFileName(testMatchId(5), 999_999_999_999),
      quarantineFileName(testMatchId(9), 1_792_154_118_999),
    ];
    expect([...names].sort()).toEqual([names[1], names[2], names[0]]);
  });
});

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
  isQuarantineFileName,
  isTemporaryArchiveName,
  quarantineFileName,
  quarantinePath,
  QUARANTINE_FOLDER,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from './archive-layout';

/** The account and the match of the tests (synthetic: the match id is no real match). */
const ACCOUNT = testAccountId(123456789);
const MATCH = testMatchId(100000001);

describe('archive layout', () => {
  it('puts the archive of a match in the folder of its account', () => {
    expect(archiveFolder(ACCOUNT)).toBe('archive/123456789');
    expect(archivePath(ACCOUNT, MATCH)).toBe('archive/123456789/100000001.json.zst');
    expect(temporaryArchivePath(ACCOUNT, MATCH)).toBe('archive/123456789/100000001.json.zst.tmp');
    expect(QUARANTINE_FOLDER).toBe('archive/quarantine');
    expect(QUARANTINE_LIMIT).toBe(20);
  });

  it('recognises a temporary archive file by its name', () => {
    expect(isTemporaryArchiveName('100000001.json.zst.tmp')).toBe(true);
    expect(isTemporaryArchiveName('100000001.json.zst')).toBe(false);
  });

  it('pads the time of a quarantine file name to 15 digits', () => {
    expect(quarantineFileName(MATCH, 1_792_154_119_000)).toBe('001792154119000-100000001.json.zst');
  });

  it('puts a quarantined response in the quarantine folder', () => {
    expect(quarantinePath(MATCH, 1_792_154_119_000)).toBe(
      'archive/quarantine/001792154119000-100000001.json.zst',
    );
    // The path is the folder and the file name, nothing else.
    expect(quarantinePath(MATCH, 42)).toBe(`${QUARANTINE_FOLDER}/${quarantineFileName(MATCH, 42)}`);
  });

  it.each([0, 42, 999_999_999_999, 1_792_154_119_000, 1_234_567_890_123_456])(
    'recognises every name that quarantineFileName builds (time %i)',
    (at) => {
      expect(isQuarantineFileName(quarantineFileName(MATCH, at))).toBe(true);
      expect(isQuarantineFileName(quarantineFileName(testMatchId(5), at))).toBe(true);
    },
  );

  it.each([
    '',
    'notes.txt',
    '000-notes.txt',
    // A time that is not padded to 15 digits was not made by the app.
    '1792154119000-100000001.json.zst',
    '001792154119000-.json.zst',
    '001792154119000-100000001.json',
    '001792154119000-100000001.json.zst.tmp',
    '001792154119000-abc.json.zst',
    'x001792154119000-100000001.json.zst',
    '100000001.json.zst',
  ])('does not take "%s" for a quarantined response', (name) => {
    expect(isQuarantineFileName(name)).toBe(false);
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

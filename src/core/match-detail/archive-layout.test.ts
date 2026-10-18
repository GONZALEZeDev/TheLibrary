/**
 * Tests of the layout of the archive folder.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testAccountId, testMatchId } from '../../test/test-data';
import {
  accountFolderName,
  archiveFolder,
  archivePath,
  isArchiveEntryName,
  isQuarantineFileName,
  isTemporaryArchiveName,
  LEGACY_QUARANTINE_ENTRY,
  quarantineFileName,
  quarantineFolder,
  quarantinePath,
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
    expect(QUARANTINE_LIMIT).toBe(20);
  });

  it('names the folder of an account after its id', () => {
    expect(accountFolderName(ACCOUNT)).toBe('123456789');
    // The folder of the archives is that name under the archive root, nothing else.
    expect(archiveFolder(ACCOUNT)).toBe(`archive/${accountFolderName(ACCOUNT)}`);
  });

  it('puts the quarantine in the folder of the account', () => {
    expect(quarantineFolder(ACCOUNT)).toBe('archive/123456789/quarantine');
    // It is inside the account folder, so that deleting the account deletes its quarantine too.
    expect(quarantineFolder(ACCOUNT).startsWith(`${archiveFolder(ACCOUNT)}/`)).toBe(true);
    // The folder of the first archive layout, directly under the root, is only known by its name.
    expect(LEGACY_QUARANTINE_ENTRY).toBe('quarantine');
  });

  it('recognises a temporary archive file by its name', () => {
    expect(isTemporaryArchiveName('100000001.json.zst.tmp')).toBe(true);
    expect(isTemporaryArchiveName('100000001.json.zst')).toBe(false);
  });

  it('pads the time of a quarantine file name to 15 digits', () => {
    expect(quarantineFileName(MATCH, 1_792_154_119_000)).toBe('001792154119000-100000001.json.zst');
  });

  it('puts a quarantined response in the quarantine folder of its account', () => {
    expect(quarantinePath(ACCOUNT, MATCH, 1_792_154_119_000)).toBe(
      'archive/123456789/quarantine/001792154119000-100000001.json.zst',
    );
    // The path is the folder and the file name, nothing else.
    expect(quarantinePath(ACCOUNT, MATCH, 42)).toBe(
      `${quarantineFolder(ACCOUNT)}/${quarantineFileName(MATCH, 42)}`,
    );
    // Another account has its own folder: a response never lands in the folder of someone else.
    expect(quarantinePath(testAccountId(987654321), MATCH, 42)).toBe(
      `archive/987654321/quarantine/${quarantineFileName(MATCH, 42)}`,
    );
  });

  it.each([
    '123',
    'quarantine',
    'x.tmp',
    '123456789',
    '.hidden',
    // A space or a dot inside the name, or at its start, is no trouble: only the end is stripped.
    ' x',
    'a b',
    'name..with.dots',
  ])('accepts "%s" as the name of an entry of the archive folder', (name) => {
    expect(isArchiveEntryName(name)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['the current folder', '.'],
    ['the parent folder', '..'],
    ['a path of two names', 'a/b'],
    ['a path from the root', '/a'],
    ['a trailing separator', 'a/'],
    ['a path of two names with a backslash', 'a\\b'],
    ['a parent with a backslash', '..\\a'],
    ['a drive', 'c:'],
    ['a stream of a file', 'a:b'],
    ['a name with a NUL', 'a\0b'],
    ['a name with a control character', 'a\u0001b'],
    ['a name with a control character at the end', 'ab\u001f'],
    // Windows strips the dots and the spaces at the end of a name: these resolve to `..` or to `x`.
    ['the parent folder followed by a space', '.. '],
    ['three dots followed by a space', '... '],
    ['a dot at the end', 'x.'],
    ['a space at the end', 'x '],
    ['a space only', ' '],
  ])('refuses the name of an entry that is %s', (_description, name) => {
    expect(isArchiveEntryName(name)).toBe(false);
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

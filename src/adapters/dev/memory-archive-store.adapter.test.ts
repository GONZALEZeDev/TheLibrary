/**
 * Tests of the in-memory archive store. The `files` map is read through its keys, which are the
 * paths of `core/match-detail/archive-layout.ts`: the tests build the expected keys with the same
 * functions, so a change of layout does not break them.
 *
 * Bytes are compared as plain arrays: under jsdom a `Uint8Array` made by a Node API is not an
 * `instanceof` the one of the test realm, so `toEqual` on the typed arrays would be unreliable.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  archivePath,
  ARCHIVE_ROOT,
  LEGACY_QUARANTINE_ENTRY,
  quarantineFolder,
  quarantinePath,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from '../../core/match-detail/archive-layout';
import { testAccountId, testMatchId } from '../../test/test-data';
import { MemoryArchiveStore } from './memory-archive-store.adapter';

/** The accounts and the matches of the tests. */
const ACCOUNT = testAccountId(123456789);
const OTHER_ACCOUNT = testAccountId(987654321);
const MATCH = testMatchId(100000001);
const OTHER_MATCH = testMatchId(100000002);

/** A quarantine time (Unix milliseconds) the tests count up from. */
const QUARANTINE_START = 1_792_154_119_000;

describe('MemoryArchiveStore', () => {
  it('reads back what it wrote', async () => {
    const store = new MemoryArchiveStore();
    await store.write(ACCOUNT, MATCH, new Uint8Array([1, 2, 3]));

    const bytes = await store.read(ACCOUNT, MATCH);
    expect(bytes === null ? null : Array.from(bytes)).toEqual([1, 2, 3]);
    // The archive sits at the path of the layout, and no temporary file stays behind.
    expect([...store.files.keys()]).toEqual([archivePath(ACCOUNT, MATCH)]);
  });

  it('returns null for a match never written', async () => {
    const store = new MemoryArchiveStore();
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));

    await expect(store.read(ACCOUNT, OTHER_MATCH)).resolves.toBeNull();
    // The archive of a match belongs to the account it was written for.
    await expect(store.read(OTHER_ACCOUNT, MATCH)).resolves.toBeNull();
  });

  it('replaces an archive', async () => {
    const store = new MemoryArchiveStore();
    await store.write(ACCOUNT, MATCH, new Uint8Array([1, 2, 3]));
    await store.write(ACCOUNT, MATCH, new Uint8Array([9]));

    const bytes = await store.read(ACCOUNT, MATCH);
    expect(bytes === null ? null : Array.from(bytes)).toEqual([9]);
    expect(store.files.size).toBe(1);
  });

  it('keeps its own copy of the bytes it is given and returns', async () => {
    const store = new MemoryArchiveStore();
    const written = new Uint8Array([1, 2, 3]);
    await store.write(ACCOUNT, MATCH, written);
    // Changing the array after the write must not change the stored archive...
    written[0] = 99;

    const firstRead = await store.read(ACCOUNT, MATCH);
    expect(firstRead === null ? null : Array.from(firstRead)).toEqual([1, 2, 3]);
    // ...and neither must changing an array that was read.
    firstRead?.fill(0);

    const secondRead = await store.read(ACCOUNT, MATCH);
    expect(secondRead === null ? null : Array.from(secondRead)).toEqual([1, 2, 3]);
  });

  it('removes the temporary files of an account only', async () => {
    const store = new MemoryArchiveStore();
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.write(OTHER_ACCOUNT, MATCH, new Uint8Array([2]));
    await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START, new Uint8Array([3]));
    store.addTemporaryFile(ACCOUNT, OTHER_MATCH);
    store.addTemporaryFile(OTHER_ACCOUNT, OTHER_MATCH);
    // A file named like a leftover, but inside the quarantine folder that the account folder holds.
    store.addFile(`${quarantineFolder(ACCOUNT)}/stray.json.zst.tmp`);
    expect(store.files.has(temporaryArchivePath(ACCOUNT, OTHER_MATCH))).toBe(true);

    await store.removeTemporaryFiles(ACCOUNT);

    // Only the temporary file of that account is gone: its archives, the other account's files
    // (temporary ones included), the quarantine and what the quarantine holds stay.
    expect([...store.files.keys()].sort()).toEqual(
      [
        archivePath(ACCOUNT, MATCH),
        archivePath(OTHER_ACCOUNT, MATCH),
        temporaryArchivePath(OTHER_ACCOUNT, OTHER_MATCH),
        quarantinePath(ACCOUNT, MATCH, QUARANTINE_START),
        `${quarantineFolder(ACCOUNT)}/stray.json.zst.tmp`,
      ].sort(),
    );
  });

  it('quarantines under the folder of the account and keeps the 20 most recent', async () => {
    const store = new MemoryArchiveStore();
    const writes = QUARANTINE_LIMIT + 5;
    for (let index = 0; index < writes; index += 1) {
      await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START + index, new Uint8Array([index]));
    }
    // Another account has fewer responses than the limit, written after those of the first one.
    for (let index = 0; index < 3; index += 1) {
      await store.quarantine(
        OTHER_ACCOUNT,
        MATCH,
        QUARANTINE_START + index,
        new Uint8Array([100 + index]),
      );
    }

    // The 5 oldest of the first account are gone, the 20 last remain. The other account keeps its 3:
    // the limit is per account, and trimming one folder never touches the other.
    const expectedNames = [
      ...Array.from({ length: QUARANTINE_LIMIT }, (_, offset) =>
        quarantinePath(ACCOUNT, MATCH, QUARANTINE_START + (writes - QUARANTINE_LIMIT) + offset),
      ),
      ...Array.from({ length: 3 }, (_, offset) =>
        quarantinePath(OTHER_ACCOUNT, MATCH, QUARANTINE_START + offset),
      ),
    ];
    expect([...store.files.keys()].sort()).toEqual(expectedNames.sort());
    // Every response is in the folder of its account, none in a quarantine folder shared by all.
    for (const path of store.files.keys()) {
      expect(path.startsWith(`${ARCHIVE_ROOT}/${LEGACY_QUARANTINE_ENTRY}/`)).toBe(false);
    }
    // The bytes of a kept response are the ones that were quarantined.
    const lastName = quarantinePath(ACCOUNT, MATCH, QUARANTINE_START + writes - 1);
    expect(Array.from(store.files.get(lastName) ?? [])).toEqual([writes - 1]);
  });

  it('trims the quarantine by the names of the responses only', async () => {
    const store = new MemoryArchiveStore();
    const folder = quarantineFolder(ACCOUNT);
    // A full folder, plus a file that is not a quarantined response and sorts before all of them.
    for (let index = 0; index < QUARANTINE_LIMIT; index += 1) {
      await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START + index, new Uint8Array([index]));
    }
    store.addFile(`${folder}/000-notes.txt`);

    await store.quarantine(
      ACCOUNT,
      MATCH,
      QUARANTINE_START + QUARANTINE_LIMIT,
      new Uint8Array([1]),
    );

    // Exactly one quarantined response went: the oldest of the 21. The foreign file stayed.
    expect(store.files.has(quarantinePath(ACCOUNT, MATCH, QUARANTINE_START))).toBe(false);
    expect(store.files.has(quarantinePath(ACCOUNT, MATCH, QUARANTINE_START + 1))).toBe(true);
    expect(store.files.has(`${folder}/000-notes.txt`)).toBe(true);
  });

  it('lists what the archive folder holds', async () => {
    const store = new MemoryArchiveStore();

    // Before the first write the archive folder does not exist.
    await expect(store.listEntries()).resolves.toEqual([]);

    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.write(ACCOUNT, OTHER_MATCH, new Uint8Array([2]));
    await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START, new Uint8Array([3]));
    await store.write(OTHER_ACCOUNT, MATCH, new Uint8Array([4]));
    // The folder of the first archive layout, and a file that is not the app's: both are entries.
    store.addFile(`${ARCHIVE_ROOT}/${LEGACY_QUARANTINE_ENTRY}/001792154119000-100000001.json.zst`);
    store.addFile(`${ARCHIVE_ROOT}/notes.txt`);

    const entries = await store.listEntries();

    // Each name once, folders and files alike; what the folders hold is not listed.
    expect([...entries].sort()).toEqual(
      [String(ACCOUNT), String(OTHER_ACCOUNT), LEGACY_QUARANTINE_ENTRY, 'notes.txt'].sort(),
    );
  });

  it('removes an entry with everything in it', async () => {
    const store = new MemoryArchiveStore();
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START, new Uint8Array([2]));
    store.addTemporaryFile(ACCOUNT, OTHER_MATCH);
    // An account whose id starts with the same digits is another entry.
    const longerAccount = testAccountId(1234567890);
    await store.write(longerAccount, MATCH, new Uint8Array([3]));
    await store.write(OTHER_ACCOUNT, MATCH, new Uint8Array([4]));

    await store.removeEntry(String(ACCOUNT));

    // The archives, the leftovers and the quarantine of the account are gone, nothing else.
    expect([...store.files.keys()].sort()).toEqual(
      [archivePath(longerAccount, MATCH), archivePath(OTHER_ACCOUNT, MATCH)].sort(),
    );
    const entries = await store.listEntries();
    expect([...entries].sort()).toEqual([String(longerAccount), String(OTHER_ACCOUNT)].sort());
  });

  it('removes a file that is directly under the archive folder', async () => {
    const store = new MemoryArchiveStore();
    store.addFile(`${ARCHIVE_ROOT}/notes.txt`);
    store.addFile(`${ARCHIVE_ROOT}/notes.txt.bak`);

    await store.removeEntry('notes.txt');

    expect([...store.files.keys()]).toEqual([`${ARCHIVE_ROOT}/notes.txt.bak`]);
  });

  it('does nothing for an entry that does not exist', async () => {
    const store = new MemoryArchiveStore();
    await store.write(OTHER_ACCOUNT, MATCH, new Uint8Array([1]));

    await expect(store.removeEntry(String(ACCOUNT))).resolves.toBeUndefined();

    expect([...store.files.keys()]).toEqual([archivePath(OTHER_ACCOUNT, MATCH)]);
  });

  it.each([
    '',
    '.',
    '..',
    'a/b',
    '../123456789',
    '/123456789',
    'a\\b',
    'c:',
    '.. ',
    '... ',
    'x.',
    'x ',
    'a\u0001b',
    'a\0b',
  ])('refuses the entry name "%s", which is not a single name', async (name) => {
    const store = new MemoryArchiveStore();
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    store.failNextRemove(new Error('disk error'));

    await expect(store.removeEntry(name)).rejects.toThrow(Error);

    // A programming error: nothing was touched, and the failure waiting for the next removal
    // was not used up by the refused name.
    expect([...store.files.keys()]).toEqual([archivePath(ACCOUNT, MATCH)]);
    await expect(store.removeEntry(String(ACCOUNT))).rejects.toThrow('disk error');
  });

  it('does not put the refused entry name in the error', async () => {
    const store = new MemoryArchiveStore();

    // The name of an entry can be an account id, which never goes in a message.
    await expect(store.removeEntry(`${String(ACCOUNT)}/..`)).rejects.not.toThrow(String(ACCOUNT));
  });

  it('fails the next write when asked', async () => {
    const store = new MemoryArchiveStore();
    store.failNextWrite(new Error('disk full'));

    await expect(store.write(ACCOUNT, MATCH, new Uint8Array([1]))).rejects.toThrow('disk full');
    // The failed write left nothing behind, and only that one write fails.
    expect(store.files.size).toBe(0);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    expect(store.files.size).toBe(1);
  });

  it('fails the next removal when asked', async () => {
    const store = new MemoryArchiveStore();
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    store.failNextRemove(new Error('access denied'));

    await expect(store.removeEntry(String(ACCOUNT))).rejects.toThrow('access denied');
    // The failed removal left everything in place, and only that one removal fails.
    expect([...store.files.keys()]).toEqual([archivePath(ACCOUNT, MATCH)]);
    await store.removeEntry(String(ACCOUNT));
    expect(store.files.size).toBe(0);
  });

  it('adds a file at a path, with one byte unless it is given bytes', () => {
    const store = new MemoryArchiveStore();

    store.addFile(`${ARCHIVE_ROOT}/a`);
    store.addFile(`${ARCHIVE_ROOT}/b`, new Uint8Array([7, 8]));

    expect(Array.from(store.files.get(`${ARCHIVE_ROOT}/a`) ?? [])).toEqual([0]);
    expect(Array.from(store.files.get(`${ARCHIVE_ROOT}/b`) ?? [])).toEqual([7, 8]);
  });
});

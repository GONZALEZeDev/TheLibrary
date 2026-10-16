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
  quarantineFileName,
  QUARANTINE_FOLDER,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from '../../core/match-detail/archive-layout';
import { testAccountId, testMatchId } from '../../test/test-data';
import { MemoryArchiveStore } from './memory-archive-store.adapter';

/** The accounts and the matches of the tests. */
const ACCOUNT = testAccountId(123456789);
const OTHER_ACCOUNT = testAccountId(987654321);
const MATCH = testMatchId(117958378);
const OTHER_MATCH = testMatchId(117958379);

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
    await store.quarantine(MATCH, QUARANTINE_START, new Uint8Array([3]));
    store.addTemporaryFile(ACCOUNT, OTHER_MATCH);
    store.addTemporaryFile(OTHER_ACCOUNT, OTHER_MATCH);
    expect(store.files.has(temporaryArchivePath(ACCOUNT, OTHER_MATCH))).toBe(true);

    await store.removeTemporaryFiles(ACCOUNT);

    // Only the temporary file of that account is gone: its archives, the other account's files
    // (temporary ones included) and the quarantine stay.
    expect([...store.files.keys()].sort()).toEqual(
      [
        archivePath(ACCOUNT, MATCH),
        archivePath(OTHER_ACCOUNT, MATCH),
        temporaryArchivePath(OTHER_ACCOUNT, OTHER_MATCH),
        `${QUARANTINE_FOLDER}/${quarantineFileName(MATCH, QUARANTINE_START)}`,
      ].sort(),
    );
  });

  it('keeps only the 20 most recent quarantined responses', async () => {
    const store = new MemoryArchiveStore();
    const writes = QUARANTINE_LIMIT + 5;
    for (let index = 0; index < writes; index += 1) {
      await store.quarantine(MATCH, QUARANTINE_START + index, new Uint8Array([index]));
    }

    // The 5 oldest are gone, the 20 last remain.
    const expectedNames = Array.from({ length: QUARANTINE_LIMIT }, (_, offset) => {
      const at = QUARANTINE_START + (writes - QUARANTINE_LIMIT) + offset;
      return `${QUARANTINE_FOLDER}/${quarantineFileName(MATCH, at)}`;
    });
    expect([...store.files.keys()].sort()).toEqual(expectedNames);
    // The bytes of a kept response are the ones that were quarantined.
    const lastName = `${QUARANTINE_FOLDER}/${quarantineFileName(MATCH, QUARANTINE_START + writes - 1)}`;
    expect(Array.from(store.files.get(lastName) ?? [])).toEqual([writes - 1]);
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
});

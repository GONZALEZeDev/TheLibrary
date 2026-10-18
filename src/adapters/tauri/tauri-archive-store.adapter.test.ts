/**
 * Tests of the Tauri archive store against a fake of the `@tauri-apps/plugin-fs` functions: no IPC
 * call is made. The fake keeps files and folders in memory, records every call it receives, and
 * fails like the real plugin where it matters here (a missing folder or file throws, a file needs
 * its folder to exist, a rename replaces its destination). The expected paths are built with the
 * functions of `core/match-detail/archive-layout.ts`, so a change of layout does not break them.
 *
 * Bytes are compared as plain arrays: under jsdom a `Uint8Array` made by a Node API is not an
 * `instanceof` the one of the test realm, so `toEqual` on the typed arrays would be unreliable.
 *
 * @packageDocumentation
 */
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import { describe, expect, it } from 'vitest';
import {
  archiveFolder,
  archivePath,
  ARCHIVE_ROOT,
  LEGACY_QUARANTINE_ENTRY,
  quarantineFolder,
  quarantinePath,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from '../../core/match-detail/archive-layout';
import { testAccountId, testMatchId } from '../../test/test-data';
import { TauriArchiveStore, type FsFunctions } from './tauri-archive-store.adapter';

/** The accounts and the matches of the tests. `ACCOUNT` is a prefix of `LONGER_ACCOUNT`. */
const ACCOUNT = testAccountId(1234);
const LONGER_ACCOUNT = testAccountId(12345);
const MATCH = testMatchId(100000001);
const OTHER_MATCH = testMatchId(100000002);

/** A quarantine time (Unix milliseconds) the tests count up from. */
const QUARANTINE_START = 1_792_154_119_000;

/** The names of the plugin functions the adapter uses. */
type FsFunctionName = keyof FsFunctions;

/** One call the fake received. */
interface RecordedCall {
  /** The plugin function that was called. */
  readonly name: FsFunctionName;
  /** The path argument (the source path of a rename). */
  readonly path: string;
  /** The destination of a rename. */
  readonly to?: string;
  /** The options argument, as the adapter gave it. */
  readonly options: unknown;
}

/** The fake plugin and what a test can do with it. */
interface FakeFs {
  /** The functions to give to the adapter. */
  readonly functions: FsFunctions;
  /** Every call received so far, in order. */
  readonly calls: RecordedCall[];
  /** The files: path → bytes. */
  readonly files: Map<string, Uint8Array>;
  /** The folders (every ancestor of a folder or a file is in it). */
  readonly folders: Set<string>;
  /**
   * Make the next call of a plugin function throw this error. Called again for the same function,
   * it queues: the failures are thrown one per call, in the order they were given.
   */
  failNext(name: FsFunctionName, error: Error): void;
}

/**
 * The folder that holds a path (`archive/1234/x.json.zst` gives `archive/1234`).
 *
 * @param path - A file or folder path, relative to the base directory.
 * @returns The folder above it, `''` for a top-level name.
 */
function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

/**
 * Create a fake of the plugin: empty disk, no failure queued.
 *
 * @returns The fake.
 */
function createFakeFs(): FakeFs {
  const calls: RecordedCall[] = [];
  const files = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  const failures = new Map<FsFunctionName, Error[]>();

  /**
   * Record a call, then either fail it (when a failure is queued for the function) or run what the
   * function does. A throw inside `action` becomes a rejection, as an IPC call would give.
   */
  const handle = <T>(call: RecordedCall, action: () => T): Promise<T> => {
    calls.push(call);
    const failure = failures.get(call.name)?.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    try {
      return Promise.resolve(action());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const functions: FsFunctions = {
    mkdir: (path, options) => {
      const target = path.toString();
      return handle({ name: 'mkdir', path: target, options }, () => {
        if (options?.recursive === true) {
          seedFolderOn(folders, target);
        } else if (parentOf(target) === '' || folders.has(parentOf(target))) {
          folders.add(target);
        } else {
          throw new Error(`mkdir: the parent of ${target} does not exist`);
        }
      });
    },
    writeFile: (path, data, options) => {
      const target = path.toString();
      return handle({ name: 'writeFile', path: target, options }, () => {
        // A stream would carry `getReader`: the adapter only ever writes bytes (no `instanceof`
        // check: a `Uint8Array` of another realm would fail it under jsdom).
        if ('getReader' in data) {
          throw new Error('writeFile: the fake only takes bytes');
        }
        if (!folders.has(parentOf(target))) {
          throw new Error(`writeFile: the folder of ${target} does not exist`);
        }
        files.set(target, data.slice());
      });
    },
    readFile: (path, options) => {
      const target = path.toString();
      return handle({ name: 'readFile', path: target, options }, () => {
        const bytes = files.get(target);
        if (bytes === undefined) {
          throw new Error(`readFile: ${target} does not exist`);
        }
        return bytes.slice();
      });
    },
    exists: (path, options) => {
      const target = path.toString();
      return handle({ name: 'exists', path: target, options }, () => {
        return files.has(target) || folders.has(target);
      });
    },
    readDir: (path, options) => {
      const target = path.toString();
      return handle({ name: 'readDir', path: target, options }, () => {
        if (!folders.has(target)) {
          throw new Error(`readDir: ${target} does not exist`);
        }
        // Direct children only. A real listing promises no order, so the fake lists the names in
        // descending order: the newest quarantined response first, the opposite of the order the
        // adapter wants. An adapter that trusted the listing instead of sorting it would fail.
        const children = [
          ...[...files.keys()]
            .filter((file) => parentOf(file) === target)
            .map((p) => ({ p, isFile: true })),
          ...[...folders]
            .filter((folder) => parentOf(folder) === target)
            .map((p) => ({ p, isFile: false })),
        ].sort((a, b) => (a.p < b.p ? 1 : -1));
        return children.map(({ p, isFile }) => ({
          name: p.slice(target.length + 1),
          isFile,
          isDirectory: !isFile,
          isSymlink: false,
        }));
      });
    },
    remove: (path, options) => {
      const target = path.toString();
      return handle({ name: 'remove', path: target, options }, () => {
        if (!folders.has(target)) {
          // Like the plugin, a missing path is an error, which is why the adapter asks `exists`.
          if (!files.delete(target)) {
            throw new Error(`remove: ${target} does not exist`);
          }
          return;
        }
        const below = `${target}/`;
        const hasContent =
          [...files.keys()].some((file) => file.startsWith(below)) ||
          [...folders].some((folder) => folder.startsWith(below));
        // Like the plugin: a folder with something in it goes only when the removal is recursive.
        if (hasContent && options?.recursive !== true) {
          throw new Error(`remove: ${target} is not empty`);
        }
        for (const file of [...files.keys()]) {
          if (file.startsWith(below)) {
            files.delete(file);
          }
        }
        for (const folder of [...folders]) {
          if (folder === target || folder.startsWith(below)) {
            folders.delete(folder);
          }
        }
      });
    },
    rename: (oldPath, newPath, options) => {
      const source = oldPath.toString();
      const destination = newPath.toString();
      return handle({ name: 'rename', path: source, to: destination, options }, () => {
        const bytes = files.get(source);
        if (bytes === undefined) {
          throw new Error(`rename: ${source} does not exist`);
        }
        // Like the plugin on Windows: an existing destination is replaced.
        files.delete(source);
        files.set(destination, bytes);
      });
    },
  };

  return {
    functions,
    calls,
    files,
    folders,
    failNext: (name, error) => {
      failures.set(name, [...(failures.get(name) ?? []), error]);
    },
  };
}

/**
 * Register a folder and every folder above it.
 *
 * @param folders - The folders of a fake disk.
 * @param path - The folder to add.
 */
function seedFolderOn(folders: Set<string>, path: string): void {
  for (let folder = path; folder !== ''; folder = parentOf(folder)) {
    folders.add(folder);
  }
}

/**
 * Put a file on the fake disk, as if an earlier run had left it. The call is not recorded.
 *
 * @param fake - The fake.
 * @param path - Where the file is.
 * @param content - Its bytes (defaults to one byte).
 */
function seedFile(fake: FakeFs, path: string, content: readonly number[] = [0]): void {
  seedFolderOn(fake.folders, parentOf(path));
  fake.files.set(path, Uint8Array.from(content));
}

/**
 * Put a folder (and its ancestors) on the fake disk. The call is not recorded.
 *
 * @param fake - The fake.
 * @param path - The folder.
 */
function seedFolder(fake: FakeFs, path: string): void {
  seedFolderOn(fake.folders, path);
}

/**
 * The bytes of a file of the fake disk, as a plain array.
 *
 * @param fake - The fake.
 * @param path - The file.
 * @returns The bytes, or `null` when the file does not exist.
 */
function bytesOf(fake: FakeFs, path: string): number[] | null {
  const bytes = fake.files.get(path);
  return bytes === undefined ? null : Array.from(bytes);
}

/**
 * The path of a response of `MATCH` quarantined for an account.
 *
 * @param at - When it was quarantined.
 * @param account - The account it was quarantined for; `ACCOUNT` by default.
 * @returns Its path under the quarantine folder of that account.
 */
function quarantinedAt(at: number, account = ACCOUNT): string {
  return quarantinePath(account, MATCH, at);
}

/**
 * The calls received so far, as `name path` lines: easy to compare, and to read in a failure.
 *
 * @param fake - The fake.
 * @returns One line per call, in order; a rename shows `source -> destination`.
 */
function callLines(fake: FakeFs): string[] {
  return fake.calls.map((call) =>
    call.to === undefined ? `${call.name} ${call.path}` : `${call.name} ${call.path} -> ${call.to}`,
  );
}

describe('TauriArchiveStore', () => {
  it('writes through a temporary file then renames it', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);

    await store.write(ACCOUNT, MATCH, new Uint8Array([1, 2, 3]));

    // The folder, then the bytes to the temporary file, then the rename over the final name: a
    // crash before the rename never leaves a half-written archive under the final name.
    expect(callLines(fake)).toEqual([
      `mkdir ${archiveFolder(ACCOUNT)}`,
      `writeFile ${temporaryArchivePath(ACCOUNT, MATCH)}`,
      `rename ${temporaryArchivePath(ACCOUNT, MATCH)} -> ${archivePath(ACCOUNT, MATCH)}`,
    ]);
    expect([...fake.files.keys()]).toEqual([archivePath(ACCOUNT, MATCH)]);
    expect(bytesOf(fake, archivePath(ACCOUNT, MATCH))).toEqual([1, 2, 3]);
  });

  it('replaces the archive a match already has', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1, 2, 3]));

    await store.write(ACCOUNT, MATCH, new Uint8Array([9]));

    expect([...fake.files.keys()]).toEqual([archivePath(ACCOUNT, MATCH)]);
    expect(bytesOf(fake, archivePath(ACCOUNT, MATCH))).toEqual([9]);
  });

  it('creates the account folder first', async () => {
    // Nothing on the disk yet: the fake refuses a file whose folder does not exist, as the plugin.
    const fake = createFakeFs();

    await new TauriArchiveStore(fake.functions).write(ACCOUNT, MATCH, new Uint8Array([1]));

    expect(fake.calls[0]).toMatchObject({
      name: 'mkdir',
      path: archiveFolder(ACCOUNT),
      // Recursive: the `archive` folder above does not exist on a first launch either.
      options: expect.objectContaining({ recursive: true }) as unknown,
    });
    expect(fake.folders.has(archiveFolder(ACCOUNT))).toBe(true);
  });

  it('removes the temporary file and rethrows when the write fails', async () => {
    const fake = createFakeFs();
    const failure = new Error('disk full');
    fake.failNext('writeFile', failure);

    await expect(
      new TauriArchiveStore(fake.functions).write(ACCOUNT, MATCH, new Uint8Array([1])),
    ).rejects.toBe(failure);

    // The cleanup is attempted even though the failed write left nothing (best effort).
    expect(callLines(fake)).toEqual([
      `mkdir ${archiveFolder(ACCOUNT)}`,
      `writeFile ${temporaryArchivePath(ACCOUNT, MATCH)}`,
      `remove ${temporaryArchivePath(ACCOUNT, MATCH)}`,
    ]);
    expect(fake.files.size).toBe(0);
  });

  it('removes the temporary file and keeps the previous archive when the rename fails', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1, 2, 3]));
    const failure = new Error('access denied');
    fake.failNext('rename', failure);

    await expect(store.write(ACCOUNT, MATCH, new Uint8Array([9]))).rejects.toBe(failure);

    // The temporary file written for the failed attempt is gone; the old archive is untouched.
    expect([...fake.files.keys()]).toEqual([archivePath(ACCOUNT, MATCH)]);
    expect(bytesOf(fake, archivePath(ACCOUNT, MATCH))).toEqual([1, 2, 3]);
  });

  it('rethrows the original error when the cleanup fails too', async () => {
    const fake = createFakeFs();
    const failure = new Error('disk full');
    fake.failNext('writeFile', failure);
    fake.failNext('remove', new Error('the cleanup error must not hide the cause'));

    await expect(
      new TauriArchiveStore(fake.functions).write(ACCOUNT, MATCH, new Uint8Array([1])),
    ).rejects.toBe(failure);
  });

  it('does not write anything when the folder cannot be created', async () => {
    const fake = createFakeFs();
    const failure = new Error('access denied');
    fake.failNext('mkdir', failure);

    await expect(
      new TauriArchiveStore(fake.functions).write(ACCOUNT, MATCH, new Uint8Array([1])),
    ).rejects.toBe(failure);

    // No temporary file exists yet: there is nothing to clean up.
    expect(callLines(fake)).toEqual([`mkdir ${archiveFolder(ACCOUNT)}`]);
  });

  it('reads back what it wrote', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1, 2, 3]));

    const bytes = await store.read(ACCOUNT, MATCH);

    expect(bytes === null ? null : Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('returns null for an absent archive', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    fake.calls.length = 0;

    await expect(store.read(ACCOUNT, OTHER_MATCH)).resolves.toBeNull();
    // The archive of a match belongs to the account it was written for.
    await expect(store.read(LONGER_ACCOUNT, MATCH)).resolves.toBeNull();

    // `readFile` throws on a missing path: the adapter asks `exists` first and never reads.
    expect(callLines(fake)).toEqual([
      `exists ${archivePath(ACCOUNT, OTHER_MATCH)}`,
      `exists ${archivePath(LONGER_ACCOUNT, MATCH)}`,
    ]);
  });

  it('removes only temporary files', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.write(LONGER_ACCOUNT, MATCH, new Uint8Array([2]));
    await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START, new Uint8Array([3]));
    seedFile(fake, temporaryArchivePath(ACCOUNT, OTHER_MATCH));
    seedFile(fake, temporaryArchivePath(LONGER_ACCOUNT, OTHER_MATCH));
    // A folder with the name of a temporary file is not a leftover of a write.
    seedFolder(fake, `${archiveFolder(ACCOUNT)}/nested.json.zst.tmp`);
    // Nor is a file named like one inside the quarantine folder, which sits in the listed folder.
    seedFile(fake, `${quarantineFolder(ACCOUNT)}/stray.json.zst.tmp`);
    fake.calls.length = 0;

    await store.removeTemporaryFiles(ACCOUNT);

    // Only the temporary file of that account is gone. Its archive, the files of an account whose
    // id starts with the same digits, and the quarantine stay.
    expect([...fake.files.keys()].sort()).toEqual(
      [
        archivePath(ACCOUNT, MATCH),
        archivePath(LONGER_ACCOUNT, MATCH),
        temporaryArchivePath(LONGER_ACCOUNT, OTHER_MATCH),
        quarantinedAt(QUARANTINE_START),
        `${quarantineFolder(ACCOUNT)}/stray.json.zst.tmp`,
      ].sort(),
    );
    expect(fake.folders.has(`${archiveFolder(ACCOUNT)}/nested.json.zst.tmp`)).toBe(true);
    // The quarantine folder is an entry of the listed folder: it is a folder, so it is left alone.
    expect(fake.folders.has(quarantineFolder(ACCOUNT))).toBe(true);
    // Only the folder of the account is listed, and the one file removed is the leftover.
    expect(fake.calls.filter((call) => call.name === 'readDir').map((call) => call.path)).toEqual([
      archiveFolder(ACCOUNT),
    ]);
    expect(fake.calls.filter((call) => call.name === 'remove').map((call) => call.path)).toEqual([
      temporaryArchivePath(ACCOUNT, OTHER_MATCH),
    ]);
  });

  it('removes nothing when the account has no folder', async () => {
    const fake = createFakeFs();

    await expect(
      new TauriArchiveStore(fake.functions).removeTemporaryFiles(ACCOUNT),
    ).resolves.toBeUndefined();

    // `readDir` throws on a missing folder: the adapter asks `exists` first and never lists.
    expect(callLines(fake)).toEqual([`exists ${archiveFolder(ACCOUNT)}`]);
  });

  it('tries every temporary file, then rejects with the first failure', async () => {
    const fake = createFakeFs();
    const leftovers = [OTHER_MATCH, testMatchId(100000003), testMatchId(100000004)].map((match) =>
      temporaryArchivePath(ACCOUNT, match),
    );
    for (const leftover of leftovers) {
      seedFile(fake, leftover);
    }
    // The first two removals fail (the fake lists the names in descending order, so these are the
    // two highest match ids): the third file is still tried, and the first error is the one thrown.
    const first = new Error('access denied');
    fake.failNext('remove', first);
    fake.failNext('remove', new Error('file in use'));

    await expect(new TauriArchiveStore(fake.functions).removeTemporaryFiles(ACCOUNT)).rejects.toBe(
      first,
    );

    // Every leftover got its `remove` call; only the one that could be removed is gone.
    expect(fake.calls.filter((call) => call.name === 'remove')).toHaveLength(leftovers.length);
    expect([...fake.files.keys()].sort()).toEqual(leftovers.slice(1).sort());
  });

  it('keeps a quarantined response in the quarantine folder, written directly', async () => {
    const fake = createFakeFs();

    await new TauriArchiveStore(fake.functions).quarantine(
      ACCOUNT,
      MATCH,
      QUARANTINE_START,
      new Uint8Array([7, 8]),
    );

    // Folder, file, listing for the trim. A half-written quarantined file is harmless (it is never
    // read back), so there is no temporary file and no rename.
    expect(callLines(fake)).toEqual([
      `mkdir ${quarantineFolder(ACCOUNT)}`,
      `writeFile ${quarantinedAt(QUARANTINE_START)}`,
      `readDir ${quarantineFolder(ACCOUNT)}`,
    ]);
    expect(fake.calls[0]?.options).toMatchObject({ recursive: true });
    expect(bytesOf(fake, quarantinedAt(QUARANTINE_START))).toEqual([7, 8]);
  });

  it('quarantines under the folder of the account and keeps the 20 most recent', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    const writes = QUARANTINE_LIMIT + 5;
    for (let index = 0; index < writes; index += 1) {
      await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START + index, new Uint8Array([index]));
    }
    // Another account has fewer responses than the limit, written after those of the first one.
    for (let index = 0; index < 3; index += 1) {
      await store.quarantine(
        LONGER_ACCOUNT,
        MATCH,
        QUARANTINE_START + index,
        new Uint8Array([100 + index]),
      );
    }

    // Everything is under the account folders, none in a quarantine folder shared by all.
    expect(fake.folders.has(`${ARCHIVE_ROOT}/${LEGACY_QUARANTINE_ENTRY}`)).toBe(false);
    // The 5 oldest of the first account are gone, the 20 last remain. The other account keeps its 3:
    // the limit is per account, and trimming one folder never touches the other.
    const expectedPaths = [
      ...Array.from({ length: QUARANTINE_LIMIT }, (_, offset) =>
        quarantinedAt(QUARANTINE_START + (writes - QUARANTINE_LIMIT) + offset),
      ),
      ...Array.from({ length: 3 }, (_, offset) =>
        quarantinedAt(QUARANTINE_START + offset, LONGER_ACCOUNT),
      ),
    ];
    expect([...fake.files.keys()].sort()).toEqual(expectedPaths.sort());
    // The bytes of a kept response are the ones that were quarantined.
    expect(bytesOf(fake, quarantinedAt(QUARANTINE_START + writes - 1))).toEqual([writes - 1]);
    expect(bytesOf(fake, quarantinedAt(QUARANTINE_START, LONGER_ACCOUNT))).toEqual([100]);
  });

  it('leaves the other entries of the quarantine folder alone when trimming', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    const folder = quarantineFolder(ACCOUNT);
    // A full folder, plus entries that are not quarantined responses and sort before all of them.
    for (let index = 0; index < QUARANTINE_LIMIT; index += 1) {
      seedFile(fake, quarantinedAt(QUARANTINE_START + index));
    }
    seedFile(fake, `${folder}/000-notes.txt`);
    seedFolder(fake, `${folder}/000000000000000-1.json.zst`);

    await store.quarantine(
      ACCOUNT,
      MATCH,
      QUARANTINE_START + QUARANTINE_LIMIT,
      new Uint8Array([1]),
    );

    // Exactly one quarantined response went: the oldest of the 21. The foreign entries stayed.
    expect(fake.files.has(quarantinedAt(QUARANTINE_START))).toBe(false);
    expect(fake.files.has(quarantinedAt(QUARANTINE_START + 1))).toBe(true);
    expect(fake.files.has(quarantinedAt(QUARANTINE_START + QUARANTINE_LIMIT))).toBe(true);
    expect(fake.files.has(`${folder}/000-notes.txt`)).toBe(true);
    expect(fake.folders.has(`${folder}/000000000000000-1.json.zst`)).toBe(true);
    expect(fake.calls.filter((call) => call.name === 'remove')).toHaveLength(1);
  });

  it('lists what the archive folder holds', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);

    // Before the first write the folder does not exist: nothing to list, and `readDir` (which
    // throws on a missing folder) is never called.
    await expect(store.listEntries()).resolves.toEqual([]);
    expect(callLines(fake)).toEqual([`exists ${ARCHIVE_ROOT}`]);

    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.write(LONGER_ACCOUNT, MATCH, new Uint8Array([2]));
    // The folder of the first archive layout, and a file that is not the app's: both are entries.
    seedFolder(fake, `${ARCHIVE_ROOT}/${LEGACY_QUARANTINE_ENTRY}`);
    seedFile(fake, `${ARCHIVE_ROOT}/notes.txt`);
    fake.calls.length = 0;

    const entries = await store.listEntries();

    // Folders and files, by name; what the folders hold is not listed. The order is the plugin's.
    expect([...entries].sort()).toEqual([
      String(ACCOUNT),
      String(LONGER_ACCOUNT),
      'notes.txt',
      LEGACY_QUARANTINE_ENTRY,
    ]);
    expect(callLines(fake)).toEqual([`exists ${ARCHIVE_ROOT}`, `readDir ${ARCHIVE_ROOT}`]);
  });

  it('removes an entry with everything in it', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START, new Uint8Array([2]));
    seedFile(fake, temporaryArchivePath(ACCOUNT, OTHER_MATCH));
    // An account whose id starts with the same digits is another entry.
    await store.write(LONGER_ACCOUNT, MATCH, new Uint8Array([3]));
    await store.quarantine(LONGER_ACCOUNT, MATCH, QUARANTINE_START, new Uint8Array([4]));

    await store.removeEntry(String(ACCOUNT));

    // The folder of the account, its archives, its leftovers and its quarantine are gone...
    expect(fake.folders.has(archiveFolder(ACCOUNT))).toBe(false);
    expect(fake.folders.has(quarantineFolder(ACCOUNT))).toBe(false);
    // ...and nothing else.
    expect([...fake.files.keys()].sort()).toEqual(
      [archivePath(LONGER_ACCOUNT, MATCH), quarantinedAt(QUARANTINE_START, LONGER_ACCOUNT)].sort(),
    );
    await expect(store.listEntries()).resolves.toEqual([String(LONGER_ACCOUNT)]);
  });

  it('removes a file that is directly under the archive folder', async () => {
    const fake = createFakeFs();
    seedFile(fake, `${ARCHIVE_ROOT}/notes.txt`);
    seedFile(fake, `${ARCHIVE_ROOT}/notes.txt.bak`);

    await new TauriArchiveStore(fake.functions).removeEntry('notes.txt');

    expect([...fake.files.keys()]).toEqual([`${ARCHIVE_ROOT}/notes.txt.bak`]);
  });

  it('removes recursively, after checking the entry exists', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    fake.calls.length = 0;

    await store.removeEntry(String(ACCOUNT));

    // The plugin errors on a missing path, so the adapter asks `exists` first. The removal is
    // recursive: it empties the folder of an account in one call, without following links.
    expect(callLines(fake)).toEqual([
      `exists ${archiveFolder(ACCOUNT)}`,
      `remove ${archiveFolder(ACCOUNT)}`,
    ]);
    expect(fake.calls[1]?.options).toMatchObject({
      baseDir: BaseDirectory.AppLocalData,
      recursive: true,
    });
  });

  it('does nothing for an entry that does not exist', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(LONGER_ACCOUNT, MATCH, new Uint8Array([1]));
    fake.calls.length = 0;

    // Neither the account of another id nor an archive folder that was never made is an error.
    await expect(store.removeEntry(String(ACCOUNT))).resolves.toBeUndefined();

    // `remove` throws on a missing path: the adapter asks `exists` first and never removes.
    expect(callLines(fake)).toEqual([`exists ${archiveFolder(ACCOUNT)}`]);
    expect([...fake.files.keys()]).toEqual([archivePath(LONGER_ACCOUNT, MATCH)]);
  });

  it.each([
    '',
    '.',
    '..',
    'a/b',
    '../1234',
    '/1234',
    'a\\b',
    'c:',
    '.. ',
    '... ',
    'x.',
    'x ',
    'a\u0001b',
    'a\0b',
  ])('refuses the entry name "%s", which is not a single name', async (name) => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    fake.calls.length = 0;

    await expect(store.removeEntry(name)).rejects.toThrow(Error);

    // A programming error: it is refused before the plugin is called, so nothing was touched.
    expect(fake.calls).toEqual([]);
    expect([...fake.files.keys()]).toEqual([archivePath(ACCOUNT, MATCH)]);
  });

  it('does not put the refused entry name in the error', async () => {
    const fake = createFakeFs();
    // The name of an entry can be an account id, which never goes in a message.
    const name = `${String(LONGER_ACCOUNT)}/..`;

    const refusal = new TauriArchiveStore(fake.functions).removeEntry(name);

    await expect(refusal).rejects.not.toThrow(String(LONGER_ACCOUNT));
  });

  it('uses the local application data folder for every call', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    // Every function of the plugin gets called: writing, reading, cleaning, quarantining
    // (twenty-one responses, so that the trim removes one), listing and removing an entry.
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.read(ACCOUNT, MATCH);
    await store.read(ACCOUNT, OTHER_MATCH);
    seedFile(fake, temporaryArchivePath(ACCOUNT, OTHER_MATCH));
    await store.removeTemporaryFiles(ACCOUNT);
    for (let index = 0; index <= QUARANTINE_LIMIT; index += 1) {
      await store.quarantine(ACCOUNT, MATCH, QUARANTINE_START + index, new Uint8Array([index]));
    }
    await store.listEntries();
    await store.removeEntry(String(ACCOUNT));

    const names = new Set(fake.calls.map((call) => call.name));
    expect([...names].sort()).toEqual(
      ['exists', 'mkdir', 'readDir', 'readFile', 'remove', 'rename', 'writeFile'].sort(),
    );
    for (const call of fake.calls) {
      const expected =
        call.name === 'rename'
          ? {
              oldPathBaseDir: BaseDirectory.AppLocalData,
              newPathBaseDir: BaseDirectory.AppLocalData,
            }
          : { baseDir: BaseDirectory.AppLocalData };
      expect(call.options, `${call.name} ${call.path}`).toMatchObject(expected);
    }
  });
});

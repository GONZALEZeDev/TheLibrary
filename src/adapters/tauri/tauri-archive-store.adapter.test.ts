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
  quarantineFileName,
  QUARANTINE_FOLDER,
  QUARANTINE_LIMIT,
  temporaryArchivePath,
} from '../../core/match-detail/archive-layout';
import { testAccountId, testMatchId } from '../../test/test-data';
import { TauriArchiveStore, type FsFunctions } from './tauri-archive-store.adapter';

/** The accounts and the matches of the tests. `ACCOUNT` is a prefix of `LONGER_ACCOUNT`. */
const ACCOUNT = testAccountId(1234);
const LONGER_ACCOUNT = testAccountId(12345);
const MATCH = testMatchId(117958378);
const OTHER_MATCH = testMatchId(117958379);

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
        if (!files.delete(target)) {
          throw new Error(`remove: ${target} is not a file`);
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
 * The path of a quarantined response.
 *
 * @param at - When it was quarantined.
 * @returns Its path under the quarantine folder.
 */
function quarantinePath(at: number): string {
  return `${QUARANTINE_FOLDER}/${quarantineFileName(MATCH, at)}`;
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
    await store.quarantine(MATCH, QUARANTINE_START, new Uint8Array([3]));
    seedFile(fake, temporaryArchivePath(ACCOUNT, OTHER_MATCH));
    seedFile(fake, temporaryArchivePath(LONGER_ACCOUNT, OTHER_MATCH));
    // A folder with the name of a temporary file is not a leftover of a write.
    seedFolder(fake, `${archiveFolder(ACCOUNT)}/nested.json.zst.tmp`);
    fake.calls.length = 0;

    await store.removeTemporaryFiles(ACCOUNT);

    // Only the temporary file of that account is gone. Its archive, the files of an account whose
    // id starts with the same digits, and the quarantine stay.
    expect([...fake.files.keys()].sort()).toEqual(
      [
        archivePath(ACCOUNT, MATCH),
        archivePath(LONGER_ACCOUNT, MATCH),
        temporaryArchivePath(LONGER_ACCOUNT, OTHER_MATCH),
        quarantinePath(QUARANTINE_START),
      ].sort(),
    );
    expect(fake.folders.has(`${archiveFolder(ACCOUNT)}/nested.json.zst.tmp`)).toBe(true);
    // Only the folder of the account is listed.
    expect(fake.calls.filter((call) => call.name === 'readDir').map((call) => call.path)).toEqual([
      archiveFolder(ACCOUNT),
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
    const leftovers = [OTHER_MATCH, testMatchId(117958380), testMatchId(117958381)].map((match) =>
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
      MATCH,
      QUARANTINE_START,
      new Uint8Array([7, 8]),
    );

    // Folder, file, listing for the trim. A half-written quarantined file is harmless (it is never
    // read back), so there is no temporary file and no rename.
    expect(callLines(fake)).toEqual([
      `mkdir ${QUARANTINE_FOLDER}`,
      `writeFile ${quarantinePath(QUARANTINE_START)}`,
      `readDir ${QUARANTINE_FOLDER}`,
    ]);
    expect(fake.calls[0]?.options).toMatchObject({ recursive: true });
    expect(bytesOf(fake, quarantinePath(QUARANTINE_START))).toEqual([7, 8]);
  });

  it('keeps the 20 most recent quarantined responses', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    const writes = QUARANTINE_LIMIT + 5;
    for (let index = 0; index < writes; index += 1) {
      await store.quarantine(MATCH, QUARANTINE_START + index, new Uint8Array([index]));
    }

    // The 5 oldest are gone, the 20 last remain.
    const expectedPaths = Array.from({ length: QUARANTINE_LIMIT }, (_, offset) =>
      quarantinePath(QUARANTINE_START + (writes - QUARANTINE_LIMIT) + offset),
    );
    expect([...fake.files.keys()].sort()).toEqual(expectedPaths);
    // The bytes of a kept response are the ones that were quarantined.
    expect(bytesOf(fake, quarantinePath(QUARANTINE_START + writes - 1))).toEqual([writes - 1]);
  });

  it('leaves the other entries of the quarantine folder alone when trimming', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    // A full folder, plus entries that are not quarantined responses and sort before all of them.
    for (let index = 0; index < QUARANTINE_LIMIT; index += 1) {
      seedFile(fake, quarantinePath(QUARANTINE_START + index));
    }
    seedFile(fake, `${QUARANTINE_FOLDER}/000-notes.txt`);
    seedFolder(fake, `${QUARANTINE_FOLDER}/000000000000000-1.json.zst`);

    await store.quarantine(MATCH, QUARANTINE_START + QUARANTINE_LIMIT, new Uint8Array([1]));

    // Exactly one quarantined response went: the oldest of the 21. The foreign entries stayed.
    expect(fake.files.has(quarantinePath(QUARANTINE_START))).toBe(false);
    expect(fake.files.has(quarantinePath(QUARANTINE_START + 1))).toBe(true);
    expect(fake.files.has(quarantinePath(QUARANTINE_START + QUARANTINE_LIMIT))).toBe(true);
    expect(fake.files.has(`${QUARANTINE_FOLDER}/000-notes.txt`)).toBe(true);
    expect(fake.folders.has(`${QUARANTINE_FOLDER}/000000000000000-1.json.zst`)).toBe(true);
    expect(fake.calls.filter((call) => call.name === 'remove')).toHaveLength(1);
  });

  it('uses the local application data folder for every call', async () => {
    const fake = createFakeFs();
    const store = new TauriArchiveStore(fake.functions);
    // Every function of the plugin gets called: writing, reading, cleaning and quarantining
    // (twenty-one responses, so that the trim removes one).
    await store.write(ACCOUNT, MATCH, new Uint8Array([1]));
    await store.read(ACCOUNT, MATCH);
    await store.read(ACCOUNT, OTHER_MATCH);
    seedFile(fake, temporaryArchivePath(ACCOUNT, OTHER_MATCH));
    await store.removeTemporaryFiles(ACCOUNT);
    for (let index = 0; index <= QUARANTINE_LIMIT; index += 1) {
      await store.quarantine(MATCH, QUARANTINE_START + index, new Uint8Array([index]));
    }

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

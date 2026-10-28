/**
 * Pins the database migrations that were shipped in a public release.
 *
 * The SQL plugin records a checksum of every migration it applies. An installed app whose
 * database already holds a migration refuses to start when the file of that migration changes, so
 * a released migration must never be edited: a change to the schema is always a new numbered file.
 * This test fails as soon as a released file changes by one byte.
 *
 * At each release that adds migrations, add their hashes here (`sha256sum migrations/<file>`).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Folder of the migrations, from the repository root (where Vitest runs). */
const MIGRATIONS_DIR = 'migrations';

/** SHA-256 of each migration shipped in a release, first shipped in TheLibrary 0.1.0. */
const RELEASED_MIGRATIONS: Readonly<Record<string, string>> = {
  '0001_init.sql': '3e856c1698908f7003496cb9590d0b2375016d7495da50987e51d9857a7c652d',
  '0002_match_detail.sql': '04e20226df7cf4a06ca54d6ca624610e82dd08fd6ff6a82ecd54646b93de71e3',
  '0003_account.sql': '2d2355f93666a8f309da4d92a1a05c20d0ea288eb89e927ead8c3766f19c687b',
  '0004_analysis.sql': '5f72e35751ee8727c2765559162d82eac4d113f25654424c3ecbf89a0dc1ba57',
  '0005_archive_format.sql': 'e3a44f7334b739c806c09bcd73481229e18f0e1b02aa556d7bfab6e55871bffd',
  '0006_evicted_status.sql': '9a5efd3b0a7b3c47423d03e83160849271fc12c1fc9f419cd396e20c18b1ac2f',
};

/** Number of the latest released migration: every file up to it must be pinned. */
const LATEST_RELEASED = 6;

/**
 * Hash raw bytes the way `sha256sum` does.
 *
 * @param bytes - The content.
 * @returns The lowercase hexadecimal SHA-256.
 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('released migrations', () => {
  it('hashes the raw bytes', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it.each(Object.entries(RELEASED_MIGRATIONS))('keeps %s exactly as released', (file, hash) => {
    expect(sha256Hex(readFileSync(join(MIGRATIONS_DIR, file)))).toBe(hash);
  });

  it('pins every migration up to the latest released one', () => {
    const released = readdirSync(MIGRATIONS_DIR).filter(
      (file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= LATEST_RELEASED,
    );
    expect(released.sort()).toEqual(Object.keys(RELEASED_MIGRATIONS).sort());
  });
});

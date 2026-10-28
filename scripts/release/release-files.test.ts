/**
 * Tests of the pure helpers of the release scripts: the version of the four files, the changelog
 * sections and the files a release publishes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildLatestJson,
  buildNotesJson,
  buildReleaseBody,
  checkTagMatchesVersion,
  compareSemVer,
  extractChangelogSection,
  isSemVer,
  readAppVersions,
  setCargoLockVersion,
  setCargoTomlVersion,
  setPackageJsonVersion,
  setTauriConfVersion,
} from './release-files.ts';

const PACKAGE_JSON = `{
  "name": "the-library",
  "version": "0.1.0",
  "dependencies": {
    "zod": "4.6.7"
  },
  "pnpm": { "overrides": { "version": "1.0.0" } }
}
`;

const TAURI_CONF = `{
  "productName": "TheLibrary",
  "version": "0.1.0",
  "plugins": {
    "updater": { "windows": { "version": "ignored" } }
  }
}
`;

const CARGO_TOML = `# Rust manifest. A comment with [brackets] inside.
[package]
name = "the-library"
version = "0.1.0"
edition = "2024"

[dependencies]
tauri = { version = "2.12.0", features = [] }

[dependencies.serde]
version = "1.0.0"
`;

const CARGO_LOCK = `[[package]]
name = "tauri"
version = "2.12.0"

[[package]]
name = "the-library"
version = "0.1.0"
dependencies = [
 "tauri",
]
`;

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something not released yet.

## [0.1.1] - 2026-11-09

### Fixed

- A small fix.

## [0.1.0] - 2026-11-02

### Added

- The first version.
- Updates inside the app.
`;

describe('isSemVer', () => {
  it('accepts plain versions only', () => {
    expect(isSemVer('0.1.0')).toBe(true);
    expect(isSemVer('10.20.30')).toBe(true);
    for (const wrong of ['0.1', 'v0.1.0', '01.0.0', '0.1.0-beta', '0.1.0+build', '', ' 0.1.0']) {
      expect(isSemVer(wrong)).toBe(false);
    }
  });
});

describe('compareSemVer', () => {
  it('compares numerically, part by part', () => {
    expect(compareSemVer('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemVer('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareSemVer('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemVer('0.1.0', '0.1.0')).toBe(0);
  });

  it('refuses a version that is not plain SemVer', () => {
    expect(() => compareSemVer('0.1', '0.1.0')).toThrow(/SemVer/);
  });
});

describe('version setters', () => {
  it('change the top-level version of package.json only', () => {
    const result = setPackageJsonVersion(PACKAGE_JSON, '0.2.0');
    expect(result).toBe(PACKAGE_JSON.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    expect(result).toContain('"overrides": { "version": "1.0.0" }');
  });

  it('change the top-level version of tauri.conf.json only', () => {
    const result = setTauriConfVersion(TAURI_CONF, '0.2.0');
    expect(result).toBe(TAURI_CONF.replace('"version": "0.1.0"', '"version": "0.2.0"'));
  });

  it('change the version of the [package] table of Cargo.toml only', () => {
    const result = setCargoTomlVersion(CARGO_TOML, '0.2.0');
    expect(result).toBe(CARGO_TOML.replace('version = "0.1.0"', 'version = "0.2.0"'));
    expect(result).toContain('[dependencies.serde]\nversion = "1.0.0"');
  });

  it('change the entry of the app in Cargo.lock only', () => {
    const result = setCargoLockVersion(CARGO_LOCK, '0.2.0');
    expect(result).toContain('name = "the-library"\nversion = "0.2.0"');
    expect(result).toContain('name = "tauri"\nversion = "2.12.0"');
  });

  it('keep Windows line endings', () => {
    const crlf = CARGO_LOCK.replaceAll('\n', '\r\n');
    const result = setCargoLockVersion(crlf, '0.2.0');
    expect(result).toBe(crlf.replace('version = "0.1.0"', 'version = "0.2.0"'));
    const crlfToml = CARGO_TOML.replaceAll('\n', '\r\n');
    expect(setCargoTomlVersion(crlfToml, '0.2.0')).toBe(
      crlfToml.replace('version = "0.1.0"', 'version = "0.2.0"'),
    );
    const crlfJson = PACKAGE_JSON.replaceAll('\n', '\r\n');
    expect(setPackageJsonVersion(crlfJson, '0.2.0')).toBe(
      crlfJson.replace('"version": "0.1.0"', '"version": "0.2.0"'),
    );
  });

  it('fail when the field is missing', () => {
    expect(() => setPackageJsonVersion('{\n  "name": "x"\n}\n', '0.2.0')).toThrow(/exactly one/);
    expect(() => setCargoLockVersion('[[package]]\nname = "tauri"\n', '0.2.0')).toThrow(
      /exactly one/,
    );
    expect(() => setCargoTomlVersion('[dependencies]\n', '0.2.0')).toThrow(/\[package\]/);
  });

  it('read back what they write', () => {
    const texts = {
      packageJson: setPackageJsonVersion(PACKAGE_JSON, '0.3.0'),
      tauriConf: setTauriConfVersion(TAURI_CONF, '0.3.0'),
      cargoToml: setCargoTomlVersion(CARGO_TOML, '0.3.0'),
      cargoLock: setCargoLockVersion(CARGO_LOCK, '0.3.0'),
    };
    expect(readAppVersions(texts)).toEqual({
      packageJson: '0.3.0',
      tauriConf: '0.3.0',
      cargoToml: '0.3.0',
      cargoLock: '0.3.0',
    });
  });
});

describe('checkTagMatchesVersion', () => {
  const versions = {
    packageJson: '0.1.0',
    tauriConf: '0.1.0',
    cargoToml: '0.1.0',
    cargoLock: '0.1.0',
  };

  it('accepts a tag naming the version of every file', () => {
    expect(checkTagMatchesVersion('v0.1.0', versions)).toBeNull();
  });

  it('names the files that disagree with the tag', () => {
    const message = checkTagMatchesVersion('v0.1.0', { ...versions, cargoLock: '0.0.9' });
    expect(message).toContain('cargoLock has 0.0.9');
    expect(message).not.toContain('packageJson');
    expect(checkTagMatchesVersion('v0.1.1', versions)).toContain('packageJson has 0.1.0');
  });

  it('refuses a tag that is not vMAJOR.MINOR.PATCH', () => {
    expect(checkTagMatchesVersion('0.1.0', versions)).toContain('not of the form');
    expect(checkTagMatchesVersion('v0.1.0-beta', versions)).toContain('not of the form');
  });
});

describe('extractChangelogSection', () => {
  it('returns the body of the section, up to the next one', () => {
    expect(extractChangelogSection(CHANGELOG, '0.1.1')).toBe('### Fixed\n\n- A small fix.');
    expect(extractChangelogSection(CHANGELOG, '0.1.0')).toBe(
      '### Added\n\n- The first version.\n- Updates inside the app.',
    );
  });

  it('returns null for a missing version or the unreleased section only', () => {
    expect(extractChangelogSection(CHANGELOG, '0.2.0')).toBeNull();
    expect(extractChangelogSection('# Changelog\n\n## [Unreleased]\n\n- x\n', '0.1.0')).toBeNull();
  });

  it('does not take 0.1.1 for 0.1.10, and reads Windows line endings', () => {
    const changelog = '## [0.1.10] - 2027-01-01\n\n- ten\n\n## [0.1.1] - 2026-11-09\n\n- one\n';
    expect(extractChangelogSection(changelog, '0.1.1')).toBe('- one');
    expect(extractChangelogSection(changelog.replaceAll('\n', '\r\n'), '0.1.10')).toBe('- ten');
  });

  it('returns null for an empty section', () => {
    expect(extractChangelogSection('## [0.1.0] - 2026-11-02\n\n## [0.0.9]\n', '0.1.0')).toBeNull();
  });
});

describe('release files', () => {
  it('builds notes with both languages, or English only', () => {
    expect(JSON.parse(buildNotesJson('Added x', 'Ajout x'))).toEqual({
      en: 'Added x',
      fr: 'Ajout x',
    });
    expect(JSON.parse(buildNotesJson('Added x', null))).toEqual({ en: 'Added x' });
  });

  it('builds latest.json in the format of the Tauri updater', () => {
    const json = buildLatestJson({
      version: '0.1.0',
      notes: '{"en":"x"}',
      pubDate: '2026-11-02T10:00:00.000Z',
      signature: 'SIG',
      url: 'https://example.test/TheLibrary_0.1.0_x64-setup.exe',
    });
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual({
      version: '0.1.0',
      notes: '{"en":"x"}',
      pub_date: '2026-11-02T10:00:00.000Z',
      platforms: {
        'windows-x86_64': {
          signature: 'SIG',
          url: 'https://example.test/TheLibrary_0.1.0_x64-setup.exe',
        },
      },
    });
  });

  it('builds the release description, French under English', () => {
    expect(buildReleaseBody('EN', null)).toBe('EN\n');
    expect(buildReleaseBody('EN', 'FR')).toBe('EN\n\n---\n\n## Français\n\nFR\n');
  });
});

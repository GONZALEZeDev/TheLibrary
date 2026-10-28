/**
 * Prepares a release on the owner's machine: `pnpm release:prepare <X.Y.Z>`.
 *
 * 1. Checks the version (plain SemVer, newer than the current one, or the current one when it was
 *    never tagged: the first release keeps the version the repository already has).
 * 2. Refuses to run over uncommitted changes, except in the changelogs (written just before) and
 *    the third-party notices (rewritten here), so that the release commit holds nothing else.
 * 3. Checks the changelogs: the English section of the version is required, the French one is
 *    recommended (the app then shows the English summary to French players).
 * 4. Writes the version into the four files that hold it (see `release-files.ts`).
 * 5. Regenerates `THIRD_PARTY_NOTICES.md`.
 * 6. Prints the commands that commit, tag and push the release. It never runs them: the owner
 *    reviews the changes and publishes them.
 *
 * The release workflow (`.github/workflows/release.yml`) then builds the tag into a draft release.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import {
  compareSemVer,
  extractChangelogSection,
  isSemVer,
  readAppVersions,
  setCargoLockVersion,
  setCargoTomlVersion,
  setPackageJsonVersion,
  setTauriConfVersion,
  type AppVersions,
} from './release-files.ts';

/** The four files that hold the version, relative to the repository root. */
const VERSION_FILES: Record<keyof AppVersions, string> = {
  packageJson: 'package.json',
  tauriConf: 'src-tauri/tauri.conf.json',
  cargoToml: 'src-tauri/Cargo.toml',
  cargoLock: 'src-tauri/Cargo.lock',
};

/** The setter of each file's version. */
const SETTERS: Record<keyof AppVersions, (text: string, version: string) => string> = {
  packageJson: setPackageJsonVersion,
  tauriConf: setTauriConfVersion,
  cargoToml: setCargoTomlVersion,
  cargoLock: setCargoLockVersion,
};

/** Files that may hold uncommitted changes when a release is prepared. */
const FILES_ALLOWED_DIRTY = new Set(['CHANGELOG.md', 'CHANGELOG.fr.md', 'THIRD_PARTY_NOTICES.md']);

/**
 * Stop the script with an error message.
 *
 * @param message - What went wrong and what to do.
 */
function fail(message: string): never {
  console.error(`release:prepare: ${message}`);
  process.exit(1);
}

/**
 * Run git and return its output.
 *
 * @param args - Arguments of git.
 * @returns Standard output.
 */
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const version = process.argv[2] ?? '';
if (!isSemVer(version)) {
  fail(`give the version to release, e.g. \`pnpm release:prepare 0.2.0\` (got "${version}")`);
}

// `git status --porcelain` lines are "XY path"; a renamed file is "XY old -> new".
const dirty = git('status', '--porcelain')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => line.slice(3).split(' -> ').pop() ?? '')
  .filter((file) => !FILES_ALLOWED_DIRTY.has(file));
if (dirty.length > 0) {
  fail(`commit or stash these changes first: ${dirty.join(', ')}`);
}

const texts = Object.fromEntries(
  await Promise.all(
    Object.entries(VERSION_FILES).map(async ([key, file]) => [key, await readFile(file, 'utf8')]),
  ),
) as Record<keyof AppVersions, string>;
const current = readAppVersions(texts);
const disagreeing = Object.entries(current).filter(([, value]) => value !== current.packageJson);
if (disagreeing.length > 0) {
  fail(`the files disagree on the current version: ${JSON.stringify(current)}`);
}

// A released version is never released again. The current version itself is accepted while it
// has no tag: that is the first release, made with the version the repository already holds.
if (git('tag', '--list', `v${version}`).trim() !== '') {
  fail(`the tag v${version} already exists: choose a newer version`);
}
const comparison = compareSemVer(version, current.packageJson);
if (comparison < 0) {
  fail(`${version} is older than the current version ${current.packageJson}`);
}

// The changelogs are checked before any file is written: a missing summary must not leave the
// version files changed, which the dirty-tree check above would then refuse at the next run.
const english = extractChangelogSection(await readFile('CHANGELOG.md', 'utf8'), version);
if (english === null) {
  fail(`CHANGELOG.md has no section "## [${version}] - YYYY-MM-DD": write the summary first`);
}
const french = extractChangelogSection(await readFile('CHANGELOG.fr.md', 'utf8'), version);
if (french === null) {
  console.warn(
    `Warning: CHANGELOG.fr.md has no section for ${version}; French players will see the English summary.`,
  );
}

if (comparison > 0) {
  for (const key of Object.keys(VERSION_FILES) as (keyof AppVersions)[]) {
    await writeFile(VERSION_FILES[key], SETTERS[key](texts[key], version));
  }
  console.log(
    `Version ${current.packageJson} -> ${version} in ${Object.values(VERSION_FILES).join(', ')}.`,
  );
} else {
  console.log(`Version ${version} kept: it was never released (no tag v${version}).`);
}

execFileSync('node', ['scripts/release/third-party-notices.ts'], { stdio: 'inherit' });

console.log(`
Ready. Review the changes, then publish them:

  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md CHANGELOG.fr.md THIRD_PARTY_NOTICES.md
  git commit -m "Release ${version}"
  git tag v${version}
  git push origin main
  git push origin v${version}

The release workflow then builds a draft release on GitHub. Try its installer, then publish it
(never as a pre-release: the installed apps only see the latest full release).`);

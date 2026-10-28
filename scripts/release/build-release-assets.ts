/**
 * Builds the files of a GitHub release from a finished Tauri build. Run by the release workflow:
 *
 *   node scripts/release/build-release-assets.ts --tag v0.2.0 \
 *     --bundle src-tauri/target/release/bundle/nsis --out release-assets
 *
 * 1. Checks that the tag names the version of the four version files (a mismatch fails the run
 *    before anything is published).
 * 2. Finds the installer (`*_x64-setup.exe`) and its signature (`.sig`, written by the Tauri build
 *    when the signing key is in the environment) in the bundle folder.
 * 3. Reads the summaries of the version in `CHANGELOG.md` (required) and `CHANGELOG.fr.md`
 *    (a GitHub warning when missing).
 * 4. Writes `<out>/latest.json` (what the installed apps download at startup) and
 *    `<out>/release-body.md` (the description of the GitHub release).
 *
 * Two options exist only for the local rehearsal of an update, never used by the workflow:
 * `--skip-tag-check` and `--download-base <url>` (the folder the installer is served from,
 * instead of the GitHub release of the tag).
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildLatestJson,
  buildNotesJson,
  buildReleaseBody,
  checkTagMatchesVersion,
  extractChangelogSection,
  readAppVersions,
} from './release-files.ts';

/** Where GitHub serves the files of a release: `<base>/<tag>/<file>`. */
const GITHUB_DOWNLOAD_BASE = 'https://github.com/GONZALEZeDev/TheLibrary/releases/download';

/**
 * Stop the script with an error message, as a GitHub error annotation.
 *
 * @param message - What went wrong.
 */
function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    bundle: { type: 'string' },
    out: { type: 'string' },
    'skip-tag-check': { type: 'boolean', default: false },
    'download-base': { type: 'string' },
  },
});
const { tag, bundle, out } = values;
if (tag === undefined || bundle === undefined || out === undefined) {
  fail('usage: build-release-assets.ts --tag vX.Y.Z --bundle <nsis folder> --out <folder>');
}
const version = tag.replace(/^v/, '');

const versions = readAppVersions({
  packageJson: await readFile('package.json', 'utf8'),
  tauriConf: await readFile('src-tauri/tauri.conf.json', 'utf8'),
  cargoToml: await readFile('src-tauri/Cargo.toml', 'utf8'),
  cargoLock: await readFile('src-tauri/Cargo.lock', 'utf8'),
});
if (!values['skip-tag-check']) {
  const mismatch = checkTagMatchesVersion(tag, versions);
  if (mismatch !== null) fail(mismatch);
}

// Exactly one installer: a leftover of another version in the folder must not be published.
const installers = (await readdir(bundle)).filter((file) => file.endsWith('_x64-setup.exe'));
const [installer] = installers;
if (installers.length !== 1 || installer === undefined) {
  fail(`expected one *_x64-setup.exe in ${bundle}, found ${String(installers.length)}`);
}
if (!installer.includes(`_${version}_`)) {
  fail(`the installer ${installer} is not version ${version}`);
}
const signature = await readFile(join(bundle, `${installer}.sig`), 'utf8').catch(() =>
  fail(`no signature ${installer}.sig: was TAURI_SIGNING_PRIVATE_KEY set for the build?`),
);

const english = extractChangelogSection(await readFile('CHANGELOG.md', 'utf8'), version);
if (english === null) {
  fail(`CHANGELOG.md has no section for ${version}`);
}
const french = extractChangelogSection(await readFile('CHANGELOG.fr.md', 'utf8'), version);
if (french === null) {
  console.log(`::warning::CHANGELOG.fr.md has no section for ${version}: the app shows English`);
}

const base = values['download-base'] ?? `${GITHUB_DOWNLOAD_BASE}/${tag}`;
await mkdir(out, { recursive: true });
await writeFile(
  join(out, 'latest.json'),
  buildLatestJson({
    version,
    notes: buildNotesJson(english, french),
    pubDate: new Date().toISOString(),
    signature: signature.trim(),
    url: `${base}/${encodeURIComponent(installer)}`,
  }),
);
await writeFile(join(out, 'release-body.md'), buildReleaseBody(english, french));
console.log(`Wrote latest.json and release-body.md for ${installer} into ${out}.`);

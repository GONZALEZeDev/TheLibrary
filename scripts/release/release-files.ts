/**
 * Pure helpers of the release scripts: they read and rewrite the texts of the files a release
 * touches, and build the files a release publishes. No helper reads the disk or runs a command, so
 * that every rule of a release is unit-tested (`release-files.test.ts`).
 *
 * - The version of the app lives in four files that must always agree: `package.json` (read by
 *   Vite into the frontend), `src-tauri/tauri.conf.json` (read by the updater to compare versions),
 *   `src-tauri/Cargo.toml` and the `the-library` entry of `src-tauri/Cargo.lock`.
 * - Each release has a section in `CHANGELOG.md` (English) and `CHANGELOG.fr.md` (French), in the
 *   "Keep a Changelog" layout: `## [X.Y.Z] - YYYY-MM-DD`, then `### Added` and the other headings.
 * - The installed app learns about a release from `latest.json`, the file format of the Tauri
 *   updater. Its `notes` field carries both summaries as a JSON object, so the app can show the one
 *   of its language.
 *
 * Used by `prepare-release.ts` (on the owner's machine) and `build-release-assets.ts` (in the
 * release workflow).
 */

/** Version of each of the four files that hold the version of the app. */
export interface AppVersions {
  readonly packageJson: string;
  readonly tauriConf: string;
  readonly cargoToml: string;
  readonly cargoLock: string;
}

/** What `latest.json` says about one release (see {@link buildLatestJson}). */
export interface LatestJsonInput {
  /** Version of the release, without the `v` of its tag. */
  readonly version: string;
  /** The `notes` field: the output of {@link buildNotesJson}. */
  readonly notes: string;
  /** Publication date, RFC 3339 (e.g. `2026-11-02T10:00:00.000Z`). */
  readonly pubDate: string;
  /** Content of the `.sig` file the Tauri build writes next to the installer. */
  readonly signature: string;
  /** Download URL of the installer. */
  readonly url: string;
}

/** `MAJOR.MINOR.PATCH`, digits only, no leading zero, no pre-release or build suffix. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Tell whether a text is a plain SemVer version (`1.2.3`). Pre-release suffixes (`1.2.3-beta`) are
 * refused on purpose: the updater endpoint only sees releases GitHub calls "latest", which are
 * never pre-releases, so such a version could never reach the installed apps.
 *
 * @param version - The text to check.
 * @returns `true` for a plain SemVer version.
 */
export function isSemVer(version: string): boolean {
  return SEMVER.test(version);
}

/**
 * Compare two plain SemVer versions.
 *
 * @param a - First version.
 * @param b - Second version.
 * @returns A negative number if `a` is older, 0 if equal, a positive number if `a` is newer.
 * @throws Error if either version is not plain SemVer.
 */
export function compareSemVer(a: string, b: string): number {
  const partsA = semVerParts(a);
  const partsB = semVerParts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Split a version into its three numbers.
 *
 * @param version - A plain SemVer version.
 * @returns Major, minor and patch.
 * @throws Error if the version is not plain SemVer.
 */
function semVerParts(version: string): number[] {
  if (!isSemVer(version)) {
    throw new Error(`Not a plain SemVer version: "${version}"`);
  }
  return version.split('.').map(Number);
}

/**
 * Replace the one match of a pattern, keeping everything else of the text byte for byte (line
 * endings included). The pattern must have two groups: the text before the version and the text
 * after it.
 *
 * @param text - The file content.
 * @param pattern - A global pattern whose groups 1 and 2 surround the version.
 * @param version - The new version.
 * @param what - Name of the field, for the error message.
 * @returns The rewritten text.
 * @throws Error if the pattern matches zero or several times.
 */
function replaceVersionOnce(text: string, pattern: RegExp, version: string, what: string): string {
  const matches = text.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${what}, found ${String(matches.length)}`);
  }
  return text.replace(pattern, (_match, before: string, after: string) => {
    return `${before}${version}${after}`;
  });
}

/**
 * Set the top-level `"version"` of `package.json`. Only the line indented by exactly two spaces is
 * the package's own version; the versions of dependencies are values, not `"version"` keys.
 *
 * @param text - Content of `package.json`.
 * @param version - The new version.
 * @returns The rewritten content.
 */
export function setPackageJsonVersion(text: string, version: string): string {
  return replaceVersionOnce(
    text,
    /^( {2}"version": ")[^"]*(",?\r?$)/gm,
    version,
    'top-level "version" in package.json',
  );
}

/**
 * Set the top-level `"version"` of `tauri.conf.json` (two-space indent, like `package.json`).
 *
 * @param text - Content of `src-tauri/tauri.conf.json`.
 * @param version - The new version.
 * @returns The rewritten content.
 */
export function setTauriConfVersion(text: string, version: string): string {
  return replaceVersionOnce(
    text,
    /^( {2}"version": ")[^"]*(",?\r?$)/gm,
    version,
    'top-level "version" in tauri.conf.json',
  );
}

/**
 * Set the `version` of the `[package]` table of `Cargo.toml`. A `version = "…"` of any other table
 * (a dependency written as a table) is left alone: only the first table of the file is searched,
 * from `[package]` to the next `[` header.
 *
 * @param text - Content of `src-tauri/Cargo.toml`.
 * @param version - The new version.
 * @returns The rewritten content.
 * @throws Error if the file has no `[package]` table or the table no single `version`.
 */
export function setCargoTomlVersion(text: string, version: string): string {
  const table = /^\[package\]\r?\n(?:(?!\[)[^\n]*\n)*/m.exec(text);
  if (table === null) {
    throw new Error('Expected a [package] table in Cargo.toml');
  }
  const rewritten = replaceVersionOnce(
    table[0],
    /^(version = ")[^"]*("\r?)$/gm,
    version,
    'version in the [package] table of Cargo.toml',
  );
  return text.slice(0, table.index) + rewritten + text.slice(table.index + table[0].length);
}

/**
 * Set the version of the app's own entry (`name = "the-library"`) of `Cargo.lock`, which cargo
 * would otherwise rewrite at the next build (and `--locked` would then fail).
 *
 * @param text - Content of `src-tauri/Cargo.lock`.
 * @param version - The new version.
 * @returns The rewritten content.
 */
export function setCargoLockVersion(text: string, version: string): string {
  return replaceVersionOnce(
    text,
    /^(name = "the-library"\r?\nversion = ")[^"]*("\r?)$/gm,
    version,
    'entry "the-library" in Cargo.lock',
  );
}

/**
 * Read the version a file holds, with the same patterns as the setters.
 *
 * @param texts - Contents of the four files.
 * @returns The version of each file.
 * @throws Error if a file does not hold exactly one version.
 */
export function readAppVersions(texts: AppVersions): AppVersions {
  return {
    packageJson: readOnce(texts.packageJson, /^ {2}"version": "([^"]*)"/gm, 'package.json'),
    tauriConf: readOnce(texts.tauriConf, /^ {2}"version": "([^"]*)"/gm, 'tauri.conf.json'),
    cargoToml: readOnce(
      /^\[package\]\r?\n(?:(?!\[)[^\n]*\n)*/m.exec(texts.cargoToml)?.[0] ?? '',
      /^version = "([^"]*)"/gm,
      'Cargo.toml',
    ),
    cargoLock: readOnce(
      texts.cargoLock,
      /^name = "the-library"\r?\nversion = "([^"]*)"/gm,
      'Cargo.lock',
    ),
  };
}

/**
 * Read the one capture of a global pattern.
 *
 * @param text - The text to search.
 * @param pattern - A global pattern with one group.
 * @param file - Name of the file, for the error message.
 * @returns The captured text.
 * @throws Error if the pattern matches zero or several times.
 */
function readOnce(text: string, pattern: RegExp, file: string): string {
  const matches = [...text.matchAll(pattern)];
  const [match] = matches;
  if (matches.length !== 1 || match?.[1] === undefined) {
    throw new Error(`Expected exactly one version in ${file}, found ${String(matches.length)}`);
  }
  return match[1];
}

/**
 * Check that a release tag names the version all four files hold.
 *
 * @param tag - The tag, e.g. `v0.1.0`.
 * @param versions - The versions read from the four files.
 * @returns `null` when everything agrees, otherwise the error to show.
 */
export function checkTagMatchesVersion(tag: string, versions: AppVersions): string | null {
  const expected = tag.startsWith('v') ? tag.slice(1) : null;
  if (expected === null || !isSemVer(expected)) {
    return `The tag "${tag}" is not of the form vMAJOR.MINOR.PATCH`;
  }
  const wrong = Object.entries(versions as unknown as Record<string, string>).filter(
    ([, version]) => version !== expected,
  );
  if (wrong.length === 0) return null;
  const list = wrong.map(([file, version]) => `${file} has ${version}`).join(', ');
  return `The tag ${tag} does not match the version of the files: ${list}`;
}

/**
 * Extract the body of one version's section from a changelog: the lines after
 * `## [X.Y.Z]` (whatever follows on that line, usually ` - YYYY-MM-DD`) up to the next `## [`
 * heading, trimmed.
 *
 * @param changelog - Content of `CHANGELOG.md` or `CHANGELOG.fr.md`.
 * @param version - The version, without `v`.
 * @returns The body, or `null` when the section is missing or empty.
 */
export function extractChangelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.trim().startsWith(heading));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith('## ['));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

/**
 * Build the `notes` field of `latest.json`: the summaries of one release as a JSON object keyed
 * by language, which the app reads to show the summary of its own language.
 *
 * @param en - English summary (required: a release always has one).
 * @param fr - French summary, or `null` when the French changelog has no section for the release.
 * @returns The JSON text.
 */
export function buildNotesJson(en: string, fr: string | null): string {
  return JSON.stringify(fr === null ? { en } : { en, fr });
}

/**
 * Build `latest.json`, the file the installed apps download at startup to learn about the latest
 * release (format of the Tauri updater's static JSON endpoint).
 *
 * @param input - See {@link LatestJsonInput}.
 * @returns The JSON text, two-space indented, ending with a newline.
 */
export function buildLatestJson(input: LatestJsonInput): string {
  const latest = {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate,
    platforms: {
      'windows-x86_64': { signature: input.signature, url: input.url },
    },
  };
  return `${JSON.stringify(latest, null, 2)}\n`;
}

/**
 * Links at the end of every release description. The code signing policy must be linked from every
 * release page (a condition of SignPath Foundation's free code signing), and the privacy page tells
 * what the installed app contacts.
 */
const RELEASE_BODY_FOOTER = [
  '[Installation](https://github.com/GONZALEZeDev/TheLibrary#installation)',
  '[Code signing policy](https://github.com/GONZALEZeDev/TheLibrary/blob/main/CODE_SIGNING_POLICY.md)',
  '[Privacy](https://github.com/GONZALEZeDev/TheLibrary/blob/main/PRIVACY.md)',
].join(' · ');

/**
 * Build the description of the GitHub release: the English summary, then the French one under its
 * own heading when there is one, then the links to the installation, the code signing policy and
 * the privacy page.
 *
 * @param en - English summary.
 * @param fr - French summary, or `null`.
 * @returns The Markdown text, ending with a newline.
 */
export function buildReleaseBody(en: string, fr: string | null): string {
  const french = fr === null ? '' : `\n\n---\n\n## Français\n\n${fr}`;
  return `${en}${french}\n\n---\n\n${RELEASE_BODY_FOOTER}\n`;
}

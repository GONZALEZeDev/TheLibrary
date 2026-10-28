/**
 * Generates `THIRD_PARTY_NOTICES.md`: every JavaScript package and Rust crate shipped inside
 * TheLibrary, with its licence and the licence and notice texts the package ships. Most of these
 * licences (MIT, BSD, Apache-2.0) ask that their text travel with the software; the file is
 * attached to every release and kept in the repository.
 *
 * Run by `pnpm notices` and by `pnpm release:prepare`. It needs no tool beyond the ones the
 * project already uses:
 * - JavaScript: `pnpm licenses list --prod --json` lists the production dependencies (the code
 *   bundled into the app; development tools are not shipped).
 * - Rust: `cargo metadata` gives the dependency graph of the shell for the Windows target; only the
 *   normal dependencies are followed (build scripts and test helpers are not shipped).
 * - The texts are the `LICENSE*`, `LICENCE*`, `COPYING*` and `NOTICE*` files of each package, read
 *   from `node_modules` and from cargo's registry folder.
 *
 * The same text is printed once and referenced by every package that ships it (the Apache-2.0
 * text alone would otherwise appear dozens of times).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One shipped package: its identity, its licence, and the texts it ships. */
export interface NoticeEntry {
  readonly name: string;
  readonly version: string;
  /** SPDX expression declared by the package (e.g. `MIT OR Apache-2.0`). */
  readonly license: string;
  readonly texts: readonly string[];
}

/** The part of `cargo metadata --format-version 1` this script reads. */
export interface CargoMetadata {
  readonly packages: readonly {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly license: string | null;
    readonly manifest_path: string;
  }[];
  readonly resolve: {
    readonly root: string | null;
    readonly nodes: readonly {
      readonly id: string;
      readonly deps: readonly {
        readonly pkg: string;
        readonly dep_kinds: readonly { readonly kind: string | null }[];
      }[];
    }[];
  };
}

/** Files that hold a licence or a notice. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

/** Output file, at the repository root. */
const OUTPUT = 'THIRD_PARTY_NOTICES.md';

/**
 * The Zstandard library, compiled into the WebAssembly module of `@hpcc-js/wasm-zstd`. That package
 * ships its own Apache-2.0 licence only, so the BSD licence of zstd (which asks for its text in the
 * documentation of a binary redistribution) is kept next to this script, as published with zstd
 * 1.5.7 (https://github.com/facebook/zstd/blob/v1.5.7/LICENSE).
 */
const ZSTD_LICENSE_FILE = join('scripts', 'release', 'zstd-LICENSE.txt');

/** The full Apache License 2.0, recognised whatever its line wrapping or appendix. */
const APACHE_2_TEXT =
  /Apache License\s+Version 2\.0,? January 2004[\s\S]*END OF TERMS AND CONDITIONS/;

/**
 * List the packages the app's binary is built from: the crates reached from the root crate through
 * normal dependencies only (`kind: null`), the root itself left out.
 *
 * @param metadata - Output of `cargo metadata`.
 * @returns The package ids.
 */
export function normalRustDependencies(metadata: CargoMetadata): Set<string> {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.resolve.root;
  const reached = new Set<string>();
  const queue = root === null ? [] : [root];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const dep of nodes.get(id)?.deps ?? []) {
      const isNormal = dep.dep_kinds.some((kind) => kind.kind === null);
      if (isNormal && !reached.has(dep.pkg)) {
        reached.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  return reached;
}

/**
 * Write the Markdown of the notices: one list per ecosystem, then each distinct text once.
 *
 * @param npm - The JavaScript packages.
 * @param rust - The Rust crates.
 * @returns The content of `THIRD_PARTY_NOTICES.md`.
 */
export function renderNotices(npm: readonly NoticeEntry[], rust: readonly NoticeEntry[]): string {
  // Each distinct text gets a number, in the order it is first met, so the output is stable.
  const textIds = new Map<string, number>();
  // The Apache License 2.0 is printed once: the copies of the crates differ only in wrapping and in
  // the filled-in appendix, and the licence asks for a copy of itself, not of each copy. Any other
  // text is kept as written (an MIT text carries the copyright line of its authors).
  const printed = new Map<number, string>();
  const textOf = (text: string): number => {
    const normalised = text.replaceAll('\r\n', '\n').trim();
    // Copies that differ only in spacing (one licence file shared by several crates) are one text.
    const key =
      APACHE_2_TEXT.test(normalised) && normalised.length < 16_000
        ? 'Apache-2.0'
        : normalised.replace(/\s+/g, ' ');
    const known = textIds.get(key);
    if (known !== undefined) return known;
    const id = textIds.size + 1;
    textIds.set(key, id);
    printed.set(id, normalised);
    return id;
  };
  const byName = (a: NoticeEntry, b: NoticeEntry) =>
    a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en');
  const list = (entries: readonly NoticeEntry[]): string =>
    [...entries]
      .sort(byName)
      .map((entry) => {
        const refs =
          entry.texts.length === 0
            ? 'licence text not shipped by the package'
            : entry.texts
                .map((text) => `[text ${String(textOf(text))}](#text-${String(textOf(text))})`)
                .join(', ');
        return `- ${entry.name} ${entry.version} — ${entry.license} — ${refs}`;
      })
      .join('\n');

  const npmList = list(npm);
  const rustList = list(rust);
  const texts = [...printed.entries()]
    .map(
      ([id, text]) =>
        `### Text ${String(id)}\n\n<a id="text-${String(id)}"></a>\n\n\`\`\`text\n${text.replaceAll('```', '`​``')}\n\`\`\``,
    )
    .join('\n\n');

  return `# Third-party notices

TheLibrary is distributed under the MIT licence (see [LICENSE](LICENSE)). It includes the
third-party software listed below, each under its own licence. This file is generated by
\`pnpm notices\` from the production JavaScript dependencies and the Rust crates compiled into the
app; do not edit it by hand.

## JavaScript packages

${npmList}

## Rust crates

${rustList}

## Licence and notice texts

${texts}
`;
}

/**
 * Read the licence and notice files of a package folder.
 *
 * @param folder - The package folder.
 * @returns Their contents, sorted by file name.
 */
async function readLicenseTexts(folder: string): Promise<string[]> {
  const files = (await readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(files.map((file) => readFile(join(folder, file), 'utf8')));
}

/** One package of `pnpm licenses list --json`. */
interface PnpmLicenseEntry {
  readonly name: string;
  readonly versions: readonly string[];
  readonly paths: readonly string[];
  readonly license: string;
}

/**
 * List the production JavaScript packages with their texts.
 *
 * @returns The entries.
 */
async function npmEntries(): Promise<NoticeEntry[]> {
  // `shell: true` lets Windows find `pnpm.cmd`; the arguments are fixed strings.
  const output = execFileSync('pnpm licenses list --prod --json', {
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicense = JSON.parse(output) as Record<string, PnpmLicenseEntry[]>;
  const entries: NoticeEntry[] = [];
  for (const packages of Object.values(byLicense)) {
    for (const pkg of packages) {
      // One entry per installed version, each with the texts of its own folder.
      for (const [index, version] of pkg.versions.entries()) {
        const folder = pkg.paths[index];
        const texts = folder === undefined ? [] : await readLicenseTexts(folder);
        entries.push({ name: pkg.name, version, license: pkg.license, texts });
      }
    }
  }
  const hpcc = entries.find((entry) => entry.name === '@hpcc-js/wasm-zstd');
  if (hpcc !== undefined) {
    entries.push({
      name: 'zstd (Zstandard, compiled into @hpcc-js/wasm-zstd)',
      version: `in ${hpcc.version}`,
      license: 'BSD-3-Clause',
      texts: [await readFile(ZSTD_LICENSE_FILE, 'utf8')],
    });
  }
  return entries;
}

/**
 * List the Rust crates compiled into the app with their texts.
 *
 * @returns The entries.
 */
async function rustEntries(): Promise<NoticeEntry[]> {
  const output = execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--filter-platform',
      'x86_64-pc-windows-msvc',
      '--manifest-path',
      join('src-tauri', 'Cargo.toml'),
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const metadata = JSON.parse(output) as CargoMetadata;
  const shipped = normalRustDependencies(metadata);
  return Promise.all(
    metadata.packages
      .filter((pkg) => shipped.has(pkg.id))
      .map(async (pkg) => ({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? 'see the licence text',
        texts: await readLicenseTexts(dirname(pkg.manifest_path)),
      })),
  );
}

// Runs only as a script, not when the tests import the pure helpers above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const content = renderNotices(await npmEntries(), await rustEntries());
  await writeFile(OUTPUT, content);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  console.log(`Wrote ${OUTPUT} (${String(Math.round(content.length / 1024))} KB, ${hash}).`);
}

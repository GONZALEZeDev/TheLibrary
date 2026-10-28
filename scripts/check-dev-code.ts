/**
 * Proves that the production build contains no development-only code.
 *
 * Development-only modules (the browser adapters with their synthetic data, the TanStack devtools)
 * contain texts no production module has (see `MARKERS`). This script:
 * 1. scans the production build (`dist/`, made by `pnpm build`): no marker may appear;
 * 2. builds the frontend in development mode into a temporary folder and scans it: every marker
 *    must appear. Without this second step the check could pass forever while proving nothing,
 *    e.g. after a marker was renamed.
 *
 * Usage, after `pnpm build`: `pnpm check:dev-code`. CI runs it on every push to main, pull
 * request and weekly run, and `tauri build` runs it before bundling the app (`beforeBuildCommand`).
 *
 * @packageDocumentation
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'vite';

/**
 * Texts that only development-only code contains. Several, of different origins, so that a
 * development module still gets caught if one of them disappears (a log line rewritten, a library
 * renaming its internals):
 * - the marker the development modules write in their log lines;
 * - the persona name of the synthetic Steam account of the browser dev mode;
 * - the CSS class prefix of the TanStack Query devtools and the name of the TanStack Router
 *   devtools component;
 * - the WebAssembly SQLite of the in-memory database of the browser dev mode (sql.js).
 */
const MARKERS = [
  'thelibrary-dev-only',
  'Fixture Player',
  'tsqd-',
  'TanStackRouterDevtools',
  'sql-wasm',
];

/** Production build, made by `pnpm build`. */
const PRODUCTION_DIR = 'dist';

/** Temporary development build, deleted at the end. */
const DEVELOPMENT_DIR = join('node_modules', '.tmp', 'dev-code-check');

/**
 * List the markers found in the files of a build.
 *
 * @param dir - Folder of the build.
 * @returns The markers found, each with the files containing it.
 */
async function findMarkers(dir: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const file = join(entry.parentPath, entry.name);
    // Every file, read as bytes: a marker cannot hide in a file type nobody thought of.
    const content = await readFile(file);
    for (const marker of MARKERS) {
      if (content.includes(marker)) {
        found.set(marker, [...(found.get(marker) ?? []), file]);
      }
    }
  }
  return found;
}

/**
 * Build the frontend in development mode into a temporary folder and list its markers.
 *
 * @returns The markers found in the development build.
 */
async function scanDevelopmentBuild(): Promise<Map<string, string[]>> {
  // `import.meta.env.DEV` follows NODE_ENV, not the mode: both are set, as `pnpm dev` does.
  process.env.NODE_ENV = 'development';
  try {
    await build({
      mode: 'development',
      logLevel: 'warn',
      // The markers need no env value: no `.env*` file is ever read into this build, so the files
      // of the developer's machine never land in this temporary folder (it stays on disk if the
      // process is killed).
      envDir: false,
      build: { outDir: DEVELOPMENT_DIR, emptyOutDir: true },
    });
    return await findMarkers(DEVELOPMENT_DIR);
  } finally {
    // Removed even when the build fails.
    await rm(DEVELOPMENT_DIR, { recursive: true, force: true });
  }
}

// A missing or empty build would pass the scan below while proving nothing.
const productionFiles = await readdir(PRODUCTION_DIR, { recursive: true }).catch(
  (): string[] => [],
);
if (
  !productionFiles.includes('index.html') ||
  !productionFiles.some((file) => file.endsWith('.js'))
) {
  console.error(`No production build in ${PRODUCTION_DIR}/: run \`pnpm build\` first.`);
  process.exit(1);
}

const leaks = await findMarkers(PRODUCTION_DIR);
if (leaks.size > 0) {
  for (const [marker, files] of leaks) {
    console.error(
      `Development-only code in the production build: "${marker}" in ${files.join(', ')}`,
    );
  }
  process.exit(1);
}

const present = await scanDevelopmentBuild();
const missing = MARKERS.filter((marker) => !present.has(marker));
if (missing.length > 0) {
  console.error(
    `The development build lacks the markers ${missing.join(', ')}: this check would prove nothing. Update MARKERS.`,
  );
  process.exit(1);
}

console.log(
  `No development-only code in ${PRODUCTION_DIR}/ (markers checked: ${MARKERS.join(', ')}).`,
);

/**
 * Proves that the production build contains no development-only code.
 *
 * Development-only modules (the browser adapters with their synthetic data, the development
 * account of the desktop build, the TanStack devtools) each write a marker in a log line. This
 * script:
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

/** Environment variable holding the developer's account id in the desktop development build. */
const DEV_ACCOUNT_VARIABLE = 'VITE_DEV_ACCOUNT_ID';

/**
 * Texts that only development-only code contains: the marker of its log lines, and the name of the
 * variable holding the developer's account id (quoted in the hint shown when it is missing).
 */
const MARKERS = ['thelibrary-dev-only', DEV_ACCOUNT_VARIABLE];

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
      // The markers need no env value, and the developer's account id must never land on disk, even
      // in this temporary folder (it stays there if the process is killed). `envDir: false` stops
      // Vite loading the `.env*` files (`.env.development.local` included), but it still exposes
      // the `VITE_*` variables of `process.env`: the account variable is replaced by `undefined`
      // (also in the whole `import.meta.env` object, should one be built).
      envDir: false,
      define: { [`import.meta.env.${DEV_ACCOUNT_VARIABLE}`]: 'undefined' },
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

/// <reference types="vitest/config" />
/**
 * Vitest configuration of the API canary (`pnpm canary`).
 *
 * The canary calls the real deadlock-api, so it never runs with `pnpm test` nor `pnpm check`: it has
 * its own configuration, its own file pattern (`*.canary.ts`, which the `include` of vite.config.ts
 * does not match) and its own weekly workflow (.github/workflows/api-canary.yml).
 *
 * The configuration is standalone rather than merged with vite.config.ts on purpose. Merging would
 * concatenate the two `include` lists, and would bring in the React and Tailwind plugins and the
 * jsdom setup file, none of which the canary needs. Vite alone resolves the extensionless imports
 * of the project (`../../core/domain/match`), which is all the canary asks of the bundler.
 *
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/** Version of the app, from package.json: sent to deadlock-api in the User-Agent (as vite.config.ts does). */
const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  // Replaced in the code at transform time, like in the app (declared in the canary itself).
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    // The canary talks to the network and to the zstd library: no DOM is needed.
    environment: 'node',
    // Explicit imports (`import { describe } from 'vitest'`) instead of injected globals.
    globals: false,
    include: ['src/test/canary/**/*.canary.ts'],
    // The worst case is 8 requests of 15 s each (REQUEST_TIMEOUT_MS), i.e. 120 s, plus the level 19
    // compression: three minutes let a slow API finish with time left for the compression, while a
    // hung run still ends well before the 10 minutes of the workflow.
    testTimeout: 180_000,
    // The verbose reporter prints the annotations of the canary (its request counts and sizes),
    // which the default reporter hides when a run passes. On GitHub Actions the reporter that
    // Vitest adds by default to the default one (failure annotations on the run) is kept.
    reporters: ['verbose', ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : [])],
  },
});

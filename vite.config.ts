/// <reference types="vitest/config" />
/**
 * Vite (dev server and production build) and Vitest configuration.
 *
 * Tuned for Tauri (https://v2.tauri.app/start/frontend/vite/): fixed port 1420 matching
 * `build.devUrl` in src-tauri/tauri.conf.json, no screen clearing so Rust errors stay visible,
 * and a build target matching WebView2 (evergreen Chromium).
 *
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Version of the app, from package.json: sent to deadlock-api in the User-Agent. */
const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Tauri sets TAURI_ENV_DEBUG to "true" for `tauri dev` and `tauri build --debug`. The value is
// compared rather than tested for truthiness, so a "false" string can never ship a debug build.
const isDebugBuild = process.env.TAURI_ENV_DEBUG === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Replaced in the code at build time (declared in src/main.tsx).
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Keep Rust/Tauri errors visible in the terminal.
  clearScreen: false,
  server: {
    port: 1420,
    // Fail instead of silently switching port: Tauri expects exactly 1420.
    strictPort: true,
    watch: {
      // The Rust side is rebuilt by Tauri itself.
      ignored: ['**/src-tauri/**'],
    },
  },
  // `envPrefix` keeps Vite's default (VITE_*). The only variable read is VITE_DEV_ACCOUNT_ID, by
  // development builds only (src/adapters/dev/dev-environment.ts): Vite reads the
  // `.env.development.*` files in development mode only. (Tauri's guide adds 'TAURI_ENV_*', but
  // Vite matches plain prefixes, so that entry would expose nothing.)
  build: {
    // WebView2 is evergreen Chromium, and Tailwind v4 itself requires Chromium 111 or later.
    target: 'chrome111',
    // Debug builds (`tauri build --debug`) keep readable code and source maps.
    minify: !isDebugBuild,
    sourcemap: isDebugBuild,
    // Vite warns above 500 kB, a limit meant for websites downloading their scripts. The desktop
    // app reads its bundle from the disk: 1 MB still flags an accidental heavy dependency.
    chunkSizeWarningLimit: 1024,
  },
  test: {
    environment: 'jsdom',
    // Explicit imports (`import { describe } from 'vitest'`) instead of injected globals.
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});

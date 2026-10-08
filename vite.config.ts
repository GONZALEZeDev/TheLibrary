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
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri sets TAURI_ENV_DEBUG to "true" for `tauri dev` and `tauri build --debug`. The value is
// compared rather than tested for truthiness, so a "false" string can never ship a debug build.
const isDebugBuild = process.env.TAURI_ENV_DEBUG === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  // `envPrefix` keeps Vite's default (VITE_*): the UI reads no build-time variable. (Tauri's guide
  // adds 'TAURI_ENV_*', but Vite matches plain prefixes, so that entry would expose nothing.)
  build: {
    // WebView2 is evergreen Chromium, and Tailwind v4 itself requires Chromium 111 or later.
    target: 'chrome111',
    // Debug builds (`tauri build --debug`) keep readable code and source maps.
    minify: !isDebugBuild,
    sourcemap: isDebugBuild,
  },
  test: {
    environment: 'jsdom',
    // Explicit imports (`import { describe } from 'vitest'`) instead of injected globals.
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});

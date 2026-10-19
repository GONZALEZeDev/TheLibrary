/**
 * Entry point of the development-only code: the adapters of the browser dev mode.
 *
 * `src/main.tsx` reaches this module only through a dynamic `import()` guarded by
 * `import.meta.env.DEV`, which Vite replaces with `false` in production builds: the module, the
 * synthetic fixtures and sql.js are then left out of the bundle. `scripts/check-dev-code.ts`
 * proves it in CI by looking for {@link DEV_ONLY_MARKER} in the production build.
 *
 * @packageDocumentation
 */
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { ArchiveStore } from '../../ports/archive-store.port';
import type { Database } from '../../ports/database.port';
import type { HttpClient } from '../../ports/http-client.port';
import type { Logger } from '../../ports/logger.port';
import type { SettingsStore } from '../../ports/settings-store.port';
import type { SignInGateway } from '../../ports/sign-in-gateway.port';
import { createFixtureApi, FixtureHttpClient } from './fixture-http-client.adapter';
import { FixtureSignInGateway } from './fixture-sign-in-gateway.adapter';
import { LocalStorageSettingsStore } from './local-storage-settings-store.adapter';
import { MemoryArchiveStore } from './memory-archive-store.adapter';
import { MemoryLogger } from './memory-logger.adapter';
import { SqlJsDatabase } from './sql-js-database.adapter';

/**
 * Text present in every development-only bundle: the CI check fails if a production build
 * contains it. It is written in a log line, so the minifier cannot drop it.
 */
export const DEV_ONLY_MARKER = 'thelibrary-dev-only';

/**
 * The adapters of the browser dev mode, one per port except the compressor: the zstd Web Worker
 * runs in the browser as well as in the desktop app, so `src/main.tsx` creates it once for both.
 */
export interface BrowserDevAdapters {
  readonly logger: Logger;
  readonly settingsStore: SettingsStore;
  readonly http: HttpClient;
  readonly database: Database;
  /**
   * Plays Steam's part: once the login page is opened, it answers after a delay, as Steam would,
   * with the callback of the fixture account. It links nothing itself: the sign-in flow checks that
   * answer and makes the link.
   */
  readonly signInGateway: SignInGateway;
  readonly archiveStore: ArchiveStore;
}

/**
 * The adapters of the browser dev mode (`pnpm dev`): no network, no Tauri. deadlock-api is
 * imitated with the synthetic fixtures (answers are delayed so loading states show), the database
 * is sql.js in memory, the archive of the match details is kept in memory too, the settings live in
 * `localStorage` and the logs go to the console. No account is linked at the start. The Steam
 * sign-in is imitated too: the gateway answers as Steam would, 800 ms after the browser is opened,
 * so the "waiting for Steam" state shows. It links nothing by itself: the sign-in flow does, once it
 * accepts the answer.
 *
 * @returns The adapters.
 */
export function createBrowserDevAdapters(): BrowserDevAdapters {
  const logger = new MemoryLogger({ mirrorToConsole: true });
  logger.log('info', 'dev', `${DEV_ONLY_MARKER}: browser adapters loaded (synthetic data)`);
  return {
    logger,
    settingsStore: new LocalStorageSettingsStore(window.localStorage),
    http: new FixtureHttpClient(createFixtureApi({ now: Date.now() }), { delayMs: 400 }),
    // In the browser, sql.js fetches its WebAssembly file from the URL Vite serves it at.
    database: new SqlJsDatabase(() => initSqlJs({ locateFile: () => sqlWasmUrl })),
    signInGateway: new FixtureSignInGateway({ delayMs: 800 }),
    // Like the database, it is empty at every reload of the page.
    archiveStore: new MemoryArchiveStore(),
  };
}

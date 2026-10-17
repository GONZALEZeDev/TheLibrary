/**
 * Entry point of the development-only code: the adapters of the browser dev mode, and the account
 * of the desktop development build.
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
import { parseAccountId } from '../../core/domain/account';
import type { AccountSource } from '../../ports/account-source.port';
import type { ArchiveStore } from '../../ports/archive-store.port';
import type { Database } from '../../ports/database.port';
import type { HttpClient } from '../../ports/http-client.port';
import type { Logger } from '../../ports/logger.port';
import type { SettingsStore } from '../../ports/settings-store.port';
import { createFixtureApi, FixtureHttpClient } from './fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from './fixtures/match-history.fixture';
import { LocalStorageSettingsStore } from './local-storage-settings-store.adapter';
import { MemoryArchiveStore } from './memory-archive-store.adapter';
import { MemoryLogger } from './memory-logger.adapter';
import { SqlJsDatabase } from './sql-js-database.adapter';
import { StaticAccountSource } from './static-account-source.adapter';

/**
 * Text present in every development-only bundle: the CI check fails if a production build
 * contains it. It is written in a log line, so the minifier cannot drop it.
 */
export const DEV_ONLY_MARKER = 'thelibrary-dev-only';

/** How a developer provides their account to the desktop development build. */
const MISSING_ACCOUNT_HINT =
  'Development build: put VITE_DEV_ACCOUNT_ID=<your Steam account id: the N of your SteamID3 [U:1:N], not the 17-digit SteamID64> in .env.development.local at the root of the repository, then restart (see CONTRIBUTING.md).';

/**
 * The adapters of the browser dev mode, one per port except the compressor: the zstd Web Worker
 * runs in the browser as well as in the desktop app, so `src/main.tsx` creates it once for both.
 */
export interface BrowserDevAdapters {
  readonly logger: Logger;
  readonly settingsStore: SettingsStore;
  readonly http: HttpClient;
  readonly database: Database;
  readonly accountSource: AccountSource;
  readonly archiveStore: ArchiveStore;
}

/**
 * The adapters of the browser dev mode (`pnpm dev`): no network, no Tauri. deadlock-api is
 * imitated with the synthetic fixtures (answers are delayed so loading states show), the database
 * is sql.js in memory, the archive of the match details is kept in memory too, the settings live in
 * `localStorage` and the logs go to the console.
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
    accountSource: new StaticAccountSource(FIXTURE_ACCOUNT_ID),
    // Like the database, it is empty at every reload of the page.
    archiveStore: new MemoryArchiveStore(),
  };
}

/**
 * The account of the desktop development build (`pnpm dev:desktop`), read from the
 * `VITE_DEV_ACCOUNT_ID` variable of the git-ignored `.env.development.local` file. Vite only reads
 * that file in development mode: a production build never sees it.
 *
 * The account id itself is never logged.
 *
 * @param logger - Where to report that the development account source is used.
 * @returns The account source: the configured account, or none with a hint for the developer.
 */
export function createDesktopDevAccountSource(logger: Logger): AccountSource {
  const value: unknown = import.meta.env.VITE_DEV_ACCOUNT_ID;
  if (value === undefined || value === '') {
    logger.log('info', 'dev', `${DEV_ONLY_MARKER}: no development account configured`);
    return new StaticAccountSource(null, MISSING_ACCOUNT_HINT);
  }
  const accountId = parseAccountId(value);
  if (accountId === null) {
    logger.log('warn', 'dev', `${DEV_ONLY_MARKER}: VITE_DEV_ACCOUNT_ID is not a valid account id`);
    return new StaticAccountSource(
      null,
      `VITE_DEV_ACCOUNT_ID is not a valid account id. ${MISSING_ACCOUNT_HINT}`,
    );
  }
  logger.log('info', 'dev', `${DEV_ONLY_MARKER}: using the development account`);
  return new StaticAccountSource(accountId);
}

/**
 * Composition root: the only production module that knows every layer.
 *
 * It picks the adapters for the current environment — Tauri plugins in the desktop app, memory and
 * Web Storage in the browser dev mode (`pnpm dev`) — builds the services, initialises i18n with the
 * saved (or system) language, then renders the application.
 *
 * @packageDocumentation
 */
import { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { isTauri } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalStorageSettingsStore } from './adapters/dev/local-storage-settings-store.adapter';
import { MemoryLogger } from './adapters/dev/memory-logger.adapter';
import { TauriLogger } from './adapters/tauri/tauri-logger.adapter';
import { TauriSettingsStore } from './adapters/tauri/tauri-settings-store.adapter';
import { toAppError, type AppErrorKind } from './core/errors/app-error';
import { resolveInitialLanguage, type Language } from './core/settings/language';
import type { AppServices } from './services/app-services';
import { SettingsService } from './services/settings.service';
import { AppProviders } from './ui/app/AppProviders';
import { createAppRouter } from './ui/app/router';
import { createI18n, RESOURCES } from './ui/i18n/i18n';
import './ui/theme/theme.css';

/** Error kinds worth retrying: a new attempt may succeed. */
const TRANSIENT_KINDS = new Set<AppErrorKind>(['network', 'timeout', 'rate_limited']);

/**
 * Build the services with the adapters of the current environment.
 *
 * @param desktop - `true` inside the Tauri desktop app, `false` in the browser dev mode.
 * @returns The application services.
 */
function createServices(desktop: boolean): AppServices {
  const logger = desktop ? new TauriLogger() : new MemoryLogger({ mirrorToConsole: true });
  const settingsStore = desktop
    ? new TauriSettingsStore()
    : new LocalStorageSettingsStore(window.localStorage);
  return { logger, settings: new SettingsService(settingsStore, logger) };
}

/**
 * Create the TanStack Query client of the application.
 *
 * Milestone M1 only reads and writes local data (the settings): it is available offline and only
 * changes through the app. So queries and mutations run whatever the network state, are not
 * refetched when the window regains focus, and are retried only when a new attempt may succeed.
 * Remote queries (M2) opt back into `networkMode: 'online'` where they are declared.
 *
 * @returns A new query client.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'always',
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          failureCount < 2 && TRANSIENT_KINDS.has(toAppError(error).kind),
      },
      mutations: { networkMode: 'always' },
    },
  });
}

/**
 * Read the language saved by the user. A storage failure must not prevent the app from starting:
 * it is logged and the system language is used instead.
 *
 * @param services - The application services.
 * @returns The saved language, or `null` when none is saved or the settings cannot be read.
 */
async function loadSavedLanguage(services: AppServices): Promise<Language | null> {
  try {
    return (await services.settings.get()).language;
  } catch (error) {
    const appError = toAppError(error);
    services.logger.log('error', 'app', 'Could not read the settings, using the defaults', {
      kind: appError.kind,
    });
    return null;
  }
}

/**
 * Replace the page with a static message when the application cannot start. Neither React nor
 * i18next is used, since either may be what failed; the text still comes from the catalogues.
 *
 * @param rootElement - The element the application renders into.
 */
function showStartupFailure(rootElement: HTMLElement): void {
  const { errors } = RESOURCES[resolveInitialLanguage(null, navigator.languages)].common;
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.className = 'p-8 text-fg';
  message.textContent = `${errors.title}. ${errors.kind.unexpected}`;
  rootElement.replaceChildren(message);
}

/**
 * Start the application.
 *
 * @param rootElement - The element the application renders into.
 * @param services - The application services.
 * @param desktop - `true` inside the Tauri desktop app, `false` in the browser dev mode.
 * @returns A promise resolved once the first render is scheduled.
 */
async function bootstrap(
  rootElement: HTMLElement,
  services: AppServices,
  desktop: boolean,
): Promise<void> {
  // The saved language wins over the system ones; i18n is ready before the first render.
  const language = resolveInitialLanguage(await loadSavedLanguage(services), navigator.languages);
  const i18n = await createI18n(language);
  const queryClient = createQueryClient();
  const router = createAppRouter();

  services.logger.log('info', 'app', 'TheLibrary started', {
    runtime: desktop ? 'desktop' : 'browser',
    language,
  });

  createRoot(rootElement).render(
    <StrictMode>
      <AppProviders services={services} queryClient={queryClient} i18n={i18n}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html must contain <div id="root">');
}
// Built before `bootstrap()`, so that a failed startup can still be logged.
const desktop = isTauri();
const services = createServices(desktop);

bootstrap(rootElement, services, desktop).catch((error: unknown) => {
  // Every expected failure is handled inside `bootstrap()`, so this is a bug: keep its trace in the
  // logs, and tell the user instead of leaving an empty window.
  const appError = toAppError(error);
  const stack = appError.cause instanceof Error ? appError.cause.stack : undefined;
  services.logger.log('error', 'app', 'TheLibrary could not start', {
    kind: appError.kind,
    reason: appError.message,
    ...(stack === undefined ? {} : { stack }),
  });
  showStartupFailure(rootElement);
});

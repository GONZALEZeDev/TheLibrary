/**
 * Composition root: the only production module that knows every layer.
 *
 * It picks the adapters for the current environment — Tauri plugins in the desktop app, memory and
 * Web Storage in the browser dev mode (`pnpm dev`) — builds the services, initialises i18n with the
 * saved (or system) language, then renders the application. It also logs every error nothing else
 * reports: errors outside a route, unhandled promise rejections, uncaught render errors.
 *
 * @packageDocumentation
 */
import { RouterProvider } from '@tanstack/react-router';
import { isTauri } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalStorageSettingsStore } from './adapters/dev/local-storage-settings-store.adapter';
import { MemoryLogger } from './adapters/dev/memory-logger.adapter';
import { TauriLogger } from './adapters/tauri/tauri-logger.adapter';
import { TauriSettingsStore } from './adapters/tauri/tauri-settings-store.adapter';
import { errorLogContext, toAppError } from './core/errors/app-error';
import { resolveInitialLanguage, type Language } from './core/settings/language';
import type { LogLevel } from './ports/logger.port';
import type { AppServices } from './services/app-services';
import { SettingsService } from './services/settings.service';
import { AppProviders } from './ui/app/AppProviders';
import { createQueryClient } from './ui/app/query-client';
import { createAppRouter } from './ui/app/router';
import { createI18n, RESOURCES } from './ui/i18n/i18n';
import './ui/theme/theme.css';

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
    services.logger.log(
      'error',
      'app',
      'Could not read the settings, using the defaults',
      errorLogContext(toAppError(error)),
    );
    return null;
  }
}

/**
 * Replace the page with a static message when the application cannot run: it failed to start, or
 * React gave up rendering it. Neither React nor i18next is used, since either may be what failed;
 * the text still comes from the catalogues.
 *
 * @param rootElement - The element the application renders into.
 */
function showFatalError(rootElement: HTMLElement): void {
  const language = resolveInitialLanguage(null, navigator.languages);
  const { errors } = RESOURCES[language].common;
  // i18next normally keeps the `lang` attribute in sync, but it may be what failed: set it here so
  // that screen readers pronounce the message in the language it is written in.
  document.documentElement.lang = language;
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.className = 'p-8 text-fg';
  message.textContent = `${errors.title}. ${errors.kind.unexpected}`;
  rootElement.replaceChildren(message);
}

/** What React tells about an error: the components that were rendering when it happened. */
interface ReactErrorInfo {
  readonly componentStack?: string | null | undefined;
}

/**
 * Log an error reported by React through the `onUncaughtError` and `onRecoverableError` root
 * options, with the component stack that only React knows.
 *
 * @param services - The application services.
 * @param level - Severity of the line.
 * @param scope - Area of the app emitting the line.
 * @param error - The error reported by React, which can be any thrown value.
 * @param errorInfo - Details given by React.
 */
function logReactError(
  services: AppServices,
  level: LogLevel,
  scope: string,
  error: unknown,
  errorInfo: ReactErrorInfo,
): void {
  const appError = toAppError(error);
  const { componentStack } = errorInfo;
  services.logger.log(level, scope, appError.message, {
    ...errorLogContext(appError),
    ...(typeof componentStack === 'string' ? { componentStack } : {}),
  });
}

/**
 * Log the errors that no error boundary and no `catch` handled, so that they leave a trace in the
 * log file. The listeners only log: such an error does not necessarily break the screen, so the UI
 * is left alone.
 *
 * @param services - The application services.
 */
function logUnhandledErrors(services: AppServices): void {
  // Errors thrown outside React's rendering, e.g. in an event handler or a timer callback.
  window.addEventListener('error', (event) => {
    // `event.error` is empty when the browser hides the error (script from another origin) or
    // reports a plain message (ResizeObserver loop): the message is then all that is known.
    const appError = toAppError((event.error as unknown) ?? event.message);
    services.logger.log('error', 'app.window', appError.message, errorLogContext(appError));
  });
  // Promises rejected with nobody to handle them; Tauri plugins reject with plain strings.
  window.addEventListener('unhandledrejection', (event) => {
    const appError = toAppError(event.reason);
    services.logger.log('error', 'app.promise', appError.message, errorLogContext(appError));
  });
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
  const queryClient = createQueryClient(services);
  const router = createAppRouter();

  services.logger.log('info', 'app', 'TheLibrary started', {
    runtime: desktop ? 'desktop' : 'browser',
    language,
  });

  createRoot(rootElement, {
    // An error that no boundary caught: React has unmounted the whole tree, which would leave an
    // empty window, so the user is told that the application cannot continue.
    onUncaughtError: (error, errorInfo) => {
      logReactError(services, 'error', 'ui.uncaught', error, errorInfo);
      showFatalError(rootElement);
    },
    // An error React recovered from by itself (e.g. a render that succeeded when retried): nothing
    // is broken, but it deserves a line in the log.
    onRecoverableError: (error, errorInfo) => {
      logReactError(services, 'warn', 'ui.recoverable', error, errorInfo);
    },
    // `onCaughtError` is deliberately left to React's default (a console line): the errors that the
    // router's boundary catches are already logged, once, by `RouteErrorFallback`, so logging them
    // here too would write each of them twice.
  }).render(
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
// Registered right away, so that nothing happening after this point goes unlogged.
logUnhandledErrors(services);

bootstrap(rootElement, services, desktop).catch((error: unknown) => {
  // Every expected failure is handled inside `bootstrap()`, so this is a bug: keep its trace in the
  // logs, and tell the user instead of leaving an empty window.
  const appError = toAppError(error);
  services.logger.log('error', 'app', 'TheLibrary could not start', {
    reason: appError.message,
    ...errorLogContext(appError),
  });
  showFatalError(rootElement);
});

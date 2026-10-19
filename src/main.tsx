/**
 * Composition root: the only production module that knows every layer.
 *
 * It picks the adapters for the current environment — Tauri plugins in the desktop app, the
 * development adapters (synthetic data, in-memory database) in the browser dev mode (`pnpm dev`) —
 * builds the services, initialises i18n with the saved (or system) language, renders the
 * application, then starts the synchronisation. It also logs every error nothing else reports:
 * errors outside a route, unhandled promise rejections, uncaught render errors.
 *
 * Development-only code (the browser adapters, with their in-memory archive store, and the TanStack
 * devtools) is only reached through dynamic `import()`s guarded by `import.meta.env.DEV`. Vite
 * replaces that flag with `false` in production builds and leaves those modules out;
 * `scripts/check-dev-code.ts` proves it in CI.
 *
 * @packageDocumentation
 */
import { RouterProvider } from '@tanstack/react-router';
import { isTauri } from '@tauri-apps/api/core';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkerCompressor } from './adapters/browser/worker-compressor.adapter';
import { TauriArchiveStore } from './adapters/tauri/tauri-archive-store.adapter';
import { TauriDatabase } from './adapters/tauri/tauri-database.adapter';
import { TauriHttpClient } from './adapters/tauri/tauri-http-client.adapter';
import { TauriLogger } from './adapters/tauri/tauri-logger.adapter';
import { TauriSettingsStore } from './adapters/tauri/tauri-settings-store.adapter';
import { TauriSignInGateway } from './adapters/tauri/tauri-sign-in-gateway.adapter';
import { errorLogContext, toAppError } from './core/errors/app-error';
import { resolveInitialLanguage, type Language } from './core/settings/language';
import type { LogLevel } from './ports/logger.port';
import type { AppServices } from './services/app-services';
import { createAppServices, type AppAdapters } from './services/create-app-services';
import { AppProviders } from './ui/app/AppProviders';
import { createQueryClient } from './ui/app/query-client';
import { createAppRouter } from './ui/app/router';
import { createUnhandledErrorReporter } from './ui/app/unhandled-errors';
import { createI18n, RESOURCES } from './ui/i18n/i18n';
import './ui/theme/theme.css';

/** Version of the app (package.json), written into the bundle by Vite: see `define` in vite.config.ts. */
declare const __APP_VERSION__: string;

/** TanStack devtools, in development builds only (see the header of this file). */
const DevTools = import.meta.env.DEV
  ? lazy(() => import('./ui/app/DevTools').then((module) => ({ default: module.DevTools })))
  : null;

/**
 * Create the adapters of the current environment.
 *
 * @param desktop - `true` inside the Tauri desktop app, `false` in the browser.
 * @returns One adapter per port.
 * @throws Error in a production build opened outside the desktop app, which has no adapters for
 *   the browser.
 */
async function createAdapters(desktop: boolean): Promise<AppAdapters> {
  // The compressor is the same in the desktop app and in the browser dev mode, and the app has
  // one: it starts its zstd worker on the first use, so creating it here costs nothing even when
  // the adapters below turn out to be unavailable.
  const compressor = new WorkerCompressor();
  if (desktop) {
    return {
      logger: new TauriLogger(),
      settingsStore: new TauriSettingsStore(),
      http: new TauriHttpClient(),
      database: new TauriDatabase(),
      archiveStore: new TauriArchiveStore(),
      compressor,
      // The listener and the browser of the Steam sign-in. There is no adapter for the account: it
      // is the link stored in the database, which the services read themselves.
      signInGateway: new TauriSignInGateway(),
    };
  }
  if (import.meta.env.DEV) {
    // The in-memory archive store comes with the browser dev adapters, never from a static import.
    return {
      ...(await import('./adapters/dev/dev-environment')).createBrowserDevAdapters(),
      compressor,
    };
  }
  throw new Error('Outside development, TheLibrary only runs in its desktop app');
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
  // At most 20 lines a minute: an error repeated in a loop must not fill the log files.
  const report = createUnhandledErrorReporter(services);
  // Errors thrown outside React's rendering, e.g. in an event handler or a timer callback.
  window.addEventListener('error', (event) => {
    // `event.error` is empty when the browser hides the error (script from another origin) or
    // reports a plain message (ResizeObserver loop): the message is then all that is known.
    report('app.window', (event.error as unknown) ?? event.message);
  });
  // Promises rejected with nobody to handle them; Tauri plugins reject with plain strings.
  window.addEventListener('unhandledrejection', (event) => {
    report('app.promise', event.reason);
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
        {DevTools !== null && (
          <Suspense fallback={null}>
            <DevTools router={router} />
          </Suspense>
        )}
      </AppProviders>
    </StrictMode>,
  );

  // Started once the first render is scheduled, so that it never delays the window. The account
  // service starts the synchronisation, but first runs the startup cleanup (data left by an
  // interrupted unlink or switch, and the compaction it owes): the first synchronisation must not
  // run while another account's data is being deleted. Then the first synchronisation runs right
  // away, the next ones on the timer of `SyncService.start`.
  setTimeout(() => {
    void services.account.start();
  }, 0);
}

/**
 * Create the adapters and the services, then start the application.
 *
 * @param rootElement - The element the application renders into.
 */
async function start(rootElement: HTMLElement): Promise<void> {
  const desktop = isTauri();
  // Built before `bootstrap()`, so that a failed startup can still be logged.
  const services = createAppServices(await createAdapters(desktop), {
    appVersion: __APP_VERSION__,
  });
  // Registered right away, so that nothing happening after this point goes unlogged.
  logUnhandledErrors(services);
  try {
    await bootstrap(rootElement, services, desktop);
  } catch (error) {
    // Every expected failure is handled inside `bootstrap()`, so this is a bug: keep its trace in
    // the logs, and tell the user instead of leaving an empty window.
    const appError = toAppError(error);
    services.logger.log('error', 'app', 'TheLibrary could not start', {
      reason: appError.message,
      ...errorLogContext(appError),
    });
    showFatalError(rootElement);
  }
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html must contain <div id="root">');
}
start(rootElement).catch((error: unknown) => {
  // The adapters could not be created, so there is no logger yet: the user is told, and the error
  // is rethrown so that it still reaches the console of the webview (useful in development).
  showFatalError(rootElement);
  throw error;
});

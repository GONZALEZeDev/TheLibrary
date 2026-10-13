/**
 * Error screen of a route.
 *
 * Registered as the router's default error component. When a page fails to render, this screen
 * replaces the page inside the shell, so the sidebar stays usable; when the root layout itself
 * fails, there is no shell left and it replaces the whole window. The screen shows a translated
 * message for the error kind, logs the technical details once, and lets the user retry or copy the
 * kind and message for a bug report.
 *
 * @packageDocumentation
 */
import type { ErrorComponentProps } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorLogContext, toAppError } from '../../core/errors/app-error';
import { useServices } from './ServicesContext';

/**
 * Initial value of the "last logged error" ref. A fresh symbol can never equal a thrown value, not
 * even `null` or `undefined`, which a route may throw like anything else.
 */
const NOT_LOGGED = Symbol('not logged');

/** Shared look of the two action buttons. */
const BUTTON_CLASS =
  'rounded-md border border-border bg-surface-raised px-4 py-2 text-sm font-medium hover:border-accent-bright';

/**
 * Route error screen.
 *
 * @returns The error screen.
 */
export function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const { logger } = useServices();
  const [copied, setCopied] = useState(false);
  // Normalised once per error: the message and kind shown, logged and copied all come from here.
  const appError = useMemo(() => toAppError(error), [error]);
  // The error logged last. A ref survives the effect replay of React's StrictMode (development
  // only), so each error is logged exactly once.
  const loggedError = useRef<unknown>(NOT_LOGGED);

  useEffect(() => {
    if (loggedError.current === error) {
      return;
    }
    loggedError.current = error;
    // A crash while rendering leaves no other trace: the log keeps the cause and the stack.
    logger.log('error', 'ui.route', appError.message, errorLogContext(appError));
  }, [logger, error, appError]);

  // Copies the kind, message and context of the error, as JSON, for a bug report. The cause and the
  // stack stay in the logs: they can hold paths or other details not meant to be pasted around.
  async function copyDetails(): Promise<void> {
    const details = { kind: appError.kind, message: appError.message, context: appError.context };
    try {
      await navigator.clipboard.writeText(JSON.stringify(details, null, 2));
      setCopied(true);
    } catch {
      // Clipboard access can be refused by the system; the details are in the logs anyway.
    }
  }

  // `role="alert"`: screen readers announce the error as soon as it replaces the page.
  return (
    <div
      role="alert"
      className="mx-auto mt-16 max-w-lg rounded-xl border border-border bg-surface p-8 text-center"
    >
      <TriangleAlert aria-hidden="true" className="mx-auto mb-4 size-10 text-loss" />
      <h1 className="text-xl font-semibold">{t('errors.title')}</h1>
      <p className="mt-2 text-sm text-fg-muted">{t(`errors.kind.${appError.kind}`)}</p>
      <div className="mt-6 flex justify-center gap-3">
        <button type="button" onClick={reset} className={BUTTON_CLASS}>
          {t('errors.retry')}
        </button>
        <button
          type="button"
          onClick={() => {
            void copyDetails();
          }}
          className={BUTTON_CLASS}
        >
          {copied ? t('errors.copied') : t('errors.copyDetails')}
        </button>
      </div>
    </div>
  );
}

/**
 * Error screen of a route.
 *
 * Registered as the router's default error component: when a page fails to render, it is replaced
 * by this screen while the sidebar stays usable. The screen shows a translated message for the
 * error kind, logs the technical details once, and lets the user retry or copy the details for a
 * bug report.
 *
 * @packageDocumentation
 */
import type { ErrorComponentProps } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppError } from '../../core/errors/app-error';
import { useServices } from './ServicesContext';

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
  const loggedError = useRef<unknown>(null);

  useEffect(() => {
    if (loggedError.current === error) {
      return;
    }
    loggedError.current = error;
    // A crash while rendering leaves no other trace: keep the stack trace of the original error.
    const stack = appError.cause instanceof Error ? appError.cause.stack : undefined;
    logger.log('error', 'ui.route', appError.message, {
      ...appError.context,
      // After the context, so a context key can never override the kind.
      kind: appError.kind,
      ...(stack === undefined ? {} : { stack }),
    });
  }, [logger, error, appError]);

  // Copies the kind, message and context of the error, as JSON, for a bug report.
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

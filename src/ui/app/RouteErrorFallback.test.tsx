/**
 * Tests of the route error screen.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { createTestQueryClient, createTestServices } from '../../test/create-test-services';
import { createI18n } from '../i18n/i18n';
import { AppProviders } from './AppProviders';
import { RouteErrorFallback } from './RouteErrorFallback';

/**
 * Render the error screen for `error` with the real providers, inside `<StrictMode>` like the app
 * (StrictMode replays effects in development, which must not log an error twice).
 *
 * @param error - The value thrown by the route. The router hands over whatever was thrown, even
 *   though the props of the error screen are typed as `Error`.
 * @returns The logger of the test services and the `reset` spy.
 */
async function renderFallback(error: unknown) {
  const { services, logger } = createTestServices();
  const i18n = await createI18n('en');
  const reset = vi.fn();
  render(
    <StrictMode>
      <AppProviders services={services} queryClient={createTestQueryClient()} i18n={i18n}>
        <RouteErrorFallback error={error as Error} reset={reset} />
      </AppProviders>
    </StrictMode>,
  );
  return { logger, reset };
}

describe('RouteErrorFallback', () => {
  it('shows the translated message of the error kind and logs the details once', async () => {
    const { logger } = await renderFallback(
      new AppError('network', 'GET /v1/info failed', { context: { status: 0 } }),
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(
      screen.getByText('The server could not be reached. Check your internet connection.'),
    ).toBeInTheDocument();
    expect(logger.entries).toEqual([
      {
        level: 'error',
        scope: 'ui.route',
        message: 'GET /v1/info failed',
        // The error has no cause, so the stack logged is its own.
        context: {
          kind: 'network',
          status: 0,
          stack: expect.stringContaining('GET /v1/info failed') as unknown,
        },
      },
    ]);
  });

  it('treats unknown errors as unexpected, logging their stack but never showing it', async () => {
    const { logger } = await renderFallback(new TypeError('x is undefined'));

    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
    expect(screen.queryByText(/x is undefined/)).not.toBeInTheDocument();
    expect(logger.entries).toEqual([
      {
        level: 'error',
        scope: 'ui.route',
        message: 'x is undefined',
        context: {
          kind: 'unexpected',
          cause: 'x is undefined',
          stack: expect.stringContaining('TypeError: x is undefined') as unknown,
        },
      },
    ]);
  });

  it('keeps the reason of a failure that is not an Error, like the strings Tauri rejects with', async () => {
    const { logger } = await renderFallback(
      new AppError('storage', 'Could not read the settings', { cause: 'store is locked' }),
    );

    expect(logger.entries).toEqual([
      {
        level: 'error',
        scope: 'ui.route',
        message: 'Could not read the settings',
        context: {
          kind: 'storage',
          cause: 'store is locked',
          stack: expect.stringContaining('Could not read the settings') as unknown,
        },
      },
    ]);
  });

  it('logs a thrown null exactly once', async () => {
    const { logger } = await renderFallback(null);

    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
    expect(logger.entries).toEqual([
      {
        level: 'error',
        scope: 'ui.route',
        message: 'null',
        context: {
          kind: 'unexpected',
          cause: 'null',
          stack: expect.stringContaining('null') as unknown,
        },
      },
    ]);
  });

  it('retries when asked', async () => {
    const user = userEvent.setup();
    const { reset } = await renderFallback(new AppError('timeout', 'too slow'));

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(reset).toHaveBeenCalledOnce();
  });

  it('copies the error details for a bug report', async () => {
    const user = userEvent.setup();
    await renderFallback(new AppError('storage', 'disk full', { cause: 'ENOSPC' }));

    await user.click(screen.getByRole('button', { name: 'Copy details' }));

    expect(await screen.findByRole('button', { name: 'Details copied' })).toBeInTheDocument();
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('"kind": "storage"');
    // The stack and the cause stay in the logs: a report pasted in public must not carry them.
    expect(copied).not.toContain('"stack"');
    expect(copied).not.toContain('"cause"');
  });
});

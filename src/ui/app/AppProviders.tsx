/**
 * Every React provider the app needs, in one place: used by the composition root and by the tests,
 * so both render the UI in exactly the same environment.
 *
 * @packageDocumentation
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { i18n } from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { AppServices } from '../../services/app-services';
import { ServicesProvider } from './ServicesContext';

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
  /** Application services (see `services/app-services.ts`). */
  readonly services: AppServices;
  /** TanStack Query cache shared by every data hook. */
  readonly queryClient: QueryClient;
  /** Initialised i18next instance (see `ui/i18n/i18n.ts`). */
  readonly i18n: i18n;
  readonly children: ReactNode;
}

/**
 * Wrap `children` with the services, TanStack Query and i18next providers.
 *
 * @returns The providers wrapping `children`.
 */
export function AppProviders({ services, queryClient, i18n, children }: AppProvidersProps) {
  return (
    <ServicesProvider services={services}>
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
      </QueryClientProvider>
    </ServicesProvider>
  );
}

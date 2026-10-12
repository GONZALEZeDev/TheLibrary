/**
 * React context giving the UI access to the application services.
 *
 * The services are created once by the composition root and passed to {@link ServicesProvider};
 * components read them with {@link useServices} and never build services or adapters themselves.
 *
 * @packageDocumentation
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { AppServices } from '../../services/app-services';

const ServicesContext = createContext<AppServices | null>(null);

/** Props of {@link ServicesProvider}. */
export interface ServicesProviderProps {
  /** The services built by the composition root (or by a test). */
  readonly services: AppServices;
  readonly children: ReactNode;
}

/**
 * Make the services available to every component below.
 *
 * @returns The provider wrapping `children`.
 */
export function ServicesProvider({ services, children }: ServicesProviderProps) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

/**
 * Access the application services.
 *
 * @returns The services given to the nearest {@link ServicesProvider}.
 * @throws Error when called outside a {@link ServicesProvider} (a programming error).
 */
export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error('useServices() must be used inside <ServicesProvider>');
  }
  return services;
}

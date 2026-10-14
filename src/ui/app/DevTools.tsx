/**
 * TanStack Query and Router devtools, for development builds only.
 *
 * `src/main.tsx` loads this file through a dynamic `import()` guarded by `import.meta.env.DEV`, so
 * production builds contain neither it nor the devtools packages; `scripts/check-dev-code.ts`
 * checks it in CI by looking for the marker below.
 *
 * @packageDocumentation
 */
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { useEffect } from 'react';
import type { createAppRouter } from './router';
import { useServices } from './ServicesContext';

/** Text present in every development-only bundle (same value as in `adapters/dev`). */
const DEV_ONLY_MARKER = 'thelibrary-dev-only';

/** Props of {@link DevTools}. */
export interface DevToolsProps {
  /** The application router, inspected by the router devtools. */
  readonly router: ReturnType<typeof createAppRouter>;
}

/**
 * Floating buttons opening the TanStack Query and Router devtools.
 *
 * @returns The devtools.
 */
export function DevTools({ router }: DevToolsProps) {
  const { logger } = useServices();
  useEffect(() => {
    logger.log('debug', 'dev', `${DEV_ONLY_MARKER}: devtools mounted`);
  }, [logger]);
  return (
    <>
      <ReactQueryDevtools buttonPosition="bottom-left" />
      <TanStackRouterDevtools router={router} position="bottom-right" />
    </>
  );
}

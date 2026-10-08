/**
 * Global test setup, run by Vitest before every test file (see `test.setupFiles` in vite.config.ts).
 *
 * @packageDocumentation
 */
// Registers the jest-dom matchers (`toBeInTheDocument()`…) on Vitest's `expect`, with their types.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  // With `globals: false`, React Testing Library cannot register its automatic cleanup itself.
  cleanup();
  // Every test starts with an empty localStorage (used by the development settings adapter).
  localStorage.clear();
});

// jsdom does not implement scrolling, and TanStack Router scrolls to the top on every navigation.
window.scrollTo = () => undefined;

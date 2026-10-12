/**
 * Typed translation keys: `t('nav.dashboard')` is checked at compile time against the English
 * catalogue, and an unknown key is a type error. The French catalogue must have the same keys,
 * which `i18n.test.ts` checks.
 *
 * @packageDocumentation
 */
import type { DEFAULT_NAMESPACE, RESOURCES } from './i18n';

declare module 'i18next' {
  /** Types the keys and interpolation values of `t()` against the English catalogue. */
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof RESOURCES)['en'];
  }
}

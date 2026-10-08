/**
 * Minimal typing of eslint-plugin-jsx-a11y, so that eslint.config.js can be type-checked.
 *
 * The plugin ships no types, and @types/eslint-plugin-jsx-a11y depends on ESLint 9 (it would
 * install a second ESLint next to ESLint 10). Only what eslint.config.js uses is declared.
 *
 * @packageDocumentation
 */
declare module 'eslint-plugin-jsx-a11y' {
  import type { ESLint, Linter } from 'eslint';

  const plugin: ESLint.Plugin & {
    flatConfigs: Record<'recommended' | 'strict', Linter.Config>;
  };
  export default plugin;
}

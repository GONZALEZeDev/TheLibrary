/**
 * ESLint configuration (flat config, ESLint 10).
 *
 * Besides the usual correctness rules, this file enforces the project conventions:
 * - layer boundaries between src/ folders (block "project/architecture");
 * - `@tauri-apps/*` and `@fabianlars/tauri-plugin-oauth` (the Steam sign-in listener) only in
 *   src/adapters/tauri/** and src/main.tsx; src/core only imports `zod`;
 * - relative imports, static or dynamic, without a script extension (`./x`, never `./x.js`), which
 *   the import resolver used by the boundaries rules cannot follow (block
 *   "project/extensionless-imports" for static imports, "project/restricted-syntax" for dynamic ones);
 * - `import.meta.env` read through dot access only (`import.meta.env.DEV`), never used as a value
 *   nor with brackets (`import.meta.env['DEV']`) (block "project/restricted-syntax", see ADR 0006);
 * - TSDoc on every exported symbol (the `jsdoc(...)` block);
 * - kebab-case folders and files, PascalCase React component files (block "project/naming");
 * - `console` only in src/adapters/dev/** — everything else logs through the Logger port;
 * - only `.ts`/`.tsx` files in src/ (block "project/typescript-only"; `.mts` and `.cts` are rejected too).
 * The layer, import and file-type rules were checked with deliberate violations.
 */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';
import checkFile from 'eslint-plugin-check-file';
import { jsdoc } from 'eslint-plugin-jsdoc';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TEST_FILES = ['src/**/*.test.{ts,tsx}'];

/**
 * The npm packages that reach the Tauri shell: everything under `@tauri-apps/` and the community
 * plugin that runs the loopback listener of the Steam sign-in. Only the Tauri adapters and the
 * composition root may import them (see the "npm packages" policies of the architecture block).
 */
const TAURI_PACKAGES = ['@tauri-apps/*', '@fabianlars/tauri-plugin-oauth'];

/** Script files that may not exist in src/: only `.ts` and `.tsx` files are allowed there. */
const NON_TYPESCRIPT_FILES = 'src/**/*.{js,jsx,mjs,cjs,mts,cts}';

/**
 * Relative import specifiers that end in a script extension (`./x.js`, `../y.mjs`…). The slash is
 * written `\x2F` because the same pattern is embedded in an ESLint selector below, where a
 * literal `/` would end the regular expression.
 */
const RELATIVE_SCRIPT_IMPORT = String.raw`^\.{1,2}\x2F.*\.(m|c)?jsx?$`;

/** Message of the two rules that forbid `RELATIVE_SCRIPT_IMPORT`. */
const EXTENSIONLESS_IMPORT_MESSAGE =
  'Import the TypeScript module without an extension (./x, not ./x.js): the boundaries rules cannot resolve a .js specifier.';

/**
 * `no-restricted-syntax` option forbidding the dynamic form of `RELATIVE_SCRIPT_IMPORT`
 * (`import('./x.js')`). `no-restricted-imports` does not look at dynamic imports, which the
 * boundaries rules do check, so the same ban is expressed on their syntax node.
 */
const NO_SCRIPT_EXTENSION_DYNAMIC_IMPORT = {
  selector: `ImportExpression[source.value=/${RELATIVE_SCRIPT_IMPORT}/]`,
  message: EXTENSIONLESS_IMPORT_MESSAGE,
};

/**
 * Message of the rule that restricts `import.meta.env` to dot access. In a build, Vite replaces
 * `import.meta.env.<NAME>` by the value of that one variable, but every other use of
 * `import.meta.env` (as a value, or with brackets) by an object holding every `VITE_*` variable of
 * the build environment: they would all be inlined in the bundle, whoever set them.
 */
const IMPORT_META_ENV_DOT_ACCESS_MESSAGE =
  "Read import.meta.env through dot access only (import.meta.env.DEV), never as a value (alias, spread, argument, type assertion, destructuring) nor with brackets (import.meta.env['DEV'], import.meta.env[key]): Vite replaces every other use with an object holding every VITE_* variable of the build environment, which would inline them all in the bundle (ADR 0006: docs/adr/0006-development-code-out-of-releases.md).";

/** `no-restricted-syntax` option restricting `import.meta.env` to the object of a dot access. */
const IMPORT_META_ENV_DOT_ACCESS_ONLY = {
  // `import.meta.env` anywhere but before a dot: `const env = import.meta.env`,
  // `{ ...import.meta.env }`, `f(import.meta.env)`, `import.meta.env as X`,
  // `const { DEV } = import.meta.env`, and every bracket access (`import.meta.env['DEV']`,
  // `import.meta.env[key]`). `import.meta.env.DEV` and `import.meta.env?.DEV` are fine.
  selector:
    'MemberExpression[computed=false][object.type="MetaProperty"][object.meta.name="import"][property.name="env"]:not(MemberExpression[computed=false] > .object)',
  message: IMPORT_META_ENV_DOT_ACCESS_MESSAGE,
};

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', '.vitest/', 'src-tauri/', 'node_modules/']),

  {
    name: 'project/typescript',
    files: ['**/*.{js,ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TanStack Router's control flow throws `redirect()` / `notFound()` results, which are not Errors.
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'package', package: '@tanstack/router-core', name: 'Redirect' },
            { from: 'package', package: '@tanstack/router-core', name: 'NotFoundError' },
          ],
        },
      ],
    },
  },

  {
    name: 'project/node-config-files',
    // Tooling that runs in Node.js: the configuration files and the scripts of scripts/.
    files: ['*.{js,ts}', 'scripts/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    name: 'project/react',
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: { globals: globals.browser },
  },

  {
    name: 'project/logging',
    files: ['src/**/*.{ts,tsx}'],
    // The console is the destination of the development logger only.
    ignores: ['src/adapters/dev/**'],
    rules: { 'no-console': 'error' },
  },

  {
    name: 'project/typescript-only',
    // The blocks of this file target .ts/.tsx files: any other script file in src/ would escape
    // them (layers, @tauri-apps/* ban, console, TSDoc, naming), so none is allowed there.
    files: [NON_TYPESCRIPT_FILES],
    plugins: { 'check-file': checkFile },
    rules: {
      'check-file/filename-blocklist': ['error', { [NON_TYPESCRIPT_FILES]: '*.{ts,tsx}' }],
    },
  },

  {
    name: 'project/extensionless-imports',
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // `moduleResolution: bundler` and Vite accept `import './x.js'` for `x.ts`, but the resolver
      // behind the boundaries rules does not: such an import would silently escape every layer
      // rule. Relative imports therefore name the TypeScript module without an extension.
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: RELATIVE_SCRIPT_IMPORT, message: EXTENSIONLESS_IMPORT_MESSAGE }] },
      ],
      // The dynamic form (`import('./x.js')`) is banned by `no-restricted-syntax`, whose options
      // are all set in the block below.
    },
  },

  {
    name: 'project/restricted-syntax',
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Dynamic imports with a script extension, and `import.meta.env` other than through dot
      // access. Every option of the rule is set here: a block setting it again later would replace
      // them, since flat config does not merge rule options.
      'no-restricted-syntax': [
        'error',
        NO_SCRIPT_EXTENSION_DYNAMIC_IMPORT,
        IMPORT_META_ENV_DOT_ACCESS_ONLY,
      ],
    },
  },

  {
    name: 'project/architecture',
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      // Without this resolver, extensionless TypeScript imports are not resolved and layer
      // violations are silently NOT reported.
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.json'] } },
      'boundaries/elements': [
        { type: 'core', pattern: 'src/core', partialMatch: false },
        { type: 'ports', pattern: 'src/ports', partialMatch: false },
        { type: 'services', pattern: 'src/services', partialMatch: false },
        { type: 'adapters-tauri', pattern: 'src/adapters/tauri', partialMatch: false },
        { type: 'adapters-dev', pattern: 'src/adapters/dev', partialMatch: false },
        { type: 'adapters-browser', pattern: 'src/adapters/browser', partialMatch: false },
        { type: 'workers', pattern: 'src/workers', partialMatch: false },
        { type: 'ui', pattern: 'src/ui', partialMatch: false },
        { type: 'test-support', pattern: 'src/test', partialMatch: false },
      ],
      // Single-file categories (boundaries v7).
      'boundaries/files': [
        { category: 'main', pattern: 'src/main.tsx' },
        { category: 'test', pattern: 'src/**/*.test.{ts,tsx}' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkAllOrigins: true,
          // When several policies match an import, the LAST one wins.
          policies: [
            // --- Layers ---
            { from: { element: { type: 'core' } }, allow: { to: { element: { type: 'core' } } } },
            {
              from: { element: { type: 'ports' } },
              allow: { to: { element: { types: { anyOf: ['core', 'ports'] } } } },
            },
            {
              from: { element: { type: 'services' } },
              allow: { to: { element: { types: { anyOf: ['core', 'ports', 'services'] } } } },
            },
            {
              from: { element: { type: 'adapters-tauri' } },
              allow: { to: { element: { types: { anyOf: ['core', 'ports', 'adapters-tauri'] } } } },
            },
            {
              from: { element: { type: 'adapters-dev' } },
              allow: { to: { element: { types: { anyOf: ['core', 'ports', 'adapters-dev'] } } } },
            },
            // Browser APIs (a Web Worker…) that are not specific to Tauri and ship in releases,
            // unlike `adapters-dev`. A worker file is reached by URL, never imported.
            {
              from: { element: { type: 'adapters-browser' } },
              allow: {
                to: { element: { types: { anyOf: ['core', 'ports', 'adapters-browser'] } } },
              },
            },
            {
              from: { element: { type: 'workers' } },
              allow: { to: { element: { type: 'core' } } },
            },
            {
              from: { element: { type: 'ui' } },
              allow: { to: { element: { types: { anyOf: ['core', 'services', 'ui'] } } } },
            },
            // The composition root and the shared test helpers assemble every layer.
            {
              from: [{ file: { categories: 'main' } }, { element: { type: 'test-support' } }],
              allow: { to: { element: { type: '*' } } },
            },
            // Tests may use the development and browser adapters and the shared test helpers.
            {
              from: { file: { categories: 'test' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['adapters-dev', 'adapters-browser', 'test-support'] },
                  },
                },
              },
            },

            // --- npm packages ---
            // Allowed unless restricted below. Node.js built-ins (origin "core") stay disallowed:
            // src/ runs in the webview.
            { allow: { to: { module: { origin: 'external' } } } },
            {
              disallow: { to: { module: { source: TAURI_PACKAGES } } },
              message:
                '@tauri-apps/* and @fabianlars/tauri-plugin-oauth may only be imported from src/adapters/tauri/** and src/main.tsx',
            },
            {
              from: [{ element: { type: 'adapters-tauri' } }, { file: { categories: 'main' } }],
              allow: { to: { module: { source: TAURI_PACKAGES } } },
            },
            {
              from: { element: { type: 'core' } },
              disallow: { to: { module: { origin: 'external', source: '!zod' } } },
              message:
                'src/core may only import the external package "zod" (got "{{to.module.source}}")',
            },
            // Test files may always use the test tooling.
            {
              from: { file: { categories: 'test' } },
              allow: { to: { module: { source: ['vitest', '@testing-library/*'] } } },
            },
          ],
        },
      ],
      // A file outside the folders above would escape every rule of this block, including the
      // ban on the Tauri packages (`TAURI_PACKAGES`): a new src/ folder must first be declared as
      // an element.
      'boundaries/no-unknown-files': 'error',
    },
  },

  jsdoc({
    config: 'flat/recommended-tsdoc-error',
    files: ['src/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            FunctionExpression: true,
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
          },
          // Interfaces, types, enums and exported constants (schemas, lookup tables…) too.
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
            'VariableDeclaration',
          ],
          // The fixer would insert empty comment stubs.
          enableFixer: false,
        },
      ],
      'jsdoc/require-hyphen-before-param-description': ['error', 'always'],
      // TSDoc style: one blank line between the summary and the first block tag.
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
      // React components receive one destructured `props` object, documented on its Props interface.
      'jsdoc/require-param': ['error', { checkDestructuredRoots: false }],
    },
  }),

  {
    name: 'project/naming',
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'check-file': checkFile },
    rules: {
      'check-file/folder-naming-convention': ['error', { 'src/**/': 'KEBAB_CASE' }],
      'check-file/filename-naming-convention': [
        'error',
        {
          'src/**/*.ts': 'KEBAB_CASE',
          // React component files are PascalCase. Test files are named after the module they
          // test (`AppShell.test.tsx`, `use-settings.test.tsx`), so they are not constrained here.
          'src/ui/**/!(*.test).tsx': 'PASCAL_CASE',
        },
        // Lets `souls-per-min.metric.ts`, `app-error.test.ts` or `i18next.d.ts` through.
        { ignoreMiddleExtensions: true },
      ],
    },
  },

  // Last: turns off every stylistic rule that would fight Prettier.
  prettierConfig,
]);

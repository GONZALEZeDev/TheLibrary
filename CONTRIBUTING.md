# Contributing to TheLibrary

Thanks for your interest! This guide explains how the code is organised and the rules every change follows. The reasons behind the key technical choices are recorded in [docs/adr](docs/adr).

## Architecture in one picture

```
ui/  ──►  services/  ──►  core/
               │
               ▼
            ports/  ◄──  adapters/tauri/   (desktop app)
                    ◄──  adapters/dev/     (tests and browser dev mode)
```

| Folder          | Role                                                                             | May import               |
| --------------- | -------------------------------------------------------------------------------- | ------------------------ |
| `src/core/`     | Domain model and pure logic (no side effects)                                    | `core/` only, plus `zod` |
| `src/ports/`    | Interfaces describing side effects (logging, storage, HTTP…)                     | `core/`                  |
| `src/services/` | Use cases orchestrating `core/` and ports                                        | `core/`, `ports/`        |
| `src/adapters/` | Port implementations: Tauri plugins, or browser storage and memory for tests/dev | `core/`, `ports/`        |
| `src/ui/`       | React routes, components, i18n, theme                                            | `core/`, `services/`     |
| `src/test/`     | Shared test helpers (services on the development adapters…)                      | everything               |
| `src/main.tsx`  | Composition root: picks the adapters and builds the services                     | everything               |

These rules are enforced by ESLint: a forbidden import fails `pnpm lint` and CI. Test files follow the rules of their folder, and may additionally use `src/adapters/dev/` and `src/test/`. Only `src/adapters/tauri/` and `src/main.tsx` may import `@tauri-apps/*`. Each folder has a short `README.md` with its own rules.

## Conventions

- **English everywhere** in code, comments and docs. User-facing text lives only in `src/ui/i18n/locales/{en,fr}`; both languages must have the same keys (a test checks it).
- **Naming**:

  | Item                            | Convention                                                                | Example                        |
  | ------------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
  | Folders and non-component files | kebab-case                                                                | `match-history.schema.ts`      |
  | React components                | PascalCase, one component per file                                        | `MatchTimeline.tsx`            |
  | Role suffixes                   | `.port`, `.adapter`, `.schema`, `.metric`, `.rule`, `.service`, `.worker` | `souls-per-min.metric.ts`      |
  | Tests                           | next to the code they test, named after it                                | `souls-per-min.metric.test.ts` |

- **Comments**, three levels: a header on every file (purpose and place in the architecture); TSDoc on every exported symbol; a comment on every non-trivial block explaining how it works and _why_. No commented-out code; every TODO references an issue.
- **Errors**: throw `AppError` (`src/core/errors/app-error.ts`) with the right `kind`; never show raw error messages to users.
- **Logging**: use the `Logger` port; `console` is only allowed in `src/adapters/dev/`.

## Workflow

1. Create a branch from `main`.
2. Write the test first, then the code.
3. Run `pnpm check` (and, if you touched `src-tauri/`, `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` from `src-tauri/`).
4. Open a pull request describing the change and how you tested it. CI must be green.

## Useful commands

| Command                                | What it does                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`                             | UI only in the browser, on the development adapters (browser storage, console logs) |
| `pnpm tauri dev`                       | Full desktop app with hot reload                                                    |
| `pnpm test` / `pnpm test:watch`        | Unit and integration tests                                                          |
| `pnpm lint` / `pnpm format`            | Lint / format everything                                                            |
| `pnpm tauri build --debug --no-bundle` | Production-mode executable (CSP enforced) without installer                         |

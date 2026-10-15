# Contributing to TheLibrary

Thanks for your interest! This guide explains how the code is organised and the rules every change follows. The reasons behind the key technical choices are recorded in [docs/adr](docs/adr).

## Architecture in one picture

```text
ui/  ──►  services/  ──►  core/
               │
               ▼
            ports/  ◄──  adapters/tauri/   (desktop app)
                    ◄──  adapters/dev/     (tests and development modes)
```

| Folder          | Role                                                                                                     | May import               |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ |
| `src/core/`     | Domain model and pure logic (no side effects)                                                            | `core/` only, plus `zod` |
| `src/ports/`    | Interfaces describing side effects (logging, storage, HTTP…)                                             | `core/`                  |
| `src/services/` | Use cases orchestrating `core/` and ports                                                                | `core/`, `ports/`        |
| `src/adapters/` | Port implementations: Tauri plugins, or memory, browser storage, sql.js and synthetic data for tests/dev | `core/`, `ports/`        |
| `src/ui/`       | React routes, components, i18n, theme                                                                    | `core/`, `services/`     |
| `src/test/`     | Shared test helpers (services on the development adapters…)                                              | everything               |
| `src/main.tsx`  | Composition root: picks the adapters and builds the services                                             | everything               |

These rules are enforced by ESLint: a forbidden import fails `pnpm lint` and CI. Test files follow the rules of their folder, and may additionally use `src/adapters/dev/` and `src/test/`. Only `src/adapters/tauri/` and `src/main.tsx` may import `@tauri-apps/*`. Every file of `src/` must belong to a folder declared in `eslint.config.js` (rule `boundaries/no-unknown-files`): a new top-level folder of `src/` is declared there first. Each layer folder (`core`, `ports`, `services`, `adapters`, `ui`) has a short `README.md` with its own rules.

## Conventions

- **English everywhere** in code, comments and docs. User-facing text lives only in `src/ui/i18n/locales/{en,fr}`; both languages must have the same keys (a test checks it).
- **Naming**:

  | Item                            | Convention                                                                               | Example                        |
  | ------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
  | Folders and non-component files | kebab-case                                                                               | `match-history.schema.ts`      |
  | React components                | PascalCase, one component per file                                                       | `MatchTimeline.tsx`            |
  | Role suffixes                   | `.port`, `.adapter`, `.schema`, `.repository`, `.metric`, `.rule`, `.service`, `.worker` | `souls-per-min.metric.ts`      |
  | Tests                           | next to the code they test, named after it                                               | `souls-per-min.metric.test.ts` |

- **Comments**, three levels: a header on every file (purpose and place in the architecture); TSDoc on every exported symbol; a comment on every non-trivial block explaining how it works and _why_. No commented-out code; every TODO references an issue.
- **Errors**: throw `AppError` (`src/core/errors/app-error.ts`) with the right `kind`; never show raw error messages to users.
- **Logging**: use the `Logger` port; `console` is only allowed in `src/adapters/dev/`. Never log an account id: endpoints are logged as templates (`/v1/players/{account_id}/…`).
- **Database**: the schema changes only through a new file in `migrations/` — never edit a released migration (see [migrations/README.md](migrations/README.md)).
- **Development-only code** (synthetic data, sql.js, the development account, devtools) is only loaded through the `import.meta.env.DEV`-guarded imports of `src/main.tsx`: never import it statically from production code ([ADR 0006](docs/adr/0006-development-code-out-of-releases.md)). `pnpm check:dev-code` proves it after `pnpm build`.

## Workflow

1. Create a branch from `main`.
2. Write the test first, then the code.
3. Run `pnpm check`, `pnpm build` and `pnpm check:dev-code` (and, if you touched `src-tauri/`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` from `src-tauri/`; the Rust code embeds the `dist/` folder that `pnpm build` produces, so build the frontend first). CI runs the same checks, plus the dependency audits (`pnpm audit`, `cargo audit`).
4. Open a pull request describing the change and how you tested it. CI must be green.

## Useful commands

| Command                                | What it does                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                             | UI only in the browser, on synthetic data (no network, in-memory database)                                    |
| `pnpm dev:desktop`                     | Full desktop app with hot reload, with its own data folders (see below)                                       |
| `pnpm check:dev-code`                  | After `pnpm build`: proves the build contains no development-only code                                        |
| `pnpm test` / `pnpm test:watch`        | Unit and integration tests                                                                                    |
| `pnpm lint` / `pnpm format`            | Lint / format everything                                                                                      |
| `pnpm tauri build --debug --no-bundle` | Production-mode executable (CSP enforced) without installer; it uses the data folders of an installed release |

## Running the desktop app with your own account

Until the Steam sign-in exists, the desktop app synchronises the account named in a local file:

1. Find your Steam **account id**: the number `N` of your SteamID3 `[U:1:N]` (not the 17-digit SteamID64), which any SteamID converter shows; it is also your SteamID64 minus 76561197960265728.
2. Create `.env.development.local` at the root of the repository (git-ignored, never commit it) with the line `VITE_DEV_ACCOUNT_ID=N`. Put it in no other `.env` file: Vite reads `.env` and `.env.local` in every mode.
3. Run `pnpm dev:desktop` (restart it after editing the file). The app synchronises your match history at startup and every 13 minutes. Without the file, the synchronisation banner shows how to create it.

`pnpm dev:desktop` runs the app under a separate identifier (`src-tauri/tauri.dev.conf.json`): its settings and database live in `%APPDATA%\io.github.gonzalezedev.thelibrary.dev`, its logs and WebView data in `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary.dev`, and they never touch an installed release. Delete those two folders to start from scratch. Do not run `pnpm tauri dev` directly: it would use the release identifier, and so the folders of an installed release. Release builds never read this file and never contain this code ([ADR 0006](docs/adr/0006-development-code-out-of-releases.md)).

Your history is complete only if your Steam account is friends with one of deadlock-api's bots, which requires a [deadlock-api Patreon membership](https://deadlock-api.com/patron); otherwise deadlock-api only knows the matches it collected by itself.

# Contributing to TheLibrary

Thanks for your interest! This guide explains how the code is organised and the rules every change follows. The reasons behind the key technical choices are recorded in [docs/adr](docs/adr).

## Architecture in one picture

```text
ui/  ──►  services/  ──►  core/  ◄──  workers/   (Web Workers)
               │
               ▼
            ports/  ◄──  adapters/tauri/     (desktop app)
                    ◄──  adapters/browser/   (browser APIs that ship in releases)
                    ◄──  adapters/dev/       (tests and development modes)
```

| Folder                  | Role                                                                                                                            | May import                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `src/core/`             | Domain model and pure logic (no side effects)                                                                                   | `core/` only, plus `zod`   |
| `src/ports/`            | Interfaces describing side effects (logging, storage, HTTP, the archive files…)                                                 | `core/`                    |
| `src/services/`         | Use cases orchestrating `core/` and ports                                                                                       | `core/`, `ports/`          |
| `src/adapters/`         | Port implementations: Tauri plugins, or memory (the archive included), browser storage, sql.js and synthetic data for tests/dev | `core/`, `ports/`          |
| `src/adapters/browser/` | Port implementations on browser APIs that ship in releases, such as the Web Worker that compresses the archive                  | `core/`, `ports/`          |
| `src/workers/`          | Web Workers: pure CPU work off the main thread (zstd compression), talking to the page by messages only                         | `core/`, plus npm packages |
| `src/ui/`               | React routes, components, i18n, theme                                                                                           | `core/`, `services/`       |
| `src/test/`             | Shared test helpers (services on the development adapters…)                                                                     | everything                 |
| `src/main.tsx`          | Composition root: picks the adapters and builds the services                                                                    | everything                 |

These rules are enforced by ESLint: a forbidden import fails `pnpm lint` and CI. Test files follow the rules of their folder, and may additionally use `src/adapters/dev/`, `src/adapters/browser/` and `src/test/`. Only `src/adapters/tauri/` and `src/main.tsx` may import `@tauri-apps/*`. Every file of `src/` must belong to a folder declared in `eslint.config.js` (rule `boundaries/no-unknown-files`): a new top-level folder of `src/` is declared there first. Each layer folder (`core`, `ports`, `services`, `adapters`, `workers`, `ui`) has a short `README.md` with its own rules.

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
- **Development-only code** (synthetic data, sql.js, the in-memory archive store, the fixture sign-in gateway, devtools) is only loaded through the `import.meta.env.DEV`-guarded imports of `src/main.tsx`: never import it statically from production code ([ADR 0006](docs/adr/0006-development-code-out-of-releases.md)). `pnpm check:dev-code` proves it after `pnpm build`.

## Workflow

1. Create a branch from `main`.
2. Write the test first, then the code.
3. Run `pnpm check`, `pnpm build` and `pnpm check:dev-code` (and, if you touched `src-tauri/`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` from `src-tauri/`; the Rust code embeds the `dist/` folder that `pnpm build` produces, so build the frontend first). CI runs the same checks, plus the dependency audits (`pnpm audit`, `cargo audit`).
4. Open a pull request describing the change and how you tested it. CI must be green.

## Useful commands

| Command                                | What it does                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                             | UI only in the browser, on synthetic data (no network, in-memory database and archive, imitated Steam)        |
| `pnpm dev:desktop`                     | Full desktop app with hot reload and the real Steam sign-in, with its own data folders (see below)            |
| `pnpm check:dev-code`                  | After `pnpm build`: proves the build contains no development-only code                                        |
| `pnpm test` / `pnpm test:watch`        | Unit and integration tests                                                                                    |
| `pnpm canary`                          | The weekly API canary: calls the real deadlock-api; GitHub Actions also runs it every Monday                  |
| `pnpm lint` / `pnpm format`            | Lint / format everything                                                                                      |
| `pnpm tauri build --debug --no-bundle` | Production-mode executable (CSP enforced) without installer; it uses the data folders of an installed release |

## Signing in during development

The app links an account only through the Steam sign-in, in development as in a release. Nothing is configured in a file.

- **`pnpm dev:desktop`** signs in through Steam's real page. Click **Link my Steam account** (the dashboard invites you to), then **Continue**: your system browser opens Steam's login page, which shows the site as `127.0.0.1` (the one-shot listener the app starts on your PC), and the app links the account you signed in with. TheLibrary never sees your password. The app then synchronises your match history at startup and every 13 minutes.
- **`pnpm dev`** (browser) needs no Steam: the same button links a synthetic fixture account after a short delay, through a fixture gateway that answers as Steam would. The checks of the sign-in still run on that answer.
- To try another account, use the settings: unlinking the account, or linking another one, deletes the old account's matches, archives and history on this PC (the logs stay).

`pnpm dev:desktop` runs the app under a separate identifier (`src-tauri/tauri.dev.conf.json`): its settings and database live in `%APPDATA%\io.github.gonzalezedev.thelibrary.dev`, its logs, archives and WebView data in `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary.dev`, and they never touch an installed release. Delete those two folders to start from scratch. Do not run `pnpm tauri dev` directly: it would use the release identifier, and so the folders of an installed release. Release builds never contain the development code ([ADR 0006](docs/adr/0006-development-code-out-of-releases.md)).

Note that deadlock-api only knows the matches it collected itself, so the history may be incomplete.

## Where the match archives live

The detail of each normal-mode Paige match of the last 90 days is downloaded after the history, pruned to the tracked player, compressed with zstd and kept as one file per match ([ADR 0003](docs/adr/0003-user-centric-archive-zstd.md)). The files live in `%LOCALAPPDATA%\<identifier>\archive\`, in a folder per account (`archive\<account>\`); under `pnpm dev:desktop` that is `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary.dev\archive\`. Deleting the folder is safe for the matches of the last 90 days: the app notices a missing archive when you open its match, puts the match back in the download queue, and fetches it again at the next synchronisation. An older match is not downloaded again: its archive is lost for good. The responses the app could not use are kept in `archive\<account>\quarantine\` (the 20 most recent of each account). Unlinking an account, or linking another one, deletes the folder of the old account, quarantine included. In the browser dev mode (`pnpm dev`) the archive is an in-memory store, gone when the page reloads.

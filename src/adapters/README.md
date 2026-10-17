# `src/adapters` — port implementations

| Folder     | Used by                                                                             | Backed by                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `tauri/`   | The desktop app                                                                     | Tauri plugins (`@tauri-apps/*`): settings, logs, HTTP, database and the archive files (`TauriArchiveStore`)                      |
| `browser/` | The desktop app and the browser dev mode (`pnpm dev`)                               | Browser APIs that ship in releases: the zstd Web Worker (`WorkerCompressor`)                                                     |
| `dev/`     | Tests and the development modes (`pnpm dev`, and the account of `pnpm dev:desktop`) | Memory (including the archive store, `MemoryArchiveStore`), Web Storage, sql.js, synthetic deadlock-api, the development account |

The composition root (`src/main.tsx`) picks the `tauri/` set or the `dev/` set with `isTauri()`; the compressor of `browser/` is the same in both. It reaches the development entry point (`dev/dev-environment.ts`) only in development builds, so release builds contain none of `dev/` ([ADR 0006](../../docs/adr/0006-development-code-out-of-releases.md)).

## Rules

- May import `ports/` and `core/` only (enforced by ESLint).
- Only `tauri/` (and `src/main.tsx`) may import `@tauri-apps/*`.
- `console` is allowed in `dev/` only, where the console is the destination.
- `browser/` holds what uses browser APIs without being specific to Tauri, and so ships in releases, unlike `dev/`. A worker file is reached by its URL (`new Worker(new URL(…, import.meta.url), { type: 'module' })`), never imported, so this layer does not depend on `src/workers/`.
- One adapter per file, named `<name>.adapter.ts`, implementing exactly one port.
- Adapters stay thin: they do not wrap failures in `AppError` and do not validate the data they read. The failures of the underlying technology (a full disk, a plugin error…) propagate as they are; the service wraps them in an `AppError` and validates the data against the schema of `core/`. The exceptions are documented on their port: the HTTP client reports its transport failures as `AppError` (only the adapter can tell a timeout from a network failure or an oversized body), the logger never fails (a line it cannot write is dropped: there is nowhere left to report it), and the worker compressor reports all its failures as `AppError('storage')` (errors cross the worker boundary as text, so only the adapter can report them). The one tolerance is the Web Storage adapter, which reads stored text it cannot parse as "nothing saved".
- Every plugin permission an adapter needs must be granted in `src-tauri/capabilities/default.json` and justified there or in an ADR (least privilege). The `fs` plugin reaches the archive folder only: its scope is `$APPLOCALDATA/archive` and `$APPLOCALDATA/archive/**` (the folder itself and its content), and it is never granted as `fs:default`.

# `src/adapters` — port implementations

| Folder   | Used by                                                                             | Backed by                                                                    |
| -------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tauri/` | The desktop app                                                                     | Tauri plugins (`@tauri-apps/*`)                                              |
| `dev/`   | Tests and the development modes (`pnpm dev`, and the account of `pnpm dev:desktop`) | Memory, Web Storage, sql.js, synthetic deadlock-api, the development account |

The composition root (`src/main.tsx`) picks one set or the other with `isTauri()`. It reaches the development entry point (`dev/dev-environment.ts`) only in development builds, so release builds contain none of `dev/` ([ADR 0006](../../docs/adr/0006-development-code-out-of-releases.md)).

## Rules

- May import `ports/` and `core/` only (enforced by ESLint).
- Only `tauri/` (and `src/main.tsx`) may import `@tauri-apps/*`.
- `console` is allowed in `dev/` only, where the console is the destination.
- One adapter per file, named `<name>.adapter.ts`, implementing exactly one port.
- Adapters stay thin: they do not wrap failures in `AppError` and do not validate the data they read. The failures of the underlying technology (a full disk, a plugin error…) propagate as they are; the service wraps them in an `AppError` and validates the data against the schema of `core/`. The exceptions are documented on their port: the HTTP client reports its transport failures as `AppError` (only the adapter can tell a timeout from a network failure or an oversized body), and the logger never fails (a line it cannot write is dropped: there is nowhere left to report it). The one tolerance is the Web Storage adapter, which reads stored text it cannot parse as "nothing saved".
- Every plugin permission an adapter needs must be granted in `src-tauri/capabilities/default.json` and justified there or in an ADR (least privilege).

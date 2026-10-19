# `src/ports` — interfaces for side effects

A port is a small TypeScript interface describing one kind of side effect (logging, settings storage, HTTP, database, the account to synchronise, the Steam sign-in, the archive files, compression…). Services depend on ports, never on concrete technologies, so the same service runs with the Tauri adapters in the desktop app and with the development adapters (memory, Web Storage, sql.js, synthetic deadlock-api, a fixture Steam sign-in) in tests and in the browser dev mode.

## Rules

- Interfaces and types only — no implementation, no runtime code.
- May import types from `core/`.
- One port per file, named `<name>.port.ts`.
- Keep ports minimal and technology-agnostic: describe _what_ is needed, not _how_ a library does it.
- Document on the port the errors its adapters may throw when they differ from the default (by default, an adapter lets the failures of the underlying technology propagate as they are: see `src/adapters/README.md`).

## Contents

| File                      | Port                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logger.port.ts`          | Structured logging                                                                                                                                    |
| `settings-store.port.ts`  | Persistence of the settings document                                                                                                                  |
| `http-client.port.ts`     | GET, form POST and binary GET requests (deadlock-api and Steam)                                                                                       |
| `database.port.ts`        | SQL statements on the app database                                                                                                                    |
| `account-source.port.ts`  | The linked account's id; implemented by `services/linked-account.repository.ts`                                                                       |
| `sign-in-gateway.port.ts` | The loopback listener of the Steam sign-in (start, callback URL, cancel) and the system browser                                                       |
| `archive-store.port.ts`   | The archive files of the match details: atomic write, read, cleanup of leftovers, per-account quarantine, listing and removal of the folder's entries |
| `compressor.port.ts`      | zstd compression and decompression of the archive files (bytes in, bytes out)                                                                         |

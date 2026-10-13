# `src/ports` — interfaces for side effects

A port is a small TypeScript interface describing one kind of side effect (logging, settings storage, and later HTTP, database, files…). Services depend on ports, never on concrete technologies, so the same service runs with the Tauri adapters in the desktop app and with the development adapters (memory, Web Storage) in tests and in the browser dev mode.

## Rules

- Interfaces and types only — no implementation, no runtime code.
- May import types from `core/`.
- One port per file, named `<name>.port.ts`.
- Keep ports minimal and technology-agnostic: describe _what_ is needed, not _how_ a library does it.

## Contents

| File                     | Port                                 |
| ------------------------ | ------------------------------------ |
| `logger.port.ts`         | Structured logging                   |
| `settings-store.port.ts` | Persistence of the settings document |

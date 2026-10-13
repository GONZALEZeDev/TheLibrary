# `src/adapters` — port implementations

| Folder   | Used by                                     | Backed by                       |
| -------- | ------------------------------------------- | ------------------------------- |
| `tauri/` | The desktop app                             | Tauri plugins (`@tauri-apps/*`) |
| `dev/`   | Tests and the browser dev mode (`pnpm dev`) | Memory, Web Storage             |

The composition root (`src/main.tsx`) picks one set or the other with `isTauri()`.

## Rules

- May import `ports/` and `core/` only (enforced by ESLint).
- Only `tauri/` (and `src/main.tsx`) may import `@tauri-apps/*`.
- `console` is allowed in `dev/` only, where the console is the destination.
- One adapter per file, named `<name>.adapter.ts`, implementing exactly one port.
- Adapters stay thin: they do not wrap failures in `AppError` and do not validate the data they read. The failures of the underlying technology (a full disk, a plugin error…) propagate as they are; the service wraps them in an `AppError` and validates the data against the schema of `core/`. The one tolerance is the Web Storage adapter, which reads stored text it cannot parse as "nothing saved".
- Every plugin permission an adapter needs must be granted in `src-tauri/capabilities/default.json` and justified there or in an ADR (least privilege).

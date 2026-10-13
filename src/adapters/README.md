# `src/adapters` — port implementations

| Folder   | Used by                                     | Backed by                       |
| -------- | ------------------------------------------- | ------------------------------- |
| `tauri/` | The desktop app                             | Tauri plugins (`@tauri-apps/*`) |
| `dev/`   | Tests and the browser dev mode (`pnpm dev`) | Memory, Web Storage, fixtures   |

The composition root (`src/main.tsx`) picks one set or the other with `isTauri()`.

## Rules

- May import `ports/` and `core/` only (enforced by ESLint).
- Only `tauri/` (and `src/main.tsx`) may import `@tauri-apps/*`.
- `console` is allowed in `dev/` only, where the console is the destination.
- One adapter per file, named `<name>.adapter.ts`, implementing exactly one port.
- Every plugin permission an adapter needs must be granted in `src-tauri/capabilities/default.json` and justified there or in an ADR (least privilege).

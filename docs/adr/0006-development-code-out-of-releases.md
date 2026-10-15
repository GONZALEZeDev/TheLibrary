# ADR 0006 — Development-only code never reaches release builds

- **Status:** Accepted
- **Date:** 2026-10-14
- **Implementation:** milestone M2a.

## Context

Until the Steam sign-in exists (milestone M3), a developer needs another way to synchronise their own account against the real deadlock-api. The browser dev mode also needs synthetic match data and an in-memory SQLite database. None of this may reach the app users install: ADR 0005 rules out choosing an arbitrary account in TheLibrary, and release builds must stay small and predictable.

## Decision

- The developer's account id lives in `.env.development.local` (`VITE_DEV_ACCOUNT_ID`), a git-ignored file. Vite reads `.env.development.*` files in development mode only: a production build never sees it.
- Every development-only module — `src/adapters/dev/dev-environment.ts` and everything it imports (synthetic fixtures, sql.js, the development account), and the TanStack devtools (`src/ui/app/DevTools.tsx`) — is reached only through a dynamic `import()` guarded by `import.meta.env.DEV` in `src/main.tsx`. Vite replaces that flag with `false` in production builds and leaves those modules out.
- `pnpm check:dev-code` proves it, in CI on every push to `main` and every pull request, and before `tauri build` bundles the app (`beforeBuildCommand`): the check fails if the production build contains a development marker, and also fails if a development build lacks them, so that it can never pass without proving anything.
- The desktop app runs in development under its own identifier (`pnpm dev:desktop`, `src-tauri/tauri.dev.conf.json`): its settings, database and logs live in separate folders and never mix with an installed release.
- The fixtures are synthetic: the repository contains no real player's match history.

## Consequences

- Release builds cannot synchronise any account until the Steam sign-in exists: they show "no account linked".
- Contributors put their own account id in their local `.env.development.local` to test against the real API; the browser dev mode needs nothing.
- The development code is public like the rest of the project; the rule of ADR 0005 is about the app users run.

## Alternatives considered

- **A hidden setting in the interface** — it would ship in releases. Rejected.
- **Recorded real histories as fixtures** — would publish the matches of a real person. Rejected.
- **The same identifier for development and releases** — the SQL plugin refuses to open a database whose applied migration changed: a migration edited during development could break the installed app on the same computer. Rejected.

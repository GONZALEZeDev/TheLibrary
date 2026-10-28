# ADR 0006 — Development-only code never reaches release builds

- **Status:** Accepted
- **Date:** 2026-10-14
- **Implementation:** milestone M2a; the Steam sign-in replaced the development account in milestone M3.

## Context

A developer needs to try the app against the real deadlock-api, and the browser dev mode needs synthetic match data and an in-memory SQLite database. None of this may reach the app users install: ADR 0005 rules out choosing an arbitrary account in TheLibrary, so no development shortcut to an account may ship, and release builds must stay small and predictable.

Until milestone M3 the Steam sign-in did not exist, so the account of a developer came from a git-ignored local environment file. That mechanism is gone: the sign-in is the only way to link an account.

## Decision

- Desktop development signs in through Steam like any user. `pnpm dev:desktop` runs the real sign-in: the system browser opens Steam's real login page, and the account that signs in is linked. No account id is configured in a file, an environment variable or the source.
- The browser dev mode (`pnpm dev`) has no Steam, so a fixture sign-in gateway answers as Steam would, after a short delay, with the callback of a synthetic account. The sign-in flow checks that answer and links the account like any other: only the loopback listener, the browser and Steam's server are imitated.
- Every development-only module — `src/adapters/dev/dev-environment.ts` and everything it imports (synthetic fixtures, sql.js, the fixture sign-in gateway), and the TanStack devtools (`src/ui/app/DevTools.tsx`) — is reached only through a dynamic `import()` guarded by `import.meta.env.DEV` in `src/main.tsx`. Vite replaces that flag with `false` in production builds and leaves those modules out.
- `pnpm check:dev-code` proves it, in CI on every push to `main` and every pull request, and before `tauri build` bundles the app (`beforeBuildCommand`): the check looks for texts that only development code contains: the marker `thelibrary-dev-only`, which the two entry points of the development code write in a log line (`src/adapters/dev/dev-environment.ts` and `src/ui/app/DevTools.tsx`), and, since the release (milestone M6), a few texts of the modules they import (the persona of the synthetic account, the class prefix and the component name of the TanStack devtools, the WebAssembly file of sql.js), so that a development module still gets caught if one of them disappears. It fails if the production build contains one of them, and also fails if a development build lacks one, so that it can never pass without proving anything.
- The desktop app runs in development under its own identifier (`pnpm dev:desktop`, `src-tauri/tauri.dev.conf.json`): its settings, database and logs live in separate folders and never mix with an installed release.
- The fixtures are synthetic: the repository contains no real player's match history.

## Consequences

- Release builds link an account through Steam, exactly as in development: they start with no account linked and invite the player to sign in, and they contain no other way to choose one.
- Contributors sign in with their own Steam account in `pnpm dev:desktop` to test against the real API; the browser dev mode needs nothing and links the synthetic account.
- The development code is public like the rest of the project; the rule of ADR 0005 is about the app users run.

## Alternatives considered

- **A hidden setting in the interface** — it would ship in releases. Rejected.
- **An account id in a local environment file** (the mechanism of milestone M2a) — it linked an account that was never signed in to Steam, a way round ADR 0005 that had to be kept out of every release build. Replaced by the Steam sign-in.
- **Recorded real histories as fixtures** — would publish the matches of a real person. Rejected.
- **The same identifier for development and releases** — the SQL plugin refuses to open a database whose applied migration changed: a migration edited during development could break the installed app on the same computer. Rejected.

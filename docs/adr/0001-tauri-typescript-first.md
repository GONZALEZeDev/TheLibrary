# ADR 0001 — Tauri 2, "TypeScript-first"

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** in place since milestone M1 (shell, layers, log and store plugins); the HTTP, SQLite and file plugins arrive with M2, the updater with M6.

## Context

TheLibrary is a public, open-source desktop app, maintained by one TypeScript/React developer, that runs next to a demanding game. It must be light, secure by default and easy to maintain.

## Decision

Use **Tauri 2** with all application logic in **TypeScript** running in the webview. The Rust side is limited to plugin registration, the navigation guard, window behaviour and, from M2 on, the SQL migration list. Official Tauri plugins provide the native capabilities (HTTP, SQLite, files, store, logs, updater…); a community plugin is an exception, justified in the ADR that needs it. The domain logic (`src/core`) and the use cases (`src/services`) are independent of Tauri and only reach native features through ports and adapters.

## Consequences

- A small installer (Tauri apps typically weigh a few MB) and a webview (WebView2) patched by Microsoft, not by us.
- Capability-based security: the webview only gets the plugin commands and scopes it is granted.
- Little Rust to maintain (plugin wiring, navigation guard, window behaviour), but every contributor and every CI run needs the Rust toolchain to build the desktop app.
- Plugin limitations must be designed around (e.g. no SQL transaction spanning several calls).
- Switching to another shell (e.g. Electron) would replace the adapters and the shell configuration (capabilities, CSP, navigation guard), not the domain logic or the use cases.

## Alternatives considered

- **Electron** — TypeScript everywhere and the most mature ecosystem, but a much larger installer, more memory next to the game, and Chromium security updates that only reach users when we ship a new version.
- **Rust core or native .NET app** — efficient, but outside the TypeScript skills of the maintainer, which would slow every change.

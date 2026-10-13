# `src/core` — domain model and pure logic

Everything here is **pure TypeScript**: no React, no Tauri, no network, no storage, no clock, no randomness. Functions take data and return data, which makes them trivial to test and safe to run anywhere (UI thread, Web Worker, tests).

## Rules

- May import other `core/` modules and `zod` only (enforced by ESLint).
- Side effects belong to `ports/` (interfaces) and `adapters/` (implementations).
- Throw `AppError` (`errors/app-error.ts`) with the right `kind` for expected failures.
- Every exported symbol has TSDoc; every non-obvious rule links to its source (ADR, API documentation).

## Contents

| Folder      | Purpose                                                |
| ----------- | ------------------------------------------------------ |
| `domain/`   | Shared domain types and constants (periods, hero ids…) |
| `errors/`   | `AppError` and its kinds                               |
| `settings/` | Supported languages and the settings document          |

Later milestones add `deadlock-api/`, `steam/`, `archive/`, `sync/` and `analysis/`.

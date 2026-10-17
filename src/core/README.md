# `src/core` — domain model and pure logic

Everything here is **pure TypeScript**: no React, no Tauri, no network, no storage, no clock, no randomness. Functions take data and return data, which makes them trivial to test and safe to run anywhere (UI thread, Web Worker, tests).

## Rules

- May import other `core/` modules and `zod` only (enforced by ESLint).
- Side effects belong to `ports/` (interfaces) and `adapters/` (implementations).
- Throw `AppError` (`errors/app-error.ts`) with the right `kind` for expected failures.
- Every exported symbol has TSDoc; every non-obvious rule links to its source (ADR, API documentation).

## Contents

| Folder          | Purpose                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`       | Shared domain types and constants (account and match ids, match summaries, heroes, periods…)                                                                                    |
| `errors/`       | `AppError` and its kinds                                                                                                                                                        |
| `settings/`     | Supported languages and the settings document                                                                                                                                   |
| `deadlock-api/` | Endpoints, request rules and budgets, response interpretation, schemas and mappers of the API                                                                                   |
| `rate-limit/`   | Sliding-window rate limits                                                                                                                                                      |
| `sync/`         | State of the synchronisation, as saved and shown                                                                                                                                |
| `match-detail/` | The match detail archive: which matches are archived, the statuses and retry schedule, the pruning to the tracked player, the envelope, the facts read back, the archive layout |
| `compression/`  | The zstd level and the messages exchanged with the zstd worker                                                                                                                  |

Later milestones add `steam/` and `analysis/`.

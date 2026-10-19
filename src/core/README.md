# `src/core` — domain model and pure logic

Everything here is **pure TypeScript**: no React, no Tauri, no network, no storage, no clock, no randomness. Functions take data and return data, which makes them trivial to test and safe to run anywhere (UI thread, Web Worker, tests).

## Rules

- May import other `core/` modules and `zod` only (enforced by ESLint).
- Side effects belong to `ports/` (interfaces) and `adapters/` (implementations).
- Throw `AppError` (`errors/app-error.ts`) with the right `kind` for expected failures.
- Every exported symbol has TSDoc; every non-obvious rule links to its source (ADR, API documentation).

## Contents

| Folder          | Purpose                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`       | Shared domain types and constants (account and match ids, match summaries, heroes, periods and the numbers of a period…)                                                           |
| `errors/`       | `AppError` and its kinds                                                                                                                                                           |
| `settings/`     | Supported languages and the settings document                                                                                                                                      |
| `account/`      | The linked account and the rules of its profile: persona name, avatar (hash, URL, size, base64) and when the profile is due for a refresh                                          |
| `steam/`        | The Steam sign-in: SteamID64 to account id conversion, the OpenID request, the checks of the callback and of Steam's confirmation, the page shown once Steam sends the player back |
| `deadlock-api/` | Endpoints, request rules and budgets, response interpretation, schemas and mappers of the API (match history, match details, heroes, Steam profiles)                               |
| `rate-limit/`   | Sliding-window rate limits                                                                                                                                                         |
| `sync/`         | State of the synchronisation, as saved and shown                                                                                                                                   |
| `match-detail/` | The match detail archive: which matches are archived, the statuses and retry schedule, the pruning to the tracked player, the envelope, the facts read back, the archive layout    |
| `compression/`  | The zstd level and the messages exchanged with the zstd worker                                                                                                                     |

Later milestones add `analysis/`.

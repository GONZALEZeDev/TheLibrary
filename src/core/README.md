# `src/core` — domain model and pure logic

Everything here is **pure TypeScript**: no React, no Tauri, no network, no storage, no clock, no randomness. Functions take data and return data, which makes them trivial to test and safe to run anywhere (UI thread, Web Worker, tests).

## Rules

- May import other `core/` modules and `zod` only (enforced by ESLint).
- Side effects belong to `ports/` (interfaces) and `adapters/` (implementations).
- Throw `AppError` (`errors/app-error.ts`) with the right `kind` for expected failures.
- Every exported symbol has TSDoc; every non-obvious rule links to its source (ADR, API documentation).

## Contents

| Folder          | Purpose                                                                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`       | Shared domain types and constants (account and match ids, match summaries, heroes, periods and the numbers of a period…)                                                                                                                           |
| `errors/`       | `AppError` and its kinds                                                                                                                                                                                                                           |
| `settings/`     | Supported languages and the settings document                                                                                                                                                                                                      |
| `account/`      | The linked account and the rules of its profile: persona name, avatar (hash, URL, size, base64) and when the profile is due for a refresh                                                                                                          |
| `steam/`        | The Steam sign-in: SteamID64 to account id conversion, the OpenID request, the checks of the callback and of Steam's confirmation, the page shown once Steam sends the player back                                                                 |
| `deadlock-api/` | Endpoints, request rules and budgets, response interpretation, schemas and mappers of the API (match history, match details, heroes, Steam profiles, and the community data: metric percentiles, performance curve, hero sample size, player rank) |
| `rate-limit/`   | Sliding-window rate limits                                                                                                                                                                                                                         |
| `sync/`         | State of the synchronisation, as saved and shown                                                                                                                                                                                                   |
| `match-detail/` | The match detail archive: which matches are archived, the statuses and retry schedule, the pruning to the tracked player, the envelope, the facts read back, the archive layout                                                                    |
| `compression/`  | The zstd level and the messages exchanged with the zstd worker                                                                                                                                                                                     |
| `analysis/`     | The match analysis: the match context, the phases and rank cohorts, the metrics (`metrics/`) and their registry, statistics, the comparisons with the habits and the curve, the strengths and weaknesses (`insights/`) and their thresholds        |

## Adding a metric

A metric is one number computed for every archived match, at the end of each synchronisation (or, as a fallback, when the page of a match not analysed yet is opened), and compared with the community and with the player's habits ([ADR 0004](../../docs/adr/0004-analysis-references.md)). To add a metric of the whole match:

1. Add its key to `MatchMetricKey` in `analysis/metric.ts`. If it is compared with a community percentile benchmark the app does not read yet, add that benchmark to `BenchmarkKey` and to `BENCHMARK_KEYS` (`deadlock-api/metric-benchmark.schema.ts`) too, and its percentiles to the development fixture of the API's answer (`src/adapters/dev/fixtures/analytics.fixture.ts`).
2. Write `analysis/metrics/<key>.metric.ts`, which exports a `MetricDefinition` (family, unit, which direction is better, group, display, how the habits are compared, the community source and `compute`), with its test `<key>.metric.test.ts` beside it. A metric returns `null` when the archive does not hold what it needs, never `0`. If it reads a field of the archive that the match context does not read yet, add the field to `analysis/match-context.ts` and to the synthetic match detail of the development fixture (`src/adapters/dev/fixtures/match-metadata.fixture.ts`), so that the development app and the tests have a value for it.
3. Add it to `MATCH_METRICS` in `analysis/registry.ts`, in the place of its family, and to the list of keys in `registry.test.ts`. A few tests pin the number of metrics and of stored values on purpose, so that a metric is never added by mistake: update the counts in `registry.test.ts`, `VALUE_COUNT` in `src/services/projection.service.test.ts` and the number of rows in `src/services/analysis.service.test.ts`.
4. Add its name under `analysis.metric.<key>` in both catalogues (`src/ui/i18n/locales/{en,fr}/common.json`). The match page lists the metrics of the registry by family, and its tests take their counts from the registry.
5. Bump `PROJECTION_VERSION` in `analysis/registry.ts`: the matches stored with the old version are projected again from their archives at the next synchronisation, with no network access.

Do not bump it for a change that leaves the projected values as they are (a text, the layout of the page). The metrics of a phase are a different case: `analysis/metrics/phase.metric.ts` builds all eleven from one table, the registry takes them from there, and the phase table names them. The thresholds that decide what counts as a strength or a weakness are in `analysis/insights/thresholds.ts`.

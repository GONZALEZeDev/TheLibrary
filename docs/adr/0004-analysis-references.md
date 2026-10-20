# ADR 0004 — Two references for strengths and weaknesses

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** milestone M4a (the match page).

## Context

TheLibrary must tell the player, for each match, what went well and what to work on. A value alone ("612 souls per minute") means nothing without a reference.

## Decision

Compare every metric with **two references**:

1. **Community** — percentiles (p1–p99) of Paige players in the user's rank bracket over the last 30 days, from `GET /v1/analytics/player-stats/metrics`, restricted to a **5-minute match-duration bucket** (many metrics are per-match totals: the median teammate healing of Paige players doubles between 25–30 and 40–45-minute matches).
2. **Personal** — the median of the 20 previous Paige matches, with the median absolute deviation (MAD) as spread.

Both signals are oriented so that higher means better, combined into a score (60% community, 40% personal), and the top 3 strengths and weaknesses are shown with their evidence and a confidence level. Insights are computed on the fly, never stored.

## As implemented (M4a)

The decision stands. The match page of milestone M4a settled the points it left open:

- **The cohort:** a ranked match is compared with the tier of the badge the player had in it, any other match with the tier of their current rank (refreshed once a day), and a player with neither with every rank. The community is the whole tier, filtered on the match average badge (`tier × 10 + 1` to `tier × 10 + 6`), which only ranked matches have; the other filters are the hero, the normal mode, the last 30 days and the duration window of the match (under 20 minutes, five minutes wide from 20 to 45 minutes, then 45 minutes and longer). A cohort needs at least 200 Paige matches (`MIN_COHORT_MATCHES`): a tier with fewer gives way to every rank in the same duration window, and when that is too small as well the match has no community comparison, which the page says. The data of a cohort is kept 24 hours, entries older than 7 days are purged, and an expired copy is still used when the app is offline.
- **The phases:** 0:00–10:00, 10:00–25:00 and 25:00 to the end, each with the souls, the damage to heroes, the damage to objectives and the kills of the player and their share of the team (shown, not scored); a phase under 3 minutes is shown but not scored. The performance curve gives the average and the spread of a counter at each time of the match, not percentiles, so a phase is compared with the community's rate over the same span on both sides: from the start of the phase to its end or to the last curve point that every match of the duration window reaches, whichever comes first. The spread of a gain is `√(σ_end² − σ_start²)` (a gain is taken as independent of where the player started) and the percentile is `100 × Φ(z)`, with `z` the distance of the player's rate to the community's in spreads. That percentile is a known approximation for skewed counters (kills, damage to objectives): `z` is the more faithful figure, and the page words the distance from it (well above, above, around, below, well below).
- **The habits:** the 20 most recent earlier matches that have a value, and at least 5 of them, else there is no personal comparison. The totals that grow with the length of a match (deaths, last hits, denies, healing, barriers) are compared per minute and shown back as totals, so that a long match does not stand out from the habits only by being long.
- **The score:** the community signal is `(p − 50) / 50` and the personal one `z / 2` limited to −1 and 1, both turned so that higher is better. The score is 60% of the first and 40% of the second; a lone signal is the score as it is, unweighted, so that the first matches of a history, and the lane difference at 10:00 (which has no community reference), are not undersold. A strength is in the best 30% of its cohort or one robust deviation above the habits, with a score above 0; a weakness is the mirror. The summary keeps at most three of each, and only one per group: metrics that say the same thing (souls per minute, souls at 10:00 and the souls of a phase) share a group, and only the strongest of them shows.
- **The confidence:** three levels. Low for a match under 15 minutes or with a leaver, medium when one of the two references is missing, high otherwise.
- **When a match is analysed:** every archived match is analysed at the end of each synchronisation. After the detail queue, the run projects every archived match that has no projection of the current `PROJECTION_VERSION`, the most recent first, so the matches are analysed before their page is opened. A run that ends early (the network is down, the account is protected) projects too: the projection works from the archives on disk, so it needs no network and no request budget. A page that opens a match still not analysed (before the end of the run that archived it, or after a new version and before the next run) analyses it as a fallback, while a dialog says that the analysis is under way: it projects the match and the 20 archived matches before it that have no projection (the habits are made of them), then shows the analysis. The 20 leave out the matches the analysis could not read, so opening the page again finds nothing left to project, and a match first projected as one of the 20 of another page has its own 20 completed the first time its page is opened, the same way. The habits keep their rule over what is projected: a metric that is often unknown (the late phase of a short match, the lane) may have fewer values than the habits need, and then has no personal comparison. The projections run one at a time, whoever asks (the synchronisation or a page), so two never write the same match at once. The analysis of a page runs in the exclusive section of the synchronisation: an account change waits for it, and a new analysis is refused while the account changes, so an analysis never writes for an account that is being erased or switched.
- **What is stored:** the insights are computed when the page opens. Only the values of the metrics are stored, once per archived match (see [ADR 0003](0003-user-centric-archive-zstd.md)): a match already projected with the current `PROJECTION_VERSION` is not projected again. When that version is bumped, each match is projected again from its archive, with no network access, the same way: at the end of the next synchronisation (a page opened before it analyses its own match, as the fallback above).
- **Critical shots:** a critical-shot rate was considered and dropped. Paige almost never lands a critical shot (the community's third quartile is 0), so the metric could only add noise, and the API's definition of the rate differs from the app's own formula, so the two could not be compared like for like.

## Consequences

- Objective standing _and_ personal progression, with explainable evidence.
- The community data is cached for 24 hours per wanted cohort (rank tier and duration window): three analytics requests when a cohort is not cached yet or is a day old (four when a small tier falls back to every rank), none otherwise.
- Thresholds and weights live in one file, `src/core/analysis/insights/thresholds.ts`, and can be tuned without touching the rules.

## Alternatives considered

- **Community only** — objective, but hides progress.
- **Personal only** — no analytics calls, but no idea of where the player stands.

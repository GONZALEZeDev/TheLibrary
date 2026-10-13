# ADR 0004 — Two references for strengths and weaknesses

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** milestone M4 (not started).

## Context

TheLibrary must tell the player, for each match, what went well and what to work on. A value alone ("612 souls per minute") means nothing without a reference.

## Decision

Compare every metric with **two references**:

1. **Community** — percentiles (p1–p99) of Paige players in the user's rank bracket over the last 30 days, from `GET /v1/analytics/player-stats/metrics`, restricted to a **5-minute match-duration bucket** (many metrics are per-match totals: the median teammate healing of Paige players doubles between 25–30 and 40–45-minute matches).
2. **Personal** — the median of the 20 previous Paige matches, with the median absolute deviation (MAD) as spread.

Both signals are oriented so that higher means better, combined into a score (60% community, 40% personal), and the top 3 strengths and weaknesses are shown with their evidence and a confidence level. Insights are computed on the fly, never stored.

## Consequences

- Objective standing _and_ personal progression, with explainable evidence.
- Benchmarks are cached for 24 hours per (rank bracket, duration bucket): a handful of analytics calls per day.
- Thresholds and weights live in one file and can be tuned without touching the rules.

## Alternatives considered

- **Community only** — objective, but hides progress.
- **Personal only** — no analytics calls, but no idea of where the player stands.

# ADR 0002 — deadlock-api.com as the data source

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** milestone M2a (match history); match detail in M2b.

## Context

Valve provides no public API for Deadlock match data (verified 2026-09-29: the only Steam Web API interface for app 1422450 exposes client/server versions). The only other paths are the game coordinator protocol and replay files, which are impractical for a TypeScript desktop app.

## Decision

Use the community-run **deadlock-api.com** (MIT): match history, full match metadata (per-player stat snapshots, items, deaths, per-second positions, per-ability damage), player rank, community benchmarks (percentiles by hero, rank and match duration) and static assets. Each installation calls the API directly from the user's IP address, within the per-IP rate limits, with a conservative client-side rate limiter and a `User-Agent` that carries only the app name, its version and the repository URL (no per-installation identifier).

## Consequences

- No backend and no API key to operate or protect.
- deadlock-api.com sees the IP address of each user and the `account_id` they track, as for any client of the service; TheLibrary itself sends no telemetry.
- The app depends on an unofficial service without SLA: responses are validated (Zod), matches are archived locally (ADR 0003), and a weekly CI canary (`pnpm canary`, every Monday) runs a fresh Paige match detail through the app's schemas, pruning and archive.
- History is complete and fresh only when the player's Steam account is friends with a deadlock-api bot, which requires a deadlock-api Patreon membership (verified 2026-10-14). Each history response says whether it was refreshed from Steam (`Called-Steam` header), and the app shows when the history may be incomplete.
- Players who opted out of deadlock-api (data-privacy feature) get no data; the app will say so.

## Alternatives considered

- **Replay (.dem) parsing** — richer data, but replays expire after about a month, weigh 270–410 MB, often lack download salts, and no TypeScript parser exists.
- **Game coordinator access through a Steam client library** — requires handling the user's Steam credentials and conflicts with their game session. Rejected.

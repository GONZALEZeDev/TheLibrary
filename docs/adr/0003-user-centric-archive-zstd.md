# ADR 0003 — User-centric match archive compressed with zstd

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** milestone M2 (not started).

## Context

A full match metadata payload weighs about 1.07 MB of JSON (average of 10 Paige matches of 34.5 minutes, measured 2026-09-29): per-second positions of the 12 players (403 KB), stat snapshots (326 KB) and the per-ability damage matrix (224 KB) dominate. The app must keep as many Paige matches as possible for deep analysis without filling the user's disk, and must be able to recompute metrics later without re-downloading.

## Decision

- Keep the archive as the **source of truth** for match detail, and SQLite only for data compared across matches (metrics, history, sync state).
- Before archiving, apply a **user-centric pruning**: keep everything about the tracked player; for the 11 others keep final stats, stat snapshots, items and deaths; drop their per-second positions and the damage-matrix entries that do not involve the tracked player (1,070 KB → 516 KB).
- Compress with **zstd level 19** in a Web Worker: 516 KB → **48 KB** on average; about 0.3 s once per match, about 2 ms to read back.

## Consequences

- About 50 MB per 1,000 Paige matches (about 48 MB of archive plus the database) instead of about 1 GB raw.
- Metrics can be recomputed from the archive (projection versioning), with no network access, for every match whose archive is still on disk.
- Features needing every player's positions re-download the full payload on demand.
- A configurable storage cap (500 MB by default) deletes the oldest archives first; their metrics stay, but can no longer be recomputed.

## Alternatives considered

- **gzip (native CompressionStream)** — no dependency, but 40% larger files.
- **brotli level 11** — 7% smaller than zstd-19, for 4–5× more CPU time.
- **Keeping full payloads** — 166 KB per match with zstd-19, 3.5× more disk for data the analysis does not need.

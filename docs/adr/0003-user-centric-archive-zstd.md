# ADR 0003 — User-centric match archive compressed with zstd

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** milestone M2b.

## Context

A full match metadata payload weighs about 1.07 MB of JSON (average of 10 Paige matches of 34.5 minutes, measured 2026-09-29): per-second positions of the 12 players (403 KB), stat snapshots (326 KB) and the per-ability damage matrix (224 KB) dominate. The app must keep as many Paige matches as possible for deep analysis without filling the user's disk, and must be able to recompute metrics later without re-downloading.

## Decision

- Keep the archive as the **source of truth** for match detail, and SQLite only for data compared across matches (metrics, history, sync state).
- Archive only the **normal-mode Paige matches of the last 90 days**: hero Paige, `game_mode` 1 (Street Brawl is 4), `match_mode` 1 (unranked) or 4 (ranked) (a private lobby is 2).
- Before archiving, apply a **user-centric pruning** that drops only two things: the per-second paths of the 11 other players, and the damage-matrix entries that involve the tracked player neither as dealer nor as target. Everything else, the final stats, stat snapshots, items and deaths of every player included, stays exactly as the API sent it (1,070 KB → 516 KB).
- Compress with **zstd level 19**: 516 KB → about **48 KB** on average (the 2026-09 estimate, from the sample above; the size measured on real archives is under Consequences); about 0.3 s once per match, about 2 ms to read back. The library is `@hpcc-js/wasm-zstd` 1.16.2: zstd compiled to WebAssembly, because the WebView has no native zstd. It runs in a module Web Worker, so the window never freezes, and the Content-Security-Policy allows it with `'wasm-unsafe-eval'`.
- Write one file per match, `%LOCALAPPDATA%\<identifier>\archive\<accountId>\<matchId>.json.zst`. It holds an envelope, `{ archiveFormat, prunedForAccountId, fetchedAt, payload }`, as UTF-8 JSON, compressed. The file is written to a `.tmp` file, then renamed, so a crash never leaves a half-written archive under its final name.

## The detail queue

After each synchronisation of the history, a queue downloads the detail of every eligible match and records where each one stands:

- **Statuses:** `pending` (never fetched), `retry` (an attempt failed for a reason that may go away), `ready` (archived), `unavailable` (the queue gave up) and `invalid` (the API answered with a detail the app cannot use).
- **Retries:** after the 1st to the 5th counted failure, the match waits 5 min, 30 min, 2 h, 12 h, then 24 h, each delay varied by ±10 % so that details that failed together do not all come back together. The 6th counted failure makes the match `unavailable`.
- **Invalid is final:** the API would give the same answer again, so the match stays `invalid` until the user clicks Retry (which also puts an `unavailable` match back in the queue).
- **Quarantine:** a response that could not be used (an `invalid` match whose body was received, or a body that is not JSON) is kept, compressed, for a look under `archive/<accountId>/quarantine/`, in the folder of the account it was fetched for: only the 20 most recent of each account stay. The app never reads it back. Unlinking an account deletes its folder, the quarantine included.
- **What counts:** only an answer of deadlock-api about the match counts as an attempt. A network failure, a timeout, a pause asked by the API and a local failure (disk, database, compressor) count none: the run stops, and the match is tried again at the next run. A success status whose body is not JSON (the page of a proxy, say) counts one retryable attempt, is quarantined and stops the run too, since every other match would get the same page.
- **Facts check:** before compressing, the queue reads back from the pruned detail the facts the match page shows (result, duration, kills, deaths, assists, souls, snapshots, items). A detail that would not yield them is refused as `invalid`, so a `ready` match always has facts to show.

## Consequences

- **2026-09 estimate:** about 50 MB per 1,000 Paige matches (about 48 MB of archive plus the database) instead of about 1 GB raw.
- **Measured size:** 55 KB per match on average (116 real Paige matches of one account, 6.4 MB in all, measured 2026-10-17), so about 55 MB of archive per 1,000 matches. The 48 KB estimate came from a sample of 10 matches of 34.5 minutes on average; what makes real archives larger has not been measured yet.
- Metrics can be recomputed from the archive (projection versioning), with no network access, for every match whose archive is still on disk.
- The metrics of an archived match are projected into the `match_projections` and `match_metrics` tables at the end of each synchronisation, which projects every archived match that has none, and projected again from the archive, the same way, at the next synchronisation when `PROJECTION_VERSION` changes. A match page opened before its match is projected projects it itself, as a fallback ([ADR 0004](0004-analysis-references.md)).
- A deleted or damaged archive (a file that is gone, or whose content cannot be decompressed or read) is not an error: the match goes back to `pending` when it is projected (at the end of a synchronisation) or when its page is opened, and the next synchronisation downloads it again if the match is still within the 90-day window (an older one keeps no archive, and its page says the archive is gone). A file that cannot be read (locked, denied) or a broken compressor (its worker crashed, or its codec could not be loaded, say because the WebAssembly was refused) says nothing about the archive: it is an error for the page, the projection skips the match and tries it again at the next run, and the match stays archived. Only a codec that ran and failed on the bytes counts as a damaged archive.
- Features needing every player's positions re-download the full payload on demand (not built yet).
- A configurable storage cap (500 MB by default) deletes the oldest archives first; their metrics stay, but can no longer be recomputed (not built yet).

## Alternatives considered

- **gzip (native CompressionStream)** — no dependency, but 40% larger files.
- **brotli level 11** — 7% smaller than zstd-19, for 4–5× more CPU time.
- **Keeping full payloads** — 166 KB per match with zstd-19, 3.5× more disk for data the analysis does not need.

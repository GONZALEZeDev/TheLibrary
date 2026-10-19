# `src/services` — use cases

A service implements the use cases of one area (settings, synchronisation, matches, hero names, the match detail archive and the linked Steam account today; analysis in a later milestone). It orchestrates the pure logic of `core/` and the side effects behind `ports/`.

## Rules

- May import `core/`, `ports/` and other services (enforced by ESLint) — never an adapter: adapters are injected through the constructor.
- Validate everything read from a port before returning it: domain data with the schemas of `core/`, stored rows and cached payloads with the schema declared next to the code that reads them.
- Wrap failures of ports in `AppError` with the right `kind`; log meaningful events through the `Logger` port.
- One service per file, named `<name>.service.ts`, tested with the `adapters/dev` implementations.
- A repository, `<name>.repository.ts`, holds the SQL of one table (or, for `database-maintenance.repository.ts`, of the database file itself): both databases run it, it validates the rows it reads and wraps database failures in `AppError` of kind `storage`.
- `app-services.ts` lists the services exposed to the UI; `create-app-services.ts` builds them from the adapters, for the composition root and the tests alike. The UI reaches the Steam account through `AccountService` only: the sign-in, profile and data services are its parts and are not exposed.

## Contents

| File                                                     | Purpose                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.service.ts`                                    | Read and change the settings                                                                                                                                   |
| `deadlock-api.service.ts`                                | Requests to deadlock-api with its politeness rules (User-Agent, timeout, size limit, budgets, pauses), answered as validated domain objects                    |
| `hero-catalog.service.ts`                                | The English hero names, refreshed weekly and kept in the database                                                                                              |
| `sync.service.ts`                                        | Synchronisation of the match history, then of the details; on a timer or on demand, and suspended while the account changes                                    |
| `matches.service.ts`, `matches.repository.ts`            | The matches of the linked account (the `matches` table): the recent ones, and the numbers of a period                                                          |
| `match-detail.service.ts`                                | The detail queue (download, prune, archive, record) and what the match page reads of it                                                                        |
| `match-detail.repository.ts`, `match-detail-verdicts.ts` | The detail status of the matches and the pure verdicts of an attempt                                                                                           |
| `sync-state.repository.ts`                               | Small values that survive a restart (`sync_state` table): request times, pause, per-account state, the compaction owed                                         |
| `api-cache.repository.ts`                                | Slow-changing API responses (`api_cache` table)                                                                                                                |
| `account.service.ts`                                     | The linked Steam account: link, switch, unlink, the cleanup at startup (with the synchronisation suspended, then started) and the daily refresh of the profile |
| `steam-sign-in.service.ts`                               | One Steam OpenID sign-in: loopback listener, system browser, checks of the callback and Steam's own confirmation; settles once, never rejects                  |
| `steam-profile.service.ts`                               | The persona name (deadlock-api) and the avatar (Steam's avatar host) of the account; never fails the caller                                                    |
| `account-data.service.ts`                                | Erasure of the local data of an account, and the sweep at startup of what belongs to no linked account; ends with a compaction                                 |
| `linked-account.repository.ts`                           | The linked account (`linked_account` table); implements the `AccountSource` port                                                                               |
| `database-maintenance.repository.ts`                     | Compaction of the database file (`VACUUM`, then a checkpoint of the write-ahead log)                                                                           |

# ADR 0005 — Mandatory Steam sign-in (OpenID) to link an account

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** milestone M3.

## Context

TheLibrary tracks one player's matches. Only the owner of a Steam account should be able to link it in the app, and the app must never handle Steam credentials.

## Decision

Link the account with **Steam's official OpenID 2.0 sign-in**, opened in the **system browser**: Steam handles the password and Steam Guard on its own page, then redirects to a one-shot loopback listener on `127.0.0.1` (random port). The app closes the listener after the first callback, or after 5 minutes without one. The browser is only ever opened on Steam's login page.

Any local process can reach that port, so the listener is not trusted: the proof comes from Steam. The app accepts a callback only if:

1. `openid.ns` is the OpenID 2.0 namespace and `openid.mode` is `id_res`;
2. the callback reached the listener's own URL (`http://127.0.0.1:<port>/callback`), and `openid.return_to` is exactly the URL the app sent, including a random single-use nonce in its query string (16 random bytes, 32 hexadecimal characters; the anti-forgery value: OpenID 2.0 has no `state` parameter);
3. `openid.op_endpoint` is `https://steamcommunity.com/openid/login`, and `openid.claimed_id` is `openid.identity` and matches `https://steamcommunity.com/openid/id/<17-digit SteamID64>`;
4. Steam signed the fields that matter: `openid.signed` lists `op_endpoint`, `claimed_id`, `identity`, `return_to`, `response_nonce` and `assoc_handle`, so none of them could be edited without breaking the signature;
5. the time in `openid.response_nonce` is within 10 minutes of the PC clock, either way: a clock that is a few minutes off still signs in, and an old captured assertion does not;
6. Steam confirms the assertion: the parameters are POSTed back with `openid.mode=check_authentication` to the fixed endpoint `https://steamcommunity.com/openid/login` (never to a URL taken from the callback, and with no redirect followed), and the answer is an HTTP 200 whose key-value lines include `ns:http://specs.openid.net/auth/2.0` and `is_valid:true`, each key once: a page that merely contains those words is not a confirmation. OpenID 2.0 lets Steam confirm each assertion only once, which defeats replays.

Only then is the SteamID64 converted into the deadlock-api `account_id`. There is no search by name or ID.

## What Steam does

Checked live on 2026-10-18, with a real sign-in:

- Steam accepts the loopback address as the realm and in `return_to`, and redirects the browser there with the nonce kept in the query string. It echoes `openid.return_to` byte for byte, so check 2 can compare it exactly.
- With `identifier_select`, `openid.claimed_id` and `openid.identity` are the same URL, and `openid.signed` lists the six fields of check 4.
- `check_authentication` answers `is_valid:true` the first time. The same POST a second time answers `is_valid:false`: a captured assertion cannot be replayed.
- Steam's consent page names the site "127.0.0.1", not TheLibrary. The app says so before it opens the browser.

## Consequences

- Proof of account ownership; credentials never reach TheLibrary. A forged or stray request on the loopback port can at worst abort the sign-in.
- Needs the community plugin `tauri-plugin-oauth` for the loopback listener (no official plugin covers it: an exception to ADR 0001, reviewed like any dependency) and an opener for the system browser. The webview only gets the permissions to start and stop the listener, and receive its event; the opener permission is limited to Steam's login page, never to any URL.
- The linked account is one row of the database, next to the matches it governs. Unlinking it, or switching to another account, deletes the local data of the account: its matches, its synchronisation state and its archive folder. The database is then compacted (`VACUUM`, then a checkpoint of its write-ahead log, since the file would otherwise keep the deleted data), and a deletion cut short by a crash is finished at the next start. The logs are kept.
- The sign-in is a product and consent rule, not an access-control boundary: match data stays public on deadlock-api.com, and anyone can modify an open-source app. It keeps TheLibrary itself from becoming a tool to follow other players.

## Alternatives considered

- **Search by name/ID** — would turn TheLibrary into a tool to follow any player. Rejected.
- **Signing in to Steam inside the app** (credentials + Steam Guard typed into TheLibrary) — indistinguishable from phishing, requires storing credentials and conflicts with the game session. Rejected.

# ADR 0005 — Mandatory Steam sign-in (OpenID) to link an account

- **Status:** Accepted
- **Date:** 2026-09-29
- **Implementation:** milestone M3 (not started).

## Context

TheLibrary tracks one player's matches. Only the owner of a Steam account should be able to link it in the app, and the app must never handle Steam credentials.

## Decision

Link the account with **Steam's official OpenID 2.0 sign-in**, opened in the **system browser**: Steam handles the password and Steam Guard on its own page, then redirects to a one-shot loopback listener on `127.0.0.1` (random port). The app closes the listener after the first callback, or after 5 minutes without one.

Any local process can reach that port, so the listener is not trusted: the proof comes from Steam. The app accepts a callback only if:

1. `openid.ns` is the OpenID 2.0 namespace and `openid.mode` is `id_res`;
2. `openid.return_to` is exactly the URL the app sent, including a random single-use nonce in its query string (the anti-forgery value: OpenID 2.0 has no `state` parameter);
3. `openid.op_endpoint` is `https://steamcommunity.com/openid/login` and `openid.claimed_id` matches `https://steamcommunity.com/openid/id/<17-digit SteamID64>`;
4. Steam confirms the assertion: the parameters are POSTed back with `openid.mode=check_authentication` to the fixed endpoint `https://steamcommunity.com/openid/login` (never to a URL taken from the callback), and the answer contains `is_valid:true`. OpenID 2.0 lets Steam confirm each assertion only once, which defeats replays.

Only then is the SteamID64 converted into the deadlock-api `account_id`. There is no search by name or ID.

## Consequences

- Proof of account ownership; credentials never reach TheLibrary. A forged or stray request on the loopback port can at worst abort the sign-in.
- Needs the community plugin `tauri-plugin-oauth` for the loopback listener (no official plugin covers it: an exception to ADR 0001, reviewed like any dependency) and an opener for the system browser. The webview only gets the permissions to start and stop the listener.
- The sign-in is a product and consent rule, not an access-control boundary: match data stays public on deadlock-api.com, and anyone can modify an open-source app. It keeps TheLibrary itself from becoming a tool to follow other players.

## Alternatives considered

- **Search by name/ID** — would turn TheLibrary into a tool to follow any player. Rejected.
- **Signing in to Steam inside the app** (credentials + Steam Guard typed into TheLibrary) — indistinguishable from phishing, requires storing credentials and conflicts with the game session. Rejected.

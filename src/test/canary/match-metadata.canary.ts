/**
 * API canary: runs a fresh Paige match detail of the real deadlock-api through the pipeline of the
 * app, so that a change of the API shows up here, in a weekly run, before it breaks the archive of
 * the users.
 *
 * It is not a test of the code, which `pnpm test` covers with synthetic data: it is the contract
 * check of the data source. It runs only with `pnpm canary` (see vitest.canary.config.ts) and by the
 * weekly workflow `API canary`, never with `pnpm test` nor `pnpm check`.
 *
 * Requests (at most six per run, well under the limits of the API):
 * 1. the list of the most recent normal-mode Paige matches (match-level fields only: no player, so
 *    no account id);
 * 2. the detail of those matches, in order, until one answers 200 (at most five). The API does not
 *    hold every match, so a 404 or a server error other than 503 moves on to the next one, whereas a
 *    429 or a 503 ends the run at once: deadlock-api asked to pause, and the canary never hammers.
 *    `disable_steam=true` is always sent, as in the app, and `force_refetch` never is.
 *
 * The requests are the ones of the app: they go through its HTTP client (`TauriHttpClient`, given
 * Node's `fetch` instead of the Tauri plugin's) with the headers of its service, and the responses
 * are interpreted by its rules (`interpretResponse`). The detail then goes through what the app does
 * with it: the schema, the tracked player, the pruning, the envelope, the zstd codec and the facts
 * the detail page reads.
 *
 * Privacy: the detail holds the account ids of the twelve players, and this repository is public,
 * and so are its workflow logs. No message of this file contains a value of a payload, an account id
 * or a match id; they only hold paths, codes, statuses and counts. Two rules follow from that:
 * - an assertion compares counts or booleans, never an object or a payload value that would be
 *   printed when it fails;
 * - the errors of the app, which hold a path and a code by design, are the only ones forwarded.
 * Nothing is written to disk.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TauriHttpClient } from '../../adapters/tauri/tauri-http-client.adapter';
import type { ApiOutcome } from '../../core/deadlock-api/api-response';
import { interpretResponse } from '../../core/deadlock-api/api-response';
import type { ApiRequest } from '../../core/deadlock-api/endpoints';
import {
  DEADLOCK_API_BASE_URL,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  matchMetadataRequest,
  userAgent,
} from '../../core/deadlock-api/endpoints';
import { parseMatchMetadata } from '../../core/deadlock-api/match-metadata.schema';
import { parseAccountId } from '../../core/domain/account';
import { PAIGE_HERO_ID } from '../../core/domain/hero';
import type { MatchId } from '../../core/domain/match';
import { parseMatchId } from '../../core/domain/match';
import { AppError } from '../../core/errors/app-error';
import {
  createArchiveEnvelope,
  decodeArchiveEnvelope,
  encodeArchiveEnvelope,
} from '../../core/match-detail/archive-envelope';
import { summarizeArchive } from '../../core/match-detail/archive-facts';
import { ARCHIVED_GAME_MODE } from '../../core/match-detail/detail-status';
import { findTrackedPlayer, pruneForPlayer } from '../../core/match-detail/pruning';
import { compressBytes, decompressBytes } from '../../workers/zstd-codec';

/** Replaced by Vite with the version of package.json (see `define` in vitest.canary.config.ts). */
declare const __APP_VERSION__: string;

/** How many matches the list asks for, and so the most detail requests a run can make. */
const LISTED_MATCHES = 5;

/**
 * The list of the most recent normal-mode Paige matches. It is the bulk endpoint of deadlock-api:
 * its rows only describe the matches themselves (id, times, modes, badges), and it is used here
 * only to find match ids, never to archive anything.
 */
const LIST_REQUEST: ApiRequest = {
  // No `match_mode` parameter: the endpoint defaults it to `ranked,unranked`, so private lobbies
  // (whose players all have the account id 0) are already left out on the server side.
  url: `${DEADLOCK_API_BASE_URL}/v1/matches/metadata?hero_ids=${String(PAIGE_HERO_ID)}&game_mode=normal&limit=${String(LISTED_MATCHES)}&order_by=match_id&order_direction=desc`,
  endpoint: '/v1/matches/metadata',
  family: 'metadata',
};

/** The part of the list the canary relies on: an array of rows that each carry a `match_id`. */
const matchListSchema = z.array(z.looseObject({ match_id: z.int().min(1) })).min(1);

/** A sender of requests that counts what it sends. */
interface CountingApi {
  /** Send one GET request the way the app does and interpret the response. */
  readonly get: (request: ApiRequest) => Promise<ApiOutcome>;
  /** How many requests were sent so far. */
  readonly requestCount: () => number;
}

/**
 * Create the sender of the run.
 *
 * Requests go through the HTTP client of the app, with the headers its service sends, the same
 * timeout and the same size limit. The response is interpreted with the app's own rules, so a status
 * the app would treat as a pause or a failure is treated the same way here.
 *
 * @returns The sender.
 */
function createCountingApi(): CountingApi {
  // The client of the desktop app, given Node's `fetch` instead of the Tauri plugin's.
  const http = new TauriHttpClient(fetch);
  let requests = 0;
  return {
    requestCount: () => requests,
    async get(request) {
      requests += 1;
      let response;
      try {
        response = await http.get({
          url: request.url,
          // The headers of `DeadlockApiService`, see `#exchange` in deadlock-api.service.ts.
          headers: { 'User-Agent': userAgent(__APP_VERSION__), Accept: 'application/json' },
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxBodyBytes: MAX_RESPONSE_BYTES,
        });
      } catch (error) {
        if (error instanceof AppError) {
          // `network`, `timeout`, or `invalid_payload` for a body over `MAX_RESPONSE_BYTES`. The
          // message holds the kind only: the cause (the error of `fetch`) stays out of it.
          throw new Error(`request ${String(requests)} failed: ${error.kind}`, { cause: error });
        }
        throw error;
      }
      return interpretResponse(request, response, Date.now());
    },
  };
}

/**
 * Build the error of a request whose answer is neither a success nor a missing match.
 *
 * @param what - Which request, for the message.
 * @param outcome - The outcome of the request.
 * @returns The error to throw. Its message holds the kind of the error and the status of the
 *   response: codes, never a value of the body.
 */
function requestFailure(what: string, outcome: Exclude<ApiOutcome, { kind: 'success' }>): Error {
  const codes = `${outcome.error.kind}, status ${String(outcome.error.context.status ?? 'unknown')}`;
  return new Error(
    outcome.kind === 'pause'
      ? `deadlock-api asked to pause on the ${what} (${codes})`
      : `the ${what} failed (${codes})`,
  );
}

/**
 * Ask the API for the most recent normal-mode Paige matches.
 *
 * @param api - The sender of the run.
 * @returns Their ids, most recent first.
 * @throws Error when the list cannot be read: the message names a status, a path or a code.
 */
async function listRecentPaigeMatchIds(api: CountingApi): Promise<MatchId[]> {
  const outcome = await api.get(LIST_REQUEST);
  if (outcome.kind !== 'success') {
    throw requestFailure('list request', outcome);
  }
  const rows = matchListSchema.safeParse(outcome.json);
  if (!rows.success) {
    const [issue] = rows.error.issues;
    // An issue on the body itself (not an array) has an empty path.
    const path =
      issue === undefined || issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
    throw new Error(`the match list has an unexpected shape: ${path}: ${issue?.code ?? 'invalid'}`);
  }
  return rows.data.slice(0, LISTED_MATCHES).map(({ match_id: id }) => {
    const matchId = parseMatchId(id);
    if (matchId === null) {
      throw new Error('a match_id of the list is not a valid match id');
    }
    return matchId;
  });
}

/**
 * Fetch the detail of the first listed match the API can give.
 *
 * A 404 (the API never received that match) or a server error other than 503 only concerns that
 * match: the next one is tried. A 429 or a 503 is deadlock-api asking everybody to slow down, and
 * any other answer is a real problem (rejected request, private data): both end the run at once,
 * since asking more matches would not help and the canary never hammers the API.
 *
 * @param api - The sender of the run.
 * @param matchIds - The listed matches, in the order to try them.
 * @returns The id of the match and the JSON of its detail.
 * @throws Error when a request fails for another reason than the ones above, or when no listed
 *   match answers.
 */
async function fetchFirstAvailableDetail(
  api: CountingApi,
  matchIds: readonly MatchId[],
): Promise<{ matchId: MatchId; json: unknown }> {
  for (const [index, matchId] of matchIds.entries()) {
    const outcome = await api.get(matchMetadataRequest(matchId));
    if (outcome.kind === 'success') {
      return { matchId, json: outcome.json };
    }
    // `interpretResponse` reports a 503 as a pause, so `service_unavailable` here is another 5xx.
    if (
      outcome.kind === 'failure' &&
      (outcome.error.kind === 'not_found' || outcome.error.kind === 'service_unavailable')
    ) {
      continue;
    }
    throw requestFailure(`detail request ${String(index + 1)}`, outcome);
  }
  throw new Error(`none of the ${String(matchIds.length)} listed matches answered 200`);
}

/**
 * Run a step of the pipeline, naming it if it fails with an error of the app.
 *
 * The errors of the app carry a path and a code (`context.issue`) and never a value of the payload,
 * so they can be put in a message. Any other error is rethrown untouched.
 *
 * @param step - What the step does, for the message.
 * @param run - The step.
 * @returns What the step returns.
 * @throws Error naming the step, the path and the code, when the step throws an `AppError`.
 */
function inStep<Result>(step: string, run: () => Result): Result {
  try {
    return run();
  } catch (error) {
    if (error instanceof AppError) {
      // The cause is the error of the app itself, which holds no value either.
      throw new Error(`${step}: ${String(error.context.issue ?? error.kind)}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Narrow a value that must exist, failing with a message that names it.
 *
 * @param value - The value, possibly missing.
 * @param what - What the value is, for the message.
 * @returns The value.
 * @throws Error when the value is `null` or `undefined`.
 */
function present<Value>(value: Value | null | undefined, what: string): Value {
  if (value === null || value === undefined) {
    throw new Error(`${what} is missing`);
  }
  return value;
}

/**
 * Tell whether two byte arrays hold the same bytes.
 *
 * @param left - A byte array.
 * @param right - Another one.
 * @returns `true` when they have the same length and the same content.
 */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Tell whether two values are deeply equal, without ever describing them.
 *
 * `expect(left).toStrictEqual(right)` prints both values when it fails; here its failure is caught
 * and reduced to `false`, so that an envelope (which holds account ids) can be compared safely.
 *
 * @param left - A value.
 * @param right - Another one.
 * @returns `true` when the values are strictly equal.
 */
function sameValue(left: unknown, right: unknown): boolean {
  try {
    expect(left).toStrictEqual(right);
    return true;
  } catch {
    return false;
  }
}

describe('deadlock-api match detail', () => {
  it('still goes through the archive pipeline of the app', async ({ annotate }) => {
    const api = createCountingApi();

    // --- 1. A recent Paige match the API holds ---
    const matchIds = await listRecentPaigeMatchIds(api);
    const { matchId, json } = await fetchFirstAvailableDetail(api, matchIds);
    // Counts only: the list request, then the detail requests.
    await annotate(
      `${String(api.requestCount())} requests: 1 list, ${String(api.requestCount() - 1)} detail`,
    );

    // --- 2. The schema of the app, and proof that the API answered the match it was asked for ---
    const metadata = inStep('match detail schema', () => parseMatchMetadata(json, matchId));
    // Booleans, so that a failure prints no value of the payload.
    expect(
      metadata.match_info.game_mode === ARCHIVED_GAME_MODE,
      'match_info.game_mode is the archived game mode',
    ).toBe(true);

    // --- 3. The Paige player: exactly one, with a usable account id ---
    const paigePlayers = metadata.match_info.players.filter(
      (player) => player.hero_id === PAIGE_HERO_ID,
    );
    expect(paigePlayers.length, 'number of players whose hero_id is Paige').toBe(1);
    const paige = present(paigePlayers[0], 'the Paige player');
    // A private lobby reports the account id 0, which the app never archives.
    const accountId = present(
      parseAccountId(paige.account_id),
      'a valid players.account_id for the Paige player',
    );
    // The tracked-player lookup of the app must find the same player, by account id.
    const tracked = inStep('tracked player lookup', () => findTrackedPlayer(metadata, accountId));
    expect(
      tracked.playerSlot === paige.player_slot,
      'the slot found by account id is the slot of the Paige player',
    ).toBe(true);
    expect(
      tracked.team === paige.team,
      'the team found by account id is the team of the Paige player',
    ).toBe(true);

    // --- 4. The pruning ---
    const pruned = pruneForPlayer(metadata, tracked.playerSlot);
    expect(
      pruned.match_info.players.length,
      'players kept by the pruning (all of them are kept)',
    ).toBe(metadata.match_info.players.length);
    const otherPaths = (pruned.match_info.match_paths?.paths ?? []).filter(
      (path) => path.player_slot !== tracked.playerSlot,
    );
    expect(otherPaths.length, 'match_paths.paths of other players left after pruning').toBe(0);

    // --- 5. The envelope, through the codec, and back ---
    const envelope = createArchiveEnvelope(pruned, accountId, Date.now());
    const encoded = encodeArchiveEnvelope(envelope);
    const compressed = await compressBytes(encoded);
    const restored = await decompressBytes(compressed);
    expect(sameBytes(restored, encoded), 'decompressed bytes equal the encoded bytes').toBe(true);
    const decoded = inStep('archive envelope decoding', () => decodeArchiveEnvelope(restored));
    expect(sameValue(decoded, envelope), 'decoded envelope equals the written envelope').toBe(true);
    await annotate(
      `archive: ${String(encoded.length)} bytes pruned, ${String(compressed.length)} bytes compressed`,
    );

    // --- 6. The facts the detail page reads ---
    const facts = inStep('archive facts', () => summarizeArchive(decoded));
    expect(facts.snapshots, 'stats snapshots of the tracked player').toBeGreaterThan(0);
    expect(facts.durationS, 'match_info.duration_s').toBeGreaterThan(0);
  });
});

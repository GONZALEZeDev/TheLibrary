/**
 * API canary: runs a fresh Paige match detail of the real deadlock-api through the pipeline of the
 * app, so that a change of the API shows up here, in a weekly run, before it breaks the archive of
 * the users.
 *
 * It is not a test of the code, which `pnpm test` covers with synthetic data: it is the contract
 * check of the data source. It runs only with `pnpm canary` (see vitest.canary.config.ts) and by the
 * weekly workflow `API canary`, never with `pnpm test` nor `pnpm check`.
 *
 * Requests (at most eight per run, well under the limits of the API):
 * 1. the list of the most recent normal-mode Paige matches (match-level fields only: no player, so
 *    no account id);
 * 2. the detail of those matches, in order, until one answers 200 (at most five). The API does not
 *    hold every match, so a 404 or a server error other than 503 moves on to the next one, whereas a
 *    429 or a 503 ends the run at once: deadlock-api asked to pause, and the canary never hammers.
 *    `disable_steam=true` is always sent, as in the app, and `force_refetch` never is;
 * 3. the hero catalogue, for Paige's loadout;
 * 4. the item catalogue (about 6.5 MB, the largest answer the app downloads), for the ids, class
 *    names and kinds the damage tab and the build are joined on.
 * The two catalogues are the last requests, sent once the checks that need no network have passed.
 * They follow the same rule: a 429 or a 503 ends the run at once.
 *
 * The requests are the ones of the app: they go through its HTTP client (`TauriHttpClient`, given
 * Node's `fetch` instead of the Tauri plugin's) with the headers of its service, and the responses
 * are interpreted by its rules (`interpretResponse`). The detail then goes through what the app does
 * with it: the schema, the tracked player, the pruning, the envelope, the zstd codec, the facts
 * the detail page reads, the analysis (the context of the match, the snapshot counters and the
 * death details it reads, and the metrics projected from it), and what the match detail page reads
 * (the damage matrix and the damage sources projected from it, the tracked player's items, the
 * scoreboard, Paige's loadout in the hero catalogue, and the item catalogue that names the build,
 * the ability unlocks and the loadout by id and by class name).
 *
 * Privacy: the detail holds the account ids of the twelve players, and this repository is public,
 * and so are its workflow logs. No message of this file contains a value of a payload, an account id
 * or a match id; they only hold paths, codes, statuses, counts, booleans and percentages. Two rules
 * follow from that:
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
import { readDamageMatrix } from '../../core/analysis/damage-matrix';
import { damageSourceKey, projectDamageSources } from '../../core/analysis/damage-sources';
import { SNAPSHOT_STATS, buildMatchContext } from '../../core/analysis/match-context';
import { MATCH_METRICS, projectMetrics } from '../../core/analysis/registry';
import type { ApiOutcome } from '../../core/deadlock-api/api-response';
import { interpretResponse } from '../../core/deadlock-api/api-response';
import { parseItemCatalogue, type CatalogueItem } from '../../core/deadlock-api/assets.schema';
import type { ApiRequest } from '../../core/deadlock-api/endpoints';
import {
  DEADLOCK_API_BASE_URL,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  heroesRequest,
  itemsRequest,
  matchMetadataRequest,
  userAgent,
} from '../../core/deadlock-api/endpoints';
import { parseHeroAssets } from '../../core/deadlock-api/heroes.schema';
import { parseMatchMetadata } from '../../core/deadlock-api/match-metadata.schema';
import { parseAccountId } from '../../core/domain/account';
import type { HeroAsset } from '../../core/domain/hero';
import { PAIGE_HERO_ID } from '../../core/domain/hero';
import type { MatchId } from '../../core/domain/match';
import { parseMatchId } from '../../core/domain/match';
import { AppError } from '../../core/errors/app-error';
import { describeFirstIssue } from '../../core/errors/first-issue';
import {
  createArchiveEnvelope,
  decodeArchiveEnvelope,
  encodeArchiveEnvelope,
} from '../../core/match-detail/archive-envelope';
import { summarizeArchive } from '../../core/match-detail/archive-facts';
import { ARCHIVED_GAME_MODE } from '../../core/match-detail/detail-status';
import { findTrackedPlayer, pruneForPlayer } from '../../core/match-detail/pruning';
import { readScoreboard } from '../../core/match-detail/scoreboard';
import { finalBuildOf, readTrackedItems } from '../../core/match-detail/tracked-items';
import { compressBytes, decompressBytes } from '../../workers/zstd-codec';

/** Replaced by Vite with the version of package.json (see `define` in vitest.canary.config.ts). */
declare const __APP_VERSION__: string;

/** How many matches the list asks for, and so the most detail requests a run can make. */
const LISTED_MATCHES = 5;

/**
 * How many of the thirteen match metrics a real match must give a value for. A few can legitimately
 * be unknown (no lane opponent, a match under ten minutes, no shot fired), so the canary does not
 * ask for all of them; but a payload that changed shape makes whole families of metrics unknown,
 * and falls under this. A single renamed counter would not: the inputs of the metrics (the snapshot
 * counters and the death details) are checked on their own for that.
 */
const MIN_KNOWN_MATCH_METRICS = 10;

/**
 * How far the total of the damage matrix may be from the tracked player's last `player_damage`
 * snapshot, as a share of that snapshot (0.1 %). Both are the same damage, so on the matches checked
 * they are equal to the point; the margin is there for rounding only (the series of the matrix are
 * real numbers, the snapshot counter a whole one, and the series are summed). It is far under what a
 * change of layout would cost: a category row counted with the sources twice doubles the total, and a
 * target taken for an enemy hero adds a share of the damage to heroes.
 */
const DAMAGE_TOTAL_TOLERANCE = 0.001;

/** The least the two damage totals may differ by, in damage points, whatever their size. */
const DAMAGE_TOTAL_MIN_TOLERANCE = 1;

/**
 * The fewest items a final build holds. A player who ends a normal match with nothing in their
 * inventory is not what a real match looks like; an empty build means the items are no longer read
 * (a renamed `upgrade_id`, a `sold_time_s` set on every entry).
 */
const MIN_FINAL_BUILD_ITEMS = 1;

/** The most items a final build holds: the inventory of a player has twelve places in all. */
const MAX_FINAL_BUILD_ITEMS = 12;

/** The most players with a place in Valve's top three of a match (`mvpRank` 1 to 3). */
const MAX_MVP_PLAYERS = 3;

/**
 * The fewest players with a place in Valve's top three. Every match has its top three since
 * 2026-01-06, and the canary reads one of the most recent matches: none means that `mvp_rank` is no
 * longer read (a renamed field reads as no place, which the app tolerates for an older match).
 */
const MIN_MVP_PLAYERS = 1;

/**
 * The largest share of `MAX_RESPONSE_BYTES` the answer of the item catalogue may take (80 %). It is
 * the largest answer the app downloads (about 65 % of the limit on 2026-10-21), and past the limit
 * its download fails for good: a fresh install would then never name a damage source. The margin
 * turns the canary red while there is still time to raise the limit.
 */
const MAX_ITEM_CATALOGUE_SHARE = 0.8;

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
  /**
   * The size of the body of the last response, in bytes, as the size limit of the app counts it
   * (decompressed); 0 before the first response.
   */
  readonly lastBodyBytes: () => number;
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
  let bodyBytes = 0;
  return {
    requestCount: () => requests,
    lastBodyBytes: () => bodyBytes,
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
      // The body is decoded as UTF-8: encoding it again gives back the bytes that were received.
      bodyBytes = new TextEncoder().encode(response.body).length;
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
    // The path and the code of the first issue, as the app reports them: never a value of the body.
    throw new Error(`the match list has an unexpected shape: ${describeFirstIssue(rows.error)}`);
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
 * Ask the API for the hero catalogue and read it the way the app does.
 *
 * It is the next to last request of a run. A 429 or a 503 (a pause), like any other answer that is
 * not a success, ends the run at once: the catalogue is a single request, with no other one to move
 * on to.
 *
 * @param api - The sender of the run.
 * @returns The playable heroes with their portrait and loadout, sorted by id.
 * @throws Error when the request does not answer 200, or when the catalogue is not what the app
 *   expects. The message holds a kind, a status or a path and a code, never a value of the body.
 */
async function fetchHeroCatalogue(api: CountingApi): Promise<HeroAsset[]> {
  const outcome = await api.get(heroesRequest());
  if (outcome.kind !== 'success') {
    throw requestFailure('hero catalogue request', outcome);
  }
  return inStep('hero catalogue', () => parseHeroAssets(outcome.json));
}

/**
 * Ask the API for the item catalogue and read it the way the app does.
 *
 * It is the last request of a run, under the same rule as the hero catalogue.
 *
 * @param api - The sender of the run.
 * @returns The readable entries, in the order of the body, and the size of the answer in bytes
 *   (what `MAX_RESPONSE_BYTES` is checked against).
 * @throws Error when the request does not answer 200, or when the catalogue is not what the app
 *   expects. The message holds a kind, a status or a path and a code, never a value of the body.
 */
async function fetchItemCatalogue(
  api: CountingApi,
): Promise<{ items: CatalogueItem[]; bodyBytes: number }> {
  const outcome = await api.get(itemsRequest());
  if (outcome.kind !== 'success') {
    throw requestFailure('item catalogue request', outcome);
  }
  const bodyBytes = api.lastBodyBytes();
  return { items: inStep('item catalogue', () => parseItemCatalogue(outcome.json)), bodyBytes };
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

/**
 * Tell whether the total of the damage matrix and the damage counter of the snapshots agree: both
 * are the damage the tracked player dealt to enemy heroes, read from two places of the payload.
 *
 * They are compared as numbers, within the margin of {@link DAMAGE_TOTAL_TOLERANCE} (a share of the
 * counter) and {@link DAMAGE_TOTAL_MIN_TOLERANCE} (a floor, for a player who dealt little).
 *
 * @param matrixTotal - The total of the damage matrix at its last sample.
 * @param snapshotDamage - The `player_damage` of the tracked player's last snapshot.
 * @returns `true` when they differ by no more than the margin. A boolean on purpose: whoever
 *   asserts on it prints no value of the payload.
 */
function damageTotalsAgree(matrixTotal: number, snapshotDamage: number): boolean {
  const margin = Math.max(DAMAGE_TOTAL_MIN_TOLERANCE, snapshotDamage * DAMAGE_TOTAL_TOLERANCE);
  return Math.abs(matrixTotal - snapshotDamage) <= margin;
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
    expect(decoded.payload.match_info.duration_s, 'match_info.duration_s').toBeGreaterThan(0);

    // --- 7. The analysis: the context of the match, and the metrics projected from it ---
    // The context is built from the archive the way the projection of the app does it, so a payload
    // that lacks what the analysis needs fails here with its path and code (never a value).
    const context = inStep('match context', () => buildMatchContext(decoded));
    // How many metric computations threw: a count, since the error of a metric may quote the archive.
    let throwingMetrics = 0;
    const projection = projectMetrics(context, () => {
      throwingMetrics += 1;
    });
    // Only the metrics of the whole match: the phase metrics and the community windows are left out,
    // since a match without a late game legitimately has no value for them. A value is a finite
    // number or `null`.
    const nullMatchMetrics = MATCH_METRICS.filter(
      ({ key }) => typeof projection.get(key) !== 'number',
    ).map(({ key }) => key);
    const knownMatchMetrics = MATCH_METRICS.length - nullMatchMetrics.length;
    // The counters the analysis reads, as the context read them from the tracked player's last
    // snapshot: a counter renamed or dropped by the API leaves every metric on it `null`, which is
    // never logged, so this is where it shows.
    const lastSnapshot = context.tracked.snapshots.at(-1);
    const missingCounters = SNAPSHOT_STATS.filter(
      (stat) => lastSnapshot?.stats[stat] === undefined,
    );
    // The kills by phase are only known when every player has one death detail per death (the
    // context's rule): otherwise the three kill metrics of the phases are `null` on every match.
    const deathDetailsComplete = context.kills !== null;
    await annotate(
      `analysis: ${String(knownMatchMetrics)} of ${String(MATCH_METRICS.length)} match metrics known, ${String(throwingMetrics)} computations threw`,
    );
    await annotate(
      `inputs: ${String(SNAPSHOT_STATS.length - missingCounters.length)} of ${String(SNAPSHOT_STATS.length)} snapshot counters present, death details complete: ${String(deathDetailsComplete)}`,
    );
    // Counts and booleans; the failure messages name metric keys and counters, which are code
    // identifiers, never a value of the payload.
    expect(
      knownMatchMetrics,
      `match metrics (of ${String(MATCH_METRICS.length)}) that are not null; null: ${nullMatchMetrics.join(', ')}`,
    ).toBeGreaterThanOrEqual(MIN_KNOWN_MATCH_METRICS);
    expect(
      missingCounters.length,
      `snapshot counters missing from the tracked player's last snapshot: ${missingCounters.join(', ')}`,
    ).toBe(0);
    expect(deathDetailsComplete, 'every player has one death detail per death').toBe(true);

    // --- 8. Damage, items, scoreboard: what the match detail page reads ---
    // The damage matrix of the tracked player. A match without one reads as `null`, which the app
    // accepts for an old archive, but a fresh match of the API must have it.
    const damageMatrix = present(
      inStep('damage matrix', () => readDamageMatrix(decoded)),
      'the damage matrix of the match',
    );
    // Its total at the last sample is the damage to enemy heroes over the whole match, which the
    // last snapshot of the tracked player counts too (`player_damage`). A matrix that sums the
    // category rows with the sources, or counts a target it should not, drifts from it.
    const matrixTotal = present(damageMatrix.total.at(-1), 'the total of the damage matrix');
    const snapshotDamage = present(
      lastSnapshot?.stats.player_damage,
      'player_damage in the last snapshot of the tracked player',
    );
    const totalsAgree = damageTotalsAgree(matrixTotal, snapshotDamage);
    // The `damage_source.` keys the projection stores: one per source that dealt damage.
    const damageValues = projectDamageSources(damageMatrix);
    const damageSourceKeys = [...damageValues.keys()].filter((key) =>
      key.startsWith(damageSourceKey('')),
    );
    // The final build comes from the items read on their own, not through the damage matrix.
    const trackedItems = inStep('tracked player items', () => readTrackedItems(decoded));
    const finalBuild = finalBuildOf(trackedItems);
    // The scoreboard of the archive: every player of the match, none of them identified.
    const scoreboard = inStep('scoreboard', () => readScoreboard(decoded));
    const mvpPlayers = scoreboard.players.filter((player) => player.mvpRank !== null).length;
    await annotate(
      `damage: ${String(damageMatrix.sources.size)} sources, ${String(damageSourceKeys.length)} damage_source keys, ${String(damageMatrix.sampleTimesS.length)} samples, matrix total agrees with the last snapshot: ${String(totalsAgree)}`,
    );
    await annotate(
      `items: ${String(trackedItems.length)} entries, ${String(finalBuild.length)} in the final build`,
    );
    await annotate(
      `scoreboard: ${String(scoreboard.players.length)} players, ${String(mvpPlayers)} with an mvp rank`,
    );
    // Counts and booleans, as in the steps above; no message names a value of the payload.
    expect(totalsAgree, 'damage matrix total differs from the last player_damage snapshot').toBe(
      true,
    );
    expect(
      damageSourceKeys.length,
      'damage_source keys projected from the damage matrix',
    ).toBeGreaterThan(0);
    expect(
      finalBuild.length,
      'items in the final build of the tracked player (at least)',
    ).toBeGreaterThanOrEqual(MIN_FINAL_BUILD_ITEMS);
    expect(
      finalBuild.length,
      'items in the final build of the tracked player (at most)',
    ).toBeLessThanOrEqual(MAX_FINAL_BUILD_ITEMS);
    expect(
      scoreboard.players.length,
      'players read by the scoreboard (every player of the archive)',
    ).toBe(decoded.payload.match_info.players.length);
    expect(
      mvpPlayers,
      'players with an mvpRank (the top three of the match, at least)',
    ).toBeGreaterThanOrEqual(MIN_MVP_PLAYERS);
    expect(
      mvpPlayers,
      'players with an mvpRank (the top three of the match, at most)',
    ).toBeLessThanOrEqual(MAX_MVP_PLAYERS);

    // --- 9. The catalogues the match page names and classifies everything with ---
    // The hero catalogue, for the loadout of Paige. The weapon of the loadout is looked up by the
    // key of its damage source in the projection, which holds a key only for a source that dealt
    // damage to enemy heroes (its critical hits are merged into it).
    const heroes = await fetchHeroCatalogue(api);
    const paigeHero = heroes.find((hero) => hero.id === PAIGE_HERO_ID);
    // Annotated before the checks, so that a run without Paige or her loadout still prints them.
    await annotate(
      `heroes: ${String(heroes.length)} playable, ${String(heroes.filter((hero) => hero.loadout !== null).length)} with a loadout, Paige with a loadout: ${String((paigeHero?.loadout ?? null) !== null)}`,
    );
    const loadout = present(
      present(paigeHero, 'Paige in the hero catalogue').loadout,
      'the loadout of Paige in the hero catalogue',
    );
    expect(
      damageValues.has(damageSourceKey(loadout.weapon)),
      'the weapon of the loadout of Paige is a damage source of the match',
    ).toBe(true);

    // The item catalogue, the last request of the run. The damage tab rests on three joins with it,
    // which fail quietly when the API changes (an unknown id or kind is shown unnamed, or as another
    // source, with no error): the items of the build by id, the ability unlocks by the ids of the
    // abilities of the loadout, and the loadout by class name.
    const { items, bodyBytes } = await fetchItemCatalogue(api);
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const itemsByClassName = new Map(items.map((item) => [item.className, item]));
    const buildItemsNotUpgrades = finalBuild.filter(
      (entry) => itemsById.get(entry.itemId)?.kind !== 'upgrade',
    ).length;
    const loadoutAbilityIds = new Set(
      loadout.abilities.map((className) => itemsByClassName.get(className)?.id),
    );
    // The entries of the items that are not shop items: the unlocks and the upgrades of abilities.
    const abilityEntries = trackedItems.filter((entry) => !entry.isShopItem);
    const abilityEntriesOutsideLoadout = abilityEntries.filter(
      (entry) => !loadoutAbilityIds.has(entry.itemId),
    ).length;
    const loadoutClassNames = [loadout.weapon, loadout.melee, ...loadout.abilities];
    const loadoutClassNamesMissing = loadoutClassNames.filter(
      (className) => !itemsByClassName.has(className),
    ).length;
    const responseShare = bodyBytes / MAX_RESPONSE_BYTES;
    // Counts and a percentage only: no id, class name or value of the catalogue.
    await annotate(
      `item catalogue: ${String(items.length)} entries, answer at ${(responseShare * 100).toFixed(0)} % of MAX_RESPONSE_BYTES`,
    );
    await annotate(
      `item joins: ${String(finalBuild.length - buildItemsNotUpgrades)} of ${String(finalBuild.length)} build items are catalogue upgrades, ${String(abilityEntries.length - abilityEntriesOutsideLoadout)} of ${String(abilityEntries.length)} ability entries are abilities of the loadout, ${String(loadoutClassNames.length - loadoutClassNamesMissing)} of ${String(loadoutClassNames.length)} loadout class names in the catalogue; ${String(api.requestCount())} requests in all`,
    );
    expect(
      buildItemsNotUpgrades,
      'items of the final build that are not an upgrade of the item catalogue',
    ).toBe(0);
    expect(
      abilityEntriesOutsideLoadout,
      'ability entries whose item_id is not the catalogue id of an ability of the loadout of Paige',
    ).toBe(0);
    expect(
      loadoutClassNamesMissing,
      'class names of the loadout of Paige missing from the item catalogue',
    ).toBe(0);
    expect(
      responseShare <= MAX_ITEM_CATALOGUE_SHARE,
      'the answer of the item catalogue takes at most 80 % of MAX_RESPONSE_BYTES',
    ).toBe(true);
  });
});

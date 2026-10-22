/**
 * Synthetic match history served by the development HTTP client.
 *
 * No real player's history is ever committed: this generator invents a plausible one for a
 * synthetic account, in the exact shape of deadlock-api's
 * `GET /v1/players/{account_id}/match-history` (every field of a row, including those the app
 * ignores). It is deterministic: the same options always produce the same history, so tests can
 * rely on it.
 *
 * @packageDocumentation
 */
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import type { AccountId } from '../../../core/domain/account';
import { RANKED_MATCH_MODE, UNRANKED_MATCH_MODE } from '../../../core/match-detail/detail-status';
import { between, createRandom } from './fixture-random';

/**
 * The synthetic account of the fixtures. It was never looked up: any resemblance with a real
 * account id is a coincidence, and its data is invented anyway.
 */
export const FIXTURE_ACCOUNT_ID = 1_000_001 as AccountId;

/** A history row in the raw shape of the API. */
export interface RawMatchHistoryRow {
  readonly account_id: number;
  readonly match_id: number;
  readonly hero_id: number;
  readonly hero_level: number;
  readonly start_time: number;
  readonly game_mode: number;
  readonly match_mode: number;
  readonly player_team: number;
  readonly player_kills: number;
  readonly player_deaths: number;
  readonly player_assists: number;
  readonly denies: number;
  readonly net_worth: number;
  readonly last_hits: number;
  readonly team_abandoned: boolean | null;
  readonly abandoned_time_s: number | null;
  readonly match_duration_s: number;
  readonly match_result: number;
  readonly objectives_mask_team0: number;
  readonly objectives_mask_team1: number;
  readonly brawl_score_team0: number | null;
  readonly brawl_score_team1: number | null;
  readonly brawl_avg_round_time_s: number | null;
  readonly ranked_display_badge: number | null;
  readonly ranked_delta: number | null;
  readonly ranked_calibration_match: boolean | null;
  readonly ranked_used_demotion_protection: boolean | null;
  readonly player_match_outcome: number;
}

/** Options of {@link createMatchHistoryFixture}. */
export interface MatchHistoryFixtureOptions {
  /** End of the history (Unix ms): the most recent match started about 2 hours before. */
  readonly now: number;
  /** The player; {@link FIXTURE_ACCOUNT_ID} by default. */
  readonly accountId?: AccountId;
  /** Number of matches; 240 by default (about three months of play). */
  readonly count?: number;
}

/** Heroes of the other matches (ids of `heroes.fixture.ts`). */
const OTHER_HERO_IDS = [1, 2, 3, 4, 6, 7, 13, 15, 20, 35];

/**
 * Generate a synthetic match history, most recent match first like the API.
 *
 * About 40 % of the matches are Paige matches, 60 % are ranked, and the player wins about half of
 * them.
 *
 * @param options - See {@link MatchHistoryFixtureOptions}.
 * @returns The rows, in the raw shape of the API.
 */
export function createMatchHistoryFixture(
  options: MatchHistoryFixtureOptions,
): RawMatchHistoryRow[] {
  const { now, accountId = FIXTURE_ACCOUNT_ID, count = 240 } = options;
  // Seeded, so that the history is the same at every run, which `Math.random()` cannot guarantee.
  const random = createRandom(67);
  const rows: RawMatchHistoryRow[] = [];
  let startTime = Math.floor(now / 1000) - 2 * 3600;
  let matchId = 108_600_000;
  for (let index = 0; index < count; index += 1) {
    const ranked = random() < 0.6;
    const playerTeam = between(random, 0, 1);
    const won = random() < 0.5;
    const durationS = between(random, 1_200, 3_000);
    rows.push({
      account_id: accountId,
      match_id: matchId,
      hero_id:
        random() < 0.4
          ? PAIGE_HERO_ID
          : (OTHER_HERO_IDS[between(random, 0, OTHER_HERO_IDS.length - 1)] ?? 1),
      hero_level: between(random, 20, 36),
      start_time: startTime,
      game_mode: 1,
      match_mode: ranked ? RANKED_MATCH_MODE : UNRANKED_MATCH_MODE,
      player_team: playerTeam,
      player_kills: between(random, 0, 15),
      player_deaths: between(random, 0, 12),
      player_assists: between(random, 2, 30),
      denies: between(random, 0, 40),
      net_worth: between(random, 15_000, 60_000),
      last_hits: between(random, 60, 300),
      team_abandoned: null,
      abandoned_time_s: null,
      match_duration_s: durationS,
      match_result: won ? playerTeam : 1 - playerTeam,
      objectives_mask_team0: between(random, 0, 65_535),
      objectives_mask_team1: between(random, 0, 65_535),
      brawl_score_team0: null,
      brawl_score_team1: null,
      brawl_avg_round_time_s: null,
      ranked_display_badge: ranked ? between(random, 60, 80) : null,
      ranked_delta: ranked ? (won ? between(random, 5, 20) : -between(random, 5, 20)) : null,
      ranked_calibration_match: ranked ? false : null,
      ranked_used_demotion_protection: null,
      player_match_outcome: won ? 1 : 2,
    });
    // The previous match ended between 1 and 20 hours earlier.
    startTime -= durationS + between(random, 3_600, 72_000);
    matchId -= between(random, 500, 9_000);
  }
  return rows;
}

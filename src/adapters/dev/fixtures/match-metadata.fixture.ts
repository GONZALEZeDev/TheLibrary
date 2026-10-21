/**
 * Synthetic match details served by the development HTTP client.
 *
 * No real player's match is ever committed: this generator invents the detail of a match of the
 * synthetic history (`match-history.fixture.ts`), in the shape of deadlock-api's
 * `GET /v1/matches/{match_id}/metadata`. It is deterministic, seeded by the match id only (no
 * `Math.random`, no clock): the same row always gives the same detail, so tests can rely on it.
 *
 * What the detail holds:
 * - twelve players, six per team, each in their own slot (1 to 12). The tracked player is in the
 *   slot `(match_id % 12) + 1` with the hero, the team, the kills, deaths, assists and net worth of
 *   their history row. The eleven others are invented accounts (from 2,000,001 up) playing the
 *   heroes of the fixture catalogue;
 * - for every player: the cumulative `stats` snapshots, their `items` (ability unlocks and
 *   upgrades, shop items kept, consumed or sold), their `mvp_rank` (Valve's top three of the match)
 *   and their `death_details`;
 * - for every player, what the match analysis reads: the `assigned_lane` (1, 4 or 6; two players of
 *   each team in each lane, the same number being the same lane for both teams), in a ranked match
 *   the `player_rank_data` with the badge the player had at the start, and the snapshot counters
 *   `boss_damage`, `shots_hit`, `shots_missed`, `teammate_healing` and `teammate_barriering`;
 * - `match_paths`: one path per player with a position every second;
 * - `damage_matrix`: one dealer per player, plus the non-player dealer (slot 0).
 *
 * The deaths form one ledger (who killed whom, when) from which the deaths, the kills and the
 * `death_details` of all the players are read, so the numbers of the match agree with each other.
 * The damage matrix and the items form another (`match-damage.fixture.ts`), from which the
 * `player_damage` of every snapshot is read: it is the same number as the sum of the player's
 * sources in the matrix.
 *
 * The fields of the analysis, and the items and the damage, are drawn from generators of their own,
 * seeded by the match id as well, so that changing them never moves the figures the main generator
 * draws.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../../../core/domain/account';
import type { MatchId } from '../../../core/domain/match';
import { RANKED_MATCH_MODE } from '../../../core/match-detail/detail-status';
import { between, createRandom, pick, shuffled } from './fixture-random';
import type { Random } from './fixture-random';
import { FIXTURE_HERO_CATALOGUE } from './heroes.fixture';
import { createMatchDamage } from './match-damage.fixture';
import type { MatchDamage } from './match-damage.fixture';
import type { RawMatchHistoryRow } from './match-history.fixture';

/** One of the twelve seats of a match: who sits in a slot. */
interface Seat {
  /** The slot, from 1 to 12: the key of their path and of their damage in the detail. */
  readonly slot: number;
  /** The team (0 or 1). */
  readonly team: number;
  readonly accountId: number;
  readonly heroId: number;
  /** `true` for the tracked player, the one of the history row. */
  readonly tracked: boolean;
  /**
   * The lane they are assigned to (see {@link LANES}): the same number is the same lane for both
   * teams.
   */
  readonly lane: number;
  /**
   * The rank badge they had when the match started (`tier × 10 + subrank`). It is written in the
   * detail of a ranked match only.
   */
  readonly badge: number;
}

/** One death of the match: who died, who killed them, and when. */
interface Death {
  readonly victim: number;
  readonly killer: number;
  /** When it happened, in seconds since the match start. */
  readonly timeS: number;
}

/** The movement path of one player, in the shape of the API's `match_paths.paths[]`. */
type Path = ReturnType<typeof createPath>;

/** The parts of a match that depend on each other and are built once for all the players. */
interface Timeline {
  readonly deaths: readonly Death[];
  readonly paths: readonly Path[];
  /** The times of the `stats` snapshots, see {@link snapshotTimes}. */
  readonly snapshotTimes: readonly number[];
}

/** The final numbers of one player, from which their snapshots are interpolated. */
interface Totals {
  readonly level: number;
  readonly assists: number;
  readonly netWorth: number;
  readonly lastHits: number;
  readonly denies: number;
  readonly damageTaken: number;
  readonly healing: number;
  /** Damage dealt to objectives (guardians, walkers, the patron…). */
  readonly bossDamage: number;
  /** Shots that hit a target. */
  readonly shotsHit: number;
  /** Shots that missed. */
  readonly shotsMissed: number;
  /** Healing given to teammates (their own healing excluded). */
  readonly teammateHealing: number;
  /** Barrier given to teammates. */
  readonly teammateBarriering: number;
}

/** The final numbers that only the match analysis reads, see {@link createAnalysisTotals}. */
type AnalysisTotals = Pick<
  Totals,
  'bossDamage' | 'shotsHit' | 'shotsMissed' | 'teammateHealing' | 'teammateBarriering'
>;

/** The slots of a match: 1 to 12, as the API numbers them. */
const SLOTS = Array.from({ length: 12 }, (_, index) => index + 1);

/** Number of players of each team. */
const TEAM_SIZE = 6;

/** Account id of the first synthetic player (the other ten follow). */
const FIRST_OTHER_ACCOUNT_ID = 2_000_001;

/** A match id that is a multiple of this has no detail: "the API never received this match". */
const MISSING_MATCH_MODULO = 7;

/**
 * The lanes of one team, one entry per player: three lanes (1, 4 and 6) with two players each. The
 * same number is the same lane on both teams, so the two players of a lane face the two of the other
 * team.
 */
const LANES = [1, 1, 4, 4, 6, 6];

/** The lowest and the highest tier of a rank badge (Initiate to Eternus). */
const MIN_TIER = 1;
const MAX_TIER = 11;

/** The lowest and the highest subrank of a tier in a rank badge. */
const MIN_SUBRANK = 1;
const MAX_SUBRANK = 6;

/** A badge is `tier × BADGE_TIER_FACTOR + subrank`. */
const BADGE_TIER_FACTOR = 10;

/**
 * Mixed into the match id to seed the generator of the fields the analysis reads, so that it never
 * shares a sequence with the generator of the rest of the detail.
 */
const ANALYSIS_SEED = 0x2f6e3a91;

/**
 * Mixed into the match id to seed the generator of the items and of the damage matrix (see
 * `match-damage.fixture.ts`), so that it never shares a sequence with the others.
 */
const DAMAGE_SEED = 0x7a3c91d5;

/** Mixed into the match id to seed the badge of the tracked player (see `fixtureTrackedBadge`). */
const TRACKED_BADGE_SEED = 0x5bd1e995;

/** The first `stats` snapshots, in seconds; the following ones are every `LATE_SNAPSHOT_STEP_S`. */
const EARLY_SNAPSHOTS_S = [180, 360, 540, 720, 900];

/** Time between two `stats` snapshots once the early ones are over, in seconds. */
const LATE_SNAPSHOT_STEP_S = 300;

/** Nobody dies before this time, in seconds. */
const FIRST_DEATH_S = 60;

/** The longest wait before a player respawns, in seconds. */
const MAX_RESPAWN_S = 60;

/**
 * Positions of the paths are whole numbers from 0 to this value, decoded with the bounds of the
 * path (`x_min`…`x_max`). A coarse grid keeps the 12 × `duration_s` positions small.
 */
const MAP_RESOLUTION = 255;

/** Half of the side of the square map, in game units: the paths go from `-` this to `+` this. */
const MAP_HALF_SIZE = 8_192;

/**
 * The item at an index of a list the caller knows to be long enough. The type checker cannot know
 * it (`noUncheckedIndexedAccess`), and a miss is a mistake of this file, not of the data.
 *
 * @param items - The list.
 * @param index - A position of the list.
 * @returns The item.
 * @throws Error when the index is outside the list.
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No item at index ${String(index)} of a list of ${String(items.length)}`);
  }
  return item;
}

/**
 * Keep a number between two bounds.
 *
 * @param value - The number.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns `value`, or the bound it went past.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Whether the API has no detail for a match.
 *
 * About one match in seven has none, so that the detail queue meets matches deadlock-api never
 * received (it answers 404 for them).
 *
 * @param matchId - The match.
 * @returns `true` when the match is a multiple of seven.
 */
export function isMetadataMissing(matchId: MatchId): boolean {
  return matchId % MISSING_MATCH_MODULO === 0;
}

/**
 * The rank badge of the tracked player in the detail of a match.
 *
 * It is written in the detail only when the match is ranked (`match_mode` 4). It depends on the
 * match id alone, so that a test can know the badge the analysis must find without reading the
 * detail.
 *
 * @param matchId - The match.
 * @returns A badge `tier × 10 + subrank`, the tier from 1 to 11 and the subrank from 1 to 6.
 */
export function fixtureTrackedBadge(matchId: MatchId): number {
  return trackedBadgeOf(matchId);
}

/**
 * Invent the detail of a match of the synthetic history.
 *
 * The slot of the tracked player is `(match_id % 12) + 1`, whatever their team: slots 1 to 6 make
 * one team and 7 to 12 the other, and when the row's team is not the one of their half the two teams
 * swap numbers, so the teams always split six and six and every slot is used once.
 *
 * `row.match_duration_s` must be positive. The result is plain JSON data that the caller may
 * serialise as the body of a response.
 *
 * @param row - The history row of the match, for the tracked player.
 * @param accountId - The account of the tracked player. It must not be one of the invented accounts
 *   (from 2,000,001 up).
 * @returns The detail, in the raw shape of the API.
 */
export function createMatchMetadataFixture(row: RawMatchHistoryRow, accountId: AccountId): unknown {
  const random = createRandom(row.match_id);
  // The lanes, the badges and the totals the analysis reads come from their own generator, so that
  // adding or changing them never moves the figures drawn from `random`.
  const analysisRandom = createRandom(row.match_id ^ ANALYSIS_SEED);
  const durationS = row.match_duration_s;
  const seats = seatPlayers(random, analysisRandom, row, accountId);
  const timeline: Timeline = {
    deaths: createDeaths(random, row, seats),
    paths: seats.map((seat) => createPath(random, seat, durationS)),
    snapshotTimes: snapshotTimes(durationS),
  };
  // The items and the damage matrix have a generator of their own too. The `player_damage` of the
  // snapshots is read from the matrix, so the two always agree.
  const damage = createMatchDamage(createRandom(row.match_id ^ DAMAGE_SEED), seats, durationS);
  const players = seats.map((seat) =>
    createPlayer(random, analysisRandom, row, seat, timeline, damage),
  );
  const topThree = topThreeRanks(players);
  return {
    match_info: {
      match_id: row.match_id,
      start_time: row.start_time,
      duration_s: durationS,
      game_mode: row.game_mode,
      match_mode: row.match_mode,
      // The history row stores the winning team in `match_result`.
      winning_team: row.match_result,
      match_outcome: 0,
      // The API does not list the players by slot: neither does the fixture.
      players: shuffled(
        random,
        players.map((player) => ({
          ...player,
          mvp_rank: topThree.get(player.player_slot) ?? null,
        })),
      ),
      match_paths: {
        version: 1,
        interval_s: 1,
        x_resolution: MAP_RESOLUTION,
        y_resolution: MAP_RESOLUTION,
        paths: timeline.paths,
      },
      damage_matrix: damage.matrix,
    },
    hero_build_ids: [],
    pregame_hero_ids: seats.map((seat) => seat.heroId),
    banned_hero_ids: [],
  };
}

/**
 * Seat the twelve players: the tracked one in their slot, the others around them.
 *
 * Every player gets a lane (two per team in each lane, the tracked player like the others) and a
 * rank badge: the tracked player's one is {@link fixtureTrackedBadge}, the others are within a tier
 * of it, as the players of one ranked match are.
 *
 * @param random - The generator of the heroes.
 * @param analysisRandom - The generator of the lanes and of the badges.
 * @param row - The history row of the match.
 * @param accountId - The account of the tracked player.
 * @returns The twelve seats, ordered by slot.
 */
function seatPlayers(
  random: Random,
  analysisRandom: Random,
  row: RawMatchHistoryRow,
  accountId: AccountId,
): Seat[] {
  const trackedSlot = (row.match_id % SLOTS.length) + 1;
  // Slots 1 to 6 are one team and 7 to 12 the other. If the history row puts the tracked player in
  // the other team than the half of their slot, the two teams swap numbers.
  const halfOf = (slot: number) => (slot <= TEAM_SIZE ? 0 : 1);
  const swapped = halfOf(trackedSlot) !== row.player_team;
  const teamOf = (slot: number) => (swapped ? 1 - halfOf(slot) : halfOf(slot));

  const otherSlots = SLOTS.filter((slot) => slot !== trackedSlot);
  const teammateSlots = otherSlots.filter((slot) => teamOf(slot) === row.player_team);
  const opponentSlots = otherSlots.filter((slot) => teamOf(slot) !== row.player_team);

  // A hero is played once per team: the teammates leave the tracked hero out, the opponents may
  // play it (a mirror match).
  const playable = FIXTURE_HERO_CATALOGUE.filter(
    (hero) => hero.player_selectable && !hero.disabled && !hero.in_development,
  ).map((hero) => hero.id);
  const teammateHeroes = shuffled(random, playable).filter((heroId) => heroId !== row.hero_id);
  const opponentHeroes = shuffled(random, playable);

  const lanes = assignLanes(analysisRandom, teamOf);
  const trackedBadge = trackedBadgeOf(row.match_id);

  const otherSeat = (slot: number, heroId: number): Seat => ({
    slot,
    team: teamOf(slot),
    // The invented accounts go in the order of the slots.
    accountId: FIRST_OTHER_ACCOUNT_ID + otherSlots.indexOf(slot),
    heroId,
    tracked: false,
    lane: at(lanes, slot - 1),
    badge: nearbyBadge(analysisRandom, trackedBadge),
  });
  return [
    {
      slot: trackedSlot,
      team: row.player_team,
      accountId,
      heroId: row.hero_id,
      tracked: true,
      lane: at(lanes, trackedSlot - 1),
      badge: trackedBadge,
    },
    ...teammateSlots.map((slot, index) => otherSeat(slot, at(teammateHeroes, index))),
    ...opponentSlots.map((slot, index) => otherSeat(slot, at(opponentHeroes, index))),
  ].toSorted((first, second) => first.slot - second.slot);
}

/**
 * Assign a lane to each of the twelve slots: each team holds the lanes of {@link LANES}, in an
 * order of its own.
 *
 * @param random - The generator.
 * @param teamOf - The team of a slot.
 * @returns The lane of each slot, in the order of the slots (the lane of slot `n` is at `n - 1`).
 */
function assignLanes(random: Random, teamOf: (slot: number) => number): number[] {
  const laneOfSlot: number[] = [];
  for (const team of [0, 1]) {
    const lanes = shuffled(random, LANES);
    SLOTS.filter((slot) => teamOf(slot) === team).forEach((slot, index) => {
      laneOfSlot[slot - 1] = at(lanes, index);
    });
  }
  return laneOfSlot;
}

/**
 * The badge of the tracked player of a match, drawn from the match id alone.
 *
 * @param matchId - The match id.
 * @returns A badge `tier × 10 + subrank`, tier from 1 to 11, subrank from 1 to 6.
 */
function trackedBadgeOf(matchId: number): number {
  const random = createRandom(matchId ^ TRACKED_BADGE_SEED);
  return (
    between(random, MIN_TIER, MAX_TIER) * BADGE_TIER_FACTOR +
    between(random, MIN_SUBRANK, MAX_SUBRANK)
  );
}

/**
 * The badge of another player of the match: the tracked player's tier, or the one above or below it
 * (never outside the tiers there are), and any subrank.
 *
 * @param random - The generator.
 * @param trackedBadge - The badge of the tracked player.
 * @returns A badge `tier × 10 + subrank`.
 */
function nearbyBadge(random: Random, trackedBadge: number): number {
  const trackedTier = Math.floor(trackedBadge / BADGE_TIER_FACTOR);
  const tier = clamp(trackedTier + between(random, -1, 1), MIN_TIER, MAX_TIER);
  return tier * BADGE_TIER_FACTOR + between(random, MIN_SUBRANK, MAX_SUBRANK);
}

/**
 * Invent the deaths of the match, with their killers.
 *
 * The tracked player dies as often as their row says and kills as many players as it says: the
 * opponents die at least that often, and exactly `player_kills` of their deaths name them as the
 * killer. Every other death has a killer of the other team.
 *
 * @param random - The generator.
 * @param row - The history row of the match.
 * @param seats - The twelve seats.
 * @returns Every death of the match, in no particular order.
 */
function createDeaths(random: Random, row: RawMatchHistoryRow, seats: readonly Seat[]): Death[] {
  const tracked = at(
    seats.filter((seat) => seat.tracked),
    0,
  );
  const teamSeats = seats.filter((seat) => seat.team === tracked.team);
  const opponentSeats = seats.filter((seat) => seat.team !== tracked.team);
  const teammateSlots = teamSeats.filter((seat) => !seat.tracked).map((seat) => seat.slot);
  const opponentSlots = opponentSeats.map((seat) => seat.slot);
  const durationS = row.match_duration_s;

  const teamDeathCounts = teamSeats.map((seat) => ({
    slot: seat.slot,
    count: seat.tracked ? row.player_deaths : between(random, 2, 9),
  }));
  const opponentDeathCounts = opponentSeats.map((seat) => ({
    slot: seat.slot,
    count: between(random, 3, 9),
  }));
  // The tracked player cannot have killed more players than died on the other team: if the row says
  // so, the opponents die a little more, evenly.
  const opponentDeathTotal = opponentDeathCounts.reduce((total, { count }) => total + count, 0);
  const missingDeaths = Math.max(0, row.player_kills - opponentDeathTotal);
  const extraDeaths = Math.ceil(missingDeaths / opponentDeathCounts.length);

  // The deaths of the opponents are shuffled, then the first ones are the kills of the tracked
  // player and the others are shared among their teammates.
  const opponentDeaths = shuffled(
    random,
    opponentDeathCounts.flatMap(({ slot, count }) =>
      deathTimes(random, count + extraDeaths, durationS).map((timeS) => ({ victim: slot, timeS })),
    ),
  ).map((death, index): Death => ({
    ...death,
    killer: index < row.player_kills ? tracked.slot : pick(random, teammateSlots),
  }));
  const teamDeaths = teamDeathCounts.flatMap(({ slot, count }) =>
    deathTimes(random, count, durationS).map((timeS): Death => ({
      victim: slot,
      killer: pick(random, opponentSlots),
      timeS,
    })),
  );
  return [...opponentDeaths, ...teamDeaths];
}

/**
 * The times at which one player dies.
 *
 * They are spread over the match, one in each of equal slices of time, so that a player never dies
 * again before they have respawned.
 *
 * @param random - The generator.
 * @param count - Number of deaths.
 * @param durationS - Length of the match, in seconds.
 * @returns The times in ascending order, in seconds since the match start; all inside the match.
 */
function deathTimes(random: Random, count: number, durationS: number): number[] {
  const spanS = Math.max(count, durationS - 2 * FIRST_DEATH_S);
  const sliceS = Math.floor(spanS / Math.max(count, 1));
  // A death falls in the first part of its slice, leaving room for the respawn before the next one.
  const slackS = Math.max(0, sliceS - MAX_RESPAWN_S - 10);
  return Array.from({ length: count }, (_, index) =>
    Math.min(durationS - 1, FIRST_DEATH_S + index * sliceS + between(random, 0, slackS)),
  );
}

/**
 * The times of the `stats` snapshots: 180, 360, 540, 720 and 900 s, then every 300 s, and one at
 * the end of the match.
 *
 * @param durationS - Length of the match, in seconds.
 * @returns The times in ascending order; the last one is `durationS`.
 */
function snapshotTimes(durationS: number): number[] {
  const times = EARLY_SNAPSHOTS_S.filter((timeS) => timeS < durationS);
  const lastEarlyS = at(EARLY_SNAPSHOTS_S, EARLY_SNAPSHOTS_S.length - 1);
  for (
    let timeS = lastEarlyS + LATE_SNAPSHOT_STEP_S;
    timeS < durationS;
    timeS += LATE_SNAPSHOT_STEP_S
  ) {
    times.push(timeS);
  }
  // The end of the match is always the last snapshot, and never appears twice.
  times.push(durationS);
  return times;
}

/**
 * Invent the movement path of one player: a position every second, from second 0 to the end of the
 * match (`duration_s + 1` positions).
 *
 * The player starts in the base of their team and wanders around it with some inertia.
 *
 * @param random - The generator.
 * @param seat - The player.
 * @param durationS - Length of the match, in seconds.
 * @returns The path in the shape of the API's `match_paths.paths[]` (without the arrays it does not
 *   need).
 */
function createPath(random: Random, seat: Seat, durationS: number) {
  const baseOffset = seat.team === 0 ? 30 : MAP_RESOLUTION - 30;
  let x = baseOffset + between(random, -8, 8);
  let y = baseOffset + between(random, -8, 8);
  let speedX = 0;
  let speedY = 0;
  const xPos: number[] = [];
  const yPos: number[] = [];
  for (let second = 0; second <= durationS; second += 1) {
    xPos.push(x);
    yPos.push(y);
    speedX = clamp(speedX + between(random, -1, 1), -3, 3);
    speedY = clamp(speedY + between(random, -1, 1), -3, 3);
    x = clamp(x + speedX, 0, MAP_RESOLUTION);
    y = clamp(y + speedY, 0, MAP_RESOLUTION);
  }
  return {
    player_slot: seat.slot,
    x_min: -MAP_HALF_SIZE,
    x_max: MAP_HALF_SIZE,
    y_min: -MAP_HALF_SIZE,
    y_max: MAP_HALF_SIZE,
    x_pos: xPos,
    y_pos: yPos,
  };
}

/**
 * Where a player was at a time, in game units.
 *
 * @param path - Their movement path.
 * @param timeS - Seconds since the match start; inside the match.
 * @returns The decoded position (the fixture map is flat, `z` is 0).
 */
function positionAt(path: Path, timeS: number): { x: number; y: number; z: number } {
  const decode = (position: number) =>
    Math.round(-MAP_HALF_SIZE + (position / MAP_RESOLUTION) * 2 * MAP_HALF_SIZE);
  return { x: decode(at(path.x_pos, timeS)), y: decode(at(path.y_pos, timeS)), z: 0 };
}

/**
 * Invent one player of the match.
 *
 * The kills and deaths of every player are read from the death ledger; for the tracked player the
 * ledger was built to agree with their history row. Their assists, net worth, last hits, denies and
 * level come from the row too. Their lane and their badge come from their seat (the badge only in a
 * ranked match). Their items come from the damage ledger of the match, and so does the
 * `player_damage` of their snapshots. Everything else is invented.
 *
 * @param random - The generator.
 * @param analysisRandom - The generator of the totals that only the analysis reads.
 * @param row - The history row of the match.
 * @param seat - The player.
 * @param timeline - The deaths, the paths and the snapshot times of the match.
 * @param damage - The items and the damage of the match.
 * @returns The player in the raw shape of the API, without their `mvp_rank` (see
 *   {@link topThreeRanks}).
 */
function createPlayer(
  random: Random,
  analysisRandom: Random,
  row: RawMatchHistoryRow,
  seat: Seat,
  timeline: Timeline,
  damage: MatchDamage,
) {
  const { deaths, paths } = timeline;
  const durationS = row.match_duration_s;
  const totals: Totals = {
    level: between(random, 20, 36),
    assists: between(random, 2, 25),
    netWorth: between(random, 15_000, 60_000),
    lastHits: between(random, 60, 300),
    denies: between(random, 0, 40),
    damageTaken: between(random, 15_000, 55_000),
    healing: between(random, 0, 15_000),
    ...createAnalysisTotals(analysisRandom),
    // The tracked player has the numbers of their history row, whatever was invented above.
    ...(seat.tracked
      ? {
          level: row.hero_level,
          assists: row.player_assists,
          netWorth: row.net_worth,
          lastHits: row.last_hits,
          denies: row.denies,
        }
      : {}),
  };
  const ownDeaths = deaths
    .filter((death) => death.victim === seat.slot)
    .toSorted((first, second) => first.timeS - second.timeS);
  const kills = deaths.filter((death) => death.killer === seat.slot).length;

  return {
    account_id: seat.accountId,
    player_slot: seat.slot,
    team: seat.team,
    hero_id: seat.heroId,
    level: totals.level,
    party: 0,
    kills,
    deaths: ownDeaths.length,
    assists: totals.assists,
    net_worth: totals.netWorth,
    last_hits: totals.lastHits,
    denies: totals.denies,
    abandon_match_time_s: 0,
    assigned_lane: seat.lane,
    // Like the API: the rank data of a match that is not ranked is `null`.
    player_rank_data:
      row.match_mode === RANKED_MATCH_MODE ? { initial_display_rank: seat.badge } : null,
    stats: createStats(seat, totals, deaths, timeline.snapshotTimes, durationS, (timeS) =>
      damage.damageAt(seat.slot, timeS),
    ),
    items: damage.itemsOf(seat.slot),
    death_details: ownDeaths.map((death) => ({
      game_time_s: death.timeS,
      killer_player_slot: death.killer,
      death_pos: positionAt(at(paths, seat.slot - 1), death.timeS),
      killer_pos: positionAt(at(paths, death.killer - 1), death.timeS),
      // The wait grows with the match, up to the longest respawn.
      death_duration_s: Math.min(MAX_RESPAWN_S, 10 + Math.floor(death.timeS / 60)),
    })),
  };
}

/**
 * The cumulative statistics of one player at the snapshot times.
 *
 * Kills and deaths are counted in the ledger up to each time; the damage to heroes is the one the
 * damage matrix has reached; the other figures grow towards the player's final numbers. At the end
 * of the match every figure is the final one.
 *
 * @param seat - The player.
 * @param totals - Their final numbers.
 * @param deaths - Every death of the match.
 * @param times - The snapshot times.
 * @param durationS - Length of the match, in seconds.
 * @param damageAt - The damage the player had dealt to enemy heroes at a time.
 * @returns One snapshot per time, in the shape of the API's `stats[]`.
 */
function createStats(
  seat: Seat,
  totals: Totals,
  deaths: readonly Death[],
  times: readonly number[],
  durationS: number,
  damageAt: (timeS: number) => number,
) {
  return times.map((timeS) => {
    const fraction = timeS / durationS;
    const happened = (death: Death) => death.timeS <= timeS;
    return {
      time_stamp_s: timeS,
      // Souls come faster late in the match.
      net_worth: Math.round(totals.netWorth * fraction ** 1.1),
      kills: deaths.filter((death) => death.killer === seat.slot && happened(death)).length,
      deaths: deaths.filter((death) => death.victim === seat.slot && happened(death)).length,
      assists: Math.round(totals.assists * fraction),
      creep_kills: Math.round(totals.lastHits * fraction),
      denies: Math.round(totals.denies * fraction),
      player_damage: damageAt(timeS),
      player_damage_taken: Math.round(totals.damageTaken * fraction),
      player_healing: Math.round(totals.healing * fraction),
      // Objectives fall late in the match, like souls.
      boss_damage: Math.round(totals.bossDamage * fraction ** 1.4),
      shots_hit: Math.round(totals.shotsHit * fraction),
      shots_missed: Math.round(totals.shotsMissed * fraction),
      teammate_healing: Math.round(totals.teammateHealing * fraction),
      teammate_barriering: Math.round(totals.teammateBarriering * fraction),
      max_health: 650 + Math.round(fraction * 1_350),
    };
  });
}

/**
 * Invent the final numbers of a player that only the match analysis reads.
 *
 * About half of the shots hit (35 to 65 %), so that the accuracy of every player is plausible.
 *
 * @param random - The generator.
 * @returns The final damage to objectives, shots and support given to teammates.
 */
function createAnalysisTotals(random: Random): AnalysisTotals {
  const shotsFired = between(random, 400, 1_500);
  const shotsHit = Math.round(shotsFired * (0.35 + 0.3 * random()));
  return {
    bossDamage: between(random, 3_000, 40_000),
    shotsHit,
    shotsMissed: shotsFired - shotsHit,
    teammateHealing: between(random, 0, 10_000),
    teammateBarriering: between(random, 0, 8_000),
  };
}

/** A player of the detail, as {@link topThreeRanks} reads them. */
type Player = ReturnType<typeof createPlayer>;

/** What each kill, assist and death is worth to the score that ranks the players of a match. */
const KILL_SCORE = 3;
const ASSIST_SCORE = 1;
const DEATH_SCORE = -2;

/** The damage to heroes that is worth one point of that score. */
const DAMAGE_PER_SCORE_POINT = 2_000;

/** How many players Valve ranks: the first, the second and the third. */
const RANKED_PLAYERS = 3;

/**
 * Rank the three best players of the match, as `mvp_rank` does: 1, 2 and 3, on any team.
 *
 * The best are the players with the best game, by a score made of what is in the detail (kills,
 * assists, deaths and the damage dealt to heroes); a tie goes to the lowest slot, so that the top
 * three is always three players and depends on nothing but the detail.
 *
 * @param players - The twelve players.
 * @returns The rank (1 to 3) of the three best, by slot. The nine others are not in the map.
 */
function topThreeRanks(players: readonly Player[]): ReadonlyMap<number, number> {
  const scored = players.map((player) => ({
    slot: player.player_slot,
    score:
      KILL_SCORE * player.kills +
      ASSIST_SCORE * player.assists +
      DEATH_SCORE * player.deaths +
      (player.stats.at(-1)?.player_damage ?? 0) / DAMAGE_PER_SCORE_POINT,
  }));
  return new Map(
    scored
      .toSorted((first, second) => second.score - first.score || first.slot - second.slot)
      .slice(0, RANKED_PLAYERS)
      .map(({ slot }, index): [number, number] => [slot, index + 1]),
  );
}

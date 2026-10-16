/**
 * Synthetic match details served by the development HTTP client.
 *
 * No real player's match is ever committed: this generator invents the detail of a match of the
 * synthetic history (`match-history.fixture.ts`), in the shape of deadlock-api's
 * `GET /v1/matches/{match_id}/metadata`. It is deterministic, seeded by the match id only (no
 * `Math.random`, no clock): the same row always gives the same detail, so tests can rely on it.
 *
 * What the detail holds:
 * - twelve players, six per team, each in his own slot (1 to 12). The tracked player is in the slot
 *   `(match_id % 12) + 1` with the hero, the team, the kills, deaths, assists and net worth of his
 *   history row. The eleven others are invented accounts (from 2,000,001 up) playing the heroes of
 *   the fixture catalogue;
 * - for every player: the cumulative `stats` snapshots, his `items` (purchases and ability
 *   upgrades) and his `death_details`;
 * - `match_paths`: one path per player with a position every second;
 * - `damage_matrix`: one dealer per player, plus the non-player dealer (slot 0).
 *
 * The deaths form one ledger (who killed whom, when) from which the deaths, the kills and the
 * `death_details` of all the players are read, so the numbers of the match agree with each other.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../../../core/domain/account';
import type { MatchId } from '../../../core/domain/match';
import { FIXTURE_HERO_CATALOGUE } from './heroes.fixture';
import type { RawMatchHistoryRow } from './match-history.fixture';

/** A function returning pseudo-random numbers in [0, 1). */
type Random = () => number;

/** One of the twelve seats of a match: who sits in a slot. */
interface Seat {
  /** The slot, from 1 to 12: the key of his path and of his damage in the detail. */
  readonly slot: number;
  /** The team (0 or 1). */
  readonly team: number;
  readonly accountId: number;
  readonly heroId: number;
  /** `true` for the tracked player, the one of the history row. */
  readonly tracked: boolean;
}

/** One death of the match: who died, who killed him, and when. */
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

/** The final numbers of one player, from which his snapshots are interpolated. */
interface Totals {
  readonly level: number;
  readonly assists: number;
  readonly netWorth: number;
  readonly lastHits: number;
  readonly denies: number;
  readonly playerDamage: number;
  readonly damageTaken: number;
  readonly healing: number;
}

/** The slots of a match: 1 to 12, as the API numbers them. */
const SLOTS = Array.from({ length: 12 }, (_, index) => index + 1);

/** The slot of the damage dealer that is not a player (neutral creeps, objectives…). */
const NON_PLAYER_SLOT = 0;

/** Number of players of each team. */
const TEAM_SIZE = 6;

/** Account id of the first synthetic player (the other ten follow). */
const FIRST_OTHER_ACCOUNT_ID = 2_000_001;

/** A match id that is a multiple of this has no detail: "the API never received this match". */
const MISSING_MATCH_MODULO = 7;

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
 * Items a player may buy. The ids are invented; like the real ones they are unsigned 32-bit
 * numbers, and several are above 2^31 so that code reading them must not assume signed integers.
 */
const ITEM_IDS = [
  380_000_101, 1_437_000_202, 2_500_000_303, 3_100_000_404, 4_200_000_505, 512_000_606,
  2_900_000_707, 3_800_000_808,
];

/** The four abilities of a hero, whose upgrades appear in the `items` of a player. Invented ids. */
const ABILITY_IDS = [610_000_011, 610_000_022, 610_000_033, 610_000_044];

/** Where the damage comes from: a source of the damage matrix refers to one of them by index. */
const DAMAGE_SOURCE_NAMES = ['weapon', 'ability_1', 'ability_2', 'neutral_creeps'];

/** Index in {@link DAMAGE_SOURCE_NAMES} of each source the fixture uses. */
const DAMAGE_SOURCE = { weapon: 0, firstAbility: 1, secondAbility: 2, creeps: 3 } as const;

/**
 * A small deterministic pseudo-random generator (mulberry32): a detail must be the same at every
 * run, which `Math.random()` cannot guarantee. Same algorithm as `match-history.fixture.ts`.
 *
 * @param seed - Any 32-bit integer.
 * @returns A function returning numbers in [0, 1).
 */
function createRandom(seed: number): Random {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A pseudo-random whole number.
 *
 * @param random - The generator.
 * @param min - Smallest value.
 * @param max - Largest value (included).
 * @returns A whole number from `min` to `max`.
 */
function between(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

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
 * A pseudo-random item of a list.
 *
 * @param random - The generator.
 * @param items - A list that is not empty.
 * @returns One of its items.
 */
function pick<T>(random: Random, items: readonly T[]): T {
  return at(items, between(random, 0, items.length - 1));
}

/**
 * A shuffled copy of a list.
 *
 * @param random - The generator.
 * @param items - The list; it is not modified.
 * @returns The same items in a pseudo-random order.
 */
function shuffled<T>(random: Random, items: readonly T[]): T[] {
  // Sorting on a random key per item is a fair shuffle as long as the keys are distinct.
  return items
    .map((item) => ({ item, key: random() }))
    .sort((first, second) => first.key - second.key)
    .map(({ item }) => item);
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
 * Invent the detail of a match of the synthetic history.
 *
 * The slot of the tracked player is `(match_id % 12) + 1`, whatever his team: slots 1 to 6 make one
 * team and 7 to 12 the other, and when the row's team is not the one of his half the two teams swap
 * numbers, so the teams always split six and six and every slot is used once.
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
  const durationS = row.match_duration_s;
  const seats = seatPlayers(random, row, accountId);
  const timeline: Timeline = {
    deaths: createDeaths(random, row, seats),
    paths: seats.map((seat) => createPath(random, seat, durationS)),
    snapshotTimes: snapshotTimes(durationS),
  };
  const players = seats.map((seat) => createPlayer(random, row, seat, timeline));
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
      players: shuffled(random, players),
      match_paths: {
        version: 1,
        interval_s: 1,
        x_resolution: MAP_RESOLUTION,
        y_resolution: MAP_RESOLUTION,
        paths: timeline.paths,
      },
      damage_matrix: createDamageMatrix(random, seats, timeline.snapshotTimes),
    },
    hero_build_ids: [],
    pregame_hero_ids: seats.map((seat) => seat.heroId),
    banned_hero_ids: [],
  };
}

/**
 * Seat the twelve players: the tracked one in his slot, the others around him.
 *
 * @param random - The generator.
 * @param row - The history row of the match.
 * @param accountId - The account of the tracked player.
 * @returns The twelve seats, ordered by slot.
 */
function seatPlayers(random: Random, row: RawMatchHistoryRow, accountId: AccountId): Seat[] {
  const trackedSlot = (row.match_id % SLOTS.length) + 1;
  // Slots 1 to 6 are one team and 7 to 12 the other. If the history row puts the tracked player in
  // the other team than the half of his slot, the two teams swap numbers.
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

  const otherSeat = (slot: number, heroId: number): Seat => ({
    slot,
    team: teamOf(slot),
    // The invented accounts go in the order of the slots.
    accountId: FIRST_OTHER_ACCOUNT_ID + otherSlots.indexOf(slot),
    heroId,
    tracked: false,
  });
  return [
    { slot: trackedSlot, team: row.player_team, accountId, heroId: row.hero_id, tracked: true },
    ...teammateSlots.map((slot, index) => otherSeat(slot, at(teammateHeroes, index))),
    ...opponentSlots.map((slot, index) => otherSeat(slot, at(opponentHeroes, index))),
  ].toSorted((first, second) => first.slot - second.slot);
}

/**
 * Invent the deaths of the match, with their killers.
 *
 * The tracked player dies as often as his row says and kills as many players as it says: the
 * opponents die at least that often, and exactly `player_kills` of their deaths name him as the
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
  // player and the others are shared among his teammates.
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
 * again before he has respawned.
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
 * The player starts in the base of his team and wanders around it with some inertia.
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
 * @param path - His movement path.
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
 * ledger was built to agree with his history row. His assists, net worth, last hits, denies and
 * level come from the row too. Everything else is invented.
 *
 * @param random - The generator.
 * @param row - The history row of the match.
 * @param seat - The player.
 * @param timeline - The deaths, the paths and the snapshot times of the match.
 * @returns The player in the raw shape of the API.
 */
function createPlayer(random: Random, row: RawMatchHistoryRow, seat: Seat, timeline: Timeline) {
  const { deaths, paths } = timeline;
  const durationS = row.match_duration_s;
  const totals: Totals = {
    level: between(random, 20, 36),
    assists: between(random, 2, 25),
    netWorth: between(random, 15_000, 60_000),
    lastHits: between(random, 60, 300),
    denies: between(random, 0, 40),
    playerDamage: between(random, 15_000, 60_000),
    damageTaken: between(random, 15_000, 55_000),
    healing: between(random, 0, 15_000),
    // The tracked player has the numbers of his history row, whatever was invented above.
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
    stats: createStats(seat, totals, deaths, timeline.snapshotTimes, durationS),
    items: createItems(random, durationS),
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
 * Kills and deaths are counted in the ledger up to each time; the other figures grow towards the
 * player's final numbers. At the end of the match every figure is the final one.
 *
 * @param seat - The player.
 * @param totals - His final numbers.
 * @param deaths - Every death of the match.
 * @param times - The snapshot times.
 * @param durationS - Length of the match, in seconds.
 * @returns One snapshot per time, in the shape of the API's `stats[]`.
 */
function createStats(
  seat: Seat,
  totals: Totals,
  deaths: readonly Death[],
  times: readonly number[],
  durationS: number,
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
      player_damage: Math.round(totals.playerDamage * fraction),
      player_damage_taken: Math.round(totals.damageTaken * fraction),
      player_healing: Math.round(totals.healing * fraction),
      max_health: 650 + Math.round(fraction * 1_350),
    };
  });
}

/**
 * Invent the `items` of a player: the items he bought (some sold again later) and the upgrades of
 * his abilities. Only the upgrades carry an `upgrade_id`.
 *
 * @param random - The generator.
 * @param durationS - Length of the match, in seconds.
 * @returns The entries, in the order they happened.
 */
function createItems(random: Random, durationS: number) {
  const lastTimeS = Math.max(30, durationS - 30);
  const purchases = Array.from({ length: between(random, 6, 12) }, () => {
    const boughtS = between(random, 30, lastTimeS);
    // About one item in six is sold again, between one and ten minutes after it was bought.
    const sold = random() < 1 / 6;
    return {
      game_time_s: boughtS,
      item_id: pick(random, ITEM_IDS),
      sold_time_s: sold ? Math.min(durationS, boughtS + between(random, 60, 600)) : 0,
    };
  });
  const upgrades = ABILITY_IDS.flatMap((abilityId) =>
    Array.from({ length: between(random, 1, 3) }, (_, level) => ({
      game_time_s: between(random, 30, lastTimeS),
      item_id: abilityId,
      sold_time_s: 0,
      upgrade_id: level + 1,
    })),
  );
  return [...purchases, ...upgrades].toSorted(
    (first, second) => first.game_time_s - second.game_time_s,
  );
}

/**
 * Invent the damage matrix: who damaged whom, from which source, over time.
 *
 * Every player is a dealer. His weapon hits all the players of the other team and the non-player
 * target (slot 0); each of his two abilities hits three of them. The non-player dealer (slot 0)
 * hits everybody. The damage is cumulative: one value per sample time, never decreasing.
 *
 * @param random - The generator.
 * @param seats - The twelve seats.
 * @param sampleTimes - The times of the samples, in seconds.
 * @returns The matrix in the shape of the API's `damage_matrix`.
 */
function createDamageMatrix(
  random: Random,
  seats: readonly Seat[],
  sampleTimes: readonly number[],
) {
  const playerDealers = seats.map((seat) => {
    const opponentSlots = seats
      .filter((other) => other.team !== seat.team)
      .map((other) => other.slot);
    const someOpponents = () =>
      shuffled(random, opponentSlots)
        .slice(0, 3)
        .toSorted((first, second) => first - second);
    return {
      dealer_player_slot: seat.slot,
      damage_sources: [
        damageSource(
          random,
          DAMAGE_SOURCE.weapon,
          [...opponentSlots, NON_PLAYER_SLOT],
          sampleTimes,
          [20, 60],
        ),
        damageSource(random, DAMAGE_SOURCE.firstAbility, someOpponents(), sampleTimes, [5, 30]),
        damageSource(random, DAMAGE_SOURCE.secondAbility, someOpponents(), sampleTimes, [5, 30]),
      ],
    };
  });
  const creepsDealer = {
    dealer_player_slot: NON_PLAYER_SLOT,
    damage_sources: [damageSource(random, DAMAGE_SOURCE.creeps, SLOTS, sampleTimes, [1, 8])],
  };
  return {
    sample_time_s: sampleTimes,
    // All the sources deal damage (type 0).
    source_details: {
      stat_type: DAMAGE_SOURCE_NAMES.map(() => 0),
      source_name: DAMAGE_SOURCE_NAMES,
    },
    damage_dealers: [creepsDealer, ...playerDealers],
  };
}

/**
 * One damage source of a dealer.
 *
 * @param random - The generator.
 * @param sourceIndex - Index of the source in {@link DAMAGE_SOURCE_NAMES}.
 * @param targetSlots - The slots it hit.
 * @param sampleTimes - The times of the samples, in seconds.
 * @param rangePerSecond - The smallest and the largest damage per second on one target.
 * @returns The source in the shape of the API's `damage_sources[]`.
 */
function damageSource(
  random: Random,
  sourceIndex: number,
  targetSlots: readonly number[],
  sampleTimes: readonly number[],
  rangePerSecond: readonly [number, number],
) {
  return {
    source_details_index: sourceIndex,
    damage_to_players: targetSlots.map((targetSlot) => ({
      target_player_slot: targetSlot,
      damage: cumulativeSeries(
        random,
        sampleTimes,
        between(random, rangePerSecond[0], rangePerSecond[1]),
      ),
    })),
  };
}

/**
 * A running total sampled at some times.
 *
 * @param random - The generator, for the irregularity of each interval.
 * @param times - The sample times, in seconds, in ascending order.
 * @param perSecond - The average amount added per second.
 * @returns One total per time; never decreasing.
 */
function cumulativeSeries(random: Random, times: readonly number[], perSecond: number): number[] {
  let total = 0;
  let previousS = 0;
  return times.map((timeS) => {
    // Each interval adds between half and one and a half times the average.
    total += Math.round(perSecond * (timeS - previousS) * (0.5 + random()));
    previousS = timeS;
    return total;
  });
}

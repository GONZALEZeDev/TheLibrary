/**
 * Tests of the phases of a match: where each phase starts and ends for a match of a given length,
 * and what a player did in each phase (souls, damage to heroes, damage to objectives, kills) next to
 * what their team did.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: a phase table only needs
 * the players' snapshots and the kills, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { present, testMatchContext, testPlayer, testSnapshot } from '../../test/analysis-context';
import type {
  KillEvent,
  MatchContext,
  PlayerContext,
  Snapshot,
  SnapshotStat,
} from './match-context';
import {
  PHASE_START_S,
  PHASE_STATS,
  PHASES,
  phaseBreakdown,
  phaseSpans,
  phaseTotal,
} from './phases';
import type { PhaseSpan } from './phases';

/** The slot of the tracked player: team 0 (slots 1 to 6). */
const TRACKED_SLOT = 3;

/** The slots of the tracked player's teammates. */
const TEAMMATE_SLOTS = [1, 2, 4, 5, 6];

/** The slots of the enemies (team 1). */
const ENEMY_SLOTS = [7, 8, 9, 10, 11, 12];

/** The length of the hand-built match: 30 minutes, so that all three phases are reached. */
const DURATION_S = 1_800;

/**
 * Build a player of a hand-built match.
 *
 * @param slot - Their slot, from 1 to 12.
 * @param snapshots - Their statistic snapshots, sorted by time.
 * @returns The player (a team of six per half: slots 1 to 6 are team 0).
 */
function player(slot: number, snapshots: readonly Snapshot[] = []): PlayerContext {
  return testPlayer({ slot, team: slot <= 6 ? 0 : 1, snapshots });
}

/**
 * Build the snapshots of a player at the end of the early phase, of the mid phase and of the match.
 *
 * Only souls, damage to heroes and damage to objectives are given: those are the counters a phase
 * reads. The numbers are cumulative, like the ones of the API.
 *
 * @param early - The counters at 10:00.
 * @param mid - The counters at 25:00.
 * @param end - The counters at the end of the match.
 * @returns The three snapshots.
 */
function threeSnapshots(
  early: Partial<Record<SnapshotStat, number>>,
  mid: Partial<Record<SnapshotStat, number>>,
  end: Partial<Record<SnapshotStat, number>>,
): readonly Snapshot[] {
  return [testSnapshot(600, early), testSnapshot(1_500, mid), testSnapshot(DURATION_S, end)];
}

/**
 * Build the context of a hand-built match.
 *
 * @param options - The tracked player, their teammates and the kills (none when left out, `null`
 *   for kills that are unknown); the enemies are six players with huge numbers, so that a team
 *   total that counted them would be wrong.
 * @returns The match context.
 */
function matchContext(options: {
  readonly tracked: PlayerContext;
  readonly teammates: readonly PlayerContext[];
  readonly kills?: readonly KillEvent[] | null;
  readonly durationS?: number;
}): MatchContext {
  const enemySnapshots = threeSnapshots(
    { net_worth: 90_000, player_damage: 90_000, boss_damage: 90_000 },
    { net_worth: 190_000, player_damage: 190_000, boss_damage: 190_000 },
    { net_worth: 290_000, player_damage: 290_000, boss_damage: 290_000 },
  );
  return testMatchContext({
    durationS: options.durationS ?? DURATION_S,
    tracked: options.tracked,
    teammates: options.teammates,
    enemies: ENEMY_SLOTS.map((slot) => player(slot, enemySnapshots)),
    // `??` would turn unknown kills (`null`) into no kill at all.
    kills: options.kills === undefined ? [] : options.kills,
  });
}

/**
 * Build one kill.
 *
 * @param timeS - When the victim died, in seconds.
 * @param killerSlot - The slot of the killer.
 * @returns The kill (the victim is the first slot of the other team).
 */
function kill(timeS: number, killerSlot: number): KillEvent {
  return { timeS, killerSlot, victimSlot: killerSlot <= 6 ? 7 : 1 };
}

describe('phaseSpans', () => {
  it('starts the phases at 0:00, 10:00 and 25:00', () => {
    expect(PHASES).toEqual(['early', 'mid', 'late']);
    expect(PHASE_START_S).toEqual({ early: 0, mid: 600, late: 1_500 });
  });

  it('spans of a 9, 24, 25:30 and 70-minute match', () => {
    expect(phaseSpans(540).map((span) => [span.phase, span.endS, span.comparable])).toEqual([
      ['early', 540, true],
    ]);
    expect(phaseSpans(1_440).map((span) => span.phase)).toEqual(['early', 'mid']);
    expect(phaseSpans(1_530).at(-1)).toMatchObject({
      phase: 'late',
      minutes: 0.5,
      comparable: false,
    });
    expect(phaseSpans(4_200).at(-1)).toMatchObject({ phase: 'late', startS: 1_500, endS: 4_200 });
  });

  it('ends every phase but the last one where the next phase starts', () => {
    expect(
      phaseSpans(4_200).map((span) => [span.phase, span.startS, span.endS, span.minutes]),
    ).toEqual([
      ['early', 0, 600, 10],
      ['mid', 600, 1_500, 15],
      ['late', 1_500, 4_200, 45],
    ]);
  });

  it('does not reach a phase that starts exactly when the match ends', () => {
    expect(phaseSpans(600).map((span) => span.phase)).toEqual(['early']);
    expect(phaseSpans(601).map((span) => span.phase)).toEqual(['early', 'mid']);
    expect(phaseSpans(1_500).map((span) => span.phase)).toEqual(['early', 'mid']);
    expect(phaseSpans(1_501).map((span) => span.phase)).toEqual(['early', 'mid', 'late']);
  });

  it('marks a phase shorter than three minutes as not comparable', () => {
    // The early phase of a match is as long as the match itself when it is short.
    expect(phaseSpans(180)).toMatchObject([{ phase: 'early', minutes: 3, comparable: true }]);
    expect(phaseSpans(179)).toMatchObject([{ phase: 'early', comparable: false }]);
    // The mid phase of a match that lasts a minute past 10:00.
    expect(phaseSpans(660).at(-1)).toMatchObject({ phase: 'mid', minutes: 1, comparable: false });
    expect(phaseSpans(780).at(-1)).toMatchObject({ phase: 'mid', minutes: 3, comparable: true });
  });

  it('has no phase for a match that has not started', () => {
    expect(phaseSpans(0)).toEqual([]);
  });
});

describe('phaseTotal', () => {
  const tracked = player(
    TRACKED_SLOT,
    threeSnapshots(
      { net_worth: 7_000, player_damage: 3_000, boss_damage: 0 },
      { net_worth: 20_000, player_damage: 15_000, boss_damage: 1_000 },
      { net_worth: 26_000, player_damage: 20_000, boss_damage: 2_000 },
    ),
  );
  const context = matchContext({
    tracked,
    teammates: [],
    kills: [
      kill(100, TRACKED_SLOT),
      kill(599, TRACKED_SLOT),
      kill(600, TRACKED_SLOT),
      kill(1_800, TRACKED_SLOT),
      kill(300, 1),
    ],
  });

  it('is the growth of the counter between the start and the end of the phase', () => {
    // The match starts with every counter at 0: the early phase is worth the value at 10:00.
    expect(phaseTotal(context, tracked, 'souls', 0, 600)).toBe(7_000);
    expect(phaseTotal(context, tracked, 'souls', 600, 1_500)).toBe(13_000);
    expect(phaseTotal(context, tracked, 'souls', 1_500, 1_800)).toBe(6_000);
  });

  it('reads the counter of each stat', () => {
    expect(phaseTotal(context, tracked, 'hero_damage', 600, 1_500)).toBe(12_000);
    expect(phaseTotal(context, tracked, 'objective_damage', 600, 1_500)).toBe(1_000);
    expect(phaseTotal(context, tracked, 'objective_damage', 0, 600)).toBe(0);
  });

  it('interpolates between the snapshots for a time that has none', () => {
    // Halfway between the snapshots of 25:00 and of the end of the match.
    expect(phaseTotal(context, tracked, 'souls', 1_500, 1_650)).toBe(3_000);
  });

  it('counts the kills of the player, with the end of the match included', () => {
    expect(phaseTotal(context, tracked, 'kills', 0, 600)).toBe(2);
    // The kill at 10:00 sharp belongs to the phase that starts there.
    expect(phaseTotal(context, tracked, 'kills', 600, 1_500)).toBe(1);
    // The kill of the last second belongs to the phase that ends with the match.
    expect(phaseTotal(context, tracked, 'kills', 1_500, DURATION_S)).toBe(1);
  });

  it('is null when a counter is unknown at the start or at the end of the phase', () => {
    const early = player(TRACKED_SLOT, [testSnapshot(600, { net_worth: 7_000 })]);
    const earlyContext = matchContext({ tracked: early, teammates: [] });
    // No snapshot after 10:00: the end of the mid phase is unknown, so is the whole phase.
    expect(phaseTotal(earlyContext, early, 'souls', 600, 1_500)).toBeNull();
    // The counter is in no snapshot at all.
    expect(phaseTotal(earlyContext, early, 'hero_damage', 0, 600)).toBeNull();
    // A player with no snapshot has no totals, but their kills are known.
    const bare = player(TRACKED_SLOT);
    expect(phaseTotal(earlyContext, bare, 'souls', 0, 600)).toBeNull();
    expect(phaseTotal(earlyContext, bare, 'kills', 0, 600)).toBe(0);
  });

  it('is null for the kills when the kills of the match are unknown, never 0', () => {
    const unknownKills = matchContext({ tracked, teammates: [], kills: null });

    expect(phaseTotal(unknownKills, tracked, 'kills', 0, 600)).toBeNull();
    expect(phaseTotal(unknownKills, tracked, 'kills', 1_500, DURATION_S)).toBeNull();
    // The counters do not depend on the kills.
    expect(phaseTotal(unknownKills, tracked, 'souls', 0, 600)).toBe(7_000);
  });
});

describe('phaseBreakdown', () => {
  /** A teammate with the given souls at 10:00 and 25:00, and the same damage as every other one. */
  function uniformPlayer(slot: number, earlySouls: number, midSouls: number): PlayerContext {
    return player(
      slot,
      threeSnapshots(
        { net_worth: earlySouls, player_damage: 1_500, boss_damage: 0 },
        { net_worth: midSouls, player_damage: 6_000, boss_damage: 0 },
        { net_worth: midSouls + 6_000, player_damage: 9_000, boss_damage: 0 },
      ),
    );
  }

  const tracked = player(
    TRACKED_SLOT,
    threeSnapshots(
      { net_worth: 7_000, player_damage: 3_000, boss_damage: 0 },
      { net_worth: 20_000, player_damage: 15_000, boss_damage: 1_000 },
      { net_worth: 26_000, player_damage: 20_000, boss_damage: 1_000 },
    ),
  );
  // Five teammates with 7,000 souls at 10:00 each: the team has 42,000. One of them is richer at
  // 25:00, so that the mid share is not the same as the early one.
  const teammates = TEAMMATE_SLOTS.map((slot) =>
    slot === 1 ? uniformPlayer(slot, 7_000, 32_000) : uniformPlayer(slot, 7_000, 20_000),
  );
  const context = matchContext({
    tracked,
    teammates,
    kills: [
      kill(100, TRACKED_SLOT),
      kill(599, TRACKED_SLOT),
      kill(250, 1),
      // An enemy's kill is no one of the team's.
      kill(100, 7),
      kill(700, TRACKED_SLOT),
      kill(DURATION_S, TRACKED_SLOT),
    ],
  });
  const breakdown = phaseBreakdown(context);

  /** The cells of a phase of the breakdown. */
  function cellsOf(phase: PhaseSpan['phase']) {
    return present(breakdown.find((row) => row.span.phase === phase)).cells;
  }

  it('has a row for every phase the match reached, in order', () => {
    expect(breakdown.map((row) => row.span.phase)).toEqual(['early', 'mid', 'late']);
    expect(breakdown.map((row) => row.span)).toEqual(phaseSpans(DURATION_S));
    expect(Object.keys(cellsOf('early'))).toEqual([...PHASE_STATS]);
  });

  it('computes phase totals and team shares', () => {
    // Souls early: 7,000 of a 42,000 team total, the enemies left out.
    expect(cellsOf('early').souls.total).toBe(7_000);
    expect(cellsOf('early').souls.teamShare).toBeCloseTo(1 / 6, 10);
    // Souls mid: 13,000 of 13,000 * 5 + 25,000 (the richer teammate), for the 6 players of the team.
    expect(cellsOf('mid').souls.total).toBe(13_000);
    expect(cellsOf('mid').souls.teamShare).toBeCloseTo(13_000 / 90_000, 10);
    // Hero damage early: 3,000 of 3,000 + 5 * 1,500.
    expect(cellsOf('early').hero_damage).toEqual({ total: 3_000, teamShare: 3_000 / 10_500 });
  });

  it('counts kills with the share of the team', () => {
    // Early: the tracked player made 2 kills and a teammate 1; the enemy's kill is not counted.
    expect(cellsOf('early').kills).toEqual({ total: 2, teamShare: 2 / 3 });
    // Mid: one kill, nobody else of the team made one.
    expect(cellsOf('mid').kills).toEqual({ total: 1, teamShare: 1 });
    // Late: the kill of the last second is counted.
    expect(cellsOf('late').kills).toEqual({ total: 1, teamShare: 1 });
  });

  it('has a null team share when the team total is 0', () => {
    // Nobody of the team dealt any damage to objectives before 10:00.
    expect(cellsOf('early').objective_damage).toEqual({ total: 0, teamShare: null });
    // The tracked player alone did afterwards.
    expect(cellsOf('mid').objective_damage).toEqual({ total: 1_000, teamShare: 1 });
  });

  it('has a null team share when a teammate has no figures', () => {
    const lastMate = present(teammates.at(-1));
    const withBlank = matchContext({
      tracked,
      teammates: [...teammates.slice(0, -1), player(lastMate.slot)],
    });
    const cells = present(phaseBreakdown(withBlank)[0]).cells;
    // The tracked player's own total is known, the team's is not.
    expect(cells.souls).toEqual({ total: 7_000, teamShare: null });
    expect(cells.hero_damage).toEqual({ total: 3_000, teamShare: null });
    expect(cells.objective_damage).toEqual({ total: 0, teamShare: null });
  });

  it('has null totals for a tracked player with no snapshots, and still counts their kills', () => {
    const bare = matchContext({
      tracked: player(TRACKED_SLOT),
      teammates: [],
      kills: [kill(100, TRACKED_SLOT)],
    });
    const cells = present(phaseBreakdown(bare)[0]).cells;
    expect(cells.souls).toEqual({ total: null, teamShare: null });
    expect(cells.kills).toEqual({ total: 1, teamShare: 1 });
  });

  it('has unknown kill cells, and the other cells, when the kills of the match are unknown', () => {
    const unknownKills = phaseBreakdown(matchContext({ tracked, teammates, kills: null }));

    for (const row of unknownKills) {
      expect(row.cells.kills, row.span.phase).toEqual({ total: null, teamShare: null });
    }
    expect(present(unknownKills[0]).cells.souls).toEqual(cellsOf('early').souls);
  });

  it('only has the phases a short match reached, ending at the match end', () => {
    const short = matchContext({
      tracked: player(TRACKED_SLOT, [testSnapshot(540, { net_worth: 5_400 })]),
      teammates: [],
      durationS: 540,
    });
    const rows = phaseBreakdown(short);
    expect(rows).toHaveLength(1);
    expect(present(rows[0]).span).toMatchObject({ phase: 'early', endS: 540 });
    // 5,400 souls at 9:00: the total of the phase, the team being the tracked player alone.
    expect(present(rows[0]).cells.souls).toEqual({ total: 5_400, teamShare: 1 });
  });
});

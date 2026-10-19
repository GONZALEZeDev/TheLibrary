/**
 * The phases of a match, and what a player did in each of them next to what their team did.
 *
 * A match is read in three phases: the early game (0:00 to 10:00), the mid game (10:00 to 25:00) and
 * the late game (25:00 to the end). A short match does not reach all of them. For each phase the
 * analysis shows four figures per player: the souls gained, the damage dealt to heroes, the damage
 * dealt to objectives and the kills, and the share of the team's total that each of them makes.
 *
 * Everything here reads a {@link MatchContext}; nothing is compared with the community or with the
 * player's habits yet.
 *
 * @packageDocumentation
 */
import { MIN_PHASE_MINUTES } from './insights/thresholds';
import { killsIn, statAt } from './match-context';
import type { MatchContext, PlayerContext, SnapshotStat } from './match-context';

/** A phase of a match: the early, the mid or the late game. */
export type Phase = 'early' | 'mid' | 'late';

/** Every phase, in the order of the match. */
export const PHASES = ['early', 'mid', 'late'] as const satisfies readonly Phase[];

/**
 * When each phase starts, in seconds since the start of the match: the early game at 0:00, the mid
 * game at 10:00 and the late game at 25:00. A phase ends where the next one starts, or with the
 * match.
 */
export const PHASE_START_S: Readonly<Record<Phase, number>> = { early: 0, mid: 600, late: 1_500 };

/** A phase as played in one match: the part of the phase between its start and the match's end. */
export interface PhaseSpan {
  /** The phase. */
  readonly phase: Phase;
  /** When it starts, in seconds since the start of the match. */
  readonly startS: number;
  /** When it ends, in seconds since the start of the match (the end of the match for the last one). */
  readonly endS: number;
  /** Its length in minutes. */
  readonly minutes: number;
  /**
   * Whether it is long enough to be compared with a reference: it lasts at least
   * {@link MIN_PHASE_MINUTES}. A phase that is not is shown with its totals but not scored.
   */
  readonly comparable: boolean;
}

/** A figure of a phase: what a player did in it. */
export type PhaseStat = 'souls' | 'hero_damage' | 'objective_damage' | 'kills';

/** Every figure of a phase, in the order they are shown. */
export const PHASE_STATS = [
  'souls',
  'hero_damage',
  'objective_damage',
  'kills',
] as const satisfies readonly PhaseStat[];

/** What a player did in a phase, and how much of what their team did it makes. */
export interface PhaseCell {
  /** What the player did, or `null` when the archive does not tell. */
  readonly total: number | null;
  /**
   * The player's total divided by the team's (from 0 to 1), or `null` when the player's total or
   * the team's is unknown, or when the team did nothing at all (there is no share of 0).
   */
  readonly teamShare: number | null;
}

/** The phase table row of a phase: its span and its four figures. */
export interface PhaseRow {
  /** The phase as played in this match. */
  readonly span: PhaseSpan;
  /** The tracked player's figures in the phase. */
  readonly cells: Readonly<Record<PhaseStat, PhaseCell>>;
}

/** The snapshot counter that each figure of a phase but the kills is the growth of. */
const SNAPSHOT_COUNTER: Readonly<Record<Exclude<PhaseStat, 'kills'>, SnapshotStat>> = {
  souls: 'net_worth',
  hero_damage: 'player_damage',
  objective_damage: 'boss_damage',
};

/**
 * The phases a match of a given length reached, with their ends clipped at the end of the match.
 *
 * A phase is reached when the match lasts past its start: a match of exactly 10:00 has an early
 * phase only. The end of a phase is where the next *reached* phase starts, and the last reached
 * phase ends with the match, whatever its nominal end: the late game has no end of its own.
 *
 * @param durationS - The length of the match, in seconds.
 * @returns The spans of the reached phases, in the order of the match (none for a match of no time).
 */
export function phaseSpans(durationS: number): readonly PhaseSpan[] {
  const reached = PHASES.filter((phase) => durationS > PHASE_START_S[phase]);
  return reached.map((phase, index) => {
    const startS = PHASE_START_S[phase];
    const next = reached[index + 1];
    // Only the last reached phase has no next one: it is cut short by the end of the match.
    const endS = next === undefined ? durationS : PHASE_START_S[next];
    const minutes = (endS - startS) / 60;
    return { phase, startS, endS, minutes, comparable: minutes >= MIN_PHASE_MINUTES };
  });
}

/**
 * What a player did in a window of the match.
 *
 * The souls, the damage to heroes and the damage to objectives are cumulative counters: the total is
 * their growth over the window, read on the player's snapshots. The kills are counted in the window.
 *
 * @param context - The match.
 * @param player - The player.
 * @param stat - The figure.
 * @param startS - The start of the window, in seconds since the start of the match.
 * @param endS - The end of the window, in seconds since the start of the match.
 * @returns The total, or `null` when a counter is unknown at the start or at the end of the window
 *   (no snapshot holds it, or the window ends after the last snapshot that does). The kills are
 *   always known.
 */
export function phaseTotal(
  context: MatchContext,
  player: PlayerContext,
  stat: PhaseStat,
  startS: number,
  endS: number,
): number | null {
  if (stat === 'kills') {
    return killsIn(context, player.slot, startS, endS);
  }
  const counter = SNAPSHOT_COUNTER[stat];
  const atStart = statAt(player, counter, startS);
  const atEnd = statAt(player, counter, endS);
  return atStart === null || atEnd === null ? null : atEnd - atStart;
}

/**
 * The phase table of the tracked player: for each phase the match reached, their four figures and
 * the share of their team that each makes.
 *
 * The team is the tracked player and their teammates; the enemies are not part of it. A share is
 * only given when every player of the team has a total, so that a missing player never makes the
 * tracked player's share look bigger than it was.
 *
 * @param context - The match.
 * @returns One row per reached phase, in the order of the match.
 */
export function phaseBreakdown(context: MatchContext): readonly PhaseRow[] {
  return phaseSpans(context.durationS).map((span) => ({
    span,
    cells: {
      souls: phaseCell(context, 'souls', span),
      hero_damage: phaseCell(context, 'hero_damage', span),
      objective_damage: phaseCell(context, 'objective_damage', span),
      kills: phaseCell(context, 'kills', span),
    },
  }));
}

/**
 * Compute one figure of the tracked player in a phase, with its share of the team's.
 *
 * @param context - The match.
 * @param stat - The figure.
 * @param span - The phase as played in the match.
 * @returns The tracked player's total and team share.
 */
function phaseCell(context: MatchContext, stat: PhaseStat, span: PhaseSpan): PhaseCell {
  const total = phaseTotal(context, context.tracked, stat, span.startS, span.endS);
  const teammateTotals = context.teammates.map((teammate) =>
    phaseTotal(context, teammate, stat, span.startS, span.endS),
  );
  const teamTotal = sumOrNull([total, ...teammateTotals]);
  return {
    total,
    teamShare: total === null || teamTotal === null || teamTotal === 0 ? null : total / teamTotal,
  };
}

/**
 * Add up numbers, any of which may be unknown.
 *
 * @param values - The numbers, or `null` for the ones that are unknown.
 * @returns The sum, or `null` as soon as one of the values is unknown: a partial sum would be taken
 *   for the real one.
 */
function sumOrNull(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    sum += value;
  }
  return sum;
}

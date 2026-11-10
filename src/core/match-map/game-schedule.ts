/**
 * The fixed schedule of a Deadlock match: when the neutral camps, crates, power-ups, the Soul Urn,
 * the Unstable Rift and the mid boss show up, and how often the trooper waves spawn.
 *
 * These timings are the same in every match, so they live in a plain table that the map replay
 * draws as a "Game schedule" row under the time slider.
 *
 * The table was checked against game build {@link SCHEDULE_GAME_BUILD}. A game patch may change
 * these timings; they are not read from any API and are updated by hand.
 *
 * @packageDocumentation
 */

/**
 * The game build the schedule below was checked against (October 2026). A later patch may change
 * the timings, and they are then updated by hand.
 */
export const SCHEDULE_GAME_BUILD = 6722;

/** The kinds of scheduled event the replay shows. */
export type ScheduleEventKind =
  | 'mid_boss'
  | 'small_camps'
  | 'crates'
  | 'medium_camps'
  | 'bridge_powerups'
  | 'large_camps'
  | 'sinners_sacrifice'
  | 'soul_urn'
  | 'unstable_rift';

/**
 * One line of the schedule, in seconds since the match start. Three shapes exist: an event that
 * happens once (and may respawn), one that repeats on a fixed period, and one that lasts a window.
 */
export type ScheduleEntry =
  | {
      readonly kind: ScheduleEventKind;
      readonly type: 'once';
      /** When the event first appears. */
      readonly atS: number;
      /** How long it takes to come back after being taken; `null` when it never respawns by itself. */
      readonly respawnS: number | null;
    }
  | {
      readonly kind: ScheduleEventKind;
      readonly type: 'repeat';
      /** When the first occurrence happens. */
      readonly firstS: number;
      /** The period between two occurrences. */
      readonly everyS: number;
    }
  | {
      readonly kind: 'unstable_rift';
      readonly type: 'window';
      /** When the window opens. */
      readonly fromS: number;
      /** When the window closes. */
      readonly toS: number;
    };

/** The schedule, in the order ties are broken when two events share a time. */
export const GAME_SCHEDULE: readonly ScheduleEntry[] = [
  { kind: 'mid_boss', type: 'once', atS: 0, respawnS: null },
  { kind: 'small_camps', type: 'once', atS: 120, respawnS: 85 },
  { kind: 'crates', type: 'once', atS: 180, respawnS: 180 },
  { kind: 'medium_camps', type: 'once', atS: 300, respawnS: 290 },
  { kind: 'bridge_powerups', type: 'repeat', firstS: 300, everyS: 300 },
  { kind: 'large_camps', type: 'once', atS: 480, respawnS: 335 },
  { kind: 'sinners_sacrifice', type: 'once', atS: 480, respawnS: 300 },
  { kind: 'soul_urn', type: 'repeat', firstS: 600, everyS: 300 },
  { kind: 'unstable_rift', type: 'window', fromS: 600, toS: 720 },
];

/**
 * How often a trooper wave spawns, by stretch of the match: every 30 s from the start, every 25 s
 * from 20:00 and every 20 s from 35:00. A wave is a span, not a point event, so it is not part of
 * {@link scheduleOccurrences}.
 */
export const TROOPER_WAVES: readonly { readonly fromS: number; readonly everyS: number }[] = [
  { fromS: 0, everyS: 30 },
  { fromS: 1200, everyS: 25 },
  { fromS: 2100, everyS: 20 },
];

/** One dated event of the schedule, ready to be drawn on the slider. */
export interface ScheduleOccurrence {
  /** What happens. */
  readonly kind: ScheduleEventKind;
  /** When it happens, in seconds since the match start. */
  readonly timeS: number;
  /** When it ends for a window event (the rift); `null` for a point event. */
  readonly untilS: number | null;
}

/**
 * List every scheduled event that starts during a match: once-entries, every repeat of a repeating
 * entry and the rift window, expanded to dated occurrences.
 *
 * A window keeps its full end time even when the match ends inside it; the caller clips it.
 * Trooper waves are not included (see {@link TROOPER_WAVES}).
 *
 * @param durationS - The match length in seconds; later events are left out.
 * @returns The occurrences sorted by time, ties keeping the order of {@link GAME_SCHEDULE}.
 */
export function scheduleOccurrences(durationS: number): readonly ScheduleOccurrence[] {
  // Expand each entry, remembering its schedule position to break ties.
  const expanded: { occurrence: ScheduleOccurrence; order: number }[] = [];
  GAME_SCHEDULE.forEach((entry, order) => {
    if (entry.type === 'once') {
      if (entry.atS <= durationS) {
        expanded.push({ occurrence: { kind: entry.kind, timeS: entry.atS, untilS: null }, order });
      }
    } else if (entry.type === 'repeat') {
      for (let timeS = entry.firstS; timeS <= durationS; timeS += entry.everyS) {
        expanded.push({ occurrence: { kind: entry.kind, timeS, untilS: null }, order });
      }
    } else if (entry.fromS <= durationS) {
      expanded.push({
        occurrence: { kind: entry.kind, timeS: entry.fromS, untilS: entry.toS },
        order,
      });
    }
  });
  // Sort by time, then by schedule order for events that share a time.
  expanded.sort((a, b) => a.occurrence.timeS - b.occurrence.timeS || a.order - b.order);
  return expanded.map((item) => item.occurrence);
}

/** How long the mid boss takes to return after its first, second and later kills, in seconds. */
const MID_BOSS_RETURN_DELAYS_S: readonly number[] = [420, 360, 300];

/** The delay that applies from the third kill on. */
const MID_BOSS_LATER_RETURN_DELAY_S = 300;

/**
 * Tell when the mid boss comes back after each of its kills: 420 s after the first, 360 s after the
 * second and 300 s after every later one.
 *
 * @param killTimesS - The kill times in seconds, in the order they happened.
 * @returns The return time of each kill, in the same order. Not clipped to the match end.
 */
export function midBossReturns(killTimesS: readonly number[]): readonly number[] {
  return killTimesS.map(
    (killS, index) => killS + (MID_BOSS_RETURN_DELAYS_S[index] ?? MID_BOSS_LATER_RETURN_DELAY_S),
  );
}

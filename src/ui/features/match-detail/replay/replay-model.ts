/**
 * The pure model of the map replay: everything the map, the playback bar and the live cards
 * compute from a {@link ReplayView} and the shared cursor, with no React in it.
 *
 * Times are in seconds since the start of the match, positions are relative to the minimap picture
 * (0 to 1 on both axes), and the viewport of the map is told in the same relative units.
 *
 * @packageDocumentation
 */
import type { RelativePoint } from '../../../../core/match-map/map-geometry';
import { isDeadAt } from '../../../../core/match-map/match-replay';
import type {
  ReplayView,
  ReplayViewMidBossKill,
  ReplayViewObjective,
  ReplayViewPlayer,
} from '../../../../services/match-replay-view';

/** A replay view that holds a replay (the other kinds say why there is none). */
export type ReplayData = ReplayView & { kind: 'replay' };

/** A picked death moves the cursor this many seconds before it, to see what led to it. */
export const DEATH_LEAD_S = 5;

/** The lowest and highest zoom of the map; 1 shows the whole picture. */
const MIN_SCALE = 1;
const MAX_SCALE = 8;

/**
 * Where a player is at a moment, which may fall between two seconds while the replay plays.
 *
 * @param positions - The position at each second (the index is the second); `null` while dead or
 *   unknown.
 * @param timeS - The moment, in seconds; fractional while playing.
 * @returns The sample at an integer second; the linear interpolation between the two neighbouring
 *   seconds otherwise; `null` when the player has no position at either of them or the moment is
 *   outside the replay.
 */
export function positionBetween(
  positions: readonly (RelativePoint | null)[],
  timeS: number,
): RelativePoint | null {
  const before = positions[Math.floor(timeS)] ?? null;
  if (Number.isInteger(timeS)) return before;
  const after = positions[Math.ceil(timeS)] ?? null;
  // A death (or a gap) on either side means there is nothing to draw in between.
  if (before === null || after === null) return null;
  const ratio = timeS - Math.floor(timeS);
  return {
    left: before.left + (after.left - before.left) * ratio,
    top: before.top + (after.top - before.top) * ratio,
  };
}

/**
 * The trail a player leaves behind: their last positions, one per second.
 *
 * @param positions - The position at each second (the index is the second).
 * @param timeS - The moment; only the seconds up to `floor(timeS)` count.
 * @param seconds - How many seconds the trail covers at most.
 * @returns The points in time order. The trail is cut at the last `null` of that stretch, so it
 *   never links a death to the place the player respawned at.
 */
export function trailOf(
  positions: readonly (RelativePoint | null)[],
  timeS: number,
  seconds: number,
): readonly RelativePoint[] {
  const last = Math.floor(timeS);
  const first = Math.max(0, last - seconds + 1);
  const trail: RelativePoint[] = [];
  for (let second = first; second <= last; second += 1) {
    const point = positions[second] ?? null;
    if (point === null) {
      // Whatever came before a hole does not belong to the current trail.
      trail.length = 0;
    } else {
      trail.push(point);
    }
  }
  return trail;
}

/**
 * The visible window of the map, in relative map units: `scale` 1 shows the whole picture, and the
 * window is `1 / scale` wide and high, its top-left corner at (`left`, `top`).
 */
export interface MapViewport {
  /** The zoom, from 1 (whole map) to 8. */
  readonly scale: number;
  /** The left edge of the window, in map units. */
  readonly left: number;
  /** The top edge of the window, in map units. */
  readonly top: number;
}

/** The viewport that shows the whole map. */
export const FULL_MAP: MapViewport = { scale: 1, left: 0, top: 0 };

/**
 * Keep a window corner so that the window (of size `1 / scale`) stays inside the map.
 *
 * @param corner - The left or top edge of the window, in map units.
 * @param scale - The zoom.
 * @returns The edge, kept inside the map.
 */
function clampCorner(corner: number, scale: number): number {
  return Math.min(Math.max(corner, 0), 1 - 1 / scale);
}

/**
 * Zoom the map around a point, so that the point stays under the same place of the screen.
 *
 * @param view - The current viewport.
 * @param at - The map point under the pointer.
 * @param factor - How much to multiply the zoom by (above 1 zooms in).
 * @returns The new viewport: the scale is clamped to [1, 8] and the window stays inside the map.
 */
export function zoomAt(view: MapViewport, at: RelativePoint, factor: number): MapViewport {
  const scale = Math.min(Math.max(view.scale * factor, MIN_SCALE), MAX_SCALE);
  // Where the point sits in the window (0 to 1) must not change with the zoom.
  const fractionX = (at.left - view.left) * view.scale;
  const fractionY = (at.top - view.top) * view.scale;
  return {
    scale,
    left: clampCorner(at.left - fractionX / scale, scale),
    top: clampCorner(at.top - fractionY / scale, scale),
  };
}

/**
 * Move the window of the map.
 *
 * @param view - The current viewport.
 * @param dLeft - How far to move the window to the right, in map units.
 * @param dTop - How far to move the window down, in map units.
 * @returns The new viewport, kept inside the map.
 */
export function panBy(view: MapViewport, dLeft: number, dTop: number): MapViewport {
  return {
    scale: view.scale,
    left: clampCorner(view.left + dLeft, view.scale),
    top: clampCorner(view.top + dTop, view.scale),
  };
}

/**
 * The moments the "previous / next event" buttons jump between: the objectives that fell, the mid
 * boss kills, the deaths of the tracked player and their kills. Other players' deaths are left out
 * on purpose, they would make the steps too many to be useful.
 *
 * @param view - The replay.
 * @param trackedKills - The seconds of the kills of the tracked player.
 * @returns The times, floored to whole seconds, sorted, without duplicates, within
 *   [0, `durationS`].
 */
export function stepEvents(view: ReplayData, trackedKills: readonly number[]): readonly number[] {
  const times: number[] = [...trackedKills];
  for (const objective of view.objectives) {
    if (objective.destroyedAtS !== null) times.push(objective.destroyedAtS);
  }
  for (const kill of view.midBossKills) times.push(kill.timeS);
  for (const player of view.players) {
    if (player.isTracked) for (const death of player.deaths) times.push(death.timeS);
  }
  // Floor first: seeking floors, so a fractional time must not be a step the cursor cannot reach.
  const floored = times.map((timeS) => Math.floor(timeS));
  return [...new Set(floored.filter((timeS) => timeS >= 0 && timeS <= view.durationS))].toSorted(
    (first, second) => first - second,
  );
}

/**
 * The last event strictly before a moment.
 *
 * @param times - The event times, sorted.
 * @param currentS - The moment.
 * @returns The time, or `null` when there is none.
 */
export function previousEvent(times: readonly number[], currentS: number): number | null {
  return times.findLast((timeS) => timeS < currentS) ?? null;
}

/**
 * The first event strictly after a moment.
 *
 * @param times - The event times, sorted.
 * @param currentS - The moment.
 * @returns The time, or `null` when there is none.
 */
export function nextEvent(times: readonly number[], currentS: number): number | null {
  return times.find((timeS) => timeS > currentS) ?? null;
}

/** What the players strip shows for one player at a moment. */
export type PlayerStatus =
  /** Alive: `healthPercent` is the health of the whole second, `null` without health data. */
  | { readonly kind: 'alive'; readonly healthPercent: number | null }
  /** Dead: `respawnInS` is the wait left in whole seconds, `null` when unknown. */
  | { readonly kind: 'dead'; readonly respawnInS: number | null };

/**
 * The status of a player at a moment, for the players strip.
 *
 * @param player - The player.
 * @param timeS - The moment, in seconds; may be fractional.
 * @returns Dead (with the respawn countdown rounded up) when the core's dead rule says so, else
 *   alive with the health of the whole second the moment sits in.
 */
export function playerStatusAt(player: ReplayViewPlayer, timeS: number): PlayerStatus {
  if (isDeadAt(player.deaths, timeS)) {
    // The death the core rule accepts tells when the player is back (no second rule here).
    const death = player.deaths.find((entry) => isDeadAt([entry], timeS));
    const respawnS = death?.respawnS ?? null;
    return { kind: 'dead', respawnInS: respawnS === null ? null : Math.ceil(respawnS - timeS) };
  }
  return { kind: 'alive', healthPercent: player.health[Math.floor(timeS)] ?? null };
}

/** One line of the live feed: a death, a fallen objective or a mid boss kill. */
export type FeedEvent =
  | {
      readonly kind: 'death';
      readonly timeS: number;
      readonly victim: ReplayViewPlayer;
      /** The killer; `null` when the archive names none, or for a self-kill. */
      readonly killer: ReplayViewPlayer | null;
    }
  | {
      readonly kind: 'objective';
      readonly timeS: number;
      readonly objective: ReplayViewObjective;
    }
  | {
      readonly kind: 'mid_boss';
      readonly timeS: number;
      readonly kill: ReplayViewMidBossKill;
    };

/** How many lines the live feed shows. */
export const LIVE_FEED_SIZE = 5;

/** Order of the kinds of event when several happen in the same second. */
const FEED_KIND_RANK: Record<FeedEvent['kind'], number> = { objective: 0, mid_boss: 1, death: 2 };

/**
 * Every event of the match, for the live feed: each death, each fallen objective, each mid boss
 * kill. Computed once per view; {@link liveFeedAt} then picks the lines for a moment.
 *
 * @param view - The replay.
 * @returns The events sorted by time; ties by kind (objective, mid boss, death), then by victim
 *   slot for deaths and by position in the view's list otherwise, so the order is stable.
 */
export function feedEvents(view: ReplayData): readonly FeedEvent[] {
  // Each event carries its tie-break key: the victim slot, or the index in the view's list.
  const keyed: { event: FeedEvent; key: number }[] = [];
  for (const victim of view.players) {
    for (const death of victim.deaths) {
      // A self-kill names no killer, and neither does a slot that is not in the view.
      const killer =
        death.killerSlot === null || death.killerSlot === victim.slot
          ? null
          : (view.players.find((entry) => entry.slot === death.killerSlot) ?? null);
      keyed.push({
        event: { kind: 'death', timeS: death.timeS, victim, killer },
        key: victim.slot,
      });
    }
  }
  view.objectives.forEach((objective, index) => {
    if (objective.destroyedAtS !== null) {
      keyed.push({
        event: { kind: 'objective', timeS: objective.destroyedAtS, objective },
        key: index,
      });
    }
  });
  view.midBossKills.forEach((kill, index) => {
    keyed.push({ event: { kind: 'mid_boss', timeS: kill.timeS, kill }, key: index });
  });
  return keyed
    .toSorted(
      (first, second) =>
        first.event.timeS - second.event.timeS ||
        FEED_KIND_RANK[first.event.kind] - FEED_KIND_RANK[second.event.kind] ||
        first.key - second.key,
    )
    .map((entry) => entry.event);
}

/**
 * The lines of the live feed at a moment.
 *
 * @param events - The events of the match, as {@link feedEvents} sorts them.
 * @param timeS - The moment, in seconds; may be fractional.
 * @returns The last {@link LIVE_FEED_SIZE} events up to the whole second of the moment, newest
 *   first.
 */
export function liveFeedAt(events: readonly FeedEvent[], timeS: number): readonly FeedEvent[] {
  const second = Math.floor(timeS);
  const happened = events.filter((event) => event.timeS <= second);
  return happened.slice(-LIVE_FEED_SIZE).toReversed();
}

/**
 * The objectives that fell, for the history card.
 *
 * @param view - The replay.
 * @returns The destroyed objectives only, oldest first; ties keep the order of the view's list.
 */
export function objectiveHistory(
  view: ReplayData,
): readonly (ReplayViewObjective & { readonly destroyedAtS: number })[] {
  return view.objectives
    .filter(
      (objective): objective is ReplayViewObjective & { destroyedAtS: number } =>
        objective.destroyedAtS !== null,
    )
    .toSorted((first, second) => first.destroyedAtS - second.destroyedAtS);
}

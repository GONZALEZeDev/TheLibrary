/**
 * Where the objectives of a match stand on the minimap picture.
 *
 * Match data names an objective by a per-team numeric id; this file says what each id is (core,
 * guardian, walker, titan, shrine, base guardian) and where it sits. Most positions come from the
 * map asset; the shrines, the base guardians and the mid boss are not in it and are placed by hand.
 *
 * @packageDocumentation
 */
import type { MapLayout } from '../deadlock-api/map.schema';
import type { RelativePoint } from './map-geometry';

/** The kinds of objective a team owns on the current map. */
export type ObjectiveKind = 'core' | 'guardian' | 'walker' | 'titan' | 'shrine' | 'base_guardian';

/** The three lanes of the current map (lane 2 does not exist). */
export type MapLaneId = 1 | 3 | 4;

/** What a team objective id stands for. */
export interface ObjectiveIdentity {
  /** The kind of objective. */
  readonly kind: ObjectiveKind;
  /** The lane of a guardian, walker or base guardian; `null` for the other kinds. */
  readonly lane: MapLaneId | null;
  /** The side (1 left, 2 right) of a shrine; `null` for the other kinds. */
  readonly index: 1 | 2 | null;
}

/**
 * The 13 objective ids each team has on the current map. Ids 2, 6 and 13 belong to the missing
 * lane 2 and are left out.
 */
export const MAP_OBJECTIVE_IDS: readonly number[] = [0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15];

/** What each objective id stands for, by id. */
const IDENTITIES: Readonly<Record<number, ObjectiveIdentity>> = {
  0: { kind: 'core', lane: null, index: null },
  1: { kind: 'guardian', lane: 1, index: null },
  3: { kind: 'guardian', lane: 3, index: null },
  4: { kind: 'guardian', lane: 4, index: null },
  5: { kind: 'walker', lane: 1, index: null },
  7: { kind: 'walker', lane: 3, index: null },
  8: { kind: 'walker', lane: 4, index: null },
  9: { kind: 'titan', lane: null, index: null },
  10: { kind: 'shrine', lane: null, index: 1 },
  11: { kind: 'shrine', lane: null, index: 2 },
  12: { kind: 'base_guardian', lane: 1, index: null },
  14: { kind: 'base_guardian', lane: 3, index: null },
  15: { kind: 'base_guardian', lane: 4, index: null },
};

/**
 * Tell what a team objective id stands for.
 *
 * @param teamObjectiveId - The objective id as match data gives it.
 * @returns The identity of the objective, or `null` for lane 2 ids and any unknown id.
 */
export function identifyObjective(teamObjectiveId: number): ObjectiveIdentity | null {
  return IDENTITIES[teamObjectiveId] ?? null;
}

/**
 * How far the map asset's objective positions sit from the buildings they name, on the picture.
 *
 * The API places each objective by the top-left corner of the icon its own minimap draws, not by the
 * building's centre. The map is point-symmetric (each team's half is the other's turned half a turn
 * around the centre), so a position of team 0 and its counterpart of team 1 should add up to 1 on
 * each axis: they add up to 0.9, and once moved by this offset the guardians and walkers fall on
 * their zip lines and next to the lane shops of the map asset.
 */
const API_ICON_OFFSET: RelativePoint = { left: 0.05, top: 0.05 };

/**
 * The same offset for the core, whose icon is wider: moved by it, each core falls behind its titan,
 * on the middle zip line, where the players who destroy it stand.
 */
const API_CORE_ICON_OFFSET: RelativePoint = { left: 0.15, top: 0.05 };

/**
 * The positions the map asset does not give: each team's two shrines (`team{t}_shrine_{1|2}`) and
 * three base guardians (`team{t}_base_guardian_{1|3|4}`).
 *
 * Team 0's base is at the bottom of the picture and team 1's at the top; the two bases are the same
 * building turned half a turn, so each position of team 0 is `1 − x` of its counterpart of team 1 on
 * both axes. The lane numbers are the zip lines' (lane 1 is the yellow line on the left for both
 * teams), so team 0's lane 1 faces team 1's lane 4.
 *
 * - A base guardian stands where its lane's zip line turns into the base.
 * - The shrines stand inside the base, on either side of the middle line, between the base guardians
 *   and the titan. A shrine's index is taken to belong to its own base, turned with it: shrine 1 of
 *   team 1 is on the right of the picture, so shrine 1 of team 0 is on the left.
 *
 * Team 1's places were measured on the picture against the zip lines and against where the attackers
 * stood in a real match at the second each of its base objectives fell; team 0's are their
 * counterparts.
 */
export const HAND_PLACED_POSITIONS: Readonly<Record<string, RelativePoint>> = {
  // Team 0 (bottom base, titan at 0.4405 / 0.8736).
  team0_shrine_1: { left: 0.4, top: 0.88 },
  team0_shrine_2: { left: 0.48, top: 0.88 },
  team0_base_guardian_1: { left: 0.38, top: 0.82 },
  team0_base_guardian_3: { left: 0.44, top: 0.765 },
  team0_base_guardian_4: { left: 0.5, top: 0.82 },
  // Team 1 (top base, titan at 0.5595 / 0.1257).
  team1_shrine_1: { left: 0.6, top: 0.12 },
  team1_shrine_2: { left: 0.52, top: 0.12 },
  team1_base_guardian_1: { left: 0.5, top: 0.18 },
  team1_base_guardian_3: { left: 0.56, top: 0.235 },
  team1_base_guardian_4: { left: 0.62, top: 0.18 },
};

/** The mid boss pit, at the centre of the picture. */
export const MID_BOSS_POSITION: RelativePoint = { left: 0.5, top: 0.5 };

/**
 * Find where an objective stands on the minimap picture.
 *
 * Core, titan, guardians and walkers are read from the map layout by the API's key
 * (`team{t}_core`, `team{t}_titan`, `team{t}_tier1_{lane}`, `team{t}_tier2_{lane}`) and moved from
 * the corner of the API's icon to the building (see {@link API_ICON_OFFSET}); shrines and base
 * guardians come from {@link HAND_PLACED_POSITIONS}.
 *
 * @param team - The team number, 0 or 1.
 * @param identity - What the objective is, from {@link identifyObjective}.
 * @param layout - The map layout.
 * @returns The position, or `null` when the team is neither 0 nor 1 or the layout lacks the key.
 */
export function objectivePosition(
  team: number,
  identity: ObjectiveIdentity,
  layout: MapLayout,
): RelativePoint | null {
  if (team !== 0 && team !== 1) return null;
  const prefix = `team${String(team)}`;
  switch (identity.kind) {
    case 'core':
      return fromApiIcon(layout.objectivePositions[`${prefix}_core`], API_CORE_ICON_OFFSET);
    case 'titan':
      return fromApiIcon(layout.objectivePositions[`${prefix}_titan`], API_ICON_OFFSET);
    case 'guardian':
      // The guardians are the tier-1 objectives of the API.
      return fromApiIcon(
        layout.objectivePositions[`${prefix}_tier1_${String(identity.lane)}`],
        API_ICON_OFFSET,
      );
    case 'walker':
      // The walkers are the tier-2 objectives of the API.
      return fromApiIcon(
        layout.objectivePositions[`${prefix}_tier2_${String(identity.lane)}`],
        API_ICON_OFFSET,
      );
    case 'shrine':
      return HAND_PLACED_POSITIONS[`${prefix}_shrine_${String(identity.index)}`] ?? null;
    case 'base_guardian':
      return HAND_PLACED_POSITIONS[`${prefix}_base_guardian_${String(identity.lane)}`] ?? null;
  }
}

/**
 * Move a position of the map asset from the corner of its icon to the building it names.
 *
 * @param position - The API's position, or `undefined` when the layout lacks the key.
 * @param offset - The offset of that kind of icon.
 * @returns The building's position, or `null` when there is none.
 */
function fromApiIcon(
  position: RelativePoint | undefined,
  offset: RelativePoint,
): RelativePoint | null {
  if (position === undefined) return null;
  return { left: position.left + offset.left, top: position.top + offset.top };
}

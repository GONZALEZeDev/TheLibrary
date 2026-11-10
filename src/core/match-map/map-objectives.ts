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
 * The positions the map asset does not give: each team's two shrines (`team{t}_shrine_{1|2}`) and
 * three base guardians (`team{t}_base_guardian_{1|3|4}`).
 *
 * These are hand-placed starting values, to be checked visually against the minimap image. Team 0's
 * base is at the bottom of the picture and team 1's at the top. A shrine sits beside its team's
 * titan (index 1 on the left, 2 on the right), between the titan and the tier-2 walkers. A base
 * guardian stands on its lane, 60% of the way from the tier-2 walker of that lane to the titan.
 */
export const HAND_PLACED_POSITIONS: Readonly<Record<string, RelativePoint>> = {
  // Team 0 (bottom base, titan at 0.3905 / 0.8236).
  team0_shrine_1: { left: 0.2705, top: 0.8036 },
  team0_shrine_2: { left: 0.5105, top: 0.8036 },
  team0_base_guardian_1: { left: 0.2976, top: 0.7622 },
  team0_base_guardian_3: { left: 0.3903, top: 0.7388 },
  team0_base_guardian_4: { left: 0.519, top: 0.7683 },
  // Team 1 (top base, titan at 0.5095 / 0.0757).
  team1_shrine_1: { left: 0.3895, top: 0.0957 },
  team1_shrine_2: { left: 0.6295, top: 0.0957 },
  team1_base_guardian_1: { left: 0.3849, top: 0.132 },
  team1_base_guardian_3: { left: 0.5097, top: 0.1608 },
  team1_base_guardian_4: { left: 0.6056, top: 0.1366 },
};

/** The mid boss pit, at the centre of the picture. */
export const MID_BOSS_POSITION: RelativePoint = { left: 0.5, top: 0.5 };

/**
 * Find where an objective stands on the minimap picture.
 *
 * Core, titan, guardians and walkers are read from the map layout by the API's key
 * (`team{t}_core`, `team{t}_titan`, `team{t}_tier1_{lane}`, `team{t}_tier2_{lane}`); shrines and base
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
      return layout.objectivePositions[`${prefix}_core`] ?? null;
    case 'titan':
      return layout.objectivePositions[`${prefix}_titan`] ?? null;
    case 'guardian':
      // The guardians are the tier-1 objectives of the API.
      return layout.objectivePositions[`${prefix}_tier1_${String(identity.lane)}`] ?? null;
    case 'walker':
      // The walkers are the tier-2 objectives of the API.
      return layout.objectivePositions[`${prefix}_tier2_${String(identity.lane)}`] ?? null;
    case 'shrine':
      return HAND_PLACED_POSITIONS[`${prefix}_shrine_${String(identity.index)}`] ?? null;
    case 'base_guardian':
      return HAND_PLACED_POSITIONS[`${prefix}_base_guardian_${String(identity.lane)}`] ?? null;
  }
}

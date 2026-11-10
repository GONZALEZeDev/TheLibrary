import { describe, expect, it } from 'vitest';
import type { MapLayout } from '../deadlock-api/map.schema';
import {
  HAND_PLACED_POSITIONS,
  MAP_OBJECTIVE_IDS,
  MID_BOSS_POSITION,
  identifyObjective,
  objectivePosition,
  type ObjectiveIdentity,
} from './map-objectives';

/**
 * A layout with the map asset's real positions (November 2026) of the objectives these tests read,
 * by pairs of counterparts: team 0's core, titan, lane 1 guardian and lane 4 walker face team 1's
 * core, titan, lane 4 guardian and lane 1 walker.
 */
const LAYOUT: MapLayout = {
  radius: 10752,
  imageUrl: 'https://assets-bucket.deadlock-api.com/minimap.png',
  objectivePositions: {
    team0_core: { left: 0.2905, top: 0.92 },
    team1_core: { left: 0.4095, top: 0 },
    team0_titan: { left: 0.3905, top: 0.8236 },
    team1_titan: { left: 0.5095, top: 0.0757 },
    team0_tier1_1: { left: 0.069, top: 0.5363 },
    team0_tier1_3: { left: 0.45, top: 0.6 },
    team0_tier2_3: { left: 0.4, top: 0.7 },
    team1_tier1_4: { left: 0.828, top: 0.3637 },
    team0_tier2_4: { left: 0.7117, top: 0.6853 },
    team1_tier2_1: { left: 0.1981, top: 0.2164 },
    team1_tier2_4: { left: 0.7497, top: 0.2279 },
  },
  lanes: [],
};

/** Read the position of an objective that the test knows is in the layout. */
function positionOf(team: number, id: number): { left: number; top: number } {
  const position = objectivePosition(team, identityOf(id), LAYOUT);
  if (position === null)
    throw new Error(`Objective ${String(id)} of team ${String(team)} has no place`);
  return position;
}

/** Identify an id that the test knows is valid, failing loudly otherwise. */
function identityOf(id: number): ObjectiveIdentity {
  const identity = identifyObjective(id);
  if (identity === null) throw new Error(`Objective id ${String(id)} is not identified`);
  return identity;
}

describe('identifyObjective', () => {
  const table: readonly (readonly [number, ObjectiveIdentity])[] = [
    [0, { kind: 'core', lane: null, index: null }],
    [1, { kind: 'guardian', lane: 1, index: null }],
    [3, { kind: 'guardian', lane: 3, index: null }],
    [4, { kind: 'guardian', lane: 4, index: null }],
    [5, { kind: 'walker', lane: 1, index: null }],
    [7, { kind: 'walker', lane: 3, index: null }],
    [8, { kind: 'walker', lane: 4, index: null }],
    [9, { kind: 'titan', lane: null, index: null }],
    [10, { kind: 'shrine', lane: null, index: 1 }],
    [11, { kind: 'shrine', lane: null, index: 2 }],
    [12, { kind: 'base_guardian', lane: 1, index: null }],
    [14, { kind: 'base_guardian', lane: 3, index: null }],
    [15, { kind: 'base_guardian', lane: 4, index: null }],
  ];

  it('identifies every id of the current map', () => {
    expect(table.map(([id]) => id)).toEqual([...MAP_OBJECTIVE_IDS]);
    for (const [id, identity] of table) {
      expect(identifyObjective(id)).toEqual(identity);
    }
  });

  it('gives null for lane 2 and unknown ids', () => {
    for (const id of [2, 6, 13, 16, -1, 99]) {
      expect(identifyObjective(id)).toBeNull();
    }
  });
});

describe('objectivePosition', () => {
  it('reads the walker of team 1 lane 4 as team1_tier2_4, moved from the icon corner', () => {
    const walker = positionOf(1, 8);
    expect(walker.left).toBeCloseTo(0.7997, 6);
    expect(walker.top).toBeCloseTo(0.2779, 6);
  });

  it('reads guardians as tier-1 keys and the titan and the core by their own keys', () => {
    const guardian = positionOf(0, 1);
    expect(guardian.left).toBeCloseTo(0.119, 6);
    expect(guardian.top).toBeCloseTo(0.5863, 6);
    const titan = positionOf(1, 9);
    expect(titan.left).toBeCloseTo(0.5595, 6);
    expect(titan.top).toBeCloseTo(0.1257, 6);
    // The core's icon is wider: it lands behind its titan, on the same vertical.
    const core = positionOf(0, 0);
    expect(core.left).toBeCloseTo(positionOf(0, 9).left, 6);
    expect(core.top).toBeCloseTo(0.97, 6);
  });

  it('turns counterparts of the two teams into points symmetric about the centre', () => {
    // Titan, lane 1 guardian against lane 4, lane 4 walker against lane 1. The walkers' real
    // positions are 0.0098 off on the left axis, so they only hold within 0.05.
    const pairs = [
      [9, 9, 2],
      [1, 4, 2],
      [8, 5, 1],
    ] as const;
    for (const [ownId, otherId, digits] of pairs) {
      const own = positionOf(0, ownId);
      const other = positionOf(1, otherId);
      expect(own.left + other.left).toBeCloseTo(1, digits);
      expect(own.top + other.top).toBeCloseTo(1, digits);
    }
  });

  it('places the two cores, asymmetric on top because the API clamps team 1 at 0', () => {
    const own = positionOf(0, 0);
    const other = positionOf(1, 0);
    expect(own.left + other.left).toBeCloseTo(1, 3);
    // The API clamps team1_core's top at 0, so the pair sums to 1.02 and not 1: the real place of
    // team 0's core is unverified.
    expect(own.top + other.top).toBeCloseTo(1.02, 3);
  });

  it('reads guardians from the tier-1 keys and walkers from the tier-2 keys', () => {
    // Lane 3 has a different tier-1 and tier-2 position: id 3 is the guardian, id 7 the walker.
    const guardian = positionOf(0, 3);
    const walker = positionOf(0, 7);
    expect(guardian.left).toBeCloseTo(0.5, 6);
    expect(guardian.top).toBeCloseTo(0.65, 6);
    expect(walker.left).toBeCloseTo(0.45, 6);
    expect(walker.top).toBeCloseTo(0.75, 6);
  });

  it('gives null when the layout lacks the key, or for a team other than 0 and 1', () => {
    // Lane 4 has no tier-1 key for team 0 in this layout.
    expect(objectivePosition(0, identityOf(4), LAYOUT)).toBeNull();
    expect(objectivePosition(2, identityOf(0), LAYOUT)).toBeNull();
  });

  it('takes shrines and base guardians from the hand-placed table', () => {
    for (const team of [0, 1]) {
      for (const index of [1, 2] as const) {
        const identity: ObjectiveIdentity = { kind: 'shrine', lane: null, index };
        expect(objectivePosition(team, identity, LAYOUT)).toBe(
          HAND_PLACED_POSITIONS[`team${String(team)}_shrine_${String(index)}`],
        );
      }
      for (const lane of [1, 3, 4] as const) {
        const identity: ObjectiveIdentity = { kind: 'base_guardian', lane, index: null };
        expect(objectivePosition(team, identity, LAYOUT)).toBe(
          HAND_PLACED_POSITIONS[`team${String(team)}_base_guardian_${String(lane)}`],
        );
      }
    }
  });
});

describe('hand-placed positions', () => {
  it('has every key for both teams', () => {
    const expected = [0, 1].flatMap((team) => [
      `team${String(team)}_shrine_1`,
      `team${String(team)}_shrine_2`,
      `team${String(team)}_base_guardian_1`,
      `team${String(team)}_base_guardian_3`,
      `team${String(team)}_base_guardian_4`,
    ]);
    expect(Object.keys(HAND_PLACED_POSITIONS).toSorted()).toEqual(expected.toSorted());
  });

  it('keeps every position within the picture', () => {
    for (const point of [...Object.values(HAND_PLACED_POSITIONS), MID_BOSS_POSITION]) {
      expect(point.left).toBeGreaterThanOrEqual(0);
      expect(point.left).toBeLessThanOrEqual(1);
      expect(point.top).toBeGreaterThanOrEqual(0);
      expect(point.top).toBeLessThanOrEqual(1);
    }
  });

  it("places team 0's base half a turn from team 1's", () => {
    // Shrines keep their index; team 0's lane 1 faces team 1's lane 4.
    const counterparts = [
      ['shrine_1', 'shrine_1'],
      ['shrine_2', 'shrine_2'],
      ['base_guardian_1', 'base_guardian_4'],
      ['base_guardian_3', 'base_guardian_3'],
      ['base_guardian_4', 'base_guardian_1'],
    ] as const;
    for (const [own, other] of counterparts) {
      const team0 = HAND_PLACED_POSITIONS[`team0_${own}`];
      const team1 = HAND_PLACED_POSITIONS[`team1_${other}`];
      expect((team0?.left ?? 0) + (team1?.left ?? 0)).toBeCloseTo(1, 6);
      expect((team0?.top ?? 0) + (team1?.top ?? 0)).toBeCloseTo(1, 6);
    }
  });

  it('places the mid boss at the centre', () => {
    expect(MID_BOSS_POSITION).toEqual({ left: 0.5, top: 0.5 });
  });
});

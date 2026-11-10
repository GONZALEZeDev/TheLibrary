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

/** A small layout with only the keys these tests read. */
const LAYOUT: MapLayout = {
  radius: 10752,
  imageUrl: 'https://assets-bucket.deadlock-api.com/minimap.png',
  objectivePositions: {
    team0_core: { left: 0.29, top: 0.92 },
    team1_tier2_4: { left: 0.75, top: 0.23 },
  },
  lanes: [],
};

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
  it('reads the walker of team 1 lane 4 as team1_tier2_4 from the layout', () => {
    expect(objectivePosition(1, identityOf(8), LAYOUT)).toEqual({
      left: 0.75,
      top: 0.23,
    });
  });

  it('gives null when the layout lacks the key, or for a team other than 0 and 1', () => {
    const core = identityOf(0);
    expect(objectivePosition(1, core, LAYOUT)).toBeNull();
    expect(objectivePosition(2, core, LAYOUT)).toBeNull();
    expect(objectivePosition(0, core, LAYOUT)).toEqual({ left: 0.29, top: 0.92 });
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

  it('places the mid boss at the centre', () => {
    expect(MID_BOSS_POSITION).toEqual({ left: 0.5, top: 0.5 });
  });
});

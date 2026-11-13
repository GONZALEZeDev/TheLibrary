import { describe, expect, it } from 'vitest';
import type { ReplayView, ReplayViewPlayer } from '../../../../services/match-replay-view';
import {
  DEATH_LEAD_S,
  FULL_MAP,
  instantAt,
  nextEvent,
  panBy,
  positionBetween,
  previousEvent,
  stepEvents,
  trailOf,
  zoomAt,
} from './replay-model';

type Replay = ReplayView & { kind: 'replay' };

/** Build a player with sensible defaults; each test overrides what it looks at. */
function player(overrides: Partial<ReplayViewPlayer>): ReplayViewPlayer {
  return {
    slot: 1,
    side: 'ally',
    isTracked: false,
    heroId: 1,
    heroName: null,
    iconUrl: null,
    hasPath: true,
    positions: [],
    deaths: [],
    ...overrides,
  };
}

/** Build a replay view around the given players, objectives and mid boss kills. */
function replay(overrides: Partial<Replay>): Replay {
  return {
    kind: 'replay',
    durationS: 1000,
    coverage: 'all',
    map: null,
    players: [],
    objectives: [],
    midBossKills: [],
    midBossReturnsS: [],
    ...overrides,
  };
}

describe('positionBetween', () => {
  const positions = [{ left: 0, top: 0 }, { left: 0.2, top: 0.4 }, null, { left: 0.5, top: 0.5 }];

  it('is exact at an integer second', () => {
    expect(positionBetween(positions, 1)).toEqual({ left: 0.2, top: 0.4 });
  });

  it('interpolates linearly at a fractional second', () => {
    const point = positionBetween(positions, 0.5);
    expect(point?.left).toBeCloseTo(0.1);
    expect(point?.top).toBeCloseTo(0.2);
  });

  it('is null when either neighbour is null, or out of range', () => {
    expect(positionBetween(positions, 1.5)).toBeNull();
    expect(positionBetween(positions, 2)).toBeNull();
    expect(positionBetween(positions, 9)).toBeNull();
    expect(positionBetween(positions, -1)).toBeNull();
  });
});

describe('trailOf', () => {
  const positions = [0, 1, 2, 3, 4, 5].map((n) => ({ left: n / 10, top: 0 }));

  it('returns the last samples up to floor(t) in time order', () => {
    expect(trailOf(positions, 4.7, 3).map((p) => p.left)).toEqual([0.2, 0.3, 0.4]);
  });

  it('starts at second 0 early in the match', () => {
    expect(trailOf(positions, 1, 10).map((p) => p.left)).toEqual([0, 0.1]);
  });

  it('stops at a death: nothing before the last null', () => {
    const withDeath = [positions[0] ?? null, positions[1] ?? null, null, positions[3] ?? null];
    expect(trailOf(withDeath, 3, 10)).toEqual([{ left: 0.3, top: 0 }]);
    expect(trailOf(withDeath, 2, 10)).toEqual([]);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the pointer fixed', () => {
    const at = { left: 0.25, top: 0.25 };
    const zoomed = zoomAt(FULL_MAP, at, 2);
    expect(zoomed.scale).toBe(2);
    // The point sits at 25% of the window before and after.
    expect((at.left - zoomed.left) * zoomed.scale).toBeCloseTo(0.25);
    expect((at.top - zoomed.top) * zoomed.scale).toBeCloseTo(0.25);
  });

  it('clamps the scale to 8 and to 1', () => {
    expect(zoomAt(FULL_MAP, { left: 0.5, top: 0.5 }, 100).scale).toBe(8);
    expect(zoomAt(FULL_MAP, { left: 0.5, top: 0.5 }, 0.1)).toEqual(FULL_MAP);
  });

  it('keeps the window inside the map', () => {
    const zoomed = zoomAt(FULL_MAP, { left: 1, top: 1 }, 4);
    expect(zoomed.left).toBeCloseTo(0.75);
    expect(zoomed.top).toBeCloseTo(0.75);
  });
});

describe('panBy', () => {
  it('moves the window', () => {
    expect(panBy({ scale: 2, left: 0.1, top: 0.1 }, 0.2, -0.05)).toEqual({
      scale: 2,
      left: 0.30000000000000004,
      top: 0.05,
    });
  });

  it('never shows outside the map', () => {
    const view = { scale: 2, left: 0.25, top: 0.25 };
    expect(panBy(view, 5, 5)).toEqual({ scale: 2, left: 0.5, top: 0.5 });
    expect(panBy(view, -5, -5)).toEqual({ scale: 2, left: 0, top: 0 });
    expect(panBy(FULL_MAP, 1, 1)).toEqual(FULL_MAP);
  });
});

describe('stepEvents, previousEvent and nextEvent', () => {
  const view = replay({
    durationS: 600,
    players: [
      player({
        slot: 1,
        isTracked: true,
        deaths: [{ timeS: 200, respawnS: 220, killerSlot: null }],
      }),
      player({ slot: 2, deaths: [{ timeS: 300, respawnS: 320, killerSlot: null }] }),
    ],
    objectives: [
      {
        side: 'ally',
        identity: { kind: 'guardian', lane: 1, index: null },
        position: null,
        destroyedAtS: 400,
      },
      {
        side: 'enemy',
        identity: { kind: 'core', lane: null, index: null },
        position: null,
        destroyedAtS: null,
      },
    ],
    midBossKills: [{ timeS: 100, killedBy: 'ally', claimedBy: 'ally' }],
  });

  it('merges objectives, mid boss, tracked deaths and kills, sorted and unique', () => {
    expect(stepEvents(view, [150, 200, 900])).toEqual([100, 150, 200, 400]);
  });

  it('floors fractional times so a step can always be reached', () => {
    expect(stepEvents(view, [150.7, 150.2, 200.9])).toEqual([100, 150, 200, 400]);
  });

  it('excludes the deaths of other players', () => {
    expect(stepEvents(view, [])).not.toContain(300);
  });

  it('finds the previous and next events strictly around the time', () => {
    const times = [100, 150, 200];
    expect(previousEvent(times, 150)).toBe(100);
    expect(nextEvent(times, 150)).toBe(200);
    expect(previousEvent(times, 100)).toBeNull();
    expect(nextEvent(times, 200)).toBeNull();
    expect(previousEvent(times, 160)).toBe(150);
  });

  it('leads a picked death by five seconds', () => {
    expect(DEATH_LEAD_S).toBe(5);
  });
});

describe('instantAt', () => {
  const view = replay({
    durationS: 700,
    players: [
      player({ slot: 3, side: 'enemy', deaths: [{ timeS: 100, respawnS: 130, killerSlot: null }] }),
      player({
        slot: 1,
        isTracked: true,
        hasPath: false,
        deaths: [{ timeS: 100, respawnS: 160, killerSlot: null }],
      }),
      player({ slot: 2, side: 'ally', deaths: [{ timeS: 100, respawnS: null, killerSlot: null }] }),
    ],
    objectives: [
      {
        side: 'ally',
        identity: { kind: 'walker', lane: 1, index: null },
        position: null,
        destroyedAtS: 50,
      },
      {
        side: 'enemy',
        identity: { kind: 'walker', lane: 3, index: null },
        position: null,
        destroyedAtS: 90,
      },
      {
        side: 'enemy',
        identity: { kind: 'core', lane: null, index: null },
        position: null,
        destroyedAtS: 500,
      },
    ],
  });

  it('lists the destroyed objectives, latest first', () => {
    expect(instantAt(view, 100).destroyed.map((o) => o.destroyedAtS)).toEqual([90, 50]);
  });

  it('lists the dead, tracked first then allies then enemies, with the respawn countdown', () => {
    const { dead } = instantAt(view, 100);
    expect(dead.map((d) => d.player.slot)).toEqual([1, 2, 3]);
    // Tracked has no path and is still listed; 60 s left.
    expect(dead.map((d) => d.respawnInS)).toEqual([60, null, 30]);
  });

  it('rounds the countdown up to whole seconds', () => {
    const { dead } = instantAt(view, 100.5);
    expect(dead.find((d) => d.player.slot === 3)?.respawnInS).toBe(30);
  });

  it('gives the next scheduled event strictly after the time', () => {
    expect(instantAt(view, 100).next?.timeS).toBe(120);
    expect(instantAt(view, 120).next?.timeS).toBe(180);
    expect(instantAt(view, 120.4).next?.timeS).toBe(180);
    expect(instantAt(replay({ durationS: 10 }), 5).next).toBeNull();
  });
});

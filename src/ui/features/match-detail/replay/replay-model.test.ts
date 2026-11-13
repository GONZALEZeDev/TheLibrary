import { describe, expect, it } from 'vitest';
import { isDeadAt } from '../../../../core/match-map/match-replay';
import type {
  ReplayView,
  ReplayViewObjective,
  ReplayViewPlayer,
} from '../../../../services/match-replay-view';
import {
  DEATH_LEAD_S,
  feedEvents,
  FULL_MAP,
  LIVE_FEED_SIZE,
  liveFeedAt,
  objectiveHistory,
  playerStatusAt,
  nextEvent,
  panBy,
  positionBetween,
  previousEvent,
  stepEvents,
  trailOf,
  zoomAt,
} from './replay-model';

type Replay = ReplayView & { kind: 'replay' };

/**
 * Build a player with sensible defaults; each test overrides what it looks at. The team follows the
 * side (allies are the Hidden King, enemies the Archmother) unless a test overrides it.
 */
function player(overrides: Partial<ReplayViewPlayer>): ReplayViewPlayer {
  const side = overrides.side ?? 'ally';
  return {
    slot: 1,
    side,
    team: side === 'ally' ? 'hidden_king' : 'archmother',
    isTracked: false,
    heroId: 1,
    heroName: null,
    iconUrl: null,
    hasPath: true,
    positions: [],
    health: [],
    deaths: [],
    ...overrides,
  };
}

/** Build a replay view around the given players, objectives and mid boss kills. */
function replay(overrides: Partial<Replay>): Replay {
  return {
    kind: 'replay',
    durationS: 1000,
    trackedTeam: 'hidden_king',
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
        team: 'hidden_king',
        identity: { kind: 'guardian', lane: 1, index: null },
        position: null,
        destroyedAtS: 400,
      },
      {
        side: 'enemy',
        team: 'archmother',
        identity: { kind: 'core', lane: null, index: null },
        position: null,
        destroyedAtS: null,
      },
    ],
    midBossKills: [
      {
        timeS: 100,
        killedBy: 'ally',
        claimedBy: 'ally',
        killedByTeam: 'hidden_king',
        claimedByTeam: 'hidden_king',
      },
    ],
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

describe('playerStatusAt', () => {
  const hero = player({
    health: [100, 80, 60, null, null, 40],
    deaths: [{ timeS: 3, respawnS: 5, killerSlot: null }],
  });

  it('a dead player shows the countdown, an alive one the health of the whole second', () => {
    expect(playerStatusAt(hero, 3)).toEqual({ kind: 'dead', respawnInS: 2 });
    expect(playerStatusAt(hero, 3.5)).toEqual({ kind: 'dead', respawnInS: 2 });
    expect(playerStatusAt(hero, 1.9)).toEqual({ kind: 'alive', healthPercent: 80 });
    expect(playerStatusAt(hero, 5)).toEqual({ kind: 'alive', healthPercent: 40 });
  });

  it('a dead player without a known respawn has a null countdown', () => {
    const unknown = player({ deaths: [{ timeS: 3, respawnS: null, killerSlot: null }] });
    expect(playerStatusAt(unknown, 3)).toEqual({ kind: 'dead', respawnInS: null });
  });

  it('picks the death the core rule accepts, whatever the order of the deaths', () => {
    // Unsorted on purpose: the later death comes first in the array.
    const twice = player({
      deaths: [
        { timeS: 50, respawnS: 60, killerSlot: null },
        { timeS: 10, respawnS: 40, killerSlot: null },
      ],
    });
    expect(playerStatusAt(twice, 20)).toEqual({ kind: 'dead', respawnInS: 20 });
    expect(playerStatusAt(twice, 45)).toEqual({ kind: 'alive', healthPercent: null });
    expect(playerStatusAt(twice, 55)).toEqual({ kind: 'dead', respawnInS: 5 });
    // An overlapping second death still reports a countdown from a death that covers the moment.
    const overlap = player({
      deaths: [
        { timeS: 10, respawnS: 40, killerSlot: null },
        { timeS: 30, respawnS: 35, killerSlot: null },
      ],
    });
    expect(playerStatusAt(overlap, 32)).toEqual({ kind: 'dead', respawnInS: 8 });
  });

  it('agrees with the core dead rule at every whole and fractional second', () => {
    const many = player({
      deaths: [
        { timeS: 50, respawnS: null, killerSlot: null },
        { timeS: 10, respawnS: 40, killerSlot: null },
        { timeS: 30, respawnS: 35, killerSlot: null },
      ],
    });
    for (let timeS = 0; timeS <= 60; timeS += 0.5) {
      expect(playerStatusAt(many, timeS).kind === 'dead', `t=${String(timeS)}`).toBe(
        isDeadAt(many.deaths, timeS),
      );
    }
  });

  it('no health data gives an alive status with a null percent', () => {
    expect(playerStatusAt(player({}), 10)).toEqual({ kind: 'alive', healthPercent: null });
  });
});

describe('the feed and the history', () => {
  /** An objective of the Archmother with the given lane and fall time. */
  function objective(lane: 1 | 3 | 4, destroyedAtS: number | null): ReplayViewObjective {
    return {
      side: 'enemy',
      team: 'archmother',
      identity: { kind: 'walker', lane, index: null },
      position: null,
      destroyedAtS,
    };
  }

  it('the feed keeps the 5 latest events up to the second, newest first', () => {
    const view = replay({
      players: [
        player({
          slot: 1,
          deaths: [10, 20, 30].map((timeS) => ({ timeS, respawnS: timeS + 5, killerSlot: null })),
        }),
      ],
      objectives: [objective(1, 15), objective(3, null)],
      midBossKills: [
        {
          timeS: 25,
          killedBy: 'ally',
          claimedBy: 'ally',
          killedByTeam: 'hidden_king',
          claimedByTeam: 'hidden_king',
        },
      ],
    });
    const events = feedEvents(view);
    expect(events.map((event) => event.timeS)).toEqual([10, 15, 20, 25, 30]);
    // Nothing after the second of the cursor; the fifth event is hidden at 29.9.
    expect(liveFeedAt(events, 29.9).map((event) => event.timeS)).toEqual([25, 20, 15, 10]);
    expect(liveFeedAt(events, 30).map((event) => event.timeS)).toEqual([30, 25, 20, 15, 10]);
    // A tie inside one second is newest first too: the highest victim slot comes first.
    const tie = feedEvents(
      replay({
        players: [1, 2, 3].map((slot) =>
          player({ slot, deaths: [{ timeS: 7, respawnS: 9, killerSlot: null }] }),
        ),
      }),
    );
    expect(
      liveFeedAt(tie, 7).map((event) => (event.kind === 'death' ? event.victim.slot : 0)),
    ).toEqual([3, 2, 1]);
    expect(LIVE_FEED_SIZE).toBe(5);
    const more = feedEvents(
      replay({
        players: [
          player({
            deaths: [1, 2, 3, 4, 5, 6, 7].map((timeS) => ({
              timeS,
              respawnS: timeS + 1,
              killerSlot: null,
            })),
          }),
        ],
      }),
    );
    expect(liveFeedAt(more, 100).map((event) => event.timeS)).toEqual([7, 6, 5, 4, 3]);
  });

  it('five deaths in one second keep a stable order by slot', () => {
    const view = replay({
      players: [5, 2, 4, 1, 3].map((slot) =>
        player({ slot, deaths: [{ timeS: 40, respawnS: 60, killerSlot: null }] }),
      ),
      objectives: [objective(1, 40)],
    });
    const events = feedEvents(view);
    // The objective comes first in a tie, then the deaths by victim slot.
    expect(events.map((event) => (event.kind === 'death' ? event.victim.slot : 0))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(events[0]?.kind).toBe('objective');
  });

  it('a killer slot of null gives a death without killer', () => {
    const view = replay({
      players: [
        player({ slot: 1, deaths: [{ timeS: 5, respawnS: 9, killerSlot: null }] }),
        player({ slot: 2, side: 'enemy', deaths: [{ timeS: 6, respawnS: 9, killerSlot: 1 }] }),
        player({ slot: 3, deaths: [{ timeS: 7, respawnS: 9, killerSlot: 99 }] }),
        player({ slot: 4, deaths: [{ timeS: 8, respawnS: 9, killerSlot: 4 }] }),
      ],
    });
    const killers = feedEvents(view).map((event) =>
      event.kind === 'death' ? (event.killer?.slot ?? null) : -1,
    );
    expect(killers).toEqual([null, 1, null, null]);
  });

  it('the history lists destroyed objectives only, oldest first', () => {
    const view = replay({
      objectives: [objective(1, 300), objective(3, null), objective(3, 100), objective(4, 300)],
    });
    expect(objectiveHistory(view).map((entry) => entry.identity.lane)).toEqual([3, 1, 4]);
  });
});

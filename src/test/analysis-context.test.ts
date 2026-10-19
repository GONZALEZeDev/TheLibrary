/**
 * Tests of the analysis test builders: what a hand-built snapshot, player and match hold when a test
 * overrides nothing, how an override replaces a field, and what `present` takes and refuses.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { present, testMatchContext, testPlayer, testSnapshot } from './analysis-context';
import { testMatchId } from './test-data';

describe('testSnapshot', () => {
  it('holds the time and the counters it is given', () => {
    expect(testSnapshot(600, { net_worth: 7_000, player_damage: 3_000 })).toEqual({
      timeS: 600,
      stats: { net_worth: 7_000, player_damage: 3_000 },
    });
  });

  it('has no counter when it is given none', () => {
    expect(testSnapshot(180)).toEqual({ timeS: 180, stats: {} });
  });

  it('keeps a counter at zero as a value', () => {
    expect(testSnapshot(180, { boss_damage: 0 }).stats).toEqual({ boss_damage: 0 });
  });
});

describe('testPlayer', () => {
  it('is the first slot of team 0, with no lane, no snapshot and no count', () => {
    expect(testPlayer()).toEqual({
      slot: 1,
      team: 0,
      lane: null,
      kills: 0,
      deaths: 0,
      assists: 0,
      netWorth: 0,
      lastHits: 0,
      denies: 0,
      snapshots: [],
    });
  });

  it('replaces the fields it is given and keeps the other defaults', () => {
    const snapshots = [testSnapshot(600, { net_worth: 7_000 })];
    expect(testPlayer({ slot: 8, team: 1, lane: 2, deaths: 4, snapshots })).toEqual({
      slot: 8,
      team: 1,
      lane: 2,
      kills: 0,
      deaths: 4,
      assists: 0,
      netWorth: 0,
      lastHits: 0,
      denies: 0,
      snapshots,
    });
  });

  it('builds a new player every time', () => {
    expect(testPlayer()).not.toBe(testPlayer());
  });
});

describe('testMatchContext', () => {
  it('is a ranked match of 1934 seconds with the default player alone in it', () => {
    expect(testMatchContext()).toEqual({
      matchId: testMatchId(100_000_001),
      durationS: 1_934,
      matchMode: 4,
      tracked: testPlayer(),
      teammates: [],
      enemies: [],
      laneOpponents: [],
      kills: [],
      trackedBadge: null,
      hasLeaver: false,
    });
  });

  it('replaces the fields it is given and keeps the other defaults', () => {
    const tracked = testPlayer({ slot: 3, lane: 1 });
    const opponent = testPlayer({ slot: 8, team: 1, lane: 1 });
    const kills = [{ timeS: 100, killerSlot: 3, victimSlot: 8 }];
    expect(
      testMatchContext({
        durationS: 600,
        tracked,
        enemies: [opponent],
        laneOpponents: [opponent],
        kills,
        trackedBadge: 43,
        hasLeaver: true,
      }),
    ).toEqual({
      matchId: testMatchId(100_000_001),
      durationS: 600,
      matchMode: 4,
      tracked,
      teammates: [],
      enemies: [opponent],
      laneOpponents: [opponent],
      kills,
      trackedBadge: 43,
      hasLeaver: true,
    });
  });

  it('keeps a badge of null and a duration of 0 as values, not as a request for the default', () => {
    const context = testMatchContext({ durationS: 0, trackedBadge: null });
    expect(context.durationS).toBe(0);
    expect(context.trackedBadge).toBeNull();
  });
});

describe('present', () => {
  it('gives the value back', () => {
    const value = { answer: 42 };
    expect(present(value)).toBe(value);
  });

  it('accepts a value that is falsy but there', () => {
    expect(present(0)).toBe(0);
    expect(present('')).toBe('');
    expect(present(false)).toBe(false);
  });

  it('throws when the value is undefined', () => {
    expect(() => {
      present(undefined);
    }).toThrow('The test expected a value');
  });

  it('throws when the value is null', () => {
    expect(() => present(null)).toThrow('The test expected a value');
  });
});

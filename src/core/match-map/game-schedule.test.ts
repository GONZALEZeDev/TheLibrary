import { describe, expect, it } from 'vitest';
import { TROOPER_WAVES, midBossReturns, scheduleOccurrences } from './game-schedule';

describe('scheduleOccurrences', () => {
  it('a 33-minute match has Soul Urns at 10:00, 15:00 … 30:00', () => {
    const urns = scheduleOccurrences(33 * 60).filter((o) => o.kind === 'soul_urn');
    expect(urns.map((o) => o.timeS)).toEqual([600, 900, 1200, 1500, 1800]);
    expect(urns.every((o) => o.untilS === null)).toBe(true);
  });

  it('the rift is one window 600–720', () => {
    const rifts = scheduleOccurrences(33 * 60).filter((o) => o.kind === 'unstable_rift');
    expect(rifts).toEqual([{ kind: 'unstable_rift', timeS: 600, untilS: 720 }]);
  });

  it('occurrences never pass the match end', () => {
    const occurrences = scheduleOccurrences(1000);
    expect(occurrences.length).toBeGreaterThan(0);
    expect(occurrences.every((o) => o.timeS <= 1000)).toBe(true);
  });

  it('leaves out once-entries and the rift that start after the match end', () => {
    const kinds = scheduleOccurrences(400).map((o) => o.kind);
    expect(kinds).not.toContain('large_camps');
    expect(kinds).not.toContain('sinners_sacrifice');
    expect(kinds).not.toContain('soul_urn');
    expect(kinds).not.toContain('unstable_rift');
    expect(kinds).toContain('medium_camps');
  });

  it('is sorted by time, ties keeping the schedule order', () => {
    const occurrences = scheduleOccurrences(700);
    const times = occurrences.map((o) => o.timeS);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // At 300 s the medium camps come before the bridge power-ups; at 480 s the large camps first.
    const at300 = occurrences.filter((o) => o.timeS === 300).map((o) => o.kind);
    expect(at300).toEqual(['medium_camps', 'bridge_powerups']);
    const at480 = occurrences.filter((o) => o.timeS === 480).map((o) => o.kind);
    expect(at480).toEqual(['large_camps', 'sinners_sacrifice']);
  });
});

describe('TROOPER_WAVES', () => {
  it('trooper waves change at 20:00 and 35:00', () => {
    expect(TROOPER_WAVES).toEqual([
      { fromS: 0, everyS: 30 },
      { fromS: 1200, everyS: 25 },
      { fromS: 2100, everyS: 20 },
    ]);
  });
});

describe('midBossReturns', () => {
  it('returns 420 s, 360 s, then 300 s after each kill', () => {
    expect(midBossReturns([1240, 1700, 2100, 2500])).toEqual([1660, 2060, 2400, 2800]);
  });

  it('gives nothing without a kill', () => {
    expect(midBossReturns([])).toEqual([]);
  });
});

/**
 * Tests of the reading of deadlock-api's performance curve
 * (`GET /v1/analytics/player-performance-curve`).
 *
 * Every payload here is synthetic: it has the shape of a real answer (a point per time of the match,
 * with the statistics the app does not read) but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parsePerformanceCurve, type CurvePoint } from './performance-curve.schema';

/**
 * One point of the curve in the exact shape of the API: the average and the standard deviation of
 * the four statistics the app reads (made up from the time), and others it does not.
 *
 * @param gameTime - The time of the point, in seconds since the start of the match.
 * @param overrides - Fields to change (or to add).
 * @returns The raw point.
 */
function rawPoint(gameTime: number, overrides: Record<string, unknown> = {}) {
  return {
    game_time: gameTime,
    net_worth_avg: gameTime * 10,
    net_worth_std: gameTime / 2,
    player_damage_avg: gameTime * 5,
    player_damage_std: gameTime / 4,
    boss_damage_avg: gameTime * 2,
    boss_damage_std: gameTime / 5,
    kills_avg: gameTime / 100,
    kills_std: gameTime / 200,
    deaths_avg: gameTime / 150,
    deaths_std: gameTime / 300,
    assists_avg: gameTime / 50,
    assists_std: gameTime / 100,
    permanent_buffs_avg: null,
    permanent_buffs_std: null,
    ...overrides,
  };
}

/**
 * The point the parser must read for a point made by {@link rawPoint}.
 *
 * @param gameTime - The time of the point.
 * @returns The expected point.
 */
function expectedPoint(gameTime: number): CurvePoint {
  return {
    timeS: gameTime,
    avg: {
      net_worth: gameTime * 10,
      player_damage: gameTime * 5,
      boss_damage: gameTime * 2,
      kills: gameTime / 100,
    },
    std: {
      net_worth: gameTime / 2,
      player_damage: gameTime / 4,
      boss_damage: gameTime / 5,
      kills: gameTime / 200,
    },
  };
}

/**
 * A raw point with one field removed.
 *
 * @param gameTime - The time of the point.
 * @param field - The field to remove.
 * @returns The raw point without the field.
 */
function rawPointWithout(gameTime: number, field: string): Record<string, unknown> {
  const point: Record<string, unknown> = rawPoint(gameTime);
  Reflect.deleteProperty(point, field);
  return point;
}

describe('parsePerformanceCurve', () => {
  it('parses the curve points sorted', () => {
    const body = [rawPoint(900), rawPoint(180), rawPoint(1200), rawPoint(540)];

    expect(parsePerformanceCurve(body)).toEqual([
      expectedPoint(180),
      expectedPoint(540),
      expectedPoint(900),
      expectedPoint(1200),
    ]);
  });

  it('reads the four statistics, and nothing else of a point', () => {
    const [point] = parsePerformanceCurve([rawPoint(720, { gold_lane_creeps_avg: 7 })]);

    expect(point).toEqual(expectedPoint(720));
  });

  it('parses an empty curve', () => {
    expect(parsePerformanceCurve([])).toEqual([]);
  });

  it('keeps a point at the start of the match and a point with no spread', () => {
    const body = [
      rawPoint(0),
      rawPoint(180, { net_worth_std: 0, player_damage_std: 0, boss_damage_std: 0, kills_std: 0 }),
    ];

    const curve = parsePerformanceCurve(body);

    expect(curve.map((point) => point.timeS)).toEqual([0, 180]);
    expect(curve[1]?.std).toEqual({ net_worth: 0, player_damage: 0, boss_damage: 0, kills: 0 });
  });

  it('leaves out a point without kills_std', () => {
    const body = [rawPoint(180), rawPointWithout(360, 'kills_std'), rawPoint(540)];

    expect(parsePerformanceCurve(body).map((point) => point.timeS)).toEqual([180, 540]);
  });

  it('leaves out a point missing any of the eight fields, or the time', () => {
    const fields = [
      'game_time',
      'net_worth_avg',
      'net_worth_std',
      'player_damage_avg',
      'player_damage_std',
      'boss_damage_avg',
      'boss_damage_std',
      'kills_avg',
      'kills_std',
    ];
    for (const field of fields) {
      expect(parsePerformanceCurve([rawPointWithout(360, field), rawPoint(180)])).toEqual([
        expectedPoint(180),
      ]);
    }
  });

  it('leaves out the points it cannot read', () => {
    const unreadable: unknown[] = [
      // The time: negative, not a whole number, not a number.
      rawPoint(-180),
      rawPoint(180.5),
      rawPoint(360, { game_time: '360' }),
      rawPoint(360, { game_time: null }),
      // An average: not a number, null, not finite.
      rawPoint(360, { net_worth_avg: '3600' }),
      rawPoint(360, { player_damage_avg: null }),
      rawPoint(360, { boss_damage_avg: Infinity }),
      rawPoint(360, { kills_avg: NaN }),
      // A spread: negative, not a number, not finite.
      rawPoint(360, { net_worth_std: -1 }),
      rawPoint(360, { player_damage_std: '1' }),
      rawPoint(360, { boss_damage_std: Infinity }),
      rawPoint(360, { kills_std: -0.001 }),
      // Not even an object.
      null,
      'text',
      42,
      [rawPoint(360)],
    ];

    for (const element of unreadable) {
      expect(parsePerformanceCurve([element, rawPoint(180)])).toEqual([expectedPoint(180)]);
      expect(parsePerformanceCurve([element])).toEqual([]);
    }
  });

  it('keeps the first of two points of the same time', () => {
    const body = [rawPoint(540, { net_worth_avg: 1 }), rawPoint(180), rawPoint(540)];

    const curve = parsePerformanceCurve(body);

    expect(curve.map((point) => point.timeS)).toEqual([180, 540]);
    expect(curve[1]?.avg.net_worth).toBe(1);
  });

  it('does not let an unreadable point hide a readable one of the same time', () => {
    const body = [rawPoint(540, { kills_std: null }), rawPoint(540, { net_worth_avg: 2 })];

    const curve = parsePerformanceCurve(body);

    expect(curve).toHaveLength(1);
    expect(curve[0]?.avg.net_worth).toBe(2);
  });

  it('refuses a body that is not an array, without quoting it', () => {
    // The planted text, like any value of the body, must stay out of the error.
    const planted = 'Planted 987654321';
    const bodies: unknown[] = [
      null,
      undefined,
      planted,
      987654321,
      {},
      { points: [rawPoint(180)] },
    ];
    for (const body of bodies) {
      expect(() => parsePerformanceCurve(body)).toThrow(
        expect.objectContaining({
          kind: 'invalid_payload',
          message: 'The performance curve is invalid',
          context: { issue: '(root): invalid_type' },
        }),
      );
    }
  });
});

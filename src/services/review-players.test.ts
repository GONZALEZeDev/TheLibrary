/**
 * Tests of the rows of the players tab of the review ({@link playerRowsOf}): the player's place
 * among the players of each match on each figure of the scoreboard, and how often they are in
 * Valve's top three, on matches whose stored values are written by hand.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { VALVE_RANK_KEY, scoreboardPlaceKey } from '../core/analysis/review/review-values';
import { SCOREBOARD_PLACE_STATS, type PlaceStat } from '../core/match-detail/scoreboard';
import { testMatchId } from '../test/test-data';
import type { RecentMatch } from './metrics.repository';
import { playerRowsOf } from './review-players';
import type { ReviewMatch } from './review-view';

/** The length of the matches of the tests, in seconds. */
const DURATION_S = 1_800;

/** The id of the most recent match of the tests; the earlier ones count down from it. */
const LAST_MATCH_ID = 600_000;

/** The start of the most recent match of the tests, in Unix seconds. */
const LAST_START_TIME = 1_790_000_000;

/** The time between the starts of two matches of the tests, in seconds. */
const MATCH_GAP_S = 3_600;

/**
 * One of the player's matches, numbered from the most recent (0) back.
 *
 * @param index - Its place from the most recent match: its id and start count down with it.
 * @param values - The values stored for it, by key.
 * @returns The match.
 */
function recentMatch(index: number, values: Readonly<Record<string, number>>): RecentMatch {
  return {
    matchId: testMatchId(LAST_MATCH_ID - index),
    startTime: LAST_START_TIME - index * MATCH_GAP_S,
    durationS: DURATION_S,
    values: new Map(Object.entries(values)),
  };
}

/**
 * The last matches of the tests, with no tier data: the players tab reads none.
 *
 * @param valuesOfEach - The values stored for each match, the most recent first.
 * @returns The matches.
 */
function lastMatches(valuesOfEach: readonly Readonly<Record<string, number>>[]): ReviewMatch[] {
  return valuesOfEach.map((values, index) => ({
    match: recentMatch(index, values),
    reference: null,
  }));
}

/**
 * The matches before the last ones, numbered after them.
 *
 * @param valuesOfEach - The values stored for each match, the most recent first.
 * @param firstIndex - The place of the first of them from the most recent match.
 * @returns The matches.
 */
function earlierMatches(
  valuesOfEach: readonly Readonly<Record<string, number>>[],
  firstIndex: number,
): RecentMatch[] {
  return valuesOfEach.map((values, offset) => recentMatch(firstIndex + offset, values));
}

/**
 * The values of a match that took the same place on one figure of the scoreboard.
 *
 * @param stat - The figure.
 * @param place - The place.
 * @returns The values, by key.
 */
function placed(stat: PlaceStat, place: number): Record<string, number> {
  return { [scoreboardPlaceKey(stat)]: place };
}

describe('playerRowsOf', () => {
  it('gives the mean place among the players for each stat', () => {
    const places = [1, 2, 3, 6, 10, 12];
    const recent = lastMatches(places.map((place) => placed('netWorth', place)));
    // Five earlier matches took the 10th place; two others have no place at all (no scoreboard), and
    // are not counted as a place of 0: the figure before stays 10.
    const before = earlierMatches(
      [
        placed('netWorth', 10),
        {},
        placed('netWorth', 10),
        placed('netWorth', 10),
        {},
        placed('netWorth', 10),
        placed('netWorth', 10),
      ],
      places.length,
    );

    const { places: rows } = playerRowsOf(recent, before);

    // One row for each figure of the scoreboard, in the order it declares them.
    expect(rows.map(({ subject }) => subject)).toEqual(
      SCOREBOARD_PLACE_STATS.map((stat) => ({ kind: 'place', stat })),
    );
    const [netWorth, ...others] = rows;
    expect(netWorth).toMatchObject({
      unit: 'place',
      better: 'lower',
      count: 6,
      comparedValue: null,
      reference: null,
      difference: null,
      percentile: null,
      // Places 1 to 3 are strong, 10 to 12 weak, the places in between neither: 3 strong, 2 weak.
      weak: 2,
      strong: 3,
      marked: 6,
      side: 'strength',
      // Ten each time before, and the place fell: it is an improvement for a place.
      progress: { before: 10, direction: 'better' },
    });
    // The place is a rank, so the figure is its mean: (1 + 2 + 3 + 6 + 10 + 12) / 6.
    expect(netWorth?.value).toBeCloseTo(34 / 6, 10);
    expect(netWorth?.matches.map(({ value, mark }) => [value, mark])).toEqual([
      [1, 'strong'],
      [2, 'strong'],
      [3, 'strong'],
      [6, null],
      [10, 'weak'],
      [12, 'weak'],
    ]);
    // A figure no match has a place for still has its row, and says nothing.
    for (const row of others) {
      expect(row).toMatchObject({ value: null, count: 0, marked: 0, side: null, matches: [] });
    }
  });

  it('leaves the top three out of matches that have none', () => {
    // Ranks of the matches that have a top three; two others have none (no key at all).
    const recent = lastMatches([
      { [VALVE_RANK_KEY]: 1 },
      {},
      { [VALVE_RANK_KEY]: 0 },
      { [VALVE_RANK_KEY]: 0 },
      { [VALVE_RANK_KEY]: 3 },
      {},
      { [VALVE_RANK_KEY]: 0 },
      { [VALVE_RANK_KEY]: 2 },
    ]);
    // Five earlier matches had the player in the top three; two others have no top three. If those
    // two were counted as a miss, the figure before would be 5 / 7 and not 1.
    const before = earlierMatches(
      [
        { [VALVE_RANK_KEY]: 1 },
        {},
        { [VALVE_RANK_KEY]: 1 },
        { [VALVE_RANK_KEY]: 1 },
        {},
        { [VALVE_RANK_KEY]: 1 },
        { [VALVE_RANK_KEY]: 1 },
      ],
      recent.length,
    );

    const { topThree } = playerRowsOf(recent, before);

    expect(topThree).toMatchObject({
      subject: { kind: 'valve_top_three' },
      unit: 'rate',
      better: 'higher',
      // Three of the six matches that have a top three: the player was in it in rank 1, 3 and 2.
      value: 0.5,
      count: 6,
      comparedValue: null,
      reference: null,
      difference: null,
      percentile: null,
      weak: 0,
      strong: 3,
      marked: 6,
      side: 'strength',
      // In it every time before, and in half the matches now.
      progress: { before: 1, direction: 'worse' },
    });
    // The matches without a top three are not in the row, and the others are marked by their rank.
    expect(topThree.matches.map(({ matchId, value, mark }) => [matchId, value, mark])).toEqual([
      [testMatchId(LAST_MATCH_ID), 1, 'strong'],
      [testMatchId(LAST_MATCH_ID - 2), 0, null],
      [testMatchId(LAST_MATCH_ID - 3), 0, null],
      [testMatchId(LAST_MATCH_ID - 4), 1, 'strong'],
      [testMatchId(LAST_MATCH_ID - 6), 0, null],
      [testMatchId(LAST_MATCH_ID - 7), 1, 'strong'],
    ]);
  });

  it('gives the average place in the top three, in the matches that were in it', () => {
    // Ranks of the last matches: six in the top three, two outside it, one with no top three.
    const recent = lastMatches(
      [1, 2, 3, 1, 0, 2, 3, 0, undefined].map((rank) =>
        rank === undefined ? {} : { [VALVE_RANK_KEY]: rank },
      ),
    );
    // Five earlier matches were 3rd. Two were outside the top three and one had none: they have no
    // place in it, and are not a place of 0 (the figure before would then be 15 / 8 and not 3).
    const before = earlierMatches(
      [3, 0, 3, 3, undefined, 3, 0, 3].map((rank) =>
        rank === undefined ? {} : { [VALVE_RANK_KEY]: rank },
      ),
      recent.length,
    );

    const { topThreePlace } = playerRowsOf(recent, before);

    expect(topThreePlace).toMatchObject({
      subject: { kind: 'valve_top_three_place' },
      unit: 'place',
      better: 'lower',
      // The mean of 1, 2, 3, 1, 2 and 3: the 0 of a match outside the top three is not a place.
      value: 2,
      count: 6,
      comparedValue: null,
      reference: null,
      difference: null,
      percentile: null,
      // Getting into the top three is judged by the other row; its place is not weak or strong.
      weak: 0,
      strong: 0,
      marked: 0,
      side: null,
      // Third each time before, and now 2nd on average: a better place is a lower number.
      progress: { before: 3, direction: 'better' },
    });
    expect(topThreePlace.matches.map(({ matchId, value, mark }) => [matchId, value, mark])).toEqual(
      [
        [testMatchId(LAST_MATCH_ID), 1, null],
        [testMatchId(LAST_MATCH_ID - 1), 2, null],
        [testMatchId(LAST_MATCH_ID - 2), 3, null],
        [testMatchId(LAST_MATCH_ID - 3), 1, null],
        [testMatchId(LAST_MATCH_ID - 5), 2, null],
        [testMatchId(LAST_MATCH_ID - 6), 3, null],
      ],
    );
  });

  it('judges the places in the middle of the table neither weak nor strong', () => {
    // Fourth to ninth place are neither: the matches are judged all the same, and the row is not listed.
    const recent = lastMatches([4, 5, 6, 7, 8, 9].map((place) => placed('lastHits', place)));

    const { places } = playerRowsOf(recent, []);

    const lastHits = places.at(-1);
    expect(lastHits).toMatchObject({ count: 6, weak: 0, strong: 0, marked: 6, side: null });
    expect(lastHits?.progress).toEqual({ before: null, direction: null });
  });
});

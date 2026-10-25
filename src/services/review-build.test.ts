/**
 * Tests of the assembly of the review ({@link buildReview}), on matches, community data, an item
 * catalogue and a loadout written by hand: the two windows, the tier's data each match is compared
 * with and the state of that comparison, the sections that need the catalogue, the twelve resistance
 * items and the summary of the points that were flagged.
 *
 * The rows themselves are tested with their builders (`./review-stats`, `./review-deaths`,
 * `./review-players`): what is checked here is how they are put together.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  durationWindowOf,
  cohortKey,
  type CohortRank,
  type DurationWindow,
} from '../core/analysis/cohort';
import { damageSourceKey } from '../core/analysis/damage-sources';
import type { MetricKey } from '../core/analysis/metric';
import { RESISTANCE_ITEMS } from '../core/analysis/review/resistance-items';
import {
  VALVE_RANK_KEY,
  deathsBeforeItemKey,
  itemBoughtAtKey,
  phaseDeathsKey,
  phaseDeathsWindowKey,
  scoreboardPlaceKey,
} from '../core/analysis/review/review-values';
import type { CatalogueItem } from '../core/deadlock-api/assets.schema';
import type { MetricBenchmark } from '../core/deadlock-api/metric-benchmark.schema';
import type { CurvePoint } from '../core/deadlock-api/performance-curve.schema';
import type { HeroLoadout } from '../core/domain/hero';
import { SCOREBOARD_PLACE_STATS, type PlaceStat } from '../core/match-detail/scoreboard';
import { testMatchId } from '../test/test-data';
import type { CohortRead } from './benchmark.service';
import type { ItemCatalogue } from './game-asset.service';
import type { ItemBenchmarkRead } from './item-benchmark.service';
import type { RecentMatch } from './metrics.repository';
import { buildReview, type ReviewInputs } from './review-build';
import type { ResistanceReview, Review, ReviewRow } from './review-view';

/** The tier the player is compared with in the tests: Phantom's tier (7). */
const RANK: CohortRank = { kind: 'tier', tier: 7 };

/** The length of most matches of the tests, in seconds: a match of the 30–35 minute window. */
const DURATION_S = 1_800;

/** The length of a longer match: the 40–45 minute window. */
const LONG_DURATION_S = 2_400;

/** The length of a shorter match: the 20–25 minute window. */
const SHORT_DURATION_S = 1_300;

/** The length of the shortest matches: the first window, under 20 minutes. */
const SHORTEST_DURATION_S = 1_000;

/** The id of the most recent match of the tests; the earlier ones count down from it. */
const LAST_MATCH_ID = 500_000;

/** The start of the most recent match of the tests, in Unix seconds. */
const LAST_START_TIME = 1_790_000_000;

/** The time between the starts of two matches of the tests, in seconds. */
const MATCH_GAP_S = 3_600;

/** When the community data was downloaded, in Unix ms: the freshest of the tests. */
const FETCHED_AT = 1_790_100_000_000;

/** An earlier download than {@link FETCHED_AT}. */
const OLDER_FETCHED_AT = FETCHED_AT - 90_000_000;

/** The deaths of the tier at the nine percentile points, for the shorter matches: the median is 4. */
const LOW_DEATHS_TABLE = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The deaths of the tier for the longer matches: far above the other table. */
const HIGH_DEATHS_TABLE = [20, 21, 22, 23, 24, 25, 26, 27, 28];

/**
 * A point of the deaths curve of the tier. Only the deaths are read by the tests; every other
 * counter holds a value of its own, far from the deaths.
 *
 * @param timeS - The time of the point, in seconds since the start of the match.
 * @param deathsAvg - The average of the deaths so far.
 * @param deathsStd - The deviation of the deaths so far.
 * @returns The point.
 */
function deathsPoint(timeS: number, deathsAvg: number, deathsStd: number): CurvePoint {
  return {
    timeS,
    avg: {
      net_worth: 5_555,
      player_damage: 1_111,
      boss_damage: 2_222,
      kills: 3_333,
      deaths: deathsAvg,
    },
    std: { net_worth: 555, player_damage: 111, boss_damage: 222, kills: 333, deaths: deathsStd },
  };
}

/**
 * The deaths of the tier in a match of 30 minutes. Over the early game it dies 3 times (a deviation
 * of 1.5), over the mid game 5 times (a deviation of 2) and over the last five minutes about 3 times.
 */
const DEATHS_CURVE: readonly CurvePoint[] = [
  deathsPoint(600, 3, 1.5),
  deathsPoint(1_500, 8, 2.5),
  deathsPoint(1_800, 11, 3.5),
];

/** The class names of the weapon, the melee and the ability of the loadout of the tests. */
const WEAPON = 'citadel_weapon_bookworm_set2';
const MELEE = 'ability_melee_bookworm';
const BOOKWYRM = 'ability_bookworm_dragonfire';

/** The loadout of the hero of the tests. */
const LOADOUT: HeroLoadout = { weapon: WEAPON, melee: MELEE, abilities: [BOOKWYRM] };

/** The asset id of the first resistance item of the tests; the others follow it, in list order. */
const FIRST_ITEM_ID = 5_000;

/** The values of a match, by key. */
type Values = Readonly<Record<string, number>>;

/**
 * One of the player's matches, numbered from the most recent (0) back.
 *
 * @param index - Its place from the most recent match: its id and start count down with it.
 * @param values - The values stored for it, by key.
 * @param durationS - Its length, in seconds.
 * @returns The match.
 */
function recentMatch(
  index: number,
  values: Values = {},
  durationS: number = DURATION_S,
): RecentMatch {
  return {
    matchId: testMatchId(LAST_MATCH_ID - index),
    startTime: LAST_START_TIME - index * MATCH_GAP_S,
    durationS,
    values: new Map(Object.entries(values)),
  };
}

/**
 * A listing of matches, most recent first.
 *
 * @param count - How many matches.
 * @param valuesOf - The values stored for the match at an index.
 * @param durationOf - The length of the match at an index; {@link DURATION_S} by default.
 * @returns The matches.
 */
function listing(
  count: number,
  valuesOf: (index: number) => Values = () => ({}),
  durationOf: (index: number) => number = () => DURATION_S,
): RecentMatch[] {
  return Array.from({ length: count }, (_unused, index) =>
    recentMatch(index, valuesOf(index), durationOf(index)),
  );
}

/** What the community data of a duration window of the tests differs by. */
interface ReadOptions {
  /** The rank the data is of; `null` for data that holds too few matches even over every rank. */
  readonly used?: CohortRank | null;
  /** Whether the data is a day old or more. */
  readonly stale?: boolean;
  /** When the data was downloaded (Unix ms). */
  readonly fetchedAt?: number;
  /** The deaths of the tier at the nine percentile points. */
  readonly table?: readonly number[];
  /** The average course of a match in the cohort. */
  readonly curve?: readonly CurvePoint[];
}

/**
 * The community data the cache holds for the tier and the duration window of a match.
 *
 * @param durationS - The length of the match, in seconds: it gives the duration window.
 * @param options - See {@link ReadOptions}: a fresh read of the tier by default.
 * @returns What the cache read.
 */
function cachedRead(durationS: number, options: ReadOptions = {}): CohortRead {
  const {
    used = RANK,
    stale = false,
    fetchedAt = FETCHED_AT,
    table = LOW_DEATHS_TABLE,
    curve = [],
  } = options;
  const window: DurationWindow = durationWindowOf(durationS);
  return {
    kind: 'cached',
    stale,
    data: {
      wanted: { rank: RANK, window },
      used: used === null ? null : { rank: used, window },
      sampleMatches: used === null ? 3 : 500,
      benchmark: new Map([['deaths', table]]) satisfies MetricBenchmark,
      curve,
      fetchedAt,
    },
  };
}

/**
 * The cache of the community data, by cohort key.
 *
 * @param reads - The data of the cohort of each length, for the tier of the tests.
 * @returns The reads, keyed as the review reads them.
 */
function cohortsOf(
  reads: readonly (readonly [durationS: number, read: CohortRead])[],
): ReadonlyMap<string, CohortRead> {
  return new Map(
    reads.map(([durationS, read]) => [
      cohortKey({ rank: RANK, window: durationWindowOf(durationS) }),
      read,
    ]),
  );
}

/** The tests' review inputs with no match, no community data and no catalogue. */
const NOTHING: ReviewInputs = {
  recent: [],
  rank: RANK,
  comparedWith: 'tier_above',
  cohorts: new Map(),
  itemBenchmark: { kind: 'missing' },
  catalogue: null,
  loadout: null,
};

/** The lane gap at 10:00 that a letter of a pattern stands for, in souls: lost, won, or even. */
const LANE_GAP_OF: Readonly<Record<string, number>> = { w: -600, s: 600, n: 0 };

/** The place that a letter of a pattern stands for: the 11th (weak), the 1st (strong) or the 6th. */
const PLACE_OF: Readonly<Record<string, number>> = { w: 11, s: 1, n: 6 };

/** The rank in Valve's top three that a letter of a pattern stands for: the 1st, or none. */
const TOP_THREE_RANK_OF: Readonly<Record<string, number>> = { s: 1, n: 0 };

/**
 * How the points of a listing go from match to match. Each is a string with a letter for every match,
 * the most recent first: `w` for a match that is weak for the point, `s` for one that is strong, `n`
 * for one that is neither, and `.` (or no letter at all) for one that has no value.
 */
interface Pattern {
  /** The lane gap at 10:00. */
  readonly lane?: string;
  /** The place among the players on each figure of the scoreboard. */
  readonly places?: Readonly<Partial<Record<PlaceStat, string>>>;
  /** The place in Valve's top three. */
  readonly topThree?: string;
}

/**
 * A listing of matches whose points are weak, strong or neither as a pattern says, by the fixed rules.
 *
 * @param count - How many matches.
 * @param pattern - See {@link Pattern}.
 * @returns The matches, most recent first.
 */
function flaggedListing(count: number, pattern: Pattern): RecentMatch[] {
  return listing(count, (index) => {
    const values: Record<string, number> = {};
    const put = (
      key: string,
      letters: string | undefined,
      table: Readonly<Record<string, number>>,
    ): void => {
      const value = table[letters?.charAt(index) ?? ''];
      if (value !== undefined) {
        values[key] = value;
      }
    };
    put('lane_souls_diff_at_10min', pattern.lane, LANE_GAP_OF);
    for (const stat of SCOREBOARD_PLACE_STATS) {
      put(scoreboardPlaceKey(stat), pattern.places?.[stat], PLACE_OF);
    }
    put(VALVE_RANK_KEY, pattern.topThree, TOP_THREE_RANK_OF);
    return values;
  });
}

/**
 * Build the review of some matches.
 *
 * @param inputs - What differs from {@link NOTHING}.
 * @returns The review.
 */
function reviewOf(inputs: Partial<ReviewInputs>): Review {
  return buildReview({ ...NOTHING, ...inputs });
}

/**
 * Find the row of a metric of the whole match in the stats tab.
 *
 * @param review - The review.
 * @param key - The metric.
 * @returns Its row.
 * @throws Error when the tab has no row for it (a failure of the test).
 */
function metricRow(review: Review, key: MetricKey): ReviewRow {
  const row = review.stats.families
    .flatMap((family) => family.rows)
    .find((candidate) => candidate.subject.kind === 'metric' && candidate.subject.key === key);
  if (row === undefined) {
    throw new Error(`The stats tab has no row for ${key}`);
  }
  return row;
}

/**
 * Find the row of a place in the players tab.
 *
 * @param review - The review.
 * @param stat - The figure of the scoreboard.
 * @returns Its row.
 * @throws Error when the tab has no row for it (a failure of the test).
 */
function placeRow(review: Review, stat: PlaceStat): ReviewRow {
  const row = review.players.places.find(
    (candidate) => candidate.subject.kind === 'place' && candidate.subject.stat === stat,
  );
  if (row === undefined) {
    throw new Error(`The players tab has no row for ${stat}`);
  }
  return row;
}

/**
 * Name the point of a row, short enough to compare lists of rows.
 *
 * @param row - The row.
 * @returns The key of a metric, `<kind>.<phase>` for the deaths of a phase, `<kind>.<class name>` for
 *   a resistance item, the figure of a place, or the kind of any other point.
 */
function labelOf(row: ReviewRow): string {
  const { subject } = row;
  switch (subject.kind) {
    case 'metric':
      return subject.key;
    case 'phase_deaths':
      return `${subject.kind}.${subject.phase}`;
    case 'resistance_minute':
    case 'resistance_rate':
      return `${subject.kind}.${subject.item.className}`;
    case 'place':
      return subject.stat;
    default:
      return subject.kind;
  }
}

/**
 * The entry of the catalogue of a resistance item.
 *
 * @param index - Its place in the list of resistance items.
 * @returns The entry, with the id, name and image the tests expect for it. Its tier is one above
 *   the tier of the list, so that a view that read the tier from the catalogue would be told apart.
 */
function resistanceEntry(index: number): CatalogueItem {
  const item = RESISTANCE_ITEMS[index];
  if (item === undefined) {
    throw new Error(`There is no resistance item ${String(index)}`);
  }
  return {
    id: FIRST_ITEM_ID + index,
    className: item.className,
    name: `Test item ${String(index)}`,
    kind: 'upgrade',
    slot: 'vitality',
    tier: item.tier + 1,
    imageUrl: `https://assets-bucket.deadlock-api.com/${item.className}.webp`,
  };
}

/**
 * A catalogue of the tests: the entries given, indexed both ways.
 *
 * @param entries - The entries.
 * @returns The catalogue.
 */
function catalogueOf(entries: readonly CatalogueItem[]): ItemCatalogue {
  return {
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    byClassName: new Map(entries.map((entry) => [entry.className, entry])),
  };
}

/**
 * An entry of the catalogue for a source of the loadout: no slot, no tier, no image.
 *
 * @param id - The asset id.
 * @param className - The class name.
 * @param kind - The kind of the entry.
 * @returns The entry.
 */
function loadoutEntry(id: number, className: string, kind: 'weapon' | 'ability'): CatalogueItem {
  return { id, className, name: className, kind, slot: null, tier: null, imageUrl: null };
}

/** The catalogue that knows all the resistance items and the damage sources of the loadout. */
function fullCatalogue(): ItemCatalogue {
  return catalogueOf([
    ...RESISTANCE_ITEMS.map((_item, index) => resistanceEntry(index)),
    loadoutEntry(8_001, WEAPON, 'weapon'),
    loadoutEntry(8_002, MELEE, 'ability'),
    loadoutEntry(8_003, BOOKWYRM, 'ability'),
  ]);
}

describe('buildReview', () => {
  describe('the two windows', () => {
    it('builds a review from 3 matches with counts but no figures', () => {
      // Three matches are too few for a figure (five are needed), but every count is there.
      const recent = listing(3, () => ({
        [scoreboardPlaceKey('netWorth')]: 1,
        deaths: 3,
      }));

      const review = reviewOf({ recent });

      expect(review.recent).toEqual({
        count: 3,
        firstStartTime: LAST_START_TIME - 2 * MATCH_GAP_S,
        lastStartTime: LAST_START_TIME,
      });
      expect(review.before).toEqual({ count: 0, firstStartTime: null, lastStartTime: null });
      expect(review.community).toEqual({
        kind: 'missing',
        rank: RANK,
        comparedWith: 'tier_above',
        itemStatsDue: false,
      });
      const netWorth = placeRow(review, 'netWorth');
      expect(netWorth).toMatchObject({
        value: null,
        count: 3,
        weak: 0,
        strong: 3,
        marked: 3,
        side: 'strength',
        progress: { before: null, direction: null },
      });
      expect(netWorth.matches).toHaveLength(3);
      // A metric of a match that has no tier data keeps its value count, and has no mark.
      expect(metricRow(review, 'deaths')).toMatchObject({
        value: null,
        count: 3,
        comparedValue: null,
        reference: null,
        difference: null,
        percentile: null,
        marked: 0,
        side: null,
      });
      // The point that was strong in every match is listed, with its counts, and nothing else is.
      expect(review.summary.strengths).toEqual([netWorth]);
      expect(review.summary.weaknesses).toEqual([]);
    });

    it('answers an empty review for a player with no match', () => {
      const review = reviewOf({});

      expect(review.recent).toEqual({ count: 0, firstStartTime: null, lastStartTime: null });
      expect(review.before).toEqual({ count: 0, firstStartTime: null, lastStartTime: null });
      expect(review.community).toEqual({
        kind: 'missing',
        rank: RANK,
        comparedWith: 'tier_above',
        itemStatsDue: false,
      });
      expect(review.summary).toEqual({ weaknesses: [], strengths: [] });
      expect(placeRow(review, 'netWorth')).toMatchObject({ count: 0, value: null, side: null });
    });

    it('splits the last 20 matches from the 20 before', () => {
      // The 20 most recent matches took the 4th place, the 20 before them the 8th.
      const recent = listing(40, (index) => ({
        [scoreboardPlaceKey('netWorth')]: index < 20 ? 4 : 8,
      }));

      const review = reviewOf({ recent });

      expect(review.recent).toEqual({
        count: 20,
        firstStartTime: LAST_START_TIME - 19 * MATCH_GAP_S,
        lastStartTime: LAST_START_TIME,
      });
      expect(review.before).toEqual({
        count: 20,
        firstStartTime: LAST_START_TIME - 39 * MATCH_GAP_S,
        lastStartTime: LAST_START_TIME - 20 * MATCH_GAP_S,
      });
      const netWorth = placeRow(review, 'netWorth');
      expect(netWorth.count).toBe(20);
      expect(netWorth.value).toBe(4);
      expect(netWorth.progress).toEqual({ before: 8, direction: 'better' });
      // The rows hold the 20 last matches, most recent first, and none of the 20 before.
      expect(netWorth.matches.map(({ matchId }) => matchId)).toEqual(
        recent.slice(0, 20).map(({ matchId }) => matchId),
      );
    });

    it('keeps what is left after the last 20 matches as the matches before', () => {
      const review = reviewOf({ recent: listing(27) });

      expect(review.recent.count).toBe(20);
      expect(review.before).toEqual({
        count: 7,
        firstStartTime: LAST_START_TIME - 26 * MATCH_GAP_S,
        lastStartTime: LAST_START_TIME - 20 * MATCH_GAP_S,
      });
    });
  });

  describe('the tier data each match is compared with', () => {
    it('compares each match with the data of its own duration window', () => {
      // The same 10 deaths: far above the tier of the shorter window (weak), far below the tier of the
      // longer one (strong). A match read against the other window's data would swap its verdict.
      const recent = [
        recentMatch(0, { deaths: 10 }, DURATION_S),
        recentMatch(1, { deaths: 10 }, LONG_DURATION_S),
        recentMatch(2, { deaths: 10 }, DURATION_S),
      ];
      const cohorts = cohortsOf([
        [DURATION_S, cachedRead(DURATION_S)],
        [LONG_DURATION_S, cachedRead(LONG_DURATION_S, { table: HIGH_DEATHS_TABLE })],
      ]);

      const review = reviewOf({ recent, cohorts });

      expect(
        metricRow(review, 'deaths').matches.map(({ matchId, mark }) => [matchId, mark]),
      ).toEqual([
        [testMatchId(LAST_MATCH_ID), 'weak'],
        [testMatchId(LAST_MATCH_ID - 1), 'strong'],
        [testMatchId(LAST_MATCH_ID - 2), 'weak'],
      ]);
      expect(review.community).toMatchObject({ kind: 'available', missingMatches: 0 });
    });

    describe('says which cohort was used', () => {
      it('counts the matches on every rank, the ones with no data, and takes the oldest download', () => {
        // 0, 1: the tier, fresh. 2, 3: every rank, stale and older. 4: nothing cached. 5: cached, but
        // with too few matches even over every rank, so there is nothing to compare with.
        const recent = [
          recentMatch(0, {}, DURATION_S),
          recentMatch(1, {}, DURATION_S),
          recentMatch(2, {}, LONG_DURATION_S),
          recentMatch(3, {}, LONG_DURATION_S),
          recentMatch(4, {}, SHORT_DURATION_S),
          recentMatch(5, {}, SHORTEST_DURATION_S),
        ];
        const cohorts = cohortsOf([
          [DURATION_S, cachedRead(DURATION_S)],
          [
            LONG_DURATION_S,
            cachedRead(LONG_DURATION_S, {
              used: { kind: 'all' },
              stale: true,
              fetchedAt: OLDER_FETCHED_AT,
            }),
          ],
          [SHORTEST_DURATION_S, cachedRead(SHORTEST_DURATION_S, { used: null })],
        ]);

        const { community } = reviewOf({ recent, cohorts });

        expect(community).toEqual({
          kind: 'available',
          rank: RANK,
          comparedWith: 'tier_above',
          itemStatsDue: false,
          fallbackMatches: 2,
          missingMatches: 2,
          stale: true,
          fetchedAt: OLDER_FETCHED_AT,
        });
      });

      it('is not stale when no data used is', () => {
        const recent = listing(3);
        const cohorts = cohortsOf([[DURATION_S, cachedRead(DURATION_S)]]);

        expect(reviewOf({ recent, cohorts }).community).toEqual({
          kind: 'available',
          rank: RANK,
          comparedWith: 'tier_above',
          itemStatsDue: false,
          fallbackMatches: 0,
          missingMatches: 0,
          stale: false,
          fetchedAt: FETCHED_AT,
        });
      });

      it('does not count the data of a match that was not used', () => {
        // The stale, older data is of a window no match of the review is in.
        const cohorts = cohortsOf([
          [DURATION_S, cachedRead(DURATION_S)],
          [
            LONG_DURATION_S,
            cachedRead(LONG_DURATION_S, { stale: true, fetchedAt: OLDER_FETCHED_AT }),
          ],
        ]);

        const { community } = reviewOf({ recent: listing(3), cohorts });

        expect(community).toMatchObject({ stale: false, fetchedAt: FETCHED_AT });
      });

      it('is missing when no match has data of the rank asked for', () => {
        const otherRank = new Map([
          [
            cohortKey({ rank: { kind: 'all' }, window: durationWindowOf(DURATION_S) }),
            cachedRead(DURATION_S),
          ],
        ]);
        const unavailable = cohortsOf([[DURATION_S, cachedRead(DURATION_S, { used: null })]]);

        for (const cohorts of [new Map<string, CohortRead>(), otherRank, unavailable]) {
          expect(reviewOf({ recent: listing(4), cohorts }).community).toEqual({
            kind: 'missing',
            rank: RANK,
            comparedWith: 'tier_above',
            itemStatsDue: false,
          });
        }
      });

      it.each(['tier_above', 'own_tier', 'every_rank'] as const)(
        'says the rank was chosen as %s, with or without a comparison',
        (comparedWith) => {
          const cohorts = cohortsOf([[DURATION_S, cachedRead(DURATION_S)]]);

          // The builder does not choose the rank, it tells how it was chosen: as given, for a
          // review that is compared with the rank and for one that is not.
          expect(reviewOf({ recent: listing(3), cohorts, comparedWith }).community).toMatchObject({
            kind: 'available',
            comparedWith,
          });
          expect(reviewOf({ recent: listing(3), comparedWith }).community).toMatchObject({
            kind: 'missing',
            comparedWith,
          });
        },
      );
    });
  });

  describe('says whether the item statistics are due', () => {
    /**
     * The item statistics of the tier, as the cache holds them.
     *
     * @param stale - Whether they are a day old or more.
     * @returns What the service reads.
     */
    function cachedItems(stale: boolean): ItemBenchmarkRead {
      return {
        kind: 'cached',
        stale,
        data: {
          wanted: RANK,
          used: RANK,
          sampleMatches: 200,
          items: new Map(),
          fetchedAt: FETCHED_AT,
        },
      };
    }

    it.each([
      { what: 'are not cached', itemBenchmark: { kind: 'missing' }, due: true },
      { what: 'are a day old or more', itemBenchmark: cachedItems(true), due: true },
      { what: 'are fresh', itemBenchmark: cachedItems(false), due: false },
    ] as const)('says $due when the item statistics $what', ({ itemBenchmark, due }) => {
      const recent = listing(3);
      const cohorts = cohortsOf([[DURATION_S, cachedRead(DURATION_S)]]);
      const catalogue = fullCatalogue();

      // Whether the matches are compared with the tier or not does not change it: the item
      // statistics are cached apart from the cohorts, and the page asks for them apart.
      expect(reviewOf({ recent, cohorts, itemBenchmark, catalogue }).community).toMatchObject({
        kind: 'available',
        itemStatsDue: due,
      });
      expect(reviewOf({ recent, itemBenchmark, catalogue }).community).toMatchObject({
        kind: 'missing',
        itemStatsDue: due,
      });
    });

    it('says they are due when the catalogue knows only some of the resistance items', () => {
      const catalogue = catalogueOf([resistanceEntry(0)]);

      const { community } = reviewOf({
        recent: listing(3),
        itemBenchmark: { kind: 'missing' },
        catalogue,
      });

      expect(community).toMatchObject({ itemStatsDue: true });
    });

    it('says they are not due when there is nothing to ask for', () => {
      // Without the catalogue, or with one that knows none of the resistance items, the download
      // finds no item to ask the statistics of: a page that asked would learn nothing.
      const catalogues = [
        null,
        catalogueOf([]),
        catalogueOf([loadoutEntry(8_001, WEAPON, 'weapon')]),
      ];

      for (const catalogue of catalogues) {
        const { community } = reviewOf({
          recent: listing(3),
          itemBenchmark: { kind: 'missing' },
          catalogue,
        });

        expect(community).toMatchObject({ itemStatsDue: false });
      }
    });
  });

  describe('the sections that need the catalogue', () => {
    it('answers them unavailable without a catalogue', () => {
      const review = reviewOf({ recent: listing(6), catalogue: null, loadout: LOADOUT });

      expect(review.deaths.resistance).toEqual({ kind: 'catalogue_unavailable' });
      expect(review.damage).toEqual({ kind: 'catalogue_unavailable' });
      // The rest of the review does not need it.
      expect(review.deaths.phases).toHaveLength(3);
      expect(review.stats.phases.length).toBeGreaterThan(0);
      expect(review.players.places).toHaveLength(5);
    });

    it('answers the damage unavailable without a loadout, and gives the resistance', () => {
      const review = reviewOf({ recent: listing(6), catalogue: fullCatalogue(), loadout: null });

      expect(review.damage).toEqual({ kind: 'catalogue_unavailable' });
      expect(review.deaths.resistance.kind).toBe('ready');
    });

    it('shares the damage over the last matches and the ones before', () => {
      // The weapon dealt 3 000 of 4 000 over the last matches, and 1 000 of 2 000 before them.
      const recent = listing(21, (index) =>
        index < 20
          ? { [damageSourceKey(WEAPON)]: 150, [damageSourceKey(BOOKWYRM)]: 50 }
          : { [damageSourceKey(WEAPON)]: 1_000, [damageSourceKey(BOOKWYRM)]: 1_000 },
      );

      const { damage } = reviewOf({ recent, catalogue: fullCatalogue(), loadout: LOADOUT });

      if (damage.kind !== 'ready') {
        throw new Error('The damage should be ready');
      }
      expect(
        damage.value.map(({ className, shareNow, shareBefore }) => [
          className,
          shareNow,
          shareBefore,
        ]),
      ).toEqual([
        [WEAPON, 0.75, 0.5],
        [BOOKWYRM, 0.25, 0.5],
      ]);
    });

    it('names the twelve resistance items in list order, and keeps one the catalogue lacks', () => {
      // Colossus (the last item) is not in the catalogue. The catalogue puts every other item one tier
      // above the list: the list holds the tier, and the catalogue is read for the rest.
      const unknown = RESISTANCE_ITEMS.length - 1;
      const known = RESISTANCE_ITEMS.flatMap((_item, index) =>
        index === unknown ? [] : [resistanceEntry(index)],
      );

      const { deaths } = reviewOf({
        recent: listing(6),
        catalogue: catalogueOf(known),
        loadout: LOADOUT,
      });

      const resistance = readyResistance(deaths.resistance);
      expect(resistance.items.map(({ item }) => item)).toEqual(
        RESISTANCE_ITEMS.map(({ className, protects, tier }, index) =>
          index === unknown
            ? { itemId: null, className, name: null, imageUrl: null, tier, protects }
            : {
                itemId: FIRST_ITEM_ID + index,
                className,
                name: `Test item ${String(index)}`,
                imageUrl: `https://assets-bucket.deadlock-api.com/${className}.webp`,
                tier,
                protects,
              },
        ),
      );
      // Every item has its two rows, known or not.
      expect(resistance.items).toHaveLength(12);
    });

    it('compares the resistance items with the statistics of the tier, and lists their rows', () => {
      // The player buys the first item at 6:30 in five matches. The tier buys it at 10:00 to 10:59.
      const itemId = FIRST_ITEM_ID;
      const recent = listing(5, () => ({ [itemBoughtAtKey(itemId)]: 390 }));
      const itemBenchmark: ItemBenchmarkRead = {
        kind: 'cached',
        stale: false,
        data: {
          wanted: RANK,
          used: RANK,
          sampleMatches: 200,
          items: new Map([[itemId, { purchases: 100, minutes: new Map([[10, 100]]) }]]),
          fetchedAt: FETCHED_AT,
        },
      };

      const review = reviewOf({
        recent,
        itemBenchmark,
        catalogue: fullCatalogue(),
        loadout: LOADOUT,
      });

      const [first] = readyResistance(review.deaths.resistance).items;
      expect(first?.minute).toMatchObject({
        value: 6.5,
        reference: 10.5,
        strong: 5,
        marked: 5,
        side: 'strength',
      });
      expect(first?.rate).toMatchObject({ value: 1, reference: 0.5, side: null });
      // The row of the tab is the row of the summary.
      expect(review.summary.strengths).toContain(first?.minute);
    });
  });

  describe('the summary', () => {
    it('lists every flagged point in the summary, the most frequent first', () => {
      // Eight matches, from the most recent. Weak and strong come from the fixed rules: a lane lost or
      // won by 600 souls, the 11th or the 1st place, a rank of 1 in Valve's top three.
      const recent = flaggedListing(8, {
        lane: 'wwwwww..',
        places: {
          netWorth: 'wwwwwwwn',
          heroDamage: 'wwwwwwsn',
          objectiveDamage: 'wwwwwwnn',
          support: 'sssswnnn',
          lastHits: 'ssssnnnn',
        },
        topThree: 'ssssnnnn',
      });

      const review = reviewOf({ recent });

      // Weak most often first; at the same count, the point that is less often strong; at the same
      // two counts, the order of the tabs (the stats, then the places in the order of the scoreboard).
      expect(review.summary.weaknesses.map(labelOf)).toEqual([
        'netWorth',
        'lane_souls_diff_at_10min',
        'objectiveDamage',
        'heroDamage',
      ]);
      expect(review.summary.weaknesses.map(({ weak, strong }) => [weak, strong])).toEqual([
        [7, 0],
        [6, 0],
        [6, 0],
        [6, 1],
      ]);
      // The same the other way round: strong most often first, then the one less often weak.
      expect(review.summary.strengths.map(labelOf)).toEqual([
        'lastHits',
        'valve_top_three',
        'support',
      ]);
      expect(review.summary.strengths.map(({ weak, strong }) => [weak, strong])).toEqual([
        [0, 4],
        [0, 4],
        [1, 4],
      ]);
      // No point is cut from the list, and each row is the very row of its tab.
      expect(review.summary.weaknesses[0]).toBe(placeRow(review, 'netWorth'));
      expect(review.summary.weaknesses[1]).toBe(metricRow(review, 'lane_souls_diff_at_10min'));
      expect(review.summary.strengths[1]).toBe(review.players.topThree);
    });

    it('keeps the order of the tabs for points flagged as often as each other', () => {
      // Six matches of eight are weak, and none strong, for every point below, so they tie on both
      // counts. In the other two matches no point has a value (the lane is even, the place is the 6th,
      // no deaths in a phase, no shop purchase). The tier buys both items at the 5th minute and the
      // player after it.
      const items = [FIRST_ITEM_ID, FIRST_ITEM_ID + 1];
      const recent = listing(8, (index) =>
        index < 6
          ? {
              lane_souls_diff_at_10min: -600,
              [phaseDeathsKey('early')]: 12,
              [phaseDeathsWindowKey('early')]: 12,
              [phaseDeathsKey('mid')]: 15,
              [phaseDeathsWindowKey('mid')]: 15,
              [phaseDeathsKey('late')]: 12,
              [phaseDeathsWindowKey('late')]: 12,
              // The first of the two is bought first, with three deaths before it.
              [itemBoughtAtKey(FIRST_ITEM_ID)]: 400,
              [itemBoughtAtKey(FIRST_ITEM_ID + 1)]: 500,
              [deathsBeforeItemKey(FIRST_ITEM_ID)]: 3,
              [scoreboardPlaceKey('netWorth')]: 11,
            }
          : { lane_souls_diff_at_10min: 0, [scoreboardPlaceKey('netWorth')]: 6 },
      );
      const itemBenchmark: ItemBenchmarkRead = {
        kind: 'cached',
        stale: false,
        data: {
          wanted: RANK,
          used: RANK,
          sampleMatches: 200,
          items: new Map(
            items.map((itemId) => [itemId, { purchases: 100, minutes: new Map([[5, 100]]) }]),
          ),
          fetchedAt: FETCHED_AT,
        },
      };
      const cohorts = cohortsOf([[DURATION_S, cachedRead(DURATION_S, { curve: DEATHS_CURVE })]]);

      const review = reviewOf({
        recent,
        cohorts,
        itemBenchmark,
        catalogue: fullCatalogue(),
        loadout: LOADOUT,
      });

      // The stats, the deaths of each phase, the resistance rows (the deaths before the first item,
      // then the minute of each item in the order of the list), and the places.
      expect(review.summary.weaknesses.map(labelOf)).toEqual([
        'lane_souls_diff_at_10min',
        'phase_deaths.early',
        'phase_deaths.mid',
        'phase_deaths.late',
        'deaths_before_resistance',
        'resistance_minute.upgrade_regenerating_bullet_shield',
        'resistance_minute.upgrade_weapon_shielding',
        'netWorth',
      ]);
      expect(review.summary.weaknesses.map(({ weak, strong }) => [weak, strong])).toEqual(
        Array.from({ length: 8 }, () => [6, 0]),
      );
      expect(review.summary.strengths).toEqual([]);
      // The minute of the first item and the pick rates are never flagged: no rule marks them.
      const { firstMinute, items: itemReviews } = readyResistance(review.deaths.resistance);
      expect([firstMinute, ...itemReviews.map(({ rate }) => rate)].map(({ side }) => side)).toEqual(
        Array.from({ length: 13 }, () => null),
      );
    });

    it('leaves out a point flagged as often on both sides, and one flagged too rarely', () => {
      // Net worth: four weak matches and four strong ones, so neither side wins. Hero damage: one weak
      // match of eight, which is under a quarter of them.
      const recent = flaggedListing(8, {
        places: { netWorth: 'wwwwssss', heroDamage: 'wnnnnnnn' },
      });

      const review = reviewOf({ recent });

      expect(review.summary).toEqual({ weaknesses: [], strengths: [] });
      expect(placeRow(review, 'netWorth')).toMatchObject({ weak: 4, strong: 4, side: null });
      expect(placeRow(review, 'heroDamage')).toMatchObject({ weak: 1, strong: 0, side: null });
    });
  });
});

/**
 * Read the resistance part of the deaths tab, which the test expects to be there.
 *
 * @param section - The resistance section.
 * @returns Its content.
 * @throws Error when the catalogue was unavailable (a failure of the test).
 */
function readyResistance(section: Review['deaths']['resistance']): ResistanceReview {
  if (section.kind !== 'ready') {
    throw new Error('The resistance section should be ready');
  }
  return section.value;
}

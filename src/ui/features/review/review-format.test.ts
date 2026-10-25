/**
 * Tests of the formatters of the review: how the figure of a point, its weak and strong counts, its
 * progress and its name are written, in English and in French, and the strings of the review page
 * that no formatter writes.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../core/analysis/phases';
import { SCOREBOARD_PLACE_STATS, type PlaceStat } from '../../../core/match-detail/scoreboard';
import type {
  ResistanceItemView,
  ReviewRow,
  ReviewSubject,
  ReviewUnit,
} from '../../../services/review-view';
import { createI18n } from '../../i18n/i18n';
import { NO_VALUE } from '../match-detail/analysis-format';
import {
  formatMarks,
  formatProgress,
  formatReviewGap,
  formatReviewValue,
  reviewLabel,
  reviewRowKey,
} from './review-format';

/** The minus sign the formatters write, instead of the hyphen of the number formats. */
const MINUS = '\u2212';

/**
 * Write the spaces of a number as plain spaces. The language data decides which space it puts
 * before a percent sign or between the digits of a thousand (a no-break space, a narrow one): the
 * tests check where the space is, not which one it is.
 *
 * @param text - A formatted text.
 * @returns The same text with plain spaces.
 */
function plain(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, ' ');
}

/**
 * Get the translation function of one language, as a component gets it from `useTranslation`.
 *
 * @param language - The language.
 * @returns The translation function.
 */
async function translatorOf(language: 'en' | 'fr'): Promise<TFunction> {
  const i18n = await createI18n(language);
  return i18n.getFixedT(language);
}

/**
 * A row of the review, for a number of deaths that nothing compares and nothing marks; a test
 * changes what it is about.
 *
 * @param overrides - The fields that differ from that row.
 * @returns The row.
 */
function rowOf(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    subject: { kind: 'metric', key: 'deaths' },
    unit: 'deaths',
    better: 'lower',
    value: 1.6,
    count: 20,
    comparedValue: 1.6,
    reference: null,
    difference: null,
    percentile: null,
    weak: 0,
    strong: 0,
    marked: 0,
    side: null,
    progress: { before: null, direction: null },
    matches: [],
    ...overrides,
  };
}

/** A resistance item that the catalogue knows. */
const KNOWN_ITEM: ResistanceItemView = {
  itemId: 1_842,
  className: 'upgrade_regenerating_bullet_shield',
  name: 'Battle Vest',
  imageUrl: null,
  tier: 2,
  protects: 'bullet',
};

/** A resistance item that the catalogue does not know: it has its class name and nothing else. */
const UNKNOWN_ITEM: ResistanceItemView = {
  itemId: null,
  className: 'upgrade_colossus',
  name: null,
  imageUrl: null,
  tier: 4,
  protects: 'both',
};

describe('formatReviewValue', () => {
  it.each([
    { unit: 'deaths', value: 1.8, en: '1.8', fr: '1,8' },
    // A number of deaths always has its decimal, so that a column of them lines up.
    { unit: 'deaths', value: 5, en: '5.0', fr: '5,0' },
    { unit: 'deaths', value: 5.04, en: '5.0', fr: '5,0' },
    { unit: 'deaths', value: 12.46, en: '12.5', fr: '12,5' },
    { unit: 'deaths_per_10_min', value: 2.46, en: '2.5 per 10 min', fr: '2,5 pour 10 min' },
    { unit: 'deaths_per_10_min', value: 3, en: '3.0 per 10 min', fr: '3,0 pour 10 min' },
  ] as const)('writes deaths with one decimal in both languages: $unit $value', async (input) => {
    const { unit, value, en, fr } = input;
    expect(formatReviewValue(value, unit, 'en', await translatorOf('en'))).toBe(en);
    expect(formatReviewValue(value, unit, 'fr', await translatorOf('fr'))).toBe(fr);
  });

  it.each([
    // A minute and a place have a decimal only when they are not whole: the figure of one match is a
    // whole place, the figure of many matches is a mean.
    { unit: 'minute', value: 12, en: '12 min', fr: '12 min' },
    { unit: 'minute', value: 12.37, en: '12.4 min', fr: '12,4 min' },
    // A mean place is not an ordinal: French writes "5,7 sur 12", with no "e".
    { unit: 'place', value: 3, en: '3 of 12', fr: '3 sur 12' },
    { unit: 'place', value: 5.67, en: '5.7 of 12', fr: '5,7 sur 12' },
    // A place in Valve's top three is out of three.
    { unit: 'top_three_place', value: 2, en: '2 of 3', fr: '2 sur 3' },
    { unit: 'top_three_place', value: 1.5, en: '1.5 of 3', fr: '1,5 sur 3' },
    { unit: 'rate', value: 0.5, en: '50%', fr: '50 %' },
    { unit: 'rate', value: 1, en: '100%', fr: '100 %' },
    { unit: 'rate', value: 0, en: '0%', fr: '0 %' },
  ] as const)('writes a minute, a place and a rate: $unit $value', async (input) => {
    const { unit, value, en, fr } = input;
    expect(plain(formatReviewValue(value, unit, 'en', await translatorOf('en')))).toBe(en);
    expect(plain(formatReviewValue(value, unit, 'fr', await translatorOf('fr')))).toBe(fr);
  });

  it.each([
    // The units of the metrics of the match page are written as that page writes them.
    { unit: 'ratio', value: 5.04, en: '5.0', fr: '5,0' },
    { unit: 'per_min', value: 1187.4, en: '1,187', fr: '1 187' },
    { unit: 'amount', value: 12345.6, en: '12,346', fr: '12 346' },
    { unit: 'count', value: 7, en: '7', fr: '7' },
    { unit: 'percent', value: 0.41, en: '41%', fr: '41 %' },
  ] as const)('writes the $unit of a metric as the match page does', async (input) => {
    const { unit, value, en, fr } = input;
    expect(plain(formatReviewValue(value, unit, 'en', await translatorOf('en')))).toBe(en);
    expect(plain(formatReviewValue(value, unit, 'fr', await translatorOf('fr')))).toBe(fr);
  });

  it.each([
    // The tier's figure of a count is the middle of many matches, often a half: written whole it
    // would contradict the gap beside it. The figure of one match (the evidence) is whole.
    { value: 4.5, en: '4.5', fr: '4,5' },
    { value: 8.5, en: '8.5', fr: '8,5' },
    { value: 8, en: '8', fr: '8' },
    { value: 12, en: '12', fr: '12' },
    { value: 0, en: '0', fr: '0' },
    // One decimal at most, and none when it rounds to a whole number.
    { value: 3.04, en: '3', fr: '3' },
    { value: 3.46, en: '3.5', fr: '3,5' },
    { value: 1234.5, en: '1,234.5', fr: '1 234,5' },
  ])('writes a count with a decimal only when it is not whole: $value', async (input) => {
    const { value, en, fr } = input;
    expect(plain(formatReviewValue(value, 'count', 'en', await translatorOf('en')))).toBe(en);
    expect(plain(formatReviewValue(value, 'count', 'fr', await translatorOf('fr')))).toBe(fr);
  });

  it.each([
    { language: 'en', you: '8', tier: '4.5', gap: '+3.5' },
    { language: 'fr', you: '8', tier: '4,5', gap: '+3,5' },
  ] as const)(
    'writes the figures of a count and their gap so that they agree in $language',
    async ({ language, you, tier, gap }) => {
      const t = await translatorOf(language);

      // 8 against 4.5 is 3.5 higher: the three texts say the same thing.
      expect(formatReviewValue(8, 'count', language, t)).toBe(you);
      expect(formatReviewValue(4.5, 'count', language, t)).toBe(tier);
      expect(formatReviewGap({ kind: 'absolute', amount: 3.5 }, 'count', language, t)).toBe(gap);
    },
  );

  it('writes a dash for an unknown value, whatever the unit', async () => {
    const units: readonly ReviewUnit[] = [
      'ratio',
      'per_min',
      'amount',
      'count',
      'percent',
      'deaths',
      'deaths_per_10_min',
      'minute',
      'rate',
      'place',
      'top_three_place',
    ];
    const t = await translatorOf('en');

    expect(units.map((unit) => formatReviewValue(null, unit, 'en', t))).toEqual(
      units.map(() => NO_VALUE),
    );
  });

  it('writes a minus sign for a negative figure, never the hyphen of the number formats', async () => {
    // A difference of lane souls is a metric that goes below zero.
    const text = formatReviewValue(-120, 'amount', 'en', await translatorOf('en'));

    expect(text).toBe(`${MINUS}120`);
  });
});

describe('formatMarks', () => {
  it('writes weak and strong counts', async () => {
    const row = rowOf({ weak: 7, strong: 2, marked: 18 });

    expect(formatMarks(row, await translatorOf('en'))).toBe('weak in 7/18 · strong in 2/18');
    expect(formatMarks(row, await translatorOf('fr'))).toBe('faible dans 7/18 · fort dans 2/18');
  });

  it('writes a count of zero, which is an answer', async () => {
    const row = rowOf({ weak: 0, strong: 0, marked: 20 });

    expect(formatMarks(row, await translatorOf('en'))).toBe('weak in 0/20 · strong in 0/20');
  });

  it('writes nothing for a point no match could judge', async () => {
    // A point without a rule (the minute of the first resistance item) is judged in no match.
    const row = rowOf({ weak: 0, strong: 0, marked: 0 });

    expect(formatMarks(row, await translatorOf('en'))).toBe('');
    expect(formatMarks(row, await translatorOf('fr'))).toBe('');
  });
});

describe('formatProgress', () => {
  it.each([
    { direction: 'better', en: '1.8 → 1.6 · better', fr: '1,8 → 1,6 · mieux' },
    { direction: 'worse', en: '1.8 → 1.6 · worse', fr: '1,8 → 1,6 · moins bien' },
    { direction: 'stable', en: '1.8 → 1.6 · stable', fr: '1,8 → 1,6 · stable' },
  ] as const)('writes a progress with its word: $direction', async ({ direction, en, fr }) => {
    const row = rowOf({ value: 1.6, progress: { before: 1.8, direction } });

    expect(formatProgress(row, 'en', await translatorOf('en'))).toBe(en);
    expect(formatProgress(row, 'fr', await translatorOf('fr'))).toBe(fr);
  });

  it('writes the figures in the unit of the row', async () => {
    const row = rowOf({
      unit: 'minute',
      value: 11.5,
      progress: { before: 13, direction: 'better' },
    });

    expect(formatProgress(row, 'en', await translatorOf('en'))).toBe('13 min → 11.5 min · better');
  });

  it('writes the move of a point that is neither better nor worse when higher, with no word', async () => {
    // How often an item is bought has no direction: it moved, and that is all that is known.
    const row = rowOf({
      unit: 'rate',
      better: null,
      value: 0.52,
      progress: { before: 0.45, direction: null },
    });

    expect(plain(formatProgress(row, 'en', await translatorOf('en')))).toBe('45% → 52%');
    expect(plain(formatProgress(row, 'fr', await translatorOf('fr')))).toBe('45 % → 52 %');
  });

  it.each([
    {
      name: 'earlier matches are too few',
      value: 1.6,
      progress: { before: null, direction: null },
    },
    {
      name: 'the last matches are too few',
      value: null,
      progress: { before: 1.8, direction: null },
    },
    { name: 'neither is known', value: null, progress: { before: null, direction: null } },
  ] as const)('writes a dash when $name', async ({ value, progress }) => {
    const row = rowOf({ value, progress });

    expect(formatProgress(row, 'en', await translatorOf('en'))).toBe(NO_VALUE);
    expect(formatProgress(row, 'fr', await translatorOf('fr'))).toBe(NO_VALUE);
  });
});

describe('formatReviewGap', () => {
  it('writes a dash when the row has no gap, whatever the unit', async () => {
    const units: readonly ReviewUnit[] = ['ratio', 'deaths', 'minute', 'place', 'rate'];
    const t = await translatorOf('fr');

    expect(units.map((unit) => formatReviewGap(null, unit, 'fr', t))).toEqual(
      units.map(() => NO_VALUE),
    );
  });

  it.each([
    // A relative gap is a signed percentage, whatever the unit of the row.
    { unit: 'deaths', ratio: 0.12, en: '+12%', fr: '+12 %' },
    { unit: 'deaths_per_10_min', ratio: -0.25, en: `${MINUS}25%`, fr: `${MINUS}25 %` },
    { unit: 'per_min', ratio: 0.5, en: '+50%', fr: '+50 %' },
    { unit: 'amount', ratio: -0.04, en: `${MINUS}4%`, fr: `${MINUS}4 %` },
  ] as const)('writes a relative gap of $unit as a signed percent', async (input) => {
    const gap = { kind: 'relative', ratio: input.ratio } as const;

    const en = formatReviewGap(gap, input.unit, 'en', await translatorOf('en'));
    const fr = formatReviewGap(gap, input.unit, 'fr', await translatorOf('fr'));

    expect(plain(en)).toBe(input.en);
    expect(plain(fr)).toBe(input.fr);
  });

  it.each([
    // Deaths, alone or for ten minutes, have one decimal; a gap that rounds to zero has no sign.
    { unit: 'deaths', amount: 0.34, en: '+0.3', fr: '+0,3' },
    { unit: 'deaths', amount: -0.82, en: `${MINUS}0.8`, fr: `${MINUS}0,8` },
    { unit: 'deaths', amount: 2, en: '+2.0', fr: '+2,0' },
    { unit: 'deaths', amount: -0.04, en: '0.0', fr: '0,0' },
    { unit: 'deaths_per_10_min', amount: 0.34, en: '+0.3', fr: '+0,3' },
    { unit: 'deaths_per_10_min', amount: -1.26, en: `${MINUS}1.3`, fr: `${MINUS}1,3` },
    // A minute keeps its unit, and a decimal when it is not whole.
    { unit: 'minute', amount: 1.5, en: '+1.5 min', fr: '+1,5 min' },
    { unit: 'minute', amount: -2, en: `${MINUS}2 min`, fr: `${MINUS}2 min` },
    // A place is a signed number: the sign says higher or lower, not better or worse.
    { unit: 'place', amount: -0.82, en: `${MINUS}0.8`, fr: `${MINUS}0,8` },
    { unit: 'place', amount: 1, en: '+1', fr: '+1' },
    { unit: 'top_three_place', amount: 0.5, en: '+0.5', fr: '+0,5' },
    { unit: 'top_three_place', amount: -1, en: `${MINUS}1`, fr: `${MINUS}1` },
    // The gap between two rates is in points, since a percentage of a percentage means little.
    { unit: 'rate', amount: 0.04, en: '+4 pts', fr: '+4 pts' },
    { unit: 'rate', amount: -0.1, en: `${MINUS}10 pts`, fr: `${MINUS}10 pts` },
  ] as const)('writes an absolute gap of $amount in $unit', async (input) => {
    const gap = { kind: 'absolute', amount: input.amount } as const;

    const en = formatReviewGap(gap, input.unit, 'en', await translatorOf('en'));
    const fr = formatReviewGap(gap, input.unit, 'fr', await translatorOf('fr'));

    expect(plain(en)).toBe(input.en);
    expect(plain(fr)).toBe(input.fr);
  });

  it.each([
    // The units of the metrics of the match page: the gap is written as that page writes it.
    { unit: 'ratio', amount: 0.5, en: '+0.5', fr: '+0,5' },
    { unit: 'per_min', amount: 12.4, en: '+12', fr: '+12' },
    { unit: 'amount', amount: 1234.6, en: '+1,235', fr: '+1 235' },
    { unit: 'count', amount: 1.4, en: '+1.4', fr: '+1,4' },
    { unit: 'percent', amount: -0.1, en: `${MINUS}10 pts`, fr: `${MINUS}10 pts` },
  ] as const)('writes an absolute gap in $unit as the match page does', async (input) => {
    const gap = { kind: 'absolute', amount: input.amount } as const;

    const en = formatReviewGap(gap, input.unit, 'en', await translatorOf('en'));
    const fr = formatReviewGap(gap, input.unit, 'fr', await translatorOf('fr'));

    expect(plain(en)).toBe(input.en);
    expect(plain(fr)).toBe(input.fr);
  });
});

describe('reviewLabel', () => {
  /** The name of each kind of subject, in English and in French; a new kind is a type error here. */
  const NAMES = {
    metric: {
      subject: { kind: 'metric', key: 'souls_per_min' },
      en: 'Souls per min',
      fr: 'Âmes par min',
    },
    phase_deaths: {
      subject: { kind: 'phase_deaths', phase: 'mid' },
      en: 'Deaths in mid',
      fr: 'Morts en mid',
    },
    resistance_minute: {
      subject: { kind: 'resistance_minute', item: KNOWN_ITEM },
      en: 'Battle Vest · Bought at',
      fr: 'Battle Vest · Acheté à',
    },
    resistance_rate: {
      subject: { kind: 'resistance_rate', item: KNOWN_ITEM },
      en: 'Battle Vest · Bought',
      fr: 'Battle Vest · Acheté',
    },
    first_resistance_minute: {
      subject: { kind: 'first_resistance_minute' },
      en: 'Your first resistance item',
      fr: 'Ton premier objet de résistance',
    },
    deaths_before_resistance: {
      subject: { kind: 'deaths_before_resistance' },
      en: 'Deaths before your first resistance item',
      fr: 'Morts avant ton premier objet de résistance',
    },
    place: {
      subject: { kind: 'place', stat: 'netWorth' },
      en: 'Place in Souls',
      fr: 'Place en Âmes',
    },
    valve_top_three: {
      subject: { kind: 'valve_top_three' },
      en: "In Valve's top three",
      fr: 'Dans le top 3 de Valve',
    },
    valve_top_three_place: {
      subject: { kind: 'valve_top_three_place' },
      en: "Average place in Valve's top three",
      fr: 'Place moyenne dans le top 3 de Valve',
    },
  } as const satisfies Record<
    ReviewSubject['kind'],
    { readonly subject: ReviewSubject; readonly en: string; readonly fr: string }
  >;

  it.each(Object.entries(NAMES))('names every kind of subject: %s', async (_kind, input) => {
    expect(reviewLabel(input.subject, await translatorOf('en'), 'en')).toBe(input.en);
    expect(reviewLabel(input.subject, await translatorOf('fr'), 'fr')).toBe(input.fr);
  });

  it('names a metric of a phase with its figure and its phase', async () => {
    const subject: ReviewSubject = { kind: 'metric', key: 'hero_damage_per_min_early' };

    expect(reviewLabel(subject, await translatorOf('en'), 'en')).toBe('Damage to heroes in early');
    expect(reviewLabel(subject, await translatorOf('fr'), 'fr')).toBe('Dégâts aux héros en early');
  });

  it.each([
    { phase: 'early', en: 'Deaths in early', fr: 'Morts en early' },
    { phase: 'mid', en: 'Deaths in mid', fr: 'Morts en mid' },
    { phase: 'late', en: 'Deaths in late', fr: 'Morts en late' },
  ] as const)('names the deaths of the $phase phase', async ({ phase, en, fr }) => {
    const subject: ReviewSubject = { kind: 'phase_deaths', phase };

    expect(reviewLabel(subject, await translatorOf('en'), 'en')).toBe(en);
    expect(reviewLabel(subject, await translatorOf('fr'), 'fr')).toBe(fr);
  });

  it('names an item the catalogue does not know by its class name', async () => {
    const minute: ReviewSubject = { kind: 'resistance_minute', item: UNKNOWN_ITEM };
    const rate: ReviewSubject = { kind: 'resistance_rate', item: UNKNOWN_ITEM };

    expect(reviewLabel(minute, await translatorOf('en'), 'en')).toBe(
      'upgrade_colossus · Bought at',
    );
    expect(reviewLabel(rate, await translatorOf('fr'), 'fr')).toBe('upgrade_colossus · Acheté');
  });

  it('tells the two rows of one item apart', async () => {
    const t = await translatorOf('en');

    const minute = reviewLabel({ kind: 'resistance_minute', item: KNOWN_ITEM }, t, 'en');
    const rate = reviewLabel({ kind: 'resistance_rate', item: KNOWN_ITEM }, t, 'en');

    expect(minute).not.toBe(rate);
  });

  it.each(['en', 'fr'] as const)(
    'gives each figure of the scoreboard its own place name in %s, never its key',
    async (language) => {
      const t = await translatorOf(language);

      const labels = SCOREBOARD_PLACE_STATS.map((stat) =>
        reviewLabel({ kind: 'place', stat }, t, language),
      );

      expect(labels).toHaveLength(SCOREBOARD_PLACE_STATS.length);
      // A missing string would come back as its key ("players.columns.souls"), not as words.
      expect(labels.filter((label) => /\b(players|analysis|review)\./.test(label))).toEqual([]);
      expect(new Set(labels).size).toBe(labels.length);
    },
  );

  /**
   * The name of the place on each figure of the scoreboard: the full name of the figure, not the
   * abbreviated column of the players table ("Dégâts obj."). A new figure is a type error here.
   */
  const PLACE_NAMES = {
    netWorth: { en: 'Place in Souls', fr: 'Place en Âmes' },
    heroDamage: { en: 'Place in Damage to heroes', fr: 'Place en Dégâts aux héros' },
    objectiveDamage: { en: 'Place in Damage to objectives', fr: 'Place en Dégâts aux objectifs' },
    support: { en: 'Place in Healing and barriers', fr: 'Place en Soins et barrières' },
    lastHits: { en: 'Place in Last hits', fr: 'Place en Last hits' },
  } as const satisfies Record<PlaceStat, { readonly en: string; readonly fr: string }>;

  it.each(SCOREBOARD_PLACE_STATS)(
    'names the place on the %s with the full name of the figure',
    async (stat) => {
      const subject: ReviewSubject = { kind: 'place', stat };

      expect(reviewLabel(subject, await translatorOf('en'), 'en')).toBe(PLACE_NAMES[stat].en);
      expect(reviewLabel(subject, await translatorOf('fr'), 'fr')).toBe(PLACE_NAMES[stat].fr);
    },
  );
});

describe('reviewRowKey', () => {
  /**
   * One point of each kind, with the key it gets. A new kind of point is a type error here, so that
   * it cannot be left without a test.
   */
  const KEY_OF_KIND = {
    metric: { subject: { kind: 'metric', key: 'deaths' }, key: 'metric.deaths' },
    phase_deaths: {
      subject: { kind: 'phase_deaths', phase: 'mid' },
      key: 'phase_deaths.mid',
    },
    resistance_minute: {
      subject: { kind: 'resistance_minute', item: KNOWN_ITEM },
      key: 'resistance_minute.upgrade_regenerating_bullet_shield',
    },
    resistance_rate: {
      subject: { kind: 'resistance_rate', item: KNOWN_ITEM },
      key: 'resistance_rate.upgrade_regenerating_bullet_shield',
    },
    first_resistance_minute: {
      subject: { kind: 'first_resistance_minute' },
      key: 'first_resistance_minute',
    },
    deaths_before_resistance: {
      subject: { kind: 'deaths_before_resistance' },
      key: 'deaths_before_resistance',
    },
    place: { subject: { kind: 'place', stat: 'netWorth' }, key: 'place.netWorth' },
    valve_top_three: { subject: { kind: 'valve_top_three' }, key: 'valve_top_three' },
    valve_top_three_place: {
      subject: { kind: 'valve_top_three_place' },
      key: 'valve_top_three_place',
    },
  } as const satisfies Record<
    ReviewSubject['kind'],
    { readonly subject: ReviewSubject; readonly key: string }
  >;

  it.each(Object.entries(KEY_OF_KIND))('keys a %s point by what names it', (_kind, expected) => {
    expect(reviewRowKey(expected.subject)).toBe(expected.key);
  });

  it('gives a different key to the point of every kind', () => {
    const keys = Object.values(KEY_OF_KIND).map(({ subject }) => reviewRowKey(subject));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives the same key to the same point, from one call to the next', () => {
    const subject: ReviewSubject = { kind: 'resistance_rate', item: KNOWN_ITEM };

    expect(reviewRowKey(subject)).toBe(reviewRowKey({ ...subject }));
  });

  it('tells two metrics, two phases and two places apart', () => {
    expect(reviewRowKey({ kind: 'metric', key: 'deaths' })).not.toBe(
      reviewRowKey({ kind: 'metric', key: 'kda' }),
    );
    // A metric of a phase is a metric: its key names the phase already.
    expect(reviewRowKey({ kind: 'metric', key: 'kills_per_min_mid' })).not.toBe(
      reviewRowKey({ kind: 'metric', key: 'kills_per_min_late' }),
    );
    expect(new Set(PHASES.map((phase) => reviewRowKey({ kind: 'phase_deaths', phase }))).size).toBe(
      PHASES.length,
    );
    expect(
      new Set(SCOREBOARD_PLACE_STATS.map((stat) => reviewRowKey({ kind: 'place', stat }))).size,
    ).toBe(SCOREBOARD_PLACE_STATS.length);
  });

  it('tells the minute rows of two items apart, and the two rows of one item apart', () => {
    const minuteOfKnown = reviewRowKey({ kind: 'resistance_minute', item: KNOWN_ITEM });
    const minuteOfOther = reviewRowKey({ kind: 'resistance_minute', item: UNKNOWN_ITEM });
    const rateOfKnown = reviewRowKey({ kind: 'resistance_rate', item: KNOWN_ITEM });
    const rateOfOther = reviewRowKey({ kind: 'resistance_rate', item: UNKNOWN_ITEM });

    expect(new Set([minuteOfKnown, minuteOfOther, rateOfKnown, rateOfOther]).size).toBe(4);
  });

  it('keys an item by its class name, whether or not the catalogue knows it', () => {
    // The catalogue may give two items the same name, or none: the class name is what tells them apart.
    const knownByClassName = { ...KNOWN_ITEM, className: UNKNOWN_ITEM.className };
    const sameNameAsKnown = { ...UNKNOWN_ITEM, name: KNOWN_ITEM.name };

    expect(reviewRowKey({ kind: 'resistance_minute', item: knownByClassName })).toBe(
      reviewRowKey({ kind: 'resistance_minute', item: UNKNOWN_ITEM }),
    );
    expect(reviewRowKey({ kind: 'resistance_minute', item: sameNameAsKnown })).not.toBe(
      reviewRowKey({ kind: 'resistance_minute', item: KNOWN_ITEM }),
    );
  });
});

describe('the strings of the review page', () => {
  // The strings no formatter writes: a component reads them with `t()` and the values it holds.
  it.each([
    { key: 'nav.review', en: 'Review', fr: 'Bilan' },
    { key: 'review.title', en: 'Review', fr: 'Bilan' },
    {
      key: 'review.window',
      options: { count: 20, from: '3 Oct', to: '21 Oct' },
      en: 'Your last 20 matches, 3 Oct to 21 Oct',
      fr: 'Tes 20 dernières parties, du 3 Oct au 21 Oct',
    },
    {
      key: 'review.before',
      options: { count: 20 },
      en: 'Progress: against the 20 matches before',
      fr: "Progression : face aux 20 parties d'avant",
    },
    {
      key: 'review.cohort.tier',
      options: { tier: 'Oracle' },
      en: 'Compared with Paige players in Oracle, the tier above yours, last 30 days',
      fr: 'Comparé aux joueurs de Paige Oracle, le palier au-dessus du tien, sur 30 jours',
    },
    {
      key: 'review.cohort.fallback',
      options: { count: 3 },
      en: '3 matches compared with every rank: too few matches in that tier',
      fr: '3 parties comparées à tous les rangs : trop peu de parties dans ce palier',
    },
    {
      key: 'review.count',
      options: { count: 20 },
      en: '20 matches',
      fr: '20 parties',
    },
    {
      key: 'review.compared',
      options: { value: '1.8' },
      en: 'You on the same stretch: 1.8',
      fr: 'Toi sur la même durée : 1.8',
    },
    {
      key: 'review.deaths.phase',
      options: { phase: 'mid' },
      en: 'Deaths in mid',
      fr: 'Morts en mid',
    },
    {
      key: 'review.evidence.match',
      options: { date: '21 Oct', value: '4.0' },
      en: '21 Oct: 4.0',
      fr: '21 Oct : 4.0',
    },
    {
      key: 'review.players.topThreePlace',
      en: "Average place in Valve's top three",
      fr: 'Place moyenne dans le top 3 de Valve',
    },
    {
      key: 'review.unit.topThreePlace',
      options: { value: '2' },
      en: '2 of 3',
      fr: '2 sur 3',
    },
  ] as const)('writes $key in both languages', async (input) => {
    const options = 'options' in input ? input.options : {};

    const en = (await translatorOf('en'))(input.key, options);
    const fr = (await translatorOf('fr'))(input.key, options);

    expect(en).toBe(input.en);
    expect(fr).toBe(input.fr);
  });

  it.each([
    // One match is a singular, in the register of the page: "tu" in French.
    {
      key: 'review.window',
      options: { count: 1, from: '21 Oct', to: '21 Oct' },
      en: 'Your last match, 21 Oct',
      fr: 'Ta dernière partie, le 21 Oct',
    },
    {
      key: 'review.window',
      options: { count: 2, from: '20 Oct', to: '21 Oct' },
      en: 'Your last 2 matches, 20 Oct to 21 Oct',
      fr: 'Tes 2 dernières parties, du 20 Oct au 21 Oct',
    },
    {
      key: 'review.before',
      options: { count: 1 },
      en: 'Progress: against the match before',
      fr: "Progression : face à la partie d'avant",
    },
    { key: 'review.count', options: { count: 1 }, en: '1 match', fr: '1 partie' },
    { key: 'review.count', options: { count: 2 }, en: '2 matches', fr: '2 parties' },
    {
      key: 'review.cohort.fallback',
      options: { count: 1 },
      en: '1 match compared with every rank: too few matches in that tier',
      fr: '1 partie comparée à tous les rangs : trop peu de parties dans ce palier',
    },
    {
      key: 'review.cohort.partial',
      options: { count: 1 },
      en: 'No comparison yet for 1 match: it will come at a next opening',
      fr: 'Pas encore de comparaison pour 1 partie : elle viendra à une prochaine ouverture',
    },
    {
      key: 'review.cohort.partial',
      options: { count: 4 },
      en: 'No comparison yet for 4 matches: it will come at a next opening',
      fr: 'Pas encore de comparaison pour 4 parties : elle viendra à une prochaine ouverture',
    },
    { key: 'review.damage.now', options: { count: 1 }, en: 'Last match', fr: 'Dernière partie' },
    { key: 'review.damage.now', options: { count: 20 }, en: 'Last 20', fr: '20 dernières' },
    {
      key: 'review.damage.before',
      options: { count: 1 },
      en: 'Match before',
      fr: "Partie d'avant",
    },
    { key: 'review.damage.before', options: { count: 20 }, en: '20 before', fr: "20 d'avant" },
    { key: 'review.damage.appears', options: { count: 1 }, en: 'In 1 match', fr: 'Dans 1 partie' },
    {
      key: 'review.damage.appears',
      options: { count: 12 },
      en: 'In 12 matches',
      fr: 'Dans 12 parties',
    },
  ] as const)('writes $key for a count of $options.count', async (input) => {
    expect((await translatorOf('en'))(input.key, input.options)).toBe(input.en);
    expect((await translatorOf('fr'))(input.key, input.options)).toBe(input.fr);
  });

  it('counts zero as a plural in English and as a singular in French', async () => {
    // French reads "0 partie", as the language of the catalogue's plural rules does.
    expect((await translatorOf('en'))('review.count', { count: 0 })).toBe('0 matches');
    expect((await translatorOf('fr'))('review.count', { count: 0 })).toBe('0 partie');
  });
});

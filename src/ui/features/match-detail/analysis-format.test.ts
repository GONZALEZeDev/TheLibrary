/**
 * Tests of the formatters of the match analysis: how a value, a difference with the habits, a phase
 * total, a time of the game and the name of a metric are written, in English and in French.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { MetricKey, MetricUnit } from '../../../core/analysis/metric';
import { PHASE_STATS } from '../../../core/analysis/phases';
import { METRICS } from '../../../core/analysis/registry';
import { AppError } from '../../../core/errors/app-error';
import { createI18n } from '../../i18n/i18n';
import {
  formatDifference,
  formatGameTime,
  formatMedian,
  formatMetricValue,
  formatPhaseTotal,
  formatShare,
  formatShareGap,
  INSIGHT_STYLE,
  metricLabel,
  NO_VALUE,
  percentileSentence,
  percentileText,
  PHASE_STAT_UNIT,
} from './analysis-format';

/** The minus sign the formatters write, instead of the hyphen of the number formats. */
const MINUS = '\u2212';

/**
 * Write the spaces of a number as plain spaces. The language data decides which space it puts
 * between the digits of a thousand or before a percent sign (a no-break space, a narrow one): the
 * tests check where the space is, not which one it is.
 *
 * @param text - A formatted number.
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

describe('formatMetricValue', () => {
  it.each([
    { unit: 'ratio', value: 5.04, en: '5.0', fr: '5,0' },
    { unit: 'ratio', value: 12.46, en: '12.5', fr: '12,5' },
    { unit: 'per_min', value: 1187.4, en: '1,187', fr: '1 187' },
    { unit: 'amount', value: 38200, en: '38,200', fr: '38 200' },
    { unit: 'amount', value: -850, en: `${MINUS}850`, fr: `${MINUS}850` },
    { unit: 'count', value: 214, en: '214', fr: '214' },
    { unit: 'count', value: 3.6, en: '4', fr: '4' },
    { unit: 'percent', value: 0.41, en: '41%', fr: '41 %' },
    { unit: 'percent', value: 0.095, en: '10%', fr: '10 %' },
  ] as const satisfies readonly {
    unit: MetricUnit;
    value: number;
    en: string;
    fr: string;
  }[])('writes $value as $unit: $en, $fr', ({ unit, value, en, fr }) => {
    expect(plain(formatMetricValue(value, unit, 'en'))).toBe(en);
    expect(plain(formatMetricValue(value, unit, 'fr'))).toBe(fr);
  });

  it.each(['ratio', 'per_min', 'percent', 'count', 'amount'] as const)(
    'writes an unknown %s value as a dash',
    (unit) => {
      expect(formatMetricValue(null, unit, 'en')).toBe(NO_VALUE);
      expect(formatMetricValue(null, unit, 'fr')).toBe(NO_VALUE);
    },
  );

  it('writes a value that is 0 as 0, not as a dash', () => {
    expect(formatMetricValue(0, 'count', 'en')).toBe('0');
  });

  it.each([
    { unit: 'amount', value: -0.2, en: '0', fr: '0' },
    { unit: 'count', value: -0.4, en: '0', fr: '0' },
    { unit: 'ratio', value: -0.04, en: '0.0', fr: '0,0' },
    { unit: 'percent', value: -0.004, en: '0%', fr: '0 %' },
  ] as const satisfies readonly {
    unit: MetricUnit;
    value: number;
    en: string;
    fr: string;
  }[])('writes $value ($unit), which rounds to zero, without a minus: $en', (input) => {
    expect(plain(formatMetricValue(input.value, input.unit, 'en'))).toBe(input.en);
    expect(plain(formatMetricValue(input.value, input.unit, 'fr'))).toBe(input.fr);
  });
});

describe('formatDifference', () => {
  it.each([
    { ratio: 0.12, en: '+12%', fr: '+12 %' },
    { ratio: -0.08, en: `${MINUS}8%`, fr: `${MINUS}8 %` },
    { ratio: 0.6, en: '+60%', fr: '+60 %' },
    // Less than half a percent is no difference: no sign, since there is no direction to tell.
    { ratio: 0.004, en: '0%', fr: '0 %' },
    { ratio: -0.004, en: '0%', fr: '0 %' },
    { ratio: 0, en: '0%', fr: '0 %' },
  ])('writes a relative difference of $ratio as $en, $fr', async ({ ratio, en, fr }) => {
    const difference = { kind: 'relative', ratio } as const;

    expect(plain(formatDifference(difference, 'amount', 'en', await translatorOf('en')))).toBe(en);
    expect(plain(formatDifference(difference, 'amount', 'fr', await translatorOf('fr')))).toBe(fr);
  });

  it.each([
    // A count keeps one decimal when the gap is not whole (the median of the habits is often a
    // half): a whole gap still reads whole, a half is not turned into a whole.
    { unit: 'count', amount: 2, en: '+2', fr: '+2' },
    { unit: 'count', amount: -1, en: `${MINUS}1`, fr: `${MINUS}1` },
    { unit: 'count', amount: 0.5, en: '+0.5', fr: '+0,5' },
    { unit: 'count', amount: -1.5, en: `${MINUS}1.5`, fr: `${MINUS}1,5` },
    { unit: 'count', amount: 0, en: '0', fr: '0' },
    { unit: 'count', amount: 0.04, en: '0', fr: '0' },
    // A rate per minute is large (the damage, the souls): it is whole, with the separators of the
    // thousands, like the value it is the gap of.
    { unit: 'per_min', amount: 1, en: '+1', fr: '+1' },
    { unit: 'per_min', amount: 1.4, en: '+1', fr: '+1' },
    { unit: 'per_min', amount: 1234.6, en: '+1,235', fr: '+1 235' },
    { unit: 'per_min', amount: -2.6, en: `${MINUS}3`, fr: `${MINUS}3` },
    { unit: 'per_min', amount: 0.04, en: '0', fr: '0' },
    // An amount is large: it stays whole, with the separators of the thousands.
    { unit: 'amount', amount: -700, en: `${MINUS}700`, fr: `${MINUS}700` },
    { unit: 'amount', amount: 1234.6, en: '+1,235', fr: '+1 235' },
    { unit: 'amount', amount: 12.4, en: '+12', fr: '+12' },
    // A ratio keeps its decimal, always: a KDA of 0.5 more is not a whole number.
    { unit: 'ratio', amount: 0.54, en: '+0.5', fr: '+0,5' },
    { unit: 'ratio', amount: 1, en: '+1.0', fr: '+1,0' },
    { unit: 'ratio', amount: -1.26, en: `${MINUS}1.3`, fr: `${MINUS}1,3` },
  ] as const satisfies readonly {
    unit: MetricUnit;
    amount: number;
    en: string;
    fr: string;
  }[])('writes an absolute difference of $amount ($unit) as $en, $fr', async (input) => {
    const difference = { kind: 'absolute', amount: input.amount } as const;

    expect(plain(formatDifference(difference, input.unit, 'en', await translatorOf('en')))).toBe(
      input.en,
    );
    expect(plain(formatDifference(difference, input.unit, 'fr', await translatorOf('fr')))).toBe(
      input.fr,
    );
  });

  it.each([
    { amount: -0.04, en: `${MINUS}4 pts`, fr: `${MINUS}4 pts` },
    { amount: 0.036, en: '+4 pts', fr: '+4 pts' },
    { amount: 0.1, en: '+10 pts', fr: '+10 pts' },
    { amount: 0.001, en: '0 pts', fr: '0 pts' },
  ])('writes the accuracy difference of $amount in points: $en', async ({ amount, en, fr }) => {
    const difference = { kind: 'absolute', amount } as const;

    expect(plain(formatDifference(difference, 'percent', 'en', await translatorOf('en')))).toBe(en);
    expect(plain(formatDifference(difference, 'percent', 'fr', await translatorOf('fr')))).toBe(fr);
  });
});

describe('formatMedian', () => {
  it.each([
    // A ratio keeps its decimal, always, like the gap with the habits.
    { unit: 'ratio', value: 3.64, en: '3.6', fr: '3,6' },
    { unit: 'ratio', value: 5, en: '5.0', fr: '5,0' },
    // A count keeps one decimal when it is not whole: the median of an even number of matches is
    // often a half, and 5.37 deaths is not "5" next to a gap of "+1.6".
    { unit: 'count', value: 5.37, en: '5.4', fr: '5,4' },
    { unit: 'count', value: 3.5, en: '3.5', fr: '3,5' },
    { unit: 'count', value: 5, en: '5', fr: '5' },
    { unit: 'count', value: 0, en: '0', fr: '0' },
    // A rate per minute is large: whole, like its value and its gap ("1,003.5" under "1,020" would
    // write a decimal the value does not have).
    { unit: 'per_min', value: 1187.4, en: '1,187', fr: '1 187' },
    { unit: 'per_min', value: 1003.5, en: '1,004', fr: '1 004' },
    { unit: 'per_min', value: 1020, en: '1,020', fr: '1 020' },
    // An amount is large: it is whole, with the separators of the thousands.
    { unit: 'amount', value: 3900.4, en: '3,900', fr: '3 900' },
    { unit: 'amount', value: -150.2, en: `${MINUS}150`, fr: `${MINUS}150` },
    // A percentage is held from 0 to 1.
    { unit: 'percent', value: 0.452, en: '45%', fr: '45 %' },
  ] as const satisfies readonly {
    unit: MetricUnit;
    value: number;
    en: string;
    fr: string;
  }[])('writes a median of $value ($unit) as $en, $fr', ({ unit, value, en, fr }) => {
    expect(plain(formatMedian(value, unit, 'en'))).toBe(en);
    expect(plain(formatMedian(value, unit, 'fr'))).toBe(fr);
  });

  it.each([
    { unit: 'count', value: -0.04, en: '0', fr: '0' },
    { unit: 'amount', value: -0.2, en: '0', fr: '0' },
    { unit: 'ratio', value: -0.04, en: '0.0', fr: '0,0' },
    { unit: 'percent', value: -0.004, en: '0%', fr: '0 %' },
  ] as const satisfies readonly {
    unit: MetricUnit;
    value: number;
    en: string;
    fr: string;
  }[])('writes a median of $value ($unit), which rounds to zero, without a minus', (input) => {
    expect(plain(formatMedian(input.value, input.unit, 'en'))).toBe(input.en);
    expect(plain(formatMedian(input.value, input.unit, 'fr'))).toBe(input.fr);
  });
});

describe('formatShare', () => {
  it.each([
    { share: 0.41, en: '41%', fr: '41 %' },
    // A share is written without decimal: the half rounds up.
    { share: 0.095, en: '10%', fr: '10 %' },
    { share: 0.006, en: '1%', fr: '1 %' },
    { share: 0.994, en: '99%', fr: '99 %' },
    // A source that dealt nothing is a share of 0, and one that dealt all the damage is a share of 1:
    // these two are exact.
    { share: 0, en: '0%', fr: '0 %' },
    { share: 1, en: '100%', fr: '100 %' },
    // A source that dealt damage never reads "0%", whatever little it dealt.
    { share: 0.004, en: '< 1%', fr: '< 1 %' },
    { share: 0.0001, en: '< 1%', fr: '< 1 %' },
    // A source that is not all the damage never reads "100%".
    { share: 0.996, en: '> 99%', fr: '> 99 %' },
    { share: 0.9999, en: '> 99%', fr: '> 99 %' },
    // A share is never negative; one that comes is written without a sign, never "−0%".
    { share: -0.004, en: '0%', fr: '0 %' },
  ])('writes a share by language: $share gives $en, $fr', ({ share, en, fr }) => {
    expect(plain(formatShare(share, 'en'))).toBe(en);
    expect(plain(formatShare(share, 'fr'))).toBe(fr);
  });

  it('writes a share as the analysis writes a percentage, whatever the language', () => {
    // One owner of the percent convention (the space before the sign in French): the share reads as
    // the percentages of the rest of the page.
    expect(formatShare(0.41, 'fr')).toBe(formatMetricValue(0.41, 'percent', 'fr'));
    expect(formatShare(0.41, 'en')).toBe(formatMetricValue(0.41, 'percent', 'en'));
  });
});

describe('formatShareGap', () => {
  it.each([
    { gap: -0.04, en: `${MINUS}4 pts`, fr: `${MINUS}4 pts` },
    { gap: 0.036, en: '+4 pts', fr: '+4 pts' },
    { gap: 0.1, en: '+10 pts', fr: '+10 pts' },
    // Under half a point is no gap: no sign, since there is no direction to tell.
    { gap: 0.001, en: '0 pts', fr: '0 pts' },
    { gap: -0.001, en: '0 pts', fr: '0 pts' },
    // A gap is a difference, not a share: "0 pts" for a gap this small is true, unlike "0%" for a
    // source that dealt damage.
    { gap: 0.004, en: '0 pts', fr: '0 pts' },
    { gap: -0.004, en: '0 pts', fr: '0 pts' },
  ])('writes a gap in points with a real minus sign: $gap gives $en', async ({ gap, en, fr }) => {
    expect(plain(formatShareGap(gap, 'en', await translatorOf('en')))).toBe(en);
    expect(plain(formatShareGap(gap, 'fr', await translatorOf('fr')))).toBe(fr);
  });

  it('never writes the hyphen of the number formats', async () => {
    expect(formatShareGap(-0.12, 'en', await translatorOf('en'))).not.toContain('-');
  });
});

describe('percentileText', () => {
  it.each([
    // The placement is clamped to 1 and 99: the clamps are not exact places.
    { percentile: 1, text: '< 1' },
    { percentile: 99, text: '> 99' },
    { percentile: 2, text: '2' },
    { percentile: 50, text: '50' },
    { percentile: 98, text: '98' },
    { percentile: 49.6, text: '50' },
  ])('writes the place $percentile as "$text"', ({ percentile, text }) => {
    expect(percentileText(percentile)).toBe(text);
  });
});

describe('percentileSentence', () => {
  it.each([
    { language: 'en', percentile: 84, sentence: 'Percentile 84 of your rank' },
    { language: 'en', percentile: 1, sentence: 'Percentile < 1 of your rank' },
    { language: 'fr', percentile: 84, sentence: 'Percentile 84 de ton rang' },
    { language: 'fr', percentile: 99, sentence: 'Percentile > 99 de ton rang' },
  ] as const)(
    'says the place $percentile in $language: $sentence',
    async ({ language, percentile, sentence }) => {
      expect(percentileSentence(percentile, await translatorOf(language))).toBe(sentence);
    },
  );
});

describe('PHASE_STAT_UNIT', () => {
  it('gives every figure of the phase table the unit its cells are written in', () => {
    // The souls and the damage are amounts, the kills a count: a phase metric is a rate per
    // minute, but a cell shows the total of its phase, and so do its gap and its usual value.
    expect(PHASE_STAT_UNIT).toEqual({
      souls: 'amount',
      hero_damage: 'amount',
      objective_damage: 'amount',
      kills: 'count',
    });
    expect(Object.keys(PHASE_STAT_UNIT).toSorted()).toEqual([...PHASE_STATS].toSorted());
  });
});

describe('formatPhaseTotal', () => {
  it.each(PHASE_STATS)('writes a total of %s in the unit of the figure', (stat) => {
    // One owner of the unit: the total is written like a value of that unit.
    expect(formatPhaseTotal(3_100.4, stat, 'en')).toBe(
      formatMetricValue(3_100.4, PHASE_STAT_UNIT[stat], 'en'),
    );
    expect(formatPhaseTotal(3.5, stat, 'fr')).toBe(
      formatMetricValue(3.5, PHASE_STAT_UNIT[stat], 'fr'),
    );
  });

  it.each([
    { stat: 'souls', total: 17800, en: '17,800', fr: '17 800' },
    { stat: 'hero_damage', total: 3100.4, en: '3,100', fr: '3 100' },
    { stat: 'objective_damage', total: 900, en: '900', fr: '900' },
    { stat: 'kills', total: 3, en: '3', fr: '3' },
    { stat: 'kills', total: 0, en: '0', fr: '0' },
  ] as const)('writes $total $stat as $en, $fr', ({ stat, total, en, fr }) => {
    expect(plain(formatPhaseTotal(total, stat, 'en'))).toBe(en);
    expect(plain(formatPhaseTotal(total, stat, 'fr'))).toBe(fr);
  });

  it.each(['souls', 'hero_damage', 'objective_damage', 'kills'] as const)(
    'writes an unknown %s total as a dash',
    (stat) => {
      expect(formatPhaseTotal(null, stat, 'en')).toBe(NO_VALUE);
    },
  );
});

describe('formatGameTime', () => {
  it.each([
    { seconds: 0, time: '0:00' },
    { seconds: 600, time: '10:00' },
    { seconds: 1500, time: '25:00' },
    { seconds: 1934, time: '32:14' },
    { seconds: 4505, time: '75:05' },
  ])('writes $seconds seconds as $time', ({ seconds, time }) => {
    expect(formatGameTime(seconds)).toBe(time);
  });
});

describe('metricLabel', () => {
  it.each([
    { key: 'kda', en: 'KDA', fr: 'KDA' },
    { key: 'souls_at_10min', en: 'Souls at 10:00', fr: 'Âmes à 10:00' },
    { key: 'teammate_healing', en: 'Healing to allies', fr: 'Soins aux alliés' },
  ] as const)('names the match metric $key', async ({ key, en, fr }) => {
    expect(metricLabel(key, await translatorOf('en'), 'en')).toBe(en);
    expect(metricLabel(key, await translatorOf('fr'), 'fr')).toBe(fr);
  });

  it.each([
    { key: 'souls_per_min_mid', en: 'Souls in mid', fr: 'Âmes en mid' },
    { key: 'souls_per_min_late', en: 'Souls in late', fr: 'Âmes en late' },
    {
      key: 'hero_damage_per_min_early',
      en: 'Damage to heroes in early',
      fr: 'Dégâts aux héros en early',
    },
    {
      key: 'objective_damage_per_min_mid',
      en: 'Damage to objectives in mid',
      fr: 'Dégâts aux objectifs en mid',
    },
    { key: 'kills_per_min_late', en: 'Kills in late', fr: 'Kills en late' },
  ] as const)('names the phase metric $key with its figure and its phase', async (input) => {
    expect(metricLabel(input.key, await translatorOf('en'), 'en')).toBe(input.en);
    expect(metricLabel(input.key, await translatorOf('fr'), 'fr')).toBe(input.fr);
  });

  it.each(['en', 'fr'] as const)(
    'gives each metric of the registry its own text in %s, never its key',
    async (language) => {
      const t = await translatorOf(language);

      const labels = METRICS.map((metric) => metricLabel(metric.key, t, language));

      // One text for each metric of the registry: a new metric is counted without a change here.
      expect(labels).toHaveLength(METRICS.length);
      // A missing string would come back as its key, with dots in it.
      expect(labels.filter((label) => label.includes('.') || label.includes('_'))).toEqual([]);
      expect(new Set(labels).size).toBe(labels.length);
    },
  );

  it.each([
    // A key that no metric has, and the one cell of the phase table that has no phase metric (the
    // early souls are `souls_at_10min`): no text is guessed for them.
    'no_such_metric',
    'souls_per_min_early',
  ])('refuses the key %s, which names no metric', async (damagedKey) => {
    const t = await translatorOf('en');
    // A key read back from a damaged record is only a string that was cast.
    const key = damagedKey as MetricKey;

    let thrown: unknown;
    try {
      metricLabel(key, t, 'en');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ kind: 'unexpected', context: { key: damagedKey } });
  });
});

describe('INSIGHT_STYLE', () => {
  it('marks a strength with a rising arrow in the win colour and a weakness with a falling one in the loss colour', () => {
    expect(INSIGHT_STYLE.strength).toEqual({ arrow: '▲', text: 'text-win', tint: 'bg-win/10' });
    expect(INSIGHT_STYLE.weakness).toEqual({ arrow: '▼', text: 'text-loss', tint: 'bg-loss/10' });
  });
});

/**
 * Tests of the metrics by family, of the gauge of a place among the rank and of the evidence panel
 * of a row, rendered on their own with views built by hand (the view the analysis service gives is
 * tested with the service), in English and in French.
 *
 * The rows are made from the registry of the metrics, so that each one has the unit, the direction
 * and the kind of community reference the page really gives it. The numbers are synthetic.
 *
 * @packageDocumentation
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Insight } from '../../../core/analysis/insights/insights';
import type { MetricDefinition, MetricFamily, MetricKey } from '../../../core/analysis/metric';
import { MATCH_METRICS } from '../../../core/analysis/registry';
import type { Language } from '../../../core/settings/language';
import type { FamilyView, MetricRowView } from '../../../services/analysis-view';
import type { CommunityCell, CommunityState } from '../../../services/community-placement';
import { createI18n } from '../../i18n/i18n';
import { Evidence } from './Evidence';
import { MetricFamilies, type MetricFamiliesProps } from './MetricFamilies';
import { PercentileGauge } from './PercentileGauge';

/** The families in the order the page shows them. */
const FAMILIES: readonly MetricFamily[] = [
  'combat',
  'survival',
  'farm',
  'support',
  'objectives',
  'laning',
];

/**
 * The families that hold a metric of the registry, in the order of the page: the ones the page
 * shows. Counting from the registry keeps the tests true when a metric is added.
 */
const FAMILIES_WITH_METRICS = FAMILIES.filter((family) =>
  MATCH_METRICS.some((definition) => definition.family === family),
);

/** The title of each family, as the page writes it in English. */
const FAMILY_TITLE_EN: Readonly<Record<MetricFamily, string>> = {
  combat: 'Combat',
  survival: 'Survival',
  farm: 'Farm',
  support: 'Support',
  objectives: 'Objectives',
  laning: 'Laning',
};

/** The title of each family, as the page writes it in French. */
const FAMILY_TITLE_FR: Readonly<Record<MetricFamily, string>> = {
  combat: 'Combat',
  survival: 'Survie',
  farm: 'Farm',
  support: 'Soutien',
  objectives: 'Objectifs',
  laning: 'Phase de lane',
};

/** How many metrics the community has no reference for: they are compared with the habits only. */
const UNREFERENCED_METRIC_COUNT = MATCH_METRICS.filter(
  (definition) => definition.community.kind === 'none',
).length;

/** How many metrics the community has a reference for: the rows a missing comparison leaves blank. */
const REFERENCED_METRIC_COUNT = MATCH_METRICS.length - UNREFERENCED_METRIC_COUNT;

/** A value of each unit, so that the rows have something to write. */
const VALUE_OF_UNIT = { ratio: 5, per_min: 1_020, percent: 0.41, count: 4, amount: 3_900 } as const;

/** When the community data of the tests was downloaded. */
const FETCHED_AT = Date.UTC(2026, 9, 13, 12, 0, 0);

/** The minus sign the page writes before a negative number. */
const MINUS = '−';

/**
 * Render an element with the i18next instance of one language.
 *
 * @param language - The language of the interface.
 * @param element - The element to render.
 */
async function renderIn(language: Language, element: ReactElement): Promise<void> {
  const i18n = await createI18n(language);
  render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

/**
 * Build the insight of a metric.
 *
 * @param key - The metric.
 * @param side - Whether it is a strength or a weakness.
 * @returns The insight.
 */
function testInsight(key: MetricKey, side: Insight['side']): Insight {
  return { key, side, score: side === 'strength' ? 0.8 : -0.8, confidence: 'high' };
}

/**
 * Where a metric stands among the community when nothing is said: in the middle of its reference.
 *
 * @param definition - The metric.
 * @returns A place on the percentiles or on the curve, or none for a metric with no reference.
 */
function defaultCommunity(definition: MetricDefinition): CommunityCell {
  switch (definition.community.kind) {
    case 'percentiles':
      return { kind: 'percentile', percentile: 50 };
    case 'curve':
      return { kind: 'curve', percentile: 50, label: 'around' };
    case 'none':
      return { kind: 'none' };
  }
}

/**
 * Build the row of a metric of the registry: 20 earlier matches that it stands 4 % above (or one
 * above, for a difference in the unit of the metric), unless overridden. The absolute differences
 * are whole numbers.
 *
 * @param definition - The metric.
 * @param overrides - Fields to change.
 * @returns The row.
 */
function testRow(
  definition: MetricDefinition,
  overrides: Partial<MetricRowView> = {},
): MetricRowView {
  return {
    key: definition.key,
    unit: definition.unit,
    better: definition.better,
    value: VALUE_OF_UNIT[definition.unit],
    community: defaultCommunity(definition),
    personal: {
      count: 20,
      median: VALUE_OF_UNIT[definition.unit] - 1,
      z: 0.2,
      difference:
        definition.display === 'relative'
          ? { kind: 'relative', ratio: 0.04 }
          : { kind: 'absolute', amount: definition.unit === 'percent' ? 0.04 : 1 },
    },
    insight: null,
    confidence: 'high',
    ...overrides,
  };
}

/**
 * Build a row for each metric of the whole match, in its family, in the order of the page.
 *
 * @param overrides - Fields to change, by metric.
 * @returns The families.
 */
function testFamilies(
  overrides: Partial<Record<MetricKey, Partial<MetricRowView>>> = {},
): FamilyView[] {
  return FAMILIES.map((family) => ({
    family,
    rows: MATCH_METRICS.filter((definition) => definition.family === family).map((definition) =>
      testRow(definition, overrides[definition.key]),
    ),
  }));
}

/**
 * Make every community comparison of a match missing, as when the data is not there: a metric the
 * community has no reference for stays as it is.
 *
 * @param families - The families.
 * @returns The same families, with the comparisons missing.
 */
function withMissingCommunity(families: readonly FamilyView[]): FamilyView[] {
  return families.map(({ family, rows }) => ({
    family,
    rows: rows.map((row) =>
      row.community.kind === 'none' ? row : { ...row, community: { kind: 'missing' } },
    ),
  }));
}

/**
 * Build the comparison with the players of tier 4 in matches of 25 to 30 minutes.
 *
 * @param overrides - Fields to change.
 * @returns The state, which is available.
 */
function availableState(
  overrides: Partial<Extract<CommunityState, { kind: 'available' }>> = {},
): CommunityState {
  return {
    kind: 'available',
    used: { rank: { kind: 'tier', tier: 4 }, window: { minS: 1_500, maxS: 1_799 } },
    fallback: false,
    stale: false,
    sampleMatches: 2_422,
    fetchedAt: FETCHED_AT,
    ...overrides,
  };
}

/**
 * Render the families of a match.
 *
 * @param language - The language of the interface.
 * @param props - What to change in the default props: the default match, compared with tier 4.
 */
async function renderFamilies(
  language: Language,
  props: Partial<MetricFamiliesProps> = {},
): Promise<void> {
  await renderIn(
    language,
    <MetricFamilies
      families={testFamilies()}
      community={availableState()}
      communityLoading={false}
      {...props}
    />,
  );
}

/**
 * Find the row of a metric.
 *
 * @param label - The name of the metric, as the page says it.
 * @returns The item of the list of its family.
 */
function rowOf(label: string): HTMLElement {
  return screen.getByText(label).closest('li') ?? expect.unreachable(`No row is named ${label}`);
}

/**
 * Find the panel of evidence of a row.
 *
 * @param label - The name of the metric, as the page says it.
 * @returns The panel.
 */
function panelOf(label: string): HTMLElement {
  return within(rowOf(label)).getByRole('tooltip');
}

/**
 * Keep the texts that a row shows, not the ones of its evidence panel (which says some of them again).
 *
 * @param elements - The elements found in a row.
 * @returns The ones that are not in the panel.
 */
function outsidePanel(elements: readonly HTMLElement[]): HTMLElement[] {
  return elements.filter((element) => element.closest('[role="tooltip"]') === null);
}

describe('MetricFamilies', () => {
  it('shows a row for each metric of the registry, in its family under its title', async () => {
    await renderFamilies('en');

    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual(
      FAMILIES_WITH_METRICS.map((family) => FAMILY_TITLE_EN[family]),
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(MATCH_METRICS.length);
    // The rows are in the list of their family, in the order of the registry.
    const rowsPerFamily = screen
      .getAllByRole('list')
      .map((list) => within(list).getAllByRole('listitem').length);
    expect(rowsPerFamily).toEqual(
      FAMILIES_WITH_METRICS.map(
        (family) => MATCH_METRICS.filter((definition) => definition.family === family).length,
      ),
    );
    // A row is in the family of its metric.
    const survival = within(screen.getByRole('region', { name: 'Survival' }));
    expect(survival.getByText('Deaths')).toBeInTheDocument();
    expect(survival.getByText('Damage taken per min')).toBeInTheDocument();
  });

  it('names the families and the metrics in French', async () => {
    await renderFamilies('fr');

    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual(
      FAMILIES_WITH_METRICS.map((family) => FAMILY_TITLE_FR[family]),
    );
    expect(screen.getByText('Dégâts aux objectifs par min')).toBeInTheDocument();
    expect(screen.getByText("Écart d'âmes en lane à 10:00")).toBeInTheDocument();
  });

  it('writes the value of a row and the gap with the habits with the conventions of the language', async () => {
    await renderFamilies('en');

    const kda = rowOf('KDA');
    expect(within(kda).getByText('5.0')).toBeInTheDocument();
    expect(within(kda).getByText('+4% vs your habits')).toBeInTheDocument();
    expect(within(rowOf('Souls per min')).getByText('1,020')).toBeInTheDocument();
    // Accuracy is a percentage, so its gap is in points.
    const accuracy = rowOf('Accuracy');
    expect(within(accuracy).getByText('41%')).toBeInTheDocument();
    expect(within(accuracy).getByText('+4 pts vs your habits')).toBeInTheDocument();
    // The gap of a count is a number of events.
    expect(within(rowOf('Deaths')).getByText('+1 vs your habits')).toBeInTheDocument();
  });

  it('writes them the French way', async () => {
    await renderFamilies('fr');

    const kda = rowOf('KDA');
    expect(within(kda).getByText('5,0')).toBeInTheDocument();
    expect(within(kda).getByText('+4 % vs tes habitudes')).toBeInTheDocument();
    // The spaces of the numbers are no-break ones: the queries read them as plain spaces.
    expect(within(rowOf('Âmes par min')).getByText('1 020')).toBeInTheDocument();
    expect(within(rowOf('Précision')).getByText('41 %')).toBeInTheDocument();
    expect(within(rowOf('Précision')).getByText('+4 pts vs tes habitudes')).toBeInTheDocument();
  });

  it('writes a gap below the habits with a minus sign', async () => {
    const families = testFamilies({
      kda: {
        personal: {
          count: 20,
          median: 5.6,
          z: -0.5,
          difference: { kind: 'relative', ratio: -0.12 },
        },
      },
    });
    await renderFamilies('en', { families });

    expect(within(rowOf('KDA')).getByText(`${MINUS}12% vs your habits`)).toBeInTheDocument();
  });

  it('puts a gauge at the place of a metric among the rank', async () => {
    const families = testFamilies({
      kda: { community: { kind: 'percentile', percentile: 84 } },
    });
    await renderFamilies('en', { families });

    const gauge = within(rowOf('KDA')).getByRole('img');

    expect(gauge).toHaveAccessibleName('Percentile 84 of your rank');
    expect(gauge.querySelector('[style]')).toHaveStyle({ left: '84%' });
  });

  it('says that lower is better in the evidence of a deaths row, and only there', async () => {
    const families = testFamilies({
      deaths: { community: { kind: 'percentile', percentile: 62 } },
    });
    await renderFamilies('en', { families });

    // The mark of the gauge is where the value stands, whether that is good or bad.
    expect(
      within(panelOf('Deaths')).getByText('Percentile 62 of your rank (lower is better)'),
    ).toBeInTheDocument();
    expect(within(rowOf('Deaths')).getByRole('img')).toHaveAccessibleName(
      'Percentile 62 of your rank',
    );
    expect(within(panelOf('KDA')).queryByText(/lower is better/)).not.toBeInTheDocument();
    // Damage taken is the other metric where less is better.
    expect(
      within(panelOf('Damage taken per min')).getByText(/lower is better/),
    ).toBeInTheDocument();
  });

  it('says it in French too', async () => {
    const families = testFamilies({
      deaths: { community: { kind: 'percentile', percentile: 62 } },
    });
    await renderFamilies('fr', { families });

    expect(
      within(panelOf('Morts')).getByText("Percentile 62 de ton rang (moins c'est mieux)"),
    ).toBeInTheDocument();
  });

  it('shows the curve label and no comparison in the laning rows', async () => {
    const families = testFamilies({
      souls_at_10min: { community: { kind: 'curve', percentile: 72, label: 'above' } },
    });
    await renderFamilies('en', { families });

    const laning = within(screen.getByRole('region', { name: 'Laning' }));
    const early = laning.getByText('Souls at 10:00').closest('li') ?? expect.unreachable();
    // The metric read on the curve has the distance to the average of the rank, and no gauge: a
    // place on a curve is approximate, so the row does not announce a percentile it cannot stand by.
    expect(within(early).queryByRole('img')).not.toBeInTheDocument();
    expect(outsidePanel(within(early).getAllByText('Above your rank'))).toHaveLength(1);
    expect(within(early).queryByText(/Percentile/)).not.toBeInTheDocument();
    // The metric the community has no reference for has neither.
    const lane =
      laning.getByText('Lane souls difference at 10:00').closest('li') ?? expect.unreachable();
    expect(within(lane).queryByRole('img')).not.toBeInTheDocument();
    expect(outsidePanel(within(lane).getAllByText('No comparison with your rank'))).toHaveLength(1);
    // Only the metrics the community has no reference for have no comparison.
    expect(outsidePanel(screen.getAllByText('No comparison with your rank'))).toHaveLength(
      UNREFERENCED_METRIC_COUNT,
    );
  });

  it('says it in French too, in the laning rows', async () => {
    await renderFamilies('fr');

    expect(
      outsidePanel(within(rowOf('Âmes à 10:00')).getAllByText('Dans la moyenne de ton rang')),
    ).toHaveLength(1);
    expect(
      outsidePanel(
        within(rowOf("Écart d'âmes en lane à 10:00")).getAllByText(
          'Pas de comparaison avec ton rang',
        ),
      ),
    ).toHaveLength(1);
  });

  it('says not enough data in the personal column of a metric with too few earlier matches', async () => {
    const families = testFamilies({ kda: { personal: null } });
    await renderFamilies('en', { families });

    const kda = rowOf('KDA');
    expect(outsidePanel(within(kda).getAllByText('Not enough data yet'))).toHaveLength(1);
    expect(within(kda).queryByText(/vs your habits/)).not.toBeInTheDocument();
    // The other rows tell their gap.
    expect(outsidePanel(screen.getAllByText('Not enough data yet'))).toHaveLength(1);
    expect(within(rowOf('Accuracy')).getByText('+4 pts vs your habits')).toBeInTheDocument();
  });

  it('says it in French too, in the personal column', async () => {
    await renderFamilies('fr', { families: testFamilies({ kda: { personal: null } }) });

    expect(
      outsidePanel(within(rowOf('KDA')).getAllByText('Pas encore assez de données')),
    ).toHaveLength(1);
  });

  it('writes a metric with no value as a dash in each column, and promises nothing', async () => {
    const families = testFamilies({
      accuracy: { value: null, personal: null, community: { kind: 'missing' } },
      lane_souls_diff_at_10min: { value: null, personal: null, community: { kind: 'none' } },
    });
    await renderFamilies('en', { families });

    // The value, the place among the rank and the gap with the habits are all unknown, and nothing
    // will fill them for this match: no "for now", no "yet", in the row or in its panel.
    const accuracy = rowOf('Accuracy');
    expect(outsidePanel(within(accuracy).getAllByText('—'))).toHaveLength(3);
    expect(within(accuracy).queryByText(/for now|yet/)).not.toBeInTheDocument();
    // It holds for a metric the community has no reference for: there is nothing to compare either.
    const lane = rowOf('Lane souls difference at 10:00');
    expect(outsidePanel(within(lane).getAllByText('—'))).toHaveLength(3);
    expect(within(lane).queryByText(/No comparison|yet/)).not.toBeInTheDocument();
  });

  it('marks a strength and a weakness with an arrow, a word and a tint', async () => {
    const families = testFamilies({
      teammate_healing: { insight: testInsight('teammate_healing', 'strength') },
      accuracy: { insight: testInsight('accuracy', 'weakness') },
    });
    await renderFamilies('en', { families });

    const strength = rowOf('Healing to allies');
    expect(within(strength).getByText('▲')).toHaveAttribute('aria-hidden', 'true');
    expect(within(strength).getByText('strength')).toHaveClass('sr-only');
    expect(within(strength).getByRole('group').firstElementChild).toHaveClass('bg-win/10');
    const weakness = rowOf('Accuracy');
    expect(within(weakness).getByText('▼')).toHaveAttribute('aria-hidden', 'true');
    expect(within(weakness).getByText('weakness')).toHaveClass('sr-only');
    expect(within(weakness).getByRole('group').firstElementChild).toHaveClass('bg-loss/10');
    // Nothing else is marked: two arrows and two words.
    expect(screen.getAllByText(/^[▲▼]$/)).toHaveLength(2);
    expect(screen.getAllByText(/^(strength|weakness)$/)).toHaveLength(2);
    expect(within(rowOf('KDA')).getByRole('group').firstElementChild).not.toHaveClass('bg-win/10');
    expect(within(rowOf('KDA')).getByRole('group').firstElementChild).not.toHaveClass('bg-loss/10');
  });

  it('says the words of a strength and a weakness in French', async () => {
    const families = testFamilies({
      teammate_healing: { insight: testInsight('teammate_healing', 'strength') },
      accuracy: { insight: testInsight('accuracy', 'weakness') },
    });
    await renderFamilies('fr', { families });

    expect(within(rowOf('Soins aux alliés')).getByText('point fort')).toBeInTheDocument();
    expect(within(rowOf('Précision')).getByText('point faible')).toBeInTheDocument();
  });

  it('says once, above the rows, that the comparison is loading while the data comes', async () => {
    await renderFamilies('en', {
      families: withMissingCommunity(testFamilies()),
      community: { kind: 'missing' },
      communityLoading: true,
    });

    // Only the line above the families says it. The rows the data is not in yet are a dash, so that
    // the families do not double in height with the same sentence on each row.
    expect(screen.getAllByText('Loading the comparison with your rank…')).toHaveLength(1);
    expect(screen.queryByText('No comparison with your rank for now')).not.toBeInTheDocument();
    expect(outsidePanel(screen.getAllByText('—'))).toHaveLength(REFERENCED_METRIC_COUNT);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The metrics the community has no reference for say so all the same.
    expect(outsidePanel(screen.getAllByText('No comparison with your rank'))).toHaveLength(
      UNREFERENCED_METRIC_COUNT,
    );
  });

  it('says once, above the rows, that there is no comparison for now once the data is not coming', async () => {
    await renderFamilies('fr', {
      families: withMissingCommunity(testFamilies()),
      community: { kind: 'missing' },
      communityLoading: false,
    });

    expect(screen.getAllByText('Pas de comparaison avec ton rang pour le moment')).toHaveLength(1);
    expect(outsidePanel(screen.getAllByText('—'))).toHaveLength(REFERENCED_METRIC_COUNT);
    expect(
      screen.queryByText('Chargement de la comparaison avec ton rang…'),
    ).not.toBeInTheDocument();
  });

  it('says once that there is no comparison for a community that is too small', async () => {
    await renderFamilies('en', {
      families: withMissingCommunity(testFamilies()),
      community: { kind: 'unavailable' },
      communityLoading: false,
    });

    expect(screen.getAllByText('No comparison with your rank for now')).toHaveLength(1);
    expect(outsidePanel(screen.getAllByText('—'))).toHaveLength(REFERENCED_METRIC_COUNT);
  });
});

describe('the cohort line of MetricFamilies', () => {
  it.each([
    {
      language: 'en',
      sentence: 'Compared with Paige players in Sentinel, 25–30 min matches, last 30 days',
    },
    {
      language: 'fr',
      sentence: 'Comparé aux joueurs de Paige Sentinel, parties de 25 à 30 min, 30 derniers jours',
    },
  ] as const)('names the tier in English in $language', async (input) => {
    await renderFamilies(input.language, { community: availableState() });

    expect(screen.getByText(input.sentence)).toBeInTheDocument();
  });

  it.each([
    { tier: 1, name: 'Initiate' },
    { tier: 11, name: 'Eternus' },
  ])('names tier $tier $name', async ({ tier, name }) => {
    await renderFamilies('fr', {
      community: availableState({
        used: { rank: { kind: 'tier', tier }, window: { minS: 1_500, maxS: 1_799 } },
      }),
    });

    expect(screen.getByText(new RegExp(`Paige ${name},`))).toBeInTheDocument();
  });

  it.each([
    // The window says "matches" itself, on the side where the English reads naturally.
    { minS: 0, maxS: 1_199, english: 'matches under 20 min' },
    { minS: 1_200, maxS: 1_499, english: '20–25 min matches' },
    { minS: 2_400, maxS: 2_699, english: '40–45 min matches' },
    { minS: 2_700, maxS: 7_000, english: 'matches of 45 min and longer' },
  ])('says the length of the matches of the window $minS-$maxS', async (input) => {
    await renderFamilies('en', {
      community: availableState({
        used: {
          rank: { kind: 'all' },
          window: { minS: input.minS, maxS: input.maxS },
        },
      }),
    });

    expect(
      screen.getByText(`Compared with Paige players of all ranks, ${input.english}, last 30 days`),
    ).toBeInTheDocument();
  });

  it.each([
    { minS: 1_200, maxS: 1_499, french: 'parties de 20 à 25 min' },
    { minS: 2_700, maxS: 7_000, french: 'parties de 45 min et plus' },
  ])(
    'says the length of the matches of the window $minS-$maxS in French',
    async ({ minS, maxS, french }) => {
      await renderFamilies('fr', {
        community: availableState({ used: { rank: { kind: 'all' }, window: { minS, maxS } } }),
      });

      expect(
        screen.getByText(
          `Comparé aux joueurs de Paige de tous les rangs, ${french}, 30 derniers jours`,
        ),
      ).toBeInTheDocument();
    },
  );

  it('says every rank when the match has no rank to be compared with', async () => {
    await renderFamilies('fr', {
      community: availableState({
        used: { rank: { kind: 'all' }, window: { minS: 0, maxS: 1_199 } },
      }),
    });

    expect(
      screen.getByText(
        'Comparé aux joueurs de Paige de tous les rangs, parties de moins de 20 min, 30 derniers jours',
      ),
    ).toBeInTheDocument();
  });

  it('says that every rank stands in for a rank with too few matches', async () => {
    await renderFamilies('en', {
      community: availableState({
        used: { rank: { kind: 'all' }, window: { minS: 1_500, maxS: 1_799 } },
        fallback: true,
      }),
    });

    expect(
      screen.getByText(
        'Compared with Paige players of all ranks, 25–30 min matches, last 30 days (not enough matches at your rank)',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    {
      language: 'en',
      sentence: 'Compared with Paige players in Sentinel, 25–30 min matches, last 30 days',
      dated: (date: string) => `(from ${date})`,
    },
    {
      language: 'fr',
      sentence: 'Comparé aux joueurs de Paige Sentinel, parties de 25 à 30 min, 30 derniers jours',
      dated: (date: string) => `(données du ${date})`,
    },
  ] as const)('dates data that is a day old or more in $language', async (input) => {
    await renderFamilies(input.language, { community: availableState({ stale: true }) });

    // The date is the one of the download, written in the language of the interface.
    const date = new Intl.DateTimeFormat(input.language, { dateStyle: 'medium' }).format(
      FETCHED_AT,
    );
    expect(screen.getByText(`${input.sentence} ${input.dated(date)}`)).toBeInTheDocument();
  });

  it('does not date fresh data', async () => {
    await renderFamilies('en', { community: availableState({ stale: false }) });

    expect(screen.queryByText(/\(from /)).not.toBeInTheDocument();
  });

  it.each([
    { communityLoading: true, sentence: 'Loading the comparison with your rank…' },
    { communityLoading: false, sentence: 'No comparison with your rank for now' },
  ])(
    'says the comparison is missing: loading is $communityLoading',
    async ({ communityLoading, sentence }) => {
      await renderFamilies('en', {
        community: { kind: 'missing' },
        communityLoading,
      });

      // The rows are not missing here, so the line above them is the one that says it.
      expect(screen.getByText(sentence)).toBeInTheDocument();
    },
  );

  it('says there is no comparison for a community that is too small', async () => {
    await renderFamilies('en', { community: { kind: 'unavailable' }, communityLoading: true });

    // A community that holds too few matches does not come with more waiting.
    expect(screen.getByText('No comparison with your rank for now')).toBeInTheDocument();
    expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
  });
});

describe('PercentileGauge', () => {
  it('is an image labelled with the place, with its mark and its tick at 50', async () => {
    await renderIn('en', <PercentileGauge percentile={37} />);

    const gauge = screen.getByRole('img', { name: 'Percentile 37 of your rank' });
    const [tick, mark] = Array.from(gauge.children);
    expect(tick).toHaveClass('left-1/2');
    expect(mark).toHaveStyle({ left: '37%' });
    // The parts are for the eye: the label says it.
    expect(tick).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    { percentile: 1, label: 'Percentile < 1 of your rank' },
    { percentile: 99, label: 'Percentile > 99 of your rank' },
    { percentile: 2, label: 'Percentile 2 of your rank' },
    { percentile: 98, label: 'Percentile 98 of your rank' },
  ])('says $percentile as "$label"', async ({ percentile, label }) => {
    await renderIn('en', <PercentileGauge percentile={percentile} />);

    expect(screen.getByRole('img')).toHaveAccessibleName(label);
  });

  it('says it in French', async () => {
    await renderIn('fr', <PercentileGauge percentile={84} />);

    expect(screen.getByRole('img')).toHaveAccessibleName('Percentile 84 de ton rang');
  });
});

describe('Evidence', () => {
  it('gives the figures behind a metric of the summary: the place, the habits, the confidence and why', async () => {
    const families = testFamilies({
      kda: {
        community: { kind: 'percentile', percentile: 84 },
        personal: { count: 20, median: 3.6, z: 1.4, difference: { kind: 'relative', ratio: 0.39 } },
        insight: testInsight('kda', 'strength'),
        confidence: 'medium',
      },
    });
    await renderFamilies('en', { families });

    const panel = within(panelOf('KDA'));
    expect(panel.getByText('Percentile 84 of your rank')).toBeInTheDocument();
    expect(panel.getByText('Your median: 3.6')).toBeInTheDocument();
    expect(panel.getByText('20 reference matches')).toBeInTheDocument();
    expect(panel.getByText('Medium confidence')).toBeInTheDocument();
    expect(
      panel.getByText('Picked for your place in your rank and the gap with your habits'),
    ).toBeInTheDocument();
  });

  it('gives the figures in French', async () => {
    const families = testFamilies({
      kda: {
        community: { kind: 'percentile', percentile: 84 },
        personal: { count: 20, median: 3.6, z: 1.4, difference: { kind: 'relative', ratio: 0.39 } },
        insight: testInsight('kda', 'strength'),
        confidence: 'low',
      },
    });
    await renderFamilies('fr', { families });

    const panel = within(panelOf('KDA'));
    expect(panel.getByText('Percentile 84 de ton rang')).toBeInTheDocument();
    expect(panel.getByText('Ta médiane : 3,6')).toBeInTheDocument();
    expect(panel.getByText('20 parties de référence')).toBeInTheDocument();
    expect(panel.getByText('Confiance faible')).toBeInTheDocument();
    expect(
      panel.getByText("Retenu pour ta place dans ton rang et l'écart avec tes habitudes"),
    ).toBeInTheDocument();
  });

  it.each([
    { language: 'en', label: 'Deaths', median: 'Your median: 5.4', gap: '+1.6 vs your habits' },
    { language: 'fr', label: 'Morts', median: 'Ta médiane : 5,4', gap: '+1,6 vs tes habitudes' },
  ] as const)(
    'writes a median that is not whole like the gap beside it in $language',
    async ({ language, label, median, gap }) => {
      const families = testFamilies({
        deaths: {
          personal: {
            count: 20,
            median: 5.37,
            z: 0.2,
            difference: { kind: 'absolute', amount: 1.6 },
          },
        },
      });
      await renderFamilies(language, { families });

      // Both are written with one decimal: the median is not rounded to "5" next to a gap of 1.6.
      expect(within(panelOf(label)).getByText(median)).toBeInTheDocument();
      expect(within(rowOf(label)).getByText(gap)).toBeInTheDocument();
    },
  );

  it('lets the cell that wraps the row write the median its own way', async () => {
    const row = testFamilies()[0]?.rows[0] ?? expect.unreachable('A family holds rows');
    await renderIn(
      'en',
      <Evidence row={row} formatMedian={(median) => `${String(median)} in the phase`}>
        <span>Wrapped</span>
      </Evidence>,
    );

    expect(
      within(screen.getByRole('tooltip')).getByText('Your median: 4 in the phase'),
    ).toBeInTheDocument();
  });

  it.each([
    { percentile: 1, text: 'Percentile < 1 of your rank' },
    { percentile: 99, text: 'Percentile > 99 of your rank' },
  ])('writes the clamp $percentile as "$text"', async ({ percentile, text }) => {
    const families = testFamilies({ kda: { community: { kind: 'percentile', percentile } } });
    await renderFamilies('en', { families });

    expect(within(panelOf('KDA')).getByText(text)).toBeInTheDocument();
  });

  it('says the distance to the average of the rank for a metric read on the curve', async () => {
    const families = testFamilies({
      souls_at_10min: { community: { kind: 'curve', percentile: 20, label: 'below' } },
    });
    await renderFamilies('en', { families });

    const panel = within(panelOf('Souls at 10:00'));
    expect(panel.getByText('Below your rank')).toBeInTheDocument();
    expect(panel.queryByText(/Percentile/)).not.toBeInTheDocument();
  });

  it('says there is no comparison for a metric the community has no reference for, and says nothing of a missing one', async () => {
    const families = testFamilies({ kda: { community: { kind: 'missing' } } });
    await renderFamilies('en', { families });

    expect(
      within(panelOf('Lane souls difference at 10:00')).getByText('No comparison with your rank'),
    ).toBeInTheDocument();
    const missing = within(panelOf('KDA'));
    expect(missing.queryByText(/rank/)).not.toBeInTheDocument();
    // The rest of the panel is there all the same.
    expect(missing.getByText('Your median: 4.0')).toBeInTheDocument();
  });

  it('says not enough data when the habits cannot be told', async () => {
    const families = testFamilies({ kda: { personal: null } });
    await renderFamilies('en', { families });

    const panel = within(panelOf('KDA'));
    expect(panel.getByText('Not enough data yet')).toBeInTheDocument();
    expect(panel.queryByText(/Your median/)).not.toBeInTheDocument();
    expect(panel.queryByText(/reference matches/)).not.toBeInTheDocument();
  });

  it.each([
    {
      name: 'both references',
      row: {
        community: { kind: 'percentile', percentile: 80 },
        personal: { count: 20, median: 4, z: 1.2, difference: { kind: 'relative', ratio: 0.2 } },
      },
      reason: 'Picked for your place in your rank and the gap with your habits',
    },
    {
      name: 'the rank only (the habits are too few)',
      row: { community: { kind: 'percentile', percentile: 80 }, personal: null },
      reason: 'Picked for your place in your rank',
    },
    {
      name: 'the rank only (the habits do not vary)',
      row: {
        community: { kind: 'percentile', percentile: 80 },
        personal: { count: 20, median: 4, z: null, difference: { kind: 'relative', ratio: 0.2 } },
      },
      reason: 'Picked for your place in your rank',
    },
    {
      name: 'the habits only (no reference in the community)',
      row: {
        community: { kind: 'none' },
        personal: { count: 20, median: 4, z: 1.2, difference: { kind: 'relative', ratio: 0.2 } },
      },
      reason: 'Picked for the gap with your habits',
    },
    {
      name: 'the habits only (the community is missing)',
      row: {
        community: { kind: 'missing' },
        personal: { count: 20, median: 4, z: 1.2, difference: { kind: 'relative', ratio: 0.2 } },
      },
      reason: 'Picked for the gap with your habits',
    },
  ] as const)('gives the reason of a metric picked for $name', async ({ row, reason }) => {
    const families = testFamilies({
      kda: { ...row, insight: testInsight('kda', 'strength') },
    });
    await renderFamilies('en', { families });

    expect(within(panelOf('KDA')).getByText(reason)).toBeInTheDocument();
    expect(screen.getAllByText(/^Picked for/)).toHaveLength(1);
  });

  it('gives no reason to a metric that is not in the summary', async () => {
    await renderFamilies('en');

    expect(screen.queryByText(/^Picked for/)).not.toBeInTheDocument();
  });

  it('gives the confidence alone for a metric with no value', async () => {
    // The view gives such a row no comparison, and the panel does not rely on it: a place and habits
    // that were there would still say nothing of a value that is unknown. Nothing will fill the
    // row for this match, so the panel promises nothing either.
    const families = testFamilies({
      kda: {
        value: null,
        community: { kind: 'percentile', percentile: 84 },
        personal: { count: 20, median: 3.6, z: 1.4, difference: { kind: 'relative', ratio: 0.39 } },
        confidence: 'low',
      },
      accuracy: {
        value: null,
        community: { kind: 'missing' },
        personal: null,
        confidence: 'medium',
      },
      lane_souls_diff_at_10min: {
        value: null,
        community: { kind: 'none' },
        personal: null,
        confidence: 'high',
      },
    });
    await renderFamilies('en', { families });

    const lines = (label: string) =>
      Array.from(panelOf(label).querySelectorAll('p')).map((line) => line.textContent);
    expect(lines('KDA')).toEqual(['Low confidence']);
    expect(lines('Accuracy')).toEqual(['Medium confidence']);
    expect(lines('Lane souls difference at 10:00')).toEqual(['High confidence']);
    // A metric that has a value keeps its whole panel.
    expect(lines('Souls per min')).toEqual([
      'Percentile 50 of your rank',
      'Your median: 1,019',
      '20 reference matches',
      'High confidence',
    ]);
  });

  it('anchors the panel of a row at the right edge, so that it leaves the names free', async () => {
    await renderFamilies('en');

    // A pointer going down the names would stay on the panel of the row above, if it covered them.
    const panel = panelOf('KDA');
    expect(panel).toHaveClass('right-0', 'left-auto');
    expect(panel).not.toHaveClass('left-0');
  });

  it.each([
    { name: 'by default', props: {}, placed: ['left-0'], notPlaced: ['right-0', 'left-auto'] },
    {
      name: 'at the start',
      props: { placement: 'start' },
      placed: ['left-0'],
      notPlaced: ['right-0', 'left-auto'],
    },
    {
      name: 'at the end',
      props: { placement: 'end' },
      placed: ['right-0', 'left-auto'],
      notPlaced: ['left-0'],
    },
  ] as const)('places the panel $name', async ({ props, placed, notPlaced }) => {
    const row = testFamilies()[0]?.rows[0] ?? expect.unreachable('A family holds rows');
    await renderIn(
      'en',
      <Evidence row={row} {...props}>
        <span>Wrapped</span>
      </Evidence>,
    );

    const panel = screen.getByRole('tooltip');
    for (const name of placed) {
      expect(panel).toHaveClass(name);
    }
    for (const name of notPlaced) {
      expect(panel).not.toHaveClass(name);
    }
  });

  it('makes each row reachable by the keyboard, described by its panel', async () => {
    const user = userEvent.setup();
    await renderFamilies('en');

    const rows = screen.getAllByRole('group');
    expect(rows).toHaveLength(MATCH_METRICS.length);
    const [first, second] = rows;
    const panel = panelOf('KDA');
    expect(first).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('aria-describedby', panel.id);
    expect(first).toHaveAccessibleDescription(/Percentile 50 of your rank/);
    // A row that takes the focus says which metric it is, before the panel says what it holds.
    expect(first).toHaveAccessibleName('KDA');
    expect(second).toHaveAccessibleName('Damage to heroes per min');

    await user.tab();

    expect(first).toHaveFocus();
    // The panel is shown for the pointer and for the focus.
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');

    await user.tab();

    expect(second).toHaveFocus();
  });

  it('names a row in French', async () => {
    await renderFamilies('fr');

    expect(screen.getAllByRole('group')[0]).toHaveAccessibleName('KDA');
    expect(screen.getAllByRole('group')[1]).toHaveAccessibleName('Dégâts aux héros par min');
  });

  it('closes the panel with Escape until the focus leaves', async () => {
    const user = userEvent.setup();
    await renderFamilies('en');
    const panel = panelOf('KDA');

    await user.tab();
    await user.keyboard('{Escape}');

    expect(panel).toHaveClass('hidden');
    expect(panel).not.toHaveClass('group-hover:block');
    expect(panel).not.toHaveClass('group-focus-visible:block');

    // Tabbing away is leaving: the panel may open again.
    await user.tab();

    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
  });

  it('keeps the panel closed after Escape while the focus stays, whatever the pointer does', async () => {
    const user = userEvent.setup();
    await renderFamilies('en');
    const panel = panelOf('KDA');
    const row = within(rowOf('KDA')).getByRole('group');

    // A click puts the pointer over the row and the focus on it.
    await user.click(row);
    await user.keyboard('{Escape}');
    expect(panel).not.toHaveClass('group-hover:block');

    // The pointer leaves, the focus does not: the panel stays closed.
    await user.unhover(row);

    expect(row).toHaveFocus();
    expect(panel).not.toHaveClass('group-hover:block');
    expect(panel).not.toHaveClass('group-focus-visible:block');

    // The focus leaves too: the panel may open again, and does when the pointer comes back.
    await user.tab();
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
    await user.hover(row);
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
  });

  it('keeps the panel closed after Escape while the pointer stays, whatever the focus does', async () => {
    const user = userEvent.setup();
    await renderFamilies('en');
    const panel = panelOf('KDA');
    const row = within(rowOf('KDA')).getByRole('group');

    await user.click(row);
    await user.keyboard('{Escape}');

    // The focus leaves, the pointer does not: the panel stays closed.
    await user.tab();

    expect(row).not.toHaveFocus();
    expect(panel).not.toHaveClass('group-hover:block');
    expect(panel).not.toHaveClass('group-focus-visible:block');

    // The pointer leaves too: the panel may open again, and does when the focus comes back.
    await user.unhover(row);
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
    await user.click(row);
    expect(row).toHaveFocus();
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
  });

  it('opens the panel again when the pointer and the focus leave one just after the other', async () => {
    const user = userEvent.setup();
    await renderFamilies('en');
    const panel = panelOf('KDA');
    const row = within(rowOf('KDA')).getByRole('group');

    await user.click(row);
    await user.keyboard('{Escape}');
    // The pointer then the focus, with no time between them for the page to draw: the second event
    // must be read against the state the first one left, not against the one drawn before it.
    act(() => {
      fireEvent.mouseLeave(row);
      fireEvent.blur(row);
    });

    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
  });

  it('wraps what it is given and opens a panel of its own', async () => {
    const row = testFamilies()[0]?.rows[0] ?? expect.unreachable('A family holds rows');
    await renderIn(
      'en',
      <Evidence row={row}>
        <span>Wrapped</span>
      </Evidence>,
    );

    const group = screen.getByRole('group');
    expect(within(group).getByText('Wrapped')).toBeInTheDocument();
    expect(group).toHaveClass('group', 'relative');
    expect(within(group).getByRole('tooltip')).toHaveClass('absolute', 'hidden');
  });
});

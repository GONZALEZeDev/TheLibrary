/**
 * Tests of the summary of the strengths and weaknesses and of the phase table of the match page,
 * rendered on their own with views built by hand (the view the analysis service gives is tested with
 * the service), in English and in French.
 *
 * The numbers are synthetic and chosen so that each one is told from the others in the page.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Insight } from '../../../core/analysis/insights/insights';
import type { MetricKey } from '../../../core/analysis/metric';
import { phaseMetricKey } from '../../../core/analysis/metrics/phase.metric';
import { phaseSpans, type Phase, type PhaseStat } from '../../../core/analysis/phases';
import type { Language } from '../../../core/settings/language';
import type {
  MetricRowView,
  PhaseCellView,
  PhaseColumnView,
} from '../../../services/analysis-view';
import { createI18n } from '../../i18n/i18n';
import { InsightSummary } from './InsightSummary';
import { PhaseTable } from './PhaseTable';

/** The length of the match of most tests: 32 minutes and 14 seconds, so the three phases are reached. */
const FULL_MATCH_S = 1_934;

/** The minus sign the page writes before a negative number. */
const MINUS = '\u2212';

/** The four figures of the table, as the row headers say them in English, in the order of the rows. */
const FIGURES = ['Souls', 'Damage to heroes', 'Damage to objectives', 'Kills'] as const;

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
 * Build the row of a metric: a rate per minute that stands around the average of the rank and
 * 4 % above the habits of the player, unless overridden.
 *
 * @param key - The metric.
 * @param overrides - Fields to change.
 * @returns The row.
 */
function testRow(key: MetricKey, overrides: Partial<MetricRowView> = {}): MetricRowView {
  return {
    key,
    unit: 'per_min',
    better: 'higher',
    value: 1_000,
    community: { kind: 'curve', percentile: 50, label: 'around' },
    personal: { count: 20, median: 17_000, z: 0.2, difference: { kind: 'relative', ratio: 0.04 } },
    insight: null,
    confidence: 'high',
    ...overrides,
  };
}

/** What the player did in a phase, by figure: each figure has a total no other figure has. */
const DEFAULT_TOTALS: Readonly<Record<PhaseStat, number>> = {
  souls: 17_800,
  hero_damage: 15_600,
  objective_damage: 4_200,
  kills: 3,
};

/**
 * Build the phase columns of a match: the phases it reached, each with its four figures. A figure
 * has the default total of its kind and a fifth of the team, and, when its phase is long enough to
 * be compared, the row of its metric. The cells in `overrides` replace the default ones.
 *
 * @param durationS - The length of the match, in seconds.
 * @param overrides - The cells to replace, by phase then figure.
 * @returns One column per phase the match reached.
 */
function testColumns(
  durationS: number,
  overrides: Partial<Record<Phase, Partial<Record<PhaseStat, PhaseCellView>>>> = {},
): PhaseColumnView[] {
  return phaseSpans(durationS).map((span) => {
    const cellOf = (stat: PhaseStat): PhaseCellView =>
      overrides[span.phase]?.[stat] ?? {
        total: DEFAULT_TOTALS[stat],
        teamShare: 0.2,
        row: span.comparable ? testRow(phaseMetricKey(stat, span.phase)) : null,
      };
    return {
      span,
      cells: {
        souls: cellOf('souls'),
        hero_damage: cellOf('hero_damage'),
        objective_damage: cellOf('objective_damage'),
        kills: cellOf('kills'),
      },
    };
  });
}

/**
 * Find the cells of the row of a figure.
 *
 * @param figure - The name of the figure, as the row header says it.
 * @returns The cells of the row, one per phase, in the order of the columns.
 */
function cellsOf(figure: string): HTMLElement[] {
  const row =
    screen.getByRole('rowheader', { name: figure }).closest('tr') ??
    expect.unreachable('A row header sits in a row');
  return within(row).getAllByRole('cell');
}

/**
 * Get one cell of the table.
 *
 * @param figure - The name of the figure, as the row header says it.
 * @param column - The place of the phase among the columns, from 0.
 * @returns The cell.
 */
function cellAt(figure: string, column: number): HTMLElement {
  return cellsOf(figure)[column] ?? expect.unreachable(`The table has no column ${String(column)}`);
}

/**
 * Get the headers of the phase columns.
 *
 * @returns One header per phase, in the order of the columns.
 */
function phaseHeaders(): HTMLElement[] {
  return screen.getAllByRole('columnheader');
}

/**
 * Get the header of one phase column.
 *
 * @param column - The place of the phase among the columns, from 0.
 * @returns The header.
 */
function phaseHeaderAt(column: number): HTMLElement {
  return (
    phaseHeaders()[column] ?? expect.unreachable(`The table has no phase header ${String(column)}`)
  );
}

/**
 * Get the classes of an element that colour its background: the tint of a cell that stood out is
 * one (`bg-win/10`, `bg-loss/10`).
 *
 * @param element - The element.
 * @returns The background classes, none when the element has no background of its own.
 */
function backgroundsOf(element: Element): string[] {
  return Array.from(element.classList).filter((name) => name.startsWith('bg-'));
}

/**
 * Find the two lines of a phase header: the name of the phase and, apart from it, the range it covers.
 *
 * @param header - The header of a phase column.
 * @returns The element of the name and the element of the range; the test fails unless each is alone.
 */
function phaseHeaderLines(header: HTMLElement): { name: HTMLElement; range: HTMLElement } {
  return {
    name: within(header).getByText(/^(Early|Mid|Late)$/),
    range: within(header).getByText(/ → /),
  };
}

/**
 * Read what a phase header says.
 *
 * @param header - The header of a phase column.
 * @returns The text of the name and the text of the range.
 */
function readPhaseHeader(header: HTMLElement): { name: string | null; range: string | null } {
  const { name, range } = phaseHeaderLines(header);
  return { name: name.textContent, range: range.textContent };
}

/**
 * Find a text that a cell shows in its own lines, not the one of its evidence panel (which says some
 * of them again: the place on the curve of the rank, for one).
 *
 * @param cell - The cell.
 * @param text - The text, whole.
 * @returns The element that holds the text; the test fails unless exactly one does.
 */
function shownInCell(cell: HTMLElement, text: string): HTMLElement {
  const shown = within(cell)
    .getAllByText(text)
    .filter((element) => element.closest('[role="tooltip"]') === null);
  expect(shown).toHaveLength(1);
  return shown[0] ?? expect.unreachable(`The cell does not show ${text}`);
}

/**
 * Get the evidence panel of a cell.
 *
 * @param cell - A cell that is compared.
 * @returns The panel, which the wrapper of the cell describes.
 */
function panelOfCell(cell: HTMLElement): HTMLElement {
  return within(cell).getByRole('tooltip');
}

describe('PhaseTable', () => {
  it('heads each phase with its name and its range, and each figure in a row, in English', async () => {
    await renderIn('en', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);

    expect(screen.getByRole('table', { name: 'By phase' })).toBeInTheDocument();
    expect(phaseHeaders().map(readPhaseHeader)).toEqual([
      { name: 'Early', range: '0:00 → 10:00' },
      { name: 'Mid', range: '10:00 → 25:00' },
      // The last phase ends with the match.
      { name: 'Late', range: '25:00 → 32:14' },
    ]);
    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
      'Souls',
      'Damage to heroes',
      'Damage to objectives',
      'Kills',
    ]);
  });

  it('heads each phase with its name and its range, and each figure in a row, in French', async () => {
    await renderIn('fr', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);

    expect(screen.getByRole('table', { name: 'Par phase' })).toBeInTheDocument();
    // The names of the phases are the game's own words, in both languages.
    expect(phaseHeaders().map(readPhaseHeader)).toEqual([
      { name: 'Early', range: '0:00 → 10:00' },
      { name: 'Mid', range: '10:00 → 25:00' },
      { name: 'Late', range: '25:00 → 32:14' },
    ]);
    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
      'Âmes',
      'Dégâts aux héros',
      'Dégâts aux objectifs',
      'Kills',
    ]);
  });

  it('sets the name of a phase over its range: the name strong, the range muted, one per line', async () => {
    await renderIn('en', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);

    for (const header of phaseHeaders()) {
      const { name, range } = phaseHeaderLines(header);
      expect(name).toHaveClass('block', 'text-sm', 'font-medium', 'text-fg');
      expect(range).toHaveClass('block', 'text-xs', 'text-fg-muted', 'tabular-nums');
    }
  });

  it('keeps reading a phase header as one phrase, whatever the styles say about the lines', async () => {
    await renderIn('en', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);

    // The two lines are blocks in the page; for assistive technologies, and wherever the styles are
    // not applied, a hidden dot keeps the name and the range apart.
    expect(phaseHeaders().map((header) => header.textContent)).toEqual([
      'Early · 0:00 → 10:00',
      'Mid · 10:00 → 25:00',
      'Late · 25:00 → 32:14',
    ]);
    // The name that is computed puts the dot between the two, with or without the spaces around it
    // (the computation drops those of an inline element when no style makes the lines blocks).
    expect(phaseHeaderAt(1)).toHaveAccessibleName(/^Mid\s*·\s*10:00 → 25:00$/);
    expect(within(phaseHeaderAt(1)).getByText('·')).toHaveClass('sr-only');
  });

  it.each([
    { reached: 'one phase', durationS: 5 * 60, phases: 1 },
    { reached: 'two phases', durationS: 24 * 60, phases: 2 },
    { reached: 'three phases', durationS: FULL_MATCH_S, phases: 3 },
  ])(
    'puts a rule above every cell and at the left of every phase column, the header row included: $reached',
    async (input) => {
      await renderIn('en', <PhaseTable phases={testColumns(input.durationS)} />);

      // The header row: the empty corner, then one header a phase.
      const [headerRow, ...bodyRows] = screen.getAllByRole('row');
      expect(bodyRows).toHaveLength(FIGURES.length);
      const [corner, ...headers] = Array.from(headerRow?.children ?? []);
      expect(corner).toHaveClass('border-t', 'border-border');
      expect(corner).not.toHaveClass('border-l');
      expect(headers).toEqual(phaseHeaders());
      expect(headers).toHaveLength(input.phases);
      // A phase header has its rule at its left, and the rule above the header row.
      for (const header of headers) {
        expect(header).toHaveClass('border-t', 'border-l', 'border-border');
      }

      // Every row of the body: the name of the figure has the rule above the row, and no rule at
      // its left (the border of the box closes the table there); every cell of a phase has both.
      for (const figure of FIGURES) {
        const figureHeader = screen.getByRole('rowheader', { name: figure });
        expect(figureHeader).toHaveClass('border-t', 'border-border');
        expect(figureHeader).not.toHaveClass('border-l');
        const cells = cellsOf(figure);
        expect(cells).toHaveLength(input.phases);
        for (const cell of cells) {
          expect(cell).toHaveClass('border-t', 'border-l', 'border-border');
        }
      }
    },
  );

  it('shows in a cell the total, the share of the team, the gap with the habits and the place in the rank', async () => {
    await renderIn('en', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);

    const cell = cellAt('Souls', 1);

    expect(within(cell).getByText('17,800')).toBeInTheDocument();
    expect(within(cell).getByText('20% of the team')).toBeInTheDocument();
    expect(within(cell).getByText('+4% vs your habits')).toBeInTheDocument();
    expect(shownInCell(cell, "Around your rank's average")).toBeInTheDocument();
    expect(within(cell).queryByText('Too short to compare')).not.toBeInTheDocument();
  });

  it('writes the numbers of a cell with the conventions of French', async () => {
    await renderIn('fr', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);

    const cell = cellAt('Âmes', 1);

    // The spaces of the numbers are no-break ones: the queries read them as plain spaces.
    expect(within(cell).getByText('17 800')).toBeInTheDocument();
    expect(within(cell).getByText("20 % de l'équipe")).toBeInTheDocument();
    expect(within(cell).getByText('+4 % vs tes habitudes')).toBeInTheDocument();
    expect(shownInCell(cell, 'Dans la moyenne de ton rang')).toBeInTheDocument();
  });

  it('writes a gap below the habits with a minus sign, and a gap in kills as a number of kills', async () => {
    const phases = testColumns(FULL_MATCH_S, {
      mid: {
        souls: {
          total: 17_800,
          teamShare: 0.2,
          row: testRow('souls_per_min_mid', {
            personal: {
              count: 20,
              median: 18_000,
              z: -0.5,
              difference: { kind: 'relative', ratio: -0.15 },
            },
          }),
        },
        kills: {
          total: 3,
          teamShare: 0.2,
          row: testRow('kills_per_min_mid', {
            personal: { count: 20, median: 2, z: 1, difference: { kind: 'absolute', amount: 1 } },
          }),
        },
      },
    });
    await renderIn('en', <PhaseTable phases={phases} />);

    expect(within(cellAt('Souls', 1)).getByText(`${MINUS}15% vs your habits`)).toBeInTheDocument();
    expect(within(cellAt('Kills', 1)).getByText('+1 vs your habits')).toBeInTheDocument();
  });

  it('shows no phase the match did not reach: a 24-minute match has no late column', async () => {
    await renderIn('en', <PhaseTable phases={testColumns(24 * 60)} />);

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(['Early · 0:00 → 10:00', 'Mid · 10:00 → 24:00']);
    // Two cells a row, not three.
    expect(cellsOf('Souls')).toHaveLength(2);
    expect(screen.queryByText(/Late/)).not.toBeInTheDocument();
  });

  it('shows "Too short to compare" in the late column of a 25:30 match, with its totals', async () => {
    await renderIn('en', <PhaseTable phases={testColumns(25 * 60 + 30)} />);

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Early · 0:00 → 10:00',
      'Mid · 10:00 → 25:00',
      'Late · 25:00 → 25:30',
    ]);
    // The four cells of the late column say it; the cells of the other columns do not.
    expect(screen.getAllByText('Too short to compare')).toHaveLength(4);
    for (const figure of ['Souls', 'Damage to heroes', 'Damage to objectives', 'Kills']) {
      expect(within(cellAt(figure, 2)).getByText('Too short to compare')).toBeInTheDocument();
      expect(within(cellAt(figure, 1)).queryByText('Too short to compare')).not.toBeInTheDocument();
    }
    // What the player did and the share of the team are still told, and no gap is.
    const late = cellAt('Souls', 2);
    expect(within(late).getByText('17,800')).toBeInTheDocument();
    expect(within(late).getByText('20% of the team')).toBeInTheDocument();
    expect(within(late).queryByText(/vs your habits/)).not.toBeInTheDocument();
  });

  it('says it in French too', async () => {
    await renderIn('fr', <PhaseTable phases={testColumns(25 * 60 + 30)} />);

    expect(within(cellAt('Âmes', 2)).getByText('Trop courte pour comparer')).toBeInTheDocument();
  });

  it('marks a strength and a weakness with their arrow and their word, and tints their cell', async () => {
    const phases = testColumns(FULL_MATCH_S, {
      early: {
        souls: {
          total: 3_900,
          teamShare: 0.17,
          row: testRow('souls_at_10min', { insight: testInsight('souls_at_10min', 'weakness') }),
        },
      },
      mid: {
        objective_damage: {
          total: 8_200,
          teamShare: 0.27,
          row: testRow('objective_damage_per_min_mid', {
            insight: testInsight('objective_damage_per_min_mid', 'strength'),
          }),
        },
      },
    });
    await renderIn('en', <PhaseTable phases={phases} />);

    const weakness = cellAt('Souls', 0);
    expect(within(weakness).getByText('▼')).toHaveAttribute('aria-hidden', 'true');
    expect(within(weakness).getByText('weakness')).toHaveClass('sr-only');
    expect(within(weakness).getByText('3,900')).toBeInTheDocument();
    expect(weakness).toHaveClass('bg-loss/10');

    const strength = cellAt('Damage to objectives', 1);
    expect(within(strength).getByText('▲')).toHaveAttribute('aria-hidden', 'true');
    expect(within(strength).getByText('strength')).toHaveClass('sr-only');
    expect(within(strength).getByText('8,200')).toBeInTheDocument();
    expect(strength).toHaveClass('bg-win/10');

    // Nothing else is marked: two arrows and two words in the table.
    expect(screen.getAllByText(/^[▲▼]$/)).toHaveLength(2);
    expect(screen.queryAllByText(/^(strength|weakness)$/)).toHaveLength(2);
    expect(cellAt('Souls', 1)).not.toHaveClass('bg-win/10');
    expect(cellAt('Souls', 1)).not.toHaveClass('bg-loss/10');
  });

  it('says the words of a strength and a weakness in French', async () => {
    const phases = testColumns(FULL_MATCH_S, {
      early: {
        souls: {
          total: 3_900,
          teamShare: 0.17,
          row: testRow('souls_at_10min', { insight: testInsight('souls_at_10min', 'weakness') }),
        },
        kills: {
          total: 3,
          teamShare: 0.17,
          row: testRow('kills_per_min_early', {
            insight: testInsight('kills_per_min_early', 'strength'),
          }),
        },
      },
    });
    await renderIn('fr', <PhaseTable phases={phases} />);

    expect(within(cellAt('Âmes', 0)).getByText('point faible')).toBeInTheDocument();
    expect(within(cellAt('Kills', 0)).getByText('point fort')).toBeInTheDocument();
  });

  it('keeps the tint of a cell that stood out, with its rules, and gives no other cell a background', async () => {
    const phases = testColumns(FULL_MATCH_S, {
      mid: {
        souls: {
          total: 9_000,
          teamShare: 0.15,
          row: testRow('souls_per_min_mid', {
            insight: testInsight('souls_per_min_mid', 'weakness'),
          }),
        },
        kills: {
          total: 9,
          teamShare: 0.4,
          row: testRow('kills_per_min_mid', {
            insight: testInsight('kills_per_min_mid', 'strength'),
          }),
        },
      },
    });
    await renderIn('en', <PhaseTable phases={phases} />);

    // The tint is the whole background of the cell, and it does not take its rules away.
    for (const [figure, tint] of [
      ['Souls', 'bg-loss/10'],
      ['Kills', 'bg-win/10'],
    ] as const) {
      const cell = cellAt(figure, 1);
      expect(cell).toHaveClass(tint, 'border-t', 'border-l', 'border-border');
      expect(backgroundsOf(cell)).toEqual([tint]);
    }
    // Nothing else has a background: not the other cells of the column, nor the cells of the other
    // phases, nor the headers (the box behind the table is the only surface).
    const tintedCells = [cellAt('Souls', 1), cellAt('Kills', 1)];
    const plain = [
      ...screen.getAllByRole('cell'),
      ...screen.getAllByRole('columnheader'),
      ...screen.getAllByRole('rowheader'),
    ].filter((element) => !tintedCells.includes(element));
    expect(plain).not.toHaveLength(0);
    for (const element of plain) {
      expect(backgroundsOf(element)).toEqual([]);
    }
  });

  it('shows "—" for the share of a team total of 0, and for a total the archive does not tell', async () => {
    const phases = testColumns(FULL_MATCH_S, {
      mid: {
        // The team did nothing at all: there is no share of 0.
        kills: { total: 0, teamShare: null, row: testRow('kills_per_min_mid') },
        // The archive does not hold the counter: the total is unknown, and so is its share.
        hero_damage: {
          total: null,
          teamShare: null,
          row: testRow('hero_damage_per_min_mid', { value: null, personal: null }),
        },
      },
    });
    await renderIn('en', <PhaseTable phases={phases} />);

    const noTeam = cellAt('Kills', 1);
    expect(within(noTeam).getByText('0')).toBeInTheDocument();
    expect(within(noTeam).getByText('—')).toBeInTheDocument();
    expect(within(noTeam).queryByText(/of the team/)).not.toBeInTheDocument();

    const unknown = cellAt('Damage to heroes', 1);
    // The total and the share are two dashes, and no gap is told.
    expect(within(unknown).getAllByText('—')).toHaveLength(2);
    expect(within(unknown).queryByText(/vs your habits/)).not.toBeInTheDocument();
  });

  it('tells nothing of the habits or of the rank that it does not know', async () => {
    const phases = testColumns(FULL_MATCH_S, {
      mid: {
        // A player with too few earlier matches, in a phase the community has no curve for.
        souls: {
          total: 17_800,
          teamShare: 0.2,
          row: testRow('souls_per_min_mid', { personal: null, community: { kind: 'missing' } }),
        },
      },
    });
    await renderIn('en', <PhaseTable phases={phases} />);

    const cell = cellAt('Souls', 1);

    expect(within(cell).getByText('17,800')).toBeInTheDocument();
    expect(within(cell).getByText('20% of the team')).toBeInTheDocument();
    expect(within(cell).queryByText(/vs your habits/)).not.toBeInTheDocument();
    expect(within(cell).queryByText(/your rank/)).not.toBeInTheDocument();
    expect(within(cell).queryByText('Too short to compare')).not.toBeInTheDocument();
  });

  it.each([
    { label: 'well_above', en: 'Well above your rank', fr: 'Bien au-dessus de ton rang' },
    { label: 'above', en: 'Above your rank', fr: 'Au-dessus de ton rang' },
    { label: 'around', en: "Around your rank's average", fr: 'Dans la moyenne de ton rang' },
    { label: 'below', en: 'Below your rank', fr: 'En dessous de ton rang' },
    { label: 'well_below', en: 'Well below your rank', fr: 'Bien en dessous de ton rang' },
  ] as const)('says where a cell stands on the curve of the rank: $label', async (input) => {
    const phases = testColumns(FULL_MATCH_S, {
      mid: {
        souls: {
          total: 17_800,
          teamShare: 0.2,
          row: testRow('souls_per_min_mid', {
            community: { kind: 'curve', percentile: 50, label: input.label },
          }),
        },
      },
    });
    await renderIn('en', <PhaseTable phases={phases} />);

    expect(shownInCell(cellAt('Souls', 1), input.en)).toBeInTheDocument();
  });

  it('shows nothing when the match reached no phase', async () => {
    await renderIn('en', <PhaseTable phases={[]} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('the evidence of the cells of PhaseTable', () => {
  it('opens one for each cell that is compared, named after its metric, and for no other', async () => {
    await renderIn('en', <PhaseTable phases={testColumns(25 * 60 + 30)} />);

    // Four figures in the two phases that are long enough: eight cells. The late phase is too short.
    expect(screen.getAllByRole('group')).toHaveLength(8);
    expect(screen.getAllByRole('tooltip')).toHaveLength(8);
    // The early souls are compared through the souls at 10:00, the others through their phase.
    expect(within(cellAt('Souls', 0)).getByRole('group')).toHaveAccessibleName('Souls at 10:00');
    expect(within(cellAt('Souls', 1)).getByRole('group')).toHaveAccessibleName('Souls in mid');
    expect(within(cellAt('Kills', 0)).getByRole('group')).toHaveAccessibleName('Kills in early');
    for (const figure of ['Souls', 'Damage to heroes', 'Damage to objectives', 'Kills']) {
      expect(within(cellAt(figure, 2)).queryByRole('group')).not.toBeInTheDocument();
      expect(within(cellAt(figure, 2)).queryByRole('tooltip')).not.toBeInTheDocument();
    }
  });

  it('names the cells in French', async () => {
    await renderIn('fr', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);

    expect(within(cellAt('Âmes', 0)).getByRole('group')).toHaveAccessibleName('Âmes à 10:00');
    expect(within(cellAt('Âmes', 1)).getByRole('group')).toHaveAccessibleName('Âmes en mid');
  });

  it('opens on the focus of the keyboard, describes the cell, and closes with Escape', async () => {
    const user = userEvent.setup();
    await renderIn('en', <PhaseTable phases={testColumns(FULL_MATCH_S)} />);
    const cell = cellAt('Souls', 0);
    const group = within(cell).getByRole('group');
    const panel = panelOfCell(cell);

    // The first cell of the table is the first stop of the keyboard.
    await user.tab();

    expect(group).toHaveFocus();
    expect(group).toHaveAttribute('aria-describedby', panel.id);
    expect(group).toHaveAccessibleDescription(/Your median: 17,000.*20 reference matches/);
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');

    await user.keyboard('{Escape}');

    expect(panel).toHaveClass('hidden');
    expect(panel).not.toHaveClass('group-focus-visible:block');
    expect(panel).not.toHaveClass('group-hover:block');
    // The figures of the cell are still there.
    expect(within(cell).getByText('17,800')).toBeInTheDocument();
  });

  it('keeps the tint, the arrow and the word on the cell that holds the evidence', async () => {
    const phases = testColumns(FULL_MATCH_S, {
      mid: {
        souls: {
          total: 9_000,
          teamShare: 0.15,
          row: testRow('souls_per_min_mid', {
            insight: testInsight('souls_per_min_mid', 'weakness'),
          }),
        },
      },
    });
    await renderIn('en', <PhaseTable phases={phases} />);

    const cell = cellAt('Souls', 1);

    expect(cell).toHaveClass('bg-loss/10');
    // The evidence says why the cell stands out.
    expect(
      within(panelOfCell(cell)).getByText(
        'Picked for your place in your rank and the gap with your habits',
      ),
    ).toBeInTheDocument();
    expect(within(cell).getByText('weakness')).toHaveClass('sr-only');
    // The arrow and the word are inside the focusable wrapper: the cell is read with them.
    expect(within(within(cell).getByRole('group')).getByText('▼')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it.each([
    {
      language: 'en',
      kills: 'Kills',
      objectives: 'Damage to objectives',
      souls: 'Souls',
      killsMedian: 'Your median: 3.5',
      killsGap: '+0.5 vs your habits',
      objectivesMedian: 'Your median: 0',
      objectivesGap: '+1,235 vs your habits',
      soulsMedian: 'Your median: 17,835',
    },
    {
      language: 'fr',
      kills: 'Kills',
      objectives: 'Dégâts aux objectifs',
      souls: 'Âmes',
      killsMedian: 'Ta médiane : 3,5',
      killsGap: '+0,5 vs tes habitudes',
      objectivesMedian: 'Ta médiane : 0',
      objectivesGap: '+1 235 vs tes habitudes',
      soulsMedian: 'Ta médiane : 17 835',
    },
  ] as const)(
    'writes the usual value and the gap of a cell as totals of the phase ($language)',
    async (input) => {
      const phases = testColumns(FULL_MATCH_S, {
        mid: {
          // Half a kill: written as a whole one it would double the gap beside it.
          kills: {
            total: 4,
            teamShare: 0.25,
            row: testRow('kills_per_min_mid', {
              personal: {
                count: 20,
                median: 3.5,
                z: 0.4,
                difference: { kind: 'absolute', amount: 0.5 },
              },
            }),
          },
          // A usual value of 0 (the phase never saw an objective hit) leaves an absolute gap, which
          // is an amount of damage: whole, not "+1,234.6" as a rate per minute would be.
          objective_damage: {
            total: 1_235,
            teamShare: 0.1,
            row: testRow('objective_damage_per_min_mid', {
              personal: {
                count: 20,
                median: 0,
                z: null,
                difference: { kind: 'absolute', amount: 1_234.6 },
              },
            }),
          },
          // An amount of souls is whole.
          souls: {
            total: 18_000,
            teamShare: 0.2,
            row: testRow('souls_per_min_mid', {
              personal: {
                count: 20,
                median: 17_834.6,
                z: 0.1,
                difference: { kind: 'relative', ratio: 0.01 },
              },
            }),
          },
        },
      });
      await renderIn(input.language, <PhaseTable phases={phases} />);

      const killsCell = cellAt(input.kills, 1);
      expect(within(killsCell).getByText(input.killsGap)).toBeInTheDocument();
      expect(within(panelOfCell(killsCell)).getByText(input.killsMedian)).toBeInTheDocument();

      const objectivesCell = cellAt(input.objectives, 1);
      expect(within(objectivesCell).getByText(input.objectivesGap)).toBeInTheDocument();
      expect(
        within(panelOfCell(objectivesCell)).getByText(input.objectivesMedian),
      ).toBeInTheDocument();

      const soulsCell = cellAt(input.souls, 1);
      expect(within(panelOfCell(soulsCell)).getByText(input.soulsMedian)).toBeInTheDocument();
    },
  );
});

describe('InsightSummary', () => {
  const STRENGTHS = [testInsight('kda', 'strength'), testInsight('souls_per_min_mid', 'strength')];
  const WEAKNESSES = [testInsight('accuracy', 'weakness')];

  it('lists the strengths then the weaknesses as pills with an arrow, a name and a word', async () => {
    await renderIn('en', <InsightSummary strengths={STRENGTHS} weaknesses={WEAKNESSES} />);

    const strengths = screen.getByRole('list', { name: 'Strengths' });
    const weaknesses = screen.getByRole('list', { name: 'Weaknesses' });
    // The strengths come first.
    expect(screen.getAllByRole('list')).toEqual([strengths, weaknesses]);

    // Each pill reads: arrow, name of the metric (a phase metric by its figure and its phase), word.
    expect(
      within(strengths)
        .getAllByRole('listitem')
        .map((pill) => pill.textContent),
    ).toEqual(['▲KDAstrength', '▲Souls in midstrength']);
    expect(
      within(weaknesses)
        .getAllByRole('listitem')
        .map((pill) => pill.textContent),
    ).toEqual(['▼Accuracyweakness']);
    // The arrow is a mark for the eye and the word is for assistive technologies.
    for (const arrow of screen.getAllByText(/^[▲▼]$/)) {
      expect(arrow).toHaveAttribute('aria-hidden', 'true');
    }
    for (const word of screen.getAllByText(/^(strength|weakness)$/)) {
      expect(word).toHaveClass('sr-only');
    }
  });

  it('names the metrics and the words in French', async () => {
    await renderIn('fr', <InsightSummary strengths={STRENGTHS} weaknesses={WEAKNESSES} />);

    expect(screen.getByRole('list', { name: 'Points forts' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Points faibles' })).toBeInTheDocument();
    expect(screen.getByText('Âmes en mid')).toBeInTheDocument();
    expect(screen.getByText('Précision')).toBeInTheDocument();
    expect(screen.getAllByText('point fort')).toHaveLength(2);
    expect(screen.getByText('point faible')).toBeInTheDocument();
  });

  it.each([
    {
      language: 'en',
      label: 'Your strengths and weaknesses in this match',
      strengths: 'Strengths',
      weaknesses: 'Weaknesses',
    },
    {
      language: 'fr',
      label: 'Tes forces et faiblesses sur la partie',
      strengths: 'Points forts',
      weaknesses: 'Points faibles',
    },
  ] as const)(
    'puts a visible label before the pills, which names the group of the two lists ($language)',
    async (input) => {
      await renderIn(
        input.language,
        <InsightSummary strengths={STRENGTHS} weaknesses={WEAKNESSES} />,
      );

      // The label is text for the eye: neither hidden nor a heading (the section keeps its own title).
      const label = screen.getByText(input.label);
      expect(label).not.toHaveClass('sr-only');
      expect(label).toHaveClass('text-fg-muted', 'font-medium');
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
      // It does not shrink when the pills crowd it: they wrap instead.
      expect(label).toHaveClass('shrink-0');
      // It stands first in the group it names, which holds the two lists and their own names.
      const group = screen.getByRole('group', { name: input.label });
      expect(group.firstElementChild).toBe(label);
      expect(within(group).getByRole('list', { name: input.strengths })).toBeInTheDocument();
      expect(within(group).getByRole('list', { name: input.weaknesses })).toBeInTheDocument();
    },
  );

  it('shows only the side that has something to say', async () => {
    await renderIn('en', <InsightSummary strengths={[]} weaknesses={WEAKNESSES} />);

    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Weaknesses' })).toBeInTheDocument();
    expect(screen.getByText('Your strengths and weaknesses in this match')).toBeInTheDocument();
    expect(screen.queryByText('Nothing stands out in this match.')).not.toBeInTheDocument();
  });

  it.each([
    {
      language: 'en',
      label: 'Your strengths and weaknesses in this match',
      sentence: 'Nothing stands out in this match.',
    },
    {
      language: 'fr',
      label: 'Tes forces et faiblesses sur la partie',
      sentence: 'Rien ne ressort dans cette partie.',
    },
  ] as const)(
    'keeps the label and says that nothing stands out when there is neither ($language)',
    async (input) => {
      await renderIn(input.language, <InsightSummary strengths={[]} weaknesses={[]} />);

      // The sentence takes the place of the pills, next to the label.
      const group = screen.getByRole('group', { name: input.label });
      expect(within(group).getByText(input.sentence)).toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    },
  );
});

/**
 * Tests of the stats tab of the review, rendered on its own with the stats the review service builds
 * for a player with no match (24 rows, in the order of the registry of the metrics), in English and
 * in French: every metric of every family under its title, the phase metrics under theirs, the rows
 * in the order the view gives them, the headings, and the header of the columns above each list.
 *
 * The rows are the ones of the review, drawn by `ReviewRow` (tested on its own); the tests here are
 * about which rows the tab lists, in which order and under which heading.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Language } from '../../../core/settings/language';
import { statsRowsOf } from '../../../services/review-stats';
import type { Review } from '../../../services/review-view';
import { createI18n } from '../../i18n/i18n';
import { REVIEW_TWO_LISTS } from './review-layout';
import { ReviewStats } from './ReviewStats';

/** The texts of the tab in English: the title of each family with the metrics it holds, in order. */
const FAMILIES_EN = [
  { title: 'Combat', labels: ['KDA', 'Damage to heroes per min', 'Accuracy'] },
  { title: 'Survival', labels: ['Deaths', 'Damage taken per min'] },
  { title: 'Farm', labels: ['Souls per min', 'Last hits', 'Denies'] },
  { title: 'Support', labels: ['Healing to allies', 'Barriers to allies'] },
  { title: 'Objectives', labels: ['Damage to objectives per min'] },
  { title: 'Laning', labels: ['Souls at 10:00', 'Lane souls difference at 10:00'] },
] as const;

/** The title of each family in French, in the order of the page, and how many metrics it holds. */
const FAMILIES_FR = [
  { title: 'Combat', count: 3 },
  { title: 'Survie', count: 2 },
  { title: 'Farm', count: 3 },
  { title: 'Soutien', count: 2 },
  { title: 'Objectifs', count: 1 },
  { title: 'Phase de lane', count: 2 },
] as const;

/** The phase metrics in English, in the order of the registry. */
const PHASE_LABELS_EN = [
  'Souls in mid',
  'Souls in late',
  'Damage to heroes in early',
  'Damage to heroes in mid',
  'Damage to heroes in late',
  'Damage to objectives in early',
  'Damage to objectives in mid',
  'Damage to objectives in late',
  'Kills in early',
  'Kills in mid',
  'Kills in late',
] as const;

/** The title of the phase metrics, by language. */
const PHASE_TITLE = { en: 'By phase', fr: 'Par phase' } as const satisfies Record<Language, string>;

/** The name of the columns of the tier and of the gap, which the header writes as one, by language. */
const TIER_AND_GAP = {
  en: 'Tier above · Gap',
  fr: 'Palier au-dessus · Écart',
} as const satisfies Record<Language, string>;

/**
 * Render an element with the i18next instance of one language.
 *
 * @param language - The language of the interface.
 * @param element - The element to render.
 * @returns The container the element was rendered in.
 */
async function renderIn(language: Language, element: ReactElement): Promise<HTMLElement> {
  const i18n = await createI18n(language);
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>).container;
}

/**
 * The stats of the review as the service builds them: the 13 metrics of the match by family in the
 * order of the match page, then the 11 metrics of a phase. With no match behind them the rows have no
 * figure, and nothing else tells them apart but their name, which is what these tests read.
 *
 * @returns The stats.
 */
function serviceStats(): Review['stats'] {
  return statsRowsOf([], []);
}

/**
 * Name each row of a section after the name its text holds.
 *
 * @param section - The section.
 * @param names - The names the rows may be about.
 * @returns For each row, in the order of the list, the first of the names its text holds, or its
 *   whole text when it holds none.
 */
function namesOfRows(section: HTMLElement, names: readonly string[]): string[] {
  return within(section)
    .getAllByRole('listitem')
    .map((item) => names.find((name) => item.textContent.includes(name)) ?? item.textContent);
}

/**
 * The title of each section of the tab, in the order of the page.
 *
 * @returns The titles.
 */
function sectionTitles(): string[] {
  return screen
    .getAllByRole('region')
    .map((section) => within(section).getByRole('heading').textContent);
}

describe('ReviewStats', () => {
  it('shows every metric of every family, in the order of the registry', async () => {
    await renderIn('en', <ReviewStats stats={serviceStats()} />);

    // Each family has its section and nothing else is listed in it: the metrics stand in the order of
    // the registry, which is not the alphabetical order of their names.
    for (const { title, labels } of FAMILIES_EN) {
      expect(namesOfRows(screen.getByRole('region', { name: title }), labels)).toEqual(labels);
    }
  });

  it('puts the families in the order of the match page, then the phases', async () => {
    await renderIn('en', <ReviewStats stats={serviceStats()} />);

    expect(sectionTitles()).toEqual([...FAMILIES_EN.map(({ title }) => title), PHASE_TITLE.en]);
  });

  it('shows the phase metrics', async () => {
    await renderIn('en', <ReviewStats stats={serviceStats()} />);

    expect(
      namesOfRows(screen.getByRole('region', { name: PHASE_TITLE.en }), PHASE_LABELS_EN),
    ).toEqual(PHASE_LABELS_EN);
  });

  it('names the families and the phases in French', async () => {
    await renderIn('fr', <ReviewStats stats={serviceStats()} />);

    expect(sectionTitles()).toEqual([...FAMILIES_FR.map(({ title }) => title), PHASE_TITLE.fr]);
    for (const { title, count } of FAMILIES_FR) {
      expect(
        within(screen.getByRole('region', { name: title })).getAllByRole('listitem'),
      ).toHaveLength(count);
    }
    expect(
      within(screen.getByRole('region', { name: PHASE_TITLE.fr })).getAllByRole('listitem'),
    ).toHaveLength(PHASE_LABELS_EN.length);
    expect(screen.getByText('Précision')).toBeInTheDocument();
    expect(screen.getByText('Âmes en mid')).toBeInTheDocument();
  });

  it('keeps the order the view gives, whatever it is', async () => {
    const stats = serviceStats();
    // The view in the opposite order everywhere: the families, their metrics and the phases.
    const reversed: Review['stats'] = {
      families: stats.families.toReversed().map(({ family, rows }) => ({
        family,
        rows: rows.toReversed(),
      })),
      phases: stats.phases.toReversed(),
    };
    await renderIn('en', <ReviewStats stats={reversed} />);

    expect(sectionTitles()).toEqual([
      ...FAMILIES_EN.map(({ title }) => title).reverse(),
      PHASE_TITLE.en,
    ]);
    expect(
      namesOfRows(screen.getByRole('region', { name: 'Combat' }), FAMILIES_EN[0].labels),
    ).toEqual([...FAMILIES_EN[0].labels].reverse());
    expect(
      namesOfRows(screen.getByRole('region', { name: PHASE_TITLE.en }), PHASE_LABELS_EN),
    ).toEqual([...PHASE_LABELS_EN].reverse());
  });

  it.each(['en', 'fr'] as const)(
    'names each section by an h2 styled as the families of the match page, with no other heading in %s',
    async (language) => {
      await renderIn(language, <ReviewStats stats={serviceStats()} />);

      // Every tab has its sections at the level right under the title of the page, and the tab panel
      // is named by its tab: the tab adds no title of its own.
      expect(screen.getAllByRole('heading')).toHaveLength(FAMILIES_EN.length + 1);
      for (const section of screen.getAllByRole('region')) {
        const heading = within(section).getByRole('heading', { level: 2 });
        expect(section).toHaveAccessibleName(heading.textContent);
        expect(heading).toHaveClass('text-xs', 'font-medium', 'text-fg-muted', 'uppercase');
        expect(heading).not.toHaveClass('sr-only');
      }
    },
  );

  it.each(['en', 'fr'] as const)(
    'puts one header of the columns above each list, in the box of the rows in %s',
    async (language) => {
      await renderIn(language, <ReviewStats stats={serviceStats()} />);

      const sections = screen.getAllByRole('region');
      expect(sections).toHaveLength(FAMILIES_EN.length + 1);
      for (const section of sections) {
        const header = within(section).getByText(TIER_AND_GAP[language]).parentElement;
        const list = within(section).getByRole('list');
        expect(header).toHaveAttribute('aria-hidden', 'true');
        // The header sits in the same box as the rows, above them, so that their padding is the same
        // and the names stand over their figures.
        expect(header?.parentElement).toBe(list.parentElement);
        expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      }
    },
  );

  it('sets the sections two by two on a wide tab, each in its own cell, in reading order', async () => {
    await renderIn('en', <ReviewStats stats={serviceStats()} />);

    const sections = screen.getAllByRole('region');
    const grid = sections[0]?.parentElement ?? expect.unreachable('The tab holds sections');
    // The grid reads the width of the tab, not of the window.
    expect(grid).toHaveClass(REVIEW_TWO_LISTS);
    expect(grid.parentElement).toHaveClass('@container');
    // Every section is a cell of the grid, so that none is cut between two columns.
    expect(Array.from(grid.children)).toEqual(sections);
  });

  it('leaves out a section that holds no row', async () => {
    const [combat] = serviceStats().families;
    const container = await renderIn(
      'en',
      <ReviewStats
        stats={{
          families: [...(combat === undefined ? [] : [combat]), { family: 'support', rows: [] }],
          phases: [],
        }}
      />,
    );

    expect(sectionTitles()).toEqual(['Combat']);
    expect(screen.queryByRole('region', { name: 'Support' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: PHASE_TITLE.en })).not.toBeInTheDocument();
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  });
});

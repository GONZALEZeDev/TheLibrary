/**
 * Tests of the header of the columns of the review: the names it shows above the figures, in English
 * and in French, that it stays out of the accessibility tree (each figure of a row names itself), and
 * that it is laid out on the grid of the rows.
 *
 * @packageDocumentation
 */
import { isInaccessible, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Language } from '../../../core/settings/language';
import type { ReviewRow as ReviewRowData } from '../../../services/review-view';
import { createI18n } from '../../i18n/i18n';
import { REVIEW_ROW_GRID } from './review-layout';
import { ReviewRow } from './ReviewRow';
import { ReviewRowHeader } from './ReviewRowHeader';

/** The names of the columns, as the header writes them, by language. */
const COLUMN_NAMES = {
  en: ['You', 'Tier above · Gap', 'Weak / strong', 'Progress'],
  fr: ['Toi', 'Palier au-dessus · Écart', 'Faible / fort', 'Progression'],
} as const satisfies Record<Language, readonly string[]>;

/** A row of the review, for the tests that set the header beside one. */
const ROW: ReviewRowData = {
  subject: { kind: 'metric', key: 'deaths' },
  unit: 'deaths',
  better: 'lower',
  value: 1.6,
  count: 18,
  comparedValue: 1.6,
  reference: 1.3,
  difference: { kind: 'absolute', amount: 0.3 },
  percentile: 40,
  weak: 7,
  strong: 2,
  marked: 18,
  side: null,
  progress: { before: 1.8, direction: 'better' },
  matches: [],
};

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
 * Find the header that was rendered, through the first name it shows. A row beside it says the same
 * name for screen readers, so the header is the one of the texts that is hidden from them.
 *
 * @param firstName - The name of the player's column, in the language of the interface.
 * @returns The header.
 */
function headerOf(firstName: string): HTMLElement {
  for (const name of screen.getAllByText(firstName)) {
    const header = name.closest<HTMLElement>('[aria-hidden="true"]');
    if (header !== null) {
      return header;
    }
  }
  return expect.unreachable('The header is hidden from assistive technologies');
}

describe('ReviewRowHeader', () => {
  it.each(['en', 'fr'] as const)('names the columns of the figures in %s', async (language) => {
    await renderIn(language, <ReviewRowHeader />);

    for (const name of COLUMN_NAMES[language]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it.each(['en', 'fr'] as const)(
    'puts each name in the column of its figures, and leaves the arrow and the name empty in %s',
    async (language) => {
      await renderIn(language, <ReviewRowHeader />);

      const header = headerOf(COLUMN_NAMES[language][0]);
      expect(Array.from(header.children).map((cell) => cell.textContent)).toEqual([
        '',
        '',
        ...COLUMN_NAMES[language],
      ]);
    },
  );

  it('is hidden from assistive technologies, as each figure of a row names itself', async () => {
    await renderIn('en', <ReviewRowHeader />);

    const header = headerOf('You');
    expect(header).toHaveAttribute('aria-hidden', 'true');
    for (const name of COLUMN_NAMES.en) {
      expect(isInaccessible(screen.getByText(name))).toBe(true);
    }
  });

  it('is a small muted caption, in the colours of the theme', async () => {
    await renderIn('en', <ReviewRowHeader />);

    expect(headerOf('You')).toHaveClass('text-xs', 'text-fg-muted');
  });

  it('is laid out on the grid of the rows, with as many cells as a row has columns', async () => {
    await renderIn(
      'en',
      <>
        <ReviewRowHeader />
        <ul>
          <ReviewRow row={ROW} />
        </ul>
      </>,
    );

    const header = headerOf('You');
    // The row has no panel to wrap its grid (it lists no match), so the item holds the grid itself.
    const grid =
      screen.getByRole('listitem').firstElementChild ?? expect.unreachable('A row has its grid');
    expect(header).toHaveClass(REVIEW_ROW_GRID);
    expect(grid).toHaveClass(REVIEW_ROW_GRID);
    expect(header.children).toHaveLength(grid.children.length);
  });

  it('writes the first column right-aligned like the player figures it names', async () => {
    await renderIn('en', <ReviewRowHeader />);

    expect(screen.getByText('You')).toHaveClass('text-right');
  });
});

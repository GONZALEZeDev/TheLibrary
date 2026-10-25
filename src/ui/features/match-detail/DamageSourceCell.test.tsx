/**
 * Tests of the cell of a damage source, which the damage table of the match page and the damage tab
 * of the review both start their rows with: the picture beside the name, the word that says what a
 * weapon, a melee attack and an item are, the neutral square of a source with no picture, and the
 * classes the header of a table shares so that its caption stands over the pictures.
 *
 * @packageDocumentation
 */
import { render, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { SourceKind } from '../../../core/analysis/damage-breakdown';
import type { Language } from '../../../core/settings/language';
import { createI18n } from '../../i18n/i18n';
import { DamageSourceCell, SOURCE_CELL, type DamageSourceCellProps } from './DamageSourceCell';

/** Where the images of the catalogues live: the one origin the app lets the page load pictures from. */
const IMAGE_ORIGIN = 'https://assets-bucket.deadlock-api.com/';

/** The word each kind that has one is given, by language. */
const KIND_WORDS = {
  en: { weapon: 'Weapon', melee: 'Melee', item: 'Item' },
  fr: { weapon: 'Arme', melee: 'Mêlée', item: 'Objet' },
} as const satisfies Record<Language, Record<string, string>>;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

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
 * Render the cell of a source, in a source that is a weapon with its picture unless overridden.
 *
 * @param overrides - Props to change.
 * @param language - The language of the interface.
 * @returns The cell.
 */
async function renderCell(
  overrides: Partial<DamageSourceCellProps> = {},
  language: Language = 'en',
): Promise<HTMLElement> {
  const container = await renderIn(
    language,
    <DamageSourceCell
      name="Express Shot"
      kind="weapon"
      imageUrl={`${IMAGE_ORIGIN}weapons/express-shot.webp`}
      {...overrides}
    />,
  );
  return container.firstElementChild instanceof HTMLElement
    ? container.firstElementChild
    : expect.unreachable('The cell draws an element');
}

describe('DamageSourceCell', () => {
  it('shows the name of the source', async () => {
    const cell = await renderCell();

    expect(within(cell).getByText('Express Shot')).toBeVisible();
  });

  it('shows a decorative picture of the source before its name', async () => {
    const cell = await renderCell();

    // The name beside the picture says the source: the picture says nothing to assistive technologies.
    const picture = cell.querySelector('img');
    expect(picture).toHaveAttribute('src', `${IMAGE_ORIGIN}weapons/express-shot.webp`);
    expect(picture).toHaveAttribute('alt', '');
    expect(picture?.compareDocumentPosition(within(cell).getByText('Express Shot'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('gives the picture the size of the pictures of a damage source', async () => {
    const cell = await renderCell();

    const picture = cell.querySelector('img');
    expect(picture).toHaveAttribute('width', '32');
    expect(picture).toHaveAttribute('height', '32');
    expect(picture).toHaveClass('size-8', 'object-contain');
  });

  it('keeps a neutral square of the same size for a source with no picture', async () => {
    const cell = await renderCell({ imageUrl: null });

    // The names of the rows stay lined up whether or not the catalogue has the picture.
    expect(cell.querySelector('img')).toBeNull();
    const square = cell.querySelector('span[aria-hidden="true"].size-8');
    expect(square).not.toBeNull();
    expect(square?.compareDocumentPosition(within(cell).getByText('Express Shot'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it.each(LANGUAGES)(
    'says what a weapon, a melee attack and an item are in %s',
    async (language) => {
      const words = KIND_WORDS[language];
      for (const kind of ['weapon', 'melee', 'item'] as const) {
        const cell = await renderCell({ name: `The ${kind}`, kind }, language);

        // The word stands under the name, in the language of the interface.
        const word = within(cell).getByText(words[kind]);
        expect(within(cell).getByText(`The ${kind}`).compareDocumentPosition(word)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(word).toHaveClass('text-xs', 'text-fg-muted');
      }
    },
  );

  it.each(['ability', 'other'] as const satisfies readonly SourceKind[])(
    'says nothing under the name of a source of kind %s',
    async (kind) => {
      const cell = await renderCell({ kind });

      // An ability needs no word, and nor does a source that is none of the four kinds.
      expect(
        within(cell)
          .getAllByText(/./u)
          .map((element) => element.textContent),
      ).toEqual(['Express Shot']);
    },
  );

  it('gives the cell the classes that the header of a table shares', async () => {
    const cell = await renderCell();

    // The header gives its first caption the very same classes, so that it stands over the pictures.
    expect(cell.className).toBe(SOURCE_CELL);
    expect(SOURCE_CELL).toContain('px-3');
  });
});

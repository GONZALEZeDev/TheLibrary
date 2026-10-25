/**
 * Tests of the list of rows of the review, rendered on its own with rows built by hand, in English
 * and in French: the box, the header of the columns inside it above the list, the list that holds
 * nothing but items, the order of the rows, the picture of the item before the name of a resistance
 * row, and the keys of the rows.
 *
 * The rows are drawn by `ReviewRow` (tested on its own). The numbers are synthetic.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '../../../core/settings/language';
import type {
  ResistanceItemView,
  ReviewRow as ReviewRowData,
  ReviewSubject,
} from '../../../services/review-view';
import { createI18n } from '../../i18n/i18n';
import { REVIEW_LIST_BOX } from './review-layout';
import { ReviewRowList } from './ReviewRowList';

/** The name of the columns of the tier and of the gap, which the header writes as one, by language. */
const TIER_AND_GAP = {
  en: 'Tier above · Gap',
  fr: 'Palier au-dessus · Écart',
} as const satisfies Record<Language, string>;

/** A resistance item the catalogue knows. */
const BATTLE_VEST: ResistanceItemView = {
  itemId: 1_842,
  className: 'upgrade_regenerating_bullet_shield',
  name: 'Battle Vest',
  imageUrl: 'https://assets.example/battle-vest.png',
  tier: 2,
  protects: 'bullet',
};

/** A second resistance item, so that a list can hold the rows of two items. */
const METAL_SKIN: ResistanceItemView = {
  itemId: 1_001,
  className: 'upgrade_metal_skin',
  name: 'Metal Skin',
  imageUrl: 'https://assets.example/metal-skin.png',
  tier: 3,
  protects: 'bullet',
};

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
 * A row of the review for a point, with no match behind it (so that it has no evidence panel to mix
 * up with the rows).
 *
 * @param subject - The point.
 * @returns The row.
 */
function rowOf(subject: ReviewSubject): ReviewRowData {
  return {
    subject,
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
}

/**
 * The rows of three metrics, in an order that is neither alphabetical nor its reverse.
 *
 * @returns The rows, and the names the list writes them under, in the same order.
 */
function metricRows(): { readonly rows: ReviewRowData[]; readonly names: string[] } {
  return {
    rows: [
      rowOf({ kind: 'metric', key: 'last_hits' }),
      rowOf({ kind: 'metric', key: 'kda' }),
      rowOf({ kind: 'metric', key: 'accuracy' }),
    ],
    names: ['Last hits', 'KDA', 'Accuracy'],
  };
}

/**
 * Name each item of the list that was rendered after the name its text holds.
 *
 * @param names - The names the items may be about.
 * @returns For each item, in the order of the list, the first of the names its text holds, or its
 *   whole text when it holds none.
 */
function namesOfItems(names: readonly string[]): string[] {
  return screen
    .getAllByRole('listitem')
    .map((item) => names.find((name) => item.textContent.includes(name)) ?? item.textContent);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewRowList', () => {
  it('lists the rows in the order given, as the items of one list', async () => {
    const { rows, names } = metricRows();
    await renderIn('en', <ReviewRowList rows={rows} />);

    // The list holds nothing but the items of its rows, in the order given: it does not sort them.
    const list = screen.getByRole('list');
    expect(Array.from(list.children, (child) => child.tagName)).toEqual(rows.map(() => 'LI'));
    expect(namesOfItems(names)).toEqual(names);
  });

  it.each(['en', 'fr'] as const)(
    'puts the header of the columns in the box of the rows, above them, in %s',
    async (language) => {
      await renderIn(language, <ReviewRowList rows={metricRows().rows} />);

      const list = screen.getByRole('list');
      const box = list.parentElement ?? expect.unreachable('The list stands in a box');
      const header = within(box).getByText(TIER_AND_GAP[language]).parentElement;
      // One header for the whole list, hidden from assistive technologies (each figure of a row
      // names itself), in the box the rows are in and before them.
      expect(within(box).getAllByText(TIER_AND_GAP[language])).toHaveLength(1);
      expect(header).toHaveAttribute('aria-hidden', 'true');
      expect(header?.parentElement).toBe(box);
      expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    },
  );

  it('is a box of the theme, and the list in it adds no padding to the rows', async () => {
    await renderIn('en', <ReviewRowList rows={metricRows().rows} />);

    const list = screen.getByRole('list');
    expect(list.parentElement?.className).toBe(REVIEW_LIST_BOX);
    expect(REVIEW_LIST_BOX).toContain('border-border');
    // The header and the rows share the padding of the box, so that their columns line up; padding
    // on the list alone would come out of the name column of the rows and push them off the header.
    expect(list.className).not.toMatch(/(^|\s)p[xytblrse]?-/u);
  });

  it.each(['resistance_minute', 'resistance_rate'] as const)(
    'puts the picture of the item before the name of a %s row',
    async (kind) => {
      await renderIn('en', <ReviewRowList rows={[rowOf({ kind, item: BATTLE_VEST })]} />);

      // The list gives the picture itself: the image of the item, decorative since the name beside it
      // says the item, in the size of the pictures of the summary.
      const [row] = screen.getAllByRole('listitem');
      const picture = row?.querySelector('img') ?? expect.unreachable('The row has a picture');
      expect(picture).toHaveAttribute('src', BATTLE_VEST.imageUrl);
      expect(picture).toHaveAttribute('alt', '');
      expect(picture).toHaveAttribute('width', '24');
      expect(picture).toHaveAttribute('height', '24');
      expect(picture).toHaveClass('size-6', 'object-contain');
      const name = within(row ?? expect.unreachable('A row')).getByText(/^Battle Vest/u);
      expect(picture.compareDocumentPosition(name)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    },
  );

  it('keeps a neutral square before the name of an item with no picture', async () => {
    const unknown: ResistanceItemView = {
      itemId: null,
      className: 'upgrade_colossus',
      name: null,
      imageUrl: null,
      tier: 4,
      protects: 'both',
    };
    await renderIn(
      'en',
      <ReviewRowList rows={[rowOf({ kind: 'resistance_rate', item: unknown })]} />,
    );

    // The names of the rows stay lined up whether or not the catalogue has the picture.
    const [row] = screen.getAllByRole('listitem');
    expect(row?.querySelector('img')).toBeNull();
    const square = row?.querySelector('span[aria-hidden="true"].size-6');
    expect(square).not.toBeNull();
    expect(
      square?.compareDocumentPosition(
        within(row ?? expect.unreachable('A row')).getByText(/^upgrade_colossus/u),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('gives no picture, and no place for one, to a row that is not about an item', async () => {
    const container = await renderIn(
      'en',
      <ReviewRowList
        rows={[
          rowOf({ kind: 'metric', key: 'kda' }),
          rowOf({ kind: 'phase_deaths', phase: 'early' }),
          rowOf({ kind: 'first_resistance_minute' }),
          rowOf({ kind: 'deaths_before_resistance' }),
          rowOf({ kind: 'place', stat: 'netWorth' }),
          rowOf({ kind: 'valve_top_three' }),
          rowOf({ kind: 'valve_top_three_place' }),
        ]}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.size-6')).toBeNull();
  });

  it('shows nothing for no row: a header over an empty list says nothing', async () => {
    const container = await renderIn('en', <ReviewRowList rows={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('gives every row its own key, even for the rows of two items', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rows = [
      rowOf({ kind: 'resistance_minute', item: BATTLE_VEST }),
      rowOf({ kind: 'resistance_minute', item: METAL_SKIN }),
      rowOf({ kind: 'resistance_rate', item: BATTLE_VEST }),
      rowOf({ kind: 'resistance_rate', item: METAL_SKIN }),
      rowOf({ kind: 'deaths_before_resistance' }),
    ];
    await renderIn('en', <ReviewRowList rows={rows} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(rows.length);
    // React warns about two children with the same key, through the console.
    const duplicateKeyWarnings = consoleError.mock.calls.filter((call) =>
      call.some((argument) => typeof argument === 'string' && argument.includes('same key')),
    );
    expect(duplicateKeyWarnings).toEqual([]);
  });
});

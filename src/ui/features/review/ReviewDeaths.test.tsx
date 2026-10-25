/**
 * Tests of the deaths and resistance tab of the review, rendered on its own with deaths built by hand
 * (the deaths the service builds are tested with the service), in English and in French: the deaths of
 * the three phases, the first resistance item with the deaths before it, the twelve resistance items
 * with the minute row before the rate row of each and the picture of each, an item the catalogue does
 * not know, and the sentence that says the item names are unavailable.
 *
 * The rows are the ones of the review, drawn by `ReviewRow` (tested on its own); the tests here are
 * about which rows the tab lists, in which order, under which heading and with which picture. The
 * numbers are synthetic.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Phase } from '../../../core/analysis/phases';
import type { ResistanceKind } from '../../../core/analysis/review/resistance-items';
import type { Language } from '../../../core/settings/language';
import type {
  ResistanceItemReview,
  ResistanceItemView,
  ResistanceReview,
  Review,
  ReviewRow as ReviewRowData,
  ReviewSubject,
} from '../../../services/review-view';
import { createI18n } from '../../i18n/i18n';
import { REVIEW_SECTION_TITLE } from './review-layout';
import { ReviewDeaths } from './ReviewDeaths';

/** The texts of the tab, by language. */
const STRINGS = {
  en: {
    deathsTitle: 'Your deaths by phase',
    resistanceTitle: 'Your resistance items',
    phases: ['Deaths in early', 'Deaths in mid', 'Deaths in late'],
    firstMinute: 'Your first resistance item',
    deathsBefore: 'Deaths before your first resistance item',
    bought: 'Bought',
    boughtAt: 'Bought at',
    unavailable: 'The item names are unavailable for now.',
    tierAndGap: 'Tier above · Gap',
  },
  fr: {
    deathsTitle: 'Tes morts par phase',
    resistanceTitle: 'Tes objets de résistance',
    phases: ['Morts en early', 'Morts en mid', 'Morts en late'],
    firstMinute: 'Ton premier objet de résistance',
    deathsBefore: 'Morts avant ton premier objet de résistance',
    bought: 'Acheté',
    boughtAt: 'Acheté à',
    unavailable: "Les noms des objets sont indisponibles pour l'instant.",
    tierAndGap: 'Palier au-dessus · Écart',
  },
} as const;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** The phases of a match, in the order of the match (which is not the alphabetical order). */
const PHASES = ['early', 'mid', 'late'] as const satisfies readonly Phase[];

/**
 * A resistance item the catalogue knows, with its picture.
 *
 * @param index - Where the item stands in the list of the twelve, which makes its id and its picture.
 * @param className - The class name of the item.
 * @param name - The English name of the item.
 * @param tier - The tier of the item in the shop.
 * @param protects - The damage the item protects against.
 * @returns The item.
 */
function itemOf(
  index: number,
  className: string,
  name: string,
  tier: number,
  protects: ResistanceKind,
): ResistanceItemView {
  return {
    itemId: 1_000 + index,
    className,
    name,
    imageUrl: `https://assets.example/${className}.png`,
    tier,
    protects,
  };
}

/**
 * The twelve resistance items, in the order of the list (by tier, which is not the alphabetical order
 * of their names), named in English as the game names them.
 */
const ITEMS: readonly ResistanceItemView[] = [
  itemOf(0, 'upgrade_regenerating_bullet_shield', 'Battle Vest', 2, 'bullet'),
  itemOf(1, 'upgrade_weapon_shielding', 'Weapon Shielding', 2, 'bullet'),
  itemOf(2, 'upgrade_magic_shield', "Enchanter's Emblem", 2, 'spirit'),
  itemOf(3, 'upgrade_spirit_bubble', 'Spirit Shielding', 2, 'spirit'),
  itemOf(4, 'upgrade_improved_bullet_armor', 'Bullet Resilience', 3, 'bullet'),
  itemOf(5, 'upgrade_metal_skin', 'Metal Skin', 3, 'bullet'),
  itemOf(6, 'upgrade_tech_purge', 'Spirit Resilience', 3, 'spirit'),
  itemOf(7, 'upgrade_reduce_debuff_duration', 'Dispel Magic', 3, 'spirit'),
  itemOf(8, 'upgrade_spellbreaker', 'Spellbreaker', 4, 'spirit'),
  itemOf(9, 'upgrade_absorbing_armor', 'Witchmail', 4, 'spirit'),
  itemOf(10, 'upgrade_auto_cleanse', 'Indomitable', 4, 'both'),
  itemOf(11, 'upgrade_colossus', 'Colossus', 4, 'both'),
];

/** The last of the twelve items as the catalogue has it when it does not know the item at all. */
const UNKNOWN_COLOSSUS: ResistanceItemView = {
  itemId: null,
  className: 'upgrade_colossus',
  name: null,
  imageUrl: null,
  tier: 4,
  protects: 'both',
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
 * A row of the review for a point, with no match behind it (so that it has no evidence panel to
 * mix up with the rows).
 *
 * @param subject - The point.
 * @param overrides - The fields that differ from that row.
 * @returns The row.
 */
function rowOf(subject: ReviewSubject, overrides: Partial<ReviewRowData> = {}): ReviewRowData {
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
    ...overrides,
  };
}

/**
 * The minute the player buys each of the twelve items, by place in the list. They are all different
 * and neither rise nor fall from one item to the next, so that a tab that sorted its rows by minute
 * (or by tier, or by name) would not give the order of the view.
 */
const MINUTES = [14.2, 9.5, 17.8, 11.3, 15.6, 8.4, 19.1, 12.7, 16.2, 10.9, 18.4, 13.5] as const;

/** How often the player buys each of the twelve items, by place in the list: all different, with no trend. */
const RATES = [0.45, 0.8, 0.15, 0.6, 0.3, 0.95, 0.05, 0.7, 0.25, 0.55, 0.85, 0.35] as const;

/** The deaths of the player in each of the three phases, in the order of the match: all different, with no trend. */
const PHASE_DEATHS = [1.2, 2.7, 0.9] as const;

/**
 * The two rows of one resistance item.
 *
 * @param item - The item.
 * @param index - Where the item stands in the list, which gives the minute and the rate of its rows.
 * @returns Its minute row and its rate row.
 */
function itemReviewOf(item: ResistanceItemView, index: number): ResistanceItemReview {
  return {
    item,
    minute: rowOf(
      { kind: 'resistance_minute', item },
      { unit: 'minute', value: MINUTES[index] ?? null, reference: 12.5 },
    ),
    rate: rowOf(
      { kind: 'resistance_rate', item },
      {
        unit: 'rate',
        better: null,
        value: RATES[index] ?? null,
        reference: 0.4,
        progress: { before: 0.4, direction: null },
      },
    ),
  };
}

/**
 * The resistance part of the deaths tab, for the given items.
 *
 * @param items - The items, in the order of the list.
 * @returns The first resistance item, the deaths before it, and the two rows of each item.
 */
function resistanceOf(items: readonly ResistanceItemView[]): ResistanceReview {
  return {
    firstMinute: rowOf({ kind: 'first_resistance_minute' }, { unit: 'minute', value: 11.5 }),
    deathsBefore: rowOf({ kind: 'deaths_before_resistance' }, { unit: 'deaths', value: 2 }),
    items: items.map((item, index) => itemReviewOf(item, index)),
  };
}

/**
 * The deaths tab, with the deaths of the three phases.
 *
 * @param resistance - The resistance part of the tab.
 * @returns The deaths.
 */
function deathsOf(resistance: Review['deaths']['resistance']): Review['deaths'] {
  return {
    phases: PHASES.map((phase, index) =>
      rowOf({ kind: 'phase_deaths', phase }, { value: PHASE_DEATHS[index] ?? null }),
    ),
    resistance,
  };
}

/**
 * The deaths tab when the item catalogue is read: the twelve items, all known.
 *
 * @returns The deaths.
 */
function readyDeaths(): Review['deaths'] {
  return deathsOf({ kind: 'ready', value: resistanceOf(ITEMS) });
}

/**
 * The two rows of every item, in the order the tab lists them: the minute, then the rate.
 *
 * @param items - The items, in the order of the list.
 * @param strings - The texts of the language of the interface.
 * @returns The label of each row.
 */
function itemLabels(
  items: readonly ResistanceItemView[],
  strings: (typeof STRINGS)[Language],
): string[] {
  return items.flatMap((item) => {
    const name = item.name ?? item.className;
    return [`${name} · ${strings.boughtAt}`, `${name} · ${strings.bought}`];
  });
}

/**
 * Find a section of the tab by its name.
 *
 * @param name - The title of the section.
 * @returns The section.
 */
function sectionNamed(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

/**
 * The two lists of the resistance section: the first resistance item with the deaths before it, then
 * the items.
 *
 * @param resistanceTitle - The title of the section.
 * @returns The two lists.
 */
function resistanceLists(resistanceTitle: string): { first: HTMLElement; items: HTMLElement } {
  const lists = within(sectionNamed(resistanceTitle)).getAllByRole('list');
  expect(lists).toHaveLength(2);
  const [first, items] = lists;
  return {
    first: first ?? expect.unreachable('A list'),
    items: items ?? expect.unreachable('A list'),
  };
}

/**
 * Name each row of a list after the label it shows. A label is matched whole, as "Metal Skin · Bought"
 * is also the start of "Metal Skin · Bought at".
 *
 * @param list - The list.
 * @param labels - The labels the rows may show.
 * @returns For each row, in the order of the list, the first of the labels it shows, or its whole text
 *   when it shows none.
 */
function labelsOfRows(list: HTMLElement, labels: readonly string[]): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map(
      (item) =>
        labels.find((label) => within(item).queryByText(label) !== null) ?? item.textContent,
    );
}

describe('ReviewDeaths', () => {
  it.each(LANGUAGES)('shows the deaths of the three phases in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewDeaths deaths={readyDeaths()} />);

    // One row for each phase, in the order of the match and as the view gives them (not sorted).
    const section = sectionNamed(strings.deathsTitle);
    expect(labelsOfRows(within(section).getByRole('list'), strings.phases)).toEqual(strings.phases);
  });

  it.each(LANGUAGES)(
    'shows the deaths before the first resistance item in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderIn(language, <ReviewDeaths deaths={readyDeaths()} />);

      // The first resistance item and the deaths before it stand in a list of their own, above the
      // items: they are about the twelve items as a whole, not about one of them.
      const { first, items } = resistanceLists(strings.resistanceTitle);
      expect(labelsOfRows(first, [strings.firstMinute, strings.deathsBefore])).toEqual([
        strings.firstMinute,
        strings.deathsBefore,
      ]);
      expect(first.compareDocumentPosition(items)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    },
  );

  it.each(LANGUAGES)(
    'lists the 12 resistance items with their pictures in %s',
    async (language) => {
      const strings = STRINGS[language];
      const container = await renderIn(language, <ReviewDeaths deaths={readyDeaths()} />);

      // Two rows for each of the twelve items, each with the picture of its item before its name.
      const labels = itemLabels(ITEMS, strings);
      const { items } = resistanceLists(strings.resistanceTitle);
      const rows = within(items).getAllByRole('listitem');
      expect(labelsOfRows(items, labels)).toEqual(labels);
      expect(rows.map((row) => row.querySelector('img')?.getAttribute('src') ?? null)).toEqual(
        ITEMS.flatMap(({ imageUrl }) => [imageUrl, imageUrl]),
      );

      // The picture is decorative (the name beside it says the item) and comes before the name.
      expect(rows.map((row) => row.querySelector('img')?.getAttribute('alt') ?? null)).toEqual(
        rows.map(() => ''),
      );
      // Its box is known before the file arrives (24 px, the size of the pictures of the summary).
      for (const attribute of ['width', 'height']) {
        expect(
          rows.map((row) => row.querySelector('img')?.getAttribute(attribute) ?? null),
        ).toEqual(rows.map(() => '24'));
      }
      expect(
        rows.map((row, index) =>
          row
            .querySelector('img')
            ?.compareDocumentPosition(within(row).getByText(labels[index] ?? '')),
        ),
      ).toEqual(rows.map(() => Node.DOCUMENT_POSITION_FOLLOWING));

      // The deaths and the two rows about the items as a whole have no picture and no place for one.
      expect(container.querySelectorAll('img')).toHaveLength(2 * ITEMS.length);
      const { first } = resistanceLists(strings.resistanceTitle);
      expect(first.querySelector('.size-6')).toBeNull();
      expect(sectionNamed(strings.deathsTitle).querySelector('.size-6')).toBeNull();
    },
  );

  it.each(LANGUAGES)('lists the minute before the rate for each item in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewDeaths deaths={readyDeaths()} />);

    // Item after item, in the order of the list: the minute row of an item, then its rate row, and
    // only then the next item. The items are not sorted by name, by tier or by minute.
    const { items } = resistanceLists(strings.resistanceTitle);
    const shown = labelsOfRows(items, itemLabels(ITEMS, strings));
    expect(ITEMS.map((_item, index) => shown.slice(2 * index, 2 * index + 2))).toEqual(
      ITEMS.map((item) => itemLabels([item], strings)),
    );
    expect(shown).toHaveLength(2 * ITEMS.length);
  });

  it.each(LANGUAGES)('keeps the order the view gives, whatever it is, in %s', async (language) => {
    const strings = STRINGS[language];
    const reversed = ITEMS.toReversed();
    const deaths = deathsOf({ kind: 'ready', value: resistanceOf(reversed) });
    await renderIn(
      language,
      <ReviewDeaths deaths={{ ...deaths, phases: deaths.phases.toReversed() }} />,
    );

    // Everything in the opposite order of the list: the phases, then the items from the last tier to
    // the first, each with its minute row before its rate row. Nothing is sorted by tier, by name, by
    // minute or by value.
    expect(
      labelsOfRows(within(sectionNamed(strings.deathsTitle)).getByRole('list'), strings.phases),
    ).toEqual(strings.phases.toReversed());
    const labels = itemLabels(reversed, strings);
    expect(labelsOfRows(resistanceLists(strings.resistanceTitle).items, labels)).toEqual(labels);
  });

  it.each(LANGUAGES)(
    'keeps a row for an item the catalogue does not know in %s',
    async (language) => {
      const strings = STRINGS[language];
      const items = [...ITEMS.slice(0, 11), UNKNOWN_COLOSSUS];
      await renderIn(
        language,
        <ReviewDeaths deaths={deathsOf({ kind: 'ready', value: resistanceOf(items) })} />,
      );

      // The item is still listed, by its class name, in its place at the end of the list.
      const list = resistanceLists(strings.resistanceTitle).items;
      const rows = within(list).getAllByRole('listitem');
      const labels = itemLabels(items, strings);
      expect(labelsOfRows(list, labels)).toEqual(labels);
      expect(labels.slice(-2)).toEqual([
        `upgrade_colossus · ${strings.boughtAt}`,
        `upgrade_colossus · ${strings.bought}`,
      ]);
      expect(screen.queryByText(/Colossus/u)).not.toBeInTheDocument();

      // It has no picture, so its rows keep the place of one (a neutral square) and the names line up.
      for (const row of rows.slice(-2)) {
        expect(row.querySelector('img')).toBeNull();
        const square = row.querySelector('span[aria-hidden="true"].size-6');
        expect(square).not.toBeNull();
        expect(
          square?.compareDocumentPosition(within(row).getByText(/^upgrade_colossus · /u)),
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      }
      // The eleven known items keep their pictures.
      expect(list.querySelectorAll('img')).toHaveLength(2 * 11);
    },
  );

  it.each(LANGUAGES)('says when the item names are unavailable in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewDeaths deaths={deathsOf({ kind: 'catalogue_unavailable' })} />);

    // The section keeps its title and says why it has no row, instead of lists with nothing in them.
    const section = sectionNamed(strings.resistanceTitle);
    expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(
      strings.resistanceTitle,
    );
    expect(within(section).getByText(strings.unavailable)).toBeVisible();
    expect(within(section).queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(strings.firstMinute)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.deathsBefore)).not.toBeInTheDocument();

    // The deaths of the phases do not need the catalogue: they are listed all the same.
    expect(
      labelsOfRows(within(sectionNamed(strings.deathsTitle)).getByRole('list'), strings.phases),
    ).toEqual(strings.phases);
    expect(screen.getAllByRole('list')).toHaveLength(1);
  });

  it('does not say the item names are unavailable when they are', async () => {
    await renderIn('en', <ReviewDeaths deaths={readyDeaths()} />);

    expect(screen.queryByText(STRINGS.en.unavailable)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('names each section by its heading, deaths first, in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewDeaths deaths={readyDeaths()} />);

    // The page title is the h1 of the page; the two sections of the tab come right under it.
    expect(
      screen
        .getAllByRole('region')
        .map((section) => within(section).getAllByRole('heading')[0]?.textContent),
    ).toEqual([strings.deathsTitle, strings.resistanceTitle]);
    for (const name of [strings.deathsTitle, strings.resistanceTitle]) {
      const heading = screen.getByRole('heading', { level: 2, name });
      expect(sectionNamed(name)).toContainElement(heading);
      expect(within(sectionNamed(name)).getAllByRole('heading')).toHaveLength(1);
      // The title has the look every section of the review has.
      expect(heading.className).toBe(REVIEW_SECTION_TITLE);
    }
  });

  it('puts one header of the columns above each of the three lists, in the box of the rows', async () => {
    await renderIn('en', <ReviewDeaths deaths={readyDeaths()} />);

    const headers = screen.getAllByText(STRINGS.en.tierAndGap);
    const lists = screen.getAllByRole('list');
    expect(headers).toHaveLength(3);
    expect(lists).toHaveLength(3);
    for (const [index, list] of lists.entries()) {
      const header = headers[index]?.parentElement;
      expect(header).toHaveAttribute('aria-hidden', 'true');
      // The header sits in the same box as the rows, above them, so that their padding is the same
      // and the names stand over their figures.
      expect(header?.parentElement).toBe(list.parentElement);
      expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });
});

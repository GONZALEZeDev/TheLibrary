/**
 * Tests of the deaths and resistance tab of the review, rendered on its own with deaths built by hand
 * (the deaths the service builds are tested with the service), in English and in French: the deaths of
 * the three phases, the first resistance item with the deaths before it, the twelve resistance items
 * with the minute row before the rate row of each and the picture of each, an item the catalogue does
 * not know, the sentence that says the item names are unavailable, and the avoidable deaths: their
 * row with its caption, the matches left out for lack of positions, and the links to the timeline of
 * the matches that had some.
 *
 * The rows are the ones of the review, drawn by `ReviewRow` (tested on its own); the tests here are
 * about which rows the tab lists, in which order, under which heading and with which picture. The
 * numbers are synthetic.
 *
 * @packageDocumentation
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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
  ReviewMatchValue,
  ReviewRow as ReviewRowData,
  ReviewSubject,
} from '../../../services/review-view';
import { testMatchId } from '../../../test/test-data';
import { matchDetailSearchSchema } from '../../app/router';
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
    deathsCaveat:
      "The tier's deaths come from its match counters and can differ by one per match from yours.",
    avoidableTitle: 'Avoidable deaths',
    avoidableCaption: 'Alone, no ally near you, facing at least 2 enemies. No community figure.',
    avoidableMatches: 'Matches with avoidable deaths',
    avoidableLinks: ['{{date}} · 2 avoidable', '{{date}} · 1 avoidable'],
    noPositions: ['1 match without positions, left out', '3 matches without positions, left out'],
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
    deathsCaveat:
      "Les morts du palier viennent des compteurs de ses parties et peuvent différer d'une par partie des tiennes.",
    avoidableTitle: 'Morts évitables',
    avoidableCaption:
      'Seul, sans allié près de toi, face à au moins 2 ennemis. Pas de chiffre de la communauté.',
    avoidableMatches: 'Parties avec des morts évitables',
    avoidableLinks: ['{{date}} · 2 évitables', '{{date}} · 1 évitable'],
    noPositions: ['1 partie sans positions, mise à part', '3 parties sans positions, mises à part'],
  },
} as const;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** How many matches the review covers in the tests: all of them have positions, unless a test says otherwise. */
const RECENT_COUNT = 18;

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
 * Render an element with the i18next instance of one language, as the page of the review route of a
 * router of its own that also has the route of a match, to see where the links of the tab lead.
 *
 * @param language - The language of the interface.
 * @param element - The element to render.
 * @returns The router, to read the address of a link.
 */
async function renderInRouter(language: Language, element: ReactElement) {
  const i18n = await createI18n(language);
  const rootRoute = createRootRoute();
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: () => element,
  });
  const matchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    validateSearch: matchDetailSearchSchema,
  });
  const history = createMemoryHistory({ initialEntries: ['/review'] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([reviewRoute, matchRoute]),
    history,
  });
  await router.load();
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  await screen.findAllByRole('region');
  return router;
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
    gapWithinNoise: false,
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
    avoidable: rowOf({ kind: 'avoidable_deaths' }),
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

/** Start of the matches of the avoidable deaths (Unix seconds): a day apart, the most recent first. */
const MATCH_STARTS = [1_760_011_200, 1_759_924_800, 1_759_838_400] as const;

/** An hour after the first match: the same day as it (at noon UTC, whatever the time zone). */
const SAME_DAY_START = 1_760_011_200 + 3_600;

/**
 * The value of the avoidable deaths in a match.
 *
 * @param index - Where the match stands in the row, most recent first, which gives its id and start.
 * @param value - Its avoidable deaths.
 * @param startTime - Its start (Unix seconds); by default, the one of its place in the row.
 * @returns The match with its value.
 */
function avoidableMatch(
  index: number,
  value: number,
  startTime: number = MATCH_STARTS[index] ?? 0,
): ReviewMatchValue {
  return {
    matchId: testMatchId(100_000_001 + index),
    startTime,
    value,
    mark: null,
  };
}

/**
 * The deaths tab with the given matches in its avoidable deaths row.
 *
 * @param matches - The matches that have the positions, most recent first.
 * @returns The deaths, whose row counts those matches.
 */
function deathsWithAvoidable(matches: readonly ReviewMatchValue[]): Review['deaths'] {
  return {
    ...readyDeaths(),
    avoidable: rowOf({ kind: 'avoidable_deaths' }, { count: matches.length, matches }),
  };
}

/**
 * How the start of a match is written in a link: its short date and its time.
 *
 * @param language - The language of the interface.
 * @param startTime - The start of the match, in Unix seconds.
 * @returns The short date and time.
 */
function dateOf(language: Language, startTime: number): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    startTime * 1_000,
  );
}

describe('ReviewDeaths', () => {
  it.each(LANGUAGES)('shows the deaths of the three phases in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

    // One row for each phase, in the order of the match and as the view gives them (not sorted).
    const section = sectionNamed(strings.deathsTitle);
    expect(labelsOfRows(within(section).getByRole('list'), strings.phases)).toEqual(strings.phases);
  });

  it.each(LANGUAGES)(
    'says under the heading of the deaths that the tier counts them otherwise, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderIn(language, <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

      // The sentence stands between the heading and the rows, in the muted text of a remark.
      const section = sectionNamed(strings.deathsTitle);
      const caveat = within(section).getByText(strings.deathsCaveat);
      expect(caveat).toHaveClass('text-fg-muted');
      const heading = within(section).getByRole('heading', { name: strings.deathsTitle });
      expect(heading.compareDocumentPosition(caveat)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(caveat.compareDocumentPosition(within(section).getByRole('list'))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      // It is about the deaths of the phases only, not about the resistance items.
      expect(
        within(sectionNamed(strings.resistanceTitle)).queryByText(strings.deathsCaveat),
      ).toBeNull();
    },
  );

  it.each(LANGUAGES)(
    'shows the deaths before the first resistance item in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderIn(language, <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

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
      const container = await renderIn(
        language,
        <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />,
      );

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
    await renderIn(language, <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

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
      <ReviewDeaths
        recentCount={RECENT_COUNT}
        deaths={{ ...deaths, phases: deaths.phases.toReversed() }}
      />,
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
        <ReviewDeaths
          recentCount={RECENT_COUNT}
          deaths={deathsOf({ kind: 'ready', value: resistanceOf(items) })}
        />,
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
    await renderIn(
      language,
      <ReviewDeaths
        recentCount={RECENT_COUNT}
        deaths={deathsOf({ kind: 'catalogue_unavailable' })}
      />,
    );

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
    // The lists left are those of the phases and of the avoidable deaths.
    expect(screen.getAllByRole('list')).toHaveLength(2);
  });

  it('does not say the item names are unavailable when they are', async () => {
    await renderIn('en', <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

    expect(screen.queryByText(STRINGS.en.unavailable)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('names each section by its heading, deaths first, in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

    // The page title is the h1 of the page; the three sections of the tab come right under it.
    expect(
      screen
        .getAllByRole('region')
        .map((section) => within(section).getAllByRole('heading')[0]?.textContent),
    ).toEqual([strings.deathsTitle, strings.avoidableTitle, strings.resistanceTitle]);
    for (const name of [strings.deathsTitle, strings.avoidableTitle, strings.resistanceTitle]) {
      const heading = screen.getByRole('heading', { level: 2, name });
      expect(sectionNamed(name)).toContainElement(heading);
      expect(within(sectionNamed(name)).getAllByRole('heading')).toHaveLength(1);
      // The title has the look every section of the review has.
      expect(heading.className).toBe(REVIEW_SECTION_TITLE);
    }
  });

  it('puts one header of the columns above each of the four lists, in the box of the rows', async () => {
    await renderIn('en', <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

    const headers = screen.getAllByText(STRINGS.en.tierAndGap);
    const lists = screen.getAllByRole('list');
    expect(headers).toHaveLength(4);
    expect(lists).toHaveLength(4);
    for (const [index, list] of lists.entries()) {
      const header = headers[index]?.parentElement;
      expect(header).toHaveAttribute('aria-hidden', 'true');
      // The header sits in the same box as the rows, above them, so that their padding is the same
      // and the names stand over their figures.
      expect(header?.parentElement).toBe(list.parentElement);
      expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it.each(LANGUAGES)('shows the avoidable deaths row with its caption in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewDeaths recentCount={RECENT_COUNT} deaths={readyDeaths()} />);

    // The section comes after the phases and before the resistance: title, caption, then the row.
    const section = sectionNamed(strings.avoidableTitle);
    const heading = within(section).getByRole('heading', { level: 2 });
    const caption = within(section).getByText(strings.avoidableCaption);
    const list = within(section).getByRole('list');
    expect(caption).toHaveClass('text-fg-muted');
    expect(heading.compareDocumentPosition(caption)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(caption.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // One row, the avoidable deaths of the view, and no line about matches left out or to link.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText(strings.avoidableTitle)).toBeVisible();
    expect(within(section).queryByText(strings.avoidableMatches)).toBeNull();
    expect(within(section).queryByText(/without positions|sans positions/u)).toBeNull();
  });

  it.each(LANGUAGES)(
    'links each match with avoidable deaths to its timeline in %s',
    async (language) => {
      const strings = STRINGS[language];
      // The middle match had positions but no avoidable death: it has no link.
      const matches = [avoidableMatch(0, 2), avoidableMatch(1, 0), avoidableMatch(2, 1)];
      const router = await renderInRouter(
        language,
        <ReviewDeaths recentCount={matches.length} deaths={deathsWithAvoidable(matches)} />,
      );

      // A list named by its title, under the row, with a link for each match that had some: most
      // recent first, the short date of the match and its number of avoidable deaths.
      const section = sectionNamed(strings.avoidableTitle);
      const list = within(section).getByRole('list', { name: strings.avoidableMatches });
      const links = within(list).getAllByRole('link');
      const [first, second] = strings.avoidableLinks;
      expect(links.map((link) => link.textContent)).toEqual([
        first.replace('{{date}}', dateOf(language, MATCH_STARTS[0])),
        second.replace('{{date}}', dateOf(language, MATCH_STARTS[2])),
      ]);

      // Each opens the timeline tab of its match.
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '/matches/100000001?tab=timeline',
        '/matches/100000003?tab=timeline',
      ]);

      // The link leaves the review for a new entry of the history (no `replace`): back returns to it.
      await userEvent.click(links[0] ?? expect.unreachable('A link'));
      expect(router.history.location.pathname).toBe('/matches/100000001');
      expect(router.history.location.search).toBe('?tab=timeline');
      router.history.back();
      expect(router.history.location.pathname).toBe('/review');
    },
  );

  it.each(LANGUAGES)(
    'tells apart two matches of one day with the same avoidable deaths in %s',
    async (language) => {
      // Same day, same count: only the time of the match tells the two links apart.
      const matches = [avoidableMatch(0, 2, SAME_DAY_START), avoidableMatch(1, 2, MATCH_STARTS[0])];
      await renderInRouter(
        language,
        <ReviewDeaths recentCount={matches.length} deaths={deathsWithAvoidable(matches)} />,
      );

      const links = within(sectionNamed(STRINGS[language].avoidableTitle)).getAllByRole('link');
      const [template] = STRINGS[language].avoidableLinks;
      const names = links.map((link) => link.textContent);
      expect(names).toEqual([
        template.replace('{{date}}', dateOf(language, SAME_DAY_START)),
        template.replace('{{date}}', dateOf(language, MATCH_STARTS[0])),
      ]);
      expect(new Set(names).size).toBe(2);
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '/matches/100000001?tab=timeline',
        '/matches/100000002?tab=timeline',
      ]);
    },
  );

  it.each(LANGUAGES.flatMap((language) => [0, 1].map((case_) => [language, case_] as const)))(
    'says how many matches had no positions in %s (case %i)',
    async (language, case_) => {
      const strings = STRINGS[language];
      // The row counts two matches; the review covers three or five: one or three are left out.
      const deaths = deathsWithAvoidable([avoidableMatch(0, 1), avoidableMatch(1, 0)]);
      await renderInRouter(
        language,
        <ReviewDeaths recentCount={case_ === 0 ? 3 : 5} deaths={deaths} />,
      );

      // The line stands under the row of the avoidable deaths, as a remark.
      const section = sectionNamed(strings.avoidableTitle);
      const line = within(section).getByText(strings.noPositions[case_] ?? '');
      expect(line).toHaveClass('text-fg-muted');
      expect(within(section).getAllByRole('list')[0]?.compareDocumentPosition(line)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    },
  );

  it('says nothing about positions when every match has them', async () => {
    const deaths = deathsWithAvoidable([avoidableMatch(0, 1), avoidableMatch(1, 0)]);
    await renderInRouter('en', <ReviewDeaths recentCount={2} deaths={deaths} />);

    expect(screen.queryByText(/without positions/u)).toBeNull();
  });

  it.each(LANGUAGES)(
    'hides the list when no match had an avoidable death in %s',
    async (language) => {
      const strings = STRINGS[language];
      // Matches with positions, none with an avoidable death.
      const deaths = deathsWithAvoidable([avoidableMatch(0, 0), avoidableMatch(1, 0)]);
      await renderIn(language, <ReviewDeaths recentCount={2} deaths={deaths} />);

      // The row stays, the title and the list of links go.
      const section = sectionNamed(strings.avoidableTitle);
      expect(within(section).getAllByRole('list')).toHaveLength(1);
      expect(within(section).queryByText(strings.avoidableMatches)).toBeNull();
      expect(within(section).queryByRole('link')).toBeNull();
    },
  );
});

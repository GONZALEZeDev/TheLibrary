/**
 * Tests of the players tab of the review, rendered on its own with places built by hand (the places the
 * service builds are tested with the service), in English and in French: the mean place of the player
 * among the 12 players for each of the five figures of the scoreboard, how often they were in Valve's
 * top three, their average place in it, the order of the rows, and the heading and header of the tab.
 *
 * The rows are the ones of the review, drawn by `ReviewRow` (tested on its own); the tests here are
 * about which rows the tab lists, in which order and under which heading. The numbers are synthetic and
 * chosen so that each one is told from the others.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { PlaceStat } from '../../../core/match-detail/scoreboard';
import type { Language } from '../../../core/settings/language';
import type {
  Review,
  ReviewRow as ReviewRowData,
  ReviewSubject,
} from '../../../services/review-view';
import { createI18n } from '../../i18n/i18n';
import { REVIEW_SECTION_TITLE } from './review-layout';
import { ReviewPlayers } from './ReviewPlayers';

/** The texts of the tab, by language. */
const STRINGS = {
  en: {
    title: 'Your places among the 12 players',
    places: [
      'Place in Souls',
      'Place in Damage to heroes',
      'Place in Damage to objectives',
      'Place in Healing and barriers',
      'Place in Last hits',
    ],
    placeValues: ['4.2 of 12', '3.5 of 12', '7 of 12', '6.4 of 12', '5.1 of 12'],
    topThree: "In Valve's top three",
    topThreeRate: /^45%$/u,
    topThreePlace: "Average place in Valve's top three",
    topThreePlaceValue: '1.8 of 3',
    you: 'You',
    tierAndGap: 'Tier above · Gap',
    twentyMatches: '20 matches',
    nineMatches: '9 matches',
    oneMatch: '1 match',
  },
  fr: {
    title: 'Tes places parmi les 12 joueurs',
    places: [
      'Place en Âmes',
      'Place en Dégâts aux héros',
      'Place en Dégâts aux objectifs',
      'Place en Soins et barrières',
      'Place en Last hits',
    ],
    placeValues: ['4,2 sur 12', '3,5 sur 12', '7 sur 12', '6,4 sur 12', '5,1 sur 12'],
    topThree: 'Dans le top 3 de Valve',
    topThreeRate: /^45\s%$/u,
    topThreePlace: 'Place moyenne dans le top 3 de Valve',
    topThreePlaceValue: '1,8 sur 3',
    you: 'Toi',
    tierAndGap: 'Palier au-dessus · Écart',
    twentyMatches: '20 parties',
    nineMatches: '9 parties',
    oneMatch: '1 partie',
  },
} as const;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** The five figures of the scoreboard a place is taken on, in the order the review lists them. */
const STATS = [
  'netWorth',
  'heroDamage',
  'objectiveDamage',
  'support',
  'lastHits',
] as const satisfies readonly PlaceStat[];

/** The mean place of the player on each figure of {@link STATS}, all different. */
const MEAN_PLACES = [4.2, 3.5, 7, 6.4, 5.1] as const;

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
 * A row of the review for a point of the players tab, with no match behind it (so that it has no
 * evidence panel to mix up with the rows) and no figure of the tier above.
 *
 * @param subject - The point.
 * @param overrides - The fields that differ from that row.
 * @returns The row.
 */
function rowOf(subject: ReviewSubject, overrides: Partial<ReviewRowData> = {}): ReviewRowData {
  return {
    subject,
    unit: 'place',
    better: 'lower',
    value: 5,
    count: 18,
    comparedValue: null,
    reference: null,
    difference: null,
    gapWithinNoise: false,
    weak: 0,
    strong: 0,
    marked: 0,
    side: null,
    progress: { before: null, direction: null },
    matches: [],
    ...overrides,
  };
}

/**
 * The players tab of the review: the five places, how often the player was in Valve's top three, and
 * their average place in it.
 *
 * @returns The players.
 */
function playersOf(): Review['players'] {
  return {
    places: STATS.map((stat, index) =>
      rowOf({ kind: 'place', stat }, { value: MEAN_PLACES[index] ?? null }),
    ),
    topThree: rowOf(
      { kind: 'valve_top_three' },
      { unit: 'rate', better: 'higher', value: 0.45, count: 20 },
    ),
    topThreePlace: rowOf(
      { kind: 'valve_top_three_place' },
      { unit: 'top_three_place', value: 1.8, count: 9 },
    ),
  };
}

/**
 * Find the row of a point by the name it shows.
 *
 * @param label - The name of the point.
 * @returns The row.
 */
function rowNamed(label: string): HTMLElement {
  return (
    screen.getAllByRole('listitem').find((item) => within(item).queryByText(label) !== null) ??
    expect.unreachable(`No row named ${label}`)
  );
}

/**
 * Read the player's figure in a row: each figure carries the name of its column for assistive
 * technologies, in front of it.
 *
 * @param row - The row.
 * @param column - The name of the column of the player's figure.
 * @returns The figure, without the name of the column.
 */
function figureOf(row: HTMLElement, column: string): string {
  const name = within(row).getByText(column);
  return (name.parentElement?.textContent ?? '').replace(name.textContent, '').trim();
}

/**
 * Name each row of the list after the name it shows.
 *
 * @param labels - The names the rows may show.
 * @returns For each row, in the order of the list, the first of the names it shows, or its whole text
 *   when it shows none.
 */
function namesOfRows(labels: readonly string[]): string[] {
  return screen
    .getAllByRole('listitem')
    .map(
      (item) =>
        labels.find((label) => within(item).queryByText(label) !== null) ?? item.textContent,
    );
}

describe('ReviewPlayers', () => {
  it.each(LANGUAGES)('shows the mean place for each stat in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewPlayers players={playersOf()} />);

    // One row for each of the five figures, with the mean place of the player among the 12.
    expect(strings.places.map((label) => figureOf(rowNamed(label), strings.you))).toEqual(
      strings.placeValues,
    );
  });

  it.each(LANGUAGES)(
    "shows how often the player was in Valve's top three in %s",
    async (language) => {
      const strings = STRINGS[language];
      await renderIn(language, <ReviewPlayers players={playersOf()} />);

      // The rate is a share of the matches, written as a percentage.
      const row = rowNamed(strings.topThree);
      expect(figureOf(row, strings.you)).toMatch(strings.topThreeRate);
      expect(within(row).getByText(strings.twentyMatches)).toBeVisible();
    },
  );

  it.each(LANGUAGES)("shows the average place in Valve's top three in %s", async (language) => {
    const strings = STRINGS[language];
    await renderIn(language, <ReviewPlayers players={playersOf()} />);

    // It is a place out of 3, over the matches the player was in the top three.
    const row = rowNamed(strings.topThreePlace);
    expect(figureOf(row, strings.you)).toBe(strings.topThreePlaceValue);
    expect(within(row).getByText(strings.nineMatches)).toBeVisible();
  });

  it.each(LANGUAGES)(
    'lists the five places, then the top three, then the average place, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderIn(language, <ReviewPlayers players={playersOf()} />);

      // One list holds them all, in the order of the view: the places are not sorted by their value.
      const names = [...strings.places, strings.topThree, strings.topThreePlace];
      expect(screen.getAllByRole('list')).toHaveLength(1);
      expect(namesOfRows(names)).toEqual(names);
    },
  );

  it('keeps the order the view gives, whatever it is', async () => {
    const players = playersOf();
    await renderIn(
      'en',
      <ReviewPlayers players={{ ...players, places: players.places.toReversed() }} />,
    );

    const { places, topThree, topThreePlace } = STRINGS.en;
    expect(namesOfRows([...places, topThree, topThreePlace])).toEqual([
      ...places.toReversed(),
      topThree,
      topThreePlace,
    ]);
  });

  it('lists the top three rows when no place is known', async () => {
    const players = playersOf();
    await renderIn('en', <ReviewPlayers players={{ ...players, places: [] }} />);

    // The two rows about Valve's top three do not depend on the places among the players.
    const { topThree, topThreePlace } = STRINGS.en;
    expect(namesOfRows([topThree, topThreePlace])).toEqual([topThree, topThreePlace]);
  });

  it('shows a dash for a place the player has no figure for', async () => {
    const players = playersOf();
    const [first, ...others] = players.places;
    await renderIn(
      'en',
      <ReviewPlayers
        players={{
          ...players,
          places: [
            ...(first === undefined ? [] : [{ ...first, value: null, count: 1 }]),
            ...others,
          ],
        }}
      />,
    );

    // Too few matches give no figure: a dash and the number of matches counted, never a made-up place.
    const row = rowNamed(STRINGS.en.places[0]);
    expect(figureOf(row, STRINGS.en.you)).toBe('—');
    expect(within(row).getByText(STRINGS.en.oneMatch)).toBeVisible();
  });

  it.each(LANGUAGES)(
    'names the section by an h2, with no other heading, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderIn(language, <ReviewPlayers players={playersOf()} />);

      // The page title is the h1 of the page and the tab panel is named by its tab: the section comes
      // right under them.
      const section = screen.getByRole('region', { name: strings.title });
      const heading = screen.getByRole('heading', { level: 2, name: strings.title });
      expect(section).toContainElement(heading);
      expect(screen.getAllByRole('heading')).toHaveLength(1);
      // The title has the look every section of the review has.
      expect(heading.className).toBe(REVIEW_SECTION_TITLE);
      expect(within(section).getByRole('list')).toBeInTheDocument();
    },
  );

  it.each(LANGUAGES)('puts the header of the columns above the rows in %s', async (language) => {
    await renderIn(language, <ReviewPlayers players={playersOf()} />);

    const header = screen.getByText(STRINGS[language].tierAndGap).parentElement;
    const list = screen.getByRole('list');
    expect(header).toHaveAttribute('aria-hidden', 'true');
    // The header sits in the same box as the rows, above them, so that their padding is the same and
    // the names stand over their figures.
    expect(header?.parentElement).toBe(list.parentElement);
    expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows no picture before the names', async () => {
    const container = await renderIn('en', <ReviewPlayers players={playersOf()} />);

    // A place among the players is not about an item: no picture, and no place left for one.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.size-6')).toBeNull();
  });
});

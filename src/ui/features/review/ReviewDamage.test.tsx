/**
 * Tests of the damage tab of the review, rendered on its own with damage shares built by hand (the
 * shares the service builds are tested with the service), in English and in French: each source with
 * its share now and before, the kind and the picture of a source, the bar, the number of matches a
 * source was used in, the header of the columns, the sentence that says the item names are
 * unavailable, and the absence of any weak or strong mark.
 *
 * The numbers are synthetic and chosen so that each one is told from the others in the page.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { DamageShareRow } from '../../../core/analysis/review/damage-review';
import type { Language } from '../../../core/settings/language';
import type { Review, ReviewWindow } from '../../../services/review-view';
import { createI18n } from '../../i18n/i18n';
import { ReviewDamage } from './ReviewDamage';
import { REVIEW_LIST_BOX, REVIEW_SECTION_TITLE } from './review-layout';

/** The texts of the tab, by language. */
const STRINGS = {
  en: {
    title: 'Your damage to heroes by source',
    now: 'Last 20',
    before: '20 before',
    nowOne: 'Last match',
    beforeOne: 'Match before',
    beforeZero: 'No match before',
    source: 'Source',
    kinds: { weapon: 'Weapon', melee: 'Melee', item: 'Item' },
    appearsOne: 'In 1 match',
    appearsMany: (count: number) => `In ${String(count)} matches`,
    unavailable: 'The item names are unavailable for now.',
    empty: 'No damage to heroes by source in these matches.',
  },
  fr: {
    title: 'Tes dégâts aux héros par source',
    now: '20 dernières',
    before: "20 d'avant",
    nowOne: 'Dernière partie',
    beforeOne: "Partie d'avant",
    beforeZero: 'Aucune partie avant',
    source: 'Source',
    kinds: { weapon: 'Arme', melee: 'Mêlée', item: 'Objet' },
    appearsOne: 'Dans 1 partie',
    appearsMany: (count: number) => `Dans ${String(count)} parties`,
    unavailable: "Les noms des objets sont indisponibles pour l'instant.",
    empty: 'Aucun dégât aux héros par source dans ces parties.',
  },
} as const;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** Where the images of the catalogues live: the one origin the app lets the page load pictures from. */
const IMAGE_ORIGIN = 'https://assets-bucket.deadlock-api.com/';

/** The dash that stands in place of a share that is not known. */
const DASH = '—';

/** The classes of the colours and tints that say a point is weak or strong. */
const VERDICT_CLASSES =
  '[class*="bg-win"], [class*="bg-loss"], [class*="text-win"], [class*="text-loss"]';

/** The window of the last 20 matches. */
const RECENT: ReviewWindow = {
  count: 20,
  firstStartTime: 1_700_000_000,
  lastStartTime: 1_700_900_000,
};

/** The window of the 20 matches before them. */
const BEFORE: ReviewWindow = {
  count: 20,
  firstStartTime: 1_699_000_000,
  lastStartTime: 1_699_900_000,
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
 * The line of a damage source: an ability that dealt a tenth of the damage now, and a bit more
 * before, unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The line.
 */
function sourceOf(overrides: Partial<DamageShareRow> = {}): DamageShareRow {
  return {
    className: 'citadel_ability_rallying_charge',
    kind: 'ability',
    itemId: 2_000_001,
    name: 'Rallying Charge',
    imageUrl: `${IMAGE_ORIGIN}abilities/rallying-charge.webp`,
    shareNow: 0.1,
    shareBefore: 0.12,
    appearsNow: 18,
    appearsBefore: 15,
    ...overrides,
  };
}

/**
 * Five sources of the four kinds, in the order the service gives them (the largest share now first).
 * Their shares add up to 100 % in each window, and no two of them are alike, now, before or in the
 * matches they appear in.
 *
 * @returns The lines.
 */
function sources(): DamageShareRow[] {
  return [
    sourceOf({
      className: 'citadel_weapon_primary',
      kind: 'weapon',
      itemId: 2_000_010,
      name: 'Express Shot',
      imageUrl: `${IMAGE_ORIGIN}weapons/express-shot.webp`,
      shareNow: 0.46,
      shareBefore: 0.41,
      appearsNow: 20,
      appearsBefore: 19,
    }),
    sourceOf({
      className: 'citadel_ability_bookwyrm',
      itemId: 2_000_011,
      name: 'Bookwyrm',
      imageUrl: `${IMAGE_ORIGIN}abilities/bookwyrm.webp`,
      shareNow: 0.3,
      shareBefore: 0.35,
      appearsNow: 17,
      appearsBefore: 18,
    }),
    sourceOf({
      className: 'upgrade_mystic_burst',
      kind: 'item',
      itemId: 2_000_012,
      name: 'Mystic Burst',
      imageUrl: `${IMAGE_ORIGIN}items/mystic-burst.webp`,
      shareNow: 0.12,
      shareBefore: 0.06,
      appearsNow: 9,
      appearsBefore: 4,
    }),
    // The melee attack has no picture in the catalogue: a neutral square takes its place.
    sourceOf({
      className: 'citadel_weapon_melee',
      kind: 'melee',
      itemId: null,
      name: 'Heavy Melee',
      imageUrl: null,
      shareNow: 0.07,
      shareBefore: 0.1,
      appearsNow: 14,
      appearsBefore: 16,
    }),
    sourceOf({ shareNow: 0.05, shareBefore: 0.08, appearsNow: 6, appearsBefore: 12 }),
  ];
}

/** The names of the sources of {@link sources}, in the order of that list. */
const SOURCE_NAMES = sources().map(({ name }) => name);

/**
 * The damage of the review when the item catalogue is read.
 *
 * @param rows - The lines.
 * @returns The damage.
 */
function readyDamage(rows: readonly DamageShareRow[]): Review['damage'] {
  return { kind: 'ready', value: rows };
}

/**
 * Render the tab with the given sources and the two windows of 20 matches.
 *
 * @param language - The language of the interface.
 * @param rows - The sources, in the order the view gives them.
 * @returns The container the tab was rendered in.
 */
async function renderSources(
  language: Language,
  rows: readonly DamageShareRow[] = sources(),
): Promise<HTMLElement> {
  return renderIn(
    language,
    <ReviewDamage damage={readyDamage(rows)} recent={RECENT} before={BEFORE} />,
  );
}

/**
 * Find the section of the tab by its title.
 *
 * @param title - The title of the section.
 * @returns The section.
 */
function sectionNamed(title: string): HTMLElement {
  return screen.getByRole('region', { name: title });
}

/**
 * The rows of the list of the section.
 *
 * @param title - The title of the section.
 * @returns The items of the list, in the order of the page.
 */
function rowsOf(title: string): HTMLElement[] {
  return within(within(sectionNamed(title)).getByRole('list')).getAllByRole('listitem');
}

/**
 * Find the row of a source by its name.
 *
 * @param title - The title of the section.
 * @param name - The name of the source.
 * @returns The row.
 */
function rowNamed(title: string, name: string): HTMLElement {
  return (
    rowsOf(title).find((row) => within(row).queryByText(name) !== null) ??
    expect.unreachable(`No row for ${name}`)
  );
}

/**
 * Name each row after the source it shows.
 *
 * @param rows - The rows of the list.
 * @returns For each row, in the order of the list, the first of the names of the sources it shows,
 *   or its whole text when it shows none.
 */
function namesOfRows(rows: readonly HTMLElement[]): string[] {
  return rows.map(
    (row) => SOURCE_NAMES.find((name) => within(row).queryByText(name) !== null) ?? row.textContent,
  );
}

/**
 * Read a figure of a row by the name of its column: each figure carries the name of its column for
 * assistive technologies, in front of it.
 *
 * @param row - The row.
 * @param column - The name of the column.
 * @returns The figure, without the name of the column.
 */
function figureUnder(row: HTMLElement, column: string): string {
  const name = within(row).getByText(column);
  return (name.parentElement?.textContent ?? '').replace(name.textContent, '').trim();
}

describe('ReviewDamage', () => {
  it("shows each source's share now and before", async () => {
    const strings = STRINGS.en;
    await renderSources('en');

    expect(
      SOURCE_NAMES.map((name) => {
        const row = rowNamed(strings.title, name);
        return {
          name,
          now: figureUnder(row, strings.now),
          before: figureUnder(row, strings.before),
        };
      }),
    ).toEqual([
      { name: 'Express Shot', now: '46%', before: '41%' },
      { name: 'Bookwyrm', now: '30%', before: '35%' },
      { name: 'Mystic Burst', now: '12%', before: '6%' },
      { name: 'Heavy Melee', now: '7%', before: '10%' },
      { name: 'Rallying Charge', now: '5%', before: '8%' },
    ]);
  });

  it('writes the shares with the conventions of French', async () => {
    const strings = STRINGS.fr;
    await renderSources('fr');

    // French puts a space before the percent sign.
    const row = rowNamed(strings.title, 'Express Shot');
    expect(figureUnder(row, strings.now)).toMatch(/^46\s%$/u);
    expect(figureUnder(row, strings.before)).toMatch(/^41\s%$/u);
  });

  it('lists the sources in the order the view gives, whatever it is', async () => {
    await renderSources('en', sources().toReversed());

    // The tab never sorts: the service decides the order, and a source with the smaller share can
    // come first.
    expect(namesOfRows(rowsOf(STRINGS.en.title))).toEqual(SOURCE_NAMES.toReversed());
  });

  it.each(LANGUAGES)('says how many matches each source was used in, in %s', async (language) => {
    const strings = STRINGS[language];
    await renderSources(language);

    // The matches of the last window only: the matches before are not counted here.
    expect(
      rowsOf(strings.title).map((row, index) => {
        const appearsNow = sources()[index]?.appearsNow ?? 0;
        return within(row).queryByText(strings.appearsMany(appearsNow))?.textContent ?? null;
      }),
    ).toEqual(sources().map(({ appearsNow }) => strings.appearsMany(appearsNow)));
  });

  it.each(LANGUAGES)('writes one match in the singular in %s', async (language) => {
    const strings = STRINGS[language];
    await renderSources(language, [
      sourceOf({ appearsNow: 1 }),
      sourceOf({ className: 'citadel_ability_bookwyrm', name: 'Bookwyrm', appearsNow: 17 }),
    ]);

    // One match is written in the singular, many in the plural.
    const [first, second] = rowsOf(strings.title);
    expect(
      within(first ?? expect.unreachable('A row')).getByText(strings.appearsOne),
    ).toBeVisible();
    expect(
      within(second ?? expect.unreachable('A row')).getByText(strings.appearsMany(17)),
    ).toBeVisible();
    expect(screen.queryByText(strings.appearsMany(1))).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('names the two windows in the header, in %s', async (language) => {
    const strings = STRINGS[language];
    await renderSources(language);

    // The header is for the eye: it names the source, the last matches and the matches before.
    const header = screen.getByText(strings.source).parentElement ?? expect.unreachable('A header');
    expect(header).toHaveAttribute('aria-hidden', 'true');
    expect(within(header).getByText(strings.now)).toBeVisible();
    expect(within(header).getByText(strings.before)).toBeVisible();
  });

  it.each(LANGUAGES)('writes a window of one match in the singular in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(
      language,
      <ReviewDamage
        damage={readyDamage(sources())}
        recent={{ ...RECENT, count: 1 }}
        before={{ ...BEFORE, count: 1 }}
      />,
    );

    // The columns are named for one match, in the header and in the row that carries them again.
    const header = screen.getByText(strings.source).parentElement ?? expect.unreachable('A header');
    expect(within(header).getByText(strings.nowOne)).toBeVisible();
    expect(within(header).getByText(strings.beforeOne)).toBeVisible();
    const row = rowNamed(strings.title, 'Express Shot');
    expect(within(row).getByText(strings.nowOne)).toBeInTheDocument();
    expect(within(row).getByText(strings.beforeOne)).toBeInTheDocument();
    expect(screen.queryByText(strings.now)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('names a window with no match before as such in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(
      language,
      <ReviewDamage
        damage={readyDamage(sources().map((source) => ({ ...source, shareBefore: null })))}
        recent={RECENT}
        before={{ count: 0, firstStartTime: null, lastStartTime: null }}
      />,
    );

    // With no match before, the column says so in the header and in each figure's own name, rather
    // than counting "0 before" (French would even write it in the singular); nothing is compared, so
    // the column is dashes.
    const header = screen.getByText(strings.source).parentElement ?? expect.unreachable('A header');
    expect(within(header).getByText(strings.beforeZero)).toBeVisible();
    const rows = rowsOf(strings.title);
    expect(rows.map((row) => figureUnder(row, strings.beforeZero))).toEqual(rows.map(() => DASH));
    expect(screen.queryByText(strings.before)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.beforeOne)).not.toBeInTheDocument();
    // The shares now are shown all the same.
    expect(figureUnder(rowNamed(strings.title, 'Express Shot'), strings.now)).toMatch(/^46\s?%$/u);
  });

  it('shows a dash for a share before when the matches before dealt no damage', async () => {
    const strings = STRINGS.en;
    await renderSources(
      'en',
      sources().map((source) => ({ ...source, shareBefore: null })),
    );

    // There is no share to compare with: a dash, never a 0 %, and the shares now are shown all the same.
    const rows = rowsOf(strings.title);
    expect(rows.map((row) => figureUnder(row, strings.before))).toEqual(rows.map(() => DASH));
    expect(rows.map((row) => figureUnder(row, strings.now))).toEqual([
      '46%',
      '30%',
      '12%',
      '7%',
      '5%',
    ]);
  });

  it('shows a source the player stopped using with a share of zero now', async () => {
    const strings = STRINGS.en;
    await renderSources('en', [sourceOf({ shareNow: 0, shareBefore: 0.18, appearsNow: 0 })]);

    const row = rowNamed(strings.title, 'Rallying Charge');
    expect(figureUnder(row, strings.now)).toBe('0%');
    expect(figureUnder(row, strings.before)).toBe('18%');
    expect(within(row).getByText(strings.appearsMany(0))).toBeVisible();
  });

  it('shows no weak or strong mark on damage', async () => {
    const container = await renderSources('en');

    // Damage has no tier figure to judge it by: no arrow, no word, no tint, no colour of a verdict.
    expect(container.textContent).not.toMatch(/[▲▼]/u);
    expect(screen.queryByText(/weak|strong|more than usual|less than usual/iu)).toBeNull();
    expect(container.querySelector(VERDICT_CLASSES)).toBeNull();
    // The comparison with the tier above is not here either.
    expect(screen.queryByText(/tier above/iu)).toBeNull();
  });

  it('shows no weak or strong mark on damage in French', async () => {
    const container = await renderSources('fr');

    expect(container.textContent).not.toMatch(/[▲▼]/u);
    expect(screen.queryByText(/faible|fort|plus que d'habitude|moins que d'habitude/iu)).toBeNull();
    expect(container.querySelector(VERDICT_CLASSES)).toBeNull();
  });

  it.each(LANGUAGES)(
    'names the kind of the weapon, the melee and an item in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderSources(language);

      // The weapon, the melee attack and an item say what they are under their name; an ability
      // needs no word.
      const words = Object.values(strings.kinds);
      expect(
        rowsOf(strings.title).map((row) =>
          words.filter((word) => within(row).queryByText(word) !== null),
        ),
      ).toEqual([[strings.kinds.weapon], [], [strings.kinds.item], [strings.kinds.melee], []]);
      const weapon = rowNamed(strings.title, 'Express Shot');
      expect(
        within(weapon)
          .getByText('Express Shot')
          .compareDocumentPosition(within(weapon).getByText(strings.kinds.weapon)),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    },
  );

  it('shows the picture of each source before its name, and a neutral square for a missing one', async () => {
    const strings = STRINGS.en;
    const container = await renderSources('en');

    const rows = rowsOf(strings.title);
    // The pictures are the ones of the catalogue, and decorative: the name beside them says the source.
    expect(rows.map((row) => row.querySelector('img')?.getAttribute('src') ?? null)).toEqual(
      sources().map(({ imageUrl }) => imageUrl),
    );
    expect(
      Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('alt')),
    ).toEqual(['', '', '', '']);
    // The melee attack has none: a neutral square of the same size keeps the names lined up.
    const melee = rowNamed(strings.title, 'Heavy Melee');
    expect(melee.querySelector('img')).toBeNull();
    const square = melee.querySelector('span[aria-hidden="true"].size-8');
    expect(square).not.toBeNull();
    expect(square?.compareDocumentPosition(within(melee).getByText('Heavy Melee'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The picture of a source stands before its name.
    const weapon = rowNamed(strings.title, 'Express Shot');
    expect(
      weapon
        .querySelector('img')
        ?.compareDocumentPosition(within(weapon).getByText('Express Shot')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('draws the share now of each source as a bar, with no mark for the share before', async () => {
    const strings = STRINGS.en;
    await renderSources('en');

    // Each bar is as long as the share now, and has nothing else in it; it is for the eye, the figure
    // is in the cell.
    const fills = rowsOf(strings.title).map((row) => row.querySelector<HTMLElement>('.bg-accent'));
    expect(fills.map((fill) => fill?.style.width)).toEqual(['46%', '30%', '12%', '7%', '5%']);
    expect(fills.map((fill) => fill?.parentElement?.children.length)).toEqual([1, 1, 1, 1, 1]);
    expect(fills.map((fill) => fill?.parentElement?.getAttribute('aria-hidden'))).toEqual(
      fills.map(() => 'true'),
    );
  });

  it.each(LANGUAGES)('says when the item names are unavailable in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(
      language,
      <ReviewDamage damage={{ kind: 'catalogue_unavailable' }} recent={RECENT} before={BEFORE} />,
    );

    // The section keeps its title and says why it has no row, instead of a list with nothing in it.
    const section = sectionNamed(strings.title);
    expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(strings.title);
    expect(within(section).getByText(strings.unavailable)).toBeVisible();
    expect(within(section).queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(strings.source)).not.toBeInTheDocument();
  });

  it('does not say the item names are unavailable when they are', async () => {
    await renderSources('en');

    expect(screen.queryByText(STRINGS.en.unavailable)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)(
    'says there is no damage under the title when no source dealt any, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderSources(language, []);

      // The title stays and a sentence says why there is nothing to list; a header of columns over an
      // empty list would say nothing.
      const section = sectionNamed(strings.title);
      expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(strings.title);
      expect(within(section).getByText(strings.empty)).toBeVisible();
      expect(within(section).queryByRole('list')).not.toBeInTheDocument();
      expect(screen.queryByText(strings.source)).not.toBeInTheDocument();
      expect(screen.queryByText(strings.unavailable)).not.toBeInTheDocument();
    },
  );

  it('does not say there is no damage when there are sources', async () => {
    await renderSources('en');

    expect(screen.queryByText(STRINGS.en.empty)).not.toBeInTheDocument();
  });

  it('does not say there is no damage when the item names are unavailable', async () => {
    await renderIn(
      'en',
      <ReviewDamage damage={{ kind: 'catalogue_unavailable' }} recent={RECENT} before={BEFORE} />,
    );

    // The names are missing, which is not the same as no damage: only the first is said.
    expect(screen.queryByText(STRINGS.en.empty)).not.toBeInTheDocument();
    expect(screen.getByText(STRINGS.en.unavailable)).toBeVisible();
  });

  it.each(LANGUAGES)(
    'names the section by an h2, with no other heading, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderSources(language);

      // The page title is the h1 of the page and the tab panel is named by its tab: the section comes
      // right under them.
      const heading = screen.getByRole('heading', { level: 2, name: strings.title });
      expect(screen.getAllByRole('heading')).toHaveLength(1);
      expect(sectionNamed(strings.title)).toContainElement(heading);
      // The title has the look every section of the review has.
      expect(heading.className).toBe(REVIEW_SECTION_TITLE);
    },
  );

  it('puts the header of the columns in the box of the rows, above them', async () => {
    await renderSources('en');

    const header = screen.getByText(STRINGS.en.source).parentElement;
    const list = within(sectionNamed(STRINGS.en.title)).getByRole('list');
    // The header sits in the same box as the rows, above them, so that their padding is the same and
    // the names stand over their figures.
    expect(header?.parentElement).toBe(list.parentElement);
    expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The box is the one of every list of the review.
    expect(list.parentElement?.className).toBe(REVIEW_LIST_BOX);
  });
});

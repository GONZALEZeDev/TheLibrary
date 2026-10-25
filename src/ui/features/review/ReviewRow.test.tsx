/**
 * Tests of the row of the review, rendered on its own with rows built by hand (the rows the review
 * service builds are tested with the service), in English and in French: its figures and the name of
 * each for screen readers, the mark of a weakness and of a strength, the count of matches, the figure
 * the gap was measured on, and the evidence panel with one line per match.
 *
 * The numbers are synthetic.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Language } from '../../../core/settings/language';
import type { ReviewMatchValue, ReviewRow as ReviewRowData } from '../../../services/review-view';
import { testMatchId } from '../../../test/test-data';
import { createI18n } from '../../i18n/i18n';
import { REVIEW_ROW_GRID } from './review-layout';
import { ReviewRow } from './ReviewRow';

/**
 * Start of the most recent match of the tests, in Unix seconds: seven past ten in the morning in UTC,
 * so that a match a minute before it is on the same day in every time zone.
 */
const LAST_START = Date.UTC(2026, 9, 20, 10, 7, 0) / 1000;

/** How many seconds make a day. */
const SECONDS_PER_DAY = 86_400;

/** The minus sign the formatters write before a negative number. */
const MINUS = '−';

/** The dash that stands for a figure that is unknown. */
const DASH = '—';

/**
 * Render an element with the i18next instance of one language, in the list a row belongs to.
 *
 * @param language - The language of the interface.
 * @param element - The row to render.
 */
async function renderIn(language: Language, element: ReactElement): Promise<void> {
  const i18n = await createI18n(language);
  render(
    <I18nextProvider i18n={i18n}>
      <ul>{element}</ul>
    </I18nextProvider>,
  );
}

/**
 * The value of a point in one of the last matches, one day after the match that follows it.
 *
 * @param index - How many matches before the most recent one (0 for the most recent).
 * @param value - The value of the match.
 * @param mark - The verdict on the match.
 * @returns The value of the match.
 */
function matchValue(
  index: number,
  value: number,
  mark: ReviewMatchValue['mark'] = null,
): ReviewMatchValue {
  return {
    matchId: testMatchId(1_000 - index),
    startTime: LAST_START - index * SECONDS_PER_DAY,
    value,
    mark,
  };
}

/**
 * A match that starts a given number of seconds after the most recent one, for the tests of matches
 * that start close to one another. It has its own id, as no two matches share one.
 *
 * @param id - The id of the match.
 * @param offset - Seconds after the start of the most recent match (negative for before).
 * @param value - The value of the match.
 * @param mark - The verdict on the match.
 * @returns The value of the match.
 */
function closeMatch(
  id: number,
  offset: number,
  value: number,
  mark: ReviewMatchValue['mark'] = null,
): ReviewMatchValue {
  return { matchId: testMatchId(id), startTime: LAST_START + offset, value, mark };
}

/**
 * A row of the review for a number of deaths over 18 matches: 1.6, against 1.3 for the tier above
 * (+0.3) and 1.8 before, weak in 7 of them and strong in 2, with three matches to list. A test
 * changes what it is about.
 *
 * @param overrides - The fields that differ from that row.
 * @returns The row.
 */
function rowOf(overrides: Partial<ReviewRowData> = {}): ReviewRowData {
  return {
    subject: { kind: 'metric', key: 'deaths' },
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
    matches: [matchValue(0, 3, 'weak'), matchValue(1, 1), matchValue(2, 0, 'strong')],
    ...overrides,
  };
}

/**
 * A row for a point with too few matches to have a figure, as the review builds one: no value, no
 * tier figure and no progress, but the count of the matches it has, each still listed (the first one
 * weak, the others judged and neither), and so the weak and strong counts of them.
 *
 * @param count - How many matches the point has: 0 to 4.
 * @returns The row.
 */
function fewMatchesRowOf(count: number): ReviewRowData {
  return rowOf({
    value: null,
    count,
    comparedValue: null,
    reference: null,
    difference: null,
    weak: count === 0 ? 0 : 1,
    strong: 0,
    marked: count,
    progress: { before: null, direction: null },
    matches: Array.from({ length: count }, (_, index) =>
      matchValue(index, index + 1, index === 0 ? 'weak' : null),
    ),
  });
}

/**
 * Write the day of a match as the evidence panel does.
 *
 * @param language - The language of the interface.
 * @param startTime - Start of the match, in Unix seconds.
 * @returns The date.
 */
function dayOf(language: Language, startTime: number): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(startTime * 1_000);
}

/**
 * Write the day and the time of a match as the evidence panel does for matches the day alone does
 * not tell apart.
 *
 * @param language - The language of the interface.
 * @param startTime - Start of the match, in Unix seconds.
 * @returns The date and the time.
 */
function dayAndTimeOf(language: Language, startTime: number): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    startTime * 1_000,
  );
}

/**
 * Find the row that was rendered.
 *
 * @returns The item of the list.
 */
function theRow(): HTMLElement {
  return screen.getByRole('listitem');
}

/**
 * Find the grid of the row that was rendered, the element that holds its cells and its tint: no role
 * or name points at it, so the shared class of the grid does.
 *
 * @returns The grid.
 */
function theGrid(): HTMLElement {
  return (
    theRow().querySelector<HTMLElement>('.grid') ??
    expect.unreachable('A row is laid out on a grid')
  );
}

/**
 * Find the lines of the evidence panel of the row that was rendered.
 *
 * @returns The text of each line, in reading order.
 */
function evidenceLines(): string[] {
  return within(within(theRow()).getByRole('tooltip'))
    .getAllByRole('paragraph')
    .map((line) => line.textContent);
}

describe('ReviewRow', () => {
  it('shows the value, the tier, the gap, the marks and the progress', async () => {
    await renderIn('en', <ReviewRow row={rowOf()} />);

    const row = within(theRow());
    expect(row.getByText('Deaths')).toBeInTheDocument();
    expect(row.getByText('1.6')).toBeInTheDocument();
    expect(row.getByText('1.3')).toBeInTheDocument();
    expect(row.getByText('+0.3')).toBeInTheDocument();
    expect(row.getByText('weak in 7/18 · strong in 2/18')).toBeInTheDocument();
    expect(row.getByText('1.8 → 1.6 · better')).toBeInTheDocument();
  });

  it('writes them the French way', async () => {
    await renderIn('fr', <ReviewRow row={rowOf()} />);

    const row = within(theRow());
    expect(row.getByText('Morts')).toBeInTheDocument();
    expect(row.getByText('1,6')).toBeInTheDocument();
    expect(row.getByText('1,3')).toBeInTheDocument();
    expect(row.getByText('+0,3')).toBeInTheDocument();
    expect(row.getByText('faible dans 7/18 · fort dans 2/18')).toBeInTheDocument();
    expect(row.getByText('1,8 → 1,6 · mieux')).toBeInTheDocument();
    expect(row.getByText('18 parties')).toBeInTheDocument();
  });

  it('writes the figures in the unit of the point', async () => {
    const row = rowOf({
      subject: { kind: 'place', stat: 'heroDamage' },
      unit: 'place',
      value: 5.7,
      comparedValue: 5.7,
      reference: 4.9,
      difference: { kind: 'absolute', amount: 0.8 },
      progress: { before: 6.2, direction: 'better' },
    });
    await renderIn('en', <ReviewRow row={row} />);

    const cells = within(theRow());
    expect(cells.getByText('Place in Damage to heroes')).toBeInTheDocument();
    expect(cells.getByText('5.7 of 12')).toBeInTheDocument();
    expect(cells.getByText('4.9 of 12')).toBeInTheDocument();
    expect(cells.getByText('+0.8')).toBeInTheDocument();
    expect(cells.getByText('6.2 of 12 → 5.7 of 12 · better')).toBeInTheDocument();
  });

  it.each([
    { language: 'en', phrase: 'about the same', gap: '+0.3' },
    { language: 'fr', phrase: 'à peu près pareil', gap: '+0,3' },
  ] as const)(
    'says "$phrase" instead of a gap within the noise of the matches',
    async ({ language, phrase, gap }) => {
      await renderIn(language, <ReviewRow row={rowOf({ gapWithinNoise: true })} />);

      const row = within(theRow());
      // The figure of the tier is still shown; its gap is the phrase and not the decimal.
      expect(row.getByText(language === 'en' ? '1.3' : '1,3')).toBeInTheDocument();
      expect(row.queryByText(gap)).toBeNull();
      const words = row.getByText(phrase);
      // The phrase stands in the gap's place, with the name of the column for a screen reader.
      expect(words.textContent).toBe(`${language === 'en' ? 'Gap' : 'Écart'} ${phrase}`);
    },
  );

  it('names its point with no link: only the rows of the summary link to their tab', async () => {
    await renderIn('en', <ReviewRow row={rowOf()} />);

    expect(within(theRow()).queryByRole('link')).not.toBeInTheDocument();
    expect(within(theRow()).getByText('Deaths')).toBeInTheDocument();
  });

  it('writes the decimal of a gap outside the noise', async () => {
    await renderIn('en', <ReviewRow row={rowOf({ gapWithinNoise: false })} />);

    expect(within(theRow()).getByText('+0.3')).toBeInTheDocument();
    expect(within(theRow()).queryByText('about the same')).toBeNull();
  });

  it('writes a relative gap as a percentage', async () => {
    const row = rowOf({ unit: 'per_min', value: 1_020, reference: 1_200, comparedValue: 1_020 });
    await renderIn(
      'en',
      <ReviewRow row={{ ...row, difference: { kind: 'relative', ratio: -0.15 } }} />,
    );

    expect(within(theRow()).getByText(`${MINUS}15%`)).toBeInTheDocument();
  });

  it('is laid out on the grid it shares with the header of the columns', async () => {
    await renderIn('en', <ReviewRow row={rowOf()} />);

    expect(theGrid()).toHaveClass(REVIEW_ROW_GRID);
    // One cell for each of the six columns: the arrow, the name and the four figures.
    expect(theGrid().children).toHaveLength(6);
  });

  it('writes the longest figure of the player in the semibold of the first column', async () => {
    const row = rowOf({ unit: 'deaths_per_10_min', value: 1.8, comparedValue: 1.8 });
    await renderIn('fr', <ReviewRow row={row} />);

    expect(within(theRow()).getByText('1,8 pour 10 min')).toHaveClass('text-sm', 'font-semibold');
  });

  it.each([
    {
      language: 'en',
      cells: [
        { figure: '1.6', column: 'You' },
        { figure: '1.3', column: 'Tier above' },
        { figure: '+0.3', column: 'Gap' },
        { figure: 'weak in 7/18 · strong in 2/18', column: 'Weak / strong' },
        { figure: '1.8 → 1.6 · better', column: 'Progress' },
      ],
    },
    {
      language: 'fr',
      cells: [
        { figure: '1,6', column: 'Toi' },
        { figure: '1,3', column: 'Palier au-dessus' },
        { figure: '+0,3', column: 'Écart' },
        { figure: 'faible dans 7/18 · fort dans 2/18', column: 'Faible / fort' },
        { figure: '1,8 → 1,6 · mieux', column: 'Progression' },
      ],
    },
  ] as const)('names each figure for screen readers in $language', async ({ language, cells }) => {
    await renderIn(language, <ReviewRow row={rowOf()} />);

    // A bare "1.3" would not say whether it is the figure of the tier or the player's own: each
    // figure carries the name of its column, which the header of the page only says once.
    const row = within(theRow());
    for (const { figure, column } of cells) {
      expect(row.getByText(figure)).toHaveTextContent(`${column} ${figure}`);
      expect(row.getByText(column)).toHaveClass('sr-only');
    }
  });

  it('keeps a space between the figure of the tier and its gap, so that they never read as one word', async () => {
    await renderIn('en', <ReviewRow row={rowOf()} />);

    const tier = within(theRow()).getByText('1.3').closest('p');
    expect(tier).toHaveTextContent('Tier above 1.3 Gap +0.3');
    // The text is checked as it is, not as the page normalises it: "1.3Gap" would run together.
    expect(tier?.textContent).toMatch(/1\.3 +Gap/);
  });

  it.each([
    {
      language: 'en',
      side: 'weakness',
      arrow: '▼',
      word: 'weakness',
      tint: 'bg-loss/10',
      otherTint: 'bg-win/10',
      label: 'Deaths',
    },
    {
      language: 'en',
      side: 'strength',
      arrow: '▲',
      word: 'strength',
      tint: 'bg-win/10',
      otherTint: 'bg-loss/10',
      label: 'Deaths',
    },
    {
      language: 'fr',
      side: 'weakness',
      arrow: '▼',
      word: 'point faible',
      tint: 'bg-loss/10',
      otherTint: 'bg-win/10',
      label: 'Morts',
    },
    {
      language: 'fr',
      side: 'strength',
      arrow: '▲',
      word: 'point fort',
      tint: 'bg-win/10',
      otherTint: 'bg-loss/10',
      label: 'Morts',
    },
  ] as const)(
    'marks a weakness with an arrow and a word, not colour alone: $side in $language',
    async ({ language, side, arrow, word, tint, otherTint, label }) => {
      await renderIn(language, <ReviewRow row={rowOf({ side })} />);

      const row = within(theRow());
      expect(row.getByText(arrow)).toHaveAttribute('aria-hidden', 'true');
      expect(row.getByText(word)).toHaveClass('sr-only');
      expect(theGrid()).toHaveClass(tint);
      expect(theGrid()).not.toHaveClass(otherTint);
      // Nothing else is marked: one arrow.
      expect(row.getAllByText(/^[▲▼]$/)).toHaveLength(1);
      // The word is set apart from the name, or a screen reader would say "Deathsweakness".
      expect(row.getByText(label)).toHaveTextContent(`${label} ${word}`);
    },
  );

  it('marks a row that is neither a weakness nor a strength with nothing', async () => {
    await renderIn('en', <ReviewRow row={rowOf({ side: null })} />);

    const row = within(theRow());
    expect(row.queryByText(/^[▲▼]$/)).not.toBeInTheDocument();
    expect(row.queryByText(/^(weakness|strength)$/)).not.toBeInTheDocument();
    expect(theGrid()).not.toHaveClass('bg-loss/10');
    expect(theGrid()).not.toHaveClass('bg-win/10');
  });

  it('marks a row with no match to list all the same', async () => {
    await renderIn('en', <ReviewRow row={rowOf({ matches: [], side: 'weakness' })} />);

    expect(theGrid()).toHaveClass('bg-loss/10');
    expect(within(theRow()).getByText('▼')).toHaveAttribute('aria-hidden', 'true');
    expect(within(theRow()).getByText('weakness')).toHaveClass('sr-only');
  });

  it('lists each match in the evidence panel', async () => {
    const matches = [matchValue(0, 3, 'weak'), matchValue(1, 1), matchValue(2, 0, 'strong')];
    await renderIn('en', <ReviewRow row={rowOf({ matches })} />);

    // One line for each match, most recent first as the row gives them, with the word of the flag
    // after the matches that were weak or strong.
    expect(evidenceLines()).toEqual([
      `${dayOf('en', LAST_START)}: 3.0 · weakness`,
      `${dayOf('en', LAST_START - SECONDS_PER_DAY)}: 1.0`,
      `${dayOf('en', LAST_START - 2 * SECONDS_PER_DAY)}: 0.0 · strength`,
    ]);
    const group = within(theRow()).getByRole('group');
    expect(group).toHaveAccessibleName('Deaths');
    expect(group).toHaveAttribute('tabindex', '0');
    // The panel hangs from the right edge of the row, so that it leaves the names below free.
    expect(within(theRow()).getByRole('tooltip')).toHaveClass('right-0', 'left-auto');
  });

  it('lists each match in French', async () => {
    const matches = [matchValue(0, 2.4, 'strong'), matchValue(1, 5, 'weak')];
    await renderIn('fr', <ReviewRow row={rowOf({ matches })} />);

    expect(evidenceLines()).toEqual([
      `${dayOf('fr', LAST_START)} : 2,4 · point fort`,
      `${dayOf('fr', LAST_START - SECONDS_PER_DAY)} : 5,0 · point faible`,
    ]);
  });

  it('writes the value of each match in the unit of the point', async () => {
    const matches = [matchValue(0, 12.37), matchValue(1, 9)];
    await renderIn('en', <ReviewRow row={rowOf({ unit: 'minute', matches })} />);

    expect(evidenceLines()).toEqual([
      `${dayOf('en', LAST_START)}: 12.4 min`,
      `${dayOf('en', LAST_START - SECONDS_PER_DAY)}: 9 min`,
    ]);
  });

  it('tells two matches of the same day with the same value apart', async () => {
    // The day alone would write both lines the same, and the panel keys its lines by their text.
    const matches = [matchValue(0, 3), closeMatch(900, -60, 3), matchValue(1, 3)];
    await renderIn('en', <ReviewRow row={rowOf({ matches })} />);

    const lines = evidenceLines();
    expect(lines).toEqual([
      `${dayAndTimeOf('en', LAST_START)}: 3.0`,
      `${dayAndTimeOf('en', LAST_START - 60)}: 3.0`,
      // The match of another day keeps the day alone.
      `${dayOf('en', LAST_START - SECONDS_PER_DAY)}: 3.0`,
    ]);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('keeps the day alone for two matches of the same day with other values', async () => {
    const matches = [matchValue(0, 3), closeMatch(900, -60, 4)];
    await renderIn('en', <ReviewRow row={rowOf({ matches })} />);

    expect(evidenceLines()).toEqual([
      `${dayOf('en', LAST_START)}: 3.0`,
      `${dayOf('en', LAST_START - 60)}: 4.0`,
    ]);
  });

  it('tells apart two matches of the same day that were both weak, and keeps the word after the value', async () => {
    // The flag word is part of the text, so the unmarked match of the day is not in the collision.
    const matches = [
      closeMatch(901, 0, 3, 'weak'),
      closeMatch(902, -3_600, 3, 'weak'),
      closeMatch(903, -60, 3),
    ];
    await renderIn('en', <ReviewRow row={rowOf({ matches })} />);

    const lines = evidenceLines();
    expect(lines).toEqual([
      `${dayAndTimeOf('en', LAST_START)}: 3.0 · weakness`,
      `${dayAndTimeOf('en', LAST_START - 3_600)}: 3.0 · weakness`,
      `${dayOf('en', LAST_START - 60)}: 3.0`,
    ]);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it.each([
    { language: 'en', separator: ': ', word: 'strength', value: '3.0' },
    { language: 'fr', separator: ' : ', word: 'point fort', value: '3,0' },
  ] as const)(
    'numbers matches that even the time does not tell apart, marked or not: $language',
    async ({ language, separator, word, value }) => {
      // Three matches that start in the same minute with the same value, and two that were strong:
      // nothing in the data tells them apart, but the panel still has one line each.
      const matches = [
        closeMatch(910, 30, 3),
        closeMatch(911, 20, 3),
        closeMatch(912, 10, 3),
        closeMatch(913, 40, 3, 'strong'),
        closeMatch(914, 15, 3, 'strong'),
      ];
      await renderIn(language, <ReviewRow row={rowOf({ matches })} />);

      const when = dayAndTimeOf(language, LAST_START);
      const unmarked = `${when}${separator}${value}`;
      const marked = `${unmarked} · ${word}`;
      const lines = evidenceLines();
      expect(lines).toEqual([
        unmarked,
        `${unmarked} (2)`,
        `${unmarked} (3)`,
        marked,
        `${marked} (2)`,
      ]);
      expect(new Set(lines).size).toBe(lines.length);
    },
  );

  it('has no evidence panel for a row with no match to list', async () => {
    await renderIn('en', <ReviewRow row={rowOf({ matches: [] })} />);

    // Nothing to say, so nothing to open: the row is a plain one.
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(within(theRow()).getByText('1.6')).toBeInTheDocument();
  });

  it('shows a dash for a row without a value', async () => {
    await renderIn('en', <ReviewRow row={fewMatchesRowOf(3)} />);

    const row = within(theRow());
    // The value, the tier and the progress: nothing is made up for any of them.
    expect(row.getAllByText(DASH).map((dash) => dash.textContent)).toEqual([
      'You —',
      'Tier above —',
      'Progress —',
    ]);
    // The matches it has are judged all the same, and counted.
    expect(row.getByText('weak in 1/3 · strong in 0/3')).toBeInTheDocument();
    // No gap to a tier that has no figure, and no figure it was measured on.
    expect(row.queryByText('Gap')).not.toBeInTheDocument();
    expect(row.queryByText(/same stretch/)).not.toBeInTheDocument();
  });

  it('shows a dash in every figure column for a point with no match at all', async () => {
    await renderIn('en', <ReviewRow row={fewMatchesRowOf(0)} />);

    expect(
      within(theRow())
        .getAllByText(DASH)
        .map((dash) => dash.textContent),
    ).toEqual(['You —', 'Tier above —', 'Weak / strong —', 'Progress —']);
    expect(within(theRow()).getByText('0 matches')).toBeInTheDocument();
  });

  it('shows a dash for the tier and no gap for a row without a tier figure', async () => {
    // The row keeps the gap of a tier it has no figure of: it must not be shown.
    const row = rowOf({ reference: null, comparedValue: null });
    await renderIn('fr', <ReviewRow row={row} />);

    const cells = within(theRow());
    expect(cells.getByText('1,6')).toBeInTheDocument();
    expect(cells.getByText(DASH)).toHaveTextContent('Palier au-dessus —');
    expect(cells.queryByText('Écart')).not.toBeInTheDocument();
    expect(cells.queryByText('+0,3')).not.toBeInTheDocument();
  });

  it('shows a dash for the marks of a point no match could judge', async () => {
    await renderIn('en', <ReviewRow row={rowOf({ weak: 0, strong: 0, marked: 0 })} />);

    expect(within(theRow()).getByText(DASH)).toHaveTextContent('Weak / strong —');
    expect(within(theRow()).queryByText(/weak in/)).not.toBeInTheDocument();
  });

  it.each([
    { language: 'en', count: 4, text: '4 matches' },
    { language: 'en', count: 3, text: '3 matches' },
    { language: 'en', count: 1, text: '1 match' },
    { language: 'fr', count: 3, text: '3 parties' },
    { language: 'fr', count: 1, text: '1 partie' },
  ] as const)(
    'says how many matches it counted when there are too few: $count in $language',
    async ({ language, count, text }) => {
      await renderIn(language, <ReviewRow row={fewMatchesRowOf(count)} />);

      // The value is a dash, and the row still says how many matches it counted.
      const row = within(theRow());
      expect(row.getByText(text)).toBeInTheDocument();
      expect(row.getAllByText(DASH)[0]).toHaveTextContent(
        `${language === 'en' ? 'You' : 'Toi'} ${DASH}`,
      );
    },
  );

  it.each([1, 2, 3, 4])(
    'still lists the %i matches of a point with too few of them to have a figure',
    async (count) => {
      await renderIn('en', <ReviewRow row={fewMatchesRowOf(count)} />);

      // The player can see which matches the point is made of, and which was weak.
      const lines = evidenceLines();
      expect(lines).toHaveLength(count);
      expect(lines[0]).toBe(`${dayOf('en', LAST_START)}: 1.0 · weakness`);
      expect(within(theRow()).getByRole('group')).toHaveAccessibleName('Deaths');
    },
  );

  it.each([
    { language: 'en', text: 'You on the same stretch: 1.9' },
    { language: 'fr', text: 'Toi sur la même durée : 1,9' },
  ] as const)(
    'shows the compared figure when it differs from the value in $language',
    async ({ language, text }) => {
      await renderIn(language, <ReviewRow row={rowOf({ comparedValue: 1.9 })} />);

      expect(within(theRow()).getByText(text)).toBeInTheDocument();
    },
  );

  it('shows the compared figure in the unit of the point, next to the tier', async () => {
    const row = rowOf({ unit: 'minute', value: 12, comparedValue: 14.5, reference: 13 });
    await renderIn('en', <ReviewRow row={row} />);

    const compared = within(theRow()).getByText('You on the same stretch: 14.5 min');
    // It stands in the cell of the tier, since it says what the gap beside the tier was measured on.
    expect(compared.parentElement).toContainElement(within(theRow()).getByText('13 min'));
    expect(compared.closest('[role="tooltip"]')).toBeNull();
  });

  it.each([
    { name: 'it equals the value', value: 1.6, comparedValue: 1.6 },
    { name: 'it only differs by what the figures round away', value: 1.62, comparedValue: 1.64 },
    { name: 'there is none', value: 1.6, comparedValue: null },
  ])('does not show the compared figure when $name', async ({ value, comparedValue }) => {
    await renderIn('en', <ReviewRow row={rowOf({ value, comparedValue })} />);

    expect(within(theRow()).queryByText(/same stretch/)).not.toBeInTheDocument();
  });

  it('shows the picture before the name of the point', async () => {
    const row = rowOf({ subject: { kind: 'valve_top_three' }, unit: 'rate' });
    await renderIn('en', <ReviewRow row={row} picture={<span data-testid="picture" />} />);

    // The name comes after the picture in the document, and is not inside it.
    expect(
      screen
        .getByTestId('picture')
        .compareDocumentPosition(screen.getByText("In Valve's top three")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('REVIEW_ROW_GRID', () => {
  /** The width of the window below which the app cannot be resized, in px (see the window config). */
  const MIN_WINDOW_PX = 1_100;
  /** The sidebar of the shell (15 rem) and its border. */
  const SIDEBAR_PX = 241;
  /** The horizontal padding of the main column of the shell (2 × 2.5 rem). */
  const MAIN_PADDING_PX = 80;
  /** The border and padding of the list of rows (2 × 5 px), and a classic scrollbar. */
  const LIST_AND_SCROLLBAR_PX = 30;
  /** The horizontal padding of a row (2 × 0.75 rem) and the gap between two columns (0.75 rem). */
  const ROW_PADDING_PX = 24;
  const GAP_PX = 12;
  const REM_PX = 16;

  /**
   * Read the columns of the grid.
   *
   * @returns The width in rem of each column that has one, and how many columns take what is left.
   */
  function columnsOfGrid(): { fixedRem: readonly number[]; flexible: number } {
    const tracks =
      /grid-cols-\[([^\]]+)\]/.exec(REVIEW_ROW_GRID)?.[1]?.split('_') ??
      expect.unreachable('The grid declares its columns');
    return {
      fixedRem: tracks.flatMap((track) => {
        const rem = /(\d+(?:\.\d+)?)rem/.exec(track)?.[1];
        return rem === undefined ? [] : [Number(rem)];
      }),
      flexible: tracks.filter((track) => track.includes('1fr')).length,
    };
  }

  it('has one column that takes what the others leave, for the name', () => {
    expect(columnsOfGrid().flexible).toBe(1);
    expect(columnsOfGrid().fixedRem).toHaveLength(5);
  });

  it('gives the figure of the player the room of the longest one on a line', () => {
    // "1,8 pour 10 min" in semibold is about 6.7 rem wide.
    expect(columnsOfGrid().fixedRem[1]).toBeGreaterThanOrEqual(7);
  });

  it('leaves the name of a point room at the narrowest window of the app', () => {
    const { fixedRem, flexible } = columnsOfGrid();
    // There is a gap between two columns, so one fewer than there are columns.
    const gaps = (fixedRem.length + flexible - 1) * GAP_PX;
    const fixed = fixedRem.reduce((total, rem) => total + rem * REM_PX, 0);
    const available =
      MIN_WINDOW_PX - SIDEBAR_PX - MAIN_PADDING_PX - LIST_AND_SCROLLBAR_PX - ROW_PADDING_PX;

    // A name of 11 rem takes two lines for the longest ones; less would take three or four.
    expect(available - gaps - fixed).toBeGreaterThanOrEqual(11 * REM_PX);
  });
});

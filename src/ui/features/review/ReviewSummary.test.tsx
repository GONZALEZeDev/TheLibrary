/**
 * Tests of the summary tab of the review, rendered on its own with summaries built by hand (the
 * summary the service builds is tested with the service), in English and in French: the weaknesses
 * before the strengths, each section with its name, the sentence of a section where nothing recurs,
 * the picture of a resistance item before its name, and the name of each row as a link to its tab.
 *
 * The tab is rendered on the review route of a router of its own, as the links of its rows need one:
 * the address they lead to is the one of the application.
 *
 * The rows are the ones of the review, drawn by `ReviewRow` (tested on its own); the tests here are
 * about which rows the tab lists, in which order and under which heading. The numbers are synthetic.
 *
 * @packageDocumentation
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Language } from '../../../core/settings/language';
import type {
  ResistanceItemView,
  Review,
  ReviewRow as ReviewRowData,
  ReviewSubject,
} from '../../../services/review-view';
import { REVIEW_TABS, reviewSearchSchema } from '../../app/router';
import { Tabs } from '../../components/Tabs';
import { createI18n } from '../../i18n/i18n';
import { REVIEW_SECTION_TITLE } from './review-layout';
import { ReviewSummary } from './ReviewSummary';

/** The texts of the tab, by language. */
const STRINGS = {
  en: {
    weaknesses: 'To work on',
    strengths: 'Your strengths',
    noWeakness: 'No recurring weakness',
    noStrength: 'No recurring strength',
    tierAndGap: 'Tier above · Gap',
    labels: { kda: 'KDA', accuracy: 'Accuracy', lastHits: 'Last hits', denies: 'Denies' },
    links: {
      kda: 'KDA',
      earlyDeaths: 'Deaths in early',
      metalSkin: 'Metal Skin · Bought at',
      netWorthPlace: 'Place in Souls',
      topThree: "In Valve's top three",
    },
  },
  fr: {
    weaknesses: 'À travailler',
    strengths: 'Tes points forts',
    noWeakness: 'Aucun point faible récurrent',
    noStrength: 'Aucun point fort récurrent',
    tierAndGap: 'Palier au-dessus · Écart',
    labels: { kda: 'KDA', accuracy: 'Précision', lastHits: 'Last hits', denies: 'Denies' },
    links: {
      kda: 'KDA',
      earlyDeaths: 'Morts en early',
      metalSkin: 'Metal Skin · Acheté à',
      netWorthPlace: 'Place en Âmes',
      topThree: 'Dans le top 3 de Valve',
    },
  },
} as const;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** A resistance item the catalogue knows, with its picture. */
const METAL_SKIN: ResistanceItemView = {
  itemId: 1_001,
  className: 'upgrade_metal_skin',
  name: 'Metal Skin',
  imageUrl: 'https://assets.example/metal-skin.png',
  tier: 3,
  protects: 'bullet',
};

/** A resistance item the catalogue knows by name but has no picture for. */
const SPELLBREAKER: ResistanceItemView = {
  itemId: 1_002,
  className: 'upgrade_spellbreaker',
  name: 'Spellbreaker',
  imageUrl: null,
  tier: 4,
  protects: 'spirit',
};

/**
 * Render an element with the i18next instance of one language, as the page of the review route of a
 * router of its own, which opens at the review.
 *
 * @param language - The language of the interface.
 * @param element - The element to render.
 * @returns The container the element was rendered in, and the router and its history, to see where
 *   a link leads.
 */
async function renderInRouter(language: Language, element: ReactElement) {
  const i18n = await createI18n(language);
  const rootRoute = createRootRoute();
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    validateSearch: reviewSearchSchema,
    component: () => element,
  });
  const history = createMemoryHistory({ initialEntries: ['/review'] });
  const router = createRouter({ routeTree: rootRoute.addChildren([reviewRoute]), history });
  await router.load();
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  await screen.findAllByRole('region');
  return { container, router, history };
}

/**
 * Render an element with the i18next instance of one language (see {@link renderInRouter}).
 *
 * @param language - The language of the interface.
 * @param element - The element to render.
 * @returns The container the element was rendered in.
 */
async function renderIn(language: Language, element: ReactElement): Promise<HTMLElement> {
  return (await renderInRouter(language, element)).container;
}

/**
 * A row of the review for a point, with no match behind it (so that it has no evidence panel to
 * mix up with the rows). A test changes what it is about.
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
 * A row for one of the 24 metrics of the match page, flagged on a side of the summary.
 *
 * @param key - The metric.
 * @param side - The side of the summary the point is on.
 * @returns The row.
 */
function metricRow(
  key: 'kda' | 'accuracy' | 'last_hits' | 'denies',
  side: 'weakness' | 'strength',
): ReviewRowData {
  return rowOf({ kind: 'metric', key }, { side });
}

/**
 * Build a summary that holds the given rows.
 *
 * @param weaknesses - The rows of the weaknesses, in the order the tab lists them.
 * @param strengths - The rows of the strengths, in the order the tab lists them.
 * @returns The summary.
 */
function summaryOf(
  weaknesses: readonly ReviewRowData[],
  strengths: readonly ReviewRowData[],
): Review['summary'] {
  return { weaknesses, strengths };
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
 * Find a section of the tab by its name.
 *
 * @param name - The title of the section.
 * @returns The section.
 */
function sectionNamed(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('ReviewSummary', () => {
  it.each(LANGUAGES)('lists the weaknesses before the strengths in %s', async (language) => {
    const strings = STRINGS[language];
    // The rows are given in the order of the summary (the most often flagged first), which is neither
    // the alphabetical order of their names nor its reverse: the tab must not sort them.
    const weaknesses = [
      metricRow('last_hits', 'weakness'),
      metricRow('kda', 'weakness'),
      metricRow('accuracy', 'weakness'),
    ];
    const strengths = [metricRow('denies', 'strength')];
    await renderIn(language, <ReviewSummary summary={summaryOf(weaknesses, strengths)} />);

    // To work on comes first, then the strengths, and the tab holds no other section.
    expect(
      screen
        .getAllByRole('region')
        .map((section) => within(section).getByRole('heading').textContent),
    ).toEqual([strings.weaknesses, strings.strengths]);

    // Each section holds its own rows, in the order given.
    const names = Object.values(strings.labels);
    expect(namesOfRows(sectionNamed(strings.weaknesses), names)).toEqual([
      strings.labels.lastHits,
      strings.labels.kda,
      strings.labels.accuracy,
    ]);
    expect(namesOfRows(sectionNamed(strings.strengths), names)).toEqual([strings.labels.denies]);
  });

  it.each(LANGUAGES)('names each section by its heading in %s', async (language) => {
    const strings = STRINGS[language];
    await renderIn(
      language,
      <ReviewSummary
        summary={summaryOf([metricRow('kda', 'weakness')], [metricRow('accuracy', 'strength')])}
      />,
    );

    // The page title is the h1 of the page; the two sections of the tab come right under it.
    for (const name of [strings.weaknesses, strings.strengths]) {
      const heading = screen.getByRole('heading', { level: 2, name });
      expect(sectionNamed(name)).toContainElement(heading);
      // The title has the look every section of the review has.
      expect(heading.className).toBe(REVIEW_SECTION_TITLE);
    }
  });

  it.each(LANGUAGES)('says when nothing recurs in %s', async (language) => {
    const strings = STRINGS[language];
    const container = await renderIn(language, <ReviewSummary summary={summaryOf([], [])} />);

    expect(within(sectionNamed(strings.weaknesses)).getByText(strings.noWeakness)).toBeVisible();
    expect(within(sectionNamed(strings.strengths)).getByText(strings.noStrength)).toBeVisible();
    // No rows, no list and no header of columns over nothing.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(strings.tierAndGap)).not.toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('says it for the section that is empty and lists the other one', async () => {
    const strings = STRINGS.en;
    await renderIn(
      'en',
      <ReviewSummary summary={summaryOf([], [metricRow('denies', 'strength')])} />,
    );

    const weakSection = sectionNamed(strings.weaknesses);
    expect(within(weakSection).getByText(strings.noWeakness)).toBeInTheDocument();
    expect(within(weakSection).queryByRole('list')).not.toBeInTheDocument();
    expect(within(weakSection).queryByText(strings.tierAndGap)).not.toBeInTheDocument();

    const strongSection = sectionNamed(strings.strengths);
    expect(within(strongSection).queryByText(strings.noStrength)).not.toBeInTheDocument();
    expect(namesOfRows(strongSection, Object.values(strings.labels))).toEqual([
      strings.labels.denies,
    ]);
  });

  it('puts one header of the columns above each list, in the box of the rows', async () => {
    const strings = STRINGS.en;
    await renderIn(
      'en',
      <ReviewSummary
        summary={summaryOf(
          [metricRow('kda', 'weakness'), metricRow('accuracy', 'weakness')],
          [metricRow('denies', 'strength')],
        )}
      />,
    );

    for (const name of [strings.weaknesses, strings.strengths]) {
      const section = sectionNamed(name);
      const header = within(section).getByText(strings.tierAndGap).parentElement;
      const list = within(section).getByRole('list');
      expect(header).toHaveAttribute('aria-hidden', 'true');
      // The header sits in the same box as the rows, above them, so that their padding is the same
      // and the names stand over their figures.
      expect(header?.parentElement).toBe(list.parentElement);
      expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it('stacks the two sections: the rows need the whole width of the tab', async () => {
    await renderIn(
      'en',
      <ReviewSummary
        summary={summaryOf([metricRow('kda', 'weakness')], [metricRow('denies', 'strength')])}
      />,
    );

    const container = sectionNamed(STRINGS.en.weaknesses).parentElement;
    expect(container).toBe(sectionNamed(STRINGS.en.strengths).parentElement);
    // Side by side, a row would be crushed: nothing makes the container a grid, a flex line or
    // columns, at any width.
    expect(container?.className).not.toMatch(/grid|flex|columns/u);
  });

  it.each(LANGUAGES)(
    'links the name of each row to the tab of its point in %s',
    async (language) => {
      const strings = STRINGS[language];
      const weaknesses = [
        metricRow('kda', 'weakness'),
        rowOf({ kind: 'phase_deaths', phase: 'early' }, { side: 'weakness' }),
        rowOf(
          { kind: 'resistance_minute', item: METAL_SKIN },
          { unit: 'minute', side: 'weakness' },
        ),
      ];
      const strengths = [
        rowOf({ kind: 'place', stat: 'netWorth' }, { unit: 'place', side: 'strength' }),
        rowOf({ kind: 'valve_top_three' }, { unit: 'rate', side: 'strength' }),
      ];
      await renderIn(language, <ReviewSummary summary={summaryOf(weaknesses, strengths)} />);

      // One link a row, named after the point (its flag is said after it, out of the link), to the
      // stats for a metric, the deaths for the deaths and the resistance, the players for a place.
      const links = screen.getAllByRole('link');
      expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
        [strings.links.kda, '/review?tab=stats'],
        [strings.links.earlyDeaths, '/review?tab=deaths'],
        [strings.links.metalSkin, '/review?tab=deaths'],
        [strings.links.netWorthPlace, '/review?tab=players'],
        [strings.links.topThree, '/review?tab=players'],
      ]);
      for (const item of screen.getAllByRole('listitem')) {
        expect(within(item).getAllByRole('link')).toHaveLength(1);
      }
    },
  );

  it('opens the tab of a row in place of the summary, as the tabs do', async () => {
    const { router, history } = await renderInRouter(
      'en',
      <ReviewSummary
        summary={summaryOf(
          [rowOf({ kind: 'phase_deaths', phase: 'early' }, { side: 'weakness' })],
          [],
        )}
      />,
    );
    const entries = history.length;

    await userEvent.setup().click(screen.getByRole('link', { name: 'Deaths in early' }));

    // The address names the tab, and replaced the one of the summary: going back leaves the review.
    expect(router.state.location.pathname).toBe('/review');
    expect(router.state.location.search).toEqual({ tab: 'deaths' });
    expect(history.length).toBe(entries);
  });

  it('keeps the focus on the review tabs after a summary link', async () => {
    const summary = summaryOf(
      [rowOf({ kind: 'phase_deaths', phase: 'early' }, { side: 'weakness' })],
      [],
    );
    // The summary in the tabs of the review, switched through the address as the page does: the
    // route reads the tab from its search, and the tabs ask the router for another one.
    const tabs = REVIEW_TABS.map((id) => ({ id, label: id }));
    function ReviewTabs() {
      const { tab } = reviewRoute.useSearch();
      const navigate = useNavigate();
      return (
        <Tabs
          label="Review"
          tabs={tabs}
          selected={tab}
          onSelect={(next) => {
            void navigate({ to: '/review', search: { tab: next }, replace: true });
          }}
        >
          {tab === 'summary' ? <ReviewSummary summary={summary} /> : <p>{`Open tab: ${tab}`}</p>}
        </Tabs>
      );
    }
    const i18n = await createI18n('en');
    const rootRoute = createRootRoute();
    const reviewRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/review',
      validateSearch: reviewSearchSchema,
      component: ReviewTabs,
    });
    const history = createMemoryHistory({ initialEntries: ['/review'] });
    const router = createRouter({ routeTree: rootRoute.addChildren([reviewRoute]), history });
    await router.load();
    render(
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    );

    await userEvent.setup().click(await screen.findByRole('link', { name: 'Deaths in early' }));

    // The link left the page with the summary: the tab it led to has the focus, not the page.
    expect(await screen.findByText('Open tab: deaths')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'deaths' })).toHaveFocus();
  });

  it('puts the picture of a resistance item before its name in the summary', async () => {
    const weaknesses = [
      rowOf(
        { kind: 'resistance_minute', item: METAL_SKIN },
        { unit: 'minute', side: 'weakness', better: 'lower' },
      ),
      metricRow('kda', 'weakness'),
    ];
    const strengths = [
      rowOf(
        { kind: 'resistance_rate', item: SPELLBREAKER },
        { unit: 'rate', side: 'strength', better: null },
      ),
    ];
    const container = await renderIn(
      'en',
      <ReviewSummary summary={summaryOf(weaknesses, strengths)} />,
    );

    // The picture is decorative and comes before the name, which says the item.
    const [metalSkinRow, kdaRow] = within(sectionNamed(STRINGS.en.weaknesses)).getAllByRole(
      'listitem',
    );
    const picture =
      metalSkinRow?.querySelector('img') ?? expect.unreachable('Metal Skin has a picture');
    expect(picture).toHaveAttribute('src', METAL_SKIN.imageUrl);
    expect(picture).toHaveAttribute('alt', '');
    const name = within(metalSkinRow ?? expect.unreachable('A row')).getByText(
      /^Metal Skin · Bought at/u,
    );
    expect(picture.compareDocumentPosition(name)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // An item with no picture keeps the place of one, so that the names line up.
    const strongRow = within(sectionNamed(STRINGS.en.strengths)).getByRole('listitem');
    expect(strongRow.querySelector('img')).toBeNull();
    const square = strongRow.querySelector('span[aria-hidden="true"].size-6');
    expect(square).not.toBeNull();
    const strongName = within(strongRow).getByText(/^Spellbreaker · Bought/u);
    expect(square?.compareDocumentPosition(strongName)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // A point that is not an item has no picture, and no place kept for one.
    expect(kdaRow?.querySelector('img')).toBeNull();
    expect(kdaRow?.querySelector('.size-6')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });
});

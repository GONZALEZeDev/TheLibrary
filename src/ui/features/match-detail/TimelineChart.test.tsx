/**
 * Tests of the chart of the timeline tab of the match page, rendered on its own with views built by
 * hand (the view the timeline service gives is tested with the service), in English and in French:
 * one marker per death, kill and purchase, the ring of the avoidable deaths, the name of the line of
 * the lane opponents, the sentence that says the kills are unknown, a legend that names only what
 * the chart can draw, a match of no length, and the death picked from the list below the chart or
 * from its marker.
 *
 * The chart is a picture for the eye: its markers are found by the title each one carries, which is
 * what the pointer shows over them. The times and the souls are synthetic.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { Language } from '../../../core/settings/language';
import type { TimelineDeath, TimelineTabView } from '../../../services/match-timeline-view';
import { createI18n } from '../../i18n/i18n';
import { DeathList } from './DeathList';
import { CHART_FRAME } from './timeline-chart-geometry';
import { TimelineChart } from './TimelineChart';

/** The view of a timeline. */
type Timeline = Extract<TimelineTabView, { kind: 'timeline' }>;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** The texts of the chart, by language. */
const STRINGS = {
  en: {
    title: 'Souls over the match',
    you: 'You',
    opponentOne: 'Your lane opponent',
    opponentOther: 'Your lane opponents (average)',
    death: 'Death',
    avoidableDeath: 'Avoidable death',
    kill: 'Kill',
    purchase: 'Purchase',
    noKills: "Kills unknown: a player's death detail is incomplete.",
    unknownHero: 'a hero',
    world: 'troopers or the environment',
    unknownItem: 'an item',
  },
  fr: {
    title: 'Âmes au fil de la partie',
    you: 'Toi',
    opponentOne: 'Ton adversaire de lane',
    opponentOther: 'Tes adversaires de lane (moyenne)',
    death: 'Mort',
    avoidableDeath: 'Mort évitable',
    kill: 'Kill',
    purchase: 'Achat',
    noKills: "Kills inconnus : le détail des morts d'un joueur est incomplet.",
    unknownHero: 'un héros',
    world: "les troupes ou l'environnement",
    unknownItem: 'un objet',
  },
} as const satisfies Record<Language, Record<string, string>>;

/**
 * The deaths of the player: two avoidable ones (one by a hero the catalogue does not name), an even
 * fight and a death by the world.
 */
const DEATHS: readonly TimelineDeath[] = [
  {
    timeS: 341,
    killer: { kind: 'hero', heroId: 13, name: 'Haze' },
    timeToKillS: 2.4,
    enemiesNear: 3,
    alliesNear: 0,
    verdict: 'avoidable',
  },
  {
    timeS: 482,
    killer: { kind: 'hero', heroId: 6, name: 'Abrams' },
    timeToKillS: 4.8,
    enemiesNear: 1,
    alliesNear: 1,
    verdict: 'balanced',
  },
  {
    timeS: 870,
    killer: { kind: 'hero', heroId: null, name: null },
    timeToKillS: 1.4,
    enemiesNear: 2,
    alliesNear: 0,
    verdict: 'avoidable',
  },
  {
    timeS: 1_635,
    killer: { kind: 'world' },
    timeToKillS: null,
    enemiesNear: 0,
    alliesNear: 3,
    verdict: null,
  },
];

/**
 * Build the view of a match of 32:14 that reached the three phases, with one lane opponent, three
 * kills (one of a hero the catalogue does not name), three purchases (one of an item the catalogue
 * does not name) and the four deaths of {@link DEATHS}, unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The view.
 */
function testView(overrides: Partial<Timeline> = {}): Timeline {
  return {
    kind: 'timeline',
    durationS: 1_934,
    phases: [
      { phase: 'early', startS: 0, endS: 600 },
      { phase: 'mid', startS: 600, endS: 1_500 },
      { phase: 'late', startS: 1_500, endS: 1_934 },
    ],
    souls: {
      you: [
        { timeS: 0, souls: 0 },
        { timeS: 600, souls: 9_000 },
        { timeS: 1_200, souls: 21_000 },
        { timeS: 1_934, souls: 38_000 },
      ],
      opponents: [
        { timeS: 0, souls: 0 },
        { timeS: 600, souls: 8_000 },
        { timeS: 1_200, souls: 22_500 },
        { timeS: 1_934, souls: 36_000 },
      ],
      opponentCount: 1,
    },
    kills: [
      { timeS: 400, victim: { heroId: 13, name: 'Haze' } },
      { timeS: 960, victim: { heroId: 99, name: null } },
      { timeS: 1_290, victim: { heroId: 6, name: 'Abrams' } },
    ],
    purchases: [
      { timeS: 120, itemId: 1, name: 'Extended Magazine', imageUrl: null },
      { timeS: 450, itemId: 2, name: null, imageUrl: null },
      { timeS: 1_100, itemId: 3, name: 'Headshot Booster', imageUrl: null },
    ],
    deaths: DEATHS,
    avoidableCount: 2,
    positions: 'known',
    ...overrides,
  };
}

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
 * Render the chart of a view, with no death selected.
 *
 * @param language - The language of the interface.
 * @param view - The view.
 */
async function renderChart(language: Language, view: Timeline = testView()): Promise<void> {
  await renderIn(language, <TimelineChart view={view} selectedDeath={null} onSelectDeath={noop} />);
}

/** A selection handler that does nothing, for the tests that select nothing. */
function noop(): void {
  // Nothing to do: the test does not select.
}

/**
 * The picture of the chart.
 *
 * @param language - The language of the interface.
 * @returns The chart, an image named by its title.
 */
function chart(language: Language): HTMLElement {
  return screen.getByRole('img', { name: STRINGS[language].title });
}

/**
 * The markers of the chart whose title starts with a text: the title is what the pointer shows over
 * a marker, and what tells each kind of marker from the others.
 *
 * @param language - The language of the interface.
 * @param label - The start of the title, before the separator (`Death`, `Kill`…).
 * @returns The markers, in the order of the chart.
 */
function markers(language: Language, label: string): Element[] {
  return [...chart(language).querySelectorAll('title')]
    .filter((title) => title.textContent.startsWith(`${label} · `))
    .map((title) => {
      const marker = title.parentElement;
      if (marker === null) {
        throw new Error('A title stands outside a marker');
      }
      return marker;
    });
}

/**
 * The titles of the markers of a kind.
 *
 * @param language - The language of the interface.
 * @param label - The start of the title (`Death`, `Kill`…).
 * @returns The titles, in the order of the chart.
 */
function markerTitles(language: Language, label: string): string[] {
  return markers(language, label).map((marker) => marker.querySelector('title')?.textContent ?? '');
}

describe('TimelineChart', () => {
  it.each(LANGUAGES)('draws one marker per death, kill and purchase (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderChart(language);

    expect(markerTitles(language, strings.avoidableDeath)).toEqual([
      `${strings.avoidableDeath} · 5:41 · Haze`,
      `${strings.avoidableDeath} · 14:30 · ${strings.unknownHero}`,
    ]);
    expect(markerTitles(language, strings.death)).toEqual([
      `${strings.death} · 8:02 · Abrams`,
      `${strings.death} · 27:15 · ${strings.world}`,
    ]);
    expect(markerTitles(language, strings.kill)).toEqual([
      `${strings.kill} · 6:40 · Haze`,
      `${strings.kill} · 16:00 · ${strings.unknownHero}`,
      `${strings.kill} · 21:30 · Abrams`,
    ]);
    expect(markerTitles(language, strings.purchase)).toEqual([
      `${strings.purchase} · 2:00 · Extended Magazine`,
      `${strings.purchase} · 7:30 · ${strings.unknownItem}`,
      `${strings.purchase} · 18:20 · Headshot Booster`,
    ]);
    // The time axis runs from the start of the match to its end.
    expect(within(chart(language)).getByText('0:00')).toBeInTheDocument();
    expect(within(chart(language)).getByText('32:14')).toBeInTheDocument();
  });

  it.each(LANGUAGES)('draws no death marker when the deaths are unknown (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderChart(language, testView({ deaths: null, avoidableCount: null }));

    expect(markers(language, strings.death)).toHaveLength(0);
    expect(markers(language, strings.avoidableDeath)).toHaveLength(0);
    expect(markers(language, strings.kill)).toHaveLength(3);
    // The legend does not name a marker the chart cannot draw.
    expect(screen.queryByText(strings.death)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.avoidableDeath)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('names no avoidable death without positions (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderChart(
      language,
      testView({
        deaths: DEATHS.map((death) => ({
          ...death,
          enemiesNear: null,
          alliesNear: null,
          verdict: null,
        })),
        avoidableCount: null,
        positions: 'missing',
      }),
    );

    // Without positions no death is told avoidable: every death is a plain cross.
    expect(markers(language, strings.death)).toHaveLength(DEATHS.length);
    expect(markers(language, strings.avoidableDeath)).toHaveLength(0);
    expect(screen.getByText(strings.death)).toBeInTheDocument();
    expect(screen.queryByText(strings.avoidableDeath)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('names no purchase when the player bought nothing (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderChart(language, testView({ purchases: [] }));

    expect(markers(language, strings.purchase)).toHaveLength(0);
    expect(screen.queryByText(strings.purchase)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('draws a match of no length and times past its end (%s)', async (language) => {
    const strings = STRINGS[language];
    // A match of no length with one point: the scales must not divide by zero.
    await renderChart(
      language,
      testView({
        durationS: 0,
        phases: [],
        souls: { you: [{ timeS: 0, souls: 0 }], opponents: null, opponentCount: 0 },
        kills: [{ timeS: 30, victim: { heroId: 13, name: 'Haze' } }],
      }),
    );

    const drawn = [...chart(language).querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );
    expect(drawn.filter((value) => value.includes('NaN') || value.includes('Infinity'))).toEqual(
      [],
    );
    // A time past the end of the match stands at the right edge, never outside the frame.
    const [kill] = markers(language, strings.kill);
    expect(kill?.getAttribute('transform')).toBe(
      `translate(${CHART_FRAME.right.toFixed(1)} ${String(CHART_FRAME.killRowY)})`,
    );
  });

  it.each(LANGUAGES)('rings the avoidable deaths (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderChart(language);

    // The ring is a shape of its own, so that the colour never tells an avoidable death alone.
    for (const marker of markers(language, strings.avoidableDeath)) {
      expect(marker.querySelectorAll('circle')).toHaveLength(1);
    }
    for (const marker of markers(language, strings.death)) {
      expect(marker.querySelectorAll('circle')).toHaveLength(0);
    }
    // The legend names both kinds of death.
    expect(screen.getByText(strings.death)).toBeInTheDocument();
    expect(screen.getByText(strings.avoidableDeath)).toBeInTheDocument();
  });

  it.each(LANGUAGES.flatMap((language) => [1, 2].map((count) => [language, count] as const)))(
    'names the opponent line by the number of opponents (%s, %i)',
    async (language, opponentCount) => {
      const strings = STRINGS[language];
      const view = testView();
      await renderChart(language, testView({ souls: { ...view.souls, opponentCount } }));

      const [named, other] =
        opponentCount === 1
          ? [strings.opponentOne, strings.opponentOther]
          : [strings.opponentOther, strings.opponentOne];
      expect(screen.getByText(strings.you)).toBeInTheDocument();
      expect(screen.getByText(named)).toBeInTheDocument();
      expect(screen.queryByText(other)).not.toBeInTheDocument();
      expect(chart(language).querySelectorAll('polyline')).toHaveLength(2);
    },
  );

  it.each(LANGUAGES)('draws no opponent line without lane opponents (%s)', async (language) => {
    const strings = STRINGS[language];
    const view = testView();
    await renderChart(
      language,
      testView({ souls: { ...view.souls, opponents: null, opponentCount: 0 } }),
    );

    expect(chart(language).querySelectorAll('polyline')).toHaveLength(1);
    expect(screen.queryByText(strings.opponentOne)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.opponentOther)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('says the kills are unknown (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderChart(language, testView({ kills: null }));

    expect(screen.getByText(strings.noKills)).toBeInTheDocument();
    expect(markers(language, strings.kill)).toHaveLength(0);
    // The legend does not name a marker the chart does not draw.
    expect(screen.queryByText(strings.kill)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('says nothing of the kills when they are known (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderChart(language);

    expect(screen.queryByText(strings.noKills)).not.toBeInTheDocument();
    expect(screen.getByText(strings.kill)).toBeInTheDocument();
  });
});

/** Props of {@link TimelineWithDeaths}. */
interface TimelineWithDeathsProps {
  /** The view. */
  readonly view: Timeline;
}

/**
 * The chart and the list of the deaths sharing the selected death, as the timeline tab holds them.
 *
 * @returns The chart over the list.
 */
function TimelineWithDeaths({ view }: TimelineWithDeathsProps) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <>
      <TimelineChart view={view} selectedDeath={selected} onSelectDeath={setSelected} />
      <DeathList
        deaths={view.deaths}
        avoidableCount={view.avoidableCount}
        positions={view.positions}
        selected={selected}
        onSelect={setSelected}
      />
    </>
  );
}

describe('TimelineChart with DeathList', () => {
  it.each(LANGUAGES)('selects a death from the list and from its marker (%s)', async (language) => {
    const strings = STRINGS[language];
    const user = userEvent.setup();
    await renderIn(language, <TimelineWithDeaths view={testView()} />);
    const [first, second, , last] = within(screen.getByRole('list')).getAllByRole('button');
    if (first === undefined || second === undefined || last === undefined) {
      expect.unreachable('The list holds a row per death');
    }
    const selectedMarkers = () =>
      [...chart(language).querySelectorAll('[data-selected="true"]')].map(
        (marker) => marker.querySelector('title')?.textContent,
      );

    for (const row of within(screen.getByRole('list')).getAllByRole('button')) {
      expect(row).toHaveAttribute('aria-pressed', 'false');
    }
    expect(selectedMarkers()).toEqual([]);

    // A row of the list picks its death, and the chart draws its marker larger.
    await user.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(selectedMarkers()).toEqual([`${strings.death} · 8:02 · Abrams`]);

    // The pressed row lets the death go.
    await user.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'false');
    expect(selectedMarkers()).toEqual([]);

    // The pointer over a marker of the chart picks its death in the list.
    const worldDeath = markers(language, strings.death).at(-1);
    await user.hover(worldDeath ?? expect.unreachable('The chart marks the death by the world'));
    expect(last).toHaveAttribute('aria-pressed', 'true');
    expect(selectedMarkers()).toEqual([`${strings.death} · 27:15 · ${strings.world}`]);

    // The keyboard reaches the rows, the one path to the deaths that is not the pointer: the focus
    // is still on the second row, clicked last, and goes back to the first.
    await user.tab({ shift: true });
    expect(first).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(last).toHaveAttribute('aria-pressed', 'false');
    expect(selectedMarkers()).toEqual([`${strings.avoidableDeath} · 5:41 · Haze`]);
  });
});

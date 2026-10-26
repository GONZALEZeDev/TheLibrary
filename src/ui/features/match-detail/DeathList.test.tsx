/**
 * Tests of the list of the deaths of the timeline tab of the match page, rendered on its own with
 * deaths built by hand (the deaths the timeline service gives are tested with the service), in
 * English and in French: the title with the count of the deaths and of the avoidable ones, one row
 * per death with its killer, the time the killer took, the players near and the verdict, the death a
 * row picks, and the sentences that stand in for what is not known.
 *
 * Picking a death from its marker on the chart is tested with the chart. The times and the counts are
 * synthetic.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import type { Language } from '../../../core/settings/language';
import type { TimelineDeath } from '../../../services/match-timeline-view';
import { createI18n } from '../../i18n/i18n';
import { DeathList, type DeathListProps } from './DeathList';

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** The texts of the list, by language. */
const STRINGS = {
  en: {
    title: 'Your deaths · 4 · 2 avoidable',
    titleOneAvoidable: 'Your deaths · 2 · 1 avoidable',
    titleNoPositions: 'Your deaths · 2',
    titleUnknown: 'Your deaths · —',
    titleNone: 'Your deaths · 0',
    rows: [
      ['5:41', 'Killed by Haze in 2.4 s · 3 enemies near you, no ally', 'Avoidable'],
      ['8:02', 'Killed by Abrams in 4.8 s · 1 enemy near you, 1 ally', 'Even fight'],
      ['14:30', 'Killed by a hero in 1.4 s · 2 enemies near you, no ally', 'Avoidable'],
      ['27:15', 'Killed by troopers or the environment · 0 enemies near you, 3 allies', null],
    ],
    rowsNoPositions: ['Killed by Haze in 2.4 s', 'Killed by troopers or the environment'],
    words: ['Avoidable', 'Even fight'],
    nearYou: 'near you',
    none: 'No death in this match.',
    incomplete: 'Your death detail is incomplete in this match.',
    noPositions: "The other players' positions are not in this match's archive.",
    refreshScheduled: 'It will be downloaded again at the next synchronisation.',
    estimate: 'Estimate: the players close to you when you died, the killer always counted.',
  },
  fr: {
    title: 'Tes morts · 4 · dont 2 évitables',
    titleOneAvoidable: 'Tes morts · 2 · dont 1 évitable',
    titleNoPositions: 'Tes morts · 2',
    titleUnknown: 'Tes morts · —',
    titleNone: 'Tes morts · 0',
    rows: [
      ['5:41', 'Tué par Haze en 2,4 s · 3 ennemis près de toi, aucun allié', 'Évitable'],
      ['8:02', 'Tué par Abrams en 4,8 s · 1 ennemi près de toi, 1 allié', 'Combat équilibré'],
      ['14:30', 'Tué par un héros en 1,4 s · 2 ennemis près de toi, aucun allié', 'Évitable'],
      ['27:15', "Tué par les troupes ou l'environnement · 0 ennemi près de toi, 3 alliés", null],
    ],
    rowsNoPositions: ['Tué par Haze en 2,4 s', "Tué par les troupes ou l'environnement"],
    words: ['Évitable', 'Combat équilibré'],
    nearYou: 'près de toi',
    none: 'Aucune mort dans cette partie.',
    incomplete: 'Le détail de tes morts est incomplet dans cette partie.',
    noPositions: "Les positions des autres joueurs ne sont pas dans l'archive de cette partie.",
    refreshScheduled: 'Elle sera téléchargée à nouveau à la prochaine synchronisation.',
    estimate:
      'Estimation : les joueurs proches de toi au moment de ta mort, le tueur toujours compté.',
  },
} as const satisfies Record<Language, unknown>;

/** The shape that marks an avoidable death beside its word, so that the colour never does it alone. */
const AVOIDABLE_SHAPE = '▼';

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
 * Two deaths of a match whose archive has no positions, the first one and the one by the world: no
 * players near, no verdict.
 */
const DEATHS_WITHOUT_POSITIONS: readonly TimelineDeath[] = DEATHS.filter(
  ({ timeS }) => timeS === 341 || timeS === 1_635,
).map((death) => ({ ...death, enemiesNear: null, alliesNear: null, verdict: null }));

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
 * Render the list of the four deaths of {@link DEATHS}, with the positions known and no death
 * selected, unless overridden.
 *
 * @param language - The language of the interface.
 * @param overrides - Props to change.
 */
async function renderList(
  language: Language,
  overrides: Partial<DeathListProps> = {},
): Promise<void> {
  await renderIn(
    language,
    <DeathList
      deaths={DEATHS}
      avoidableCount={2}
      positions="known"
      selected={null}
      onSelect={vi.fn()}
      {...overrides}
    />,
  );
}

/**
 * The rows of the list, one button per death.
 *
 * @returns The rows, in the order of the list.
 */
function rows(): HTMLElement[] {
  return within(screen.getByRole('list')).getAllByRole('button');
}

/**
 * One row of the list.
 *
 * @param index - The index of the death.
 * @returns The row of the death.
 */
function row(index: number): HTMLElement {
  return rows()[index] ?? expect.unreachable(`The list has no row ${String(index)}`);
}

describe('DeathList', () => {
  it.each(LANGUAGES)(
    'lists every death with killer, time to kill, players near and label (%s)',
    async (language) => {
      const strings = STRINGS[language];
      await renderList(language);

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(strings.title);
      expect(rows()).toHaveLength(strings.rows.length);
      strings.rows.forEach(([time, sentence, word], index) => {
        const inRow = within(row(index));
        expect(inRow.getByText(time)).toBeInTheDocument();
        expect(inRow.getByText(sentence)).toBeInTheDocument();
        if (word === null) {
          // A death by the world is neither avoidable nor an even fight: it has no label.
          for (const label of strings.words) {
            expect(inRow.queryByText(label)).not.toBeInTheDocument();
          }
        } else {
          expect(inRow.getByText(word)).toBeInTheDocument();
        }
        // An avoidable death carries its shape beside its word.
        expect(row(index).textContent.includes(AVOIDABLE_SHAPE)).toBe(word === strings.words[0]);
      });
      // What the players near are read from, under the list.
      expect(screen.getByText(strings.estimate)).toBeInTheDocument();
      expect(screen.queryByText(strings.noPositions, { exact: false })).not.toBeInTheDocument();
    },
  );

  it.each(LANGUAGES)('counts one avoidable death in the singular (%s)', async (language) => {
    await renderList(language, { deaths: DEATHS.slice(0, 2), avoidableCount: 1 });

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      STRINGS[language].titleOneAvoidable,
    );
  });

  it.each(LANGUAGES)('selects a death from the list (%s)', async (language) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    await renderList(language, { selected: 2, onSelect });

    expect(rows().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
    // A row that is not pressed picks its death; the pressed one lets it go.
    await user.click(row(0));
    expect(onSelect).toHaveBeenLastCalledWith(0);
    await user.click(row(2));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it.each(LANGUAGES)(
    'says the positions are missing and the refresh to come (%s)',
    async (language) => {
      const strings = STRINGS[language];
      await renderList(language, {
        deaths: DEATHS_WITHOUT_POSITIONS,
        avoidableCount: null,
        positions: 'missing_refresh_scheduled',
      });

      // No avoidable count: any death may have been avoidable.
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
        new RegExp(`^${strings.titleNoPositions}$`),
      );
      strings.rowsNoPositions.forEach((sentence, index) => {
        expect(within(row(index)).getByText(sentence)).toBeInTheDocument();
      });
      // The sentence replaces the players near and the labels, and the refresh follows it.
      expect(
        screen.getByText(`${strings.noPositions} ${strings.refreshScheduled}`),
      ).toBeInTheDocument();
      expect(screen.queryByText(strings.nearYou, { exact: false })).not.toBeInTheDocument();
      for (const word of strings.words) {
        expect(screen.queryByText(word)).not.toBeInTheDocument();
      }
      expect(screen.queryByText(strings.estimate)).not.toBeInTheDocument();
    },
  );

  it.each(LANGUAGES)('says the positions are missing for good (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderList(language, {
      deaths: DEATHS_WITHOUT_POSITIONS,
      avoidableCount: null,
      positions: 'missing',
    });

    expect(screen.getByText(strings.noPositions)).toBeInTheDocument();
    expect(screen.queryByText(strings.refreshScheduled, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText(strings.estimate)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('says the death detail is incomplete (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderList(language, { deaths: null, avoidableCount: null });

    // The count is not known: a dash, never a zero.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      new RegExp(`^${strings.titleUnknown}$`),
    );
    expect(screen.getByText(strings.incomplete)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(strings.estimate)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('says there was no death (%s)', async (language) => {
    const strings = STRINGS[language];
    await renderList(language, { deaths: [], avoidableCount: 0 });

    // No avoidable count beside a count of no death.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      new RegExp(`^${strings.titleNone}$`),
    );
    expect(screen.getByText(strings.none)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    // Nothing is estimated when there is no death.
    expect(screen.queryByText(strings.estimate)).not.toBeInTheDocument();
  });
});

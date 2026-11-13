/**
 * Tests of the timeline tab of the match page: the tab on its own, rendered with views built by hand
 * (the view the timeline service gives is tested with the service), and inside the whole page, opened
 * from the address, in English and in French.
 *
 * The chart and the list of the deaths have their own tests; here, that the tab reads the view, shows
 * both for a timeline, shows the sentence or nothing for the views that have none, and holds the death
 * the two share.
 *
 * @packageDocumentation
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MatchId } from '../../../core/domain/match';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import type { ReplayView } from '../../../services/match-replay-view';
import type { TimelineDeath, TimelineTabView } from '../../../services/match-timeline-view';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import {
  ARCHIVED_ID,
  ARCHIVED_IDS,
  MISSING_ID,
  renderMatchDetail,
  STRINGS as PAGE_STRINGS,
  synchronised,
} from '../../../test/match-detail-page';
import { testMatchId } from '../../../test/test-data';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { CHART_FRAME } from './timeline-chart-geometry';
import { TimelineTab } from './TimelineTab';

/** The match of the tests that render the tab on its own. */
const MATCH_ID = testMatchId(100_000_001);

/** The list of the deaths, a region named by its title in either language (the bar has buttons too). */
const DEATH_LIST = { name: /^(Your deaths|Tes morts)/ };

/** The rows of the list of the deaths: the buttons of its region. */
const deathButtons = () => within(screen.getByRole('region', DEATH_LIST)).getAllByRole('button');

/** The view of a timeline. */
type Timeline = Extract<TimelineTabView, { kind: 'timeline' }>;

/** The texts of the tab, by language. */
const STRINGS = {
  en: {
    tabs: ['Analysis', 'Timeline', 'Damage and build', 'Players'],
    chartTitle: 'Souls over the match',
    deathsTitle: 'Your deaths · 2 · 1 avoidable',
    unreadable: 'This match cannot be read.',
    storageError: 'Local data could not be read or saved.',
  },
  fr: {
    tabs: ['Analyse', 'Chronologie', 'Dégâts et build', 'Joueurs'],
    chartTitle: 'Âmes au fil de la partie',
    deathsTitle: 'Tes morts · 2 · dont 1 évitable',
    unreadable: 'Impossible de lire cette partie.',
    storageError: "Impossible de lire ou d'enregistrer les données locales.",
  },
} as const satisfies Record<Language, Record<string, string | readonly string[]>>;

/** The languages of the interface, for the tests that run in each. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** Two deaths, one of them avoidable. */
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
];

/** The view of a timeline of a match of 32:14, with the two deaths of {@link DEATHS}. */
function timelineView(): Timeline {
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
        { timeS: 1_934, souls: 38_000 },
      ],
      opponents: [
        { timeS: 0, souls: 0 },
        { timeS: 1_934, souls: 36_000 },
      ],
      opponentCount: 1,
    },
    kills: [{ timeS: 400, victim: { heroId: 13, name: 'Haze' } }],
    purchases: [],
    deaths: DEATHS,
    avoidableCount: 1,
    positions: 'known',
  };
}

/** A replay of the match of {@link timelineView}: a map and one player, still at the middle of it. */
function replayView(): ReplayView {
  return {
    kind: 'replay',
    durationS: 1_934,
    trackedTeam: 'hidden_king',
    coverage: 'all',
    map: {
      imageUrl: 'https://assets-bucket.deadlock-api.com/map.png',
      lanes: [],
      midBoss: { left: 0.5, top: 0.5 },
    },
    players: [
      {
        slot: 1,
        side: 'ally',
        team: 'hidden_king',
        isTracked: true,
        heroId: 1,
        heroName: 'Paige',
        iconUrl: null,
        hasPath: true,
        positions: Array.from({ length: 1_935 }, () => ({ left: 0.5, top: 0.5 })),
        health: [],
        deaths: [],
      },
    ],
    objectives: [],
    midBossKills: [],
    midBossReturnsS: [],
  };
}

/**
 * Render the tab for a match whose timeline view is the one given, and wait until it has been read.
 *
 * @param view - The view the service gives, or the error it fails with.
 * @param language - The language of the interface; English by default.
 * @param replay - The replay the service gives; none (not archived) by default.
 * @returns The root of the render.
 */
async function renderTimelineTab(
  view: TimelineTabView | AppError,
  language: Language = 'en',
  replay: ReplayView = { kind: 'not_archived' },
): Promise<HTMLElement> {
  const { services } = createTestServices();
  vi.spyOn(services.replay, 'getReplay').mockResolvedValue(replay);
  const read = vi.spyOn(services.timeline, 'getTimelineTab');
  if (view instanceof AppError) {
    read.mockRejectedValue(view);
  } else {
    read.mockResolvedValue(view);
  }
  const queryClient = createTestQueryClient();
  const i18n = await createI18n(language);
  const { container } = render(
    <AppProviders services={services} queryClient={queryClient} i18n={i18n}>
      <TimelineTab matchId={MATCH_ID} />
    </AppProviders>,
  );
  // The view is read from the service, so it comes a moment after the first render.
  await waitFor(() => {
    expect(read).toHaveBeenCalledWith(MATCH_ID);
    expect(queryClient.isFetching()).toBe(0);
  });
  return container;
}

describe('TimelineTab', () => {
  it.each(LANGUAGES)(
    'shows the chart and the deaths of an archived match, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderTimelineTab(timelineView(), language);

      // Two sections, each named by its title: the chart first, then the list of the deaths.
      const headings = await screen.findAllByRole('heading', { level: 2 });
      expect(headings.map((heading) => heading.textContent)).toEqual([
        strings.chartTitle,
        strings.deathsTitle,
      ]);
      expect(screen.getByRole('img', { name: strings.chartTitle })).toBeInTheDocument();
      expect(screen.getAllByRole('region')).toHaveLength(2);
      expect(screen.getAllByRole('button')).toHaveLength(DEATHS.length);
    },
  );

  it('picks a death in the list for the chart, and lets it go', async () => {
    const user = userEvent.setup();
    await renderTimelineTab(timelineView());
    const chart = await screen.findByRole('img', { name: STRINGS.en.chartTitle });
    const selectedMarkers = () =>
      [...chart.querySelectorAll('[data-selected="true"]')].map(
        (marker) => marker.querySelector('title')?.textContent,
      );
    expect(selectedMarkers()).toEqual([]);

    const [first] = screen.getAllByRole('button');
    if (first === undefined) {
      throw new Error('The list has a row per death');
    }
    await user.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(selectedMarkers()).toEqual(['Avoidable death · 5:41 · Haze']);

    await user.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(selectedMarkers()).toEqual([]);
  });

  it.each(LANGUAGES)('says the match cannot be read, in %s', async (language) => {
    await renderTimelineTab({ kind: 'unreadable' }, language);

    expect(await screen.findByText(STRINGS[language].unreadable)).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows nothing for a match whose detail is not archived', async () => {
    const container = await renderTimelineTab({ kind: 'not_archived' });

    // The analysis above the tabs says why there is nothing.
    expect(container).toBeEmptyDOMElement();

    // The control: after the same wait, a timeline has rendered, so the empty page above is the page
    // of the view and not the page before the view came.
    cleanup();
    const ready = await renderTimelineTab(timelineView());
    expect(ready).not.toBeEmptyDOMElement();
  });

  it('says why the tab could not be read when the service fails', async () => {
    await renderTimelineTab(new AppError('storage', 'The database failed'));

    expect(await screen.findByRole('alert')).toHaveTextContent(STRINGS.en.storageError);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});

describe('TimelineTab replay', () => {
  /** The slider of the playback bar, once the replay has been read. */
  const slider = () => screen.findByRole('slider', { name: 'Time in the match' });

  it('picking a death moves the cursor 5 s before it', async () => {
    const user = userEvent.setup();
    await renderTimelineTab(timelineView(), 'en', replayView());
    expect(await slider()).toHaveValue('0');

    const [first, second] = deathButtons();
    if (first === undefined || second === undefined) {
      throw new Error('The list has a row per death');
    }
    // The first death is at 341 s, the second at 482 s.
    await user.click(first);
    expect(await slider()).toHaveValue('336');
    await user.click(second);
    expect(await slider()).toHaveValue('477');
  });

  it('hovering a death marker on the chart highlights its row and does not move the cursor', async () => {
    const user = userEvent.setup();
    await renderTimelineTab(timelineView(), 'en', replayView());
    expect(await slider()).toHaveValue('0');
    const chart = screen.getByRole('img', { name: STRINGS.en.chartTitle });
    const marker = [...chart.querySelectorAll('[data-selected]')].find(
      (node) => node.querySelector('title')?.textContent === 'Avoidable death · 5:41 · Haze',
    );
    if (marker === undefined) throw new Error('The chart has a marker for the first death');

    await user.hover(marker);
    const [first] = deathButtons();
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(await slider()).toHaveValue('0');
  });

  it('letting a death go does not move the cursor', async () => {
    const user = userEvent.setup();
    await renderTimelineTab(timelineView(), 'en', replayView());
    await slider();
    const [first] = deathButtons();
    if (first === undefined) throw new Error('The list has a row per death');
    await user.click(first);
    expect(await slider()).toHaveValue('336');

    // The second click on the same row lets the death go: the cursor stays where it is.
    await user.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(await slider()).toHaveValue('336');
  });

  it('clicking the chart seeks the map', async () => {
    const user = userEvent.setup();
    await renderTimelineTab(timelineView(), 'en', replayView());
    await slider();
    const chart = screen.getByRole('img', { name: STRINGS.en.chartTitle });
    // jsdom has no layout: give the picture a box of the same size as its frame.
    chart.getBoundingClientRect = () => new DOMRect(0, 0, CHART_FRAME.width, CHART_FRAME.height);
    const { left, right } = CHART_FRAME;
    await user.pointer({
      keys: '[MouseLeft]',
      target: chart,
      coords: { clientX: (left + right) / 2, clientY: 50 },
    });

    // Half of the match of 1934 s.
    await waitFor(() => {
      expect(Number(screen.getByRole<HTMLInputElement>('slider').value)).toBeCloseTo(967, -1);
    });
  });

  it('moves the cursor with the arrow keys only when the replay section is focused', async () => {
    const user = userEvent.setup();
    await renderTimelineTab(timelineView(), 'en', replayView());
    expect(await slider()).toHaveValue('0');

    await user.keyboard('{ArrowRight}');
    expect(await slider()).toHaveValue('0');

    screen.getByRole('region', { name: 'Match replay' }).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(await slider()).toHaveValue('2');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(await slider()).toHaveValue('12');
  });

  it('shows no replay for a match that is not archived, and keeps the death list', async () => {
    await renderTimelineTab(timelineView());

    expect(screen.queryByRole('region', { name: 'Match replay' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(deathButtons()).toHaveLength(DEATHS.length);
  });
});

describe('the timeline tab in the match page', () => {
  it('opens the timeline tab from the address', async () => {
    const testServices = await synchronised();
    const { router } = await renderMatchDetail(ARCHIVED_ID, testServices, { tab: 'timeline' });

    const selected = await screen.findByRole('tab', { selected: true });
    expect(selected).toHaveAccessibleName('Timeline');
    expect(router.state.location.search).toEqual({ tab: 'timeline' });
    // The panel is named by its tab, and holds the chart of the match read from its archive.
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAccessibleName('Timeline');
    // Read in one go: the chart is drawn alone first, then moved next to the map once the replay is
    // read, which draws it again. An element found before the move would be gone after it.
    await waitFor(() => {
      expect(within(panel).getByRole('img', { name: STRINGS.en.chartTitle })).toBeInTheDocument();
    });
  });

  it.each(LANGUAGES)('shows the timeline tab second, in %s', async (language) => {
    const testServices = await synchronised();
    await renderMatchDetail(ARCHIVED_ID, testServices, { language });

    await screen.findByRole('tab', { selected: true });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(
      STRINGS[language].tabs,
    );
  });

  it('opens the timeline tab by a click and keeps it in the address', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();
    const { router } = await renderMatchDetail(ARCHIVED_ID, testServices);

    await user.click(await screen.findByRole('tab', { name: 'Timeline' }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'timeline' });
    });
    expect(await screen.findByRole('img', { name: STRINGS.en.chartTitle })).toBeInTheDocument();
  });

  it('has no tabs for a match with no archive', async () => {
    const testServices = await synchronised();
    const read = vi.spyOn(testServices.services.timeline, 'getTimelineTab');
    await renderMatchDetail(MISSING_ID, testServices, { tab: 'timeline' });

    // The page has settled on the state of a match waiting for its detail, and only then are the
    // tabs looked for.
    expect(await screen.findByText(PAGE_STRINGS.en.waiting)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('picks no death when the page goes to another match', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();
    const [first, second] = ARCHIVED_IDS;
    if (first === undefined || second === undefined) {
      throw new Error('The synthetic history archives two matches');
    }
    const goTo = async (
      router: Awaited<ReturnType<typeof renderMatchDetail>>['router'],
      matchId: MatchId,
    ) => {
      await router.navigate({
        to: '/matches/$matchId',
        params: { matchId },
        search: { tab: 'timeline' },
      });
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/matches/${String(matchId)}`);
      });
    };
    const deathRows = async () => {
      await screen.findByRole('region', DEATH_LIST);
      return deathButtons();
    };
    const selectedMarkers = async () =>
      (await screen.findByRole('img', { name: STRINGS.en.chartTitle })).querySelectorAll(
        '[data-selected="true"]',
      ).length;

    // The second match is read first, so that the page finds its timeline cached when it comes
    // back: nothing but the page itself then resets what the player picked.
    const { router } = await renderMatchDetail(second, testServices, { tab: 'timeline' });
    await deathRows();
    await goTo(router, first);

    // A death is picked in the first match: the row is pressed and its marker is drawn larger.
    const [row] = await deathRows();
    if (row === undefined) {
      throw new Error('The first match has a death to pick');
    }
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(await selectedMarkers()).toBe(1);

    await goTo(router, second);

    // The second match is on the page, with deaths of its own, and none of them is picked.
    const rows = await deathRows();
    for (const next of rows) {
      expect(next).toHaveAttribute('aria-pressed', 'false');
    }
    expect(await selectedMarkers()).toBe(0);
  });
});

/**
 * Tests of the replay section of the timeline tab, rendered on its own with a replay built by hand,
 * a chart stand-in and a playback whose controls are spies: what shows for each state of the
 * replay (loading, not archived, unreadable, no map, no positions, only the tracked player), the
 * keyboard of the focused section, and the texts in English and in French.
 *
 * @packageDocumentation
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Language } from '../../../../core/settings/language';
import type { ReplayView, ReplayViewPlayer } from '../../../../services/match-replay-view';
import { createTestQueryClient, createTestServices } from '../../../../test/create-test-services';
import { testMatchId } from '../../../../test/test-data';
import { AppProviders } from '../../../app/AppProviders';
import { createI18n } from '../../../i18n/i18n';
import type { ReplayData } from './replay-model';
import { ReplaySection } from './ReplaySection';
import type { Playback } from './use-playback';

/** The match of the tests. */
const MATCH_ID = testMatchId(100_000_001);

/** The texts of the section, by language. */
const STRINGS = {
  en: {
    title: 'Match replay',
    mapTitle: 'Match map',
    mapUnavailable: 'The map is not available right now, but the rest of the replay is.',
    noPositions: "The players' paths are not in this match's archive, so the map cannot be drawn.",
    trackedOnly: "Only your path is in this match's archive, so only you are drawn on the map.",
    unreadable: 'The replay of this match could not be read.',
    slider: 'Time in the match',
  },
  fr: {
    title: 'Replay du match',
    mapTitle: 'Carte du match',
    mapUnavailable: "La carte n'est pas disponible pour le moment, mais le reste du replay l'est.",
    noPositions:
      "Les trajets des joueurs ne sont pas dans l'archive de cette partie : la carte ne peut pas être dessinée.",
    trackedOnly:
      "Seul ton trajet est dans l'archive de cette partie : tu es le seul dessiné sur la carte.",
    unreadable: "Le replay de cette partie n'a pas pu être lu.",
    slider: 'Moment de la partie',
  },
} as const satisfies Record<Language, Record<string, string>>;

/** The languages of the interface. */
const LANGUAGES = ['en', 'fr'] as const satisfies readonly Language[];

/** A player of the replay, alive and still at the middle of the map for ten seconds. */
function player(overrides: Partial<ReplayViewPlayer> = {}): ReplayViewPlayer {
  return {
    slot: 1,
    side: 'ally',
    team: overrides.side === 'enemy' ? 'archmother' : 'hidden_king',
    isTracked: true,
    heroId: 1,
    heroName: 'Haze',
    iconUrl: null,
    hasPath: true,
    positions: Array.from({ length: 11 }, () => ({ left: 0.5, top: 0.5 })),
    health: [],
    deaths: [],
    ...overrides,
  };
}

/** A replay of ten seconds with a map, one player and no objective. */
function replayView(overrides: Partial<ReplayData> = {}): ReplayData {
  return {
    kind: 'replay',
    durationS: 10,
    trackedTeam: 'hidden_king',
    coverage: 'all',
    map: {
      imageUrl: 'https://assets-bucket.deadlock-api.com/map.png',
      lanes: [],
      midBoss: { left: 0.5, top: 0.5 },
    },
    players: [player()],
    objectives: [],
    midBossKills: [],
    midBossReturnsS: [],
    ...overrides,
  };
}

/** A playback at a moment whose controls are spies. */
function playbackAt(timeS = 3): Playback {
  return {
    timeS,
    playing: false,
    speed: 1,
    seek: vi.fn<(timeS: number) => void>(),
    step: vi.fn<(deltaS: number) => void>(),
    toggle: vi.fn<() => void>(),
    setSpeed: vi.fn(),
  };
}

/**
 * Render the section for a replay, and wait until the replay has been read.
 *
 * @param view - The view the replay service gives.
 * @param language - The language of the interface; English by default.
 * @param playback - The playback; at 3 s by default.
 * @returns The playback given.
 */
async function renderSection(
  view: ReplayView,
  language: Language = 'en',
  playback: Playback = playbackAt(),
): Promise<Playback> {
  const { services } = createTestServices();
  const read = vi.spyOn(services.replay, 'getReplay').mockResolvedValue(view);
  const queryClient = createTestQueryClient();
  const i18n = await createI18n(language);
  render(
    <AppProviders services={services} queryClient={queryClient} i18n={i18n}>
      <ReplaySection
        matchId={MATCH_ID}
        playback={playback}
        trackedKills={[]}
        chart={<div data-testid="chart">chart</div>}
      />
    </AppProviders>,
  );
  await waitFor(() => {
    expect(read).toHaveBeenCalledWith(MATCH_ID);
    expect(queryClient.isFetching()).toBe(0);
  });
  return playback;
}

describe('ReplaySection', () => {
  it('shows the chart alone when the match is not archived', async () => {
    await renderSection({ kind: 'not_archived' });

    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByText(STRINGS.en.unreadable)).not.toBeInTheDocument();
  });

  it('shows the chart and the sentence of an archive that cannot be read', async () => {
    await renderSection({ kind: 'unreadable' });

    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.getByText(STRINGS.en.unreadable)).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)('shows the map, the chart, the panel and the bar, in %s', async (language) => {
    const strings = STRINGS[language];
    await renderSection(replayView(), language);

    expect(screen.getByRole('region', { name: strings.title })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: strings.mapTitle })).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: strings.slider })).toBeInTheDocument();
    // The panel is titled by the moment of the cursor.
    // The v1 "At 14:05" panel is gone; the cards of layout A stand in its place.
    expect(screen.queryByText(/^At 0:03$/)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.mapUnavailable)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.trackedOnly)).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)(
    'shows the map-unavailable sentence and still renders the playback bar, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderSection(replayView({ map: null }), language);

      expect(screen.getByText(strings.mapUnavailable)).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: strings.mapTitle })).not.toBeInTheDocument();
      expect(screen.getByRole('slider', { name: strings.slider })).toBeInTheDocument();
      expect(screen.getByTestId('chart')).toBeInTheDocument();
    },
  );

  it('shows the no-positions sentence in place of the map', async () => {
    await renderSection(replayView({ coverage: 'none' }));

    expect(screen.getByText(STRINGS.en.noPositions)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: STRINGS.en.mapTitle })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: STRINGS.en.slider })).toBeInTheDocument();
  });

  it.each(LANGUAGES)(
    'says that only the tracked player is drawn on a format-1 archive, in %s',
    async (language) => {
      const strings = STRINGS[language];
      await renderSection(replayView({ coverage: 'tracked_only' }), language);

      expect(screen.getByText(strings.trackedOnly)).toBeInTheDocument();
      expect(screen.getByRole('img', { name: strings.mapTitle })).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: strings.slider })).toBeInTheDocument();
    },
  );

  it('moves the cursor with the arrow keys and Space only when the section is focused', async () => {
    const user = userEvent.setup();
    const playback = await renderSection(replayView());
    const section = screen.getByRole('region', { name: STRINGS.en.title });
    expect(section).toHaveAttribute('tabindex', '0');

    // Nothing has the focus: the keys go to the page and the replay does not move.
    await user.keyboard('{ArrowRight}{ArrowLeft} ');
    expect(playback.step).not.toHaveBeenCalled();
    expect(playback.toggle).not.toHaveBeenCalled();

    section.focus();
    await user.keyboard('{ArrowRight}');
    expect(playback.step).toHaveBeenLastCalledWith(1);
    await user.keyboard('{ArrowLeft}');
    expect(playback.step).toHaveBeenLastCalledWith(-1);
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(playback.step).toHaveBeenLastCalledWith(10);
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(playback.step).toHaveBeenLastCalledWith(-10);
    await user.keyboard(' ');
    expect(playback.toggle).toHaveBeenCalledTimes(1);
  });

  it('leaves Space and the plain arrows to the controls that need them', async () => {
    const user = userEvent.setup();
    const playback = await renderSection(replayView());

    // The slider keeps its own plain arrows: the section does not step on top of them.
    screen.getByRole('slider', { name: STRINGS.en.slider }).focus();
    await user.keyboard('{ArrowRight}');
    expect(playback.step).not.toHaveBeenCalled();

    // A button keeps Space as a click: the section does not toggle on top of it.
    screen.getByRole('button', { name: 'Speed ×4' }).focus();
    await user.keyboard(' ');
    expect(playback.toggle).not.toHaveBeenCalled();
    expect(playback.setSpeed).toHaveBeenCalledWith(4);
  });

  it('keeps the arrows working once a button of the bar has the focus', async () => {
    const user = userEvent.setup();
    const playback = await renderSection(replayView());

    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Play' })).toHaveFocus();
    (playback.step as ReturnType<typeof vi.fn>).mockClear();

    await user.keyboard('{ArrowRight}');
    expect(playback.step).toHaveBeenLastCalledWith(1);
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(playback.step).toHaveBeenLastCalledWith(-10);
  });

  it('handles Shift + arrows and Space on the slider, and keeps its plain arrows', async () => {
    const user = userEvent.setup();
    const playback = await renderSection(replayView());
    const slider = screen.getByRole('slider', { name: STRINGS.en.slider });
    slider.focus();

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(playback.step).toHaveBeenLastCalledWith(10);
    // The section prevented the default, so the slider did not also move by one second.
    expect(playback.seek).not.toHaveBeenCalled();

    await user.keyboard(' ');
    expect(playback.toggle).toHaveBeenCalledTimes(1);
  });

  it('does not toggle twice when Space is pressed on a button', async () => {
    const user = userEvent.setup();
    const playback = await renderSection(replayView());

    screen.getByRole('button', { name: 'Play' }).focus();
    await user.keyboard(' ');
    // The button's own click calls `toggle` once; the section adds nothing.
    expect(playback.toggle).toHaveBeenCalledTimes(1);
  });
});

/** A replay with twelve players (six per team) and a few deaths, for the layout tests. */
function fullReplay(overrides: Partial<ReplayData> = {}): ReplayData {
  const players = Array.from({ length: 12 }, (_, index) =>
    player({
      slot: index + 1,
      side: index < 6 ? 'ally' : 'enemy',
      isTracked: index === 0,
      heroName: `Hero${String(index + 1)}`,
      deaths:
        index === 1
          ? [{ timeS: 5, respawnS: 20, killerSlot: 8 }]
          : index === 7
            ? [{ timeS: 6, respawnS: 21, killerSlot: 1 }]
            : [],
    }),
  );
  return replayView({ durationS: 60, players, ...overrides });
}

/** The cards of layout A are named sections; the strip and the feed hold the fixed slots. */
describe('ReplaySection layout A', () => {
  it('layout A renders the strip, the map column with the history, and the right column with the feed and the reminder', async () => {
    await renderSection(fullReplay());
    const section = screen.getByRole('region', { name: STRINGS.en.title });

    const strip = within(section).getByRole('region', { name: 'Players' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(12);
    const history = within(section).getByRole('region', { name: 'Objectives history' });
    const feed = within(section).getByRole('region', { name: 'Live feed' });
    const map = within(section).getByRole('img', { name: STRINGS.en.mapTitle });
    const chart = within(section).getByTestId('chart');
    const rules = within(section).getByRole('heading', { name: 'Game rules' });
    const slider = within(section).getByRole('slider', { name: STRINGS.en.slider });

    // Order in the document: strip, then the map column (map, history), then the right column
    // (chart, feed, reminder), then the bar.
    const follows = (first: Element, second: Element) =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(strip, map)).toBe(true);
    expect(follows(map, history)).toBe(true);
    expect(follows(history, chart)).toBe(true);
    expect(follows(chart, feed)).toBe(true);
    expect(follows(feed, rules)).toBe(true);
    expect(follows(rules, slider)).toBe(true);
  });

  it('wires the objectives history to the playback seek', async () => {
    const user = userEvent.setup();
    const playback = await renderSection(
      fullReplay({
        objectives: [
          {
            side: 'enemy',
            team: 'archmother',
            identity: { kind: 'walker', lane: 1, index: null },
            position: null,
            destroyedAtS: 30,
          },
        ],
      }),
    );
    const history = screen.getByRole('region', { name: 'Objectives history' });
    await user.click(within(history).getAllByRole('button').at(0) ?? history);
    expect(playback.seek).toHaveBeenCalledTimes(1);
  });

  it('the map-unavailable sentence keeps every other card', async () => {
    await renderSection(fullReplay({ map: null }));

    expect(screen.getByText(STRINGS.en.mapUnavailable)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Players' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Objectives history' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Live feed' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Game rules' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: STRINGS.en.slider })).toBeInTheDocument();
  });

  it('keeps every other card when no position is known', async () => {
    await renderSection(fullReplay({ coverage: 'none' }));

    expect(screen.getByText(STRINGS.en.noPositions)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Players' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Objectives history' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Live feed' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Game rules' })).toBeInTheDocument();
  });

  it('the section height does not change between two seconds with different event counts', async () => {
    /** The structure that fixes the height: the strip slots and the feed line slots. */
    const slotCounts = () => ({
      strip: within(screen.getByRole('region', { name: 'Players' })).getAllByRole('listitem')
        .length,
      feed: within(screen.getByRole('region', { name: 'Live feed' })).getAllByRole('listitem')
        .length,
    });

    // Second 3: no death yet, so the feed is empty. Second 30: two deaths and some health.
    const view = fullReplay();
    await renderSection(view, 'en', playbackAt(3));
    const atThree = slotCounts();
    cleanup();
    await renderSection(view, 'en', playbackAt(30));
    const atThirty = slotCounts();

    expect(atThree).toEqual({ strip: 12, feed: 5 });
    expect(atThirty).toEqual(atThree);
  });
});

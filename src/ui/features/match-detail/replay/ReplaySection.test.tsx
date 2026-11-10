/**
 * Tests of the replay section of the timeline tab, rendered on its own with a replay built by hand,
 * a chart stand-in and a playback whose controls are spies: what shows for each state of the
 * replay (loading, not archived, unreadable, no map, no positions, only the tracked player), the
 * keyboard of the focused section, and the texts in English and in French.
 *
 * @packageDocumentation
 */
import { render, screen, waitFor } from '@testing-library/react';
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
    unreadable: 'This match cannot be read.',
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
    unreadable: 'Impossible de lire cette partie.',
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
    isTracked: true,
    heroId: 1,
    heroName: 'Haze',
    iconUrl: null,
    hasPath: true,
    positions: Array.from({ length: 11 }, () => ({ left: 0.5, top: 0.5 })),
    deaths: [],
    ...overrides,
  };
}

/** A replay of ten seconds with a map, one player and no objective. */
function replayView(overrides: Partial<ReplayData> = {}): ReplayData {
  return {
    kind: 'replay',
    durationS: 10,
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
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(/0:03/);
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
      expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
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

  it('leaves the keys of a control inside the section to the control', async () => {
    const user = userEvent.setup();
    const playback = await renderSection(replayView());

    // The slider keeps its own arrows: the section does not step on top of them.
    screen.getByRole('slider', { name: STRINGS.en.slider }).focus();
    await user.keyboard('{ArrowRight}');
    expect(playback.step).not.toHaveBeenCalled();

    // A button keeps Space as a click: the section does not toggle on top of it.
    screen.getByRole('button', { name: 'Speed ×4' }).focus();
    await user.keyboard(' ');
    expect(playback.toggle).not.toHaveBeenCalled();
    expect(playback.setSpeed).toHaveBeenCalledWith(4);
  });
});

/**
 * Tests of the playback bar of the replay, rendered on its own with a replay built by hand and a
 * playback whose controls are spies: the slider, the previous / next event buttons, the speeds, the
 * icons of the three tracks, their separators, the legend and the click on a marker.
 *
 * @packageDocumentation
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { GAME_ICONS } from '../../../../core/match-map/game-icons';
import type { ObjectiveKind } from '../../../../core/match-map/map-objectives';
import type { ReplayViewPlayer } from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import { PlaybackBar } from './PlaybackBar';
import type { ReplayData } from './replay-model';
import type { Playback } from './use-playback';

/** A player of the replay, with deaths and no path needed; the team follows the side. */
function player(overrides: Partial<ReplayViewPlayer>): ReplayViewPlayer {
  const side = overrides.side ?? 'ally';
  return {
    slot: 1,
    side,
    team: side === 'ally' ? 'hidden_king' : 'archmother',
    isTracked: false,
    heroId: 1,
    heroName: 'Haze',
    iconUrl: null,
    hasPath: false,
    positions: [],
    health: [],
    deaths: [],
    ...overrides,
  };
}

/** A fallen objective of a kind; the team follows the side. */
function objective(
  side: 'ally' | 'enemy',
  kind: ObjectiveKind,
  destroyedAtS: number,
): ReplayData['objectives'][number] {
  return {
    side,
    team: side === 'ally' ? 'hidden_king' : 'archmother',
    identity: { kind, lane: null, index: null },
    position: null,
    destroyedAtS,
  };
}

/** A replay of 20 minutes: two deaths, one of each kind of objective, a Mid Boss kill and return. */
function testView(): ReplayData {
  return {
    kind: 'replay',
    durationS: 1200,
    trackedTeam: 'hidden_king',
    coverage: 'all',
    map: null,
    players: [
      player({
        slot: 1,
        side: 'ally',
        heroName: 'Haze',
        deaths: [{ timeS: 300, respawnS: 330, killerSlot: null }],
      }),
      player({
        slot: 7,
        side: 'enemy',
        heroName: 'Abrams',
        deaths: [{ timeS: 400, respawnS: 440, killerSlot: null }],
      }),
    ],
    objectives: [
      objective('enemy', 'walker', 754),
      objective('ally', 'guardian', 250),
      objective('enemy', 'base_guardian', 840),
      objective('enemy', 'titan', 900),
      objective('ally', 'core', 960),
      objective('ally', 'shrine', 1020),
    ],
    midBossKills: [
      {
        timeS: 900,
        killedBy: 'ally',
        claimedBy: 'enemy',
        killedByTeam: 'hidden_king',
        claimedByTeam: 'archmother',
      },
    ],
    midBossReturnsS: [1100],
  };
}

/** The masked icon span (a tinted `GameIcon`) inside a marker button. */
function maskOf(marker: HTMLElement): HTMLElement {
  const span = marker.querySelector<HTMLElement>('span');
  if (span === null) throw new Error('the marker has no masked icon');
  return span;
}

/** A playback whose controls are spies. */
function testPlayback(overrides: Partial<Playback> = {}): Playback {
  return {
    timeS: 100,
    playing: false,
    speed: 1,
    seek: vi.fn(),
    step: vi.fn(),
    toggle: vi.fn(),
    setSpeed: vi.fn(),
    ...overrides,
  };
}

/** Render the bar in English. */
async function renderBar(
  playback: Playback,
  stepTimes: readonly number[] = [50, 300, 754],
): Promise<void> {
  const i18n = await createI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <PlaybackBar view={testView()} playback={playback} stepTimes={stepTimes} />
    </I18nextProvider>,
  );
}

describe('PlaybackBar', () => {
  it('the slider steps by one second and seeks', async () => {
    const playback = testPlayback({ timeS: 100.6 });
    await renderBar(playback);
    const slider = screen.getByRole('slider', { name: 'Time in the match' });
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '1200');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveValue('100');
    expect(screen.getByText('1:40 / 20:00')).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '250' } });
    expect(playback.seek).toHaveBeenCalledWith(250);
  });

  it('⏭ jumps to the next step event, ⏮ to the previous', async () => {
    const user = userEvent.setup();
    const playback = testPlayback({ timeS: 100 });
    await renderBar(playback);
    await user.click(screen.getByRole('button', { name: 'Next event' }));
    expect(playback.seek).toHaveBeenLastCalledWith(300);
    await user.click(screen.getByRole('button', { name: 'Previous event' }));
    expect(playback.seek).toHaveBeenLastCalledWith(50);
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(playback.toggle).toHaveBeenCalled();
  });

  it('disables the step buttons when there is no event that way', async () => {
    await renderBar(testPlayback({ timeS: 0 }), [300]);
    expect(screen.getByRole('button', { name: 'Previous event' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next event' })).toBeEnabled();
  });

  it('speed buttons switch ×1/×4/×10', async () => {
    const user = userEvent.setup();
    const playback = testPlayback({ speed: 4 });
    await renderBar(playback);
    expect(screen.getByRole('button', { name: 'Speed ×4' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Speed ×1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.click(screen.getByRole('button', { name: 'Speed ×10' }));
    expect(playback.setSpeed).toHaveBeenCalledWith(10);
  });

  it('a death is a skull tinted by the team of the victim, whatever the side', async () => {
    const user = userEvent.setup();
    const playback = testPlayback();
    await renderBar(playback);
    const ally = screen.getByTitle('Haze · ally · 5:00');
    const enemy = screen.getByTitle('Abrams · enemy · 6:40');
    // The skull is masked and filled with the team colour; the side no longer changes the shape.
    expect(maskOf(ally).style.maskImage).toContain(GAME_ICONS.death);
    expect(maskOf(ally)).toHaveClass('bg-team-hidden-king');
    expect(maskOf(enemy).style.maskImage).toContain(GAME_ICONS.death);
    expect(maskOf(enemy)).toHaveClass('bg-team-archmother');
    expect(ally).not.toHaveAttribute('data-shape');
    await user.click(enemy);
    expect(playback.seek).toHaveBeenCalledWith(400);
  });

  it('an objective and a death of the same team do not share an icon', async () => {
    await renderBar(testPlayback());
    const walker = maskOf(screen.getByTitle('Walker · enemy · 12:34'));
    const death = maskOf(screen.getByTitle('Abrams · enemy · 6:40'));
    expect(walker).toHaveClass('bg-team-archmother');
    expect(death).toHaveClass('bg-team-archmother');
    expect(walker.style.maskImage).toContain(GAME_ICONS.walker);
    expect(walker.style.maskImage).not.toBe(death.style.maskImage);
  });

  it('draws the icon of each objective kind in the colour of its team', async () => {
    await renderBar(testPlayback());
    // Guardians and base guardians use the guardian icon; walkers the walker icon.
    const guardian = maskOf(screen.getByTitle('Guardian · ally · 4:10'));
    expect(guardian.style.maskImage).toContain(GAME_ICONS.guardian);
    expect(guardian).toHaveClass('bg-team-hidden-king');
    const baseGuardian = maskOf(screen.getByTitle('Base Guardian · enemy · 14:00'));
    expect(baseGuardian.style.maskImage).toContain(GAME_ICONS.guardian);
    expect(baseGuardian).toHaveClass('bg-team-archmother');
    // The Titan, the Core and the Shrine are drawn glyphs, outlined or filled by team.
    const titan = screen.getByTitle('Titan · enemy · 15:00').querySelector('path');
    expect(titan?.getAttribute('class')).toContain('stroke-team-archmother');
    const core = screen.getByTitle('Patron · ally · 16:00').querySelector('polygon');
    expect(core?.getAttribute('class')).toContain('fill-team-hidden-king');
    const shrine = screen.getByTitle('Shrine · ally · 17:00').querySelector('polygon');
    expect(shrine?.getAttribute('fill')).toBe('none');
    expect(shrine?.getAttribute('class')).toContain('stroke-team-hidden-king');
  });

  it('the Mid Boss kill takes the killer team colour, the return is neutral and faded', async () => {
    await renderBar(testPlayback());
    const kill = screen.getByTitle(
      'Mid Boss killed by your team, claimed by the enemy team · 15:00',
    );
    expect(maskOf(kill).style.maskImage).toContain(GAME_ICONS.mid_boss);
    expect(maskOf(kill)).toHaveClass('bg-team-hidden-king');
    const back = screen.getByTitle('Mid Boss is back · 18:20');
    expect(maskOf(back).style.maskImage).toContain(GAME_ICONS.mid_boss);
    expect(maskOf(back)).toHaveClass('bg-fg-muted');
    expect(back).toHaveClass('opacity-50');
    expect(document.querySelector('.bg-accent-bright, .bg-loss')).toBeNull();
  });

  it('track titles sit in their own column, never over a marker', async () => {
    await renderBar(testPlayback());
    const grid = document.querySelector('[data-track="objectives"]')?.parentElement;
    expect(grid).toHaveClass('grid');
    for (const id of ['objectives', 'midBoss', 'deaths']) {
      const title = document.querySelector(`[data-track-title="${id}"]`);
      const track = document.querySelector(`[data-track="${id}"]`);
      expect(title).not.toBeNull();
      // Separate cells of the same grid: the title holds no marker and is not inside the track.
      expect(title?.parentElement).toBe(grid);
      expect(track?.parentElement).toBe(grid);
      expect(title?.querySelector('button')).toBeNull();
      expect(track?.contains(title)).toBe(false);
    }
    expect(document.querySelector('[data-track-title="midBoss"]')).toHaveTextContent('Mid Boss');
  });

  it('has no schedule track', async () => {
    await renderBar(testPlayback());
    expect(document.querySelector('[data-track="schedule"]')).toBeNull();
    expect(document.querySelector('[data-track-title="schedule"]')).toBeNull();
    expect(screen.queryByTitle(/Unstable Rift/)).toBeNull();
    expect(screen.queryByTitle(/Trooper waves/)).toBeNull();
  });

  it('separates the tracks with a thin border line', async () => {
    await renderBar(testPlayback());
    for (const id of ['objectives', 'midBoss', 'deaths']) {
      expect(document.querySelector(`[data-track-title="${id}"]`)).toHaveClass(
        'border-b',
        'border-border',
      );
      expect(document.querySelector(`[data-track="${id}"]`)).toHaveClass(
        'border-b',
        'border-border',
      );
    }
  });

  it('the cursor line spans the tracks and follows the clock', async () => {
    await renderBar(testPlayback({ timeS: 300 }));
    expect(screen.getByTestId('playback-cursor')).toHaveStyle({ left: '25%' });
  });

  it('the legend lists each kind once and the two team swatches', async () => {
    await renderBar(testPlayback());
    const legend = screen.getByRole('group', { name: 'Legend' });
    for (const label of [
      'Guardian',
      'Walker',
      'Titan',
      'Patron',
      'Shrine',
      'Mid Boss killed',
      'Mid Boss returns',
      'Death',
      'The colour tells the team',
      'Hidden King',
      'Archmother',
    ]) {
      expect(within(legend).getAllByText(label)).toHaveLength(1);
    }
    // The kind icons are neutral: the only team colours are the two swatches.
    expect(legend.querySelectorAll('.bg-team-hidden-king')).toHaveLength(1);
    expect(legend.querySelectorAll('.bg-team-archmother')).toHaveLength(1);
    expect(legend.querySelector('[class*="team-"][class*="stroke"]')).toBeNull();
    expect(within(legend).queryByText(/Scheduled event|Rift window|Trooper/)).toBeNull();
  });

  it('draws objectives and the Mid Boss kill and return', async () => {
    const user = userEvent.setup();
    const playback = testPlayback();
    await renderBar(playback);
    await user.click(screen.getByTitle('Walker · enemy · 12:34'));
    expect(playback.seek).toHaveBeenLastCalledWith(754);
    await user.click(
      screen.getByTitle('Mid Boss killed by your team, claimed by the enemy team · 15:00'),
    );
    expect(playback.seek).toHaveBeenLastCalledWith(900);
    await user.click(screen.getByTitle('Mid Boss is back · 18:20'));
    expect(playback.seek).toHaveBeenLastCalledWith(1100);
  });

  it('keeps the markers of the rows out of the tab order', async () => {
    await renderBar(testPlayback());
    // Mouse only: the keyboard uses the event buttons, the slider and the section keys.
    for (const title of [
      'Walker · enemy · 12:34',
      'Haze · ally · 5:00',
      'Mid Boss is back · 18:20',
    ]) {
      expect(screen.getByTitle(title)).toHaveAttribute('tabindex', '-1');
      expect(screen.getByTitle(title)).toHaveAttribute('aria-label', title);
    }
  });
});

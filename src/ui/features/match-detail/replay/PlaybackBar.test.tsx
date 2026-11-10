/**
 * Tests of the playback bar of the replay, rendered on its own with a replay built by hand and a
 * playback whose controls are spies: the slider, the previous / next event buttons, the speeds, the
 * ticks of the deaths, the span of the rift and the click on a marker.
 *
 * @packageDocumentation
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import type { ReplayViewPlayer } from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import { PlaybackBar } from './PlaybackBar';
import type { ReplayData } from './replay-model';
import type { Playback } from './use-playback';

/** A player of the replay, with deaths and no path needed. */
function player(overrides: Partial<ReplayViewPlayer>): ReplayViewPlayer {
  return {
    slot: 1,
    side: 'ally',
    isTracked: false,
    heroId: 1,
    heroName: 'Haze',
    iconUrl: null,
    hasPath: false,
    positions: [],
    deaths: [],
    ...overrides,
  };
}

/** A replay of 20 minutes: two deaths, one fallen walker, one mid boss kill and its return. */
function testView(): ReplayData {
  return {
    kind: 'replay',
    durationS: 1200,
    coverage: 'all',
    map: null,
    players: [
      player({ slot: 1, side: 'ally', heroName: 'Haze', deaths: [{ timeS: 300, respawnS: 330 }] }),
      player({
        slot: 7,
        side: 'enemy',
        heroName: 'Abrams',
        deaths: [{ timeS: 400, respawnS: 440 }],
      }),
    ],
    objectives: [
      {
        side: 'enemy',
        identity: { kind: 'walker', lane: 1, index: null },
        position: null,
        destroyedAtS: 754,
      },
    ],
    midBossKills: [{ timeS: 900, killedBy: 'ally', claimedBy: 'enemy' }],
    midBossReturnsS: [1100],
  };
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

  it("every player's death is a tick, coloured by side", async () => {
    const user = userEvent.setup();
    const playback = testPlayback();
    await renderBar(playback);
    const ally = screen.getByTitle('Haze · ally · 5:00');
    const enemy = screen.getByTitle('Abrams · enemy · 6:40');
    expect(ally).toHaveClass('bg-accent-bright');
    expect(enemy).toHaveClass('bg-loss');
    // The enemy tick has another shape, so the side is not told by the colour alone.
    expect(enemy).toHaveAttribute('data-shape', 'diamond');
    expect(ally).toHaveAttribute('data-shape', 'round');
    await user.click(enemy);
    expect(playback.seek).toHaveBeenCalledWith(400);
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

  it('the rift is drawn as a span, clipped to the match', async () => {
    const user = userEvent.setup();
    const playback = testPlayback();
    await renderBar(playback);
    const rift = screen.getByTitle('Unstable Rift · 10:00');
    // 600 s to 720 s of 1200 s: starts at 50 %, 10 % wide.
    expect(rift).toHaveStyle({ left: '50%', width: '10%' });
    await user.click(rift);
    expect(playback.seek).toHaveBeenCalledWith(600);
    // A 20-minute match only reaches the first stretch of trooper waves.
    expect(screen.getByTitle('Trooper waves every 30 s')).toBeInTheDocument();
  });

  it('shows the respawn duration in the tooltip of a scheduled event', async () => {
    await renderBar(testPlayback());
    expect(screen.getByTitle('Small camps (T1) · 2:00 · respawn 1:25')).toBeInTheDocument();
  });

  it('keeps the markers of the rows out of the tab order', async () => {
    await renderBar(testPlayback());
    // Mouse only: the keyboard uses the event buttons, the slider and the section keys.
    expect(screen.getByTitle('Unstable Rift · 10:00')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTitle('Mid Boss is back · 18:20')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTitle('Small camps (T1) · 2:00 · respawn 1:25')).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });
});

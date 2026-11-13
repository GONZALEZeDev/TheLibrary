/**
 * Tests of the "At 14:05" panel, rendered on its own with a replay built by hand: the objectives
 * fallen, the dead players with their respawn countdown (with or without a path) and the next
 * scheduled event.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { ReplayViewPlayer } from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import { InstantPanel } from './InstantPanel';
import type { ReplayData } from './replay-model';

/** A player of the replay. */
function player(overrides: Partial<ReplayViewPlayer>): ReplayViewPlayer {
  return {
    slot: 1,
    side: 'ally',
    team: 'hidden_king',
    isTracked: false,
    heroId: 1,
    heroName: 'Haze',
    iconUrl: null,
    hasPath: true,
    positions: [],
    health: [],
    deaths: [],
    ...overrides,
  };
}

/**
 * A replay of 20 minutes: a walker falls at 100 s, Haze dies at 800 s and Abrams (no path) at
 * 790 s.
 */
function testView(): ReplayData {
  return {
    kind: 'replay',
    durationS: 1200,
    trackedTeam: 'hidden_king',
    coverage: 'tracked_only',
    map: null,
    players: [
      player({
        slot: 1,
        heroName: 'Haze',
        deaths: [{ timeS: 800, respawnS: 840, killerSlot: null }],
      }),
      player({
        slot: 7,
        side: 'enemy',
        heroName: 'Abrams',
        hasPath: false,
        deaths: [{ timeS: 790, respawnS: 830, killerSlot: null }],
      }),
    ],
    objectives: [
      {
        side: 'enemy',
        team: 'archmother',
        identity: { kind: 'walker', lane: 1, index: null },
        position: null,
        destroyedAtS: 100,
      },
    ],
    midBossKills: [],
    midBossReturnsS: [],
  };
}

/** Render the panel in English at a moment. */
async function renderPanel(timeS: number): Promise<void> {
  const i18n = await createI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <InstantPanel view={testView()} timeS={timeS} />
    </I18nextProvider>,
  );
}

describe('InstantPanel', () => {
  it('the panel lists the dead with their respawn countdown', async () => {
    await renderPanel(805);
    expect(screen.getByRole('heading', { name: 'At 13:25' })).toBeInTheDocument();
    // The hero is told with its side, as the objective rows are.
    expect(screen.getByText('Haze · ally')).toBeInTheDocument();
    expect(screen.getByText('respawns in 35 s')).toBeInTheDocument();
    expect(screen.getByText('Walker · enemy')).toBeInTheDocument();
  });

  it('lists deaths of players without a path from death_details', async () => {
    await renderPanel(805);
    expect(screen.getByText('Abrams · enemy')).toBeInTheDocument();
    expect(screen.getByText('respawns in 25 s')).toBeInTheDocument();
  });

  it('says so when nobody is dead and nothing fell', async () => {
    await renderPanel(50);
    expect(screen.getByText('Nobody is dead.')).toBeInTheDocument();
    expect(screen.getByText('No objective destroyed yet.')).toBeInTheDocument();
  });

  it('the panel names the next scheduled event', async () => {
    await renderPanel(805);
    // The bridge power-ups come at 15:00, before the Soul Urn that shares the second.
    expect(screen.getByText('Bridge power-ups · 15:00')).toBeInTheDocument();
  });

  it('says so when no scheduled event is left', async () => {
    await renderPanel(1200);
    expect(screen.getByText('No more scheduled events.')).toBeInTheDocument();
  });
});

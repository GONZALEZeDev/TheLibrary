/**
 * Tests of the live feed, rendered on its own with a replay built by hand: at most five lines, a
 * height that never changes, the death, objective and mid boss lines, and the team colours.
 *
 * @packageDocumentation
 */
import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import type { Language } from '../../../../core/settings/language';
import type { ReplayViewPlayer } from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import { LiveFeed } from './LiveFeed';
import type { ReplayData } from './replay-model';

afterEach(cleanup);

/** A player of the replay; the team follows the side. */
function player(slot: number, heroName: string | null, side: 'ally' | 'enemy'): ReplayViewPlayer {
  return {
    slot,
    side,
    team: side === 'ally' ? 'hidden_king' : 'archmother',
    isTracked: slot === 1,
    heroId: slot,
    heroName,
    iconUrl: null,
    hasPath: true,
    positions: [],
    health: [],
    deaths: [],
  };
}

/** A replay of 100 seconds with Paige (ally) and Wraith (enemy), plus the given changes. */
function testView(overrides: Partial<ReplayData> = {}): ReplayData {
  return {
    kind: 'replay',
    durationS: 100,
    trackedTeam: 'hidden_king',
    coverage: 'all',
    map: null,
    players: [player(1, 'Paige', 'ally'), player(7, 'Wraith', 'enemy')],
    objectives: [],
    midBossKills: [],
    midBossReturnsS: [],
    ...overrides,
  };
}

/** A view where Paige dies at the given seconds, killed by Wraith (slot 7). */
function withDeaths(times: readonly number[], killerSlot: number | null = 7): ReplayData {
  const base = testView();
  return {
    ...base,
    players: base.players.map((entry) =>
      entry.slot === 1
        ? { ...entry, deaths: times.map((timeS) => ({ timeS, respawnS: timeS + 10, killerSlot })) }
        : entry,
    ),
  };
}

/** Render the feed in a language. */
async function renderFeed(language: Language, view: ReplayData, timeS: number): Promise<void> {
  const i18n = await createI18n(language);
  render(
    <I18nextProvider i18n={i18n}>
      <LiveFeed view={view} timeS={timeS} />
    </I18nextProvider>,
  );
}

describe('LiveFeed', () => {
  it('the feed shows 5 lines at most and keeps its height with 0 events', async () => {
    await renderFeed('en', withDeaths([10, 20, 30, 40, 50, 60, 70]), 65);

    // Seven deaths happened but only the last five show, newest first.
    const lines = screen.getAllByRole('listitem');
    expect(lines).toHaveLength(5);
    expect(lines[0]?.textContent).toContain('1:00');
    expect(lines[4]?.textContent).toContain('0:20');
    cleanup();

    // With nothing yet, the five slots stay and the first says so.
    await renderFeed('en', withDeaths([10]), 3);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Nothing has happened yet.')).toBeTruthy();
  });

  it('a death line names the killer, or none for an unknown killer', async () => {
    await renderFeed('en', withDeaths([10]), 12);
    expect(screen.getByText('Paige killed by Wraith')).toBeTruthy();
    cleanup();

    await renderFeed('en', withDeaths([10], null), 12);
    expect(screen.getByText('Paige died')).toBeTruthy();
    cleanup();

    // A hero without a name falls back to the generic one.
    const base = withDeaths([10], null);
    const unnamed: ReplayData = {
      ...base,
      players: base.players.map((entry) =>
        entry.slot === 1 ? { ...entry, heroName: null } : entry,
      ),
    };
    await renderFeed('en', unnamed, 12);
    expect(screen.getByText(/^a hero died$/i)).toBeTruthy();
  });

  it('an objective line names the owner team in its colour, with the lane dot', async () => {
    const view = testView({
      objectives: [
        {
          side: 'enemy',
          team: 'archmother',
          identity: { kind: 'walker', lane: 1, index: null },
          position: null,
          destroyedAtS: 30,
        },
        {
          side: 'ally',
          team: 'hidden_king',
          identity: { kind: 'shrine', lane: null, index: 1 },
          position: null,
          destroyedAtS: 31,
        },
      ],
    });
    await renderFeed('en', view, 40);

    const team = screen.getByText('Archmother');
    expect(team.className).toContain('text-team-archmother');
    const walkerLine = team.closest('li');
    expect(walkerLine?.textContent).toBe('0:30Archmother lost Walker');
    // The walker has a lane, so a dot in the colour of lane 1; the shrine has none.
    const dot = walkerLine?.querySelector<HTMLElement>('[data-lane-dot]');
    expect(dot?.style.backgroundColor).toBe('rgb(241, 204, 48)');
    const shrineLine = screen.getByText('Hidden King').closest('li');
    expect(shrineLine?.querySelector('[data-lane-dot]')).toBeNull();
  });

  it('the mid boss line names the killing and the claiming teams', async () => {
    const view = testView({
      midBossKills: [
        {
          timeS: 20,
          killedBy: 'ally',
          claimedBy: 'enemy',
          killedByTeam: 'hidden_king',
          claimedByTeam: 'archmother',
        },
      ],
    });
    await renderFeed('en', view, 25);

    expect(screen.getByText('Hidden King').className).toContain('text-team-hidden-king');
    expect(screen.getByText('Archmother').className).toContain('text-team-archmother');
    expect(screen.getByText('Hidden King').closest('li')?.textContent).toBe(
      '0:20Mid Boss killed by Hidden King · Rejuvenator taken by Archmother',
    );
  });

  it('colours team names from the data, not from a hero named like a team', async () => {
    // A hero named like a team dies: nothing on a death line is coloured.
    const base = withDeaths([10]);
    const view: ReplayData = {
      ...base,
      players: base.players.map((entry) =>
        entry.slot === 1 ? { ...entry, heroName: 'Archmother' } : entry,
      ),
    };
    await renderFeed('en', view, 12);

    const line = screen.getByText('Archmother killed by Wraith');
    expect(line.querySelector('[class*="text-team"]')).toBeNull();
  });

  it('renders in French', async () => {
    await renderFeed('fr', withDeaths([10]), 12);

    expect(screen.getByText('Paige tué par Wraith')).toBeTruthy();
  });
});

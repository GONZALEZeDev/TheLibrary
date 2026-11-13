/**
 * Tests of the objectives history card, rendered on its own with a replay built by hand: complete
 * from the start, greyed until the objective falls, seeking on a click, and the empty sentence.
 *
 * @packageDocumentation
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayViewObjective } from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import { ObjectivesHistory } from './ObjectivesHistory';
import type { ReplayData } from './replay-model';

afterEach(cleanup);

/** An objective of the replay. */
function objective(overrides: Partial<ReplayViewObjective>): ReplayViewObjective {
  return {
    side: 'enemy',
    team: 'archmother',
    identity: { kind: 'walker', lane: 1, index: null },
    position: null,
    destroyedAtS: null,
    ...overrides,
  };
}

/** A replay of 100 seconds with the given objectives. */
function testView(objectives: readonly ReplayViewObjective[]): ReplayData {
  return {
    kind: 'replay',
    durationS: 100,
    trackedTeam: 'hidden_king',
    coverage: 'all',
    map: null,
    players: [],
    objectives,
    midBossKills: [],
    midBossReturnsS: [],
  };
}

/** The test objectives: a walker (30 s), a shrine (60 s) and a guardian that never falls. */
const OBJECTIVES = [
  objective({ destroyedAtS: 60, identity: { kind: 'shrine', lane: null, index: 1 } }),
  objective({ destroyedAtS: 30 }),
  objective({
    side: 'ally',
    team: 'hidden_king',
    identity: { kind: 'guardian', lane: 3, index: null },
  }),
];

/** Render the card in English. */
async function renderHistory(
  view: ReplayData,
  timeS: number,
  onSeek: (timeS: number) => void = vi.fn(),
): Promise<void> {
  const i18n = await createI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <ObjectivesHistory view={view} timeS={timeS} onSeek={onSeek} />
    </I18nextProvider>,
  );
}

describe('ObjectivesHistory', () => {
  it('the history is complete from the start and greys what has not fallen yet', async () => {
    await renderHistory(testView(OBJECTIVES), 40);

    // Only destroyed objectives, oldest first: the standing guardian is not listed.
    const lines = screen.getAllByRole('button');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toBe('0:30WalkerArchmother');
    expect(lines[1]?.textContent).toBe('1:00ShrineArchmothernot fallen yet');
    // The walker has fallen by 40 s; the shrine has not, so it is greyed (but still clickable).
    expect(lines[0]?.getAttribute('data-pending')).toBeNull();
    expect(lines[1]?.getAttribute('data-pending')).toBe('true');
    expect(lines[1]?.hasAttribute('aria-disabled')).toBe(false);
    // The owner team is in its colour, and the walker has the dot of its lane.
    expect(screen.getAllByText('Archmother')[0]?.className).toContain('text-team-archmother');
    expect(lines[0]?.querySelector<HTMLElement>('[data-lane-dot]')?.style.backgroundColor).toBe(
      'rgb(241, 204, 48)',
    );
    expect(lines[1]?.querySelector('[data-lane-dot]')).toBeNull();
  });

  it('a match without destroyed objective shows the empty sentence', async () => {
    await renderHistory(testView(OBJECTIVES.filter((entry) => entry.destroyedAtS === null)), 40);

    expect(screen.getByText('No objective has been destroyed in this match.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('clicking a history line seeks to its time', async () => {
    const onSeek = vi.fn();
    await renderHistory(testView(OBJECTIVES), 0, onSeek);

    const [, shrine] = screen.getAllByRole('button');
    if (shrine === undefined) throw new Error('no history line');
    fireEvent.click(shrine);

    expect(onSeek).toHaveBeenCalledExactlyOnceWith(60);
  });
});

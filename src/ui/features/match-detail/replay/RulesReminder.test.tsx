/**
 * Tests of the rules reminder: every line is rendered from the schedule table, with the build it
 * was checked against, and the icons only decorate the lines that have one.
 *
 * @packageDocumentation
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GAME_SCHEDULE,
  SCHEDULE_GAME_BUILD,
  TROOPER_WAVES,
} from '../../../../core/match-map/game-schedule';
import { createI18n } from '../../../i18n/i18n';
import { formatGameTime } from '../analysis-format';
import { RulesReminder } from './RulesReminder';

afterEach(cleanup);

/** Render the reminder in English. */
async function renderReminder(): Promise<void> {
  const i18n = await createI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <RulesReminder />
    </I18nextProvider>,
  );
}

describe('RulesReminder', () => {
  it('the reminder states every scheduled rule from the schedule table', async () => {
    await renderReminder();
    // One line per table entry, one per trooper stretch, the Mid Boss returns and the build.
    const lines = screen.getAllByRole('listitem');
    expect(lines).toHaveLength(GAME_SCHEDULE.length + TROOPER_WAVES.length + 2);
    // Spot checks, each time taken from the table and not typed again.
    const camps = GAME_SCHEDULE.find((entry) => entry.kind === 'small_camps');
    if (camps?.type !== 'once' || camps.respawnS === null) throw new Error('table changed');
    expect(
      screen.getByText(
        `Small camps (T1): ${formatGameTime(camps.atS)} · respawn ${formatGameTime(camps.respawnS)}`,
      ),
    ).toBeInTheDocument();
    const urn = GAME_SCHEDULE.find((entry) => entry.kind === 'soul_urn');
    if (urn?.type !== 'repeat') throw new Error('table changed');
    expect(
      screen.getByText(
        `Soul Urn: ${formatGameTime(urn.firstS)}, then every ${formatGameTime(urn.everyS)}`,
      ),
    ).toBeInTheDocument();
    const rift = GAME_SCHEDULE.find((entry) => entry.kind === 'unstable_rift');
    if (rift?.type !== 'window') throw new Error('table changed');
    expect(
      screen.getByText(
        `Unstable Rift: between ${formatGameTime(rift.fromS)} and ${formatGameTime(rift.toS)}`,
      ),
    ).toBeInTheDocument();
    for (const stretch of TROOPER_WAVES) {
      const every = formatGameTime(stretch.everyS);
      const from = formatGameTime(stretch.fromS);
      expect(screen.getByText(`Trooper waves: every ${every} from ${from}`)).toBeInTheDocument();
    }
    expect(screen.getByText(/^Mid Boss returns 7:00/)).toBeInTheDocument();
    expect(
      screen.getByText(`Timings of game build ${String(SCHEDULE_GAME_BUILD)}`),
    ).toBeInTheDocument();
  });

  it('decorates only the lines that have a game icon, without a name of their own', async () => {
    await renderReminder();
    const urnLine = screen.getByText(/^Soul Urn/).closest('li');
    if (urnLine === null) throw new Error('missing line');
    // Decorative: the text of the line already names the event, so the picture has no alt text.
    expect(urnLine.querySelector('img')).toHaveAttribute('alt', '');
    const crates = screen.getByText(/^Crates and breakables/).closest('li');
    if (crates === null) throw new Error('missing line');
    expect(within(crates).queryByRole('img', { hidden: true })).toBeNull();
    expect(crates.querySelector('img')).toBeNull();
  });
});

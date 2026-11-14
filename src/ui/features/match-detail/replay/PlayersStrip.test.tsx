/**
 * Tests of the players strip, rendered on its own with a replay built by hand, in English and in
 * French: twelve fixed slots, the tracked team first with its tag, the health bar of the living,
 * the greyed portrait and the countdown of the dead, and the archives that hold no health.
 *
 * @packageDocumentation
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import type { Language } from '../../../../core/settings/language';
import type { ReplayViewPlayer } from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import { PlayersStrip } from './PlayersStrip';
import type { ReplayData } from './replay-model';

afterEach(cleanup);

/** A player of the replay; the team follows the side unless overridden. */
function player(overrides: Partial<ReplayViewPlayer> = {}): ReplayViewPlayer {
  const side = overrides.side ?? 'ally';
  return {
    slot: 1,
    side,
    team: side === 'ally' ? 'hidden_king' : 'archmother',
    isTracked: false,
    heroId: 1,
    heroName: 'Haze',
    iconUrl: 'https://assets-bucket.deadlock-api.com/haze.png',
    hasPath: true,
    positions: [],
    // Ten seconds at 80 % of health.
    health: Array.from({ length: 11 }, () => 80),
    deaths: [],
    ...overrides,
  };
}

/** The names of the heroes of the test replay, by slot (1 to 6 allies, 7 to 12 enemies). */
const HEROES = [
  'Paige',
  'Haze',
  'Abrams',
  'Seven',
  'Bebop',
  'Dynamo',
  'Lash',
  'Wraith',
  'Vindicta',
  'Yamato',
  'Infernus',
  'Kelvin',
];

/** A replay of ten seconds with twelve players, the tracked player (Paige) in slot 1. */
function testView(overrides: Partial<ReplayData> = {}): ReplayData {
  return {
    kind: 'replay',
    durationS: 10,
    trackedTeam: 'hidden_king',
    coverage: 'all',
    map: null,
    players: HEROES.map((heroName, index) =>
      player({
        slot: index + 1,
        side: index < 6 ? 'ally' : 'enemy',
        isTracked: index === 0,
        heroName,
      }),
    ),
    objectives: [],
    midBossKills: [],
    midBossReturnsS: [],
    ...overrides,
  };
}

/** The view with one player replaced (found by slot). */
function withPlayer(
  view: ReplayData,
  slot: number,
  changes: Partial<ReplayViewPlayer>,
): ReplayData {
  return {
    ...view,
    players: view.players.map((entry) => (entry.slot === slot ? { ...entry, ...changes } : entry)),
  };
}

/** The texts of the strip, by language. */
const STRINGS = {
  en: { hiddenKing: 'Hidden King', archmother: 'Archmother', yours: 'Your team', title: 'Players' },
  fr: {
    hiddenKing: 'Hidden King',
    archmother: 'Archmother',
    yours: 'Ton équipe',
    title: 'Joueurs',
  },
} as const satisfies Record<Language, Record<string, string>>;

/** Render the strip in a language. */
async function renderStrip(language: Language, view: ReplayData, timeS = 3): Promise<void> {
  const i18n = await createI18n(language);
  render(
    <I18nextProvider i18n={i18n}>
      <PlayersStrip view={view} timeS={timeS} />
    </I18nextProvider>,
  );
}

/** The slot of a hero, found by its accessible label. */
function slotOf(hero: string): HTMLElement {
  return screen.getByRole('listitem', { name: new RegExp(`^${hero}`) });
}

describe('PlayersStrip', () => {
  it('centres its two groups horizontally and lets them wrap', async () => {
    await renderStrip('en', testView());
    const strip = screen.getByRole('region', { name: STRINGS.en.title });
    expect(strip).toHaveClass('flex', 'flex-wrap', 'justify-center');
    // The two groups are the direct children of the centred container.
    expect(strip.children).toHaveLength(2);
  });

  it('shows 12 slots, the tracked team first, with its tag', async () => {
    // The tracked player (slot 7) is on the Archmother: that group must come first.
    const base = testView({ trackedTeam: 'archmother' });
    const view: ReplayData = {
      ...base,
      players: base.players.map((entry) => ({
        ...entry,
        side: entry.slot > 6 ? 'ally' : 'enemy',
        team: entry.slot > 6 ? 'archmother' : 'hidden_king',
        isTracked: entry.slot === 7,
      })),
    };
    await renderStrip('en', view);

    const slots = screen.getAllByRole('listitem');
    expect(slots).toHaveLength(12);
    // Slots 7 to 12 (now the tracked team) come first, each group ordered by slot.
    expect(slots.map((item) => item.getAttribute('aria-label')?.split(' · ')[0])).toEqual([
      ...HEROES.slice(6),
      ...HEROES.slice(0, 6),
    ]);
    // Only the tracked group carries the tag.
    expect(screen.getAllByText(STRINGS.en.yours)).toHaveLength(1);
    const headers = screen.getAllByRole('heading');
    expect(headers.map((header) => header.textContent)).toEqual([
      `${STRINGS.en.archmother}${STRINGS.en.yours}`,
      STRINGS.en.hiddenKing,
    ]);
    // Each header carries the logo of its Patron.
    // The logo only decorates the visible team name.
    for (const header of headers) expect(within(header).queryByRole('img')).toBeNull();
  });

  it('colours the groups and the bars by team identity, not by side', async () => {
    await renderStrip('en', testView());

    expect(screen.getByText(STRINGS.en.hiddenKing).className).toContain('text-team-hidden-king');
    expect(screen.getByText(STRINGS.en.archmother).className).toContain('text-team-archmother');
    const allyBar = within(slotOf('Haze')).getByRole('progressbar');
    const enemyBar = within(slotOf('Wraith')).getByRole('progressbar');
    expect(allyBar.className).toContain('bg-team-hidden-king');
    expect(enemyBar.className).toContain('bg-team-archmother');
  });

  it('marks the tracked player and draws the health bar at its percent', async () => {
    await renderStrip('en', testView());

    const bar = within(slotOf('Paige')).getByRole('progressbar', { name: 'Health 80 %' });
    expect(bar.style.width).toBe('80%');
    expect(slotOf('Paige').getAttribute('data-tracked')).toBe('true');
    expect(slotOf('Haze').hasAttribute('data-tracked')).toBe(false);
  });

  it('shows a plain disc with the initial for a hero without an icon', async () => {
    await renderStrip('en', withPlayer(testView(), 2, { iconUrl: null }));

    expect(within(slotOf('Haze')).queryByRole('img')).toBeNull();
    expect(within(slotOf('Haze')).getByText('H')).toBeTruthy();
  });

  it('greys a dead player and counts down to the respawn', async () => {
    const view = withPlayer(testView(), 2, { deaths: [{ timeS: 2, respawnS: 10, killerSlot: 7 }] });
    await renderStrip('en', view, 4);

    const slot = slotOf('Haze');
    expect(within(slot).getByText('6 s')).toBeTruthy();
    expect(within(slot).queryByRole('progressbar')).toBeNull();
    expect(slot.getAttribute('aria-label')).toBe('Haze · Hidden King · Dead · 6 s');
    expect(slotOf('Abrams').getAttribute('aria-label')).toBe('Abrams · Hidden King · Health 80 %');
  });

  it('shows no countdown for a dead player whose respawn is unknown', async () => {
    const view = withPlayer(testView(), 2, {
      deaths: [{ timeS: 4, respawnS: null, killerSlot: null }],
    });
    await renderStrip('en', view, 4);

    const slot = slotOf('Haze');
    // Announced as dead, unlike an alive player without health data.
    expect(slot.getAttribute('aria-label')).toBe('Haze · Hidden King · Dead');
    expect(within(slot).queryByText(/ s$/)).toBeNull();
  });

  it('on a format-1 archive only the tracked player has a health bar, the others still show deaths', async () => {
    const base = testView();
    const view: ReplayData = {
      ...base,
      players: base.players.map((entry) =>
        entry.isTracked
          ? entry
          : {
              ...entry,
              hasPath: false,
              health: [],
              // The deaths still come from the death list of the archive.
              deaths: entry.slot === 2 ? [{ timeS: 1, respawnS: 20, killerSlot: null }] : [],
            },
      ),
    };
    await renderStrip('en', view, 3);

    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    // The dead one still counts down.
    expect(within(slotOf('Haze')).getByText('17 s')).toBeTruthy();
  });

  it('keeps 6 slots per group when a team has fewer players', async () => {
    const view = testView();
    await renderStrip('en', { ...view, players: view.players.slice(0, 8) });

    // Eight named slots, the rest empty placeholders: the strip keeps its size.
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    expect(document.querySelectorAll('li')).toHaveLength(12);
  });

  it('labels an alive player without health data differently from a dead one', async () => {
    await renderStrip('en', withPlayer(testView(), 2, { health: [] }));

    expect(slotOf('Haze').getAttribute('aria-label')).toBe('Haze · Hidden King');
  });

  it('falls back to a generic name for an unknown hero', async () => {
    await renderStrip('en', withPlayer(testView(), 2, { heroName: null }));

    expect(screen.getByRole('listitem', { name: /^a hero/ })).toBeTruthy();
  });

  it('renders in French', async () => {
    await renderStrip('fr', testView());

    expect(screen.getByText(STRINGS.fr.yours)).toBeTruthy();
    expect(screen.getByRole('region', { name: STRINGS.fr.title })).toBeTruthy();
    expect(within(slotOf('Paige')).getByRole('progressbar', { name: 'Vie 80 %' })).toBeTruthy();
  });
});

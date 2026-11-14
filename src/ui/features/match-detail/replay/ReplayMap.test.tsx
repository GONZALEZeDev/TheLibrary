/**
 * Tests of the map of the replay, rendered on its own with a replay built by hand, in English and in
 * French: one icon per player alive at the moment, the standing and the fallen objectives, the wheel
 * zoom and the button that restores the whole map, icons that keep their screen size when zoomed,
 * the drag that pans, and the trails.
 *
 * The map is a picture for the eye: its icons and markers are found by the title each one carries,
 * which is what the pointer shows over them. The positions and the times are synthetic.
 *
 * @packageDocumentation
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { GAME_ICONS } from '../../../../core/match-map/game-icons';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import type { Language } from '../../../../core/settings/language';
import type {
  ReplayViewObjective,
  ReplayViewPlayer,
  Side,
} from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import type { ReplayData } from './replay-model';
import { ReplayMap } from './ReplayMap';

/** The map as the component needs it (never `null` here). */
type Map = NonNullable<ReplayData['map']>;

/** The team of a side in these fixtures: the tracked player is Hidden King, the other side Archmother. */
function teamOfSide(side: Side): TeamIdentity {
  return side === 'ally' ? 'hidden_king' : 'archmother';
}

/** A player of the replay: alive and walking right at every second of `positions`, unless overridden. */
function player(overrides: Partial<ReplayViewPlayer> = {}): ReplayViewPlayer {
  const side = overrides.side ?? 'ally';
  return {
    slot: 1,
    side,
    // The team follows the side unless a test crosses them on purpose.
    team: teamOfSide(side),
    isTracked: false,
    heroId: 1,
    heroName: 'Haze',
    iconUrl: 'https://assets-bucket.deadlock-api.com/haze.png',
    hasPath: true,
    // Ten seconds of a walk to the right, at the middle of the map.
    positions: Array.from({ length: 11 }, (_, second) => ({ left: 0.1 + second / 100, top: 0.5 })),
    health: [],
    deaths: [],
    ...overrides,
  };
}

/** An objective of the map. */
function objective(overrides: Partial<ReplayViewObjective> = {}): ReplayViewObjective {
  const side = overrides.side ?? 'enemy';
  return {
    side,
    team: teamOfSide(side),
    identity: { kind: 'walker', lane: 1, index: null },
    position: { left: 0.3, top: 0.3 },
    destroyedAtS: null,
    ...overrides,
  };
}

/**
 * A replay of ten seconds: the tracked player and an ally alive all along, an enemy dead from the
 * start (no position), and an enemy without an icon. One enemy walker falls at 5 s, one ally titan
 * stands, one shrine has no position.
 */
function testView(overrides: Partial<ReplayData> = {}): ReplayData {
  const map: Map = {
    imageUrl: 'https://assets-bucket.deadlock-api.com/map.png',
    lanes: [
      {
        color: '#eab308',
        points: [
          { left: 0.2, top: 0.2 },
          { left: 0.3, top: 0.8 },
        ],
      },
    ],
    midBoss: { left: 0.5, top: 0.5 },
  };
  return {
    kind: 'replay',
    durationS: 10,
    trackedTeam: 'hidden_king',
    coverage: 'all',
    map,
    players: [
      player({ slot: 1, isTracked: true, heroName: 'Paige' }),
      player({ slot: 2, heroName: 'Haze' }),
      player({
        slot: 7,
        side: 'enemy',
        heroName: 'Abrams',
        positions: Array.from({ length: 11 }, () => null),
      }),
      player({ slot: 8, side: 'enemy', heroName: 'Seven', iconUrl: null }),
    ],
    objectives: [
      objective({ destroyedAtS: 5 }),
      objective({ side: 'ally', identity: { kind: 'titan', lane: null, index: null } }),
      objective({
        identity: { kind: 'shrine', lane: null, index: 1 },
        position: null,
      }),
    ],
    midBossKills: [],
    midBossReturnsS: [],
    ...overrides,
  };
}

/** The texts of the map, by language. */
const STRINGS = {
  en: { title: 'Match map', reset: 'Reset zoom', walker: 'Walker' },
  fr: {
    title: 'Carte du match',
    reset: 'Réinitialiser le zoom',
    walker: 'Walker',
  },
} as const satisfies Record<Language, Record<string, string>>;

/** Render the map in a language. */
async function renderMap(
  language: Language,
  props: {
    view?: ReplayData;
    timeS?: number;
    showTrails?: boolean;
    onToggleTrails?: () => void;
  } = {},
): Promise<void> {
  const i18n = await createI18n(language);
  render(
    <I18nextProvider i18n={i18n}>
      <ReplayMap
        view={props.view ?? testView()}
        timeS={props.timeS ?? 3}
        showTrails={props.showTrails ?? false}
        onToggleTrails={props.onToggleTrails ?? (() => undefined)}
      />
    </I18nextProvider>,
  );
}

/** The picture of the map. */
function picture(language: Language): SVGSVGElement {
  const svg = screen.getByRole('img', { name: STRINGS[language].title });
  if (!(svg instanceof SVGSVGElement)) throw new Error('The map is not an svg');
  return svg;
}

/** The elements of the picture whose title starts with a text (a hero or an objective). */
function marked(language: Language, label: string): Element[] {
  return [...picture(language).querySelectorAll('title')]
    .filter((title) => title.textContent.startsWith(label))
    .map((title) => title.parentElement ?? expect.unreachable('A title stands outside a marker'));
}

/** The viewBox of the picture as four numbers. */
function viewBox(language: Language): number[] {
  return (picture(language).getAttribute('viewBox') ?? '').split(' ').map(Number);
}

/** Give the picture a size, since jsdom lays nothing out. */
function sizePicture(language: Language): void {
  vi.spyOn(picture(language), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
}

describe('ReplayMap', () => {
  it('draws one icon per player alive at t, none for the dead', async () => {
    await renderMap('en');

    expect(marked('en', 'Paige')).toHaveLength(1);
    expect(marked('en', 'Haze')).toHaveLength(1);
    // Dead: no position at that second, so nothing is drawn.
    expect(marked('en', 'Abrams')).toHaveLength(0);
    // Alive without an icon: a plain disc, no picture.
    const [seven] = marked('en', 'Seven');
    expect(seven?.querySelector('image')).toBeNull();
    expect(seven?.querySelector('circle')).not.toBeNull();
    expect(marked('en', 'Paige')[0]?.querySelector('image')?.getAttribute('href')).toBe(
      'https://assets-bucket.deadlock-api.com/haze.png',
    );
    expect(marked('en', 'Seven')[0]?.querySelector('title')?.textContent).toBe(
      'Seven · Archmother',
    );
    // The tracked player has one ring more than their ally.
    expect(marked('en', 'Paige')[0]?.querySelectorAll('circle')).toHaveLength(
      (marked('en', 'Haze')[0]?.querySelectorAll('circle').length ?? 0) + 1,
    );
  });

  it('draws the tracked player last, over the others', async () => {
    await renderMap('en');

    const titles = [...picture('en').querySelectorAll('title')].map((title) => title.textContent);
    const paige = titles.indexOf('Paige · Hidden King');
    expect(paige).toBeGreaterThan(titles.indexOf('Haze · Hidden King'));
    expect(paige).toBeGreaterThan(titles.indexOf('Seven · Archmother'));
  });

  it('a destroyed objective is told by its state from its second on', async () => {
    await renderMap('en', { timeS: 4.5 });
    const standing = marked('en', 'Walker')[0];
    expect(standing?.getAttribute('data-state')).toBe('standing');
    expect(standing?.querySelector('[stroke-dasharray]')).toBeNull();

    // Unmounted and rendered at the second the walker falls: it is dashed from that second.
    cleanup();
    await renderMap('en', { timeS: 5 });
    const fallen = marked('en', 'Walker')[0];
    expect(fallen?.getAttribute('data-state')).toBe('destroyed');
    // The icon stays (faded) and a dashed ring in the colour of its team surrounds it.
    expect(fallen?.querySelector('mask image')?.getAttribute('href')).toBe(GAME_ICONS.walker);
    expect(fallen?.querySelector('g[opacity]')).not.toBeNull();
    const ring = fallen?.querySelector('circle[stroke-dasharray]');
    expect(ring?.getAttribute('class')).toContain('stroke-team-archmother');
    // Whatever the state, the titan stands and an objective without a position is not drawn.
    expect(marked('en', 'Titan')[0]?.getAttribute('data-state')).toBe('standing');
    expect(marked('en', 'Shrine')).toHaveLength(0);
  });

  it('wheel zooms and the reset button restores the full map', async () => {
    const user = userEvent.setup();
    await renderMap('en');
    sizePicture('en');
    const reset = screen.getByRole('button', { name: STRINGS.en.reset });
    expect(viewBox('en')[2]).toBe(1000);
    expect(reset).toBeDisabled();

    fireEvent.wheel(picture('en'), { deltaY: -100, clientX: 250, clientY: 250 });
    const zoomed = viewBox('en');
    expect(zoomed[2]).toBeLessThan(1000);
    expect(zoomed[3]).toBe(zoomed[2]);
    expect(reset).toBeEnabled();

    // The wheel is cancelled, so that the page does not scroll under the map.
    const notPrevented = fireEvent.wheel(picture('en'), {
      deltaY: -100,
      clientX: 250,
      clientY: 250,
    });
    expect(notPrevented).toBe(false);

    await user.click(reset);
    expect(viewBox('en')).toEqual([0, 0, 1000, 1000]);
  });

  it('icons keep their screen size when zoomed', async () => {
    await renderMap('en');
    sizePicture('en');
    const width = () =>
      Number(marked('en', 'Haze')[0]?.querySelector('image')?.getAttribute('width'));
    const before = width();
    const boxBefore = viewBox('en')[2] ?? 0;

    fireEvent.wheel(picture('en'), { deltaY: -100, clientX: 250, clientY: 250 });

    // The window shrank by a factor: the icon shrank by the same one, so it spans the same pixels.
    expect(width()).toBeLessThan(before);
    expect((viewBox('en')[2] ?? 0) / boxBefore).toBeCloseTo(width() / before, 5);
  });

  it('dragging pans the zoomed map', async () => {
    await renderMap('en');
    sizePicture('en');
    fireEvent.wheel(picture('en'), { deltaY: -100, clientX: 250, clientY: 250 });
    const [leftBefore] = viewBox('en');

    fireEvent.pointerDown(picture('en'), { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(picture('en'), { pointerId: 1, buttons: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(picture('en'), { pointerId: 1, clientX: 200, clientY: 300 });

    // Dragging the map to the left shows more of its right side.
    expect(viewBox('en')[0]).toBeGreaterThan(leftBefore ?? 0);
  });

  it('tells the teams by a shape as well as a colour', async () => {
    await renderMap('en', { timeS: 4.5 });

    const ring = (label: string) => marked('en', label)[0]?.querySelector('circle:last-of-type');
    // The enemy ring is dashed, the ally ring solid.
    expect(ring('Seven · Archmother')?.getAttribute('stroke-dasharray')).toMatch(/\d/);
    expect(ring('Haze · Hidden King')?.hasAttribute('stroke-dasharray')).toBe(false);
    // An objective no longer changes shape with its side: no diamond turn, whatever the side.
    expect(picture('en').querySelector('[transform="rotate(45)"]')).toBeNull();
  });

  it('a player is ringed in the colour of their team, whatever their side', async () => {
    // Crossed on purpose: an ally of the tracked player that plays for the Archmother.
    const view = testView({
      players: [
        player({ slot: 1, isTracked: true, heroName: 'Paige' }),
        player({ slot: 2, heroName: 'Haze', side: 'ally', team: 'archmother' }),
        player({ slot: 3, heroName: 'Seven', side: 'enemy', team: 'hidden_king' }),
      ],
    });
    await renderMap('en', { view, showTrails: true });

    const ring = (label: string) => marked('en', label)[0]?.querySelector('circle:last-of-type');
    // The colour follows the team ...
    expect(ring('Haze · Archmother')?.getAttribute('class')).toContain('stroke-team-archmother');
    expect(ring('Seven · Hidden King')?.getAttribute('class')).toContain('stroke-team-hidden-king');
    // ... and the dash follows the side.
    expect(ring('Haze · Archmother')?.hasAttribute('stroke-dasharray')).toBe(false);
    expect(ring('Seven · Hidden King')?.getAttribute('stroke-dasharray')).toMatch(/\d/);
    // The trails take the colour of the team too.
    const trails = [...picture('en').querySelectorAll('[data-trail]')].map((trail) =>
      trail.getAttribute('class'),
    );
    expect(trails.filter((c) => c?.includes('stroke-team-archmother'))).toHaveLength(1);
    expect(trails.filter((c) => c?.includes('stroke-team-hidden-king'))).toHaveLength(2);
  });

  it('a guardian or a walker is its API icon tinted in the colour of its team', async () => {
    const view = testView({
      objectives: [
        objective({ identity: { kind: 'walker', lane: 1, index: null } }),
        objective({ side: 'ally', identity: { kind: 'guardian', lane: 1, index: null } }),
        // Crossed on purpose: an enemy-side objective that belongs to the Hidden King.
        objective({
          side: 'enemy',
          team: 'hidden_king',
          identity: { kind: 'base_guardian', lane: null, index: 1 },
        }),
      ],
    });
    await renderMap('en', { view });

    const walker = marked('en', 'Walker · Archmother')[0];
    const mask = walker?.querySelector('mask');
    expect(mask?.querySelector('image')?.getAttribute('href')).toBe(GAME_ICONS.walker);
    expect(mask?.getAttribute('style')).toContain('alpha');
    const tint = walker?.querySelector('rect');
    expect(tint?.getAttribute('class')).toContain('fill-team-archmother');
    expect(tint?.getAttribute('mask')).toBe(`url(#${mask?.id ?? ''})`);

    const guardian = marked('en', 'Guardian · Hidden King')[0];
    expect(guardian?.querySelector('mask image')?.getAttribute('href')).toBe(GAME_ICONS.guardian);
    expect(guardian?.querySelector('rect')?.getAttribute('class')).toContain(
      'fill-team-hidden-king',
    );
    // The colour follows the team, not the side.
    const base = marked('en', 'Base Guardian · Hidden King')[0];
    expect(base?.querySelector('mask image')?.getAttribute('href')).toBe(GAME_ICONS.guardian);
    expect(base?.querySelector('rect')?.getAttribute('class')).toContain('fill-team-hidden-king');
    // Every marker has its own mask id.
    const ids = [...picture('en').querySelectorAll('mask')].map((m) => m.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('a titan, a core and a shrine are their glyph in the colour of their team', async () => {
    const view = testView({
      objectives: [
        objective({ side: 'ally', identity: { kind: 'titan', lane: null, index: null } }),
        objective({ identity: { kind: 'core', lane: null, index: null } }),
        objective({
          side: 'ally',
          identity: { kind: 'shrine', lane: null, index: 1 },
          destroyedAtS: 2,
        }),
      ],
    });
    await renderMap('en', { view });

    const titan = marked('en', 'Titan · Hidden King')[0];
    expect(titan?.querySelector('path')?.getAttribute('class')).toContain(
      'stroke-team-hidden-king',
    );
    expect(titan?.querySelector('image')).toBeNull();
    const core = marked('en', 'Patron · Archmother')[0];
    expect(core?.querySelector('polygon')?.getAttribute('class')).toContain('fill-team-archmother');
    // A fallen shrine keeps its glyph in its destroyed state: dashed, unfilled, in its team colour.
    const shrine = marked('en', 'Shrine · Hidden King')[0];
    expect(shrine?.getAttribute('data-state')).toBe('destroyed');
    const outline = shrine?.querySelector('polygon');
    expect(outline?.getAttribute('class')).toContain('stroke-team-hidden-king');
    expect(outline?.getAttribute('stroke-dasharray')).toMatch(/\d/);
  });

  it('a standing objective has a background halo, a fallen one has none', async () => {
    await renderMap('en', { timeS: 4.5 });
    expect(marked('en', 'Walker · Archmother')[0]?.querySelector('[data-halo]')).not.toBeNull();
    expect(marked('en', 'Titan · Hidden King')[0]?.querySelector('[data-halo]')).not.toBeNull();
    cleanup();
    await renderMap('en', { timeS: 5 });
    expect(marked('en', 'Walker · Archmother')[0]?.querySelector('[data-halo]')).toBeNull();
  });

  it('a titan opens towards its own base', async () => {
    const view = testView({
      objectives: [
        // Base at the top of the map: a cup opening up towards the edge (sweep flag 0).
        objective({
          side: 'ally',
          identity: { kind: 'titan', lane: null, index: null },
          position: { left: 0.5, top: 0.2 },
        }),
        // Base at the bottom: a dome opening down towards the edge (sweep flag 1).
        objective({
          side: 'enemy',
          identity: { kind: 'titan', lane: null, index: null },
          position: { left: 0.5, top: 0.8 },
        }),
      ],
    });
    await renderMap('en', { view });

    const sweep = (label: string) =>
      /A [\d.]+ [\d.]+ 0 0 (\d)/.exec(
        marked('en', label)[0]?.querySelector('path')?.getAttribute('d') ?? '',
      )?.[1];
    expect(sweep('Titan · Hidden King')).toBe('0');
    expect(sweep('Titan · Archmother')).toBe('1');
  });

  it('a walker icon that fails to load leaves a drawn shape in the team colour', async () => {
    await renderMap('en', { timeS: 4.5 });
    const walker = marked('en', 'Walker · Archmother')[0];
    const icon = walker?.querySelector('mask image');
    expect(icon).not.toBeNull();
    if (icon) fireEvent.error(icon);
    expect(walker?.querySelector('mask')).toBeNull();
    expect(walker?.querySelector('circle')?.getAttribute('class')).toContain(
      'fill-team-archmother',
    );
  });

  it('the mid boss shows its icon, or a drawn disc when the icon fails', async () => {
    await renderMap('en');
    const pit = marked('en', 'Mid Boss')[0];
    expect(pit?.querySelector('image')?.getAttribute('href')).toBe(GAME_ICONS.mid_boss);
    // The official golden icon, drawn untinted (no mask).
    expect(GAME_ICONS.mid_boss).toContain('new_boss_marker.png');
    expect(pit?.querySelector('mask')).toBeNull();
    expect(pit?.querySelector('circle')).toBeNull();

    const icon = pit?.querySelector('image');
    if (icon) fireEvent.error(icon);
    expect(pit?.querySelector('image')).toBeNull();
    expect(pit?.querySelector('circle')).not.toBeNull();
  });

  it('only the main button starts a drag and a move with no button ends it', async () => {
    await renderMap('en');
    sizePicture('en');
    fireEvent.wheel(picture('en'), { deltaY: -100, clientX: 250, clientY: 250 });
    const before = viewBox('en')[0];

    // A right click does not start a drag.
    fireEvent.pointerDown(picture('en'), {
      pointerId: 1,
      button: 2,
      buttons: 2,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.pointerMove(picture('en'), { pointerId: 1, buttons: 2, clientX: 200, clientY: 300 });
    expect(viewBox('en')[0]).toBe(before);

    // A main-button drag pans, then a move with no button down is ignored.
    fireEvent.pointerDown(picture('en'), {
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.pointerMove(picture('en'), { pointerId: 1, buttons: 0, clientX: 200, clientY: 300 });
    expect(viewBox('en')[0]).toBe(before);
  });

  it('trails toggle', async () => {
    const onToggleTrails = vi.fn();
    const user = userEvent.setup();
    await renderMap('en', { showTrails: false, onToggleTrails, timeS: 3 });
    expect(picture('en').querySelectorAll('[data-trail]')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /trails/i }));
    expect(onToggleTrails).toHaveBeenCalledOnce();
  });

  it('draws one trail per player that has a path to show when trails are on', async () => {
    await renderMap('en', { showTrails: true, timeS: 3 });
    // Three players are alive; the dead one has no trail.
    expect(picture('en').querySelectorAll('[data-trail]')).toHaveLength(3);
    const trail = picture('en').querySelector('[data-trail]');
    // One point per second of the last ten, here from 0 to 3 s.
    expect(trail?.getAttribute('points')?.trim().split(' ')).toHaveLength(4);
  });

  it('renders in French', async () => {
    await renderMap('fr', { timeS: 4.5 });

    expect(screen.getByRole('button', { name: STRINGS.fr.reset })).toBeInTheDocument();
    expect(marked('fr', 'Haze')[0]?.querySelector('title')?.textContent).toBe('Haze · Hidden King');
    expect(marked('fr', 'Seven')[0]?.querySelector('title')?.textContent).toBe(
      'Seven · Archmother',
    );
    // The objective and team names stay English in French.
    expect(marked('fr', 'Walker')[0]?.querySelector('title')?.textContent).toBe(
      'Walker · Archmother',
    );
    expect(screen.getByRole('button', { name: /traînées/i })).toBeInTheDocument();
  });
});

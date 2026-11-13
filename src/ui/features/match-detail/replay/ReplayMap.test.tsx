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
import type { Language } from '../../../../core/settings/language';
import type { ReplayViewObjective, ReplayViewPlayer } from '../../../../services/match-replay-view';
import { createI18n } from '../../../i18n/i18n';
import type { ReplayData } from './replay-model';
import { ReplayMap } from './ReplayMap';

/** The map as the component needs it (never `null` here). */
type Map = NonNullable<ReplayData['map']>;

/** A player of the replay: alive and walking right at every second of `positions`, unless overridden. */
function player(overrides: Partial<ReplayViewPlayer> = {}): ReplayViewPlayer {
  return {
    slot: 1,
    side: 'ally',
    team: 'hidden_king',
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
  return {
    side: 'enemy',
    team: 'archmother',
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
  en: { title: 'Match map', reset: 'Reset zoom', ally: 'ally', enemy: 'enemy', walker: 'Walker' },
  fr: {
    title: 'Carte du match',
    reset: 'Réinitialiser le zoom',
    ally: 'allié',
    enemy: 'ennemi',
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
    expect(marked('en', 'Seven')[0]?.querySelector('title')?.textContent).toBe('Seven · enemy');
    // The tracked player has one ring more than their ally.
    expect(marked('en', 'Paige')[0]?.querySelectorAll('circle')).toHaveLength(
      (marked('en', 'Haze')[0]?.querySelectorAll('circle').length ?? 0) + 1,
    );
  });

  it('draws the tracked player last, over the others', async () => {
    await renderMap('en');

    const titles = [...picture('en').querySelectorAll('title')].map((title) => title.textContent);
    const paige = titles.indexOf('Paige · ally');
    expect(paige).toBeGreaterThan(titles.indexOf('Haze · ally'));
    expect(paige).toBeGreaterThan(titles.indexOf('Seven · enemy'));
  });

  it('a destroyed objective is dashed from its second on', async () => {
    await renderMap('en', { timeS: 4.5 });
    const standing = marked('en', 'Walker')[0];
    expect(standing?.getAttribute('data-state')).toBe('standing');
    expect(standing?.querySelector('[stroke-dasharray]')).toBeNull();

    // Unmounted and rendered at the second the walker falls: it is dashed from that second.
    cleanup();
    await renderMap('en', { timeS: 5 });
    const fallen = marked('en', 'Walker')[0];
    expect(fallen?.getAttribute('data-state')).toBe('destroyed');
    expect(fallen?.querySelector('[stroke-dasharray]')).not.toBeNull();
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
    expect(ring('Seven · enemy')?.getAttribute('stroke-dasharray')).toMatch(/\d/);
    expect(ring('Haze · ally')?.hasAttribute('stroke-dasharray')).toBe(false);
    // An enemy objective is a diamond, an ally one is not; a standing one is never dashed.
    const walker = marked('en', 'Walker · enemy')[0]?.querySelector('rect');
    expect(walker?.getAttribute('transform')).toBe('rotate(45)');
    expect(walker?.hasAttribute('stroke-dasharray')).toBe(false);
    expect(marked('en', 'Titan · ally')[0]?.querySelector('rect')?.hasAttribute('transform')).toBe(
      false,
    );
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
    expect(marked('fr', 'Haze')[0]?.querySelector('title')?.textContent).toBe('Haze · allié');
    expect(marked('fr', 'Seven')[0]?.querySelector('title')?.textContent).toBe('Seven · ennemi');
    // The objective names stay English; the side is told in French.
    expect(marked('fr', 'Walker')[0]?.querySelector('title')?.textContent).toBe('Walker · ennemi');
    expect(screen.getByRole('button', { name: /traînées/i })).toBeInTheDocument();
  });
});

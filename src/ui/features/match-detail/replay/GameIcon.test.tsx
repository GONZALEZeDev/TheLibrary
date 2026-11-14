/**
 * Tests of the game icon: the picture of the asset bucket while it loads, and the drawn shape that
 * takes its place when it fails, in the same box so that nothing around it moves.
 *
 * @packageDocumentation
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_ICONS } from '../../../../core/match-map/game-icons';
import { GameIcon } from './GameIcon';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** One preloading `Image` object the tinted icon created. */
interface StubImage {
  src: string;
  crossOrigin: string | null;
  onerror: (() => void) | null;
}

/** Replaces `Image` with a recorder, so a test can fail the load of the tinted icon. */
function stubImage(): StubImage[] {
  const instances: StubImage[] = [];
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      crossOrigin: string | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        instances.push(this);
      }
    },
  );
  return instances;
}

describe('GameIcon', () => {
  it('shows the picture of the icon, named by its label, in a box of the given size', () => {
    render(<GameIcon icon="walker" label="Walker" size={20} fallback="square" />);

    const img = screen.getByRole('img', { name: 'Walker' });
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(GAME_ICONS.walker);
    expect(img.getAttribute('width')).toBe('20');
    expect(img.getAttribute('height')).toBe('20');
  });

  it('enlarges the drawing of the Mid Boss inside an unchanged box, and not another icon', () => {
    const { rerender } = render(
      <GameIcon icon="mid_boss" label="Icon" size={16} fallback="circle" />,
    );
    const boss = screen.getByRole('img', { name: 'Icon' });
    expect(boss.style.transform).toBe('scale(1.7)');
    expect(boss.getAttribute('width')).toBe('16');

    rerender(<GameIcon icon="walker" label="Icon" size={16} fallback="circle" />);
    expect(screen.getByRole('img', { name: 'Icon' }).style.transform).toBe('');
  });

  it('enlarges the mask of a tinted Mid Boss, and keeps `contain` for another icon', () => {
    const { rerender } = render(
      <GameIcon icon="mid_boss" label="Icon" size={16} fallback="circle" tint="neutral" />,
    );
    const boss = screen.getByRole('img', { name: 'Icon' });
    expect(boss.style.maskSize).toContain('170%');
    expect(boss.style.width).toBe('16px');

    rerender(<GameIcon icon="walker" label="Icon" size={16} fallback="circle" tint="neutral" />);
    expect(screen.getByRole('img', { name: 'Icon' }).style.maskSize).toBe('contain');
  });

  it.each(['circle', 'diamond', 'square'] as const)(
    'falls back to the drawn %s when the image fails, in the same box',
    (fallback) => {
      render(<GameIcon icon="guardian" label="Guardian" size={20} fallback={fallback} />);

      fireEvent.error(screen.getByRole('img', { name: 'Guardian' }));

      const drawn = screen.getByRole('img', { name: 'Guardian' });
      expect(drawn.tagName.toLowerCase()).toBe('svg');
      expect(drawn.getAttribute('width')).toBe('20');
      expect(drawn.getAttribute('height')).toBe('20');
      // The shape is filled with the text colour, so the parent tints it.
      expect(drawn.querySelector('[fill="currentColor"]')).not.toBeNull();
    },
  );

  it('tries the new picture again when the icon changes', () => {
    const { rerender } = render(
      <GameIcon icon="guardian" label="Icon" size={16} fallback="circle" />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Icon' }));
    expect(screen.getByRole('img', { name: 'Icon' }).tagName.toLowerCase()).toBe('svg');

    rerender(<GameIcon icon="walker" label="Icon" size={16} fallback="circle" />);

    expect(screen.getByRole('img', { name: 'Icon' }).tagName).toBe('IMG');
  });

  it('hides a decorative icon from readers, picture and fallback alike', () => {
    render(<GameIcon icon="guardian" label="Guardian" size={20} fallback="circle" decorative />);
    expect(screen.queryByRole('img')).toBeNull();

    fireEvent.error(document.querySelector('img') ?? expect.unreachable('No picture'));

    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  describe('tinted', () => {
    it('renders a masked span of the box size, coloured by the team', () => {
      render(
        <GameIcon icon="death" label="Death" size={14} fallback="circle" tint="hidden_king" />,
      );

      const span = screen.getByRole('img', { name: 'Death' });
      expect(span.tagName).toBe('SPAN');
      expect(span.className).toContain('bg-team-hidden-king');
      expect(span.style.width).toBe('14px');
      expect(span.style.height).toBe('14px');
      expect(span.style.maskImage).toContain(GAME_ICONS.death);
      expect(span.style.maskSize).toBe('contain');
      expect(span.style.maskRepeat).toBe('no-repeat');
      expect(span.style.maskPosition).toContain('center');
    });

    it('uses the muted foreground for a neutral tint', () => {
      render(<GameIcon icon="death" label="Death" size={14} fallback="circle" tint="neutral" />);

      expect(screen.getByRole('img', { name: 'Death' }).className).toContain('bg-fg-muted');
    });

    it('hides a decorative tinted icon from readers', () => {
      render(
        <GameIcon
          icon="death"
          label="Death"
          size={14}
          fallback="circle"
          tint="archmother"
          decorative
        />,
      );

      expect(screen.queryByRole('img')).toBeNull();
      expect(document.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    });

    it('probes in CORS mode, as a CSS mask is fetched', () => {
      const instances = stubImage();
      render(<GameIcon icon="death" label="Death" size={14} fallback="circle" tint="neutral" />);

      expect(instances[0]?.crossOrigin).toBe('anonymous');
    });

    it('gets a fresh probe, and a fresh try, when the icon changes', () => {
      const instances = stubImage();
      const { rerender } = render(
        <GameIcon icon="guardian" label="Icon" size={14} fallback="circle" tint="neutral" />,
      );
      act(() => {
        instances[0]?.onerror?.();
      });
      expect(screen.getByRole('img', { name: 'Icon' }).tagName.toLowerCase()).toBe('svg');

      rerender(<GameIcon icon="walker" label="Icon" size={14} fallback="circle" tint="neutral" />);

      expect(instances).toHaveLength(2);
      expect(instances[1]?.src).toBe(GAME_ICONS.walker);
      expect(screen.getByRole('img', { name: 'Icon' }).tagName).toBe('SPAN');
    });

    it('falls back to the drawn shape, tinted by the team text colour, when the load fails', () => {
      const instances = stubImage();
      render(
        <GameIcon
          icon="guardian"
          label="Guardian"
          size={14}
          fallback="diamond"
          tint="archmother"
        />,
      );
      expect(instances[0]?.src).toBe(GAME_ICONS.guardian);

      act(() => {
        instances[0]?.onerror?.();
      });

      const drawn = screen.getByRole('img', { name: 'Guardian' });
      expect(drawn.tagName.toLowerCase()).toBe('svg');
      expect(drawn.getAttribute('class')).toContain('text-team-archmother');
      expect(drawn.getAttribute('width')).toBe('14');
      expect(drawn.querySelector('[fill="currentColor"]')).not.toBeNull();
    });
  });
});

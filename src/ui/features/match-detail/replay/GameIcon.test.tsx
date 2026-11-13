/**
 * Tests of the game icon: the picture of the asset bucket while it loads, and the drawn shape that
 * takes its place when it fails, in the same box so that nothing around it moves.
 *
 * @packageDocumentation
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GAME_ICONS } from '../../../../core/match-map/game-icons';
import { GameIcon } from './GameIcon';

afterEach(cleanup);

describe('GameIcon', () => {
  it('shows the picture of the icon, named by its label, in a box of the given size', () => {
    render(<GameIcon icon="walker" label="Walker" size={20} fallback="square" />);

    const img = screen.getByRole('img', { name: 'Walker' });
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(GAME_ICONS.walker);
    expect(img.getAttribute('width')).toBe('20');
    expect(img.getAttribute('height')).toBe('20');
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
});
